import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { buildToolDescriptors, handleToolCall, resolveToolTarget, buildToolIndex, findResolvedTool, buildOutboundNameMap } from "@/mcp/tool-registry.js";
import { __setAgentrunHostCheckForTest } from "@/sidecar/ssrf.js";
import type { NonMcpResources, ToolCallContext } from "@/mcp/types.js";
import type { Resource } from "@/types/resources.js";

/**
 * openapi 工具现在走真实 HTTP（callOpenapiTool → fetch）。stub global.fetch 返回受控 Response，
 * 工具结果文本即 mock 的响应体；同时记录 fetch 被调用的 url/init 供断言。
 * 真实子 agent HTTP（callSubAgent 连本地 mock server）走 127.0.0.1，需放行到原始 fetch。
 */
const realFetch = globalThis.fetch;
function stubOpenapiFetch(responseBody: unknown, status = 200) {
  const spy = vi.fn((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url as never, init);
    const text = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    return Promise.resolve(new Response(text, { status }));
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}
// 委派/子 agent 用例连本地 mock（127.0.0.1）+ agentrun mode；R1 域名白名单会拦 loopback，
// 故管路类用例临时关校验（拦截行为另由 ssrf/sub-agent-caller 专门用例覆盖，不削弱生产）。
beforeEach(() => __setAgentrunHostCheckForTest(false));
afterEach(() => { vi.unstubAllGlobals(); __setAgentrunHostCheckForTest(true); });

const EMPTY: NonMcpResources = {
  tools: [],
  skills: [],
  subAgents: [],
  sandboxes: [],
};

function ctx(resources: NonMcpResources = EMPTY): ToolCallContext {
  return { resources };
}

// ---- fixture helpers（扁平 Resource，openapiConfig 每 operation 一个工具） ----

function openapiTool(
  resourceId: string,
  resourceName: string,
  resourceType: Resource["resourceType"],
  operationId: string,
  opts?: {
    description?: string;
    method?: string;
    path?: string;
    serverUrl?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  },
): Resource {
  const method = opts?.method ?? "post";
  const path = opts?.path ?? "/invoke";
  const schema =
    opts?.properties || opts?.required
      ? {
          type: "object",
          properties: opts?.properties ?? {},
          ...(opts?.required ? { required: opts.required } : {}),
        }
      : undefined;
  return {
    resourceId,
    resourceName,
    resourceType,
    description: opts?.description,
    protocol: "openapi",
    openapiConfig: {
      openapi: "3.0.0",
      servers: [{ url: opts?.serverUrl ?? "https://api.example.com" }],
      paths: {
        [path]: {
          [method]: {
            operationId,
            ...(schema
              ? { requestBody: { content: { "application/json": { schema } } } }
              : {}),
          },
        },
      },
    },
    auth: { mode: "none" },
  };
}

function subAgent(
  resourceId: string,
  resourceName: string,
  opts?: { description?: string; serverUrl?: string; protocol?: Resource["protocol"] },
): Resource {
  return {
    resourceId,
    resourceName,
    resourceType: "AGENT",
    description: opts?.description,
    protocol: opts?.protocol ?? "ag-ui",
    openapiConfig: opts?.serverUrl
      ? {
          openapi: "3.0.0",
          servers: [{ url: opts.serverUrl }],
          paths: { "/invoke": { post: { operationId: "invoke" } } },
        }
      : undefined,
    auth: { mode: "agentrun" },
  };
}

function skill(resourceId: string, resourceName: string, opts?: { description?: string }): Resource {
  return {
    resourceId,
    resourceName,
    resourceType: "SKILL",
    description: opts?.description,
    protocol: "openapi",
    openapiConfig: {
      openapi: "3.0.0",
      servers: [{ url: "https://acct.agentrun-data.cn-hangzhou.aliyuncs.com" }],
      paths: { [`/skills/${resourceName}/download`]: { get: { operationId: "download" } } },
    },
  };
}

describe("buildToolDescriptors", () => {
  it("returns empty array for empty resources", () => {
    expect(buildToolDescriptors(EMPTY)).toEqual([]);
  });

  it("converts FunctionCall openapi tool", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [
        openapiTool("fc-calc", "calc", "FUNCTIONCALL", "calc", {
          description: "Calculator",
          properties: { expr: { type: "string" } },
        }),
      ],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("function__calc__calc");
    expect(tools[0].description).toBe("Calculator");
    expect(tools[0].inputSchema).toHaveProperty("properties.expr");
  });

  it("converts FunctionCall tool without parameters", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [openapiTool("fc-ping", "ping", "FUNCTIONCALL", "ping")],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools[0].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("converts FunctionCall tool without description (falls back to name)", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [openapiTool("fc-ping", "ping", "FUNCTIONCALL", "ping")],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools[0].description).toContain("ping");
  });

  it("skills are not exposed as model tools", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      skills: [skill("sk-review", "review", { description: "Code review" })],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools).toHaveLength(0);
  });

  it("converts SubAgent to <name>_delegate", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      subAgents: [subAgent("ag-researcher", "researcher", { serverUrl: "http://researcher", description: "Web research agent" })],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("agent__researcher__delegate");
    expect(tools[0].inputSchema.required).toContain("task");
  });

  it("converts KnowledgeBase openapi tool (operationId → tool name)", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [
        openapiTool("kb-docs", "docs", "KNOWLEDGE_BASE", "kb_retrieve_docs", {
          description: "Doc search",
          properties: { query: { type: "string" } },
          required: ["query"],
        }),
      ],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("kb__docs__kb_retrieve_docs");
    expect(tools[0].inputSchema.required).toContain("query");
  });

  it("converts Memory openapi resource with search+add operations", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [
        {
          resourceId: "mem-ctx",
          resourceName: "ctx",
          resourceType: "MEMORY",
          description: "Context memory",
          protocol: "openapi",
          openapiConfig: {
            openapi: "3.0.0",
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/memory/search": { post: { operationId: "memory_search_ctx" } },
              "/memory/add": { post: { operationId: "memory_add_ctx" } },
            },
          },
          auth: { mode: "none" },
        },
      ],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["memory__ctx__memory_add_ctx", "memory__ctx__memory_search_ctx"]);
  });

  it("converts Sandbox to one tool per operation (sanitized operationId)", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      sandboxes: [
        {
          resourceId: "sb-1",
          resourceName: "sb1",
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
        },
      ],
    };
    const tools = buildToolDescriptors(resources);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "sandbox__sb1__sandbox_sb1_exec",
      "sandbox__sb1__sandbox_sb1_read_file",
      "sandbox__sb1__sandbox_sb1_write_file",
    ]);
  });

  it("handles mixed resources", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [openapiTool("fc-1", "fc1", "FUNCTIONCALL", "fc1")],
      skills: [skill("sk-1", "sk1")],
      subAgents: [subAgent("ag-1", "a1", { serverUrl: "http://a1" })],
      sandboxes: [
        {
          resourceId: "sb-1",
          resourceName: "s1",
          resourceType: "SANDBOX",
          protocol: "openapi",
          openapiConfig: {
            openapi: "3.0.0",
            servers: [{ url: "https://api.example.com/sandboxes/s1" }],
            paths: {
              "/contexts/execute": { post: { operationId: "sandbox_s1_exec" } },
              "/files/read": { post: { operationId: "sandbox_s1_read_file" } },
              "/files/write": { post: { operationId: "sandbox_s1_write_file" } },
            },
          },
        },
      ],
    };
    const tools = buildToolDescriptors(resources);
    // 1 functioncall + 0 skill + 1 delegate + 3 sandbox ops = 5
    expect(tools).toHaveLength(5);
  });

  it("registers downstream MCP tools from toolManifest (聚合静态清单)", () => {
    const resources = {
      tools: [], skills: [], subAgents: [], sandboxes: [],
      mcpServers: [
        {
          resourceId: "mcp-1", resourceName: "ds", resourceType: "MCP", protocol: "mcp",
          mcpConfig: { transport: "http", url: "https://h/mcp" },
          toolManifest: [
            { name: "search-code", description: "搜代码", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
            { name: "read_file" },
          ],
        },
      ],
    } as never;
    const tools = buildToolDescriptors(resources);
    const names = tools.map((t) => t.name);
    // 统一前缀 <资源名>_ + 净化名（连字符→下划线）；2 个清单工具
    expect(names).toContain("mcp__ds__search_code");
    expect(names).toContain("mcp__ds__read_file");
    expect(tools.find((t) => t.name === "mcp__ds__search_code")?.description).toBe("搜代码");
  });

  // ---- 严格统一命名：每个工具名 = <资源名>_<动作>，资源名+动作净化后相同才抛错 ----

  it("strict-uniform naming = <resourceName>_<action> for every tool", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      subAgents: [subAgent("ag-1", "alpha", { serverUrl: "http://a" })],
      tools: [openapiTool("fc-1", "fc1", "FUNCTIONCALL", "do_thing")],
    };
    const names = buildToolDescriptors(resources).map((t) => t.name).sort();
    // 委派 = <资源名>_delegate；openapi = <资源名>_<operationId>。名字与是否有别的资源无关、可预测。
    expect(names).toEqual(["agent__alpha__delegate", "function__fc1__do_thing"]);
  });

  it("two same-type resources sharing an operationId stay distinct via resource name", () => {
    // 用户场景：两个 MEMORY 实例用同套标准 OpenAPI（operationId 都叫 memory_search）。
    const mem = (resourceName: string): Resource => ({
      resourceId: `mem-${resourceName}`,
      resourceName,
      resourceType: "MEMORY",
      protocol: "openapi",
      openapiConfig: {
        openapi: "3.0.0",
        servers: [{ url: `https://api.example.com/${resourceName}` }],
        paths: { "/memory/search": { post: { operationId: "memory_search" } } },
      },
      auth: { mode: "none" },
    });
    const resources: NonMcpResources = { ...EMPTY, tools: [mem("proj"), mem("user")] };
    const names = buildToolDescriptors(resources).map((t) => t.name).sort();
    expect(names).toEqual(["memory__proj__memory_search", "memory__user__memory_search"]);
  });

  it("delegate and openapi names never clash because actions differ (_delegate vs operationId)", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      subAgents: [subAgent("ag-1", "x", { serverUrl: "http://a" })],
      tools: [openapiTool("fc-1", "fc1", "FUNCTIONCALL", "delegate_to_x")],
    };
    const names = buildToolDescriptors(resources).map((t) => t.name).sort();
    expect(names).toEqual(["agent__x__delegate", "function__fc1__delegate_to_x"]);
  });

  it("two openapi operations sanitizing to the same name stay distinct via resource name", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [
        openapiTool("fc-1", "fc1", "FUNCTIONCALL", "do-thing"),
        openapiTool("fc-2", "fc2", "FUNCTIONCALL", "do_thing"),
      ],
    };
    const names = buildToolDescriptors(resources).map((t) => t.name).sort();
    expect(names).toEqual(["function__fc1__do_thing", "function__fc2__do_thing"]);
  });

  it("throws when resourceName + action sanitize identically (genuinely indistinguishable)", () => {
    const resources: NonMcpResources = {
      ...EMPTY,
      subAgents: [
        subAgent("ag-1", "my-bot", { serverUrl: "http://a" }),
        subAgent("ag-2", "my_bot", { serverUrl: "http://b" }),
      ],
    };
    expect(() => buildToolDescriptors(resources)).toThrowError(/collision[\s\S]*agent__my_bot__delegate/i);
    // 错误信息点名两个冲突来源
    expect(() => buildToolDescriptors(resources)).toThrowError(/my-bot[\s\S]*my_bot|my_bot[\s\S]*my-bot/);
  });

  it("hash-compresses names that exceed the codex 64-char budget (deterministic, head 保留 type 前缀)", () => {
    const longName = "a".repeat(60);
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [openapiTool("fc-1", longName, "FUNCTIONCALL", "op")],
    };
    const name = buildToolDescriptors(resources)[0].name;
    expect(name.length).toBeLessThanOrEqual(64 - "mcp__agentcore__".length);
    // 统一格式下 `__` 是我们的段分隔符、保留在 head（不再禁止）；压缩只在末尾追加 `_<hash>`（单下划线，hash 无 `__`）。
    expect(name.startsWith("function__")).toBe(true);
    const hash = name.slice(name.lastIndexOf("_") + 1);
    expect(hash).toMatch(/^[a-z0-9]+$/); // base36，确定性、不含 `_`
    // 确定性：同输入同输出
    expect(buildToolDescriptors(resources)[0].name).toBe(name);
  });

  it("外发还原表：压缩名 → 原始 <type>__<name>__<op>（findResolvedTool 两头通）", () => {
    const longName = "a".repeat(60);
    const resources: NonMcpResources = {
      ...EMPTY,
      tools: [openapiTool("fc-1", longName, "FUNCTIONCALL", "op")],
    };
    const [tool] = buildToolIndex(resources);
    expect(tool.rawName).toBe(`function__${longName}__op`); // 原始名（未压缩）
    expect(tool.name).not.toBe(tool.rawName); // 最终名被压缩
    const map = buildOutboundNameMap(resources);
    expect(map.get(tool.name)).toBe(tool.rawName); // 还原表：压缩名→原始名
    // 两头查找：codex 用压缩名、HITL 历史回放用原始名，都能路由到同一工具
    expect(findResolvedTool(resources, tool.name)?.rawName).toBe(tool.rawName);
    expect(findResolvedTool(resources, tool.rawName)?.name).toBe(tool.name);
  });

  it("buildToolIndex 按 resources 对象身份缓存（评审 P2-1：同对象复用、异对象各建）", () => {
    const resources: NonMcpResources = { ...EMPTY, tools: [openapiTool("fc-1", "calc", "FUNCTIONCALL", "op")] };
    const first = buildToolIndex(resources);
    // 同一 resources 对象 → 命中缓存、返回同一数组引用（不重建）。
    expect(buildToolIndex(resources)).toBe(first);
    // 内容相同的另一个对象 → 缓存未命中、各自构建（引用不同、内容等价）。
    const other: NonMcpResources = { ...EMPTY, tools: [openapiTool("fc-1", "calc", "FUNCTIONCALL", "op")] };
    const second = buildToolIndex(other);
    expect(second).not.toBe(first);
    expect(second.map((t) => t.name)).toEqual(first.map((t) => t.name));
  });

  it("routes a tool to the correct resource by its uniform name", async () => {
    const spy = stubOpenapiFetch({ ok: true });
    const mem = (resourceName: string): Resource => ({
      resourceId: `mem-${resourceName}`,
      resourceName,
      resourceType: "MEMORY",
      protocol: "openapi",
      openapiConfig: {
        openapi: "3.0.0",
        servers: [{ url: `https://api.example.com/${resourceName}` }],
        paths: { "/memory/search": { post: { operationId: "memory_search" } } },
      },
      auth: { mode: "none" },
    });
    const resources: NonMcpResources = { ...EMPTY, tools: [mem("proj"), mem("user")] };
    await handleToolCall("memory__user__memory_search", { q: "x" }, ctx(resources));
    // 命中 user 实例的 serverUrl，而非 proj
    expect(String(spy.mock.calls[0][0])).toContain("/user/");
  });
});

