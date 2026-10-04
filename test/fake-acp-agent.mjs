/**
 * Scriptable fake ACP agent used by the offline test suite.
 *
 * It implements the *verified* wire contract of @deepseek-ai/dsh-acp — protocol
 * version 1, `session/new` returning `{sessionId, configOptions}`, one prompt per
 * session at a time, ordered `session/update` notifications, a `session/prompt`
 * response carrying a `stopReason`, and `session/request_permission` for the
 * client — so the bridge can be tested end to end with zero model calls, zero
 * credentials and zero quota.
 *
 * It is a *simulation*, not a claim about DSH behaviour beyond those shapes; the
 * real handshake is exercised separately by the host self-test.
 *
 * Environment knobs (used by the tests):
 *   FAKE_SCENARIO   normal | clarify | permission | slow | silent | crash | stop_refusal | fail_prompt
 *   FAKE_STATE      file recording sessions and prompts, so resume/new is observable
 *   FAKE_DELAY_MS   delay before answering a prompt
 *   FAKE_WRITE      file to create when the permission scenario is allowed
 *   FAKE_LOG        append per-frame diagnostics
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SCENARIO = process.env.FAKE_SCENARIO ?? 'normal';
const STATE = process.env.FAKE_STATE ?? null;
const DELAY = Number(process.env.FAKE_DELAY_MS ?? '0');
const WRITE_TARGET = process.env.FAKE_WRITE ?? null;
const LOG = process.env.FAKE_LOG ?? null;
const PROTOCOL_VERSION = 1;

/**
 * The catalogue this fake publishes. It mirrors the real shape: model ids of the
 * form \`provider/model\`, grouped per provider, plus a reasoning option that
 * only exists for models declaring reasoning. FAKE_NO_CATALOGUE=1 simulates a
 * worker that publishes nothing — the case where the bridge must defer to the
 * worker instead of inventing a verdict.
 */
/** Route selector, exactly as the real server encodes it. */
const selector = (provider, model) => JSON.stringify([provider, model]);

const CATALOGUE_GROUPS = [
  { group: 'deepseek-official', name: 'DeepSeek Official', options: [
    { value: selector('deepseek-official', 'deepseek-flash'), name: 'deepseek-flash' },
    { value: selector('deepseek-official', 'deepseek-v4-pro'), name: 'deepseek-v4-pro' },
  ] },
  { group: 'other-provider', name: 'Other', options: [
    { value: selector('other-provider', 'small-model'), name: 'small-model' },
  ] },
];
const DEFAULT_ROUTE = selector('deepseek-official', 'deepseek-flash');
const NO_CATALOGUE = process.env.FAKE_NO_CATALOGUE === '1';

/** Read a selector value the way the real client does; never throws. */
const readSelector = value => {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2) return { provider: parsed[0], model: parsed[1] };
  } catch { /* not the documented encoding */ }
  return {};
};

/** Build configOptions for a session, honouring a per-session chosen route. */
const configOptionsFor = session => {
  const current = session?.route ?? DEFAULT_ROUTE;
  if (NO_CATALOGUE) {
    return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current, options: [] }];
  }
  const groups = CATALOGUE_GROUPS.map(entry => ({
    group: entry.group,
    name: entry.name,
    options: entry.options.filter(option => option.value !== current),
  })).filter(entry => entry.options.length > 0);
  const provider = readSelector(current).provider ?? 'unknown';
  const existing = groups.find(entry => entry.group === provider);
  const currentEntry = { value: current, name: readSelector(current).model ?? current };
  if (existing) existing.options.unshift(currentEntry);
  else groups.unshift({ group: provider, name: provider, options: [currentEntry] });
  const options = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current, options: groups }];
  // Reasoning exists only for models that declare it — the bridge must not assume it.
  if (current !== selector('other-provider', 'small-model')) {
    options.push({
      id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
      currentValue: session?.effort ?? 'medium',
      options: [
        { value: '', name: 'Provider default' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    });
  }
  return options;
};

const log = entry => {
  if (!LOG) return;
  try {
    appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  } catch { /* diagnostics only */ }
};

const readState = () => {
  if (!STATE) return { sessions: [], prompts: 0, resumed: 0 };
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return { sessions: [], prompts: 0, resumed: 0 };
  }
};
const writeState = patch => {
  if (!STATE) return;
  // 记录自己的 PID：收尾类验收需要**独立确认这个 worker 真的结束了**，
  // 而不是只看「桥进程退出了」——复核 N5 指出，只检查桥的 PID 无法验证任何 worker 的结束。
  const next = { ...readState(), pid: process.pid, ...patch };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(next, null, 2));
};

