import { nanoid } from "nanoid";
import { createEvent } from "../events/factory.js";
import { EventType } from "../types/events.js";
import type { McpToolResult, ToolCallContext } from "./types.js";

/** Server-executed tools (including file, shell, and remote tools) announce before awaiting work. */
export async function withToolEvents(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  execute: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  const { emit, conversationId } = ctx;
  if (!ctx.emitToolLifecycle || !emit || !conversationId) return execute();
  const toolCallId = ctx.toolCallId ?? `tool-${nanoid()}`;
  const toolName = name === "imagegen" ? "image_gen.imagegen" : name;
  emit(createEvent(EventType.ToolcallStart, conversationId, { toolCallId, toolName }));
  emit(createEvent(EventType.ToolcallEnd, conversationId, { toolCallId, args }));
  let result: McpToolResult;
  try {
    result = await execute();
  } catch (error) {
    emit(createEvent(EventType.ToolresultEnd, conversationId, {
      toolCallId, isError: true,
      result: { content: [{ type: "text", text: "TOOL_EXECUTION_FAILED" }], isError: true },
    }));
    throw error;
  }
  emit(createEvent(EventType.ToolresultEnd, conversationId, { toolCallId, result, isError: result.isError ?? false }));
  return result;
}
