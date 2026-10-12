import { WorkspaceQueue } from './workspace-queue.mjs';
// Coordinator owns durable intent, session queues, and outcome settlement.
// Never replay an unobserved prompt automatically. Retain every owned worker
// until its exit is observed, even after its connection has been discarded.
import { buildObservation } from './observation.mjs';
import { CLARIFY_MARKER, extractClarification, renderPrompt, renderFollowUp } from './prompts.mjs';
import { createCollector } from './collector.mjs';
import { createPermissionPolicy, ApprovalBroker } from './permissions.mjs';
export { buildObservation, CLARIFY_MARKER, extractClarification, renderPrompt, renderFollowUp, createCollector, createPermissionPolicy };


import { resolve, isAbsolute } from 'node:path';

import { describeArtifacts, fingerprintOf, verifyFingerprint } from './fingerprint.mjs';
import { PromptLedger, PROMPT_LEDGER_EVENTS } from './prompt-ledger.mjs';

import { modelRouteFingerprint, validateTaskContract } from './contract.mjs';
import { createRecord, transition, isTerminal, canTransition, StateError } from './state.mjs';
import { mapKey, SessionMap } from './session-map.mjs';
import { AcpClient, AcpError, UNKNOWN_OUTCOME_CODES } from './acp-client.mjs';
import { createWorkerSpec, WorkerError } from './worker.mjs';
import {
  CatalogueCache, summarizeConfigOptions, applySelection, resolveSelection,
  validateModelSelection, validateReasoningSelection, modelValues, reasoningValues,
  DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_PROVIDER, DEFAULT_MODEL_ID,
  encodeModelSelector, decodeModelSelector, PROVIDER_DEFAULT_REASONING,
} from './models.mjs';

