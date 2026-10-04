import { signalWorker, processTarget } from './platform/process.mjs';


import { StringDecoder } from 'node:string_decoder';

import { spawnWorker, terminateWorker } from './transport.mjs';
import { CLIENT_INFO } from './version.mjs';

export const PROTOCOL_VERSION = 1;

export const RPC = Object.freeze({
  methodNotFound: -32601,
  invalidRequest: -32600,
  internalError: -32603,
});

export class AcpError extends Error {
  constructor(code, message, detail) {
    super(message ?? code);
    this.name = 'AcpError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export const UNKNOWN_OUTCOME_CODES = Object.freeze([
  'prompt_timeout', 'connection_lost', 'worker_exit', 'write_failed', 'client_shutdown',

  'output_limit', 'stderr_limit', 'invalid_frame',
]);

export class AcpClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #buffer = '';
  #decoder = new StringDecoder('utf8');
  #bytes = 0;
  #stderrBytes = 0;
  #closed = false;
  #failure = null;

  #closing = false;
  #listeners = new Set();

  #emergencyGraceMs = 250;

  #observeExitError = null;
  #permission = async () => ({ outcome: 'cancelled' });

  #submitted = new Set();
  #frameObserver = null;

  constructor({
    command, args = [], transport = 'direct', cwd, env,
    promptTimeoutMs = 1_800_000,
    requestTimeoutMs = 30_000,
    maxFrameBytes = 8 * 1024 * 1024,
    maxStderrBytes = 1024 * 1024,
    emergencyGraceMs = 250,
    onDisconnect,

    frameObserver = null,
  }) {
    for (const [name, value] of [['promptTimeoutMs', promptTimeoutMs], ['requestTimeoutMs', requestTimeoutMs]]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new AcpError('invalid_limit', `${name} 必须是正整数。`);
    }
    this.promptTimeoutMs = promptTimeoutMs;
    this.#emergencyGraceMs = emergencyGraceMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.maxStderrBytes = maxStderrBytes;
    this.onDisconnect = onDisconnect;

    this.#frameObserver = typeof frameObserver === 'function' ? frameObserver : null;
    this.workerInfo = null;
    this.agentCapabilities = null;
    this.exit = null;

    this.#child = spawnWorker({ command, args, transport, cwd, env });
    this.transport = transport;
    this.#child.stdout.on('data', chunk => this.#onStdout(chunk));
    this.#child.stdout.on('end', () => this.#onEnd());
    this.#child.stdout.on('error', () => this.#fail('connection_lost'));
    this.#child.stdin.on('error', () => this.#fail('write_failed'));
    this.#child.stderr.on('data', chunk => {
      this.#stderrBytes += chunk.length;
      if (this.#stderrBytes > this.maxStderrBytes) this.#fail('stderr_limit');
    });
    this.#child.on('error', error => this.#fail('spawn_error', error.code));
    this.exit = new Promise(resolve => {
      this.#child.once('close', (code, signal) => {
        this.#closed = true;
        this.#fail('worker_exit', `worker 退出：code=${code} signal=${signal}`);
        resolve({ code, signal });
      });
    });
  }

  get pid() { return this.#child.pid ?? null; }

  get childForDiagnostics() { return this.#child; }
  get stderrBytes() { return this.#stderrBytes; }
  get stdoutBytes() { return this.#bytes; }
  get failure() { return this.#failure; }

  onUpdate(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setPermissionPolicy(policy) {
    const isFunction = typeof policy === 'function';
    const isObject = policy !== null && typeof policy === 'object' && typeof policy.decide === 'function';
    this.#permission = isFunction || isObject
      ? policy
      : async () => ({ outcome: 'cancelled' });
  }

  permissionObserver() {
    const policy = this.#permission;
    return policy !== null && typeof policy === 'object' && typeof policy.observeUpdate === 'function'
      ? policy.observeUpdate
      : null;
  }

  async initialize() {
    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (!result || typeof result !== 'object') throw new AcpError('invalid_initialize');
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpError('protocol_mismatch', `worker 协议版本 ${result.protocolVersion}，本桥只支持 ${PROTOCOL_VERSION}。`);
    }
    this.protocolVersion = result.protocolVersion;
    this.workerInfo = result.agentInfo ?? null;
    this.agentCapabilities = result.agentCapabilities ?? null;
    return result;
  }

  authenticate(methodId = 'none') {
    return this.#request('authenticate', { methodId });
  }

  newSession({ cwd, mcpServers = [] }) {
    return this.#request('session/new', { cwd, mcpServers }, this.requestTimeoutMs);
  }

  listSessions({ cwd } = {}) {
    const params = {};
    if (cwd !== undefined) params.cwd = cwd;
    return this.#request('session/list', params, this.requestTimeoutMs);
  }

  resumeSession({ sessionId, cwd, mcpServers = [] }) {
    return this.#request('session/resume', { sessionId, cwd, mcpServers }, this.requestTimeoutMs);
  }

  closeSession(sessionId) {
    return this.#request('session/close', { sessionId }, this.requestTimeoutMs);
  }

  setConfigOption({ sessionId, configId, value }) {
    return this.#request('session/set_config_option', { sessionId, configId, value }, this.requestTimeoutMs);
  }

  prompt({ sessionId, text }) {
    const settled = this.#request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }, this.promptTimeoutMs);

    Object.defineProperty(settled, 'requestId', { value: this.#nextId - 1, enumerable: false });
    return settled;
  }

  cancel(sessionId) {
    this.#notification('session/cancel', { sessionId });
  }

  #request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.#failure) return Promise.reject(new AcpError(this.#failure));
    if (this.#closed) return Promise.reject(new AcpError('client_closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {

      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        const code = method === 'session/prompt' ? 'prompt_timeout' : 'request_timeout';
        pending.reject(new AcpError(code, `${method} 超时（${timeoutMs}ms）。`));
      }, timeoutMs);
      this.#pending.set(id, {

        resolve: value => { this.#submitted.delete(id); resolve(value); },
        reject: error => {
          if (error !== null && typeof error === 'object' && error.submitted === undefined) {
            error.submitted = this.#submitted.has(id);
          }
          this.#submitted.delete(id);
          reject(error);
        },
        timer,
        method,
      });

      const written = this.#write({ jsonrpc: '2.0', id, method, params });
      if (written) this.#submitted.add(id);
    });
  }

  wasSubmitted(requestId) {
    return this.#submitted.has(requestId);
  }

  #notification(method, params) {
    if (this.#failure || this.#closed) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(frame) {
    try {

      try { this.#frameObserver?.('out', frame); } catch { /* 观察者不得影响正事 */ }
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (error) {
      this.#fail('write_failed', error.code);
      return false;
    }
  }

  #onStdout(chunk) {
    this.#bytes += chunk.length;
    if (this.#bytes > this.maxFrameBytes) {
      this.#fail('output_limit');
      return;
    }
    this.#buffer += this.#decoder.write(chunk);
    while (this.#buffer.includes('\n')) {
      const index = this.#buffer.indexOf('\n');
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        this.#fail('invalid_frame', 'worker 输出了非 JSON 内容；协议流被污染。');
        return;
      }

      try { this.#frameObserver?.('in', frame); } catch { /* 观察者不得影响正事 */ }
      try {
        this.#handleFrame(frame);
      } catch (error) {
        this.#fail(error.code ?? 'frame_error', error.message);
        return;
      }
    }
  }

  #handleFrame(frame) {
    if (!frame || frame.jsonrpc !== '2.0') throw new AcpError('invalid_frame');
    if (typeof frame.method === 'string') {
      if (frame.id !== undefined) return this.#handleServerRequest(frame);
      return this.#handleNotification(frame);
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) throw new AcpError('unexpected_response', `收到未知请求 id 的响应：${frame.id}`);
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);

    const hasResult = Object.hasOwn(frame, 'result');
    const hasError = Object.hasOwn(frame, 'error');
    if (hasResult && hasError) {
      pending.reject(new AcpError('invalid_response', '响应同时带 result 与 error（互斥）'));
      return;
    }
    if (hasError) {
      const raw = frame.error;
      const wellFormed = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        && Number.isInteger(raw.code) && typeof raw.message === 'string';
      if (!wellFormed) {
        pending.reject(new AcpError('invalid_response',
          `响应 error 形状非法：${JSON.stringify(raw)}`));
        return;
      }
      const error = new AcpError('rpc_error',
        `${pending.method} 被 worker 拒绝：${raw.message}`, raw.code);

      error.rpc = {
        requestId: frame.id,
        method: pending.method,
        error: { ...raw },
      };
      pending.reject(error);
      return;
    }
    if (!hasResult) {
      pending.reject(new AcpError('invalid_response'));
      return;
    }
    pending.resolve(frame.result);
  }

  #handleNotification(frame) {
    if (frame.method === 'session/update') {
      for (const listener of this.#listeners) {
        try {
          listener(frame.params);
        } catch { /* a listener must not break the transport */ }
      }
      return;
    }

    this.unknownNotifications = (this.unknownNotifications ?? 0) + 1;
  }

  #handleServerRequest(frame) {
    if (frame.method === 'session/request_permission') {

      const policy = this.#permission;
      const decide = typeof policy === 'function' ? policy : params => policy.decide(params);
      Promise.resolve()
        .then(() => decide(frame.params))
        .then(
          outcome => this.#write({ jsonrpc: '2.0', id: frame.id, result: { outcome } }),
          () => this.#write({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } }),
        );
      return;
    }
    this.#write({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: RPC.methodNotFound, message: 'client_method_disabled' },
    });
  }

  #onEnd() {
    if (this.#buffer.length > 0) this.#fail('incomplete_frame');

    if (!this.#failure && !this.#closed) this.#fail('connection_lost');
  }

  #fail(code, detail) {
    if (this.#failure) return;
    this.#failure = code;
    for (const [id, pending] of this.#pending.entries()) {
      clearTimeout(pending.timer);
      const error = new AcpError(code, detail);

      error.submitted = this.#submitted.has(id);
      pending.reject(error);
    }
    this.#pending.clear();

    if (!this.#closing) {
      try {
        this.onDisconnect?.({ code, detail, pid: this.pid });
      } catch { /* diagnostics must not throw */ }
    }
  }

  async emergencyKill() {
    const pid = this.#child?.pid ?? null;
    if (!pid) return { pid: null, signalled: false };
    let signalled = false;
    try {

      signalWorker(this.#child, 'SIGKILL');
      signalled = true;
    } catch (error) {

      if (error.code !== 'ESRCH') throw error;
    }

    const observed = await this.observeExit(pid, this.#emergencyGraceMs);
    return {
      pid,
      signalled,
      terminationObserved: observed,

      ...(observed ? {} : (this.#observeExitError ? { observeError: this.#observeExitError } : {})),

      code: observed ? this.#child.exitCode : null,
      signal: observed ? this.#child.signalCode : null,
    };
  }

  async observeExit(pid, graceMs = this.#emergencyGraceMs) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    const deadline = Date.now() + graceMs;
    for (;;) {
      try {
        process.kill(processTarget(pid), 0); // 信号 0 = 只探测存在性，不投递
      } catch (error) {

        if (error?.code === 'ESRCH') return true;

        this.#observeExitError = { code: error?.code ?? null, message: error?.message ?? String(error) };
        return false;
      }
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async shutdown() {
    this.#closing = true;
    const finish = async () => {
      const result = await terminateWorker(this.#child);
      this.#closed = true;
      this.#fail('client_shutdown');
      return result;
    };
    if (this.#closed) return { code: this.#child.exitCode, signal: this.#child.signalCode, escalated: false, observed: true };

    try {
      await new Promise(resolve => {
        this.#child.stdin.end(() => {
          this.#child.stdin.destroy();
          resolve();
        });
      });
    } catch {
      this.#child.stdin.destroy();
    }
    const closed = new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 200);
      this.#child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    const raced = await closed;
    if (raced !== 'timeout') {
      this.#closed = true;
      this.#fail('client_shutdown');
      return { code: this.#child.exitCode, signal: this.#child.signalCode, escalated: false, observed: true };
    }
    return finish();
  }
}
