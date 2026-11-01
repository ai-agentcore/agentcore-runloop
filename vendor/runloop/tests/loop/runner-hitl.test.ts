import { describe, it, expect } from "vitest";
import { LoopRunner } from "@/loop/runner.js";
import { EventType, ErrorCode, type RunloopEvent } from "@/types/events.js";
import type { RunRequest } from "@/types/api.js";

async function collect(gen: AsyncGenerator<RunloopEvent>): Promise<RunloopEvent[]> {
  const out: RunloopEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function baseReq(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    agent: { cli: "echo" },
    events: [{ type: "user.message", content: "hi" } as never],
    model: { provider: "test", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
    credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    ...overrides,
  };
}

describe("LoopRunner — run.end pairing (L-033)", () => {
  it("error path emits run.error then run.end{error} as the final event", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    // missing model.baseUrl/apiKey → runner throws → run.error + run.end{error}
    const req = baseReq({ model: { provider: "test", model: "m" } as never });
    const events = await collect(runner.run(req));
    const err = events.find((e) => e.type === EventType.RunError) as RunloopEvent & { error?: { code?: string } };
    expect(err).toBeDefined();
    expect(err.error?.code).toBe(ErrorCode.LoopError);
    expect(events[events.length - 1].type).toBe(EventType.RunEnd);
    expect((events[events.length - 1] as RunloopEvent & { reason?: string }).reason).toBe("error");
    // every event carries runId
    expect(events.every((e) => typeof (e as RunloopEvent & { runId?: string }).runId === "string")).toBe(true);
  });

  it("completed run ends with run.end{completed}", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const events = await collect(runner.run(baseReq()));
    const end = events[events.length - 1] as RunloopEvent & { reason?: string };
    expect(end.type).toBe(EventType.RunEnd);
    expect(end.reason).toBe("completed");
  });
});

describe("LoopRunner — HITL execute-on-resume (AD-026)", () => {
  it("aux-track resolve approve injects toolresult before the run continues", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const req = baseReq({
      events: [
        { type: "user.message", content: "do it" },
        { type: "toolcall.start", toolCallId: "tc-1", toolName: "request_confirmation" },
        { type: "toolcall.end", toolCallId: "tc-1", args: { reason: "ok?" } },
        { type: "toolcall.suspend", toolCallId: "tc-1", toolName: "request_confirmation", reason: "model_request",
          options: [{ optionId: "approve", label: "ok", kind: "allow_once" }, { optionId: "reject", label: "no", kind: "reject_once" }] },
        { type: "user.command", command: "resolve", toolCallId: "tc-1", selectedOptionId: "approve" },
      ] as never,
    });
    const events = await collect(runner.run(req));
    const trStart = events.find((e) => e.type === EventType.ToolresultStart);
    const trEnd = events.find((e) => e.type === EventType.ToolresultEnd) as RunloopEvent & { result?: { status?: string } };
    expect(trStart).toBeDefined();
    expect(trEnd?.result?.status).toBe("confirmed_by_user");
    expect(events[events.length - 1].type).toBe(EventType.RunEnd);
  });

  it("unresolved suspend (no resolve) → run.error{HITL_UNRESOLVED} + run.end{error}", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const req = baseReq({
      events: [
        { type: "toolcall.suspend", toolCallId: "tc-9", toolName: "db_drop", reason: "static_rule",
          options: [{ optionId: "approve", label: "ok", kind: "allow_once" }] },
      ] as never,
    });
    const events = await collect(runner.run(req));
    const err = events.find((e) => e.type === EventType.RunError) as RunloopEvent & { error?: { code?: string } };
    expect(err?.error?.code).toBe(ErrorCode.HitlUnresolved);
    const end = events[events.length - 1] as RunloopEvent & { reason?: string };
    expect(end.type).toBe(EventType.RunEnd);
    expect(end.reason).toBe("error");
  });

  // NL 通道（AD-026 增补）端到端经 LoopRunner：reask 分支（跳过 codex，重问 + hitl_pending）
  it("NL 通道：回复不匹配 → 重问消息 + run.end{hitl_pending}，不跑 codex/不报错", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const req = baseReq({
      events: [
        { type: "user.message", content: "do it" },
        { type: "toolcall.start", toolCallId: "tc-r", toolName: "request_confirmation" },
        { type: "toolcall.end", toolCallId: "tc-r", args: { reason: "ok?" } },
        { type: "toolcall.suspend", toolCallId: "tc-r", toolName: "request_confirmation", reason: "model_request",
          prompt: "是否继续？", options: [
            { optionId: "approve", label: "ok", kind: "allow_once", matchWords: ["是", "好的"] },
            { optionId: "reject", label: "no", kind: "reject_once", matchWords: ["否", "取消"] },
          ] },
        { type: "user.message", content: "我还不太确定欸" },
      ] as never,
    });
    const events = await collect(runner.run(req));
    expect(events.some((e) => e.type === EventType.RunError)).toBe(false);
    expect(events.some((e) => e.type === EventType.MessageDelta)).toBe(true); // 重问提示消息
    const end = events[events.length - 1] as RunloopEvent & { reason?: string };
    expect(end.type).toBe(EventType.RunEnd);
    expect(end.reason).toBe("hitl_pending");
  });

  // NL 通道经 LoopRunner：肯定词命中 → 合成 resolve、注入 toolresult、run 继续（非 reask、非 error）
  it("NL 通道：肯定词命中 → 注入 toolresult 并继续（辅轨 confirmed_by_user）", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const req = baseReq({
      events: [
        { type: "user.message", content: "do it" },
        { type: "toolcall.start", toolCallId: "tc-y", toolName: "request_confirmation" },
        { type: "toolcall.end", toolCallId: "tc-y", args: { reason: "ok?" } },
        { type: "toolcall.suspend", toolCallId: "tc-y", toolName: "request_confirmation", reason: "model_request",
          prompt: "是否继续？", options: [
            { optionId: "approve", label: "ok", kind: "allow_once", matchWords: ["是", "好的"] },
            { optionId: "reject", label: "no", kind: "reject_once", matchWords: ["否", "取消"] },
          ] },
        { type: "user.message", content: "好的。" },
      ] as never,
    });
    const events = await collect(runner.run(req));
    expect(events.some((e) => e.type === EventType.RunError)).toBe(false);
    const trEnd = events.find((e) => e.type === EventType.ToolresultEnd) as RunloopEvent & { result?: { status?: string } };
    expect(trEnd?.result?.status).toBe("confirmed_by_user");
    const end = events[events.length - 1] as RunloopEvent & { reason?: string };
    expect(end.type).toBe(EventType.RunEnd);
    expect(end.reason).not.toBe("hitl_pending"); // 已解决、继续完成
  });
});