export class BridgeError extends Error {
  constructor(code, message, detail) {
    super(message ?? code);
    this.name = 'BridgeError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const nowIso = clock => new Date(clock()).toISOString();

const REPLAY_LIMIT = 1;

const COMMITTED = Symbol('bridge.committed');

export class Bridge {
  #store;
  #sessions;
  #connections = new Map();

  #promptLedger;

  #clients = new Set();

  #retired = new Set();

  #liveSessions = new Map();

  #resumeFailure = null;
  #workspaceQueue = new WorkspaceQueue();
  #inflight = new Map();
  #clock;
  #createClient;
  #observeClient;
  #maxResultChars;
  #log;
  #exposeModelChoice;
  #catalogue;
  #selectionDefaults;
  #defaultWorkspace;
  approvals;

  constructor({
    store, sessions = new SessionMap(), clock = Date.now, createClient, worker = {},
    maxResultChars = 200_000, log,

    exposeModelChoice = false,
    defaults = {},
    catalogueRoot = null,

    defaultWorkspace = null,

    observeClient = null,
    approvalMode = 'ask',
    approvalTimeoutMs = 300_000,
  }) {
    if (!store) throw new BridgeError('store_required');
    this.#store = store;
    this.approvals = new ApprovalBroker({ mode: approvalMode, timeoutMs: approvalTimeoutMs, store, clock });
    this.#sessions = sessions;
    this.#clock = clock;
    this.#observeClient = typeof observeClient === 'function' ? observeClient : null;
    this.#createClient = createClient ?? ((spec, hooks) => {
      const { promptTimeoutMs, requestTimeoutMs, ...launch } = spec;
      return new AcpClient({
        ...launch,
        ...(promptTimeoutMs ? { promptTimeoutMs } : {}),
        ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
        ...hooks,
      });
    });
    this.workerOptions = { ...worker };
    if (!this.workerOptions.profile) this.workerOptions.profile = 'acp';
    this.#maxResultChars = maxResultChars;
    const logger = log ?? (() => {});
    this.#log = event => {
      logger(event);
      if (PROMPT_LEDGER_EVENTS.includes(event?.event)) {
        try { this.#store.appendPromptLedgerEvent?.(event); }
        catch (error) {
          // Telemetry cannot change submission, rollback, or prefix selection.
          try { logger({ event: 'prompt_ledger_event_not_recorded', id: event.id,
            originalEvent: event.event, message: error?.message ?? String(error) }); } catch {}
        }
      }
    };
    this.#exposeModelChoice = exposeModelChoice === true;

    const provider = defaults.provider ?? DEFAULT_PROVIDER;
    const modelId = defaults.modelId ?? DEFAULT_MODEL_ID;
    this.#selectionDefaults = {
      provider,
      modelId,
      selector: defaults.selector ?? encodeModelSelector(provider, modelId),

      reasoningEffort: defaults.reasoningEffort === undefined
        ? DEFAULT_REASONING_EFFORT
        : (defaults.reasoningEffort ?? PROVIDER_DEFAULT_REASONING),
    };
    this.#catalogue = catalogueRoot ? new CatalogueCache(catalogueRoot) : null;
    this.#defaultWorkspace = defaultWorkspace;
    this.#promptLedger = new PromptLedger({
      store: this.#store, sessions: this.#sessions, clock: this.#clock, inflight: this.#inflight,
      require: id => this.#require(id), ensureSession: (...args) => this.#ensureSession(...args),
      runPrompt: args => this.#runPrompt(args), markUnknown: (...args) => this.#markUnknown(...args),
      publicView: record => this.#publicView(record), log: event => this.#log(event),
      ErrorType: BridgeError, committed: COMMITTED,
    });
  }

  get clientCountForTest() { return this.#clients.size; }

  forgetDeliveryLedgerForTest() {
    this.#promptLedger.forgetForTest();
  }
  get sessions() { return this.#sessions; }

  setSelectionDefaults(partial = {}) {
    const next = { ...this.#selectionDefaults };
    if (partial.provider !== undefined) next.provider = partial.provider;
    if (partial.modelId !== undefined) next.modelId = partial.modelId;
    if (partial.selector !== undefined) next.selector = partial.selector;
    if (partial.reasoningEffort !== undefined) next.reasoningEffort = partial.reasoningEffort;
    if (next.selector === undefined || (partial.provider !== undefined || partial.modelId !== undefined)) {
      next.selector = next.selector ?? encodeModelSelector(next.provider, next.modelId);
    }
    this.#selectionDefaults = next;
    return { ...next };
  }
  get store() { return this.#store; }
  get inflight() { return [...this.#inflight.keys()]; }

  flushSessions() {
    return this.#store.writeSessions(this.#sessions.toJSON());
  }

  loadTasks() {
    return this.#store.readAll();
  }

  reconcile() {
    const tasks = this.loadTasks();
    const stranded = [];
    for (const record of tasks.values()) {
      if (['dispatching', 'running', 'cancelling', 'unknown'].includes(record.status)) {
        stranded.push({
          id: record.id,
          status: record.status,
          attempts: record.attempts,
          sessionId: record.sessionId,
          updatedAt: record.updatedAt,
          note: record.status === 'unknown'
            ? '结果未观测到；可能已产生副作用，需人工核对后再决定重试或结案。'
            : '上次运行在本桥退出时仍未结算；请确认对应 worker 是否已停止。',
        });
      }
    }
    return { tasks: tasks.size, stranded, problems: tasks.problems };
  }

  async delegate(contract, { wait = false } = {}) {
    const { valid, errors, policy } = validateTaskContract(contract, { exposeModelChoice: this.#exposeModelChoice });
    if (!valid) {
      throw new BridgeError('invalid_contract', `任务契约校验未通过（${errors.length} 项）：${errors.map(e => `${e.field}: ${e.message}`).join('；')}`, errors);
    }
    const id = contract.id;

    if (id.startsWith('dsh-')) {
      throw new BridgeError('reserved_id', `任务 id 不得以 dsh- 开头（保留前缀）：${id}`);
    }
    const existing = this.#store.read(id);
    if (existing) {
      const same = JSON.stringify(existing.contract) === JSON.stringify(contract);
      if (!same) {
        throw new BridgeError('id_conflict', `任务 id ${id} 已存在且内容不同；请换一个 id（幂等只对完全相同的契约生效）。`);
      }
      if (isTerminal(existing.status)) return { ...this.#publicView(existing), idempotent: true };
      return { ...this.#publicView(existing), idempotent: true };
    }

    const at = nowIso(this.#clock);
    let record = createRecord({ id, contract, at, policy, contractFingerprint: fingerprintOf(contract) });
    this.#store.write(record, { expectRevision: undefined });
    record = transition(record, 'dispatching', { at: nowIso(this.#clock), event: { event: 'dispatch_scheduled' } });
    this.#store.write(record, { expectRevision: record.revision - 1 });

    const promise = this.#dispatch(id, contract, policy)

      .catch(error => this.#markUnknown(id, error, { receipt: 'no_prompt' }))
      .finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, promise);

    if (wait) await promise;
    const latest = this.#store.read(id) ?? record;
    return this.#publicView(latest);
  }

  retry(id, { reason, actor = 'operator' } = {}) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new BridgeError('reason_required', '重放必须给出理由：没有理由的重放与没有重放在记录上无法区分。');
    }
    const record = this.#require(id);
    if (record.status !== 'queued') {
      throw new BridgeError(
        'not_retryable',
        `任务 ${id} 当前状态为 ${record.status}，只有裁定为 retry 而回到 queued 的任务可以重放。`,
        {
          hint: record.status === 'unknown'
            ? '它还是 unknown：先用 `resolve --verdict retry --reason …` 显式裁定，再重放。'
            : '只有 `resolve` 的 retry 裁定会把任务放回 queued。',
        },
      );
    }
    if (record.resolution?.verdict !== 'retry') {
      throw new BridgeError('not_retryable', `任务 ${id} 回到 queued 的原因不是 retry 裁定，拒绝重放。`);
    }

    if ((record.replayCount ?? 0) >= REPLAY_LIMIT) {
      throw new BridgeError(
        'already_replayed',
        `任务 ${id} 已经重放过 ${record.replayCount} 次（上限 ${REPLAY_LIMIT}），拒绝再次重放。`,
        { hint: '需要再试请用新的任务 id：重放次数不受限会让「未知执行」的核对失去意义。' },
      );
    }

    const at = nowIso(this.#clock);
    const nextCount = (record.replayCount ?? 0) + 1;
    const replay = {
      ...record.resolution,
      replayed: true,
      replayedAt: at,
      replayedBy: typeof actor === 'string' && actor.trim().length > 0 ? actor.trim() : 'operator',
      replayReason: reason.trim(),

      replayAttempts: nextCount,
    };

    const armed = transition(record, 'dispatching', {
      at,
      patch: { resolution: replay, replayCount: nextCount },
      event: { event: 'retry_replay_started', actor: replay.replayedBy, reason: replay.replayReason },
    });
    this.#store.write(armed, { expectRevision: record.revision });
    this.#log({ event: 'retry_replay_started', id, actor: replay.replayedBy, reason: replay.replayReason });

    const promise = this.#dispatch(id, record.contract, record.policy)
      .catch(error => this.#markUnknown(id, error, { receipt: 'no_prompt' }))
      .finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, promise);
    return promise.then(() => this.#publicView(this.#require(id)));
  }

  async reply(id, text) {
    return this.#promptLedger.reply(id, text);
  }

  async cancel(id, { reason = 'caller requested' } = {}) {
    const record = this.#require(id);
    if (isTerminal(record.status)) return this.#publicView(record);
    if (record.status === 'queued') {
      const next = transition(record, 'cancelled', {
        at: nowIso(this.#clock), patch: { error: { code: 'cancelled_before_dispatch', reason } }, event: { event: 'cancelled' },
      });
      this.#store.write(next, { expectRevision: record.revision });
      return this.#publicView(next);
    }
    this.approvals.cancelTask(id);
    if (record.status === 'cancelling') return this.#publicView(record);
    if (!canTransition(record.status, 'cancelling')) {
      throw new BridgeError('cannot_cancel', `状态 ${record.status} 不支持取消。`);
    }
    const next = transition(record, 'cancelling', {
      at: nowIso(this.#clock), patch: { error: { code: 'cancel_requested', reason } }, event: { event: 'cancel_requested' },
    });
    this.#store.write(next, { expectRevision: record.revision });
    const client = this.#connections.get(record.sessionKey);
    if (client && record.sessionId) {
      try {
        client.cancel(record.sessionId);
      } catch { /* connection may already be gone; settlement below reports reality */ }
    } else {
      this.#markUnknown(id, new BridgeError('no_connection', '没有可用的连接发送取消，结果未知。'), { receipt: 'unconfirmed_cancel' });
    }
    return this.#publicView(this.#store.read(id) ?? next);
  }

  async waitForTask(id, timeoutMs = 30_000) {
    const started = this.#clock();
    const settledView = () => ({
      settled: true,
      waitedMs: this.#clock() - started,
      view: this.#publicView(this.#require(id)),
    });
    const current = this.#require(id);
    if (isTerminal(current.status)) return settledView();
    const inflight = this.#inflight.get(id);
    if (!inflight) return { settled: false, waitedMs: 0, view: this.#publicView(current) };
    let timer;
    const budget = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    });
    let unsubscribe = () => {};
    const approval = new Promise(resolve => {
      if (this.approvals.list(id).length) resolve('approval');
      else unsubscribe = this.approvals.onPending(request => { if (request.taskId === id) resolve('approval'); });
    });
    let outcome;
    try { outcome = await Promise.race([inflight.then(() => 'settled'), budget, approval]); }
    finally { clearTimeout(timer); unsubscribe(); }
    if (outcome === 'settled') return settledView();
    return { settled: false, waitedMs: this.#clock() - started, view: this.#publicView(this.#require(id)) };
  }

  resolve(id, { verdict, reason, actor = 'operator' } = {}) {
    const VERDICTS = {
      retry: { status: 'queued', note: '放回队列；是否重发由调用方决定，桥不自动重放' },
      keep_failed: { status: 'resolved', note: '作为未成功的执行结案' },
      abandoned: { status: 'resolved', note: '无法核对，明确放弃核对' },
      keep_completed: { status: 'resolved', note: '按已观测到的证据结案为完成' },
    };
    const spec = VERDICTS[verdict];
    if (spec === undefined) {
      throw new BridgeError('invalid_verdict', `verdict 必须是 ${Object.keys(VERDICTS).join(' / ')} 之一。`);
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new BridgeError('reason_required', '必须给出理由：没有理由的裁定与没有裁定在记录上无法区分。');
    }
    const record = this.#require(id);
    if (record.status !== 'unknown') {

      const hint = record.status === 'cancelling'
        ? 'cancelling 表示可能仍有 worker 在跑那条提示，请等取消结算落定（cancelled 或 unknown）后再裁定。'
        : '只有结果未观测到（unknown）的任务需要人工裁定。';
      throw new BridgeError(
        'not_resolvable',
        `任务 ${id} 当前状态为 ${record.status}，不接受裁定。${hint}`,
      );
    }
    const at = nowIso(this.#clock);
    const resolution = {
      verdict,
      status: spec.status,
      actor: typeof actor === 'string' && actor.trim().length > 0 ? actor.trim() : 'operator',
      reason: reason.trim(),
      at,

      replayed: (record.replayCount ?? 0) > 0,
      ...((record.replayCount ?? 0) > 0
        ? {
          replayAttempts: record.replayCount,
          ...(record.resolution?.replayedAt ? { replayedAt: record.resolution.replayedAt } : {}),
          ...(record.resolution?.replayedBy ? { replayedBy: record.resolution.replayedBy } : {}),
          ...(record.resolution?.replayReason ? { replayReason: record.resolution.replayReason } : {}),
        }
        : {}),
    };
    const next = transition(record, spec.status, {
      at,
      patch: { resolution },
      event: { event: 'resolved', verdict, actor: resolution.actor },
    });
    this.#store.write(next, { expectRevision: record.revision });
    this.#log({ event: 'resolved', id, verdict, status: spec.status, actor: resolution.actor });
    return { ...this.#publicView(this.#require(id)), resolution, note: spec.note };
  }

  status(id) {
    const record = this.#require(id);
    return this.#publicView(record);
  }

  inventory() {
    const records = this.loadTasks();
    return { tasks: [...records.values()].map(record => this.#publicView(record)), problems: records.problems };
  }

  list() {
    return this.inventory().tasks;
  }

  result(id) {
    const record = this.#require(id);
    const text = record.result?.text ?? '';

    const observation = record.result?.observation ?? record.error?.observation ?? null;
    return {
      id: record.id,
      status: record.status,
      stopReason: record.result?.stopReason ?? null,
      truncated: text.length > this.#maxResultChars,
      text: text.slice(0, this.#maxResultChars),
      toolCalls: record.result?.toolCalls ?? 0,
      turns: record.result?.turns ?? 0,
      usage: record.result?.usage ?? null,

      degraded: observation?.degraded ?? null,
      gaps: observation?.gaps ?? [],
      observation,
      artifacts: record.result?.artifacts ?? null,
      resolution: record.resolution ?? null,
      error: record.error ?? null,
    };
  }

  async #retireClient(client, reason) {
    let observed = false;
    let detail = null;
    try {
      const result = await client.shutdown();
      observed = result?.observed === true;
      detail = result ?? null;
    } catch (error) {
      detail = { error: error?.message ?? String(error) };
    }
    if (observed) this.#retired.add(client);
    this.#log({ event: 'client_retired', reason, observed, detail });
    return { observed, detail };
  }

  async emergencyKillWorkers() {

    const clients = [...this.#clients];
    const results = await Promise.all(clients.map(async client => {
      try {
        return await client.emergencyKill();
      } catch (error) {

        return {
          pid: client?.pid ?? null,
          signalled: false,
          terminationObserved: false,
          error: error?.message ?? String(error),
        };
      }
    }));
    this.#log({ event: 'emergency_kill_workers', results });
    return results;
  }

  async shutdown() {
    this.approvals.cancelTask();

    const clients = [...this.#clients];
    this.#connections.clear();
    this.#liveSessions.clear();
    const results = await Promise.all(clients.map(async client => {

      if (this.#retired.has(client)) return { observed: true, alreadyRetired: true };
      const { observed, detail } = await this.#retireClient(client, 'shutdown');
      return { observed, ...(detail !== null ? { detail } : {}) };
    }));
    this.#retired.clear();
    try { this.flushSessions(); } catch { /* store may already be unlocked */ }
    return results;
  }

  #require(id) {
    const record = this.#store.read(id);
    if (!record) throw new BridgeError('not_found', `没有任务 ${id}。`);
    return record;
  }

  #reportedEffort(record) {
    const normalise = value => {
      if (value === null || value === undefined) return null;
      return value === PROVIDER_DEFAULT_REASONING ? null : value;
    };

    if (record.appliedRoute !== undefined && record.appliedRoute !== null) {
      return { value: normalise(record.appliedRoute.reasoningEffort), source: 'snapshot' };
    }

    const entry = record.sessionKey ? this.#sessions.get(record.sessionKey) : null;
    const sameSession = entry != null
      && entry.sessionId === record.sessionId
      && (entry.generation ?? 0) === (record.sessionGeneration ?? 0);
    if (sameSession && entry.route !== undefined && entry.route !== null) {
      return { value: normalise(entry.route.reasoningEffort), source: 'session' };
    }

    const requested = record.policy?.reasoningEffort;
    const fallback = requested === undefined ? this.#selectionDefaults.reasoningEffort : requested;
    return { value: normalise(fallback), source: 'requested' };
  }

  #reportedModel(record) {
    let route = record.appliedRoute;
    let source = 'snapshot';
    if (route === undefined || route === null) {
      const entry = record.sessionKey ? this.#sessions.get(record.sessionKey) : null;
      const sameSession = entry != null && entry.sessionId === record.sessionId
        && (entry.generation ?? 0) === (record.sessionGeneration ?? 0);
      route = sameSession ? entry.route : null;
      source = 'session';
    }
    const observed = decodeModelSelector(route?.model);
    if (observed) return { provider: observed.provider, model: observed.model,
      modelSelector: encodeModelSelector(observed.provider, observed.model), modelSource: source };

    const provider = record.policy?.provider ?? this.#selectionDefaults.provider;
    const model = record.policy?.model ?? this.#selectionDefaults.modelId;
    return { provider, model, modelSelector: encodeModelSelector(provider, model), modelSource: 'requested' };
  }

  #publicView(record) {
    return {
      pendingApprovals: this.approvals.list(record.id),
      workerSnapshot: record.workerSnapshot ?? null,
      id: record.id,
      status: record.status,
      revision: record.revision,
      phase: record.contract?.phase ?? null,
      workspace: record.contract?.workspace ?? null,

      ...this.#reportedModel(record),

      ...(() => {
        const effort = this.#reportedEffort(record);
        return {
          reasoningEffort: effort.value,

          reasoningEffortSource: effort.source,
        };
      })(),
      sessionId: record.sessionId ?? null,
      attempts: record.attempts ?? 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      clarification: record.clarification
        ? { question: record.clarification.question, answered: Boolean(record.clarification.answer) }
        : null,
      error: record.error ?? null,
      stopReason: record.result?.stopReason ?? null,
      hasResult: (record.result?.text ?? '').length > 0,

      degraded: record.result?.observation?.degraded ?? null,
      resolution: record.resolution ?? null,
      observationGaps: record.result?.observation?.gaps ?? [],
    };
  }

  #sessionKeyFor(contract, policy) {
    return mapKey({
      project: contract.project ?? 'default',
      phase: contract.phase,
      workspace: contract.workspace,
      contextRevision: policy.contextRevision,
      capabilities: this.#capabilitiesOf(policy),
    });
  }

  #capabilitiesOf(policy) {
    return modelRouteFingerprint(policy, {
      provider: this.#selectionDefaults.provider,
      modelId: this.#selectionDefaults.modelId,

      reasoningEffort: this.#selectionDefaults.reasoningEffort,
    });
  }

  #advance(id, to, patch = {}, eventName = to) {
    const current = this.#require(id);
    if (!canTransition(current.status, to)) {
      throw new StateError('illegal_transition', `${current.status} -> ${to}`);
    }
    const next = transition(current, to, {
      at: nowIso(this.#clock), patch, event: { event: eventName },
    });
    this.#store.write(next, { expectRevision: current.revision });
    return next;
  }

  #enqueue(workspace, job) {
    return this.#workspaceQueue.enqueue(workspace, job);
  }

  async #dispatch(id, contract, policy) {
    const sessionKey = this.#sessionKeyFor(contract, policy);
    const current = this.#require(id);

    this.#store.write(
      {
        ...current,
        sessionKey,
        attempts: (current.attempts ?? 0) + 1,
        updatedAt: nowIso(this.#clock),
        history: [...current.history, { at: nowIso(this.#clock), to: 'dispatching', event: 'dispatch_started', sessionKey }].slice(-64),
      },
      { expectRevision: current.revision },
    );

    const text = renderPrompt(contract);
    return this.#enqueue(contract.workspace, async () => {
      const sessionId = await this.#ensureSession(sessionKey, contract, policy);
      const record = this.#require(id);
      this.#store.write(
        transition(record, 'running', {
          at: nowIso(this.#clock),
          patch: {
            sessionId,
            sessionGeneration: this.#sessions.get(sessionKey)?.generation ?? 0,
            workerSnapshot: this.#connections.get(sessionKey)?.identity ?? null,

            appliedRoute: (() => {
              const entry = this.#sessions.get(sessionKey);
              return entry?.route ? { ...entry.route } : null;
            })(),
          },
          event: { event: 'prompt_submitted' },
        }),
        { expectRevision: record.revision },
      );
      return this.#runPrompt({ id, sessionKey, text, sessionId, policy, phase: contract.phase });
    });
  }

  async #ensureSession(sessionKey, contract, policy) {
    const client = await this.#clientFor(sessionKey, contract);
    const existing = this.#sessions.get(sessionKey);

    const live = this.#liveSessions.get(sessionKey);
    if (existing && live === existing.sessionId) {
      return existing.sessionId;
    }
    if (existing && resolve(existing.workspace) === resolve(contract.workspace)) {
      try {
        await client.resumeSession({ sessionId: existing.sessionId, cwd: contract.workspace, mcpServers: [] });
        this.#liveSessions.set(sessionKey, existing.sessionId);

        return existing.sessionId;
      } catch (error) {

        this.#resumeFailure = {
          at: nowIso(this.#clock),
          sessionId: existing.sessionId,
          code: error?.code ?? 'error',
          message: error?.message ?? String(error),
          workspace: contract.workspace,

          ...(error?.rpc === undefined ? {} : { rpc: error.rpc }),
        };
        this.#log({
          event: 'resume_failed',
          sessionKey,
          sessionId: existing.sessionId,
          code: error?.code ?? 'error',
          workerMessage: error?.message ?? String(error),

          ...(error?.rpc === undefined ? {} : { rpc: error.rpc }),
          note: '恢复旧会话失败，改为开新会话；原因见 workerMessage 与 rpc.error.data',
        });
      }
    }
    const created = await client.newSession({ cwd: contract.workspace, mcpServers: [] });
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
      throw new BridgeError('invalid_session', 'worker 未返回 sessionId。');
    }
    const applied = await this.#applyRoute({ client, sessionId: created.sessionId, policy, published: created.configOptions });
    this.flushCatalogue(applied.summaryAfter);
    const generation = existing ? this.#sessions.rotate(sessionKey, {
      reason: existing.workspace !== contract.workspace ? 'workspace_changed' : 'resume_failed',
      now: nowIso(this.#clock),

      ...(this.#resumeFailure ? { failure: this.#resumeFailure } : {}),
    }) : 0;
    this.#resumeFailure = null;
    this.#sessions.put(sessionKey, {
      sessionId: created.sessionId,
      workspace: contract.workspace,
      phase: contract.phase,
      project: contract.project ?? 'default',
      contextRevision: policy.contextRevision,
      capabilities: this.#capabilitiesOf(policy),
      route: { model: applied.model, reasoningEffort: applied.reasoningEffort },
      generation,

      rotationRecorded: existing !== undefined,
      now: nowIso(this.#clock),
    });

    this.#liveSessions.set(sessionKey, created.sessionId);
    this.flushSessions();
    return created.sessionId;
  }

  async #applyRoute({ client, sessionId, policy, published }) {
    const summary = summarizeConfigOptions(published);

    const requestedModel = typeof policy.model === 'string' && policy.model.length > 0
      ? encodeModelSelector(policy.provider ?? this.#selectionDefaults.provider, policy.model)
      : undefined;
    const selection = resolveSelection({
      requestedModel,
      requestedReasoning: policy.reasoningEffort,
      defaults: { model: this.#selectionDefaults.selector, reasoningEffort: this.#selectionDefaults.reasoningEffort },
    });

    const modelCheck = validateModelSelection(summary, selection.model, { explicit: selection.modelExplicit });
    if (modelCheck.status === 'invalid') {
      throw new BridgeError('model_not_available', `契约请求的路由不存在：${describeSelector(selection.model)}`, {
        requested: describeSelector(selection.model),
        candidates: (modelCheck.candidates ?? modelValues(summary)).map(describeSelector),
        hint: '用 `dsh-bridge models --refresh` 取回该 worker 实际公布的清单，再改契约里的 provider/model。',
      });
    }
    if (modelCheck.status !== 'ok') {
      this.#log({ event: 'route_note', sessionId, note: modelCheck.message, code: modelCheck.status });
    }
    const reasoningCheck = validateReasoningSelection(summary, selection.reasoningEffort);
    if (reasoningCheck.status === 'invalid') {
      throw new BridgeError('reasoning_not_available', reasoningCheck.message, {
        candidates: reasoningCheck.candidates ?? reasoningValues(summary),
      });
    }

    try {
      const applied = await applySelection({ client, sessionId, selection, summary });
      if (applied.notes.length > 0) this.#log({ event: 'route_notes', sessionId, notes: applied.notes });
      return applied;
    } catch (error) {
      const published = modelValues(summary).map(describeSelector);
      const isDefaultRoute = !selection.modelExplicit;
      throw new BridgeError(
        isDefaultRoute ? 'default_route_rejected' : (error.code ?? 'route_rejected'),
        isDefaultRoute
          ? `配置里的默认路由被 worker 拒绝：${describeSelector(selection.model)}。${error.message ?? ''}`
          : (error.message ?? 'worker 拒绝了本次路由设置。'),
        {
          requested: describeSelector(selection.model),
          ...(published.length > 0 ? { candidates: published } : {}),
          hint: isDefaultRoute
            ? '改 bridge.config.json 里的 provider/model（先跑 `dsh-bridge models --refresh` 看这台机器实际公布什么）。'
            : (error.hint ?? undefined),
        },
      );
    }
  }

  flushCatalogue(summary) {
    if (!this.#catalogue || !summary) return null;
    try {
      return this.#catalogue.write({ dshHome: this.workerOptions?.dshHome ?? null, summary });
    } catch (error) {
      this.#log({ event: 'catalogue_write_failed', code: error?.code ?? 'error' });
      return null;
    }
  }

  readCatalogue() {
    return this.#catalogue?.read() ?? null;
  }

  async discoverModels({ workspace, refresh = true } = {}) {
    const cached = this.readCatalogue();
    if (!refresh && cached) return { summary: cached.summary, sessionId: null, at: cached.at, cached: true };

    const target = workspace ?? this.workerOptions?.workspace ?? this.#defaultWorkspace;
    if (typeof target !== 'string' || !isAbsolute(target)) {
      throw new BridgeError('workspace_required', 'discoverModels 需要一个绝对路径的工作区来建立会话。');
    }
    const key = `discovery\u0000${target}`;
    const client = await this.#clientFor(key, { workspace: target });
    let created = null;
    try {
      created = await client.newSession({ cwd: target, mcpServers: [] });
      const summary = summarizeConfigOptions(created.configOptions);
      this.flushCatalogue(summary);
      return { summary, sessionId: created.sessionId, at: new Date(this.#clock()).toISOString(), cached: false };
    } finally {
      try {
        if (created?.sessionId) await client.closeSession(created.sessionId);
      } catch (error) {
        this.#log({ event: 'discovery_close_failed', code: error?.code ?? 'error' });
      }
      this.#connections.delete(key);

      this.#liveSessions.delete(key);
      await this.#retireClient(client, 'discovery_done');
    }
  }

  get modelChoiceEnabled() { return this.#exposeModelChoice; }
  get defaultWorkspace() { return this.#defaultWorkspace; }
  get selectionDefaults() { return { ...this.#selectionDefaults }; }

  async #clientFor(sessionKey, contract) {
    const existing = this.#connections.get(sessionKey);
    if (existing && !existing.failure) return existing;
    if (existing) {
      this.#connections.delete(sessionKey);
      this.#liveSessions.delete(sessionKey);

      await this.#retireClient(existing, 'connection_discarded');
    }

    const spec = createWorkerSpec({ workspace: contract.workspace, ...this.workerOptions });
    const client = this.#createClient(spec, {

      onDisconnect: info => this.#log({
        event: 'worker_disconnect',
        code: info.code,
        pid: info.pid,
        sessionKey,
        note: '连接断开：本次派发结果未知，请核对工作区后再决定是否重试',
      }),
    });
    if (this.#observeClient !== null) {
      try { this.#observeClient(client); } catch { /* 观察者不得影响正事 */ }
    }
    this.#connections.set(sessionKey, client);
    this.#clients.add(client);
    try {
      const handshake = await client.initialize();
      client.identity = { protocolVersion: handshake?.protocolVersion ?? null, agentInfo: handshake?.agentInfo ?? null, agentCapabilities: handshake?.agentCapabilities ?? null, platform: process.platform, arch: process.arch, node: process.versions.node, transport: spec.transport, entry: spec.command, args: spec.args };
    } catch (error) {

      await this.#retireClient(client, 'initialize_failed');
      this.#connections.delete(sessionKey);
      this.#liveSessions.delete(sessionKey);
      throw error;
    }
    return client;
  }

  async #runPrompt({ id, sessionKey, text, sessionId, policy, phase }) {

    const client = this.#connections.get(sessionKey);
    if (!client) throw new BridgeError('no_connection', '提交提示前没有连接。');

    const activeSessionId = this.#liveSessions.get(sessionKey) ?? sessionId;
    const collector = createCollector(activeSessionId);
    const off = client.onUpdate(collector.observe);

    const permission = createPermissionPolicy({
      policy,
      broker: this.approvals,
      taskId: id,
      onUnnamedRequest: () => this.#log({
        event: 'permission_refused_unnamed',
        id,
        note: 'worker 请求权限但既未在报文里给出工具名、也没有可关联的 tool_call 通知；按拒绝处理',
      }),
    });
    client.setPermissionPolicy(permission);
    const permissionOff = client.onUpdate(update => permission.observeUpdate(update));

    let response;
    const promptCall = client.prompt({ sessionId: activeSessionId, text });
    let committed = false;
    try {
      response = await promptCall;
      committed = true;

      this.#promptLedger.recordSubmitted({ id, sessionKey, text, activeSessionId });
    } catch (error) {
      off();
      permissionOff();
      this.approvals.cancelTask(id);
      const code = error instanceof AcpError ? error.code : 'prompt_error';

      const submitted = typeof error?.submitted === 'boolean'
        ? error.submitted
        : (client.wasSubmitted?.(promptCall?.requestId) ?? null);

      const definitelyUnsubmitted = submitted === false;
      if (!definitelyUnsubmitted) {
        return this.#markUnknown(id, error, {
          receipt: 'unobserved',
          clientFailure: code,

          result: collector.snapshot(),
        });
      }
      const current = this.#require(id);
      const snapshot = collector.snapshot();
      this.#store.write(transition(current, 'failed', {
        at: nowIso(this.#clock),
        patch: {
          result: { ...snapshot, observation: this.#observe('no_prompt', snapshot) },
          error: { code, message: error.message },
        },
        event: { event: 'prompt_failed', code },
      }), { expectRevision: current.revision });
      return this.#publicView(this.#require(id));
    }
    off();
    permissionOff();
    this.approvals.cancelTask(id);

    const result = { ...collector.snapshot(), stopReason: response?.stopReason ?? null, usage: response?.usage ?? null };
    const clarification = extractClarification(result.text);
    const current = this.#require(id);

    if (current.status === 'cancelling') {
      this.#store.write(transition(current, 'cancelled', {
        at: nowIso(this.#clock),
        patch: { result: { ...result, observation: this.#observe('response', result) } },
        event: { event: 'cancelled_settled' },
      }), { expectRevision: current.revision });
      return this.#publicView(this.#require(id));
    }

    if (clarification && current.status === 'running') {
      this.#store.write(transition(current, 'needs_clarification', {
        at: nowIso(this.#clock),
        patch: {
          result: { ...result, observation: this.#observe('response', result) },
          clarification: { question: clarification.question, askedAt: nowIso(this.#clock), answer: null },
        },
        event: { event: 'clarification_requested' },
      }), { expectRevision: current.revision });

      return this.#committedView(this.#publicView(this.#require(id)));
    }

    if (result.stopReason === 'end_turn') {

      let artifacts = null;
      try {
        artifacts = await describeArtifacts(current.contract?.deliverables ?? current.policy?.writePaths ?? []);
      } catch (error) {
        this.#log({ event: 'artifact_hash_failed', id, code: error?.code ?? 'error' });
      }
      const resultWithArtifacts = {
        ...result,
        observation: this.#observe('response', result),
        ...(artifacts ? { artifacts } : {}),
      };
      this.#store.write(transition(current, 'completed', {
        at: nowIso(this.#clock),

        patch: { result: resultWithArtifacts },
        event: { event: 'completed', stopReason: result.stopReason },
      }), { expectRevision: current.revision });
      return this.#committedView(this.#publicView(this.#require(id)));
    }

    this.#store.write(transition(current, 'failed', {
      at: nowIso(this.#clock),
      patch: {
        result: { ...result, observation: this.#observe('response', result) },
        error: { code: 'stop_reason', message: `worker 以 ${result.stopReason} 结束。` },
      },
      event: { event: 'failed', stopReason: result.stopReason },
    }), { expectRevision: current.revision });
    return this.#committedView(this.#publicView(this.#require(id)));
  }

  #committedView(view) {
    Object.defineProperty(view, COMMITTED, { value: true, enumerable: false });
    return view;
  }

  #observe(receipt, result, clientFailure = null) {
    return { ...buildObservation({ receipt, result, clientFailure }), observedAt: nowIso(this.#clock) };
  }

  #markUnknown(id, error, { receipt = 'unobserved', clientFailure = null, result = null } = {}) {
    try {
      const current = this.#store.read(id);
      if (!current) return { id, status: 'unknown' };
      if (isTerminal(current.status)) return this.#publicView(current);
      const code = error?.code ?? 'unknown_error';
      const observation = this.#observe(receipt, result, clientFailure);
      const detail = {
        code,
        message: error?.message ?? String(error),
        observation,
        ...(error?.detail ? { detail: error.detail } : {}),
      };

      const target = receipt === 'no_prompt' ? 'failed' : 'unknown';
      if (!canTransition(current.status, target)) {
        this.#log({ event: 'outcome_transition_refused', id, from: current.status, target, code });
        return this.#publicView(current);
      }
      const next = transition(current, target, {
        at: nowIso(this.#clock),
        patch: { error: detail },
        event: { event: receipt === 'no_prompt' ? 'dispatch_failed' : 'outcome_unknown', code },
      });
      this.#store.write(next, { expectRevision: current.revision });
      return this.#publicView(next);
    } catch (failure) {
      this.#log({ event: 'unknown_persist_failed', id, code: failure?.code ?? 'error' });
      return { id, status: 'unknown', error: { code: error?.code ?? 'unknown_error' } };
    }
  }
}

function describeSelector(value) {
  const decoded = decodeModelSelector(value);
  if (decoded) return `${decoded.provider}:${decoded.model}`;
  return String(value);
}

export { createWorkerSpec, WorkerError, describeSelector };
