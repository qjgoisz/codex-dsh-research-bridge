// The Linux pipe wrapper is an opt-in compatibility adapter. Shell text is
// constant; all user values are separate argv. Native direct is the default.
import { spawn } from 'node:child_process';
const PIPE_WRAPPER = '/bin/cat | "$@" 2> >(/bin/cat >&2) | /bin/cat; dsh_status=${PIPESTATUS[1]}; wait; exit "$dsh_status"';
export const TRANSPORTS = Object.freeze(['direct', 'posix-pipes']);
export function buildLaunch({ command, args = [], transport = 'direct' }, platform = process.platform) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('invalid_launch_command');
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('invalid_launch_args');
  if (!TRANSPORTS.includes(transport)) throw new Error(`unsupported_transport:${transport}`);
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command))
    throw new Error('windows_batch_launcher_requires_explicit_runtime: use node.exe and the DSH JS entry');
  if (transport === 'direct') return { command, args: [...args], transport };
  if (platform !== 'linux') throw new Error('posix_pipes_requires_linux');
  return { command: '/bin/bash', args: ['--noprofile', '--norc', '-c', PIPE_WRAPPER, 'dsh-acp-worker', command, ...args], transport };
}
export function launchWorker(spec) {
  const launch = buildLaunch(spec);
  return spawn(launch.command, launch.args, {
    cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    detached: process.platform !== 'win32', windowsHide: true,
  });
}
