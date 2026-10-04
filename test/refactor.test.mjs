import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApprovalBroker, createPermissionPolicy } from '../src/permissions.mjs';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/orchestration.mjs';
import { McpServer } from '../src/mcp-server.mjs';
import { contract, testWorker, until } from './fixtures.mjs';
import { validateConfig, mergeFlags } from '../src/config.mjs';
import { parseArgs } from '../src/cli.mjs';
import { validateTaskContract } from '../src/contract.mjs';
const options = [{ optionId: 'yes-opaque', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no-opaque', kind: 'reject_once', name: 'Reject once' }];

test('configuration validates overrides as a whole and preserves provider-default', () => {
  assert.equal(validateConfig({ schema: 1 }).config.schema, 2);
  assert.equal(validateConfig({ reasoningEffort: 'provider-special' }).config.reasoningEffort, 'provider-special');
  assert.equal(validateConfig({ reasoningEffort: null }).config.reasoningEffort, null);
  assert.throws(() => mergeFlags(validateConfig({}).config, { promptTimeoutMs: -1 }));
  assert.throws(() => parseArgs(['serve', '--unknown', 'x']));
  assert.throws(() => parseArgs(['serve', '--state-root', 'a', '--state-root', 'b']));
  assert.deepEqual(parseArgs(['serve', '--worker-arg', '--profile', '--worker-arg', 'acp']).flags['worker-arg'], ['--profile','acp']);
});

test('minimal contracts allow network and research definitions without tool tables', () => {
  const input = { id: 'minimal', objective: 'check units', workspace: resolve('.'), phase: 'numerics', plan: { summary: 'check', steps: ['compare dimensions'] }, acceptance: ['consistent units'], permissions: { network: true }, research: { units: 'SI', inputCommit: 'abc' } };
  assert.equal(validateTaskContract(input).valid, true);
  assert.equal(validateTaskContract({ ...input, id: '../../escape' }).valid, false);
  assert.equal(validateTaskContract({ ...input, allowRecursiveDelegation: true }).valid, false);
});

test('approvals select advertised opaque IDs and never grant persistent permission automatically', async () => {
  const allow = new ApprovalBroker({ mode: 'allow-once' });
  assert.deepEqual(await allow.request({ taskId: 'x', options }), { outcome: 'selected', optionId: 'yes-opaque' });
  assert.deepEqual(await allow.request({ taskId: 'x', options: [{ optionId: 'forever', kind: 'allow_always' }] }), { outcome: 'cancelled' });
  const deny = new ApprovalBroker({ mode: 'deny' });
  assert.deepEqual(await deny.request({ taskId: 'x', options }), { outcome: 'selected', optionId: 'no-opaque' });
});

test('approval decisions reject forged IDs, require reasons, expire and cancel', async () => {
  const broker = new ApprovalBroker({ timeoutMs: 50 });
  const pending = broker.request({ taskId: 'x', options });
  const request = broker.list()[0];
  assert.throws(() => broker.decide({ requestId: request.requestId, optionId: 'forged', reason: 'test' }));
  assert.throws(() => broker.decide({ requestId: request.requestId, optionId: 'yes-opaque', reason: '' }));
  broker.decide({ requestId: request.requestId, optionId: 'yes-opaque', reason: 'explicit test authorization' });
  assert.deepEqual(await pending, { outcome: 'selected', optionId: 'yes-opaque' });
  const timed = broker.request({ taskId: 'x', options });
  assert.deepEqual(await timed, { outcome: 'cancelled' });
  const cancelled = broker.request({ taskId: 'x', options }); broker.cancelTask('x');
  assert.deepEqual(await cancelled, { outcome: 'cancelled' });
});

test('legacy policies correlate tool IDs but never synthesize an option ID', async () => {
  const policy = createPermissionPolicy({ policy: { tools: ['bash'] } });
  policy.observeUpdate({ sessionUpdate: 'tool_call', toolCallId: '1', title: 'bash' });
  assert.deepEqual(await policy.decide({ toolCall: { toolCallId: '1' }, options }), { outcome: 'selected', optionId: 'yes-opaque' });
  assert.deepEqual(await policy.decide({ toolCall: { toolCallId: '1' }, options: [] }), { outcome: 'cancelled' });
});

test('MCP exposes pending approval promptly, records the decision, then delivers the actual artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-审批 空格-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const target = join(workspace, 'result.txt');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({ store, worker: testWorker({ FAKE_SCENARIO: 'permission', FAKE_WRITE: target }), approvalTimeoutMs: 1000 });
  const server = new McpServer({ bridge });
  try {
    const request = contract({ id: 'approval-integration', workspace, permissions: undefined, deliverables: [target] });
    const view = await bridge.delegate(request);
    assert.equal(view.id, request.id);
    const waiting = await bridge.waitForTask(request.id, 1000);
    assert.equal(waiting.settled, false);
    assert.equal(waiting.view.pendingApprovals.length, 1);
    assert.equal(existsSync(target), false);
    const permission = bridge.approvals.list()[0];
    const response = await server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'dsh_approve', arguments: { requestId: permission.requestId, optionId: 'allow-once', reason: 'isolated test explicitly authorizes this file' } } });
    assert.ok(!response.result.isError);
    await until(() => bridge.status(request.id).status === 'completed');
    assert.equal(readFileSync(target, 'utf8'), 'written with permission\n');
    const record = store.read(request.id);
    assert.equal(record.approvals[1].optionId, 'allow-once');
    assert.equal(record.workerSnapshot.protocolVersion, 1);
    assert.ok(record.result.artifacts.entries.some(a => a.path === target));
  } finally { await bridge.shutdown(); store.unlock(); }
});

test('approval persistence failure cannot grant permission', async () => {
  const broker = new ApprovalBroker({ mode: 'allow-once', store: { read: () => ({ id: 'x', revision: 1 }), write: () => { throw new Error('disk full'); } } });
  await assert.rejects(broker.request({ taskId: 'x', options }), /disk full/);
  assert.equal(broker.list().length, 0);
});

import { WorkspaceQueue } from '../src/workspace-queue.mjs';
test('overlapping directories serialize while unrelated work can progress', async () => {
  const queue = new WorkspaceQueue(), events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const root = resolve('queue-test');
  const first = queue.enqueue(root, async () => { events.push('first'); await gate; events.push('first-done'); });
  const nested = queue.enqueue(join(root, 'sub'), async () => { events.push('nested'); });
  const unrelated = queue.enqueue(resolve('other-queue-test'), async () => { events.push('other'); });
  await unrelated;
  assert.deepEqual(events, ['first','other']);
  release(); await Promise.all([first,nested]);
  assert.deepEqual(events, ['first','other','first-done','nested']);
});
