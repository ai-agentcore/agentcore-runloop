import { describe, it, expect } from "vitest";
import { buildSignedRequest } from "@/sidecar/agentrun-sign.js";

describe("buildSignedRequest", () => {
  const creds = {
    accessKeyId: "LTAI5tTestKey",
    accessKeySecret: "TestSecret123",
    securityToken: "sts-token-abc",
    accountId: "1234567890",
    region: "cn-hangzhou",
  };

  it("produces Authorization header with correct algorithm", () => {
    const signed = buildSignedRequest("POST", "https://1234567890.agentrun-data.cn-hangzhou.aliyuncs.com/ag-ui/agent", "{}", creds);
    expect(signed.headers["Agentrun-Authorization"]).toMatch(/^AGENTRUN4-HMAC-SHA256 Credential=/);
  });

  it("rewrites URL to RAM subdomain", () => {
    const signed = buildSignedRequest("POST", "https://1234567890.agentrun-data.cn-hangzhou.aliyuncs.com/ag-ui/agent", "{}", creds);
    expect(signed.url).toContain("-ram.agentrun-data");
  });

  it("includes x-acs-security-token when provided", () => {
    const signed = buildSignedRequest("POST", "https://host.aliyuncs.com/path", "{}", creds);
    expect(signed.headers["x-acs-security-token"]).toBe("sts-token-abc");
  });

  it("omits x-acs-security-token when not provided", () => {
    const { securityToken, ...credsNoToken } = creds;
    const signed = buildSignedRequest("POST", "https://host.aliyuncs.com/path", "{}", credsNoToken);
    expect(signed.headers["x-acs-security-token"]).toBeUndefined();
  });

  it("never adds x-acs-parent-id (not in reference signer → would break server signature)", () => {
    const signed = buildSignedRequest("POST", "https://host.aliyuncs.com/path", "{}", creds, "application/json");
    expect(signed.headers["x-acs-parent-id"]).toBeUndefined();
    const auth = signed.headers["Agentrun-Authorization"]!;
    expect(auth).not.toContain("x-acs-parent-id");
  });

  it("includes host always; content-type only when explicitly provided", () => {
    const withCt = buildSignedRequest("POST", "https://1234567890.agentrun-data.cn-hangzhou.aliyuncs.com/path", "{}", creds, "application/json");
    expect(withCt.headers["host"]).toBe("1234567890-ram.agentrun-data.cn-hangzhou.aliyuncs.com");
    expect(withCt.headers["content-type"]).toBe("application/json");

    // GET skill-download style: no contentType → content-type neither sent nor signed.
    const noCt = buildSignedRequest("GET", "https://1234567890.funagent-data-pre.cn-hangzhou.aliyuncs.com/tools/x/download", "", creds);
    expect(noCt.headers["content-type"]).toBeUndefined();
    expect(noCt.headers["Agentrun-Authorization"]).not.toContain("content-type");
  });

  it("Credential contains accessKeyId, date, region", () => {
    const signed = buildSignedRequest("POST", "https://host.aliyuncs.com/path", "{}", creds);
    const auth = signed.headers["Agentrun-Authorization"]!;
    expect(auth).toContain(`Credential=${creds.accessKeyId}/`);
    expect(auth).toContain("/cn-hangzhou/agentrun/aliyun_v4_request");
  });

  it("SignedHeaders includes required headers sorted (content-type only when provided)", () => {
    const signed = buildSignedRequest("POST", "https://host.aliyuncs.com/path", "{}", creds, "application/json");
    const auth = signed.headers["Agentrun-Authorization"]!;
    const signedHeaders = auth.match(/SignedHeaders=([^,]+)/)?.[1] ?? "";
    const keys = signedHeaders.split(";");
    expect(keys).toContain("host");
    expect(keys).toContain("content-type");
    expect(keys).toContain("x-acs-date");
    expect(keys).toContain("x-acs-content-sha256");
    expect(keys).toContain("x-acs-security-token");
    expect(keys).not.toContain("x-acs-parent-id");
    // verify sorted
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("does not rewrite non-aliyuncs URLs", () => {
    const signed = buildSignedRequest("POST", "https://custom-host.example.com/path", "{}", creds);
    expect(signed.url).toBe("https://custom-host.example.com/path");
  });

  it("defaults region to cn-hangzhou when not provided", () => {
    const { region, ...credsNoRegion } = creds;
    const signed = buildSignedRequest("POST", "https://host.aliyuncs.com/path", "{}", credsNoRegion);
    expect(signed.headers["Agentrun-Authorization"]).toContain("/cn-hangzhou/");
  });

  it("throws for truly invalid URLs (rewriteToRamUrl catch returns raw, but buildSignedRequest re-parses)", () => {
    expect(() => buildSignedRequest("POST", "not-a-valid-url", "{}", creds)).toThrow();
  });

  it("percent-encodes special characters in query string values", () => {
    const signed = buildSignedRequest(
      "GET",
      "https://host.aliyuncs.com/path?key=hello!'()*world",
      "",
      creds,
    );
    expect(signed.headers["Agentrun-Authorization"]).toMatch(/Signature=[a-f0-9]+/);
  });

  it("rewrites funagent-data hostname to RAM", () => {
    const signed = buildSignedRequest(
      "POST",
      "https://123.funagent-data.cn-hangzhou.aliyuncs.com/path",
      "{}",
      creds,
    );
    expect(signed.url).toContain("-ram.funagent-data");
  });

  it("rewrites funagent-data-pre hostname to RAM", () => {
    const signed = buildSignedRequest(
      "POST",
      "https://123.funagent-data-pre.cn-hangzhou.aliyuncs.com/path",
      "{}",
      creds,
    );
    expect(signed.url).toContain("-ram.funagent-data-pre");
  });
});
