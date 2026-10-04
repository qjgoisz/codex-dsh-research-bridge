import { EventEmitter } from 'node:events';

import { createSuite } from './harness.mjs';
import { installShutdownHandlers, HANDLED_SIGNALS } from '../src/shutdown.mjs';

export const suite = createSuite('宿主终止时的收尾（残留锁的根因）');

/** 造一个可控的假环境：信号源、退出函数、桥与存储都可观测。 */
function harness({ shutdownFails = false, unlockFails = false, hang = false, emergencyKill = true, terminateObserved = true } = {}) {
  const signals = new EventEmitter();
  const events = { shutdowns: 0, unlocks: 0, exits: [], forced: [], emergency: [], logs: [] };
  const bridge = {
    shutdown: async () => {
      events.shutdowns += 1;
      if (hang) return new Promise(() => {});
      if (shutdownFails) throw new Error('worker 拒绝退出');
      return [{ observed: true }];
    },
    // 默认提供紧急终止：U3 之后看门狗会调它，并据其结果决定退出码。
    // 传 emergencyKill: false 可模拟「桥没有这个方法」的旧形态。
    // 替身与真实实现同形：**可能只发出信号而未观测到终止**（复核 W3 的边界）。
    ...(emergencyKill === false
      ? {}
      : {
        emergencyKillWorkers: () => {
          events.emergency.push(1);
          return Promise.resolve([{ pid: 42, signalled: true, terminationObserved: terminateObserved }]);
        },
      }),
  };
  const store = {
    unlock: () => {
      events.unlocks += 1;
      if (unlockFails) throw new Error('锁已被别人清掉');
    },
  };
  const lifecycle = installShutdownHandlers({
    bridge,
    store,
    signals,
    exit: code => events.exits.push(code),
    // 必须注入 forceExit：真实实现在超时后会调用它，
    // 不注入就会调到真正的 process.exit，把测试进程本身杀掉。
    forceExit: code => events.forced.push(code),
    watchdogMs: 50,
    forceExitDelayMs: 20,
    log: entry => events.logs.push(entry),
  });
  return { signals, events, lifecycle };
}

/**
 * **带清理的 `Promise.race`**（复核 AD4 的判定依据）。
 *
 * `Promise.race` 只决定"谁先到"，**不会取消败方** —— 而败方是一个
 * `setTimeout(...)`。于是"退出握手赢了"之后，那个 2000/3000ms 的 timer
 * 仍然挂在事件循环上，runner 要等它到期才结束：
 * 复核实测正常退出目标 `汇总 154ms、墙钟 2.064s`；只保存句柄并清掉之后
 * 变成 `153ms、0.216s`（断言一字未改）。
 *
 * @param {Promise<any>} promise 被观察的 Promise
 * @param {number} ms 上界
 * @param {string} onTimeout 超时时返回的标记值
 * @returns {Promise<any>}
 */
async function raceWithTimeout(promise, ms, onTimeout) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(onTimeout), ms); }),
    ]);
  } finally {
    // **胜方确定后清掉败方 timer** —— 这不是改变判定，只是不再空等。
    if (timer !== null) clearTimeout(timer);
  }
}

suite.test('信号触发时：先收 worker，再放锁（顺序不可颠倒）', async ctx => {
  const { signals, events } = harness();
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 30));
  ctx.equal(events.shutdowns, 1, 'worker 必须被终止');
  ctx.equal(events.unlocks, 1, '锁必须被释放');
  ctx.deepEqual(events.exits, [0], '收尾完成后退出');
  ctx.equal(events.logs[0].signal, 'SIGTERM');
});

suite.test('SIGHUP 与 SIGINT 也走同一条路径（SIGHUP 曾经完全没处理）', async ctx => {
  for (const name of ['SIGINT', 'SIGHUP']) {
    const { signals, events } = harness();
    signals.emit(name);
    await new Promise(resolve => setTimeout(resolve, 30));
    ctx.equal(events.shutdowns, 1, `${name} 必须触发收尾`);
    ctx.equal(events.unlocks, 1, `${name} 必须释放锁`);
  }
  ctx.deepEqual([...HANDLED_SIGNALS], ['SIGTERM', 'SIGINT', 'SIGHUP']);
  ctx.assert(!HANDLED_SIGNALS.includes('SIGKILL'),
    'SIGKILL 不可捕获，不能假装处理了它 —— 残留锁的可能性因此仍然存在');
});

