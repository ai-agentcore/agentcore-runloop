import {
  EventType,
  type RunloopEvent,
  type UserMessageEvent,
  type MessageDeltaEvent,
  type ToolcallStartEvent,
  type ToolresultEndEvent,
} from "../types/events.js";

export interface CompressOptions {
  maxMessages: number;
  preserveLastNTurns: number;
  includeToolResults: boolean;
  /**
   * 历史以「工具调用结果」收尾时（client-tool 跨 run resume 的续跑点），追加一条 user 角色的延续提示：
   * 重新点出刚返回的结果 + 指示模型「基于结果继续、不要重复已完成的工具调用」。
   * 否则 transcript 折叠后以 assistant 自述收尾，文本型 CLI（codex exec）会从原始请求重新决策、
   * 重复调用同一 client tool（无限确认循环）。仅主 agent 文本 transcript 路径开启（runner），
   * 子 agent 委派（sub-agent-caller）不开。默认关，向后兼容。
   */
  continuationHint: boolean;
}

const DEFAULT_OPTIONS: CompressOptions = {
  maxMessages: 100,
  preserveLastNTurns: 5,
  includeToolResults: true,
  continuationHint: false,
};

export interface CompressedMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function compressEvents(
  events: RunloopEvent[],
  options: Partial<CompressOptions> = {}
): CompressedMessage[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const turns = groupIntoTurns(events);

  // 全局 toolCallId → toolName 映射：toolcall.start 与 toolresult.end 可能跨 turn
  // （HITL execute-on-resume 注入的 toolresult 在 resume run 的新 turn，但其 toolcall.start 在历史早期 turn）。
  const toolNames = new Map<string, string>();
  for (const e of events) {
    if (e.type === EventType.ToolcallStart) toolNames.set(e.toolCallId, e.toolName);
  }

  let messages: CompressedMessage[];
  if (turns.length <= opts.preserveLastNTurns) {
    messages = turnsToMessages(turns, opts.includeToolResults, toolNames);
  } else {
    const earlyTurns = turns.slice(0, turns.length - opts.preserveLastNTurns);
    const recentTurns = turns.slice(-opts.preserveLastNTurns);

    const summary = summarizeTurns(earlyTurns);
    const recentMessages = turnsToMessages(recentTurns, opts.includeToolResults, toolNames);

    const systemMsg: CompressedMessage = {
      role: "system",
      content: `[Earlier conversation summary]\n${summary}`,
    };
    messages = [systemMsg, ...recentMessages].slice(-opts.maxMessages);
  }

  if (opts.continuationHint && turns.length > 0) {
    const cue = buildContinuationCue(turns[turns.length - 1], toolNames);
    if (cue) messages = [...messages, { role: "user", content: cue }];
  }

  return messages;
}

/**
 * 若该 turn 以「工具调用结果」收尾（最后一个产出事件是 toolresult.end、其后无 message.delta），
 * 说明工具已返回但模型尚未基于结果继续 —— 返回一条延续提示；否则返回 null。
 */
function buildContinuationCue(
  lastTurn: Turn,
  toolNames: Map<string, string>
): string | null {
  const content = lastTurn.assistantEvents.filter(
    (e) => e.type === EventType.MessageDelta || e.type === EventType.ToolresultEnd
  );
  const tail = content[content.length - 1];
  if (!tail || tail.type !== EventType.ToolresultEnd) return null;

  const results = lastTurn.assistantEvents.filter(
    (e): e is ToolresultEndEvent => e.type === EventType.ToolresultEnd
  );
  const lines = results.map(
    (r) => `- ${toolNames.get(r.toolCallId) ?? r.toolCallId} → ${renderResult(r)}`
  );
  return [
    "[系统提示] 上述工具调用已执行完毕并返回结果，用户已对相应的询问/确认作出答复：",
    ...lines,
    "",
    "请直接基于以上结果继续执行后续步骤（例如调用相应的子 agent 或工具来完成用户的任务）。",
    "严禁就同一事项再次发起确认或询问，不要重复调用已经返回结果的工具。",
  ].join("\n");
}

interface Turn {
  userEvents: RunloopEvent[];
  assistantEvents: RunloopEvent[];
}

