import { capabilityFingerprint, sessionKeyOf } from '../src/contract.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createSuite } from './harness.mjs';
import * as acpClientModule from '../src/acp-client.mjs';
import { Store } from '../src/store.mjs';
import { verifyFingerprint } from '../src/fingerprint.mjs';
import { createRecord, transition } from '../src/state.mjs';
import { SessionMap } from '../src/session-map.mjs';
import { Bridge, renderPrompt, extractClarification, createCollector, CLARIFY_MARKER } from '../src/orchestration.mjs';
import { createWorkerSpec, preflightWorker } from '../src/worker.mjs';
import { assertOfflineSpec, contract, testWorker, TEST_PROMPT_TIMEOUT_MS } from './fixtures.mjs';
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_PROVIDER, DEFAULT_MODEL_ID, PROVIDER_DEFAULT_REASONING, encodeModelSelector } from '../src/models.mjs';
import { buildObservation } from '../src/orchestration.mjs';


/**
 * **文件导航**（本文件 66 条、158KB）。
 *
 * ⚠️ 我**没有**把它拆成多个文件：拆 66 条是纯机械改动，而本会话已经因为
 * **漏一个 import** 造成过 `AcpClient is not defined`（且当时入口测试用退出桩、
 * 那段代码从不执行，**没能抓到**）。这个文件的真问题只是**导航性**，
 * 用这份索引解决、风险为零。
 *
 * 分节（**沿用文件里原有的 `// ----` 注释**，不是我另起一套）：
 *   · **L1–398**：会话复用、派发与结算（398 行区间内的用例）
 *   · **L399**：模型选择（该节起 7 条）
 *   · **L550**：完成侧的观测（P2 第二半）（该节起 5 条）
 *   · **L633**：会话键的纳入/排除判据（该节起 4 条）
 *   · **L747**：轮换记账（曾每次记两遍）（该节起 2 条）
 *   · **L816**：F2：提交后的观测错误不得说"没执行过"（该节起 29 条）
 *
 * 全部 66 条的行号（改动会让它漂移，但顺序稳定）：
 *
 *   L50 派发意图先落盘，再启动 worker（顺序不可颠倒） ｜ L61 派发意图先落盘再启动 worker：注入工厂在启动瞬间断言磁盘状态（
 *   L107 正常完成：状态 completed，结果含 worker 正文与停止 ｜ L118 同阶段同工作区复用会话：第二次直接沿用活跃会话，不再 resume
 *   L147 阶段变化不复用会话，且映射里留下轮换记录 ｜ L166 worker 提问时任务进入 needs_clarification
 *   L199 取消：静默任务被取消后结算为 cancelled ｜ L218 worker 无响应时任务标记 unknown，绝不假装失败或成功
 *   L230 worker 以 refusal 结束时任务 failed，而不是  ｜ L239 契约不合法时拒绝派发，且不产生任何记录
 *   L249 同一 id 重复提交：内容相同则幂等，内容不同则报冲突 ｜ L264 权限：工具未列入白名单时一律拒绝，未产生副作用
 *   L304 渲染的提示词包含目标、验收、权限与咨询标记 ｜ L311 澄清标记解析是显式的，不靠猜语气
 *   L318 更新收集器只把已提交正文算作交付物 ｜ L330 worker 规格：DSH_HOME 被显式注入，命令不经过 she
 *   L353 preflight 只读且诚实报缺：缺少 DSH profile 时 ｜ L363 崩溃恢复：启动时报告未结算任务，且不自动重放
 *   L387 保留 id 前缀 dsh- 被拒：防止反向委派成环 ｜ L423 模型选择默认关闭：契约里带 model 直接被拒签
 *   L437 开启后：默认路由被显式设置，且目录被缓存 ｜ L464 开启后：显式请求不在目录里 -> 任务 failed（而非 unkn
 *   L480 开启后：显式请求目录里的模型会被真正设置 ｜ L502 模型进会话键：换模型不复用会话
 *   L518 worker 不公布目录时：默认值仍被尝试，失败也说得清 ｜ L532 discoverModels 建会话读目录，不发送提示
 *   L554 正常完成：record 里带着可以核对的观测 ｜ L570 worker 报 end_turn 却没有任何产出 -> compl
 *   L586 未观测到结果时：观测记 unobserved，且不谎报完成 ｜ L599 派发在提交提示之前失败：receipt=no_prompt，不当作未
 *   L613 观测构造是纯函数：各类情形给出明确结论 ｜ L639 仅权限白名单不同时：仍然复用同一个会话（曾被真实运行证伪）
 *   L667 而换模型仍然必须换会话（判据的另一半） ｜ L691 导出的 sessionKeyOf 与实际使用的键是同一把
 *   L705 导出的 sessionKeyOf 与实际落盘的键逐字段相同（A8：原 ｜ L752 一次轮换只记一条：rotate + put 不得重复记账
 *   L787 轮换记录带上原始失败原因（否则无法诊断） ｜ L821 提示提交后的观测失败一律记为结果未知（F2）
 *   L850 观测层失败码必须都在"结果未知"集合里（F2 的第二半） ｜ L862 dsh_result 必须能识别无产出的 completed（F14
 *   L904 审批报文只有 toolCallId 时，白名单仍能命中（F11） ｜ L946 提交后的三种帧失真都记为未知，不得说"没执行过"（R1）
 *   L982 确证没写上线时，仍然可以说"本次没有执行过"（R1 的反面） ｜ L1009 丢弃失败连接时必须终止它的 worker，且 shutdown 要能
 *   L1079 shutdown 的返回值不得谎报：未确认退出时 observed  ｜ L1113 部署默认推理档位变化必须换会话，且报告不得谎报已应用（F5）
 *   L1191 报告必须给出会话实际生效的档位，而不是请求值（F5 的另一面） ｜ L1274 重启后的澄清回复必须先尝试恢复会话（F7）
 *   L1374 回复未能提交时会话无法确保时，记明确失败而不是未知（F7 的另一面） ｜ L1465 裁定为 retry 之后必须有显式重放入口，且只能重放一次（F10）
 *   L1538 重放不得对未裁定的任务生效（F10 的边界） ｜ L1566 历史任务的档位报告不得随当前映射漂移（T3）
 *   L1621 旧记录（无任务级快照）在映射不可信时不得引用今天的会话（T3） ｜ L1685 回复发生会话轮换时，必须把新会话登记回任务（V2）
 *   L1778 “每条记录只能重放一次”必须经得起反复裁定（V3） ｜ L1839 连续两次澄清：续跑必须真的追加，不得丢掉先前答复（F8）
 *   L1944 未提交的答案不得进入「此前的澄清」历史（X4） ｜ L2039 发送文本落盘失败后，不得再宣称前缀稳定（X3）
 *   L2169 轮换后的路由快照必须是**新会话的值**，不得沿用旧档位（Y7） ｜ L2313 保存失败后：内存台账必须保住下一轮的 base，且同一轮不得有互斥结
 *   L2432 真正确认提交之前，答案不得被记成 submitted（Z2） ｜ L2522 同会话键的另一个任务不得借用前一个任务的台账（AB2）
 *   L2629 重建 Bridge 后，不完整标记必须先于旧 persisted 文 ｜ L2771 准备阶段不得落盘「拟发送文本」，未确认提交不得标 submitted
 *   L2834 确证请求没写上线时，必须撤回本轮答案并回到等待澄清（AB3 的另一半 ｜ L2899 部署配置的 null 与 undefined 必须区分：null 表
 */

export const suite = createSuite('编排：派发、复用、澄清、取消、未知');

/** Build a bridge whose worker is the fake ACP agent. */
function makeBridge(ctx, { scenario = 'normal', env = {}, workspace, dshHome } = {}) {
  const root = ctx.tempDir('bridge-orchestration-');
  const store = new Store(root).init().lock();
  const sessions = SessionMap.fromStore(store.readSessions());
  // A state file lets the fake agent keep per-session memory across process
  // restarts, which is what makes "clarify once, then continue" observable.
  const agentState = join(root, 'agent-state.json');
  return {
    store,
    sessions,
    agentState,
    workspace: workspace ?? root,
    bridge: new Bridge({
      store,
      sessions,
      worker: {
        ...testWorker(
          { FAKE_SCENARIO: scenario, FAKE_STATE: agentState, ...env },
          // The silent scenario never answers, so it must not inherit the generic
          // test budget: the point of those tests is that the bridge gives up.
          { promptTimeoutMs: scenario === 'silent' ? 300 : TEST_PROMPT_TIMEOUT_MS },
        ),
        dshHome: dshHome ?? join(root, 'dsh-home'),
      },
      log: () => {},
    }),
  };
}

suite.test('派发意图先落盘，再启动 worker（顺序不可颠倒）', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx, { workspace: undefined });
  const task = contract({ id: 'a1', workspace, permissions: { writePaths: [workspace] } });
  const view = await bridge.delegate(task, { wait: false });
  ctx.equal(view.status, 'dispatching', '返回前必须已持久化为 dispatching');
  ctx.assert(store.read('a1') !== null, '磁盘上必须有记录');
  await bridge.delegate(task, { wait: true }); // let the fake finish so shutdown is clean
  await bridge.shutdown();
  store.unlock();
});

suite.test(
  '派发意图先落盘再启动 worker：注入工厂在启动瞬间断言磁盘状态（A2）',
  async ctx => {
    // 原测试只在 delegate 返回**之后**看记录，所以把顺序颠倒（先起 worker 再落盘）照样通过。
    // 这里改成在**启动 worker 的那一刻**检查磁盘 —— 顺序一旦颠倒，这条立刻失败。
    const root = ctx.tempDir("bridge-a2-");
    const store = new Store(join(root, "state")).init().lock();
    const snapshots = [];
    let delegateWasCalling = false;

    const bridge = new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      worker: { ...testWorker(), dshHome: join(root, "dsh-home") },
      log: () => {},
      // 工厂被调用的那一刻 = worker 即将启动的那一刻
      createClient: (spec, hooks) => {
        const record = store.read("a2-probe");
        snapshots.push({
          status: record?.status ?? null,
          onDisk: record !== null,
          historyEvents: (record?.history ?? []).map(h => h.event),
        });
        const { AcpClient } = acpClientModule;
        return new AcpClient(spec, hooks);
      },
    });

    const view = await bridge.delegate(
      contract({ id: "a2-probe", workspace: root, permissions: { writePaths: [root] } }),
      { wait: true },
    );
    ctx.equal(view.status, "completed");
    ctx.assert(snapshots.length > 0, "注入的工厂必须真的被调用过，否则这条测试什么都没验证");
    const atStartup = snapshots[0];
    ctx.equal(atStartup.onDisk, true,
      "启动 worker 的那一刻，任务记录必须已经在磁盘上 —— 否则崩溃时无从知道发生过什么");
    ctx.equal(atStartup.status, "dispatching",
      `启动时记录应处于 dispatching，实际 ${atStartup.status}`);
    ctx.assert(atStartup.historyEvents.includes("dispatch_scheduled"),
      `落盘必须发生在启动之前：${JSON.stringify(atStartup.historyEvents)}`);
    await bridge.shutdown();
    store.unlock();
  },
);

suite.test('正常完成：状态 completed，结果含 worker 正文与停止原因', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx);
  const view = await bridge.delegate(contract({ id: 'a2', workspace, permissions: { writePaths: [workspace] } }), { wait: true });
  ctx.equal(view.status, 'completed');
  const result = bridge.result('a2');
  ctx.equal(result.stopReason, 'end_turn');
  ctx.assert(result.text.includes('已完成任务'), `结果正文应含 worker 输出：${result.text.slice(0, 80)}`);
  await bridge.shutdown();
  store.unlock();
});

suite.test('同阶段同工作区复用会话：第二次直接沿用活跃会话，不再 resume', async ctx => {
  const root = ctx.tempDir('bridge-session-');
  const stateFile = join(root, 'agent-state.json');
  const env = { FAKE_STATE: stateFile };
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker(env), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  const task = id => contract({ id, workspace: root, permissions: { writePaths: [root] } });

  const first = await bridge.delegate(task('b1'), { wait: true });
  const second = await bridge.delegate(task('b2'), { wait: true });
  ctx.equal(first.status, 'completed');
  ctx.equal(second.status, 'completed');
  ctx.equal(first.sessionId, second.sessionId, '同一阶段应复用同一个 ACP 会话');

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  // 这条断言曾经是 `resumed === 1`，而它**把缺陷写成了预期行为**：
  // 真实 DSH 的 resumeSession 第一句就拒绝已激活的会话（`session is already active`），
  // 所以"第二次必须走 resume"等于要求桥每轮轮换成新会话、丢掉全部上下文。
  // 正确行为是：同键且连接仍持有该会话时直接继续，resume 只在跨进程/连接已丢时才需要。
  ctx.equal(state.resumed, 0, '同一连接内应直接沿用已激活的会话，不应调用 resume');
  await bridge.shutdown();
  store.unlock();
});

suite.test('阶段变化不复用会话，且映射里留下轮换记录', async ctx => {
  const root = ctx.tempDir('bridge-rotate-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker(), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  const base = { workspace: root, permissions: { writePaths: [root] } };
  const explode = await bridge.delegate(contract({ id: 'c1', ...base, phase: 'numerics' }), { wait: true });
  const write = await bridge.delegate(contract({ id: 'c2', ...base, phase: 'writing' }), { wait: true });
  ctx.assert(explode.sessionId !== write.sessionId, '不同阶段必须使用不同的 worker 会话');
  const entries = bridge.sessions.toJSON();
  ctx.equal(entries.length, 2, '两个阶段各有一条会话映射');
  await bridge.shutdown();
  store.unlock();
});

suite.test('worker 提问时任务进入 needs_clarification，回复后继续到完成', async ctx => {
  const { store, bridge, workspace, agentState } = makeBridge(ctx, { scenario: 'clarify_once' });
  const task = contract({ id: 'd1', workspace, permissions: { writePaths: [workspace] } });
  const first = await bridge.delegate(task, { wait: true });
  ctx.equal(first.status, 'needs_clarification');
  ctx.assert(first.clarification.question.includes('噪声约定'), `问题应被解析出来：${JSON.stringify(first.clarification)}`);

  const resumed = await bridge.reply('d1', '标准差取 1e-3');
  ctx.equal(resumed.status, 'running', '回复后任务重新进入运行');

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const view = bridge.status('d1');
    if (['completed', 'failed', 'unknown'].includes(view.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const final = bridge.status('d1');
  ctx.equal(final.status, 'completed', `回复后应完成，实际 ${final.status}`);
  ctx.equal(final.sessionId, first.sessionId, '回复必须复用同一个 ACP 会话，而不是另开一个');
  ctx.assert(bridge.result('d1').text.includes('完成计算'), '继续后的结果应当是第二次回答的正文');

  const agentSnapshot = JSON.parse(ctx.read(agentState));
  ctx.equal(agentSnapshot.prompts, 2, 'worker 应收到两次提示：提问与回答');
  ctx.equal(agentSnapshot.resumed, 0, '同一连接内应直接复用会话，无需 resume');

  // Only a task waiting for clarification may be replied to.
  const error = await ctx.rejects(bridge.reply('d1', '再说一句'), caught => caught.code === 'not_waiting');
  ctx.equal(error.code, 'not_waiting');

  await bridge.shutdown();
  store.unlock();
});

suite.test('取消：静默任务被取消后结算为 cancelled', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx, { scenario: 'silent' });
  const task = contract({ id: 'e1', workspace, permissions: { writePaths: [workspace] } });
  await bridge.delegate(task, { wait: false });
  // Wait until the prompt is actually in flight.
  const deadline = Date.now() + 5000;
  while (bridge.status('e1').status !== 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  ctx.equal(bridge.status('e1').status, 'running');
  await bridge.cancel('e1', { reason: '测试取消' });
  while (!['cancelled', 'unknown'].includes(bridge.status('e1').status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  ctx.equal(bridge.status('e1').status, 'cancelled');
  await bridge.shutdown();
  store.unlock();
});

suite.test('worker 无响应时任务标记 unknown，绝不假装失败或成功', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx, { scenario: 'silent' });
  const task = contract({ id: 'f1', workspace, permissions: { writePaths: [workspace] } });
  const view = await bridge.delegate(task, { wait: true });
  ctx.equal(view.status, 'unknown');
  ctx.equal(bridge.result('f1').error.code, 'prompt_timeout');
  const report = bridge.reconcile();
  ctx.assert(report.stranded.some(item => item.id === 'f1'), 'unknown 任务必须出现在待核对清单里');
  await bridge.shutdown();
  store.unlock();
});

suite.test('worker 以 refusal 结束时任务 failed，而不是 completed', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx, { scenario: 'stop_refusal' });
  const view = await bridge.delegate(contract({ id: 'g1', workspace, permissions: { writePaths: [workspace] } }), { wait: true });
  ctx.equal(view.status, 'failed');
  ctx.equal(view.stopReason, 'refusal');
  await bridge.shutdown();
  store.unlock();
});

suite.test('契约不合法时拒绝派发，且不产生任何记录', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx);
  const bad = contract({ id: 'h1', workspace, permissions: { writePaths: [workspace], network: 'yes' } });
  const error = await ctx.rejects(bridge.delegate(bad, { wait: true }), caught => caught.code === 'invalid_contract');
  ctx.equal(error.code, 'invalid_contract');
  ctx.equal(store.read('h1'), null, '被拒的任务不得留下半截记录');
  await bridge.shutdown();
  store.unlock();
});

suite.test('同一 id 重复提交：内容相同则幂等，内容不同则报冲突', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx);
  const task = contract({ id: 'i1', workspace, permissions: { writePaths: [workspace] } });
  await bridge.delegate(task, { wait: true });
  const again = await bridge.delegate(task, { wait: true });
  ctx.equal(again.idempotent, true);
  ctx.equal(again.status, 'completed');

  const conflicting = contract({ id: 'i1', workspace, objective: '完全不同的目标', permissions: { writePaths: [workspace] } });
  const error = await ctx.rejects(bridge.delegate(conflicting, { wait: true }), caught => caught.code === 'id_conflict');
  ctx.equal(error.code, 'id_conflict');
  await bridge.shutdown();
  store.unlock();
});

suite.test('权限：工具未列入白名单时一律拒绝，未产生副作用', async ctx => {
  const root = ctx.tempDir('bridge-perm-');
  const target = join(root, 'should-not-exist.txt');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'permission', FAKE_WRITE: target }),
      dshHome: join(root, 'dsh-home'),
    },
    log: () => {},
  });
  const view = await bridge.delegate(contract({ id: 'j1', workspace: root, permissions: { writePaths: [root], tools: [] } }), { wait: true });
  ctx.equal(view.status, 'completed');
  ctx.equal(existsSync(target), false, '未授权工具不得产生文件');

  // Now declare the tool, and the same scenario is allowed.
  const target2 = join(root, 'allowed.txt');
  const store2 = new Store(join(root, 'state2')).init().lock();
  const bridge2 = new Bridge({
    store: store2,
    sessions: SessionMap.fromStore(store2.readSessions()),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'permission', FAKE_WRITE: target2 }),
      dshHome: join(root, 'dsh-home'),
    },
    log: () => {},
  });
  await bridge2.delegate(contract({
    id: 'j2', workspace: root,
    permissions: { writePaths: [root], tools: ['fs_write'] },
  }), { wait: true });
  ctx.equal(existsSync(target2), true, '列入白名单后应放行');
  await bridge.shutdown();
  await bridge2.shutdown();
  store.unlock();
  store2.unlock();
});

