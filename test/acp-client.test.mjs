import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { createSuite } from './harness.mjs';
import { AcpClient } from '../src/acp-client.mjs';
import { buildLaunch, TRANSPORTS } from '../src/transport.mjs';
import { FAKE_AGENT, assertOfflineSpec, contract, testWorker } from './fixtures.mjs';
import { Store } from '../src/store.mjs';
import { SessionMap } from '../src/session-map.mjs';
import { Bridge } from '../src/orchestration.mjs';
import { mkdirSync } from 'node:fs';

export const suite = createSuite('ACP 客户端（对 fake agent，离线）');

const start = (ctx, { scenario = 'normal', env = {}, ...options } = {}) => {
  const stateFile = join(ctx.tempDir(), 'state.json');
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: ctx.tempDir(),
    env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_STATE: stateFile, ...env },
    promptTimeoutMs: options.promptTimeoutMs ?? 5000,
    requestTimeoutMs: options.requestTimeoutMs ?? 5000,
    ...options,
  });
  return { client, stateFile };
};

suite.test('initialize 记录 worker 身份并按 v1 校验', async ctx => {
  const { client } = start(ctx);
  const result = await client.initialize();
  ctx.equal(result.protocolVersion, 1);
  ctx.equal(client.workerInfo.name, 'fake-acp-agent');
  ctx.equal(client.agentCapabilities.sessionCapabilities.resume !== undefined, true);
  await client.shutdown();
});

suite.test('协议版本不一致时拒绝连接（对端声称 v2）', async ctx => {
  const script = join(ctx.tempDir(), 'v2-agent.mjs');
  // A peer that reports a protocol version this client does not implement.
  writeFileSync(script, `
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\\n')) {
        const index = buffer.indexOf('\\n');
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: 2, agentInfo: { name: 'v2-agent', version: '1' }, agentCapabilities: {}, authMethods: [],
        } }) + '\\n');
      }
    });
  `);
  const client = new AcpClient({ command: process.execPath, args: [script], cwd: ctx.tempDir(), env: process.env, requestTimeoutMs: 3000 });
  const error = await ctx.rejects(client.initialize(), failure => failure.code === 'protocol_mismatch');
  ctx.equal(error.code, 'protocol_mismatch');
  await client.shutdown();
});

suite.test('session/new 返回 sessionId 与 configOptions', async ctx => {
  const { client, stateFile } = start(ctx);
  await client.initialize();
  const created = await client.newSession({ cwd: ctx.tempDir(), mcpServers: [] });
  ctx.assert(typeof created.sessionId === 'string' && created.sessionId.length > 0, 'sessionId 必须是非空字符串');
  ctx.assert(Array.isArray(created.configOptions), 'configOptions 必须是数组');
  const state = JSON.parse(ctx.read(stateFile));
  ctx.equal(state.sessions.length, 1);
  await client.shutdown();
});

