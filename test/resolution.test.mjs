import { join } from 'node:path';

import { createSuite } from './harness.mjs';
import { Store } from '../src/store.mjs';
import { SessionMap } from '../src/session-map.mjs';
import { Bridge } from '../src/orchestration.mjs';
import { McpServer } from '../src/mcp-server.mjs';
import { canTransition, createRecord, isTerminal, transition } from '../src/state.mjs';
import { contract, testWorker, TEST_PROMPT_TIMEOUT_MS } from './fixtures.mjs';

export const suite = createSuite('unknown 的显式结案（P4）');

/** 造一个停在 unknown 的任务：worker 完全无响应。 */
async function unknownTask(ctx, id) {
  const root = ctx.tempDir('resolve-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'silent' }),
      dshHome: join(root, 'dsh-home'),
      promptTimeoutMs: 300,
    },
    log: () => {},
  });
  const view = await bridge.delegate(contract({ id, workspace: root, permissions: { writePaths: [root] } }), { wait: true });
  ctx.equal(view.status, 'unknown', '前置条件：任务应停在 unknown');
  return { root, store, bridge };
}

suite.test('裁定会连人、理由、时间一起落盘（判据一：能看出是谁、为什么、结论是什么）', async ctx => {
  const { store, bridge } = await unknownTask(ctx, 'r1');
  const before = store.read('r1');
  const result = bridge.resolve('r1', { verdict: 'abandoned', reason: '核对过 workspace，没有新增文件，判定无法补齐观测', actor: 'test-reviewer' });

  ctx.equal(result.status, 'resolved');
  const record = store.read('r1');
  ctx.equal(record.resolution.verdict, 'abandoned');
  ctx.equal(record.resolution.actor, 'test-reviewer');
  ctx.assert(record.resolution.reason.includes('没有新增文件'), '理由要原样保留');
  ctx.assert(record.resolution.at, '必须记时间');
  ctx.equal(record.resolution.replayed, false, '必须写明没有重放');
  ctx.equal(record.resolution.status, 'resolved');
  ctx.equal(record.revision, before.revision + 1, '裁定是一次状态变更');

  // 历史里也要留痕，便于日后只看 history 也能复盘
  const last = record.history.at(-1);
  ctx.equal(last.event, 'resolved');
  ctx.equal(last.verdict, 'abandoned');
  await bridge.shutdown();
  store.unlock();
});

suite.test('裁定不会触发任何自动重放（判据二）', async ctx => {
  const { store, bridge } = await unknownTask(ctx, 'r2');
  const before = store.read('r2');
  bridge.resolve('r2', { verdict: 'keep_failed', reason: '输出为空且无工具调用，按未成功结案' });
  const after = store.read('r2');

  ctx.equal(after.attempts, before.attempts, 'attempts 不得增加 —— 没有重发');
  ctx.equal(after.status, 'resolved');
  ctx.assert(isTerminal('resolved'), 'resolved 必须是终态，不能再自动出边');
  ctx.deepEqual(bridge.inflight, [], '不得留下在途执行');
  await bridge.shutdown();
  store.unlock();
});

suite.test('resolved 没有任何自动出边；unknown 也不再自动出边', ctx => {
  ctx.equal(isTerminal('resolved'), true);
  ctx.equal(canTransition('resolved', 'running'), false, '终态不得自动回到执行');
  ctx.equal(canTransition('unknown', 'running'), false, 'unknown 仍无自动出边');
  ctx.equal(canTransition('unknown', 'resolved'), true, '只允许人工裁定进入 resolved');
  ctx.equal(canTransition('running', 'resolved'), false, '正在跑的任务不能靠裁定了事');
});

suite.test('retry 只把任务放回队列，不代替调用方重发', async ctx => {
  const { store, bridge } = await unknownTask(ctx, 'r3');
  const result = bridge.resolve('r3', { verdict: 'retry', reason: '已核对工作区无副作用，决定重做' });
  ctx.equal(result.status, 'queued', 'retry 的目标状态是 queued');
  ctx.assert(result.note.includes('不自动重放'), `返回里必须写明桥不重放：${result.note}`);
  ctx.equal(store.read('r3').attempts, 1, 'attempts 不得因为裁定而增加');
  await bridge.shutdown();
  store.unlock();
});

suite.test('理由缺失一律拒绝：没有理由的裁定与没有裁定无法区分', async ctx => {
  const { store, bridge } = await unknownTask(ctx, 'r4');
  for (const reason of ['', '   ', null, undefined]) {
    const error = await ctx.rejects(
      (async () => bridge.resolve('r4', { verdict: 'abandoned', reason }))(),
      caught => caught.code === 'reason_required',
    );
    ctx.equal(error.code, 'reason_required');
  }
  ctx.equal(store.read('r4').status, 'unknown', '被拒的裁定不得改动状态');
  await bridge.shutdown();
  store.unlock();
});

