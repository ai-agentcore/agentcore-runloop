// Metrics 开关与配置：默认全关，按环境变量灰度开启。
// 任何采集都不应在默认部署里产生开销——enabled=false 时连指标对象都不创建（见 src/server/index.ts）。

export interface MetricsConfig {
  /** 总开关：false 时 /metrics 返回 404、不安装任何采集（默认 false）。 */
  enabled: boolean;
  /** 暴露端点路径（默认 /metrics）。 */
  path: string;
  /** HTTP RED 中间件开关（默认 true，受 enabled 约束）。 */
  httpEnabled: boolean;
  /** 事件流派生指标（run/tool/event/turn）开关（默认 true，受 enabled 约束）。 */
  eventsEnabled: boolean;
}

function isEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): MetricsConfig {
  return {
    enabled: isEnabled(env.AGENTCORE_METRICS_ENABLED, false),
    path: env.AGENTCORE_METRICS_PATH?.trim() || "/metrics",
    httpEnabled: isEnabled(env.AGENTCORE_METRICS_HTTP_ENABLED, true),
    eventsEnabled: isEnabled(env.AGENTCORE_METRICS_EVENTS_ENABLED, true),
  };
}
