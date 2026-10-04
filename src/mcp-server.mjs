

import { BRIDGE_NAME, BRIDGE_VERSION } from './version.mjs';
import { CLARIFY_MARKER } from './orchestration.mjs';
import { PHASE_NAMES } from './contract.mjs';
import {
  DEFAULT_MODEL_ID, DEFAULT_PROVIDER, DEFAULT_REASONING_EFFORT, describeSelector,
} from './models.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

export const MAX_WAIT_MS = 120_000;

export const DEFAULT_WAIT_MS = 30_000;

export const DEFAULT_STATUS_LIMIT = 20;

const TASK_FIELDS = {
  id: { type: 'string', description: '任务 id（字母数字与 . _ -，用于幂等）' },
  objective: { type: 'string', description: '要交付的目标本身：计算、推导、核对或产出什么' },
  phase: { type: 'string', enum: PHASE_NAMES, description: '科研阶段或维护类型，决定会话复用边界' },
  workspace: { type: 'string', description: 'worker 的工作区根（绝对路径，必须已存在）' },
  deliverables: { type: 'array', items: { type: 'string' }, description: '期望交付的文件路径' },
  research: { type: 'object', description: '模型、假设、单位、边界条件、参数范围与输入版本', additionalProperties: true },
  project: { type: 'string', description: '项目标签，默认 default；与 phase/workspace 共同决定会话' },
  contextRevision: { type: 'integer', description: '输入文档的版本号；变化即开新会话' },
  plan: {
    type: 'object',
    description: '可执行计划',
    properties: {
      summary: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'steps'],
  },
  acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准（至少一条）' },
  stopIf: { type: 'array', items: { type: 'string' }, description: '遇到这些情况必须停下并提问' },
  permissions: {
    type: 'object',
    description: '可选任务约定；不是额外授权。工具审批以 DSH 实际请求为准',
    properties: {
      readPaths: { type: 'array', items: { type: 'string' } },
      writePaths: { type: 'array', items: { type: 'string' } },
      tools: { type: 'array', items: { type: 'string' }, description: '旧契约兼容字段；新任务无需维护工具列表，使用部署审批策略' },
      network: { type: 'boolean' },
    },

  },
  provider: {
    type: 'string',
    description: '供应商 id，例如 deepseek-official。仅在桥启用模型选择时可用；省略则用配置的默认路由',
  },
  model: {
    type: 'string',
    description: '模型 id 本身，例如 deepseek-flash（不要写 provider/model）。仅在桥启用模型选择时可用',
  },
  reasoningEffort: {
    type: ['string', 'null'],
    description: '推理档位，例如 high；null 表示沿用 provider 默认。仅在桥启用模型选择时可用',
  },
  reversePolicy: { type: 'string', enum: ['consult_only'], description: '固定为 consult_only' },
  allowRecursiveDelegation: { type: 'boolean', description: '固定为 false' },
};

