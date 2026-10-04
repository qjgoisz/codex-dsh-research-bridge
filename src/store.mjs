import { createHash } from 'node:crypto';

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { validateRecord, StateError } from './state.mjs';

const LOCK_NAME = 'bridge.lock';
const TASKS_DIR = 'tasks';
const SESSIONS_NAME = 'sessions.json';
const SCHEMA_VERSION = 1;

export class StoreError extends Error {
  constructor(code, message, detail) {
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const readJson = path => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StoreError('read_failed', `无法读取 ${path}`, error.code);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError('corrupt_json', `状态文件已损坏，拒绝静默跳过：${path}`);
  }
};

function writeJsonAtomic(path, value, beforeRename, swap, fs) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (typeof beforeRename === 'function') beforeRename({ tmp, path, payload });

    const operations = fs ?? { renameSync };
    if (swap === undefined || swap === null) {
      operations.renameSync(tmp, path);
    } else {
      swap(tmp, path);
    }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw new StoreError('write_failed', `无法写入 ${path}`, error.code);
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export class Store {
  #root;
  #tasksDir;
  #lockPath;
  #locked = false;

  constructor(root, { beforeRename, swap, fs } = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new StoreError('invalid_root');
    this.#root = root;
    this.#tasksDir = join(root, TASKS_DIR);
    this.#lockPath = join(root, LOCK_NAME);

    this.beforeRename = typeof beforeRename === 'function' ? beforeRename : null;

    this.swap = typeof swap === 'function' ? swap : null;

    this.fs = fs && typeof fs.renameSync === 'function' ? fs : null;

    this.stat = statSync;
  }

  get root() { return this.#root; }
  get lockPath() { return this.#lockPath; }
  taskPath(id) { return join(this.#tasksDir, `${id}.json`); }

  #promptTextPath(key) {

    const name = createHash('sha256').update(String(key)).digest('hex');
    return join(this.#root, 'prompts', `${name}.jsonl`);
  }

  appendPromptText(key, entry) {
    if (!this.#locked) throw new StoreError('not_locked', '写入前必须先获取写锁。');
    if (typeof key !== 'string' || key.length === 0) return null;
    if (typeof entry?.text !== 'string' || entry.text.length === 0) return null;
    const path = this.#promptTextPath(key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    return path;
  }

  #legacyPromptTextPath(key) {
    return join(this.#root, 'prompts', `${encodeURIComponent(String(key))}.jsonl`);
  }

  lastPromptTextFor(key, identity = null) {
    if (typeof key !== 'string' || key.length === 0) return null;
    const candidates = [];

    for (const path of [this.#legacyPromptTextPath(key), this.#promptTextPath(key)]) {
      let raw;
      try { raw = readFileSync(path, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.text === 'string' && parsed.text.length > 0) candidates.push(parsed);
        } catch { /* 坏行跳过 */ }
      }
    }
    if (candidates.length === 0) return null;

    const matches = candidates.filter(parsed => {
      if (identity === null) return true;
      if (parsed.taskId !== identity.taskId) return false;
      if (identity.sessionId !== undefined && parsed.sessionId !== identity.sessionId) return false;
      if (identity.generation !== undefined && parsed.generation !== identity.generation) return false;
      return true;
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    return matches[matches.length - 1];
  }

  legacyPromptTextExists(key) {
    return existsSync(this.#legacyPromptTextPath(key));
  }

  get sessionsPath() { return join(this.#root, SESSIONS_NAME); }

  init() {
    mkdirSync(this.#tasksDir, { recursive: true, mode: 0o700 });
    return this;
  }

  lockStatus() {
    if (!existsSync(this.#lockPath)) return { state: 'free' };
    let doc;
    try {
      doc = JSON.parse(readFileSync(this.#lockPath, 'utf8'));
    } catch {
      return { state: 'corrupt' };
    }
    if (typeof doc?.pid !== 'number') return { state: 'corrupt' };
    return {
      state: pidAlive(doc.pid) ? 'held-live' : 'stale',
      pid: doc.pid,
      startedAt: typeof doc.startedAt === 'string' ? doc.startedAt : undefined,
    };
  }

  lock({ allowStale = false } = {}) {
    const status = this.lockStatus();
    if (status.state === 'held-live') {
      throw new StoreError('lock_held', `状态目录已被活动进程占用（pid ${status.pid}）。`, status);
    }
    if (status.state === 'corrupt' && !allowStale) {
      throw new StoreError('lock_corrupt', '锁文件无法解析；请人工核对后运行 unlock。', status);
    }
    if ((status.state === 'stale' || status.state === 'corrupt') && !allowStale) {
      throw new StoreError(
        'lock_stale',
        `发现残留锁（pid ${status.pid ?? '未知'}，进程已不存在）。确认无人在写后运行 unlock --stale 清理。`,
        status,
      );
    }
    if (existsSync(this.#lockPath) && allowStale) unlinkSync(this.#lockPath);
    try {
      writeFileSync(this.#lockPath, `${JSON.stringify({
        pid: process.pid, startedAt: new Date().toISOString(), schema: SCHEMA_VERSION,
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw new StoreError('lock_failed', '无法获取写锁。', error.code);
    }
    this.#locked = true;
    return this;
  }

  unlock() {
    if (!this.#locked) return;
    try {
      const doc = JSON.parse(readFileSync(this.#lockPath, 'utf8'));
      if (doc?.pid === process.pid) unlinkSync(this.#lockPath);
    } catch { /* lock already gone */ }
    this.#locked = false;
  }

  read(id) {
    const path = this.taskPath(this.#assertId(id));
    if (!existsSync(path)) return null;
    const doc = readJson(path);
    if (doc?.schema !== SCHEMA_VERSION) {
      throw new StoreError('schema_mismatch', `任务文件 schema 不是 ${SCHEMA_VERSION}：${path}`);
    }
    if (doc.id !== id) throw new StoreError('id_mismatch', `任务文件内容与文件名不符：${path}`);

    if (doc.record?.id !== id) {
      throw new StoreError(
        'id_mismatch',
        `任务文件正文的 id（${String(doc.record?.id)}）与文件名（${id}）不符：${path}`,
      );
    }
    const problems = validateRecord(doc.record);
    if (problems.length > 0) {
      throw new StoreError('invalid_record', `任务记录不合法（${path}）：${problems.join('；')}`);
    }
    return doc.record;
  }

  write(record, { expectRevision } = {}) {
    if (!this.#locked) throw new StoreError('not_locked', '写入前必须先获取写锁。');
    const problems = validateRecord(record);
    if (problems.length > 0) {
      throw new StoreError('invalid_record', `拒绝写入不合法记录：${problems.join('；')}`);
    }
    const path = this.taskPath(record.id);

    if (record.id !== this.#assertId(record.id)) {
      throw new StoreError('id_mismatch', `写入的任务 id 非法：${record.id}`);
    }
    if (Number.isSafeInteger(expectRevision) && existsSync(path)) {
      const current = readJson(path);
      if (current?.record?.revision !== expectRevision) {
        throw new StoreError(
          'revision_conflict',
          `revision 冲突：磁盘 ${current?.record?.revision}，期望 ${expectRevision}。`,
        );
      }
    }
    writeJsonAtomic(path, {
      schema: SCHEMA_VERSION,
      id: record.id,
      updatedAt: new Date().toISOString(),
      record,
    }, this.beforeRename, this.swap, this.fs);
    return record;
  }

  list() {
    if (!existsSync(this.#tasksDir)) return [];
    return readdirSync(this.#tasksDir)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .sort();
  }

  readAll() {
    const out = new Map();
    for (const id of this.list()) {
      const record = this.read(id);
      if (record) out.set(id, record);
    }
    return out;
  }

  readSessions() {
    if (!existsSync(this.sessionsPath)) return { schema: SCHEMA_VERSION, entries: [] };
    const doc = readJson(this.sessionsPath);
    if (doc?.schema !== SCHEMA_VERSION || !Array.isArray(doc.entries)) {
      throw new StoreError('schema_mismatch', `会话映射文件不合法：${this.sessionsPath}`);
    }
    return doc;
  }

  writeSessions(entries) {
    if (!this.#locked) throw new StoreError('not_locked', '写入前必须先获取写锁。');
    if (!Array.isArray(entries)) throw new StoreError('invalid_sessions');
    writeJsonAtomic(this.sessionsPath, { schema: SCHEMA_VERSION, updatedAt: new Date().toISOString(), entries });
    return entries;
  }

  inspect() {
    const lock = this.lockStatus();
    const tasks = [];
    for (const id of this.list()) {
      const record = this.read(id);
      if (record) tasks.push({ id: record.id, status: record.status, revision: record.revision });
    }
    return { root: this.#root, lock, tasks, sessions: existsSync(this.sessionsPath) };
  }

  sizeOf(id) {
    const path = this.taskPath(id);
    if (!existsSync(path)) return 0;
    return statSync(path).size;
  }

  #assertId(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new StateError('invalid_id', `任务 id 不合法（只允许字母数字与 . _ -，且不以符号开头）：${String(id)}`);
    }
    return id;
  }
}
