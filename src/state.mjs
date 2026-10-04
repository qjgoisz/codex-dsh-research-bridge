

export const STATUSES = Object.freeze([
  'queued', 'dispatching', 'running', 'needs_clarification',
  'cancelling', 'completed', 'failed', 'cancelled', 'unknown', 'resolved',
]);

export const OCCUPYING = Object.freeze(['dispatching', 'running', 'needs_clarification', 'cancelling']);

export const NEEDS_RECONCILE = Object.freeze(['dispatching', 'running', 'cancelling', 'unknown']);

export const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled', 'unknown', 'resolved']);

export const TRANSITIONS = Object.freeze({
  queued: ['dispatching', 'cancelled'],
  dispatching: ['running', 'unknown', 'failed', 'cancelled'],
  running: ['needs_clarification', 'completed', 'failed', 'cancelling', 'unknown'],
  needs_clarification: ['running', 'cancelled', 'unknown'],
  cancelling: ['cancelled', 'unknown'],
  completed: [],
  failed: [],
  cancelled: [],

  unknown: ['resolved', 'queued', 'completed', 'failed', 'cancelled'],
  resolved: [],
});

export const isTerminal = status => TERMINAL.includes(status);
export const isOccupying = status => OCCUPYING.includes(status);
export const needsReconcile = status => NEEDS_RECONCILE.includes(status);

export function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export class StateError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'StateError';
    this.code = code;
  }
}

export function transition(record, to, { at, patch = {}, event } = {}) {
  if (!record || typeof record !== 'object') throw new StateError('invalid_record');
  if (!nonEmptyString(at)) throw new StateError('invalid_timestamp');
  if (!canTransition(record.status, to)) {
    throw new StateError('illegal_transition', `不允许的状态转换：${record.status} -> ${to}`);
  }
  const forbidden = ['id', 'revision', 'status', 'createdAt', 'updatedAt', 'history', 'contractFingerprint'];
  for (const key of Object.keys(patch)) {
    if (forbidden.includes(key)) throw new StateError('protected_field', `不允许覆盖字段：${key}`);
  }
  const history = Array.isArray(record.history) ? record.history : [];
  return {
    ...record,
    ...patch,
    status: to,
    revision: (Number.isSafeInteger(record.revision) ? record.revision : 0) + 1,
    updatedAt: at,
    history: event === undefined ? history : [...history, { at, to, ...event }].slice(-64),
  };
}

const nonEmptyString = value => typeof value === 'string' && value.length > 0;

export function createRecord({ id, contract, at, policy, contractFingerprint = null }) {
  if (!nonEmptyString(id)) throw new StateError('invalid_id');
  if (!nonEmptyString(at)) throw new StateError('invalid_timestamp');

  if (contractFingerprint !== null && !nonEmptyString(contractFingerprint)) {
    throw new StateError('invalid_fingerprint');
  }
  return {
    id,
    status: 'queued',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    contract,
    contractFingerprint,
    policy,
    sessionId: null,
    sessionGeneration: 0,
    attempts: 0,
    dispatchIds: [],
    clarification: null,
    result: null,
    error: null,
    history: [{ at, to: 'queued', event: 'created' }],
  };
}

export function validateRecord(record) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['record 不是对象'];
  if (!nonEmptyString(record.id)) problems.push('id 缺失');
  if (!STATUSES.includes(record.status)) problems.push(`status 非法：${record.status}`);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) problems.push('revision 非法');
  if (!nonEmptyString(record.createdAt)) problems.push('createdAt 缺失');
  if (!nonEmptyString(record.updatedAt)) problems.push('updatedAt 缺失');
  if (record.sessionId !== null && !nonEmptyString(record.sessionId)) problems.push('sessionId 非空时必须是非空字符串');
  if (!Number.isSafeInteger(record.attempts) || record.attempts < 0) problems.push('attempts 非法');

  if (record.replayCount !== undefined
    && (!Number.isSafeInteger(record.replayCount) || record.replayCount < 0)) {
    problems.push('replayCount 必须是非负整数');
  }
  if (!Array.isArray(record.dispatchIds)) problems.push('dispatchIds 必须是数组');
  if (!Array.isArray(record.history)) problems.push('history 必须是数组');
  if (record.contractFingerprint !== null && record.contractFingerprint !== undefined
    && !nonEmptyString(record.contractFingerprint)) problems.push('contractFingerprint 必须是非空字符串或 null');

  if (record.resolution !== null && record.resolution !== undefined) {
    const r = record.resolution;
    if (typeof r !== 'object' || Array.isArray(r)) problems.push('resolution 必须是对象或 null');
    else {
      if (!nonEmptyString(r.verdict)) problems.push('resolution.verdict 缺失');
      if (!nonEmptyString(r.reason)) problems.push('resolution.reason 缺失');
      if (!nonEmptyString(r.actor)) problems.push('resolution.actor 缺失');
      if (!nonEmptyString(r.at)) problems.push('resolution.at 缺失');

      if (r.replayed !== false && r.replayed !== true) {
        problems.push('resolution.replayed 必须是布尔值');
      }
      if (r.replayed === true) {
        if (!nonEmptyString(r.replayedAt)) problems.push('resolution.replayed 为 true 时必须记录 replayedAt');
        if (!nonEmptyString(r.replayedBy)) problems.push('resolution.replayed 为 true 时必须记录 replayedBy');
        if (!nonEmptyString(r.replayReason)) problems.push('resolution.replayed 为 true 时必须记录 replayReason');
      }
    }
  }
  return problems;
}
