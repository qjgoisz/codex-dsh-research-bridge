// Only processes started by the bridge may be signalled. POSIX groups and
// Windows process trees have different semantics; observations remain explicit.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export function processTarget(pid, platform = process.platform) {
  return platform === 'win32' ? pid : -pid;
}
export function signalWorker(child, signal, platform = process.platform) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return false;
  if (platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
        { windowsHide: true, stdio: 'ignore', timeout: 2000 });
      return true;
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      throw Object.assign(new Error('windows_tree_termination_unconfirmed'), { code: 'tree_signal_failed', cause: error });
    }
  }
  try { process.kill(-child.pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export function observeWorker(pid, platform = process.platform) {
  try { process.kill(processTarget(pid, platform), 0); return { alive: true, observable: true }; }
  catch (error) {
    if (error.code === 'ESRCH') return { alive: false, observable: true };
    return { alive: null, observable: false, code: error.code };
  }
}
export async function terminateTree(child, { graceMs = 2000, killMs = 3000 } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return { code: child?.exitCode ?? null, signal: child?.signalCode ?? null, observed: true, escalated: false };
  let listener;
  const closed = new Promise(resolve => { listener = (code, signal) => resolve({ code, signal }); child.once('close', listener); });
  const bounded = async ms => {
    let timer;
    try { return await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  };
  let escalated = false;
  try {
    if (process.platform === 'win32') {
      try { await execute('taskkill.exe', ['/PID', String(child.pid), '/T'], { windowsHide: true, timeout: graceMs }); }
      catch { /* force below if exit is not observed */ }
    } else signalWorker(child, 'SIGTERM');
    let result = await bounded(graceMs);
    if (!result) { escalated = true; signalWorker(child, 'SIGKILL'); result = await bounded(killMs); }
    return { code: result?.code ?? null, signal: result?.signal ?? null, observed: result !== null, escalated };
  } finally { child.removeListener('close', listener); }
}
