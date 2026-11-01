// 远端隔离沙箱数据面客户端（系统实例 / AGENTCORE_REMOTE_SHELL 模式）。
//
// 背景：系统实例多租下，runloop 进程持系统密钥，绝不能给 codex 本地 shell（否则不可信代码能读密钥）。
// 此时执行/文件能力一律打到 AgentRun **隔离沙箱**的数据面 REST API，runloop 只做签名转发、不在本地落地。
// 数据面路径**优先从 SANDBOX 资源的 openapiConfig 按保留 operationId 解析**（resolveSandboxOps），
// 上游调整路径 runloop 自动跟随；未声明对应 operation 时回退下面这套**默认路径**（SANDBOX_OP_DEFAULTS）。
// 默认对齐 AgentRun **code-interpreter sandbox** data API（@agentrun/sdk 的 `${dataEndpoint}/sandboxes/{id}`
// 命名空间，super_agent 经该 SDK 访问；早期手抄的 /cmd、/mkdir、/directory 是错的、线上 404，已据 SDK 校正）：
//   POST /sandboxes/{id}/processes/cmd   {command, cwd?, timeout?}  → {result:{exitCode,stdout,stderr}}（兼容平铺） [operationId: exec]
//   GET  /sandboxes/{id}/files?path=                                → {content}（兼容平铺/裸文本）             [operationId: read_file]
//   POST /sandboxes/{id}/files           {path, content, createDir}                                            [operationId: write_file]
//   GET  /sandboxes/{id}/filesystem?path=&depth=                    → {entries:[{name,type,...}]}              [operationId: list_directory]
//   POST /sandboxes/{id}/filesystem/mkdir {path, parents}                                                      [operationId: mkdir]
// 注：仅 method+path 从 spec 取；请求 body / query 形状仍由动作语义决定（与 spec 的 parameters 无关）。
// 签名复用 runloop `buildSignedRequest`（AGENTRUN4-HMAC-SHA256，host 改写 `-ram`）。
// 注意：不加 x-acs-parent-id 等额外 x-acs-* 头——多签会致 403 SignatureDoesNotMatch（见 agentrun-sign.ts）。

import type { Credentials } from "../types/resources.js";
import { extractOperations } from "../mcp/openapi.js";
import { buildSignedRequest } from "./agentrun-sign.js";
import { logResourceRequest, logResourceResponse, type ResourceCallLogger } from "./resource-log.js";
import { rewriteToInternalEndpoint } from "./internal-endpoint.js";
import { envPositiveInt } from "../util/env.js";

export interface RemoteShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RemoteDirEntry {
  name: string;
  type: "file" | "dir";
}

export interface RemoteSandboxTarget {
  /** 数据面基址（scheme://host，无尾斜杠）。 */
  dataBase: string;
  /** 沙箱实例 id。 */
  sandboxId: string;
}

/** 远端沙箱数据面请求默认超时（exec/file IO）。env AGENTCORE_SANDBOX_TIMEOUT_MS 可覆盖（毫秒，正整数）。 */
const DEFAULT_TIMEOUT_MS = envPositiveInt("AGENTCORE_SANDBOX_TIMEOUT_MS", 3_600_000); // 1h

/** 数据面动作（与 runloop 的 bash/file 工具语义一一对应）。 */
export type SandboxAction = "exec" | "read_file" | "write_file" | "list_directory" | "mkdir";

/** 一个数据面 operation 的 wire 信息：HTTP 方法 + 路径（path 可含 `{id}` 占位，按实例 sandboxId 替换）。 */
export interface SandboxOp {
  method: string;
  path: string;
}

export type SandboxOps = Record<SandboxAction, SandboxOp>;

/**
 * 默认数据面路径（上游 openapiConfig 未声明对应 operation 时回退）。
 * 对齐 AgentRun code-interpreter sandbox data API（@agentrun/sdk 的 `${dataEndpoint}/sandboxes/{id}` 命名空间）。
 */
