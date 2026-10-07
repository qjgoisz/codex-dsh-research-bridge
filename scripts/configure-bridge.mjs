#!/usr/bin/env node
import { readFileSync, lstatSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { BUILT_IN_CONFIG, validateConfig, defaultConfigPath } from '../src/config.mjs';
import { planProviderSync, applyProviderSync } from '../src/platform/provider-sync.mjs';
import { readConfiguredCatalogue } from '../src/platform/catalogue.mjs';
import { desktopWorkerConfig } from '../src/platform/desktop.mjs';

const fields = Object.keys(BUILT_IN_CONFIG).filter(key => key !== 'schema');
const nullable = new Set(['reasoningEffort', 'dshHome', 'dshRoot', 'workerCommand', 'workerArgs', 'workerEntry', 'nodeBin', 'profile']);
const hints = {
  reasoningEffort: 'provider 的档位，例如 off/low/high/max；null 沿用默认',
  exposeModelChoice: 'true / false', transport: 'direct / posix-pipes（Linux）',
  approvalMode: 'ask / deny / allow-once；allow-once 自动批准单次操作',
  workerArgs: '完整 argv 的 JSON 字符串数组；null 使用默认 profile 参数',
  workerCommand: '可执行文件路径；null 自动发现', workerEntry: 'JS 入口路径；null 自动发现',
  dshHome: '用户配置目录，通常 ~/.dsh；账号登录时与 Desktop 共用',
  dshRoot: 'DSH npm 包目录；Desktop 请使用 --desktop，预置会清空此字段',
  provider: '微信/账号登录用 deepseek-account；API 密钥用 deepseek-official',
  nodeBin: 'JS 运行时路径；null 使用当前 Node', profile: 'DSH profile；null 恢复 acp',
};
const desktopPathHints = `Desktop 路径说明：
  macOS 应用包以 .app 结尾，例如 /Applications/<应用名>.app
  macOS 资源目录以 .app/Contents/Resources 结尾（大写 Resources）
  Linux 安装根目录没有固定后缀，例如 /usr/lib/deepseek-harness
  Linux/Windows 资源目录通常以 resources 结尾
  所选目录下应能定位 runtime/cli/bin/dsh（Windows 为 dsh.exe）
  --desktop 支持安装根目录、macOS .app 或资源目录；不要填写用户配置目录 ~/.dsh。
`;
const authenticationHints = `认证说明：deepseek-account 使用 Desktop 微信/账号登录；deepseek-official 需要 DEEPSEEK_API_KEY。
复用账号登录时，桥与 Desktop 应使用相同 dshHome/DSH_HOME，桥仍使用 acp profile。
Desktop 预置保留 provider/model，不会自动切换认证方式。
`;
const help = `交互式桥配置（读取 DSH 模型；可双重确认同步提供商；不启动 DSH）
用法：node scripts/configure-bridge.mjs [选项]
  --config FILE       配置文件，默认启动目录的 bridge.config.json
  --set KEY VALUE     设置字段，可重复；有 --set 时跳过字段问答
  --yes               预览校验后直接保存；无 --set 时使用当前值/默认值
  --check             仅预览校验，不问答、不写文件
  --state-root DIR    读取 DIR/models.json 的已有模型目录，默认 .bridge-state
  --desktop           交互询问 Desktop 安装目录并配置其 CLI 启动器
  --desktop-root DIR  指定 Desktop 安装目录、macOS .app 或 Resources 目录
  --cached-models     跳过 DSH 配置读取，仅使用模型缓存/手工输入
  --help              显示帮助
Enter 保留当前值；可空字段输入 null；保存前明确确认。\n跨 profile 提供商同步仅在交互模式提供，必须先答 y 再输入 SYNC；--yes 不会自动同步。
${desktopPathHints}${authenticationHints}`;

export function parseValue(key, text) {
  if (!fields.includes(key)) throw new Error(`未知或不可设置的字段：${key}`);
  if (text === 'null' && nullable.has(key)) return null;
  if (key === 'workerArgs') return JSON.parse(text);
  if (typeof BUILT_IN_CONFIG[key] === 'boolean') {
    if (!['true', 'false'].includes(text)) throw new Error(`${key} 必须是 true / false`);
    return text === 'true';
  }
  if (typeof BUILT_IN_CONFIG[key] === 'number') {
    if (!/^\d+$/.test(text)) throw new Error(`${key} 必须是正整数毫秒`);
    return Number(text);
  }
  return text;
}

export function readSnapshot(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return { path, bytes: null, raw: {}, mode: 0o600 };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`配置必须是普通文件，不接受符号链接：${path}`);
  const bytes = readFileSync(path);
  const raw = JSON.parse(bytes.toString('utf8'));
  const result = validateConfig(raw);
  if (!result.config) throw new Error(result.problems.join('\n'));
  return { path, bytes, raw, mode: stat.mode & 0o777 };
}

