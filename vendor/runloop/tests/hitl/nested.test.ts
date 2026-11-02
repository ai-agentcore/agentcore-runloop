import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { translateChildEvent } from "@/sidecar/event-translator.js";
import { resolvePendingHitl, type ForwardNestedInput } from "@/hitl/resume.js";
import { SidecarServer } from "@/sidecar/server.js";
import { handleToolCall, toolNameFor } from "@/mcp/tool-registry.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { RunloopEvent } from "@/types/events.js";

const CID = "parent-conv";

describe("nested HITL — up-propagation (translateChildEvent)", () => {
  it("runloop child toolcall.suspend propagates up with parentToolCallId", () => {
    const out = translateChildEvent(
      { type: "toolcall.suspend", toolCallId: "child-tc", toolName: "db_drop", reason: "static_rule", options: [{ optionId: "a", label: "x", kind: "allow_once" }], conversationId: "child", id: "s", timestamp: 1 },
      "runloop",
      { conversationId: CID, parentToolCallId: "deleg-1" },
    );
    expect(out[0].type).toBe("toolcall.suspend");
    expect((out[0] as { parentToolCallId?: string }).parentToolCallId).toBe("deleg-1");
    expect(out[0].conversationId).toBe(CID);
  });

  it("ag-ui INTERRUPT → toolcall.suspend (fixes silent-drop bug)", () => {
    const out = translateChildEvent(
      { type: "INTERRUPT", value: { toolCallId: "c-1", toolName: "rm", options: [{ optionId: "a", label: "ok", kind: "allow_once" }] } },
      "ag-ui",
      { conversationId: CID, parentToolCallId: "deleg-2" },
    );
    expect(out[0].type).toBe("toolcall.suspend");
    expect((out[0] as { parentToolCallId?: string; reason?: string }).parentToolCallId).toBe("deleg-2");
    expect((out[0] as { reason?: string }).reason).toBe("model_request");
  });

  it("ag-ui CUSTOM runloop.hitl_request → suspend; unrelated CUSTOM → dropped", () => {
    const hitl = translateChildEvent(
      { type: "CUSTOM", name: "runloop.hitl_request", value: { toolCallId: "c-2", toolName: "t" } },
      "ag-ui", { conversationId: CID, parentToolCallId: "d" },
    );
    expect(hitl[0].type).toBe("toolcall.suspend");
    const other = translateChildEvent({ type: "CUSTOM", name: "runloop.usage", value: {} }, "ag-ui", { conversationId: CID, parentToolCallId: "d" });
    expect(other).toEqual([]);
  });
});