export function createTools({
  exposeModelChoice = false,
  defaultProvider = DEFAULT_PROVIDER,
  defaultModel = DEFAULT_MODEL_ID,
  defaultReasoningEffort = DEFAULT_REASONING_EFFORT,
} = {}) {
  const fields = exposeModelChoice
    ? TASK_FIELDS
    : Object.fromEntries(Object.entries(TASK_FIELDS)
      .filter(([name]) => name !== 'model' && name !== 'provider' && name !== 'reasoningEffort'));

  const route = exposeModelChoice
    ? `默认路由 ${defaultProvider}:${defaultModel}，推理档位 ${defaultReasoningEffort || '(provider 默认)'}；可用 provider/model/reasoningEffort 覆盖。`
    : `本部署固定使用 ${defaultProvider}:${defaultModel}（推理档位 ${defaultReasoningEffort || '(provider 默认)'}），不能按任务改模型。`;

  const tools = [
    {
      name: 'dsh_delegate',
      description: [
        '把一项边界明确的任务委派给 DSH worker：先做契约校验，落盘成功即返回任务 id。',
        `默认等待结算至多 ${DEFAULT_WAIT_MS / 1000} 秒（waitMs 可调，上限 ${MAX_WAIT_MS}）：预算内结算就直接带回结果，`,
        '超时不算失败、任务仍在继续，返回里会说明。一次委派只花一次往返，',
        '因此请把相关工作合并成一项任务，而不是拆成很多小任务。',
        route,
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          ...fields,
          waitMs: {
            type: 'integer',
            description: `等待结算的毫秒数，0 表示立即返回；默认 ${DEFAULT_WAIT_MS}，上限 ${MAX_WAIT_MS}`,
          },
        },
        required: ['id', 'objective', 'phase', 'workspace', 'plan', 'acceptance'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_status',
      description: [
        '查询任务状态。给 id 查单个任务；不给 id 返回摘要：需要关注的 unknown/cancelling/needs_clarification 全部列出，',
        `其余按更新时间倒序最多 ${DEFAULT_STATUS_LIMIT} 条（limit 可调）。`,
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id；省略则返回摘要' },
          limit: { type: 'integer', description: `摘要里最多列出多少条普通任务，默认 ${DEFAULT_STATUS_LIMIT}` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_result',
      description: '取回任务结果文本与证据（停止原因、工具调用数、用量）。未结算时返回当前状态、不阻塞。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_reply',
      description: '回答 worker 的澄清问题，让该任务继续。仅在任务状态为 needs_clarification 时有效。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, answer: { type: 'string' } },
        required: ['id', 'answer'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_resolve',
      description: [
        '对 result 未观测到的任务（**只限 unknown**）做一次**显式人工裁定**，',
        '并把裁定、理由与时间写进记录。裁定只在人（或主控）做出判断后使用：',
        'retry=放回队列（桥不会自动重发）、keep_failed=按未成功结案、abandoned=明确放弃核对、',
        'keep_completed=按已观测证据结案为完成。实际上没有观测到的结果不该被伪造成 failed。',
        '注意：cancelling 不接受裁定 —— 它表示可能仍有 worker 在跑，请等它落定到 cancelled 或 unknown。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['retry', 'keep_failed', 'abandoned', 'keep_completed'],
            description: '裁定内容',
          },
          reason: { type: 'string', description: '理由（必填）：看了什么、据此判定了什么' },
          actor: { type: 'string', description: '做出裁定的一方，默认 operator' },
        },
        required: ['id', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_retry',
      description: [
        '对已经由 `dsh_resolve` 裁定为 retry 的任务做**一次显式重放**。',
        '为什么需要单独的入口：`dsh_resolve` 的 retry 只把任务放回队列并留言',
        '「是否重发由调用方决定」，但以相同 id 再 delegate 只会返回那条 queued 记录 ——',
        '也就是当初没有任何执行入口。这里补上，并刻意**不做自动重放**',
        '不得自动重放未知任务；每条记录**只能重放一次**，',
        '重放事实与理由都落盘。需要再试请用新的任务 id。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: '重放理由（必填）：为什么认为可以重放' },
          actor: { type: 'string', description: '发起重放的一方，默认 operator' },
        },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_cancel',
      description: '请求取消任务。取消是请求，桥会观察实际结算；未观测到结算时任务标记为 unknown 而非假装已完成。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];

  if (exposeModelChoice) {
    tools.push({
      name: 'dsh_models',
      description: [
        '列出该 DSH worker 实际公布的模型与推理档位。',
        '它会启动一个 worker 并建一次会话来读取目录，但不发送提示、不消耗模型调用；结果会缓存。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: { refresh: { type: 'boolean', description: 'true 表示忽略缓存重新发现；默认 true' } },
        additionalProperties: false,
      },
    });
  }
  tools.push({ name: 'dsh_approvals', description: '查看 DSH 实际请求的待处理审批。只观测，不授予权限。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } });
  tools.push({ name: 'dsh_approve', description: '回传已有用户授权的审批决定。选项必须来自原请求；若没有授权应先向用户提出具体审批。',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, optionId: { type: 'string' }, reason: { type: 'string' } },
      required: ['requestId', 'optionId', 'reason'], additionalProperties: false } });
  return tools;
}

export const TOOLS = Object.freeze(createTools());

const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message, extra = {}) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
});

export class McpServer {
  #bridge;
  #version;
  #initialized = false;
  #tools;
  #maxWaitMs;

  constructor({ bridge, version = BRIDGE_VERSION, exposeModelChoice = null, defaults = {}, maxWaitMs = MAX_WAIT_MS }) {
    if (!bridge) throw new Error('bridge_required');
    this.#bridge = bridge;
    this.#version = version;
    this.#maxWaitMs = Math.min(maxWaitMs, MAX_WAIT_MS);

    const enabled = exposeModelChoice === null ? bridge.modelChoiceEnabled === true : exposeModelChoice === true;
    const selection = bridge.selectionDefaults ?? {};
    this.#tools = Object.freeze(createTools({
      exposeModelChoice: enabled,
      defaultProvider: defaults.provider ?? selection.provider ?? DEFAULT_PROVIDER,
      defaultModel: defaults.model ?? selection.modelId ?? DEFAULT_MODEL_ID,
      defaultReasoningEffort: defaults.reasoningEffort ?? selection.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    }));
  }

  get tools() { return [...this.#tools]; }
  get initialized() { return this.#initialized; }

  initialize(params) { return this.#initialize(params); }

  async handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id ?? null, -32600, 'invalid_request');
    }
    const isNotification = message.id === undefined || message.id === null;
    try {
      switch (message.method) {
        case 'initialize':
          return this.#reply(isNotification, message.id, this.#initialize(message.params));
        case 'notifications/initialized':
          this.#initialized = true;
          return null;
        case 'ping':
          return this.#reply(isNotification, message.id, {});
        case 'tools/list':
          return this.#reply(isNotification, message.id, { tools: this.#tools });
        case 'tools/call':
          return this.#reply(isNotification, message.id, await this.#call(message.params));
        default:
          if (isNotification) return null;
          return rpcError(message.id, -32601, `unknown_method:${message.method}`);
      }
    } catch (error) {
      if (isNotification) return null;
      return rpcError(message.id, -32603, error?.message ?? 'internal_error');
    }
  }

  #reply(isNotification, id, result) {
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  }

  #initialize(params) {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: BRIDGE_NAME, version: this.#version },
      instructions: [
        '本服务把 Codex 的任务委派给 DSH worker，由你规划和验收。',
        `dsh_delegate 默认阻塞等待至多 ${DEFAULT_WAIT_MS / 1000} 秒并在结算时直接带回结果；超时不算失败，任务仍在继续。`,
        `若任务等待澄清，用 dsh_reply 回答；worker 提问时会在正文中输出 ${CLARIFY_MARKER}。`,
        '状态 unknown 表示结果未观测到、可能已产生副作用：不要直接重试，先核对；核对后用 dsh_resolve 做出显式裁定。',
        'completed 只表示 worker 执行结束，不代表验收通过；验收是你的责任。',
        '为省额度与往返：把相关工作合并成一项任务，而不是拆成很多小任务；同阶段会复用会话。',
      ].join('\n'),
    };
  }

  async #call(params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== 'string') return fail('missing_tool_name');
    switch (name) {
      case 'dsh_approvals': return ok({ pending: this.#bridge.approvals.list(args.id) });
      case 'dsh_approve':
        try { return ok(this.#bridge.approvals.decide(args)); }
        catch (error) { return fail(error.message, { code: error.code ?? 'approval_failed' }); }
      case 'dsh_delegate':
        return this.#delegate(args);
      case 'dsh_status':
        return this.#status(args);
      case 'dsh_result':
        return this.#result(args);
      case 'dsh_reply':
        return this.#replyToTask(args);
      case 'dsh_resolve':
        return this.#resolve(args);
      case 'dsh_retry':
        return this.#retry(args);
      case 'dsh_cancel':
        return this.#cancel(args);
      case 'dsh_models':
        return this.#models(args);
      default:
        return fail(`unknown_tool:${name}`);
    }
  }

  async #delegate(args) {
    const { waitMs, ...contract } = args;
    const budget = clampWait(waitMs, DEFAULT_WAIT_MS, this.#maxWaitMs);
    try {
      const view = await this.#bridge.delegate(contract, { wait: false });

      if (isSettled(view.status) || budget <= 0) {
        return ok({ ...view, waited: false, settled: isSettled(view.status), next: nextStep(view) });
      }
      const waited = await this.#bridge.waitForTask(contract.id, budget);
      return ok({
        ...waited.view,
        waited: true,
        settled: waited.settled,
        budgetMs: budget,
        next: waited.settled
          ? nextStep(waited.view)
          : `等待 ${budget}ms 未结算，任务仍在继续；可再用 dsh_status / dsh_result 取回，或再次 dsh_delegate 同一 id（幂等，会继续等待）。`,
      });
    } catch (error) {
      return fail(error.message ?? 'delegate_failed', { code: error.code ?? 'error', details: error.detail ?? undefined });
    }
  }

  #status(args) {
    try {
      if (args.id !== undefined) return ok(this.#bridge.status(args.id));
      const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : DEFAULT_STATUS_LIMIT;
      const tasks = this.#bridge.list();
      const attention = tasks.filter(task => (['unknown', 'cancelling', 'needs_clarification'].includes(task.status) || task.pendingApprovals?.length));
      const rest = tasks
        .filter(task => !attention.includes(task))
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      return ok({
        count: tasks.length,
        needs_attention: attention,
        recent: rest.slice(0, limit),
        omitted: Math.max(0, rest.length - limit),
        note: tasks.length === 0
          ? '当前没有任务。'
          : 'needs_attention 里的每一条都需要一个明确决定，不能直接重发。',
      });
    } catch (error) {
      return fail(error.message ?? 'status_failed', { code: error.code ?? 'error' });
    }
  }

  #result(args) {
    try {
      return ok(this.#bridge.result(args.id));
    } catch (error) {
      return fail(error.message ?? 'result_failed', { code: error.code ?? 'error' });
    }
  }

  async #replyToTask(args) {
    try {
      const view = await this.#bridge.reply(args.id, args.answer);
      return ok({ ...view, next: '任务已继续，用 dsh_status 查询进展' });
    } catch (error) {
      return fail(error.message ?? 'reply_failed', { code: error.code ?? 'error' });
    }
  }

  async #retry(args) {
    try {
      return ok(await this.#bridge.retry(args.id, {
        reason: args.reason,
        actor: args.actor ?? 'caller',
      }));
    } catch (error) {
      return fail(error.message ?? 'retry_failed', { code: error.code ?? 'error' });
    }
  }

  #resolve(args) {
    try {
      return ok(this.#bridge.resolve(args.id, {
        verdict: args.verdict,
        reason: args.reason,
        actor: args.actor ?? 'caller',
      }));
    } catch (error) {
      return fail(error.message ?? 'resolve_failed', { code: error.code ?? 'error' });
    }
  }

  async #cancel(args) {
    try {
      return ok(await this.#bridge.cancel(args.id, { reason: args.reason ?? 'caller requested' }));
    } catch (error) {
      return fail(error.message ?? 'cancel_failed', { code: error.code ?? 'error' });
    }
  }

  async #models(args) {
    if (!this.#tools.some(tool => tool.name === 'dsh_models')) {
      return fail('model_choice_disabled', {
        hint: '本桥未启用模型选择；需要操作者用 --expose-model-choice 或配置项 exposeModelChoice 启用。',
      });
    }
    try {
      const discovered = await this.#bridge.discoverModels({ refresh: args.refresh !== false });
      const summary = discovered.summary;
      const selection = this.#bridge.selectionDefaults;
      return ok({
        at: discovered.at,
        cached: discovered.cached,
        current: summary?.model?.currentValue ?? null,
        models: (summary?.model?.choices ?? []).map(choice => ({
          value: choice.value,
          provider: describeSelector(choice.value)?.provider ?? choice.group ?? null,
          modelId: describeSelector(choice.value)?.modelId ?? choice.name,
          name: choice.name,
          group: choice.group,
        })),
        reasoning: summary?.reasoning == null ? null : {
          current: summary.reasoning.currentValue ?? null,
          options: (summary.reasoning.choices ?? []).map(choice => ({ value: choice.value, name: choice.name })),
        },
        defaults: {
          provider: selection.provider,
          model: selection.modelId,
          reasoningEffort: selection.reasoningEffort,
          selector: selection.selector,
        },
        note: '本次只建会话读目录，未发送提示，因此没有消耗模型调用。',
      });
    } catch (error) {
      return fail(error.message ?? 'discovery_failed', { code: error.code ?? 'error', details: error.detail ?? undefined });
    }
  }
}

