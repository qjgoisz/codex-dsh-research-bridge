import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { contract, FAKE_AGENT } from './fixtures.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition timeout'); await sleep(25); }
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-shared-'));
  const state = join(root, 'state'); mkdirSync(state);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const clients = [];
  t.after(async () => {
    for (const client of clients) if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill('SIGTERM');
    if (existsSync(join(state, 'daemon.json'))) {
      const { pid } = JSON.parse(readFileSync(join(state, 'daemon.json')));
      try { process.kill(pid, 'SIGTERM'); } catch {}
      await until(() => !existsSync(join(state, 'bridge.lock')));
    }
    rmSync(root, { recursive: true, force: true });
  });
  const start = (extra = [], cwd = root) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--state-root', state,
      '--idle-timeout-ms', '500', '--dsh-home', join(root, 'home'),
      '--worker-command', process.execPath, '--worker-arg', FAKE_AGENT,
      '--provider', 'deepseek-official', '--model', 'deepseek-flash',
      '--prompt-timeout-ms', '5000', ...extra], {
      cwd, env: { ...process.env, FAKE_SCENARIO: 'normal', FAKE_STATE: join(root, 'agent.json') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map(); let buffer = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', s => { stderr += s; });
    child.stdout.on('data', s => {
      buffer += s;
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        const waiter = pending.get(message.id); pending.delete(message.id); waiter?.resolve(message);
      }
    });
    const closed = new Promise(resolve => child.once('close', code => {
      for (const waiter of pending.values()) waiter.reject(new Error(`client closed: ${stderr}`));
      pending.clear(); resolve(code);
    }));
    child.stdin.on('error', () => {});
    const client = { child, closed, stderr: () => stderr,
      rpc(id, method, params = {}) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${stderr}`)); }, 12000);
          pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
      },
      async stop() { child.stdin.end(); assert.equal(await closed, 0, stderr); },
    };
    clients.push(client); return client;
  };
  return { root, state, workspace, start };
}
const initialize = c => c.rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
const tool = (c, id, name, args) => c.rpc(id, 'tools/call', { name, arguments: args });
const value = response => JSON.parse(response.result.content[0].text);

test('concurrent clients share one writer, isolated RPC IDs, tasks and reconnects', { timeout: 20000 }, async t => {
  const { root, state, workspace, start } = setup(t);
  const a = start(), b = start([], workspace);
  const inits = await Promise.all([initialize(a), initialize(b)]);
  for (const r of inits) assert.equal(r.result.serverInfo.name, 'codex-dsh-bridge');
  const owner = JSON.parse(readFileSync(join(state, 'bridge.lock'))).pid;
  assert.notEqual(owner, a.child.pid); assert.notEqual(owner, b.child.pid);
  assert.equal(JSON.parse(readFileSync(join(state, 'daemon.json'))).pid, owner);
  const lists = await Promise.all([a.rpc(2, 'tools/list'), b.rpc(2, 'tools/list')]);
  assert.equal(lists[0].result.tools.length, 9); assert.deepEqual(lists[0], lists[1]);
  const submitted = await tool(a, 3, 'dsh_delegate', { ...contract({ id: 'shared-task', workspace }), waitMs: 0 });
  assert.equal(submitted.result.isError, undefined);
  await a.stop(); // Task and the second client's connection survive the first client's EOF.
  assert.deepEqual((await b.rpc(3, 'ping')).result, {});
  let result;
  for (let i = 0; i < 60; i++) {
    result = value(await tool(b, 4 + i, 'dsh_result', { id: 'shared-task' }));
    if (result.status === 'completed') break;
    await sleep(50);
  }
  assert.equal(result.status, 'completed');
  assert.equal(value(await tool(b, 90, 'dsh_delegate', { ...contract({ id: 'shared-task', workspace }), waitMs: 0 })).status, 'completed');
  assert.equal(JSON.parse(readFileSync(join(root, 'agent.json'))).prompts, 1);
  assert.equal(JSON.parse(readFileSync(join(state, 'bridge.lock'))).pid, owner);
  await b.stop();
  const c = start(); await initialize(c);
  assert.equal(JSON.parse(readFileSync(join(state, 'bridge.lock'))).pid, owner);
  assert.equal(value(await tool(c, 2, 'dsh_result', { id: 'shared-task' })).status, 'completed');
  await c.stop();
  await until(() => !existsSync(join(state, 'bridge.lock')));
  assert.equal(existsSync(join(state, 'daemon.json')), false);
});

test('configuration mismatch is explicit and does not disturb the existing client', { timeout: 15000 }, async t => {
  const { state, start } = setup(t);
  const a = start(); await initialize(a);
  const owner = readFileSync(join(state, 'bridge.lock'), 'utf8');
  const b = start(['--reasoning', 'low']);
  assert.notEqual(await b.closed, 0);
  assert.match(b.stderr(), /共享桥配置或代码已变化/);
  assert.deepEqual((await a.rpc(2, 'ping')).result, {});
  assert.equal(readFileSync(join(state, 'bridge.lock'), 'utf8'), owner);
  await a.stop();
  await until(() => !existsSync(join(state, 'bridge.lock')));
});

test('stale writer locks remain untouched and require explicit recovery', { timeout: 15000 }, async t => {
  const { state, start } = setup(t);
  const raw = JSON.stringify({ pid: 999999999, schema: 1, startedAt: '2026-01-01T00:00:00Z' });
  writeFileSync(join(state, 'bridge.lock'), raw);
  const c = start(); assert.notEqual(await c.closed, 0);
  assert.match(c.stderr(), /unlock --stale/);
  assert.equal(readFileSync(join(state, 'bridge.lock'), 'utf8'), raw);
  assert.equal(existsSync(join(state, 'daemon.json')), false);
});

test('unauthenticated local connections cannot call tools or disrupt authenticated clients', { timeout: 15000 }, async t => {
  const { state, start } = setup(t);
  const a = start(); await initialize(a);
  const info = JSON.parse(readFileSync(join(state, 'daemon.json')));
  if (process.platform !== 'win32') assert.equal(statSync(join(state, 'daemon.json')).mode & 0o777, 0o600);
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: info.port });
    socket.on('error', reject); let text = '';
    socket.on('data', s => { text += s; }); socket.on('end', () => resolve(JSON.parse(text)));
    socket.write(`${JSON.stringify({ token: 'invalid', fingerprint: 'invalid', workspace: state })}\n`);
  });
  assert.equal(response.error, 'unauthorized');
  assert.deepEqual((await a.rpc(2, 'ping')).result, {});
  await a.stop();
  await until(() => !existsSync(join(state, 'bridge.lock')));
});

test('host shutdown closes clients without automatic replay or respawn', { timeout: 15000 }, async t => {
  const { state, start } = setup(t);
  const a = start(); await initialize(a);
  const { pid } = JSON.parse(readFileSync(join(state, 'daemon.json')));
  process.kill(pid, 'SIGTERM');
  assert.notEqual(await a.closed, 0);
  assert.match(a.stderr(), /未重发请求/);
  await until(() => !existsSync(join(state, 'bridge.lock')));
  assert.equal(existsSync(join(state, 'daemon.json')), false);
});

test('model discovery preserves each client working directory without model prompts', { timeout: 15000 }, async t => {
  const { root, state, workspace, start } = setup(t);
  const a = start(['--expose-model-choice']);
  const b = start(['--expose-model-choice'], workspace);
  await Promise.all([initialize(a), initialize(b)]);
  for (const c of [a, b]) {
    const response = await tool(c, 2, 'dsh_models', { refresh: true });
    assert.equal(response.result.isError, undefined);
  }
  const agent = JSON.parse(readFileSync(join(root, 'agent.json')));
  assert.deepEqual(new Set(agent.sessions.map(session => realpathSync(session.cwd))), new Set([root, workspace].map(path => realpathSync(path))));
  assert.equal(agent.prompts, 0);
  assert.equal(existsSync(join(state, 'bridge.lock')), true);
  await a.stop(); await b.stop();
});

test('invalid stale endpoint metadata does not prevent starting a new state owner', { timeout: 15000 }, async t => {
  const { state, start } = setup(t);
  writeFileSync(join(state, 'daemon.json'), JSON.stringify({ schema: 1, port: -1, token: 'old' }));
  const a = start(); await initialize(a);
  assert.equal(JSON.parse(readFileSync(join(state, 'daemon.json'))).pid,
    JSON.parse(readFileSync(join(state, 'bridge.lock'))).pid);
  await a.stop();
});
