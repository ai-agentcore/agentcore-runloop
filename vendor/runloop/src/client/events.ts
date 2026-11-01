// 此文件由 scripts/generate-client-ts.ts 从 spec/events.json 自动生成，请勿手动编辑。

/** 所有事件类型的字符串字面量枚举 */
export const EventType = {
  RunStart: "run.start" as const,
  RunEnd: "run.end" as const,
  RunInterrupt: "run.interrupt" as const,
  RunError: "run.error" as const,
  RunUsage: "run.usage" as const,
  UserMessage: "user.message" as const,
  UserAttachment: "user.attachment" as const,
  UserCommand: "user.command" as const,
  MessageStart: "message.start" as const,
  MessageDelta: "message.delta" as const,
  MessageEnd: "message.end" as const,
  ReasoningStart: "reasoning.start" as const,
  ReasoningDelta: "reasoning.delta" as const,
  ReasoningEnd: "reasoning.end" as const,
  ToolcallStart: "toolcall.start" as const,
  ToolcallDelta: "toolcall.delta" as const,
  ToolcallEnd: "toolcall.end" as const,
  ToolcallSuspend: "toolcall.suspend" as const,
  ToolresultStart: "toolresult.start" as const,
  ToolresultDelta: "toolresult.delta" as const,
  ToolresultEnd: "toolresult.end" as const,
  PlanUpdate: "plan.update" as const,
  TurnStart: "turn.start" as const,
  TurnEnd: "turn.end" as const,
};
export type EventType = (typeof EventType)[keyof typeof EventType];

/** run.error / 适配器错误事件的错误码枚举 */
export const ErrorCode = {
  LoopError: "LOOP_ERROR" as const,
  ProcessError: "PROCESS_ERROR" as const,
  CodexError: "CODEX_ERROR" as const,
  CodexTurnFailed: "CODEX_TURN_FAILED" as const,
  AcpInitFailed: "ACP_INIT_FAILED" as const,
  AcpSessionFailed: "ACP_SESSION_FAILED" as const,
  AcpPromptFailed: "ACP_PROMPT_FAILED" as const,
  ToolError: "TOOL_ERROR" as const,
  ToolFailed: "TOOL_FAILED" as const,
  HitlUnresolved: "HITL_UNRESOLVED" as const,
};
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 输出事件公共字段 */
export interface BaseEvent {
  id: string;
  type: string;
  timestamp: number;
  conversationId: string;
  runId?: string;
  parentToolCallId?: string;
  metadata?: Record<string, unknown>;
}

/** run.start 事件 */
export interface RunStartEvent extends BaseEvent {
  type: "run.start";
  agentCli: string;
  model?: string;
}

/** run.end 事件 */
export interface RunEndEvent extends BaseEvent {
  type: "run.end";
  reason: "completed" | "interrupted" | "error" | "timeout" | "hitl_pending" | "tool_pending";
}

/** run.interrupt 事件 */
export interface RunInterruptEvent extends BaseEvent {
  type: "run.interrupt";
  reason: string;
}

/** run.error 事件 */
export interface RunErrorEvent extends BaseEvent {
  type: "run.error";
  error: { code: "LOOP_ERROR" | "PROCESS_ERROR" | "CODEX_ERROR" | "CODEX_TURN_FAILED" | "ACP_INIT_FAILED" | "ACP_SESSION_FAILED" | "ACP_PROMPT_FAILED" | "TOOL_ERROR" | "TOOL_FAILED" | "HITL_UNRESOLVED"; message: string; details?: unknown };
}

/** run.usage 事件 */
export interface RunUsageEvent extends BaseEvent {
  type: "run.usage";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  model?: string;
}

/** user.message 事件 */
export interface UserMessageEvent extends BaseEvent {
  type: "user.message";
  content: string;
  role: "user";
}

/** user.attachment 事件 */
export interface UserAttachmentEvent extends BaseEvent {
  type: "user.attachment";
  uri: string;
  etag?: string;
  region?: string;
  size?: number;
  mimeType?: string;
  name?: string;
}

