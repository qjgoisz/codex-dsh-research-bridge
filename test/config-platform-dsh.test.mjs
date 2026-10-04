// 离线纯函数测试：配置校验 / CLI 覆盖 / 平台启动参数 / 进程目标 / 任务契约。
//
// 范围与边界（与本任务验收一致）：
// - 只调用纯函数，不启动任何子进程、不联网、不调用模型、不读写测试数据文件。
// - 平台参数（win32 / linux / darwin）只是模拟构建参数，不代表在原生 Windows/macOS
//   上做过实测；本文件只断言函数返回的启动 argv 与进程目标语义。
// - workspace 一律用 path.resolve 生成本平台绝对路径。
//
// 运行方式（由 Codex 执行复核）：
//   node --test test/config-platform-dsh.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  validateConfig,
  mergeFlags,
  ConfigError,
  CONFIG_SCHEMA,
  BUILT_IN_CONFIG,
} from '../src/config.mjs';
import { buildLaunch } from '../src/platform/launch.mjs';
import { processTarget } from '../src/platform/process.mjs';
import { validateTaskContract } from '../src/contract.mjs';

const clone = value => structuredClone(value);

// 本平台绝对路径，避免硬编码 POSIX 前缀。
const workspace = resolve('config-platform-dsh-workspace');