suite.test('渲染的提示词包含目标、验收、权限与咨询标记', ctx => {
  const text = renderPrompt(contract({ id: 'k1' }));
  for (const needle of ['# 委派任务 k1', '## 目标', '## 验收标准', '## 文件与运行约定', 'consult_only', CLARIFY_MARKER]) {
    ctx.assert(text.includes(needle), `提示词缺少 ${needle}`);
  }
});

suite.test('澄清标记解析是显式的，不靠猜语气', ctx => {
  ctx.equal(extractClarification('一切正常，继续。'), null);
  ctx.equal(extractClarification('我不确定，可能有问题。'), null, '普通不确定不应触发澄清');
  const parsed = extractClarification(`先说明\n${CLARIFY_MARKER} 边界条件是什么？`);
  ctx.equal(parsed.question, '边界条件是什么？');
});

suite.test('更新收集器只把已提交正文算作交付物', ctx => {
  const collector = createCollector('s1');
  collector.observe({ sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { text: '别人' } } });
  collector.observe({ sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { text: '思考' } } });
  collector.observe({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: '结论' } } });
  collector.observe({ sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'bash' } });
  const snapshot = collector.snapshot();
  ctx.equal(snapshot.text, '结论');
  ctx.equal(snapshot.toolCalls, 1);
  ctx.equal(snapshot.thoughts, 1);
});

suite.test('worker 规格：DSH_HOME 被显式注入，命令不经过 shell', ctx => {
  const spec = createWorkerSpec({ workspace: '/tmp/ws', command: 'dsh', dshHome: '/tmp/dsh-home', transport: 'direct' });
  ctx.equal(spec.command, 'dsh');
  ctx.deepEqual(spec.args, ['--profile', 'acp']);
  ctx.equal(spec.cwd, '/tmp/ws');
  ctx.equal(spec.env.DSH_HOME, '/tmp/dsh-home');
  ctx.equal(spec.env.DSH_TELEMETRY_DISABLED, '1');

  const withRoot = createWorkerSpec({ workspace: '/tmp/ws', installationRoot: '/opt/dsh', nodeBin: '/usr/bin/node', dshHome: '/tmp/h' });
  ctx.equal(withRoot.command, '/usr/bin/node');
  ctx.deepEqual(withRoot.args, ['/opt/dsh/lib/bin.js', '--profile', 'acp']);

  const withExtras = createWorkerSpec({ workspace: '/tmp/ws', command: 'dsh', extraArgs: ['--flag'], dshHome: '/tmp/h' });
  ctx.deepEqual(withExtras.args, ['--profile', 'acp', '--flag']);

  // A caller-supplied command/args pair is the complete argv and must not be
  // rewritten: this is exactly the mistake that made the tests launch the wrong
  // program while looking correct.
  const explicit = createWorkerSpec({ workspace: '/tmp/ws', command: '/usr/bin/node', args: ['/tmp/fake.mjs'], dshHome: '/tmp/h' });
  ctx.equal(explicit.command, '/usr/bin/node');
  ctx.deepEqual(explicit.args, ['/tmp/fake.mjs'], '显式 argv 不得被 `--profile acp` 覆盖');
});

suite.test('preflight 只读且诚实报缺：缺少 DSH profile 时明确给出下一步', ctx => {
  const dshHome = ctx.tempDir('fake-dsh-home-');
  const report = preflightWorker({ dshHome });
  ctx.equal(report.ok, false);
  ctx.equal(report.profilePresent, false);
  ctx.assert(report.problems.some(text => text.includes('profile') && text.includes('package.json')), JSON.stringify(report.problems));
  ctx.equal(report.profile, 'acp', '默认 profile 必须是 acp');
  ctx.assert(report.hints.some(text => text.includes('--profile acp')), '必须给出可执行的下一步');
});

suite.test('崩溃恢复：启动时报告未结算任务，且不自动重放', ctx => {
  const root = ctx.tempDir('bridge-reconcile-');
  const store = new Store(root).init().lock();
  // Simulate a bridge that was killed mid-flight: a record persisted as running.
  const record = createRecord({ id: 'z1', contract: contract({ id: 'z1', workspace: root }), at: '2026-10-01T00:00:00.000Z', policy: {} });
  store.write(record);
  store.write(transition(record, 'dispatching', { at: '2026-10-01T00:00:01.000Z' }), { expectRevision: 1 });
  store.write(
    transition(store.read('z1'), 'running', { at: '2026-10-01T00:00:02.000Z', patch: { sessionId: 'sess-x' } }),
    { expectRevision: 2 },
  );
  store.unlock();

  const reopened = new Store(root).init();
  const bridge = new Bridge({ store: reopened, sessions: SessionMap.fromStore(reopened.readSessions()), worker: {} });
  const report = bridge.reconcile();
  ctx.equal(report.tasks, 1);
  ctx.equal(report.stranded.length, 1);
  ctx.equal(report.stranded[0].id, 'z1');
  ctx.equal(report.stranded[0].status, 'running');
  ctx.assert(report.stranded[0].note.includes('人工核对') || report.stranded[0].note.includes('确认'), '必须提示人工核对');
  ctx.equal(reopened.read('z1').status, 'running', 'reconcile 是只读的，不得偷偷改动状态');
});

suite.test('保留 id 前缀 dsh- 被拒：防止反向委派成环', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx);
  const error = await ctx.rejects(
    bridge.delegate(contract({ id: 'dsh-1', workspace, permissions: { writePaths: [workspace] } }), { wait: true }),
    caught => caught.code === 'reserved_id',
  );
  ctx.equal(error.code, 'reserved_id');
  ctx.equal(store.read('dsh-1'), null, '被拒的任务不得留下记录');
  await bridge.shutdown();
  store.unlock();
});

// ---------------------------------------------------------------- 模型选择
// 默认关闭：契约里出现 model 会被明确拒绝，而不是被静默忽略。开启后：
// 默认路由被显式设置、目录被缓存、显式请求不在目录里时拒签。

function makeModelAwareBridge(ctx, { scenario = 'normal', env = {}, expose = false, defaults = {}, workspace } = {}) {
  const root = ctx.tempDir('bridge-route-');
  const store = new Store(root).init().lock();
  const stateRoot = join(root, 'state');
  return {
    root,
    stateRoot,
    store,
    bridge: new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      worker: { ...testWorker({ FAKE_SCENARIO: scenario, ...env }), dshHome: join(root, 'dsh-home') },
      exposeModelChoice: expose,
      defaults,
      catalogueRoot: stateRoot,
      log: () => {},
    }),
  };
}

suite.test('模型选择默认关闭：契约里带 model 直接被拒签', async ctx => {
  const { store, bridge, root } = makeModelAwareBridge(ctx, {});
  const error = await ctx.rejects(
    bridge.delegate(contract({ id: 'r1', workspace: root, permissions: { writePaths: [root] }, model: 'a/b' }), { wait: true }),
    caught => caught.code === 'invalid_contract',
  );
  ctx.equal(error.code, 'invalid_contract');
  ctx.assert(error.detail.some(item => item.field === 'model'), '必须指出是 model 字段');
  ctx.equal(store.read('r1'), null, '被拒的任务不得留下记录');
  ctx.equal(bridge.modelChoiceEnabled, false);
  await bridge.shutdown();
  store.unlock();
});

suite.test('开启后：默认路由被显式设置，且目录被缓存', async ctx => {
  const root = ctx.tempDir('bridge-route-ws-');
  const stateFile = join(root, 'agent-state.json');
  const { store, stateRoot, bridge } = makeModelAwareBridge(ctx, { env: { FAKE_STATE: stateFile }, expose: true });
  const view = await bridge.delegate(
    contract({ id: 'r2', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  ctx.equal(view.status, 'completed', `实际 ${view.status} / ${JSON.stringify(view.error)}`);
  ctx.equal(view.model, DEFAULT_MODEL_ID, '状态报告的是模型 id，给人看的');
  ctx.equal(view.provider, DEFAULT_PROVIDER);
  ctx.equal(view.modelSelector, DEFAULT_MODEL, '协议层的选择值单独报告');
  ctx.equal(view.reasoningEffort, DEFAULT_REASONING_EFFORT);

  const agentState = JSON.parse(ctx.read(stateFile));
  const setModel = (agentState.configSets ?? []).find(entry => entry.configId === 'model');
  ctx.assert(setModel, `worker 应当收到一次 model 设置：${JSON.stringify(agentState.configSets ?? [])}`);
  ctx.equal(setModel.value, DEFAULT_MODEL, '下发给 worker 的必须是协议要的选择值，而不是可读字符串');

  const cached = bridge.readCatalogue();
  ctx.assert(cached, '会话观察到的目录必须被缓存');
  ctx.assert(cached.summary.model.choices.length >= 2, '缓存里应当有多个候选模型');
  ctx.equal(ctx.exists(join(stateRoot, 'models.json')), true, '缓存必须落盘在 state root 下');
  await bridge.shutdown();
  store.unlock();
});

suite.test('开启后：显式请求不在目录里 -> 任务 failed（而非 unknown）并列出候选', async ctx => {
  const root = ctx.tempDir('bridge-route-bad-');
  const { store, bridge } = makeModelAwareBridge(ctx, { expose: true });
  // 派发在提交提示之前就失败了：没有任何副作用需要核对，因此是 failed 而不是 unknown。
  const view = await bridge.delegate(contract({
    id: 'r3', workspace: root, permissions: { writePaths: [root] }, model: 'nope/none',
  }), { wait: true });
  ctx.equal(view.status, 'failed', `实际 ${view.status}`);
  ctx.equal(view.error.code, 'model_not_available');
  ctx.assert(Array.isArray(view.error.detail?.candidates) && view.error.detail.candidates.length > 0,
    `必须给出候选模型：${JSON.stringify(view.error)}`);
  ctx.deepEqual(bridge.reconcile().stranded, [], '提示未提交的失败不该进人工核对队列');
  await bridge.shutdown();
  store.unlock();
});

suite.test('开启后：显式请求目录里的模型会被真正设置', async ctx => {
  const root = ctx.tempDir('bridge-route-ok-');
  const stateFile = join(root, 'agent-state.json');
  const { store, bridge } = makeModelAwareBridge(ctx, { env: { FAKE_STATE: stateFile }, expose: true });
  const chosen = 'small-model';
  const chosenSelector = encodeModelSelector('other-provider', chosen);
  const view = await bridge.delegate(contract({
    id: 'r4', workspace: root, permissions: { writePaths: [root] },
    provider: 'other-provider', model: chosen, reasoningEffort: null,
  }), { wait: true });
  ctx.equal(view.status, 'completed', `实际 ${view.status} / ${JSON.stringify(view.error)}`);
  ctx.equal(view.model, chosen);
  ctx.equal(view.reasoningEffort, null, 'null 表示沿用 provider 默认');

  const agentState = JSON.parse(ctx.read(stateFile));
  const sets = agentState.configSets ?? [];
  ctx.assert(sets.some(entry => entry.configId === 'model' && entry.value === chosenSelector), `模型必须被设置（期望 ${chosenSelector}，实得 ${JSON.stringify(sets)}）`);
  ctx.assert(!sets.some(entry => entry.configId === 'reasoning_effort'), '该模型未声明推理档位时不得设置它');
  await bridge.shutdown();
  store.unlock();
});

suite.test('模型进会话键：换模型不复用会话', async ctx => {
  const root = ctx.tempDir('bridge-route-key-');
  const { store, bridge } = makeModelAwareBridge(ctx, { expose: true });
  const base = { workspace: root, permissions: { writePaths: [root] } };
  const first = await bridge.delegate(contract({ id: 'r5', ...base }), { wait: true });
  const second = await bridge.delegate(contract({
    id: 'r6', ...base, provider: 'other-provider', model: 'small-model',
  }), { wait: true });
  ctx.equal(first.status, 'completed');
  ctx.equal(second.status, 'completed');
  ctx.assert(first.sessionId !== second.sessionId, '路由变化必须开新会话，不能在同一会话里混用模型');
  ctx.equal(bridge.sessions.toJSON().length, 2, '两条路由各有一条会话映射');
  await bridge.shutdown();
  store.unlock();
});

suite.test('worker 不公布目录时：默认值仍被尝试，失败也说得清', async ctx => {
  const root = ctx.tempDir('bridge-route-nocat-');
  const { store, bridge } = makeModelAwareBridge(ctx, { expose: true, env: { FAKE_NO_CATALOGUE: '1' } });
  const view = await bridge.delegate(
    contract({ id: 'r7', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  // 没有目录时桥不能断言默认值非法，于是交给 worker 裁定；fake 在无目录模式下接受它。
  ctx.equal(view.status, 'completed', `实际 ${view.status} / ${JSON.stringify(view.error)}`);
  ctx.equal(view.model, DEFAULT_MODEL_ID);
  await bridge.shutdown();
  store.unlock();
});

suite.test('discoverModels 建会话读目录，不发送提示', async ctx => {
  const root = ctx.tempDir('bridge-discover-');
  const stateFile = join(root, 'agent-state.json');
  const { store, bridge, stateRoot } = makeModelAwareBridge(ctx, { env: { FAKE_STATE: stateFile }, expose: true });
  const discovered = await bridge.discoverModels({ workspace: root });
  ctx.equal(discovered.cached, false);
  ctx.assert(discovered.summary.model.choices.length >= 3, '必须列出全部候选');
  const agentState = JSON.parse(ctx.read(stateFile));
  ctx.equal(agentState.prompts ?? 0, 0, '发现目录绝不能发送提示（否则就烧额度了）');
  ctx.equal(ctx.exists(join(stateRoot, 'models.json')), true);

  const fromCache = await bridge.discoverModels({ refresh: false });
  ctx.equal(fromCache.cached, true);
  ctx.equal(fromCache.sessionId, null, '命中缓存时不该再起 worker');
  await bridge.shutdown();
  store.unlock();
});

// ------------------------------------------------- 完成侧的观测（P2 第二半）
// 一条记录若只留 stopReason，就无法区分「worker 正常收敛」与「什么都没收到却被当成完成」。
// 下面这组用例把那两类情形钉死。

suite.test('正常完成：record 里带着可以核对的观测', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx);
  const view = await bridge.delegate(contract({ id: 'obs-1', workspace, permissions: { writePaths: [workspace] } }), { wait: true });
  ctx.equal(view.status, 'completed');
  const record = store.read('obs-1');
  ctx.assert(record.contractFingerprint, 'admission 时必须记下契约指纹');
  ctx.deepEqual(verifyFingerprint(record), { ok: true, actual: record.contractFingerprint });
  ctx.equal(record.result.observation.receipt, 'response');
  ctx.equal(record.result.observation.degraded, false, `不该被判为降级：${JSON.stringify(record.result.observation.gaps)}`);
  ctx.assert(record.result.observation.textChars > 0, '应当记下正文长度');
  ctx.assert(record.result.observation.observedAt, '应当记下观测时间');
  ctx.equal(view.degraded, false, 'publicView 也要暴露可核对性');
  await bridge.shutdown();
  store.unlock();
});

suite.test('worker 报 end_turn 却没有任何产出 -> completed 但被标为降级（P2 的判据）', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx, { scenario: 'silent_success' });
  const view = await bridge.delegate(contract({ id: 'obs-2', workspace, permissions: { writePaths: [workspace] } }), { wait: true });
  // 状态仍然是 completed（worker 确实报了正常结束）……
  ctx.equal(view.status, 'completed');
  // …但观测必须说清"没有可核对的产出"，这就是"看起来完成"与"确实完成"的分界。
  ctx.equal(view.degraded, true, '没有正文也没有工具调用时必须降级');
  ctx.assert(view.observationGaps.some(text => text.includes('没有可核对的产出')), JSON.stringify(view.observationGaps));
  const record = store.read('obs-2');
  ctx.equal(record.result.observation.textChars, 0);
  ctx.equal(record.result.observation.toolCalls, 0);
  ctx.equal(record.result.observation.stopReason, 'end_turn');
  await bridge.shutdown();
  store.unlock();
});

suite.test('未观测到结果时：观测记 unobserved，且不谎报完成', async ctx => {
  const { store, bridge, workspace } = makeBridge(ctx, { scenario: 'silent' });
  const view = await bridge.delegate(contract({ id: 'obs-3', workspace, permissions: { writePaths: [workspace] } }), { wait: true });
  ctx.equal(view.status, 'unknown');
  const record = store.read('obs-3');
  ctx.equal(record.error.observation.receipt, 'unobserved');
  ctx.equal(record.error.observation.degraded, true);
  ctx.equal(record.error.observation.clientFailure, 'prompt_timeout');
  ctx.assert(record.error.observation.gaps.some(text => text.includes('可能已产生副作用')), JSON.stringify(record.error.observation.gaps));
  await bridge.shutdown();
  store.unlock();
});

suite.test('派发在提交提示之前失败：receipt=no_prompt，不当作未观测执行', async ctx => {
  const root = ctx.tempDir('bridge-obs-');
  const { store, bridge } = makeModelAwareBridge(ctx, { expose: true });
  const view = await bridge.delegate(contract({
    id: 'obs-4', workspace: root, permissions: { writePaths: [root] }, model: 'nope/none',
  }), { wait: true });
  ctx.equal(view.status, 'failed');
  const record = store.read('obs-4');
  ctx.equal(record.error.observation.receipt, 'no_prompt');
  ctx.assert(record.error.observation.gaps.some(text => text.includes('没有执行过')), JSON.stringify(record.error.observation.gaps));
  await bridge.shutdown();
  store.unlock();
});

suite.test('观测构造是纯函数：各类情形给出明确结论', ctx => {
  const none = buildObservation({ receipt: 'unobserved' });
  ctx.equal(none.degraded, true);
  ctx.assert(none.gaps.length > 0);

  const empty = buildObservation({ receipt: 'response', result: { text: '', toolCalls: 0, thoughts: 0, stopReason: 'end_turn' } });
  ctx.equal(empty.degraded, true, 'end_turn 且无产出必须降级');

  const real = buildObservation({ receipt: 'response', result: { text: '结论', toolCalls: 2, thoughts: 1, stopReason: 'end_turn' } });
  ctx.equal(real.degraded, false);
  ctx.equal(real.textChars, 2);
  ctx.equal(real.toolCalls, 2);

  const noStop = buildObservation({ receipt: 'response', result: { text: 'x', toolCalls: 1, stopReason: null } });
  ctx.assert(noStop.gaps.some(text => text.includes('stopReason')), JSON.stringify(noStop.gaps));

  const cancel = buildObservation({ receipt: 'unconfirmed_cancel' });
  ctx.assert(cancel.gaps.some(text => text.includes('取消未确认')), JSON.stringify(cancel.gaps));
});

// ------------------------------------------------ 会话键的纳入/排除判据
// 这组用例来自一次真实运行的观测：两轮 phase 与 workspace 完全相同的任务，
// 仅仅因为允许的工具名不同，就被分到了两个不同的 worker 会话。
// 原测试只断言了「阶段/工作区/上下文版本变化要换会话」，**从没断言工具白名单不该换**，
// 所以它一直通过。这正是交接文档 F-3 指出的那类"断言强度不够"。

suite.test('仅权限白名单不同时：仍然复用同一个会话（曾被真实运行证伪）', async ctx => {
  const root = ctx.tempDir('bridge-key-');
  const store = new Store(join(root, 'state')).init().lock();
  // FAKE_STATE 是必须的：真实 worker 的会话在持久存储里，两轮委派之间要能 resume。
  // 少了它，fake 无从持久化，resume 必然失败、桥只能轮换 —— 测出来的会是假现象。
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_STATE: join(root, 'agent-state.json') }), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  const base = { workspace: root };
  const first = await bridge.delegate(contract({
    id: 'k1', ...base, permissions: { writePaths: [root], tools: ['cat', 'jq'] },
  }), { wait: true });
  const second = await bridge.delegate(contract({
    id: 'k2', ...base, permissions: { writePaths: [root], tools: ['cat', 'ls', 'find'] },
  }), { wait: true });

  ctx.equal(first.status, 'completed');
  ctx.equal(second.status, 'completed');
  ctx.equal(first.sessionId, second.sessionId,
    '工具白名单是每任务的权限约束，不该改变会话身份；换了就会打断上下文连续性');
  ctx.equal(bridge.sessions.toJSON().length, 1, '只应存在一条会话映射');
  await bridge.shutdown();
  store.unlock();
});

