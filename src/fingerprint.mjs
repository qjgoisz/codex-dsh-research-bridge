

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(item => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function fingerprintOf(value) {
  const digest = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

export function verifyFingerprint(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'record_not_an_object' };
  const expected = record.contractFingerprint;
  if (typeof expected !== 'string' || expected.length === 0) {
    return { ok: false, reason: 'no_fingerprint_recorded' };
  }
  if (!record.contract || typeof record.contract !== 'object') {
    return { ok: false, reason: 'no_contract_stored' };
  }
  const actual = fingerprintOf(record.contract);
  return actual === expected
    ? { ok: true, actual }
    : { ok: false, reason: 'contract_changed', expected, actual };
}

export async function describeFile(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return { path, exists: false, reason: 'invalid_path' };
  }
  if (!existsSync(path)) return { path, exists: false, reason: 'not_found' };
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    return { path, exists: false, reason: error.code ?? 'stat_failed' };
  }
  if (!stats.isFile()) return { path, exists: true, reason: 'not_a_regular_file' };
  try {
    const digest = await new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('error', reject);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
    });
    return { path, exists: true, bytes: stats.size, mtime: stats.mtime.toISOString(), fingerprint: digest };
  } catch (error) {
    return { path, exists: true, bytes: stats.size, reason: error.code ?? 'hash_failed' };
  }
}

export async function describeArtifacts(paths, { max = 64 } = {}) {
  const list = Array.isArray(paths) ? paths.filter(path => typeof path === 'string' && path.length > 0) : [];
  const kept = list.slice(0, max);
  const described = [];
  for (const path of kept) described.push(await describeFile(path));
  return { entries: described, total: list.length, truncated: Math.max(0, list.length - kept.length) };
}
