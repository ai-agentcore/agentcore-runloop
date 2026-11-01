import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Client, { AssumeRoleForWorkloadIdentityRequest } from "@alicloud/agentidentitydata20251127";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@darabonba/typescript";
import {
  AGENT_IDENTITY_DATA_PURPOSE,
  AgentSATokenProvider,
  ResourceSTSProvider,
  WorkloadAccessTokenProvider,
} from "alibabacloud-agentcore-sdk/auth";
import { loadAgentConfig, RuntimeEnvironmentProvider } from "alibabacloud-agentcore-sdk/runtime";

export const STS_BROKER_PATH = "/v1/sts";
const CLOCK_SKEW_SECONDS = 60;
const MAX_BODY_BYTES = 16_384;
const MAX_POLICY_BYTES = 2_048;

export interface StsBrokerConfig {
  keyId?: string;
  secret?: Buffer;
  durationSeconds: number;
}

export type StsGrant = {
  version: 1;
  identity: { type: "userId"; userId: string } | { type: "jwt"; userToken: string };
  policy: string;
};

export interface StsCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
}

export interface StsIdentityProvider {
  get(grant: StsGrant): Promise<StsCredentials>;
  close?(): void;
}

export interface IdentityClient {
  assumeRoleForWorkloadIdentityWithOptions(request: AssumeRoleForWorkloadIdentityRequest, runtime: RuntimeOptions): Promise<{ body?: { credentials?: Partial<StsCredentials> } }>;
}

type IdentityClientConstructor = new (config: $OpenApiUtil.Config) => IdentityClient;

export function resolveIdentityClientConstructor(candidate: unknown): IdentityClientConstructor {
  if (typeof candidate === "function") return candidate as IdentityClientConstructor;
  const defaultExport = candidate && typeof candidate === "object"
    ? (candidate as { default?: unknown }).default
    : undefined;
  if (typeof defaultExport === "function") return defaultExport as IdentityClientConstructor;
  throw new TypeError("Agent Identity SDK client constructor is unavailable");
}

const GeneratedIdentityClient = resolveIdentityClientConstructor(Client);

interface ProviderOptions {
  now?: () => number;
  createClient?: () => Promise<IdentityClient>;
  getWorkloadAccessToken?: () => Promise<string>;
  runtimeFactory?: {
    get(): Promise<IdentityClient>;
    getWorkloadAccessToken(): Promise<string>;
    close(): void;
  };
}

interface BrokerOptions {
  now?: () => number;
  provider?: StsIdentityProvider;
}

export interface StsBroker {
  (request: Request): Promise<Response>;
  close(): void;
}

class BrokerError extends Error {
  constructor(readonly status: number, readonly code: string, readonly diagnostics?: Record<string, string | number>) {
    super(code);
  }
}

class IdentityExchangeError extends Error {
  readonly stage: string;
  readonly upstreamCode?: string;
  readonly upstreamRequestId?: string;
  readonly upstreamStatus?: number;

  constructor(stage: string, error: unknown) {
    super("Agent Identity exchange failed");
    const bootstrapError = error instanceof RuntimeBootstrapError ? error : undefined;
    this.stage = bootstrapError?.stage ?? stage;
    const source = bootstrapError?.cause ?? error;
    const fields = source && typeof source === "object" ? source as Record<string, unknown> : {};
    const data = fields.data && typeof fields.data === "object" ? fields.data as Record<string, unknown> : {};
    const code = fields.code ?? data.Code;
    const requestId = fields.requestId ?? data.RequestId ?? data.requestId;
    const status = fields.statusCode ?? data.statusCode;
    if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(code)) this.upstreamCode = code;
    if (typeof requestId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(requestId)) this.upstreamRequestId = requestId;
    if (Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599) this.upstreamStatus = Number(status);
  }
}

class RuntimeBootstrapError extends Error {
  constructor(readonly stage: string, override readonly cause: unknown) {
    super("AgentCore runtime credential bootstrap failed", { cause });
  }
}