function makeContract(overrides = {}) {
  return {
    id: 'task-1',
    objective: '只读源码并核对纯函数行为。',
    phase: 'maintenance',
    workspace,
    plan: { summary: '读取函数接口并写离线断言。', steps: ['读取源码', '编写断言'] },
    acceptance: ['断言可离线复现'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// config.mjs — validateConfig：schema 2 / schema 1 只读兼容
// ---------------------------------------------------------------------------

test('[config] schema 2 通过校验，输入对象不被修改', () => {
  const raw = { schema: 2, provider: 'deepseek-official', model: 'deepseek-flash' };
  const snapshot = clone(raw);

  const { config, problems, warnings } = validateConfig(raw);

  assert.notEqual(config, null, 'schema 2 应通过校验');
  assert.deepEqual(problems, []);
  assert.equal(config.schema, CONFIG_SCHEMA);
  assert.equal(config.provider, 'deepseek-official');
  assert.equal(config.model, 'deepseek-flash');
  assert.deepEqual(raw, snapshot, 'validateConfig 不得改写输入对象');
  assert.deepEqual(warnings, []);
});

test('[config] schema 1 只读兼容：可载入、带提示、不改写输入，规范化为当前 schema', () => {
  const raw = { schema: 1, provider: 'deepseek-official', reasoningEffort: 'high' };
  const snapshot = clone(raw);

  const { config, problems, warnings } = validateConfig(raw);

  assert.notEqual(config, null, '旧 schema 1 应可读取而不报错');
  assert.deepEqual(problems, [], 'schema 1 不应产生 problems');
  assert.equal(config.schema, CONFIG_SCHEMA, '只读兼容后规范化为当前 schema');
  assert.ok(
    warnings.some(w => w.includes('schema 1')),
    `应提示按只读兼容加载，实际 warnings=${JSON.stringify(warnings)}`,
  );
  assert.deepEqual(raw, snapshot, '读取 schema 1 不得改写原输入');
});

test('[config] 未知 schema 被拒绝且给出 problems', () => {
  const { config, problems } = validateConfig({ schema: 3 });
  assert.equal(config, null);
  assert.ok(problems.some(p => p.includes('schema')), `problems=${JSON.stringify(problems)}`);
});

test('[config] 非对象输入被拒绝', () => {
  const { config, problems } = validateConfig(null);
  assert.equal(config, null);
  assert.ok(problems.length > 0);
});

// ---------------------------------------------------------------------------
// config.mjs — validateConfig：任意非空推理档位允许，纯空白拒绝
// ---------------------------------------------------------------------------

test('[config] 任意非空推理档位允许结构校验', () => {
  const { config, problems } = validateConfig({ reasoningEffort: 'custom-tier' });
  assert.deepEqual(problems, []);
  assert.notEqual(config, null);
  assert.equal(config.reasoningEffort, 'custom-tier');
});

test('[config] 纯空白推理档位被拒绝，config 为 null', () => {
  const { config, problems } = validateConfig({ reasoningEffort: '   ' });
  assert.equal(config, null);
  assert.ok(
    problems.some(p => p.includes('reasoningEffort')),
    `problems=${JSON.stringify(problems)}`,
  );
});

test('[config] 空串推理档位按 provider 默认处理（与纯空白区分）', () => {
  // 源码明确把 ''（及 null）规范化为 null = 沿用 provider 默认；只有非空串里的
  // 纯空白（如 '   '）才报错。此断言记录该现行语义。
  const { config, problems } = validateConfig({ reasoningEffort: '' });
  assert.deepEqual(problems, []);
  assert.notEqual(config, null);
  assert.equal(config.reasoningEffort, null);
});

test('[config] max 档位仍合法但带最贵档位提示', () => {
  const { config, problems, warnings } = validateConfig({ reasoningEffort: 'max' });
  assert.deepEqual(problems, []);
  assert.notEqual(config, null);
  assert.equal(config.reasoningEffort, 'max');
  assert.ok(warnings.length > 0, 'max 档位应有提示');
});

// ---------------------------------------------------------------------------
// config.mjs — mergeFlags：合法覆盖生效，非法 CLI 覆盖必须拒绝
// ---------------------------------------------------------------------------

test('[config] mergeFlags 应用合法覆盖且不修改原 config', () => {
  const base = { ...BUILT_IN_CONFIG };
  const snapshot = clone(base);

  const merged = mergeFlags(base, { reasoningEffort: 'low', transport: 'posix-pipes' });

  assert.equal(merged.reasoningEffort, 'low');
  assert.equal(merged.transport, 'posix-pipes');
  assert.deepEqual(base, snapshot, 'mergeFlags 不得改写传入的 config');
  assert.notEqual(merged, base, '应返回新对象');
});

test('[config] 非法 transport CLI 覆盖必须拒绝', () => {
  assert.throws(
    () => mergeFlags({ ...BUILT_IN_CONFIG }, { transport: 'smtp' }),
    error => error instanceof ConfigError
      && error.code === 'config_invalid'
      && /transport/.test(error.message),
    '非法 transport override 必须抛 ConfigError(config_invalid)',
  );
});

test('[config] 非正 promptTimeoutMs 与空白 profile CLI 覆盖必须拒绝', () => {
  assert.throws(
    () => mergeFlags({ ...BUILT_IN_CONFIG }, { promptTimeoutMs: 0 }),
    error => error instanceof ConfigError && error.code === 'config_invalid',
  );
  assert.throws(
    () => mergeFlags({ ...BUILT_IN_CONFIG }, { profile: '   ' }),
    error => error instanceof ConfigError && error.code === 'config_invalid',
  );
});

// ---------------------------------------------------------------------------
// platform/launch.mjs — buildLaunch（仅模拟平台参数）
// ---------------------------------------------------------------------------

test('[launch] 非法 command / args / transport 被拒绝', () => {
  assert.throws(() => buildLaunch({ command: '' }), /invalid_launch_command/);
  assert.throws(() => buildLaunch({ command: 'node\0' }), /invalid_launch_command/);
  assert.throws(
    () => buildLaunch({ command: 'node', args: ['ok', 1] }),
    /invalid_launch_args/,
  );
  assert.throws(
    () => buildLaunch({ command: 'node', args: ['bad\0arg'] }),
    /invalid_launch_args/,
  );
  assert.throws(
    () => buildLaunch({ command: 'node', transport: 'ssh' }),
    /unsupported_transport:ssh/,
  );
});

test('[launch] 模拟 win32：.cmd / .bat 批处理启动器被拒绝', () => {
  const expected = /windows_batch_launcher_requires_explicit_runtime/;
  assert.throws(
    () => buildLaunch({ command: String.raw`C:\dsh\dsh.cmd`, args: [] }, 'win32'),
    expected,
  );
  assert.throws(
    () => buildLaunch({ command: 'DSH.BAT', args: [] }, 'win32'),
    expected,
    '.bat 后缀应大小写不敏感地被拒绝',
  );
});

test('[launch] 模拟 win32：node.exe + 完整 argv 直接可用', () => {
  const nodeExe = String.raw`C:\Program Files\nodejs\node.exe`;
  const entry = String.raw`C:\dsh\runtime\cli.js`;
  const argv = [entry, '--profile', 'acp', '--flag', 'value with space'];

  const launch = buildLaunch({ command: nodeExe, args: argv, transport: 'direct' }, 'win32');

  assert.deepEqual(launch, { command: nodeExe, args: argv, transport: 'direct' });
  assert.notEqual(launch.args, argv, '应复制 args，而不是复用调用方数组');
});

test('[launch] direct 返回完整 argv 且不修改输入 args', () => {
  const argv = ['--profile', 'acp'];
  const snapshot = clone(argv);

  const launch = buildLaunch({ command: 'node', args: argv }, 'linux');

  assert.deepEqual(launch, { command: 'node', args: ['--profile', 'acp'], transport: 'direct' });
  assert.deepEqual(argv, snapshot, 'buildLaunch 不得改写调用方的 args');
});

test('[launch] POSIX 管道在非 Linux 平台被拒绝', () => {
  assert.throws(
    () => buildLaunch({ command: 'dsh', args: [], transport: 'posix-pipes' }, 'win32'),
    /posix_pipes_requires_linux/,
  );
  assert.throws(
    () => buildLaunch({ command: 'dsh', args: [], transport: 'posix-pipes' }, 'darwin'),
    /posix_pipes_requires_linux/,
  );
});

test('[launch] Linux 上 POSIX 管道包装保留 command 与完整 args', () => {
  const command = '/opt/dsh/bin/dsh';
  const args = ['--profile', 'acp', '--extra', 'x'];

  const launch = buildLaunch({ command, args, transport: 'posix-pipes' }, 'linux');

  assert.equal(launch.command, '/bin/bash');
  assert.equal(launch.transport, 'posix-pipes');
  assert.equal(launch.args[0], '--noprofile');
  assert.equal(launch.args[1], '--norc');
  assert.equal(launch.args[2], '-c');
  assert.match(launch.args[3], /PIPESTATUS/, '包装脚本应保留退出码转发');
  assert.equal(launch.args[4], 'dsh-acp-worker');
  assert.equal(launch.args[5], command);
  assert.deepEqual(launch.args.slice(6), args, '用户 command 后的 argv 应原样附加');
});

// ---------------------------------------------------------------------------
// platform/process.mjs — processTarget
// ---------------------------------------------------------------------------

test('[process] 模拟 win32 用正 PID，Linux/macOS 用负 PID 表示进程组', () => {
  assert.equal(processTarget(4321, 'win32'), 4321);
  assert.equal(processTarget(4321, 'linux'), -4321);
  assert.equal(processTarget(4321, 'darwin'), -4321);
});

test('[process] 默认平台与本机 process.platform 一致', () => {
  const expected = process.platform === 'win32' ? 4321 : -4321;
  assert.equal(processTarget(4321), expected);
});

// ---------------------------------------------------------------------------
// contract.mjs — validateTaskContract：无需 permissions/工具表，允许 network:true
// ---------------------------------------------------------------------------

test('[contract] 不带 permissions 字段的任务仍然有效，且无工具表', () => {
  const input = makeContract();
  assert.equal(Object.hasOwn(input, 'permissions'), false);

  const result = validateTaskContract(input);

  assert.equal(result.valid, true, `errors=${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.policy.readPaths, []);
  assert.deepEqual(result.policy.writePaths, []);
  assert.equal(result.policy.network, undefined, '未提供 network 时保持未设置');
  assert.equal(result.policy.tools, undefined, '任务不需要工具白名单');
  assert.equal(result.policy.workspace, resolve(workspace));
});

test('[contract] permissions={} 有效且不引入工具表', () => {
  const result = validateTaskContract(makeContract({ permissions: {} }));
  assert.equal(result.valid, true, `errors=${JSON.stringify(result.errors)}`);
  assert.equal(result.policy.tools, undefined);
  assert.equal(result.policy.network, undefined);
});

test('[contract] permissions.network=true 被允许且无需 tools', () => {
  const result = validateTaskContract(makeContract({ permissions: { network: true } }));

  assert.equal(result.valid, true, `errors=${JSON.stringify(result.errors)}`);
  assert.equal(result.policy.network, true);
  assert.equal(result.policy.tools, undefined);
});

test('[contract] 显式提供的旧工具表被原样保留', () => {
  const tools = ['read_file', 'bash'];
  const result = validateTaskContract(makeContract({ permissions: { network: true, tools } }));

  assert.equal(result.valid, true, `errors=${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.policy.tools, tools);
  assert.equal(result.policy.network, true);
});

test('[contract] 非布尔 network 被拒绝', () => {
  const result = validateTaskContract(makeContract({ permissions: { network: 'yes' } }));

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(e => e.field === 'permissions.network'),
    `errors=${JSON.stringify(result.errors)}`,
  );
});
