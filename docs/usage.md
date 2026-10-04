# 使用与部署

需要 Node.js 24+，以及具有 ACP v1 入口的 DSH 安装。先确认 DSH 自身能使用所需 provider/model；桥不配置凭据、不初始化 profile，也不修改 Codex 或 DSH 配置。使用原有 DSH 安装的 ACP worker 不代表共享 WebUI 的活跃聊天。

## Windows 与 macOS 快速开始

以下按源码仓库使用，需要先安装 Node.js 24+、Git 和可用的 DSH ACP 入口。无需 Bash 或额外 npm 依赖。

### Windows（PowerShell）

```powershell
git clone https://github.com/qjgoisz/codex-dsh-research-bridge.git
cd codex-dsh-research-bridge
node --version
node scripts/configure-bridge.mjs
node src/cli.mjs preflight
```

配置使用 `transport=direct`。若自动发现不能定位 DSH，填写 `nodeBin` 为实际 `node.exe` 路径、`workerEntry` 为 DSH 的 JS CLI 入口，`workerArgs=null` 使用默认 profile 参数；自定义完整参数时填写 JSON 数组。不要把 `.cmd` / `.bat` 作为 `workerCommand`。JSON 中的反斜杠须写成 `\\`，或使用正斜杠。

向 MCP 客户端登记实际 `node.exe` 为 command，args 为下面命令中 `node` 之后的各项，使用绝对路径：

```powershell
node "<桥目录>/src/cli.mjs" serve --config "<配置文件>" --state-root "<独立状态目录>"
```

### macOS（Terminal）

```sh
git clone https://github.com/qjgoisz/codex-dsh-research-bridge.git
cd codex-dsh-research-bridge
node --version
node scripts/configure-bridge.mjs
node src/cli.mjs preflight
```

同样使用 `transport=direct`，不要选择 Linux 专用的 `posix-pipes`。向 MCP 客户端登记 Node 的绝对路径（可用 `command -v node` 查看），args 使用 `src/cli.mjs serve --config ... --state-root ...` 的各项绝对路径。图形应用不一定继承终端 PATH。

两个平台的 Desktop 都应先确认对应客户端版本确实提供 CLI/ACP 入口；需要时配置显式运行时与入口，不假定安装包内部路径。原生 Windows/macOS 官方 Desktop 尚未验收，以上是启动与配置步骤。`preflight` 是安装/配置预检；完整协议验证可运行 `node scripts/probe.mjs --config <配置> --report <新的报告文件>`，它会启动测试 worker，但不发送模型提示。

## 配置

推荐使用交互式配置：

```sh
node scripts/configure-bridge.mjs
# Linux/macOS 也可使用薄入口
sh scripts/configure-bridge.sh
# 或
npm run configure
```

连接 Desktop 时，可让配置脚本查找安装目录中的 CLI 启动器：

```sh
node scripts/configure-bridge.mjs --desktop
# 或指定目录，仅预览、不保存
node scripts/configure-bridge.mjs --desktop-root "<Desktop 安装目录>" --check
```

交互式目录问答前会显示路径说明：

| 输入类型 | 常见结尾或示例 |
| --- | --- |
| macOS 应用包 | `/Applications/<应用名>.app` |
| macOS 资源目录 | `<应用名>.app/Contents/Resources`，注意大写 |
| Linux 安装根目录 | 如 `/usr/lib/deepseek-harness`，没有固定后缀 |
| Linux/Windows 资源目录 | 通常以 `/resources` 结尾 |

脚本在这些目录下查找 `runtime/cli/bin/dsh`（Windows 为 `dsh.exe`）。
这是安装入口，不是用户配置目录 `~/.dsh`；无需新增启动包装脚本。

#### Desktop 微信/账号认证

`deepseek-account` 使用 Desktop 账号登录，包括微信登录；`deepseek-official` 是需要
`DEEPSEEK_API_KEY` 的 API 路由。Desktop 预置保留已有 provider/model，不会自动切换认证。
希望复用账号登录时，显式选择账号路由，且桥的 `dshHome`（或 `DSH_HOME`）应与 Desktop 相同，
通常为 `~/.dsh`；桥仍使用 `acp` profile，不复制 Desktop 的整个 profile 补丁或凭据库。

```sh
node scripts/configure-bridge.mjs --desktop-root "<安装根目录、.app 或资源目录>" --set provider deepseek-account --set model deepseek-flash --set profile acp --check
```

