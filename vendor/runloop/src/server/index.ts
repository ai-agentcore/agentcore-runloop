import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { LoopRunner } from "../loop/runner.js";
import { registerRoutes } from "./routes.js";
import { createHandlers } from "./handlers.js";
import { setupDnsMapping } from "./dns-mapping.js";
import { Logger, loggerOptionsFromEnv } from "../util/logger.js";
import { getVersionInfo, formatVersion } from "../util/version.js";
import { configFromEnv } from "../observability/config.js";
import { createMetrics } from "../observability/collector.js";
import { metricsHandler, metricsHttpMiddleware } from "../observability/http.js";

export function createApp(runner?: LoopRunner) {
  const app = new Hono();
  const loopRunner = runner ?? new LoopRunner();
  const baseLoggerOptions = loggerOptionsFromEnv();

  // 可观测性：默认全关（enabled=false 时连指标对象都不创建，零开销）。
  // 开启时安装 HTTP RED 中间件（须在路由前注册以包裹后续请求）+ 事件流派生指标 + /metrics 端点。
  const metricsConfig = configFromEnv();
  const metrics = metricsConfig.enabled ? createMetrics() : undefined;
  if (metrics && metricsConfig.httpEnabled) {
    app.use(metricsHttpMiddleware(metrics.collector, metricsConfig.path));
  }

  const handlers = createHandlers(
    loopRunner,
    baseLoggerOptions,
    metrics && metricsConfig.eventsEnabled ? metrics.collector : undefined,
  );
  const httpLog = new Logger("http", baseLoggerOptions);

  registerRoutes(app, handlers, httpLog);

  if (metrics) {
    app.get(metricsConfig.path, metricsHandler(metrics.registry));
  }

  return app;
}

const port = parseInt(process.env.PORT ?? "3000", 10);

if (process.env.NODE_ENV !== "test") {
  // 启动 banner：把部署版本（AGENTCORE_TAG=git short-sha）打到结构化日志（→ stdout/SLS，可按
  // message.msg:"runloop starting" / message.tag 查）+ console（纯文本日志里肉眼可见），方便确认版本号。
  const version = getVersionInfo();
  new Logger("server", loggerOptionsFromEnv()).info("runloop starting", { ...version, pid: process.pid });
  console.log(formatVersion(version));

  // VPC 打通：进程级安装 DNS 映射，使 runloop 能直连 agentrun 内网域名（env 未配则 no-op）。
  setupDnsMapping();
  const runner = new LoopRunner({
    workspacesDir: process.env.AGENTCORE_WORKSPACES_DIR ?? "/tmp/runloop-workspaces",
    // 不给 logDir 默认值：未设 AGENTCORE_LOG_DIR → logDir undefined → logger 只走 stdout（部署不落盘，AD-022）。
    // 本地经 .env（dotenv/config）设 AGENTCORE_LOG_DIR=./logs → 照常落盘多文件，便于 C-007 调试。
    logDir: process.env.AGENTCORE_LOG_DIR,
  });
  const app = createApp(runner);
  const hostname = process.env.HOST ?? "0.0.0.0";
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`runloop server listening on http://${hostname}:${info.port}`);
  });
}
