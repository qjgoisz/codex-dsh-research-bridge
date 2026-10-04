export const TOOL_NAME_MEMORY = 256;

export function createPermissionPolicy({ policy, broker, taskId, onUnnamedRequest } = {}) {
  const allow = new Set(policy?.tools ?? []);

  const names = new Map();
  const operations = new Map();

  const remember = (toolCallId, name) => {
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) return;
    if (typeof name !== 'string' || name.length === 0) return;
    names.delete(toolCallId);
    names.set(toolCallId, name);
    while (names.size > TOOL_NAME_MEMORY) names.delete(names.keys().next().value);
  };

  return {

    observeUpdate(params) {
      const update = params?.update ?? params;
      if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && typeof update.toolCallId === 'string') {
        operations.set(update.toolCallId, { ...operations.get(update.toolCallId), ...update });
        while (operations.size > TOOL_NAME_MEMORY) operations.delete(operations.keys().next().value);
      }
      if (update?.sessionUpdate === 'tool_call') remember(update.toolCallId, update.title);

      if (update?.sessionUpdate === 'tool_call_update' && !names.has(update.toolCallId)) {
        remember(update.toolCallId, update.title);
      }
    },

    knownName: toolCallId => names.get(toolCallId) ?? null,
    async decide({ toolCall, options }) {

      const fromRequest = typeof toolCall?.name === 'string' && toolCall.name.length > 0 ? toolCall.name : null;
      const name = fromRequest ?? names.get(toolCall?.toolCallId) ?? null;
      if (policy?.tools === undefined && broker) return broker.request({ taskId, toolCall: { ...operations.get(toolCall?.toolCallId), ...toolCall }, options, name });
      if (name !== null && allow.size > 0 && allow.has(name)) {
        const optionId = pick(options, 'allow-once');
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
      }

      if (name === null && allow.size > 0) onUnnamedRequest?.();
      const optionId = pick(options, 'reject-once');
      return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    },
  };
}

const pick = (options, kind) => options?.find(o => o.kind === kind.replaceAll('-', '_'))?.optionId ?? null;

// Requests are durable evidence, while their resolvers live only in this
// process. Restart never reconstructs an approval or replays a prompt.
import { randomUUID } from 'node:crypto';
export class ApprovalBroker {
  #pending = new Map();
  #listeners = new Set();
  onPending(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  constructor({ mode = 'ask', timeoutMs = 300_000, store = null, clock = Date.now } = {}) {
    if (!['ask', 'deny', 'allow-once'].includes(mode)) throw new Error('invalid_approval_mode');
    this.mode = mode; this.timeoutMs = timeoutMs; this.store = store; this.clock = clock;
  }
  list(taskId) { return [...this.#pending.values()].filter(e => !taskId || e.request.taskId === taskId).map(e => ({ ...e.request })); }
  #persist(taskId, event) {
    if (!this.store) return;
    const record = this.store.read(taskId);
    if (!record) throw new Error('approval_task_missing');
    this.store.write({ ...record, approvals: [...(record.approvals ?? []), event], updatedAt: new Date(this.clock()).toISOString() }, { expectRevision: record.revision });
  }
  async request({ taskId, toolCall, options, name }) {
    const request = { requestId: randomUUID(), taskId, toolCallId: toolCall?.toolCallId ?? null,
      name: name ?? null, operation: redactApproval({ title: toolCall?.title ?? null, kind: toolCall?.kind ?? null, rawInput: toolCall?.rawInput ?? null, locations: toolCall?.locations ?? null }), detailsObserved: toolCall?.rawInput !== undefined, options: Array.isArray(options) ? options.map(o => ({ optionId: o.optionId, kind: o.kind, name: o.name })) : [],
      status: 'pending', at: new Date(this.clock()).toISOString() };
    if (!request.options.length) return { outcome: 'cancelled' };
    const automatic = this.mode === 'allow-once' ? 'allow-once' : this.mode === 'deny' ? 'reject-once' : null;
    if (automatic) {
      const selected = request.options.find(o => o.kind === automatic.replaceAll('-', '_'));
      this.#persist(taskId, { ...request, status: 'decided', source: this.mode, optionId: selected?.optionId ?? null });
      return selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' };
    }
    this.#persist(taskId, request);
    return new Promise(resolve => {
      const timer = setTimeout(() => { try { this.#finish(request.requestId, null, 'timeout'); } catch { /* cancelled on persistence failure */ } }, this.timeoutMs);
      this.#pending.set(request.requestId, { request, resolve, timer });
      for (const listener of this.#listeners) { try { listener(request); } catch { /* observers cannot grant permission */ } }
    });
  }
  decide({ requestId, optionId, reason }) {
    const entry = this.#pending.get(requestId);
    if (!entry) throw Object.assign(new Error('审批不存在或已结算'), { code: 'approval_not_pending' });
    if (!entry.request.options.some(o => o.optionId === optionId)) throw Object.assign(new Error('审批选项必须来自原始请求'), { code: 'invalid_approval_option' });
    if (typeof reason !== 'string' || !reason.trim()) throw Object.assign(new Error('审批决定需要说明理由或授权来源'), { code: 'approval_reason_required' });
    this.#finish(requestId, optionId, reason);
    return { requestId, taskId: entry.request.taskId, optionId, status: 'decided' };
  }
  #finish(requestId, optionId, reason) {
    const entry = this.#pending.get(requestId); if (!entry) return;
    // Never send an approval that could not be recorded.
    try { this.#persist(entry.request.taskId, { ...entry.request, status: optionId ? 'decided' : 'cancelled', optionId, reason, decidedAt: new Date(this.clock()).toISOString() }); }
    catch (error) {
      clearTimeout(entry.timer); this.#pending.delete(requestId); entry.resolve({ outcome: 'cancelled' }); throw error;
    }
    clearTimeout(entry.timer); this.#pending.delete(requestId);
    entry.resolve(optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' });
  }
  cancelTask(taskId) {
    for (const e of [...this.#pending.values()]) if (!taskId || e.request.taskId === taskId) {
      try { this.#finish(e.request.requestId, null, 'task_or_connection_closed'); } catch { /* request already cancelled on failure */ }
    }
  }
}

function redactApproval(value) {
  if (Array.isArray(value)) return value.map(redactApproval);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(authorization|api[_-]?key|access[_-]?token|password|secret|credentials?)$/i.test(key) ? '[redacted]' : redactApproval(item)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]');
  return value;
}
