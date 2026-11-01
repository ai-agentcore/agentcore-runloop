import AgentRunClient from "@alicloud/agentrun20250910";
import { envPositiveInt } from "../util/env.js";

/** AgentRun 访问凭证（control / data plane 共用）。 */
export interface AgentRunCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  accountId?: string;
  region?: string;
}

/** 推导出的 AgentRun control / data plane endpoint。 */
export interface AgentRunEndpointConfig {
  controlEndpoint: string;
  dataEndpoint: string;
  effectiveRegion: string;
}

// 底层 httpx（@alicloud/openapi-core → httpx@2.x）的 connect/read 默认超时**仅 3s**（httpx 的 `TIMEOUT` 常量）。
// 在并发控制面调用风暴下会大量 ConnectTimeout——典型场景：① `make e2e` 一次并行起 ~27 个 e2e suite，
// 它们的 beforeAll 几乎同时打 `/agents/tools`（listTools）；② Docker `linux/amd64` 在 Apple Silicon 上走
// Rosetta 模拟、TLS 握手 CPU 变慢。单连接握手仅 ~70ms，但几十个并发挤在一起会冲过 3s。
// 故显式把 AgentRun SDK 的 connect/read 超时调高（远离 3s），并允许 env 覆盖。
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 60_000;

/**
 * 构造 AgentRun SDK Config（含显式 connect/read 超时）。抽出为纯函数便于单测断言超时值与 env 覆盖。
 * 超时经 `AGENTRUN_CONNECT_TIMEOUT_MS` / `AGENTRUN_READ_TIMEOUT_MS` 可覆盖（毫秒，正整数）。
 */
export function buildAgentRunClientConfig(opts: {
  credentials: AgentRunCredentials;
  endpoint?: string;
}): Record<string, unknown> {
  return {
    accessKeyId: opts.credentials.accessKeyId,
    accessKeySecret: opts.credentials.accessKeySecret,
    securityToken: opts.credentials.securityToken,
    regionId: opts.credentials.region,
    endpoint: normalizeHost(opts.endpoint),
    // @alicloud/openapi-core 的 Config 直接读这两个字段（client.js 内 `config.connectTimeout/readTimeout`）。
    connectTimeout: envPositiveInt("AGENTRUN_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
    readTimeout: envPositiveInt("AGENTRUN_READ_TIMEOUT_MS", DEFAULT_READ_TIMEOUT_MS),
  };
}

/** 用凭证构造 AgentRun control-plane SDK client（endpoint 取 host 部分）。 */
export function createAgentRunClient(opts: {
  credentials: AgentRunCredentials;
  endpoint?: string;
}): AgentRunClient {
  return new AgentRunClient(
    buildAgentRunClientConfig(opts) as ConstructorParameters<typeof AgentRunClient>[0],
  );
}

/**
 * 推导 control endpoint（仅 region 即可，缺省 cn-hangzhou）。
 * pre / staging 固定指向杭州预发；其余视为线上。
 */
export function deriveAgentRunControlEndpoint(region?: string): string {
  const r = (region ?? "").trim() || "cn-hangzhou";
  if (r === "pre" || r === "staging") {
    return "https://agentrun-pre.cn-hangzhou.aliyuncs.com";
  }
  return `https://agentrun.${r}.aliyuncs.com`;
}

/**
 * 推导 control + data endpoint（需 accountId 拼 data 域名）。
 * pre / staging 固定杭州预发；其余按线上模板，签名 region 用原 region。
 */
export function deriveAgentRunEndpoints(accountId: string, region: string): AgentRunEndpointConfig {
  if (!accountId.trim()) {
    throw new Error("AgentRun accountId is required to derive endpoints");
  }
  const r = region.trim();
  if (!r) {
    throw new Error("AgentRun region is required to derive endpoints");
  }

  const controlEndpoint = deriveAgentRunControlEndpoint(r);
  if (r === "pre" || r === "staging") {
    return {
      controlEndpoint,
      dataEndpoint: `https://${accountId}.funagent-data-pre.cn-hangzhou.aliyuncs.com`,
      effectiveRegion: "cn-hangzhou",
    };
  }
  return {
    controlEndpoint,
    dataEndpoint: `https://${accountId}.agentrun.${r}-data.aliyuncs.com`,
    effectiveRegion: r,
  };
}

function normalizeHost(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