/** Active sessions on this connection: sessionId -> {cwd, busy}. */
const sessions = new Map();

// **不要把持久会话预置进 active 表** —— 复核 V1 的判定依据：
// 我原先就是这么做的，而 resume 的第一条守卫是 `sessions.has(id)`，
// 于是预置**恰好让恢复永远失败**（一律 `session is already active`），
// 报告 2.5 声称的「预置让成功恢复可走通」与事实相反。
//
// 正确的区分（复核建议）：**持久会话库**与**本连接 active 表**是两件事。
// 持久库由状态文件承担（resume 时从中查），active 表只在本连接真正建立/恢复会话后才有条目。
// `resume` 从持久库读入 cwd/route/effort，再加入 active —— 这才是真实 worker 的形态。

const permission = new Map();
let nextId = 1;
const pendingPermissions = new Map();

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

/**
 * 真的产生副作用，然后按指定方式损坏响应流 —— 用于复现"提交后观测失败"（R1）。
 *
 * 三种方式对应客户端的三条真实错误路径：
 *   invalid_response     响应里有 result 之外的形状（这里发一条没有 result 的同 id 响应）
 *   unexpected_response  响应的 id 不是任何在途请求
 *   incomplete_frame     不完整的 JSON 之后关闭 stdout
 */
async function effectThenMangle(sessionId, requestId, mode) {
  // 副作用先落地：这是"执行真的发生过"的证据
  if (process.env.FAKE_SIDE_EFFECT) {
    try { writeFileSync(process.env.FAKE_SIDE_EFFECT, 'side effect\n'); } catch { /* 忽略 */ }
  }
  notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-r1', title: 'fs_write', status: 'completed' });
  const raw = text => process.stdout.write(text);
  if (mode === 'effect_then_invalid_response') {
    raw(`${JSON.stringify({ jsonrpc: '2.0', id: requestId })}\n`); // 无 result、无 error
    return;
  }
  if (mode === 'effect_then_unexpected_response') {
    raw(`${JSON.stringify({ jsonrpc: '2.0', id: 'not-a-pending-id', result: { stopReason: 'end_turn' } })}\n`);
    return;
  }
  // incomplete_frame：写半条 JSON 就关闭 stdout
  raw('{"jsonrpc":"2.0","id":1,"resu');
  await new Promise(resolve => setTimeout(resolve, 20));
  process.stdout.end();
}

const notify = (sessionId, update) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update },
});

const chunk = (sessionId, text, messageId = 'm1') => notify(sessionId, {
  sessionUpdate: 'agent_message_chunk',
  messageId,
  content: { type: 'text', text },
});

const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id,
  error: { code, message, ...(data === undefined ? {} : { data }) } });

const requestPermission = (sessionId, toolCall) => new Promise(resolve => {
  const id = nextId++;
  pendingPermissions.set(id, resolve);
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
});

