

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const PHASES = ['explore', 'numerics', 'writing', 'maintenance', 'generic'];

const has = (object, key) => Object.hasOwn(object, key);

const plainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const nonBlank = value => typeof value === 'string' && value.trim().length > 0;

export function isSafeAbsolutePath(value) {
  return nonBlank(value) && !value.includes('\0') && isAbsolute(value)
    && !value.split(sep).includes('..');
}

export function realPathOf(path, resolver = realpathSync) {
  try {
    return resolver(path);
  } catch {
    return resolve(path);
  }
}

export function canonicalize(path, resolver = realpathSync) {

  let current = resolve(path);
  const tail = [];
  for (;;) {
    const real = realPathOf(current, resolver);
    if (existsSync(real)) return resolve(join(real, ...tail.reverse()));
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.push(basename(current));
    current = parent;
  }
}

export function isWithin(parent, child, resolver) {
  const base = canonicalize(parent, resolver);
  const target = canonicalize(child, resolver);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}


function checkStringArray(value, field, errors, { nonEmpty = false, paths = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    errors.push({ field, message: nonEmpty ? '必须是非空字符串数组。' : '必须是字符串数组。' });
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!has(value, index) || !nonBlank(value[index])) {
      errors.push({ field: `${field}[${index}]`, message: '必须是非空字符串。' });
    } else if (paths && !isSafeAbsolutePath(value[index])) {
      errors.push({ field: `${field}[${index}]`, message: '必须是绝对路径，且不得含 `..` 或 NUL。' });
    }
  }
}

export function validateTaskContract(input, { exposeModelChoice = false } = {}) {
  const errors = [];
  const error = (field, message) => errors.push({ field, message });

  if (!plainObject(input)) {
    return { valid: false, errors: [{ field: '$', message: '必须是普通对象。' }] };
  }

  if (!nonBlank(input.objective)) error('objective', '必须是非空字符串：这是要交付的目标本身。');
  if (!nonBlank(input.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id)) error('id', '必须是非空字符串：任务 id 由调用方指定并用于幂等。');

  if (!nonBlank(input.phase) || !PHASES.includes(input.phase)) {
    error('phase', `必须是 ${PHASES.join(' / ')} 之一。`);
  }

  if (!isSafeAbsolutePath(input.workspace)) {
    error('workspace', '必须是绝对路径，且不得含 `..` 或 NUL：这是 worker 的工作区根。');
  }

  if (has(input, 'contextRevision') && input.contextRevision !== null
    && (!Number.isSafeInteger(input.contextRevision) || input.contextRevision < 0)) {
    error('contextRevision', '必须是 >= 0 的安全整数或 null。');
  }

  if (!plainObject(input.plan)) {
    error('plan', '必须是对象：{ summary, steps }。');
  } else {
    if (!nonBlank(input.plan.summary)) error('plan.summary', '必须是非空字符串。');
    checkStringArray(input.plan.steps, 'plan.steps', errors, { nonEmpty: true });
  }

  checkStringArray(input.acceptance, 'acceptance', errors, { nonEmpty: true });

  if (has(input, 'project') && (!nonBlank(input.project) || input.project.includes('\0'))) error('project', '必须是非空字符串。');
  if (has(input, 'research') && !plainObject(input.research)) error('research', '必须是对象。');
  if (has(input, 'deliverables')) checkStringArray(input.deliverables, 'deliverables', errors, { paths: true });
  if (has(input, 'stopIf')) checkStringArray(input.stopIf, 'stopIf', errors);

  const permissions = input.permissions ?? {};
  if (!plainObject(permissions)) error('permissions', '必须是对象。');
  const policy = { readPaths: [], writePaths: [], network: undefined, tools: undefined };
  if (plainObject(permissions)) {
    for (const field of ['readPaths', 'writePaths']) {
      if (!has(permissions, field)) continue;
      checkStringArray(permissions[field], `permissions.${field}`, errors, { paths: true });
      if (Array.isArray(permissions[field])) policy[field] = permissions[field].filter(nonBlank).map(p => resolve(p));
    }
    if (has(permissions, 'network')) {
      if (typeof permissions.network !== 'boolean') error('permissions.network', '必须是布尔值。');
      else policy.network = permissions.network;
    }
    // Optional legacy list is honored only when supplied explicitly.
    if (has(permissions, 'tools')) {
      checkStringArray(permissions.tools, 'permissions.tools', errors);
      policy.tools = Array.isArray(permissions.tools) ? permissions.tools : [];
    }
  }

  if (has(input, 'model') || has(input, 'provider') || has(input, 'reasoningEffort')) {
    if (!exposeModelChoice) {
      error(
        'model',
        '本桥未启用模型选择（配置项 exposeModelChoice 或 --expose-model-choice）。请去掉 model/provider/reasoningEffort，或由操作者启用。',
      );
    } else {

      if (has(input, 'model') && !nonBlank(input.model)) {
        error('model', '必须是模型 id，例如 deepseek-flash（不要写 provider/model，也不要写 JSON 选择值）。');
      }
      if (has(input, 'provider') && !nonBlank(input.provider)) {
        error('provider', '必须是非空字符串，例如 deepseek-official。');
      }
      if (has(input, 'reasoningEffort') && input.reasoningEffort !== null && !nonBlank(input.reasoningEffort)) {
        error('reasoningEffort', '必须是非空字符串，或 null（表示沿用 provider 默认）。');
      }
    }
  }

  if (has(input, 'reversePolicy') && input.reversePolicy !== 'consult_only') {
    error('reversePolicy', '必须是 `consult_only`：worker 只能向 Codex 提问，不能反向委派。');
  }
  if (has(input, 'allowRecursiveDelegation') && input.allowRecursiveDelegation !== false) {
    error('allowRecursiveDelegation', '必须是 false：桥不开放递归委派。');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    policy: {
      ...policy,
      workspace: resolve(input.workspace),
      phase: input.phase,
      contextRevision: Number.isSafeInteger(input.contextRevision) ? input.contextRevision : 0,

      model: nonBlank(input.model) ? input.model : undefined,
      provider: nonBlank(input.provider) ? input.provider : undefined,
      reasoningEffort: has(input, 'reasoningEffort') ? input.reasoningEffort : undefined,
    },
  };
}

export function modelRouteFingerprint(policy = {}, defaults = {}) {
  const provider = policy.provider ?? defaults.provider ?? '';
  const model = policy.model ?? defaults.modelId ?? '';

  const explicit = policy.reasoningEffort;
  const fallback = defaults.reasoningEffort === undefined ? undefined : defaults.reasoningEffort;
  const resolved = explicit === undefined ? fallback : explicit;
  const reasoning = resolved === undefined
    ? '(unset)'
    : resolved === null ? '(provider-default)' : resolved;
  return [`provider=${provider}`, `model=${model}`, `reasoning=${reasoning}`].join(';');
}

export function sessionKeyOf(contract, contextRevision = 0, policy = contract.permissions ?? {}, defaults = {}) {
  return {
    project: contract.project ?? 'default',
    phase: contract.phase,
    workspace: resolve(contract.workspace),
    contextRevision,
    capabilities: modelRouteFingerprint(policy, defaults),
  };
}

export const PHASE_NAMES = Object.freeze([...PHASES]);

// Compatibility export: this fingerprints routing, not effective tool authority.
export const capabilityFingerprint = modelRouteFingerprint;
