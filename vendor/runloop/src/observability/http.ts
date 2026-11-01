// HTTP RED 中间件 + /metrics 暴露端点（Hono）。
// 中间件按 method × route × status_class 记录请求量与时延；/metrics 渲染 registry。

import type { Context, MiddlewareHandler } from "hono";
import type { MetricsCollector } from "./collector.js";
import type { MetricsRegistry } from "./registry.js";
import { httpErrorType, httpStatusClass, normalizeHttpPath } from "./labels.js";

/**
 * HTTP RED 中间件。注册在路由之前，包裹后续所有请求。
 * `metricsPath` 自身的抓取请求不计入指标（避免自我观测噪声）。
 */
export function metricsHttpMiddleware(
  collector: MetricsCollector,
  metricsPath: string,
): MiddlewareHandler {
  return async (c: Context, next) => {
    if (c.req.path === metricsPath) {
      await next();
      return;
    }
    const start = Date.now();
    await next();
    try {
      const status = c.res.status;
      // runloop 路由固定、无路径参数；归一路径即低基数 route 标签（兜底替换疑似 id 段）。
      const route = normalizeHttpPath(c.req.path);
      collector.observeHttp({
        method: c.req.method,
        route,
        statusClass: httpStatusClass(status),
        errorType: httpErrorType(status),
        durationSeconds: (Date.now() - start) / 1000,
      });
    } catch {
      // 采集失败不影响请求处理。
    }
  };
}

/** GET /metrics handler：渲染 Prometheus 文本。 */
export function metricsHandler(registry: MetricsRegistry) {
  return (c: Context) =>
    c.text(registry.render(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
}