suite.test('而换模型仍然必须换会话（判据的另一半）', async ctx => {
  const root = ctx.tempDir('bridge-key2-');
  const stateFile = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_STATE: stateFile }), dshHome: join(root, 'dsh-home') },
    exposeModelChoice: true,
    log: () => {},
  });
  const base = { workspace: root, permissions: { writePaths: [root] } };
  const first = await bridge.delegate(contract({ id: 'k3', ...base }), { wait: true });
  const second = await bridge.delegate(contract({
    id: 'k4', ...base, provider: 'other-provider', model: 'small-model',
  }), { wait: true });
  ctx.equal(first.status, 'completed');
  ctx.equal(second.status, 'completed');
  ctx.assert(first.sessionId !== second.sessionId, '路由变化必须开新会话');
  ctx.equal(bridge.sessions.toJSON().length, 2);
  await bridge.shutdown();
  store.unlock();
});

suite.test('导出的 sessionKeyOf 与实际使用的键是同一把', ctx => {
  const base = contract({ id: 'k5', workspace: '/tmp/ws', permissions: { writePaths: ['/tmp/ws'] } });
  // 两个入口都必须用同一个 capabilityFingerprint，否则"导出的键"会与"实际用的键"对不上
  const policy = { model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'high' };
  const keyed = sessionKeyOf(base, 0, policy, { provider: 'deepseek-official', modelId: 'deepseek-flash' });
  ctx.equal(keyed.capabilities, capabilityFingerprint(policy, { provider: 'deepseek-official', modelId: 'deepseek-flash' }));
  ctx.assert(!keyed.capabilities.includes('tools='), `键里不该出现 tools：${keyed.capabilities}`);
  ctx.assert(!keyed.capabilities.includes('net='), `键里不该出现 net：${keyed.capabilities}`);
  // 用了默认模型与显式写了同一个模型，必须算出同一把键
  const implicit = capabilityFingerprint({}, { provider: 'deepseek-official', modelId: 'deepseek-flash' });
  const explicit = capabilityFingerprint({ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'deepseek-official', modelId: 'deepseek-flash' });
  ctx.equal(implicit, explicit, '默认路由与显式写同一个模型必须等价');
});

suite.test(
  '导出的 sessionKeyOf 与实际落盘的键逐字段相同（A8：原测试没碰真正的 Bridge）',
  async ctx => {
    // 原测试只比较两个导出函数彼此的输出，等于只验证了"同一函数等于自己"：
    // 把 Bridge 内部算键的地方改坏，它照样通过。这里改为与**实际落盘的记录**比对。
    const root = ctx.tempDir("bridge-a8-");
    const store = new Store(join(root, "state")).init().lock();
    const bridge = new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      worker: { ...testWorker(), dshHome: join(root, "dsh-home") },
      defaults: { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID, selector: DEFAULT_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT },
      log: () => {},
    });
    const submitted = contract({ id: "k-a8", workspace: root, permissions: { writePaths: [root] } });
    await bridge.delegate(submitted, { wait: true });

    const record = store.read("k-a8");
    const actual = record.sessionKey;
    ctx.assert(typeof actual === "string" && actual.length > 0, "记录里必须落盘实际使用的会话键");

    // 用同一份契约与同一套默认值重新算一遍"应当"的键
    // 默认值必须**完整**传给导出函数：漏掉 reasoningEffort 会算出 `(unset)`，
    // 而实际键里是解析后的档位 —— 那会让这条测试假失败（我改 F5 时就踩到了）。
    const expected = sessionKeyOf(submitted, record.policy?.contextRevision ?? 0, record.policy, {
      provider: DEFAULT_PROVIDER,
      modelId: DEFAULT_MODEL_ID,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    });
    const expectedFlat = [expected.project, expected.phase, resolve(expected.workspace), `r${expected.contextRevision}`, expected.capabilities].join("\u0000");
    ctx.equal(actual, expectedFlat,
      "实际落盘的键必须逐字段等于导出函数算出的键；不一致说明两处各算了一次");

    // 并且它必须真的进了会话映射（否则键只是个装饰）
    const mapped = bridge.sessions.get(actual);
    ctx.assert(mapped, `落盘的键必须能在会话映射里查到：${JSON.stringify(bridge.sessions.toJSON().map(e => e.key))}`);
    ctx.equal(mapped.sessionId, record.sessionId, "映射里的会话必须就是该任务用的会话");
    await bridge.shutdown();
    store.unlock();
  },
);

// ------------------------------------------------ 轮换记账（曾每次记两遍）
// 来自真实运行的观测：映射里同一次轮换留下两条 —— 一条 `resume_failed`、一条 `unspecified`，
// 同一 from、同一毫秒。后果是 generation 与 rotations 的计数虚高一倍，日志无法阅读。
// 根因是 rotate() 与 put() 两处都在追加 rotations 数组。

suite.test('一次轮换只记一条：rotate + put 不得重复记账', async ctx => {
  const root = ctx.tempDir('bridge-rot-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker(), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });

  // 第一次：新会话，不应有轮换
  await bridge.delegate(contract({ id: 'r-1', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
  ctx.equal(bridge.sessions.toJSON()[0].rotations.length, 0, '首次建会话不该产生轮换记录');

  // 第二次：换 phase 会换会话（同一键吗？不同键 → 不产生轮换）。改用换 workspace 来触发同键轮换。
  const other = ctx.tempDir('bridge-rot-2-');
  await bridge.delegate(contract({ id: 'r-2', workspace: other, permissions: { writePaths: [other] } }), { wait: true });

  // 第三次：回到第一个 workspace —— 同一键、workspace 不符 → 触发一次轮换
  await bridge.delegate(contract({ id: 'r-3', workspace: root, permissions: { writePaths: [root] } }), { wait: true });

  const entries = bridge.sessions.toJSON();
  for (const entry of entries) {
    const rotations = entry.rotations ?? [];
    ctx.equal(rotations.length, new Set(rotations.map(r => `${r.from}@${r.at}`)).size,
      `每次轮换只能有一条记录，实际：${JSON.stringify(rotations)}`);
    ctx.assert(!rotations.some(r => r.reason === 'unspecified'),
      `不该出现 unspecified 噪声：${JSON.stringify(rotations)}`);
    ctx.equal(entry.generation, rotations.length,
      `generation 必须等于轮换次数（generation=${entry.generation}, rotations=${rotations.length}）`);
  }
  await bridge.shutdown();
  store.unlock();
});

suite.test('轮换记录带上原始失败原因（否则无法诊断）', async ctx => {
  const root = ctx.tempDir('bridge-rot3-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker(), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  await bridge.delegate(contract({ id: 'r-4', workspace: root, permissions: { writePaths: [root] } }), { wait: true });

  // 直接篡改映射，让下一次复用必然 resume 失败：把 sessionId 换成一个不存在的值。
  const key = bridge.sessions.toJSON()[0].key;
  const entry = bridge.sessions.toJSON()[0];
  bridge.sessions.put(key, { ...entry, sessionId: 'sess-does-not-exist', now: entry.updatedAt, rotationRecorded: true });

  await bridge.delegate(contract({ id: 'r-5', workspace: root, permissions: { writePaths: [root] } }), { wait: true });

  const rotations = bridge.sessions.toJSON().find(e => e.key === key).rotations ?? [];
  const failed = rotations.find(r => r.reason === 'resume_failed');
  ctx.assert(failed, `应当有一条 resume_failed 轮换：${JSON.stringify(rotations)}`);
  ctx.assert(failed.failure, '轮换记录必须带上原始失败原因，否则无法区分 already active 与 cwd 不符');
  ctx.assert(typeof failed.failure.message === 'string' && failed.failure.message.length > 0,
    `failure.message 必须非空：${JSON.stringify(failed.failure)}`);
  ctx.equal(failed.failure.sessionId, 'sess-does-not-exist', '要记下是哪个会话恢复失败');
  await bridge.shutdown();
  store.unlock();
});

// ------------------------------------------------ F2：提交后的观测错误不得说"没执行过"
// 复核实测（2026-10-02）：适配器先真的写文件、发 tool_call，再抛 output_limit，
// 结果被记成 `failed / receipt:no_prompt`，gaps 写着"本次没有执行过"—— 而文件存在。
// 把未观测说成已观测，比说"不知道"更糟。

suite.test('提示提交后的观测失败一律记为结果未知（F2）', async ctx => {
  const root = ctx.tempDir('bridge-f2-');
  const sideEffect = join(root, 'side-effect.txt');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: 'flood_after_tool_call', FAKE_SIDE_EFFECT: sideEffect }), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  const view = await bridge.delegate(contract({
    id: 'f2', workspace: root, permissions: { writePaths: [root], tools: ['fs_write'] },
  }), { wait: true });

  ctx.equal(view.status, 'unknown',
    `提示可能已提交、工具可能已执行，只能记未知；实际 ${view.status}`);
  const record = store.read('f2');
  ctx.equal(record.error.observation.receipt, 'unobserved', '不得记为 no_prompt');
  const gaps = record.error.observation.gaps.join(' ');
  ctx.assert(!gaps.includes('没有执行过'), `不得断言「没有执行过」：${gaps}`);
  ctx.assert(gaps.includes('可能已产生副作用'), `应当明确说可能已产生副作用：${gaps}`);
  // 这条是关键：那次执行**真的发生了**（副作用文件在），所以 unknown 才是诚实的分类。
  // 缺了它，这条测试就只是在校对字符串，而不是在验证"不得把已发生的说成没发生"。
  ctx.assert(existsSync(sideEffect),
    '副作用必须真的落盘，否则测不到"已执行却被记成没执行过"这个错误说法');
  await bridge.shutdown();
  store.unlock();
});

suite.test('观测层失败码必须都在"结果未知"集合里（F2 的第二半）', async ctx => {
  // 这一次实测走到的是 invalid_frame（洪泛内容不是合法 JSON），
  // 所以单独钉住这几个码本身：只要它们不在集合里，"已经产生副作用却被记成没执行过"就会重现。
  const { UNKNOWN_OUTCOME_CODES } = await import('../src/acp-client.mjs');
  for (const code of ['output_limit', 'stderr_limit', 'invalid_frame', 'prompt_timeout', 'connection_lost']) {
    ctx.assert(UNKNOWN_OUTCOME_CODES.includes(code), `${code} 必须按结果未知处理：${[...UNKNOWN_OUTCOME_CODES]}`);
  }
  // 而确实没提交过提示的失败不该混进来 —— 否则"未执行"就再也表达不出来
  ctx.assert(!UNKNOWN_OUTCOME_CODES.includes('spawn_error'),
    'spawn_error 发生在起进程之前，本次确实没有执行过');
});

suite.test('dsh_result 必须能识别无产出的 completed（F14）', async ctx => {
  // 复核实测：README 称 status 与 result 都带 degraded，而 result 实际没有该字段，
  // 于是只读 dsh_result 的调用方无法识别「worker 报了结束却没有可核对的产出」。
  const root = ctx.tempDir('bridge-f14-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: 'silent_success' }), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  await bridge.delegate(contract({
    id: 'f14', workspace: root, permissions: { writePaths: [root] },
  }), { wait: true });

  const view = bridge.result('f14');
  ctx.equal(view.status, 'completed', '前置条件：worker 报了正常结束');
  ctx.equal(view.degraded, true, 'result 必须暴露 degraded —— 否则"无产出的 completed"无法被识别');
  ctx.assert(Array.isArray(view.gaps) && view.gaps.length > 0, `gaps 必须说明降级原因：${JSON.stringify(view.gaps)}`);
  ctx.assert(view.gaps.some(text => text.includes('没有可核对的产出')), JSON.stringify(view.gaps));
  ctx.assert(view.observation, 'result 应当带上完整观测，便于调用方自行判断');
  ctx.equal(view.observation.receipt, 'response');
  ctx.assert('artifacts' in view, '交付物区块也要能读到（可能为 null）');
  ctx.assert('resolution' in view, '裁定也要能读到（可能为 null）');

  // 反例：正常产出时不得误报降级，否则这个字段就没有信息量
  const root2 = ctx.tempDir('bridge-f14b-');
  const store2 = new Store(join(root2, 'state')).init().lock();
  const bridge2 = new Bridge({
    store: store2,
    sessions: SessionMap.fromStore(store2.readSessions()),
    worker: { ...testWorker(), dshHome: join(root2, 'dsh-home') },
    log: () => {},
  });
  await bridge2.delegate(contract({ id: 'f14-ok', workspace: root2, permissions: { writePaths: [root2] } }), { wait: true });
  const ok = bridge2.result('f14-ok');
  ctx.equal(ok.degraded, false, `有正文的正常完成不该降级：${JSON.stringify(ok.gaps)}`);
  ctx.deepEqual(ok.gaps, []);
  await bridge.shutdown(); store.unlock();
  await bridge2.shutdown(); store2.unlock();
});

suite.test('审批报文只有 toolCallId 时，白名单仍能命中（F11）', async ctx => {
  // 复核 F11 判定依据：真实 DSH 的审批请求是 `toolCall: { toolCallId }`，**不带工具名**
  // （`dsh-acp/lib/index.js`）；工具名在稍早的 `tool_call` 通知的 `title` 里。
  // 旧版 fake 把 name 塞进审批报文，把这个缺口遮住了 —— 真实运行里白名单会完全失效。
  // 现在 fake 已改为真实形状，这条测试就是那次失效的回归防线。
  const root = ctx.tempDir('bridge-f11-');
  const target = join(root, 'written.txt');
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: 'permission', FAKE_WRITE: target }), dshHome: join(root, 'dsh-home') },
    log: entry => logs.push(entry),
  });

  // 白名单里只有 fs_write —— 必须命中，否则 fake 不会写文件
  await bridge.delegate(contract({
    id: 'f11', workspace: root, permissions: { writePaths: [root], tools: ['fs_write'] },
  }), { wait: true });
  ctx.equal(existsSync(target), true,
    '白名单里有该工具时必须放行：审批报文不带名字，桥要靠 tool_call 通知关联');
  ctx.assert(!logs.some(e => e.event === 'permission_refused_unnamed'),
    `既然是同一个 toolCallId 关联到的，就不该报"未命名请求"：${JSON.stringify(logs.filter(e => e.event?.startsWith('permission')))}`);

  // 反例：白名单里没有它时必须拒绝，且不得产生副作用
  const target2 = join(root, 'must-not-exist.txt');
  const store2 = new Store(join(root, 'state2')).init().lock();
  const bridge2 = new Bridge({
    store: store2,
    sessions: SessionMap.fromStore(store2.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: 'permission', FAKE_WRITE: target2 }), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  await bridge2.delegate(contract({
    id: 'f11-deny', workspace: root, permissions: { writePaths: [root], tools: ['fs_read'] },
  }), { wait: true });
  ctx.equal(existsSync(target2), false, '不在白名单里的工具必须被拒');
  await bridge.shutdown(); store.unlock();
  await bridge2.shutdown(); store2.unlock();
});

suite.test('提交后的三种帧失真都记为未知，不得说"没执行过"（R1）', async ctx => {
  // 复核 R1 的判定依据：F2 只列了三个错误码，于是 invalid_response /
  // unexpected_response / incomplete_frame 这三条**提交后**的观测失败仍被记成
  // failed/no_prompt（gaps 写着「本次没有执行过」），而副作用文件确实存在。
  // 修法是按**提交信标**分类，而不是继续补错误码名单。
  for (const mode of ['effect_then_invalid_response', 'effect_then_unexpected_response', 'effect_then_incomplete_frame']) {
    const root = ctx.tempDir(`bridge-r1-${mode}-`);
    const sideEffect = join(root, 'side-effect.txt');
    const store = new Store(join(root, 'state')).init().lock();
    const bridge = new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      worker: {
        ...testWorker({ FAKE_SCENARIO: mode, FAKE_SIDE_EFFECT: sideEffect }),
        dshHome: join(root, 'dsh-home'),
        promptTimeoutMs: 4000,
      },
      log: () => {},
    });

    const view = await bridge.delegate(contract({
      id: 'r1', workspace: root, permissions: { writePaths: [root], tools: ['fs_write'] },
    }), { wait: true });

    const record = store.read('r1');
    const gaps = (record.error?.observation?.gaps ?? []).join(' ');
    ctx.equal(view.status, 'unknown',
      `[${mode}] 提示已提交、工具已执行，只能记未知；实际 ${view.status}（${record.error?.code}）`);
    ctx.equal(record.error?.observation?.receipt, 'unobserved', `[${mode}] 不得记为 no_prompt`);
    ctx.assert(!gaps.includes('没有执行过'), `[${mode}] 不得断言"没有执行过"：${gaps}`);
    ctx.assert(existsSync(sideEffect), `[${mode}] 副作用必须真的存在，否则这条测试测不到那个错误说法`);
    await bridge.shutdown();
    store.unlock();
  }
});

