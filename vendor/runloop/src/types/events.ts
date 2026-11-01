// 此文件由 scripts/generate-server.ts 从 spec/events.json 自动生成，请勿手动编辑。
import { z } from "zod";

/** 所有事件类型的字符串字面量枚举 */
export const EventType = {
  RunStart: "run.start",
  RunEnd: "run.end",
  RunInterrupt: "run.interrupt",
  RunError: "run.error",
  RunUsage: "run.usage",
  UserMessage: "user.message",
  UserAttachment: "user.attachment",
  UserCommand: "user.command",
  MessageStart: "message.start",
  MessageDelta: "message.delta",
  MessageEnd: "message.end",
  ReasoningStart: "reasoning.start",
  ReasoningDelta: "reasoning.delta",
  ReasoningEnd: "reasoning.end",
  ToolcallStart: "toolcall.start",
  ToolcallDelta: "toolcall.delta",
  ToolcallEnd: "toolcall.end",
  ToolcallSuspend: "toolcall.suspend",
  ToolresultStart: "toolresult.start",
  ToolresultDelta: "toolresult.delta",
  ToolresultEnd: "toolresult.end",
  PlanUpdate: "plan.update",
  TurnStart: "turn.start",
  TurnEnd: "turn.end",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** run.error / 适配器错误事件的错误码枚举 */
export const ErrorCode = {
  LoopError: "LOOP_ERROR",
  ProcessError: "PROCESS_ERROR",
  CodexError: "CODEX_ERROR",
  CodexTurnFailed: "CODEX_TURN_FAILED",
  AcpInitFailed: "ACP_INIT_FAILED",
  AcpSessionFailed: "ACP_SESSION_FAILED",
  AcpPromptFailed: "ACP_PROMPT_FAILED",
  ToolError: "TOOL_ERROR",
  ToolFailed: "TOOL_FAILED",
  HitlUnresolved: "HITL_UNRESOLVED",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 输出事件公共字段 */
export const BaseEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.number(),
  conversationId: z.string(),
  runId: z.string().describe("本次 /v1/run 请求标识（每次唯一）。runner 创建事件时统一带上。").optional(),
  parentToolCallId: z.string().describe("If set, this event belongs to a nested delegation (child agent). Points to the toolCallId of the parent toolcall.start. Follow the chain to reconstruct the full call tree.").optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

/** 输入事件公共字段（宽松：id/timestamp 可选） */
export const InputBaseSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  timestamp: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** run.start 事件 */
export const RunStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RunStart),
  agentCli: z.string(),
  model: z.string().optional(),
});

/** run.end 事件 */
export const RunEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RunEnd),
  reason: z.enum(["completed","interrupted","error","timeout","hitl_pending","tool_pending"]),
});

/** run.interrupt 事件 */
export const RunInterruptEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RunInterrupt),
  reason: z.string(),
});

/** run.error 事件 */
export const RunErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RunError),
  error: z.object({ "code": z.enum(["LOOP_ERROR","PROCESS_ERROR","CODEX_ERROR","CODEX_TURN_FAILED","ACP_INIT_FAILED","ACP_SESSION_FAILED","ACP_PROMPT_FAILED","TOOL_ERROR","TOOL_FAILED","HITL_UNRESOLVED"]).describe("run.error / 适配器错误事件的错误码枚举。"), "message": z.string(), "details": z.any().optional() }),
});

/** run.usage 事件 */
export const RunUsageEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RunUsage),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  cacheReadTokens: z.number().int().optional(),
  cacheWriteTokens: z.number().int().optional(),
  costUsd: z.number().optional(),
  model: z.string().optional(),
});

/** user.message 事件 */
export const UserMessageEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.UserMessage),
  content: z.string(),
  role: z.literal("user"),
});

/** user.attachment 事件 */
export const UserAttachmentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.UserAttachment),
  uri: z.string().describe("Agent-accessible attachment path or logical reference. A trusted upstream adapter must materialize remote bytes into the selected execution workspace before calling Runloop."),
  etag: z.string().describe("Optional upstream integrity/version metadata. Runloop does not fetch storage objects or consume this value.").optional(),
  region: z.string().describe("Optional upstream storage metadata retained for compatibility. Runloop is storage-agnostic.").optional(),
  size: z.number().int().gte(0).describe("Optional attachment size in bytes, validated by the upstream materializer.").optional(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
});

