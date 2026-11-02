# 通用能力目录

[场景方案](README.md)

本目录基于 2026-11-02 的本地源码核对。**“已有”表示存在实现，不代表已通过目标环境、并发规模或所有部署形态的验收。** Cxx 是文档中的能力编号，不是现有 API、配置参数或已实现插件接口。

## 能力与实现边界

| 编号 | 通用能力 | 当前基础 | 差距与扩展归属 |
| --- | --- | --- | --- |
| C01 | Agent 执行与模型连接 | Codex 循环；AgentCore 模型连接；部署侧模型与 thinking 策略；超时、中断 | 当前只支持 Codex；企业模型网关需平台连接配置与协议验证，不支持请求覆盖模型、Key、endpoint 或任意 Header |
| C02 | 可替换执行环境 | local OS 沙箱、sandbox 远端文件/Shell、tools-only；远端惰性获取与会话复用 | 云平台负责运行时容器隔离；工具沙箱多副本租约、恢复、回收管理与配额待补；不包含浏览器登录态管理 |
| C03 | 版本化 Skill 装配 | `name@version`；SDK 缓存；local 安全投影；sandbox 分片导入与完成标记 | 企业 Skill 源拉取、审批发布、依赖构建、热更新策略需控制面/供应链适配；不自动透传个人环境变量 |
| C04 | 业务工具接入 | AgentCore MCP 发现、独立 deadline、降级 warning、结构化工具结果 | 企业 API、办公 CLI、搜索、浏览器、知识库需具体 MCP/Skill；业务权限与幂等由连接器落实 |
| C05 | 输入文件、工作空间与产物 | OSS 附件校验/物化；local 用户会话路径；远端工作根；`publish_artifact` 与文件 ID 映射 | 附件确认/票据签发和文件下载服务由应用提供；产物目录查询、保留期限、共享授权与垃圾回收待补 |
| C06 | 身份与凭证边界 | 平台工作负载身份、动态凭证；随机内部 Token；STS Broker 要求可信业务 Policy | 不等同于用户 SSO/OAuth/OBO；用户映射、授权范围、撤销刷新、个人/团队身份和脚本定向注入待设计 |
| C07 | 交互与人工确认 | AG-UI/SSE；客户端工具；vendored HITL 挂起/恢复 | 业务审批策略、持久可信历史、重放防护及跨渠道 UI 需接入验证；不能只靠提示词授权高影响操作 |
| C08 | 检索、知识与联网 | 可通过 MCP 调用外部检索、搜索、抓取与业务数据服务 | 未内置 RAG 索引/同步/重排，也未内置搜索套餐；来源引用、ACL 过滤、费用和限流由对应服务负责 |
| C09 | 浏览器与多模态工具 | local 模式存在受限图片读取/生成路径；可扩展 MCP | sandbox 当前不注册本地图片工具；Browser SDK/浏览器 MCP、截图协议、Cookie/Profile 生命周期与隔离待集成 |
| C10 | 会话与记忆 | 输入历史事件/消息适配；内核事件压缩与会话运行状态；`/v1/runs` 列出当前运行 | 不是按用户持久化的历史会话 API；会话列表/详情/资源快照、长期记忆抽取与召回、删除与保留策略待补 |
| C11 | 多渠道与部署接入 | HTTP `/v1/run`、AG-UI；自定义 Node 镜像；部署教程 | 飞书/其他 IM 与 Web 工作台需接入适配；第三方 Agent 纳管不是现有通用 API；平台托管镜像不等于本项目镜像 |
| C12 | 观测与质量证据 | AgentLoop / OTel；run、模型、工具等事件观测；启动耗时；安全诊断；默认不采集正文 | 双平台导出、跨 Agent trace 传播、评测数据集、评估器和长轨迹评测策略需另行接入 |
| C13 | 后台与周期任务 | HTTP 入口可供外部调度调用；有运行超时和取消基础 | 未内置 scheduler、任务持久化队列或调度授权；幂等、重试、并发控制、撤销授权与通知需适配 |
| C14 | 多 Agent 协议协作 | vendored Runloop 含 A2A/委派相关代码 | 当前包装层未提供完整 AgentCard、注册发现、对外 A2A 与级联观测链；需以独立集成任务验收 |
| C15 | 运行策略与资源治理 | 部署固定资源；超时；可选资源降级；`/v1/run` 接收 `agent.maxTurns`，内核按 turn-end 计数 | AG-UI 未映射 maxTurns；缺统一策略上限/成本预算；系统提示词拼接请求指令，不能宣称已具备不可篡改安全策略 |
| C16 | 发布与基础设施集成 | Dockerfile、平台部署路径；可选沙箱 Volume metadata 解析 | 镜像源连通、VPC/跨云网络、存储、版本发布回滚、计费配额归平台；本仓库不提供多云控制面 |

## 源码定位