确认预览后去掉 `--check`，按提示保存，再重启桥。模型 id 以实际 worker 目录为准；
目录读取或结构校验成功不等于认证成功，需要另行验证一次真实模型回答。
若仍报 `DEEPSEEK_API_KEY` 缺失，检查生效路由是否仍为 `deepseek-official`。
不要在桥配置或文档中填写登录 token 或 API 密钥。Windows/macOS 原生账号调用尚未验收。

`--desktop` 会先询问安装目录，再进入通常的字段问答和保存确认。也可传入 macOS `.app` 或 `Resources` 目录。脚本检查 `resources/runtime/cli/bin/`、`Contents/Resources/runtime/cli/bin/` 和直接提供的 Resources 目录；Linux/macOS 查找可执行 `dsh`，Windows 查找 `dsh.exe`。这些是限定的候选布局，不保证每个 Desktop 版本都有相同入口；若仅有 `.cmd/.bat` 或未找到入口，会明确报错，不执行图形启动器。Windows/macOS 原生兼容性仍需独立验证。

Desktop 预置设置 `workerCommand` 和 `transport=direct`，清除旧 npm 根与 JS 运行时覆盖；保留 provider/model、推理档位、profile、dshHome 和审批策略。`workerArgs=null` 表示按当前 profile 构建默认参数。显式 `--set` 优先于预置；最终预览为准。不会启动 Desktop、修改其配置、迁移凭据或静默切换模型。保存后先运行 preflight 和独立 probe；模型路由与真实委派需另外验收。

Enter 保留当前值；可空字段输入 `null`，`workerArgs` 输入 JSON 字符串数组。脚本预览完整 schema 2 配置并校验，最后输入 `y` 才保存。已有文件会按原始字节备份为 `bridge.config.json.bak.*`；内容未变时不写入、不备份。原配置中的 `_` / `$` 注释字段保留；保存旧 schema 1 时升级为 schema 2。检测到外部修改、符号链接或其他配置进程的锁时拒绝覆盖。默认配置路径是启动目录；用 `--config` 指定其他位置。

脚本只读取桥配置及已有的 `models.json` 缓存，不启动 DSH、不调用模型，也不修改 DSH profile、凭据或 Codex 设置。用 `--state-root` 指向桥状态目录即可显示缓存中的 provider/model 菜单；无缓存时手工填写。缓存可能过期，结构校验通过不表示模型、档位或安装已验证。审批默认 `ask`；选择 `allow-once` 会自动批准 DSH 发出的单次允许选项。

批量设置与只读预览沿用原版参数：

```sh
node scripts/configure-bridge.mjs --set reasoningEffort null --check
node scripts/configure-bridge.mjs --config ./custom.json --set provider deepseek-official --set model deepseek-flash --yes
node scripts/configure-bridge.mjs --help
```

`--check` 不问答、不写文件；`--yes` 使用指定值或当前默认值，预览校验后直接保存。`--set` 可重复，跳过字段问答但仍需要保存确认，除非同时使用 `--yes`。原版的 `--mount-acp` 未移植，DSH 配置继续由 DSH 管理。

在桥目录执行：

```sh
node src/cli.mjs config --init
node src/cli.mjs config
node src/cli.mjs preflight
```

配置优先级为 CLI 参数、配置文件、内置默认。默认配置和状态位于启动目录，不写进安装包目录。自定义配置使用 `--config <文件>`，缺失默认配置时使用内置值；显式指定的配置文件缺失会报错。

| 配置 | 行为 |
| --- | --- |
| schema | 新配置为 2；旧 schema 1 可读取 |
| provider / model | 可读路由，桥编码协议选择值 |
| reasoningEffort | 非空 provider 档位；null 沿用 provider 默认 |
| exposeModelChoice | 默认 false；true 暴露 dsh_models 和任务路由覆盖 |
| profile | 默认 acp；必须具有 ACP 入口 |
| dshHome / dshRoot | 可选 DSH home 与 npm 安装根；不含凭据 |
| workerCommand / workerArgs | 显式可执行文件与完整 argv；args=null 使用默认 profile 参数 |
| workerEntry / nodeBin | JS 入口与运行时；适用于显式安装/捆绑运行时 |
| transport | direct；Linux 可显式选择 posix-pipes |
| promptTimeoutMs | 单次模型执行预算，默认 30 分钟 |
| requestTimeoutMs | ACP 控制请求预算，默认 30 秒 |
| approvalMode | ask（默认）、deny、allow-once |
| approvalTimeoutMs | 待处理审批预算，默认 5 分钟 |

