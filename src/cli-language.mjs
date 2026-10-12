// Presentation-only localization. Never rewrite task records, upstream errors,
// protocol schemas, identifiers or the experimental clarification mechanism.
export function resolveCliLanguage(args = [], env = process.env) {
  let selected = env.DSH_BRIDGE_LANG || 'en';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--worker-arg') { i++; continue; }
    if (args[i] === '--set') { i += 2; continue; }
    if (args[i] === '--lang') {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) {
        throw Object.assign(new Error('Missing value: --lang'), { code: 'invalid_language' });
      }
      selected = args[++i];
    }
  }
  if (!['en', 'zh-CN'].includes(selected)) {
    throw Object.assign(new Error(`Unsupported language: ${selected}. Use en or zh-CN.`), { code: 'invalid_language' });
  }
  return selected;
}
export function safeCliLanguage(args = [], env = process.env) {
  try { return resolveCliLanguage(args, env); } catch { return 'en'; }
}
const messages = [
  ['未知选项：--{0}', 'Unknown option: --{0}'],
  ['重复选项：--{0}', 'Duplicate option: --{0}'],
  ['缺少取值：--{0}', 'Missing value: --{0}'],
  ['未知命令：{0}', 'Unknown command: {0}'],
  ['契约不是合法 JSON：{0}', 'Task contract is not valid JSON: {0}'],
  ['指定的配置不存在：{0}', 'Specified configuration does not exist: {0}'],
  ['配置文件不是合法 JSON：{0}', 'Configuration is not valid JSON: {0}'],
  ['配置校验未通过：{0}\n  · {1}', 'Configuration validation failed: {0}\n  · {1}'],
  ['配置文件已存在，未覆盖：{0}', 'Configuration already exists; it was not overwritten: {0}'],
  ['先自行备份或指定 --config 到别的路径。', 'Back up the file or use --config with another path.'],
  ['未知配置项：{0}（可用：{1}）', 'Unknown configuration field: {0} (allowed: {1})'],
  ['schema 必须是 {0}，收到 {1}', 'schema must be {0}; received {1}'],
  ['配置必须是对象。', 'Configuration must be an object.'],
  ['provider 必须是非空字符串，例如 deepseek-official', 'provider must be a non-empty string, for example deepseek-official'],
  ['model 必须是模型 id 本身，例如 deepseek-flash（不要写 provider/model）', 'model must be a model ID, for example deepseek-flash (not provider/model)'],
  ['reasoningEffort 必须是字符串，或 null 表示沿用 provider 默认', 'reasoningEffort must be a string, or null to use the provider default'],
  ['reasoningEffort 必须是 {0} 之一（或 null），收到：{1}', 'reasoningEffort must be one of {0} (or null); received: {1}'],
  ['exposeModelChoice 必须是布尔值', 'exposeModelChoice must be a boolean'],
  ['{0} 必须是正整数毫秒', '{0} must be a positive integer in milliseconds'],
  ['{0} 必须是非空字符串或 null', '{0} must be a non-empty string or null'],
  ['transport 必须是 direct 或 posix-pipes', 'transport must be direct or posix-pipes'],
  ['workerArgs 必须是字符串数组或 null。', 'workerArgs must be an array of strings or null.'],
  ['approvalMode 必须为 ask / deny / allow-once。', 'approvalMode must be ask / deny / allow-once.'],
  ['schema 1 以只读兼容方式加载；不改写原文件。新默认审批为 ask。', 'schema 1 is loaded in read-only compatibility mode; the file is unchanged. The new default approval mode is ask.'],
  ['--idle-timeout-ms 必须为 100 到 3600000 的整数', '--idle-timeout-ms must be an integer from 100 to 3600000'],
  ['共享后台启动期间配置或代码已变化，请重试。', 'Configuration or code changed during shared backend startup; try again.'],
  ['共享桥配置或代码已变化：请关闭使用此状态目录的所有 MCP 客户端，等待后台退出后重连；或使用另一个状态目录。', 'Shared bridge configuration or code changed: close all MCP clients using this state directory, wait for the backend to exit, then reconnect; or use another state directory.'],
  ['无法连接共享桥后台；检查状态目录中的 daemon.log。旧版 serve 或 CLI 可能仍持有 bridge.lock；不要删除活动锁，残留锁仍需显式 unlock --stale。', 'Cannot connect to the shared backend; check daemon.log in the state directory. An older serve or CLI process may hold bridge.lock. Do not delete a live lock; stale locks still require explicit unlock --stale.'],
  ['共享桥连接中断；未重发请求，请重连后查询任务状态。', 'Shared bridge connection interrupted; the request was not resent. Reconnect and check task status.'],
  ['CLI 单次执行请明确选择 --approval-mode deny 或 allow-once；交互审批使用 serve 的 MCP 工具。', 'For one-shot CLI execution, explicitly select --approval-mode deny or allow-once; use serve MCP tools for interactive approvals.'],
  ['delegate 需要 --file <契约.json>（或 --file - 读 stdin）', 'delegate requires --file <contract.json> (or --file - for stdin)'],
  ['{0} 需要 --id', '{0} requires --id'],
  ['reply 需要 --id 与 --text', 'reply requires --id and --text'],
  ['resolve 需要 --verdict（retry / keep_failed / abandoned / keep_completed）', 'resolve requires --verdict (retry / keep_failed / abandoned / keep_completed)'],
  ['{0} 需要 --reason：没有理由的裁定与没有裁定无法区分', '{0} requires --reason: a resolution without a reason cannot be distinguished from no resolution'],
  ['retry 需要 --reason：没有理由的重放与没有重放无法区分', 'retry requires --reason: a replay without a reason cannot be distinguished from no replay'],
  ['没有任务 {0}。', 'Task not found: {0}'],
  ['任务契约校验未通过（{0} 项）：{1}', 'Task contract validation failed ({0} errors): {1}'],
  ['任务 id 不得以 dsh- 开头（保留前缀）：{0}', 'Task ID must not start with the reserved dsh- prefix: {0}'],
  ['任务 id 非法：{0}', 'Invalid task ID: {0}'],
  ['任务 id {0} 已存在且内容不同；请换一个 id（幂等只对完全相同的契约生效）。', 'Task ID {0} already exists with different content; use another ID. Idempotence applies only to identical contracts.'],
  ['任务 {0} 当前状态为 {1}，只有 needs_clarification 可以回复。', 'Task {0} is {1}; replies require needs_clarification.'],
  ['回复内容不能为空。', 'Reply text must not be empty.'],
  ['状态 {0} 不支持取消。', 'Cancellation is not supported in state {0}.'],
  ['状态目录已被活动进程占用（pid {0}）。', 'State directory is held by a live process (pid {0}).'],
  ['锁文件无法解析；请人工核对后运行 unlock。', 'Cannot parse the lock file; inspect it manually before running unlock.'],
  ['发现残留锁（pid {0}，进程已不存在）。确认无人在写后运行 unlock --stale 清理。', 'Stale lock found (pid {0}, process no longer exists). Confirm that no writer is active, then run unlock --stale.'],
  ['无法获取写锁。', 'Cannot acquire the writer lock.'],
  ['写入前必须先获取写锁。', 'Acquire the writer lock before writing.'],
  ['记录实验事件前必须持有写锁。', 'Recording experiment events requires the writer lock.'],
  ['状态文件已损坏，拒绝静默跳过：{0}', 'State file is corrupt; it will not be silently skipped: {0}'],
  ['无法读取 {0}', 'Cannot read {0}'],
  ['任务文件 schema 不是 {0}：{1}', 'Task file schema is not {0}: {1}'],
  ['任务文件内容与文件名不符：{0}', 'Task file contents do not match its filename: {0}'],
  ['任务文件正文的 id（{0}）与文件名（{1}）不符：{2}', 'Task record ID ({0}) does not match filename ({1}): {2}'],
  ['任务记录不合法（{0}）：{1}', 'Invalid task record ({0}): {1}'],
  ['拒绝写入不合法记录：{0}', 'Refusing to write an invalid record: {0}'],
  ['写入的任务 id 非法：{0}', 'Invalid task ID for writing: {0}'],
  ['revision 冲突：磁盘 {0}，期望 {1}。', 'revision conflict: disk {0}, expected {1}.'],
  ['会话映射文件不合法：{0}', 'Invalid session map file: {0}'],
  ['worker 工作区必须是本平台的绝对路径。', 'Worker workspace must be an absolute path for this platform.'],
  ['DSH_HOME 不存在：{0}', 'DSH_HOME does not exist: {0}'],
  ['DSH profile 未初始化，缺少 package.json：{0}', 'DSH profile is not initialized; package.json is missing: {0}'],
  ['无法定位 DSH；请指定 workerCommand/workerArgs 或 dshRoot。', 'Cannot locate DSH; specify workerCommand/workerArgs or dshRoot.'],
  ['posix-pipes 仅适用于 Linux。', 'posix-pipes is only available on Linux.'],
  ['使用 node.exe 和 JS 入口替代 .cmd/.bat。', 'Use node.exe and a JS entry instead of .cmd/.bat.'],
  ['Desktop 安装目录不能为空。', 'Desktop installation directory must not be empty.'],
  ['Desktop 安装位置必须是目录。', 'Desktop installation location must be a directory.'],
  ['发现多个 Desktop CLI 入口，请指定更精确的 Resources 目录。', 'Multiple Desktop CLI entries found; specify a more precise Resources directory.'],
  ['未知或不可设置的字段：{0}', 'Unknown or non-editable field: {0}'],
  ['{0} 必须是 true / false', '{0} must be true / false'],
  ['配置必须是普通文件，不接受符号链接：{0}', 'Configuration must be a regular file, not a symlink: {0}'],
  ['配置在问答期间被修改，请重新运行；未覆盖外部修改。', 'Configuration changed during the interaction; run again. External changes were not overwritten.'],
  ['配置锁已存在：{0}；确认没有配置进程后可手工删除。', 'Configuration lock already exists: {0}; remove it manually only after confirming that no configuration process is active.'],
  ['未知选项：{0}', 'Unknown option: {0}'],
  ['{0} 缺少参数', 'Missing argument: {0}'],
  ['--desktop 搭配 --yes / --check 时必须指定 --desktop-root。', '--desktop with --yes / --check requires --desktop-root.'],
  ['输入结束，未保存配置。', 'Input ended; configuration was not saved.'],
  ['Desktop 目录为空，未保存配置。', 'Desktop directory is empty; configuration was not saved.'],
  ['必须是普通对象。', 'Must be a plain object.'],
  ['必须是非空字符串：这是要交付的目标本身。', 'Must be a non-empty string describing the intended deliverable.'],
  ['必须是非空字符串：任务 id 由调用方指定并用于幂等。', 'Must be a non-empty task ID supplied by the caller for idempotence.'],
  ['必须是绝对路径，且不得含 `..` 或 NUL：这是 worker 的工作区根。', 'Must be an absolute workspace path without `..` or NUL.'],
  ['必须是已存在的目录，不能是文件。', 'Must be an existing directory, not a file.'],
  ['工作区目录不存在；请先创建该目录。', 'Workspace directory does not exist; create it first.'],
  ['无法访问工作区目录。', 'Cannot access the workspace directory.'],
  ['必须是对象：{ summary, steps }。', 'Must be an object: { summary, steps }.'],
  ['必须是非空数组。', 'Must be a non-empty array.'],
];
messages.push(
  ['必须是非空字符串数组。', 'Must be a non-empty array of strings.'],
  ['必须是字符串数组。', 'Must be an array of strings.'],
  ['必须是非空字符串。', 'Must be a non-empty string.'],
  ['必须是对象。', 'Must be an object.'],
  ['必须是布尔值。', 'Must be a boolean.'],
  ['必须是 >= 0 的安全整数或 null。', 'Must be a safe integer >= 0 or null.'],
  ['必须是 {0} 之一。', 'Must be one of {0}.'],
  ['必须是绝对路径，且不得含 `..` 或 NUL。', 'Must be an absolute path without `..` or NUL.'],
  ['必须是模型 id，例如 deepseek-flash（不要写 provider/model，也不要写 JSON 选择值）。', 'Must be a model ID such as deepseek-flash, not provider/model or a JSON selector.'],
  ['必须是非空字符串，例如 deepseek-official。', 'Must be a non-empty string, for example deepseek-official.'],
  ['必须是非空字符串，或 null（表示沿用 provider 默认）。', 'Must be a non-empty string or null to use the provider default.'],
  ['必须是 `consult_only`：worker 只能向 Codex 提问，不能反向委派。', 'Must be `consult_only`: the worker may consult Codex but cannot delegate back.'],
  ['必须是 false：桥不开放递归委派。', 'Must be false: recursive delegation is not enabled.'],
  ['重放必须给出理由：没有理由的重放与没有重放在记录上无法区分。', 'A replay requires a reason so it can be distinguished from no replay in the record.'],
  ['必须给出理由：没有理由的裁定与没有裁定在记录上无法区分。', 'A resolution requires a reason so it can be distinguished from no resolution in the record.'],
  ['任务 {0} 当前状态为 {1}，只有裁定为 retry 而回到 queued 的任务可以重放。', 'Task {0} is {1}; only queued tasks explicitly resolved for retry may be replayed.'],
  ['任务 {0} 回到 queued 的原因不是 retry 裁定，拒绝重放。', 'Task {0} was not queued by a retry resolution; replay refused.'],
  ['任务 {0} 已经重放过 {1} 次（上限 {2}），拒绝再次重放。', 'Task {0} has been replayed {1} times (limit {2}); another replay is refused.'],
  ['verdict 必须是 {0} 之一。', 'verdict must be one of {0}.'],
  ['任务 {0} 当前状态为 {1}，不接受裁定。{2}', 'Task {0} is {1}; it cannot be resolved. {2}'],
  ['只有 unknown 需要人工裁定。', 'Only unknown tasks require manual resolution.'],
  ['worker 未返回 sessionId。', 'Worker did not return sessionId.'],
  ['提交提示前没有连接。', 'No connection is available before prompt submission.'],
  ['discoverModels 需要一个绝对路径的工作区来建立会话。', 'discoverModels requires an absolute workspace path to create a session.'],
  ['提供商 id 无效。', 'Invalid provider ID.'],
  ['来源或目标提供商插件缺失、停用、动态启用或有多个实例，无法确定同步对象。', 'The source or target provider plugin is missing, disabled, dynamically enabled or ambiguous; a synchronization target cannot be selected.'],
  ['提供商配置结构不支持同步。', 'Provider configuration structure does not support synchronization.'],
  ['来源提供商配置不是对象。', 'Source provider configuration is not an object.'],
  ['目标 providers 结构不支持同步。', 'Target providers structure does not support synchronization.'],
  ['配置在确认期间被修改，停止同步；请重新预览。', 'Configuration changed during confirmation; synchronization stopped. Preview it again.'],
  ['同步配置锁不可用；确认没有其他配置进程后重试。', 'Synchronization lock unavailable; confirm that no other configuration process is active before retrying.'],
  ['自定义 workerArgs 可能带有配置覆盖；请通过缓存或手工选择并用运行时目录核验。', 'Custom workerArgs may override configuration; use the cache or manual selection and verify against the runtime catalogue.'],
  ['未找到当前 worker 的可读 DSH 包；可使用缓存或手工输入（ASAR-only 暂不支持静态读取）。', 'No readable DSH package found for this worker; use the cache or manual input. Static inspection of ASAR-only packages is not available yet.'],
  ['所选 DSH profile 尚未初始化；本脚本不会创建或迁移它。', 'The selected DSH profile is not initialized; this script will not create or migrate it.'],
  ['当前 DSH 的只读配置接口不兼容或配置无法解析；可使用缓存或手工输入。', 'The DSH read-only configuration interface is incompatible or configuration cannot be parsed; use the cache or manual input.'],
);
messages.push(
  ['配置必须是 JSON 对象。', 'Configuration must be a JSON object.'],
  ['契约请求的路由不存在：{0}', 'Requested task route is unavailable: {0}'],
  ['模型 {0} 不在当前 worker 公布的目录中。', 'Model {0} is not in the catalogue published by this worker.'],
  ['推理档位 {0} 不在当前选项内。', 'Reasoning effort {0} is not among the current options.'],
  ['不允许的状态转换：{0} -> {1}', 'Invalid state transition: {0} -> {1}'],
  ['不允许覆盖字段：{0}', 'Cannot overwrite protected field: {0}'],
  ['record 不是对象', 'record is not an object'],
  ['{0} 缺失', '{0} is missing'],
  ['status 非法：{0}', 'Invalid status: {0}'],
  ['revision 非法', 'Invalid revision'],
  ['sessionId 非空时必须是非空字符串', 'A non-null sessionId must be a non-empty string'],
  ['attempts 非法', 'Invalid attempts'],
  ['replayCount 必须是非负整数', 'replayCount must be a non-negative integer'],
  ['{0} 必须是数组', '{0} must be an array'],
  ['resolution 必须是对象或 null', 'resolution must be an object or null'],
  ['resolution.replayed 必须是布尔值', 'resolution.replayed must be a boolean'],
  ['resolution.replayed 为 true 时必须记录 {0}', 'resolution.replayed=true requires {0}'],
  ['{0} 必须是正整数毫秒。', '{0} must be a positive integer in milliseconds.'],
);
// Only these placeholders contain nested diagnostics. Paths and IDs stay literal.
const nested = new Map([
  ['任务契约校验未通过（{0} 项）：{1}', [1]],
  ['配置校验未通过：{0}\n  · {1}', [1]],
  ['任务记录不合法（{0}）：{1}', [1]],
  ['拒绝写入不合法记录：{0}', [0]],
  ['任务 {0} 当前状态为 {1}，不接受裁定。{2}', [2]],
]);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = messages.map(([zh,en]) => {
  const indexes = [];
  const parts = zh.split(/\{(\d+)\}/);
  const pattern = parts.map((part,i) => i % 2 ? (indexes.push(Number(part)), '([\\s\\S]*?)') : escape(part)).join('');
  return { pattern: new RegExp(`^${pattern}$`), en, indexes, nested: nested.get(zh) ?? [] };
});
export function translateDiagnostic(message, language = 'en', depth = 0) {
  const text = String(message);
  if (language === 'zh-CN' || depth > 6) return text;
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const values = {};
    rule.indexes.forEach((index,i) => { values[index] = rule.nested.includes(index) ? translateDiagnostic(match[i+1],language,depth+1) : match[i+1]; });
    return rule.en.replace(/\{(\d+)\}/g, (_,i) => values[i]);
  }
  const field = /^(\$|[A-Za-z][\w.\[\]]*): ([\s\S]*)$/.exec(text);
  if (field) return `${field[1]}: ${translateDiagnostic(field[2],language,depth+1)}`;
  if (text.includes('\n')) return text.split('\n').map(line => {
    const m = /^(\s*(?:· )?)(.*)$/.exec(line);
    return m[1]+translateDiagnostic(m[2],language,depth+1);
  }).join('\n');
  if (text.includes('；')) return text.split('；').map(part => translateDiagnostic(part,language,depth+1)).join('; ');
  // Unrecognized upstream diagnostics remain literal rather than losing details.
  return text;
}
export function formatCliError(error, language = 'en') {
  const lines = [translateDiagnostic(error?.message ?? String(error), language)];
  if (error?.code) lines.push(`code=${error.code}`);
  if (error?.hint) lines.push(`${language === 'zh-CN' ? '提示' : 'Hint'}: ${translateDiagnostic(error.hint,language)}`);
  return lines.join('\n')+'\n';
}