| 能力 | 主要入口 | 复核重点 |
| --- | --- | --- |
| C01 / C15 | [config.ts](../../src/config.ts)、[app.ts](../../src/app.ts)、[internal-api.ts](../../src/internal-api.ts)、[runner.ts](../../vendor/runloop/src/loop/runner.ts) | 只允许 Codex；部署与请求配置边界；maxTurns 的实际计数语义；模型保留字段 |
| C02 | [manager.ts](../../src/sandbox/manager.ts)、[lazy-execution.ts](../../src/sandbox/lazy-execution.ts)、[provider](../../src/sandbox/agent-sandbox-provider.ts) | `uid + conversationId` 绑定；单进程 Map；生命周期和超时；E2B SDK 对接 |
| C03 | [runtime.ts](../../src/runtime.ts)、[workspace.ts](../../src/workspace.ts)、[skill-sync.ts](../../src/sandbox/skill-sync.ts) | 版本解析；SDK 根目录；安全链接；导入完整性 |
| C04 / C08 | [runtime.ts](../../src/runtime.ts)、[internal-api.ts](../../src/internal-api.ts) | MCP 发现与调用；不要把可接入服务写成内置能力 |
| C05 | [attachment-materializer.ts](../../src/attachment-materializer.ts)、[artifacts.ts](../../src/artifacts.ts)、[session-workspace.ts](../../src/session-workspace.ts) | 短期票据与路径边界；不返回绝对交付路径；应用承担下载鉴权 |
| C06 | [sts-broker.ts](../../src/sts-broker.ts)、[app.ts](../../src/app.ts) | Workload Role 是权限上限；业务 Policy 必填；uid 真实性由接入方保障 |
| C07 / C11 | [ag-ui.ts](../../src/ag-ui.ts)、[HITL resume](../../vendor/runloop/src/hitl/resume.ts) | 请求历史与客户端工具；确认恢复路径；接入方的可信边界 |
| C09 | [app.ts](../../src/app.ts)、[配置参考](../reference.md) | local 与 sandbox 图片能力不同；浏览器需独立适配 |
| C10 | [app.ts](../../src/app.ts)、[事件压缩](../../vendor/runloop/src/events/compress.ts) | 活跃运行、会话历史与长期记忆是不同能力 |
| C12 | [agentloop.ts](../../src/agentloop.ts)、[startup-timing.ts](../../src/startup-timing.ts) | 正文采集默认关闭；导出 fail-open；评测不在运行时实现中 |
| C13 / C14 | [app.ts](../../src/app.ts)、[vendored A2A](../../vendor/runloop/src/sidecar/a2a.ts) | 有调用入口或底层代码不等于已有调度/协议产品闭环 |
| C16 | [Dockerfile](../../Dockerfile)、[部署教程](../agentcore-guide.md)、[volume-resolver.ts](../../src/sandbox/volume-resolver.ts) | 镜像、网络和存储的外部依赖 |

## 通用扩展契约建议

以下是后续设计约束，尚未定义为可调用 API：

- **身份上下文**：接入方验证 tenant/user/team/会话；运行时只接受可信映射。工作负载身份与用户授权分开，禁止用公开用户标识换取不受限凭证。
- **凭证解析**：按主体、目标服务、操作范围和授权有效期解析短期凭证；默认在连接器执行边界使用，不进入模型、共享 Skill 目录、全局进程环境或事件正文。若 CLI 必须读取环境变量，仅在被授权子进程注入，并验证输出脱敏和结束后清理。
- **执行环境**：装配所需运行时/依赖/网络策略，提供创建、连接、执行、中断、续期、释放契约；工作目录与交付根分离；失效不得绕过隔离回退。
- **会话记录**：以用户和会话为权限边界保存消息/事件、run 状态、资源版本、产物索引及 trace 引用；持久化恢复不依赖某个服务实例内存。恢复确认操作须使用可信历史。
- **结果与证据**：工具保留结构化内容与错误状态；交付使用稳定文件 ID；观测关联 run、会话和工具；数据导出单独授权并明确保留期。
- **运行策略**：部署侧限制轮次、耗时、调用预算、目标工具、外部访问和审批；请求只能在上限内收紧，不能借参数改变模型、资源、身份或工作根。

## 容易混淆的边界

1. **Agent 容器与工具沙箱**：`sandbox` 移出的是文件/Shell 执行；Agent 容器本身仍需要平台隔离与治理。
2. **会话复用与历史管理**：复用沙箱并不提供历史会话列表、资源展示或分析接口。
3. **资源凭证与个人授权**：`AgentCore.credentials.get()` 和 STS Broker 不能直接代替飞书/企业 SSO 的用户委托。
4. **工作持久化与产物交付**：Volume 保存工作文件；`publish_artifact` 负责交付文件。共享存储不自动形成共享权限。
5. **Skill 内容与运行依赖**：装配 Skill 不承诺任意 Python/浏览器/办公 CLI 已安装；依赖需受控构建与版本验证。
6. **local 联网与服务联网**：local 原生 Shell 禁止联网；业务联网走 MCP，或使用显式配置网络策略的远端沙箱。
7. **观测与记忆/评测**：Trace 是执行证据；长期记忆、用户会话历史和质量评测需要不同的数据模型与权限。
8. **系统提示词与强制策略**：部署提示词已有，请求也可提供指令；不可修改的授权边界必须由代码和服务策略实现。
