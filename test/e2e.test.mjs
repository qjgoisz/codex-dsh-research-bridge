import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSuite } from './harness.mjs';

/** 进程是否还活着；用于断言收尾真的结束了它，而不是只看了退出码。 */
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
import { contract, FAKE_AGENT } from './fixtures.mjs';

export const suite = createSuite('端到端：CLI serve 作为真正的 MCP server');

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

/**
 * Spawn the bridge exactly as Codex would: a plain stdio MCP server child
 * process. This test deliberately goes through the real process boundary, so it
 * also proves stdout carries nothing but protocol frames.
 */
function startServer(ctx, { scenario = 'normal', extraArgs = [] } = {}) {
  const root = ctx.tempDir('bridge-e2e-');
  const workspace = ctx.tempDir('bridge-e2e-ws-');
  const child = spawn(process.execPath, [
    CLI,
    'serve', '--standalone',
    '--state-root', join(root, 'state'),
    '--dsh-home', join(root, 'dsh-home'),
    // Replace the worker with the fake ACP agent. This is the same public
    // override an operator would use to point the bridge at another install.
    '--worker-command', process.execPath,
    '--worker-arg', FAKE_AGENT,
    // 明确指定 fake 公布的路由，避免测试依赖操作者的部署配置。
    '--provider', 'deepseek-official',
    '--model', 'deepseek-flash',
    '--prompt-timeout-ms', '5000',
    ...extraArgs,
  ], {
    cwd: ctx.tempDir('bridge-e2e-cwd-'),
    env: {
      ...process.env,
      FAKE_SCENARIO: scenario,
      FAKE_STATE: join(root, 'agent-state.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = [];
  const waiters = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else responses.push(message);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  return {
    root,
    workspace,
    child,
    stderr: () => stderr,
    next: (timeoutMs = 8000) => new Promise((resolve, reject) => {
      if (responses.length > 0) {
        resolve(responses.shift());
        return;
      }
      const timer = setTimeout(() => reject(new Error(`等待 MCP 响应超时（stderr: ${stderr.slice(0, 400)}）`)), timeoutMs);
      waiters.push(message => { clearTimeout(timer); resolve(message); });
    }),
    send: message => child.stdin.write(`${JSON.stringify(message)}\n`),
    // 只等自然退出，**不发任何信号**。EOF 路径必须用它验收：
    // 原先那条 EOF 测试在 stdin.end() 之后又调了 stop()，而 stop() 会发 SIGTERM ——
    // 于是"EOF 干净退出"可能是靠信号完成的（复核 A4 的判定依据）。
    waitForExit: (timeoutMs = 8000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(new Error(`等待自然退出超时（stderr: ${stderr.slice(0, 400)}）`));
      }, timeoutMs);
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    }),
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return; }
      child.once('close', code => resolve(code));
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2000).unref();
    }),
  };
}

suite.test('完整往返：initialize → tools/list → delegate → result', async ctx => {
  const server = startServer(ctx);
  try {
    server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-test', version: '1' }, capabilities: {} } });
    const init = await server.next();
    ctx.equal(init.result.protocolVersion, '2025-06-18');
    ctx.equal(init.result.serverInfo.name, 'codex-dsh-bridge');

    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = await server.next();
    ctx.equal(tools.result.tools.length, 9);

    server.send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'dsh_delegate',
        arguments: contract({ id: 'e2e-1', workspace: server.workspace, permissions: { writePaths: [server.workspace] } }),
      },
    });
    const delegated = await server.next();
    const payload = JSON.parse(delegated.result.content[0].text);
    ctx.equal(payload.id, 'e2e-1');
    ctx.assert(['dispatching', 'running', 'completed'].includes(payload.status), `实际 ${payload.status}`);

    // Poll for the settled result through the same channel.
    let result = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      server.send({ jsonrpc: '2.0', id: 100 + attempt, method: 'tools/call', params: { name: 'dsh_result', arguments: { id: 'e2e-1' } } });
      const response = await server.next();
      result = JSON.parse(response.result.content[0].text);
      if (result.status === 'completed' || result.status === 'failed' || result.status === 'unknown') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    ctx.equal(result.status, 'completed', `端到端应完成，实际 ${result.status}（stderr: ${server.stderr().slice(0, 200)}）`);
    ctx.assert(result.text.includes('已完成任务'), '结果必须带上 worker 的正文');
    ctx.assert(!server.stderr().includes('无法'), 'stderr 不应出现启动错误');
  } finally {
    await server.stop();
  }
});

suite.test('stdout 只承载协议流：非协议内容会被立刻判为错误', async ctx => {
  const server = startServer(ctx);
  try {
    server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const init = await server.next();
    ctx.equal(init.jsonrpc, '2.0');
    // A malformed frame must produce a JSON-RPC parse error, not a crash.
    server.child.stdin.write('{ this is not json }\n');
    const error = await server.next();
    ctx.equal(error.error.code, -32700);
    // And the connection must still work afterwards.
    server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const pong = await server.next();
    ctx.deepEqual(pong.result, {});
  } finally {
    await server.stop();
  }
});

