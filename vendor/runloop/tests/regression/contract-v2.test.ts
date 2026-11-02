import { describe, it, expect } from "vitest";
import { RunRequestSchema } from "@/types/api.js";
import { EventType, ErrorCode } from "@/types/events.js";
import { normalizeInputEvents } from "@/events/normalize.js";
import { RunManager } from "@/loop/run.js";

/**
 * 新契约回归守护（spec v2 重构）：
 * - InputEvent 不再静默剥离字段（事件溯源/HITL/嵌套的运行时前提）
 * - 24 事件 + ErrorCode 枚举
 * - 同 conversationId 并发拒绝前提（L-029）
 * - user.command{resolve} 续接字段保全
 */
describe("contract v2 — InputEvent passthrough (P0)", () => {
  it("preserves history-event fields (toolCallId/result/parentToolCallId) through RunRequest parse", () => {
    const parsed = RunRequestSchema.parse({
      events: [
        { type: "toolresult.end", toolCallId: "tc-1", result: { dropped: 12 }, isError: false, parentToolCallId: "d-1" },
      ],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    });
    const e = parsed.events[0] as Record<string, unknown>;
    expect(e.toolCallId).toBe("tc-1");
    expect(e.result).toEqual({ dropped: 12 });
    expect(e.parentToolCallId).toBe("d-1");
  });

  it("preserves user.command resolve fields (toolCallId/selectedOptionId/audit)", () => {
    const parsed = RunRequestSchema.parse({
      events: [
        { type: "user.command", command: "resolve", toolCallId: "tc-1", selectedOptionId: "approve", actorId: "u1", tenantId: "t1" },
      ],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    });
    const e = parsed.events[0] as Record<string, unknown>;
    expect(e.command).toBe("resolve");
    expect(e.toolCallId).toBe("tc-1");
    expect(e.selectedOptionId).toBe("approve");
    expect(e.actorId).toBe("u1");
  });

  it("preserves user.message metadata + extra fields", () => {
    const parsed = RunRequestSchema.parse({
      events: [{ type: "user.message", content: "hi", metadata: { k: 1 }, extra: "kept" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    });
    const e = parsed.events[0] as Record<string, unknown>;
    expect(e.content).toBe("hi");
    expect(e.extra).toBe("kept");
  });

  it("accepts a storage-neutral, already-materialized attachment without OSS metadata or credentials", () => {
    const parsed = RunRequestSchema.parse({
      events: [{
        type: "user.attachment",
        uri: "/workspace/uploads/up_abc/file.txt",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 12,
      }],
    });
    expect(parsed.events[0]).toMatchObject({
      type: "user.attachment",
      uri: "/workspace/uploads/up_abc/file.txt",
      size: 12,
    });
  });
});

describe("contract v2 — request structure (agent/hitl blocks)", () => {
  it("accepts agent block + hitl block", () => {
    const parsed = RunRequestSchema.parse({
      events: [{ type: "user.message", content: "hi" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      agent: { cli: "codex", maxTurns: 3, timeoutMs: 1000, cwd: "/tmp", env: { A: "1" }, systemPrompt: "x" },
      hitl: { enabled: true, rules: [{ toolPattern: "db_*", action: "ask" }] },
      headers: { "X-Trace": "abc" },
    });
    expect(parsed.agent?.cli).toBe("codex");
    expect(parsed.agent?.maxTurns).toBe(3);
    expect(parsed.hitl?.enabled).toBe(true);
    expect(parsed.headers?.["X-Trace"]).toBe("abc");
  });

  it("accepts unified flat Resource[] (resourceType source axis + protocol call axis)", () => {
    const parsed = RunRequestSchema.parse({
      events: [{ type: "user.message", content: "hi" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      resources: [
        // AGENT 委派：protocol=ag-ui + openapiConfig（入口 operationId=invoke）+ agentrun 签名
        {
          resourceId: "agt-1",
          resourceName: "researcher",
          resourceType: "AGENT",
          protocol: "ag-ui",
          openapiConfig: {
            servers: [{ url: "https://tools.example.com" }],
            paths: { "/invoke": { post: { operationId: "invoke" } } },
          },
          auth: { mode: "none" },
        },
        // FUNCTIONCALL：protocol=openapi + openapiConfig（每 operation 一个工具）+ 不签名
        {
          resourceId: "fc-1",
          resourceName: "getWeather",
          resourceType: "FUNCTIONCALL",
          protocol: "openapi",
          openapiConfig: {
            servers: [{ url: "https://api.weather" }],
            paths: { "/weather": { post: { operationId: "getWeather" } } },
          },
          auth: { mode: "none" },
        },
        // MCP：protocol=mcp + mcpConfig（codex 原生连接）
        {
          resourceId: "mcp-1",
          resourceName: "tools",
          resourceType: "MCP",
          protocol: "mcp",
          mcpConfig: { transport: "http", url: "https://x/mcp" },
        },
      ],
    });
    expect(parsed.resources).toHaveLength(3);
    expect(parsed.resources?.[0].resourceType).toBe("AGENT");
    expect(parsed.resources?.[0].protocol).toBe("ag-ui");
    expect(parsed.resources?.[0].auth?.mode).toBe("none");
    expect(parsed.resources?.[0].openapiConfig).toBeDefined();
    expect(parsed.resources?.[1].protocol).toBe("openapi");
    expect(parsed.resources?.[2].protocol).toBe("mcp");
    expect(parsed.resources?.[2].mcpConfig?.url).toBe("https://x/mcp");
  });

  it("accepts all 8 resourceType source values", () => {
    const types = ["FUNCTIONCALL", "SKILL", "AGENT", "SANDBOX", "SANDBOX_TEMPLATE", "MCP", "KNOWLEDGE_BASE", "MEMORY"] as const;
    const r = RunRequestSchema.safeParse({
      events: [{ type: "user.message", content: "hi" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      resources: types.map((t, i) => ({
        resourceId: `r-${i}`,
        resourceName: `r-${i}`,
        resourceType: t,
        protocol: t === "MCP" ? "mcp" : "openapi",
      })),
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.resources).toHaveLength(8);
  });

  it("rejects an unknown resourceType", () => {
    const r = RunRequestSchema.safeParse({
      events: [{ type: "user.message", content: "hi" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      resources: [{ resourceId: "x", resourceName: "x", resourceType: "BOGUS", protocol: "openapi" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown protocol", () => {
    const r = RunRequestSchema.safeParse({
      events: [{ type: "user.message", content: "hi" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      resources: [{ resourceId: "x", resourceName: "x", resourceType: "FUNCTIONCALL", protocol: "bogus" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("contract v2 — EventType + ErrorCode", () => {
  it("has exactly the 24 target event types and no removed ones", () => {
    const values = Object.values(EventType);
    expect(values).toHaveLength(24);
    for (const removed of ["run.resume", "permission", "hitl.request", "hitl.resolved", "hitl.timeout", "usage", "tool_call.start", "tool_call.error"]) {
      expect(values).not.toContain(removed);
    }
    for (const present of ["toolcall.start", "toolcall.delta", "toolcall.end", "toolcall.suspend", "toolresult.start", "toolresult.delta", "toolresult.end", "run.usage", "reasoning.start", "reasoning.delta", "reasoning.end"]) {
      expect(values).toContain(present);
    }
  });

  it("exposes ErrorCode enum constants", () => {
    expect(ErrorCode.LoopError).toBe("LOOP_ERROR");
    expect(ErrorCode.HitlUnresolved).toBe("HITL_UNRESOLVED");
    expect(ErrorCode.CodexTurnFailed).toBe("CODEX_TURN_FAILED");
  });
});

describe("contract v2 — concurrency (L-029)", () => {
  it("hasRunning reflects running state", () => {
    const mgr = new RunManager();
    const s = mgr.create("conv-x");
    expect(mgr.hasRunning("conv-x")).toBe(false);
    s.status = "running";
    expect(mgr.hasRunning("conv-x")).toBe(true);
    mgr.complete("conv-x");
    expect(mgr.hasRunning("conv-x")).toBe(false);
    expect(mgr.hasRunning("nonexistent")).toBe(false);
  });
});

describe("contract v2 — normalize preserves resolve fields", () => {
  it("normalizeInputEvents keeps user.command resolve toolCallId/selectedOptionId", () => {
    const out = normalizeInputEvents(
      [{ type: EventType.UserCommand, command: "resolve", toolCallId: "tc-1", selectedOptionId: "approve" } as never],
      "conv-1",
    );
    const e = out[0] as Record<string, unknown>;
    expect(e.command).toBe("resolve");
    expect(e.toolCallId).toBe("tc-1");
    expect(e.selectedOptionId).toBe("approve");
    expect(e.conversationId).toBe("conv-1");
  });
});
