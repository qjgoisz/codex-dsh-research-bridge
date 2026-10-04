import { join } from 'node:path';

import { createSuite } from './harness.mjs';
import { Store } from '../src/store.mjs';
import { SessionMap } from '../src/session-map.mjs';
import { Bridge } from '../src/orchestration.mjs';
import { McpServer, TOOLS, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp-server.mjs';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from '../src/models.mjs';
import { contract, testWorker, TEST_PROMPT_TIMEOUT_MS } from './fixtures.mjs';

export const suite = createSuite('MCP 表面（stdio JSON-RPC）');

function makeServer(ctx, { scenario = 'normal', env = {} } = {}) {
  const root = ctx.tempDir('bridge-mcp-');
  // A real workspace: the bridge refuses to dispatch into a path that does not
  // exist (otherwise the worker dies with a bare ENOENT), so tests that are about
  // status semantics must not accidentally be tests about a missing directory.
  const workspace = ctx.tempDir('bridge-mcp-ws-');
  const store = new Store(root).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: {
      ...testWorker({ FAKE_SCENARIO: scenario, ...env }),
      dshHome: join(root, 'dsh-home'),
      promptTimeoutMs: scenario === 'silent' ? 300 : TEST_PROMPT_TIMEOUT_MS,
    },
    log: () => {},
  });
  return { store, bridge, root, workspace, server: new McpServer({ bridge }) };
}

const call = async (server, name, args) => {
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
  return JSON.parse(response.result.content[0].text);
};

suite.test('tools/list 默认暴露七个工具（开启后多一个 dsh_models，另测）且都不授予权限', async ctx => {
  const { server, bridge, store, workspace } = makeServer(ctx);
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = response.result.tools.map(tool => tool.name);
  // `dsh_retry` 是 F10 补上的显式重放入口：`dsh_resolve` 的 retry 只把任务放回队列，
  // 在那之前**没有任何执行入口**（同 id 再 delegate 只返回 queued 记录）。
  ctx.deepEqual(names, ['dsh_delegate', 'dsh_status', 'dsh_result', 'dsh_reply', 'dsh_resolve', 'dsh_retry', 'dsh_cancel', 'dsh_approvals', 'dsh_approve']);
  ctx.equal(TOOLS.length, 9);

  // No tool may accept a credential, and none may open recursive delegation.
  for (const tool of TOOLS) {
    const text = JSON.stringify(tool);
    ctx.assert(!/apiKey|api_key|token|password|secret/i.test(text), `${tool.name} 不得携带凭据字段`);
  }
  ctx.assert(TOOLS.every(tool => tool.name.startsWith('dsh_')), '工具命名必须统一前缀');
  const delegate = TOOLS.find(tool => tool.name === 'dsh_delegate');
  ctx.assert(delegate, 'dsh_delegate 必须存在');
  ctx.equal(delegate.inputSchema.additionalProperties, false, 'delegate 不得接受未声明字段');
  ctx.equal(delegate.inputSchema.properties.network, undefined, 'network 不是顶层字段');
  ctx.equal(delegate.inputSchema.properties.permissions.properties.network.type, 'boolean');
  ctx.assert(
    !delegate.inputSchema.required.includes('permissions') && delegate.inputSchema.required.includes('acceptance'),
    '任务应要求验收且不要求旧权限表',
  );
  await bridge.shutdown();
  store.unlock();
});

suite.test('initialize 协商版本并给出可执行的使用说明', async ctx => {
  const { server } = makeServer(ctx);
  for (const requested of SUPPORTED_PROTOCOL_VERSIONS) {
    const response = await server.handle({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested },
    });
    ctx.equal(response.result.protocolVersion, requested);
    ctx.assert(response.result.instructions.includes('dsh_delegate'), '说明必须提到 delegate');
    ctx.assert(response.result.instructions.includes('unknown'), '说明必须解释 unknown 的含义');
  }
  const older = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  ctx.equal(older.result.protocolVersion, '2024-11-05', '未知版本回落到已支持的最低版本');
});

suite.test('notifications 不产生响应，未知方法返回 JSON-RPC 错误', async ctx => {
  const { server } = makeServer(ctx);
  ctx.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const unknown = await server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  ctx.equal(unknown.error.code, -32601);
  const malformed = await server.handle({ id: 6, method: 'tools/list' });
  ctx.equal(malformed.error.code, -32600);
});