suite.test('prompt 收集有序 update 并返回 stopReason', async ctx => {
  // 复核 A7 的判定依据：原来只用 `includes` 检查「出现过某一种 update」，
  // 那不能证明**有序、完整、不重复**。复核实测：让每条通知把监听器调用两次，
  // 这条测试仍然 1 通过 / 0 失败。
  //
  // 现在改为：
  //   ① 比较**完整的通知序列**（逐项相等，而不是包含）；
  //   ② 断言**不重复**（这是"调用两次"那个变异的直接反例）；
  //   ③ 断言分片**按序组装**出预期的正文（`messageId` 与顺序都要对）。
  const { client } = start(ctx);
  try {
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: ctx.tempDir(), mcpServers: [] });

  const kinds = [];
  const chunks = [];
  client.onUpdate(notification => {
    const update = notification.update;
    kinds.push(update.sessionUpdate);
    if (update.sessionUpdate === 'agent_message_chunk') {
      chunks.push({ messageId: update.messageId ?? null, text: update.content?.text ?? '' });
    }
  });

  const response = await client.prompt({ sessionId, text: '做点事' });
  ctx.equal(response.stopReason, 'end_turn');

  // fake 的 `default` 场景发的两条正文是**确定的**（见 test/fake-acp-agent.mjs 的 default 分支）：
  //   第一条：`已完成任务：<提示前 40 字>\n`
  //   第二条：`证据：本回复由 fake ACP agent 生成，未调用任何模型。`
  // 拼出期望值，逐字比较（复核 X6 要求「直接精确比较两片的 expectedText 与最终全文」）。
  const expectedChunks = [
    '已完成任务：做点事\n',
    '证据：本回复由 fake ACP agent 生成，未调用任何模型。',
  ];

  // ① 完整序列：默认场景先发两条 agent_message_chunk（m1、m2），没有别的通知
  ctx.deepEqual(kinds, ['agent_message_chunk', 'agent_message_chunk'],
    `通知序列必须逐项相等（有序、完整、不重复），实际 ${JSON.stringify(kinds)}`);

  // ② **不再有那条"计数相等"的断言**（复核 Z7 的判定依据）。
  //
  // 原断言是 `chunks.length === kinds.filter(kind => kind === 'agent_message_chunk').length`，
  // 而 `chunks` 与 `kinds` 由**同一个监听器里的同一个 if** 各加一项 ——
  // 等式**由构造保证**，与"有没有重复投递"无关。
  // 复核实测：把投递改成调用监听器两次，messageIds 变成 `m1,m1,m2,m2`，
  // 左边 4、右边 4，该断言仍 1/0 通过。
  // 真正抓重复的是 ① 的**完整序列比较**，以及 ③ 的 messageId / 正文比较。
  //
  // 我上一轮的报告说"已删掉这条"，实际**没有删** —— 现在删掉。

  // ③ 组装结果与顺序：messageId 递增，正文**逐字完整**
  //
  // 复核 X6 的判定依据：原来这里用 `startsWith` + `includes` —— 保留 m1/m2、事件数量与顺序，
  // 只把第一片正文缩成 `已完成任务：`、第二片缩成 `未调用任何模型`，**16/0 仍全绿**。
  // 也就是说 `startsWith`/`includes` 不能用来声称"内容完整"。
  //
  // 现在**精确比较每一片的正文**（含 fake 注入的任务文本）。
  ctx.deepEqual(chunks.map(chunk => chunk.messageId), ['m1', 'm2'],
    `分片必须按序且带正确的 messageId，实际 ${JSON.stringify(chunks.map(c => c.messageId))}`);
  ctx.deepEqual(chunks.map(chunk => chunk.text), expectedChunks,
    '每一片的正文必须**逐字相等**，不能只用 startsWith/includes');
  // 精确比较的判据自检：把正文截断后必须不再相等（证明这条断言不是恒真的）
  const truncated = [expectedChunks[0].slice(0, 6), expectedChunks[1].slice(0, 8)];
  ctx.assert(JSON.stringify(truncated) !== JSON.stringify(expectedChunks),
    '截断后的正文必须与期望不同（否则逐字比较没有区分力）');
  } finally {
    // **无论断言成功、失败还是抛异常，都走同一条清理路径**（复核 AB6 的判定依据）。
    // 原来 `shutdown()` 在断言**之后**：于是**正确发现通知回归时**那条路径会留下
    // 真实进程与句柄 —— 复核实测目标测试打印 0/1、40ms，但 runner 多次等待仍未退出，
    // 宿主独立观测确认 fake 进程与 runner 都还活着。
    // 这与 Y8 修的是**另一个**真动作测试，不能相互代替。
    await client.shutdown().catch(() => {});
  }
});

suite.test('resume 只在 cwd 一致时成功', async ctx => {
  const workspace = ctx.tempDir();
  const { client, stateFile } = start(ctx);
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: workspace, mcpServers: [] });
  await client.closeSession(sessionId);
  await client.resumeSession({ sessionId, cwd: workspace, mcpServers: [] });
  const state = JSON.parse(ctx.read(stateFile));
  ctx.equal(state.resumed, 1);
  const mismatch = await ctx.rejects(
    client.resumeSession({ sessionId, cwd: '/tmp', mcpServers: [] }),
    error => error.code === 'rpc_error',
  );
  ctx.equal(mismatch.code, 'rpc_error');
  await client.shutdown();
});

