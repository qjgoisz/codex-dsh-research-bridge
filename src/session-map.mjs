

import { resolve } from 'node:path';

export function mapKey({ project = 'default', phase, workspace, contextRevision = 0, capabilities = '' }) {
  return [project, phase, resolve(workspace), `r${contextRevision}`, capabilities].join('\u0000');
}

export function describeKey(key) {
  const [project, phase, workspace, contextRevision, capabilities] = key.split('\u0000');
  return { project, phase, workspace, contextRevision, capabilities };
}

export class SessionMap {
  #entries = new Map();

  constructor(entries = []) {
    for (const entry of entries) {
      if (entry && typeof entry.key === 'string') this.#entries.set(entry.key, { ...entry });
    }
  }

  static fromStore(sessionsDoc) {
    return new SessionMap(Array.isArray(sessionsDoc?.entries) ? sessionsDoc.entries : []);
  }

  toJSON() {
    return [...this.#entries.values()].map(entry => ({ ...entry }));
  }

  get size() { return this.#entries.size; }

  get(key) {
    const entry = this.#entries.get(key);
    return entry ? { ...entry } : null;
  }

  put(key, { sessionId, workspace, phase, project, contextRevision, capabilities, route, generation, reason, rotationRecorded = false, now }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('invalid_session_id');
    const previous = this.#entries.get(key);
    const entry = {
      key,
      sessionId,
      workspace: resolve(workspace),
      phase,
      project,
      contextRevision,
      capabilities,

      route: route ?? previous?.route ?? null,
      generation: Number.isSafeInteger(generation) ? generation : (previous?.generation ?? 0),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,

      rotations: previous && !rotationRecorded
        ? [...(previous.rotations ?? []).slice(-8), {
          from: previous.sessionId, at: now, reason: reason ?? 'unspecified',
        }]
        : (previous?.rotations ?? []),
    };
    this.#entries.set(key, entry);
    return { ...entry };
  }

  rotate(key, { reason, failure, now }) {
    const previous = this.#entries.get(key);
    const generation = (previous?.generation ?? 0) + 1;
    if (previous) {
      this.#entries.set(key, {
        ...previous,
        generation,
        updatedAt: now,
        rotations: [...(previous.rotations ?? []).slice(-8), {
          from: previous.sessionId,
          at: now,
          reason: reason ?? 'rotated',
          ...(failure ? { failure } : {}),
        }],
      });
    }
    return generation;
  }

  forget(key) {
    return this.#entries.delete(key);
  }

  list() {
    return [...this.#entries.values()].map(({ key, sessionId, phase, workspace, generation, updatedAt }) => ({
      key: key.replaceAll('\u0000', ' | '),
      sessionId,
      phase,
      workspace,
      generation,
      updatedAt,
    }));
  }
}
