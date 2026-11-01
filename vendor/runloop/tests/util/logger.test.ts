import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Logger, createLogger, closeAllLogStreams, loggerOptionsFromEnv } from "@/util/logger.js";

describe("Logger", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = join(tmpdir(), `runloop-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await closeAllLogStreams();
    for (const dir of tmpDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("writes to file when logDir is set", async () => {
    const dir = makeTmpDir();
    const log = new Logger("test-module", { logDir: dir, level: "debug" });

    log.info("hello world", { requestId: "r1" });
    log.debug("detail");
    log.warn("caution");
    log.error("failure");

    await closeAllLogStreams();

    const filePath = join(dir, "runloop.log");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    const lines = readJsonLines(content, "test-module");
    expect(lines[0]).toMatchObject({
      level: 30,
      category: "test-module",
      msg: "hello world",
      requestId: "r1",
    });
    expect(content).toContain("hello world");
    expect(content).toContain("detail");
    expect(content).toContain("caution");
    expect(content).toContain("failure");
  });

  it("respects minimum log level", async () => {
    const dir = makeTmpDir();
    const log = new Logger("filtered", { logDir: dir, level: "warn" });

    log.debug("skip me");
    log.info("skip me too");
    log.warn("show me");
    log.error("and me");

    await closeAllLogStreams();

    const content = readFileSync(join(dir, "runloop.log"), "utf-8");
    expect(content).not.toContain("skip me");
    expect(content).toContain("show me");
    expect(content).toContain("and me");
  });

  it("child logger writes to runloop default file", async () => {
    const dir = makeTmpDir();
    const parent = new Logger("parent", { logDir: dir });
    const child = parent.child("child");

    parent.info("parent msg");
    child.info("child msg");

    await closeAllLogStreams();

    const content = readFileSync(join(dir, "runloop.log"), "utf-8");

    expect(content).toContain("parent msg");
    expect(content).toContain("child msg");
  });

  it("enabled is true by default (stdout sink)", () => {
    const log = new Logger("silent", {});
    expect(log.enabled).toBe(true);
  });

  it("enabled is false when explicit empty sinks", () => {
    const log = new Logger("silent", { sinks: [] });
    expect(log.enabled).toBe(false);
  });

  it("enabled is true when logDir is set", async () => {
    const dir = makeTmpDir();
    const log = new Logger("active", { logDir: dir });
    expect(log.enabled).toBe(true);
  });

  it("enabled is true when stderr is true", () => {
    const log = new Logger("stderr-active", { stderr: true });
    expect(log.enabled).toBe(true);
  });

  it("includes ISO timestamp in log lines", async () => {
    const dir = makeTmpDir();
    const log = new Logger("ts", { logDir: dir });
    log.info("timestamped");
    await closeAllLogStreams();

    const content = readFileSync(join(dir, "runloop.log"), "utf-8");
    const line = readJsonLines(content, "ts")[0];
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("creates logDir recursively if needed", async () => {
    const dir = join(makeTmpDir(), "nested", "deep");
    const log = new Logger("nested", { logDir: dir });
    log.info("deep write");
    await closeAllLogStreams();

    expect(existsSync(join(dir, "runloop.log"))).toBe(true);
  });

  it("shares stream for same category file in same dir", async () => {
    const dir = makeTmpDir();
    const log1 = new Logger("shared", { logDir: dir });
    const log2 = new Logger("shared", { logDir: dir });

    log1.info("from first");
    log2.info("from second");
    await closeAllLogStreams();

    const content = readFileSync(join(dir, "runloop.log"), "utf-8");
    expect(content).toContain("from first");
    expect(content).toContain("from second");
  });

  it("writes traced logs to the request log as well as category file", async () => {
    const dir = makeTmpDir();
    const log = new Logger("event", { logDir: dir, traceId: "trace/one" });

    log.info("session.start");
    await closeAllLogStreams();

    const categoryContent = readFileSync(join(dir, "runloop.log"), "utf-8");
    const requestContent = readFileSync(join(dir, "requests", "trace_one.log"), "utf-8");
    const line = readJsonLines(requestContent, "event")[0];
    expect(categoryContent).toContain("session.start");
    expect(line).toMatchObject({
      category: "event",
      traceId: "trace/one",
      requestId: "trace/one",
      msg: "session.start",
    });
  });

  it("redacts sensitive fields recursively", async () => {
    const dir = makeTmpDir();
    const log = new Logger("secure", { logDir: dir });

    log.info("payload", {
      model: { apiKey: "sk-live", nested: { accessKeySecret: "secret" } },
      value: "safe",
    });
    await closeAllLogStreams();

    const line = readJsonLines(readFileSync(join(dir, "runloop.log"), "utf-8"), "secure")[0];
    expect(line.model.apiKey).toBe("***");
    expect(line.model.nested.accessKeySecret).toBe("***");
    expect(line.value).toBe("safe");
  });

  it("masks all values under a `headers` subtree regardless of key name (L11)", async () => {
    const dir = makeTmpDir();
    const log = new Logger("secure", { logDir: dir });

    log.info("payload", {
      headers: {
        "x-tenant-cred": "supersecret",
        "x-agentrun-transparent-tenant": "t-123",
        "content-type": "application/json",
      },
    });
    await closeAllLogStreams();

    const line = readJsonLines(readFileSync(join(dir, "runloop.log"), "utf-8"), "secure")[0];
    // 非常规凭证头键名不含 token/secret 等子串，但 value 仍被脱敏；key 保留便于排查。
    expect(line.headers["x-tenant-cred"]).toBe("***");
    expect(line.headers["x-agentrun-transparent-tenant"]).toBe("***");
    expect(line.headers["content-type"]).toBe("***");
    expect(Object.keys(line.headers).sort()).toEqual(["content-type", "x-agentrun-transparent-tenant", "x-tenant-cred"]);
  });

  it("caps every log file at maxFileBytes", async () => {
    const dir = makeTmpDir();
    const log = new Logger("capped", { logDir: dir, maxFileBytes: 512 });

    for (let i = 0; i < 20; i++) {
      log.info("large payload", { i, data: "x".repeat(200) });
    }
    await closeAllLogStreams();

    const filePath = join(dir, "runloop.log");
    expect(statSync(filePath).size).toBeLessThanOrEqual(512);
  });

  it("keeps at most maxTraceDirs request log files", async () => {
    const dir = makeTmpDir();
    const requestsDir = join(dir, "requests");
    for (let i = 0; i < 5; i++) {
      mkdirSync(requestsDir, { recursive: true });
      new Logger("event", { logDir: dir, traceId: `old-${i}` }).info("old");
      await closeAllLogStreams();
    }

    const log = new Logger("event", { logDir: dir, traceId: "current", maxTraceDirs: 3 });
    log.info("session.start");
    await closeAllLogStreams();

    const files = readdirSync(requestsDir).filter((name) => statSync(join(requestsDir, name)).isFile());
    expect(files).toContain("current.log");
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it("routes top-level category files to the desired layout", async () => {
    const dir = makeTmpDir();
    new Logger("http", { logDir: dir }).info("http request");
    new Logger("agentrun", { logDir: dir }).info("mcp request");
    new Logger("model", { logDir: dir }).info("model request");
    await closeAllLogStreams();

    expect(readFileSync(join(dir, "server.log"), "utf-8")).toContain("http request");
    expect(readFileSync(join(dir, "agentrun.log"), "utf-8")).toContain("mcp request");
    expect(readFileSync(join(dir, "runloop.log"), "utf-8")).toContain("model request");
  });

  it("truncates dropped-warning itself when maxFileBytes is extremely small", async () => {
    const dir = makeTmpDir();
    // maxFileBytes=10 is so small that even the "log entry exceeded maxFileBytes" warning
    // JSON exceeds it, triggering the second buffer.subarray truncation (lines 235-237).
    const log = new Logger("tiny", { logDir: dir, maxFileBytes: 10 });

    // Should not throw — the logger must handle this gracefully.
    log.info("a]message that exceeds the tiny limit");
    log.warn("another oversized message for good measure");
    await closeAllLogStreams();

    const filePath = join(dir, "runloop.log");
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).size).toBeLessThanOrEqual(10);
  });

  it("handles statSync failure in enforceRequestRetention gracefully", async () => {
    const dir = makeTmpDir();
    const requestsDir = join(dir, "requests");
    mkdirSync(requestsDir, { recursive: true });

    // Create a symlink pointing to a nonexistent target — statSync will throw.
    const { symlinkSync } = await import("node:fs");
    const badLink = join(requestsDir, "broken.log");
    symlinkSync("/nonexistent-path-that-does-not-exist", badLink);

    // Creating a logger with traceId triggers enforceRequestRetention.
    // The broken symlink should be caught and skipped, not crash.
    const log = new Logger("event", { logDir: dir, traceId: "current-req", maxTraceDirs: 3 });
    log.info("test message");
    await closeAllLogStreams();

    const requestContent = readFileSync(join(requestsDir, "current-req.log"), "utf-8");
    expect(requestContent).toContain("test message");
  });

  it("stamps type=\"log\" on every line by default", async () => {
    const dir = makeTmpDir();
    const log = new Logger("typed", { logDir: dir, level: "debug" });
    log.debug("d");
    log.info("i", { a: 1 });
    log.warn("w");
    log.error("e");
    await closeAllLogStreams();

    const lines = readJsonLines(readFileSync(join(dir, "runloop.log"), "utf-8"), "typed");
    expect(lines.every((l) => l.type === "log")).toBe(true);
    expect(lines[1]).toMatchObject({ type: "log", a: 1 });
  });

  it("event() 完全展开：type 即事件类型，完整事件放 event 字段，msg 恒为 \"event\"", async () => {
    const dir = makeTmpDir();
    const log = new Logger("event", { logDir: dir });
    log.event({ type: "run.start", id: "e1", runId: "r1", conversationId: "c1" });
    await closeAllLogStreams();

    const line = readJsonLines(readFileSync(join(dir, "runloop.log"), "utf-8"), "event")[0];
    expect(line).toMatchObject({ type: "run.start", msg: "event" });
    expect(line.eventType).toBeUndefined(); // eventType 子字段已废除（完全展开）
    expect(line.event).toMatchObject({ type: "run.start", id: "e1", runId: "r1" });
  });

  it("埋点命名方法：方法名 === type，内置 level", async () => {
    const dir = makeTmpDir();
    const log = new Logger("svc", { logDir: dir, level: "debug" });
    log.request({ conversationId: "c1", runId: "r1", uid: "acc-1" });
    log.first_token({ conversationId: "c1", runId: "r1", ttftMs: 42 });
    log.run_complete({ conversationId: "c1", runId: "r1", eventCount: 7 });
    log.model_request({ requestedModel: "qwen", upstream: "qwen", baseUrl: "http://u" });
    log.model_response({ upstream: "qwen" });
    log.model_fallback({ upstream: "qwen", error: "fb" });
    log.model_error({ upstream: "qwen", error: "boom" });
    await closeAllLogStreams();

    const lines = readJsonLines(readFileSync(join(dir, "runloop.log"), "utf-8"), "svc");
    expect(lines[0]).toMatchObject({ type: "request", level: 30, conversationId: "c1", uid: "acc-1" });
    expect(lines[1]).toMatchObject({ type: "first_token", level: 30, ttftMs: 42 });
    expect(lines[2]).toMatchObject({ type: "run_complete", level: 30, eventCount: 7 });
    expect(lines[3]).toMatchObject({ type: "model_request", level: 30, requestedModel: "qwen", baseUrl: "http://u" });
    expect(lines[4]).toMatchObject({ type: "model_response", level: 30, upstream: "qwen" });
    expect(lines[5]).toMatchObject({ type: "model_fallback", level: 40, upstream: "qwen", error: "fb" });
    expect(lines[6]).toMatchObject({ type: "model_error", level: 50, upstream: "qwen", error: "boom" });
  });
});

// category 过滤：fork 复用下偶有其它模块的日志行混入同一文件，按位置 index 会错位；
// 传 category 只取本测试 logger（模块名唯一）写的行，使断言对外来行健壮。
function readJsonLines(content: string, category?: string): any[] {
  const lines = content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return category ? lines.filter((l) => l.category === category) : lines;
}

describe("Logger — 配置/sink 分支补全", () => {
  const tmpDirs: string[] = [];
  function tmp(): string { const d = join(tmpdir(), `lg-${Date.now()}-${Math.random().toString(36).slice(2)}`); tmpDirs.push(d); return d; }
  const prevSinks = process.env.AGENTCORE_LOG_SINKS;
  afterEach(async () => {
    await closeAllLogStreams();
    if (prevSinks === undefined) delete process.env.AGENTCORE_LOG_SINKS; else process.env.AGENTCORE_LOG_SINKS = prevSinks;
    for (const d of tmpDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("loggerOptionsFromEnv：AGENTCORE_LOG_SINKS 解析（有效/空/全无效）", () => {
    process.env.AGENTCORE_LOG_SINKS = "stdout,file, bogus";
    expect(loggerOptionsFromEnv().sinks).toEqual(["stdout", "file"]); // 过滤无效，保留有效
    process.env.AGENTCORE_LOG_SINKS = "bogus,nope";
    expect(loggerOptionsFromEnv().sinks).toBeUndefined();             // 全无效 → undefined（222）
    delete process.env.AGENTCORE_LOG_SINKS;
    expect(loggerOptionsFromEnv().sinks).toBeUndefined();             // 未设 → undefined（217）
  });

  it("resolveSinks：显式 sinks=[file] + stdout 选项 → 加 stdout；无 logDir → 删 file", () => {
    // sinks=["file"] 显式 + stdout:true（203 分支）+ 无 logDir → file 被删（205 分支）→ 仍 enabled（stdout）
    const log = new Logger("m", { sinks: ["file"], stdout: true });
    expect(log.enabled).toBe(true);
  });

  it("resolveSinks：显式 sinks=[file] 无 logDir → file 删光、无 stdout → 不 enabled", () => {
    const log = new Logger("m", { sinks: ["file"] }); // file 删（205）、无其它 sink → enabled false
    expect(log.enabled).toBe(false);
  });

  it("forTrace 派生带 traceId 的子 logger（161）", async () => {
    const dir = tmp();
    new Logger("event", { logDir: dir }).forTrace("trace-xyz").info("hi");
    await closeAllLogStreams();
    const reqDir = join(dir, "requests");
    expect(existsSync(reqDir) && readdirSync(reqDir).some((n) => n.startsWith("trace-xyz"))).toBe(true);
  });

  it("createLogger 用默认 options（216）", () => {
    const log = createLogger("m"); // 不传 options → 默认 {}
    expect(log).toBeInstanceOf(Logger);
  });

  it("loggerOptionsFromEnv：合法 AGENTCORE_LOG_LEVEL 被解析（253）", () => {
    process.env.AGENTCORE_LOG_LEVEL = "debug";
    expect(loggerOptionsFromEnv().level).toBe("debug");
    process.env.AGENTCORE_LOG_LEVEL = "bogus";
    expect(loggerOptionsFromEnv().level).toBeUndefined(); // 非法 → undefined（255）
    delete process.env.AGENTCORE_LOG_LEVEL;
  });

  it("traceId 含特殊字符 → 请求日志名净化（路径段净化）", async () => {
    const dir = tmp();
    new Logger("event", { logDir: dir, traceId: "a/b c:d" }).info("x");
    await closeAllLogStreams();
    const reqDir = join(dir, "requests");
    expect(existsSync(reqDir) && readdirSync(reqDir).some((n) => n.endsWith(".log") && !n.includes("/"))).toBe(true);
  });
});
