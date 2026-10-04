import { killTrackedWorkers, setWorkerOwner, trackedWorkerCount } from '../src/transport.mjs';
/** Minimal zero-dependency test harness: deterministic, sequential, no globals. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const COLORS = process.stdout.isTTY
  ? { green: '\u001b[32m', red: '\u001b[31m', dim: '\u001b[2m', reset: '\u001b[0m' }
  : { green: '', red: '', dim: '', reset: '' };

export function createSuite(name) {
  const tests = [];
  return {
    name,
    test(title, fn) { tests.push({ title, fn }); },
    tests,
  };
}

/**
 * Run suites sequentially. Each test's failure is captured, never swallowed, and
 * temp directories registered through `ctx.tempDir` are removed afterwards.
 *
 * @param {Array<{name: string, tests: Array<{title: string, fn: Function}>}>} suites
 */
export async function runSuites(suites, { filter } = {}) {
  let passed = 0;
  const failures = [];
  /** 超时中止：`{ label }` 非空时不再执行后续测试（复核 AJ2）。 */
  let aborted = null;
  let skipped = 0;
  const t0 = Date.now();

  // 筛选词没有任何匹配时必须报错，而不是"0 通过 / 0 失败、退出码 0"。
  // 后者会把「什么都没验证」呈现成「验证通过」—— 复核 B6 的判定依据。
  const selected = suites.reduce((count, suite) => count + suite.tests.filter(test =>
    !filter || `${suite.name} › ${test.title}`.includes(filter)).length, 0);
  if (selected === 0) {
    throw new Error(`没有匹配的测试：${filter ?? '(全部)'} —— 请检查筛选词是否拼错`);
  }

  for (const suite of suites) {
    process.stdout.write(`\n${suite.name}\n`);
    for (const test of suite.tests) {
      const label = `${suite.name} › ${test.title}`;
      if (filter && !label.includes(filter)) continue;
      if (aborted !== null) { skipped += 1; continue; }
      const temps = [];
      const ctx = {
        tempDir(prefix = 'bridge-test-') {
          const dir = mkdtempSync(join(tmpdir(), prefix));
          temps.push(dir);
          return dir;
        },
        assert(condition, message) {
          if (!condition) throw new Error(message ?? 'assertion failed');
        },
        equal(actual, expected, message) {
          if (actual !== expected) {
            throw new Error(`${message ?? 'not equal'}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`);
          }
        },
        deepEqual(actual, expected, message) {
          const left = JSON.stringify(actual);
          const right = JSON.stringify(expected);
          if (left !== right) throw new Error(`${message ?? 'not deep equal'}\n  实际: ${left}\n  期望: ${right}`);
        },
        rejects: async (promise, matcher, message) => {
          try {
            await promise;
          } catch (error) {
            if (matcher && !matcher(error)) throw new Error(`${message ?? 'rejected, but not as expected'}: ${error.message}`);
            return error;
          }
          throw new Error(`${message ?? 'expected rejection, but the promise resolved'}`);
        },
        read: path => readFileSync(path, 'utf8'),
        exists: path => existsSync(path),
      };
      setWorkerOwner(label);
      const started = Date.now();
      try {
        // **每条测试都有有界超时**（复核 AC1 / AB6 一族的根因）。
        //
        // 原先 `runSuites` **没有测试级超时** —— 一条测试挂住（例如
        // `await bridge.shutdown()` 在故障下不返回）就会**拖住整套**：
        // 复核实测 AH2 变异下汇总行虽然打印（233/5），但进程 **600 秒仍未退出**
        // （正常全套 11 秒）。
        //
        // 超时判失败而**不是**静默放过，并且**打印明确的失败原因** ——
        // 这样"跑不动"不再看起来像"运行中"。
        // **预算必须是正整数**（复核实施指南 §1.1 指出）。
        //
        // 复核实测：`DSH_TEST_TIMEOUT_MS=abc` / `-1` / `0` 都会**静默**变成"几乎立即超时" ——
        // `Number('abc')` 是 `NaN`、`-1` 与 `0` 让 `setTimeout` 立即触发，
        // 于是**正常测试被判失败**，还报"超时后没有停止"。那是我自己的配置错误，
        // 却被包装成"测试有问题"。现在：坏值 ⇒ **回退默认并明确警告**。
        const rawBudget = process.env.DSH_TEST_TIMEOUT_MS;
        let TEST_TIMEOUT_MS = 30000;
        if (rawBudget !== undefined) {
          const parsed = Number(rawBudget);
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            TEST_TIMEOUT_MS = parsed;
          } else {
            process.stdout.write(`${COLORS.red}  ⚠️ DSH_TEST_TIMEOUT_MS=${JSON.stringify(rawBudget)}`
              + ` 不是正整数 —— 已回退默认 ${TEST_TIMEOUT_MS}ms`
              + `（否则它会静默变成"几乎立即超时"）${COLORS.reset}\n`);
          }
        }
        // **超时判定必须靠来源可靠的专用错误对象，不能靠错误文字**（复核 AM4）。
        //
        // 我上一版用 `/测试超时/.test(error.message)` 判超时 —— 于是**任何 message 里
        // 含"测试超时"的普通失败**都会被当成超时：杀 worker、保留临时目录、
        // **跳过全部后续测试**，并报告成"超时后没有停止"。
        // 复核实测：一条**同步立即抛出** `Error('业务诊断：上游测试超时，但本测试立即返回')`
        // 的测试，会让第二条测试不执行并输出"其后 1 项未运行" —— 而它**根本没有超时**。
        //
        // 现在用**身份比较**：只有这个 Promise 自己构造的那个错误对象才算超时。
        const timeoutError = new Error(
          `测试超时（${TEST_TIMEOUT_MS}ms 未结束）—— 有界的等待，不是"跑得慢"；`
          + `可用 DSH_TEST_TIMEOUT_MS 调整`);
        let timer = null;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError), TEST_TIMEOUT_MS);
        });
        let timedOut = false;
        try {
          await Promise.race([test.fn(ctx), timeout]);
        } catch (error) {
          if (error === timeoutError) timedOut = true;
          throw error;
        } finally {
          if (timer !== null) clearTimeout(timer);
          if (timedOut) {
            // **超时必须把这条测试留下的 worker 一并终止**，否则那条挂住的路径
            // 仍持有事件循环 —— runner 会"汇总打印了却不退出"，
            // 看起来像"还在跑"（复核 AC1 / AB6 是同一族的两个实例）。
            // **只终止这一条测试留下的 worker**（复核 AJ2：全局 pid 集合不能代表
            // "这一条测试的资源"）。并**观测**它们是否真的退出了 ——
            // 发送信号成功不等于进程已消失。
            const cleanup = killTrackedWorkers(label);
            const alive = cleanup.stillAlive.length;
            process.stdout.write(`${COLORS.dim}    （超时清理：本条的 ${cleanup.killed.length} 个 worker`
              + ` 已发信号，用时 ${cleanup.tookMs}ms`
              + `${alive > 0 ? `，**其中 ${alive} 个仍在存活：${cleanup.stillAlive.join(', ')}**` : '，均已退出'}`
              + `；登记表剩余 ${trackedWorkerCount()} 条）${COLORS.reset}\n`);
            // **`Promise.race` 不会取消败方**（复核 AJ2 的判定依据）：
            // 超时分支赢了之后，`test.fn(ctx)` **仍在运行**。此时若继续跑后面的测试，
            // 就会出现"两条测试并发运行在已污染状态中"。
            // 复核实测的时序（无 worker、无网络）：
            //   20ms  第一条超时、被记失败、**临时目录被清理**
            //   21ms  第二条已经开始
            //   81ms  第一条**仍在运行**，重新创建了刚被清掉的目录并写文件
            //   121ms 第二条观测到这个遗留目录，也失败
            // 汇总 0/2 —— 后续统计不再满足"顺序隔离"这个前提。
            //
            // 通用 Promise 无法强制取消。这里采取**诚实**的做法：
            //   · **中止整套后续执行**，并明确报告"有 N 项未运行"；
            //   · **不清理这条测试的临时目录**（它还在写，删了只会污染别人）。
            // 进程隔离（每条测试独立子进程 + 外部 watchdog）是更彻底的修法，
            // 本仓库**没有做**，这条限度写在文档里。
            aborted = { label };
          }
        }
        passed += 1;
        process.stdout.write(`${COLORS.green}  ✓${COLORS.reset} ${test.title} ${COLORS.dim}(${Date.now() - started}ms)${COLORS.reset}\n`);
      } catch (error) {
        failures.push({ label, error });
        process.stdout.write(`${COLORS.red}  ✗ ${test.title}${COLORS.reset}\n    ${(error.stack ?? error.message).split('\n').join('\n    ')}\n`);
      } finally {
        // 已中止的那条**还在运行**，删它的临时目录只会污染后续 —— 交给进程退出。
        if (aborted === null || aborted.label !== label) {
          for (const dir of temps) {
            try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        }
      }
    }
  }

  const failed = failures.length;
  process.stdout.write(`\n${failed === 0 ? COLORS.green : COLORS.red}${passed} 通过 / ${failed} 失败${COLORS.reset} ${COLORS.dim}(${Date.now() - t0}ms)${COLORS.reset}\n`);
  if (aborted !== null) {
    // **把"没跑"如实说出来** —— 否则后面的 0 通过会被读成"这些项通过了"。
    process.stdout.write(`${COLORS.red}已中止：${aborted.label} 超时后**没有停止**`
      + `（\`Promise.race\` 不取消败方），其后 **${skipped} 项未运行**。`
      + `本次验收结论**不完整**。${COLORS.reset}\n`);
  }
  return { passed, failed, failures };
}
