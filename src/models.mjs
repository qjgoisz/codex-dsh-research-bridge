

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const cataloguePublished = summary => (summary?.model?.choices ?? []).length > 0;

export const MODEL_CONFIG_ID = 'model';
export const REASONING_CONFIG_ID = 'reasoning_effort';

export const PROVIDER_DEFAULT_REASONING = '';

export const DEFAULT_PROVIDER = 'deepseek-official';
export const DEFAULT_MODEL_ID = 'deepseek-flash';
export const DEFAULT_MODEL = encodeModelSelector(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);
export const DEFAULT_REASONING_EFFORT = 'high';

export function encodeModelSelector(provider, model) {
  if (typeof provider !== 'string' || provider.length === 0) throw new ModelCatalogueError('invalid_provider');
  if (typeof model !== 'string' || model.length === 0) throw new ModelCatalogueError('invalid_model_id');
  return JSON.stringify([provider, model]);
}

export function decodeModelSelector(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string')) {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch { /* not the documented encoding */ }
  return null;
}

const CATALOGUE_FILE = 'models.json';
const CATALOGUE_SCHEMA = 1;

export class ModelCatalogueError extends Error {
  constructor(code, message, hint) {
    super(message ?? code);
    this.name = 'ModelCatalogueError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function flattenSelectOptions(option) {
  const out = [];
  if (!isPlainObject(option) || !Array.isArray(option.options)) return out;
  for (const entry of option.options) {
    if (!isPlainObject(entry)) continue;
    if (Array.isArray(entry.options)) {
      for (const inner of entry.options) {
        if (isPlainObject(inner) && typeof inner.value === 'string') {
          out.push({ value: inner.value, name: inner.name ?? inner.value, group: entry.group ?? entry.name ?? null });
        }
      }
      continue;
    }
    if (typeof entry.value === 'string') {
      out.push({ value: entry.value, name: entry.name ?? entry.value, group: null });
    }
  }
  return out;
}

export function summarizeConfigOptions(configOptions) {
  const list = Array.isArray(configOptions) ? configOptions : [];
  const modelOption = list.find(option => option?.id === MODEL_CONFIG_ID) ?? null;
  const reasoningOption = list.find(option => option?.id === REASONING_CONFIG_ID) ?? null;
  return {
    model: modelOption === null ? null : {
      currentValue: typeof modelOption.currentValue === 'string' ? modelOption.currentValue : null,
      choices: flattenSelectOptions(modelOption),
    },
    reasoning: reasoningOption === null ? null : {
      currentValue: typeof reasoningOption.currentValue === 'string' ? reasoningOption.currentValue : null,
      choices: flattenSelectOptions(reasoningOption),
    },
  };
}

export function modelValues(summary) {
  const values = (summary?.model?.choices ?? []).map(choice => choice.value);
  if (summary?.model?.currentValue) values.unshift(summary.model.currentValue);
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

export function reasoningValues(summary) {
  if (!summary?.reasoning) return [];
  const values = summary.reasoning.choices.map(choice => choice.value);
  if (typeof summary.reasoning.currentValue === 'string') values.unshift(summary.reasoning.currentValue);
  return [...new Set(values.filter(value => typeof value === 'string'))];
}

export function validateModelSelection(summary, requested, { explicit = true } = {}) {
  if (requested === undefined || requested === null || requested === '') return { status: 'ok' };
  const values = modelValues(summary);
  if (values.includes(requested)) return { status: 'ok', value: requested };

  if (!cataloguePublished(summary) || values.length === 0) {
    return {
      status: 'unknown',
      value: requested,
      message: '该 worker 未公布模型目录，无法预先校验；将由 worker 裁定。',
    };
  }
  if (explicit) {
    return {
      status: 'invalid',
      value: requested,
      message: `模型 ${requested} 不在当前 worker 公布的目录中。`,
      candidates: values,
    };
  }
  return {
    status: 'unavailable',
    value: requested,
    message: `桥的默认模型 ${requested} 不在该 worker 公布的目录中；将尝试设置，若 worker 拒绝则报错。`,
    candidates: values,
  };
}

export function validateReasoningSelection(summary, requested) {
  if (requested === undefined || requested === null || requested === PROVIDER_DEFAULT_REASONING) return { status: 'ok' };
  if (!summary?.reasoning) {
    return {
      status: 'unsupported',
      value: requested,
      message: '当前模型未声明推理档位；该设置会被跳过，不会导致任务失败。',
    };
  }
  const values = reasoningValues(summary);
  if (values.includes(requested)) return { status: 'ok', value: requested };
  return {
    status: 'invalid',
    value: requested,
    message: `推理档位 ${requested} 不在当前选项内。`,
    candidates: values,
  };
}

export class CatalogueCache {
  #path;

  constructor(stateRoot) {
    if (typeof stateRoot !== 'string' || stateRoot.length === 0) throw new ModelCatalogueError('invalid_root');
    this.#path = join(stateRoot, CATALOGUE_FILE);
  }

  get path() { return this.#path; }

  read() {
    if (!existsSync(this.#path)) return null;
    let doc;
    try {
      doc = JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch {
      return null;
    }
    if (!isPlainObject(doc) || doc.schema !== CATALOGUE_SCHEMA || !isPlainObject(doc.summary)) return null;
    return doc;
  }

  ageMs(now = Date.now()) {
    const doc = this.read();
    if (!doc?.at) return null;
    const then = Date.parse(doc.at);
    return Number.isFinite(then) ? Math.max(0, now - then) : null;
  }

  write({ dshHome, summary, at = new Date().toISOString() }) {
    mkdirSync(this.#path.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, `${JSON.stringify({
      schema: CATALOGUE_SCHEMA, at, dshHome, summary,
    }, null, 2)}\n`, { mode: 0o600 });
    return this.read();
  }
}

export function resolveSelection({ requestedModel, requestedReasoning, defaults = {} } = {}) {

  const modelExplicit = typeof requestedModel === 'string' && requestedModel.length > 0;
  const reasoningExplicit = requestedReasoning !== undefined;
  const defaultModel = typeof defaults.model === 'string' && defaults.model.length > 0 ? defaults.model : DEFAULT_MODEL;
  const defaultReasoning = defaults.reasoningEffort === undefined || defaults.reasoningEffort === null
    ? DEFAULT_REASONING_EFFORT
    : defaults.reasoningEffort;
  const model = modelExplicit ? requestedModel : defaultModel;
  const reasoningEffort = reasoningExplicit ? requestedReasoning : defaultReasoning;
  return {
    model,
    reasoningEffort: reasoningEffort === null ? PROVIDER_DEFAULT_REASONING : reasoningEffort,
    modelExplicit,
    reasoningExplicit,
  };
}

export function summaryToOptions(summary) {
  if (!isPlainObject(summary)) return [];
  const options = [];
  if (summary.model) {
    options.push({
      id: MODEL_CONFIG_ID, type: 'select', currentValue: summary.model.currentValue,
      options: regroup(summary.model.choices),
    });
  }
  if (summary.reasoning) {
    options.push({ id: REASONING_CONFIG_ID, type: 'select', currentValue: summary.reasoning.currentValue, options: summary.reasoning.choices });
  }
  return options;
}

function regroup(choices) {
  const groups = new Map();
  for (const choice of choices) {
    const key = choice.group ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ value: choice.value, name: choice.name });
  }
  if (groups.size === 1 && groups.has(null)) return groups.get(null);
  return [...groups.entries()].map(([group, options]) => ({
    group: group ?? '', name: group ?? '', options,
  }));
}

export async function applySelection({ client, sessionId, selection, summary = null }) {
  const applied = { requested: { ...selection }, model: null, reasoningEffort: null, notes: [], summaryAfter: null };
  let options = Array.isArray(summary) ? summary : summaryToOptions(summary);

  try {
    const afterModel = await client.setConfigOption({
      sessionId, configId: MODEL_CONFIG_ID, value: selection.model,
    });
    options = afterModel?.configOptions ?? options;
    applied.model = selection.model;
  } catch (error) {
    throw new ModelCatalogueError(
      'model_rejected',
      `worker 拒绝了模型 ${selection.model}：${error.message}`,
      '用 `dsh-bridge models --refresh` 取回该 worker 实际公布的模型清单，再改契约或改默认值。',
    );
  }

  const latest = summarizeConfigOptions(options);
  applied.summaryAfter = latest;

  if (selection.reasoningEffort === PROVIDER_DEFAULT_REASONING) {
    applied.reasoningEffort = PROVIDER_DEFAULT_REASONING;
    applied.notes.push('推理档位保持 provider 默认');
    return applied;
  }
  if (latest.reasoning === null) {
    applied.notes.push('该模型未声明推理档位，已跳过设置');
    return applied;
  }
  try {
    const afterReasoning = await client.setConfigOption({
      sessionId, configId: REASONING_CONFIG_ID, value: selection.reasoningEffort,
    });
    options = afterReasoning?.configOptions ?? options;
    applied.reasoningEffort = selection.reasoningEffort;
    applied.summaryAfter = summarizeConfigOptions(options);
  } catch (error) {
    throw new ModelCatalogueError(
      'reasoning_rejected',
      `worker 拒绝了推理档位 ${selection.reasoningEffort}：${error.message}`,
      `该模型公布的档位：${reasoningValues(latest).map(value => value || '(provider 默认)').join(', ') || '(无)'}`,
    );
  }
  return applied;
}

export function describeSelector(value) {
  return decodeModelSelector(value);
}