describe("nested HITL — down-routing invariant (resolvePendingHitl)", () => {
  // delegation d-1 (agent__child__delegate) suspended a child toolcall tc-x
  const nestedHistory = (): RunloopEvent[] => [
    { id: "e1", type: "toolcall.start", timestamp: 1, conversationId: CID, toolCallId: "d-1", toolName: "agent__child__delegate" } as RunloopEvent,
    { id: "e2", type: "toolcall.end", timestamp: 2, conversationId: CID, toolCallId: "d-1", args: { task: "do" } } as RunloopEvent,
    { id: "ec", type: "message.delta", timestamp: 3, conversationId: CID, parentToolCallId: "d-1", content: "child thinking" } as RunloopEvent,
    { id: "s1", type: "toolcall.suspend", timestamp: 4, conversationId: CID, parentToolCallId: "d-1", toolCallId: "tc-x", toolName: "db_drop", reason: "static_rule", options: [{ optionId: "ok", label: "allow", kind: "allow_once" }] } as RunloopEvent,
    { id: "c1", type: "user.command", timestamp: 5, conversationId: CID, command: "resolve", toolCallId: "tc-x", selectedOptionId: "ok" } as RunloopEvent,
  ];

  it("forwards to child via forwardNested; never parent-executes (invariant); injects delegation toolresult", async () => {
    const calls: ForwardNestedInput[] = [];
    // sidecar stub whose executeTool MUST NOT be called for a nested suspend
    const executeTool = vi.fn();
    const fakeSidecar = { executeTool } as unknown as SidecarServer;

    const r = await resolvePendingHitl(nestedHistory(), {
      conversationId: CID, runId: "run-1", sidecar: fakeSidecar,
      forwardNested: async (input) => { calls.push(input); return { nestedResult: { ok: true }, delegationResult: "child final answer" }; },
    });

    expect(r.error).toBeUndefined();
    // invariant: parent did NOT execute the child op
    expect(executeTool).not.toHaveBeenCalled();
    // forwarded down the delegation chain with the right delegation + sub-history
    expect(calls).toHaveLength(1);
    expect(calls[0].delegationToolName).toBe("agent__child__delegate");
    expect(calls[0].suspendToolCallId).toBe("tc-x");
    expect(calls[0].childHistory.some((e) => e.id === "ec")).toBe(true); // child-frame slice
    expect(calls[0].delegationTask).toBe("do"); // 原始委派任务透传下去（无状态子 agent 重建完整 messages 用）
    // delegation toolresult reuses the delegation toolCallId, carrying the child's final output
    const delegationResult = r.events.find((e) => e.type === "toolresult.end" && (e as { toolCallId?: string }).toolCallId === "d-1") as RunloopEvent & { result?: unknown };
    expect(delegationResult?.result).toBe("child final answer");
  });

  it("without a forwarder, still respects invariant (injects forwarded markers, no execution)", async () => {
    const r = await resolvePendingHitl(nestedHistory(), { conversationId: CID, runId: "run-1", sidecar: null });
    expect(r.error).toBeUndefined();
    const delegationResult = r.events.find((e) => e.type === "toolresult.end" && (e as { toolCallId?: string }).toolCallId === "d-1") as RunloopEvent & { result?: { status?: string } };
    expect(delegationResult?.result?.status).toBe("forwarded_to_child");
  });

  // P3（多轮嵌套）：子 agent resume 后又抛出新 suspend → 附新子 suspend、不产委派 toolresult、以 hitl_pending 收尾。
  it("多轮嵌套：forwardNested 报 reSuspended → 透传新子 suspend、跳过委派 toolresult、reask", async () => {
    const newChildSuspend = {
      id: "s2", type: "toolcall.suspend", timestamp: 9, conversationId: CID, parentToolCallId: "d-1",
      toolCallId: "tc-y", toolName: "db_drop", reason: "static_rule", options: [{ optionId: "ok", label: "allow", kind: "allow_once" }],
    } as RunloopEvent;
    const r = await resolvePendingHitl(nestedHistory(), {
      conversationId: CID, runId: "run-1", sidecar: null,
      forwardNested: async () => ({ nestedResult: { status: "resolved_by_child" }, reSuspended: true, childEvents: [newChildSuspend] }),
    });
    expect(r.error).toBeUndefined();
    expect(r.reask, "子再次挂起 → 父以 hitl_pending 收尾").toBe(true);
    // round-1 的 tc-x nested toolresult 已产（已转发/解决）
    expect(r.events.some((e) => e.type === "toolresult.end" && (e as { toolCallId?: string }).toolCallId === "tc-x")).toBe(true);
    // 委派未完成 → 不产委派(d-1) toolresult
    expect(r.events.some((e) => e.type === "toolresult.end" && (e as { toolCallId?: string }).toolCallId === "d-1"), "委派未完成不产 d-1 toolresult").toBe(false);
    // 新子 suspend 透传到父流
    expect(r.events.some((e) => e.type === "toolcall.suspend" && (e as { toolCallId?: string }).toolCallId === "tc-y"), "新子 suspend 应透传").toBe(true);
  });

  // P1（G3+G4）：input_required 取值类嵌套 suspend（options 空）——用户 NL 回复**就是值**，
  // 不靠选项匹配（matchReplyToOption 对空 options 必落空 → 当前会 reask）。修复后值进 payload 向下转发。
  it("input_required 嵌套 suspend + NL 回复值 → 向下转发 payload（不靠选项匹配、不 reask）", async () => {
    const calls: ForwardNestedInput[] = [];
    const history: RunloopEvent[] = [
      { id: "e1", type: "toolcall.start", timestamp: 1, conversationId: CID, toolCallId: "d-1", toolName: "agent__child__delegate" } as RunloopEvent,
      { id: "e2", type: "toolcall.end", timestamp: 2, conversationId: CID, toolCallId: "d-1", args: { task: "订票" } } as RunloopEvent,
      {
        id: "s1", type: "toolcall.suspend", timestamp: 3, conversationId: CID, parentToolCallId: "d-1",
        toolCallId: "tc-x", toolName: "a2a_input_required", reason: "model_request", interactionKind: "input_required",
        responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, options: [],
      } as unknown as RunloopEvent,
      { id: "u1", type: "user.message", timestamp: 4, conversationId: CID, content: "北京" } as RunloopEvent,
    ];
    const r = await resolvePendingHitl(history, {
      conversationId: CID, runId: "run-1", sidecar: null,
      forwardNested: async (input) => { calls.push(input); return { nestedResult: { ok: true }, delegationResult: "已订北京" }; },
    });
    expect(r.error).toBeUndefined();
    expect(r.reask, "取值类不该 reask").toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].payload, "NL 值按 responseSchema 单属性名进 payload").toMatchObject({ value: "北京" });
  });
});

