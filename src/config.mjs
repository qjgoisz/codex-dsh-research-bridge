

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DEFAULT_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT,
  PROVIDER_DEFAULT_REASONING, encodeModelSelector,
} from './models.mjs';

export const CONFIG_FILE_NAME = 'bridge.config.json';

export const REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

export const EXPENSIVE_EFFORTS = Object.freeze(['max']);
export const CONFIG_SCHEMA = 2;

export const BUILT_IN_CONFIG = Object.freeze({
  schema: CONFIG_SCHEMA,
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  exposeModelChoice: false,
  promptTimeoutMs: 1_800_000,
  transport: 'direct',
  dshHome: null,
  dshRoot: null,
  profile: 'acp',
  workerCommand: null,
  workerArgs: null,
  workerEntry: null,
  nodeBin: null,
  approvalMode: 'ask',
  approvalTimeoutMs: 300_000,
  requestTimeoutMs: 30_000,
});

export class ConfigError extends Error {
  constructor(code, message, hint) {
    super(message ?? code);
    this.name = 'ConfigError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

export const defaultConfigPath = (baseDir = process.cwd()) => join(baseDir, CONFIG_FILE_NAME);

export function validateConfig(raw) {
  const problems = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { config: null, problems: ['配置必须是 JSON 对象。'], warnings };
  }

  const known = new Set(Object.keys(BUILT_IN_CONFIG));
  for (const key of Object.keys(raw)) {
    if (key.startsWith('_') || key.startsWith('$')) continue; // comments
    if (!known.has(key)) {
      problems.push(`未知配置项：${key}（可用：${[...known].join(', ')}）`);
    }
  }

  const config = { ...BUILT_IN_CONFIG };
  if (raw.schema === 1) warnings.push('schema 1 以只读兼容方式加载；不改写原文件。新默认审批为 ask。');

  if (raw.schema !== undefined && ![1, CONFIG_SCHEMA].includes(raw.schema)) {
    problems.push(`schema 必须是 ${CONFIG_SCHEMA}，收到 ${JSON.stringify(raw.schema)}`);
  }

  if (raw.provider !== undefined) {
    if (!nonEmpty(raw.provider)) problems.push('provider 必须是非空字符串，例如 deepseek-official');
    else config.provider = raw.provider.trim();
  }
  if (raw.model !== undefined) {
    if (!nonEmpty(raw.model)) problems.push('model 必须是模型 id 本身，例如 deepseek-flash（不要写 provider/model）');
    else config.model = raw.model.trim();
  }
  if (raw.reasoningEffort !== undefined) {
    if (raw.reasoningEffort === null || raw.reasoningEffort === '') {

      config.reasoningEffort = null;
    } else if (typeof raw.reasoningEffort !== 'string') {
      problems.push('reasoningEffort 必须是字符串，或 null 表示沿用 provider 默认');
    } else if (!nonEmpty(raw.reasoningEffort)) {
      problems.push(`reasoningEffort 必须是 ${REASONING_EFFORTS.join(' / ')} 之一（或 null），收到：${raw.reasoningEffort}`);
    } else {
      config.reasoningEffort = raw.reasoningEffort;
      if (EXPENSIVE_EFFORTS.includes(raw.reasoningEffort)) {
        warnings.push(`reasoningEffort=${raw.reasoningEffort} 已显式选择；含义与成本以当前 provider 公布的信息为准。`);
      }
    }
  }
  if (raw.exposeModelChoice !== undefined) {
    if (typeof raw.exposeModelChoice !== 'boolean') problems.push('exposeModelChoice 必须是布尔值');
    else config.exposeModelChoice = raw.exposeModelChoice;
  }
  if (raw.promptTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.promptTimeoutMs) || raw.promptTimeoutMs < 1) {
      problems.push('promptTimeoutMs 必须是正整数毫秒');
    } else {
      config.promptTimeoutMs = raw.promptTimeoutMs;
    }
  }
  if (raw.transport !== undefined) {
    if (!['direct', 'posix-pipes'].includes(raw.transport)) problems.push('transport 必须是 direct 或 posix-pipes');
    else config.transport = raw.transport;
  }
  for (const key of ['dshHome', 'dshRoot', 'profile', 'workerCommand', 'workerEntry', 'nodeBin']) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!nonEmpty(raw[key])) problems.push(`${key} 必须是非空字符串或 null`);
    else config[key] = raw[key].trim();
  }

  if (config.profile !== 'acp') {
    warnings.push(`profile 设为 ${config.profile}；桥的默认 preflight 与文档按 acp 编写，请确认该 profile 确实挂载了 @deepseek-ai/dsh-acp`);
  }
  if (raw.workerArgs !== undefined && raw.workerArgs !== null) {
    if (!Array.isArray(raw.workerArgs) || raw.workerArgs.some(a => typeof a !== 'string' || a.includes('\0'))) problems.push('workerArgs 必须是字符串数组或 null。');
    else config.workerArgs = [...raw.workerArgs];
  }
  if (raw.approvalMode !== undefined) {
    if (!['ask', 'deny', 'allow-once'].includes(raw.approvalMode)) problems.push('approvalMode 必须为 ask / deny / allow-once。');
    else config.approvalMode = raw.approvalMode;
  }
  for (const key of ['approvalTimeoutMs', 'requestTimeoutMs']) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 1) problems.push(`${key} 必须是正整数毫秒。`);
    else config[key] = raw[key];
  }

  return { config: problems.length === 0 ? config : null, problems, warnings };
}