suite.test('terminate worker 失败时，锁仍必须被释放', async ctx => {
  const { signals, events } = harness({ shutdownFails: true });
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 30));
  ctx.equal(events.unlocks, 1, 'worker 收不掉不是留下残留锁的理由');
  ctx.deepEqual(events.exits, [0]);
  const logged = events.logs.find(e => e.workerError);
  ctx.assert(logged, `失败必须被记下：${JSON.stringify(events.logs)}`);
  ctx.assert(logged.workerError.includes('worker 拒绝退出'), '要带上原始信息');
});

suite.test('unlock 失败不会阻止退出（否则进程卡住、宿主更强硬地杀）', async ctx => {
  const { signals, events } = harness({ unlockFails: true });
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 30));
  ctx.deepEqual(events.exits, [0], '即使放锁失败也必须退出');
  ctx.assert(events.logs.some(e => e.lockError), `放锁失败要被记下：${JSON.stringify(events.logs)}`);
});

suite.test('收尾是幂等的：第二个信号不会重来一遍', async ctx => {
  const { signals, events } = harness();
  signals.emit('SIGTERM');
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 30));
  ctx.equal(events.shutdowns, 1, '并发信号只能收尾一次');
  ctx.equal(events.unlocks, 1);
  ctx.deepEqual(events.exits, [0], '也只退出一次');
});

suite.test('看门狗兜底：worker 卡住时必须**真的要求强制退出**（N4）', async ctx => {
  // 复核 N4 的判定依据：原断言只检查"记了一条日志 + 退出"，而真正路径上
  // 没有任何东西杀掉卡住的 worker —— 那条断言是空洞的。
  // 现在必须断言**强制退出确实被要求**，而不只是写了日志。
  const { signals, events } = harness({ hang: true });
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 150));

  ctx.assert(events.logs.some(e => e.event === 'bridge_shutdown_watchdog'),
    `看门狗触发必须留痕：${JSON.stringify(events.logs)}`);
  ctx.deepEqual(events.forced, [0],
    '卡住的 worker 必须触发强制退出（只写日志是不够的）');
  ctx.assert(events.logs.some(e => e.event === 'bridge_shutdown_force_exit'),
    '强制退出也必须留痕');
  // U3：看门狗必须**先终止 worker 进程组**，再结束自己。
  ctx.deepEqual(events.emergency, [1],
    '看门狗到期必须先调用 emergencyKillWorkers（只 process.exit 会把 worker 留在独立进程组里）');
  ctx.deepEqual(events.exits, [0],
    'worker 的终止被**观测到**时才以 0 退出（判据是 terminationObserved，不是 signalled）');
});

suite.test('worker 未被确认终止时，看门狗必须以非零退出（U3）', async ctx => {
  // 复核 U3 的建议：「以失败/未确认退出」，而不是一律 0。
  // 这里模拟桥没有 emergencyKillWorkers 的形态（= 修好之前的行为）。
  const { signals, events } = harness({ hang: true, emergencyKill: false });
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 150));

  ctx.deepEqual(events.forced, [1],
    '无法确认 worker 已终止时必须非零退出，让宿主知道这次收尾没有完成核对');
  const logged = events.logs.find(e => e.event === 'bridge_shutdown_force_exit');
  ctx.equal(logged?.unconfirmed, true, `留痕必须写明"未确认"：${JSON.stringify(logged)}`);
});

suite.test('只发出信号但未观测到终止时，必须非零退出（W3）', async ctx => {
  // 复核 W3 的判定依据：`signalled: true` 只是**信号回报**，源码那时没有后续的退出观测。
  // 而看门狗把它当成"已确认终止"，于是 `unconfirmed: false` 与报告里
  // "宿主可区分收尾完成"这话说得比证据强。
  //
  // 这条测试固定住新语义：**未观测到终止 → 非零退出 + unconfirmed: true**。
  const { signals, events } = harness({ hang: true, terminateObserved: false });
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 150));

  ctx.deepEqual(events.emergency, [1], '仍然要发出终止信号');
  ctx.deepEqual(events.forced, [1],
    '只发出信号、未观测到终止时必须非零退出');
  const logged = events.logs.find(e => e.event === 'bridge_shutdown_force_exit');
  ctx.equal(logged?.unconfirmed, true,
    `留痕必须写明未确认：${JSON.stringify(logged)}`);
  ctx.equal(logged?.workersTerminationObserved, 0,
    '留痕必须区分"发了信号"与"观测到终止"');
});

