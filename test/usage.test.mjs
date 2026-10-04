import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Store } from '../src/store.mjs';
import { SessionMap } from '../src/session-map.mjs';
import { Bridge, createCollector, renderPrompt, renderFollowUp } from '../src/orchestration.mjs';
import { UsageSeries, checkPrefixStability, MAX_SAMPLES } from '../src/usage.mjs';
import { contract, testWorker } from './fixtures.mjs';

import { createSuite } from './harness.mjs';

// 项目根：与其它测试文件一致，用 import.meta.dirname 的上一级。
const projectRoot = join(import.meta.dirname, '..');

export const suite = createSuite('上下文占用与复用前提（P3）');

suite.test('一个提示内多次 usage_update 会被逐条收集成曲线', ctx => {
  const series = new UsageSeries();
  series.observe({ sessionUpdate: 'usage_update', used: 1000, size: 1000000 }, 1);
  series.observe({ sessionUpdate: 'usage_update', used: 2500, size: 1000000 }, 2);
  const summary = series.summary();
  ctx.equal(summary.samples.length, 2);
  ctx.equal(summary.firstUsed, 1000);
  ctx.equal(summary.lastUsed, 2500);
  ctx.equal(summary.grewBy, 1500);
  ctx.equal(summary.samples[0].delta, null, '第一个样本没有前一值可比');
  ctx.equal(summary.samples[1].delta, 1500);
  ctx.equal(summary.sawDecrease, false);
});

suite.test('占用下降被辨识为可能的驱逐/压缩，而不是被抹平', ctx => {
  const series = new UsageSeries();
  for (const [i, used] of [1000, 2500, 1800, 4200].entries()) {
    series.observe({ sessionUpdate: 'usage_update', used, size: 1000000 }, i + 1);
  }
  const summary = series.summary();
  ctx.equal(summary.sawDecrease, true, '1800 < 2500 必须被记为回退');
  ctx.equal(summary.samples[2].delta, -700, '回退量要如实保留');
  ctx.equal(summary.maxUsed, 4200, '峰值要保留，否则看不出真实压力');
});

suite.test('没有 samples 时是 null（未观测到），不是 0', ctx => {
  ctx.equal(new UsageSeries().summary(), null, '0 会被读成"没有消耗"，必须是 null');
});

suite.test('样本数量有上限，超出的部分被计数而不是静默丢弃', ctx => {
  const series = new UsageSeries();
  for (let i = 0; i < MAX_SAMPLES + 5; i += 1) {
    series.observe({ sessionUpdate: 'usage_update', used: i + 1, size: 1000 }, i + 1);
  }
  const summary = series.summary();
  ctx.equal(summary.samples.length, MAX_SAMPLES);
  ctx.equal(summary.truncated, 5);
});

suite.test('畸形或无关的通知不会污染曲线', ctx => {
  const series = new UsageSeries();
  series.observe({ sessionUpdate: 'agent_message_chunk', used: 5, size: 5 }, 1);
  series.observe({ sessionUpdate: 'usage_update' }, 2);
  series.observe({ sessionUpdate: 'usage_update', used: 'x', size: 1 }, 3);
  series.observe(null, 4);
  ctx.equal(series.summary(), null, '这些都不构成有效样本');
});

suite.test('前缀稳定性：只有追加才算保持（提供方按整段前缀匹配）', ctx => {
  const first = 'A+B';
  ctx.deepEqual(checkPrefixStability(first, 'A+B'), { stable: true, appendedChars: 0 });
  ctx.deepEqual(checkPrefixStability(first, 'A+B\n另外请补充第二点'), { stable: true, appendedChars: 9 });
  const broken = checkPrefixStability(first, 'A+C');
  ctx.equal(broken.stable, false);
  ctx.equal(broken.reason, 'prefix_diverged');
  ctx.equal(broken.sharedChars, 2, '要说清一致到哪里，便于定位');
  ctx.equal(checkPrefixStability(null, 'x').stable, false);
});

suite.test('renderFollowUp 是追加式的：原任务文本逐字成为前缀（缓存前缀不失配）', ctx => {
  const base = contract({ id: 'u-prefix', workspace: '/tmp/ws', permissions: { writePaths: ['/tmp/ws'] } });
  const first = renderPrompt(base);

  // 同一契约两次渲染必须逐字节一致，否则"追加"都无从谈起
  ctx.equal(renderPrompt(base), first, '同一契约的渲染必须确定');

  const withQuestion = { ...base, clarification: { question: '标准差是多少？', answer: null } };
  const followUp = renderFollowUp(withQuestion, '1e-3');
  const verdict = checkPrefixStability(first, followUp);
  ctx.equal(verdict.stable, true, `续跑文本必须以前一轮为前缀：${JSON.stringify(verdict)}`);
  ctx.assert(verdict.appendedChars > 0, '必须真的追加了内容');
  ctx.assert(followUp.includes('1e-3'), '答案必须在文本里');
  ctx.assert(followUp.includes('标准差是多少？'), '被回答的问题要一并保留，便于日后复盘');
  ctx.assert(followUp.startsWith(first), '前缀必须逐字相同，而不是"看起来差不多"');
});

