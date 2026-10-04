// Installation discovery is read-only. An explicit executable/runtime entry
// supports Desktop without baking a vendor's private bundle layout into core.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
export const DEFAULT_DSH_HOME = join(homedir(), '.dsh');
export const DEFAULT_WORKER_COMMAND = 'dsh';
export const WORKER_PROFILE = 'acp';
export class WorkerError extends Error {
  constructor(code, message, hint) { super(message ?? code); this.name = 'WorkerError'; this.code = code; if (hint !== undefined) this.hint = hint; }
}
export function createWorkerSpec(options = {}) {
  const { workspace, dshHome = process.env.DSH_HOME ?? DEFAULT_DSH_HOME, command, args,
    extraArgs = [], transport = 'direct', profile = WORKER_PROFILE, env = process.env,
    nodeBin = process.execPath, installationRoot, entry } = options;
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes('\0'))
    throw new WorkerError('invalid_workspace', 'worker 工作区必须是本平台的绝对路径。');
  const jsEntry = entry ?? (installationRoot ? join(installationRoot, 'lib', 'bin.js') : null);
  const detected = !command && !jsEntry ? locateDsh() : null;
  const runtimeEntry = jsEntry ?? detected?.entry;
  const resolvedCommand = command ?? (runtimeEntry ? nodeBin : DEFAULT_WORKER_COMMAND);
  const resolvedArgs = args === undefined
    ? [...(runtimeEntry && !command ? [runtimeEntry] : []), '--profile', profile, ...extraArgs]
    : args;
  if (!Array.isArray(resolvedArgs) || resolvedArgs.some(a => typeof a !== 'string')) throw new WorkerError('invalid_worker_args');
  return { ...options, command: resolvedCommand, args: [...resolvedArgs], transport, cwd: workspace,
    env: { ...env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }, dshHome, profile };
}
export function readDshInstallation(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== '@deepseek-ai/dsh') return null;
    return { name: manifest.name, version: manifest.version, root, entry: join(root, 'lib', 'bin.js') };
  } catch { return null; }
}
export function locateDsh({ installationRoot, command = DEFAULT_WORKER_COMMAND, pathEnv = process.env.PATH ?? '' } = {}) {
  if (installationRoot) return readDshInstallation(installationRoot);
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of [command, `${command}.cmd`, `${command}.exe`]) {
      const launcher = join(dir, name);
      if (!existsSync(launcher)) continue;
      try {
        let root = dirname(realpathSync(launcher));
        for (let depth = 0; depth < 5; depth++) {
          const found = readDshInstallation(root);
          if (found) return found;
          const parent = dirname(root); if (parent === root) break; root = parent;
        }
      } catch { /* try standard installation roots below */ }
      for (const root of [join(dir, 'node_modules', '@deepseek-ai', 'dsh'), join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh')]) {
        const found = readDshInstallation(root); if (found) return found;
      }
    }
  }
  return null;
}
export function preflightWorker(options = {}) {
  const { dshHome = process.env.DSH_HOME ?? DEFAULT_DSH_HOME, transport = 'direct', profile = WORKER_PROFILE,
    installationRoot, command, args, entry, nodeBin } = options;
  const problems = [], hints = [];
  const profileDir = join(dshHome, 'profiles', profile);
  const profilePresent = existsSync(join(profileDir, 'package.json'));
  const installation = locateDsh({ installationRoot, command });
  const explicit = Boolean(command || entry);
  if (!existsSync(dshHome)) problems.push(`DSH_HOME 不存在：${dshHome}`);
  // Only the npm adapter knows this profile layout. Desktop must be probed.
  if (!explicit && !profilePresent) problems.push(`DSH profile 未初始化，缺少 package.json：${profileDir}`);
  if (!explicit && !installation) problems.push('无法定位 DSH；请指定 workerCommand/workerArgs 或 dshRoot。');
  if (transport === 'posix-pipes' && process.platform !== 'linux') problems.push('posix-pipes 仅适用于 Linux。');
  if (!profilePresent && !explicit) hints.push(`请确认 DSH 安装后初始化 profile：dsh --profile ${profile} --help`);
  let launch = null;
  try { launch = createWorkerSpec({ ...options, workspace: options.workspace ?? process.cwd() }); }
  catch (error) { problems.push(error.message); }
  if (launch && /\.(cmd|bat)$/i.test(launch.command) && process.platform === 'win32') problems.push('使用 node.exe 和 JS 入口替代 .cmd/.bat。');
  if (explicit) hints.push('显式入口的配置布局与协议能力需运行 probe 核验；静态预检不证明 ACP 可用。');
  return { ok: problems.length === 0, problems, hints, profileDir, profilePresent, profile, installation,
    transport, dshHome, platform: process.platform, arch: process.arch,
    launch: launch ? { command: launch.command, args: launch.args } : null, protocol: 'unverified' };
}
