#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';

import { Store, StoreError } from './store.mjs';
import { SessionMap } from './session-map.mjs';
import { Bridge, BridgeError } from './orchestration.mjs';
import { McpServer, serveStdio } from './mcp-server.mjs';
import { installShutdownHandlers } from './shutdown.mjs';
import { canonicalStateRoot, hostFingerprint, serveSharedClient, serveSharedHost } from './shared-server.mjs';
import { preflightWorker, DEFAULT_DSH_HOME, locateDsh } from './worker.mjs';
import { CatalogueCache, describeSelector } from './models.mjs';
import {
  CONFIG_FILE_NAME, loadConfigFile, mergeFlags, resolvedRoute, defaultConfigPath,
  ConfigError, BUILT_IN_CONFIG, writeConfigFile,
} from './config.mjs';

const DEFAULT_STATE_ROOT = resolve(process.cwd(), '.bridge-state');

export const USAGE = `用法：dsh-bridge <命令> [选项]

命令
  serve                            MCP stdio 客户端，自动连接共享后台（供 Codex 调用）
  delegate --file <契约.json>       提交任务；--file - 表示从 stdin 读取
  status [--id <任务id>]           查询任务状态
  result --id <任务id>             取回任务结果
  reply --id <任务id> --text <文本>  回答 worker 的澄清问题
  resolve --id <任务id> --verdict <裁定> --reason <理由> [--actor <谁>]
                                    对 unknown 做一次显式人工裁定并落盘
  retry --id <任务id> --reason <理由> [--actor <谁>]
                                    重放一个已裁定为 retry 的任务（每条记录只能重放一次）
  cancel --id <任务id> [--reason 文本]
  models [--refresh]               读取该 worker 实际公布的模型与推理档位（不消耗模型调用）
  inspect                          查看状态目录概况与所有未结算任务
  preflight                        检查 DSH_HOME、acp profile 与安装是否就绪
  config [--init]                  打印生效配置；--init 写出一份带注释的配置模板
  unlock [--stale]                 清理残留锁（--stale 用于进程已退出的情况）

选项
  --config <文件>       配置文件（默认 bridge.config.json，缺失则用内置默认值）
  --state-root <目录>   状态目录（默认 ${DEFAULT_STATE_ROOT}）
  --dsh-home <目录>     DSH home（默认配置值或 $DSH_HOME 或 ${DEFAULT_DSH_HOME}）
  --dsh-root <目录>     已安装的 @deepseek-ai/dsh 目录
  --profile <名字>      worker 使用的 DSH profile（默认 acp）
  --provider <id>       默认供应商，例如 deepseek-official
  --model-id <id>       默认模型 id，例如 deepseek-flash（注意：不是 provider/model）
  --reasoning <档位>    默认推理档位，例如 high；传空字符串表示 provider 默认
  --expose-model-choice  启用模型选择：暴露 dsh_models，并允许契约覆盖模型
  --transport <名字>    direct（默认）或 posix-pipes
  --prompt-timeout-ms <毫秒>  worker 单次提示的时间上限（默认 1800000）
  --wait                兼容旧选项；CLI delegate 总是等待，MCP 仍异步
  --worker-command <路径>    覆盖 worker 可执行文件（诊断与离线测试用）
  --worker-arg <参数>        worker argv 的一项；可重复出现，给出后整体替换默认 argv
  --approval-mode <模式>    ask（默认）/ deny / allow-once
  --request-timeout-ms <毫秒>  ACP 请求超时
  --workspace <目录>        models 命令用于建立会话的工作区（默认当前目录）
  --standalone          serve 使用旧的单进程模式，独占状态目录
  --idle-timeout-ms <毫秒>  共享后台在最后一个客户端离开后延迟退出（默认 30000）
  --help                显示本说明
`;

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const valueFlags = new Set(['config','state-root','dsh-home','dsh-root','profile','provider','model-id','model','reasoning','transport','prompt-timeout-ms','worker-command','worker-arg','workspace','id','file','text','verdict','reason','actor','approval-mode','request-timeout-ms','idle-timeout-ms','host-fingerprint']);
  const booleanFlags = new Set(['wait', 'stale', 'help', 'json', 'refresh', 'expose-model-choice', 'init', 'standalone']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!valueFlags.has(name)) throw new Error(`未知选项：--${name}`);
    if (Object.hasOwn(flags, name) && name !== 'worker-arg') throw new Error(`重复选项：--${name}`);
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith('--') && name !== 'worker-arg')) throw new Error(`缺少取值：--${name}`);

    flags[name] = Object.hasOwn(flags, name) ? [].concat(flags[name], value) : value;
    index += 1;
  }
  return { flags, positional };
}