async function handlePrompt(id, params) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) return fail(id, -32602, `unknown session: ${sessionId}`);
  if (session.busy) return fail(id, -32602, 'a prompt is already in flight for this session');
  session.busy = true;
  session.promptId = id;
  const state = readState();
  writeState({
    prompts: state.prompts + 1,
    lastPrompt: (params.prompt ?? []).map(block => block.text ?? '').join(''),
    // **每次提示都记下该会话的「实际生效档位」**，供测试独立核对。
    //
    // 为什么需要（复核 T2 的判定依据）：F5 的两条测试原先只把公开报告与桥自己写进
    // SessionMap 的 route 相比 —— 那是**桥的自报值**。把真正设置档位的 RPC 删掉之后，
    // 桥照旧自报 high/low，而 fake 侧实际一直是 medium，测试却仍然全绿。
    // 这个字段让外部能独立看到「worker 到底被设成了什么」。
    promptEfforts: [...(state.promptEfforts ?? []), { sessionId: params.sessionId, effort: session.effort ?? null }],
    // **记录完整的实际 prompt 文本**（复核 X2 的判定依据）：
    // 桥自己保存的 `lastPromptText` 是"拟发送"的记录 —— 如果发送路径退回旧实现，
    // 那份记录仍然是对的，于是测试全绿而实际发出去的内容是错的。
    // 只有 fake 侧的**线上文本**才是独立证据。
    promptTexts: [...(state.promptTexts ?? []), {
      sessionId: params.sessionId,
      text: (params.prompt ?? []).map(block => block.text ?? '').join(''),
    }],
  });

  if (SCENARIO === 'crash') {
    process.exit(9);
  }
  if (SCENARIO === 'silent') {
    // Never answer: the client must time out and the bridge must report `unknown`.
    return;
  }
  if (DELAY > 0) await new Promise(resolve => setTimeout(resolve, DELAY));

  try {
    switch (SCENARIO) {
      // 沙箱边界探针的离线替身：探针会发两条提示（一条写对照文件、一条尝试越界），
      // 这里**只真正创建工作区内那个对照文件**，越界一律只在文本里提及 ——
      // 于是判定应当给出 not_attempted，而不是声称「全部越界目标都尝试过」。
      // 有它，探针的完整控制流就能在不接触真实 worker 的前提下跑通（复核 U1 的要求）。
      case 'boundary_probe': {
        const inside = join(process.env.FAKE_WORKSPACE ?? process.cwd(), 'dsh-probe-inside-workspace.txt');
        writeFileSync(inside, 'control-file-created-by-offline-adapter');
        notify(sessionId, {
          sessionUpdate: 'tool_call', toolCallId: 'probe-control', status: 'completed',
          title: 'bash',
          rawInput: { command: `printf '%s' control > ${inside}` },
        });
        chunk(sessionId, `已写入对照文件：${inside}\n`);
        // 只**打印**三条越界路径：证明「提及」不等于「尝试」
        notify(sessionId, {
          sessionUpdate: 'tool_call', toolCallId: 'probe-mention', status: 'completed',
          title: 'bash',
          rawInput: { command: "printf '%s\\n' '/etc/dsh-probe-review' '/tmp/dsh-probe-persistence-check.txt'" },
        });
        chunk(sessionId, '越界路径仅列出，未执行写入。\n');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });
      }
      case 'clarify':
        chunk(sessionId, '我需要一个前提。\n');
        chunk(sessionId, '<<BRIDGE_CLARIFY>> 噪声约定的标准差是多少？', 'm2');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });

      case 'clarify_once':
        // Ask exactly once: after the caller answers, the same session finishes
        // the work. This is what makes the "reply then continue" path testable.
        if (readState().prompts <= 1) {
          chunk(sessionId, '先确认前提。\n');
          chunk(sessionId, '<<BRIDGE_CLARIFY>> 噪声约定的标准差是多少？', 'm2');
          session.busy = false;
          return ok(id, { stopReason: 'end_turn' });
        }
        chunk(sessionId, '按你给的标准差完成计算，结论见下。', 'm3');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });

      case 'clarify_twice': {
        // 前两次提示都要求澄清，第三次完成。**状态跨桥共享**（同一个 FAKE_STATE），
        // 所以「同一份答案重发」与「换成更正的答案」都可以在这种历史下观察。
        // 复核 X4 需要一个「已有已提交历史 + 一次未提交尝试」的场景。
        if (readState().prompts <= 2) {
          chunk(sessionId, '先确认前提。\n');
          chunk(sessionId, `<<BRIDGE_CLARIFY>> 第 ${readState().prompts} 次确认，请给个值？`, 'm2');
          session.busy = false;
          return ok(id, { stopReason: 'end_turn' });
        }
        chunk(sessionId, '按你给的值完成，结论见下。', 'm3');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });
      }

      case 'denied': {
        chunk(sessionId, '尝试写入。\n');
        const outcome = await requestPermission(sessionId, {
          toolCallId: 'call-1', title: 'Write file', name: 'fs_write', kind: 'edit',
        });
        const allowed = outcome.outcome === 'selected' && outcome.optionId === 'allow-once';
        log({ event: 'permission_outcome', outcome });
        session.busy = false;
        if (!allowed) {
          chunk(sessionId, '权限被拒绝，未写入任何文件。', 'm2');
          return ok(id, { stopReason: 'end_turn' });
        }
        return ok(id, { stopReason: 'end_turn' });
      }

      case 'permission': {
        chunk(sessionId, '开始工作。\n');
        // 仿**真实** DSH 的顺序与形状（复核 F11 的判定依据）：
        //   1) 先发 tool_call 通知，工具名在 `title` 里（dsh-acp 的 toolCallUpdate:
        //      `title: event.data.name`）；
        //   2) 再发审批请求，而审批报文**只有 toolCallId**，不带名字
        //      （dsh-acp 构造的是 `toolCall: { toolCallId: callId }`）。
        // 旧版 fake 把 name 塞进审批报文，于是"桥只看审批报文"这个缺口永远测不出来，
        // 而真实运行里白名单会因此完全失效。
        notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'fs_write', status: 'in_progress' });
        const outcome = await requestPermission(sessionId, { toolCallId: 'call-1' });
        const allowed = outcome.outcome === 'selected' && outcome.optionId === 'allow-once';
        log({ event: 'permission_outcome', outcome });
        if (allowed && WRITE_TARGET) {
          mkdirSync(dirname(WRITE_TARGET), { recursive: true });
          writeFileSync(WRITE_TARGET, 'written with permission\n');
          notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Write result file', name: 'fs_write', kind: 'edit', status: 'in_progress' });
          notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });
        }
        chunk(sessionId, allowed ? '已写入结果文件。' : '权限被拒绝，未写入。', 'm2');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });
      }

      case 'silent_success':
        // 关键场景：worker 报 end_turn，但既没有正文也没有工具调用。
        // 「看起来完成了」与「确实有产出」在这里必须能被区分开。
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });

      case 'stop_refusal':
        chunk(sessionId, '无法在给定假设下继续。');
        session.busy = false;
        return ok(id, { stopReason: 'refusal' });

      case 'boundary_probe_then_fail': {
        // 沙箱探针的离线替身，但在**对照文件已创建之后**让 prompt 失败。
        // 用于验证探针的**异常路径清理**（复核 W4 的判定依据）：
        // 原先 finally 只处理 worker、不调 cleanupWorkspaceFile，
        // 于是入口退出 1 而对照文件**仍然存在**。
        const inside = join(process.env.FAKE_WORKSPACE ?? process.cwd(), 'dsh-probe-inside-workspace.txt');
        writeFileSync(inside, 'control-file-created-before-the-failure');
        // **留痕：我真的创建了对照文件**（复核 Y6 的判定依据）。
        // 否则"退出非零 + 文件不存在"在"worker 根本没启动、从未创建文件"时也成立 ——
        // 测试就无法证明自己覆盖了所声称的异常清理路径。
        const before = readState();
        writeState({ controlFileCreatedByFake: true, controlFileCreatedAt: new Date().toISOString(),
          priorPromptCount: before.prompts });
        // **真握手**（复核 Y6 的建议）：创建之后**暂停**，等父测试亲自确认文件存在，
        // 再放行让 prompt 失败。这样「已创建」是**父测试测到的前置条件**，
        // 而不是 fake 自己的自报 —— 否则在"fake 根本不创建"的变异下，
        // "非零退出 + 最终没有文件"仍然成立，测试就没覆盖所称的路径。
        const goFile = process.env.FAKE_GO_FILE;
        if (goFile) {
          const waitUntil = Date.now() + 20000;
          while (!existsSync(goFile) && Date.now() < waitUntil) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        session.busy = false;
        return fail(id, -32603, 'injected failure after creating the control file');
      }

      case 'fail_prompt':
        session.busy = false;
        return fail(id, -32603, 'internal error from fake agent');

      case 'flood_after_tool_call': {
        // 复现 F2 的形态：提示**已经在飞**，期间**已经产生副作用**（写出文件、报了 tool_call），
        // 然后输出量撑爆客户端的字节上限。桥的客户端此时抛 AcpError('output_limit')，
        // 而那次执行是**真的发生过**的。
        if (process.env.FAKE_SIDE_EFFECT) {
          try { writeFileSync(process.env.FAKE_SIDE_EFFECT, 'side effect\n'); } catch { /* 忽略 */ }
        }
        notify(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-f2',
          title: 'write',
          status: 'completed',
        });
        // 稍作延迟再淹没：让 prompt 请求先进入"在飞"状态（这正是真实时序）。
        // 立即洪泛会打到"提示还没提交"的窗口，测到的就不是回想要测的那一格。
        const flood = `${'x'.repeat(64 * 1024)}\n`;
        const timer = setInterval(() => {
          process.stdout.write(flood.repeat(80));
        }, 5);
        void timer;
        // 永不返回响应：客户端会因为 output_limit 自行失败。
        return undefined;
      }

      case 'effect_then_invalid_response':
      case 'effect_then_unexpected_response':
      case 'effect_then_incomplete_frame': {
        // 复核 R1 的三个反例：**先真的产生副作用**，再用三种"响应/帧失真"让客户端失败。
        // 这些错误码都不在 UNKNOWN_OUTCOME_CODES 里，于是桥原先按"提交前失败"处理，
        // 记成 failed/no_prompt —— 而副作用文件确实存在，把已执行说成没执行。
        await effectThenMangle(sessionId, id, SCENARIO);
        return undefined; // 不返回正常响应：让客户端因畸形帧自行失败
      }

      case 'usage_series': {
        // 一个提示内多次 usage_update —— 真实 worker 就是这么发的。
        // 第三个数比第二个小：用来验证"占用回退（驱逐/压缩）可被辨识"。
        notify(sessionId, { sessionUpdate: 'usage_update', used: 1000, size: 1000000 });
        notify(sessionId, { sessionUpdate: 'usage_update', used: 2500, size: 1000000 });
        notify(sessionId, { sessionUpdate: 'usage_update', used: 1800, size: 1000000 });
        notify(sessionId, { sessionUpdate: 'usage_update', used: 4200, size: 1000000 });
        chunk(sessionId, '占用曲线已记录。');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });
      }

      case 'notifications':
        notify(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考中' } });
        notify(sessionId, { sessionUpdate: 'usage_update', used: 42, size: 1000000 });
        chunk(sessionId, '完成。');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn', usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } });

      default:
        chunk(sessionId, `已完成任务：${(params.prompt ?? []).map(b => b.text ?? '').join('').slice(0, 40)}\n`);
        chunk(sessionId, '证据：本回复由 fake ACP agent 生成，未调用任何模型。', 'm2');
        session.busy = false;
        return ok(id, { stopReason: 'end_turn' });
    }
  } catch (error) {
    session.busy = false;
    return fail(id, -32603, String(error?.message ?? error));
  }
}

