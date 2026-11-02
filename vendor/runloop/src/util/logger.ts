import { existsSync, mkdirSync, readdirSync, rmSync, statSync, truncateSync, writeSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = "file" | "stdout" | "stderr";
export type LogFields = Record<string, unknown>;

/**
 * 埋点（metric）类型：在关键位置产出的结构化记录，喂图表/大盘。方法名 === type 值（见下面便捷方法）。
 * - request        : 收到 /v1/run（conversationId/runId/uid/agentCli/eventCount/model/body…）
 * - run_complete   : run 的 SSE 流收尾（conversationId/runId/eventCount/durationMs）
 * - first_token    : 首 token 耗时（conversationId/runId/ttftMs）
 * - model_request  : 模型审计旁路——发往上游前（requestedModel/upstream/baseUrl）
 * - model_response : 模型审计旁路——上游成功（upstream）
 * - model_error    : 模型审计旁路——上游出错（upstream/error）
 * - model_fallback : 模型审计旁路——出错回退下一个上游（upstream/error）
 */
export type MetricType =
  | "request"
  | "run_complete"
  | "first_token"
  | "model_request"
  | "model_response"
  | "model_error"
  | "model_fallback";

/**
 * 日志类型判别符（每行日志的顶层 `type` 字段，缺省 "log"）。**完全展开：一类产出 = 一个 type。**
 * 三大类本质都是"某位置产出的一条结构化记录"，平级铺开、无嵌套：
 * - `log`        : 自由文本/通用结构化日志（默认；info/debug/warn/error 都落这），给人排查用
 * - 埋点 metric  : 见 {@link MetricType}，喂大盘
 * - 事件投影     : `type` 直接取自 RunloopEvent 的类型（`run.start`/`toolcall.suspend`/`message.delta`/…），
 *                  完整事件对象放在 `event` 字段（由 {@link Logger.event} 产出）
 * 与 `category`（来源模块）正交：category 说"谁打的"，type 说"这是哪一类产出"。
 * `(string & {})` 容纳事件类型字符串，同时保留字面量自动补全。
 */
export type LogType = "log" | MetricType | (string & {});

export interface LoggerOptions {
  logDir?: string;
  level?: LogLevel;
  sinks?: LogSink[];
  stdout?: boolean;
  stderr?: boolean;
  redactKeys?: string[];
  traceId?: string;
  maxFileBytes?: number;
  maxTraceDirs?: number;
}

const fileDestinations = new Map<string, DestinationStream>();
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TRACE_DIRS = 100;

function getOrCreateFileDestination(
  filePath: string,
  maxFileBytes: number,
): DestinationStream {
  const existing = fileDestinations.get(filePath);
  if (existing) return existing;

  mkdirSync(dirname(filePath), { recursive: true });
  const destination = new CappedFileDestination(filePath, maxFileBytes);
  fileDestinations.set(filePath, destination);
  return destination;
}

export async function closeAllLogStreams(): Promise<void> {
  for (const destination of fileDestinations.values()) {
    try {
      (destination as DestinationStream & { flushSync?: () => void }).flushSync?.();
    } catch {}
    try {
      (destination as DestinationStream & { destroy?: () => void }).destroy?.();
    } catch {}
  }

  fileDestinations.clear();
}

export class Logger {
  private readonly logger: PinoLogger | null;
  private readonly sinks: Set<LogSink>;
  private readonly redactKeys: string[];
  private readonly options: LoggerOptions;
  readonly module: string;

  constructor(module: string, options: LoggerOptions = {}) {
    this.module = module;
    this.sinks = resolveSinks(options);
    this.redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
    this.options = { ...options, sinks: [...this.sinks], redactKeys: this.redactKeys };
    this.logger = this.createPinoLogger(options);
  }

  // 自由文本日志（type:log）。type 不再由调用方传入——要打埋点用下面的命名方法。
  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields, "log");
  }

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields, "log");
  }

  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields, "log");
  }

  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields, "log");
  }

  /**
   * RunloopEvent 日志投影（完全展开）：`type` 直接取事件类型（`run.start` 等），完整事件放 `event` 字段，
   * `msg` 恒为常量 "event"。
   */
  event(event: { type: string; [key: string]: unknown }): void {
    this.write("info", "event", { event }, event.type);
  }

  // ── 埋点便捷方法（方法名 === 产出的 type，内置 level；喂大盘）──────────────────
  /** 收到 /v1/run 请求（请求列表大盘）。 */
  request(fields?: LogFields): void {
    this.write("info", "request", fields, "request");
  }
  /** run 的 SSE 流收尾（耗时/事件数大盘）。 */
  run_complete(fields?: LogFields): void {
    this.write("info", "run_complete", fields, "run_complete");
  }
  /** 首 token 耗时（TTFT 大盘）。 */
  first_token(fields?: LogFields): void {
    this.write("info", "first_token", fields, "first_token");
  }
  /** 模型审计——发往上游前。 */
  model_request(fields?: LogFields): void {
    this.write("info", "model_request", fields, "model_request");
  }
  /** 模型审计——上游成功。 */
  model_response(fields?: LogFields): void {
    this.write("info", "model_response", fields, "model_response");
  }
  /** 模型审计——上游出错。 */
  model_error(fields?: LogFields): void {
    this.write("error", "model_error", fields, "model_error");
  }
  /** 模型审计——出错回退下一个上游。 */
  model_fallback(fields?: LogFields): void {
    this.write("warn", "model_fallback", fields, "model_fallback");
  }

  get enabled(): boolean {
    return this.logger !== null;
  }

  child(subModule: string): Logger {
    return new Logger(subModule, this.options);
  }

  forTrace(traceId: string): Logger {
    return new Logger(this.module, { ...this.options, traceId });
  }

  private createPinoLogger(options: LoggerOptions): PinoLogger | null {
    const streams: pino.StreamEntry[] = [];
    if (this.sinks.has("file") && options.logDir) {
      const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
      streams.push({
        level: "debug",
        stream: getOrCreateFileDestination(
          join(options.logDir, categoryFileName(this.module)),
          maxFileBytes
        ),
      });
      if (options.traceId) {
        const requestId = sanitizePathSegment(options.traceId);
        const requestsDir = join(options.logDir, "requests");
        enforceRequestRetention(requestsDir, `${requestId}.log`, options.maxTraceDirs ?? DEFAULT_MAX_TRACE_DIRS);
        streams.push({
          level: "debug",
          stream: getOrCreateFileDestination(join(requestsDir, `${requestId}.log`), maxFileBytes),
        });
      }
    }
    if (this.sinks.has("stdout")) {
      streams.push({ level: "debug", stream: pino.destination(1) });
    }
    if (this.sinks.has("stderr")) {
      streams.push({ level: "debug", stream: pino.destination(2) });
    }
    if (streams.length === 0) return null;

    return pino(
      {
        level: options.level ?? "info",
        base: {
          category: this.module,
          traceId: options.traceId,
          requestId: options.traceId,
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.multistream(streams, { dedupe: true })
    );
  }

  private write(level: LogLevel, msg: string, fields?: LogFields, type: LogType = "log"): void {
    if (!this.logger) return;
    const redacted = fields ? redact(fields, this.redactKeys) as LogFields : undefined;
    // `type` 始终作为顶层判别符注入；调用点不传 type 时缺省 "log"。
    this.logger[level]({ type, ...(redacted ?? {}) }, msg);
  }
}

export function createLogger(module: string, options: LoggerOptions = {}): Logger {
  return new Logger(module, options);
}

export function loggerOptionsFromEnv(overrides: LoggerOptions = {}): LoggerOptions {
  const sinks = parseSinks(process.env.AGENTCORE_LOG_SINKS);

  return {
    logDir: overrides.logDir ?? process.env.AGENTCORE_LOG_DIR,
    level: overrides.level ?? parseLogLevel(process.env.AGENTCORE_LOG_LEVEL),
    sinks: overrides.sinks ?? sinks,
    stdout: overrides.stdout,
    stderr: overrides.stderr,
    redactKeys: overrides.redactKeys,
    traceId: overrides.traceId,
    maxFileBytes: overrides.maxFileBytes,
    maxTraceDirs: overrides.maxTraceDirs,
  };
}

function resolveSinks(options: LoggerOptions): Set<LogSink> {
  const sinks = new Set<LogSink>();
  for (const sink of options.sinks ?? []) {
    sinks.add(sink);
  }
  if (!options.sinks) {
    // 默认：stdout + （给了 logDir 则）file。本地默认落盘；部署侧用 AGENTCORE_LOG_SINKS=stdout 关掉 file。
    sinks.add("stdout");
    if (options.logDir) sinks.add("file");
  }
  if (options.stdout) sinks.add("stdout");
  if (options.stderr) sinks.add("stderr");
  if (sinks.has("file") && !options.logDir) sinks.delete("file");
  return sinks;
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return undefined;
}

function parseSinks(value: string | undefined): LogSink[] | undefined {
  if (!value) return undefined;
  const sinks = value
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is LogSink => s === "file" || s === "stdout" || s === "stderr");
  return sinks.length > 0 ? sinks : undefined;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]+/g, "_").slice(0, 160) || "unknown";
}