function groupIntoTurns(events: RunloopEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn = { userEvents: [], assistantEvents: [] };
  let phase: "user" | "assistant" = "user";

  for (const event of events) {
    if (event.type === EventType.UserMessage || event.type === EventType.UserAttachment) {
      if (phase === "assistant" && current.assistantEvents.length > 0) {
        turns.push(current);
        current = { userEvents: [], assistantEvents: [] };
      }
      current.userEvents.push(event);
      phase = "user";
    } else if (
      event.type === EventType.MessageDelta ||
      event.type === EventType.MessageStart ||
      event.type === EventType.MessageEnd ||
      event.type === EventType.ToolcallStart ||
      event.type === EventType.ToolcallEnd ||
      event.type === EventType.ToolcallSuspend ||
      event.type === EventType.ToolresultEnd
    ) {
      current.assistantEvents.push(event);
      phase = "assistant";
    }
  }

  if (current.userEvents.length > 0 || current.assistantEvents.length > 0) {
    turns.push(current);
  }

  return turns;
}

function turnsToMessages(
  turns: Turn[],
  includeToolResults: boolean,
  toolNames: Map<string, string>
): CompressedMessage[] {
  const messages: CompressedMessage[] = [];

  for (const turn of turns) {
    const userParts = turn.userEvents
      .filter((e): e is UserMessageEvent => e.type === EventType.UserMessage)
      .map((e) => e.content);
    // 附件转为文本引用喂给 agent CLI（多模态 content block 跨协议翻译留待 P2）
    for (const e of turn.userEvents) {
      if (e.type === EventType.UserAttachment) {
        const a = e as { uri: string; name?: string; mimeType?: string };
        const label = a.name ?? a.uri;
        userParts.push(`[Attachment: ${label}${a.mimeType ? ` (${a.mimeType})` : ""}] ${a.uri}`);
      }
    }
    const userContent = userParts.join("\n");

    if (userContent) {
      messages.push({ role: "user", content: userContent });
    }

    let assistantContent = "";
    const deltas = turn.assistantEvents.filter(
      (e): e is MessageDeltaEvent => e.type === EventType.MessageDelta
    );
    assistantContent += deltas.map((e) => e.content).join("");

    if (includeToolResults) {
      const toolCalls = turn.assistantEvents.filter(
        (e): e is ToolcallStartEvent => e.type === EventType.ToolcallStart
      );
      const toolResults = turn.assistantEvents.filter(
        (e): e is ToolresultEndEvent => e.type === EventType.ToolresultEnd
      );

      const renderedResults = new Set<string>();
      for (const tc of toolCalls) {
        const result = toolResults.find((r) => r.toolCallId === tc.toolCallId);
        assistantContent += `\n[Tool: ${tc.toolName}]`;
        if (result) {
          renderedResults.add(result.toolCallId);
          assistantContent += ` → ${renderResult(result)}`;
        }
      }
      // 孤儿 toolresult（toolcall.start 在更早的 turn，如 HITL resume 注入的结果）
      for (const r of toolResults) {
        if (renderedResults.has(r.toolCallId)) continue;
        const name = toolNames.get(r.toolCallId) ?? r.toolCallId;
        assistantContent += `\n[Tool: ${name}] → ${renderResult(r)}`;
      }
    }

    if (assistantContent.trim()) {
      messages.push({ role: "assistant", content: assistantContent.trim() });
    }
  }

  return messages;
}

function renderResult(result: ToolresultEndEvent): string {
  const body = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
  return result.isError ? `[error] ${body}` : body;
}

function summarizeTurns(turns: Turn[]): string {
  const parts: string[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const userMsg = turn.userEvents
      .filter((e): e is UserMessageEvent => e.type === EventType.UserMessage)
      .map((e) => e.content)
      .join(" ");

    const toolCalls = turn.assistantEvents
      .filter(
        (e): e is ToolcallStartEvent => e.type === EventType.ToolcallStart
      )
      .map((e) => e.toolName);

    let line = `Turn ${i + 1}: User: "${truncate(userMsg, 100)}"`;
    if (toolCalls.length > 0) {
      line += ` → Tools: [${toolCalls.join(", ")}]`;
    }
    parts.push(line);
  }

  return parts.join("\n");
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}
