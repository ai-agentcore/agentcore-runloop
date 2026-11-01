/**
 * 回归守护：HITL execute-on-resume 产出的 resume run SSE 必须**自洽**——
 * toolresult.* 前有同 id 的 toolcall.start（无孤儿）。
 *
 * 由真实 e2e（make e2e，tests/e2e/hitl.test.ts「重问→再批准」用例）抓到：早期 resume run 只注入
 * toolresult.*，而对应 toolcall.start 在更早的 suspend run，导致 assertBaseInvariants 报「孤儿事件」。
 * 修复 = resolvePendingHitl 在 resume run 重发 toolcall.start+end（语义上 resume run 才真正执行）。
 * 本测试用合成事件流在 `make test` 里守住，不需真实 e2e 凭证。
 */
import { describe, it, expect } from "vitest";
import { assertBaseInvariants } from "../e2e/event-invariants.js";
import { resolvePendingHitl } from "@/hitl/resume.js";
import { createEvent } from "@/events/factory.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

const CID = "c-selfcontained";

function suspendThenResolve(toolCallId: string, optionId: string): RunloopEvent[] {
  return [
    { id: `st-${toolCallId}`, type: "toolcall.start", timestamp: 1, conversationId: CID, toolCallId, toolName: "request_confirmation" },
    { id: `en-${toolCallId}`, type: "toolcall.end", timestamp: 2, conversationId: CID, toolCallId, args: { reason: "ok?" } },
    { id: `s-${toolCallId}`, type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId, toolName: "request_confirmation", reason: "model_request",
      options: [{ optionId: "approve", label: "ok", kind: "allow_once" }, { optionId: "reject", label: "no", kind: "reject_once" }] },
    { id: `c-${toolCallId}`, type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId, selectedOptionId: optionId },
  ] as RunloopEvent[];
}

/** 把 execute-on-resume 注入事件包成一个完整 resume run 的 SSE 响应（run.start…run.end）。 */
function asRunSse(injected: RunloopEvent[]): RunloopEvent[] {
  return [
    createEvent(EventType.RunStart, CID, { runId: "run-2", agentCli: "codex" }),
    ...injected,
    createEvent(EventType.RunEnd, CID, { runId: "run-2", reason: "completed" }),
  ];
}

describe("HITL resume run 自洽（无孤儿 toolresult.start）", () => {
  it("批准 → resume run 的 SSE 通过 assertBaseInvariants（toolcall.start 前置于 toolresult.*）", async () => {
    const r = await resolvePendingHitl(suspendThenResolve("tc-approve", "approve"), {
      conversationId: CID, runId: "run-2", sidecar: null,
    });
    expect(r.error).toBeUndefined();
    expect(r.events[0].type).toBe(EventType.ToolcallStart); // 重发的生命周期开头
    expect(() => assertBaseInvariants(asRunSse(r.events))).not.toThrow();
  });

  it("拒绝 → resume run 的 SSE 同样自洽", async () => {
    const r = await resolvePendingHitl(suspendThenResolve("tc-reject", "reject"), {
      conversationId: CID, runId: "run-2", sidecar: null,
    });
    expect(r.error).toBeUndefined();
    expect(() => assertBaseInvariants(asRunSse(r.events))).not.toThrow();
  });
});
