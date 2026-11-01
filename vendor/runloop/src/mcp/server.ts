import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { NonMcpResources, ToolCallContext, McpToolDescriptor, McpToolResult } from "./types.js";
import type { Credentials, ClientTool } from "../types/resources.js";
import { type RunloopEvent, EventType } from "../types/events.js";
import { createEvent } from "../events/factory.js";
import { buildToolDescriptors, handleToolCall, sanitizeToolName, CLIENT_TOOL_PREFIX } from "./tool-registry.js";
import { listDownstreamMcpTools } from "../sidecar/mcp-proxy.js";
import { Logger, type LoggerOptions } from "../util/logger.js";
import { envPositiveInt } from "../util/env.js";

// 启动期下游 MCP 发现的超时（R3）：连/列工具挂住时不无界阻塞 run 启动，超时即跳过该资源（best-effort）。
// 给慢启动的下游留足时间（无 toolManifest 时才走 discovery；有 manifest 则立刻呈现工具、不等发现）。
// ⚠ 注意：无 manifest 且下游慢/挂时，这段等待会拖慢首 token——慢下游优先下发 toolManifest 规避。
// 真正的工具调用不受此限（见 callDownstreamMcpTool，默认无界、env 可加上限）。
const DOWNSTREAM_DISCOVERY_TIMEOUT_MS = envPositiveInt("AGENTCORE_MCP_DISCOVERY_TIMEOUT_MS", 300_000); // 5min

export interface AgentrunMcpServerOptions {
  resources: NonMcpResources;
  credentials?: Credentials;
  emit?: (event: RunloopEvent) => void;
  conversationId?: string;
  headers?: Record<string, string>;
  /**
   * 工具执行入口覆盖。runner 接线时传入 sidecar.gatedExecute，让 codex 经原生 MCP 的调用也过 HITL 主轨闸门。
   * 缺省（如单测）回退到无闸门的 handleToolCall。
   */
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /** 额外暴露的工具（如 HITL 辅轨 ask 原语 request_user_input），与 buildToolDescriptors 合并。 */
  extraTools?: McpToolDescriptor[];
  /**
   * 客户端声明、客户端执行的工具（消费通道 2）。注入到 codex 工具列表里供模型调用，但 runloop **不执行**——
   * 命中即暂停 run（tool_pending），由客户端在下次 run 回传 toolresult.end 续跑（见 onToolPending）。
   */
  clientTools?: ClientTool[];
  /**
   * 客户端工具被调用时的暂停回调（runner 传入 → 置 toolPending + abort codex，本轮以 tool_pending 收尾）。
   * 与 HITL 的 onSuspend 平行：HITL=runloop 代执行需审批；client tool=客户端执行、runloop 只暂停。
   */
  onToolPending?: (info: { toolName: string; args: Record<string, unknown>; toolCallId: string }) => void;
  logger?: LoggerOptions;
}

export class AgentrunMcpServer {
  private server: Server | null = null;
  private _port = 0;
  private readonly resources: NonMcpResources;
  private readonly ctx: ToolCallContext;
  private readonly execute: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  private readonly extraTools: McpToolDescriptor[];
  /** 客户端工具描述符（净化名）+ 名集合（registerTools 据此短路成暂停而非执行）。 */
  private readonly clientToolDescriptors: McpToolDescriptor[];
  private readonly clientToolNames: Set<string>;
  /** 暴露名（`client__<声明名>`）→ 客户端声明的原始名：外发事件还原用。 */
  private readonly clientToolDisplay = new Map<string, string>();
  private readonly onToolPending?: (info: { toolName: string; args: Record<string, unknown>; toolCallId: string }) => void;
  private mcpServer: McpServer;
  private transport: StreamableHTTPServerTransport | null = null;
  private readonly log: Logger;