const toArgList = value => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

const readContract = path => {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`契约不是合法 JSON：${error.message}`);
  }
};

const print = (value, asJson) => {
  if (asJson || typeof value === 'object') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${String(value)}\n`);
};

export function resolveConfig(flags = {}) {
  const path = flags.config ?? defaultConfigPath();
  if (flags.config !== undefined && !existsSync(resolve(path))) throw new ConfigError('config_missing', `指定的配置不存在：${path}`);
  const loaded = loadConfigFile(resolve(path));
  const config = mergeFlags(loaded.config, {
    provider: flags.provider,
    model: flags['model-id'] ?? flags.model,
    reasoningEffort: Object.hasOwn(flags, 'reasoning') ? flags.reasoning : undefined,
    exposeModelChoice: Object.hasOwn(flags, 'expose-model-choice') ? true : undefined,
    promptTimeoutMs: flags['prompt-timeout-ms'] ? Number(flags['prompt-timeout-ms']) : undefined,
    transport: flags.transport,
    dshHome: flags['dsh-home'],
    dshRoot: flags['dsh-root'],
    profile: flags.profile,
    workerCommand: flags['worker-command'],
    workerArgs: flags['worker-arg'] === undefined ? undefined : toArgList(flags['worker-arg']),
    approvalMode: flags['approval-mode'],
    requestTimeoutMs: flags['request-timeout-ms'] === undefined ? undefined : Number(flags['request-timeout-ms']),
  });
  return { ...loaded, config };
}

export function openBridge(options = {}) {
  const {
    stateRoot = DEFAULT_STATE_ROOT, config = BUILT_IN_CONFIG, lock = true, allowStale = false,
    workerCommand, workerArgs, defaultWorkspace,
  } = options;
  const root = resolve(stateRoot);
  const store = new Store(root).init();
  if (lock) store.lock({ allowStale });
  try {
    const sessions = SessionMap.fromStore(store.readSessions());
    const route = resolvedRoute(config);
    const bridge = new Bridge({
      store,
      sessions,
      worker: {
        dshHome: config.dshHome ?? process.env.DSH_HOME ?? DEFAULT_DSH_HOME,
        profile: config.profile,
        transport: config.transport,
        installationRoot: config.dshRoot ?? undefined,
        promptTimeoutMs: config.promptTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        ...(config.workerCommand ? { command: config.workerCommand } : {}),
        ...(config.workerArgs !== null ? { args: config.workerArgs } : {}),
        ...(config.workerEntry ? { entry: config.workerEntry } : {}),
        ...(config.nodeBin ? { nodeBin: config.nodeBin } : {}),
        ...(workerCommand ? { command: workerCommand } : {}),
        ...(workerArgs !== undefined ? { args: toArgList(workerArgs) } : {}),
      },
      exposeModelChoice: config.exposeModelChoice === true,
      approvalMode: config.approvalMode,
      approvalTimeoutMs: config.approvalTimeoutMs,
      catalogueRoot: root,
      defaultWorkspace,
      defaults: {
        provider: route.provider,
        modelId: route.modelId,
        selector: route.selector,
        reasoningEffort: route.reasoningEffort,
      },
      log: event => process.stderr.write(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`),
    });
    return { store, sessions, bridge, root, route };
  } catch (error) { if (lock) store.unlock(); throw error; }
}