suite.test('共同截止时间：后来者拿剩余预算，不是从自己那一刻重新起算（N3）', async ctx => {
  // 复核 N3 的判定依据：每次调用都从自己那一刻起算预算时，
  // "某个调用者用完预算"不影响另一个 —— 进程总时长随信号次数累积，"有上限"并不成立。
  // 判据：第一次等待用完大部分预算后，紧接着的第二次等待必须**用很短的时间就超时**。
  const { EventEmitter } = await import('node:events');
  const { installShutdownHandlers } = await import('../src/shutdown.mjs');

  const signals = new EventEmitter();
  const events = { forced: [], exits: [], logs: [] };
  const lifecycle = installShutdownHandlers({
    bridge: {
      shutdown: () => new Promise(() => {}),  // 永不完成
      // U3 之后看门狗会调它，并据结果决定退出码；这里让 worker 都"已发出信号"，
      // 于是退出码为 0，本测试只关注预算是否共享。
      emergencyKillWorkers: async () => [{ pid: 7, signalled: true, terminationObserved: true }],
    },
    store: { unlock: () => {} },
    signals,
    exit: code => events.exits.push(code),
    forceExit: code => events.forced.push(code),
    watchdogMs: 80,
    forceExitDelayMs: 10,
    log: entry => events.logs.push(entry),
  });

  const first = Date.now();
  await lifecycle.awaitCleanup('stdio_eof');
  const firstTook = Date.now() - first;

  const second = Date.now();
  await lifecycle.awaitCleanup('SIGTERM');
  const secondTook = Date.now() - second;

  ctx.assert(firstTook >= 60, `第一次应当用掉大部分预算，实际 ${firstTook}ms`);
  ctx.assert(secondTook <= firstTook / 2,
    `第二次必须拿剩余预算（应当明显短于 ${firstTook}ms），实际 ${secondTook}ms`);
  ctx.deepEqual(events.forced, [0, 0], '两次超时都应当要求强制退出（worker 已确认发信号时退出码 0）');
});

suite.test('dispose 之后信号不再触发收尾（可重复安装）', async ctx => {
  const { signals, events, lifecycle } = harness();
  lifecycle.dispose();
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 20));
  ctx.equal(events.shutdowns, 0, 'dispose 后不该还有监听器');
  ctx.equal(events.exits.length, 0);
});

suite.test('shutdown 可被直接调用（stdio EOF 路径），且不改退出码', async ctx => {
  const { events, lifecycle } = harness();
  const result = await lifecycle.shutdown('stdio_eof');
  ctx.equal(result.already, false);
  ctx.equal(events.shutdowns, 1);
  ctx.equal(events.unlocks, 1);
  ctx.deepEqual(events.exits, [], '正常返回路径不该强制退出，退出码由调用方决定');
  // 语义在 F3 之后变了：第二次调用**返回同一个 cleanup 的结果**，而不是 {already:true}。
  // 这是必要的 —— 并发信号必须能等待第一次收尾完成，否则它会抢跑（复核 F3）。
  const again = await lifecycle.shutdown('again');
  ctx.equal(again.already, false, '第二次调用返回的是同一份收尾结果');
  ctx.equal(events.shutdowns, 1, '只收尾一次');
  ctx.deepEqual(events.exits, [], '仍然不强制退出');
});