export function loadConfigFile(path) {
  if (!existsSync(path)) {
    return { config: { ...BUILT_IN_CONFIG }, path: null, source: 'built-in', warnings: [] };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError('config_unreadable', `配置文件不是合法 JSON：${path}`, error.message);
  }
  const { config, problems, warnings } = validateConfig(raw);
  if (config === null) {
    throw new ConfigError('config_invalid', `配置校验未通过：${path}\n  · ${problems.join('\n  · ')}`);
  }
  return { config, path, source: 'file', warnings };
}

export function mergeFlags(config, flags = {}) {
  const merged = { ...config };
  if (nonEmpty(flags.provider)) merged.provider = flags.provider;
  if (nonEmpty(flags.model)) merged.model = flags.model;
  if (flags.reasoningEffort !== undefined) merged.reasoningEffort = flags.reasoningEffort;
  if (flags.exposeModelChoice !== undefined) merged.exposeModelChoice = flags.exposeModelChoice === true;
  if (Number.isSafeInteger(flags.promptTimeoutMs) && flags.promptTimeoutMs > 0) merged.promptTimeoutMs = flags.promptTimeoutMs;
  if (nonEmpty(flags.transport)) merged.transport = flags.transport;
  if (nonEmpty(flags.dshHome)) merged.dshHome = flags.dshHome;
  if (nonEmpty(flags.dshRoot)) merged.dshRoot = flags.dshRoot;
  if (nonEmpty(flags.profile)) merged.profile = flags.profile;
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined && Object.hasOwn(BUILT_IN_CONFIG, key)) merged[key] = value;
  }
  const validated = validateConfig(merged);
  if (!validated.config) throw new ConfigError('config_invalid', validated.problems.join('\n'));
  return validated.config;
}

export function resolvedRoute(config) {
  return {
    provider: config.provider,
    modelId: config.model,
    selector: encodeModelSelector(config.provider, config.model),
    reasoningEffort: config.reasoningEffort,
  };
}

export function writeConfigFile(path, values = {}) {
  if (existsSync(path)) {
    throw new ConfigError('config_exists', `配置文件已存在，未覆盖：${path}`, '先自行备份或指定 --config 到别的路径。');
  }
  const body = {
    _comment: [
      'Codex → DSH 桥的配置。默认路由 = provider + model（模型 id 本身，不要写 provider/model）。',
      '选择值的真实格式由 DSH 决定（JSON.stringify([provider, model])），桥会自行编码，你不要手写。',
      'reasoningEffort 由 worker 运行时目录校验；null 表示沿用 provider 默认。',
      'approvalMode=ask 将上游实际审批转交 dsh_approvals / dsh_approve；allow-once 是操作者显式选择。',
      '这里不要放任何凭据：凭据属于 DSH，由 ~/.dsh 管理。',
    ],
    schema: CONFIG_SCHEMA,
    ...BUILT_IN_CONFIG,
    ...values,
  };
  delete body.schema;
  const doc = { schema: CONFIG_SCHEMA, ...body };
  const checked = validateConfig(doc);
  if (!checked.config) throw new ConfigError('config_invalid', checked.problems.join('\n'));
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return doc;
}