function categoryFileName(module: string): string {
  if (module === "http") return "server.log";
  if (module === "runloop") return "tools.log";
  return "runloop.log";
}

class CappedFileDestination implements DestinationStream {
  private size: number;
  private destroyed = false;

  constructor(
    private readonly filePath: string,
    maxBytes: number
  ) {
    this.maxBytes = Math.max(1, maxBytes);
    mkdirSync(dirname(filePath), { recursive: true });
    this.size = existsSync(filePath) ? statSync(filePath).size : 0;
  }

  private readonly maxBytes: number;

  write(data: string): void {
    if (this.destroyed) return;
    let buffer = Buffer.from(data);
    if (buffer.byteLength > this.maxBytes) {
      buffer = Buffer.from(JSON.stringify({
        level: 40,
        time: new Date().toISOString(),
        type: "log",
        category: "logger",
        originalBytes: buffer.byteLength,
        maxBytes: this.maxBytes,
        msg: "log entry exceeded maxFileBytes and was dropped",
      }) + "\n");
    }
    if (buffer.byteLength > this.maxBytes) {
      buffer = buffer.subarray(0, this.maxBytes);
    }

    if (this.size + buffer.byteLength > this.maxBytes) {
      truncateSync(this.filePath, 0);
      this.size = 0;
    }

    const fd = openSync(this.filePath, "a");
    try {
      writeSync(fd, buffer);
    } finally {
      closeSync(fd);
    }
    this.size += buffer.byteLength;
  }