function candidate(raw) {
  const result = validateConfig(raw);
  if (!result.config) throw new Error(result.problems.join('\n'));
  const comments = Object.fromEntries(Object.entries(raw).filter(([key]) => key.startsWith('_') || key.startsWith('$')));
  return { value: { ...comments, ...result.config }, warnings: result.warnings };
}

export function saveConfig(snapshot, value) {
  const bytes = Buffer.from(`${JSON.stringify(candidate(value).value, null, 2)}\n`);
  const check = () => {
    const current = readSnapshot(snapshot.path);
    if (current.bytes === null ? snapshot.bytes !== null : snapshot.bytes === null || !current.bytes.equals(snapshot.bytes)) {
      throw new Error('配置在问答期间被修改，请重新运行；未覆盖外部修改。');
    }
  };
  // Cooperating configurators serialize the compare-and-replace operation.
  const lock = `${snapshot.path}.configure.lock`;
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`配置锁已存在：${lock}；确认没有配置进程后可手工删除。`);
    throw error;
  }
  const temp = `${snapshot.path}.tmp.${randomUUID()}`;
  let backup = null;
  try {
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    check();
    if (snapshot.bytes?.equals(bytes)) return { changed: false, backup: null };
    const fd = openSync(temp, 'wx', snapshot.mode);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    check();
    if (snapshot.bytes !== null) {
      backup = `${snapshot.path}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}`;
      writeFileSync(backup, snapshot.bytes, { flag: 'wx', mode: snapshot.mode });
    }
    check();
    renameSync(temp, snapshot.path);
    return { changed: true, backup };
  } finally {
    try {
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } finally {
      try { closeSync(lockFd); } finally { unlinkSync(lock); }
    }
  }
}

