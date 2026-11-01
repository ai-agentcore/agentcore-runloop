/**
 * 子 agent SSE 事件翻译器：将 ag-ui / runloop / chat-completions 协议的 SSE 事件
 * 翻译为带 parentToolCallId 的 runloop 事件，支持 N 级嵌套委派的调用树重建。
 *
 * 设计原则：
 * - 子 agent 返回的每个 SSE 事件都翻译为一个或多个 runloop 事件
 * - 所有翻译后的事件携带 parentToolCallId = 父级委派的 toolCallId
 * - 子 agent 如果自己也有委派（孙 agent），其 tool_call.* 事件会嵌套携带自己的 toolCallId，
 *   客户端沿 parentToolCallId 链即可恢复任意深度的调用树
 * - 对于 runloop 协议的子 agent，其事件可能已经带了 parentToolCallId（来自更深层嵌套），
 *   此时只替换 conversationId 并保留原 parentToolCallId（子 agent 内部的嵌套关系不变），
 *   仅对 **顶层事件**（无 parentToolCallId）设置为我们的 delegationToolCallId
 */

import type { RunloopEvent } from "../types/events.js";
import { EventType } from "../types/events.js";
import { createEvent } from "../events/factory.js";
import {
  a2aPartsText,
  a2aMessageText,
  isA2aInputRequired,
  isA2aCompleted,
  isA2aFailed,
  unwrapA2aResult,
} from "./a2a.js";
import { defaultHitlOptions } from "../hitl/default-options.js";

export interface TranslateOptions {
  conversationId: string;
  parentToolCallId: string;
  /**
   * 父级转发给该 ag-ui 子 agent 的**客户端工具名集合**（AG-UI HITL 机制①）。子 agent 对其中任一工具发
   * `TOOL_CALL_*` 即「请客户端执行」=人介入挂起 → 翻成 `toolcall.suspend`（向上冒泡），而非普通嵌套 toolcall。
   * 缺省/空集 → 一切 TOOL_CALL 按普通工具调用翻译（零行为变化）。
   */
  clientToolNames?: Set<string>;
  /**
   * 跨事件累积器（机制①）：AG-UI tool-call 的 START/ARGS/END 是 3 条独立事件，需在一次委派的流消费中
   * 累积 `{toolName, args}`，在 END 产出带 args 的 `toolcall.suspend`。由 `sub-agent-caller` 每次委派建一个、
   * 透传进来；翻译器读写它。缺省则不累积（无机制① 支持）。
   */
  aguiToolCalls?: Map<string, { toolName: string; args: string }>;
}

/** AG-UI interrupt.reason 的合法语义类别（→ toolcall.suspend.interactionKind）；非此集合的 reason 不透传。 */
const AGUI_INTERACTION_KINDS = new Set(["tool_call", "input_required", "confirmation"]);

/**
 * 翻译单条子 agent SSE JSON 事件为 runloop 事件数组。
 * 返回空数组表示该事件不需要翻译（如心跳、未知类型）。
 */
export function translateChildEvent(
  event: Record<string, unknown>,
  protocol: "ag-ui" | "chat-completions" | "runloop" | "a2a",
  opts: TranslateOptions,
): RunloopEvent[] {
  switch (protocol) {
    case "runloop":
      return translateRunloopEvent(event, opts);
    case "ag-ui":
      return translateAguiEvent(event, opts);
    case "chat-completions":
      return translateChatCompletionsChunk(event, opts);
    case "a2a":
      return translateA2aEvent(event, opts);
    default:
      return [];
  }
}

function translateRunloopEvent(
  event: Record<string, unknown>,
  opts: TranslateOptions,
): RunloopEvent[] {
  const type = event.type as string;
  if (!type) return [];

  // 跳过子 agent 的 run 生命周期（父级已有自己的）
  if (type === EventType.RunStart || type === EventType.RunEnd
    || type === EventType.RunInterrupt || type === EventType.RunError) {
    return [];
  }
  // 跳过 run.usage（父级有自己的审计）
  if (type === EventType.RunUsage) return [];

  // 子 agent 事件如果已经带 parentToolCallId（来自更深层嵌套），保留它不覆盖——
  // 这样客户端能完整重建子 agent 内部的嵌套链；
  // 仅对子 agent 的顶层事件（无 parentToolCallId）设置我们的 delegationToolCallId。
  const childParent = event.parentToolCallId as string | undefined;
  const effectiveParent = childParent ?? opts.parentToolCallId;

  // 重建事件：替换 conversationId，设置 parentToolCallId，保留其他所有字段
  const { id: _id, timestamp: _ts, conversationId: _cid, ...rest } = event;
  return [createEvent(type, opts.conversationId, {
    ...rest,
    parentToolCallId: effectiveParent,
  })];
}

