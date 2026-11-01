import type { Resource } from "../types/resources.js";

/**
 * openapiConfig 是一份标准 OpenAPI 文档。runloop 从中按 operation 派生工具：
 * 每个 operation = 一个工具，operationId = 工具名（必须存在且唯一），inputSchema 从
 * operation 的 requestBody / parameters 派生。详见 ai-codex runloop-integration.md「openapiConfig」。
 */
export interface OpenapiOperation {
  operationId: string;
  method: string; // get/post/put/patch/delete...
  path: string;
  serverUrl: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

/**
 * 递归内联 `#/components/schemas/*` 的 `$ref` —— 上游下发的是完整标准 OpenAPI 文档（FastAPI 等
 * 生成的 spec 用 `$ref` 引用 components.schemas），若不解析，暴露给模型的 inputSchema 会是一个裸
 * `{$ref:...}`、模型无从知道入参（典型：天气工具首次用空 `{}` 调用就是因为拿不到 `city` 必填项）。
 * 深度上限防环；无法解析的 `$ref` 原样保留（不丢字段）。
 */
function inlineRefs(
  node: unknown,
  components: Record<string, unknown> | undefined,
  depth: number,
): unknown {
  if (depth > 20 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, components, depth + 1));
  const ref = (node as Record<string, unknown>).$ref;
  if (typeof ref === "string") {
    const m = ref.match(/^#\/components\/schemas\/([^/]+)$/);
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    const target = m ? schemas?.[m[1]] : undefined;
    if (target !== undefined) return inlineRefs(target, components, depth + 1);
    return node; // 无法解析：原样保留
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = inlineRefs(v, components, depth + 1);
  }
  return out;
}

/** 从 operation 的 requestBody（application/json schema）或 parameters 派生暴露给模型的 inputSchema。 */
function deriveInputSchema(
  op: Record<string, unknown>,
  components?: Record<string, unknown>,
): Record<string, unknown> {
  const requestBody = op.requestBody as Record<string, unknown> | undefined;
  const bodySchema = (requestBody?.content as Record<string, Record<string, unknown>> | undefined)?.[
    "application/json"
  ]?.schema as Record<string, unknown> | undefined;
  if (bodySchema) return inlineRefs(bodySchema, components, 0) as Record<string, unknown>;

  const params = (op.parameters as Array<Record<string, unknown>> | undefined) ?? [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    const pname = p.name as string | undefined;
    if (!pname) continue;
    properties[pname] = inlineRefs(
      (p.schema as Record<string, unknown> | undefined) ?? { type: "string" },
      components,
      0,
    );
    if (p.required) required.push(pname);
  }
  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

/** 解析 openapiConfig 里的全部 operation（path × method，需有 operationId）。 */
export function extractOperations(
  openapiConfig: Record<string, unknown> | undefined,
): OpenapiOperation[] {
  if (!openapiConfig) return [];
  const servers = (openapiConfig.servers as Array<{ url?: string }> | undefined) ?? [];
  const serverUrl = servers[0]?.url ?? "";
  const components = openapiConfig.components as Record<string, unknown> | undefined;
  const paths = (openapiConfig.paths as Record<string, Record<string, unknown>> | undefined) ?? {};

  const ops: OpenapiOperation[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!op || typeof op !== "object") continue;
      const operation = op as Record<string, unknown>;
      // operationId 缺省时从 method+path 派生回退名（净化），避免「资源在、却静默 0 工具、无任何报错」。
      // 契约要求 operationId 存在；缺失时降级派生让工具仍可用，而不是悄悄丢掉整个 operation。
      const operationId = (operation.operationId as string | undefined)
        || `${method.toLowerCase()}_${path}`.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
        || `${method.toLowerCase()}_op`;
      ops.push({
        operationId,
        method: method.toLowerCase(),
        path,
        serverUrl,
        description: (operation.description ?? operation.summary) as string | undefined,
        inputSchema: deriveInputSchema(operation, components),
      });
    }
  }
  return ops;
}

/**
 * 入口定位（单动作资源 AGENT/SKILL）：openapiConfig 只有一个 operation 时直接用它；
 * 多个 operation 时必须含保留 operationId（AGENT=invoke、SKILL=download）。找不到则返回 undefined。
 */
export function locateEntryOperation(
  ops: OpenapiOperation[],
  reservedId: string,
): OpenapiOperation | undefined {
  if (ops.length === 1) return ops[0];
  return ops.find((o) => o.operationId === reservedId);
}

/** 拼接 serverUrl + path（serverUrl 可空——SANDBOX_TEMPLATE 懒创建后由 runloop 填）。 */
export function joinUrl(serverUrl: string, path: string): string {
  if (!serverUrl) return path;
  return serverUrl.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

/** 子 agent 委派端点：openapiConfig 的入口 operation（保留名 invoke）拼成完整 URL。 */
export function deriveAgentEndpoint(agent: Resource): string {
  const ops = extractOperations(agent.openapiConfig as Record<string, unknown> | undefined);
  const entry = locateEntryOperation(ops, "invoke");
  if (!entry) return "";
  return joinUrl(entry.serverUrl, entry.path);
}

/** SKILL 下载端点：openapiConfig 的入口 operation（保留名 download）拼成完整 URL。 */
export function deriveSkillDownloadUrl(skill: Resource): string {
  const ops = extractOperations(skill.openapiConfig as Record<string, unknown> | undefined);
  const entry = locateEntryOperation(ops, "download");
  if (!entry) return "";
  return joinUrl(entry.serverUrl, entry.path);
}

/** 子 agent 委派协议 = protocol（mcp 不适用于 AGENT；非委派 protocol 回落 ag-ui）。 */
export function delegationProtocol(agent: Resource): "ag-ui" | "chat-completions" | "runloop" | "a2a" {
  switch (agent.protocol) {
    case "chat-completions":
      return "chat-completions";
    case "runloop":
      return "runloop";
    case "a2a":
      return "a2a";
    default:
      return "ag-ui";
  }
}
