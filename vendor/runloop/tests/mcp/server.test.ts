import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { __setSsrfLookupForTest } from "@/sidecar/ssrf.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RunloopMcpServer } from "@/mcp/server.js";
import { FILE_TOOL_DESCRIPTORS } from "@/sidecar/file-tools.js";
import type { NonMcpResources, McpToolResult } from "@/mcp/types.js";
import type { Resource } from "@/types/resources.js";
import type { RunloopEvent } from "@/types/events.js";

const CALC: Resource = {
  resourceId: "fc1",
  resourceName: "calc",
  resourceType: "FUNCTIONCALL",
  description: "Calculator",
  protocol: "openapi",
  openapiConfig: {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/calc": {
        post: {
          operationId: "calc",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { expr: { type: "string" } } } } } },
        },
      },
    },
  },
  auth: { mode: "none" },
};

const REVIEW_SKILL: Resource = {
  resourceId: "sk1",
  resourceName: "review",
  resourceType: "SKILL",
  description: "Code review",
  protocol: "openapi",
  openapiConfig: {
    openapi: "3.0.0",
    servers: [{ url: "https://tools.example.com" }],
    paths: { "/skills/review/download": { get: { operationId: "download" } } },
  },
};

const BOT_AGENT: Resource = {
  resourceId: "ag1",
  resourceName: "bot",
  resourceType: "AGENT",
  description: "Helper",
  protocol: "ag-ui",
  openapiConfig: {
    openapi: "3.0.0",
    servers: [{ url: "https://example.com/bot" }],
    paths: { "/invoke": { post: { operationId: "invoke" } } },
  },
  auth: { mode: "none" },
};

const PY_SANDBOX: Resource = {
  resourceId: "sbx1",
  resourceName: "py-sandbox",
  resourceType: "SANDBOX",
  protocol: "openapi",
  openapiConfig: {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example.com/sandboxes/sb1" }],
    paths: {
      "/contexts/execute": { post: { operationId: "sandbox_sb1_exec" } },
      "/files/read": { post: { operationId: "sandbox_sb1_read_file" } },
      "/files/write": { post: { operationId: "sandbox_sb1_write_file" } },
    },
  },
};

const RESOURCES: NonMcpResources = {
  tools: [CALC],
  skills: [REVIEW_SKILL],
  subAgents: [BOT_AGENT],
  sandboxes: [PY_SANDBOX],
};

const EMPTY: NonMcpResources = {
  tools: [],
  skills: [],
  subAgents: [],
  sandboxes: [],
};