export async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  if (flags.help || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return flags.help ? 0 : 2;
  }

  let resolved;
  try {
    resolved = resolveConfig(flags);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const { config } = resolved;
  for (const warning of resolved.warnings) process.stderr.write(`警告：${warning}\n`);
  const common = {
    stateRoot: flags['state-root'] ?? DEFAULT_STATE_ROOT,
    config,
    workerCommand: flags['worker-command'],
    workerArgs: flags['worker-arg'],
    defaultWorkspace: flags.workspace ?? process.cwd(),
  };

  if (command === 'preflight') {
    const report = preflightWorker({
      dshHome: common.config.dshHome ?? process.env.DSH_HOME ?? DEFAULT_DSH_HOME,
      transport: common.config.transport,
      installationRoot: common.config.dshRoot ?? undefined,
      profile: common.config.profile,
      command: config.workerCommand ?? undefined,
      args: config.workerArgs ?? undefined,
      entry: config.workerEntry ?? undefined,
      nodeBin: config.nodeBin ?? undefined,
    });
    print({
      ...report,
      route: resolvedRoute(common.config),
      configSource: resolved.source,
      configPath: resolved.path,
    }, true);
    return report.ok ? 0 : 1;
  }

  if (command === 'config') {
    if (flags.init === true) {
      const path = resolve(flags.config ?? defaultConfigPath());
      try {
        writeConfigFile(path);
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
        return 1;
      }
      print({ written: path, note: '已写出一份带注释的配置模板；请按你的 DSH 实际公布的路由修改。' }, true);
      return 0;
    }
    print({
      source: resolved.source,
      path: resolved.path,
      config,
      route: resolvedRoute(config),
      note: '选择值的真实格式由 DSH 决定（JSON.stringify([provider, model])），桥会自行编码；不要手写。',
    }, true);
    return 0;
  }

  if (command === 'serve-host' || (command === 'serve' && !flags.standalone)) {
    const idleMs = Number(flags['idle-timeout-ms'] ?? 30000);
    if (!Number.isSafeInteger(idleMs) || idleMs < 100 || idleMs > 3600000) {
      throw new Error('--idle-timeout-ms 必须为 100 到 3600000 的整数');
    }
    common.stateRoot = canonicalStateRoot(resolve(common.stateRoot));
    const fingerprint = hostFingerprint({ ...common, idleMs });
    if (command === 'serve-host') {
      if (flags['host-fingerprint'] !== fingerprint) throw new Error('共享后台启动期间配置或代码已变化，请重试。');
      return serveSharedHost({ root: common.stateRoot, fingerprint, idleMs, open: () => openBridge(common) });
    }
    let commandIndex = 0;
    while (argv[commandIndex]?.startsWith('--')) {
      commandIndex += flags[argv[commandIndex].slice(2)] === true ? 1 : 2;
    }
    const hostArgs = [fileURLToPath(import.meta.url), ...argv];
    hostArgs[commandIndex + 1] = 'serve-host';
    hostArgs.push('--host-fingerprint', fingerprint);
    return serveSharedClient({ root: common.stateRoot, fingerprint,
      workspace: common.defaultWorkspace, hostArgs, input: stdin, output: stdout });
  }

  if (command === 'serve') {
    const { store, bridge } = openBridge(common);
    const server = new McpServer({ bridge });

    const lifecycle = installShutdownHandlers({
      bridge,
      store,
      log: event => process.stderr.write(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`),
    });
    try {
      await serveStdio({ input: stdin, output: stdout, server });
    } finally {

      const outcome = await lifecycle.awaitCleanup('stdio_eof');
      if (outcome === null) {
        process.stderr.write(`${JSON.stringify({
          event: 'bridge_shutdown_watchdog', reason: 'stdio_eof', at: new Date().toISOString(),
        })}\n`);
      }
      lifecycle.dispose();
    }
    return 0;
  }

  if (command === 'inspect') {
    const store = new Store(resolve(common.stateRoot)).init();
    const report = store.inspect();
    const bridge = new Bridge({ store, sessions: SessionMap.fromStore(store.readSessions()), worker: {} });
    print({ ...report, stranded: bridge.reconcile().stranded }, true);
    return 0;
  }

  if (command === 'unlock') {
    const store = new Store(resolve(common.stateRoot)).init();
    const status = store.lockStatus();
    if (status.state === 'free') {
      print({ unlocked: false, reason: '没有锁文件' }, true);
      return 0;
    }
    if (status.state === 'held-live' && flags.stale !== true) {
      print({ unlocked: false, reason: `锁被活动进程持有（pid ${status.pid}）` }, true);
      return 1;
    }
    if (status.state === 'stale' && flags.stale !== true) {
      print({
        unlocked: false,
        reason: `发现残留锁（pid ${status.pid}）。确认该进程确已退出后，加 --stale 再执行。`,
      }, true);
      return 1;
    }
    store.lock({ allowStale: true });
    store.unlock();
    print({ unlocked: true, previous: status }, true);
    return 0;
  }

  if (command === 'models') {
    const { store, bridge, root, route } = openBridge(common);
    try {
      const cached = bridge.readCatalogue();
      const discovered = flags.refresh === true || !cached
        ? await bridge.discoverModels({ workspace: common.defaultWorkspace, refresh: true })
        : { summary: cached.summary, at: cached.at, cached: true };
      const summary = discovered.summary;
      const ageMs = cached ? new CatalogueCache(root).ageMs() : null;
      print({
        at: discovered.at,
        cached: discovered.cached === true,
        ageMs,
        current: summary?.model?.currentValue ?? null,
        models: (summary?.model?.choices ?? []).map(choice => ({
          value: choice.value,
          provider: describeSelector(choice.value)?.provider ?? choice.group ?? null,
          modelId: describeSelector(choice.value)?.modelId ?? choice.name,
          name: choice.name,
          group: choice.group,
        })),
        reasoning: summary?.reasoning == null ? null : {
          current: summary.reasoning.currentValue ?? null,
          options: (summary.reasoning.choices ?? []).map(choice => ({ value: choice.value, name: choice.name })),
        },
        configuredRoute: route,
        note: '只建会话读目录，未发送提示，因此没有消耗模型调用。',
      }, true);
      return 0;
    } finally {
      await bridge.shutdown();
      store.unlock();
    }
  }

  if (['delegate', 'reply', 'retry'].includes(command) && config.approvalMode === 'ask') {
    throw new BridgeError('cli_interactive_approval_requires_serve', 'CLI 单次执行请明确选择 --approval-mode deny 或 allow-once；交互审批使用 serve 的 MCP 工具。');
  }
  const READ_ONLY = new Set(['status', 'result']);

  const { store, bridge } = openBridge({ ...common, lock: !READ_ONLY.has(command) });
  try {
    switch (command) {
      case 'delegate': {
        if (!flags.file) throw new Error('delegate 需要 --file <契约.json>（或 --file - 读 stdin）');
        const contract = readContract(flags.file);
        const view = await bridge.delegate(contract, { wait: true });
        print(view, true);
        return ['completed', 'needs_clarification'].includes(view.status) ? 0 : 1;
      }
      case 'status': {
        print(flags.id ? bridge.status(flags.id) : { tasks: bridge.list() }, true);
        return 0;
      }
      case 'result': {
        if (!flags.id) throw new Error('result 需要 --id');
        const value = bridge.result(flags.id);
        if (value.text.length > 0) {
          process.stdout.write(`${value.text}\n`);
          process.stderr.write(`${JSON.stringify({
            status: value.status, stopReason: value.stopReason, toolCalls: value.toolCalls, turns: value.turns, usage: value.usage,
          })}\n`);
        } else {
          print(`（尚无结果；状态 ${value.status}${value.error ? `，error=${value.error.code}` : ''}）`, false);
        }
        return 0;
      }
      case 'reply': {
        if (!flags.id || !flags.text) throw new Error('reply 需要 --id 与 --text');
        await bridge.reply(flags.id, flags.text);
        const outcome = await bridge.waitForTask(flags.id, config.promptTimeoutMs + config.requestTimeoutMs);
        print(outcome.view, true);
        return outcome.view.status === 'completed' || outcome.view.status === 'needs_clarification' ? 0 : 1;
      }
      case 'resolve': {
        if (!flags.id) throw new Error('resolve 需要 --id');
        if (!flags.verdict) throw new Error('resolve 需要 --verdict（retry / keep_failed / abandoned / keep_completed）');
        if (!flags.reason) throw new Error('resolve 需要 --reason：没有理由的裁定与没有裁定无法区分');
        print(bridge.resolve(flags.id, {
          verdict: flags.verdict,
          reason: flags.reason,
          actor: flags.actor ?? 'operator',
        }), true);
        return 0;
      }
      case 'retry': {
        if (!flags.id) throw new Error('retry 需要 --id');
        if (!flags.reason) throw new Error('retry 需要 --reason：没有理由的重放与没有重放无法区分');
        print(await bridge.retry(flags.id, {
          reason: flags.reason,
          actor: flags.actor ?? 'operator',
        }), true);
        return 0;
      }
      case 'cancel': {
        if (!flags.id) throw new Error('cancel 需要 --id');
        print(await bridge.cancel(flags.id, { reason: flags.reason ?? 'cli requested' }), true);
        return 0;
      }
      default:
        process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    await bridge.shutdown();
    store.unlock();
  }
}

export { StoreError, BridgeError, ConfigError, locateDsh, CONFIG_FILE_NAME };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write(`${error?.message ?? String(error)}\n`);
      if (error?.code) process.stderr.write(`code=${error.code}\n`);
      process.exitCode = 1;
    },
  );
}
