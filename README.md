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

真实 DSH 的接入需按安装版本进行独立探测与验收。已提供离线回归、无模型协议探测和显式真实模型冒烟；Windows/macOS 官方 Desktop、ARM64 与活跃 WebUI 聊天共享仍待验证。详见兼容性说明。

- [使用与部署](docs/usage.md)
- [Windows 与 macOS 快速开始](docs/usage.md#windows-与-macos-快速开始)
- [架构与不变量](docs/architecture.md)
- [兼容性与验证记录](docs/compatibility.md)
- [配置与状态兼容](docs/migration.md)
- [许可证](LICENSE)
- [来源与版权声明](NOTICE.md)
- [参与开发](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)
- [发布流程](docs/releasing.md)

```sh
npm run check
npm test
npm run test:unit
npm run smoke
```

默认测试使用 fake ACP worker，无需 DSH、凭据、网络或模型费用。`probe` 会启动真实 DSH 并创建隔离测试会话，但不发送模型提示。`smoke -- --allow-model --config <配置文件>` 才会调用真实模型；使用独立测试工作区和状态，不复用研究会话。

本项目采用 GNU GPL v3.0（GPL-3.0-only），见 LICENSE。当前保留 private=true，未发布 npm 包。