describe("handleToolCall", () => {
  const resources: NonMcpResources = {
    ...EMPTY,
    tools: [
      openapiTool("fc-calc", "calc", "FUNCTIONCALL", "calc", {
        description: "Calculator",
        properties: { expr: { type: "string" } },
        method: "post",
        path: "/calc",
      }),
    ],
    skills: [skill("sk-review", "review", { description: "Review" })],
    subAgents: [subAgent("ag-bot", "bot", { serverUrl: "http://bot", description: "Helper bot" })],
    sandboxes: [
      {
        resourceId: "sb-1",
        resourceName: "sb1",
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
      },
    ],
  };

  it("handles FunctionCall tool (real HTTP via callOpenapiTool)", async () => {
    const spy = stubOpenapiFetch({ ok: true, computed: 2 });
    const result = await handleToolCall("function__calc__calc", { expr: "1+1" }, ctx(resources));
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.computed).toBe(2);
    expect(result.isError).toBe(false);
    // 调用到正确的 operation：URL 含 path、method POST、body 含 args
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/calc");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify({ expr: "1+1" }));
  });

  it("handles SubAgent delegation (no credentials -> delegation_request)", async () => {
    // bot has endpoint but ctx() carries no credentials, so it falls through to delegation_request.
    const result = await handleToolCall("agent__bot__delegate", { task: "research" }, ctx(resources));
    const data = JSON.parse(result.content[0].text);
    expect(data.type).toBe("delegation_request");
    expect(data.agent).toBe("bot");
    expect(data.task).toBe("research");
  });

  it("handles sandbox exec (real HTTP via callOpenapiTool)", async () => {
    const spy = stubOpenapiFetch({ stdout: "a\nb" });
    const result = await handleToolCall("sandbox__sb1__sandbox_sb1_exec", { command: "ls" }, ctx(resources));
    const data = JSON.parse(result.content[0].text);
    expect(data.stdout).toBe("a\nb");
    expect(result.isError).toBe(false);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/contexts/execute");
    expect((init as RequestInit).body).toBe(JSON.stringify({ command: "ls" }));
  });

  it("emits full delegation lifecycle (start → end → message.delta* → result) under one id", async () => {
    // 根本修复回归守护：委派层拥有完整语义生命周期，全程共享一个 toolCallId。
    const { port, server } = await new Promise<{ port: number; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hello "}\n\n');
        res.write('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"world"}\n\n');
        res.end();
      });
      s.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as any).port, server: s }));
    });

    const emitted: any[] = [];
    const ctxStream: ToolCallContext = {
      resources: {
        ...EMPTY,
        subAgents: [subAgent("ag-streamer", "streamer", { serverUrl: `http://127.0.0.1:${port}`, protocol: "ag-ui" })],
      },
      credentials: { accessKeyId: "ak", accessKeySecret: "sk", accountId: "123", region: "cn-hangzhou" },
      emit: (e) => emitted.push(e),
      conversationId: "s1",
    };

    const result = await handleToolCall("agent__streamer__delegate", { task: "do it" }, ctxStream);
    server.close();

    // 结果累积正确
    const data = JSON.parse(result.content[0].text);
    expect(data.type).toBe("delegation_result");
    expect(data.result).toBe("hello world");

    // 事件序列：toolcall.start → toolcall.end → message.delta+(with parentToolCallId) → toolresult.end
    const types = emitted.map((e: any) => e.type);
    expect(types[0]).toBe("toolcall.start");
    expect(types[1]).toBe("toolcall.end");
    expect(types[types.length - 1]).toBe("toolresult.end");
    // 子 agent 文本作为 message.delta with parentToolCallId 注入
    const deltas = emitted.filter((e: any) => e.type === "message.delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((e: any) => e.parentToolCallId)).toBe(true);

    // toolcall.start/toolcall.end/toolresult.end 共享同一个 toolCallId
    const tcEvents = emitted.filter((e: any) => e.type.startsWith("toolcall.") || e.type.startsWith("toolresult."));
    const ids = new Set(tcEvents.map((e: any) => e.toolCallId));
    expect(ids.size).toBe(1);
    // message.delta 的 parentToolCallId 指向该 toolCallId
    expect(deltas[0].parentToolCallId).toBe(tcEvents[0].toolCallId);

    // toolcall.end 携带 task 参数，且 toolcall.start 先于首个 message.delta（嵌套文本）
    expect(emitted[1].args).toEqual({ task: "do it" });
    const startIdx = types.indexOf("toolcall.start");
    const firstDeltaIdx = types.indexOf("message.delta");
    expect(startIdx).toBeLessThan(firstDeltaIdx);
  });

  it("delegation failure (sub-agent 404): returned McpToolResult.isError matches the emitted event", async () => {
    // 回归：早期 handleDelegation 经 textResult 返回（不带 isError），导致 `tool result` 日志误报
    // isError:false、codex 把失败当成功，而 toolresult.end 事件却是 isError:true（两者不一致）。
    const { port, server } = await new Promise<{ port: number; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"detail":"Not Found"}');
      });
      s.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as any).port, server: s }));
    });

    const emitted: any[] = [];
    const ctxFail: ToolCallContext = {
      resources: { ...EMPTY, subAgents: [subAgent("ag-x", "searcher", { serverUrl: `http://127.0.0.1:${port}`, protocol: "ag-ui" })] },
      credentials: { accessKeyId: "ak", accessKeySecret: "sk", accountId: "123", region: "cn-hangzhou" },
      emit: (e) => emitted.push(e),
      conversationId: "s1",
    };

    const result = await handleToolCall("agent__searcher__delegate", { task: "find btc" }, ctxFail);
    server.close();

    // 返回的 McpToolResult.isError = true，与 toolresult.end 事件的 isError 一致。
    expect(result.isError).toBe(true);
    const toolresult = emitted.find((e: any) => e.type === "toolresult.end");
    expect(toolresult.isError).toBe(true);
    expect(String(toolresult.result)).toContain("404");
  });

  it("handles sandbox read_file", async () => {
    const spy = stubOpenapiFetch({ content: "file-body" });
    const result = await handleToolCall("sandbox__sb1__sandbox_sb1_read_file", { path: "/tmp/a" }, ctx(resources));
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe("file-body");
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/files/read");
    expect((init as RequestInit).body).toBe(JSON.stringify({ path: "/tmp/a" }));
  });

  it("handles sandbox write_file", async () => {
    const spy = stubOpenapiFetch({ written: true });
    const result = await handleToolCall("sandbox__sb1__sandbox_sb1_write_file", { path: "/tmp/a", content: "hi" }, ctx(resources));
    const data = JSON.parse(result.content[0].text);
    expect(data.written).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/files/write");
    expect((init as RequestInit).body).toBe(JSON.stringify({ path: "/tmp/a", content: "hi" }));
  });

  it("returns error for unknown tool", async () => {
    const result = await handleToolCall("nonexistent", {}, ctx(resources));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("returns error for unknown delegate", async () => {
    const result = await handleToolCall("delegate_to_nobody", {}, ctx(resources));
    expect(result.isError).toBe(true);
  });

  it("returns error for unknown sandbox", async () => {
    const result = await handleToolCall("sandbox_nope_exec", {}, ctx(resources));
    expect(result.isError).toBe(true);
  });

  it("handles KnowledgeBase openapi tool (real HTTP)", async () => {
    const resourcesWithKb: NonMcpResources = {
      ...EMPTY,
      tools: [
        openapiTool("kb-docs", "docs", "KNOWLEDGE_BASE", "kb_retrieve_docs", {
          description: "Doc KB",
          properties: { query: { type: "string" } },
          required: ["query"],
          method: "post",
          path: "/kb/retrieve",
        }),
      ],
    };
    const spy = stubOpenapiFetch({ docs: ["d1", "d2"] });
    const result = await handleToolCall("kb__docs__kb_retrieve_docs", { query: "how" }, ctx(resourcesWithKb));
    const data = JSON.parse(result.content[0].text);
    expect(data.docs).toEqual(["d1", "d2"]);
    expect(result.isError).toBe(false);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/kb/retrieve");
    expect((init as RequestInit).body).toBe(JSON.stringify({ query: "how" }));
  });

  it("handles Memory openapi tools (real HTTP)", async () => {
    const resourcesWithMem: NonMcpResources = {
      ...EMPTY,
      tools: [
        {
          resourceId: "mem-1",
          resourceName: "m1",
          resourceType: "MEMORY",
          protocol: "openapi",
          openapiConfig: {
            openapi: "3.0.0",
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/memory/search": { post: { operationId: "memory_search_m1" } },
              "/memory/add": { post: { operationId: "memory_add_m1" } },
            },
          },
          auth: { mode: "none" },
        },
      ],
    };

    const searchSpy = stubOpenapiFetch({ hits: ["m"] });
    const searchResult = await handleToolCall("memory__m1__memory_search_m1", { query: "what" }, ctx(resourcesWithMem));
    const searchData = JSON.parse(searchResult.content[0].text);
    expect(searchData.hits).toEqual(["m"]);
    let [url, init] = searchSpy.mock.calls[0];
    expect(String(url)).toContain("/memory/search");
    expect((init as RequestInit).body).toBe(JSON.stringify({ query: "what" }));

    const addSpy = stubOpenapiFetch({ added: true });
    const addResult = await handleToolCall("memory__m1__memory_add_m1", { content: "remember this" }, ctx(resourcesWithMem));
    const addData = JSON.parse(addResult.content[0].text);
    expect(addData.added).toBe(true);
    [url, init] = addSpy.mock.calls[0];
    expect(String(url)).toContain("/memory/add");
    expect((init as RequestInit).body).toBe(JSON.stringify({ content: "remember this" }));
  });

  describe("SubAgent with endpoint + credentials (callSubAgent branch)", () => {
    let mockServer: Server | null = null;

    afterEach(() => {
      if (mockServer) {
        mockServer.close();
        mockServer = null;
      }
    });

    it("calls callSubAgent when agent has endpoint and ctx has credentials", async () => {
      const { port, server } = await new Promise<{ port: number; server: Server }>((resolve) => {
        const s = createServer((req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "hello from sub-agent" })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
          res.end();
        });
        s.listen(0, "127.0.0.1", () => {
          const addr = s.address() as { port: number };
          resolve({ port: addr.port, server: s });
        });
      });
      mockServer = server;

      const resourcesWithUrl: NonMcpResources = {
        ...EMPTY,
        subAgents: [subAgent("ag-remote-bot", "remote-bot", { serverUrl: `http://127.0.0.1:${port}`, description: "Remote bot" })],
      };

      const ctxWithCreds: ToolCallContext = {
        resources: resourcesWithUrl,
        credentials: { accessKeyId: "ak", accessKeySecret: "sk", accountId: "123", region: "cn-hangzhou" },
        conversationId: "s1",
      };

      // 严格统一命名 + 净化（连字符→下划线，对齐 codex 不动点）：remote-bot → remote_bot_delegate；
      // 但回包 agent 字段仍是原始 resourceName。
      const result = await handleToolCall("agent__remote_bot__delegate", { task: "test" }, ctxWithCreds);
      const data = JSON.parse(result.content[0].text);
      expect(data.type).toBe("delegation_result");
      expect(data.agent).toBe("remote-bot");
      expect(data.result).toContain("hello from sub-agent");
    });

    it("SANDBOX_TEMPLATE: 懒创建绑定 serverUrl 后再发 openapi 调用", async () => {
      const spy = stubOpenapiFetch({ ok: true });
      // 模板：openapiConfig serverUrl 空，operationId=tpl_exec
      const tmpl = openapiTool("tpl-1", "py", "SANDBOX_TEMPLATE", "tpl_exec", { serverUrl: "", path: "/exec" });
      const ensureServerUrl = vi.fn(async () => "https://inst.example.com");
      const c: ToolCallContext = {
        resources: { ...EMPTY, sandboxes: [tmpl] },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1", region: "cn-hangzhou" },
        sandboxProvisioner: { ensureServerUrl } as never,
      };
      const res = await handleToolCall("sandbox__py__tpl_exec", { code: "print(1)" }, c);
      expect(res.isError).toBe(false);
      expect(ensureServerUrl).toHaveBeenCalledOnce();
      // 调用打到懒创建出的实例 endpoint
      const calledUrl = String(spy.mock.calls.find((c2) => !String(c2[0]).includes("127.0.0.1"))?.[0]);
      expect(calledUrl).toBe("https://inst.example.com/exec");
    });
  });
});