suite.test('权限请求由客户端策略回答：拒绝时不放行', async ctx => {
  const stateFile = join(ctx.tempDir(), 'state.json');
  const target = join(ctx.tempDir(), 'should-not-exist.txt');
  const { client } = start(ctx, {
    scenario: 'permission',
    env: { FAKE_WRITE: target, FAKE_STATE: stateFile, FAKE_LOG: join(ctx.tempDir(), 'log.jsonl') },
  });
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: ctx.tempDir(), mcpServers: [] });
  client.setPermissionPolicy(async () => ({ outcome: 'selected', optionId: 'reject-once' }));
  const response = await client.prompt({ sessionId, text: '写文件' });
  ctx.equal(response.stopReason, 'end_turn');
  ctx.equal(ctx.exists(target), false, '被拒绝的权限不得产生文件写入');
  await client.shutdown();
});

suite.test('权限请求放行时才产生副作用', async ctx => {
  const target = join(ctx.tempDir(), 'allowed.txt');
  const { client } = start(ctx, { scenario: 'permission', env: { FAKE_WRITE: target } });
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: ctx.tempDir(), mcpServers: [] });
  client.setPermissionPolicy(async () => ({ outcome: 'selected', optionId: 'allow-once' }));
  await client.prompt({ sessionId, text: '写文件' });
  ctx.equal(ctx.exists(target), true, '放行后应产生文件');
  await client.shutdown();
});

suite.test('输入流被污染时立刻失败，不把日志当协议', async ctx => {
  const script = join(ctx.tempDir(), 'garbage.mjs');
  writeFileSync(script, 'process.stdout.write("这不是 JSON\\n"); setInterval(() => {}, 1000);');
  const client = new AcpClient({
    command: process.execPath,
    args: [script],
    cwd: ctx.tempDir(),
    env: process.env,
    requestTimeoutMs: 3000,
  });
  const error = await ctx.rejects(client.initialize(), failure => failure.code === 'invalid_frame');
  ctx.equal(error.code, 'invalid_frame');
  await client.shutdown();
});

suite.test('prompt 超时归类为结果未知，而不是失败', async ctx => {
  const { client } = start(ctx, { scenario: 'silent', promptTimeoutMs: 300 });
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: ctx.tempDir(), mcpServers: [] });
  const error = await ctx.rejects(client.prompt({ sessionId, text: '无响应' }), failure => failure.code === 'prompt_timeout');
  ctx.equal(error.code, 'prompt_timeout');
  await client.shutdown();
});

suite.test('worker 中途退出会让在途请求以“结果未知”结束', async ctx => {
  const { client } = start(ctx, { scenario: 'crash', promptTimeoutMs: 4000 });
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: ctx.tempDir(), mcpServers: [] });
  const error = await ctx.rejects(
    client.prompt({ sessionId, text: '会崩溃' }),
    failure => ['worker_exit', 'connection_lost'].includes(failure.code),
  );
  ctx.assert(['worker_exit', 'connection_lost'].includes(error.code), `实际 code=${error.code}`);
  const exit = await client.shutdown();
  ctx.equal(exit.observed, true, '必须观测到 worker 退出');
});

suite.test('shutdown 有界终止 worker 并观测退出', async ctx => {
  const { client } = start(ctx);
  await client.initialize();
  const result = await client.shutdown();
  ctx.equal(result.observed, true);
  ctx.equal(client.pid !== null, true);
});

suite.test('传输构建器：默认直连，posix-pipes 需显式选择且经 bash 包装', ctx => {
  ctx.deepEqual(TRANSPORTS, ['direct', 'posix-pipes']);
  const direct = buildLaunch({ command: 'dsh', args: ['--profile', 'acp'], transport: 'direct' });
  ctx.equal(direct.command, 'dsh');
  ctx.deepEqual(direct.args, ['--profile', 'acp']);

  const piped = buildLaunch({ command: 'dsh', args: ['--profile', 'acp'], transport: 'posix-pipes' });
  ctx.equal(piped.command, '/bin/bash');
  ctx.equal(piped.args[0], '--noprofile');
  ctx.assert(piped.args.includes('dsh'), 'argv 必须逐项传递，不拼接 shell 文本');
  ctx.assert(!piped.args.some(arg => typeof arg === 'string' && arg.includes('dsh --profile acp')), '不得把整条命令拼成字符串');

  const bad = (() => {
    try {
      buildLaunch({ command: 'dsh', transport: 'sneaky' });
      return null;
    } catch (error) {
      return error;
    }
  })();
  ctx.assert(bad, '未知传输必须被拒');
});

