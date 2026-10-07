// Explicit provider transfer; the planner is read-only and its preview never
// contains endpoint headers, inline keys, or unevaluated credential expressions.
import { readFileSync, lstatSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_DSH_HOME } from '../worker.mjs';
import { catalogueInstallation } from './catalogue.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.trim() === value && value && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const enabled = entry => entry.disabled === undefined || entry.disabled === false;
const plans = new WeakMap(); // Keep private configuration out of serializable previews.

function entriesNamed(entries, name) {
  return entries.flatMap(entry => !object(entry) || !enabled(entry) ? []
    : entry.group && Array.isArray(entry.config) ? entriesNamed(entry.config, name)
    : entry.name === name ? [entry] : []);
}

export function providerPatch(sourceEntries, targetEntries, provider) {
  if (!validId(provider)) throw new Error('提供商 id 无效。');
  const name = provider === 'deepseek-account' ? '@deepseek-ai/dsh-llm-deepseek-account'
    : provider === 'deepseek-official' ? '@deepseek-ai/dsh-llm-deepseek-api-key' : '@deepseek-ai/dsh-llm-pi-ai';
  const sources = entriesNamed(sourceEntries, name).filter(entry => name.endsWith('-pi-ai')
    ? object(entry.config?.providers) && Object.hasOwn(entry.config.providers, provider) : true);
  const targets = entriesNamed(targetEntries, name);
  if (sources.length !== 1 || targets.length !== 1 || !validId(targets[0].id)) {
    throw new Error('来源或目标提供商插件缺失、停用、动态启用或有多个实例，无法确定同步对象。');
  }
  const target = targets[0], source = sources[0];
  const sourceConfig = source.config ?? {};
  if (!object(sourceConfig) || (target.config !== undefined && !object(target.config))) throw new Error('提供商配置结构不支持同步。');
  let config, replace;
  if (name.endsWith('-pi-ai')) {
    if (!object(sourceConfig.providers[provider])) throw new Error('来源提供商配置不是对象。');
    if (target.config?.providers !== undefined && !object(target.config.providers)) throw new Error('目标 providers 结构不支持同步。');
    replace = Object.hasOwn(target.config?.providers ?? {}, provider);
    config = { ...(target.config ?? {}), providers: { ...(target.config?.providers ?? {}),
      [provider]: structuredClone(sourceConfig.providers[provider]) } };
  } else { config = structuredClone(sourceConfig); replace = true; }
  return { patch: { id: target.id, name, config }, replace };
}

function snapshot(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('配置路径不是普通文件。');
    return { path, bytes: readFileSync(path) };
  } catch (error) {
    if (error.code === 'ENOENT') return { path, bytes: null };
    throw new Error('无法安全读取配置文件。');
  }
}