suite.test('dsh_delegate 立即返回任务 id，不等模型', async ctx => {
  const { server, bridge, store, workspace } = makeServer(ctx);
  const payload = await call(server, 'dsh_delegate', contract({
    id: 'm1', workspace, permissions: { writePaths: [workspace] },
  }));
  ctx.equal(payload.id, 'm1');
  ctx.assert(['dispatching', 'running', 'completed'].includes(payload.status), `实际 ${payload.status}`);
  ctx.assert(typeof payload.next === 'string', '必须告诉调用方下一步做什么');
  await bridge.shutdown();
  store.unlock();
});

suite.test('契约不合法时返回 isError 结果而不是协议错误', async ctx => {
  const { server, bridge, store } = makeServer(ctx);
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'dsh_delegate', arguments: { id: 'bad', objective: '', phase: 'nope' } },
  });
  ctx.equal(response.error, undefined, '工具级失败不应变成 JSON-RPC 错误');
  ctx.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  ctx.equal(payload.code, 'invalid_contract');
  ctx.assert(Array.isArray(payload.details) && payload.details.length > 0, '必须给出逐字段原因');
  await bridge.shutdown();
  store.unlock();
});

suite.test('dsh_status：单任务查询、全量列出，并把需要关注的任务单列', async ctx => {
  const { server, bridge, store, root, workspace } = makeServer(ctx, { scenario: 'silent' });

  // A worker that never answers fails during session preparation, i.e. before any
  // prompt is submitted: nothing can have happened, so this settles as `failed`.
  // (It is the one case where the bridge can honestly avoid "outcome unknown".)
  const delegate = await call(server, 'dsh_delegate', contract({
    id: 'm2', workspace, permissions: { writePaths: [workspace] },
  }));
  ctx.equal(delegate.id, 'm2');
  const deadline = Date.now() + 8000;
  let single = await call(server, 'dsh_status', { id: 'm2' });
  while (Date.now() < deadline && !['failed', 'unknown', 'completed'].includes(single.status)) {
    await new Promise(resolve => setTimeout(resolve, 20));
    single = await call(server, 'dsh_status', { id: 'm2' });
  }
  // The session came up and the prompt WAS submitted, then the worker went quiet:
  // that is precisely "outcome unknown", not a failed dispatch.
  ctx.equal(single.status, 'unknown', `实际 ${single.status}`);
  ctx.equal(single.error.code, 'prompt_timeout');

  // A task whose prompt WAS admitted and then lost track of is `unknown`, and
  // that is exactly what the caller must be warned about. Seed one directly so
  // the needs_attention contract is tested without depending on a race.
  const { createRecord, transition } = await import('../src/state.mjs');
  const seeded = createRecord({ id: 'm-seeded', contract: contract({ id: 'm-seeded', workspace: root }), at: '2026-10-01T00:00:00.000Z', policy: {} });
  store.write(seeded);
  store.write(transition(seeded, 'dispatching', { at: '2026-10-01T00:00:01.000Z' }), { expectRevision: 1 });
  store.write(transition(store.read('m-seeded'), 'running', { at: '2026-10-01T00:00:02.000Z', patch: { sessionId: 'sess-seed' } }), { expectRevision: 2 });
  store.write(transition(store.read('m-seeded'), 'unknown', { at: '2026-10-01T00:00:03.000Z', patch: { error: { code: 'connection_lost', message: '断线' } } }), { expectRevision: 3 });

  const all = await call(server, 'dsh_status', {});
  ctx.equal(all.count, 2);
  // Both are unobserved executions, and both must be surfaced — a caller that
  // only sees one of them would retry the other one blindly.
  ctx.deepEqual([...all.needs_attention].map(task => task.id).sort(), ['m-seeded', 'm2'],
    'unknown 任务必须全部出现在需要关注的列表里');
  await bridge.shutdown();
  store.unlock();
});

suite.test('dsh_result 在未结算时返回状态而不阻塞', async ctx => {
  const { server, bridge, store, workspace } = makeServer(ctx, { scenario: 'silent' });
  await call(server, 'dsh_delegate', contract({ id: 'm3', workspace, permissions: { writePaths: [workspace] } }));
  const early = await call(server, 'dsh_result', { id: 'm3' });
  ctx.assert(['dispatching', 'running', 'unknown'].includes(early.status), `实际 ${early.status}`);
  ctx.equal(early.text, '');
  await bridge.shutdown();
  store.unlock();
});