suite.test('EOF 收尾与信号收尾共享同一个截止时间（F3）', async ctx => {
  // 复核 F3 的判定依据：EOF 路径没有看门狗，而且第二次 shutdown 会**立刻返回**
  // （`{already:true}`）而不是等第一次完成 —— 于是 EOF 收尾期间来的信号会抢跑退出。
  //
  // 本测试只验「并发路径**等待**同一次收尾」。超时路径（共同截止时间 N3、看门狗 N4）
  // 由另外两条测试负责 —— 所以这里刻意让清理**最终会完成**，避免走进超时分支。
  const { EventEmitter } = await import('node:events');
  const { installShutdownHandlers } = await import('../src/shutdown.mjs');

  const signals = new EventEmitter();
  const events = { shutdowns: 0, unlock: 0, exits: [], forced: [], logs: [] };
  let release = null;
  const lifecycle = installShutdownHandlers({
    bridge: {
      shutdown: () => {
        events.shutdowns += 1;
        return new Promise(resolve => { release = () => resolve([{ observed: true }]); });
      },
    },
    store: { unlock: () => { events.unlock += 1; } },
    signals,
    exit: code => events.exits.push(code),
    forceExit: code => events.forced.push(code),
    watchdogMs: 3000,
    forceExitDelayMs: 20,
    log: entry => events.logs.push(entry),
  });

  // 启动收尾但**不等待**：这会固定共同截止时间（本测试不需要走超时分支，所以不调 awaitCleanup）。
  const pending = lifecycle.shutdown('stdio_eof');
  ctx.equal(events.shutdowns, 1, '收尾只发起一次');
  ctx.equal(events.unlock, 0, 'worker 还没结束，锁尚未释放 —— 这是预期');

  // 并发信号必须在**等待同一个 cleanup**，不得另起一次收尾，也不得抢跑退出
  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 60));
  ctx.equal(events.shutdowns, 1, '并发信号不得重复发起收尾');
  ctx.deepEqual(events.exits, [], 'worker 还在收尾，此时不得退出（旧实现在这里抢跑）');

  // 收尾真正完成后：释放锁、退出恰好一次、且**从未**要求强制退出
  release();
  await pending;
  await new Promise(resolve => setTimeout(resolve, 60));
  ctx.equal(events.unlock, 1, '收尾完成后必须释放锁');
  ctx.deepEqual(events.exits, [0], '退出恰好一次');
  ctx.deepEqual(events.forced, [],
    '收尾最终成功时不得要求强制退出（强制退出只属于超时路径）');
  ctx.assert(events.logs.some(e => e.event === 'bridge_shutdown_join'),
    `并发调用应当留下「加入同一次收尾」的记录：${JSON.stringify(events.logs.map(e => e.event))}`);
});

suite.test('收尾顺序：worker 完成 → 释放锁 → 退出（A3）', async ctx => {
  // 复核 A3 的判定依据：原来那条测试只比较**调用次数**，把 unlock 提到
  // `await bridge.shutdown()` 之前也照样通过 —— 次数不能证明顺序。
  // 这里用 deferred promise 记录真实事件序列。
  const { EventEmitter } = await import('node:events');
  const { installShutdownHandlers } = await import('../src/shutdown.mjs');

  const signals = new EventEmitter();
  const order = [];
  let releaseWorker;
  const lifecycle = installShutdownHandlers({
    bridge: {
      shutdown: () => {
        order.push('worker:start');
        return new Promise(resolve => {
          releaseWorker = () => { order.push('worker:done'); resolve([{ observed: true }]); };
        });
      },
    },
    store: {
      unlock: () => {
        order.push('unlock');
        // 锁必须在 worker **完成之后**才释放：若实现把它提前，这条会失败。
        if (!order.includes('worker:done')) order.push('unlock-before-worker-finished');
      },
    },
    signals,
    exit: code => order.push(`exit:${code}`),
    // 即使本测试的 watchdogMs 很大、正常情况下走不到超时，也必须注入 forceExit：
    // 「没注入」就意味着一旦时间参数被改动，超时路径会调用真正的 process.exit，
    // 把整个测试进程杀掉，而症状只是「汇总行消失」（我刚刚就这样踩过一次）。
    forceExit: code => order.push(`forced:${code}`),
    watchdogMs: 2000,
    log: () => {},
  });

  signals.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 20));
  ctx.deepEqual(order, ['worker:start'],
    `worker 未完成时不得释放锁、更不得退出，实际顺序：${order.join(' → ')}`);

  releaseWorker();
  await new Promise(resolve => setTimeout(resolve, 30));
  ctx.deepEqual(order, ['worker:start', 'worker:done', 'unlock', 'exit:0'],
    `收尾顺序必须是 worker 完成 → 释放锁 → 退出，实际：${order.join(' → ')}`);
  ctx.assert(!order.includes('unlock-before-worker-finished'),
    '锁不得在 worker 收尾之前释放');
});