suite.test('裁定内容必须来自白名单', async ctx => {
  const { store, bridge } = await unknownTask(ctx, 'r5');
  const error = await ctx.rejects(
    (async () => bridge.resolve('r5', { verdict: '看起来没问题', reason: 'x' }))(),
    caught => caught.code === 'invalid_verdict',
  );
  ctx.assert(error.message.includes('retry'), `错误必须列出合法裁定：${error.message}`);
  await bridge.shutdown();
  store.unlock();
});

suite.test('只对 unknown / cancelling 开放；正在跑的任务要先取消', async ctx => {
  const root = ctx.tempDir('resolve-guard-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: {
      ...testWorker({ FAKE_SCENARIO: 'silent' }),
      dshHome: join(root, 'dsh-home'),
      promptTimeoutMs: TEST_PROMPT_TIMEOUT_MS,
    },
    log: () => {},
  });
  await bridge.delegate(contract({ id: 'r6', workspace: root, permissions: { writePaths: [root] } }), { wait: false });
  const deadline = Date.now() + 3000;
  while (bridge.status('r6').status !== 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  ctx.equal(bridge.status('r6').status, 'running');
  const error = await ctx.rejects(
    (async () => bridge.resolve('r6', { verdict: 'abandoned', reason: 'x' }))(),
    caught => caught.code === 'not_resolvable',
  );
  ctx.assert(error.message.includes('unknown'), `错误要说明什么时候可用：${error.message}`);
  await bridge.cancel('r6', { reason: '测试' });
  await bridge.shutdown();
  store.unlock();
});

suite.test('MCP 表面暴露 dsh_resolve，并把它接进状态摘要的引导里', async ctx => {
  const root = ctx.tempDir('resolve-mcp-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: 'silent' }), dshHome: join(root, 'dsh-home'), promptTimeoutMs: 300 },
    log: () => {},
  });
  const server = new McpServer({ bridge });
  const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const resolve = listed.result.tools.find(tool => tool.name === 'dsh_resolve');
  ctx.assert(resolve, 'dsh_resolve 必须出现在工具表里');
  ctx.deepEqual(resolve.inputSchema.properties.verdict.enum, ['retry', 'keep_failed', 'abandoned', 'keep_completed']);
  ctx.deepEqual(resolve.inputSchema.required, ['id', 'verdict', 'reason']);

  await bridge.delegate(contract({ id: 'r7', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
  const called = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'dsh_resolve', arguments: { id: 'r7', verdict: 'abandoned', reason: '无响应且无产出' } },
  });
  const payload = JSON.parse(called.result.content[0].text);
  ctx.equal(payload.status, 'resolved');
  ctx.equal(payload.resolution.actor, 'caller', 'MCP 侧默认记 caller');
  ctx.equal(payload.resolution.reason, '无响应且无产出');
  await bridge.shutdown();
  store.unlock();
});

suite.test('cancelling 不接受裁定，且错误信息能指导下一步（F9）', async ctx => {
  // 复现（Codex 复核 R 之前的 F9）：resolve 原先宣称接受 unknown 与 cancelling，
  // 但状态机的 cancelling 出边只有 cancelled / unknown，四种裁定全部 illegal_transition。
  // 收窄到 unknown 之后，这里要求：四种裁定都被明确拒绝，而不是抛状态机的内部错误。
  const root = ctx.tempDir('resolve-cancelling-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker(), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });

  // 手工造一个 cancelling 记录（合法路径：queued → dispatching → running → cancelling）
  const c = contract({ id: 'f9-cancelling', workspace: root, permissions: { writePaths: [root] } });
  const at = new Date().toISOString();
  let record = createRecord({ id: 'f9-cancelling', contract: c, at, policy: c.permissions });
  for (const status of ['dispatching', 'running', 'cancelling']) {
    record = transition(record, status, { at, event: { event: 'test_setup' } });
  }
  store.write(record, { expectRevision: record.revision - 1 });
  ctx.equal(store.read('f9-cancelling').status, 'cancelling', '前置条件');

  for (const verdict of ['retry', 'keep_failed', 'abandoned', 'keep_completed']) {
    const error = await ctx.rejects(
      (async () => bridge.resolve('f9-cancelling', { verdict, reason: '试图裁定' }))(),
      caught => caught.code === 'not_resolvable',
    );
    // 关键：拒绝的理由必须是"这个状态不接受裁定"，而不是状态机抛出的 illegal_transition。
    // 前者能指导调用方，后者只是内部不一致的暴露。
    ctx.equal(error.code, 'not_resolvable', `${verdict} 应给出可理解的拒绝`);
    ctx.assert(error.message.includes('cancelling'), `错误应点明是哪个状态：${error.message}`);
    ctx.assert(error.message.includes('等取消结算落定') || error.message.includes('cancelled'),
      `错误应给出下一步：${error.message}`);
  }

  ctx.equal(store.read('f9-cancelling').status, 'cancelling', '被拒的裁定不得改动状态');
  ctx.equal(store.read('f9-cancelling').resolution, undefined, '不得留下半截裁定');
  await bridge.shutdown();
  store.unlock();
});