export async function planProviderSync(config, sourceProfile, provider, { boot: suppliedBoot, yaml: suppliedYaml } = {}) {
  const targetProfile = config.profile ?? 'acp';
  if (![sourceProfile, targetProfile].every(p => validId(p) && !/[\\/]/.test(p) && !['.', '..'].includes(p)) || sourceProfile === targetProfile) {
    throw new Error('来源/目标 profile 无效或相同。');
  }
  if (config.workerArgs !== null && config.workerArgs !== undefined) throw new Error('自定义 workerArgs 的配置覆盖不支持自动同步。');
  const installation = catalogueInstallation(config);
  if (!installation) throw new Error('无法定位当前 worker 的 DSH 配置接口。');
  const home = resolve(config.dshHome ?? process.env.DSH_HOME ?? DEFAULT_DSH_HOME);
  const anchor = join(installation.root, 'package.json');
  const require = createRequire(anchor);
  let boot, yaml;
  try {
    boot = suppliedBoot ?? await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
    yaml = suppliedYaml ?? require('js-yaml');
  } catch { throw new Error('当前 DSH 缺少所需配置读取/序列化接口。'); }
  const watched = new Map();
  const watch = path => { if (!watched.has(path)) watched.set(path, snapshot(path)); };
  const homePatch = join(home, 'cordis.patch.yml'); watch(homePatch);
  let source, target, homePatches;
  const load = profile => {
    const dir = join(home, 'profiles', profile);
    watch(join(dir, 'package.json')); watch(join(dir, 'cordis.patch.yml'));
    const loaded = boot.loadProfileDirectory('bridge-sync', dir, anchor);
    if (loaded.skippedBundles.length) throw new Error('profile 有无法读取的 bundle，停止同步。');
    watch(join(dir, 'compatibility.json'));
    for (const layer of loaded.layers) {
      watch(join(layer.packageDir, 'package.json'));
      for (const path of layer.patchPaths) watch(path);
    }
    return loaded;
  };
  try {
    source = load(sourceProfile); target = load(targetProfile);
    homePatches = boot.loadOptionalPatches('bridge-sync', homePatch) ?? [];
  } catch { throw new Error('来源或目标 profile 配置无法完整读取；未修改文件。'); }
  const compose = (loaded, patches = loaded.patches) => boot.composeEntries([
    ...loaded.layers.map(layer => layer.patches), patches, homePatches,
  ]);
  const { patch, replace } = providerPatch(compose(source), compose(target), provider);
  const plannedEntries = compose(target, [...target.patches, patch]);
  const resultEntry = entriesNamed(plannedEntries, patch.name).find(e => e.id === patch.id);
  if (!isDeepStrictEqual(resultEntry?.config, patch.config)) {
    throw new Error('home 补丁覆盖了拟同步的配置；请先处理层级冲突，未修改文件。');
  }
  const targetPath = target.patchPath, original = watched.get(targetPath);
  // Serialize !!js as data, never execute it. Use DSH's installed YAML library.
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar',
    predicate: value => object(value) && Object.keys(value).length === 1 && typeof value.__jsExpr === 'string',
    represent: value => value.__jsExpr });
  const schema = yaml.JSON_SCHEMA.extend(js);
  const text = original.bytes?.toString('utf8') ?? '';
  // Block sequences accept an appended override, preserving original comments.
  // Flow sequences/empty documents are reserialized with an exact-byte backup.
  const first = text.split('\n').find(line => line.trim() && !line.trim().startsWith('#')) ?? '';
  const append = /^\s*-\s/.test(first) && !/^\s*(?:---|\.\.\.)\s*$/m.test(text);
  let next;
  try {
    next = Buffer.from(append ? text.replace(/\s*$/, '\n') + yaml.dump([patch], { schema, noRefs: true, lineWidth: -1 })
      : yaml.dump([...target.patches, patch], { schema, noRefs: true, lineWidth: -1 }));
  } catch { throw new Error('提供商补丁无法序列化；未输出可能含凭据的原始错误。'); }
  const preview = { sourceProfile, targetProfile, provider, targetPath,
    action: replace ? '替换目标中该提供商的完整配置；其他提供商保留' : '添加提供商；其他提供商保留',
    formatting: append ? '保留原有文本并追加覆盖补丁' : '重新序列化补丁列表；原文将备份',
    authentication: '复制配置中的认证引用及已有配置值；不读取凭据文件，不显示密钥或 headers',
    environment: '不复制来源环境文件；相对路径和表达式按目标 profile 解释，尚未验证认证'  };
  plans.set(preview, { watched, target: original, next });
  return preview;
}

export function applyProviderSync(plan) {
  const privatePlan = plans.get(plan);
  if (!privatePlan) throw new Error('同步计划无效或已使用，请重新预览。');
  const { watched, target, next } = privatePlan;
  const check = () => {
    for (const old of watched.values()) {
      const now = snapshot(old.path);
      if (old.bytes === null ? now.bytes !== null : now.bytes === null || !old.bytes.equals(now.bytes)) {
        throw new Error('配置在确认期间被修改，停止同步；请重新预览。');
      }
    }
  };
  const lock = target.path + '.bridge-sync.lock';
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw new Error('同步配置锁不可用；确认没有其他配置进程后重试。'); }
  const temp = target.path + '.tmp.' + randomUUID();
  let backup;
  try {
    writeFileSync(fd, JSON.stringify({pid:process.pid,at:new Date().toISOString()})); check();
    const out = openSync(temp, 'wx', 0o600);
    try { writeFileSync(out, next); fsyncSync(out); } finally { closeSync(out); }
    if (target.bytes !== null) {
      backup = target.path + '.bak.' + randomUUID();
      writeFileSync(backup, target.bytes, { flag:'wx',mode:0o600 });
    }
    check(); renameSync(temp,target.path); plans.delete(plan);
    return { path: target.path, backup };
  } finally {
    try { unlinkSync(temp); } catch (e) { if(e.code!=='ENOENT') throw e; }
    closeSync(fd); unlinkSync(lock);
  }
}