suite.test('dsh_cancel 与 dsh_reply 对非法状态给出可读错误', async ctx => {
  const { server, bridge, store } = makeServer(ctx);
  const missing = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsh_cancel', arguments: { id: 'nope' } },
  });
  ctx.equal(missing.result.isError, true);
  ctx.equal(JSON.parse(missing.result.content[0].text).code, 'not_found');

  const reply = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_reply', arguments: { id: 'nope', answer: 'x' } },
  });
  ctx.equal(JSON.parse(reply.result.content[0].text).code, 'not_found');

  const unknownTool = await server.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_anything', arguments: {} },
  });
  ctx.equal(unknownTool.result.isError, true);
  await bridge.shutdown();
  store.unlock();
});

suite.test('模型选择接口的暴露规则：工具与字段同进同出', async ctx => {
  const plain = makeModelAware(ctx, { expose: false });
  const plainTools = await plain.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const plainNames = plainTools.result.tools.map(tool => tool.name);
  ctx.deepEqual(plainNames, ['dsh_delegate', 'dsh_status', 'dsh_result', 'dsh_reply', 'dsh_resolve', 'dsh_retry', 'dsh_cancel', 'dsh_approvals', 'dsh_approve'],
    '默认不暴露 dsh_models（但 dsh_resolve 属于默认表面）');
  const plainDelegate = plainTools.result.tools.find(tool => tool.name === 'dsh_delegate');
  ctx.assert(!('model' in plainDelegate.inputSchema.properties), '默认 schema 里不得出现 model');
  ctx.assert(!('reasoningEffort' in plainDelegate.inputSchema.properties), '默认 schema 里不得出现 reasoningEffort');
  ctx.assert(plainDelegate.description.includes(DEFAULT_MODEL_ID), '默认模型必须写进工具说明，调用方才不会乱猜');
  ctx.assert(plainDelegate.description.includes(DEFAULT_PROVIDER), '默认供应商也必须写进说明');

  const opened = makeModelAware(ctx, { expose: true });
  const openedTools = await opened.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const openedNames = openedTools.result.tools.map(tool => tool.name);
  ctx.assert(openedNames.includes('dsh_models'), '开启后必须出现 dsh_models');
  const openedDelegate = openedTools.result.tools.find(tool => tool.name === 'dsh_delegate');
  ctx.assert('model' in openedDelegate.inputSchema.properties, '开启后 schema 必须允许 model');
  ctx.assert('reasoningEffort' in openedDelegate.inputSchema.properties, '开启后 schema 必须允许 reasoningEffort');

  // 关闭时即使直接调用也不放行：这里不暴露等于不实现，而不是"藏起来"。
  const refused = await plain.server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'dsh_models', arguments: {} },
  });
  ctx.equal(refused.result.isError, true);
  ctx.equal(JSON.parse(refused.result.content[0].text).error, 'model_choice_disabled');

  await plain.bridge.shutdown();
  await opened.bridge.shutdown();
});

suite.test('dsh_models：读目录、命中缓存、不发送提示', async ctx => {
  const { bridge, server, store, workspace } = makeModelAware(ctx, { expose: true });
  const first = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'dsh_models', arguments: { refresh: true } },
  });
  const payload = JSON.parse(first.result.content[0].text);
  ctx.assert(Array.isArray(payload.models) && payload.models.length >= 3, `应列出多个模型：${JSON.stringify(payload)}`);
  ctx.assert(payload.models.some(model => model.value === DEFAULT_MODEL), '必须包含当前默认模型的选择值');
  ctx.assert(payload.models.every(model => typeof model.provider === 'string' && typeof model.modelId === 'string'),
    '每个候选都要同时给出可读的 provider/modelId，调用方不该被逼着读不透明的值');
  ctx.assert(payload.reasoning && payload.reasoning.options.some(option => option.value === ''), '必须包含 provider 默认档');
  ctx.equal(payload.defaults.model, DEFAULT_MODEL_ID);
  ctx.equal(payload.defaults.provider, DEFAULT_PROVIDER);
  void workspace;
  await bridge.shutdown();
  store.unlock();
});

/** Build a bridge (and its MCP server) with model choice explicitly on or off. */
function makeModelAware(ctx, { expose = false } = {}) {
  const root = ctx.tempDir('bridge-mcp-model-');
  const workspace = ctx.tempDir('bridge-mcp-model-ws-');
  const store = new Store(root).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: 'normal' }), dshHome: join(root, 'dsh-home'), promptTimeoutMs: TEST_PROMPT_TIMEOUT_MS },
    exposeModelChoice: expose,
    catalogueRoot: root,
    defaultWorkspace: workspace,
    log: () => {},
  });
  return { root, workspace, store, bridge, server: new McpServer({ bridge }) };
}
