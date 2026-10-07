// Version-sensitive DSH configuration reading lives here, away from the UI.
// Never boot DSH, evaluate !!js, resolve credentials, or initialize a profile.
import { existsSync, realpathSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DSH_HOME, locateDsh, readDshInstallation } from '../worker.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(value);

export function catalogueInstallation(config) {
  if (config.dshRoot) return readDshInstallation(resolve(config.dshRoot));
  // Desktop's public launcher is outside its bundled npm tree. Inspect both
  // unpacked resource layouts; ASAR-only packages require a future adapter.
  for (const entry of [config.workerEntry, config.workerCommand].filter(Boolean)) {
    if (!existsSync(entry)) continue;
    let root = dirname(realpathSync(entry));
    for (let depth = 0; depth < 8; depth++) {
      for (const candidate of [root, join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'),
        join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')]) {
        const found = readDshInstallation(candidate);
        if (found) return found;
      }
      const parent = dirname(root); if (parent === root) break; root = parent;
    }
  }
  // An explicit worker must not silently borrow another installation on PATH.
  if (config.workerCommand || config.workerEntry) return null;
  return locateDsh();
}

export async function collectConfiguredRoutes(entries, importPackage, warnings = []) {
  const routes = new Map();
  const add = (provider, models) => {
    if (!id(provider) || !Array.isArray(models)) return;
    for (const model of models) if (object(model) && id(model.id)) {
      routes.set(JSON.stringify([provider, model.id]), { provider, model: model.id });
    }
  };
  const walk = async rows => {
    for (const entry of rows) {
      if (!object(entry)) continue;
      if (entry.disabled === true) continue;
      if (entry.disabled !== undefined && entry.disabled !== false) {
        warnings.push('跳过动态或未知 disabled 条件；未执行表达式。'); continue;
      }
      if (entry.group && Array.isArray(entry.config)) { await walk(entry.config); continue; }
      const values = object(entry.config) ? entry.config : {};
      try {
        if (['@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-account'].includes(entry.name)) {
          const deepseek = await importPackage('@deepseek-ai/dsh-llm-deepseek');
          add(entry.name.endsWith('-account') ? 'deepseek-account' : 'deepseek-official', deepseek.resolveAdapterOptions(values).models);
        } else if (entry.name === '@deepseek-ai/dsh-llm-pi-ai' && object(values.providers)) {
          for (const [provider, route] of Object.entries(values.providers)) {
            if (!object(route)) continue;
            let models = route.models;
            if (models === undefined || (Array.isArray(models) && !models.length)) {
              const pi = await importPackage('@earendil-works/pi-ai/providers/all', '@deepseek-ai/dsh-llm-pi-ai');
              models = pi.getBuiltinModels(provider);
            }
            add(provider, models);
          }
        }
      } catch {
        // Parser/provider errors may contain keys or headers: never echo them.
        warnings.push('部分提供商模型目录无法读取；未输出原始配置或解析错误。');
      }
    }
  };
  await walk(entries);
  return [...routes.values()];
}

export async function readConfiguredCatalogue(config, { includeOtherProfiles = true } = {}) {
  const installation = catalogueInstallation(config);
  if (!installation) throw new Error('未找到当前 worker 的可读 DSH 包；可使用缓存或手工输入（ASAR-only 暂不支持静态读取）。');
  const home = resolve(config.dshHome ?? process.env.DSH_HOME ?? DEFAULT_DSH_HOME);
  const profile = config.profile ?? 'acp';
  const profileDir = join(home, 'profiles', profile);
  if (!existsSync(join(profileDir, 'package.json'))) throw new Error('所选 DSH profile 尚未初始化；本脚本不会创建或迁移它。');
  const anchor = join(installation.root, 'package.json');
  const require = createRequire(anchor);
  const importPackage = async (name, parent) => {
    const resolver = parent ? createRequire(require.resolve(parent)) : require;
    return import(pathToFileURL(resolver.resolve(name)).href);
  };
  try {
    const boot = await importPackage('@deepseek-ai/dsh-app-boot');
    if (![boot.loadProfileDirectory, boot.composeEntries, boot.loadOptionalPatches].every(f => typeof f === 'function')) {
      throw new Error('unsupported');
    }
    const warnings = [];
    const loaded = boot.loadProfileDirectory('bridge-catalogue', profileDir, anchor);
    if (loaded.skippedBundles?.length) warnings.push('部分 profile bundle 不可用，模型目录可能不完整。');
    const homePatches = boot.loadOptionalPatches('bridge-catalogue', join(home, 'cordis.patch.yml')) ?? [];
    const entries = boot.composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches, homePatches],
      () => warnings.push('存在未匹配的配置补丁，模型目录可能不完整。'));
    const routes = await collectConfiguredRoutes(entries, importPackage, warnings);
    const otherProfiles = [];
    if (includeOtherProfiles) {
      for (const directory of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
        if (!directory.isDirectory() || directory.name === profile) continue;
        try {
          const other = await readConfiguredCatalogue({ ...config, profile: directory.name }, { includeOtherProfiles: false });
          const missing = other.routes.filter(route => !routes.some(r => r.provider === route.provider && r.model === route.model));
          if (missing.length) otherProfiles.push({ profile: directory.name, routes: missing, warnings: other.warnings });
        } catch { warnings.push('部分其他 profile 无法读取；未输出配置原文。'); }
      }
    }
    return { routes, otherProfiles, warnings: [...new Set(warnings)], source: `DSH ${installation.version} / profile ${profile}`, home };
  } catch {
    throw new Error('当前 DSH 的只读配置接口不兼容或配置无法解析；可使用缓存或手工输入。');
  }
}