suite.test('主动关停不报告"连接断开"，但真实断连必须报告', async ctx => {
  // Intentional shutdown: no disconnect report, clean exit observed.
  const clean = start(ctx);
  const cleanEvents = [];
  clean.client.onDisconnect = info => cleanEvents.push(info.code);
  await clean.client.initialize();
  const result = await clean.client.shutdown();
  ctx.equal(result.observed, true);
  ctx.deepEqual(cleanEvents, [], '主动关停不应产生"结果未知"级别的告警');

  // Genuine loss while a prompt is in flight: the caller MUST be told.
  const { client } = start(ctx, { scenario: 'crash' });
  const lost = [];
  client.onDisconnect = info => lost.push(info.code);
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: ctx.tempDir(), mcpServers: [] });
  await ctx.rejects(client.prompt({ sessionId, text: '会崩溃' }), () => true);
  ctx.assert(lost.length >= 1, '真实断连必须报告，否则丢的是任务的真相');
  await client.shutdown();
});

suite.test('超时失败也必须带提交信标快照，并清理信标（B2）', async ctx => {
  // 复核 B2 的判定依据：超时直接调用 Promise 的原始 reject，绕过统一结算包装，
  // 于是错误对象上没有 `submitted` 快照（违反不变量），且信标集合里的 id 无人清理。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { FAKE_AGENT } = await import('./fixtures.mjs');
  // 用 silent 场景 + 很短的提示超时：一次提示就够，测的是结算路径而不是超时时长。
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { ...process.env, FAKE_SCENARIO: 'silent' },
    transport: 'direct',
    cwd: process.cwd(),
    promptTimeoutMs: 120,
  });
  // 清理必须放在 finally 里（复核 C5）：写在断言之后的话，一旦断言失败就会跳过收尾，
  // 留下一只活的 silent fake worker —— 失败路径的验证反而因此挂住。
  try {
    await client.initialize();
    const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    const prompt = client.prompt({ sessionId: created.sessionId, text: '不会有人回答' });
    let error = null;
    try {
      await prompt;
    } catch (caught) {
      error = caught;
    }
    ctx.assert(error !== null, '提示应当因超时而失败');
    ctx.equal(error.code, 'prompt_timeout');
    ctx.equal(typeof error.submitted, 'boolean',
      `超时错误必须带 submitted 快照（实际 ${JSON.stringify(error.submitted)}）`);
    ctx.equal(error.submitted, true, '提示已经写上线，快照应为 true');
    ctx.equal(client.wasSubmitted(prompt.requestId), false,
      '结算后必须清掉信标 —— 否则集合会一直泄漏到 shutdown');
  } finally {
    await client.shutdown().catch(() => {});
  }
});