/** user.command 事件 */
export const UserCommandEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.UserCommand),
  command: z.literal("resolve").describe("HITL 审批续接。中断不走此事件（用 POST /v1/interrupt）。"),
  toolCallId: z.string().describe("要解决的挂起 toolcall 的 toolCallId —— HITL 唯一绑定键。").optional(),
  selectedOptionId: z.string().describe("选中的 option id，引用 toolcall.suspend.options[].optionId；allow/reject、once/always 由 option 的 kind 派生。").optional(),
  targetEventId: z.string().describe("可选，指向 toolcall.suspend 事件 id（与 toolCallId 二选一冗余引用）。").optional(),
  toolName: z.string().describe("可选，断言所解决 suspend 的工具名；提供时必须与被引用 suspend 的 toolName 一致，否则整个 run 被拒（AD-026 #11，防解决错对象）。").optional(),
  actorId: z.string().describe("审计字段（由受信网关注入，runloop 只记录）。").optional(),
  tenantId: z.string().describe("审计字段（由受信网关注入）。").optional(),
  decisionTime: z.number().describe("审计字段：审批决策时间（毫秒）。").optional(),
  reason: z.string().describe("审计字段：审批理由（自由文本）。").optional(),
  payload: z.record(z.string(), z.any()).optional(),
});

/** message.start 事件 */
export const MessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.MessageStart),
  messageId: z.string().describe("聚合 id：同一条 assistant message 的 start/delta/end 共享同一个 messageId（由 runloop 合并点 MergeNormalizer 统一盖上，跨流/孤儿 delta/再合成都一致）。上游据此把流式片段归并成一条消息。与 toolcall 的 toolCallId、reasoning 的 reasoningId 对称。").optional(),
  role: z.literal("assistant"),
});

/** message.delta 事件 */
export const MessageDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.MessageDelta),
  messageId: z.string().describe("聚合 id：与本条 message 的 start/end 相同（见 message.start.messageId）。").optional(),
  content: z.string(),
});

/** message.end 事件 */
export const MessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.MessageEnd),
  messageId: z.string().describe("聚合 id：与本条 message 的 start/delta 相同（见 message.start.messageId）。").optional(),
});

/** reasoning.start 事件 */
export const ReasoningStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ReasoningStart),
  reasoningId: z.string().describe("聚合 id：同一段 reasoning 的 start/delta/end 共享同一个 reasoningId（由 MergeNormalizer 统一盖上）。与 message 的 messageId 对称、独立命名空间。").optional(),
});

/** reasoning.delta 事件 */
export const ReasoningDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ReasoningDelta),
  reasoningId: z.string().describe("聚合 id：与本段 reasoning 的 start/end 相同（见 reasoning.start.reasoningId）。").optional(),
  content: z.string().describe("模型思考（reasoning）的流式增量。与 message.* 对称、独立命名空间，不混入 assistant 正文。"),
});

/** reasoning.end 事件 */
export const ReasoningEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ReasoningEnd),
  reasoningId: z.string().describe("聚合 id：与本段 reasoning 的 start/delta 相同（见 reasoning.start.reasoningId）。").optional(),
});

/** toolcall.start 事件 */
export const ToolcallStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolcallStart),
  toolCallId: z.string(),
  toolName: z.string(),
});

/** toolcall.delta 事件 */
export const ToolcallDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolcallDelta),
  toolCallId: z.string(),
  chunk: z.string(),
});

/** toolcall.end 事件 */
export const ToolcallEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolcallEnd),
  toolCallId: z.string(),
  args: z.record(z.string(), z.any()),
});