function translateAguiEvent(
  event: Record<string, unknown>,
  opts: TranslateOptions,
): RunloopEvent[] {
  const type = (event.type as string)?.toUpperCase?.() ?? (event.type as string);
  if (!type) return [];

  const make = (t: string, data: Record<string, unknown> = {}) =>
    createEvent(t, opts.conversationId, { parentToolCallId: opts.parentToolCallId, ...data });

  switch (type) {
    case "TEXT_MESSAGE_START":
    case "text_message_start":
      return [make(EventType.MessageStart, { role: "assistant" })];

    case "TEXT_MESSAGE_CONTENT":
    case "text_message_content":
      return [make(EventType.MessageDelta, { content: event.delta as string ?? "" })];

    case "TEXT_MESSAGE_END":
    case "text_message_end":
      return [make(EventType.MessageEnd)];

    case "TOOL_CALL_START":
    case "tool_call_start": {
      const tcId = (event.toolCallId as string) ?? (event.tool_call_id as string) ?? "";
      const tcName = (event.toolCallName as string) ?? (event.name as string) ?? "";
      // 机制①（HITL via tool-call）：子 agent 对**父级转发的客户端工具**发 TOOL_CALL = 请客户端（最终是人）
      // 执行 = 人介入挂起。开始累积，到 TOOL_CALL_END 产出带 args 的 toolcall.suspend（START/ARGS/END 跨 3 事件）。
      if (tcName && opts.clientToolNames?.has(tcName) && opts.aguiToolCalls) {
        opts.aguiToolCalls.set(tcId, { toolName: tcName, args: "" });
      }
      return [make(EventType.ToolcallStart, {
        toolCallId: tcId,
        toolName: tcName,
      })];
    }

    case "TOOL_CALL_ARGS":
    case "tool_call_args": {
      const tcId = (event.toolCallId as string) ?? (event.tool_call_id as string) ?? "";
      const delta = event.delta as string ?? "";
      // 机制①累积：客户端 HITL 工具的参数攒到 END 再产 suspend，不发 toolcall.delta（那是普通工具的流式参数）。
      const pending = opts.aguiToolCalls?.get(tcId);
      if (pending) {
        pending.args += delta;
        return [];
      }
      return [make(EventType.ToolcallDelta, { toolCallId: tcId, chunk: delta })];
    }

    case "TOOL_CALL_END":
    case "tool_call_end": {
      const tcId = (event.toolCallId as string) ?? (event.tool_call_id as string) ?? "";
      // 机制①：客户端 HITL 工具的 END → toolcall.end（带累积 args）+ toolcall.suspend（沿 parentToolCallId 链冒泡）。
      const pending = opts.aguiToolCalls?.get(tcId);
      if (pending) {
        opts.aguiToolCalls!.delete(tcId);
        let args: Record<string, unknown> = {};
        try {
          const p = JSON.parse(pending.args || "{}");
          if (p && typeof p === "object") args = p as Record<string, unknown>;
        } catch {
          /* 非 JSON args，留空对象 */
        }
        const rawReason = args.reason as string | undefined;
        const interactionKind = rawReason && AGUI_INTERACTION_KINDS.has(rawReason) ? rawReason : undefined;
        const isInput = interactionKind === "input_required";
        const prompt = (args.prompt as string) ?? (args.question as string) ?? undefined;
        return [
          make(EventType.ToolcallEnd, { toolCallId: tcId, args }),
          make(EventType.ToolcallSuspend, {
            toolCallId: tcId,
            toolName: pending.toolName,
            args,
            reason: "model_request" as const,
            ...(interactionKind ? { interactionKind } : {}),
            ...(args.responseSchema ? { responseSchema: args.responseSchema as Record<string, unknown> } : {}),
            ...(prompt ? { prompt } : {}),
            // 取值类（input_required）留空让上游渲染输入控件；其余套默认 approve/reject（带 matchWords）。
            options: (args.options as unknown[]) ?? (isInput ? [] : defaultHitlOptions()),
          }),
        ];
      }
      return [make(EventType.ToolresultEnd, {
        toolCallId: tcId,
        result: event.result as string ?? "",
        isError: false,
      })];
    }

    // 子 agent 思考流（ag-ui 0.0.57 REASONING_* + 旧 THINKING_*）→ runloop reasoning.*（附记修复）。
    // type 已 toUpperCase。映射 message-level 事件为 start/delta/end，忽略外层 REASONING_START/END 包裹
    // 避免双 start/end（标准嵌套序列 START→MESSAGE_START→CONTENT*→MESSAGE_END→END 由此得干净的
    // start→delta*→end）。委派期间父 message 已被 MergeNormalizer 关闭，注入 child reasoning 不与父 message 交织。
    case "REASONING_MESSAGE_START":
    case "THINKING_TEXT_MESSAGE_START":
      return [make(EventType.ReasoningStart)];

    case "REASONING_MESSAGE_CONTENT":
    case "REASONING_MESSAGE_CHUNK":
    case "THINKING_TEXT_MESSAGE_CONTENT":
      return [make(EventType.ReasoningDelta, { content: event.delta as string ?? "" })];

    case "REASONING_MESSAGE_END":
    case "THINKING_TEXT_MESSAGE_END":
      return [make(EventType.ReasoningEnd)];

    case "REASONING_START":
    case "REASONING_END":
    case "REASONING_ENCRYPTED_VALUE":
    case "THINKING_START":
    case "THINKING_END":
      // 外层包裹 / 加密值不翻译（start/end 由 message-level 事件承载）。
      return [];

    case "RUN_STARTED":
    case "run_started":
    case "RUN_ERROR":
    case "run_error":
      // 子 agent 生命周期不翻译（父级已有自己的 run.* / tool_call.result）
      return [];

    case "RUN_FINISHED":
    case "run_finished": {
      // AG-UI 现行 interrupt 协议（HITL）：RUN_FINISHED + outcome:{type:"interrupt",interrupts:[...]}。
      // 把每个 interrupt 沿 parentToolCallId 链向上透传为父级 toolcall.suspend（AD-026 嵌套）。
      // 无 interrupt outcome 的正常收尾不翻译（父级有自己的 tool_call.result）。
      const outcome = event.outcome as { type?: string; interrupts?: unknown[] } | undefined;
      if (outcome?.type !== "interrupt" || !Array.isArray(outcome.interrupts)) return [];
      return outcome.interrupts.map((raw) => {
        const it = (raw ?? {}) as Record<string, unknown>;
        // AG-UI 的 reason（tool_call/input_required/confirmation）是交互语义类别 → 落到独立的 interactionKind
        // （与我们触发源的 suspend.reason 正交，G4）；非枚举值则不带（按 options/prompt 处理）。
        const rawReason = it.reason as string | undefined;
        const interactionKind = rawReason && AGUI_INTERACTION_KINDS.has(rawReason) ? rawReason : undefined;
        const isInput = interactionKind === "input_required";
        return make(EventType.ToolcallSuspend, {
          // AG-UI interrupt 的 id 即 resume 时的 interruptId（顶层 resume[].interruptId 回引此值）。
          // 优先 toolCallId（tool_call reason），否则用 interrupt id 作锚（confirmation/input_required 裸中断）。
          toolCallId: (it.toolCallId as string) ?? (it.id as string) ?? `child-${opts.parentToolCallId}`,
          toolName: (it.toolName as string) ?? "interrupt",
          args: (it.args as Record<string, unknown>) ?? {},
          reason: "model_request" as const,
          ...(interactionKind ? { interactionKind } : {}),
          ...(it.responseSchema ? { responseSchema: it.responseSchema as Record<string, unknown> } : {}),
          ...(it.expiresAt ? { expiresAt: it.expiresAt as string } : {}),
          // NL 降级提问透传（AD-026 增补）：interrupt.message → prompt
          ...(it.message ? { prompt: it.message as string } : {}),
          // 取值类（input_required）不套默认是非选项——留空，让上游按 responseSchema 渲染输入控件；
          // 其余（confirmation/tool_call）套默认 approve/reject 带 matchWords（嵌套 NL 通道补全）。
          options: (it.options as unknown[]) ?? (isInput ? [] : defaultHitlOptions()),
        });
      });
    }

    case "INTERRUPT":
    case "interrupt": {
      // 子 ag-ui agent 触发的 HITL → 沿 parentToolCallId 链向上透传为父级 toolcall.suspend（AD-026 嵌套）。
      // 之前 default 分支会静默丢弃 interrupt/custom 事件（含 HITL）——这里补上。
      const v = (event.value ?? event.payload ?? event) as Record<string, unknown>;
      return [make(EventType.ToolcallSuspend, {
        toolCallId: (v.toolCallId as string) ?? (event.toolCallId as string) ?? `child-${(opts.parentToolCallId)}`,
        toolName: (v.toolName as string) ?? "interrupt",
        args: (v.args as Record<string, unknown>) ?? {},
        reason: "model_request" as const,
        // NL 降级提问透传（AD-026 增补）：子 ag-ui agent 给了 prompt 就带上去
        ...(v.prompt ? { prompt: v.prompt as string } : {}),
        // 子 agent 自带 options 则用其自带的；否则默认 approve/reject 带 matchWords（嵌套 NL 通道补全）。
        options: (v.options as unknown[]) ?? defaultHitlOptions(),
      })];
    }

    case "CUSTOM":
    case "custom": {
      // ag-ui CUSTOM：HITL 类（runloop.hitl_request 等）透传为 toolcall.suspend，其余作为带 metadata 的事件保留，
      // 不再静默丢弃（修复审计发现的 interrupt/custom 掉事件 bug）。
      const name = (event.name as string) ?? "";
      if (/hitl|interrupt|suspend/i.test(name)) {
        const v = (event.value ?? {}) as Record<string, unknown>;
        return [make(EventType.ToolcallSuspend, {
          toolCallId: (v.toolCallId as string) ?? `child-${opts.parentToolCallId}`,
          toolName: (v.toolName as string) ?? name,
          args: (v.args as Record<string, unknown>) ?? {},
          reason: "model_request" as const,
          ...(v.prompt ? { prompt: v.prompt as string } : {}),
          options: (v.options as unknown[]) ?? defaultHitlOptions(),
        })];
      }
      return [];
    }

    default:
      return [];
  }
}

