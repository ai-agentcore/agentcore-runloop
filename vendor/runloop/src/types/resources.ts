// Runloop internal types for the AgentCore Codex distribution.
import { z } from "zod";

/** 模型配置 */
export const ModelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().describe("Required at runtime — agent CLI must not call upstream LLM directly").optional(),
  apiKey: z.string().describe("Required at runtime — used by ModelProviderProxy").optional(),
  maxTokens: z.number().int().optional(),
  temperature: z.number().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** 平台凭证 */
export const CredentialsSchema = z.object({
  accessKeyId: z.string().describe("Platform access key ID"),
  accessKeySecret: z.string().describe("Platform access key secret"),
  securityToken: z.string().describe("STS temporary security token").optional(),
  accountId: z.string().describe("Platform account ID").optional(),
  region: z.string().describe("Region (e.g. cn-hangzhou)").optional(),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

/** 灰度/实验开关（Phase 1 暂空） */
export const FeaturesSchema = z.object({
  toolBridge: z.literal("mcp").describe("Expose tools through the in-process MCP server.").optional(),
  execViaMcp: z.boolean().describe("命令执行（shell）的归属：`true`（**默认**）=关掉 agent CLI 内建 shell，执行改走 runloop 自有的 `shell` MCP 工具（统一过 HITL 主轨闸门、可审计、后端可换远端隔离沙箱）；`false`=用 agent CLI 内建 shell（如 codex 的 exec_command，自带流式 / write_stdin）。缺省 `true`（走我们的 MCP）。运维可用 env `AGENTCORE_EXEC_VIA_MCP=0` 作为全局 kill-switch（仅当请求未显式指定时生效）。").optional(),
}).passthrough();
export type Features = z.infer<typeof FeaturesSchema>;

/** Agent CLI 运行时配置 */
export const AgentConfigSchema = z.object({
  cli: z.literal("codex").describe("Registered agent CLI name.").default("codex").optional(),
  cwd: z.string().describe("Working directory override (defaults to the conversation workspace).").optional(),
  env: z.record(z.string(), z.string()).describe("Environment variables injected into the agent CLI process. Runloop's required vars (OPENAI_API_KEY=proxy token, CODEX_HOME, NO_PROXY, dropped-privilege HOME/USER) always win; still filtered by the dropped-privilege env allowlist (cannot smuggle secrets into the non-root codex).").optional(),
  systemPrompt: z.string().describe("User-provided instructions appended after the built-in Super Agent system prompt.").optional(),
  maxTurns: z.number().int().describe("Maximum loop turns before auto-stop.").optional(),
  timeoutMs: z.number().int().describe("Timeout in milliseconds before auto-interrupt.").optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** HITL 静态规则 */
export const HitlRuleSchema = z.object({
  toolPattern: z.string().describe("Glob pattern: 'db_drop_*', '*', 'exact_name'."),
  action: z.enum(["block","ask","allow"]),
  reason: z.string().optional(),
});
export type HitlRule = z.infer<typeof HitlRuleSchema>;

/** HITL 配置（开关 + 静态规则） */
export const HitlConfigSchema = z.object({
  enabled: z.boolean().describe("Master switch (default off).").default(false).optional(),
  rules: z.array(z.object({ "toolPattern": z.string().describe("Glob pattern: 'db_drop_*', '*', 'exact_name'."), "action": z.enum(["block","ask","allow"]), "reason": z.string().optional() })).describe("Static rules: a tool call whose name matches a rule with action 'ask' is force-suspended for approval.").optional(),
  clientCapabilities: z.object({ "interactions": z.array(z.enum(["confirm","input","choice"])).describe("F1: interaction kinds the client supports and the model is allowed to trigger. Kinds not listed are not exposed to the model (except safety main-track confirm and the NL floor).").optional(), "nativeHitl": z.boolean().describe("Client can consume native toolcall.suspend events directly; when true, listed interaction kinds are delivered as native events.").default(false), "renderTools": z.record(z.string(), z.string()).describe("Optional explicit interaction-kind -> client tool name map for deterministic rendering, e.g. {\"choice\":\"super_agent_choices\"}. When an interaction has no explicit mapping and nativeHitl is false, runloop maps it to a suitable client tool (or NL) via a dedicated pure-HITL LLM call (F3).").optional() }).describe("Client HITL capability declaration (AD-026 F1/F3). runloop uses it to (F1) only let the model trigger the listed interaction kinds, and to pick the surface per suspend: native event / map to client tool / NL. Safety main-track confirm + NL floor are not gated by F1.").optional(),
});
export type HitlConfig = z.infer<typeof HitlConfigSchema>;

/** 客户端声明、客户端执行的工具 */
export const ClientToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.any()).describe("JSON Schema for the tool inputs.").optional(),
});
export type ClientTool = z.infer<typeof ClientToolSchema>;

/** 统一资源（扁平）：溯源 resourceType + 调用方式 protocol + mcpConfig|openapiConfig + 鉴权 auth */
export const ResourceSchema = z.object({
  resourceId: z.string().describe("Stable resource identifier."),
  resourceName: z.string().describe("逻辑名——用于生成暴露给模型的工具名、注入提示词。"),
  resourceType: z.enum(["FUNCTIONCALL","SKILL","AGENT","SANDBOX","SANDBOX_TEMPLATE","MCP","KNOWLEDGE_BASE","MEMORY"]).describe("Resource category; execution backends and Skill installation are managed by AgentCore."),
  description: z.string().describe("工具描述/提示词。").optional(),
  protocol: z.enum(["mcp","openapi","ag-ui","chat-completions","runloop","a2a"]).describe("调用方式——runloop 与该资源通信的协议。mcp→用 mcpConfig；openapi/ag-ui/chat-completions/runloop/a2a→用 openapiConfig（标准 OpenAPI 文档）。其中 ag-ui/chat-completions/runloop/a2a 为子 agent 委派协议（配合 resourceType=AGENT）。a2a=Agent2Agent 协议（JSON-RPC 2.0 over HTTP+SSE，message/stream 流式委派、Task/Message/status-update/artifact-update 事件）。"),
  mcpConfig: z.object({ "transport": z.enum(["stdio","http","sse"]).optional(), "command": z.string().optional(), "args": z.array(z.string()).optional(), "env": z.record(z.string(), z.string()).optional(), "url": z.string().optional(), "headers": z.record(z.string(), z.string()).optional() }).describe("纯标准 MCP server 连接配置（protocol=mcp 时用）——可直接喂标准 MCP client，**不含任何 runloop 私有字段**。stdio 用 command/args/env；http·sse 用 url/headers。静态工具清单是 runloop 扩展、不属 MCP 标准，见 Resource.toolManifest。").optional(),
  openapiConfig: z.record(z.string(), z.any()).describe("标准 OpenAPI 文档（protocol≠mcp 时用，格式同 openapi.json）。每个 operation=一个工具、operationId=工具名（必须存在且唯一）；inputSchema 从 operation 的 parameters/requestBody 派生。runloop 据 resourceType 特殊处理：AGENT/SKILL 单 operation 直接用、多 operation 须含保留 operationId（AGENT=invoke、SKILL=download）；SANDBOX/SANDBOX_TEMPLATE 多 operation=多工具、全部共享（懒创建出的）实例 serverUrl。").optional(),
  auth: z.object({ mode: z.literal("none").default("none") }).describe("Downstream authentication uses configured headers.").optional(),
  headers: z.record(z.string(), z.string()).describe("资源级附加 header —— openapi/委派下游 HTTP 调用的**调用时供给通道**。典型是外部鉴权密钥（Bearer/apikey）：OpenAPI 的 securitySchemes 只声明鉴权方案、**密钥值故意留给调用方在此供给**（不写进 openapiConfig 文档），这正是本字段存在的理由、非 openapiConfig 的冗余。非密常量 header（如固定 X-Tenant）也可改写进 openapiConfig 的 const 参数。与顶层 headers 合并、资源级优先、runloop 签名/必备 header 最高优先；MCP 连接自身 header 用 mcpConfig.headers。").optional(),
  toolManifest: z.array(z.object({ "name": z.string().describe("工具名（= MCP tool name）。"), "description": z.string().optional(), "inputSchema": z.record(z.string(), z.any()).describe("JSON Schema（暴露给模型的入参）。").optional() })).describe("静态工具清单（可选，**runloop 扩展、非 MCP 标准**，故置于标准 mcpConfig 之外）。仅 protocol=mcp 用——codex 只连 runloop 单个进程内 runloop-mcp 聚合器，下游 MCP server 都被它聚合/代理；MCP 工具发现本是运行时 round-trip（连下游→initialize→tools/list），慢下游拖慢 agent 首 token。声明此清单后聚合器**立刻把工具呈现给 agent**（首 token 不等下游启动），首次实际调用才**懒连**下游转发、并用真实 tools/list **校正**（self-heal）。缺省则聚合器启动时连下游 tools/list 发现（首 token 等下游）。protocol≠mcp 不用此字段——openapiConfig 的 operations 已自描述工具。").optional(),
  serverManagesHistory: z.boolean().describe("子 agent（protocol=ag-ui/a2a/runloop 等委派目标）是否**服务端自管会话/历史**。`true`=该 agent 按 threadId 在服务端保存自己的会话（含挂起的 HITL）——runloop 多次委派/HITL resume 传**一致的 threadId**、只下发**增量** messages（最新一轮 + 审批决策）。`false`/缺省=无服务端会话（无状态 agent）——runloop 每次下发**完整** messages（原始任务 + 子轨迹 + 审批决策）+ resume 标识，让其自行重建。仅影响委派类资源（AGENT）。来源：平台 protocolSettings[ag-ui].config.serverManagesHistory（前端可标）。").optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;