suite.test('续跑追加不会把答案混进原任务正文（可读性）', ctx => {
  const base = contract({ id: 'u-clean', workspace: '/tmp/ws', permissions: { writePaths: ['/tmp/ws'] } });
  const followUp = renderFollowUp({ ...base, clarification: { question: 'q', answer: null } }, '答案');
  const marker = followUp.indexOf('## 澄清答复');
  ctx.assert(marker > 0, '必须有明确的分隔标记');
  ctx.equal(followUp.slice(0, marker).trimEnd(), renderPrompt(base).trimEnd(),
    '分隔标记之前必须是原任务文本的原样');
});

suite.test('占用曲线会随结果一起落盘', async ctx => {
  const root = ctx.tempDir('usage-record-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: 'usage_series' }), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  const view = await bridge.delegate(contract({
    id: 'u2', workspace: root, permissions: { writePaths: [root] },
  }), { wait: true });
  ctx.equal(view.status, 'completed');
  const record = store.read('u2');
  const series = record.result.usageSeries;
  ctx.assert(series, '完成记录里应当有占用曲线');
  ctx.equal(series.samples.length, 4);
  ctx.equal(series.sawDecrease, true, 'fake 故意发了一次回退');
  ctx.equal(series.contextSize, 1000000);
  ctx.assert(series.note.includes('缓存命中与成本不在 ACP 面上'), '必须写明这个面上没有缓存与成本');
  await bridge.shutdown();
  store.unlock();
});

suite.test('收集器把 usage_update 与正文分开记账', ctx => {
  const collector = createCollector('s1');
  collector.observe({ sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 10, size: 100 } });
  collector.observe({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: '正文' } } });
  collector.observe({ sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 20, size: 100 } });
  const snapshot = collector.snapshot();
  ctx.equal(snapshot.text, '正文', '占用通知不得混入正文');
  ctx.equal(snapshot.usageSeries.samples.length, 2);
});

// ------------------------------------------------ F15：沙箱边界探针的判定
// 复核的判定依据：原探针在「worker 完全没有尝试越界写入」的反例上，仍输出
// 「沙箱在系统层面拦住了越界写入」—— 它把「文件没留下」升级成了「沙箱拒绝了尝试」，
// 中间缺一步：**有没有尝试过**。判定逻辑现在抽成纯函数，因此可以被离线覆盖。