  flushSync(): void {}

  destroy(): void {
    this.destroyed = true;
  }
}

function enforceRequestRetention(requestsDir: string, currentFileName: string, maxRequestLogs: number): void {
  if (maxRequestLogs <= 0) return;
  mkdirSync(requestsDir, { recursive: true });
  const requestLogs = readdirSync(requestsDir)
    .map((name) => {
      const path = join(requestsDir, name);
      try {
        const stat = statSync(path);
        return stat.isFile() && name.endsWith(".log") ? { name, path, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const currentExists = requestLogs.some((log) => log.name === currentFileName);
  const excess = requestLogs.length + (currentExists ? 0 : 1) - maxRequestLogs;
  if (excess <= 0) return;

  let removed = 0;
  for (const log of requestLogs) {
    if (log.name === currentFileName) continue;
    rmSync(log.path, { force: true });
    removed++;
    if (removed >= excess) break;
  }
}

const DEFAULT_REDACT_KEYS = [
  "apiKey",
  "accessKeySecret",
  "securityToken",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
];

function redact(value: unknown, redactKeys: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, redactKeys));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (redactKeys.some((pattern) => key.toLowerCase().includes(pattern.toLowerCase()))) {
      out[key] = "***";
    } else if (key.toLowerCase() === "headers" && val && typeof val === "object" && !Array.isArray(val)) {
      // 按 key 名子串匹配挡不住 → 对 headers 子树**与 key 名无关地**把所有 value 脱敏，保留 key 便于排查（L11）。
      out[key] = maskAllValues(val as Record<string, unknown>);
    } else {
      out[key] = redact(val, redactKeys);
    }
  }
  return out;
}

/** 把对象的所有顶层 value 脱敏成 ***（保留 key）；用于值敏感但键名不可预测的子树（如透传 headers）。 */
function maskAllValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) out[key] = "***";
  return out;
}
