import { describe, it, expect, afterEach } from "vitest";
import { assertOutboundAllowed, assertAgentrunHostAllowed, isBlockedAddress, SsrfBlockedError, __setSsrfLookupForTest } from "@/sidecar/ssrf.js";

afterEach(() => __setSsrfLookupForTest(null));

describe("isBlockedAddress", () => {
  it("blocks loopback / RFC1918 / link-local / metadata / CGNAT (IPv4)", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.1", "172.15.0.1", "172.32.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks loopback / ULA / link-local / IPv4-mapped (IPv6)", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 / IPv4-mapped public", () => {
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks unparseable input (conservative)", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("assertOutboundAllowed", () => {
  it("rejects non-http(s) protocols", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x", "ftp://x"]) {
      await expect(assertOutboundAllowed(url)).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });

  it("rejects when the host resolves to a private/metadata address", async () => {
    __setSsrfLookupForTest(async () => [{ address: "169.254.169.254" }]);
    await expect(assertOutboundAllowed("https://evil.example.com/")).rejects.toThrow(/blocked private\/loopback\/metadata/);
  });

  it("rejects DNS-rebinding: any resolved address private → blocked", async () => {
    __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }, { address: "10.0.0.5" }]);
    await expect(assertOutboundAllowed("https://rebind.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows when all resolved addresses are public", async () => {
    __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]);
    await expect(assertOutboundAllowed("https://api.example.com/x")).resolves.toBeUndefined();
  });

  it("rejects when DNS resolution fails", async () => {
    __setSsrfLookupForTest(async () => { throw new Error("ENOTFOUND"); });
    await expect(assertOutboundAllowed("https://nope.example.com/")).rejects.toThrow(/dns lookup failed/);
  });
});

describe("assertAgentrunHostAllowed (R1)", () => {
  it("allows aliyun agentrun domains（含 VPC dns-mapping 的 aliyun host）", () => {
    for (const url of [
      "https://1234567890123456.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x",
      "https://1234567890123456.funagent-data-pre.cn-hangzhou.aliyuncs.com/tools/x",
      "https://acct.agentrun-data-vpc.cn-hangzhou.aliyuncs.com/x",
      "https://nlb-xxx.cn-hangzhou.nlb.aliyuncsslb.com/x",
    ]) {
      expect(() => assertAgentrunHostAllowed(url), url).not.toThrow();
    }
  });

  it("rejects IP 字面量（元数据/环回/私网）", () => {
    for (const url of ["http://169.254.169.254/x", "http://127.0.0.1:8080", "http://10.0.0.5/x", "http://[::1]/x"]) {
      expect(() => assertAgentrunHostAllowed(url), url).toThrow(SsrfBlockedError);
    }
  });

  it("rejects 任意外部域名 + 非 http(s) 协议", () => {
    expect(() => assertAgentrunHostAllowed("https://evil.example.com/agentrun")).toThrow(/not in allowlist/);
    expect(() => assertAgentrunHostAllowed("https://aliyuncs.com.evil.com/x")).toThrow(/not in allowlist/);
    expect(() => assertAgentrunHostAllowed("file:///etc/passwd")).toThrow(SsrfBlockedError);
  });
});
