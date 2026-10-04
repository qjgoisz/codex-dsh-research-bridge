import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { createSuite } from './harness.mjs';
import { Store } from '../src/store.mjs';
import { SessionMap } from '../src/session-map.mjs';
import { Bridge } from '../src/orchestration.mjs';
import {
  canonicalJson, fingerprintOf, verifyFingerprint, describeFile, describeArtifacts,
} from '../src/fingerprint.mjs';
import { contract, testWorker } from './fixtures.mjs';

export const suite = createSuite('可复现性：契约指纹与交付物指纹');

suite.test('历史路由：重启改默认供应商/模型后仍报告执行快照；旧记录须标来源', async ctx => {
  const root = ctx.tempDir('route-history-');
  const stateRoot = join(root, 'state');
  const build = defaults => {
    const store = new Store(stateRoot).init().lock();
    return new Bridge({ store, sessions: SessionMap.fromStore(store.readSessions()),
      defaults, worker: { ...testWorker(), dshHome: join(root, 'dsh-home') }, log: () => {} });
  };
  const first = build({ provider: 'deepseek-official', modelId: 'deepseek-flash', reasoningEffort: 'high' });
  try {
    const r = await first.delegate(contract({ id: 'route-history', workspace: root }), { wait: true });
    ctx.equal(r.status, 'completed');
    ctx.equal(r.modelSource, 'snapshot');
  } finally { await first.shutdown(); first.store.unlock(); }
  const taskFile = join(stateRoot, 'tasks', 'route-history.json');
  const query = async expectedSource => {
    const next = build({ provider: 'other-provider', modelId: 'small-model', reasoningEffort: 'low' });
    try {
      const r = next.status('route-history');
      ctx.equal(r.modelSource, expectedSource);
      const observed = expectedSource !== 'requested';
      ctx.equal(r.provider, observed ? 'deepseek-official' : 'other-provider');
      ctx.equal(r.model, observed ? 'deepseek-flash' : 'small-model');
      ctx.equal(r.modelSelector, JSON.stringify(observed
        ? ['deepseek-official', 'deepseek-flash'] : ['other-provider', 'small-model']));
    } finally { await next.shutdown(); next.store.unlock(); }
  };
  await query('snapshot');
  const doc = JSON.parse(readFileSync(taskFile, 'utf8'));
  delete doc.record.appliedRoute;
  writeFileSync(taskFile, JSON.stringify(doc));
  await query('session');
  doc.record.sessionGeneration = (doc.record.sessionGeneration ?? 0) + 1;
  writeFileSync(taskFile, JSON.stringify(doc));
  await query('requested');
  doc.record.sessionGeneration = 0;
  doc.record.sessionId = 'not-the-current-session';
  writeFileSync(taskFile, JSON.stringify(doc));
  await query('requested');
});

const makeBridge = (ctx, { scenario = 'normal', env = {} } = {}) => {
  const root = ctx.tempDir('provenance-');
  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker({ FAKE_SCENARIO: scenario, ...env }), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  return { root, store, bridge };
};

suite.test('指纹与 JSON 的键序无关，与内容有关', ctx => {
  const a = { objective: 'x', permissions: { writePaths: ['/p'], network: false } };
  const b = { permissions: { network: false, writePaths: ['/p'] }, objective: 'x' };
  ctx.equal(fingerprintOf(a), fingerprintOf(b), '仅仅键序不同不应改变指纹');
  ctx.equal(canonicalJson(a), canonicalJson(b));
  ctx.assert(fingerprintOf(a) !== fingerprintOf({ ...a, objective: 'y' }), '内容变化必须改变指纹');
  ctx.assert(fingerprintOf(a).startsWith('sha256:'), '格式必须带算法前缀，便于将来换算法时被识别');
  ctx.assert(fingerprintOf([1, 2]) !== fingerprintOf([2, 1]), '数组顺序是有意义的，必须影响指纹');
});

suite.test('落盘的契约与提交时一致：可核对（P2 判据之一）', async ctx => {
  const { store, bridge, root } = makeBridge(ctx);
  const submitted = contract({ id: 'prov-1', workspace: root, permissions: { writePaths: [join(root, 'Results')] } });
  await bridge.delegate(submitted, { wait: true });

  const record = store.read('prov-1');
  ctx.assert(record.contractFingerprint, 'admission 时必须记下指纹');
  ctx.equal(record.contractFingerprint, fingerprintOf(submitted), '指纹必须就是提交内容的指纹');
  ctx.deepEqual(verifyFingerprint(record), { ok: true, actual: record.contractFingerprint });
  await bridge.shutdown();
  store.unlock();
});