suite.test('确证没写上线时，仍然可以说"本次没有执行过"（R1 的反面）', async ctx => {
  // 分类必须双向：如果一律记未知，那"未执行"就再也表达不出来。
  // worker 起不来时请求根本没写上线，此时 no_prompt 是准确的。
  const root = ctx.tempDir('bridge-r1b-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: {
      command: '/nonexistent/definitely-not-a-worker',
      args: [],
      transport: 'direct',
      dshHome: join(root, 'dsh-home'),
      promptTimeoutMs: 3000,
    },
    log: () => {},
  });
  const view = await bridge.delegate(contract({ id: 'r1b', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
  ctx.equal(view.status, 'failed', `worker 起不来的失败应记为 failed；实际 ${view.status}`);
  const record = store.read('r1b');
  ctx.equal(record.error.observation.receipt, 'no_prompt');
  ctx.assert(record.error.observation.gaps.some(g => g.includes('没有执行过')),
    `确证未上线时应当能说"没有执行过"：${JSON.stringify(record.error.observation.gaps)}`);
  await bridge.shutdown();
  store.unlock();
});

suite.test('丢弃失败连接时必须终止它的 worker，且 shutdown 要能回收全部（R2）', async ctx => {
  // 复核 R2 的判定依据：第一条任务的 fake 在写文件后结束 stdout（incomplete_frame），
  // 第二条任务建新客户端并成功。Bridge.shutdown() 之后对**第一个** PID 执行 kill(pid,0)
  // 仍然成功（oldClientAlive=true）—— 旧 worker 失去所有权、无人回收。
  //
  // 这条测试因此断言两件事，缺一不可：
  //   1. 旧 PID 真的死了（不只是"新任务完成了"）；
  //   2. shutdown 的返回值**可判定**，而不是一律宣称成功。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-r2-');
  const store = new Store(join(root, 'state')).init().lock();
  const made = [];
  const logs = [];
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    // 捕获每个真实 client（以便事后查 pid），并在**启动之前**确认规格是离线的。
    // 这道断言是必要的：我曾经在这里把 workerOptions 设成 undefined，
    // 结果这个"离线"测试真的启动了 dsh，而返回值被我丢弃，于是照样全绿。
    createClient: (spec, hooks) => {
      assertOfflineSpec(spec);
      const client = new AcpClient(spec, hooks);
      made.push(client);
      return client;
    },
    worker: { ...testWorker({ FAKE_SCENARIO: 'effect_then_incomplete_frame' }), dshHome: join(root, 'dsh-home'), promptTimeoutMs: 4000 },
  });

  // 第一条：连接会因 incomplete_frame 进入 failure
  await bridge.delegate(contract({ id: 'r2-a', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
  const firstPid = made[0]?.pid ?? null;
  ctx.assert(made.length >= 1, '至少要创建一个 client');
  ctx.assert(typeof firstPid === 'number', `第一个 client 应当有 pid：${firstPid}`);

  // 第二条：换一个能正常完成的场景，触发「丢弃旧连接 → 新建」。
  // 场景切换必须改**环境变量**（fake 每次启动都读它），而不是把 workerOptions 抹掉 ——
  // 抹掉会让规格回退成真实的 `dsh`。
  bridge.workerOptions.env.FAKE_SCENARIO = 'normal';
  const second = await bridge.delegate(
    contract({ id: 'r2-b', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  ctx.equal(second.status, 'completed', `第二条任务必须真正完成，实际 ${second.status}`);
  ctx.assert(made.length >= 2, `第二条任务应当新建 client（实际 ${made.length} 个）`);

  // 旧 client 应当在被丢弃时就被终止；这里给有界终止一点时间
  const deadline = Date.now() + 3000;
  const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (isAlive(firstPid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));

  ctx.equal(isAlive(firstPid), false,
    `被丢弃连接的 worker 必须被终止（pid ${firstPid} 仍存活）—— 这正是 R2 的资源泄漏`);
  ctx.assert(logs.some(e => e.event === 'client_retired' && e.reason === 'connection_discarded'),
    `应当留下退休记录：${JSON.stringify(logs.filter(e => e.event === 'client_retired'))}`);

  // shutdown 必须覆盖**全部**创建过的 client，且结果可判定
  const results = await bridge.shutdown();
  ctx.assert(Array.isArray(results) && results.length >= 2,
    `shutdown 应回收全部 ${made.length} 个 client；实际 ${JSON.stringify(results)}`);
  ctx.assert(results.every(r => typeof r.observed === 'boolean'),
    `每个结果都必须说明是否确认退出：${JSON.stringify(results)}`);
  for (const client of made) {
    if (typeof client.pid === 'number') {
      ctx.equal(isAlive(client.pid), false, `shutdown 之后 pid ${client.pid} 不得存活`);
    }
  }
  store.unlock();
});

suite.test('shutdown 的返回值不得谎报：未确认退出时 observed 为 false（R2 的可判定性）', async ctx => {
  // 资源回收是否成功必须可判定。用一个 shutdown 永远不返回确认的 client 验证：
  // 桥不能因为"我调用了 shutdown"就宣称成功。
  const root = ctx.tempDir('bridge-r2b-');
  const store = new Store(join(root, 'state')).init().lock();
  const fake = {
    failure: null,
    pid: null,
    onUpdate: () => () => {},
    setPermissionPolicy: () => {},
    permissionObserver: () => null,
    initialize: async () => {},
    newSession: async () => ({ sessionId: 'sess-stub', configOptions: [] }),
    resumeSession: async () => ({}),
    prompt: async () => ({ stopReason: 'end_turn' }),
    closeSession: async () => {},
    // 关键：不返回 observed，表示"我没能确认它退出"
    shutdown: async () => ({ observed: false, escalated: true }),
  };
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    createClient: () => fake,
    worker: { ...testWorker(), dshHome: join(root, 'dsh-home') },
  });
  await bridge.delegate(contract({ id: 'r2b', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
  const results = await bridge.shutdown();
  ctx.assert(results.length >= 1, `应当有被回收的 client：${JSON.stringify(results)}`);
  ctx.equal(results[0].observed, false,
    `没能确认退出时必须报 observed:false，不得谎报成功：${JSON.stringify(results)}`);
  store.unlock();
});

suite.test('部署默认推理档位变化必须换会话，且报告不得谎报已应用（F5）', async ctx => {
  // 复核 F5 的判定依据：任务未显式指定档位时，键里只有「default」，
  // 于是部署默认 high → low 之后仍复用**用 high 建立**的会话，而状态报 low。
  // 会话把选择持在 agent 作用域，所以任务实际跑在旧档位上 —— 而报告说它跑在新档位上。
  //
  // 复核 T1 又指出：我原先的「两次部署」各自起了一个**新 worker**，于是旧键的恢复
  // 必然失败（新进程不认识旧会话），`sessionId` 不同既可能来自「档位变了」也可能来自
  // 「恢复根本不可能成功」—— 断言无法归因。
  //
  // 现在改为**同一个 Bridge、同一个 worker 连接**上连续派发，只改默认档位：
  //   ① high→high 必须复用同一会话（对照）；② high→low 必须换会话（被测行为）。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-f5-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();

  // 关键的"可换部署默认值"入口：同一个 Bridge 上重设默认档位，
  // 而不是新建 Bridge/worker —— 这样"复用"才可能发生。
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    defaults: { provider: 'deepseek-official', modelId: 'deepseek-flash', reasoningEffort: 'high' },
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'normal', FAKE_STATE: agentState }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  const send = id => bridge.delegate(
    contract({ id, workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );

  try {
    const first = await send('f5-a');
    ctx.equal(first.status, 'completed');
    const second = await send('f5-b');
    ctx.equal(second.status, 'completed');

    // ① 对照：同一档位必须复用同一会话（否则'换会话'无法归因到档位变化）
    ctx.equal(second.sessionId, first.sessionId,
      '同一档位（high→high）必须复用同一个会话 —— 这是「档位变化导致换会话」的对照');

    // ② 把它改成 low，再派发：必须换会话
    bridge.setSelectionDefaults({ reasoningEffort: 'low' });
    const third = await send('f5-c');
    ctx.equal(third.status, 'completed');
    ctx.assert(third.sessionId !== first.sessionId,
      `默认档位从 high 变成 low 之后必须开新会话；仍然是 ${third.sessionId}`);

    // ③ 会话键里必须是**解析后的档位**，不是占位符
    const key = store.read('f5-c').sessionKey ?? '';
    ctx.assert(key.includes('reasoning=low'), `会话键必须记录 low，实际 ${key}`);
    ctx.assert(!key.includes('(default)') && !key.includes('(unset)'),
      `会话键不得停留在占位符上，实际 ${key}`);

    // ④ **独立核对每一轮的真实档位**（复核 W7 的判定依据）。
    //
    // 原先这条测试的 low 那一轮只验了身份（会话键、sessionId），没有核对 **worker 侧
    // 实际收到的档位** —— 于是"只对 low 跳过设置档位的 RPC、其它保留"这个变异
    // 能穿过全部九条相关测试（复核实测 9/0）。
    //
    // 身份键正确 ≠ 配置实际施加正确：前者是键的事，后者要看 fake 记下的实际值。
    const state = JSON.parse(ctx.read(agentState));
    const efforts = (state.promptEfforts ?? []).map(entry => entry.effort);
    ctx.deepEqual(efforts, ['high', 'high', 'low'],
      `三轮的实际档位必须是 high/high/low（fake 侧独立记录），实际 ${JSON.stringify(efforts)}`);
    // 而且公开报告也要与之一致（不能只对着记忆看）
    ctx.equal(store.read('f5-a').appliedRoute?.reasoningEffort, 'high');
    ctx.equal(store.read('f5-c').appliedRoute?.reasoningEffort, 'low');
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('报告必须给出会话实际生效的档位，而不是请求值（F5 的另一面）', async ctx => {
  // 会话映射里必须存有实际施加的路由。此前 `SessionMap.put()` 没有解构 `route`，
  // 调用方一直传、它一直丢 —— 于是"报告实际档位"根本没有依据。
  const root = ctx.tempDir('bridge-f5r-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    defaults: { provider: 'deepseek-official', modelId: 'deepseek-flash', reasoningEffort: 'high' },
    // 必须给 FAKE_STATE：独立观测（T2）要读 fake 自己记下的实际档位。
    worker: { ...testWorker({ FAKE_SCENARIO: 'normal', FAKE_STATE: agentState }), dshHome: join(root, 'dsh-home') },
  });
  // **第一段的派发与全部断言都必须在 try 之内**（复核 AM1 的判定依据）。
  //
  // 我上一版只写了 `try { await bridge.shutdown(); } finally { store.unlock(); }` ——
  // 那只保护 `shutdown()` **自己**；前面的 `delegate()` 与全部断言仍在 try 外，
  // **断言一失败根本走不到那个 finally**，第一个 worker 留下来、进程挂住。
  //
  // 而且我当时的"修好了"证据是**假的**：`93ms 退出` 是 **runner 末尾的全局清理**
  // 杀掉了这个 worker 造成的 —— 它**遮住了测试自身的缺口**。
  // 复核实测（两个对照都只用副本、都删掉 runner 尾部的全局清理）：
  //   · 当前修法：54ms 打印 0/1，**2 秒仍未退出**，父进程探测到 fake PID 存活；
  //   · 把派发与断言一起包进 finally：同样断言失败，**106ms 自然以 1 结束**，无存活 worker。
  let firstError = null;
  try {
    const view = await bridge.delegate(
      contract({ id: 'f5r', workspace: root, permissions: { writePaths: [root] } }),
      { wait: true },
    );
    ctx.equal(view.status, 'completed');

    // 映射条目必须留下实际路由
    const entry = bridge.sessions.toJSON().find(e => e.sessionId === view.sessionId);
    ctx.assert(entry, '会话映射里应当有该会话');
    ctx.assert(entry.route, `映射条目必须保留实际施加的路由：${JSON.stringify(entry)}`);

    // 报告的档位必须与映射里的实际值一致，而不是"当前默认值"这种说法
    ctx.equal(view.reasoningEffort, entry.route.reasoningEffort,
      `报告(${view.reasoningEffort}) 必须等于会话实际档位(${entry.route.reasoningEffort})`);

    // **独立观测**（复核 T2 的核心）：不看桥说了什么，看 **fake 侧**记下的实际档位。
    // 原先只比桥的自报值，于是把真正设置档位的 RPC 删掉之后测试仍然全绿。
    const agentState2 = JSON.parse(ctx.read(join(root, 'agent-state.json')));
    const observed = (agentState2.promptEfforts ?? []);
    ctx.assert(observed.length >= 1,
      `fake 必须记下提示时的实际档位：${JSON.stringify(agentState2).slice(0, 200)}`);
    ctx.equal(observed[observed.length - 1].effort, view.reasoningEffort,
      `worker 侧实际生效档位(${observed[observed.length - 1].effort}) 必须等于公开报告(${view.reasoningEffort})`);
  } catch (error) {
    firstError = error;
  } finally {
    // **断言失败也穿过这里** —— 这才是 AJ3 真正要的那条清理。
    try {
      await bridge.shutdown();
    } finally {
      store.unlock();
    }
  }
  if (firstError !== null) throw firstError;

  const store2 = new Store(join(root, 'state')).init().lock();
  try {
    const bridge2 = new Bridge({
      store: store2,
      sessions: SessionMap.fromStore(store2.readSessions()),
      log: () => {},
      defaults: { provider: 'deepseek-official', modelId: 'deepseek-flash', reasoningEffort: 'low' },
      worker: { ...testWorker({ FAKE_SCENARIO: 'normal' }), dshHome: join(root, 'dsh-home') },
    });
    try {
      const after = bridge2.status('f5r');
      ctx.equal(after.reasoningEffort, 'high',
        `默认值改成 low 之后，旧任务的报告仍应是它当时实际用的 high，实际 ${after.reasoningEffort}`);
    } finally {
      await bridge2.shutdown().catch(() => {});
    }
  } finally {
    store2.unlock();
  }
});

suite.test('重启后的澄清回复必须先尝试恢复会话（F7）', async ctx => {
  // 复核 F7 的判定依据：离线 Bridge A 得到 needs_clarification 后关闭；
  // 用同一 Store 创建 Bridge B 再 reply —— 实际 unknown、error=no_connection，
  // prompt 总数仍为 1，**resume 从未调用**。代码路径与 CLI 的"每命令新建 Bridge"一致。
  //
  // 这里刻意**不依赖内存会话**（复核提醒不能靠 fake 的内存掩盖）：第二个 Bridge
  // 是全新实例，所有连接都从零开始，所以它只能走"确保会话"这条路。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-f7-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');

  // 收集两个 Bridge 的事件：判定"是否尝试过恢复"需要看 resume_failed。
  const relay = [];
  const makeBridge = () => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: entry => relay.push(entry),
      worker: {
        ...testWorker({ FAKE_SCENARIO: 'clarify_once', FAKE_STATE: agentState }),
        dshHome: join(root, 'dsh-home'),
      },
      createClient: (spec, hooks) => {
        assertOfflineSpec(spec);
        return new AcpClient(spec, hooks);
      },
    });
  };

  // 第一个 Bridge：派发到一个会要求澄清的场景，然后关闭（模拟一次 CLI 调用结束）
  // `clarify_once` 依据状态文件里的 prompts 计数决定"是否再问一次"，
  // 所以每个测试必须用**自己的状态文件**，否则计数会被别的测试推高、第一轮就不再澄清。
  const first = makeBridge();
  let view;
  let firstSessionId = null;
  try {
    view = await first.delegate(
      contract({ id: 'f7-1', workspace: root, permissions: { writePaths: [root] } }),
      { wait: true },
    );
    ctx.equal(view.status, 'needs_clarification', `应当进入澄清等待，实际 ${view.status}`);
    const firstRecord = first.store.read('f7-1');
    ctx.assert(typeof firstRecord.sessionId === 'string', '澄清期间应当已经建立了会话');
    firstSessionId = firstRecord.sessionId;
  } finally {
    // 断言失败也必须收掉 worker，否则会留下游离进程（复核建议的 C5 推广）。
    await first.shutdown().catch(() => {});
    first.store.unlock();
  }
  const promptsBefore = JSON.parse(ctx.read(agentState)).prompts;

  // 第二个 Bridge：全新实例，内存里没有任何连接
  const second = makeBridge();
  try {
    const after = await second.reply('f7-1', '这是我的回答');
    // 关键断言：**不得**是 unknown/no_connection —— 那正是 F7 的旧行为
    ctx.assert(after.status !== 'unknown',
      `回复不得因"没有连接"而记为未知（F7 的旧行为），实际 ${after.status} / ${JSON.stringify(after.error)}`);
    ctx.assert(after.error?.code !== 'no_connection',
      `不得再出现 no_connection：${JSON.stringify(after.error)}`);

    // 而且要真的把答案提交出去：prompt 计数必须增加
    await new Promise(resolve => setTimeout(resolve, 250));
    const secondSessionId = second.status('f7-1').sessionId;
    const state = JSON.parse(ctx.read(agentState));
    ctx.assert(state.prompts > promptsBefore,
      `回复必须真的提交（prompt 数应从 ${promptsBefore} 增加），实际 ${state.prompts}`);

    // 并且**必须尝试恢复过会话**。两种可接受的结果：
    //   (a) 恢复成功（状态文件里 resumed ≥ 1）；或
    //   (b) 恢复被 worker 拒绝，但桥留下了 resume_failed 记录。
    // 判定依据是"到底有没有试过"，而不是"必须成功"——F7 的缺陷正是**从未尝试**。
    // **必须是「恢复成功」这一支**（复核 V1 的判定依据）：
    // 我原先允许「resumed≥1 **或** 留下 resume_failed」，而当时 fake 的预置让恢复
    // 永远失败 —— 于是这条断言实际只在验「尝试过」，成功恢复那条路径**从未被测过**。
    // 更糟的是：预置把持久会话塞进 active 表，反而阻断恢复，报告却声称它让恢复可走通。
    const resumeFailed = relay.filter(entry => entry.event === 'resume_failed');
    ctx.equal(resumeFailed.length, 0,
      `本轮必须是成功恢复，不得出现 resume_failed：${JSON.stringify(resumeFailed)}`);
    ctx.assert((state.resumed ?? 0) >= 1,
      `恢复必须真的发生（fake 侧 resumed=${state.resumed}）`);
    ctx.equal(ctx.read ? JSON.parse(ctx.read(agentState)).sessions.length : 0, 1,
      '恢复成功时**不应**新建会话（会话数应保持 1）');
    // 会话身份必须保持：这是"恢复了旧会话"与"换了新会话"的区别
    ctx.equal(secondSessionId, firstSessionId,
      `恢复成功后 sessionId 必须不变（旧 ${firstSessionId}，新 ${secondSessionId}）`);
    // 独立核对：fake 记下的两条提示都落在**同一个**会话上
    const efforts = (state.promptEfforts ?? []);
    ctx.assert(efforts.length >= 2, `fake 应记下两条提示：${JSON.stringify(efforts)}`);
    ctx.equal(efforts[1].sessionId, firstSessionId,
      '回复那条提示必须发到**被恢复的那个会话**，而不是别的新会话');
  } finally {
    await second.shutdown().catch(() => {});
    second.store.unlock();
  }
});

suite.test('回复未能提交时会话无法确保时，记明确失败而不是未知（F7 的另一面）', async ctx => {
  // 复核要求"正确区分恢复失败和答案提交后未知"。
  // 这里让恢复**必然失败**：用一个指向不存在 worker 命令的 Bridge。
  // 预期：状态为 failed（答案从未提交），而不是 unknown。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-f7b-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');

  const good = new Store(stateRoot).init();
  good.lock({ allowStale: true });
  const bridgeA = new Bridge({
    store: good,
    sessions: SessionMap.fromStore(good.readSessions()),
    log: () => {},
    worker: { ...testWorker({ FAKE_SCENARIO: 'clarify_once', FAKE_STATE: agentState }), dshHome: join(root, 'dsh') },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });
  const view = await bridgeA.delegate(
    contract({ id: 'f7b-1', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  ctx.equal(view.status, 'needs_clarification');
  await bridgeA.shutdown();
  good.unlock();

  // 第二个 Bridge：恢复／新建都必然失败（worker 命令不存在）
  const store = new Store(stateRoot).init();
  store.lock({ allowStale: true });
  const bridgeB = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    worker: {
      command: '/nonexistent/worker-for-f7b',
      args: [],
      env: { ...process.env },
      transport: 'direct',
      dshHome: join(root, 'dsh'),
    },
  });
  await bridgeB.reply('f7b-1', '回答');
  // reply 返回时收尾仍在进行（会话无法确保 ⇒ 结果异步落地），所以要等它定下来。
  const deadline = Date.now() + 5000;
  let after = bridgeB.status('f7b-1');
  while (!['failed', 'unknown', 'completed', 'needs_clarification'].includes(after.status)
    && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    after = bridgeB.status('f7b-1');
  }
  // **不是 failed，而是回到等待澄清**（复核 V4）：
  // 答案没有提交 ⇒ 澄清仍然悬着；记成终态 `failed` 会让那句话成为做不到的承诺。
  ctx.equal(after.status, 'needs_clarification',
    `会话无法确保时应当回到等待澄清（答案没提交），实际 ${after.status} / ${JSON.stringify(after.error)}`);
  ctx.assert(after.error, '必须保留原因');
  ctx.assert(after.clarification?.answered === false,
    '答案应当退回未作答，否则用户无法用同样的答案重发');
  ctx.assert(after.error?.hint?.includes('再 reply'),
    `错误里必须给出可执行的下一步：${JSON.stringify(after.error)}`);
  await bridgeB.shutdown().catch(() => {});
  store.unlock();

  // **验证那句提示真的做得到**（复核 V4 的核心）：换一个可用的 worker，用同样的答案重发。
  const store2 = new Store(stateRoot).init();
  store2.lock({ allowStale: true });
  const bridgeC = new Bridge({
    store: store2,
    sessions: SessionMap.fromStore(store2.readSessions()),
    log: () => {},
    worker: { ...testWorker({ FAKE_SCENARIO: 'clarify_once', FAKE_STATE: agentState }), dshHome: join(root, 'dsh') },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });
  try {
    const promptsBeforeRetry = JSON.parse(ctx.read(agentState)).prompts;
    await bridgeC.reply('f7b-1', '回答');
    const retryDeadline = Date.now() + 5000;
    while (!['completed', 'failed', 'unknown', 'needs_clarification'].includes(bridgeC.status('f7b-1').status)
      && Date.now() < retryDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    ctx.equal(JSON.parse(ctx.read(agentState)).prompts, promptsBeforeRetry + 1,
      '同一个答案必须真的能重发（prompt 数 +1）—— 这是那句提示的兑现');
    ctx.assert(bridgeC.status('f7b-1').status !== 'needs_clarification'
      || bridgeC.status('f7b-1').clarification?.answer !== null,
    '重发之后不应再停留在"未作答"');
  } finally {
    await bridgeC.shutdown().catch(() => {});
    store2.unlock();
  }
});

suite.test('裁定为 retry 之后必须有显式重放入口，且只能重放一次（F10）', async ctx => {
  // 复核 F10 的判定依据：任务先 unknown，再 resolve(retry, 合法理由)，
  // 再以相同契约与 ID delegate(wait:true) —— 实际返回 queued、idempotent=true、
  // prompts=1、attempts=1，**没有第二次派发**。"由调用方决定是否重发"当时是空话。
  //
  // 修法**刻意不做自动重放**（复核的结论：不得自动重放未知任务）：
  // 提供一次显式、单独授权的入口，且每条记录只能重放一次。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-f10-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'effect_then_incomplete_frame', FAKE_STATE: agentState }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  const task = contract({ id: 'f10-1', workspace: root, permissions: { writePaths: [root] } });
  try {
    // 1. 制造一个 unknown：worker 先产生副作用再损坏响应流
    const first = await bridge.delegate(task, { wait: true });
    ctx.equal(first.status, 'unknown', `应当未观测到结果，实际 ${first.status}`);
    const attemptsBefore = store.read('f10-1').attempts;
    const promptsBefore = JSON.parse(ctx.read(agentState)).prompts;

    // 2. 以相同 ID 再 delegate 只是幂等返回原记录（这正是 F10 的旧症状）
    const again = await bridge.delegate(task, { wait: true });
    ctx.equal(again.idempotent, true, '相同契约应当幂等');
    ctx.equal(again.status, 'unknown', '幂等返回不得悄悄重发');
    ctx.equal(JSON.parse(ctx.read(agentState)).prompts, promptsBefore, '幂等返回不得产生新的 prompt');

    // 3. 显式裁定 retry
    const resolved = bridge.resolve('f10-1', { verdict: 'retry', reason: '副作用文件已核对，可以重放' });
    ctx.equal(resolved.status, 'queued');
    ctx.equal(resolved.resolution.replayed, false, '裁定本身不得重放');

    // 4. 必须有公开的重放入口 —— 而且它真的产生第二次派发
    ctx.equal(typeof bridge.retry, 'function', '必须提供显式的重放入口（F10 的核心）');
    const replayed = await bridge.retry('f10-1', { reason: '按裁定重放一次' });
    ctx.assert(['completed', 'failed', 'unknown'].includes(replayed.status),
      `重放后应当落定，实际 ${replayed.status}`);
    ctx.equal(JSON.parse(ctx.read(agentState)).prompts, promptsBefore + 1,
      '重放必须**真的**提交一次提示（否则又只是改状态）');
    ctx.equal(store.read('f10-1').attempts, attemptsBefore + 1, '重放必须让 attempts 增加');
    ctx.equal(store.read('f10-1').resolution.replayed, true, '重放事实必须落盘');

    // 5. 只能重放一次：再调即被拒
    let second = null;
    try {
      await bridge.retry('f10-1', { reason: '再放一次' });
    } catch (error) {
      second = error;
    }
    ctx.assert(second, '第二次重放必须被拒绝（否则"未知执行"的核对失去意义）');
    ctx.assert(['already_replayed', 'not_retryable'].includes(second.code),
      `拒绝理由应当明确，实际 ${second?.code}: ${second?.message}`);

    // 6. 理由必填（与 resolve 同一纪律）
    let noReason = null;
    try { bridge.retry('f10-1', {}); } catch (error) { noReason = error; }
    ctx.equal(noReason?.code, 'reason_required', '重放必须要求理由');
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('重放不得对未裁定的任务生效（F10 的边界）', async ctx => {
  const root = ctx.tempDir('bridge-f10b-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    worker: { ...testWorker({ FAKE_SCENARIO: 'effect_then_incomplete_frame' }), dshHome: join(root, 'dsh-home') },
  });
  try {
    const view = await bridge.delegate(
      contract({ id: 'f10b-1', workspace: root, permissions: { writePaths: [root] } }),
      { wait: true },
    );
    ctx.equal(view.status, 'unknown');
    // 还是 unknown：没有显式裁定就不许重放
    let error = null;
    try { await bridge.retry('f10b-1', { reason: '想直接重放' }); } catch (caught) { error = caught; }
    ctx.equal(error?.code, 'not_retryable',
      `未裁定的 unknown 不得重放，实际 ${error?.code}: ${error?.message}`);
    ctx.assert(error.message.includes('resolve') || (error.detail?.hint ?? '').length > 0,
      `提示应当指向先做裁定：${error.message} / ${error.detail?.hint ?? ''}`);
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('历史任务的档位报告不得随当前映射漂移（T3）', async ctx => {
  // 复核 T3 的两个夹具，都用真 Bridge + 离线 fake：
  //   ① 旧版本记录（没有任务级快照）：只能靠映射，而映射可能已被重建 —— 重建后不得把
  //      **今天的默认值**当作旧任务的实际值；
  //   ② 同键轮换：generation 变了就是**另一个会话**，旧任务的报告不得引用它的路由。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-t3-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');

  const makeBridge = effort => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: () => {},
      defaults: { provider: 'deepseek-official', modelId: 'deepseek-flash', reasoningEffort: effort },
      worker: {
        ...testWorker({ FAKE_SCENARIO: 'normal', FAKE_STATE: agentState }),
        dshHome: join(root, 'dsh-home'),
      },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  // 先跑一个实际 high 的任务
  const first = makeBridge('high');
  const view = await first.delegate(
    contract({ id: 't3-1', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  ctx.equal(view.status, 'completed');
  ctx.equal(view.reasoningEffort, 'high', `第一条任务实际是 high：${view.reasoningEffort}`);

  // 任务级快照必须落盘 —— 这是 T3 修法的核心
  const record = first.store.read('t3-1');
  ctx.assert(record.appliedRoute, `任务必须保存自己的路由快照：${JSON.stringify(record.appliedRoute)}`);
  ctx.equal(record.appliedRoute.reasoningEffort, 'high');
  ctx.equal(first.status('t3-1').reasoningEffortSource, 'snapshot',
    '有任务级快照时，来源应当是 snapshot');
  await first.shutdown();
  first.store.unlock();

  // ② 默认值改变（= 换了另一个部署），旧任务的报告不得跟着变
  const second = makeBridge('low');
  try {
    ctx.equal(second.status('t3-1').reasoningEffort, 'high',
      '部署默认值改成 low 之后，旧任务的报告仍应是它当时实际用的 high');
  } finally {
    await second.shutdown().catch(() => {});
    second.store.unlock();
  }
});

suite.test('旧记录（无任务级快照）在映射不可信时不得引用今天的会话（T3）', async ctx => {
  // 夹具①：忠实构造一个**旧版本格式**的记录（没有 appliedRoute），
  // 并让映射里的条目**不属于**该任务（sessionId 不同）。
  // 这时桥对「旧任务实际跑在哪个档位」没有任何证据，
  // 借用当前映射的路由就等于把今天的会话当成历史的证据。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-t3b-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');

  const makeBridge = effort => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: () => {},
      defaults: { provider: 'deepseek-official', modelId: 'deepseek-flash', reasoningEffort: effort },
      worker: {
        ...testWorker({ FAKE_SCENARIO: 'normal', FAKE_STATE: agentState }),
        dshHome: join(root, 'dsh-home'),
      },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  const first = makeBridge('high');
  const created = await first.delegate(
    contract({ id: 't3b-1', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  ctx.equal(created.status, 'completed');
  await first.shutdown();
  first.store.unlock();

  // 忠实降级成旧格式：删掉任务级快照、并把任务的 sessionId 改成一个**别的**会话，
  // 表示「这条记录来自更早的会话，映射里现在那条不是它的」。
  // 任务按 id 逐个落盘（`<state>/tasks/<id>.json`），外层是 {schema,id,updatedAt,record}。
  const taskFile = join(stateRoot, 'tasks', 't3b-1.json');
  const doc = JSON.parse(ctx.read(taskFile));
  const entry = doc.record;
  ctx.assert(entry?.appliedRoute, `前置条件：新版本应当写了任务级快照：${Object.keys(entry ?? {}).join(',')}`);
  delete entry.appliedRoute;
  entry.sessionId = 'sess-from-an-older-generation';
  writeFileSync(taskFile, `${JSON.stringify(doc, null, 2)}\n`);

  // 换一个默认档位重建桥并查询旧任务：
  // 映射里那条（属于新会话）的路由是 low，但**它不是旧任务的证据**。
  const second = makeBridge('low');
  try {
    const seen = second.status('t3b-1');
    // 复核 T3 的要求是**区分「请求档位」与「实际观测档位」**，而不是禁止给出请求值：
    //   映射不可信时桥没有证据，于是它退回请求值／部署默认值 —— 这本身可以接受，
    //   但它必须**标明这不是观测值**，否则就是「无证据却补成今天的值」。
    ctx.equal(seen.reasoningEffortSource, 'requested',
      `映射不可信时必须标明来源是 requested（实际 ${seen.reasoningEffortSource}）`);
    ctx.assert(seen.reasoningEffortSource !== 'session',
      '不得把当前映射的路由当作旧任务的观测值');
  } finally {
    await second.shutdown().catch(() => {});
    second.store.unlock();
  }
});

suite.test('回复发生会话轮换时，必须把新会话登记回任务（V2）', async ctx => {
  // 复核 V2 的判定依据：`reply` 把确保后的 ID 用在 prompt 上，但**任务的 sessionId 仍是旧值**；
  // 于是 `cancel` 会把取消发给**旧会话**——真正在跑的回复停不下来。
  // 复核实测：prompt 与 cancel 打在不同会话上，取消后任务停在 cancelling 直到超时。
  //
  // 制造轮换：让 fake 持久状态里的会话**不可恢复**（sessions 置空）。
  // 这不是「真实 DSH 跨重启根因」的判断，只是构造一条**产品允许**的轮换路径。
  const { existsSync: exists, readFileSync: readText, writeFileSync: writeText } = await import('node:fs');
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-v2-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');

  const makeBridge = scenario => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: () => {},
      worker: { ...testWorker({ FAKE_SCENARIO: scenario, FAKE_STATE: agentState }), dshHome: join(root, 'dsh-home') },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  const first = makeBridge('clarify_once');
  const view = await first.delegate(
    contract({ id: 'v2-1', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  ctx.equal(view.status, 'needs_clarification');
  const oldSessionId = first.store.read('v2-1').sessionId;
  await first.shutdown();
  first.store.unlock();

  // 让旧会话**不可恢复**：持久库里那条记录的 cwd 不匹配，resume 必然被拒 → 轮换
  const persisted = JSON.parse(readText(agentState));
  persisted.sessions = persisted.sessions.map(entry => ({ ...entry, cwd: '/nonexistent-cwd-for-v2' }));
  writeText(agentState, JSON.stringify(persisted, null, 2));

  const second = makeBridge('normal');
  try {
    await second.reply('v2-1', '回答');
    const deadline = Date.now() + 5000;
    while (!['completed', 'failed', 'unknown'].includes(second.status('v2-1').status)
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const after = second.status('v2-1');
    const newSessionId = after.sessionId;

    // 轮换必须发生（否则这条测试没有测到 V2 的路径）
    ctx.assert(newSessionId !== oldSessionId,
      `前置条件：必须发生轮换（旧 ${oldSessionId}，新 ${newSessionId}）`);

    // ① 任务的登记必须跟着换 —— 这是 V2 的修法本身
    ctx.equal(second.store.read('v2-1').sessionId, newSessionId,
      '轮换后任务记录里的 sessionId 必须更新为新会话');

    // ② 而且真正在跑的回复就是发到新会话上的（独立看 fake 的记录）
    const state = JSON.parse(readText(agentState));
    const prompts = state.promptEfforts ?? [];
    ctx.assert(prompts.length >= 2, `fake 应记下两条提示：${JSON.stringify(prompts)}`);
    ctx.equal(prompts[prompts.length - 1].sessionId, newSessionId,
      '回复那条提示必须发到轮换后的新会话');

    // ③ 会话代次也要跟着走：cancel / 报告都按它判断
    ctx.equal(second.store.read('v2-1').sessionGeneration,
      second.sessions.get(first.store.read('v2-1').sessionKey)?.generation ?? 0,
      '任务的 sessionGeneration 必须与当前映射一致');

    // ④ **路由快照也要跟着换**（复核 W5）：旧快照属于旧会话，若不同步，
    //    报告会把**旧路由**当成这次执行的观测值。
    //    复核实测：初次 high、回复实际 medium，而报告写 high / source=snapshot。
    const rebound = second.store.read('v2-1');
    if (rebound.appliedRoute) {
      ctx.equal(rebound.appliedRoute.sessionId, newSessionId,
        '路由快照必须绑定**新**会话的 id，而不是旧会话的');
      ctx.equal(rebound.appliedRoute.generation, rebound.sessionGeneration,
        '路由快照的代次必须与任务当前的代次一致');
    }
    // 旧快照不得被丢掉，而应作为历史保留
    ctx.assert((rebound.routeHistory ?? []).length >= 1,
      `被取代的旧路由必须留在 routeHistory 里作为历史证据：${JSON.stringify(rebound.routeHistory)}`);
    ctx.equal(rebound.routeHistory[0].supersededBy, 'session_rebound_on_reply');
    ctx.equal(rebound.appliedRoute.sessionId === rebound.routeHistory[0].sessionId, false,
      '被取代的旧快照应当指向**旧**会话，与新快照不同');
  } finally {
    await second.shutdown().catch(() => {});
    second.store.unlock();
  }
});

suite.test('“每条记录只能重放一次”必须经得起反复裁定（V3）', async ctx => {
  // 复核 V3 的判定依据：每次 `resolve(retry)` 都新建一个 `replayed: false` 的 resolution，
  // 于是「裁定 → 重放 → 再裁定 → 再重放」可以无限循环：
  //   delegate → unknown → resolve(retry) → retry → unknown → resolve(retry) → retry → ...
  // 复核实测走了三轮（prompts 1→2→3），而 replayAttempts 还被错写成 1。
  // 另外：删掉 retry 里那段限制，原四条测试**仍然全绿** —— 因为第二次调用时状态已是 unknown，
  // 被前面的状态门槛拦下，根本没走到被声称验证的那段。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-v3-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'effect_then_incomplete_frame', FAKE_STATE: agentState }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  try {
    await bridge.delegate(
      contract({ id: 'v3-1', workspace: root, permissions: { writePaths: [root] } }),
      { wait: true },
    );
    ctx.equal(bridge.status('v3-1').status, 'unknown');

    // 第一次：裁定 + 显式重放
    bridge.resolve('v3-1', { verdict: 'retry', reason: '第一次重放' });
    const first = await bridge.retry('v3-1', { reason: '执行第一次重放' });
    ctx.assert(['unknown', 'failed', 'completed'].includes(first.status),
      `第一次重放应当结算，实际 ${first.status}`);
    ctx.equal(bridge.store.read('v3-1').replayCount, 1, '重放计数必须落盘为 1');

    // 再裁定一次 —— 这一步必须**不能**把「已重放」的事实清掉
    const again = bridge.resolve('v3-1', { verdict: 'retry', reason: '再裁定一次' });
    ctx.equal(again.status, 'queued');
    ctx.equal(bridge.store.read('v3-1').replayCount, 1,
      '重新裁定不得清零任务级重放计数（V3 的核心）');
    ctx.equal(again.resolution.replayed, true,
      '重新裁定生成的 resolution 必须如实反映"已重放过"');

    // 第二次重放必须被拒
    let error = null;
    try {
      await bridge.retry('v3-1', { reason: '企图第二次重放' });
    } catch (caught) { error = caught; }
    ctx.equal(error?.code, 'already_replayed',
      `第二次重放必须报 already_replayed，实际 ${error?.code}: ${error?.message}`);

    // 而且这条拒绝不是因为"状态不是 queued" —— 它确实已经是 queued 了
    ctx.equal(bridge.status('v3-1').status, 'queued',
      '前置条件：任务此刻确实是 queued，所以拒绝只能来自重放上限');
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('连续两次澄清：续跑必须真的追加，不得丢掉先前答复（F8）', async ctx => {
  // 复核 F8 的判定依据：worker 连续提出两次澄清时，**第三条 prompt 不以第二条开头**，
  // 而且**第一份答复不见了**。对这两条实际文本调用 `checkPrefixStability` 得到 stable=false，
  // 但桥日志两次都写 `prefix_appended` —— 也就是「续跑只能追加」这个宣称并不成立。
  //
  // 根因：`renderFollowUp` 每轮都用 `renderPrompt(contract)` 从**原始契约**重建，
  // 而 `contract.clarification` 每轮被整份替换。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { renderPrompt } = await import('../src/orchestration.mjs');
  const { checkPrefixStability } = await import('../src/usage.mjs');
  const root = ctx.tempDir('bridge-f8-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    worker: {
      // `clarify` 场景**每轮都会问**，正好造出"连续两次澄清"
      ...testWorker({ FAKE_SCENARIO: 'clarify', FAKE_STATE: agentState }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  const task = contract({ id: 'f8-1', workspace: root, permissions: { writePaths: [root] } });
  try {
    const first = await bridge.delegate(task, { wait: true });
    ctx.equal(first.status, 'needs_clarification');

    // 第一轮答复 → worker 再问一次
    const afterFirst = await bridge.reply('f8-1', '第一个答复内容');
    ctx.assert(afterFirst.status === 'running' || afterFirst.status === 'needs_clarification',
      `第一次回复后的状态：${afterFirst.status}`);
    let deadline = Date.now() + 5000;
    while (bridge.status('f8-1').status !== 'needs_clarification' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    ctx.equal(bridge.status('f8-1').status, 'needs_clarification',
      '前置条件：worker 应当第二次要求澄清');

    // 第二轮答复 → 记录里应当同时留下两轮的问答。
    // 注意：`clarify` 场景**每轮都会问**，所以这里**不要**等终态（那会白等到超时）。
    // 我们要的是「第二次续跑真的被提交出去」，等它重新进入 needs_clarification 即可。
    await bridge.reply('f8-1', '第二个答复内容');
    // 等的是**发送文本**被记录：`clarifications` 在提交前就落盘了，
    // 而 `lastPromptText` 是在真正提交那一刻更新的 —— 只等前者会读到上一轮的文本。
    deadline = Date.now() + 3000;
    while (!String(bridge.store.read('f8-1').lastPromptText ?? '').includes('第二个答复内容')
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const record = store.read('f8-1');
    // ① 两轮问答都要留下（否则「先前答复丢了」这个缺陷会重演）
    ctx.equal((record.clarifications ?? []).length, 2,
      `两轮澄清都必须被记录：${JSON.stringify(record.clarifications)}`);
    ctx.equal(record.clarifications[0].answer, '第一个答复内容');
    ctx.equal(record.clarifications[1].answer, '第二个答复内容');

    // ② **线上真相**：以 fake 独立记录的 prompt 文本为准，而不是桥的自报记录。
    //
    // 复核 X2 的判定依据：只在真实提交入口把 `text: followUp` 换回"从原始契约重建"，
    // 而保存的 `lastPromptText`、稳定性日志与所有断言都保留 —— **16/0 全绿**，
    // 而 fake 侧看到的是「第三条不以第二条为前缀，且没有第一份答案」。
    // 也就是说：桥的**拟发送记录**遮住了发送路径的回归。
    const wireTexts = (JSON.parse(ctx.read(agentState)).promptTexts ?? []).map(entry => entry.text);
    ctx.assert(wireTexts.length >= 3, `fake 必须记下三条线上文本：${wireTexts.length}`);
    ctx.assert(wireTexts[1].startsWith(wireTexts[0]),
      'second prompt 必须以 first prompt 为前缀（线上证据）');
    ctx.assert(wireTexts[2].startsWith(wireTexts[1]),
      `third prompt 必须以 second prompt 为前缀（线上证据）：\n${wireTexts[2].slice(-200)}`);
    ctx.assert(wireTexts[2].includes('第一个答复内容'),
      'third prompt 必须仍含第一份答案（这正是原 F8 缺陷的形态）');

    // ③ 桥保存的记录必须**等于**线上文本 —— 否则它就是一句不成立的自报
    const sent = record.lastPromptText;
    ctx.equal(sent, wireTexts[wireTexts.length - 1],
      '桥保存的 lastPromptText 必须等于 fake 实际收到的最后一条文本');
    ctx.assert(typeof sent === 'string' && sent.length > 0, '必须记录本轮实际发送的文本');
    ctx.assert(sent.includes('第一个答复内容'),
      `最后一次发送的文本必须仍含第一个答复（F8 的核心）：${sent.slice(-300)}`);
    ctx.assert(sent.includes('第二个答复内容'), '也要含第二个答复');
    // 顺序也要对：先前答复在后者之前
    ctx.assert(sent.indexOf('第一个答复内容') < sent.indexOf('第二个答复内容'),
      '先前的答复必须排在后面那轮之前');

    // ④ 日志不得再谎称"追加成功"：稳定性判定必须基于**上一轮实际发送的文本**
    const firstPromptText = renderPrompt(task);
    ctx.assert(sent.startsWith(firstPromptText),
      '最终文本必须以**首轮提示**为前缀（追加的起点）');
    const diverged = logs.filter(entry => entry.event === 'prefix_diverged');
    ctx.equal(diverged.length, 0,
      `本场景不该出现前缀失配（说明每次都在上一轮之后追加）：${JSON.stringify(diverged)}`);
    // 反过来验一遍判据本身：拿"丢了第一份答复"的文本去比，必须报不稳定
    const wrong = `${firstPromptText}\n\n## 澄清答复\n第二个答复内容\n`;
    ctx.equal(checkPrefixStability(record.lastPromptText.replace('第一个答复内容', ''), wrong).stable, false,
      '判据必须能识别"丢了先前答复"的文本（否则这条测试的③是空的）');
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('未提交的答案不得进入「此前的澄清」历史（X4）', async ctx => {
  // 复核 X4 的判定依据：回退未作答只撤回**当前** clarification，没有撤回新加入的
  // `clarifications` —— 于是下一次把**从未发出**的答案当历史送给 worker。
  // 复核实测：总 prompt 只有 2 条，累积问答 2 条，而最终文本的「此前的澄清」里
  // **含那条未提交的旧答案**。
  //
  // 完整流程（缺一环就测不到污染）：
  //   ① 桥 A：澄清 → 用一个**能完成**的答案回答（产生一条 submitted 历史）；
  //   ② 桥 B：再答一次，但**提交阶段失败**（会话无法确保）→ 该答案从未发出；
  //   ③ 桥 C：用**更正后的不同答案**重发 → 线上文本只能含更正答案与已提交的那条。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-x4-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  // 同一个 fake 状态：三轮的 prompt 全部累积在 `promptTexts` 里
  const worker = () => ({
    ...testWorker({ FAKE_SCENARIO: 'clarify_twice', FAKE_STATE: agentState }),
    dshHome: join(root, 'dsh-home'),
  });
  const mkBridge = () => new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    worker: worker(),
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  const task = contract({ id: 'x4-1', workspace: root, permissions: { writePaths: [root] } });
  const first = mkBridge();
  try {
    const r1 = await first.delegate(task, { wait: true });
    ctx.equal(r1.status, 'needs_clarification', '前置条件：worker 要求澄清');
    // ① 第一次回复：**提交成功**（这条会成为合法的历史）
    await first.reply('x4-1', '第一个已提交的答案');
    let deadline = Date.now() + 3000;
    while (first.status('x4-1').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const afterFirst = store.read('x4-1');
    ctx.equal(afterFirst.clarifications?.[0]?.submitted, true,
      `第一条已提交的问答必须带 submitted 标记：${JSON.stringify(afterFirst.clarifications)}`);
    await first.shutdown();

    // ② 第二次回复：**提交阶段失败** —— 该答案从未发出
    const failing = new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: entry => logs.push(entry),
      worker: {
        ...testWorker({ FAKE_SCENARIO: 'clarify_twice' }),
        command: '/nonexistent/dsh-binary', // 无法确保会话 → 答案从未提交
        dshHome: join(root, 'dsh-home2'),
      },
      createClient: (spec, hooks) => new AcpClient(spec, hooks),
    });
    // `reply` 在"未提交"时**不抛错** —— 它把任务回退到 needs_clarification 并返回视图。
    // （抛错会让调用方以为需要重试整件事，而实际是"答案没发出去、澄清仍悬着"。）
    await failing.reply('x4-1', '**从未发出的旧答案**');
    await failing.shutdown().catch(() => {});

    const afterFail = store.read('x4-1');
    ctx.equal(afterFail.status, 'needs_clarification', '未提交时必须回到等待澄清');
    ctx.equal(afterFail.clarification?.answer, null, '答案必须退回未作答');
    // **关键**：那条未提交的问答不得留在可用的历史里
    ctx.deepEqual((afterFail.clarifications ?? []).filter(e => e.submitted !== true), [],
      `未提交的条目必须被撤回，实际：${JSON.stringify(afterFail.clarifications)}`);

    // ③ 第三次：用更正后的不同答案重发，并让它完成
    const third = mkBridge();
    try {
      await third.reply('x4-1', '更正后的答案');
      deadline = Date.now() + 3000;
      while (['needs_clarification', 'running'].includes(third.status('x4-1').status)
        && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const wire = (JSON.parse(ctx.read(agentState)).promptTexts ?? []).map(e => e.text);
      ctx.equal(wire.length, 3, `线上应有三条 prompt（首次派发 + 两次回复）：${wire.length}`);
      ctx.assert(wire[2].includes('更正后的答案'), '第三条必须含更正答案');
      ctx.assert(wire[2].includes('第一个已提交的答案'),
        '第三条必须仍含**已提交**的那条历史（否则这条测试把合法历史也删掉了）');
      ctx.assert(!wire[2].includes('从未发出的旧答案'),
        `**从未发出的答案绝不能被送给 worker**，实际：\n${wire[2].slice(-500)}`);
      ctx.assert(!wire[1].includes('从未发出的旧答案'),
        '未提交的那次本身也没有真的发送出去');
    } finally {
      await third.shutdown().catch(() => {});
    }
  } finally {
    store.unlock();
  }
});


suite.test('发送文本落盘失败后，不得再宣称前缀稳定（X3）', async ctx => {
  // 复核 X3 的判定依据：`lastPromptText` 写失败被吞掉，后续比较使用**过时 base**，
  // 不能兑现「上一轮实际文本只能追加」。复核得到的日志是：
  //   prefix_appended / last_prompt_text_not_recorded / prefix_appended
  // —— 中间那次宣称是**没有证据支撑**的。
  //
  // 我的修法把「有没有可信 base」变成三态并**分流日志**：
  //   persisted → 正常比较、记 prefix_appended（带 baseSource）
  //   memory    → 比较并记 prefix_appended + persistedHistoryIncomplete: true
  //   none      → **不比较**，记 `prefix_stability_unverified`
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { checkPrefixStability } = await import('../src/usage.mjs');
  const root = ctx.tempDir('bridge-x3-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'clarify', FAKE_STATE: agentState }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  // 注入：让**保存 lastPromptText 的写**失败，其余写正常。
  //
  // 注意注入窗口（复核 Z2 改动了提交顺序之后）：保存现在发生在 **prompt 成功结算之后**
  // （提交确认才回填），所以"命中一次"要一直命中到该轮结束 ——
  // 否则 `.then` 里的第二次尝试会把文本写进去，前置条件「记录里不得有 lastPromptText」就不成立。
  const realWrite = store.write.bind(store);
  let injecting = true;
  let injected = false;
  store.write = (record, options) => {
    if (injecting && record?.lastPromptText !== undefined) {
      injected = true;
      const error = new Error('injected write failure');
      error.code = 'EIO';
      throw error;
    }
    return realWrite(record, options);
  };

  const task = contract({ id: 'x3-1', workspace: root, permissions: { writePaths: [root] } });
  try {
    await bridge.delegate(task, { wait: true });
    await bridge.reply('x3-1', '第一份答复');
    // 等**保存那一步真的被尝试过**（并留下痕迹）——否则断言跑在回复完成之前，
    // 会误报"注入没命中"（这是我第一版的实际症状）。
    let saved = Date.now() + 3000;
    while (!logs.some(entry => entry.event === 'last_prompt_text_not_recorded')
      && Date.now() < saved) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    ctx.equal(injected, true, '前置条件：注入的保存失败必须真的发生');
    // 前置条件②：落盘真的失败了 —— 记录里此时**没有** lastPromptText
    ctx.equal(typeof store.read('x3-1').lastPromptText, 'undefined',
      '注入生效时记录里不得有 lastPromptText');

    let deadline = Date.now() + 3000;
    while (bridge.status('x3-1').status !== 'needs_clarification' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // **让 base 真的不可用**（复核 AB2 之后台账语义变了，这里同步更新）：
    // 台账现在**每次真实发送都刷新**，并且带 `taskId`/`sessionId`/`generation` 归属 ——
    // 所以"把记录 revision 推进一格"不再能让它过时（那正是 Z1 的修法目标）。
    //
    // 真正等价于"无可信 base"的情形是：**台账里那份文本不属于当前任务**。
    // 这与"重建 Bridge（进程内台账为空）"是同一个语义：那时既没有持久文本
    // （这一轮的落盘失败过）、也没有可用的内存台账 → 必须拒绝下前缀结论。
    bridge.forgetDeliveryLedgerForTest();
    injecting = false;                                 // 关闭注入窗口
    store.write = realWrite;                           // 恢复正常写入
    await bridge.reply('x3-1', '第二份答复');
    deadline = Date.now() + 3000;
    while (!logs.some(entry => entry.event === 'prefix_stability_unverified'
      || entry.event === 'prefix_appended') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // ① **前提已加强**（复核 AB1 的后半）：现在有了**持久**的发送文本缓冲，
    //    所以"清掉内存台账"不再等于"没有可信 base" —— 它会从持久缓冲取到
    //    **上一轮确实发送过的文本**（`baseSource === 'persisted-log'`），
    //    这正是"已发送答案不丢"要的性质。
    //    真正"没有可信 base"的情形（既无落盘文本、又无缓冲）由日志里的
    //    `prefix_stability_unverified` 覆盖 —— 下面保留这条判据的自检。
    const withLog = logs.filter(entry => entry.event === 'prefix_appended'
      && entry.baseSource === 'persisted-log');
    ctx.assert(withLog.length >= 1,
      `内存台账被清空时应当从持久缓冲取 base，实际：${JSON.stringify(logs.map(l => [l.event, l.baseSource]))}`);
    const unverified = logs.filter(entry => entry.event === 'prefix_stability_unverified');
    ctx.assert(unverified.every(entry => entry.reason === 'base_unavailable' &&
      /不比较|不宣称/.test(entry.note ?? '')),
      `未验证留痕必须说明"没有比较"，实际：${JSON.stringify(unverified)}`);

    // ② 保存失败必须留痕，且写明"持久历史不完整"
    const notRecorded = logs.filter(entry => entry.event === 'last_prompt_text_not_recorded');
    ctx.assert(notRecorded.length >= 1, '保存失败必须留痕');
    ctx.equal(notRecorded[0].persistedHistoryIncomplete, true,
      '留痕必须写明"持久历史不完整"，而不是笼统的"质量受影响"');

    // ③ 那次"未验证"的轮次**不得**同时出现 prefix_appended（否则就是无证据宣称）
    const appendedAfterFailure = logs.filter(entry => entry.event === 'prefix_appended'
      && entry.baseSource !== 'memory');
    ctx.assert(appendedAfterFailure.every(entry => entry.baseSource === 'persisted'
      || entry.baseSource === 'persisted-log'),
    // `persisted-log` 是复核 AB1 的后半新增的可信来源：
    // 它让「重建之后仍能取到上一轮实际发送的文本」成立 —— 所以它算可信来源。
    `追加结论只能来自可信来源：${JSON.stringify(appendedAfterFailure)}`);

    // ④ 判据自检：**空串是任何串的前缀** —— 这恰恰说明必须有 base 守卫。
    //    如果代码在 base 不可用时仍去比较，它会得到 stable: true 并记
    //    `prefix_appended`，那就是一条无证据的宣称。所以这里先确认这个陷阱真实存在：
    ctx.equal(checkPrefixStability('', 'anything').stable, true,
      '空 base 会被判为稳定 —— 正因如此，代码必须先判断"有没有可信 base"，不能直接比较');
    //    再确认代码**没有**掉进这个陷阱：所有 prefix_appended 都必须带可靠的 baseSource
    const bogus = logs.filter(entry => entry.event === 'prefix_appended' && !entry.baseSource);
    ctx.deepEqual(bogus, [],
      'prefix_appended 必须标明 baseSource（否则无法区分它是否来自可信 base）');
  } finally {
    store.write = realWrite;
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});


suite.test('轮换后的路由快照必须是**新会话的值**，不得沿用旧档位（Y7）', async ctx => {
  // 复核 Y7 的判定依据：V2 的断言只核对了快照的 sessionId / 代次 / 历史，
  // **没有要求当前路由值真的来自新会话** —— 所以"身份正确、值仍取旧会话"的变异能穿过（10/0）。
  // 复核实测：把 `nextRoute` 改成保留新 sessionId/generation、但
  // `reasoningEffort` 取 `current.appliedRoute.reasoningEffort`，相关测试仍全绿。
  //
  // 这里让**新会话的档位与旧的不同**（旧 high → 新 low），这样"值是否来自新会话"才可分辨。
  const { readFileSync: readText, writeFileSync: writeText } = await import('node:fs');
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-y7-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');

  const makeBridge = scenario => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: () => {},
      worker: { ...testWorker({ FAKE_SCENARIO: scenario, FAKE_STATE: agentState }), dshHome: join(root, 'dsh-home') },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  // ① 第一次：high
  const first = makeBridge('clarify_once');
  first.setSelectionDefaults({ reasoningEffort: 'high' });
  const view = await first.delegate(
    contract({ id: 'y7-1', workspace: root, permissions: { writePaths: [root] } }),
    { wait: true },
  );
  ctx.equal(view.status, 'needs_clarification', '前置条件：worker 要求澄清');
  const oldRoute = first.store.read('y7-1').appliedRoute;
  ctx.equal(oldRoute?.reasoningEffort, 'high', `前置条件：旧会话档位应为 high：${JSON.stringify(oldRoute)}`);
  const oldSessionId = first.store.read('y7-1').sessionId;
  await first.shutdown();
  first.store.unlock();

  // ② 让旧会话不可恢复 → 轮换
  const persisted = JSON.parse(readText(agentState));
  persisted.sessions = persisted.sessions.map(entry => ({ ...entry, cwd: '/nonexistent-cwd-for-y7' }));
  writeText(agentState, JSON.stringify(persisted, null, 2));

  // ③ 第二次：**新档位 low** —— 若快照沿用旧值，它会错误地报 high
  const second = makeBridge('normal');
  second.setSelectionDefaults({ reasoningEffort: 'low' });
  try {
    await second.reply('y7-1', '回答');
    const deadline = Date.now() + 5000;
    while (!['completed', 'failed', 'unknown'].includes(second.status('y7-1').status)
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const rebound = second.store.read('y7-1');
    const newSessionId = rebound.sessionId;
    ctx.assert(newSessionId !== oldSessionId, '前置条件：必须真的发生了轮换（新会话 id 不同）');

    // **核心**：快照的档位必须来自新会话（low），而不是沿用旧会话的 high
    ctx.equal(rebound.appliedRoute?.reasoningEffort, 'low',
      `轮换后快照必须取**新会话**的档位（low），实际 ${JSON.stringify(rebound.appliedRoute)}`);
    ctx.equal(rebound.appliedRoute?.sessionId, newSessionId, '快照必须绑定新会话 id');

    // 新映射里的 route 也必须与之一致（不能"快照对、映射错"，反之亦然）
    const key = rebound.sessionKey;
    const mapped = second.sessions.get(key);
    ctx.equal(mapped?.route?.reasoningEffort ?? null, rebound.appliedRoute?.reasoningEffort ?? null,
      `映射与快照的档位必须一致：映射 ${JSON.stringify(mapped?.route)} 快照 ${JSON.stringify(rebound.appliedRoute)}`);

    // 旧值必须作为**历史**保留，并且仍归属**旧会话**
    const history = rebound.routeHistory ?? [];
    ctx.assert(history.length >= 1, `旧快照必须留在历史里：${JSON.stringify(history)}`);
    ctx.equal(history[history.length - 1].reasoningEffort, 'high', '历史里必须是旧值 high');
    ctx.equal(history[history.length - 1].sessionId, oldSessionId,
      '历史条目必须仍归属**旧**会话 —— 不得被改写成新会话');

    // 公开报告也要与快照一致
    //
    // **不得用 `if (x !== undefined)` 包住**（复核 AA5 的判定依据）：
    // 条件式断言在**字段被删掉**时会整条跳过 —— 复核实测"仅删公开视图的
    // `reasoningEffort` 字段"这个变异原目标仍 **1/0** 绿。
    // 所以这里直接要求字段存在且值为 low。
    const published = second.status('y7-1');
    ctx.assert(published.reasoningEffort !== undefined,
      `公开报告**必须**带 reasoningEffort 字段（缺字段会让调用方无法识别档位）：${JSON.stringify(published)}`);
    ctx.equal(published.reasoningEffort, 'low',
      `公开报告必须报新会话的档位：${JSON.stringify(published)}`);

    // **接收端事实：新会话必须真的收到 low**（复核 AA5 的第一条变异）。
    //
    // 我上一版只核对了桥**自己的**快照与公开视图 —— 于是
    // "只对 low 跳过实际 setConfigOption RPC"这种变异能穿过：
    // 桥自报 low、fake 新会话只收到 model 配置、没有任何 reasoning RPC。
    // 现在按**新 sessionId** 去 fake 的记录里找实际收到的配置与档位。
    const agentRecord = JSON.parse(ctx.read(agentState));
    const configSets = agentRecord.configSets ?? [];
    const newSessionConfigs = configSets.filter(entry => entry.sessionId === newSessionId);
    ctx.assert(newSessionConfigs.length >= 1,
      `新会话 (${newSessionId}) 必须真的收到过配置下发；实际：${JSON.stringify(configSets.map(e => e.sessionId))}`);
    const reasoningSets = newSessionConfigs.filter(entry => entry.configId === 'reasoning_effort' || entry.optionId === 'reasoning_effort' || entry.id === 'reasoning_effort');
    ctx.assert(reasoningSets.length >= 1,
      `新会话必须真的收到 reasoning 档位下发（跳过 RPC 时这里是空的）：${JSON.stringify(newSessionConfigs)}`);
    ctx.equal(reasoningSets[reasoningSets.length - 1].value ?? reasoningSets[reasoningSets.length - 1].currentValue,
      'low',
      `新会话实际收到的档位必须是 low：${JSON.stringify(reasoningSets)}`);

    // 旧会话仍应当是 high（不得被新值污染）
    //
    // **不得用 `if (length > 0)` 包住**（复核 AG3 的判定依据）：
    // 条件式断言在"旧会话**根本没收到** reasoning 下发"时会整条跳过 ——
    // 复核实测（只对 high 跳过 RPC）原 Y7 目标仍 **1/0**，
    // 而 fake 的 `configSets` 里**没有旧会话 reasoning 配置**、`promptEfforts` 是 medium → low。
    // 所以这里直接要求旧会话的 reasoning 记录**存在且为 high**。
    const reasoningOf = entry => entry.configId === 'reasoning_effort'
      || entry.optionId === 'reasoning_effort' || entry.id === 'reasoning_effort';
    const oldSessionConfigs = configSets.filter(entry => entry.sessionId === oldSessionId && reasoningOf(entry));
    ctx.assert(oldSessionConfigs.length > 0,
      `旧会话必须**真的收到** reasoning 档位下发（空数组说明那条 RPC 被跳过）：`
      + `${JSON.stringify(configSets.map(e => [e.sessionId, e.configId]))}`);
    const oldValue = oldSessionConfigs[oldSessionConfigs.length - 1].value ?? oldSessionConfigs[oldSessionConfigs.length - 1].currentValue;
    ctx.equal(oldValue, 'high', '旧会话收到的档位必须仍是 high，不得被新值改写');

    // **再按 sessionId 核对执行时实际使用的档位**（复核 AG3 的建议）
    const efforts = agentRecord.promptEfforts ?? [];
    const oldEffort = efforts.find(entry => entry.sessionId === oldSessionId)?.effort;
    const newEffort = efforts.find(entry => entry.sessionId === newSessionId)?.effort;
    // **无条件要求两份执行证据都存在**（复核 AH2 的判定依据）。
    //
    // 我上一版用 `if (value !== undefined)` 包住 —— 于是把 `promptEfforts` 清空
    // 就能让**两个断言都跳过**：复核实测 Y7 原目标仍 **1/0**，
    // 而那一刻配置 RPC 记录仍在（两个会话的 high/low 下发都在），
    // **只是"执行时实际用了什么档位"的证据完全没有了**。
    // 这与生产 route 的 unknown/null 场景是不同检查项，不能混为一谈。
    ctx.equal(oldEffort, 'high',
      `旧会话"执行时实际使用"的档位证据不得缺失（清空 promptEfforts 即绕过）：${JSON.stringify(efforts)}`);
    ctx.equal(newEffort, 'low',
      `新会话"执行时实际使用"的档位证据不得缺失（清空 promptEfforts 即绕过）：${JSON.stringify(efforts)}`);
  } finally {
    await second.shutdown().catch(() => {});
    second.store.unlock();
  }
});

suite.test('保存失败后：内存台账必须保住下一轮的 base，且同一轮不得有互斥结论（Z1）', async ctx => {
  // 复核 Z1 的两条穿透证据（我上一轮的测试都没挡住）：
  //   ① 直接删掉保存失败后的 `#pendingPromptText.set(...)`，相关测试仍 **20/0** ——
  //      现有 X3 测试只测"内存过时后报 unverified"，**没有要求 memory 路径真正保住下一轮文本**；
  //   ② 在无可信 base 的同一次回复里额外记一条 `prefix_appended / baseSource:persisted`，
  //      原 X3 目标测试仍 **1/0** —— 它只检查"日志里有 unverified"与"appended 的标签是 persisted"，
  //      **没有核对同一轮不能同时存在两种结论**。
  //
  // 另外复核指出：普通状态推进（澄清结算）就会改变记录 revision，
  // 于是"内存副本的 revision 仍成立"这个判据本身是脆的 —— 现在改用**提交序号**。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-z1-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'clarify', FAKE_STATE: agentState }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  // 注入：让**第一份回复**的文本保存失败（之后恢复）
  const realWrite = store.write.bind(store);
  let injecting = true;
  store.write = (record, options) => {
    if (injecting && record?.lastPromptText !== undefined) {
      const error = new Error('injected write failure');
      error.code = 'EIO';
      throw error;
    }
    return realWrite(record, options);
  };

  const task = contract({ id: 'z1-1', workspace: root, permissions: { writePaths: [root] } });
  try {
    await bridge.delegate(task, { wait: true });
    await bridge.reply('z1-1', '第一份答复');
    let deadline = Date.now() + 3000;
    while (bridge.status('z1-1').status !== 'needs_clarification' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    ctx.equal(bridge.status('z1-1').status, 'needs_clarification', '前置条件：worker 再次要求澄清');

    injecting = false;
    store.write = realWrite;
    await bridge.reply('z1-1', '第二份答复');
    deadline = Date.now() + 3000;
    while (!String(store.read('z1-1').lastPromptText ?? '').includes('第二份答复')
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // ① **线上真相**：第三轮（第二份回复）必须以**第二份的文本**为前缀，
    //    也就是说第一份已发送的答案必须仍在里面。
    //    这正是"删掉内存台账"会破坏的性质 —— 旧文本会替代内存文本。
    const wire = (JSON.parse(ctx.read(agentState)).promptTexts ?? []).map(entry => entry.text);
    ctx.assert(wire.length >= 3, `线上应至少三条 prompt：${wire.length}`);
    ctx.assert(wire[2].startsWith(wire[1]),
      `第三轮必须以第二轮为前缀（内存台账要保住 base）：\n${wire[2].slice(-300)}`);
    ctx.assert(wire[2].includes('第一份答复'),
      '第一份**已发送**的答复不得从后续文本里消失');

    // ①b **必须由内存台账提供 base**。
    //
    // 只断言"文本含第一份答复"是不够的 —— 我实测发现：删掉内存台账之后，
    // 代码会退回 `renderPrompt(record.contract)` 当 base，而那条**不含第一份答复**，
    // `startsWith` 依然成立（契约是双方共同的前缀），于是断言被骗过。
    // 真正要守的性质是：**声称"追加成功"的那一轮，必须有一个可信的 base**。
    const withBase = logs.filter(entry => entry.event === 'prefix_appended'
      && entry.replySeq === 2);
    ctx.equal(withBase.length, 1,
      `第二轮必须且只能有一次「追加成功」的结论：${JSON.stringify(logs.map(e => [e.event, e.replySeq, e.baseSource]))}`);
    ctx.equal(withBase[0].baseSource, 'memory',
      '第二轮的可信 base 必须来自内存台账（记录里没有可用的 lastPromptText）');
    // 反向：不得出现"没有可信 base"的结论 —— 那说明台账没保住文本
    ctx.assert(!logs.some(entry => entry.event === 'prefix_stability_unverified'
      && entry.replySeq === 2),
    `第二轮不得因为「没有可信 base」而放弃结论：${JSON.stringify(logs.filter(e => e.replySeq === 2))}`);

    // ② **同一轮不得有互斥结论**（复核 Z1 的穿透证据 ②）：
    //    按 `replySeq` 分组，每一轮的结论必须是"要么 verified、要么 unverified"，
    //    不能同时出现 prefix_appended 与 prefix_stability_unverified。
    const bySeq = new Map();
    for (const entry of logs) {
      if (!['prefix_appended', 'prefix_diverged', 'prefix_stability_unverified'].includes(entry.event)) continue;
      const list = bySeq.get(entry.replySeq) ?? [];
      list.push(entry.event);
      bySeq.set(entry.replySeq, list);
    }
    ctx.assert(bySeq.size >= 2, `日志必须按轮标记 replySeq：${JSON.stringify([...bySeq])}`);
    for (const [seq, events] of bySeq) {
      const conclusive = events.filter(e => e === 'prefix_appended' || e === 'prefix_diverged');
      const inconclusive = events.filter(e => e === 'prefix_stability_unverified');
      ctx.assert(!(conclusive.length > 0 && inconclusive.length > 0),
        `第 ${seq} 轮同时给出了两种互斥结论：${JSON.stringify(events)}`);
      ctx.assert(events.length === 1,
        `第 ${seq} 轮应当只有一条前缀结论：${JSON.stringify(events)}`);
    }

    // ③ 保存失败必须留下**持久化**的不完整标记（跨 Bridge 也成立）
    const record = store.read('z1-1');
    ctx.equal(record.incompletePromptHistory, false,
      '第二份成功落盘之后，不完整标记应当被清掉');
    // 而失败当下确实写过这个标记 —— 用日志核对（记录已被后续成功覆盖）
    ctx.assert(logs.some(entry => entry.event === 'last_prompt_text_not_recorded'
      && entry.persistedHistoryIncomplete === true),
    '保存失败必须留下"持久历史不完整"的痕迹');
  } finally {
    store.write = realWrite;
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('真正确认提交之前，答案不得被记成 submitted（Z2）', async ctx => {
  // 复核 Z2 的判定依据：会话已确保**不等于**答案已提交。`submitted` 标记此前是在
  // **发送动作之前**写成 true 的，写入传输失败后没有撤回。
  // 复核实测（只对该 client 的 stdin.write 注入同步 EPIPE）：
  //   fake 独立记录只有 1 条首次 prompt、没有回复；任务记成
  //   **failed / observation.receipt:no_prompt**，而同一记录的回答却是 **submitted:true**，
  //   `lastPromptText` 也保存了这条**没有写出去**的文本。
  //
  // 这里的对应实验：让**会话无法确保**（worker 命令不存在 → 请求根本发不出去）。
  // 断言：答案不进历史、文本不落盘、答案退回未作答、任务回到等待澄清。
  //
  // **坦白覆盖范围**（我实测过）：把"发送前就标 submitted"这个变异放回去，**这条测试不会红** ——
  // 因为失败路径的**回退**会把那个标记撤掉，最终状态与正确实现相同。
  // 也就是说："预标记 + 回退"这个组合的**可观察结果**是对的。
  // 这条测试固定的是**最终状态**（答案没被当成已答复、文本没被当成已发送、
  // 任务回到等待澄清），而不是"内部必须在发送之后才标记"这个实现细节。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { readFileSync } = await import('node:fs');
  const root = ctx.tempDir('bridge-z2-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');
  const logs = [];

  // 每个桥**按需创建**，用完就 shutdown + unlock —— 同一时刻只有一个持锁者
  // （与本仓 V2 那条测试同一种做法）。
  const makeBridge = (scenario, extraWorker = {}) => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: entry => logs.push(entry),
      worker: {
        ...testWorker({ FAKE_SCENARIO: scenario, FAKE_STATE: agentState }),
        ...extraWorker,
        dshHome: join(root, `dsh-home-${scenario}`),
      },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  const task = contract({ id: 'z2-1', workspace: root, permissions: { writePaths: [root] } });

  // ① 先造一条真正的澄清（用一个能连上的桥）
  const first = makeBridge('clarify_once');
  const view = await first.delegate(task, { wait: true });
  ctx.equal(view.status, 'needs_clarification', '前置条件：worker 要求澄清');
  await first.shutdown();
  first.store.unlock();

  // ② 用一个**连不上**的桥回复：请求发不出去
  const broken = makeBridge('clarify_once', { command: '/nonexistent/dsh-binary-for-z2' });
  try {
    await broken.reply('z2-1', '这条答案发不出去');
    // `reply` 返回时收尾可能尚未结算（错误路径是异步的）—— 有界等待它落定。
    const deadline = Date.now() + 5000;
    while (broken.store.read('z2-1').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const record = broken.store.read('z2-1');

    // ① 答案**不得**被标成已提交（它从未写上线）。
    //    注意：本轮只是**改**上一轮建立的澄清，记录里通常没有同步多出的问答条目 ——
    //    所以要断言的是"答案有没有被当作已答复留下"（`clarification.answer` 必须退回 null）。
    const rounds = record.clarifications ?? [];
    ctx.assert(!rounds.some(entry => entry.submitted === true),
      `从未写上线时不得标为已提交：${JSON.stringify(rounds)}`);
    ctx.equal(record.clarification?.answer, null,
      `未提交时必须把答案退回未作答（否则它就是"发送前就当作已答复"）：${JSON.stringify(record.clarification)}`);
    // ② 那条文本也**不得**被当成"上一轮实际发送的文本"保存下来
    ctx.assert(!String(record.lastPromptText ?? '').includes('这条答案发不出去'),
      `没写出去的文本不得进 lastPromptText：${String(record.lastPromptText ?? '').slice(-120)}`);
    // ③ 必须回到等待澄清（答案没出去，这次澄清仍然悬着）
    ctx.equal(record.status, 'needs_clarification',
      `未提交时必须回到等待澄清；实际 ${record.status} / ${JSON.stringify(record.error ?? {})}`);
    ctx.assert(logs.some(entry => entry.event === 'clarification_reply_not_submitted'),
      '必须留下「未提交」的审计事件');
    // ④ **未提交那一次**不得被当成"已答复"。
    //    注意：现在**派发路径也会记 `prefix_appended`**（它是真实发送，正常）——
    //    所以不能笼统断言"没有 prefix_appended"，那会误报。
    //    真正要守的性质是：这次回复留下"未提交"的审计事件（已被上面那条覆盖），
    //    且答案没有进历史（第①条覆盖）。
  } finally {
    await broken.shutdown().catch(() => {});
    broken.store.unlock();
  }
  void readFileSync;
});


suite.test('同会话键的另一个任务不得借用前一个任务的台账（AB2）', async ctx => {
  // 复核 AB2 的判定依据：内存台账只按 `sessionKey` 索引、**没有任务身份**。
  // 实测：任务 A 的两次文本保存失败之后，**正常派发**同键任务 B
  // （同工作区、同阶段、同能力集），B 的回复竟然**含 A 的目标、不含 B 的目标**。
  //
  // 现场还原：A 的保存失败 → 同键派发 B → 回复 B → 检查线上文本里是哪个目标。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-ab2-');
  const agentState = join(root, 'agent-state.json');
  const store = new Store(join(root, 'state')).init().lock();
  const logs = [];
  // 两个任务用**同一个** fake 状态文件：这样 promptTexts 是连续的、可逐条核对
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: entry => logs.push(entry),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'clarify', FAKE_STATE: agentState }),
      dshHome: join(root, 'dsh-home'),
    },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });

  const y7 = () => 'ONLY_B_OBJECTIVE';
  const taskA = contract({
    id: 'ab2-a', workspace: root, permissions: { writePaths: [root] },
    objective: 'ONLY_A_OBJECTIVE',
  });
  const taskB = contract({
    id: 'ab2-b', workspace: root, permissions: { writePaths: [root] },
    objective: y7(),
  });

  // 让 A 的文本保存失败（之后关闭注入）
  const realWrite = store.write.bind(store);
  let injecting = true;
  store.write = (record, options) => {
    if (injecting && record?.lastPromptText !== undefined) {
      const error = new Error('injected write failure');
      error.code = 'EIO';
      throw error;
    }
    return realWrite(record, options);
  };

  try {
    // ① 任务 A：派发 → 回复，且**两次文本都保存失败**
    await bridge.delegate(taskA, { wait: true });
    await bridge.reply('ab2-a', 'ONLY_A_ANSWER');
    let deadline = Date.now() + 3000;
    while (bridge.status('ab2-a').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    injecting = false;
    store.write = realWrite;

    // ② 同键派发任务 B（前置条件：两者 sessionKey 必须相同）
    await bridge.delegate(taskB, { wait: true });
    const keyA = store.read('ab2-a').sessionKey;
    const keyB = store.read('ab2-b').sessionKey;
    ctx.equal(keyA, keyB, `前置条件：两个任务必须共用会话键（${keyA} vs ${keyB}）`);

    // ③ 回复 B —— 线上文本里必须是 **B 的目标**，且**不得**含 A 的目标
    //
    // **先记下回复之前的线上条数**（复核 AD2 的判定依据）：
    // 我原来的等待循环**超时不失败**，而断言只看"最后一条文本里是哪个目标" ——
    // 而 B 的**初次派发**就满足"含 B 目标、不含 A 目标"。
    // 于是把生产 `reply()` 改成"遇到 ab2-b 直接返回公开视图、根本不发"，
    // 这条测试仍然 **1/0 通过**（复核实测）。
    const beforeReply = (JSON.parse(ctx.read(agentState)).promptTexts ?? []).length;
    await bridge.reply('ab2-b', '回答给 B');
    deadline = Date.now() + 3000;
    while (!String(store.read('ab2-b').lastPromptText ?? '').includes('回答给 B')
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const wire = (JSON.parse(ctx.read(agentState)).promptTexts ?? []).map(entry => entry.text);
    // **前置条件：受检的那次回复必须真的发生过**（否则整条测试是空的）
    ctx.assert(wire.length > beforeReply,
      `前置条件：B 的回复必须真的发送出去（回复前 ${beforeReply} 条，现在 ${wire.length} 条）`);
    ctx.assert(wire[wire.length - 1].includes('回答给 B'),
      `前置条件：最后一条线上文本必须含这次的答案：${wire[wire.length - 1].slice(-120)}`);
    const last = wire[wire.length - 1];
    ctx.assert(last.includes('ONLY_B_OBJECTIVE'),
      `B 的回复必须含 **B 自己**的目标：\n${last.slice(0, 300)}`);
    ctx.assert(!last.includes('ONLY_A_OBJECTIVE'),
      `B 的回复**不得**借用 A 的台账（把 A 的目标当自己的契约）：\n${last.slice(0, 300)}`);

    // **坦白这条测试的覆盖范围**（我实测过）：把"台账不校验归属"的变异放回去，
    // **这条测试不会红** —— 因为真正起作用的是「**每次真实发送都更新台账**」
    // （我这次新增在 `#runPrompt` 的成功点）：B 派发时台账就被刷成 B 自己的文本，
    // 到 B 回复时已经没有 A 的文本可借。
    // 归属校验（`taskId`/`sessionId`/`generation`）是**防御性**的：
    // 它挡的是"某次发送没更新台账"的情形，而不是当前这条路径。
    // 报告如实写这两点，不把这条测试当成归属校验的可区分证据。
    // 反向：A 的目标仍然出现在 A 自己的那几条里（不是"整段都没了"）
    ctx.assert(wire.some(text => text.includes('ONLY_A_OBJECTIVE')),
      'A 的目标应当仍在 A 自己的发送文本里');
  } finally {
    store.write = realWrite;
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('重建 Bridge 后，不完整标记必须先于旧 persisted 文本参与判断（AB1）', async ctx => {
  // 复核 AB1 的判定依据（两个缺陷叠在一起）：
  //   ① 序号从**空内存台账**起算 —— 重建后 seq 又变成 1，而记录里 `lastSubmittedSeq` 也是 1，
  //      于是 `persistedSeq >= seq - 1` 立刻成立；
  //   ② `incompletePromptHistory` 被放在 persisted 分支**之后**检查，形同虚设 ——
  //      记录明写着"历史不完整"，`lastPromptText` 仍被当成"上一轮实际发送的文本"。
  // 复核实测：故障后记录明确 `incompletePromptHistory=true / lastSubmittedSeq=1`，
  // 重建 Bridge 再回复 → 第三份**不以上一份为前缀、第二份已发送的答案消失**，
  // 而日志仍记 `prefix_appended / baseSource:persisted / replySeq:1`。
  //
  // 另外复核指出：原测试的持久性证据不足 —— 把唯一的 `incompletePromptHistory:true`
  // 改成 false，原目标测试仍 1/0。**所以这条测试在故障当下直接读磁盘**，
  // 不用日志代替持久事实。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { readFileSync } = await import('node:fs');
  const root = ctx.tempDir('bridge-ab1-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');
  const logs = [];

  const makeBridge = () => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: entry => logs.push(entry),
      worker: {
        ...testWorker({ FAKE_SCENARIO: 'clarify', FAKE_STATE: agentState }),
        dshHome: join(root, 'dsh-home'),
      },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  const task = contract({ id: 'ab1-1', workspace: root, permissions: { writePaths: [root] } });

  // ① 第一个桥：第一份答复**成功**保存（产生可信的持久文本）
  const first = makeBridge();
  try {
    await first.delegate(task, { wait: true });
    await first.reply('ab1-1', '第一份答复');
    let deadline = Date.now() + 3000;
    while (first.status('ab1-1').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const afterFirst = first.store.read('ab1-1');
    ctx.equal(afterFirst.incompletePromptHistory, false, '前置条件：第一份成功时不完整标记应为 false');
    ctx.assert(Number.isSafeInteger(afterFirst.lastSubmittedSeq) && afterFirst.lastSubmittedSeq >= 1,
      `前置条件：第一份应当落下一个提交序号：${afterFirst.lastSubmittedSeq}`);
    ctx.assert(String(afterFirst.lastPromptText ?? '').includes('第一份答复'),
      '前置条件：第一份的文本应当落盘');
  } finally {
    await first.shutdown().catch(() => {});
    first.store.unlock();
  }

  // ② 第二个桥：**让第二份的文本保存持续失败**（准备写入与结算后确认写入都失败）
  const second = makeBridge();
  const realWrite = second.store.write.bind(second.store);
  second.store.write = (record, options) => {
    if (record?.lastPromptText !== undefined) {
      const current = second.store.read(record.id ?? '');
      if (current?.lastPromptText !== record.lastPromptText) {
        const error = new Error('injected write failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return realWrite(record, options);
  };
  try {
    await second.reply('ab1-1', '第二份答复');
    let deadline = Date.now() + 3000;
    while (second.status('ab1-1').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // **故障当下读磁盘**（不用日志代替持久事实）—— 复核 AB1 的要求
    const atFailure = second.store.read('ab1-1');
    ctx.equal(atFailure.incompletePromptHistory, true,
      `文本保存失败的那一刻，磁盘上必须写明历史不完整：${JSON.stringify({
        incompletePromptHistory: atFailure.incompletePromptHistory,
        lastSubmittedSeq: atFailure.lastSubmittedSeq,
      })}`);
    ctx.assert(String(atFailure.lastPromptText ?? '').includes('第一份答复'),
      '此时记录里的 lastPromptText 仍是**更早那一轮**的文本（这正是危险的旧 base）');
  } finally {
    second.store.write = realWrite;
    await second.shutdown().catch(() => {});
    second.store.unlock();
  }

  // ③ **重建** Bridge 再回复：不得把那份旧文本当成可信 base
  const third = makeBridge();
  try {
    // **记录日志游标**（复核 AD5 的判定依据）：
    // 我原来用 `entry.replySeq === 1` 过滤，而这一刻的实际序号已经是 3 ——
    // 于是过滤结果**恒为空**，那条断言**恒真**（空洞）。
    // 复核实测：把缓冲分支正确的 `baseSource: 'persisted-log'` 故意写坏成 `'persisted'`，
    // 实际文本仍完整，原目标又 **1/0**。
    //
    // 现在只检查**本轮新增**的日志，不写死序号。
    const logCursor = logs.length;
    await third.reply('ab1-1', '第三份答复');
    const deadline = Date.now() + 3000;
    while (third.status('ab1-1').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // **"已发送答案不丢"现在成立了**（复核 AB1 的后半，由**持久发送缓冲**实现）：
    // 重建之后内存台账为空，但 `Store.appendPromptText` 落盘的日志还在 ——
    // `base` 从那里取到**上一轮确实发送过的文本**（`baseSource === 'persisted-log'`），
    // 于是第二份已发送的答案**留在**第三份里。
    const wire = (JSON.parse(readFileSync(agentState, 'utf8')).promptTexts ?? []).map(e => e.text);
    const lastWire = wire[wire.length - 1];
    ctx.assert(lastWire.includes('第二份答复'),
      `重建之后第三份仍必须含**上一轮实际发送**的答案（持久缓冲的作用）：\n${lastWire.slice(-300)}`);
    ctx.assert(lastWire.includes('第一份答复'),
      '更早那一份已发送的答案同样不得丢');

    // **本轮新增日志里的来源必须正确**（复核 AD5 的建议）：
    //   · 必须有一条 `prefix_appended` 且 `baseSource === 'persisted-log'`（它确实用了缓冲）；
    //   · **不得**有 `baseSource === 'persisted'`（那份旧文本不是可信 base）。
    const thisRound = logs.slice(logCursor).filter(entry => entry.id === 'ab1-1');
    ctx.assert(thisRound.some(entry => entry.event === 'prefix_appended'
      && entry.baseSource === 'persisted-log'),
      `本轮必须记下"来源是持久缓冲"：${JSON.stringify(thisRound.map(e => [e.event, e.baseSource]))}`);
    ctx.assert(!thisRound.some(entry => entry.event === 'prefix_appended'
      && entry.baseSource === 'persisted'),
      `不得把来源误报成 persisted（那是空洞断言放过的那种变异）：`
      + `${JSON.stringify(thisRound.map(e => [e.event, e.baseSource]))}`);

    // 恢复之后标记应当被清掉（成功保存会清它）
    const recovered = third.store.read('ab1-1');
    ctx.equal(recovered.incompletePromptHistory, false,
      '成功落盘之后不完整标记应当被清掉');
  } finally {
    await third.shutdown().catch(() => {});
    third.store.unlock();
  }
});

suite.test('准备阶段不得落盘「拟发送文本」，未确认提交不得标 submitted（AB3）', async ctx => {
  // 复核 AB3 的判定依据：`#runPrompt` 在 catch 里落盘失败/未知之后**照样 resolve**，
  // 外部 `.then(view)` 由 "Promise fulfilled" 推出"已提交"。而且**准备阶段**就写了
  // `lastPromptText` —— 复核实测（真实 stdin.write 注入同步 EPIPE）：
  //   fake 只收到 1 条首次 prompt；任务记 `failed / receipt:no_prompt / 本次没有执行过`；
  //   而同一记录的回答是 `submitted:true`、`lastPromptText` 是一条**从未发出**的文本。
  //
  // 这条测试用**会话无法确保**（worker 起不来）来走同一条"请求没出去"的路径，
  // 断言准备阶段**不**留下未发送的文本（这是 `#runPrompt` 那条真实路径的前置条件）。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-ab3-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');

  const makeBridge = extra => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: () => {},
      worker: {
        ...testWorker({ FAKE_SCENARIO: 'clarify_once', FAKE_STATE: agentState }),
        ...extra,
        dshHome: join(root, 'dsh-home'),
      },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  const task = contract({ id: 'ab3-1', workspace: root, permissions: { writePaths: [root] } });
  const first = makeBridge({});
  await first.delegate(task, { wait: true });
  ctx.equal(first.status('ab3-1').status, 'needs_clarification', '前置条件：worker 要求澄清');
  const dispatchText = String(first.store.read('ab3-1').lastPromptText ?? '');
  ctx.assert(dispatchText.length > 0, '派发那一次的文本应当落盘（它是"上一轮实际发送的文本"）');
  await first.shutdown();
  first.store.unlock();

  // 用一个**连不上**的桥回复：请求根本发不出去
  const broken = makeBridge({ command: '/nonexistent/dsh-binary-for-ab3' });
  try {
    await broken.reply('ab3-1', '这条答案发不出去');
    const deadline = Date.now() + 5000;
    while (broken.store.read('ab3-1').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const rec = broken.store.read('ab3-1');
    // **核心**：准备阶段不得把这条**没发出去**的文本写成 lastPromptText
    ctx.assert(!String(rec.lastPromptText ?? '').includes('这条答案发不出去'),
      `未确认提交的文本不得落盘为 lastPromptText：${String(rec.lastPromptText ?? '').slice(-120)}`);
    // 也不得标成已提交
    ctx.assert(!(rec.clarifications ?? []).some(entry => entry.submitted === true),
      `未确认提交时不得标 submitted：${JSON.stringify(rec.clarifications)}`);
    // 派发那次的可信文本应当**原样保留**（不是被覆盖掉）
    ctx.equal(rec.lastPromptText, dispatchText,
      '派发那次的文本是唯一可信的"上一轮实际发送文本"，不得被未发送的文本覆盖');
  } finally {
    await broken.shutdown().catch(() => {});
    broken.store.unlock();
  }
});

suite.test('确证请求没写上线时，必须撤回本轮答案并回到等待澄清（AB3 的另一半）', async ctx => {
  // 复核 AB3 的判定依据：`#runPrompt` 把 `write_failed` / `worker_exit` / `connection_lost`
  // 转成 `failed` 或 `unknown` 的视图之后**正常 resolve** ——
  // 于是 reply 的 `catch` 从不执行，**回退逻辑挂在一个走不到的分支上**。
  // 复核实测（真实 stdin.write 注入同步 EPIPE）：
  //   fatal = `failed / receipt:no_prompt`，但 `clarification.answer` **没有**退回未作答。
  //
  // 这条测试用「会话无法确保」（worker 起不来 → 请求根本发不出去）走同一条路径，
  // 断言**撤回**真的发生（`needs_clarification` + 答案退回 + 留下审计事件）。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const root = ctx.tempDir('bridge-ab3b-');
  const stateRoot = join(root, 'state');
  const agentState = join(root, 'agent-state.json');
  const logs = [];

  const makeBridge = extra => {
    const store = new Store(stateRoot).init();
    store.lock({ allowStale: true });
    return new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: entry => logs.push(entry),
      worker: {
        ...testWorker({ FAKE_SCENARIO: 'clarify_once', FAKE_STATE: agentState }),
        ...extra,
        dshHome: join(root, 'dsh-home'),
      },
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
  };

  const task = contract({ id: 'ab3b-1', workspace: root, permissions: { writePaths: [root] } });
  const first = makeBridge({});
  await first.delegate(task, { wait: true });
  ctx.equal(first.status('ab3b-1').status, 'needs_clarification', '前置条件：worker 要求澄清');
  await first.shutdown();
  first.store.unlock();

  const broken = makeBridge({ command: '/nonexistent/dsh-binary-for-ab3b' });
  try {
    await broken.reply('ab3b-1', '这条答案发不出去');
    const deadline = Date.now() + 5000;
    while (broken.store.read('ab3b-1').status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const rec = broken.store.read('ab3b-1');

    // ① **撤回必须真的发生**：回到等待澄清（不是停在 failed）
    ctx.equal(rec.status, 'needs_clarification',
      `确证没写上线时必须回到等待澄清，实际 ${rec.status} / ${JSON.stringify(rec.error ?? {})}`);
    // ② 答案退回未作答（下一个人可以重新回答）
    ctx.equal(rec.clarification?.answer, null, `答案必须退回未作答：${JSON.stringify(rec.clarification)}`);
    // ③ 那一次不得被算成"已答复"
    ctx.assert(!(rec.clarifications ?? []).some(entry => entry.submitted === true),
      `未写上线的那次不得进历史：${JSON.stringify(rec.clarifications)}`);
    // ④ 审计事件必须留下（可诊断）
    const events = logs.map(entry => entry.event);
    ctx.assert(events.includes('clarification_reply_not_committed') || events.includes('clarification_reply_not_submitted'),
      `必须留下「未被提交」的审计事件：${JSON.stringify(events)}`);
  } finally {
    await broken.shutdown().catch(() => {});
    broken.store.unlock();
  }
});

suite.test('部署配置的 null 与 undefined 必须区分：null 表示不覆盖提供方默认（F4）', async ctx => {
  // 复核 F4 的判定依据：配置宣称 `reasoningEffort: null` 表示**不覆盖提供方默认**，
  // 运行时却用**空值合并**把它换成 `high` —— 于是公开状态与实际语义矛盾。
  //
  // 我实测到的现状（修之前）：传 null、不传、传 'low' **三者都报 "high"**。
  // 根因是两个常量的语义不同（`DEFAULT_REASONING_EFFORT = 'high'` 是"用桥默认"，
  // `PROVIDER_DEFAULT_REASONING = ''` 是"不覆盖"），而 `??` 把 `null` 归到了前者。
  const { AcpClient } = await import('../src/acp-client.mjs');
  const make = (defaults, temp) => {
    const store = new Store(join(temp, 'state')).init().lock();
    const bridge = new Bridge({
      store,
      sessions: SessionMap.fromStore(store.readSessions()),
      log: () => {},
      worker: { ...testWorker({ FAKE_SCENARIO: 'default', FAKE_STATE: join(temp, 'a.json') }), dshHome: join(temp, 'd') },
      defaults,
      createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    });
    return { store, bridge };
  };

  // ① `null` → 明确"不覆盖提供方默认"
  const a = make({ provider: 'p', modelId: 'm', reasoningEffort: null }, ctx.tempDir('f4-null-'));
  ctx.equal(a.bridge.selectionDefaults.reasoningEffort, PROVIDER_DEFAULT_REASONING,
    `null 必须表示「不覆盖提供方默认」，而不是被换成 high`);
  a.store.unlock();

  // ② 不传这一项 → 用桥的默认档位
  const b = make({ provider: 'p', modelId: 'm' }, ctx.tempDir('f4-undef-'));
  ctx.equal(b.bridge.selectionDefaults.reasoningEffort, DEFAULT_REASONING_EFFORT,
    '不传这一项时应当用桥的默认档位');
  b.store.unlock();

  // ③ 明确指定 → 就是那个值
  const c = make({ provider: 'p', modelId: 'm', reasoningEffort: 'low' }, ctx.tempDir('f4-low-'));
  ctx.equal(c.bridge.selectionDefaults.reasoningEffort, 'low', '明确指定的档位必须原样保留');
  c.store.unlock();

  // ④ **三者必须互不相同** —— 这条断言本身就是"空值合并"那个 bug 的反例
  ctx.assert(a.bridge.selectionDefaults.reasoningEffort !== b.bridge.selectionDefaults.reasoningEffort,
    'null 与 undefined 必须给出**不同**的结果（旧写法两者都是 high）');
});
