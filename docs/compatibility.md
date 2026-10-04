# 兼容性与验证

桥使用 Node.js 24+ 与 ACP v1。平台启动适配和离线模拟不等于实际客户端兼容性；升级 DSH 后应使用独立工作区、配置与状态重新验收。

| 入口或平台 | 验证方式 | 限制 |
| --- | --- | --- |
| bridge + fake ACP | 离线回归、审批/产物、会话复用、澄清、取消、unknown、EOF 收尾 | 不证明真实 provider 或 Desktop 行为 |
| npm DSH + ACP profile | probe 与显式真实模型冒烟 | 独立 ACP 会话，不保证共享 WebUI 活跃聊天或全部 web 插件 |
| posix-pipes | Linux 上显式选择并独立探测 | Linux 专用可选传输 |
| Linux Desktop CLI/ACP | 新桥经 MCP 的隔离模型冒烟通过：产物、模型路由、会话复用、澄清、取消响应、输入保护与 EOF 收尾 | 不证明图形界面操作、运行中工具中断或其他构建兼容性；不同版本仍需独立验收 |
| Windows/macOS 官方 Desktop | 配置启动器/运行时与完整 argv，再执行独立验收 | 原生客户端尚未验收 |
| ARM64 | 按对应安装与架构验证 | 尚未验收 |

WebUI 和 ACP 的 profile 可能加载不同插件；共享 DSH 核心不能证明配置、工具与会话行为全部相同。握手记录协议版本、agent 身份与 capability，模型路由按实际 configOptions 校验，不静默替换模型。

检查会话列表时应区分活跃会话与已关闭会话；有些实现会过滤活跃会话。测试新建、关闭、list、resume，并保留原始响应，不能仅凭列表缺项判断持久化失败。

ACP 审批 kind 使用 allow_once/reject_once，optionId 是原请求提供的不透明值。桥按 kind 找到选项并回传原 optionId，不构造选项，也不自动选 allow_always。[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)

## 离线验证

```sh
npm run check
npm run test:unit
npm test
npm run smoke
```

CI 配置在 Linux、Windows、macOS 执行语法与单元测试；完整历史回归暂在 Linux 运行，因为其中仍有 POSIX 路径和进程观测测试。CI 配置存在不表示远端 CI 已通过，应以实际运行记录为准。

## 真实 DSH 验证

```sh
node scripts/probe.mjs --config <配置> --report <新的报告文件>
node scripts/probe.mjs --config <配置> --transport posix-pipes --report <另一个新的报告文件>
node scripts/smoke.mjs --allow-model --config <配置> --report <新的科研验收报告>
```

probe 不发送模型提示，但会启动 DSH 并创建测试会话。真实模型冒烟须明确选择 `--allow-model`，并使用独立测试实例与状态目录。记录系统、架构、运行时、DSH/ACP 版本、启动入口、有效配置及原始观测；报告存放在 Git 忽略目录，不随源码发布。

真实冒烟检查算术文件、输入字节保护、活会话复用、澄清、取消响应和收尾。算术夹具不能证明物理理论；cancelled 响应也不能单独证明运行中的 shell 或工具已经中断。窗口关闭、进程退出和工具中断需要分别验证，不能关闭操作者正在使用的研究实例。

初始化超时或 EOF 需要独立 fake 与真实 worker 对照，记录运行环境和原始错误；不自动归因于沙箱，也不把沙箱外运行设为默认部署要求。
