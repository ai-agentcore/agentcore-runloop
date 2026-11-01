import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InputEvent, RunloopEvent } from "../vendor/runloop/src/types/events.js";
import { DEFAULT_UID, UidSchema } from "./session-workspace.js";

export const SessionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const TextSchema = z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))]);
const AttachmentSchema = z.object({
  id: SessionIdSchema,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().positive().max(32 * 1024 * 1024),
  uri: z.string().min(1).max(2048),
  etag: z.string().min(1).max(256),
}).strip();
const MessageSchema = z.object({
  id: z.string().min(1), role: z.enum(["user", "assistant", "system", "developer", "tool"]),
  content: TextSchema.nullish(), toolCallId: z.string().min(1).optional(),
  attachments: z.array(AttachmentSchema).max(10).optional(),
  toolCalls: z.array(z.object({ id: z.string().min(1), type: z.literal("function"), function: z.object({ name: z.string().min(1), arguments: z.string() }) })).optional(),
}).superRefine((m, ctx) => {
  if ((m.role !== "assistant" && m.content == null && !m.attachments?.length) || (m.role === "tool" && !m.toolCallId) ||
      (m.role === "assistant" && m.content == null && !m.toolCalls?.length)) ctx.addIssue({ code: "custom", message: "Message content or tool call is missing" });
});
export const AgUiInputSchema = z.object({
  threadId: SessionIdSchema, runId: SessionIdSchema, messages: z.array(MessageSchema).min(1),
  state: z.unknown().default({}),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) })),
  context: z.array(z.object({ description: z.string(), value: z.string() })),
  forwardedProps: z.object({
    uid: UidSchema.optional(),
    attachmentDownloads: z.array(z.object({
      uri: z.string().min(1).max(2048),
      url: z.string().url().max(8192).refine(value => value.startsWith("https://")),
      expiresAt: z.string().datetime({ offset: true }).optional(),
    }).strict()).max(10).optional(),
  }).passthrough().default({}),
}).strict();
export type AgUiInput = z.infer<typeof AgUiInputSchema>;
export type AgUiEvent = { type: string; [key: string]: unknown };

type MessageContent = z.infer<typeof TextSchema> | null | undefined;

function textContent(content: MessageContent): string {
  if (!Array.isArray(content)) return content ?? "";
  return content.map(part => part.text).join("\n");
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result) ?? "null";
}

function outputToolResult(event: Extract<RunloopEvent, { type: "toolresult.end" }>): unknown {
  if (!event.isError) return event.result;
  return { result: event.result, isError: true };
}

// Client tool definitions and forwardedProps never change deployment-owned resources.
export function agUiRequest(input: AgUiInput) {
  const events: InputEvent[] = [], instructions: string[] = [];
  if (input.context.length) events.push({ type: "user.message", content: `Reference context:\n${JSON.stringify(input.context)}` });
  for (const message of input.messages) {
    const content = textContent(message.content);
    switch (message.role) {
      case "system": case "developer": instructions.push(content); break;
      case "user":
        if (content) events.push({ type: "user.message", content });
        for (const attachment of message.attachments ?? []) {
          events.push({
            type: "user.attachment",
            id: attachment.id,
            uri: attachment.uri,
            etag: attachment.etag,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
          } as InputEvent);
        }
        break;
      case "assistant":
        if (content) events.push({ type: "message.delta", messageId: message.id, content });
        for (const call of message.toolCalls ?? []) {
          const args = z.record(z.string(), z.unknown()).parse(JSON.parse(call.function.arguments));
          events.push({ type: "toolcall.start", toolCallId: call.id, toolName: call.function.name }, { type: "toolcall.end", toolCallId: call.id, args });
        }
        break;
      case "tool": events.push({ type: "toolresult.end", toolCallId: message.toolCallId, result: content }); break;
    }
  }
  return {
    uid: input.forwardedProps.uid ?? DEFAULT_UID,
    conversationId: input.threadId,
    runId: input.runId,
    events,
    agent: { systemPrompt: instructions.join("\n\n") },
  };
}

