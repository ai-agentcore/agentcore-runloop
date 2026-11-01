import { describe, it, expect, afterEach, vi } from "vitest";
import { resolvePendingHitl } from "@/hitl/resume.js";
import { SidecarServer } from "@/sidecar/server.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { Resource } from "@/types/resources.js";
import type { RunloopEvent } from "@/types/events.js";

const CID = "conv-nl";
const RUN = "run-1";

const realFetch = globalThis.fetch;
function stubUpstreamFetch(responseBody: unknown = { ok: true }, status = 200) {
  const spy = vi.fn((url: string | URL, init?: RequestInit) => {
    if (String(url).includes("127.0.0.1") || String(url).includes("localhost")) return realFetch(url as never, init);
    const text = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    return Promise.resolve(new Response(text, { status }));
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}
afterEach(() => vi.unstubAllGlobals());

function functionCall(toolName: string): Resource {
  return {
    resourceId: `fc-${toolName}`,
    resourceName: toolName,
    resourceType: "FUNCTIONCALL",
    protocol: "openapi",
    openapiConfig: {
      openapi: "3.0.0",
      servers: [{ url: "https://api.x" }],
      paths: { "/p": { post: { operationId: toolName, requestBody: { content: { "application/json": { schema: { type: "object", properties: { database: { type: "string" } } } } } } } } },
    },
    auth: { mode: "none" },
  };
}

function emptyResources(overrides: Partial<NonMcpResources> = {}): NonMcpResources {
  return { tools: [], skills: [], subAgents: [], sandboxes: [], ...overrides };
}
function sidecarWith(resources: NonMcpResources): SidecarServer {
  return new SidecarServer({ resources, conversationId: CID, credentials: { accessKeyId: "ak", accessKeySecret: "sk" } });
}

/** 挂起历史（带 matchWords，模拟 NL 降级通道的 suspend） */
function suspendWithWords(toolCallId: string, toolName: string): RunloopEvent[] {
  return [
    { id: `st-${toolCallId}`, type: "toolcall.start", timestamp: 1, conversationId: CID, toolCallId, toolName } as RunloopEvent,
    { id: `en-${toolCallId}`, type: "toolcall.end", timestamp: 2, conversationId: CID, toolCallId, args: { database: "testdb" } } as RunloopEvent,
    { id: `s-${toolCallId}`, type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId, toolName, args: { database: "testdb" }, reason: "static_rule", prompt: `是否允许执行「${toolName}」？`, options: [
      { optionId: "approve", label: "允许", kind: "allow_once", matchWords: ["是", "可以", "好的"] },
      { optionId: "reject", label: "拒绝", kind: "reject_once", matchWords: ["否", "不要", "取消"] },
    ] } as RunloopEvent,
  ];
}
function userMsg(id: string, content: string, ts: number): RunloopEvent {
  return { id, type: "user.message", timestamp: ts, conversationId: CID, content } as RunloopEvent;
}
function resolveCmd(toolCallId: string, selectedOptionId: string): RunloopEvent {
  return { id: "c1", type: "user.command", timestamp: 99, conversationId: CID, command: "resolve", toolCallId, selectedOptionId } as RunloopEvent;
}

describe("resolvePendingHitl · NL 通道（AD-026 增补）", () => {
  it("肯定词命中 → execute-on-resume 执行真实 op，注入 toolresult，无 reask", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    const sidecar = sidecarWith(emptyResources({ tools: [functionCall("db_drop")] }));
    const history = [...suspendWithWords("tc-1", "function__db_drop__db_drop"), userMsg("u1", "好的。", 4)];

    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    expect(r.reask).toBeFalsy();
    // resume run 自洽：重发 toolcall.start+end（语义上 resume run 才真正执行），再 toolresult.*
    expect(r.events.map((e) => e.type)).toEqual(["toolcall.start", "toolcall.end", "toolresult.start", "toolresult.end"]);
    expect((r.events[3] as RunloopEvent & { isError?: boolean }).isError).toBe(false);
    // 用历史 args 执行（database: testdb）
    expect((spy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ database: "testdb" }));
  });

  it("否定词命中 → denied_by_user", async () => {
    const sidecar = sidecarWith(emptyResources());
    const history = [...suspendWithWords("tc-2", "db_drop"), userMsg("u1", "取消", 4)];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.reask).toBeFalsy();
    const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string } };
    expect(end.isError).toBe(true);
    expect(end.result?.status).toBe("denied_by_user");
  });

  it("回复不匹配且未达上限 → reask（仍挂起、不产 toolresult、发提示消息）", async () => {
    const sidecar = sidecarWith(emptyResources());
    const history = [...suspendWithWords("tc-3", "db_drop"), userMsg("u1", "我不太确定欸", 4)];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    expect(r.reask).toBe(true);
    expect(r.events.some((e) => e.type === "toolresult.end")).toBe(false);
    // 重问会发一条 assistant 提示消息
    expect(r.events.some((e) => e.type === "message.delta")).toBe(true);
    // 该提示消息的 start/delta/end 共享同一个 messageId（reask 不经归一化器，由 buildReaskMessage 本地盖）。
    const msgEvents = r.events.filter((e) => e.type.startsWith("message.")) as Array<{ messageId?: string }>;
    expect(msgEvents).toHaveLength(3);
    const ids = new Set(msgEvents.map((e) => e.messageId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^msg-/);
  });

  it("连续 5 次不匹配 → 主动拒绝并告知原因", async () => {
    const sidecar = sidecarWith(emptyResources());
    const msgs = [1, 2, 3, 4, 5].map((i) => userMsg(`u${i}`, `乱答${i}`, 3 + i));
    const history = [...suspendWithWords("tc-4", "db_drop"), ...msgs];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.reask).toBeFalsy();
    const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string; reason?: string } };
    expect(end.isError).toBe(true);
    expect(end.result?.status).toBe("denied_by_user");
    expect(String(end.result?.reason)).toContain("未匹配");
  });

  it("多 suspend：回复计数按 suspend 区间隔离，针对后一 suspend 的回复不计入前一个（L4）", async () => {
    const sidecar = sidecarWith(emptyResources());
    // S1 后 4 条不匹配回复，再来 S2 + 1 条不匹配回复。S1 的窗口（S1→S2）只含 4 条 < 阈值 5 →
    // 应 reask（仍挂起），而非被「S1 之后全部 5 条」误算成 auto_reject。
    const s1 = suspendWithWords("tc-A", "db_drop");
    const s1Replies = [1, 2, 3, 4].map((i) => userMsg(`a${i}`, `含糊${i}`, 3 + i));
    const s2 = suspendWithWords("tc-B", "db_wipe");
    const s2Reply = [userMsg("b1", "也含糊", 20)];
    const history = [...s1, ...s1Replies, ...s2, ...s2Reply];

    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    // S1 未达上限 → reask；不应产生针对 tc-A 的 denied_by_user。
    expect(r.reask).toBe(true);
    const deniedA = r.events.find(
      (e) => e.type === "toolresult.end"
        && (e as RunloopEvent & { toolCallId?: string }).toolCallId === "tc-A"
        && (e as RunloopEvent & { result?: { status?: string } }).result?.status === "denied_by_user",
    );
    expect(deniedA).toBeUndefined();
  });

  it("结构化 user.command{resolve} 优先于 NL 回复", async () => {
    const sidecar = sidecarWith(emptyResources());
    // NL 回复是肯定词，但结构化 resolve 是 reject → 应以 reject 为准
    const history = [...suspendWithWords("tc-5", "db_drop"), userMsg("u1", "好的", 4), resolveCmd("tc-5", "reject")];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string } };
    expect(end.isError).toBe(true);
    expect(end.result?.status).toBe("denied_by_user");
  });

  it("既无结构化 resolve 也无 NL 回复 → 仍报 unresolved 错误", async () => {
    const sidecar = sidecarWith(emptyResources());
    const history = suspendWithWords("tc-6", "db_drop");
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toContain("unresolved");
  });
});