/** toolcall.suspend 事件 */
export const ToolcallSuspendEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolcallSuspend),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.any()).describe("展示用·非权威。execute-on-resume 用历史 toolcall.end.args，不认此字段（仅展示、可脱敏）。").optional(),
  bindingHash: z.string().describe("审批绑定哈希（H5）：hash(toolName + 解析后执行端点/描述符)。execute-on-resume 前重算当前 resources 的同款哈希，不符 ⇒ 同名工具在批准后被指向了不同 endpoint/实现（防『批 A 执行 B』）⇒ 拒绝执行、需重新审批。仅资源型工具（openapi/委派/MCP）含端点签名；内置 bash/file 无端点则只绑 toolName。args 不进哈希（execute-on-resume 用不可变历史 args 或 allow_modified 的 payload，天然绑定）。").optional(),
  reason: z.enum(["static_rule","model_request","llm_judge"]),
  interactionKind: z.enum(["tool_call","input_required","confirmation"]).describe("AG-UI 交互语义类别（与触发源 reason 正交）：tool_call=工具执行前置审批、input_required=向用户索取结构化输入、confirmation=是非确认。源自 ag-ui 子 agent interrupt 的 reason；缺省=未声明（按 options/prompt 处理）。input_required 时 options 通常为空、改由 responseSchema 描述输入。").optional(),
  responseSchema: z.record(z.string(), z.any()).describe("resume 时期望的 payload 结构（JSON Schema），由 ag-ui 子 agent interrupt 透传。input_required 类用它驱动上游渲染输入控件 + 校验；is-non-题（confirmation）一般无此字段、用 options。").optional(),
  expiresAt: z.string().describe("可选 ISO-8601 过期时刻（ag-ui interrupt 透传）。过期后该挂起不应再被恢复；event-sourced 下生命周期主要由上游管理，本字段仅作信号。").optional(),
  prompt: z.string().describe("NL 降级通道的提问文本（i18n，由 out-of-band phrasing service 生成并持久化）。纯文本上游把它作为 assistant 文本呈现给用户；富通道（clientTools/原生 UI）用 options 即可，可忽略本字段。").optional(),
  surface: z.enum(["native","client_tool","nl"]).describe("呈现选择建议（AD-026 增补 · 触发 ⊥ 呈现）：runloop 按 hitl.clientCapabilities 配置选定该 suspend 怎么递给人——native=客户端原生消费 toolcall.suspend 事件、client_tool=映射到客户端工具渲染（见 renderTool）、nl=自然语言兜底。runloop 恒发全表征（options+prompt+matchWords+responseSchema），本字段仅建议，客户端/bridge 仍可自选、NL 永远兜底。缺省=未声明（按现行为 native 处理）。").optional(),
  renderTool: z.string().describe("surface=client_tool 时的目标客户端工具名（renderTools 显式映射或 F3 纯 HITL LLM 选定）。其余 surface 不设。").optional(),
  options: z.array(z.object({ "optionId": z.string(), "label": z.string(), "kind": z.enum(["allow_once","allow_always","allow_modified","reject_once","reject_always"]), "matchWords": z.array(z.string()).describe("NL 降级通道的 i18n 触发词（可多个）。纯文本上游下，resume 时把用户回复归一化后与此完全相等匹配到本 option（确定性、replay 安全，见 AD-026 增补）。").optional() })),
});

/** toolresult.start 事件 */
export const ToolresultStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolresultStart),
  toolCallId: z.string(),
});

/** toolresult.delta 事件 */
export const ToolresultDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolresultDelta),
  toolCallId: z.string(),
  delta: z.string(),
});

/** toolresult.end 事件 */
export const ToolresultEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ToolresultEnd),
  toolCallId: z.string(),
  result: z.any(),
  isError: z.boolean().describe("true 即工具失败（模型自行处理，与 run 失败无关）。").optional(),
});

/** plan.update 事件 */
export const PlanUpdateEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.PlanUpdate),
  entries: z.array(z.object({ "content": z.string(), "status": z.enum(["pending","in_progress","completed"]), "priority": z.enum(["high","medium","low"]).optional() })),
});

/** turn.start 事件 */
export const TurnStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TurnStart),
  turnIndex: z.number().int(),
});

/** turn.end 事件 */
export const TurnEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TurnEnd),
  turnIndex: z.number().int(),
  stopReason: z.enum(["end_turn","max_tokens","max_turns","cancelled","hitl_pending","tool_pending"]),
});

// ── 输入事件 ──────────────────────────────────────────

