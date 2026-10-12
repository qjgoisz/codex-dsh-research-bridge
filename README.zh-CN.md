[English](README.md) | [简体中文](README.zh-CN.md)

# codex-dsh-bridge

持久化的 MCP → ACP 科研委派桥。Codex 组织目标、上下文和验收，DSH 执行推导、计算与文件工作；桥记录任务、会话、路由和结果证据。`completed` 表示执行轮次结束，科研结论仍需独立验收。

当前实现使用 Node.js 24 ESM，无直接依赖。支持 stdio MCP、ACP v1、任务幂等、澄清续跑、会话恢复、模型路由和有界收尾。默认不要求工具清单，也不强制离线。DSH 实际发出的审批默认通过 `dsh_approvals` / `dsh_approve` 转交主控。

```sh
node src/cli.mjs --help
node scripts/configure-bridge.mjs
node src/cli.mjs preflight
node src/cli.mjs serve --state-root ./bridge-state
```

在仓库目录运行。交互式配置脚本跨平台，预览校验后确认保存，修改已有文件时保留原始备份；也可用 `config --init` 仅创建默认配置。模板默认 deepseek-official/deepseek-flash/high；运行时目录是路由与推理选项的依据，不会自动换模型。凭据继续由 DSH 管理。

使用 Desktop 时运行 `node scripts/configure-bridge.mjs --desktop`，按提示指定安装目录以定位 CLI；不会启动图形应用或调用模型。交互页面会提示 `.app`、`Contents/Resources` 与 `resources` 的常见结尾。微信/账号登录应选择 `deepseek-account` 并共用 Desktop 的 DSH home；`deepseek-official` 需要 API 密钥，Desktop 预置不会自动切换路由。入口布局及平台限制见使用文档。

真实 DSH 的接入需按安装版本进行独立探测与验收。已提供离线回归、无模型协议探测和显式真实模型冒烟；Windows/macOS 官方 Desktop、ARM64 与活跃 WebUI 聊天共享仍待验证。详见兼容性说明。

- [使用与部署](docs/zh-CN/usage.md)
- [Windows 与 macOS 快速开始](docs/zh-CN/usage.md#windows-与-macos-快速开始)
- [架构与不变量](docs/zh-CN/architecture.md)
- [兼容性与验证记录](docs/zh-CN/compatibility.md)
- [配置与状态兼容](docs/zh-CN/migration.md)
- [许可证](LICENSE)
- [来源与版权声明](NOTICE.md)
- [参与开发](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)
- [发布流程](docs/zh-CN/releasing.md)
- [澄清前缀账本实验](docs/zh-CN/prompt-ledger-experiment.md)

```sh
npm run check
npm test
npm run test:unit
npm run smoke
```

默认测试使用 fake ACP worker，无需 DSH、凭据、网络或模型费用。`probe` 会启动真实 DSH 并创建隔离测试会话，但不发送模型提示。`smoke -- --allow-model --config <配置文件>` 才会调用真实模型；使用独立测试工作区和状态，不复用研究会话。

本项目采用 GNU GPL v3.0（GPL-3.0-only），见 LICENSE。当前保留 private=true，未发布 npm 包，发布待定。

## 文档语言

公开文档以英文（`*.md`、`docs/en/`）与简体中文（`*.zh-CN.md`、`docs/zh-CN/`）维护，英文为默认入口。每个页面带有双向语言链接，对应文件保持相同基本文件名。行为变更须在同一 PR 内同时更新两种语言；措辞修正可只改一种语言，延迟的译文以所滞后的源版本号或日期标注。标识符、选项、错误码与 JSON 保持不译。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## CLI 错误语言

CLI 错误默认使用英文。`--lang en`、`--lang zh-CN` 或环境变量 `DSH_BRIDGE_LANG` 选择错误输出语言；两者同时存在时命令行标志优先。该策略覆盖 CLI 错误与帮助输出；交互式配置提示、菜单与预览不声明已全部翻译。面向人的错误保留稳定错误码与上游原始诊断文本。历史任务记录、JSON 载荷、协议记录与研究提示不会被改写为其他语言。见[使用与部署](docs/zh-CN/usage.md#cli-语言与错误输出)。
