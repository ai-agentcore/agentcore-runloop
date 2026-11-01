import { describe, it, expect, afterEach, vi } from "vitest";
import { resolvePendingHitl, derivePolicies, validateHitlResolves } from "@/hitl/resume.js";
import { SidecarServer, REQUEST_CONFIRMATION_TOOL } from "@/sidecar/server.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { Resource } from "@/types/resources.js";
import type { RunloopEvent } from "@/types/events.js";

const CID = "conv-hitl";

/**
 * 主轨 execute-on-resume 现在用历史 args 经 sidecar 代执行真实 openapi 工具（fetch）。
 * stub global.fetch：本地放行，上游返回受控响应体（工具结果即该响应体）。
 */
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
const RUN = "run-1";

/** 扁平 FUNCTIONCALL 资源：openapiConfig 含一个 operationId=工具名 的 operation（echo function_call）。 */
function functionCall(toolName: string): Resource {
  return {
    resourceId: `fc-${toolName}`,
    resourceName: toolName,
    resourceType: "FUNCTIONCALL",
    protocol: "openapi",
    openapiConfig: {
      openapi: "3.0.0",
      servers: [{ url: "https://api.x" }],
      paths: {
        "/p": {
          post: {
            operationId: toolName,
            requestBody: {
              content: { "application/json": { schema: { type: "object", properties: { database: { type: "string" } } } } },
            },
          },
        },
      },
    },
    auth: { mode: "none" },
  };
}

function emptyResources(overrides: Partial<NonMcpResources> = {}): NonMcpResources {
  return {
    tools: [],
    skills: [],
    subAgents: [],
    sandboxes: [],
    ...overrides,
  };
}

function sidecarWith(resources: NonMcpResources): SidecarServer {
  return new SidecarServer({ resources, conversationId: CID, credentials: { accessKeyId: "ak", accessKeySecret: "sk" } });
}

/** 构造一段"挂起的 toolcall"历史 */
function suspendHistory(toolCallId: string, toolName: string, reason = "static_rule"): RunloopEvent[] {
  return [
    { id: "e1", type: "toolcall.start", timestamp: 1, conversationId: CID, toolCallId, toolName } as RunloopEvent,
    { id: "e2", type: "toolcall.end", timestamp: 2, conversationId: CID, toolCallId, args: { database: "testdb" } } as RunloopEvent,
    { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId, toolName, args: { database: "testdb" }, reason, options: [
      { optionId: "approve", label: "允许", kind: "allow_once" },
      { optionId: "reject", label: "拒绝", kind: "reject_once" },
    ] } as RunloopEvent,
  ];
}

function resolveCmd(toolCallId: string, selectedOptionId: string): RunloopEvent {
  return { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId, selectedOptionId } as RunloopEvent;
}