export const InputUserMessageSchema = InputBaseSchema.extend({
  type: z.literal(EventType.UserMessage),
  content: z.string(),
}).passthrough();

export const InputUserAttachmentSchema = InputBaseSchema.extend({
  type: z.literal(EventType.UserAttachment),
  uri: z.string(),
  etag: z.string().optional(),
  region: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
}).passthrough();

export const InputUserCommandSchema = InputBaseSchema.extend({
  type: z.literal(EventType.UserCommand),
  command: z.enum(["resolve"]),
  toolCallId: z.string().optional(),
  selectedOptionId: z.string().optional(),
  targetEventId: z.string().optional(),
  actorId: z.string().optional(),
  tenantId: z.string().optional(),
  decisionTime: z.number().optional(),
  reason: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const InputHistoryEventSchema = InputBaseSchema.extend({
  type: z.string(),
}).passthrough();

export const InputEventSchema = z.union([
  InputUserMessageSchema,
  InputUserAttachmentSchema,
  InputUserCommandSchema,
  InputHistoryEventSchema,
]);

export type InputEvent = z.infer<typeof InputEventSchema>;

/** 所有输出事件的联合类型 */
export const RunloopEventSchema = z.discriminatedUnion("type", [
  RunStartEventSchema,
  RunEndEventSchema,
  RunInterruptEventSchema,
  RunErrorEventSchema,
  RunUsageEventSchema,
  UserMessageEventSchema,
  UserAttachmentEventSchema,
  UserCommandEventSchema,
  MessageStartEventSchema,
  MessageDeltaEventSchema,
  MessageEndEventSchema,
  ReasoningStartEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  ToolcallStartEventSchema,
  ToolcallDeltaEventSchema,
  ToolcallEndEventSchema,
  ToolcallSuspendEventSchema,
  ToolresultStartEventSchema,
  ToolresultDeltaEventSchema,
  ToolresultEndEventSchema,
  PlanUpdateEventSchema,
  TurnStartEventSchema,
  TurnEndEventSchema,
]);

export type RunloopEvent = z.infer<typeof RunloopEventSchema>;

export type RunStartEvent = z.infer<typeof RunStartEventSchema>;
export type RunEndEvent = z.infer<typeof RunEndEventSchema>;
export type RunInterruptEvent = z.infer<typeof RunInterruptEventSchema>;
export type RunErrorEvent = z.infer<typeof RunErrorEventSchema>;
export type RunUsageEvent = z.infer<typeof RunUsageEventSchema>;
export type UserMessageEvent = z.infer<typeof UserMessageEventSchema>;
export type UserAttachmentEvent = z.infer<typeof UserAttachmentEventSchema>;
export type UserCommandEvent = z.infer<typeof UserCommandEventSchema>;
export type MessageStartEvent = z.infer<typeof MessageStartEventSchema>;
export type MessageDeltaEvent = z.infer<typeof MessageDeltaEventSchema>;
export type MessageEndEvent = z.infer<typeof MessageEndEventSchema>;
export type ReasoningStartEvent = z.infer<typeof ReasoningStartEventSchema>;
export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;
export type ReasoningEndEvent = z.infer<typeof ReasoningEndEventSchema>;
export type ToolcallStartEvent = z.infer<typeof ToolcallStartEventSchema>;
export type ToolcallDeltaEvent = z.infer<typeof ToolcallDeltaEventSchema>;
export type ToolcallEndEvent = z.infer<typeof ToolcallEndEventSchema>;
export type ToolcallSuspendEvent = z.infer<typeof ToolcallSuspendEventSchema>;
export type ToolresultStartEvent = z.infer<typeof ToolresultStartEventSchema>;
export type ToolresultDeltaEvent = z.infer<typeof ToolresultDeltaEventSchema>;
export type ToolresultEndEvent = z.infer<typeof ToolresultEndEventSchema>;
export type PlanUpdateEvent = z.infer<typeof PlanUpdateEventSchema>;
export type TurnStartEvent = z.infer<typeof TurnStartEventSchema>;
export type TurnEndEvent = z.infer<typeof TurnEndEventSchema>;
export type OutputEvent = Exclude<RunloopEvent, UserMessageEvent | UserAttachmentEvent | UserCommandEvent>;