describe("tool-registry — 分支补全", () => {
  const mcpRes = {
    tools: [], skills: [], subAgents: [], sandboxes: [],
    mcpServers: [{ resourceId: "m1", resourceName: "calc", resourceType: "MCP", protocol: "mcp", mcpConfig: { url: "https://h/mcp" }, toolManifest: [{ name: "add" }] }],
  } as unknown as NonMcpResources;

  it("resolveToolTarget：openapi / delegate / mcp / 未知名", () => {
    const r = { tools: [openapiTool("fc1", "fc1", "FUNCTIONCALL", "do_thing")], skills: [], subAgents: [subAgent("ag1", "bot", { serverUrl: "http://bot" })], sandboxes: [] } as NonMcpResources;
    expect(resolveToolTarget("function__fc1__do_thing", r)).toMatch(/^openapi:/);
    expect(resolveToolTarget("agent__bot__delegate", r)).toMatch(/^delegate:/);
    expect(resolveToolTarget("mcp__calc__add", mcpRes)).toBe("mcp:https://h/mcp:add");
    expect(resolveToolTarget("nope", r)).toBe(""); // 未知名 → ""
  });

  it("handleToolCall：execBackend 注入 → bash/file 路由到远端后端", async () => {
    const okR = { content: [{ type: "text" as const, text: "remote" }], isError: false };
    const execBackend = { shell: vi.fn(async () => okR), file: vi.fn(async () => okR) };
    const c = { resources: EMPTY, execBackend } as unknown as ToolCallContext;
    await handleToolCall("bash", { command: "ls" }, c);
    expect(execBackend.shell).toHaveBeenCalledWith("ls");
    await handleToolCall("read_file", { file_path: "/a" }, c);
    expect(execBackend.file).toHaveBeenCalledWith("read_file", { file_path: "/a" });
  });

  it("handleToolCall：get_skill（skill 工具，无 workdir → 回落 description）", async () => {
    const c = { resources: { ...EMPTY, skills: [skill("sk", "rev", { description: "审查" })] } } as ToolCallContext;
    const r = await handleToolCall("get_skill", { name: "rev" }, c);
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain("审查");
  });

  it("handleDelegation：无 task + 无 credentials → delegation_request（task 缺省 \"\"）", async () => {
    const r = { tools: [], skills: [], subAgents: [subAgent("ag1", "bot", { description: "B" })], sandboxes: [] } as NonMcpResources; // 无 serverUrl → 无 endpoint
    const res = await handleToolCall("agent__bot__delegate", {}, ctx(r)); // 无 task
    expect(JSON.parse(res.content[0].text)).toMatchObject({ type: "delegation_request", task: "" });
  });
});