/** user.command 事件 */
export interface UserCommandEvent extends BaseEvent {
  type: "user.command";
  command: "resolve";
  toolCallId?: string;
  selectedOptionId?: string;
  targetEventId?: string;
  toolName?: string;
  actorId?: string;
  tenantId?: string;
  decisionTime?: number;
  reason?: string;
  payload?: Record<string, unknown>;
}

/** message.start 事件 */
export interface MessageStartEvent extends BaseEvent {
  type: "message.start";
  messageId?: string;
  role: "assistant";
}

/** message.delta 事件 */
export interface MessageDeltaEvent extends BaseEvent {
  type: "message.delta";
  messageId?: string;
  content: string;
}

/** message.end 事件 */
export interface MessageEndEvent extends BaseEvent {
  type: "message.end";
  messageId?: string;
}

/** reasoning.start 事件 */
export interface ReasoningStartEvent extends BaseEvent {
  type: "reasoning.start";
  reasoningId?: string;
}

/** reasoning.delta 事件 */
export interface ReasoningDeltaEvent extends BaseEvent {
  type: "reasoning.delta";
  reasoningId?: string;
  content: string;
}

/** reasoning.end 事件 */
export interface ReasoningEndEvent extends BaseEvent {
  type: "reasoning.end";
  reasoningId?: string;
}

/** toolcall.start 事件 */
export interface ToolcallStartEvent extends BaseEvent {
  type: "toolcall.start";
  toolCallId: string;
  toolName: string;
}

/** toolcall.delta 事件 */
export interface ToolcallDeltaEvent extends BaseEvent {
  type: "toolcall.delta";
  toolCallId: string;
  chunk: string;
}

/** toolcall.end 事件 */
export interface ToolcallEndEvent extends BaseEvent {
  type: "toolcall.end";
  toolCallId: string;
  args: Record<string, unknown>;
}

/** toolcall.suspend 事件 */
export interface ToolcallSuspendEvent extends BaseEvent {
  type: "toolcall.suspend";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  bindingHash?: string;
  reason: "static_rule" | "model_request" | "llm_judge";
  interactionKind?: "tool_call" | "input_required" | "confirmation";
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  prompt?: string;
  surface?: "native" | "client_tool" | "nl";
  renderTool?: string;
  options: { optionId: string; label: string; kind: "allow_once" | "allow_always" | "allow_modified" | "reject_once" | "reject_always"; matchWords?: string[] }[];
}

/** toolresult.start 事件 */
export interface ToolresultStartEvent extends BaseEvent {
  type: "toolresult.start";
  toolCallId: string;
}

/** toolresult.delta 事件 */
export interface ToolresultDeltaEvent extends BaseEvent {
  type: "toolresult.delta";
  toolCallId: string;
  delta: string;
}

/** toolresult.end 事件 */
export interface ToolresultEndEvent extends BaseEvent {
  type: "toolresult.end";
  toolCallId: string;
  result: unknown;
  isError?: boolean;
}

/** plan.update 事件 */
export interface PlanUpdateEvent extends BaseEvent {
  type: "plan.update";
  entries: { content: string; status: "pending" | "in_progress" | "completed"; priority?: "high" | "medium" | "low" }[];
}

/** turn.start 事件 */
export interface TurnStartEvent extends BaseEvent {
  type: "turn.start";
  turnIndex: number;
}

/** turn.end 事件 */
export interface TurnEndEvent extends BaseEvent {
  type: "turn.end";
  turnIndex: number;
  stopReason: "end_turn" | "max_tokens" | "max_turns" | "cancelled" | "hitl_pending" | "tool_pending";
}

/** 所有输出事件的联合类型 */
export type RunloopEvent = RunStartEvent | RunEndEvent | RunInterruptEvent | RunErrorEvent | RunUsageEvent | UserMessageEvent | UserAttachmentEvent | UserCommandEvent | MessageStartEvent | MessageDeltaEvent | MessageEndEvent | ReasoningStartEvent | ReasoningDeltaEvent | ReasoningEndEvent | ToolcallStartEvent | ToolcallDeltaEvent | ToolcallEndEvent | ToolcallSuspendEvent | ToolresultStartEvent | ToolresultDeltaEvent | ToolresultEndEvent | PlanUpdateEvent | TurnStartEvent | TurnEndEvent;