describe("RunloopMcpServer", () => {
  let server: RunloopMcpServer;

  // openapi 工具（mode=none）调用会过 SSRF 守卫做 DNS；注入假解析器返公网 IP，避免依赖真实网络。
  beforeEach(() => __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]));
  afterEach(async () => {
    __setSsrfLookupForTest(null);
    if (server) await server.stop();
  });

  it("starts on a random port and stops cleanly", async () => {
    server = new RunloopMcpServer({ resources: EMPTY });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    expect(server.baseUrl).toBe(`http://127.0.0.1:${port}`);
    await server.stop();
    server = null!;
  });

  it("handles initialize via handleJsonRpc", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.result).toHaveProperty("protocolVersion");
    expect((res.result as any).serverInfo.name).toBe("runloop-mcp");
  });

  it("lists tools via handleJsonRpc", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res.result as any).tools;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("function__calc__calc");
    expect(names).toContain("agent__bot__delegate");
    expect(names).toContain("sandbox__py_sandbox__sandbox_sb1_exec");
    // skill 不暴露为工具：calc(1) + agent__bot__delegate(1) + 3 sandbox ops = 5
    expect(names).not.toContain("review");
    expect(tools.length).toBe(5);
  });

  it("returns empty tools for empty resources", async () => {
    server = new RunloopMcpServer({ resources: EMPTY });
    const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((res.result as any).tools).toEqual([]);
  });

  it("calls a tool via handleJsonRpc (openapi → real HTTP, fetch stubbed)", async () => {
    // openapi 工具走真实 fetch；stub 返回受控响应体，工具结果即该响应体。
    const realFetch = globalThis.fetch;
    const spy = vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).includes("127.0.0.1")) return realFetch(url as never, init);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, expr: "2+2" }), { status: 200 }));
    });
    vi.stubGlobal("fetch", spy as unknown as typeof fetch);
    try {
      server = new RunloopMcpServer({ resources: RESOURCES });
      const res = await server.handleJsonRpc({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "function__calc__calc", arguments: { expr: "2+2" } },
      });
      const data = JSON.parse((res.result as any).content[0].text);
      expect(data.ok).toBe(true);
      expect((res.result as any).isError).toBe(false);
      // 调用到 calc operation，body 含 args
      const [, init] = spy.mock.calls[0];
      expect((init as RequestInit).body).toBe(JSON.stringify({ expr: "2+2" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns error for unknown tool via handleJsonRpc", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    const res = await server.handleJsonRpc({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    expect((res.result as any).isError).toBe(true);
  });

  it("returns method-not-found for unknown method", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "unknown/method" });
    expect(res.error?.code).toBe(-32601);
  });

  it("HTTP POST works with official MCP transport", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(server.baseUrl + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.1" } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("runloop-mcp");
  });

  it("wires emit callback without crash", async () => {
    const emitted: RunloopEvent[] = [];
    server = new RunloopMcpServer({
      resources: RESOURCES,
      conversationId: "s1",
      emit: (event) => emitted.push(event),
    });
    const res = await server.handleJsonRpc({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "agent__bot__delegate", arguments: { task: "hello" } },
    });
    expect(res.result).toBeDefined();
  });

  it("GET /mcp is handled by transport", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(server.baseUrl + "/mcp", { method: "GET" });
    // transport may reject sessionless GET, but the route is handled (not 405)
    expect(res.status).not.toBe(405);
  });

  it("DELETE /mcp is handled by transport", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(server.baseUrl + "/mcp", { method: "DELETE" });
    expect(res.status).not.toBe(405);
  });

  it("rejects an oversized request body (H2 body limit)", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    await server.start();
    const huge = "x".repeat(17 * 1024 * 1024); // > 16MiB 上限
    // readBody 超限 reject + req.destroy()：客户端可能拿到非 2xx，也可能因连接被毁而 fetch 抛错。
    // 两者都表示 body 被拒（未 OOM、未正常处理），均可接受。
    const rejected = await fetch(server.baseUrl + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: huge,
    }).then((r) => !r.ok).catch(() => true);
    expect(rejected).toBe(true);
  });

  it("PUT returns 405 Method Not Allowed", async () => {
    server = new RunloopMcpServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(server.baseUrl + "/mcp", { method: "PUT" });
    expect(res.status).toBe(405);
  });

  // 回归（C2）：经官方 MCP transport（codex 实走的路径，非 handleJsonRpc 捷径）校验工具参数 schema。
  // 早期 registerTools 把所有字段设必填、只分 number/string → read_file 的可选 offset/limit 变必填、
  // grep.ignore_case/edit_file.replace_all 等 boolean 被当 string，官方 transport 校验失败、工具不可用。
  it("official transport advertises optional/boolean params correctly and accepts partial args (C2)", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const executeTool = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }], isError: false };
    };
    server = new RunloopMcpServer({ resources: EMPTY, extraTools: FILE_TOOL_DESCRIPTORS, executeTool });
    await server.start();

    const client = new Client({ name: "c2-test", version: "0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(server.baseUrl + "/mcp"));
    await client.connect(transport);
    try {
      // tools/list：广告的 schema 必须把 offset/limit 标为非必填、ignore_case 为 boolean。
      const { tools } = await client.listTools();
      const readFile = tools.find((t) => t.name === "read_file")!;
      expect(readFile).toBeDefined();
      expect(readFile.inputSchema.required ?? []).toEqual(["file_path"]); // 仅 file_path 必填
      expect((readFile.inputSchema.properties as any).offset?.type).toBe("number");
      const grep = tools.find((t) => t.name === "grep")!;
      expect((grep.inputSchema.properties as any).ignore_case?.type).toBe("boolean");

      // tools/call：只给必填参数（省 offset/limit）不被校验拦截。
      const r1 = await client.callTool({ name: "read_file", arguments: { file_path: "x.ts" } });
      expect(r1.isError ?? false).toBe(false);
      // boolean 参数按 boolean 传，不被当 string 拒绝。
      const r2 = await client.callTool({ name: "grep", arguments: { pattern: "TODO", ignore_case: true } });
      expect(r2.isError ?? false).toBe(false);

      expect(calls.map((c) => c.name)).toEqual(["read_file", "grep"]);
      expect(calls[1].args.ignore_case).toBe(true); // 透到 executeTool 仍是 boolean
    } finally {
      await client.close();
    }
  });
});