describe("resolvePendingHitl", () => {
  it("no suspends → no events, no error", async () => {
    const r = await resolvePendingHitl([], { conversationId: CID, runId: RUN, sidecar: null });
    expect(r.events).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it("主轨 allow_once → executes op via sidecar, injects toolresult.start + toolresult.end", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    // 严格统一命名（AD-027）：resourceName=db_drop + operationId=db_drop → 工具名 function__db_drop__db_drop
    const resources = emptyResources({ tools: [functionCall("db_drop")] });
    const sidecar = sidecarWith(resources);
    const history = [...suspendHistory("tc-1", "function__db_drop__db_drop"), resolveCmd("tc-1", "approve")];

    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    // resume run 自洽：重发 toolcall.start+end 再 toolresult.*（避免孤儿 toolresult.start）
    expect(r.events.map(e => e.type)).toEqual(["toolcall.start", "toolcall.end", "toolresult.start", "toolresult.end"]);
    const end = r.events[3] as RunloopEvent & { isError?: boolean; result?: unknown };
    expect(end.isError).toBe(false);
    // 真实执行了 openapi 工具（fetch），结果即上游响应体；用历史 args 执行（database: testdb）
    expect(String(end.result)).toContain("dropped");
    expect((spy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ database: "testdb" }));
  });

  it("reject_once → toolresult.end isError=true with denied_by_user", async () => {
    const sidecar = sidecarWith(emptyResources());
    const history = [...suspendHistory("tc-2", "db_drop"), resolveCmd("tc-2", "reject")];

    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    const end = r.events.find(e => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string } };
    expect(end.isError).toBe(true);
    expect(end.result?.status).toBe("denied_by_user");
  });

  it("辅轨 request_confirmation allow → confirmed_by_user, no real op", async () => {
    const sidecar = sidecarWith(emptyResources());
    const history = [...suspendHistory("tc-3", REQUEST_CONFIRMATION_TOOL, "model_request"), resolveCmd("tc-3", "approve")];

    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    const end = r.events.find(e => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string } };
    expect(end.isError).toBe(false);
    expect(end.result?.status).toBe("confirmed_by_user");
  });

  // ── ask 原语 request_user_input：确认 / 多选 / 取值 三形态都能 resume（AD-026 增补） ──
  describe("ask 原语 request_user_input resume（确认/多选/取值）", () => {
    const suspendAsk = (
      toolCallId: string,
      extra: Record<string, unknown>,
    ): RunloopEvent =>
      ({ id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId, toolName: "request_user_input", reason: "model_request", ...extra } as RunloopEvent);

    it("确认（无 schema）：approve option 匹配 → confirmed_by_user + selectedOptionId", async () => {
      const history: RunloopEvent[] = [
        suspendAsk("tc-c", { interactionKind: "confirmation", prompt: "确认？", options: [
          { optionId: "approve", label: "允许", kind: "allow_once", matchWords: ["是"] },
          { optionId: "reject", label: "拒绝", kind: "reject_once", matchWords: ["否"] },
        ] }),
        resolveCmd("tc-c", "approve"),
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
      expect(r.error).toBeUndefined();
      const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string; selectedOptionId?: string } };
      expect(end.isError).toBe(false);
      expect(end.result?.status).toBe("confirmed_by_user");
      expect(end.result?.selectedOptionId).toBe("approve");
    });

    it("多选（enum）：结构化 resolve 选枚举值 → confirmed_by_user，result 带 selectedOptionId（枚举值）", async () => {
      const history: RunloopEvent[] = [
        suspendAsk("tc-ch", {
          responseSchema: { enum: ["回滚", "热修", "灰度"] },
          options: [
            { optionId: "回滚", label: "回滚", kind: "allow_once", matchWords: ["回滚"] },
            { optionId: "热修", label: "热修", kind: "allow_once", matchWords: ["热修"] },
            { optionId: "灰度", label: "灰度", kind: "allow_once", matchWords: ["灰度"] },
          ],
        }),
        resolveCmd("tc-ch", "热修"),
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
      expect(r.error).toBeUndefined();
      const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { result?: { status?: string; selectedOptionId?: string } };
      expect(end.result?.status).toBe("confirmed_by_user");
      expect(end.result?.selectedOptionId).toBe("热修");
    });

    it("多选（enum）：NL 回复枚举值 → 按 matchWords 命中该 option（不是 input_required）", async () => {
      const history: RunloopEvent[] = [
        suspendAsk("tc-chnl", {
          responseSchema: { enum: ["回滚", "热修", "灰度"] },
          options: [
            { optionId: "回滚", label: "回滚", kind: "allow_once", matchWords: ["回滚"] },
            { optionId: "热修", label: "热修", kind: "allow_once", matchWords: ["热修"] },
            { optionId: "灰度", label: "灰度", kind: "allow_once", matchWords: ["灰度"] },
          ],
        }),
        { id: "m1", type: "user.message", timestamp: 4, conversationId: CID, content: "灰度" } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
      expect(r.error).toBeUndefined();
      expect(r.reask).toBeFalsy();
      const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { result?: { selectedOptionId?: string } };
      expect(end.result?.selectedOptionId).toBe("灰度");
    });

    it("取值（input_required）：结构化 resolve 带 payload（无 selectedOptionId）→ confirmed_by_user + payload", async () => {
      const history: RunloopEvent[] = [
        suspendAsk("tc-in", { interactionKind: "input_required", responseSchema: { type: "string" }, options: [] }),
        { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId: "tc-in", payload: { value: "张三" } } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
      expect(r.error).toBeUndefined();
      const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string; payload?: { value?: string } } };
      expect(end.isError).toBe(false);
      expect(end.result?.status).toBe("confirmed_by_user");
      expect(end.result?.payload?.value).toBe("张三");
    });

    it("取值（input_required）：NL 回复就是值 → 按 responseSchema 单属性名进 payload", async () => {
      const history: RunloopEvent[] = [
        suspendAsk("tc-innl", {
          interactionKind: "input_required",
          responseSchema: { type: "object", properties: { email: { type: "string" } } },
          options: [],
        }),
        { id: "m1", type: "user.message", timestamp: 4, conversationId: CID, content: "a@b.com" } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
      expect(r.error).toBeUndefined();
      const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { result?: { payload?: Record<string, string> } };
      expect(end.result?.payload?.email).toBe("a@b.com");
    });
  });

  it("unresolved suspend (no resolve) → HITL_UNRESOLVED error (no-partial-resume)", async () => {
    const r = await resolvePendingHitl(suspendHistory("tc-4", "db_drop"), { conversationId: CID, runId: RUN, sidecar: null });
    expect(r.error).toBeTruthy();
    expect(r.error).toContain("tc-4");
  });

  it("invalid selectedOptionId → error", async () => {
    const history = [...suspendHistory("tc-5", "db_drop"), resolveCmd("tc-5", "nonexistent")];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
    expect(r.error).toContain("invalid selectedOptionId");
  });

  it("idempotent: suspend already has a toolresult → skipped (replay safe)", async () => {
    const history: RunloopEvent[] = [
      ...suspendHistory("tc-6", "db_drop"),
      resolveCmd("tc-6", "approve"),
      { id: "tr1", type: "toolresult.end", timestamp: 5, conversationId: CID, toolCallId: "tc-6", result: "done", isError: false } as RunloopEvent,
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
    expect(r.error).toBeUndefined();
    expect(r.events).toEqual([]);
  });

  it("toolCallId 复用：旧 suspend 已解决，不应让复用同名 toolCallId 的新 suspend 被误判已解决 (H5/AD-026 #5)", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    const sidecar = sidecarWith(emptyResources({ tools: [functionCall("db_drop")] }));
    const ev = (id: string, type: string, extra: Record<string, unknown>, ts: number): RunloopEvent =>
      ({ id, type, timestamp: ts, conversationId: CID, ...extra } as RunloopEvent);
    const opts = [{ optionId: "approve", label: "x", kind: "allow_once" }, { optionId: "reject", label: "y", kind: "reject_once" }];
    const history: RunloopEvent[] = [
      // S1（tc-1）已完整解决：start/end/suspend(s-old)/resolve(→s-old)/toolresult(tc-1)
      ev("a1", "toolcall.start", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop" }, 1),
      ev("a2", "toolcall.end", { toolCallId: "tc-1", args: { database: "old" } }, 2),
      ev("s-old", "toolcall.suspend", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop", args: { database: "old" }, reason: "static_rule", options: opts }, 3),
      ev("c-old", "user.command", { command: "resolve", targetEventId: "s-old", selectedOptionId: "approve" }, 4),
      ev("tr-old", "toolresult.end", { toolCallId: "tc-1", result: "old dropped", isError: false }, 5),
      // S2 复用 tc-1，新 suspend(s-new) + 其 resolve，尚未解决
      ev("b1", "toolcall.start", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop" }, 6),
      ev("b2", "toolcall.end", { toolCallId: "tc-1", args: { database: "new" } }, 7),
      ev("s-new", "toolcall.suspend", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop", args: { database: "new" }, reason: "static_rule", options: opts }, 8),
      ev("c-new", "user.command", { command: "resolve", targetEventId: "s-new", selectedOptionId: "approve" }, 9),
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    // S2 必须被执行（产出恰好一条 toolresult.end），且用 S2 自己的 args（database:new）。
    expect(r.events.filter((e) => e.type === "toolresult.end").length).toBe(1);
    expect((spy.mock.calls.at(-1)![1] as RequestInit).body).toBe(JSON.stringify({ database: "new" }));
  });

  // R8（review）：toolCallId 跨 run 复用、且 resolve **同时带 toolCallId + targetEventId**（客户端冗余带两者是合法的）。
  // 旧 ③/④ 与主循环匹配都 toolCallId 优先 → 绑到「最后一个」suspend / 双重匹配 → 误报 precedes 或 conflicting。
  // 必须按全局唯一 targetEventId 绑定（AD-026 #5），toolCallId 仅在 targetEventId 缺省时兜底。
  it("R8: toolCallId 复用 + resolve 同时带 toolCallId/targetEventId → validateHitlResolves 不误报 precedes", () => {
    const ev = (id: string, type: string, extra: Record<string, unknown>, ts: number): RunloopEvent =>
      ({ id, type, timestamp: ts, conversationId: CID, ...extra } as RunloopEvent);
    const opts = [{ optionId: "approve", label: "x", kind: "allow_once" }, { optionId: "reject", label: "y", kind: "reject_once" }];
    const history: RunloopEvent[] = [
      ev("a1", "toolcall.start", { toolCallId: "tc-1", toolName: "db_drop" }, 1),
      ev("a2", "toolcall.end", { toolCallId: "tc-1", args: { database: "old" } }, 2),
      ev("s-old", "toolcall.suspend", { toolCallId: "tc-1", toolName: "db_drop", options: opts }, 3),
      ev("c-old", "user.command", { command: "resolve", toolCallId: "tc-1", targetEventId: "s-old", selectedOptionId: "approve" }, 4),
      ev("tr-old", "toolresult.end", { toolCallId: "tc-1", result: "old dropped", isError: false }, 5),
      ev("b1", "toolcall.start", { toolCallId: "tc-1", toolName: "db_drop" }, 6),
      ev("b2", "toolcall.end", { toolCallId: "tc-1", args: { database: "new" } }, 7),
      ev("s-new", "toolcall.suspend", { toolCallId: "tc-1", toolName: "db_drop", options: opts }, 8),
      ev("c-new", "user.command", { command: "resolve", toolCallId: "tc-1", targetEventId: "s-new", selectedOptionId: "approve" }, 9),
    ];
    expect(validateHitlResolves(history)).toBeUndefined();
  });

  it("R8: toolCallId 复用 + resolve 带 toolCallId/targetEventId → resolvePendingHitl 不误拒/不 conflicting，S2 正确执行", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    const sidecar = sidecarWith(emptyResources({ tools: [functionCall("db_drop")] }));
    const ev = (id: string, type: string, extra: Record<string, unknown>, ts: number): RunloopEvent =>
      ({ id, type, timestamp: ts, conversationId: CID, ...extra } as RunloopEvent);
    const opts = [{ optionId: "approve", label: "x", kind: "allow_once" }, { optionId: "reject", label: "y", kind: "reject_once" }];
    const history: RunloopEvent[] = [
      ev("a1", "toolcall.start", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop" }, 1),
      ev("a2", "toolcall.end", { toolCallId: "tc-1", args: { database: "old" } }, 2),
      ev("s-old", "toolcall.suspend", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop", args: { database: "old" }, reason: "static_rule", options: opts }, 3),
      ev("c-old", "user.command", { command: "resolve", toolCallId: "tc-1", targetEventId: "s-old", selectedOptionId: "approve" }, 4),
      ev("tr-old", "toolresult.end", { toolCallId: "tc-1", result: "old dropped", isError: false }, 5),
      ev("b1", "toolcall.start", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop" }, 6),
      ev("b2", "toolcall.end", { toolCallId: "tc-1", args: { database: "new" } }, 7),
      ev("s-new", "toolcall.suspend", { toolCallId: "tc-1", toolName: "function__db_drop__db_drop", args: { database: "new" }, reason: "static_rule", options: opts }, 8),
      ev("c-new", "user.command", { command: "resolve", toolCallId: "tc-1", targetEventId: "s-new", selectedOptionId: "approve" }, 9),
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    expect(r.events.filter((e) => e.type === "toolresult.end").length).toBe(1);
    expect((spy.mock.calls.at(-1)![1] as RequestInit).body).toBe(JSON.stringify({ database: "new" }));
  });

  it("binding 校验：suspend.bindingHash 与当前端点不符 → 拒绝执行（防批A执行B，H5）", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    const sidecar = sidecarWith(emptyResources({ tools: [functionCall("db_drop")] }));
    const history = [...suspendHistory("tc-b1", "function__db_drop__db_drop"), resolveCmd("tc-b1", "approve")];
    // 模拟批准后 resources 端点被改：suspend 携带的是旧端点哈希。
    (history[2] as RunloopEvent & { bindingHash?: string }).bindingHash = "stale-hash-from-endpoint-A";
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string } };
    expect(end.isError).toBe(true);
    expect(end.result?.status).toBe("binding_mismatch");
    expect(spy).not.toHaveBeenCalled(); // 未执行真实 op
  });

  it("binding 校验：bindingHash 匹配当前端点 → 正常执行（H5）", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    const sidecar = sidecarWith(emptyResources({ tools: [functionCall("db_drop")] }));
    const history = [...suspendHistory("tc-b2", "function__db_drop__db_drop"), resolveCmd("tc-b2", "approve")];
    (history[2] as RunloopEvent & { bindingHash?: string }).bindingHash = sidecar.bindingHashFor("function__db_drop__db_drop");
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean };
    expect(end.isError).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it("execute-on-resume 给下游带 x-idempotency-key 头（conversationId:suspendEventId，H5）", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    const sidecar = sidecarWith(emptyResources({ tools: [functionCall("db_drop")] }));
    const history = [...suspendHistory("tc-idem", "function__db_drop__db_drop"), resolveCmd("tc-idem", "approve")];
    await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-idempotency-key"]).toBe(`${CID}:s1`); // suspend id = s1（suspendHistory 固定）
  });

  it("conflicting resolutions for same toolCallId → error", async () => {
    const history = [
      ...suspendHistory("tc-7", "db_drop"),
      resolveCmd("tc-7", "approve"),
      { id: "c2", type: "user.command", timestamp: 5, conversationId: CID, command: "resolve", toolCallId: "tc-7", selectedOptionId: "reject" } as RunloopEvent,
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
    expect(r.error).toContain("conflicting");
  });

  it("allow_once with no sidecar → approved_no_executor isError", async () => {
    const history = [...suspendHistory("tc-8", "db_drop"), resolveCmd("tc-8", "approve")];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
    const end = r.events.find(e => e.type === "toolresult.end") as RunloopEvent & { isError?: boolean; result?: { status?: string } };
    expect(end.isError).toBe(true);
    expect(end.result?.status).toBe("approved_no_executor");
  });

  it("matches resolve by targetEventId when toolCallId absent", async () => {
    const sidecar = sidecarWith(emptyResources());
    const history: RunloopEvent[] = [
      ...suspendHistory("tc-9", "db_drop"),
      { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", targetEventId: "s1", selectedOptionId: "reject" } as RunloopEvent,
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
    expect(r.error).toBeUndefined();
    expect(r.events.find(e => e.type === "toolresult.end")).toBeTruthy();
  });

  // ── 分支补全 ──
  describe("derivePolicies", () => {
    function suspendOpt(id: string, tc: string, name: string, kind: string): RunloopEvent {
      return { id, type: "toolcall.suspend", timestamp: 1, conversationId: CID, toolCallId: tc, toolName: name,
        options: [{ optionId: "o", label: "x", kind }] } as RunloopEvent;
    }
    it("allow_always / reject_always 派生粘性集；无 resolve 跳过；选错 option 不入集", () => {
      const hist: RunloopEvent[] = [
        suspendOpt("s1", "t1", "tool_a", "allow_always"),
        { id: "r1", type: "user.command", timestamp: 2, conversationId: CID, command: "resolve", targetEventId: "s1", selectedOptionId: "o" } as RunloopEvent,
        suspendOpt("s2", "t2", "tool_b", "reject_always"),
        { id: "r2", type: "user.command", timestamp: 3, conversationId: CID, command: "resolve", targetEventId: "s2", selectedOptionId: "o" } as RunloopEvent,
        suspendOpt("s3", "t3", "tool_c", "allow_always"), // 无 resolve → 跳过
        suspendOpt("s4", "t4", "tool_d", "allow_always"),
        { id: "r4", type: "user.command", timestamp: 5, conversationId: CID, command: "resolve", targetEventId: "s4", selectedOptionId: "nope" } as RunloopEvent, // option 不匹配
      ];
      const p = derivePolicies(hist);
      expect([...p.allow]).toEqual(["tool_a"]);
      expect([...p.reject]).toEqual(["tool_b"]);
    });
  });

  // ── #11 畸形 resolve 校验（AD-026）：必须显式拒绝 → run.error，而非误执行/误路由 ──
  describe("畸形 resolve 校验（#11）", () => {
    it("resolve 早于其 suspend → error", async () => {
      const history: RunloopEvent[] = [
        { id: "c1", type: "user.command", timestamp: 1, conversationId: CID, command: "resolve", toolCallId: "tc-x", selectedOptionId: "approve" } as RunloopEvent,
        ...suspendHistory("tc-x", "db_drop"), // suspend(s1) 在 resolve 之后
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
      expect(r.error).toContain("precedes");
    });

    it("resolve 引用不存在的 suspend（toolCallId/targetEventId 都不匹配）→ error", async () => {
      const history: RunloopEvent[] = [
        ...suspendHistory("tc-real", "db_drop"),
        { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId: "tc-ghost", selectedOptionId: "approve" } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
      expect(r.error).toContain("unknown suspend");
    });

    it("重复 event id（两个 HITL 事件同 id）→ error", async () => {
      const history: RunloopEvent[] = [
        ...suspendHistory("tc-a", "db_drop"), // suspend id=s1
        { id: "s1", type: "toolcall.suspend", timestamp: 5, conversationId: CID, toolCallId: "tc-b", toolName: "db_drop", options: [
          { optionId: "approve", label: "允许", kind: "allow_once" }, { optionId: "reject", label: "拒绝", kind: "reject_once" },
        ] } as RunloopEvent, // 复用 id=s1 → 重复
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
      expect(r.error).toContain("duplicate");
    });

    it("同一 toolCallId 出现多个 suspend → error", async () => {
      const history: RunloopEvent[] = [
        ...suspendHistory("tc-dup", "db_drop"), // suspend id=s1, toolCallId=tc-dup
        { id: "s2", type: "toolcall.suspend", timestamp: 6, conversationId: CID, toolCallId: "tc-dup", toolName: "db_drop", options: [
          { optionId: "approve", label: "允许", kind: "allow_once" }, { optionId: "reject", label: "拒绝", kind: "reject_once" },
        ] } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
      expect(r.error).toContain("multiple suspends");
    });

    it("合法历史（resolve 在 suspend 之后、引用正确）→ 不报畸形错", async () => {
      const sidecar = sidecarWith(emptyResources());
      const history = [...suspendHistory("tc-ok", "db_drop"), resolveCmd("tc-ok", "reject")];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
      expect(r.error).toBeUndefined();
    });

    it("suspend.options 内重复 optionId → error", async () => {
      const history: RunloopEvent[] = [
        { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-do", toolName: "db_drop", options: [
          { optionId: "approve", label: "允许", kind: "allow_once" },
          { optionId: "approve", label: "再允许", kind: "allow_always" }, // 重复 optionId
        ] } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
      expect(r.error).toContain("duplicate optionId");
    });

    it("resolve.toolName 与被引用 suspend 不一致 → error", async () => {
      const history: RunloopEvent[] = [
        ...suspendHistory("tc-tn", "db_drop"), // suspend.toolName = db_drop
        { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId: "tc-tn", selectedOptionId: "approve", toolName: "send_email" } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
      expect(r.error).toContain("toolName");
    });

    it("resolve.parentToolCallId 与被引用 suspend 不一致（嵌套层级错配）→ error", async () => {
      const history: RunloopEvent[] = [
        // 顶层 suspend（无 parentToolCallId），resolve 却声称 parent=d-1
        ...suspendHistory("tc-pp", "db_drop"),
        { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId: "tc-pp", selectedOptionId: "approve", parentToolCallId: "d-1" } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: null });
      expect(r.error).toContain("parentToolCallId");
    });

    it("resolve 带正确 toolName/parentToolCallId（缺省/一致）→ 不报错", async () => {
      const sidecar = sidecarWith(emptyResources());
      const history: RunloopEvent[] = [
        ...suspendHistory("tc-okc", "db_drop"),
        { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId: "tc-okc", selectedOptionId: "reject", toolName: "db_drop" } as RunloopEvent,
      ];
      const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar });
      expect(r.error).toBeUndefined();
    });
  });

  it("NL 通道：未匹配回复 → reask（产提示消息、不产 toolresult）", async () => {
    const history: RunloopEvent[] = [
      { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-nl", toolName: "db_drop",
        prompt: "确认删库？", options: [
          { optionId: "approve", label: "允许", kind: "allow_once", matchWords: ["允许", "yes"] },
          { optionId: "reject", label: "拒绝", kind: "reject_once", matchWords: ["拒绝", "no"] },
        ] } as RunloopEvent,
      { id: "m1", type: "user.message", timestamp: 4, conversationId: CID, role: "user", content: "blah blah" } as RunloopEvent,
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
    expect(r.reask).toBe(true);
    expect(r.events.some(e => e.type === "message.delta" || e.type === "message.start")).toBe(true);
    expect(r.events.some(e => e.type === "toolresult.end")).toBe(false);
  });

  it("NL 通道：达上限 → auto_reject（无 reject 选项时回落 'reject'）", async () => {
    const replies = Array.from({ length: 5 }, (_, i) => (
      { id: `m${i}`, type: "user.message", timestamp: 10 + i, conversationId: CID, role: "user", content: "nonsense" } as RunloopEvent
    ));
    const history: RunloopEvent[] = [
      { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-nl2", toolName: "db_drop",
        options: [{ optionId: "approve", label: "允许", kind: "allow_once", matchWords: ["允许"] }] } as RunloopEvent, // 无 reject 选项 → rejectOptionId 回落 "reject"
      ...replies,
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
    // optionId 回落 "reject" 在 options 里找不到 → invalid selectedOptionId 错误（覆盖 rejectOptionId ?? 'reject' + 220 分支）
    expect(r.error).toMatch(/invalid selectedOptionId "reject"/);
  });

  it("主轨：历史缺 toolcall.start/end → 名字/参数回落 suspend.toolName/suspend.args", async () => {
    const fakeSidecar = {
      bindingHashFor: () => undefined,
      executeTool: vi.fn(async () => ({ content: [] as Array<{ text: string }>, isError: undefined })),
    } as unknown as SidecarServer;
    const history: RunloopEvent[] = [
      // 仅 suspend + resolve，无 toolcall.start / toolcall.end
      { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-bare", toolName: "db_drop",
        args: { database: "fallback" }, options: [{ optionId: "approve", label: "允许", kind: "allow_once" }] } as RunloopEvent,
      resolveCmd("tc-bare", "approve"),
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: fakeSidecar });
    expect(r.error).toBeUndefined();
    // executeTool 用 suspend.toolName + suspend.args 回落
    expect((fakeSidecar.executeTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("db_drop", { database: "fallback" }, expect.anything());
    // 空 content / undefined isError → result "" / isError false（334/335 分支）
    const tr = r.events.find(e => e.type === "toolresult.end") as { result?: unknown; isError?: boolean };
    expect(tr.result).toBe("");
    expect(tr.isError).toBe(false);
  });

  it("NL reask：回复无 content + 选项无 matchWords + suspend 无 prompt（77/109/110 默认分支）", async () => {
    const history: RunloopEvent[] = [
      { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-x", toolName: "db_drop",
        options: [{ optionId: "approve", label: "允许", kind: "allow_once" }] } as RunloopEvent, // 无 matchWords、无 prompt
      { id: "m1", type: "user.message", timestamp: 4, conversationId: CID, role: "user" } as RunloopEvent, // 无 content
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: sidecarWith(emptyResources()) });
    expect(r.reask).toBe(true);
    const txt = r.events.map(e => (e as { content?: string }).content ?? "").join("");
    expect(txt).toContain("请确认是否继续"); // suspend.prompt ?? 默认
  });

  it("derivePolicies：suspend 无 options（?? [] 分支）", () => {
    const hist: RunloopEvent[] = [
      { id: "s1", type: "toolcall.suspend", timestamp: 1, conversationId: CID, toolCallId: "t1", toolName: "tool_x" } as RunloopEvent, // 无 options
      { id: "r1", type: "user.command", timestamp: 2, conversationId: CID, command: "resolve", targetEventId: "s1", selectedOptionId: "o" } as RunloopEvent,
    ];
    const p = derivePolicies(hist);
    expect(p.allow.size).toBe(0);
    expect(p.reject.size).toBe(0);
  });

  it("toolcall.end 无 args（?? {} 分支，173）", async () => {
    const fakeSidecar = { bindingHashFor: () => undefined, executeTool: vi.fn(async () => ({ content: [{ text: "ok" }], isError: false })) } as unknown as SidecarServer;
    const history: RunloopEvent[] = [
      { id: "e1", type: "toolcall.start", timestamp: 1, conversationId: CID, toolCallId: "tc-na", toolName: "db_drop" } as RunloopEvent,
      { id: "e2", type: "toolcall.end", timestamp: 2, conversationId: CID, toolCallId: "tc-na" } as RunloopEvent, // 无 args
      { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-na", toolName: "db_drop",
        options: [{ optionId: "approve", label: "允许", kind: "allow_once" }] } as RunloopEvent,
      resolveCmd("tc-na", "approve"),
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: RUN, sidecar: fakeSidecar });
    expect(r.error).toBeUndefined();
    expect((fakeSidecar.executeTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("db_drop", {}, expect.anything());
  });
});