suite.test('看门狗触发后，桥必须仍在有限时间内退出（Y3）', async ctx => {
  // 复核 Y3 的判定依据：强制退出的计时器原来建在 `await bridge.emergencyKillWorkers()`
  // **之后**，而那个 await **没有上限** —— 一旦它不结算，看门狗虽已响，
  // 桥仍然没有任何退出上限。
  //
  // 复核实测（真实 `installShutdownHandlers` + **永不结算**的 async 紧急收尾，
  // `watchdogMs:20 / forceExitDelayMs:10`）：100ms 后已记录 `bridge_shutdown_watchdog`，
  // 但 `forceExit` 调用次数仍为 **0**、`awaitCleanup` 仍未结算。
  //
  // 这条测试固定住：**紧急终止永不结算时，也必须仍在有界时间内 forceExit**。
  const { installShutdownHandlers } = await import('../src/shutdown.mjs');

  const exits = [];
  const logs = [];
  const never = () => new Promise(() => {}); // **永不结算**

  const lifecycle = installShutdownHandlers({
    bridge: {
      shutdown: never,
      emergencyKillWorkers: never, // 关键：这一步永不结算
      reconcile: () => ({ unsettled: [] }),
    },
    store: { unlock: () => {} },
    log: entry => logs.push(entry),
    forceExit: code => exits.push(code),
    watchdogMs: 20,
    forceExitDelayMs: 10,
    hardExitGraceMs: 120,
  });

  try {
    // 直接走「有上限地等待收尾」这条真实入口（它与信号路径共享同一个实现）
    const settled = await raceWithTimeout(lifecycle.awaitCleanup('test-y3'), 1200, 'STILL_PENDING');

    ctx.assert(settled !== 'STILL_PENDING',
      `awaitCleanup 必须有上限地返回；日志：${JSON.stringify(logs.map(e => e.event))}`);
    ctx.assert(exits.length >= 1,
      `看门狗触发后必须仍然退出（forceExit 调用 ${exits.length} 次）；`
      + `日志：${JSON.stringify(logs.map(e => e.event))}`);

    // 而且必须**如实记录**那次超时，而不是假装终止成功
    ctx.assert(logs.some(entry => entry.event === 'bridge_shutdown_watchdog'),
      '必须记录看门狗触发');
    ctx.assert(logs.some(entry => entry.event === 'bridge_shutdown_emergency_kill_timeout'),
      `紧急终止不结算时必须留痕；日志：${JSON.stringify(logs.map(e => e.event))}`);
    const forced = logs.find(entry => entry.event === 'bridge_shutdown_force_exit');
    if (forced) {
      ctx.equal(forced.unconfirmed, true,
        '未能确认终止时必须以「未确认」退出（而不是假装成功）');
    }
  } finally {
    lifecycle.dispose();
  }
});


suite.test('收尾完成并 dispose 之后，不得再触发第二次退出（AA3）', async ctx => {
  // 复核 AA3 的判定依据：`hardTimer` 原来建在它声称要保护的那个 `await` **之后**，
  // 而 `finally` 只清 `timer`/`forceTimer`，**没清它** ——
  // 于是 `awaitCleanup` 正常返回、调用方 `dispose()` 之后，它仍会触发第二次 `forceExit`。
  //
  // **必须同时注入 `exit` 与 `forceExit`**（复核 AC1 的判定依据）：
  // 正常完成路径调用的是 `exit(code)`（默认是**真实的 `process.exit`**），
  // 只注入 `forceExit` 的话，`finish()` 会调用真实的 `process.exit(0)` ——
  // **整个 runner 被提前终止**，后面的套件不再执行、也没有汇总，
  // 而外层看到的是 `exit=0`，于是"已发现的失败"被掩盖。
  // 复核实测：原测试单跑连 ✓ 都不产生却返回 0；同一次完整运行在它之后就没有汇总。
  //
  // 另外**不要 `await` 一个 boolean 来等待收尾**：`shutdownThenExit` 返回 true
  // 并不代表收尾完成。这里用**显式的退出握手**（一个由注入的 exit 解析的 Promise）。
  const { installShutdownHandlers } = await import('../src/shutdown.mjs');
  const { EventEmitter } = await import('node:events');

  const exits = [];
  const logs = [];
  const signals = new EventEmitter();
  let resolveExited;
  const exitedHandshake = new Promise(resolve => { resolveExited = resolve; });
  const record = code => { exits.push(code); resolveExited(code); };

  const lifecycle = installShutdownHandlers({
    bridge: {
      shutdown: async () => ({ ok: true }),
      emergencyKillWorkers: async () => [{ pid: 4242, signalled: true, terminationObserved: true }],
      reconcile: () => ({ unsettled: [] }),
    },
    store: { unlock: () => {} },
    log: entry => logs.push(entry),
    signals,
    // **两个都要注入**：正常路径走 `exit`，看门狗路径走 `forceExit`。
    exit: record,
    forceExit: record,
    watchdogMs: 200,
    forceExitDelayMs: 10,
    hardExitGraceMs: 60, // 故意很小：如果它没被清掉，dispose 之后就会触发
  });

  try {
    lifecycle.shutdownThenExit('aa3');
    // **显式握手**：等到真的发生了一次退出（不是等一个 boolean）
    const handshake = await raceWithTimeout(exitedHandshake.then(() => 'EXITED'), 2000, 'NO_EXIT');
    ctx.equal(handshake, 'EXITED', '正常收尾必须在有界时间内触发一次退出');
    ctx.deepEqual(exits, [0], `正常收尾应当只退出一次（码 0）：${JSON.stringify(exits)}`);
    ctx.assert(!logs.some(entry => entry.event === 'bridge_shutdown_hard_exit'),
      `正常路径不得触发"独立上限"退出：${JSON.stringify(logs.map(e => e.event))}`);

    lifecycle.dispose();
    // 等到明显超过 hardExitGraceMs —— 如果 hardTimer 没被清掉，它会在这里触发第二次退出
    await new Promise(resolve => setTimeout(resolve, 150));

    ctx.deepEqual(exits, [0],
      `dispose 之后不得再有退出（hardTimer 必须已被清理）：${JSON.stringify(exits)}`);
    ctx.assert(!logs.some(entry => entry.event === 'bridge_shutdown_hard_exit'),
      `dispose 之后不得出现"独立上限"日志：${JSON.stringify(logs.map(e => e.event))}`);
  } finally {
    lifecycle.dispose();
  }
});