describe("RunloopMcpServer — 分支补全", () => {
  let server: RunloopMcpServer;
  afterEach(async () => { vi.unstubAllGlobals(); if (server) await server.stop(); });

  it("handleJsonRpc：无 id → 回 0；tools/call 无 params / 无 arguments", async () => {
    server = new RunloopMcpServer({ resources: EMPTY });
    const noId = await server.handleJsonRpc({ jsonrpc: "2.0", method: "tools/list" });
    expect(noId.id).toBe(0);                                  // request.id ?? 0
    const noParams = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call" });
    expect((noParams.result as McpToolResult).isError).toBe(true); // params ?? {} → name undefined → unknown
    const noArgs = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } });
    expect((noArgs.result as McpToolResult).isError).toBe(true);   // arguments ?? {}
  });

  it("registerTools：array/object 属性 → jsonSchemaPropToZod array/object 分支", async () => {
    const fc: Resource = {
      resourceId: "fc-ao", resourceName: "ao", resourceType: "FUNCTIONCALL", protocol: "openapi", description: "d",
      openapiConfig: { openapi: "3.0.0", servers: [{ url: "https://api.x" }], paths: { "/p": { post: { operationId: "ao",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { arr: { type: "array" }, obj: { type: "object" } }, required: ["arr"] } } } } } } } },
      auth: { mode: "none" },
    };
    server = new RunloopMcpServer({ resources: { ...EMPTY, tools: [fc] } });
    await server.start(); // registerTools 构建 zod，命中 array/object 分支
    const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((res.result as { tools: Array<{ name: string }> }).tools.some((t) => t.name === "function__ao__ao")).toBe(true);
  });

  it("HTTP：非法 JSON body / 未 initialize 的 POST → 400", async () => {
    server = new RunloopMcpServer({ resources: EMPTY });
    await server.start();
    // 非法 JSON（196 catch 分支）+ 未 init（202）→ 400
    const bad = await fetch(server.baseUrl + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    // 合法但非 initialize、无 session → 400（202）
    const noSession = await fetch(server.baseUrl + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(noSession.status).toBe(400);
  });

  // ── 客户端工具（消费通道 2 / tool_pending）──
  describe("client tools（tool_pending）", () => {
    const CT = [{ name: "open_file_picker", description: "Let user pick a file", parameters: { type: "object", properties: { hint: { type: "string" } } } }];

    it("client tool 出现在 tools/list（client__ 前缀名，给模型看）", async () => {
      server = new RunloopMcpServer({ resources: EMPTY, clientTools: CT });
      const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect((res.result as { tools: Array<{ name: string }> }).tools.some((t) => t.name === "client__open_file_picker")).toBe(true);
    });

    it("调用 client tool → 暂停（不执行）：emit toolcall.start/end + onToolPending + 回 tool_pending 哨兵", async () => {
      const emitted: RunloopEvent[] = [];
      const pending: Array<{ toolName: string; toolCallId: string }> = [];
      const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "SHOULD_NOT_RUN" }], isError: false }));
      server = new RunloopMcpServer({
        resources: EMPTY, clientTools: CT, conversationId: "s1",
        emit: (e) => emitted.push(e),
        onToolPending: (info) => pending.push({ toolName: info.toolName, toolCallId: info.toolCallId }),
        executeTool: execute,
      });
      const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "client__open_file_picker", arguments: { hint: "pick a config" } } });
      const result = res.result as McpToolResult;
      // 不执行：execute 未被调用
      expect(execute).not.toHaveBeenCalled();
      // 回 tool_pending 哨兵（含 toolCallId）
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("tool_pending");
      expect(payload.toolCallId).toMatch(/^ct-/);
      expect(result.isError).toBe(false);
      // emit 权威 toolcall.start/end（同一 toolCallId，client 据此渲染并执行）
      const start = emitted.find((e) => e.type === "toolcall.start") as RunloopEvent & { toolCallId?: string; toolName?: string };
      const end = emitted.find((e) => e.type === "toolcall.end") as RunloopEvent & { toolCallId?: string; args?: Record<string, unknown> };
      expect(start?.toolName).toBe("open_file_picker");
      expect(start?.toolCallId).toBe(payload.toolCallId);
      expect(end?.args).toEqual({ hint: "pick a config" });
      // 通知 runner 暂停
      expect(pending).toEqual([{ toolName: "open_file_picker", toolCallId: payload.toolCallId }]);
    });

    // R9（review）：声明名含 sanitize 会改写的字符（`-`/`.`）时，**模型侧**暴露净化名 `client__ask_user_now`，
    // 但**外发事件 + onToolPending** 必须还原成客户端声明的**原始名** `ask-user.now`（客户端按声明名 dispatch）。
    // 旧代码 clientToolDisplay 存的是净化名 → 外发 `ask_user_now`，客户端匹配不到（违反 AD-029 + 自身注释）。
    it("R9: 声明名含 -/. → 暴露净化名给模型，但外发事件/onToolPending 用声明原始名", async () => {
      const emitted: RunloopEvent[] = [];
      const pending: Array<{ toolName: string }> = [];
      const CT2 = [{ name: "ask-user.now", description: "ask", parameters: { type: "object", properties: {} } }];
      server = new RunloopMcpServer({
        resources: EMPTY, clientTools: CT2, conversationId: "s1",
        emit: (e) => emitted.push(e),
        onToolPending: (info) => pending.push({ toolName: info.toolName }),
      });
      // 模型侧仍是净化 + 前缀名
      const list = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect((list.result as { tools: Array<{ name: string }> }).tools.some((t) => t.name === "client__ask_user_now")).toBe(true);
      // 调用净化名 → 外发声明原始名
      await server.handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "client__ask_user_now", arguments: {} } });
      const start = emitted.find((e) => e.type === "toolcall.start") as RunloopEvent & { toolName?: string };
      expect(start?.toolName).toBe("ask-user.now");
      expect(pending).toEqual([{ toolName: "ask-user.now" }]);
    });

    it("非 client tool 不受影响（仍走 execute）", async () => {
      const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "EXECUTED" }], isError: false }));
      server = new RunloopMcpServer({ resources: EMPTY, clientTools: CT, extraTools: [{ name: "real_tool", description: "d", inputSchema: { type: "object", properties: {} } }], executeTool: execute });
      const res = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "real_tool", arguments: {} } });
      expect(execute).toHaveBeenCalledOnce();
      expect((res.result as McpToolResult).content[0].text).toBe("EXECUTED");
    });
  });
});
