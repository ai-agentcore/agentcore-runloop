import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeIdentityClientFactory,
  createStsBroker,
  createStsIdentityProvider,
  resolveIdentityClientConstructor,
  type IdentityClient,
  type StsBrokerConfig,
} from "../src/sts-broker.js";

const now = 1_800_000_000_000;
const secret = Buffer.from("11".repeat(32), "hex");
const config: StsBrokerConfig = {
  keyId: "chat",
  secret,
  durationSeconds: 900,
};
const credentials = {
  accessKeyId: "STS.scoped",
  accessKeySecret: "secret",
  securityToken: "token",
  expiration: new Date(now + 900_000).toISOString(),
};
const userPolicy = JSON.stringify({ Version: "1", Statement: [{ Effect: "Allow", Action: ["oss:GetObject"], Resource: ["acs:oss:*:*:bucket/users/alice/*"] }] });
const userGrant = { version: 1, identity: { type: "userId", userId: "app:alice" }, policy: userPolicy } as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(body: unknown, overrides: Record<string, string> = {}, nonce = "22".repeat(16)): Request {
  const text = JSON.stringify(body);
  const timestamp = String(now / 1000);
  const canonical = ["STS-BROKER-V1", "POST", "/v1/sts", config.keyId, timestamp, nonce, sha256(text)].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return new Request("http://local/v1/sts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-STS-Key-ID": config.keyId!,
      "X-STS-Timestamp": timestamp,
      "X-STS-Nonce": nonce,
      "X-STS-Signature": signature,
      ...overrides,
    },
    body: text,
  });
}