  constructor(options: AgentrunMcpServerOptions) {
    this.resources = options.resources;
    this.log = new Logger("agentrun", options.logger ?? {});
    this.ctx = {
      resources: options.resources,
      credentials: options.credentials,
      emit: options.emit,
      conversationId: options.conversationId,
      headers: options.headers,
      log: this.log, // 无 executeTool 覆盖（如单测）时，本 ctx 的资源调用也记录请求/响应
    };
    this.extraTools = options.extraTools ?? [];
    // 客户端工具（消费通道 2）：模型侧暴露 `client__<净化声明名>`（AD-029 类型前缀：标明「客户端执行」、
    // 与内置/平台工具防撞名）。但**外发事件**仍用客户端声明的原始名（见 clientToolDisplay）——客户端靠声明名
    // 认出该执行哪个工具，前缀只是内部分类（同「压缩仅内部、外发还原」原则）。codex 的重复卡片由 codex-adapter
    // 按 clientToolNames 抑制，故事件唯一来源是 dispatchToolCall，可直接 emit 声明名。
    this.clientToolDescriptors = (options.clientTools ?? []).map((ct) => {
      const exposed = `${CLIENT_TOOL_PREFIX}${sanitizeToolName(ct.name)}`;
      // 外发还原映射的 value 必须是客户端**声明的原始名**（ct.name），非净化名——客户端按声明名 dispatch，
      // 声明名含 `-`/`.` 时净化名（ask_user_now）与声明名（ask-user.now）不同，存净化名会让客户端匹配不到（R9）。
      this.clientToolDisplay.set(exposed, ct.name);
      return {
        name: exposed,
        description:
          ct.description ??
          `Client-side tool "${ct.name}". Calling it pauses the run; the client executes it and returns the result.`,
        inputSchema: (ct.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
      };
    });
    this.clientToolNames = new Set(this.clientToolDescriptors.map((d) => d.name));
    this.onToolPending = options.onToolPending;
    // 统一执行入口：有 executeTool（runner 传 sidecar.gatedExecute，含 HITL 主轨）则用之，否则裸 handleToolCall。
    this.execute = options.executeTool ?? ((name, args) => handleToolCall(name, args, this.ctx));

    this.mcpServer = new McpServer(
      { name: "agentrun-mcp", version: "0.1.0" },
      // 声明 resources/prompts 能力（即便为空）：否则 SDK 不允许注册 resources/list 等处理器，
      // 且 codex 探这些方法会拿到 -32601。声明后我们返回空列表，codex 干净地知道"无资源可探"。
      { capabilities: { resources: {}, prompts: {} } },
    );

    // 工具注册移到 start()：需先对「无 toolManifest 的下游 MCP」做运行时 tools/list 发现，再建表。
    // codex 启动后会无条件探 resources/list、resources/templates/list、prompts/list；不实现会返 -32601，
    // 让模型误以为该 MCP server 有"资源"可探（它跑去调 list_mcp_resources 而非真正的工具）。注册空列表消除死路。
    this.registerEmptyListHandlers();
  }

  private registerEmptyListHandlers(): void {
    const s = this.mcpServer.server;
    s.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    s.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
    s.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  }

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  private toolDescriptors(): McpToolDescriptor[] {
    return [...buildToolDescriptors(this.resources), ...this.extraTools, ...this.clientToolDescriptors];
  }

  /** Return exact wire names so the adapter can suppress duplicate CLI cards. */
  enableToolEvents(): Set<string> {
    this.ctx.emitToolLifecycle = true;
    return new Set(this.toolDescriptors().map(tool => tool.name));
  }

  /**
   * 工具调用单一分发入口（registerTools 回调 + handleJsonRpc 共用，避免两条路径行为漂移）。
   * 客户端工具（消费通道 2）：runloop 不执行——发权威 toolcall.start/end（客户端据此拿 toolCallId+args 渲染并执行）、
   * 触发暂停（onToolPending → run 以 tool_pending 收尾）、给 codex 回 pending 哨兵。结果由客户端下次 run 以
   * toolresult.end 回传，compressEvents 自动折进 transcript（无 execute-on-resume）。其它工具走统一 execute（含 HITL 主轨）。
   */
  private async dispatchToolCall(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.log.info("tool call", { toolName, args });
    if (this.clientToolNames.has(toolName)) {
      const toolCallId = `ct-${nanoid()}`;
      // 外发还原：事件用客户端声明的原始名（去 `client__` 前缀），客户端据此认出并执行；前缀只是模型侧分类。
      const displayName = this.clientToolDisplay.get(toolName) ?? toolName;
      if (this.ctx.emit && this.ctx.conversationId) {
        this.ctx.emit(createEvent(EventType.ToolcallStart, this.ctx.conversationId, { toolCallId, toolName: displayName }));
        this.ctx.emit(createEvent(EventType.ToolcallEnd, this.ctx.conversationId, { toolCallId, args }));
      }
      this.onToolPending?.({ toolName: displayName, args, toolCallId });
      this.log.info("client tool pending", { toolName: displayName, toolCallId });
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "tool_pending", toolCallId, message: "awaiting client-side tool execution" }) }],
        isError: false,
      };
    }
    const result = await this.execute(toolName, args);
    this.log.info("tool result", {
      toolName,
      isError: result.isError ?? false,
      content: result.content?.[0]?.text?.slice(0, 500),
    });
    return result;
  }

  private registerTools(): void {
    for (const tool of this.toolDescriptors()) {
      const zodShape: Record<string, z.ZodTypeAny> = {};
      const schema = tool.inputSchema as { properties?: Record<string, JsonSchemaProp>; required?: string[] } | undefined;
      const props = schema?.properties;
      const required = new Set(Array.isArray(schema?.required) ? schema!.required : []);
      if (props) {
        for (const [key, val] of Object.entries(props)) {
          // 按 JSON Schema 的 type 生成对应 Zod，并按 required 决定 .optional()。
          // 早期只分 number/string 且全部必填，导致 read_file 的可选 offset/limit 变必填、
          // ignore_case/replace_all 等 boolean 被当 string → 官方 MCP transport 校验失败、工具不可用。
          const zt = jsonSchemaPropToZod(val);
          zodShape[key] = required.has(key) ? zt : zt.optional();
        }
      }

      const toolName = tool.name;
      this.mcpServer.tool(toolName, tool.description, zodShape, async (args) => {
        const result = await this.dispatchToolCall(toolName, args as Record<string, unknown>);
        return { content: result.content, isError: result.isError };
      });
    }
  }

  /**
   * 下游 MCP（protocol=mcp）运行时发现：对**无静态 toolManifest** 的资源，启动时连下游 tools/list 拿真实工具清单
   * 写回 resource.toolManifest（首 token 等下游，契约 AD-027「无清单→启动时连下游发现」）。有 manifest 则跳过
   * （首 token 不等下游）。best-effort——下游连不上只 warn、不阻断（该资源暴露 0 工具，但不拖垮整个 server）。
   */
  private async discoverDownstreamTools(): Promise<void> {
    for (const resource of this.resources.mcpServers ?? []) {
      const manifest = (resource as { toolManifest?: unknown[] }).toolManifest;
      if (Array.isArray(manifest) && manifest.length > 0) continue;
      try {
        const tools = await listDownstreamMcpTools(resource, this.ctx.credentials, { globalHeaders: this.ctx.headers, timeout: DOWNSTREAM_DISCOVERY_TIMEOUT_MS });
        (resource as { toolManifest?: unknown[] }).toolManifest = tools;
        this.log.info("mcp downstream discovered", { resource: resource.resourceName, count: tools.length });
      } catch (err) {
        this.log.warn("mcp downstream discovery failed (non-fatal)", {
          resource: resource.resourceName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async start(): Promise<number> {
    await this.discoverDownstreamTools();
    this.registerTools();
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        try {
          await this.handleHttp(req, res);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "internal server error" }));
          }
        }
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this._port = addr.port;
          this.log.info("mcp server started", { baseUrl: this.baseUrl });
          resolve(this._port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    await this.mcpServer.close();
    this.log.info("mcp server stopping", { port: this._port });
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Streamable HTTP（stateful 会话）：codex 的 rmcp 客户端 initialize 后会开一条 GET SSE 通知流，
   * 需要服务端按 session 维护 transport。stateless（sessionIdGenerator:undefined）下单例 transport
   * 对 GET 标准流返回 500 text/plain → rmcp worker UnexpectedContentType 致命退出、工具不可用。
   * 故按标准模式：首个 initialize POST 懒建 stateful transport（生成 session id），后续 POST/GET/DELETE
   * 携 mcp-session-id 路由到它。codex 单客户端→单 session，一个 transport 足够。
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    this.log.debug("mcp http request", { method: req.method, url: req.url, sessionId });

    if (req.method === "POST") {
      const raw = await readBody(req);
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
      this.log.debug("mcp rpc", { method: (parsed as { method?: string })?.method, sessionId });
      if (!this.transport && isInitializeRequest(parsed)) {
        this.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await this.mcpServer.server.connect(this.transport);
      }
      if (!this.transport) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No active MCP session; send initialize first" }, id: null }));
        return;
      }
      await this.transport.handleRequest(req, res, parsed);
      this.log.debug("mcp http response", { method: req.method, url: req.url, statusCode: res.statusCode, durationMs: Date.now() - started });
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!this.transport) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No active MCP session" }, id: null }));
        return;
      }
      await this.transport.handleRequest(req, res);
      this.log.debug("mcp http response", { method: req.method, url: req.url, statusCode: res.statusCode, durationMs: Date.now() - started });
      return;
    }

    res.writeHead(405);
    res.end();
    this.log.debug("mcp http response", { method: req.method, url: req.url, statusCode: 405, durationMs: Date.now() - started });
  }

  async handleJsonRpc(request: { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> }): Promise<{ jsonrpc: "2.0"; id: string | number; result?: unknown; error?: { code: number; message: string } }> {
    const id = request.id ?? 0;
    this.log.debug("json-rpc request", { method: request.method, id });
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agentrun-mcp", version: "0.1.0" },
          },
        };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: this.toolDescriptors() },
        };
      case "tools/call": {
        const params = request.params ?? {};
        const name = params.name as string;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const toolResult = await this.dispatchToolCall(name, args);
        return { jsonrpc: "2.0", id, result: toolResult };
      }
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  }
}

/** 入站请求体上限（H2）：防超大 body（巨型工具参数等）OOM/CPU DoS。 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body too large (> ${MAX_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

interface JsonSchemaProp {
  type?: string;
  description?: string;
}

/** 把单个 JSON Schema property 映射到对应的 Zod 类型（含 description）。 */
function jsonSchemaPropToZod(val: JsonSchemaProp): z.ZodTypeAny {
  const desc = val.description ?? "";
  let zt: z.ZodTypeAny;
  switch (val.type) {
    case "number":
    case "integer":
      zt = z.number();
      break;
    case "boolean":
      zt = z.boolean();
      break;
    case "array":
      zt = z.array(z.any());
      break;
    case "object":
      zt = z.object({}).passthrough();
      break;
    case "string":
    default:
      zt = z.string();
      break;
  }
  return zt.describe(desc);
}