function translateChatCompletionsChunk(
  event: Record<string, unknown>,
  opts: TranslateOptions,
): RunloopEvent[] {
  const make = (t: string, data: Record<string, unknown> = {}) =>
    createEvent(t, opts.conversationId, { parentToolCallId: opts.parentToolCallId, ...data });

  const choices = event.choices as Array<{ delta?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return [];

  const delta = choices[0]?.delta;
  const finish = choices[0]?.finish_reason;
  const out: RunloopEvent[] = [];

  if (delta?.content) {
    out.push(make(EventType.MessageDelta, { content: delta.content }));
  }

  if (finish === "stop") {
    out.push(make(EventType.MessageEnd));
  }

  return out;
}

/**
 * 翻译 A2A（Agent2Agent）协议事件。先解包 JSON-RPC `result` 信封，再按 A2A 事件 kind 分派：
 * - `message`(role agent) / `artifact-update` / `status-update`(working).status.message → `message.delta`（文本 parts）
 * - `status-update`(final, completed) → `message.end`
 * - `status-update` | `task` 处于 input-required/auth-required → `toolcall.suspend`（嵌套 HITL 向上透传，AD-026）
 * - JSON-RPC 错误信封 / 失败终态 → 不在此产事件（由 sub-agent-caller 的 extractA2aError 捕获为结构化终态错误）
 * - `task` 非终态快照 → 不产文本（避免与 artifact/message 流重复计数）
 */
function translateA2aEvent(
  event: Record<string, unknown>,
  opts: TranslateOptions,
): RunloopEvent[] {
  // 错误信封交给 extractA2aError 处理，不翻译成事件。
  if (event.jsonrpc && event.error) return [];

  const a2a = unwrapA2aResult(event);
  const kind = (a2a.kind as string) ?? (a2a.type as string);
  if (!kind) return [];

  const make = (t: string, data: Record<string, unknown> = {}) =>
    createEvent(t, opts.conversationId, { parentToolCallId: opts.parentToolCallId, ...data });

  switch (kind) {
    case "message": {
      const text = a2aPartsText(a2a.parts);
      return text ? [make(EventType.MessageDelta, { content: text })] : [];
    }

    case "artifact-update": {
      const artifact = a2a.artifact as { parts?: unknown } | undefined;
      const text = a2aPartsText(artifact?.parts);
      return text ? [make(EventType.MessageDelta, { content: text })] : [];
    }

    case "status-update":
    case "task": {
      const status = a2a.status as Record<string, unknown> | undefined;
      const state = status?.state as string | undefined;
      // 需要人介入 → 沿 parentToolCallId 链向上透传为父级 toolcall.suspend（嵌套 HITL）。
      if (isA2aInputRequired(state)) {
        const prompt = a2aMessageText(status?.message);
        return [make(EventType.ToolcallSuspend, {
          toolCallId: (a2a.taskId as string) ?? (a2a.id as string) ?? `child-${opts.parentToolCallId}`,
          toolName: "a2a_input_required",
          args: {},
          reason: "model_request" as const,
          ...(prompt ? { prompt } : {}),
          // 默认 approve/reject 带 matchWords（嵌套 NL 通道补全）——否则真实首轮 input-required 的
          // NL 回复（"好的"）在 resolvePendingHitl 里匹配不到任何 option → 重问直至自动拒绝。
          options: defaultHitlOptions(),
        })];
      }
      // 失败终态交 extractA2aError；task 非终态快照不产文本（避免与 artifact/message 重复）。
      if (isA2aFailed(state) || kind === "task") return [];
      // status-update：中间/完成态——status.message 文本流出 + 完成时关闭 message。
      const out: RunloopEvent[] = [];
      const text = a2aMessageText(status?.message);
      if (text) out.push(make(EventType.MessageDelta, { content: text }));
      if (a2a.final === true && isA2aCompleted(state)) out.push(make(EventType.MessageEnd));
      return out;
    }

    default:
      return [];
  }
}