describe("nested HITL — delegation barrier (tool-registry)", () => {
  let server: Server | null = null;
   // 委派连本地 mock；R1 拦截另由专门用例覆盖
  afterEach(() => { server?.close(); server = null;  });

  it("child suspend → delegation produces no toolresult + fires onSuspend (barrier)", async () => {
    // mock child runloop server streams a toolcall.suspend then ends
    const { port } = await new Promise<{ port: number }>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "toolcall.suspend", toolCallId: "child-tc", toolName: "db_drop", reason: "static_rule", options: [{ optionId: "a", label: "x", kind: "allow_once" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "run.end", reason: "hitl_pending" })}\n\n`);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => resolve({ port: (server!.address() as { port: number }).port }));
    });

    const resources: NonMcpResources = {
      tools: [], skills: [], sandboxes: [],
      subAgents: [{
        resourceId: "a", resourceName: "child", resourceType: "AGENT", protocol: "runloop",
        openapiConfig: {
          openapi: "3.0.0",
          servers: [{ url: `http://127.0.0.1:${port}` }],
          paths: { "/invoke": { post: { operationId: "invoke" } } },
        },
        auth: { mode: "none" },
      }],
    };
    const emitted: RunloopEvent[] = [];
    let suspended = false;
    // 严格统一命名（AD-027）：AGENT resourceName=child → 委派工具名 agent__child__delegate
    const result = await handleToolCall("agent__child__delegate", { task: "do" }, {
      resources,
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      conversationId: CID,
      emit: (e) => emitted.push(e),
      onSuspend: () => { suspended = true; },
    });

    expect(suspended).toBe(true);
    expect(result.content[0].text).toContain("delegation_pending");
    // the child suspend propagated up with parentToolCallId = delegation id; no delegation toolresult emitted
    expect(emitted.some((e) => e.type === "toolcall.suspend")).toBe(true);
    expect(emitted.some((e) => e.type === "toolresult.end")).toBe(false);
  });
});