suite.test('看门狗路径必须创建并清理 hardTimer（AC4）', async ctx => {
  // 复核 AC4 的判定依据：我上一轮新增的那条测试里 fixture 的 `shutdown` **正常结算**，
  // `awaitCleanup` 在创建 `hardTimer` **之前**就返回了 —— 所以再等 150ms 也验证不到它的清理。
  // 复核实测：透明记录到的定时器只有 `[200, 0, 150]`，**没有** `hardExitGraceMs=60`。
  // 而同时删掉生产里的 `clearTimeout(hardTimer)` 与回调的 `exitRequested` 防重复保护，
  // 那条测试仍然 **1/0** —— 把要保护的代码改坏而原断言继续通过。
  //
  // 这条补偿测试**走真实看门狗路径**：让 `shutdown` **永不结算**，
  // 触发看门狗 → 紧急终止正常返回 → `awaitCleanup` 返回。
  // 然后核对：没有额外退出、没有 hard_exit 日志。
  const { installShutdownHandlers } = await import('../src/shutdown.mjs');
  const { EventEmitter } = await import('node:events');

  const exits = [];
  const logs = [];
  const signals = new EventEmitter();
  const never = () => new Promise(() => {});

  const lifecycle = installShutdownHandlers({
    bridge: {
      shutdown: never,                                   // **永不结算** → 必然走看门狗
      emergencyKillWorkers: async () => [{ pid: 4242, signalled: true, terminationObserved: true }],
      reconcile: () => ({ unsettled: [] }),
    },
    store: { unlock: () => {} },
    log: entry => logs.push(entry),
    signals,
    exit: code => exits.push(code),
    forceExit: code => exits.push(code),
    watchdogMs: 10,          // 很快就触发
    forceExitDelayMs: 10,
    hardExitGraceMs: 400,    // 足够大：真被触发时一定看得见
  });

  try {
    // 前置条件：**必须真的进入看门狗路径**（否则这条测试与 AC4 指出的那条一样空）
    const outcome = await raceWithTimeout(
      lifecycle.awaitCleanup('ac4').then(() => 'RETURNED'), 3000, 'STILL_WAITING');
    ctx.equal(outcome, 'RETURNED', '看门狗必须在有界时间内让 awaitCleanup 返回');
    ctx.assert(logs.some(entry => entry.event === 'bridge_shutdown_watchdog'),
      `前置条件：必须真的触发看门狗：${JSON.stringify(logs.map(e => e.event))}`);
    ctx.deepEqual(exits, [0], `正常确认终止时应当只退出一次（码 0）：${JSON.stringify(exits)}`);

    // **关键**：dispose 之后等到明显超过 hardExitGraceMs ——
    // 若 hardTimer 没被创建/没被清理，它会在这里触发额外退出与 hard_exit 日志。
    lifecycle.dispose();
    await new Promise(resolve => setTimeout(resolve, 500));

    ctx.deepEqual(exits, [0], `dispose 之后不得再有退出：${JSON.stringify(exits)}`);
    ctx.assert(!logs.some(entry => entry.event === 'bridge_shutdown_hard_exit'),
      `看门狗已正常返回时不得触发"独立上限"退出：${JSON.stringify(logs.map(e => e.event))}`);
  } finally {
    lifecycle.dispose();
  }
});