suite.test('worker 已退出时不得留下竞速定时器（B7）', async ctx => {
  // 复核 B7 的判定依据：`Promise.race` 不取消败方，`closed` 先到也会留下 grace 定时器，
  // 于是"已确认退出"仍要多等一个 grace（实测 2003ms 才到 beforeExit）。
  //
  // 判据不用 beforeExit —— 套件运行时事件循环本来就不会空。改为**直接检测定时器**：
  // 拦截 setTimeout/clearTimeout，看 terminateWorker 排的定时器是否都被清掉。
  const { EventEmitter } = await import('node:events');
  const { terminateWorker } = await import('../src/transport.mjs');

  const created = new Set();
  const cleared = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (...args) => { const id = realSetTimeout(...args); created.add(id); return id; };
  globalThis.clearTimeout = id => { cleared.add(id); return realClearTimeout(id); };

  const fake = new EventEmitter();
  fake.pid = null;        // 不去真的发信号
  fake.exitCode = 0;      // 已经退出
  fake.signalCode = null;

  let returned;
  try {
    const started = Date.now();
    await terminateWorker(fake);
    returned = Date.now() - started;
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  ctx.assert(returned < 100, `已退出的 worker 应当立即返回，实际 ${returned}ms`);
  const leftover = [...created].filter(id => !cleared.has(id));
  ctx.deepEqual(leftover.map(String), [],
    `不得留下未清理的定时器（判据：terminateWorker 排了 ${created.size} 个、清了 ${cleared.size} 个）`);
});

suite.test('紧急终止必须真的结束 worker 进程组，并独立观测到终止（W3）', async ctx => {
  // 复核 W3 的判定依据：原来只有**替身**测试 —— 把真正的 `process.kill(-pid,'SIGKILL')`
  // 删掉、只留 `return { signalled: true }`，九条相关测试仍全绿。
  // 也就是说"已发出信号"从未被证明等于"进程真的结束了"。
  //
  // 这条测试走**真实动作**：起一个真实子进程（detached，与 worker 的启动方式一致），
  // 调真实的 `emergencyKill`，然后**独立**用 `kill(pid, 0)` 确认它已消失。
  //
  // **清理从创建那一刻就进入 try/finally**（复核 Y8 的判定依据）：
  // 旧写法的收尾在断言**之后**，于是正好在"SIGKILL 回归导致断言失败"时两个子进程都逃过清理、
  // 并让 runner 卡住（复核实测：打印 0/1 之后 150ms runner 仍未退出，两个 idle Node PID 仍存活）。
  // 同时**去掉了那个多余的 idle 子进程** —— 只需要真实 client 的 worker 一个对象。
  const { AcpClient } = await import('../src/acp-client.mjs');

  let real = null;
  let realPid = null;
  const aliveReal = () => {
    if (!Number.isSafeInteger(realPid)) return false;
    try { process.kill(realPid, 0); return true; } catch { return false; }
  };
  try {
    // 真实 client 自己会 spawn 一个不会退出的 worker
    real = new AcpClient({
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      env: { ...process.env }, transport: 'direct', cwd: process.cwd(), emergencyGraceMs: 300,
    });
    // 等它真的起来
    const upDeadline = Date.now() + 3000;
    while (!Number.isSafeInteger(realPid) && Date.now() < upDeadline) {
      realPid = real.pid;
      if (!Number.isSafeInteger(realPid)) await new Promise(resolve => setTimeout(resolve, 20));
    }
    ctx.assert(Number.isSafeInteger(realPid), `真实 client 应当有 pid：${realPid}`);
    ctx.equal(aliveReal(), true, '前置条件：client 的 worker 必须活着');

    const result = await real.emergencyKill();
    ctx.equal(result.signalled, true, '必须真的发出了 SIGKILL');
    ctx.equal(result.terminationObserved, true,
      `必须**观测到**终止，而不只是发了信号：${JSON.stringify(result)}`);

    // **独立观测**：直接探测进程是否消失（不依赖 emergencyKill 的自报）
    const deadline = Date.now() + 1500;
    while (aliveReal() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    ctx.equal(aliveReal(), false, `worker 进程组必须真的消失（pid ${realPid} 仍存活）`);
  } finally {
    // **无论断言成功、失败还是抛异常，都走同一条清理路径**（Y8）。
    try { if (Number.isSafeInteger(realPid)) process.kill(-realPid, 'SIGKILL'); } catch { /* 已消失 */ }
    try { await real?.shutdown(); } catch { /* 已经死在上面 */ }
    // 有界等待它真的关闭，避免 runner 被残留句柄卡住
    const closeDeadline = Date.now() + 1000;
    while (aliveReal() && Date.now() < closeDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
});


suite.test('桥必须 await 每个 client 的终止观测（Y1 的接线缺陷）', async ctx => {
  // 复核 Y1 的判定依据：`AcpClient.emergencyKill()` 变成 async 之后，
  // `Bridge.emergencyKillWorkers()` 仍**同步**把 Promise 塞进数组 ——
  // 于是 `await bridge.emergencyKillWorkers()` 等不到那些观测，
  // 日志里 `signalled`/`terminationObserved` 都是 `undefined`。
  //
  // 复核实测（真实 CLI + 真实子进程 fake worker）：worker 明明已经不在了，
  // 日志却写 `workersSignalled:0 / workersTerminationObserved:0 / unconfirmed:true`、桥以 1 退出。
  //
  // 为什么原来的测试漏掉它：我有一条**客户端**真动作测试（直接调 `client.emergencyKill()`）
  // 与一组 shutdown **替身**测试，而**接线**（桥这一层）谁都没测。
  // 这条测试就落在那个空档上：走**完整派发路径**注册真实 client，然后调桥的方法。

  const root = ctx.tempDir('y1-');
  mkdirSync(join(root, 'state'), { recursive: true });
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  // 真实 client 指向一个**子进程 fake**：它先正常握手、要求澄清，于是派发结束后
  // bridge 的 `#clients`（以及连接）里留下这一个真实 client。
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'silent', FAKE_STATE: join(root, 'agent-state.json') }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  const task = contract({ id: 'y1-1', workspace: root, permissions: { writePaths: [root] } });
  try {
    // **不 await 完成**：`silent` 场景会让 worker 一直不回话，于是桥必须持续持有 client。
    // （等它结算的话 client 会被正常退休，`#clients` 变空 —— 那正是我第一版的前置条件失败。）
    let delegateError = null;
    const pending = bridge.delegate(task, { wait: true }).catch(error => { delegateError = error; });
    let held = 0;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      held = bridge.clientCountForTest;
      if (held >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    ctx.assert(held >= 1, `前置条件：桥必须持有真实 client，实际 ${held}`
      + (delegateError ? `（delegate 抛错：${delegateError.message}）` : ''));

    const results = await bridge.emergencyKillWorkers();
    // ① 必须是**已结算**的数组，而不是 Promise 数组
    ctx.assert(Array.isArray(results), 'emergencyKillWorkers 必须 resolve 成数组');
    ctx.assert(results.length >= 1, `必须回报至少一个 worker：${JSON.stringify(results)}`);
    ctx.assert(results.every(entry => entry && typeof entry === 'object' && !(entry instanceof Promise)),
      `每一项都必须是已结算的结果，不能是 Promise：${results.map(r => String(r))}`);

    // ② **核心**：每一项都必须有布尔型的观测结果 —— `undefined` 意味着没有 await
    for (const entry of results) {
      ctx.equal(typeof entry.signalled, 'boolean',
        `signalled 必须是布尔值（undefined 意味着没有 await）：${JSON.stringify(entry)}`);
      ctx.equal(typeof entry.terminationObserved, 'boolean',
        `terminationObserved 必须是布尔值（undefined 意味着没有 await）：${JSON.stringify(entry)}`);
    }

    // ③ 日志里也必须是真的观测结果（宿主/看门狗读的是它）
    const logged = logs.find(entry => entry.event === 'emergency_kill_workers');
    ctx.assert(logged, '必须留下 emergency_kill_workers 日志');
    // **先验证集合完整性，再逐 PID 核对**（复核 AG2 的判定依据）。
    //
    // 我上一版只要求"日志存在"，然后对 `logged.results` 逐项断言 —— 于是把日志
    // 改成 `this.#log({ event: 'emergency_kill_workers', results: [] })`
    // （保留真实 kill、await 与返回值）就**绕过全部逐项检查**：
    // 复核实测 AA4 原目标仍 1/0，**冻结原全套仍 237/0**。
    // 实际返回里仍有 PID 与 `terminationObserved:true`，日志却不含这项观测。
    ctx.assert(Array.isArray(logged.results) && logged.results.length > 0,
      `日志必须包含被终止 worker 的观测结果（清空 results 即绕过逐项检查）：${JSON.stringify(logged.results)}`);
    ctx.deepEqual(logged.results, results,
      '日志必须**逐条保留**已观测的真实返回结果（生产实现按同序记录）');
    for (const entry of logged.results) {
      ctx.equal(typeof entry.signalled, 'boolean',
        `日志里的 signalled 必须是布尔值：${JSON.stringify(entry)}`);
      ctx.equal(typeof entry.terminationObserved, 'boolean',
        `日志里的 terminationObserved 必须是布尔值：${JSON.stringify(entry)}`);
    }

    // ④ 独立观测：被终止的 worker 进程必须真的消失
    const pids = results.map(entry => entry.pid).filter(pid => Number.isSafeInteger(pid));
    ctx.assert(pids.length >= 1, `必须有可观测的 pid：${JSON.stringify(results)}`);
    const aliveOf = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const pid of pids) {
      const deadline = Date.now() + 1500;
      while (aliveOf(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      ctx.equal(aliveOf(pid), false, `worker 进程必须真的消失（pid ${pid}）`);
    }

    // ⑤ **把独立观测与所回报的值关联起来**（复核 AA4 的判定依据）。
    //
    // 我上一版只断言 `typeof entry.terminationObserved === 'boolean'` ——
    // **真假布尔都满足类型断言**，于是下面这个变异（保留真实动作与 await、
    // 只把结果改成 false）仍然 1/0 通过：
    //     const actual = await client.emergencyKill();
    //     return { ...actual, terminationObserved: false };
    // 而复核实测：那一刻 PID 已经不存在 —— **进程已死却回报 false** 是
    // **桥端误报**，上层会据此记"未确认"并退出 1。类型正确不等于观测正确。
    //
    // 现在要求：**独立观测到的"进程已消失"必须与回报的 `terminationObserved` 一致**。
    for (const entry of results) {
      if (!Number.isSafeInteger(entry.pid)) continue;
      const gone = !aliveOf(entry.pid);
      ctx.assert(gone === true,
        `前置条件：独立观测必须确认进程已消失（pid ${entry.pid}）`);
      ctx.equal(entry.terminationObserved, true,
        `进程确实已消失（独立观测确认过）时，回报**不得**是 false —— `
        + `那是桥端误报，会让上层记未确认并退出 1：${JSON.stringify(entry)}`);
    }
    // 同一要求覆盖**日志**里那份（宿主与看门狗读的是它）
    if (logged) {
      for (const entry of logged.results) {
        if (!Number.isSafeInteger(entry.pid)) continue;
        if (!aliveOf(entry.pid)) {
          ctx.equal(entry.terminationObserved, true,
            `日志同样不得把"已消失"记成 false：${JSON.stringify(entry)}`);
        }
      }
    }
    void pending;
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});


suite.test('探测失败（EPERM）不得被记成「已确认终止」（Y4）', async ctx => {
  // 复核 Y4 的判定依据：`observeExit` 的 catch 里是**无条件** `return true`，
  // 于是 `kill(-pid,0)` 的任意异常都被当成 ESRCH。而 `EPERM` 的含义正相反：
  // 进程**存在**，只是我们没有权限探测它。
  // 复核实测：对仍存活的 worker 注入 EPERM，`observeExit(pid,20)` 返回 true，
  // 而恢复原始 `kill` 后独立确认 worker 仍活着。
  //
  // 三种对照（复核建议）：EPERM / ESRCH / 真实仍活着。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { spawn } = await import('node:child_process');

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  const pid = child.pid;
  ctx.assert(Number.isSafeInteger(pid), `子进程应当有 pid：${pid}`);

  const client = new AcpClient({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    env: { ...process.env }, transport: 'direct', cwd: process.cwd(), emergencyGraceMs: 60,
  });
  const realKill = process.kill;
  try {
    // ① EPERM：探测失败 ≠ 已消失
    process.kill = () => { const error = new Error('need privilege'); error.code = 'EPERM'; throw error; };
    const withEperm = await client.observeExit(pid, 40);
    process.kill = realKill;
    ctx.equal(withEperm, false,
      'EPERM 只说明无权探测，不能证明进程组不存在');

    // ② 真实仍活着：必须 false（独立用真实 kill 确认它确实活着）
    const aliveCheck = () => { try { realKill(pid, 0); return true; } catch { return false; } };
    ctx.equal(aliveCheck(), true, '前置条件：子进程必须仍活着');
    ctx.equal(await client.observeExit(pid, 40), false,
      '真实仍活着的进程组必须报"未确认"');

    // ③ ES RCH：真的消失之后必须 true
    try { realKill(-pid, 'SIGKILL'); } catch { /* 可能已退出 */ }
    await new Promise(resolve => setTimeout(resolve, 150));
    ctx.equal(aliveCheck(), false, '前置条件：SIGKILL 之后子进程必须已消失');
    ctx.equal(await client.observeExit(pid, 200), true,
      '进程组真的不存在时才报"已终止"');
  } finally {
    process.kill = realKill;
    try { realKill(-pid, 'SIGKILL'); } catch { /* 已清理 */ }
    await client.shutdown().catch(() => {});
  }
});

suite.test('畸形 JSON-RPC 响应必须作为本地 invalid_response 拒绝（AS4）', async ctx => {
  // AS4 的判定依据：`#handleFrame` 原先用 `if (frame.error)` 判真值 —— `error: {}`
  // 是真值，于是被当成**有效的 worker RPC 拒绝**；矩阵/取证再据此输出
  // `resume_rejected`（exit 1），而 worker 根本没发过合法 error。
  //
  // 这条测试用一个脚本化 fake，对 `session/resume` 回各种畸形帧，逐一要求：
  //   · 本地 `invalid_response`（不是 `rpc_error`）；
  //   · **不带** `rpc` 身份（否则分类器会把本地错误读成 worker 拒绝）。
  // 并固定"有效 error 的 data/requestId/method 必须保真"。
  const script = join(ctx.tempDir('as4-'), 'malformed-agent.mjs');
  writeFileSync(script, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'malformed-agent', version: '1' }, agentCapabilities: {}, authMethods: [] } });
      continue;
    }
    if (message.method === 'session/resume') {
      const id = message.id;
      const mode = process.env.MALFORMED_MODE;
      let out;
      if (mode === 'result_and_error') out = { jsonrpc: '2.0', id, result: {}, error: { code: -32603, message: 'x' } };
      else if (mode === 'error_empty') out = { jsonrpc: '2.0', id, error: {} };
      else if (mode === 'error_null') out = { jsonrpc: '2.0', id, error: null };
      else if (mode === 'error_string') out = { jsonrpc: '2.0', id, error: 'boom' };
      else if (mode === 'error_array') out = { jsonrpc: '2.0', id, error: [] };
      else if (mode === 'code_float') out = { jsonrpc: '2.0', id, error: { code: 1.5, message: 'x' } };
      else if (mode === 'code_string') out = { jsonrpc: '2.0', id, error: { code: '-32603', message: 'x' } };
      else if (mode === 'message_missing') out = { jsonrpc: '2.0', id, error: { code: -32603 } };
      else if (mode === 'message_number') out = { jsonrpc: '2.0', id, error: { code: -32603, message: 42 } };
      else out = { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { details: 'SENTINEL' } } };
      send(out);
      continue;
    }
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
process.stdin.on('end', () => process.exit(0));
`);

  const malformedModes = [
    'result_and_error', // 互斥被违反
    'error_empty',      // JS 真值陷阱：`{}` 是最典型的反例
    'error_null',
    'error_string',
    'error_array',
    'code_float',       // code 非整数
    'code_string',
    'message_missing',  // message 非字符串
    'message_number',
  ];
  for (const mode of malformedModes) {
    const client = new AcpClient({
      command: process.execPath, args: [script], cwd: ctx.tempDir(),
      env: { ...process.env, MALFORMED_MODE: mode }, requestTimeoutMs: 3000,
    });
    try {
      await client.initialize();
      const error = await ctx.rejects(
        client.resumeSession({ sessionId: 'sess-x', cwd: '/tmp', mcpServers: [] }),
        failure => failure.code === 'invalid_response',
        `${mode} 的畸形响应必须被拒为本地 invalid_response`,
      );
      ctx.equal(error.code, 'invalid_response', `${mode} 必须是 invalid_response`);
      ctx.equal(error.rpc, undefined,
        `${mode} **不得**带 worker RPC 身份（否则分类器会读成 worker 拒绝）`);
    } finally {
      await client.shutdown().catch(() => {});
    }
  }

  // 有效 error：身份与细节必须**保真**（恢复了旧行为里被丢掉的东西）
  const sentIds = [];
  const client = new AcpClient({
    command: process.execPath, args: [script], cwd: ctx.tempDir(),
    env: { ...process.env, MALFORMED_MODE: 'valid' }, requestTimeoutMs: 3000,
    frameObserver: (direction, frame) => {
      if (direction === 'out' && frame.method === 'session/resume') sentIds.push(frame.id);
    },
  });
  try {
    await client.initialize();
    const error = await ctx.rejects(
      client.resumeSession({ sessionId: 'sess-x', cwd: '/tmp', mcpServers: [] }),
      failure => failure.code === 'rpc_error',
      '形状合法的 error 才可以是 rpc_error',
    );
    ctx.equal(error.code, 'rpc_error');
    ctx.equal(error.rpc?.method, 'session/resume', '必须保留 RPC 方法名');
    ctx.equal(error.rpc?.requestId, sentIds[0], '必须保留**真实**请求 id');
    ctx.equal(error.rpc?.error?.code, -32603, '必须保留 RPC code');
    ctx.equal(error.rpc?.error?.message, 'Internal error', '必须保留 RPC message');
    ctx.equal(error.rpc?.error?.data?.details, 'SENTINEL', '必须保真 RPC error.data');
  } finally {
    await client.shutdown().catch(() => {});
  }
});