suite.test('stdin 关闭时 bridge 与 ACP worker 都自然结束并释放锁（只关 stdin，不发信号）', async ctx => {
  // 判据按复核 A4 + N5 收紧：
  //   A4：**只关 stdin**、等**自然**退出、并检查锁。
  //   N5：必须**真的有一个活跃 ACP worker**。原实现只 initialize，锁里的 pid 是**桥**的 PID，
  //       所以把 `Bridge.shutdown` 的 worker 清理整个删掉也照样通过 —— 那条断言是空洞的。
  //       现在改为：先派发一个任务让 worker 起来，再从 fake 的状态文件独立取得 **worker 的 PID**。
  const server = startServer(ctx, { scenario: 'normal' });
  try {
    server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-test', version: '1' }, capabilities: {} } });
    await server.next();
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const lockPath = join(server.root, 'state', 'bridge.lock');
    const agentState = join(server.root, 'agent-state.json');
    ctx.equal(existsSync(lockPath), true, 'serve 运行期间应当持有锁');
    const bridgePid = JSON.parse(readFileSync(lockPath, 'utf8')).pid;
    ctx.assert(Number.isSafeInteger(bridgePid), `锁里应当记录桥的 pid：${bridgePid}`);

    // 真的派发一个任务：这会拉起一个 ACP worker（fake agent）。
    server.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'dsh_delegate',
        arguments: contract({ id: 'eof-1', workspace: server.workspace, permissions: { writePaths: [server.workspace] } }),
      },
    });
    await server.next();

    // 轮询到结算，确保 worker 真的跑过（并写下了自己的状态）
    for (let attempt = 0; attempt < 50; attempt += 1) {
      server.send({ jsonrpc: '2.0', id: 100 + attempt, method: 'tools/call', params: { name: 'dsh_result', arguments: { id: 'eof-1' } } });
      const response = await server.next();
      const payload = JSON.parse(response.result.content[0].text);
      if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'unknown') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // **独立取得 worker 的 PID**：来自 fake 自己写的状态文件，而不是桥的锁文件。
    ctx.assert(existsSync(agentState), 'fake agent 应当写下了状态文件（含它自己的 pid）');
    const agentPid = JSON.parse(readFileSync(agentState, 'utf8')).pid;
    ctx.assert(Number.isSafeInteger(agentPid), `状态文件里应当有 worker 的 pid：${agentPid}`);
    ctx.assert(agentPid !== bridgePid, `worker 的 pid(${agentPid}) 必须不同于桥的 pid(${bridgePid})`);

    // 只关 stdin，不发任何信号；等自然退出。
    server.child.stdin.end();
    const code = await server.waitForExit();

    ctx.equal(code, 0, `EOF 后的自然退出应当返回 0，实际 ${code}`);
    ctx.equal(existsSync(lockPath), false, 'EOF 收尾必须释放锁（否则下次启动会因残留锁被拒）');

    // 给 worker 一点时间落地退出，然后**独立断言它真的结束了**。
    const deadline = Date.now() + 3000;
    while (isProcessAlive(agentPid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    ctx.equal(isProcessAlive(agentPid), false,
      `ACP worker 必须被收尾（pid ${agentPid} 仍存活）—— 这正是 N5 指出的覆盖缺口`);
    ctx.equal(isProcessAlive(bridgePid), false, `bridge 进程必须真的退出（pid ${bridgePid} 仍存活）`);
  } finally {
    // 失败路径也必须把 serve 进程清掉，否则会留下游离进程（复核建议 C5 的推广做法）。
    if (isProcessAlive(server.child.pid)) {
      try { server.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
});

suite.test('preflight 在缺少 acp profile 时以非零退出并说明下一步', async ctx => {
  const stateRoot = ctx.tempDir('bridge-e2e-state-');
  const dshHome = ctx.tempDir('bridge-e2e-dsh-');
  const child = spawn(process.execPath, [
    CLI, 'preflight', '--state-root', stateRoot, '--dsh-home', dshHome,
  ], { cwd: stateRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  ctx.equal(code, 1, '环境不就绪必须以非零退出');
  const report = JSON.parse(out);
  ctx.equal(report.ok, false);
  ctx.assert(report.hints.join(' ').includes('--profile acp'), `必须给出下一步：${out.slice(0, 300)}`);
});

suite.test('inspect 报告状态目录与未结算任务，不做修改', async ctx => {
  const stateRoot = ctx.tempDir('bridge-e2e-inspect-');
  const child = spawn(process.execPath, [CLI, 'inspect', '--state-root', stateRoot], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  ctx.equal(code, 0);
  const report = JSON.parse(out);
  ctx.equal(report.tasks.length, 0);
  ctx.deepEqual(report.stranded, []);
});

suite.test('unlock 不会悄悄清理残留锁，必须显式 --stale', async ctx => {
  const stateRoot = ctx.tempDir('bridge-e2e-unlock-');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, 'bridge.lock'), JSON.stringify({ pid: 999_999_999, startedAt: '2026-10-01T00:00:00.000Z', schema: 1 }));

  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'unlock', '--state-root', stateRoot, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.once('close', code => resolve({ code, out }));
  });

  const refused = await run([]);
  ctx.equal(refused.code, 1, '默认必须拒绝清理残留锁');
  ctx.equal(ctx.exists(join(stateRoot, 'bridge.lock')), true, '锁文件必须还在');

  const forced = await run(['--stale']);
  ctx.equal(forced.code, 0);
  ctx.equal(ctx.exists(join(stateRoot, 'bridge.lock')), false, '显式授权后才清理');
});

suite.test('--help 输出说明且不启动任何 worker', async ctx => {
  const child = spawn(process.execPath, [CLI, '--help'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  ctx.equal(code, 0);
  ctx.assert(out.includes('serve'), '必须说明 serve');
  ctx.assert(out.includes('--state-root'), '必须说明状态目录选项');
  ctx.assert(!/sudo/.test(out), '说明里不得出现提权示例');
});