async function atBootstrapStage<T>(stage: string, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new RuntimeBootstrapError(stage, error);
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sign(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function validateGrant(value: unknown, now: number): { grant: StsGrant; deadline: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrokerError(400, "INVALID_REQUEST");
  const request = value as Record<string, unknown>;
  if (request.version !== 1 || Object.keys(request).length !== 3
    || Object.keys(request).some(key => !["version", "identity", "policy"].includes(key))) {
    throw new BrokerError(400, "INVALID_REQUEST");
  }
  const identity = request.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity) || Object.keys(identity).length !== 2) {
    throw new BrokerError(400, "INVALID_REQUEST");
  }
  const fields = identity as Record<string, unknown>;
  let parsedIdentity: StsGrant["identity"];
  let deadline = Infinity;
  if (fields.type === "userId" && typeof fields.userId === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(fields.userId)) {
    parsedIdentity = { type: "userId", userId: fields.userId };
  } else if (fields.type === "jwt" && typeof fields.userToken === "string" && fields.userToken.length <= 12_000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(fields.userToken)) {
    try {
      const claims = JSON.parse(Buffer.from(fields.userToken.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new Error();
      deadline = claims.exp * 1_000;
      if (deadline <= now + 60_000) throw new Error();
    } catch {
      throw new BrokerError(400, "INVALID_REQUEST");
    }
    parsedIdentity = { type: "jwt", userToken: fields.userToken };
  } else {
    throw new BrokerError(400, "INVALID_REQUEST");
  }

  if (typeof request.policy !== "string" || Buffer.byteLength(request.policy) > MAX_POLICY_BYTES) throw new BrokerError(400, "INVALID_REQUEST");
  try {
    const document = JSON.parse(request.policy) as Record<string, unknown>;
    if (!document || document.Version !== "1" || !Array.isArray(document.Statement) || document.Statement.length === 0) throw new Error();
  } catch {
    throw new BrokerError(400, "INVALID_REQUEST");
  }
  return { grant: { version: 1, identity: parsedIdentity, policy: request.policy }, deadline };
}

function diagnostics(error: unknown): Record<string, string | number> | undefined {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const result: Record<string, string | number> = {};
  if (typeof fields.stage === "string" && /^[a-z_]{1,40}$/.test(fields.stage)) result.stage = fields.stage;
  if (typeof fields.upstreamCode === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(fields.upstreamCode)) result.upstreamCode = fields.upstreamCode;
  if (typeof fields.upstreamRequestId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(fields.upstreamRequestId)) result.upstreamRequestId = fields.upstreamRequestId;
  if (Number.isInteger(fields.upstreamStatus) && Number(fields.upstreamStatus) >= 400 && Number(fields.upstreamStatus) <= 599) result.upstreamStatus = Number(fields.upstreamStatus);
  return Object.keys(result).length ? result : undefined;
}

function json(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export interface RuntimeClientDependencies {
  loadAgent(): Promise<{ regionId: string }>;
  loadEnvironment(): Promise<{ controllerUrl: string; agentSATokenFile: string }>;
  createResourceSts(controllerUrl: string, tokenFile: string): {
    get(purpose: string): Promise<{ accessKeyId: string; accessKeySecret: string; securityToken?: string }>;
    close(): void;
  };
  createWorkloadAccessToken(controllerUrl: string, tokenFile: string): {
    get(): Promise<string>;
    close(): void;
  };
  createIdentityClient(config: $OpenApiUtil.Config): IdentityClient;
}

const runtimeClientDependencies: RuntimeClientDependencies = {
  loadAgent: () => loadAgentConfig(),
  loadEnvironment: () => new RuntimeEnvironmentProvider().snapshot(),
  createResourceSts: (controllerUrl, tokenFile) => new ResourceSTSProvider(controllerUrl, new AgentSATokenProvider(tokenFile)),
  createWorkloadAccessToken: (controllerUrl, tokenFile) => new WorkloadAccessTokenProvider(controllerUrl, new AgentSATokenProvider(tokenFile)),
  createIdentityClient: config => new GeneratedIdentityClient(config),
};

export function createRuntimeIdentityClientFactory(
  dependencies: RuntimeClientDependencies = runtimeClientDependencies,
): { get(): Promise<IdentityClient>; getWorkloadAccessToken(): Promise<string>; close(): void } {
  let resourceSts: ReturnType<RuntimeClientDependencies["createResourceSts"]> | undefined;
  let initialization: Promise<{
    regionId: string;
    controllerUrl: string;
    agentSATokenFile: string;
    provider: ReturnType<RuntimeClientDependencies["createResourceSts"]>;
  }> | undefined;
  const initialize = async () => {
    const [agent, environment] = await Promise.all([
      atBootstrapStage("runtime_config", () => dependencies.loadAgent()),
      atBootstrapStage("runtime_environment", () => dependencies.loadEnvironment()),
    ]);
    const provider = await atBootstrapStage("resource_sts_initialization", () =>
      dependencies.createResourceSts(environment.controllerUrl, environment.agentSATokenFile));
    resourceSts = provider;
    return {
      regionId: agent.regionId,
      controllerUrl: environment.controllerUrl,
      agentSATokenFile: environment.agentSATokenFile,
      provider,
    };
  };
  return {
    async get() {
      const { regionId, provider } = await (initialization ??= initialize());
      const credential = await atBootstrapStage("resource_sts", () => provider.get(AGENT_IDENTITY_DATA_PURPOSE));
      const clientConfig = new $OpenApiUtil.Config({
        accessKeyId: credential.accessKeyId,
        accessKeySecret: credential.accessKeySecret,
        securityToken: credential.securityToken,
        regionId,
        endpoint: `agentidentitydata.${regionId}.aliyuncs.com`,
        protocol: "https",
        connectTimeout: 5_000,
        readTimeout: 10_000,
      });
      return atBootstrapStage("identity_client", () => dependencies.createIdentityClient(clientConfig));
    },
    async getWorkloadAccessToken() {
      const { controllerUrl, agentSATokenFile } = await (initialization ??= initialize());
      const provider = dependencies.createWorkloadAccessToken(controllerUrl, agentSATokenFile);
      try {
        return await provider.get();
      } finally {
        provider.close();
      }
    },
    close() { resourceSts?.close(); },
  };
}

export function createStsIdentityProvider(config: StsBrokerConfig, options: ProviderOptions = {}): StsIdentityProvider {
  const now = options.now ?? Date.now;
  const runtimeFactory = options.runtimeFactory ?? (options.createClient ? undefined : createRuntimeIdentityClientFactory());
  const createClient = options.createClient ?? (() => runtimeFactory!.get());
  const getWorkloadAccessToken = options.getWorkloadAccessToken ?? (() => runtimeFactory!.getWorkloadAccessToken());
  const cached = new Map<string, { credentials: StsCredentials; expiresAt: number }>();
  const pending = new Map<string, Promise<StsCredentials>>();

  async function exchange(grant: StsGrant, key: string, deadline: number): Promise<StsCredentials> {
    let stage = "sdk_initialization";
    try {
      const client = await createClient();
      const runtime = new RuntimeOptions({ connectTimeout: 5_000, readTimeout: 10_000, autoretry: false });
      stage = "workload_access_token";
      // Cloud identity is always the current Agent workload resolved by the
      // Controller. User identity remains bound to validation/cache/policy.
      const token = await getWorkloadAccessToken();
      if (typeof token !== "string" || !token) throw new Error("Invalid workload token response");
      stage = "assume_role";
      const response = await client.assumeRoleForWorkloadIdentityWithOptions(new AssumeRoleForWorkloadIdentityRequest({
        workloadAccessToken: token,
        durationSeconds: config.durationSeconds,
        roleSessionName: "agentcore-runloop-sts",
        policy: grant.policy,
      }), runtime);
      stage = "credential_validation";
      const value = response.body?.credentials;
      if (!value || [value.accessKeyId, value.accessKeySecret, value.securityToken, value.expiration].some(item => typeof item !== "string" || !item.trim())) {
        throw new Error("Invalid STS response");
      }
      const expiresAt = Date.parse(value.expiration!);
      if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value.expiration!) || !Number.isFinite(expiresAt) || expiresAt <= now() + 60_000) throw new Error("Invalid STS expiration");
      const credentials: StsCredentials = Object.freeze({
        accessKeyId: value.accessKeyId!,
        accessKeySecret: value.accessKeySecret!,
        securityToken: value.securityToken!,
        expiration: new Date(expiresAt).toISOString(),
      });
      if (cached.size >= 1_000) cached.delete(cached.keys().next().value!);
      cached.set(key, { credentials, expiresAt: Math.min(expiresAt, deadline) });
      return credentials;
    } catch (error) {
      throw new IdentityExchangeError(stage, error);
    }
  }

  return {
    async get(input) {
      const { grant, deadline } = validateGrant(input, now());
      const key = digest(JSON.stringify(grant));
      const hit = cached.get(key);
      if (hit && hit.expiresAt > now() + 300_000) return hit.credentials;
      let request = pending.get(key);
      if (!request) {
        if (pending.size >= 100) throw new IdentityExchangeError("rate_limit", new Error());
        request = exchange(grant, key, deadline).finally(() => pending.delete(key));
        pending.set(key, request);
      }
      return request;
    },
    close() { runtimeFactory?.close(); },
  };
}

export function createStsBroker(config: StsBrokerConfig, options: BrokerOptions = {}): StsBroker {
  const now = options.now ?? Date.now;
  const provider = options.provider ?? createStsIdentityProvider(config, { now });
  const hmacEnabled = Boolean(config.keyId && config.secret);
  const seen = new Map<string, number>();
  const handler = async (request: Request) => {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST") throw new BrokerError(405, "METHOD_NOT_ALLOWED");
      if (url.pathname !== STS_BROKER_PATH || url.search) throw new BrokerError(404, "NOT_FOUND");
      const contentType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (contentType !== "application/json") throw new BrokerError(415, "UNSUPPORTED_MEDIA_TYPE");
      const length = Number(request.headers.get("Content-Length") ?? 0);
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new BrokerError(413, "REQUEST_TOO_LARGE");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) throw new BrokerError(413, "REQUEST_TOO_LARGE");
      const body = Buffer.from(bytes).toString("utf8");
      const seconds = now() / 1_000;
      let nonce: string | undefined;
      if (hmacEnabled) {
        const keyId = request.headers.get("X-STS-Key-ID") ?? "";
        const timestamp = request.headers.get("X-STS-Timestamp") ?? "";
        nonce = request.headers.get("X-STS-Nonce") ?? "";
        const supplied = request.headers.get("X-STS-Signature") ?? "";
        if (keyId !== config.keyId || !/^\d{10,11}$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) {
          throw new BrokerError(401, "UNAUTHORIZED");
        }
        if (Math.abs(seconds - Number(timestamp)) > CLOCK_SKEW_SECONDS) throw new BrokerError(401, "EXPIRED_REQUEST");
        const expected = sign(config.secret!, ["STS-BROKER-V1", "POST", STS_BROKER_PATH, keyId, timestamp, nonce, digest(bytes)].join("\n"));
        if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))) throw new BrokerError(401, "UNAUTHORIZED");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new BrokerError(400, "INVALID_REQUEST"); }
      const { grant } = validateGrant(parsed, now());
      if (nonce) {
        for (const [entry, expiry] of seen) if (expiry < seconds) seen.delete(entry);
        if (seen.has(nonce)) throw new BrokerError(409, "REPLAYED_REQUEST");
        if (seen.size >= 10_000) throw new BrokerError(429, "TOO_MANY_REQUESTS");
        seen.set(nonce, seconds + CLOCK_SKEW_SECONDS);
      }
      let credentials: StsCredentials;
      try {
        credentials = await provider.get(grant);
      } catch (error) {
        throw new BrokerError(502, "CREDENTIAL_EXCHANGE_FAILED", diagnostics(error));
      }
      const responseBody = JSON.stringify({ version: grant.version, credentials });
      const responseHeaders: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
      };
      if (nonce) responseHeaders["X-STS-Response-Signature"] = sign(config.secret!, ["STS-BROKER-RESPONSE-V1", nonce, digest(responseBody)].join("\n"));
      return new Response(responseBody, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (error) {
      const rejected = error instanceof BrokerError ? error : new BrokerError(500, "INTERNAL_ERROR");
      const requestId = randomUUID();
      if (rejected.status >= 500) console.warn(JSON.stringify({ event: "sts_broker_failed", code: rejected.code, requestId, ...(rejected.diagnostics ? { diagnostics: rejected.diagnostics } : {}) }));
      return json({ error: rejected.code, requestId, ...(rejected.diagnostics ? { diagnostics: rejected.diagnostics } : {}) }, rejected.status);
    }
  };
  return Object.assign(handler, { close: () => provider.close?.() });
}
