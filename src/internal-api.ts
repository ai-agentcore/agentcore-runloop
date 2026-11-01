import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { ModelMessage, ModelParameters } from "alibabacloud-agentcore-sdk/model";
import type { Config } from "./config.js";
import type { Runtime } from "./runtime.js";
import { ARTIFACT_CONVERSATION_HEADER, ARTIFACT_UID_HEADER, PUBLISH_ARTIFACT_TOOL, publishArtifact, withArtifactTool } from "./artifacts.js";
import { SessionWorkspaceError } from "./session-workspace.js";

const RESERVED_MODEL_FIELDS = new Set([
  "messages",
  "model",
  "stream",
  "extra_headers",
  "extra_body",
  "extra_query",
  "base_url",
  "api_key",
  "resource_name",
]);

const THINKING_FIELDS = new Set([
  "enable_thinking",
  "reasoning_effort",
  "thinking_budget",
  "thinking",
  "reasoning",
]);

function bearerMatches(actual: string | undefined, token: string): boolean {
  const supplied = Buffer.from(actual ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelMessageArray(value: unknown): value is ModelMessage[] {
  return Array.isArray(value) && value.every(message => isRecord(message) && typeof message.role === "string");
}

function modelParameters(body: Record<string, unknown>, enableThinking: boolean): ModelParameters {
  const parameters: ModelParameters = {};
  for (const [key, value] of Object.entries(body)) {
    if (RESERVED_MODEL_FIELDS.has(key) || THINKING_FIELDS.has(key)) continue;
    parameters[key] = value;
  }
  parameters.enable_thinking = enableThinking;
  return parameters;
}

function normalizeToolResult(value: unknown): Record<string, unknown> {
  if (isRecord(value) && Array.isArray(value.content)) return value;
  let text: string;
  if (typeof value === "string") text = value;
  else text = JSON.stringify(value) ?? "null";
  return { content: [{ type: "text", text }], isError: false };
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function selectProtocolVersion(requestedVersion: unknown): string {
  const supported = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
  if (typeof requestedVersion === "string" && supported.has(requestedVersion)) {
    return requestedVersion;
  }
  return "2025-03-26";
}

function filesystemCode(error: unknown): string {
  if (error instanceof SessionWorkspaceError) return error.fsCode;
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "";
}

function safeToolFailure(name: string, error: unknown): { code: string; text: string } {
  if (name !== PUBLISH_ARTIFACT_TOOL.name) return { code: "TOOL_EXECUTION_FAILED", text: "AgentCore tool execution failed" };
  const fsCode = filesystemCode(error);
  if (fsCode === "ENOENT") return { code: "SOURCE_NOT_FOUND", text: "Artifact publish failed (SOURCE_NOT_FOUND): source file does not exist" };
  if (fsCode === "EEXIST") return { code: "DESTINATION_EXISTS", text: "Artifact publish failed (DESTINATION_EXISTS): choose a different artifact_path" };
  if (["EACCES", "EPERM", "EROFS"].includes(fsCode)) return { code: "STORAGE_DENIED", text: "Artifact publish failed (STORAGE_DENIED): artifact storage is not writable" };
  if (fsCode === "ENOSPC") return { code: "STORAGE_FULL", text: "Artifact publish failed (STORAGE_FULL): artifact storage has no free space" };
  if (error instanceof SessionWorkspaceError) return { code: "WORKSPACE_UNAVAILABLE", text: "Artifact publish failed (WORKSPACE_UNAVAILABLE): session storage is unavailable" };
  const message = error instanceof Error ? error.message : "";
  if (message === "source_path is required") return { code: "SOURCE_REQUIRED", text: "Artifact publish failed (SOURCE_REQUIRED): source_path is required" };
  if (message.startsWith("source_path ") || message.startsWith("artifact_path ") || message.startsWith("artifact destination ")) {
    return { code: "INVALID_PATH", text: "Artifact publish failed (INVALID_PATH): source_path or artifact_path is invalid" };
  }
  return { code: "ARTIFACT_PUBLISH_FAILED", text: "Artifact publish failed (ARTIFACT_PUBLISH_FAILED)" };
}

export type ArtifactPublisher = (
  uid: string,
  conversationId: string,
  arguments_: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export function createInternalApi(
  config: Config,
  runtime: Runtime,
  token: string,
  options: { artifactPublisher?: ArtifactPublisher } = {},
): Hono {
  const app = new Hono();

  const authorize: MiddlewareHandler = async (context, next) => {
    if (!bearerMatches(context.req.header("Authorization"), token)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
  app.use("/model/*", authorize);
  app.use("/mcp", authorize);

  app.post("/model/v1/chat/completions", async context => {
    const body = await context.req.json().catch(() => null);
    if (!isRecord(body) || !isModelMessageArray(body.messages)) {
      return context.json({ error: "messages must be an array" }, 400);
    }
    if (body.model !== undefined && body.model !== config.modelName) {
      return context.json({ error: "Model is not configured" }, 400);
    }
    for (const key of RESERVED_MODEL_FIELDS) {
      if (key !== "messages" && key !== "model" && key !== "stream" && key in body) {
        return context.json({ error: "Reserved model parameters" }, 400);
      }
    }

    const parameters = modelParameters(body, config.modelEnableThinking);
    if (body.stream !== true) {
      try {
        const result = await runtime.completion(body.messages, parameters, context.req.raw.signal);
        return context.json(result);
      } catch {
        return context.json({ error: "AgentCore model request failed" }, 502);
      }
    }

    const source = runtime.stream(body.messages, parameters, context.req.raw.signal);
    const iterator = source[Symbol.asyncIterator]();
    let first: IteratorResult<Record<string, unknown>>;
    try {
      first = await iterator.next();
    } catch {
      return context.json({ error: "AgentCore model request failed" }, 502);
    }
    if (first.done) return context.json({ error: "AgentCore model returned an empty stream" }, 502);

    return streamSSE(context, async stream => {
      try {
        await stream.writeSSE({ data: JSON.stringify(first.value) });
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          await stream.writeSSE({ data: JSON.stringify(next.value) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } finally {
        await iterator.return?.(undefined);
      }
    });
  });

  app.post("/mcp", async context => {
    const payload = await context.req.json().catch(() => null);
    if (!isRecord(payload) || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
      return rpcError(null, -32600, "Invalid request");
    }
    if (!("id" in payload)) return new Response(null, { status: 202 });

    const id = payload.id;
    const params = payload.params ?? {};
    if (!isRecord(params)) return rpcError(id, -32602, "params must be an object");

    if (payload.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: selectProtocolVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "agentcore-node-runtime", version: "0.2.0" },
      });
    }
    if (payload.method === "ping") return rpcResult(id, {});
    if (payload.method === "tools/list") {
      const manifest = await runtime.manifest();
      return rpcResult(id, { tools: withArtifactTool(manifest.tools, Boolean(config.artifactRoot)) });
    }
    if (payload.method !== "tools/call") return rpcError(id, -32601, "Method not found");

    const name = params.name;
    const arguments_ = params.arguments ?? {};
    if (typeof name !== "string" || !isRecord(arguments_)) {
      return rpcError(id, -32602, "Invalid tool parameters");
    }
    try {
      const uid = context.req.header(ARTIFACT_UID_HEADER) ?? "";
      const conversationId = context.req.header(ARTIFACT_CONVERSATION_HEADER) ?? "";
      let result: unknown;
      if (name === PUBLISH_ARTIFACT_TOOL.name && options.artifactPublisher) {
        result = await options.artifactPublisher(uid, conversationId, arguments_);
      } else if (
        name === PUBLISH_ARTIFACT_TOOL.name
        && config.execution === "local"
        && config.workdir
        && config.artifactRoot
      ) {
        result = await publishArtifact(config.workdir, config.artifactRoot, uid, conversationId, arguments_);
      } else {
        result = await runtime.callTool(name, arguments_);
      }
      return rpcResult(id, normalizeToolResult(result));
    } catch (error) {
      const failure = safeToolFailure(name, error);
      const requestId = context.req.header("X-Request-Id");
      console.warn(JSON.stringify({ event: "mcp_tool_failed", tool: name, code: failure.code,
        ...(requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? { requestId } : {}) }));
      return rpcResult(id, {
        content: [{ type: "text", text: failure.text }],
        isError: true,
      });
    }
  });

  app.get("/mcp", context => context.body(null, 405));
  app.delete("/mcp", context => context.body(null, 200));
  return app;
}
