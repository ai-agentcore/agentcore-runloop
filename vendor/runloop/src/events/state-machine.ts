import { createEvent } from "./factory.js";
import { EventType, type RunloopEvent } from "../types/events.js";

export type EventState = "IDLE" | "MESSAGE_OPEN" | "REASONING_OPEN" | "TOOL_ACTIVE";

/**
 * 事件生命周期状态机 — 确保 adapter 产出的事件序列满足 runloop 协议不变量：
 * 1. message.start 必须在 message.delta 之前
 * 2. message.end 必须在 tool_call.start 之前关闭打开的 message
 * 3. 同一时刻最多一个 message open
 *
 * adapter 只需调用 textDelta / toolCallStart 等原始信号方法，
 * 状态机自动补全缺失的 start/end 事件。
 */
export class EventStateMachine {
  private state: EventState = "IDLE";
  private sid: string;

  constructor(conversationId: string) {
    this.sid = conversationId;
  }

  get currentState(): EventState {
    return this.state;
  }

  /** 关闭当前打开的文本流（message 或 reasoning），返回补的 end 事件。 */
  private closeOpenText(): RunloopEvent[] {
    if (this.state === "MESSAGE_OPEN") {
      this.state = "IDLE";
      return [createEvent(EventType.MessageEnd, this.sid, {})];
    }
    if (this.state === "REASONING_OPEN") {
      this.state = "IDLE";
      return [createEvent(EventType.ReasoningEnd, this.sid, {})];
    }
    return [];
  }

  textDelta(content: string): RunloopEvent[] {
    const events: RunloopEvent[] = [];
    if (this.state === "REASONING_OPEN") events.push(...this.closeOpenText()); // reasoning 与 message 互斥
    if (this.state !== "MESSAGE_OPEN") {
      events.push(createEvent(EventType.MessageStart, this.sid, { role: "assistant" as const }));
      this.state = "MESSAGE_OPEN";
    }
    events.push(createEvent(EventType.MessageDelta, this.sid, { content }));
    return events;
  }

  /** reasoning 流式增量（与 message 对称、互斥，独立命名空间）。 */
  reasoningDelta(content: string): RunloopEvent[] {
    const events: RunloopEvent[] = [];
    if (this.state === "MESSAGE_OPEN") events.push(...this.closeOpenText());
    if (this.state !== "REASONING_OPEN") {
      events.push(createEvent(EventType.ReasoningStart, this.sid, {}));
      this.state = "REASONING_OPEN";
    }
    events.push(createEvent(EventType.ReasoningDelta, this.sid, { content }));
    return events;
  }

  /** reasoning 完整文本（item.completed 非流式路径）：start→delta→end 一气呵成。 */
  reasoningComplete(content: string): RunloopEvent[] {
    const events: RunloopEvent[] = [...this.closeOpenText()];
    events.push(
      createEvent(EventType.ReasoningStart, this.sid, {}),
      createEvent(EventType.ReasoningDelta, this.sid, { content }),
      createEvent(EventType.ReasoningEnd, this.sid, {}),
    );
    this.state = "IDLE";
    return events;
  }

  textComplete(content: string): RunloopEvent[] {
    const events: RunloopEvent[] = [];
    if (this.state === "MESSAGE_OPEN") {
      events.push(createEvent(EventType.MessageEnd, this.sid, {}));
    }
    events.push(createEvent(EventType.MessageStart, this.sid, { role: "assistant" as const }));
    events.push(createEvent(EventType.MessageDelta, this.sid, { content }));
    events.push(createEvent(EventType.MessageEnd, this.sid, {}));
    this.state = "IDLE";
    return events;
  }

  toolCallStart(toolCallId: string, toolName: string): RunloopEvent[] {
    const events: RunloopEvent[] = [...this.closeOpenText()]; // 关掉打开的 message / reasoning
    events.push(createEvent(EventType.ToolcallStart, this.sid, { toolCallId, toolName }));
    this.state = "TOOL_ACTIVE";
    return events;
  }

  toolCallArgs(toolCallId: string, chunk: string): RunloopEvent[] {
    return [createEvent(EventType.ToolcallDelta, this.sid, { toolCallId, chunk })];
  }

  toolCallExecuting(toolCallId: string, args: Record<string, unknown>): RunloopEvent[] {
    return [createEvent(EventType.ToolcallEnd, this.sid, { toolCallId, args })];
  }

  toolResultStart(toolCallId: string): RunloopEvent[] {
    return [createEvent(EventType.ToolresultStart, this.sid, { toolCallId })];
  }

  toolCallOutputDelta(toolCallId: string, delta: string): RunloopEvent[] {
    return [createEvent(EventType.ToolresultDelta, this.sid, { toolCallId, delta })];
  }

  toolCallResult(toolCallId: string, result: unknown, isError?: boolean): RunloopEvent[] {
    this.state = "IDLE";
    return [createEvent(EventType.ToolresultEnd, this.sid, { toolCallId, result, isError })];
  }

  /** 工具错误并入 toolresult.end（isError=true，模型自行处理，与 run 失败无关） */
  toolCallError(toolCallId: string, error: { code: string; message: string }): RunloopEvent[] {
    this.state = "IDLE";
    return [createEvent(EventType.ToolresultEnd, this.sid, { toolCallId, result: error, isError: true })];
  }

  usage(data: Record<string, unknown>): RunloopEvent[] {
    return [createEvent(EventType.RunUsage, this.sid, data)];
  }

  flush(): RunloopEvent[] {
    return this.closeOpenText(); // 关掉打开的 message / reasoning
  }
}
