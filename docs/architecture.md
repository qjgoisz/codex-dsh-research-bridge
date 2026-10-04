# 架构与不变量

```text
Codex → MCP stdio → durable coordinator → ACP stdio → DSH worker
                        ↓                   ↑
                 tasks / session map    updates / approvals
```

主体沿用 Node.js 24 ESM，保留参考实现的经故障测试覆盖的协议与生命周期逻辑。平台代码集中到 src/platform；启动参数、安装发现与运行时能力均作为适配事实，核心不读取 Desktop 私有配置或凭据。

| 模块 | 责任 |
| --- | --- |
| cli / config | 命令、部署配置、整体校验和优先级 |
| mcp-server / acp-client | 两侧协议帧、请求关联、版本与错误 |
| orchestration | 意图落盘、会话获取、任务派发、结算与恢复 |
| state / store / session-map | 纯状态转换、单写者原子存储、会话 generation |
| workspace-queue | 重叠目录排队，避免不同会话竞争相同文件 |
| prompts | 任务、独立异议、澄清历史及科研约定 |
| collector / observation / usage / fingerprint | 正文与用量观测、提交证据和产物字节指纹 |
| permissions | 实际审批转交、选项校验、期限与审计 |
| worker / platform | 安装发现、完整 argv、POSIX/Windows 回收 |
| shutdown | 信号、EOF 和看门狗共用的有界收尾 |

必须先 queued 落盘，再 dispatching 落盘，之后启动或发送提示。模型执行与 MCP 等待预算分离；等待耗尽不代表执行失败。审批出现时等待工具提前返回待处理信息，避免主控一直等待被自身审批阻塞的任务。

任务契约指纹保证幂等。同一会话 prompt 串行；重叠工作区也串行。连接索引与所有 worker 的所有权台账分开，坏连接被删除后仍负责回收其进程。发出信号不等于观测到退出。

提交事实由实际请求写入/响应路径记录。确定未提交才可以 no_prompt；可能提交但结果不可见必须 unknown。启动后不重放未结算任务；裁定与重放分别执行。审批请求与决定落盘失败时不能回传批准。

保存 worker 的协议版本、能力、入口、平台与运行时快照；模型路由在执行前设置并保存任务快照。历史 capabilities 字段兼容保留，其内容仅是模型路由指纹，不表示工具权限。有效工具集合目前没有通用自动发现保证。

usage used/size 表示上下文占用，不能解释为缓存 token 或成本。无有效样本是未观测。前缀一致性仅是字符串证据。completed、模型意见一致或文件指纹均不能证明科研结论正确。

当前反向路径仍为显式澄清结束该轮，主控回答后续跑。独立 Codex 咨询实例未实现；此功能需要另外明确咨询预算、授权与递归停止边界。