DSH npm 安装优先通过 PATH 上的启动器发现实际包根，再以当前 Node 运行 JS 入口。Desktop 使用经验证的显式可执行文件/运行时与完整 argv；桥不假定 Windows/macOS bundle 的私有目录。Windows .cmd/.bat 启动器需要改用 node.exe 与 JS 入口，避免 shell 插值。

## MCP 服务

将下列命令作为 MCP stdio server 启动命令登记到主控客户端。文件与状态路径应使用本机绝对路径，避免客户端启动目录变化。

```sh
node <桥目录>/src/cli.mjs serve --config <配置文件> --state-root <独立状态目录>
```

| 工具 | 用途 |
| --- | --- |
| dsh_delegate | 校验、落盘和异步派发；默认等待最多30秒，waitMs=0立即返回 |
| dsh_status / dsh_result | 查询状态、正文、用量与产物指纹 |
| dsh_reply | 回答 needs_clarification，参数 id 与 answer |
| dsh_cancel | 请求取消；cancelled 才表示已确认取消 |
| dsh_resolve / dsh_retry | 先裁定 unknown，再显式重试；每个任务最多一次重放 |
| dsh_approvals / dsh_approve | 查看原始待审批选项，回传已获授权的选项及理由 |
| dsh_models | 开启模型选择后读取/刷新运行时目录 |

最小契约需要 id、objective、phase、workspace、plan、acceptance。workspace 必须为本平台已存在的绝对路径；阶段可为 explore、numerics、writing、maintenance、generic。research 可记录模型、单位、假设、参数范围、输入提交与未决问题；deliverables 指定需要描述与计算指纹的文件。

示例见 examples/task.json。文件使用 __WORKSPACE__ 占位，提交前替换为实际绝对路径。支持路径中的空格与中文。不要将 Windows 路径字符串直接套用为 POSIX 路径。

新任务无需 permissions；旧 readPaths/writePaths 是任务约定及产物证据，不构成文件系统授权。network=false 会在提示中表达离线要求；真正访问范围由 DSH 自身运行环境决定。显式提供旧 tools 列表时仍按该列表处理审批，省略时采用配置的审批策略。

默认 ask 在 DSH 实际发出审批时暂停该操作，主控可同时查询。dsh_approve 的 optionId 必须来自 dsh_approvals，reason 应记录已有用户授权或审批理由。它不自行扩大用户授权。allow-once 是操作者显式选定的自动单次批准策略，不能选择 allow_always；deny 拒绝请求。审批只覆盖 DSH 实际发出的请求，不能保证所有工具都经过此通道。

## 会话与恢复

同项目、阶段、工作区、contextRevision 和模型路由复用会话。同连接活跃会话直接继续；重连后尝试 resume；恢复失败记录原因及 generation 轮换。输入或分支变化需调用方调整 contextRevision，桥不会自动检测 Git 分支。重叠工作区串行执行，互不重叠的目录可并行。

同任务 id 和相同契约返回已有记录，不会重新执行；不同内容报冲突。超时与断线可能留下副作用，unknown 不自动重放。桥重启仅报告未结算任务；先核对工作区与 worker，再显式裁定和重试。resolve 只接受 unknown，不接受仍可能运行的 cancelling。

## 诊断与维护

```sh
node scripts/probe.mjs --config <配置文件> --report <新的报告文件>
node src/cli.mjs inspect --state-root <状态目录>
node src/cli.mjs models --config <配置文件> --state-root <状态目录> --workspace <测试目录> --refresh
node src/cli.mjs unlock --state-root <状态目录> --stale
```

probe 不发模型提示；它创建新的测试目录、测试会话并尝试关闭/恢复，DSH 可能保存元数据。上游升级后用独立状态做验证，不改写旧研究状态。活动写者的锁不能按年龄抢占；unlock --stale 仍拒绝活动写者。

退出 MCP 服务会有界回收其 worker 并释放写锁；观测不到退出时如实报告。卸载只需撤销主控的 MCP 登记并停止桥；研究状态由用户决定保留，桥不自动删除 DSH 会话或研究数据。


CLI 的 delegate/reply/retry 是单次执行工具，需明确 --approval-mode deny 或 allow-once，并等待结算后退出。交互审批与异步任务使用长期运行的 serve/MCP 工具；CLI 不会声称退出后仍有后台模型任务。--wait 保留为兼容参数。
