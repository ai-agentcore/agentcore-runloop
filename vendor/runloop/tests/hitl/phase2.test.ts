import { describe, it, expect, afterEach, vi } from "vitest";
import { SidecarServer } from "@/sidecar/server.js";
import { StaticLlmJudge } from "@/hitl/judge.js";
import { resolvePendingHitl, derivePolicies } from "@/hitl/resume.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { Resource } from "@/types/resources.js";
import type { RunloopEvent } from "@/types/events.js";

const CID = "conv-p2";

/**
 * openapi 工具现在走真实 HTTP。stub global.fetch：本地（127.0.0.1）放行，上游返回受控响应体。
 * 默认 echo 请求 body（含执行参数），便于断言"用哪份 args 实际执行"（approve_with_changes）。
 */
const realFetch = globalThis.fetch;
function stubUpstreamFetch(responseBody?: unknown, status = 200) {
  const spy = vi.fn((url: string | URL, init?: RequestInit) => {
    if (String(url).includes("127.0.0.1") || String(url).includes("localhost")) return realFetch(url as never, init);
    const text =
      responseBody === undefined
        ? JSON.stringify({ ok: true, echoedBody: (init?.body as string) ?? "" })
        : typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    return Promise.resolve(new Response(text, { status }));
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}
afterEach(() => vi.unstubAllGlobals());

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

function resources(over: Partial<NonMcpResources> = {}): NonMcpResources {
  return { tools: [], skills: [], subAgents: [], sandboxes: [], ...over };
}
async function post(baseUrl: string, name: string, args: unknown = {}) {
  const res = await fetch(`${baseUrl}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, args }) });
  return res.json();
}

describe("HITL Phase 2 — LLM judge track (reason:llm_judge)", () => {
  it("static-allow + judge=ask → suspend with reason llm_judge", async () => {
    const emitted: RunloopEvent[] = [];
    const server = new SidecarServer({
      resources: resources({ tools: [functionCall("do_it")] }),
      conversationId: CID,
      hitl: { enabled: true, rules: [] }, // no static match
      llmJudge: new StaticLlmJudge("ask"),
      emit: (e) => emitted.push(e),
      onSuspend: () => {},
    });
    await server.start();
    try {
      const r = await post(server.baseUrl, "do_it");
      expect(r.content[0].text).toContain("hitl_pending");
      const suspend = emitted.find((e) => e.type === "toolcall.suspend") as RunloopEvent & { reason?: string };
      expect(suspend?.reason).toBe("llm_judge");
    } finally { await server.stop(); }
  });

  it("static-allow + judge=allow → no suspend (executes via real HTTP)", async () => {
    stubUpstreamFetch({ executed: true });
    const server = new SidecarServer({
      resources: resources({ tools: [functionCall("do_it")] }),
      conversationId: CID,
      hitl: { enabled: true, rules: [] },
      llmJudge: new StaticLlmJudge("allow"),
    });
    await server.start();
    try {
      // 严格统一命名（AD-027）：resourceName=do_it + operationId=do_it → 工具名 function__do_it__do_it
      const r = await post(server.baseUrl, "function__do_it__do_it");
      // 放行 → 正常执行 openapi 工具，结果即上游响应体
      expect(JSON.parse(r.content[0].text).executed).toBe(true);
    } finally { await server.stop(); }
  });
});

describe("HITL Phase 2 — sticky grants (allow_always/reject_always)", () => {
  it("grantedAllow bypasses an ask rule (no suspend, executes via real HTTP)", async () => {
    let suspended = false;
    stubUpstreamFetch({ executed: true });
    const server = new SidecarServer({
      resources: resources({ tools: [functionCall("db_drop")] }),
      conversationId: CID,
      hitl: { enabled: true, rules: [{ toolPattern: "function__db_drop*", action: "ask" }] },
      // 严格统一命名（AD-027）：工具名 function__db_drop__db_drop（db_* 前缀仍匹配）
      grantedAllow: new Set(["function__db_drop__db_drop"]),
      onSuspend: () => { suspended = true; },
    });
    await server.start();
    try {
      const r = await post(server.baseUrl, "function__db_drop__db_drop");
      expect(suspended).toBe(false);
      // 粘性放行 → 正常执行 openapi 工具
      expect(JSON.parse(r.content[0].text).executed).toBe(true);
    } finally { await server.stop(); }
  });

  it("grantedReject denies without suspend", async () => {
    let suspended = false;
    const server = new SidecarServer({
      resources: resources(),
      conversationId: CID,
      hitl: { enabled: true, rules: [{ toolPattern: "*", action: "ask" }] },
      grantedReject: new Set(["db_drop"]),
      onSuspend: () => { suspended = true; },
    });
    await server.start();
    try {
      const r = await post(server.baseUrl, "db_drop");
      expect(suspended).toBe(false);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("reject_always");
    } finally { await server.stop(); }
  });

  it("derivePolicies extracts always-grants from resolved history", () => {
    const history: RunloopEvent[] = [
      { id: "s1", type: "toolcall.suspend", timestamp: 1, conversationId: CID, toolCallId: "tc-1", toolName: "db_drop", reason: "static_rule",
        options: [{ optionId: "alw", label: "always", kind: "allow_always" }, { optionId: "rej", label: "no", kind: "reject_once" }] } as RunloopEvent,
      { id: "c1", type: "user.command", timestamp: 2, conversationId: CID, command: "resolve", toolCallId: "tc-1", selectedOptionId: "alw" } as RunloopEvent,
      { id: "s2", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-2", toolName: "rm_all", reason: "static_rule",
        options: [{ optionId: "rejA", label: "never", kind: "reject_always" }] } as RunloopEvent,
      { id: "c2", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId: "tc-2", selectedOptionId: "rejA" } as RunloopEvent,
    ];
    const p = derivePolicies(history);
    expect(p.allow.has("db_drop")).toBe(true);
    expect(p.reject.has("rm_all")).toBe(true);
  });
});

describe("HITL Phase 2 — approve_with_changes (allow_modified)", () => {
  it("executes with user-overridden args from user.command.payload.args", async () => {
    const spy = stubUpstreamFetch(); // echo body
    const sidecar = new SidecarServer({
      resources: resources({ tools: [functionCall("db_drop")] }),
      conversationId: CID,
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    });
    // 严格统一命名（AD-027）：resourceName=db_drop + operationId=db_drop → 工具名 function__db_drop__db_drop
    const history: RunloopEvent[] = [
      { id: "e1", type: "toolcall.start", timestamp: 1, conversationId: CID, toolCallId: "tc-1", toolName: "function__db_drop__db_drop" } as RunloopEvent,
      { id: "e2", type: "toolcall.end", timestamp: 2, conversationId: CID, toolCallId: "tc-1", args: { database: "staging" } } as RunloopEvent,
      { id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, toolCallId: "tc-1", toolName: "function__db_drop__db_drop", args: { database: "staging" }, reason: "static_rule",
        options: [{ optionId: "mod", label: "approve with changes", kind: "allow_modified" }] } as RunloopEvent,
      { id: "c1", type: "user.command", timestamp: 4, conversationId: CID, command: "resolve", toolCallId: "tc-1", selectedOptionId: "mod", payload: { args: { database: "prod" } } } as RunloopEvent,
    ];
    const r = await resolvePendingHitl(history, { conversationId: CID, runId: "run-1", sidecar });
    expect(r.error).toBeUndefined();
    const end = r.events.find((e) => e.type === "toolresult.end") as RunloopEvent & { result?: unknown };
    // 用 user 改写的 args 执行 → fetch body 含 "prod"、不含 "staging"；结果即上游响应体（echo 了该 body）
    expect(String(end.result)).toContain("prod");
    expect(String(end.result)).not.toContain("staging");
    const upstream = spy.mock.calls.find((c) => !String(c[0]).includes("127.0.0.1"))!;
    expect((upstream[1] as RequestInit).body).toBe(JSON.stringify({ database: "prod" }));
  });
});