export const SANDBOX_OP_DEFAULTS: SandboxOps = {
  exec: { method: "POST", path: "/sandboxes/{id}/processes/cmd" },
  read_file: { method: "GET", path: "/sandboxes/{id}/files" },
  write_file: { method: "POST", path: "/sandboxes/{id}/files" },
  list_directory: { method: "GET", path: "/sandboxes/{id}/filesystem" },
  mkdir: { method: "POST", path: "/sandboxes/{id}/filesystem/mkdir" },
};

/**
 * 每个动作可接受的保留 operationId —— **canonical 优先，其后接受 @agentrun/sdk 风格别名**
 * （决策：两套别名都接受，上游用哪套都能 work）。spec 用其中任一 operationId 声明该 operation，
 * runloop 即按 spec 的 {method, path} 调用；都没声明则回退 SANDBOX_OP_DEFAULTS。
 */
const SANDBOX_OP_IDS: Record<SandboxAction, string[]> = {
  exec: ["exec", "cmd"],
  read_file: ["read_file", "readFile"],
  write_file: ["write_file", "writeFile"],
  list_directory: ["list_directory", "listFiles"],
  mkdir: ["mkdir", "makeDir"],
};

/**
 * 从 SANDBOX 资源的 openapiConfig **真正解析**数据面 operation（{method, path}）。
 * 每个动作按保留 operationId（canonical 优先、别名其次）在 spec 里查；命中则用 spec 的 method+path
 * （上游调整路径如 `/processes/cmd → /exec` 时 runloop 自动跟随），未命中则回退内置默认路径。
 * 与 SKILL 的 `deriveSkillDownloadUrl` / AGENT 的 `deriveAgentEndpoint` 同构（都走 extractOperations）。
 */
export function resolveSandboxOps(openapiConfig: Record<string, unknown> | undefined): SandboxOps {
  const ops = extractOperations(openapiConfig);
  const byId = new Map(ops.map((o) => [o.operationId, o]));
  const out = {} as SandboxOps;
  for (const action of Object.keys(SANDBOX_OP_DEFAULTS) as SandboxAction[]) {
    const match = SANDBOX_OP_IDS[action].map((id) => byId.get(id)).find(Boolean);
    out[action] = match ? { method: match.method.toUpperCase(), path: match.path } : SANDBOX_OP_DEFAULTS[action];
  }
  return out;
}

/** 沙箱数据面 REST 客户端 —— 单实例、无状态、每请求独立签名。 */
export class RemoteSandboxBridge {
  private readonly ops: SandboxOps;

  constructor(
    private readonly target: RemoteSandboxTarget,
    private readonly credentials: Credentials,
    /** 资源调用日志器（记录沙箱数据面 请求/响应 内容，便于排查端点不可达/路径错等）。 */
    private readonly log?: ResourceCallLogger,
    /** 数据面 operation（由 resolveSandboxOps 从 openapiConfig 解析；缺省=内置默认路径）。 */
    ops?: SandboxOps,
  ) {
    this.ops = ops ?? SANDBOX_OP_DEFAULTS;
  }

