import { launchWorker } from './platform/launch.mjs';
import { signalWorker, observeWorker, terminateTree } from './platform/process.mjs';
export { buildLaunch, TRANSPORTS } from './platform/launch.mjs';
export const trackedWorkers = new Map();
let currentOwner = null;
export function setWorkerOwner(owner) { currentOwner = owner ?? null; }
export function spawnWorker(spec) {
  if (spec.stdinHolder) throw new Error('stdin_holder_not_supported');
  const child = launchWorker(spec);
  if (process.env.DSH_TEST_TRACK_WORKERS === '1' && child.pid) {
    trackedWorkers.set(child.pid, { child, owner: currentOwner });
    child.once('exit', () => trackedWorkers.delete(child.pid));
    child.once('error', () => trackedWorkers.delete(child.pid));
  }
  return child;
}
export function trackedWorkerCount(owner = null) {
  return [...trackedWorkers.values()].filter(e => owner === null || e.owner === owner).length;
}
export function killTrackedWorkers(owner = null, options = {}) {
  const killed = [], stillAlive = [], started = Date.now();
  for (const [pid, entry] of trackedWorkers) {
    if (owner !== null && entry.owner !== owner) continue;
    try {
      if (options.signal) options.signal(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      else signalWorker(entry.child, 'SIGKILL');
      killed.push(pid);
    } catch { /* observation below remains authoritative */ }
    const observation = options.isAlive ? { alive: options.isAlive(pid) } : observeWorker(pid);
    if (observation.alive !== false) stillAlive.push(pid);
    else trackedWorkers.delete(pid);
  }
  return { killed, tookMs: Date.now() - started, stillAlive };
}
export const terminateWorker = terminateTree;