describe("nested HITL — sidecar.forwardNestedResolution (runloop child resume)", () => {
  it("returns forwarded_no_child when delegation agent not found", async () => {
    const sidecar = new SidecarServer({
      resources: { tools: [], skills: [], subAgents: [], sandboxes: [] },
      conversationId: CID,
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    });
    const r = await sidecar.forwardNestedResolution({ delegationToolName: "agent__missing__delegate", childHistory: [], suspendToolCallId: "tc-x", selectedOptionId: "ok" });
    expect(r.isError).toBe(true);
    expect((r.delegationResult as { status?: string }).status).toBe("forwarded_no_child");
  });

  // 回归（真实部署 e2e 抓到）：长 agent 名触发哈希压缩时，历史里的委派工具名是**还原后的原始名**（rawName），
  // 而工具索引的 t.name 是压缩名——forwardNestedResolution 若按 t.name 严格匹配会落空 → 误判 forwarded_no_child
  // （本地短名不压缩故掩盖）。修复：用 findResolvedTool（两头通，匹配 name | rawName）。
  it("resolves a long (hash-compressed) delegation name via rawName (no forwarded_no_child)", async () => {

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "message.delta", content: "CHILD_DONE_TOKEN" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "run.end", reason: "completed" })}\n\n`);
      res.end();
    });
    try {
      const port = await new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
      );

      // 名字足够长，使 agent__<name>__delegate 超过 49 字符上限 → buildToolIndex 哈希压缩。
      const longName = "verylong_subagent_name_for_compression_regression";
      const rawDelegate = `agent__${longName}__delegate`;
      const compressed = toolNameFor("AGENT", longName, "delegate");
      expect(compressed, "前提：该名应被压缩（与原始名不同）").not.toBe(rawDelegate);

      const sidecar = new SidecarServer({
        resources: {
          tools: [], skills: [], sandboxes: [],
          subAgents: [{
            resourceId: "a", resourceName: longName, resourceType: "AGENT", protocol: "runloop",
            openapiConfig: { openapi: "3.0.0", servers: [{ url: `http://127.0.0.1:${port}` }], paths: { "/invoke": { post: { operationId: "invoke" } } } },
            auth: { mode: "none" },
          }],
        },
        conversationId: CID,
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      });

      // 历史里存的是还原后的原始名 rawDelegate（而非压缩名）。
      const r = await sidecar.forwardNestedResolution({ delegationToolName: rawDelegate, childHistory: [], suspendToolCallId: "tc-x", selectedOptionId: "approve" });
      expect((r.delegationResult as { status?: string }).status, "不应误判 forwarded_no_child").not.toBe("forwarded_no_child");
      expect(String(r.delegationResult), "应拿到子 agent 的实际输出（向下转发成功）").toContain("CHILD_DONE_TOKEN");
    } finally {
      server.close();

    }
  });

  // P3 多轮嵌套：子 agent resume 后又抛出新 suspend → forwardNestedResolution 收集子事件 + 标记 reSuspended，
  // 委派未完成（不产 delegationResult）；新子 suspend 带 parentToolCallId=委派 id 透传回父流。
  it("子 agent resume 后又挂起 → reSuspended + 透传新子 suspend（不产 delegationResult）", async () => {

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "toolcall.suspend", toolCallId: "tc-child2", toolName: "db_drop", reason: "static_rule", options: [{ optionId: "ok", label: "allow", kind: "allow_once" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "run.end", reason: "completed" })}\n\n`);
      res.end();
    });
    try {
      const port = await new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
      );
      const sidecar = new SidecarServer({
        resources: { tools: [], skills: [], sandboxes: [], subAgents: [{
          resourceId: "a", resourceName: "child", resourceType: "AGENT", protocol: "runloop",
          openapiConfig: { openapi: "3.0.0", servers: [{ url: `http://127.0.0.1:${port}` }], paths: { "/invoke": { post: { operationId: "invoke" } } } },
          auth: { mode: "none" },
        }] },
        conversationId: CID,
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      });
      const r = await sidecar.forwardNestedResolution({
        delegationToolCallId: "d-1", delegationToolName: "agent__child__delegate",
        childHistory: [], suspendToolCallId: "tc-x", selectedOptionId: "approve",
      });
      expect(r.reSuspended, "子再次挂起 → reSuspended").toBe(true);
      expect(r.delegationResult, "委派未完成 → 不产 delegationResult").toBeUndefined();
      expect(r.childEvents?.some((e) => e.type === "toolcall.suspend" && (e as { toolCallId?: string }).toolCallId === "tc-child2"), "透传新子 suspend").toBe(true);
      expect(r.childEvents?.every((e) => (e as { parentToolCallId?: string }).parentToolCallId === "d-1"), "子事件带 parentToolCallId=委派 id").toBe(true);
    } finally {
      server.close();

    }
  });
});
