// Overlapping workspaces cannot execute concurrently, even when project,
// phase or route gives them different sessions. Disjoint directories can run.
import { relative, isAbsolute, sep } from 'node:path';
import { canonicalize } from './contract.mjs';
const contains = (root, child) => {
  const r = relative(root, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};
const overlap = (a, b) => contains(a, b) || contains(b, a);
export class WorkspaceQueue {
  #pending = [];
  #active = new Set();
  enqueue(workspace, job) {
    const root = canonicalize(workspace);
    return new Promise((resolve, reject) => {
      this.#pending.push({ root, job, resolve, reject }); this.#drain();
    });
  }
  #drain() {
    const waiting = [];
    for (const entry of this.#pending) {
      if ([...this.#active, ...waiting].some(e => overlap(e.root, entry.root))) { waiting.push(entry); continue; }
      this.#active.add(entry);
      Promise.resolve().then(entry.job).then(entry.resolve, entry.reject).finally(() => {
        this.#active.delete(entry); this.#drain();
      });
    }
    this.#pending = waiting;
  }
}
