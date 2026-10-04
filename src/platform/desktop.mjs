// Inspect public CLI launchers without starting Desktop or depending on its
// internal provider/profile packages. Unknown layouts require an explicit entry.
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function desktopWorkerConfig(root, { platform = process.platform } = {}) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new Error('Desktop 安装目录不能为空。');
  const directory = resolve(root);
  if (!statSync(directory).isDirectory()) throw new Error('Desktop 安装位置必须是目录。');
  const resources = [join(directory, 'resources'), join(directory, 'Contents', 'Resources'), directory];
  const name = platform === 'win32' ? 'dsh.exe' : 'dsh';
  const candidates = resources.map(path => join(path, 'runtime', 'cli', 'bin', name));
  const found = new Map();
  for (const path of candidates) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK);
      found.set(realpathSync(path), path);
    } catch { /* Missing or inaccessible launcher: try another supported layout. */ }
  }
  if (found.size > 1) throw new Error('发现多个 Desktop CLI 入口，请指定更精确的 Resources 目录。');
  if (!found.size) {
    const extra = platform === 'win32' ? ' .cmd/.bat 不能直接作为 worker；请使用已验证的运行时与 JS 入口配置。' : '';
    throw new Error(`未找到可执行的 Desktop CLI 启动器（runtime/cli/bin/${name}）。${extra} 可继续手工配置 workerCommand 或 workerEntry；不要使用图形应用启动器代替 CLI。`);
  }
  return {
    workerCommand: [...found.values()][0], workerArgs: null,
    workerEntry: null, nodeBin: null, dshRoot: null, transport: 'direct',
  };
}
