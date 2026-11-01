import type {
  ChatCompletionRequest,
  ChatCompletionMessage,
  ChatCompletionToolCall,
  ChatCompletionChunk,
} from "./types.js";

/**
 * Anthropic Messages API ↔ Chat Completions（枢纽 IR）翻译器（AD-013）。
 *
 * 进方向：messagesRequestToChatCompletions —— claude-code 的 /v1/messages 请求 → Chat。
 *   支持 system（string|blocks）、text / tool_use / tool_result content block、tools(input_schema)。
 * 出方向：chatCompletionChunkToClaudeEvents —— 上游 Chat 流 → Anthropic SSE 事件（含 tool_use 块）。
 */

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

export function messagesRequestToChatCompletions(
  body: Record<string, unknown>
): ChatCompletionRequest {
  const messages: ChatCompletionMessage[] = [];

  if (body.system) {
    const system = typeof body.system === "string"
      ? body.system
      : (body.system as AnthropicBlock[]).map((b) => b.text ?? "").join("\n");
    if (system) messages.push({ role: "system", content: system });
  }

  for (const msg of (body.messages ?? []) as Record<string, unknown>[]) {
    const role = msg.role as "user" | "assistant";
    const content = msg.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const blocks = content as AnthropicBlock[];
    const textParts: string[] = [];
    const toolCalls: ChatCompletionToolCall[] = [];
    const toolResults: { tool_use_id: string; text: string }[] = [];

    for (const b of blocks) {
      if (b.type === "text") {
        textParts.push(b.text ?? "");
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id ?? "",
          type: "function",
          function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === "tool_result") {
        toolResults.push({ tool_use_id: b.tool_use_id ?? "", text: stringifyToolResult(b.content) });
      }
      // image / 其它 block：枢纽 IR 暂以文本占位（多模态跨协议留待 P2）
    }

    // user 消息里的 tool_result → 独立的 role:tool 消息（Chat 语义）
    for (const tr of toolResults) {
      messages.push({ role: "tool", content: tr.text, tool_call_id: tr.tool_use_id });
    }

    const text = textParts.join("");
    if (role === "assistant" && toolCalls.length > 0) {
      messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
    } else if (text || toolResults.length === 0) {
      messages.push({ role, content: text });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  const ccTools = tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name as string,
      description: t.description as string | undefined,
      parameters: (t.input_schema ?? t.parameters) as Record<string, unknown> | undefined,
    },
  }));

  return {
    model: body.model as string,
    messages,
    stream: true,
    tools: ccTools?.length ? ccTools : undefined,
    temperature: body.temperature as number | undefined,
    max_tokens: (body.max_tokens as number) ?? 4096,
  };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as AnthropicBlock[]).map((b) => (b.type === "text" ? b.text ?? "" : JSON.stringify(b))).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

// ── 出方向：Chat chunk → Anthropic Messages SSE ──────────────────────────

type ClaudeBlockKind = "none" | "text" | "tool_use";

export interface ClaudeMessagesState {
  messageId: string;
  model: string;
  startedMessage: boolean;
  blockIndex: number;
  openBlock: ClaudeBlockKind;
  /** 当前活跃 tool_use 的累积（用于 input_json_delta） */
  activeToolIndex: number | null;
  outputTokens: number;
  stopReason: string | null;
  stopped: boolean;
}

export function createClaudeState(messageId: string, model: string): ClaudeMessagesState {
  return {
    messageId,
    model,
    startedMessage: false,
    blockIndex: -1,
    openBlock: "none",
    activeToolIndex: null,
    outputTokens: 0,
    stopReason: null,
    stopped: false,
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function claudeMessageStart(state: ClaudeMessagesState): string {
  state.startedMessage = true;
  return sse("message_start", {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function closeOpenBlock(state: ClaudeMessagesState): string {
  if (state.openBlock === "none") return "";
  const out = sse("content_block_stop", { type: "content_block_stop", index: state.blockIndex });
  state.openBlock = "none";
  state.activeToolIndex = null;
  return out;
}

/** 把一个 Chat chunk 翻译成 0..N 条 Anthropic SSE 事件 */
export function chatCompletionChunkToClaudeEvents(
  chunk: ChatCompletionChunk,
  state: ClaudeMessagesState
): string[] {
  const out: string[] = [];
  if (chunk.usage) state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;

  const choice = chunk.choices?.[0];
  if (!choice) return out;
  const delta = choice.delta;

  // 文本增量
  if (delta?.content) {
    if (state.openBlock !== "text") {
      out.push(closeOpenBlock(state));
      state.blockIndex++;
      state.openBlock = "text";
      out.push(sse("content_block_start", { type: "content_block_start", index: state.blockIndex, content_block: { type: "text", text: "" } }));
    }
    out.push(sse("content_block_delta", { type: "content_block_delta", index: state.blockIndex, delta: { type: "text_delta", text: delta.content } }));
  }

  // 工具调用增量
  for (const tc of delta?.tool_calls ?? []) {
    if (tc.id) {
      // 新 tool_use 块
      out.push(closeOpenBlock(state));
      state.blockIndex++;
      state.openBlock = "tool_use";
      state.activeToolIndex = tc.index;
      out.push(sse("content_block_start", {
        type: "content_block_start",
        index: state.blockIndex,
        content_block: { type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input: {} },
      }));
      state.stopReason = "tool_use";
    }
    if (tc.function?.arguments) {
      out.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "input_json_delta", partial_json: tc.function.arguments },
      }));
    }
  }

  if (choice.finish_reason) {
    out.push(closeOpenBlock(state));
    if (!state.stopReason) state.stopReason = mapFinishReason(choice.finish_reason);
    out.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: state.stopReason, stop_sequence: null },
      usage: { output_tokens: state.outputTokens },
    }));
    out.push(sse("message_stop", { type: "message_stop" }));
    state.stopped = true;
  }

  return out;
}

export function claudeFinalize(state: ClaudeMessagesState): string[] {
  if (state.stopped) return [];
  const out: string[] = [];
  out.push(closeOpenBlock(state));
  out.push(sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: state.stopReason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: state.outputTokens },
  }));
  out.push(sse("message_stop", { type: "message_stop" }));
  state.stopped = true;
  return out;
}

export function claudeErrorEvent(message: string): string {
  return sse("error", { type: "error", error: { type: "api_error", message } });
}

function mapFinishReason(finish: string): string {
  switch (finish) {
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    case "stop": default: return "end_turn";
  }
}