describe("STS broker HTTP boundary", () => {
  it("binds identity and policy to HMAC and signs the credential response", async () => {
    let received: unknown;
    const broker = createStsBroker(config, {
      now: () => now,
      provider: { get: async grant => { received = grant; return credentials; } },
    });
    const grant = userGrant;
    const response = await broker(request(grant));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ version: 1, credentials });
    expect(received).toEqual(grant);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-STS-Response-Signature")).toBe(
      createHmac("sha256", secret).update(["STS-BROKER-RESPONSE-V1", "22".repeat(16), sha256(body)].join("\n")).digest("hex"),
    );
  });

  it("rejects unsigned, replayed, stale, oversized and malformed grants before exchange", async () => {
    const get = vi.fn(async () => credentials);
    const broker = createStsBroker(config, { now: () => now, provider: { get } });
    const grant = userGrant;
    expect((await broker(request(grant, { "X-STS-Signature": "00".repeat(32) }))).status).toBe(401);
    const valid = request(grant);
    expect((await broker(valid.clone())).status).toBe(200);
    expect((await broker(valid.clone())).status).toBe(409);
    expect((await broker(request(grant, { "X-STS-Timestamp": String(now / 1000 - 61) }))).status).toBe(401);
    for (const bad of [
      { version: 1 },
      { version: 2, identity: grant.identity, policy: grant.policy },
      { ...grant, roleArn: "admin" },
      { ...grant, policy: "*" },
      { ...grant, policy: JSON.stringify({ Version: "1", Statement: [] }) },
    ]) expect((await broker(request(bad))).status).toBe(400);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("returns sanitized upstream diagnostics and never credential exception text", async () => {
    const broker = createStsBroker(config, {
      now: () => now,
      provider: { get: async () => { throw Object.assign(new Error("SECRET_WAT"), { stage: "assume_role", upstreamCode: "Forbidden.NoPermission" }); } },
    });
    const response = await broker(request(userGrant));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain("SECRET_WAT");
    expect(JSON.parse(body)).toMatchObject({ error: "CREDENTIAL_EXCHANGE_FAILED", diagnostics: { stage: "assume_role", upstreamCode: "Forbidden.NoPermission" } });
  });

  it("rejects unsupported HTTP shapes and bodies without invoking identity", async () => {
    const get = vi.fn(async () => credentials);
    const broker = createStsBroker(config, { now: () => now, provider: { get } });
    expect((await broker(new Request("http://local/v1/sts", { method: "GET" }))).status).toBe(405);
    expect((await broker(new Request("http://local/v1/sts?scope=all", { method: "POST" }))).status).toBe(404);
    expect((await broker(new Request("http://local/v1/sts", { method: "POST", body: "{}" }))).status).toBe(415);
    expect((await broker(request(userGrant, { "Content-Length": "20000" }))).status).toBe(413);
    const huge = request({ value: "x".repeat(17_000) }, {}, "33".repeat(16));
    expect((await broker(huge)).status).toBe(413);
    const invalid = request(userGrant, {}, "44".repeat(16));
    const invalidBody = new Request(invalid.url, { method: "POST", headers: invalid.headers, body: "{" });
    expect((await broker(invalidBody)).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    broker.close();
  });

  it("closes the provider lifecycle", () => {
    const close = vi.fn();
    const broker = createStsBroker(config, { provider: { get: async () => credentials, close } });
    broker.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses platform gateway authentication without HMAC when no broker secret is configured", async () => {
    const broker = createStsBroker({ durationSeconds: 900 }, {
      now: () => now,
      provider: { get: async () => credentials },
    });
    const response = await broker(new Request("http://local/v1/sts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(userGrant),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-STS-Response-Signature")).toBeNull();
    expect(await response.json()).toEqual({ version: 1, credentials });
  });
});

describe("AgentCore identity exchange", () => {
  it("uses a machine WAT and isolates cache by trusted identity and policy", async () => {
    let clock = now;
    const calls: Array<[string, unknown]> = [];
    const client = {
      assumeRoleForWorkloadIdentityWithOptions: async (input: { workloadAccessToken?: string; policy?: string }) => {
        calls.push(["sts", input.policy]);
        return { body: { credentials } };
      },
    };
    const provider = createStsIdentityProvider(config, {
      now: () => clock,
      createClient: async () => client,
      getWorkloadAccessToken: async () => {
        calls.push(["wat", "machine"]);
        return "wat:machine";
      },
    });
    const first = userGrant;
    const policy = JSON.stringify({ Version: "1", Statement: [{ Effect: "Allow", Action: ["oss:GetObject"], Resource: ["a"] }] });
    await Promise.all([provider.get(first), provider.get(first)]);
    expect(calls).toHaveLength(2);
    await provider.get({ ...first, policy });
    expect(calls.at(-1)).toEqual(["sts", policy]);
    clock += 601_000;
    await provider.get(first);
    expect(calls).toHaveLength(6);
  });

  it("uses the Controller WAT for user ID and JWT grants while validating JWT cache deadlines", async () => {
    const calls: string[] = [];
    const client = {
      assumeRoleForWorkloadIdentityWithOptions: async () => ({ body: { credentials } }),
    };
    const provider = createStsIdentityProvider(config, {
      now: () => now,
      createClient: async () => client,
      getWorkloadAccessToken: async () => { calls.push("machine"); return "machine-wat"; },
    });
    await provider.get(userGrant);
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: now / 1000 + 400 })).toString("base64url")}.signature`;
    await provider.get({ version: 1, identity: { type: "jwt", userToken: jwt }, policy: userPolicy });
    expect(calls).toEqual(["machine", "machine"]);
    await expect(provider.get({ version: 1, identity: { type: "jwt", userToken: "bad" }, policy: userPolicy })).rejects.toMatchObject({ status: 400 });
    const expired = `a.${Buffer.from(JSON.stringify({ exp: now / 1000 + 30 })).toString("base64url")}.b`;
    await expect(provider.get({ version: 1, identity: { type: "jwt", userToken: expired }, policy: userPolicy })).rejects.toMatchObject({ status: 400 });
  });

  it("uses the Controller-resolved machine WAT instead of treating runtimeName as a workload identity", async () => {
    const getWorkloadAccessToken = vi.fn(async () => "controller-wat");
    let receivedToken: string | undefined;
    const provider = createStsIdentityProvider(config, {
      now: () => now,
      getWorkloadAccessToken,
      createClient: async () => ({
        assumeRoleForWorkloadIdentityWithOptions: async request => {
          receivedToken = request.workloadAccessToken;
          return { body: { credentials } };
        },
      }),
    });
    await provider.get(userGrant);
    expect(getWorkloadAccessToken).toHaveBeenCalledOnce();
    expect(receivedToken).toBe("controller-wat");
  });

  it("uses and closes the managed runtime factory by default", async () => {
    const close = vi.fn();
    const runtimeFactory = {
      get: vi.fn(async () => ({
        assumeRoleForWorkloadIdentityWithOptions: async () => ({ body: { credentials } }),
      })),
      getWorkloadAccessToken: vi.fn(async () => "controller-wat"),
      close,
    };
    const provider = createStsIdentityProvider({ durationSeconds: 900 }, { now: () => now, runtimeFactory });
    expect(await provider.get(userGrant)).toEqual(credentials);
    expect(runtimeFactory.get).toHaveBeenCalledOnce();
    expect(runtimeFactory.getWorkloadAccessToken).toHaveBeenCalledOnce();
    provider.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed at each exchange stage and preserves only safe diagnostics", async () => {
    const cases = [
      {
        expected: "sdk_initialization",
        getWorkloadAccessToken: async () => "wat",
        createClient: async () => { throw Object.assign(new Error("secret"), { code: "Forbidden.Safe", requestId: "request-1", statusCode: 403 }); },
      },
      { expected: "workload_access_token", createClient: async () => ({
        assumeRoleForWorkloadIdentityWithOptions: async () => ({ body: { credentials } }),
      }), getWorkloadAccessToken: async () => { throw new Error("unavailable"); } },
      { expected: "credential_validation", createClient: async () => ({
        assumeRoleForWorkloadIdentityWithOptions: async () => ({ body: { credentials: { ...credentials, expiration: "invalid" } } }),
      }), getWorkloadAccessToken: async () => "wat" },
    ];
    for (const entry of cases) {
      const provider = createStsIdentityProvider(config, {
        now: () => now,
        createClient: entry.createClient,
        getWorkloadAccessToken: entry.getWorkloadAccessToken,
      });
      await expect(provider.get(userGrant)).rejects.toMatchObject({ stage: entry.expected });
    }
  });
});

describe("AgentCore runtime credential bootstrap", () => {
  it("resolves the generated Agent Identity client from its CommonJS default export", () => {
    class GeneratedClient {}
    expect(resolveIdentityClientConstructor({ default: GeneratedClient })).toBe(GeneratedClient);
    expect(resolveIdentityClientConstructor(GeneratedClient)).toBe(GeneratedClient);
  });

  it("surfaces sanitized Resource STS diagnostics through the broker response and log payload", async () => {
    const factory = createRuntimeIdentityClientFactory({
      loadAgent: async () => ({ regionId: "cn-hangzhou" }),
      loadEnvironment: async () => ({ controllerUrl: "http://controller.local", agentSATokenFile: "/runtime/token" }),
      createResourceSts: () => ({
        get: async () => {
          throw Object.assign(new Error("controller response must not leak"), {
            code: "CREDENTIAL_EXCHANGE_FAILED",
            requestId: "controller-request-1",
            statusCode: 403,
          });
        },
        close: vi.fn(),
      }),
      createWorkloadAccessToken: () => ({ get: async () => "wat", close: vi.fn() }),
      createIdentityClient: () => ({}) as IdentityClient,
    });
    const provider = createStsIdentityProvider(config, {
      now: () => now,
      createClient: () => factory.get(),
    });
    const broker = createStsBroker({ durationSeconds: 900 }, { now: () => now, provider });
    const response = await broker(new Request("http://local/v1/sts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(userGrant),
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "CREDENTIAL_EXCHANGE_FAILED",
      diagnostics: {
        stage: "resource_sts",
        upstreamCode: "CREDENTIAL_EXCHANGE_FAILED",
        upstreamRequestId: "controller-request-1",
        upstreamStatus: 403,
      },
    });
    broker.close();
    factory.close();
  });

  it.each([
    ["runtime_config", "loadAgent"],
    ["runtime_environment", "loadEnvironment"],
    ["resource_sts_initialization", "createResourceSts"],
    ["resource_sts", "get"],
    ["identity_client", "createIdentityClient"],
  ] as const)("reports the safe %s bootstrap stage", async (expectedStage, failingStep) => {
    const failure = Object.assign(new Error("must not leak"), {
      code: "CREDENTIAL_EXCHANGE_FAILED",
      requestId: "request-safe-1",
      statusCode: 403,
    });
    const factory = createRuntimeIdentityClientFactory({
      loadAgent: async () => {
        if (failingStep === "loadAgent") throw failure;
        return { regionId: "cn-hangzhou" };
      },
      loadEnvironment: async () => {
        if (failingStep === "loadEnvironment") throw failure;
        return { controllerUrl: "http://controller.local", agentSATokenFile: "/runtime/token" };
      },
      createResourceSts: () => {
        if (failingStep === "createResourceSts") throw failure;
        return {
          get: async () => {
            if (failingStep === "get") throw failure;
            return { accessKeyId: "resource-ak", accessKeySecret: "resource-sk", securityToken: "resource-token" };
          },
          close: vi.fn(),
        };
      },
      createWorkloadAccessToken: () => ({ get: async () => "wat", close: vi.fn() }),
      createIdentityClient: () => {
        if (failingStep === "createIdentityClient") throw failure;
        return {} as IdentityClient;
      },
    });

    await expect(factory.get()).rejects.toMatchObject({
      stage: expectedStage,
      cause: failure,
    });
    factory.close();
  });

  it("derives region and Agent Identity credentials from the mounted runtime and closes resources", async () => {
    const get = vi.fn(async () => ({ accessKeyId: "resource-ak", accessKeySecret: "resource-sk", securityToken: "resource-token" }));
    const close = vi.fn();
    const closeWorkload = vi.fn();
    const getWorkloadAccessToken = vi.fn(async () => "controller-wat");
    const createIdentityClient = vi.fn((_config: unknown) => ({}) as IdentityClient);
    const factory = createRuntimeIdentityClientFactory({
      loadAgent: async () => ({ regionId: "cn-hangzhou" }),
      loadEnvironment: async () => ({ controllerUrl: "http://controller.local", agentSATokenFile: "/runtime/token" }),
      createResourceSts: (endpoint, tokenFile) => {
        expect(endpoint).toBe("http://controller.local");
        expect(tokenFile).toBe("/runtime/token");
        return { get, close };
      },
      createWorkloadAccessToken: (endpoint, tokenFile) => {
        expect(endpoint).toBe("http://controller.local");
        expect(tokenFile).toBe("/runtime/token");
        return { get: getWorkloadAccessToken, close: closeWorkload };
      },
      createIdentityClient,
    });
    expect(await factory.get()).toEqual({});
    expect(await factory.get()).toEqual({});
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith("agentidentitydata");
    expect(createIdentityClient).toHaveBeenCalledTimes(2);
    expect(await factory.getWorkloadAccessToken()).toBe("controller-wat");
    const sdkConfig = createIdentityClient.mock.calls[0][0] as { regionId: string; endpoint: string; accessKeyId: string };
    expect(sdkConfig).toMatchObject({ regionId: "cn-hangzhou", endpoint: "agentidentitydata.cn-hangzhou.aliyuncs.com", accessKeyId: "resource-ak" });
    factory.close();
    expect(close).toHaveBeenCalledOnce();
    expect(closeWorkload).toHaveBeenCalledOnce();
  });

  it("allows closing before lazy initialization", () => {
    const factory = createRuntimeIdentityClientFactory({
      loadAgent: async () => { throw new Error("unused"); },
      loadEnvironment: async () => { throw new Error("unused"); },
      createResourceSts: () => { throw new Error("unused"); },
      createWorkloadAccessToken: () => { throw new Error("unused"); },
      createIdentityClient: () => { throw new Error("unused"); },
    });
    expect(() => factory.close()).not.toThrow();
  });
});