export function clampWait(requested, fallback, max) {
  if (requested === undefined || requested === null) return Math.min(fallback, max);
  if (!Number.isSafeInteger(requested) || requested < 0) return Math.min(fallback, max);
  return Math.min(requested, max);
}

const isSettled = status => ['completed', 'failed', 'cancelled', 'unknown'].includes(status);

function nextStep(view) {
  if (view?.pendingApprovals?.length) return 'DSH 等待审批；用 dsh_approvals 查看实际选项，取得用户授权后通过 dsh_approve 回传';
  switch (view?.status) {
    case 'needs_clarification':
      return 'worker 提出问题，请用 dsh_reply 回答';
    case 'unknown':
      return '结果未观测到：先核对工作区，再决定重试或结案；不要直接重发';
    case 'completed':
      return 'worker 已结束，请用 dsh_result 取回正文并按验收标准判定';
    case 'failed':
      return '派发或执行失败，见 error；修正原因后再提交';
    default:
      return '用 dsh_status 查询进展，用 dsh_result 取结果';
  }
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function serveStdio({ input, output, server }) {
  let buffer = '';
  const write = message => {
    if (message === null) return;
    output.write(`${JSON.stringify(message)}\n`);
  };
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(rpcError(null, -32700, 'parse_error'));
        continue;
      }
      server.handle(message).then(
        write,
        error => write(rpcError(message?.id ?? null, -32603, error?.message ?? 'internal_error')),
      );
    }
  });
  return new Promise(resolve => input.on('end', resolve));
}
