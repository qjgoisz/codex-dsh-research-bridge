// Stdio clients share one state-owning process. No model work runs in a proxy.
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer, serveStdio } from './mcp-server.mjs';
import { installShutdownHandlers } from './shutdown.mjs';

const ENDPOINT = 'daemon.json';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function hostFingerprint(options, sourceRoot = import.meta.dirname) {
  const { defaultWorkspace, stateRoot, ...shared } = options;
  const hash = createHash('sha256');
  hash.update(JSON.stringify(canonical({ ...shared, dshHomeEnv: process.env.DSH_HOME ?? null,
    pathEnv: process.env.PATH ?? null, nodeVersion: process.version })));
  // Do not reconnect new source code to a daemon running an older implementation.
  const walk = root => {
    for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(root, e.name));
      else if (e.name.endsWith('.mjs')) hash.update(readFileSync(join(root, e.name)));
    }
  };
  walk(sourceRoot);
  return hash.digest('hex');
}

export function canonicalStateRoot(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

function endpoint(root) {
  try { return JSON.parse(readFileSync(join(root, ENDPOINT), 'utf8')); }
  catch { return null; }
}

// Consume exactly one line, leaving MCP bytes buffered until the caller resumes.
function firstLine(socket) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('shared_bridge_handshake_timeout')), 2000);
    const finish = (error, line, rest) => {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
      socket.pause();
      if (rest?.length) socket.unshift(rest);
      if (error) reject(error); else resolve(line);
    };
    const onError = error => finish(error);
    const onClose = () => finish(new Error('shared_bridge_connection_closed'));
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      const i = data.indexOf(10);
      if (i > 16384) finish(new Error('shared_bridge_invalid_handshake'));
      else if (i >= 0) finish(null, data.subarray(0, i).toString('utf8'), data.subarray(i + 1));
      else if (data.length > 16384) finish(new Error('shared_bridge_invalid_handshake'));
    };
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
    socket.resume();
  });
}

async function connect(root, fingerprint, workspace) {
  const info = endpoint(root);
  if (!info || info.schema !== 1 || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535
    || typeof info.token !== 'string') return null;
  const socket = createConnection({ host: '127.0.0.1', port: info.port });
  socket.on('error', () => {});
  try {
    const response = firstLine(socket);
    socket.write(`${JSON.stringify({ token: info.token, fingerprint, workspace })}\n`);
    const result = JSON.parse(await response);
    if (!result.ok) {
      socket.destroy();
      if (result.error === 'configuration_mismatch') {
        throw new Error('共享桥配置或代码已变化：请关闭使用此状态目录的所有 MCP 客户端，等待后台退出后重连；或使用另一个状态目录。');
      }
      return null;
    }
    return socket;
  } catch (error) {
    socket.destroy();
    if (error.message.startsWith('共享桥配置')) throw error;
    return null;
  }
}

export async function serveSharedClient({ root, fingerprint, workspace, hostArgs, input, output }) {
  let socket = await connect(root, fingerprint, workspace);
  if (!socket) {
    const fd = openSync(join(root, 'daemon.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, hostArgs, {
        cwd: process.cwd(), env: process.env, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', fd],
      });
    } finally { closeSync(fd); }
    let spawnError = null;
    child.on('error', error => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + 10000;
    while (!socket && Date.now() < deadline) {
      if (spawnError) throw spawnError;
      await sleep(50);
      socket = await connect(root, fingerprint, workspace);
      if (!socket && child.exitCode !== null) {
        // A competing client may have won the lock but not published its endpoint yet.
        let lock;
        try { lock = JSON.parse(readFileSync(join(root, 'bridge.lock'), 'utf8')); } catch {}
        let alive = false;
        try { if (lock?.pid) { process.kill(lock.pid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
        if (!alive) break;
      }
    }
    if (!socket) throw new Error('无法连接共享桥后台；检查状态目录中的 daemon.log。旧版 serve 或 CLI 可能仍持有 bridge.lock；不要删除活动锁，残留锁仍需显式 unlock --stale。');
  }
  // A proxy EOF never closes another client's connection or cancels its work.
  await new Promise((resolve, reject) => {
    let ended = false;
    const onEnd = () => { ended = true; socket.end(); };
    const onError = error => { socket.destroy(); reject(error); };
    input.once('end', onEnd); input.once('error', onError); output.once('error', onError);
    socket.once('error', onError);
    socket.once('close', () => {
      input.unpipe(socket); socket.unpipe(output);
      input.off('end', onEnd); input.off('error', onError); output.off('error', onError);
      input.pause();
      if (ended) resolve(); else reject(new Error('共享桥连接中断；未重发请求，请重连后查询任务状态。'));
    });
    input.pipe(socket, { end: false }); socket.pipe(output, { end: false }); socket.resume();
    if (input.readableEnded) onEnd();
  });
  return 0;
}

export async function serveSharedHost({ root, fingerprint, idleMs, open }) {
  const { store, bridge } = open(); // The existing exclusive writer lock is authoritative.
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  let idleTimer;
  let stopping = false;
  let published = false;
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (!sockets.size && !stopping) idleTimer = setTimeout(() => lifecycle.shutdownThenExit('shared_idle'), idleMs);
  };
  const listener = createServer(socket => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket); clearTimeout(idleTimer);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); scheduleIdle(); });
    (async () => {
      const hello = JSON.parse(await firstLine(socket));
      if (hello.token !== token) { socket.end(`${JSON.stringify({ ok: false, error: 'unauthorized' })}\n`, () => socket.destroy()); return; }
      if (hello.fingerprint !== fingerprint) { socket.end(`${JSON.stringify({ ok: false, error: 'configuration_mismatch' })}\n`, () => socket.destroy()); return; }
      if (typeof hello.workspace !== 'string') { socket.destroy(); return; }
      const server = new McpServer({ bridge, workspace: hello.workspace });
      socket.write(`${JSON.stringify({ ok: true })}\n`);
      const done = serveStdio({ input: socket, output: socket, server });
      socket.resume();
      await done;
      socket.end();
    })().catch(() => socket.destroy());
  });
  const sharedBridge = {
    emergencyKillWorkers: () => bridge.emergencyKillWorkers(),
    shutdown: async () => {
      stopping = true; clearTimeout(idleTimer);
      listener.close();
      for (const socket of sockets) socket.destroy();
      try { return await bridge.shutdown(); }
      finally {
        if (published && endpoint(root)?.token === token) unlinkSync(join(root, ENDPOINT));
      }
    },
  };
  const lifecycle = installShutdownHandlers({ bridge: sharedBridge, store,
    log: event => process.stderr.write(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`),
  });
  try {
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const temp = join(root, `daemon.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify({ schema: 1, pid: process.pid, port: listener.address().port, token }), { mode: 0o600 });
    renameSync(temp, join(root, ENDPOINT)); published = true;
    scheduleIdle();
    await new Promise(resolve => listener.once('close', resolve));
    await lifecycle.awaitCleanup('shared_close');
    return 0;
  } catch (error) {
    await lifecycle.awaitCleanup('shared_start_failed');
    throw error;
  } finally { lifecycle.dispose(); }
}
