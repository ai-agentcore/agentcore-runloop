/**
 * 守护 e2e 基础不变量校验器（tests/e2e/event-invariants.ts）。
 *
 * 该校验器对每个 e2e case 的 SSE 响应无条件强制：字段符合 spec schema、run 首尾成对、
 * message/toolcall 顺序、生命周期成组。本测试用合成事件流（不需要真实 e2e 凭证）验证它
 * 既放行合法流、又能抓住各类违规——这样校验器本身的回归在 `make test` 里就能守住。
 */
import { describe, it, expect } from "vitest";
import { assertBaseInvariants } from "../e2e/event-invariants.js";
import { createEvent } from "@/events/factory.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

const CONV = "conv-1";
const ev = (type: string, data: Record<string, unknown> = {}): RunloopEvent =>
  createEvent(type, CONV, data);

/** 合法基线：run.start → 一条助手消息 → 一次工具调用(start→end→result) → run.end。 */
function validStream(): RunloopEvent[] {
  return [
    ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
    ev(EventType.MessageStart, { role: "assistant" }),
    ev(EventType.MessageDelta, { content: "你好" }),
    ev(EventType.MessageEnd),
    ev(EventType.ToolcallStart, { toolCallId: "tc1", toolName: "base64" }),
    ev(EventType.ToolcallEnd, { toolCallId: "tc1", args: { x: 1 } }),
    ev(EventType.ToolresultEnd, { toolCallId: "tc1", result: "ok" }),
    ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
  ];
}

describe("e2e base invariants — 放行合法流", () => {
  it("接受标准 run.start…run.end 流", () => {
    expect(() => assertBaseInvariants(validStream())).not.toThrow();
  });

  it("接受无工具的纯对话流", () => {
    expect(() =>
      assertBaseInvariants([
        ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
        ev(EventType.MessageStart, { role: "assistant" }),
        ev(EventType.MessageDelta, { content: "hi" }),
        ev(EventType.MessageEnd),
        ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
      ]),
    ).not.toThrow();
  });

  it("接受 toolresult.start 缺省的工具流（MCP/codex 路径常如此）", () => {
    // 仅 toolcall.start→end→toolresult.end，无 toolresult.start，不应误判孤儿。
    expect(() => assertBaseInvariants(validStream())).not.toThrow();
  });

  it("接受 toolcall.end→toolcall.suspend（本 run 不产 toolresult）", () => {
    expect(() =>
      assertBaseInvariants([
        ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
        ev(EventType.ToolcallStart, { toolCallId: "tc1", toolName: "drop_table" }),
        ev(EventType.ToolcallEnd, { toolCallId: "tc1", args: {} }),
        ev(EventType.ToolcallSuspend, {
          toolCallId: "tc1",
          toolName: "drop_table",
          reason: "static_rule",
          options: [{ optionId: "approve", label: "允许", kind: "allow_once" }],
        }),
        ev(EventType.RunEnd, { runId: "r1", reason: "hitl_pending" }),
      ]),
    ).not.toThrow();
  });
});

describe("e2e base invariants — A. spec schema 字段校验", () => {
  it("缺必填字段（toolcall.start 无 toolName）应抛错", () => {
    const events = validStream();
    events[4] = ev(EventType.ToolcallStart, { toolCallId: "tc1" }); // 缺 toolName
    expect(() => assertBaseInvariants(events)).toThrow(/违反 spec schema/);
  });

  it("枚举越界（run.end.reason 非法）应抛错", () => {
    const events = validStream();
    events[events.length - 1] = ev(EventType.RunEnd, { runId: "r1", reason: "bogus" });
    expect(() => assertBaseInvariants(events)).toThrow(/违反 spec schema/);
  });

  it("未知事件类型应抛错", () => {
    const events = validStream();
    events.splice(1, 0, ev("totally.bogus", {}));
    expect(() => assertBaseInvariants(events)).toThrow(/违反 spec schema/);
  });
});

describe("e2e base invariants — B. run 成对收尾", () => {
  it("空流应抛错", () => {
    expect(() => assertBaseInvariants([])).toThrow(/empty/);
  });

  it("首事件非 run.start 应抛错", () => {
    const events = validStream().slice(1);
    events.unshift(ev(EventType.RunEnd, { runId: "r1", reason: "completed" }));
    expect(() => assertBaseInvariants(events)).toThrow(/首个事件应为 run\.start/);
  });

  it("末事件非 run.end 应抛错（L-033）", () => {
    const events = validStream();
    events.pop();
    expect(() => assertBaseInvariants(events)).toThrow(/末个事件应为 run\.end/);
  });

  it("出现两个 run.end 应抛错", () => {
    const events = validStream();
    events.splice(events.length - 1, 0, ev(EventType.RunEnd, { runId: "r1", reason: "completed" }));
    expect(() => assertBaseInvariants(events)).toThrow(/run\.end 应恰好 1 个/);
  });
});

