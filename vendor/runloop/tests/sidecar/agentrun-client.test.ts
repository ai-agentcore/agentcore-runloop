import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createAgentRunClient,
  buildAgentRunClientConfig,
  deriveAgentRunControlEndpoint,
  deriveAgentRunEndpoints,
} from "@/sidecar/agentrun-client.js";

describe("deriveAgentRunControlEndpoint", () => {
  it("defaults to cn-hangzhou when region is missing", () => {
    expect(deriveAgentRunControlEndpoint()).toBe("https://agentrun.cn-hangzhou.aliyuncs.com");
  });

  it("uses the pre endpoint for pre/staging", () => {
    expect(deriveAgentRunControlEndpoint("pre")).toBe("https://agentrun-pre.cn-hangzhou.aliyuncs.com");
    expect(deriveAgentRunControlEndpoint("staging")).toBe("https://agentrun-pre.cn-hangzhou.aliyuncs.com");
  });

  it("uses the regional template for normal regions", () => {
    expect(deriveAgentRunControlEndpoint("cn-beijing")).toBe("https://agentrun.cn-beijing.aliyuncs.com");
  });
});

describe("deriveAgentRunEndpoints", () => {
  it("uses fixed Hangzhou pre endpoints for pre", () => {
    expect(deriveAgentRunEndpoints("114333373279084", "pre")).toEqual({
      controlEndpoint: "https://agentrun-pre.cn-hangzhou.aliyuncs.com",
      dataEndpoint: "https://114333373279084.funagent-data-pre.cn-hangzhou.aliyuncs.com",
      effectiveRegion: "cn-hangzhou",
    });
  });

  it("uses fixed Hangzhou pre endpoints for staging", () => {
    expect(deriveAgentRunEndpoints("114333373279084", "staging")).toEqual({
      controlEndpoint: "https://agentrun-pre.cn-hangzhou.aliyuncs.com",
      dataEndpoint: "https://114333373279084.funagent-data-pre.cn-hangzhou.aliyuncs.com",
      effectiveRegion: "cn-hangzhou",
    });
  });

  it("uses production endpoint templates for normal regions", () => {
    expect(deriveAgentRunEndpoints("114333373279084", "cn-beijing")).toEqual({
      controlEndpoint: "https://agentrun.cn-beijing.aliyuncs.com",
      dataEndpoint: "https://114333373279084.agentrun.cn-beijing-data.aliyuncs.com",
      effectiveRegion: "cn-beijing",
    });
  });

  it("throws when accountId or region is missing", () => {
    expect(() => deriveAgentRunEndpoints("", "pre")).toThrow(/accountId is required/);
    expect(() => deriveAgentRunEndpoints("acc", "  ")).toThrow(/region is required/);
  });
});

describe("createAgentRunClient", () => {
  const credentials = { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou" };

  it("builds a client and extracts the host from a full endpoint URL", () => {
    const client = createAgentRunClient({
      credentials,
      endpoint: "https://agentrun.cn-hangzhou.aliyuncs.com",
    });
    expect(client).toBeDefined();
  });

  it("tolerates a missing or non-URL endpoint", () => {
    expect(createAgentRunClient({ credentials })).toBeDefined();
    expect(createAgentRunClient({ credentials, endpoint: "not a url" })).toBeDefined();
  });
});

describe("buildAgentRunClientConfig —— 显式 connect/read 超时（httpx 默认 3s 太短）", () => {
  const credentials = { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou" };
  const ENV_KEYS = ["AGENTRUN_CONNECT_TIMEOUT_MS", "AGENTRUN_READ_TIMEOUT_MS"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("缺省：connectTimeout/readTimeout 远高于 httpx 默认 3s（吸收并发握手风暴）", () => {
    const cfg = buildAgentRunClientConfig({ credentials });
    expect(cfg.connectTimeout as number).toBeGreaterThanOrEqual(30_000);
    expect(cfg.readTimeout as number).toBeGreaterThanOrEqual(30_000);
    expect(cfg.accessKeyId).toBe("ak");
    expect(cfg.regionId).toBe("cn-hangzhou");
  });

  it("env 覆盖：AGENTRUN_CONNECT_TIMEOUT_MS / AGENTRUN_READ_TIMEOUT_MS", () => {
    process.env.AGENTRUN_CONNECT_TIMEOUT_MS = "45000";
    process.env.AGENTRUN_READ_TIMEOUT_MS = "90000";
    const cfg = buildAgentRunClientConfig({ credentials });
    expect(cfg.connectTimeout).toBe(45_000);
    expect(cfg.readTimeout).toBe(90_000);
  });

  it("非法 env（非正数）→ 回落默认值", () => {
    process.env.AGENTRUN_CONNECT_TIMEOUT_MS = "abc";
    process.env.AGENTRUN_READ_TIMEOUT_MS = "-5";
    const cfg = buildAgentRunClientConfig({ credentials });
    expect(cfg.connectTimeout as number).toBeGreaterThanOrEqual(30_000);
    expect(cfg.readTimeout as number).toBeGreaterThanOrEqual(30_000);
  });
});
