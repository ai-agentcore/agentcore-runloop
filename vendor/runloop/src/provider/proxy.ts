import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ProviderConfig, ChatCompletionChunk, ChatCompletionRequest, ChatCompletionMessage } from "./types.js";
import { streamChatCompletions } from "./upstream.js";
import {
  responsesRequestToChatCompletions,
  chatCompletionChunkToResponsesEvents,
  createResponsesState,
  buildToolNameRewriteMap,
  responsesCreatedEvent,
  responsesCompletedEvent,
  responsesErrorEvent,
} from "./translate-responses.js";
import {
  messagesRequestToChatCompletions,
  createClaudeState,
  claudeMessageStart,
  chatCompletionChunkToClaudeEvents,
  claudeFinalize,
  claudeErrorEvent,
} from "./translate-messages.js";
import { RouterPolicy } from "./router.js";
import { Logger, type LoggerOptions } from "../util/logger.js";
import { nanoid } from "nanoid";

export interface ModelProviderProxyOptions {
  config: ProviderConfig;
  /** 可选静态路由策略（alias + fallback）。不传则退化为 config 单上游、行为不变。 */
  router?: RouterPolicy;
  /** 会话级占位 token；不传则自动生成。agent CLI 用它作 API key，proxy 校验入站 Authorization。 */
  sessionToken?: string;
  /**
   * 是否强制校验入站 Authorization（默认 false）。开启后非持 token 的请求 401（HTTP）/拒绝升级（WS）。
   * 生产由 runner 经 AGENTCORE_PROXY_REQUIRE_AUTH 开启；默认关，避免影响 codex WS 握手鉴权（待确认）。
   */
  requireAuth?: boolean;
  logger?: LoggerOptions;
}

export type TextDeltaListener = (content: string) => void;

export class ModelProviderProxy {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private _port: number = 0;
  private config: ProviderConfig;
  private router: RouterPolicy;
  private readonly _sessionToken: string;
  private readonly requireAuth: boolean;
  private log: Logger;
  private textDeltaListeners: TextDeltaListener[] = [];
  private responseHistory = new Map<string, ChatCompletionMessage[]>();

  constructor(options: ModelProviderProxyOptions) {
    this.config = options.config;
    this.router = options.router ?? RouterPolicy.single(options.config);
    this._sessionToken = options.sessionToken ?? nanoid(32);
    this.requireAuth = options.requireAuth ?? false;
    this.log = new Logger("model", options.logger ?? {});
  }

  /** 会话级占位 token：agent CLI 颁发的不可猜随机串；真实上游凭证只在本 proxy 内存里。 */
  get sessionToken(): string {
    return this._sessionToken;
  }

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  /** 校验入站请求的 Authorization/x-api-key 是否匹配 session token（AD-012 凭证隔离边界）。 */
  private isAuthorized(headers: import("node:http").IncomingHttpHeaders): boolean {
    const auth = headers["authorization"];
    const bearer = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : undefined;
    const apiKey = typeof headers["x-api-key"] === "string" ? headers["x-api-key"] : undefined;
    return bearer === this._sessionToken || apiKey === this._sessionToken;
  }