suite.test('样本超上限后，摘要的终点与增长量仍必须覆盖整个观测时域（F13）', async ctx => {
  // 复核 F13 的判定依据：`#samples` 有上限，而 `summary()` 却从**被截断的数组**取首末样本，
  // 于是 used=1…69 时输出 lastUsed=64、grewBy=63 —— 而真实终点是 69、真实增长是 68。
  // 摘要报告的是一个**中间点**：被限长的曲线不该决定摘要的观测时域。
  //
  // 原来那条测试（`样本数量有上限…`）只检查 `samples.length` 与 `truncated`，
  // 对 `lastUsed` / `grewBy` 一个字都没断言 —— 这就是它没抓住的原因。
  const { UsageSeries, MAX_SAMPLES } = await import('../src/usage.mjs');
  const series = new UsageSeries();
  const total = MAX_SAMPLES + 5; // 69
  for (let used = 1; used <= total; used += 1) {
    series.observe({ sessionUpdate: 'usage_update', used, size: 1000 }, used);
  }
  const summary = series.summary();

  // 曲线仍然被限长（这是设计，不变）
  ctx.equal(summary.samples.length, MAX_SAMPLES);
  ctx.equal(summary.truncated, total - MAX_SAMPLES);

  // **摘要必须覆盖整个时域**
  ctx.equal(summary.firstUsed, 1, `首个观测必须是 1，实际 ${summary.firstUsed}`);
  ctx.equal(summary.lastUsed, total,
    `最新观测必须是 ${total}（不是被截断的 ${MAX_SAMPLES}），实际 ${summary.lastUsed}`);
  ctx.equal(summary.maxUsed, total);
  ctx.equal(summary.grewBy, total - 1,
    `增长量必须覆盖整个时域（${total - 1}），实际 ${summary.grewBy}`);
  // 上面那条整条序列 size 恒为 1000 —— 它对"首样本还是最新样本"**没有区分力**
  // （复核 X9 的判定依据：只把 `contextSize: last.size` 改成 `first.size`，仍 16/0）。
  // 所以这里用一条**末端 size 变化**的独立输入来区分：
  // 前 MAX_SAMPLES 条 size=1000，之后 size=2000 → contextSize 必须是 2000。
  const sizeSeries = new UsageSeries();
  const total2 = MAX_SAMPLES + 5;
  for (let i = 0; i < total2; i += 1) {
    sizeSeries.observe({ sessionUpdate: 'usage_update', used: i + 1, size: i < MAX_SAMPLES ? 1000 : 2000 }, i + 1);
  }
  const sizeSummary = sizeSeries.summary();
  ctx.equal(sizeSummary.contextSize, 2000,
    `contextSize 必须来自**最新**样本（期望 2000，首样本是 1000），实际 ${sizeSummary.contextSize}`);
  ctx.equal(sizeSummary.lastUsed, total2,
    `同一输入下 lastUsed 也必须覆盖整个时域，实际 ${sizeSummary.lastUsed}`);
  // 三个字段分别断言：恢复任何**单个**字段的错误实现都应让对应断言变红
  ctx.equal(sizeSummary.firstUsed, 1, 'firstUsed 来自首个样本');
  ctx.equal(sizeSummary.grewBy, total2 - 1, 'grewBy 覆盖整个时域');

  // 边界：正好等于上限时不该受影响
  const exact = new UsageSeries();
  for (let used = 1; used <= MAX_SAMPLES; used += 1) {
    exact.observe({ sessionUpdate: 'usage_update', used, size: 100 }, used);
  }
  ctx.equal(exact.summary().lastUsed, MAX_SAMPLES);
  ctx.equal(exact.summary().grewBy, MAX_SAMPLES - 1);

  // 边界：出现下降时 sawDecrease 仍要看得见，且 latest 是最后那个值
  const dropped = new UsageSeries();
  dropped.observe({ sessionUpdate: 'usage_update', used: 50, size: 100 }, 1);
  dropped.observe({ sessionUpdate: 'usage_update', used: 10, size: 100 }, 2);
  ctx.equal(dropped.summary().lastUsed, 10, 'latest 必须反映最近的下降');
  ctx.equal(dropped.summary().sawDecrease, true, '下降信号不能被限长吞掉');
});

