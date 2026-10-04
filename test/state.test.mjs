import { createSuite } from './harness.mjs';
import {
  createRecord, transition, canTransition, validateRecord, isTerminal,
  isOccupying, needsReconcile, STATUSES, StateError,
} from '../src/state.mjs';
import { contract } from './fixtures.mjs';

export const suite = createSuite('状态机（纯函数）');

const at = '2026-10-01T00:00:00.000Z';
const record = () => createRecord({ id: 't1', contract: contract(), at, policy: {} });

suite.test('新建记录处于 queued 且带 revision 1', ctx => {
  const created = record();
  ctx.equal(created.status, 'queued');
  ctx.equal(created.revision, 1);
  ctx.deepEqual(validateRecord(created), []);
});

suite.test('合法转换递增 revision 并留下历史', ctx => {
  const dispatched = transition(record(), 'dispatching', { at, event: { event: 'go' } });
  ctx.equal(dispatched.status, 'dispatching');
  ctx.equal(dispatched.revision, 2);
  ctx.equal(dispatched.history.at(-1).event, 'go');
});

suite.test('非法转换被拒绝且不产生记录', ctx => {
  const created = record();
  ctx.equal(canTransition('queued', 'completed'), false);
  const error = (() => {
    try {
      transition(created, 'completed', { at });
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  ctx.assert(error instanceof StateError, '应抛出 StateError');
  ctx.equal(error.code, 'illegal_transition');
});

suite.test('terminal 状态没有出边', ctx => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    ctx.equal(isTerminal(status), true);
    for (const target of STATUSES) {
      ctx.equal(canTransition(status, target), false, `${status} -> ${target} 必须被拒`);
    }
  }
});

suite.test('unknown 只能由人工决定去向，不可自动回到 running', ctx => {
  const unknown = (() => {
    const dispatched = transition(record(), 'dispatching', { at });
    return transition(dispatched, 'unknown', { at, patch: { error: { code: 'prompt_timeout' } } });
  })();
  ctx.equal(canTransition('unknown', 'running'), false, 'unknown 不得静默重放执行');
  ctx.equal(canTransition('unknown', 'queued'), true, '可以人工放回队列重新派发');
  ctx.equal(canTransition('unknown', 'failed'), true, '可以人工结案为 failed');
  ctx.equal(needsReconcile('unknown'), true);
});

suite.test('cancelling 占用会话且只能结算为 cancelled 或 unknown', ctx => {
  ctx.equal(isOccupying('cancelling'), true);
  ctx.equal(canTransition('cancelling', 'cancelled'), true);
  ctx.equal(canTransition('cancelling', 'unknown'), true);
  ctx.equal(canTransition('cancelling', 'running'), false);
});

suite.test('受保护字段不能被 patch 覆盖', ctx => {
  const created = record();
  for (const field of ['id', 'revision', 'status', 'createdAt', 'updatedAt', 'history']) {
    const error = (() => {
      try {
        transition(created, 'dispatching', { at, patch: { [field]: 'x' } });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    ctx.equal(error?.code, 'protected_field', `${field} 必须受保护`);
  }
});

suite.test('记录校验能发现结构性损坏', ctx => {
  const broken = { ...record(), revision: 0 };
  ctx.assert(validateRecord(broken).length > 0, 'revision 0 必须被报出');
  ctx.assert(validateRecord({ ...record(), status: 'wat' }).length > 0);
  ctx.assert(validateRecord({ ...record(), dispatchIds: null }).length > 0);
});

suite.test('history 有上限，不会无限增长', ctx => {
  let current = record();
  current = transition(current, 'dispatching', { at });
  current = transition(current, 'running', { at });
  for (let index = 0; index < 100; index += 1) {
    current = transition(current, 'needs_clarification', { at, event: { event: `q${index}` } });
    current = transition(current, 'running', { at, event: { event: `a${index}` } });
  }
  ctx.assert(current.history.length <= 64, `history 长度应受限，实际 ${current.history.length}`);
});