function cachedModels(stateRoot) {
  try {
    const doc = JSON.parse(readFileSync(join(stateRoot, 'models.json'), 'utf8'));
    if (doc.schema !== 1) return [];
    return (doc.summary?.model?.choices ?? []).flatMap(choice => {
      try {
        const pair = JSON.parse(choice.value);
        return Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string' && v.trim())
          ? [{ provider: pair[0], model: pair[1] }] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

// DSH writes are separate from saving bridge.config.json and always require
// two interactive confirmations. --yes/--check never enter this workflow.
export async function confirmProviderTransfers(config, catalogue, { ask, output, planSync = planProviderSync, applySync = applyProviderSync }) {
  let synced = 0;
  for (const other of catalogue.otherProfiles ?? []) {
    for (const provider of [...new Set(other.routes.map(route => route.provider))]) {
      const answer = await ask(`是否将 ${other.profile} 的提供商 ${provider} 同步到 ${config.profile ?? 'acp'}？[y/N]：`);
      if (!['y', 'yes'].includes(answer.toLowerCase())) continue;
      let plan;
      try { plan = await planSync(config, other.profile, provider); }
      catch (error) { output.write(`无法同步：${error.message}\n`); continue; }
      output.write(`同步预览：\n${JSON.stringify(plan, null, 2)}\n`);
      output.write(`来源模型：${other.routes.filter(route => route.provider === provider).map(route => route.model).join(', ')}\n`);
      output.write('本操作立即写入 DSH profile 并备份原文件；之后取消桥配置保存不会撤销同步。不会启动 DSH 或调用模型。\n');
      if (await ask('二次确认：输入 SYNC 写入，其他输入取消：') !== 'SYNC') {
        output.write('已取消同步，未写入 DSH 配置。\n'); continue;
      }
      try {
        const result = await applySync(plan); synced++;
        output.write(`已同步：${result.path}\n`);
        if (result.backup) output.write(`DSH 原文备份：${result.backup}\n`);
      } catch (error) { output.write(`同步失败：${error.message}\n`); }
    }
  }
  return synced;
}

export async function main(args = process.argv.slice(2), { input = process.stdin, output = process.stdout, cwd = process.cwd(), readCatalogue = readConfiguredCatalogue, planSync = planProviderSync, applySync = applyProviderSync } = {}) {
  let path = defaultConfigPath(cwd), stateRoot = join(cwd, '.bridge-state');
  let yes = false, checkOnly = false, desktop = false, desktopRoot, cacheOnly = false;
  const changes = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { output.write(help); return; }
    if (arg === '--yes') { yes = true; continue; }
    if (arg === '--check') { checkOnly = true; continue; }
    if (arg === '--cached-models') { cacheOnly = true; continue; }
    if (arg === '--desktop') { desktop = true; continue; }
    if (!['--config', '--state-root', '--desktop-root', '--set'].includes(arg)) throw new Error(`未知选项：${arg}`);
    const count = arg === '--set' ? 2 : 1;
    if (i + count >= args.length) throw new Error(`${arg} 缺少参数`);
    if (arg === '--set') { changes.push([args[++i], args[++i]]); continue; }
    const value = args[++i];
    if (arg === '--config') path = resolve(cwd, value);
    else if (arg === '--desktop-root') { desktop = true; desktopRoot = resolve(cwd, value); }
    else stateRoot = resolve(cwd, value);
  }
  if (desktop && !desktopRoot && (yes || checkOnly)) throw new Error('--desktop 搭配 --yes / --check 时必须指定 --desktop-root。');
  const snapshot = readSnapshot(path);
  let raw = { ...snapshot.raw };
  for (const [key, text] of changes) raw[key] = parseValue(key, text);
  let current = candidate(raw);
  let rl;
  try {
    let ask;
    if (!checkOnly && !yes) {
      rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
      const lines = rl[Symbol.asyncIterator]();
      ask = async prompt => {
        output.write(prompt);
        const line = await lines.next();
        if (line.done) throw new Error('输入结束，未保存配置。');
        return line.value.trim();
      };
    }
    if (desktop) {
      output.write(desktopPathHints + authenticationHints);
      if (!desktopRoot) {
        const answer = await ask('Desktop 安装目录、macOS .app 或 Resources 目录：');
        if (!answer) throw new Error('Desktop 目录为空，未保存配置。');
        desktopRoot = resolve(cwd, answer);
      }
      raw = { ...raw, ...desktopWorkerConfig(desktopRoot) };
      // Explicit field edits take precedence over the detected launch preset.
      for (const [key, text] of changes) raw[key] = parseValue(key, text);
      current = candidate(raw);
      output.write(`Desktop CLI：${current.value.workerCommand}\n仅定位入口；未启动 Desktop，未验证协议。provider/model/profile/dshHome 保持当前值。\n`);
    }
    if (!changes.length && !checkOnly && !yes) {
      if (!desktop) output.write(authenticationHints);
      output.write('Enter 保留当前值；null 重置可空字段。配置不会启动 DSH 或调用模型。\n');
      raw = { ...current.value };
      // Ask launch/home/profile first: the menu must describe the selected worker,
      // not the installation that happened to be configured before this run.
      const discoveryFields = ['dshHome', 'profile', 'dshRoot', 'workerCommand', 'workerArgs', 'workerEntry', 'nodeBin'];
      let models = [], menuSource = '缓存菜单（可能过期）';
      const choose = async (key, values) => {
        output.write(`\n${key} ${menuSource}（m 手工输入）：\n${values.map((v, i) => `  ${i + 1}) ${v}`).join('\n')}\n`);
        while (true) {
          const answer = await ask(`${key} [${raw[key]}]：`);
          if (!answer) return;
          if (answer === 'm') { await edit(key); return; }
          if (/^\d+$/.test(answer) && values[Number(answer) - 1]) { raw[key] = values[Number(answer) - 1]; return; }
          output.write('请输入菜单编号、m 或 Enter。\n');
        }
      };
      const edit = async key => {
        const hint = hints[key] ?? (key.endsWith('TimeoutMs') ? '正整数毫秒' : nullable.has(key) ? '路径或 null' : '非空字符串');
        while (true) {
          const answer = await ask(`${key} [${JSON.stringify(raw[key])}]（${hint}）：`);
          if (!answer) return;
          try {
            const next = candidate({ ...raw, [key]: parseValue(key, answer) });
            raw = next.value;
            return;
          } catch (error) { output.write(`${error.message}\n`); }
        }
      };
      if (!cacheOnly) {
        for (const key of discoveryFields) await edit(key);
        try {
          if (raw.workerArgs !== null) throw new Error('自定义 workerArgs 可能带有配置覆盖；请通过缓存或手工选择并用运行时目录核验。');
          let catalogue = await readCatalogue(raw);
          models = catalogue.routes;
          for (const other of catalogue.otherProfiles ?? []) {
            output.write(`其他 profile ${other.profile} 的配置路由（当前 ${raw.profile ?? 'acp'} 不包含，不作为可用选项）：\n`);
            for (const route of other.routes) output.write(`  ${route.provider} / ${route.model}\n`);
            output.write('需先同步提供商配置；修改桥的 provider/model 字段不会自动同步 DSH 配置。\n');
          }
          const synced = await confirmProviderTransfers(raw, catalogue, { ask, output, planSync, applySync });
          if (synced) {
            catalogue = await readCatalogue(raw);
            models = catalogue.routes;
            output.write('已重新读取目标 profile，模型菜单已刷新。\n');
          }
          menuSource = `配置菜单（${catalogue.source}；未验证认证或在线可用性）`;
          for (const warning of catalogue.warnings) output.write(`目录提示：${warning}\n`);
          output.write(`只读配置目录：${models.length} 个路由。不会启动 DSH 或调用模型。\n`);
        } catch (error) { output.write(`目录提示：${error.message}\n`); }
      }
      if (!models.length) { models = cachedModels(stateRoot); menuSource = '缓存菜单（可能过期）'; }
      if (models.length) {
        await choose('provider', [...new Set(models.map(m => m.provider))]);
        const options = [...new Set(models.filter(m => m.provider === raw.provider).map(m => m.model))];
        if (options.length) await choose('model', options); else await edit('model');
      } else {
        output.write('未发现可用模型目录缓存，请手工填写 provider/model。\n');
        await edit('provider'); await edit('model');
      }
      for (const key of fields.filter(key => !['provider', 'model', ...(!cacheOnly ? discoveryFields : [])].includes(key))) await edit(key);
      current = candidate(raw);
    }
    output.write(`\n配置预览：${path}\n${JSON.stringify(current.value, null, 2)}\n`);
    if (current.value.provider === 'deepseek-account') output.write('认证提示：使用 DSH 账号登录，无需 DEEPSEEK_API_KEY；请核对共用 dshHome 和登录状态。\n');
    else if (current.value.provider === 'deepseek-official') output.write('认证提示：此路由需要 DEEPSEEK_API_KEY；仅登录 Desktop 账号不能替代 API 密钥。\n');
    for (const warning of current.warnings) output.write(`提示：${warning}\n`);
    output.write('校验通过（结构校验；未验证 DSH 安装、凭据或模型可用性）。\n');
    if (checkOnly) { output.write('仅检查，未写入。\n'); return; }
    if (!yes && !['y', 'yes'].includes((await ask('保存配置？[y/N]：')).toLowerCase())) {
      output.write('未保存。\n'); return;
    }
    const saved = saveConfig(snapshot, current.value);
    output.write(saved.changed ? `已保存：${path}\n` : '配置没有变化，未写入或备份。\n');
    if (saved.backup) output.write(`原文件备份：${saved.backup}\n`);
  } finally { rl?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`配置失败：${error.message}\n`); process.exitCode = 1; });
}