suite.test('usage_update 的原始观测必须能分清「没发 / 收到但字段不完整 / 接受」（AL3）', async ctx => {
  // 复核 AL3 的判定依据：`usageSeries === null` **只说明结果里没有有效样本**，
  // 分不出 worker 没发 / 线上没到 / 到了没被收集。复核实测：
  // 让 worker 真实发出四条通知、只把**收集器**那一支改坏，仍然是 `null`。
  //
  // 这条测试固定两层证据：
  //   ① `UsageSeries.observe()` 必须**返回布尔**（是否接受），所以"收到但无效"可分辨；
  //   ② 结果里必须带 `usageObservation: { seen, invalid, accepted }`。
  const { UsageSeries } = await import('../src/usage.mjs');

  // ① `observe` 的返回值约定
  const series = new UsageSeries();
  ctx.equal(series.observe({ sessionUpdate: 'usage_update', used: 10, size: 100 }, 1), true,
    '字段完整的通知必须被接受（返回 true）');
  ctx.equal(series.observe({ sessionUpdate: 'usage_update', used: 20, size: 100 }, 2), true,
    '第二条也必须被接受');
  ctx.equal(series.observe({ sessionUpdate: 'usage_update', used: 'x', size: 100 }, 3), false,
    '字段不完整必须返回 false（否则"收到但无效"分不出来）');
  ctx.equal(series.observe({ sessionUpdate: 'usage_update' }, 4), false,
    '缺 used/size 必须返回 false');
  ctx.equal(series.observe(null, 5), false, 'null 必须返回 false');
  ctx.equal(series.summary()?.samples?.length, 2,
    `只有被接受的两条应成为样本：${JSON.stringify(series.summary()?.samples)}`);

  // ② 结果里必须带原始观测（透过真实的 fake worker 拿一条）
  const { Store } = await import('../src/store.mjs');
  const { SessionMap } = await import('../src/session-map.mjs');
  const { Bridge } = await import('../src/orchestration.mjs');
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { contract, testWorker, assertOfflineSpec } = await import('./fixtures.mjs');
  const { join } = await import('node:path');

  const root = ctx.tempDir('al3-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    defaults: { provider: 'deepseek-official', modelId: 'deepseek-flash' },
    worker: { ...testWorker({ FAKE_SCENARIO: 'usage_series', FAKE_STATE: join(root, 'agent.json') }), dshHome: join(root, 'dsh-home') },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
  });
  try {
    await bridge.delegate(contract({ id: 'al3-1', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
    const deadline = Date.now() + 5000;
    while (['queued', 'dispatching', 'running'].includes(store.read('al3-1').status)
      && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    const record = store.read('al3-1');
    const observation = record.result?.usageObservation ?? null;
    ctx.assert(observation !== null,
      `结果里必须带 usageObservation（否则无法分清三层）：${JSON.stringify(Object.keys(record.result ?? {}))}`);
    ctx.equal(typeof observation.seen, 'number', 'seen 必须是数字');
    ctx.equal(typeof observation.invalid, 'number', 'invalid 必须是数字');
    ctx.equal(observation.accepted, observation.seen - observation.invalid,
      'accepted 必须等于 seen - invalid（内部一致）');
    ctx.assert(observation.seen >= 1,
      `前置条件：这个 fake 场景应当发出多条 usage_update，实际 seen=${observation.seen}`);
    ctx.assert(record.result.usageSeries !== null,
      `收到 ${observation.seen} 条之后应当有样本（这同时证明 accepted > 0）`);
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});

suite.test('独立观察者必须能分清「收集器没计入」与「线上没来」（AL3 路径 B）', async ctx => {
  // 复核 AM6 / 实施指南 §2.2 的核心问题：`usageObservation.seen` 的加一
  // **就在被诊断的收集分支内部**，所以 `seen === 0` 无法排除收集层故障。
  // 要分清，必须在**被诊断代码之外**另设观察点。
  //
  // 这条测试固定两件事：
  //   ① 桥的 `observeClient` 钩子**真的被调用**（否则探针那份观察者根本没挂上）；
  //   ② 由它建立的独立观察者能看到**线上真实的 `usage_update`**，
  //      而收集器计数来自**另一条**路径 —— 两者可以是不同的数字。
  const { Store } = await import('../src/store.mjs');
  const { SessionMap } = await import('../src/session-map.mjs');
  const { Bridge } = await import('../src/orchestration.mjs');
  const { AcpClient } = await import('../src/acp-client.mjs');
  const { contract, testWorker, assertOfflineSpec } = await import('./fixtures.mjs');
  const { join } = await import('node:path');

  const root = ctx.tempDir('al3b-');
  const store = new Store(join(root, 'state')).init().lock();
  const wire = [];               // 独立观察者记下的线上通知
  const observeClientCalls = [];
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    log: () => {},
    defaults: { provider: 'deepseek-official', modelId: 'deepseek-flash' },
    worker: { ...testWorker({ FAKE_SCENARIO: 'usage_series', FAKE_STATE: join(root, 'agent.json') }), dshHome: join(root, 'dsh-home') },
    createClient: (spec, hooks) => { assertOfflineSpec(spec); return new AcpClient(spec, hooks); },
    // 与探针**同一写法**的独立观察者
    observeClient: client => {
      observeClientCalls.push(client);
      client.onUpdate(params => {
        const update = params?.update;
        if (update?.sessionUpdate !== 'usage_update') return;
        wire.push({ used: update.used, size: update.size });
      });
    },
  });
  try {
    await bridge.delegate(contract({ id: 'al3b', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
    const deadline = Date.now() + 5000;
    while (['queued', 'dispatching', 'running'].includes(store.read('al3b').status)
      && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    const result = store.read('al3b').result ?? {};
    const collector = result.usageObservation ?? null;

    // ① 钩子必须被调用过（否则探针的观察者静默失效）
    ctx.assert(observeClientCalls.length >= 1,
      `observeClient 钩子必须被调用（每次建 client 一次），实际 ${observeClientCalls.length} 次`);

    // ② 独立观察者必须看到线上的 usage_update
    ctx.assert(wire.length >= 1,
      `独立观察者应当看到线上 usage_update，实际 ${wire.length} 条`);
    ctx.assert(wire.every(w => Number.isFinite(w.used) && Number.isFinite(w.size)),
      `线上观察者必须拿到可用的 used/size：${JSON.stringify(wire)}`);

    // ③ 两个计数来自**不同路径**，且这次应当一致（都 > 0）
    ctx.assert(collector !== null,
      `结果里应当有 usageObservation：${JSON.stringify(Object.keys(result))}`);
    ctx.assert(collector.seen >= 1,
      `收集器应当计入通知，实际 ${collector.seen}`);
    ctx.equal(collector.seen, wire.length,
      `本次两者应当一致（线上 ${wire.length} / 收集器 ${collector.seen}）；`
      + `若不一致就说明收集层漏记，而那正是这条观测能区分的东西`);

    // ④ **可区分性本身**：字段齐全时，"线上 > 0 而收集器为 0"是可表达的
    const dropScenario = { wire: wire.length, seen: 0 };
    ctx.assert(dropScenario.wire > 0 && dropScenario.seen === 0,
      '必须能表达"线上有、收集器没有"这一情形（AM6 缺的就是这一问）');
  } finally {
    await bridge.shutdown().catch(() => {});
    store.unlock();
  }
});
