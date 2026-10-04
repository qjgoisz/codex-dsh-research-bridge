/** Shared fixtures for the bridge test suite. */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute *filesystem* path to the fake ACP agent (not a file URL). */
export const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

/** A valid contract; override any field to build the invalid cases. */
export function contract(overrides = {}) {
  const workspace = overrides.workspace ?? '/tmp/bridge-test-workspace';
  return {
    id: 'task-001',
    objective: '核对有效方程中 m 的二阶系数',
    phase: 'numerics',
    workspace,
    project: 'default',
    contextRevision: 0,
    plan: {
      summary: '在给定噪声约定下独立展开到二阶',
      steps: ['列出符号与假设', '独立展开', '对比原推导'],
    },
    acceptance: ['差异必须定位到方程与假设', '未验证步骤必须标注'],
    stopIf: ['噪声约定缺失'],
    permissions: { readPaths: [workspace], writePaths: [workspace] },
    reversePolicy: 'consult_only',
    allowRecursiveDelegation: false,
    ...overrides,
  };
}

/** Worker configuration that launches the fake ACP agent instead of DSH. */
export function fakeWorker(env = {}) {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { ...process.env, ...env },
    transport: 'direct',
  };
}

/**
 * Bounded prompt budget for every test worker. Without this an unresponsive
 * fake would inherit the production 30-minute prompt timeout and a broken test
 * would hang instead of failing — which is exactly the trap that cost real time
 * while building this suite.
 */
export const TEST_PROMPT_TIMEOUT_MS = 5000;

/** Worker configuration for tests: fake agent + a short, explicit prompt budget. */
export function testWorker(env = {}, overrides = {}) {
  return { ...fakeWorker(env), promptTimeoutMs: TEST_PROMPT_TIMEOUT_MS, ...overrides };
}

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll `probe` until it returns a truthy value or the budget runs out.
 * Used instead of fixed sleeps so tests stay fast but not flaky.
 */
export async function until(probe, { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await wait(intervalMs);
  }
}

/**
 * 断言一个 worker 启动规格确实是离线的（本套件）或确实是真实 worker（显式探针）。
 *
 * 为什么要有它：R2 那条测试曾经把 `bridge.workerOptions` 设成 undefined，
 * 于是 `#clientFor()` 重建规格时回退成 `dsh` —— **离线测试里真的启动了 DSH**，
 * 而那个 delegate 的返回值被我丢弃了，所以即使真实任务不成功也照样全绿。
 * 单靠入口注释承诺「离线」是不够的：必须有一处**在启动前**检查。
 *
 * 用法（测试里的注入点）：
 *   createClient: guardOfflineSpec(spec => { made.push(spec); return new AcpClient(spec, hooks); })
 */
export function assertOfflineSpec(spec) {
  // 判据必须是**完整 argv**，而不是"参数里含 fake 路径"。
  // 复核 C1 的反例：`process.execPath -e '<任意代码>' <FAKE_AGENT>` 也含该路径，
  // 于是守卫放行、真正执行的是另一个程序（fake 只是最后一个参数）。
  // 完整比对才能表达"启动的就是这个 fake agent，没有别的程序"。
  if (spec?.command !== process.execPath) {
    throw new Error(`离线测试不得启动 ${spec?.command}（应当只启动 fake agent：${FAKE_AGENT}）`);
  }
  const args = spec?.args;
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== FAKE_AGENT) {
    throw new Error(
      `离线 worker 必须使用指定 fake 的完整启动规格：期望 [${FAKE_AGENT}]，实际 ${JSON.stringify(args)}`,
    );
  }
  return spec;
}