  /** 首选 + fallback 链：逐个尝试上游，首 chunk 前出错则切下一个（audit 旁路日志）。 */
  private async *upstream(model: string | undefined, ccRequest: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<string> {
    const chain = this.router.chain(model);
    for (let i = 0; i < chain.length; i++) {
      signal?.throwIfAborted();
      const cfg = chain[i];
      this.log.model_request({ requestedModel: model ?? cfg.model, upstream: cfg.model, baseUrl: cfg.baseUrl });
      let started = false;
      try {
        for await (const chunk of streamChatCompletions(cfg, { ...ccRequest, model: cfg.model }, signal)) {
          signal?.throwIfAborted();
          started = true;
          yield chunk;
        }
        this.log.model_response({ upstream: cfg.model });
        return;
      } catch (err) {
        if (signal?.aborted) throw err; // Cancellation must never trigger a fallback request.
        const msg = err instanceof Error ? err.message : String(err);
        if (started || i === chain.length - 1) {
          this.log.model_error({ upstream: cfg.model, error: msg });
          throw err;
        }
        this.log.model_fallback({ upstream: cfg.model, error: msg });
      }
    }
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: String(err) } }));
          }
        });
      });

      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws) => {
        this.handleWebSocketResponses(ws);
      });

      this.server.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        this.log.debug(`upgrade request: ${url}`);
        if (this.requireAuth && !this.isAuthorized(req.headers)) {
          this.log.warn(`WS upgrade rejected: unauthorized ${url}`);
          socket.destroy();
          return;
        }
        if (url.endsWith("/responses") && this.wss) {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss!.emit("connection", ws, req);
          });
        } else {
          this.log.debug(`upgrade rejected: ${url}`);
          socket.destroy();
        }
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this._port = addr.port;
          this.log.info(`listening on 127.0.0.1:${this._port}`);
          resolve(this._port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this.responseHistory.clear();
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
      this.wss = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  updateConfig(config: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  onTextDelta(listener: TextDeltaListener): () => void {
    this.textDeltaListeners.push(listener);
    return () => {
      const idx = this.textDeltaListeners.indexOf(listener);
      if (idx >= 0) this.textDeltaListeners.splice(idx, 1);
    };
  }

  private emitTextDelta(content: string): void {
    for (const listener of this.textDeltaListeners) {
      listener(content);
    }
  }

  private async handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    if (req.headers.upgrade) {
      this.log.debug(`skipping request handler for upgrade: ${req.url}`);
      return;
    }
    // 凭证隔离边界：只有持 session token 的 agent CLI 子进程能调本地 proxy，拒绝其它进程乱蹭。
    if (this.requireAuth && !this.isAuthorized(req.headers)) {
      this.log.warn(`401 unauthorized: ${req.url}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unauthorized: invalid or missing session token" } }));
      return;
    }
    const body = await readBody(req);
    const url = req.url ?? "";
    this.log.debug(`HTTP ${req.method} ${url}`);

    if (url.endsWith("/chat/completions")) {
      return this.handleChatCompletions(body, res);
    }

    if (url.endsWith("/responses")) {
      return this.handleResponses(body, res);
    }

    if (url.endsWith("/messages")) {
      return this.handleClaudeMessages(body, res);
    }

    const pathname = url.split("?")[0];
    if (pathname.endsWith("/models") || pathname.match(/\/models\//)) {
      return this.handleModels(res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unknown endpoint: ${url}` } }));
  }

  private async handleChatCompletions(
    body: string,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    const parsed = JSON.parse(body);
    const isStream = parsed.stream !== false;

    this.logRequest("POST /v1/chat/completions", parsed);

    if (!isStream) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Non-streaming not implemented" } }));
      return;
    }

    this.logUpstreamRequest(parsed as ChatCompletionRequest);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const startTime = Date.now();
    try {
      for await (const chunk of this.upstream((parsed as ChatCompletionRequest).model, parsed as ChatCompletionRequest)) {
        this.logUpstreamChunk(chunk, startTime);
        res.write(`data: ${chunk}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      this.logStreamEnd(startTime);
    } catch (err) {
      const errData = JSON.stringify({
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      res.write(`data: ${errData}\n\n`);
    }
    res.end();
  }

  private async handleResponses(
    body: string,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    const parsed = JSON.parse(body);
    const ccRequest = responsesRequestToChatCompletions(parsed);
    const responseId = `resp_${nanoid()}`;
    const suppressTextDelta = isPrewarmRequest(parsed);

    this.logRequest("POST /v1/responses", parsed);
    this.logUpstreamRequest(ccRequest);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    res.write(responsesCreatedEvent(responseId, this.config.model));

    const state = createResponsesState(responseId, buildToolNameRewriteMap(parsed));
    const startTime = Date.now();

    try {
      for await (const chunkStr of this.upstream(ccRequest.model, ccRequest)) {
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(chunkStr);
        } catch {
          continue;
        }

        this.logUpstreamChunk(chunkStr, startTime);
        if (!suppressTextDelta) this.emitChunkTextDelta(chunk);

        const events = chatCompletionChunkToResponsesEvents(chunk, state);
        for (const event of events) {
          res.write(event);
        }
      }

      if (!state.hasStartedMessage) {
        res.write(responsesErrorEvent("No content generated"));
      }
      if (!state.hasCompleted) {
        res.write(responsesCompletedEvent(responseId));
      }
      this.logStreamEnd(startTime);
    } catch (err) {
      res.write(responsesErrorEvent(err instanceof Error ? err.message : String(err)));
    }

    res.end();
  }

  private async handleClaudeMessages(
    body: string,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    const parsed = JSON.parse(body);
    const ccRequest = messagesRequestToChatCompletions(parsed);
    const cfg = this.router.resolve(ccRequest.model);

    this.logRequest("POST /v1/messages", parsed);
    this.logUpstreamRequest(ccRequest);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const state = createClaudeState(`msg_${nanoid()}`, cfg.model);
    res.write(claudeMessageStart(state));

    const startTime = Date.now();
    try {
      for await (const chunkStr of this.upstream(ccRequest.model, ccRequest)) {
        this.logUpstreamChunk(chunkStr, startTime);
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(chunkStr);
        } catch {
          continue;
        }
        if (!isPrewarmRequest(parsed)) this.emitChunkTextDelta(chunk);
        for (const event of chatCompletionChunkToClaudeEvents(chunk, state)) {
          res.write(event);
        }
      }
      for (const event of claudeFinalize(state)) res.write(event);
      this.logStreamEnd(startTime);
    } catch (err) {
      res.write(claudeErrorEvent(err instanceof Error ? err.message : String(err)));
    }

    res.end();
  }

  private handleModels(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    // codex 的 ModelsResponse 期望 models 数组包含 ModelInfo（必填 slug/display_name 等十余个字段），
    // OpenAI-compatible 的 {id, object, owned_by} 格式会导致 serde 反序列化失败。
    // 返回空 models 数组避免解析错误；codex exec 模式通过 -m 指定模型，不依赖 models list。
    const model = {
      id: this.config.model,
      object: "model",
      owned_by: this.config.provider,
    };
    res.end(JSON.stringify({
      object: "list",
      data: [model],
      models: [],
    }));
  }

  private handleWebSocketResponses(ws: WebSocket): void {
    this.log.info(`WebSocket connection established for /v1/responses`);

    const responseHistory = this.responseHistory;
    const requests = new Set<AbortController>();

    const wsSend = (sse: string): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          resolve();
          return;
        }
        const msg = sseToWsMessage(sse);
        this.log.debug(`WS send: ${msg.slice(0, 200)}`);
        ws.send(msg, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    };

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimeout = () => {
      if (idleTimer) clearTimeout(idleTimer);
      // A model waiting for its first token or streaming a long answer is active.
      // The run deadline bounds execution; this timer only reaps idle connections.
      if (requests.size || ws.readyState !== WebSocket.OPEN) return;
      idleTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this.log.info(`WebSocket idle timeout, closing`);
          ws.close(1000);
        }
      }, 30_000);
    };
    resetIdleTimeout();

    ws.on("close", () => {
      if (idleTimer) clearTimeout(idleTimer);
      for (const request of requests) request.abort();
      this.log.debug(`WebSocket closed`);
    });

    ws.on("message", async (data) => {
      const request = new AbortController();
      requests.add(request);
      resetIdleTimeout();
      try {
        const raw = typeof data === "string" ? data : data.toString();
        const parsed = JSON.parse(raw);

        this.logRequest("WS /v1/responses", parsed);

        const ccRequest = responsesRequestToChatCompletions(parsed);
        const responseId = `resp_${nanoid()}`;
        const state = createResponsesState(responseId, buildToolNameRewriteMap(parsed));
        const suppressTextDelta = isPrewarmRequest(parsed);
        const skipUpstream = parsed.generate === false || suppressTextDelta;

        // 如果有 previous_response_id，从历史中恢复之前的 messages
        const prevId = parsed.previous_response_id as string | undefined;
        if (prevId && responseHistory.has(prevId)) {
          const prevMessages = responseHistory.get(prevId)!;
          const systemMsgs = ccRequest.messages.filter(m => m.role === "system");
          const currentMsgs = ccRequest.messages.filter(m => m.role !== "system");
          ccRequest.messages = [...systemMsgs, ...prevMessages, ...currentMsgs];
        }

        await wsSend(responsesCreatedEvent(responseId, this.config.model));

        if (skipUpstream) {
          this.log.info("skip upstream (prewarm/generate=false)");
          await wsSend(responsesCompletedEvent(responseId));
          state.hasCompleted = true;
          responseHistory.set(responseId, []);
          return;
        }

        this.logUpstreamRequest(ccRequest);

        const startTime = Date.now();
        for await (const chunkStr of this.upstream(ccRequest.model, ccRequest, request.signal)) {
          request.signal.throwIfAborted();
          if (ws.readyState !== WebSocket.OPEN) break;
          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(chunkStr);
          } catch {
            continue;
          }

          this.logUpstreamChunk(chunkStr, startTime);
          if (!suppressTextDelta) this.emitChunkTextDelta(chunk);

          const events = chatCompletionChunkToResponsesEvents(chunk, state);
          for (const event of events) {
            await wsSend(event);
          }
        }

        if (request.signal.aborted || ws.readyState !== WebSocket.OPEN) return;

        if (!state.hasStartedMessage) {
          await wsSend(responsesErrorEvent("No content generated"));
        }

        if (!state.hasCompleted) {
          await wsSend(responsesCompletedEvent(responseId));
        }

        // 保存完整对话历史（不含 system）供后续 previous_response_id 使用
        const fullNonSystem = ccRequest.messages.filter(m => m.role !== "system");
        responseHistory.set(responseId, [...fullNonSystem, ...buildAssistantMessage(state)]);

        this.logStreamEnd(startTime);
      } catch (err) {
        if (request.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`WebSocket handler error: ${msg}`);
        try {
          const errEvent = sseToWsMessage(responsesErrorEvent(msg));
          ws.send(errEvent);
        } catch {}
      } finally {
        requests.delete(request);
        resetIdleTimeout();
      }
    });

    ws.on("error", (err) => {
      this.log.error(`WebSocket error: ${err.message}`);
    });
  }

  private logRequest(endpoint: string, body: Record<string, unknown>): void {
    if (!this.log.enabled) return;
    const safe = { ...body };
    if (typeof safe.input === "string" && safe.input.length > 500) {
      safe.input = safe.input.slice(0, 500) + `... (${(safe.input as string).length} chars)`;
    }
    this.log.info(`← ${endpoint}`);
    this.log.debug(`  body: ${JSON.stringify(safe, null, 2)}`);
  }

  private logUpstreamRequest(ccRequest: ChatCompletionRequest): void {
    if (!this.log.enabled) return;
    const safe = { ...ccRequest, messages: ccRequest.messages.map(m => {
      if (typeof m.content === "string" && m.content.length > 500) {
        return { ...m, content: m.content.slice(0, 500) + `... (${m.content.length} chars)` };
      }
      return m;
    })};
    this.log.info(`→ upstream chat/completions model=${this.config.model}`);
    this.log.debug(`  url: ${this.config.baseUrl}`);
    this.log.debug(`  messages: ${JSON.stringify(safe.messages, null, 2)}`);
    if (safe.tools) {
      this.log.debug(`  tools: ${JSON.stringify(safe.tools.map(t => t.function.name))}`);
    }
  }

  private logUpstreamChunk(chunkStr: string, startTime: number): void {
    if (!this.log.enabled) return;
    const elapsed = Date.now() - startTime;
    try {
      const chunk = JSON.parse(chunkStr);
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        this.log.debug(`[${elapsed}ms] δ "${choice.delta.content}"`);
      } else if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id) {
            this.log.debug(`[${elapsed}ms] tool_call: ${tc.function?.name ?? "?"} (${tc.id})`);
          } else if (tc.function?.arguments) {
            this.log.debug(`[${elapsed}ms] tool_args: ${tc.function.arguments}`);
          }
        }
      } else if (choice?.finish_reason) {
        this.log.debug(`[${elapsed}ms] finish: ${choice.finish_reason}`);
      } else if (chunk.usage) {
        this.log.info(`[${elapsed}ms] usage: in=${chunk.usage.prompt_tokens} out=${chunk.usage.completion_tokens}`);
      }
    } catch {}
  }

  private emitChunkTextDelta(chunk: ChatCompletionChunk): void {
    if (this.textDeltaListeners.length === 0) return;
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) {
      this.emitTextDelta(content);
    }
  }

  private logStreamEnd(startTime: number): void {
    const elapsed = Date.now() - startTime;
    this.log.info(`[${elapsed}ms] stream complete`);
  }
}

/**
 * codex 启动时会先发一个 prewarm/init 请求（input 为空数组），用于预热和读取 AGENTS.md。
 * 这个请求产生的模型文本不应注入主 SSE 事件流，否则会和真正的回复拼接在一起污染结果。
 */
function isPrewarmRequest(parsed: unknown): boolean {
  const input = (parsed as { input?: unknown })?.input;
  return Array.isArray(input) && input.length === 0;
}


function sseToWsMessage(sse: string): string {
  for (const line of sse.split("\n")) {
    if (line.startsWith("data: ")) return line.slice(6);
  }
  return "";
}

export function buildAssistantMessage(
  state: import("./translate-responses.js").ResponsesState,
): ChatCompletionMessage[] {
  const msgs: ChatCompletionMessage[] = [];
  const allToolCalls = [...state.completedToolCalls, ...state.toolCalls.values()];
  if (allToolCalls.length > 0) {
    msgs.push({
      role: "assistant",
      content: state.accumulatedText || null,
      tool_calls: allToolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        // namespace 工具回写历史时必须还原扁平名 `{namespace}__{name}`（与 tools[] 一致），否则模型
        // 从历史学到裸名复用 → 回程 toolNameMap 落空 → codex `unsupported call`（见 L-044 round-trip）。
        function: { name: tc.namespace ? `${tc.namespace}__${tc.name}` : tc.name, arguments: tc.args },
      })),
    });
  } else if (state.accumulatedText) {
    msgs.push({ role: "assistant", content: state.accumulatedText });
  }
  return msgs;
}

/** 入站请求体上限（H2）：防超大 body OOM/CPU DoS。 */
const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_PROXY_BODY_BYTES) {
        reject(new Error(`request body too large (> ${MAX_PROXY_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