  /** 某动作的完整数据面 URL：dataBase + 解析出的 path（`{id}`/`{sandboxId}` 等占位替换为实例 id）+ 可选 query。 */
  private url(action: SandboxAction, query = ""): string {
    const path = this.ops[action].path.replace(/\{[^}]+\}/g, encodeURIComponent(this.target.sandboxId));
    const base = this.target.dataBase.replace(/\/$/, "");
    return `${base}${path.startsWith("/") ? "" : "/"}${path}${query}`;
  }

  /** 带签名发一个数据面请求，返回解析后的 JSON（非 JSON → 包成 {raw}）。 */
  private async request(method: string, url: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const signed = buildSignedRequest(method, url, payload, this.credentials, body === undefined ? undefined : "application/json");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 记录沙箱出站请求（数据面 URL + body）：端点不可达（fetch failed）时这条日志直接给出试图打的地址。
    logResourceRequest(this.log, { target: "sandbox", method, url, body: payload || undefined });
    const startedAt = Date.now();
    try {
      const res = await fetch(rewriteToInternalEndpoint(signed.url), {
        method,
        headers: signed.headers,
        body: body === undefined ? undefined : payload,
        signal: controller.signal,
      });
      const text = await res.text();
      logResourceResponse(this.log, { target: "sandbox", url, status: res.status, ok: res.ok, durationMs: Date.now() - startedAt, body: text });
      if (!res.ok) {
        throw new Error(`sandbox ${method} ${url} → HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } catch (err) {
      // fetch 网络错误（如端点不可达）无 res：单独记一条，带上 URL，避免「fetch failed」无上下文。
      if (!(err instanceof Error && err.message.startsWith("sandbox "))) {
        logResourceResponse(this.log, { target: "sandbox", url, ok: false, durationMs: Date.now() - startedAt, error: `${method} ${url} → ${String(err)}` });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 在沙箱里执行一条命令（非流式、无 stdin）。兼容新版 {result:{...}} 与旧版平铺响应。 */
  async executeCommand(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RemoteShellResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const raw = (await this.request(this.ops.exec.method, this.url("exec"), {
      command,
      cwd: opts.cwd,
      timeout: Math.ceil(timeoutMs / 1000),
    }, timeoutMs)) as Record<string, unknown>;
    const result = (raw.result ?? raw) as Record<string, unknown>;
    // `error` 字段语义尚未与真实数据面 shape 对齐（L2）。退出码：显式 exitCode/exit_code 优先，缺失时
    // error 存在才推断失败（exit=1）。stderr 仍取 error 作兜底——但**显式 exit=0（成功）时不把 error 当
    // stderr**（它是非致命提示，不应让模型把成功误读成失败）。失败（exit≠0）/无显式退出码时 error→stderr 不变。
    const hasExplicitExit = result.exitCode !== undefined || result.exit_code !== undefined;
    const exitCode = Number(result.exitCode ?? result.exit_code ?? (result.error ? 1 : 0));
    const stdout = String(result.stdout ?? result.output ?? "");
    const errAsStderr = hasExplicitExit && exitCode === 0 ? "" : (result.error ?? "");
    const stderr = String(result.stderr ?? errAsStderr);
    // 状态非 completed（超时/被杀）时修正退出码（对齐 super_agent）。
    const status = raw.status ?? result.status;
    const corrected = status !== undefined && status !== "completed" && exitCode === 0 ? 1 : exitCode;
    return { exitCode: corrected, stdout, stderr };
  }

  /** 读文件内容（兼容 {content} / {data} / 裸文本）。 */
  async readFile(path: string): Promise<string> {
    const raw = (await this.request(this.ops.read_file.method, this.url("read_file", `?path=${encodeURIComponent(path)}`))) as Record<string, unknown>;
    if (typeof raw.content === "string") return raw.content;
    if (typeof raw.data === "string") return raw.data;
    if (typeof raw.raw === "string") return raw.raw;
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  }

  /** 写文件（覆盖；父目录自动创建）。 */
  async writeFile(path: string, content: string): Promise<void> {
    await this.request(this.ops.write_file.method, this.url("write_file"), { path, content, createDir: true });
  }

  /** 列目录（兼容 {entries} / {files} / 数组）。 */
  async listDirectory(path = ".", depth = 1): Promise<RemoteDirEntry[]> {
    const raw = (await this.request(this.ops.list_directory.method, this.url("list_directory", `?path=${encodeURIComponent(path)}&depth=${depth}`))) as Record<string, unknown>;
    const list = (raw.entries ?? raw.files ?? (Array.isArray(raw) ? raw : [])) as Array<Record<string, unknown>>;
    return list.map((e) => ({
      name: String(e.name ?? e.path ?? ""),
      type: (e.type === "dir" || e.isDir || e.isDirectory) ? "dir" : "file",
    }));
  }

  /** 建目录（递归）。 */
  async mkdir(path: string): Promise<void> {
    await this.request(this.ops.mkdir.method, this.url("mkdir"), { path, parents: true });
  }
}
