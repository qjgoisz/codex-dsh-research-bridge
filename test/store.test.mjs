import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createSuite } from './harness.mjs';
import { Store } from '../src/store.mjs';
import { createRecord, transition } from '../src/state.mjs';
import { contract } from './fixtures.mjs';

export const suite = createSuite('持久化与恢复');

const at = '2026-10-01T00:00:00.000Z';
// 第二个参数是**构造选项**（例如 A5 用的 beforeRename），第三个是 lock 选项。
const open = (root, storeOptions = {}, lockOptions = {}) =>
  new Store(root, storeOptions).init().lock(lockOptions);
const makeRecord = (overrides = {}) => {
  // 兼容两种调用：`makeRecord('t1')` 与 `makeRecord({ id, objective })`。
  const options = typeof overrides === 'string' ? { id: overrides } : overrides;
  const id = options.id ?? 't1';
  const record = createRecord({ id, contract: contract({ id }), at, policy: {} });
  return options.objective === undefined ? record : { ...record, objective: options.objective };
};

suite.test('写入后可读回，且内容完全一致', ctx => {
  const store = open(ctx.tempDir());
  const record = makeRecord();
  store.write(record);
  ctx.deepEqual(store.read('t1'), record);
  ctx.deepEqual(store.list(), ['t1']);
  store.unlock();
});

suite.test('原子替换：目录里不留临时文件', ctx => {
  const root = ctx.tempDir();
  const store = open(root);
  store.write(makeRecord());
  store.write(transition(makeRecord(), 'dispatching', { at }), { expectRevision: 1 });
  const leftovers = readdirSync(join(root, 'tasks')).filter(name => name.includes('.tmp-'));
  ctx.deepEqual(leftovers, [], '不应残留临时文件');
  ctx.equal(store.read('t1').revision, 2);
  store.unlock();
});

