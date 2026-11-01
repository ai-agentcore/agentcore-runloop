import { nanoid } from "nanoid";
import { createEvent } from "./factory.js";
import { EventType, type RunloopEvent } from "../types/events.js";

/** 组聚合 id（同一条 message / 同一段 reasoning 的 start/delta/end 共享）。带前缀便于日志/SSE 辨认。 */
function newGroupId(prefix: string): string {
  return `${prefix}-${nanoid()}`;
}

/**
 * 合并流不变量归一化器。
 *
 * runloop 把 adapter 事件流和 sidecar 注入事件流合并成单条上游 SSE 流。两条流各自维护
 * 自己的 message 开闭状态，互不知情；而协议要求 `tool_call.start` 之前必须先关闭打开的 message
 * （见 tests/e2e/events 不变量）。合并点是唯一同时看到两条流的地方，因此在这里统一维护 message
 * 开闭真相（合并点是唯一权威，因为 proxy 流式文本经 onStreamDelta→sm.textDelta，没有自己的
 * 重同步点；委派 exec 卡片被抑制后 adapter 的 sm 可能停在 MESSAGE_OPEN，导致委派后的文本以
 * 裸 message.delta 发出）：
 *  - 遇到 `tool_call.start` 而 message 仍打开时，先补一条 `message.end`；
 *  - 遇到 `message.start` 而 message 已打开（跨流竞争：adapter 父 message 未关时 sidecar 注入了
 *    嵌套 child 的 message.start）时，先补一条 `message.end` 关掉上一条，再开新的（否则裸双 start）；
 *  - 遇到 `message.delta` 而 message 已关闭（孤儿 delta）时，先补一条 `message.start`；
 *  - 跨流竞争产生的多余 `message.end`（message 已关闭）直接丢弃，保证幂等。
 *
 * 聚合 id（合并点是唯一权威，同 L-056 "出站字段统一在中心出口盖"）：合并点也是给 message.* /
 * reasoning.* 盖 `messageId` / `reasoningId` 的唯一权威——同一条 message 的 start/delta/end（含
 * 归一化器自己补出的 start/end）共享一个 `messageId`，reasoning 同理共享一个 `reasoningId`。因为
 * 上游产出者（adapter 状态机、stateless 的子 agent event-translator）无法跨独立事件维持一致 id，
 * 且归一化器会再合成 start/end，故 id 必须由它统一盖、覆盖任何上游残留。toolcall/toolresult 已有
 * `toolCallId` 作聚合键、不在此盖。每次「新 message / 新 reasoning 段」开始时换一个新 id（start 处
 * 重新生成、段间不复用），故无需在 end 处清空——下一段 start 必换新 id。
 *
 * 该归一化器是纯状态机，便于独立测试合并不变量。
 */
export class MergeNormalizer {
  private messageOpen = false;
  /** 当前 message 的聚合 id（每条 message 的 start 处换新；段内 delta/end 沿用）。 */
  private messageId = newGroupId("msg");
  /** 当前 reasoning 段的聚合 id（每段 reasoning 的 start 处换新）。 */
  private reasoningId = newGroupId("rsn");

  constructor(private readonly conversationId: string) {}

  get isMessageOpen(): boolean {
    return this.messageOpen;
  }

  normalize(event: RunloopEvent): RunloopEvent[] {
    const out: RunloopEvent[] = [];

    // tool_call.start 或 新 message.start 到来而上一条 message 仍打开 → 先补 message.end 关掉它
    //（沿用当前 messageId，属于正在关闭的那条 message）。
    if ((event.type === EventType.ToolcallStart || event.type === EventType.MessageStart) && this.messageOpen) {
      out.push(this.stamp(createEvent(EventType.MessageEnd, this.conversationId, {})));
      this.messageOpen = false;
    }

    if (event.type === EventType.MessageStart) {
      this.messageId = newGroupId("msg"); // 开新 message：换新 id
      this.messageOpen = true;
    } else if (event.type === EventType.MessageDelta && !this.messageOpen) {
      this.messageId = newGroupId("msg"); // 孤儿 delta：补 start 并开新 message
      out.push(this.stamp(createEvent(EventType.MessageStart, this.conversationId, { role: "assistant" })));
      this.messageOpen = true;
    } else if (event.type === EventType.MessageEnd && !this.messageOpen) {
      return out; // 丢弃多余的 message.end
    }

    out.push(this.stamp(event));
    if (event.type === EventType.MessageEnd) this.messageOpen = false;
    return out;
  }

  /**
   * 终止前兜底闭合（L10）：若仍有打开的 message，补一条 `message.end`。
   * `run.end` 必须是流末事件且流末不得有未闭合 message（assertBaseInvariants）；但子 agent
   * （ag-ui 仅 TEXT_MESSAGE_END 才发 MessageEnd / chat-completions 仅 finish_reason==="stop" 才关）
   * 漏发 message-end 时，孤儿 child message 会一路带到 run.end 触发自身契约抛错。runner 在每个
   * 终结点（completed/interrupted/timeout/error/hitl_pending）emit run.end 前调用 flush 使流自洽。
   */
  flush(): RunloopEvent[] {
    if (!this.messageOpen) return [];
    this.messageOpen = false;
    return [this.stamp(createEvent(EventType.MessageEnd, this.conversationId, {}))];
  }

  /**
   * 给 message.* / reasoning.* 盖上各自的聚合 id（同组共享一个）。其它事件原样返回。
   * 直接写入字段（与 runner 的 stampRunId 同风格——事件均为新建、未被共享）。
   * reasoning 无 normalize 结构逻辑，故其「换新 id」在 reasoning.start 这里做。
   */
  private stamp(event: RunloopEvent): RunloopEvent {
    switch (event.type) {
      case EventType.MessageStart:
      case EventType.MessageDelta:
      case EventType.MessageEnd:
        (event as { messageId?: string }).messageId = this.messageId;
        return event;
      case EventType.ReasoningStart:
        this.reasoningId = newGroupId("rsn"); // 开新 reasoning 段：换新 id
        (event as { reasoningId?: string }).reasoningId = this.reasoningId;
        return event;
      case EventType.ReasoningDelta:
      case EventType.ReasoningEnd:
        (event as { reasoningId?: string }).reasoningId = this.reasoningId;
        return event;
      default:
        return event;
    }
  }
}
