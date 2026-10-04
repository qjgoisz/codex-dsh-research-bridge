# 配置与状态兼容

新 bridge.config.json 为 schema 2。schema 1 由校验器只读加载，在内存中补全新字段；没有自动写回。新增 worker 入口和审批配置。配置路径默认改为当前启动目录，部署时推荐显式 --config。显式配置缺失、未知 CLI 选项、重复标量参数和非法覆盖会报错，不回退为其他配置或路由。

reasoningEffort 只做字符串结构校验，最终按 worker 公布的 configOptions 校验。null（兼容旧空字符串）表示 provider 默认；明确关闭推理需要 provider 实际支持的选项。

新任务不要求 permissions、reversePolicy、allowRecursiveDelegation；省略时仍采用仅咨询、不递归的语义。旧工具列表仅在明确提供时参与审批；旧 readPaths/writePaths 不扩大运行环境权限。希望采用新审批方式时应在**新任务**中省略 tools，不要改写已执行任务的契约。

任务与会话存储外层仍为 schema 1，保留旧字段与指纹；新 workerSnapshot 和审批事件是附加字段。旧任务可读取，但未结算记录仅作为恢复报告，不自动重放。桥的默认模型/推理变化不能改写历史任务的应用快照。

默认不接管原版桥状态。复用旧状态前应停掉旧写者、确认 worker 退出、备份整个状态目录，并使用副本进行 inspect；不能让两版桥写同一个目录。本轮未迁移现场研究状态。

配置 schema 1 的旧离线准入政策不被移植；network=true 现在是允许的契约。旧 permissions.network=false 继续表达任务的离线意图。环境审批、文件访问及凭据管理继续由 DSH 原机制负责。

会话映射中的 capabilities 为历史兼容名称，当前仅编码 provider/model/reasoning；新接口内部明确命名为 modelRouteFingerprint。没有自动把 Git 分支、输入提交或工具集合纳入会话身份，输入变化需显式更新 contextRevision。

独立 Codex 咨询实例、自动升级/监控、Windows/macOS Desktop 安装发现均未新增。项目许可证为 GPL-3.0-only，见 LICENSE。升级后应以新测试目录验证上游能力，不改变或重放研究会话。