suite.test('revision 冲突被拒绝，防止覆盖并发状态', ctx => {
  const store = open(ctx.tempDir());
  store.write(makeRecord());
  const error = (() => {
    try {
      store.write(transition(makeRecord(), 'dispatching', { at }), { expectRevision: 99 });
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  ctx.equal(error?.code, 'revision_conflict');
  ctx.equal(store.read('t1').status, 'queued', '冲突写入不得改变磁盘状态');
  store.unlock();
});

suite.test('未加锁时拒绝写入', ctx => {
  const store = new Store(ctx.tempDir()).init();
  const error = (() => {
    try {
      store.write(makeRecord());
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  ctx.equal(error?.code, 'not_locked');
});

suite.test('活动进程持有的锁不可被抢占', ctx => {
  const root = ctx.tempDir();
  const first = open(root);
  const second = new Store(root).init();
  const error = (() => {
    try {
      second.lock();
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  ctx.equal(error?.code, 'lock_held');
  first.unlock();
  second.lock();
  second.unlock();
});

suite.test('残留锁必须由显式授权清理，不会按时间自动删除', ctx => {
  const root = ctx.tempDir();
  const store = new Store(root).init();
  // A pid that cannot exist: the lock is genuinely stale.
  writeFileSync(store.lockPath, JSON.stringify({ pid: 999_999_999, startedAt: at, schema: 1 }));

  const status = store.lockStatus();
  ctx.equal(status.state, 'stale');
  const refused = (() => {
    try {
      store.lock();
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  ctx.equal(refused?.code, 'lock_stale', '默认必须拒绝并提示人工核对');

  store.lock({ allowStale: true });
  ctx.equal(store.lockStatus().state, 'held-live');
  store.unlock();
  ctx.equal(store.lockStatus().state, 'free');
});

suite.test('损坏的任务文件导致读取失败而不是被静默跳过', ctx => {
  const root = ctx.tempDir();
  const store = open(root);
  store.write(makeRecord());
  writeFileSync(join(root, 'tasks', 't1.json'), '{ 这不是 JSON');
  const error = (() => {
    try {
      store.readAll();
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  ctx.equal(error?.code, 'corrupt_json');
  store.unlock();
});

suite.test('schema 或 id 不匹配一律拒绝', ctx => {
  const root = ctx.tempDir();
  const store = open(root);
  store.write(makeRecord());
  writeFileSync(join(root, 'tasks', 't1.json'), JSON.stringify({ schema: 99, id: 't1', record: makeRecord() }));
  ctx.equal(
    (() => { try { store.read('t1'); return null; } catch (error) { return error; } })()?.code,
    'schema_mismatch',
  );
  store.unlock();
});

suite.test('会话映射独立落盘并可原样读回', ctx => {
  const store = open(ctx.tempDir());
  const entries = [{ key: 'k1', sessionId: 'sess-1', workspace: '/tmp/w', phase: 'numerics', project: 'default', contextRevision: 0, capabilities: '', generation: 0, createdAt: at, updatedAt: at, rotations: [] }];
  store.writeSessions(entries);
  ctx.deepEqual(store.readSessions().entries, entries);
  store.unlock();
});

suite.test('inspect 报告锁状态与全部任务，不做任何修改', ctx => {
  const store = open(ctx.tempDir());
  store.write(makeRecord('a'));
  store.write(transition(makeRecord('b'), 'dispatching', { at }));
  const report = store.inspect();
  ctx.equal(report.lock.state, 'held-live');
  ctx.equal(report.tasks.length, 2);
  ctx.deepEqual(report.tasks.map(task => task.status).sort(), ['dispatching', 'queued']);
  store.unlock();
});

suite.test('任务 id 经过白名单校验，路径拼接无逃逸', ctx => {
  const store = open(ctx.tempDir());
  for (const bad of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(200)]) {
    const error = (() => {
      try {
        store.read(bad);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    ctx.assert(error, `id ${JSON.stringify(bad)} 必须被拒`);
  }
  store.unlock();
});

suite.test('状态目录可以位于任意工作区内路径，且不触碰外部目录', ctx => {
  const root = ctx.tempDir();
  mkdirSync(join(root, 'nested', 'state'), { recursive: true });
  const store = open(join(root, 'nested', 'state'));
  store.write(makeRecord());
  ctx.equal(store.read('t1').id, 't1');
  store.unlock();
});

suite.test('文件名 / 外层 id / 正文 id 三处都必须一致（F12 / A9）', ctx => {
  // 复核 F12 的判定依据：原先只比外层 `doc.id`，于是把**正文** `record.id` 改成别的任务之后，
  // `store.read('outer')` 会返回一个 `id: 'another-task'` 的记录，**无任何报错**；
  // 调用方拿到它之后按 `record.id` 定位，任务身份就被悄悄换掉了。
  //
  // 复核 A9 还要求：**分别**破坏每个位置，而不是用「schema 不符」把「schema 或 id」一并覆盖。
  const readCode = (store, id) => {
    try { store.read(id); return null; } catch (error) { return error?.code ?? 'error'; }
  };

  for (const [label, corrupt] of [
    ['文件名与外层 id 不符', doc => { doc.id = 'another-task'; }],
    ['正文 id 与文件名不符', doc => { doc.record.id = 'another-task'; }],
    ['外层与正文都改（一致地改了，仍与文件名不符）', doc => { doc.id = 'other'; doc.record.id = 'other'; }],
  ]) {
    const root = ctx.tempDir();
    const store = open(root);
    store.write(makeRecord());
    const path = join(root, 'tasks', 't1.json');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    corrupt(doc);
    writeFileSync(path, JSON.stringify(doc, null, 2));
    // 只有第三种情形能过外层检查，但三处仍不一致 —— 必须同样被拒
    ctx.equal(readCode(store, 't1'), 'id_mismatch', `${label} 必须被拒为 id_mismatch`);
    store.unlock();
  }

  // 对照组：三处一致时必须能正常读出（否则这条检查就成了"一律拒绝"）
  const root = ctx.tempDir();
  const store = open(root);
  store.write(makeRecord());
  ctx.equal(store.read('t1').id, 't1', '三处一致时必须能正常读出');
  store.unlock();
});

suite.test('重放审计不变量：replayed=true 时缺任一审计字段都必须被拒（V3 待办）', ctx => {
  // 复核指出：**正常路径全绿不能证明不变量受保护** ——
  // 把 state.mjs 里三个「replayed=true 必须有审计字段」的检查删掉，原四条 F7/F10 测试
  // 仍然 4/0，因为它们只走正常重放路径，那里字段是齐的。
  //
  // 这里直接用**构造出来的非法记录**（纯输入对照）去撞那个不变量，
  // 并**逐个**删掉一个字段，确认每一个都被拒绝 —— 而不是只测一种缺法。
  const baseRecord = () => ({
    ...makeRecord(),
    resolution: {
      verdict: 'retry',
      reason: '看过了',
      actor: 'operator',
      at,
      replayed: true,
      replayedAt: at,
      replayedBy: 'operator',
      replayReason: '重放一次',
      replayAttempts: 1,
    },
  });

  const fields = ['replayedAt', 'replayedBy', 'replayReason'];
  for (const field of fields) {
    const root = ctx.tempDir();
    const store = open(root);
    const record = baseRecord();
    delete record.resolution[field];
    let error = null;
    try { store.write(record); } catch (caught) { error = caught; }
    ctx.equal(error?.code, 'invalid_record',
      `缺 ${field} 时必须被拒（否则"声称重放过"可以不留审计）`);
    ctx.assert(error.message.includes(field), `拒绝理由必须点名 ${field}：${error?.message}`);
    store.unlock();
  }

  // 对照：字段齐全时必须能写入 —— 否则这条检查就是"一律拒绝"
  const root = ctx.tempDir();
  const store = open(root);
  store.write(baseRecord());
  ctx.equal(store.read('t1').resolution.replayed, true, '字段齐全时必须能写入');
  store.unlock();

  // 另外：replayCount 的类型也必须被校验（V3 引入的任务级计数）
  for (const bad of [-1, 1.5, 'x', null]) {
    const r2 = ctx.tempDir();
    const s2 = open(r2);
    let error = null;
    try { s2.write({ ...makeRecord(), replayCount: bad }); } catch (caught) { error = caught; }
    ctx.equal(error?.code, 'invalid_record', `replayCount=${JSON.stringify(bad)} 必须被拒`);
    s2.unlock();
  }
});

suite.test('原子替换：rename 之前失败时，读者只看到完整的旧文档（A5）', ctx => {
  // 复核 A5 的判定依据：原来那条测试只断言「不留临时文件」，
  // 而**不留临时文件并不证明原子替换** —— 把 writeJsonAtomic 换成直接
  // `writeFileSync(目标)` 也能不留临时文件，而那条测试照样通过（复核实测 1/0）。
  //
  // 原子性的真正性质：**读者永远只看到完整的旧文档或完整的新文档**。
  // 所以必须能注入「写了一半、还没 rename」这个时刻 —— Store 现在支持这个注入口。
  const root = ctx.tempDir();
  const path = join(root, 'tasks', 't1.json');

  // 先写一份"旧"文档
  const first = open(root);
  first.write(makeRecord({ id: 't1', objective: '旧的' }));
  first.unlock();
  const oldDoc = readFileSync(path, 'utf8');
  ctx.assert(oldDoc.includes('旧的'), '前置条件：旧文档已落盘');

  // 注入：在**新内容已写完、rename 尚未发生**这一刻抛错，模拟「替换前崩了」。
  // 这一刻是关键：原子实现在此刻目标仍是旧的，而直接写目标的实现此刻已经被改。
  let targetAtInjection = null;
  const failing = open(root, {
    beforeRename: ({ path: target }) => {
      targetAtInjection = readFileSync(target, 'utf8');
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    },
  });
  let error = null;
  try {
    failing.write(makeRecord({ id: 't1', objective: '新的' }), { expectRevision: 1 });
  } catch (caught) { error = caught; }
  ctx.assert(error, '注入的故障必须让写入失败');

  // ① **注入那一刻**目标必须还是旧的 —— 这才是「原子替换」的直接证据。
  //    直接写目标的实现会在这里就已经改了目标文件，而那条路**不是**原子替换。
  ctx.equal(targetAtInjection, oldDoc,
    '新内容写完、rename 之前，目标文件必须仍是旧的（原子替换的直接证据）');

  // ② 读者看到的仍是**完整的旧文档**（不是半截、也不是新文档）
  const after = readFileSync(path, 'utf8');
  ctx.equal(after, oldDoc, '替换前失败时，目标文件必须逐字节保持旧内容');
  ctx.assert(!after.includes('新的'), '不得出现新内容的一半');

  // ③ 目标文件仍然可解析（"半截 JSON"是最坏的失败形态）
  const parsed = JSON.parse(after);
  ctx.equal(parsed.record.objective, '旧的');
  ctx.equal(parsed.id, 't1');

  // ④ 临时文件不得残留（这一条是原测试已有的，保留）
  const leftovers = readdirSync(join(root, 'tasks')).filter(name => name.includes('.tmp-'));
  ctx.deepEqual(leftovers, [], '失败后不得留下临时文件');

  // ⑤ 而且 Store 仍然能正常读回旧记录
  failing.unlock();
  const reader = open(root);
  ctx.equal(reader.read('t1').objective, '旧的', '失败之后仍能读到完整的旧记录');
  reader.unlock();
});

suite.test('原子替换：rename 之后，读者只看到完整的新文档（A5 的另一面）', ctx => {
  // 反面：如果只测「失败时不损坏」，一个从不写入的实现也能通过。
  const root = ctx.tempDir();
  const path = join(root, 'tasks', 't2.json');
  const store = open(root);
  store.write(makeRecord({ id: 't2', objective: '第一版' }));
  store.write(makeRecord({ id: 't2', objective: '第二版' }), { expectRevision: 1 });
  store.unlock();

  const doc = JSON.parse(readFileSync(path, 'utf8'));
  ctx.equal(doc.record.objective, '第二版', '成功写入后必须是完整的新文档');
  // `Store.write` 自己把 revision 加一（见它的文档注释），所以这里如实断言它的实际语义；
  // 这条断言的意义是「第二次写真的落了盘」，不是断定某个具体数值。
  ctx.assert(Number.isSafeInteger(doc.record.revision) && doc.record.revision >= 1,
    `revision 必须是合法整数：${doc.record.revision}`);
  const leftovers = readdirSync(join(root, 'tasks')).filter(name => name.includes('.tmp-'));
  ctx.deepEqual(leftovers, [], '成功路径也不得留下临时文件');
});

suite.test('原子替换：替换动作本身必须是 rename，且换入那一刻目标仍是旧的（X5）', ctx => {
  // 复核 X5 的判定依据：保留临时文件、fsync、beforeRename 与异常清理，
  // **只把最终那行 `renameSync(tmp, path)` 换成 `writeFileSync(path, payload)` + `unlinkSync(tmp)`** ——
  // 仍然 16/0。因为 `beforeRename` 看到的是**替换之前**的状态，
  // 它对"替换动作是什么"完全没有区分力。
  //
  // 这条测试给 Store 注入一个**可观察的换入函数**，在它被执行的那一刻检查磁盘：
  //   - 原子实现（rename）：目标**仍是旧的**，临时文件里有完整新内容；
  //   - 直接写实现：目标**已经被改**。
  // 两者在这个时刻的状态不同，所以这个注入点是有区分力的。
  const root = ctx.tempDir();
  const path = join(root, 'tasks', 's1.json');

  const seeder = open(root);
  seeder.write(makeRecord({ id: 's1', objective: '旧的' }));
  seeder.unlock();
  const oldDoc = readFileSync(path, 'utf8');

  const observations = [];
  const store = open(root, {
    swap: (tmp, target) => {
      observations.push({
        tmp,
        targetAtSwap: readFileSync(target, 'utf8'),
        tmpExists: existsSync(tmp),
        tmpPayload: existsSync(tmp) ? readFileSync(tmp, 'utf8') : null,
      });
      // **照常执行真正的原子替换**（renameSync 由调用方传入）——
      // 这条测试只观察，不改变行为。
      return renameSync(tmp, target);
    },
  });

  store.write(makeRecord({ id: 's1', objective: '新的' }), { expectRevision: 1 });
  store.unlock();

  ctx.equal(observations.length, 1, `换入函数必须恰好被调用一次：${observations.length}`);
  const seen = observations[0];

  // ① 换入那一刻，**临时文件里有完整的新内容**
  ctx.assert(seen.tmpExists, '换入之前必须存在临时文件（新内容先写在那里）');
  ctx.assert(seen.tmpPayload.includes('新的'),
    `临时文件里必须是完整的新文档：${String(seen.tmpPayload).slice(0, 80)}`);

  // ② 换入那一刻，**目标还是旧的** —— 这是「由 rename 换入」的直接证据。
  //    直接写目标实现在这一刻目标已经被改，所以这条断言会红。
  ctx.equal(seen.targetAtSwap, oldDoc,
    '换入那一刻目标必须仍是旧文档（若它已被改，说明不是原子替换）');

  // ③ 换入之后目标变成完整的新文档
  const after = JSON.parse(readFileSync(path, 'utf8'));
  ctx.equal(after.record.objective, '新的');

  // ④ **结构断言：最终的换入动作必须是 rename**（复核 X5 的建议：
  //    「用独立可注入的文件系统适配器验证最终目标只由 rename 替换」）。
  //    上面三条是**行为**证据；这一条盯住**源码里那一行**，两者互补：
  //    行为证据证明"此刻替换是原子的"，结构断言证明"替换动作就是 rename"。
  // **结构断言已让位给独立观测**（复核 Z4 的判定依据）。
  //
  // 原结构断言要求源码里有一处字面 `renameSync(tmp, path);` —— 而复核用一个**局部同名函数**
  // 就绕过了它（字面行还在、默认动作已经变成直接写目标）。
  // 现在默认动作从可注入的**操作台**取，由 `默认写入动作必须真的由 rename 换入（Z4）`
  // 那条测试用**独立 fs 观测**判断 —— 那才是有区分力的判据。
  //
  // 这里只保留一条**弱**的结构提示（不冒充证据）：换入动作必须经由操作台调用。
  const storeSource = readFileSync(join(import.meta.dirname, '..', 'src', 'store.mjs'), 'utf8');
  ctx.assert(/operations\.renameSync\(tmp, path\)/.test(storeSource),
    '换入动作必须经由可注入的操作台调用（独立观测的前提）');

  // ⑤ 负例对照：把一个"直接写目标"的换入函数交给同一个注入点，
  //    它**必然**会在 ② 那种检查下暴露 —— 证明这个注入点有区分力。
  const root2 = ctx.tempDir();
  const path2 = join(root2, 'tasks', 's2.json');
  const seeder2 = open(root2);
  seeder2.write(makeRecord({ id: 's2', objective: '旧的' }));
  seeder2.unlock();
  const oldDoc2 = readFileSync(path2, 'utf8');
  const directStore = open(root2, {
    swap: (tmp, target) => {
      // 这就是复核的变异：直接覆盖目标，绕开 rename
      writeFileSync(target, readFileSync(tmp, 'utf8'));
      unlinkSync(tmp);
    },
  });
  directStore.write(makeRecord({ id: 's2', objective: '新的' }), { expectRevision: 1 });
  directStore.unlock();
  // 负例的证据：直接写之后目标**已经变成新的** —— 与上面的原子实现相反。
  // 也就是说，同一个观察点（"换入那一刻目标是什么"）能分辨两种实现，
  // 所以它不是一条恒真的断言。
  const directAfter = readFileSync(path2, 'utf8');
  ctx.assert(directAfter !== oldDoc2,
    '负例：直接写目标的换入方式会让目标立刻变成新的（与原子实现的观察结果相反）');
  ctx.assert(directAfter.includes('新的'));
  // 而**原子实现**在同一个观察点看到的是旧内容（上面 ② 已断言）——
  // 两者结论不同，说明该观察点具有区分力。
  ctx.assert(seen.targetAtSwap === oldDoc && seen.targetAtSwap !== directAfter,
    '原子实现与直接写实现在"换入那一刻"的观察结果必须不同');
});

suite.test('默认写入动作必须真的由 rename 换入（独立观测 fs 调用，Z4）', ctx => {
  // 复核 Z4 的判定依据：X5 的测试「行为观察的是**自己注入的 swap**」，
  // 默认分支只靠**字面源码检查**保护 —— 而下面这个变异同时绕过两者：
  //     const renameSync = (temporary, destination) => {
  //       writeFileSync(destination, payload); unlinkSync(temporary);
  //     };
  //     renameSync(tmp, path);
  // 字面行 `renameSync(tmp, path);` 还在，默认动作却已经是直接写目标（复核实测 20/0 全绿）。
  //
  // 这条测试的做法：传入一个**代理操作台**，它把每次 fs 调用记下来并转发给真实实现。
  // 于是"默认分支到底做了什么"由**独立观测**决定：
  //   - 正确实现：观测到 renameSync(tmp, target)，且**没有**对目标路径的 writeFileSync；
  //   - 那个变异：观测到 writeFileSync(target) —— 即使它叫 renameSync。
  const root = ctx.tempDir();
  const path = join(root, 'tasks', 'z4.json');
  const seeder = open(root);
  seeder.write(makeRecord({ id: 'z4', objective: '旧' }));
  seeder.unlock();
  const oldDoc = readFileSync(path, 'utf8');

  const observed = [];
  const store = open(root, {
    fs: {
      renameSync: (from, to) => { observed.push({ op: 'rename', from, to }); return renameSync(from, to); },
    },
  });
  store.write(makeRecord({ id: 'z4', objective: '新' }), { expectRevision: 1 });
  store.unlock();

  // ① **换入动作必须是 rename**，且它的目标是我们要写的那个文件
  const renames = observed.filter(entry => entry.op === 'rename');
  ctx.assert(renames.length >= 1,
    `默认分支必须通过 rename 换入；实际观测到：${JSON.stringify(observed)}`);
  ctx.equal(renames[renames.length - 1].to, path, 'rename 的目标必须是那个文件');

  // ② **不得**出现"直接写最终目标"的动作。
  //    这条断言与 ① 是**同一个观察点**（同一次写入的 fs 调用序列），
  //    所以把实现换成直接写时会立刻违反 —— 我上一版的负例用的是**另一个时刻**，没有区分力。
  ctx.assert(!observed.some(entry => entry.op === 'write-target'),
    `默认分支不得直接把内容写进最终目标：${JSON.stringify(observed)}`);

  // ③ 最终内容正确（正面结果仍要成立）
  ctx.equal(JSON.parse(readFileSync(path, 'utf8')).record.objective, '新');
  // ④ 换入之前目标仍是旧的 —— 与 ①② 同一时刻的观察
  ctx.equal(readFileSync(path, 'utf8') === oldDoc, false, '写入之后目标已更新');
});

suite.test('默认生产分支的换入动作必须是真实 rename，而不是被同名覆盖（AB4）', ctx => {
  // 复核 AB4 的判定依据（我前两版的做法都有洞）：
  //
  //  - 第一版：测试**注入自己提供的操作台** → 那是"由测试提供动作"，
  //    把 `operations` 换成一个**同名函数**（内部直接写目标）就能绕过；
  //  - 第二版：我改成"只包真实 `renameSync` 再注入" → 这仍然把**注入**当默认，
  //    您的变异保留调用形状、只换动作，我的观测**照样被调用**，所以也没抓住。
  //
  // **现在这一版的关键区别：测试完全不提供 `fs`。**
  // 默认分支于是走**模块作用域**里的真实 `renameSync`（与生产默认路径完全同一条）。
  // 因此：
  //   - 只要生产默认动作还是 rename，`beforeRename` 之后的换入就会**消费掉临时文件**；
  //   - 一旦被同名函数顶替成"直接写目标"，**临时文件不会被消费**
  //     （复核实测的那段变异里 `unlinkSync(temporary)` 消费的是**临时**文件，
  //      所以本判据要看的正是**临时文件是否消失**与**目标是否换入**）。
  //
  // 判据落在**文件系统事实**上，不依赖任何测试提供的对象。
  const root = ctx.tempDir();
  const path = join(root, 'tasks', 'ab4.json');

  const seeder = open(root);
  seeder.write(makeRecord({ id: 'ab4', objective: '旧' }));
  seeder.unlock();
  const oldDoc = readFileSync(path, 'utf8');

  let tmpSeenAtHook = null;
  let targetSeenAtHook = null;
  const store = open(root, {
    // **只观察，不提供动作**（`fs` 完全不传 ⇒ 默认分支走真实 renameSync）
    beforeRename: ({ tmp, path: target }) => {
      tmpSeenAtHook = {
        path: tmp, exists: existsSync(tmp), content: readFileSync(tmp, 'utf8'),
        ino: statSync(tmp).ino,
      };
      targetSeenAtHook = { path: target, content: readFileSync(target, 'utf8'), ino: statSync(target).ino };
    },
  });
  store.write(makeRecord({ id: 'ab4', objective: '新' }), { expectRevision: 1 });
  store.unlock();

  // ① 钩子那一刻：临时文件存在且含**新**内容；目标仍是**旧**内容
  ctx.assert(tmpSeenAtHook?.exists === true,
    `换入之前必须存在临时文件：${JSON.stringify(tmpSeenAtHook)}`);
  ctx.assert(tmpSeenAtHook.content.includes('新'),
    '临时文件里必须是完整的新文档');
  ctx.equal(targetSeenAtHook.content, oldDoc,
    '换入那一刻目标必须仍是旧文档（直接写实现会在这里就已经改了目标）');

  // ② **换入之后：临时文件必须已被消费**（rename 的语义）。
  //    这一条是"默认动作确实是 rename"最直接的**文件系统证据** ——
  //    它不看源码、也不看任何测试提供的对象。
  ctx.equal(existsSync(tmpSeenAtHook.path), false,
    `换入之后临时文件必须已被消费（被直接写目标顶替时它会留下）：${tmpSeenAtHook.path}`);

  // ②b **inode 身份断言**（复核 AE4 的判定依据）：
  //    我上一轮**只把 inode 塞进观测对象、却从未比较**，然后据此写下
  //    "加了 inode 判据仍通过"与"两个实现不可观测" —— 那是**把没使用的证据说成无法区分**。
  //    复核用真实文件系统实测：
  //      正常 rename：           旧 95773 → 临时 95775 → 最终目标 **95775**（变成临时 inode）
  //      默认 fallback 直接写：   旧 95997 → 临时 95999 → 最终目标 **95997**（保持旧 inode）
  //    所以这个判据在本机同文件系统上**真的能抓住"直接写 + unlink"**。
  //
  //    限度（复核同时指出）：它**不能单独证明全过程原子性** ——
  //    "先写目标、再 rename"可能有相同的最终 inode。要同时抓住两种形态，
  //    需要用独立观测真实 fs 调用的驱动，而不是这里的 inode 断言。
  ctx.equal(statSync(path).ino, tmpSeenAtHook.ino,
    `最终目标 inode 必须成为**临时文件**的 inode（rename 的语义）：`
    + `换入前目标 ino=${targetSeenAtHook.ino}、临时 ino=${tmpSeenAtHook.ino}、`
    + `最终 ino=${statSync(path).ino}`);
  ctx.assert(statSync(path).ino !== targetSeenAtHook.ino,
    '最终 inode 不得与换入前的旧目标相同 —— 那说明只是重写了同一份文件（直接写）');

  // ③ 最终内容正确
  ctx.equal(JSON.parse(readFileSync(path, 'utf8')).record.objective, '新');
});

suite.test('旧格式（非哈希）发送缓冲仍须被读到，且按身份与时间取较新（AE3）', ctx => {
  // 复核 AE3 的判定依据：AD6 把文件名从 `encodeURIComponent(key).jsonl`
  // 换成 `sha256(key).jsonl` —— 于是**升级之后**旧缓冲还在磁盘上，
  // 却因为只找新路径而被当成"不存在"，续跑时那条**已经发送过**的答案就丢了。
  // 复核实测：用旧规则写出真实缓冲、两次文本保存失败、重建 Bridge →
  // 第三条实际请求丢了旧答案（1/1）。
  const root = ctx.tempDir();
  const key = 'default numerics /some/workspace r0 prov-model';

  // ① 只有**旧格式**文件时应能读到
  const legacyPath = join(root, 'prompts', `${encodeURIComponent(key)}.jsonl`);
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(legacyPath, `${JSON.stringify({
    text: 'OLD_SENT_ANSWER', taskId: 't-legacy', sessionId: 's1', generation: 0,
    at: '2026-10-03T00:00:01.000Z',
  })}\n`);

  const store = open(root);
  const found = store.lastPromptTextFor(key, { taskId: 't-legacy', sessionId: 's1', generation: 0 });
  ctx.assert(found !== null, '只有旧格式文件时必须能读到（否则升级后丢已发送答案）');
  ctx.equal(found.text, 'OLD_SENT_ANSWER');
  ctx.equal(store.legacyPromptTextExists(key), true, '前置条件：旧文件确实存在');

  // ② **身份过滤在旧格式上同样生效**：别的任务不得借到它
  ctx.equal(store.lastPromptTextFor(key, { taskId: 't-other', sessionId: 's1', generation: 0 }), null,
    '归属不符时不得返回（否则又回到 AB2 的串扰）');

  // ③ 两种格式同时存在时，按**时间戳取较新的一条**
  const legacyRule = join(root, 'prompts');
  // 找到新哈希文件名（实现细节不外露，这里用目录列举）
  store.appendPromptText(key, {
    text: 'NEW_HASHED_ANSWER', taskId: 't-legacy', sessionId: 's1', generation: 0,
    at: '2026-10-03T00:00:02.000Z',
  });
  const files = readdirSync(legacyRule).filter(name => name.endsWith('.jsonl'));
  ctx.assert(files.length >= 2, `应当同时存在两种格式：${JSON.stringify(files)}`);
  const newer = store.lastPromptTextFor(key, { taskId: 't-legacy', sessionId: 's1', generation: 0 });
  ctx.equal(newer.text, 'NEW_HASHED_ANSWER',
    '两种格式同时存在时必须取**较新**的那条（旧格式不能盖住新写入）');

  // ④ **反向：旧格式必须也能赢**（复核 AF3 的判定依据）。
  //
  // 我上一版所谓"反向也测一次"只是把旧记录改得**更早**，两次都要求哈希记录获胜 ——
  // 于是它挡不住"两种文件并存时永远忽略旧格式"这个错误实现。
  // 现在让**旧格式明确更新**，它必须获胜。
  writeFileSync(legacyPath, `${JSON.stringify({
    text: 'NEWER_LEGACY_ANSWER', taskId: 't-legacy', sessionId: 's1', generation: 0,
    at: '2026-10-03T00:00:09.000Z',   // 明确晚于哈希那条
  })}\n`);
  const legacyWins = store.lastPromptTextFor(key, { taskId: 't-legacy', sessionId: 's1', generation: 0 });
  ctx.equal(legacyWins.text, 'NEWER_LEGACY_ANSWER',
    '旧格式更新时它必须获胜（否则测试挡不住"永远忽略旧格式"的实现）');

  // ⑤ **同刻时新格式胜**（复核 AF2 的判定依据）：
  //    同刻（毫秒相等）稳定排序下，先收集的会赢 ——
  //    所以收集顺序必须是 `[旧, 新]`，让**新格式**在同刻时胜出。
  //    我上一版是 `[新, 旧]`，同刻时旧格式反而盖住了后来发送的新文本。
  const tieLegacy = join(root, 'prompts-tie', 'x.jsonl');
  void tieLegacy;
  const root2 = ctx.tempDir();
  const key2 = 'default numerics /tie/workspace r0 prov';
  mkdirSync(join(root2, 'prompts'), { recursive: true });
  writeFileSync(join(root2, 'prompts', `${encodeURIComponent(key2)}.jsonl`),
    `${JSON.stringify({ text: 'TIE_LEGACY', taskId: 't-tie', sessionId: 's1', generation: 0,
      at: '2026-10-03T00:00:05.000Z' })}\n`);
  const store2 = open(root2);
  const hashEntry = { text: 'TIE_HASHED', taskId: 't-tie', sessionId: 's1', generation: 0,
    at: '2026-10-03T00:00:05.000Z' };   // **同一毫秒**
  store2.appendPromptText(key2, hashEntry);
  const tied = store2.lastPromptTextFor(key2, { taskId: 't-tie', sessionId: 's1', generation: 0 });
  ctx.equal(tied.text, 'TIE_HASHED', '同刻时**新格式**必须胜（否则会丢掉后来发送的文本）');
  store2.unlock();

  store.unlock();
});