function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params } = message;

  // Responses to our permission requests.
  if (method === undefined && pendingPermissions.has(id)) {
    const resolve = pendingPermissions.get(id);
    pendingPermissions.delete(id);
    resolve(message.result?.outcome ?? { outcome: 'cancelled' });
    return;
  }

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      });

    case 'authenticate':
      return ok(id, {});

    case 'session/new': {
      if (params.additionalDirectories?.length) {
        return fail(id, -32602, 'additionalDirectories is not supported');
      }
      const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
      sessions.set(sessionId, { cwd: params.cwd, busy: false, route: DEFAULT_ROUTE, effort: 'medium' });
      const state = readState();
      // 必须落盘。真实 worker 的会话在**持久会话存储**里，进程重启后能 resume；
      // 这个 fake 原先只把会话放在内存，而每轮委派都是一个新进程 —— 于是 resume 永远失败，
      // 桥只能轮换会话。一个关于"会话复用"的测试因此测的是一个假现象。
      writeState({ sessions: [...state.sessions, { sessionId, cwd: params.cwd, created: true }] });
      return ok(id, { sessionId, configOptions: configOptionsFor(sessions.get(sessionId)) });
    }

    case 'session/resume': {
      // Protocol-negative controls, deliberately unlike a conforming worker.
      if (SCENARIO === 'resume_missing_fields') return send({ jsonrpc: '2.0', id });
      if (SCENARIO === 'resume_null_error') return send({ jsonrpc: '2.0', id, error: null });
      if (SCENARIO === 'resume_both_fields') return send({ jsonrpc: '2.0', id, result: {},
        error: { code: -32603, message: 'Internal error' } });
      // **诊断场景**：resume 失败，且把细节放进 `data` —— 这正是 DSH 的形态。
      //
      // `@agentclientprotocol/sdk/dist/jsonrpc.js` 的 `errorToResult()` 对**普通异常**：
      //     const details = errorDetails(error);
      //     RequestError.internalError(details ? JSON.parse(details) : {})
      // ⇒ `message` 只是通用文案 `Internal error`，**细节在 `data`**。
      // 桥原先只取 `message`+`code` 而丢掉 `data` ⇒ 根因最可能的载体被丢在两层之外。
      // **记下收到的请求 id**（复核 AP5 的判定依据）：
      // 这样才能断言桥保留的 `requestId` 是**真实收到的那个**，
      // 而不是随便一个数字（复核实测：改成恒定 999999，旧断言仍通过）。
      writeState({ resumeRequestIds: [...(readState().resumeRequestIds ?? []), id] });
      // **记下收到的请求 id**（复核 AP5 的判定依据）：
      // 这样才能断言桥保留的 `requestId` 是**真实收到的那个**，
      // 而不是随便一个数字（复核实测：改成恒定 999999，旧断言仍通过）。
      writeState({ resumeRequestIds: [...(readState().resumeRequestIds ?? []), id] });
      if (process.env.FAKE_RESUME_DATA !== undefined) {
        return fail(id, -32603, 'Internal error', { details: process.env.FAKE_RESUME_DATA });
      }
      // 真实 DSH 的第一条守卫（dsh-acp/lib/index.js 的 resumeSession 开头）：
      //   if (sessions.has(id) || activating.has(id) || ctx.sessions.get(id) !== undefined)
      //     throw invalidParams(`session is already active: ${id}`)
      // 这个 fake 原先没有它，于是"桥对**本进程自己刚建的活跃会话**调用 resume"这个缺陷
      // 永远测不出来 —— 一个只会在真实运行里暴露的桥端 bug。补上，让两者在这一条上一致。
      if (sessions.has(params.sessionId)) {
        return fail(id, -32602, `session is already active: ${params.sessionId}`);
      }
      const state = readState();
      const known = state.sessions.find(entry => entry.sessionId === params.sessionId);
      if (!known) return fail(id, -32602, `session is not resumable: ${params.sessionId}`);
      if (known.cwd !== params.cwd) return fail(id, -32602, `session cwd does not match: ${params.cwd}`);
      sessions.set(params.sessionId, {
        cwd: params.cwd,
        busy: false,
        route: known.route ?? DEFAULT_ROUTE,
        effort: known.effort ?? 'medium',
      });
      writeState({ resumed: state.resumed + 1, sessions: state.sessions.map(entry => (entry.sessionId === params.sessionId ? { ...entry, resumed: true } : entry)) });
      return ok(id, { configOptions: configOptionsFor(sessions.get(params.sessionId)) });
    }

    case 'session/list': {
      const state = readState();
      const all = state.sessions.filter(entry => params.cwd === undefined || entry.cwd === params.cwd);
      return ok(id, { sessions: all.map(entry => ({ sessionId: entry.sessionId, cwd: entry.cwd })) });
    }

    case 'session/close':
      sessions.delete(params.sessionId);
      return ok(id, {});

    case 'session/set_config_option': {
      const session = sessions.get(params.sessionId);
      if (!session) return fail(id, -32602, `unknown session: ${params.sessionId}`);
      const known = new Set(['model', 'reasoning_effort']);
      if (!known.has(params.configId)) return fail(id, -32602, `unknown session config option: ${params.configId}`);
      if (params.configId === 'model') {
        const legal = NO_CATALOGUE ? null : CATALOGUE_GROUPS.flatMap(entry => entry.options.map(option => option.value));
        if (legal !== null && !legal.includes(params.value)) {
          return fail(id, -32602, `cannot resolve model route: ${params.value}`);
        }
        session.route = params.value;
      } else {
        session.effort = params.value;
      }
      const state = readState();
      writeState({
        configSets: [...(state.configSets ?? []), { configId: params.configId, value: params.value, sessionId: params.sessionId }],
        // 路由也要存回 state：这样进程重启后 resume 能恢复它，configOptions 才是持续的
        sessions: state.sessions.map(item => (item.sessionId === params.sessionId
          ? { ...item, ...(params.configId === 'model' ? { route: params.value } : { effort: params.value }) }
          : item)),
      });
      return ok(id, { configOptions: configOptionsFor(session) });
    }

    case 'session/prompt':
      handlePrompt(id, params ?? {});
      return;

    case 'session/cancel': {
      // Cancellation is a notification. The fake stops the turn by answering an
      // in-flight prompt with `cancelled`, which is what DSH does as well. The
      // in-flight prompt needs to learn *which* id to answer, so the fake keeps
      // the latest prompt id per session.
      const targets = params?.sessionId !== undefined
        ? [params.sessionId]
        : [...sessions.keys()];
      for (const sessionId of targets) {
        const session = sessions.get(sessionId);
        if (!session?.busy) continue;
        session.busy = false;
        for (const [pendingId, resolve] of pendingPermissions) {
          pendingPermissions.delete(pendingId);
          resolve({ outcome: 'cancelled' });
        }
        if (session.promptId !== undefined) {
          ok(session.promptId, { stopReason: 'cancelled' });
          session.promptId = undefined;
        }
      }
      return;
    }

    default:
      if (id !== undefined) return fail(id, -32601, `unknown method: ${method}`);
      return;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunkData => {
  buffer += chunkData;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    log({ event: 'recv', method: message.method ?? 'response', id: message.id ?? null });
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));

// Keep the process alive even when the parent closes stdin abruptly.
process.on('SIGTERM', () => process.exit(0));