/** Convert one run, keeping AG-UI message/tool lifecycles and one terminal event. */
export class AgUiStream {
  // Codex uses the same message shape for progress narration and its final
  // reply. Stream each candidate as activity, then promote only the last one
  // after a completed run proves that no tool call followed it.
  private message?: { id: string; content: string; activityOpen: boolean };
  private terminal = false;
  private tools = new Map<string, boolean>();
  constructor(private input: AgUiInput) {}
  start(): AgUiEvent[] {
    return [{ type: "RUN_STARTED", threadId: this.input.threadId, runId: this.input.runId }, { type: "STATE_SNAPSHOT", snapshot: this.input.state }];
  }
  private closeActivity(clear: boolean): AgUiEvent[] {
    const message = this.message;
    if (clear) this.message = undefined;
    if (!message?.activityOpen) return [];
    message.activityOpen = false;
    return [{ type: "THINKING_TEXT_MESSAGE_END", messageId: message.id }];
  }
  private discardMessageAsActivity(): AgUiEvent[] {
    return this.closeActivity(true);
  }
  private promoteMessageToAnswer(): AgUiEvent[] {
    const message = this.message;
    const close = this.closeActivity(false);
    this.message = undefined;
    if (!message?.content) return close;
    return [...close,
      { type: "TEXT_MESSAGE_START", messageId: message.id, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: message.id, delta: message.content },
      { type: "TEXT_MESSAGE_END", messageId: message.id },
    ];
  }
  fail(code: string, message: string): AgUiEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [...this.discardMessageAsActivity(), { type: "RUN_ERROR", code, message }];
  }
  finish(): AgUiEvent[] { return this.fail("INCOMPLETE_STREAM", "Agent stream ended without a terminal event"); }
  push(event: RunloopEvent): AgUiEvent[] {
    if (this.terminal) return [];
    switch (event.type) {
      case "message.start": {
        const activity = this.discardMessageAsActivity();
        this.message = { id: event.messageId ?? randomUUID(), content: "", activityOpen: false };
        return activity;
      }
      case "message.delta": {
        if (!event.content) return [];
        const activity: AgUiEvent[] = [];
        if (this.message && event.messageId && event.messageId !== this.message.id) {
          activity.push(...this.discardMessageAsActivity());
        }
        if (!this.message) this.message = { id: event.messageId ?? randomUUID(), content: "", activityOpen: false };
        if (!this.message.activityOpen) {
          this.message.activityOpen = true;
          activity.push({ type: "THINKING_TEXT_MESSAGE_START", messageId: this.message.id });
        }
        this.message.content += event.content;
        activity.push({ type: "THINKING_TEXT_MESSAGE_CONTENT", messageId: this.message.id, delta: event.content });
        return activity;
      }
      case "message.end": return this.closeActivity(false);
      case "toolcall.start":
        if (this.tools.has(event.toolCallId)) return [];
        this.tools.set(event.toolCallId, false);
        return [...this.discardMessageAsActivity(), { type: "TOOL_CALL_START", toolCallId: event.toolCallId, toolCallName: event.toolName }];
      case "toolcall.end":
        if (this.tools.get(event.toolCallId) !== false) return [];
        this.tools.set(event.toolCallId, true);
        // Use authoritative complete arguments, not possibly duplicated CLI chunks.
        return [{ type: "TOOL_CALL_ARGS", toolCallId: event.toolCallId, delta: JSON.stringify(event.args) }, { type: "TOOL_CALL_END", toolCallId: event.toolCallId }];
      case "toolresult.end": {
        if (!this.tools.has(event.toolCallId)) return [];
        const prefix = this.push({ ...event, type: "toolcall.end", args: {} });
        const result = outputToolResult(event);
        return [...prefix, {
          type: "TOOL_CALL_RESULT",
          messageId: randomUUID(),
          toolCallId: event.toolCallId,
          role: "tool",
          content: serializeToolResult(result),
        }];
      }
      case "run.error": return this.fail(event.error.code, "Agent execution failed; check server logs");
      case "run.end":
        if (event.reason !== "completed") return this.fail(`RUN_${event.reason.toUpperCase()}`, `Agent run ended: ${event.reason}`);
        this.terminal = true;
        return [...this.promoteMessageToAnswer(), { type: "RUN_FINISHED", threadId: this.input.threadId, runId: this.input.runId }];
      default: return [];
    }
  }
}