describe("e2e base invariants — C. conversationId 一致", () => {
  it("某事件 conversationId 不一致应抛错", () => {
    const events = validStream();
    events[2] = createEvent(EventType.MessageDelta, "other-conv", { content: "x" });
    expect(() => assertBaseInvariants(events)).toThrow(/conversationId.*不一致/);
  });
});

describe("e2e base invariants — D. message 顺序", () => {
  it("孤儿 message.delta（无 message.start）应抛错", () => {
    const events = [
      ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
      ev(EventType.MessageDelta, { content: "孤儿" }),
      ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
    ];
    expect(() => assertBaseInvariants(events)).toThrow(/orphan message\.delta/);
  });

  it("流末未闭合 message 应抛错", () => {
    const events = [
      ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
      ev(EventType.MessageStart, { role: "assistant" }),
      ev(EventType.MessageDelta, { content: "未关" }),
      ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
    ];
    expect(() => assertBaseInvariants(events)).toThrow(/unclosed message/);
  });

  it("toolcall.start 前 message 未关闭应抛错", () => {
    const events = [
      ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
      ev(EventType.MessageStart, { role: "assistant" }),
      ev(EventType.ToolcallStart, { toolCallId: "tc1", toolName: "t" }),
      ev(EventType.ToolcallEnd, { toolCallId: "tc1", args: {} }),
      ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
    ];
    expect(() => assertBaseInvariants(events)).toThrow(/message still open/);
  });
});

describe("e2e base invariants — F. 聚合 id 同组一致", () => {
  it("接受同一条 message 的 start/delta/end 共享 messageId", () => {
    expect(() =>
      assertBaseInvariants([
        ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
        ev(EventType.MessageStart, { messageId: "msg-1", role: "assistant" }),
        ev(EventType.MessageDelta, { messageId: "msg-1", content: "你好" }),
        ev(EventType.MessageEnd, { messageId: "msg-1" }),
        ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
      ]),
    ).not.toThrow();
  });

  it("message 组内 messageId 撕裂应抛错", () => {
    expect(() =>
      assertBaseInvariants([
        ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
        ev(EventType.MessageStart, { messageId: "msg-1", role: "assistant" }),
        ev(EventType.MessageDelta, { messageId: "msg-2", content: "x" }), // id 撕裂
        ev(EventType.MessageEnd, { messageId: "msg-1" }),
        ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
      ]),
    ).toThrow(/聚合 id 必须同组一致/);
  });

  it("reasoning 组内 reasoningId 撕裂应抛错", () => {
    expect(() =>
      assertBaseInvariants([
        ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
        ev(EventType.ReasoningStart, { reasoningId: "rsn-1" }),
        ev(EventType.ReasoningDelta, { reasoningId: "rsn-9", content: "think" }), // id 撕裂
        ev(EventType.ReasoningEnd, { reasoningId: "rsn-1" }),
        ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
      ]),
    ).toThrow(/聚合 id 必须同组一致/);
  });

  it("旧式合成流（start 不带 id）整组跳过、不误判", () => {
    // validStream 的 message 事件均无 messageId（all-or-nothing：start 无 id → 跳过整组）。
    expect(() => assertBaseInvariants(validStream())).not.toThrow();
  });
});

describe("e2e base invariants — E. 生命周期成组", () => {
  it("孤儿 toolresult.end（无前置 toolcall.start）应抛错", () => {
    const events = [
      ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
      ev(EventType.ToolresultEnd, { toolCallId: "ghost", result: "x" }),
      ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
    ];
    expect(() => assertBaseInvariants(events)).toThrow(/孤儿事件/);
  });

  it("孤儿 toolcall.end（id 与 start 不匹配）应抛错", () => {
    const events = [
      ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
      ev(EventType.ToolcallStart, { toolCallId: "tc1", toolName: "t" }),
      ev(EventType.ToolcallEnd, { toolCallId: "tc2", args: {} }), // id 撕裂
      ev(EventType.RunEnd, { runId: "r1", reason: "completed" }),
    ];
    expect(() => assertBaseInvariants(events)).toThrow(/孤儿事件/);
  });

  it("suspend 之后又出现同 id 的 toolresult 应抛错（AD-026）", () => {
    const events = [
      ev(EventType.RunStart, { runId: "r1", agentCli: "codex" }),
      ev(EventType.ToolcallStart, { toolCallId: "tc1", toolName: "t" }),
      ev(EventType.ToolcallEnd, { toolCallId: "tc1", args: {} }),
      ev(EventType.ToolcallSuspend, {
        toolCallId: "tc1",
        toolName: "t",
        reason: "static_rule",
        options: [{ optionId: "a", label: "允许", kind: "allow_once" }],
      }),
      ev(EventType.ToolresultEnd, { toolCallId: "tc1", result: "x" }),
      ev(EventType.RunEnd, { runId: "r1", reason: "hitl_pending" }),
    ];
    expect(() => assertBaseInvariants(events)).toThrow(/AD-026/);
  });
});