suite.test('演示：契约被事后改过，指纹核对必须报错（判据要求"能失败"）', async ctx => {
  const { store, bridge, root } = makeBridge(ctx);
  await bridge.delegate(contract({ id: 'prov-2', workspace: root, permissions: { writePaths: [root] } }), { wait: true });
  const before = store.read('prov-2');
  ctx.equal(verifyFingerprint(before).ok, true, '先确认原状是通过的');

  // 直接改磁盘上的契约，模拟"事后被编辑过"——这正是要能被发现的情形。
  const tampered = { ...before, contract: { ...before.contract, objective: '被改过的目标' } };
  const verdict = verifyFingerprint(tampered);
  ctx.equal(verdict.ok, false, '契约被改过时核对必须失败');
  ctx.equal(verdict.reason, 'contract_changed');
  ctx.assert(verdict.expected !== verdict.actual, '应当同时给出期望值与实际值，便于定位');

  // 而且丢记录或丢契约也要给明确原因，而不是静默通过。
  ctx.equal(verifyFingerprint({ ...before, contractFingerprint: null }).reason, 'no_fingerprint_recorded');
  ctx.equal(verifyFingerprint({ ...before, contract: null }).reason, 'no_contract_stored');
  await bridge.shutdown();
  store.unlock();
});

suite.test('交付物指纹：存在的文件记摘要，不存在的路径如实记为 exists:false', async ctx => {
  const root = ctx.tempDir('artifacts-');
  const real = join(root, 'result.txt');
  writeFileSync(real, '结论：m 的二阶系数为 3/2\n');
  const missing = join(root, 'not-created.md');

  const one = await describeFile(real);
  ctx.equal(one.exists, true);
  ctx.assert(one.fingerprint?.startsWith('sha256:'), '存在的文件必须带摘要');
  ctx.equal(one.bytes, Buffer.byteLength('结论：m 的二阶系数为 3/2\n'));
  ctx.assert(one.mtime, '应当记下修改时间');

  // A6：只断言 `sha256:` 前缀测不出摘要是否正确 —— 把摘要换成固定前缀加 64 个 0 也能通过。
  // 这里改为与**独立算出的已知值**比较，并验证「同长度内容变化也必须改变摘要」。
  const knownContent = "结论：m 的二阶系数为 3/2\n";
  const knownFile = join(root, "known.txt");
  writeFileSync(knownFile, knownContent);
  const known = await describeFile(knownFile);
  const expectedDigest = createHash("sha256").update(readFileSync(knownFile)).digest("hex");
  ctx.equal(known.fingerprint, `sha256:${expectedDigest}`,
    "摘要必须是文件字节的真实 sha256，而不是形状正确的固定串");

  // 内容变化必须改变摘要（且长度相同，排除"长度变了所以变了"）
  const sameLengthFile = join(root, "known-swapped.txt");
  writeFileSync(sameLengthFile, knownContent.replace("3/2", "5/2"));
  const swapped = await describeFile(sameLengthFile);
  ctx.equal(swapped.bytes, known.bytes, "两个文件必须等长，否则这条断言测不出摘要是否真的看内容");
  ctx.assert(swapped.fingerprint !== known.fingerprint,
    `等长但内容不同必须得到不同摘要：${known.fingerprint}`);

  const absent = await describeFile(missing);
  ctx.equal(absent.exists, false);
  ctx.equal(absent.reason, 'not_found', '不存在的交付物要如实记为 not_found，不能省略');

  const many = await describeArtifacts([real, missing], { max: 1 });
  ctx.equal(many.total, 2);
  ctx.equal(many.truncated, 1, '超出上限的部分要被计数，而不是消失');
  ctx.equal(many.entries.length, 1);
});

suite.test('成功结算会把交付物指纹写进记录', async ctx => {
  const root = ctx.tempDir('provenance-art-');
  const outputDir = join(root, 'Results');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'answer.json'), '{"m2": 1.5}\n');

  const store = new Store(join(root, 'state')).init().lock();
  const bridge = new Bridge({
    store,
    sessions: SessionMap.fromStore(store.readSessions()),
    worker: { ...testWorker(), dshHome: join(root, 'dsh-home') },
    log: () => {},
  });
  // writePaths 通常声明的是**目录**；契约也允许直接声明一个文件。
  const declaredFile = join(outputDir, 'answer.json');
  await bridge.delegate(contract({
    id: 'prov-3',
    workspace: root,
    permissions: { writePaths: [outputDir, declaredFile, join(root, 'missing-dir')] },
  }), { wait: true });

  const record = store.read('prov-3');
  const artifacts = record.result.artifacts;
  ctx.assert(artifacts, '完成记录里应当有交付物区块');
  ctx.equal(artifacts.total, 3);

  const asFile = artifacts.entries.find(entry => entry.path === declaredFile);
  ctx.equal(asFile.exists, true);
  ctx.assert(asFile.fingerprint?.startsWith('sha256:'), `交付文件必须有摘要：${JSON.stringify(asFile)}`);
  ctx.equal(asFile.bytes, Buffer.byteLength('{"m2": 1.5}\n'));

  const asDir = artifacts.entries.find(entry => entry.path === outputDir);
  ctx.equal(asDir.exists, true);
  ctx.equal(asDir.reason, 'not_a_regular_file', '目录要如实标注，而不是被当成文件去摘要');

  const absent = artifacts.entries.find(entry => entry.path === join(root, 'missing-dir'));
  ctx.equal(absent.exists, false, '未产出的路径如实记为不存在');
  ctx.equal(absent.reason, 'not_found');
  await bridge.shutdown();
  store.unlock();
});
