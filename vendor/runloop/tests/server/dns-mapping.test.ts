import { describe, it, expect, vi } from "vitest";
import dns from "node:dns";
import tls from "node:tls";
import {
  buildDnsMappingRules,
  resolveHostname,
  setupDnsMapping,
  type DnsMappingRule,
} from "../../src/server/dns-mapping.js";

const silentLogger = { info: vi.fn(), warn: vi.fn() } as never;

const DATA_ENV = {
  AGENTRUN_DATA_HOST: "agentrun-data-vpc.cn-hangzhou.aliyuncs.com",
  AGENTRUN_DATA_ENDPOINT: "http://nlb-xxx.cn-hangzhou.nlb.aliyuncsslb.com",
} as NodeJS.ProcessEnv;

const CONTROL_ENV = {
  AGENTRUN_CONTROL_HOST: "agentrun-vpc.cn-hangzhou.aliyuncs.com",
  AGENTRUN_CONTROL_ENDPOINT: "https://ep-abc.epsrv-def.cn-hangzhou.privatelink.aliyuncs.com",
} as NodeJS.ProcessEnv;

describe("buildDnsMappingRules", () => {
  it("returns empty when no env configured", () => {
    expect(buildDnsMappingRules({})).toEqual([]);
  });

  it("builds a suffix rule from data host/endpoint (target = endpoint hostname)", () => {
    expect(buildDnsMappingRules({ ...DATA_ENV })).toEqual([
      { mode: "suffix", pattern: "agentrun-data-vpc.cn-hangzhou.aliyuncs.com", target: "nlb-xxx.cn-hangzhou.nlb.aliyuncsslb.com" },
    ]);
  });

  it("builds an exact rule from control host/endpoint", () => {
    expect(buildDnsMappingRules({ ...CONTROL_ENV })).toEqual([
      { mode: "exact", pattern: "agentrun-vpc.cn-hangzhou.aliyuncs.com", target: "ep-abc.epsrv-def.cn-hangzhou.privatelink.aliyuncs.com" },
    ]);
  });

  it("builds both rules, control first then data", () => {
    const rules = buildDnsMappingRules({ ...CONTROL_ENV, ...DATA_ENV });
    expect(rules.map((r) => r.mode)).toEqual(["exact", "suffix"]);
  });

  it("ignores half-configured pairs (host without endpoint)", () => {
    expect(buildDnsMappingRules({ AGENTRUN_DATA_HOST: "x" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("resolveHostname", () => {
  const rules: DnsMappingRule[] = [
    { mode: "exact", pattern: "agentrun-vpc.cn-hangzhou.aliyuncs.com", target: "ep-target" },
    { mode: "suffix", pattern: "agentrun-data-vpc.cn-hangzhou.aliyuncs.com", target: "nlb-target" },
  ];

  it("exact match resolves to target", () => {
    expect(resolveHostname("agentrun-vpc.cn-hangzhou.aliyuncs.com", rules)).toBe("ep-target");
  });

  it("exact rule does NOT match subdomains", () => {
    expect(resolveHostname("x.agentrun-vpc.cn-hangzhou.aliyuncs.com", rules)).toBe(
      "x.agentrun-vpc.cn-hangzhou.aliyuncs.com",
    );
  });

  it("suffix match resolves the bare host and signed subdomains (-ram)", () => {
    expect(resolveHostname("agentrun-data-vpc.cn-hangzhou.aliyuncs.com", rules)).toBe("nlb-target");
    expect(resolveHostname("123456-ram.agentrun-data-vpc.cn-hangzhou.aliyuncs.com", rules)).toBe("nlb-target");
  });

  it("passthrough for unmatched hostnames", () => {
    expect(resolveHostname("dashscope.aliyuncs.com", rules)).toBe("dashscope.aliyuncs.com");
  });
});

describe("setupDnsMapping", () => {
  it("no-op when no rules (does not patch modules)", () => {
    const lookup = vi.fn();
    const connect = vi.fn();
    const dnsModule = { lookup } as never;
    const tlsModule = { connect } as never;
    const rules = setupDnsMapping({ env: {}, dnsModule, tlsModule });
    expect(rules).toEqual([]);
    expect(dnsModule).toMatchObject({ lookup }); // unchanged
    expect(tlsModule).toMatchObject({ connect });
  });

  it("patches dns.lookup to remap matched host and passthrough others", () => {
    const originalLookup = vi.fn();
    const dnsModule = { lookup: originalLookup } as never;
    const tlsModule = { connect: vi.fn() } as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    setupDnsMapping({ env: { ...DATA_ENV }, dnsModule, tlsModule, logger });

    const cb = () => {};
    (dnsModule as { lookup: Function }).lookup("123-ram.agentrun-data-vpc.cn-hangzhou.aliyuncs.com", cb);
    expect(originalLookup).toHaveBeenCalledWith("nlb-xxx.cn-hangzhou.nlb.aliyuncsslb.com", cb, undefined);

    (dnsModule as { lookup: Function }).lookup("other.aliyuncs.com", { family: 4 }, cb);
    expect(originalLookup).toHaveBeenLastCalledWith("other.aliyuncs.com", { family: 4 }, cb);
  });

  it("is idempotent: second setupDnsMapping does not re-wrap the already-patched lookup (L7)", () => {
    const originalLookup = vi.fn();
    const dnsModule = { lookup: originalLookup } as never;
    const tlsModule = { connect: vi.fn() } as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    setupDnsMapping({ env: { ...DATA_ENV }, dnsModule, tlsModule, logger });
    const patchedOnce = (dnsModule as { lookup: Function }).lookup;
    // 再次安装 → 检测到已 patch 标记，跳过再 patch（不层层包裹）。
    setupDnsMapping({ env: { ...DATA_ENV }, dnsModule, tlsModule, logger });
    expect((dnsModule as { lookup: Function }).lookup).toBe(patchedOnce);

    // 解析仍正确，且原始 lookup 不会被多层 patch 重复调用。
    const cb = () => {};
    (dnsModule as { lookup: Function }).lookup("123-ram.agentrun-data-vpc.cn-hangzhou.aliyuncs.com", cb);
    expect(originalLookup).toHaveBeenCalledTimes(1);
  });

  it("patches tls.connect to set SNI back to the original host suffix", () => {
    const originalConnect = vi.fn();
    const dnsModule = { lookup: vi.fn() } as never;
    const tlsModule = { connect: originalConnect } as never;

    setupDnsMapping({ env: { ...DATA_ENV }, dnsModule, tlsModule });

    // host == target → servername gets set to the original pattern
    const opts: { host: string; servername?: string } = { host: "nlb-xxx.cn-hangzhou.nlb.aliyuncsslb.com" };
    (tlsModule as { connect: Function }).connect(opts);
    expect(opts.servername).toBe("agentrun-data-vpc.cn-hangzhou.aliyuncs.com");
    expect(originalConnect).toHaveBeenCalledWith(opts);
  });

  it("no-op when deps has no env (falls back to process.env, which lacks AGENTRUN_* in tests)", () => {
    expect(setupDnsMapping({ dnsModule: { lookup: vi.fn() } as never, tlsModule: { connect: vi.fn() } as never })).toEqual([]);
  });

  it("installs an exact-rule label for control host", () => {
    const logger = { info: vi.fn(), warn: vi.fn() } as never;
    setupDnsMapping({
      env: { ...CONTROL_ENV },
      dnsModule: { lookup: vi.fn() } as never,
      tlsModule: { connect: vi.fn() } as never,
      logger,
    });
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      "dns-mapping rule installed",
      expect.objectContaining({ label: "agentrun-vpc.cn-hangzhou.aliyuncs.com" }),
    );
  });

  it("falls back to node dns/tls modules when not injected (then restores)", () => {
    const realLookup = dns.lookup;
    const realConnect = tls.connect;
    try {
      const rules = setupDnsMapping({ env: { ...DATA_ENV }, logger: silentLogger });
      expect(rules).toHaveLength(1);
      expect(dns.lookup).not.toBe(realLookup);
      expect(tls.connect).not.toBe(realConnect);
    } finally {
      (dns as { lookup: unknown }).lookup = realLookup;
      (tls as { connect: unknown }).connect = realConnect;
    }
  });

  it("tls.connect does not override an explicit servername, and tolerates non-object args", () => {
    const originalConnect = vi.fn();
    const tlsModule = { connect: originalConnect } as never;
    setupDnsMapping({ env: { ...DATA_ENV }, dnsModule: { lookup: vi.fn() } as never, tlsModule });

    const opts = { host: "nlb-xxx.cn-hangzhou.nlb.aliyuncsslb.com", servername: "explicit" };
    (tlsModule as { connect: Function }).connect(opts);
    expect(opts.servername).toBe("explicit");

    // non-object first arg (e.g. port) must not throw
    expect(() => (tlsModule as { connect: Function }).connect(443, "host")).not.toThrow();
  });
});
