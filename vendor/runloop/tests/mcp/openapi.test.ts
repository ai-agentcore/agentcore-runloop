import { describe, it, expect } from "vitest";
import {
  extractOperations,
  locateEntryOperation,
  joinUrl,
  deriveAgentEndpoint,
  deriveSkillDownloadUrl,
  delegationProtocol,
} from "@/mcp/openapi.js";
import type { Resource } from "@/types/resources.js";

const SERVER = "https://acct.agentrun-data.cn-hangzhou.aliyuncs.com";

describe("extractOperations", () => {
  it("returns [] for undefined config", () => {
    expect(extractOperations(undefined)).toEqual([]);
  });

  it("derives inputSchema from requestBody (application/json)", () => {
    const ops = extractOperations({
      servers: [{ url: SERVER }],
      paths: {
        "/weather": {
          post: {
            operationId: "getWeather",
            description: "查天气",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
                },
              },
            },
          },
        },
      },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      operationId: "getWeather",
      method: "post",
      path: "/weather",
      serverUrl: SERVER,
      description: "查天气",
    });
    expect(ops[0].inputSchema).toEqual({ type: "object", properties: { city: { type: "string" } }, required: ["city"] });
  });

  it("resolves requestBody $ref against components.schemas (FastAPI-style spec → concrete inputSchema, not bare $ref)", () => {
    // 上游（super-agent）现在原样透传平台 protocolSpec —— FastAPI 生成的 spec 用 $ref 引用 components。
    const ops = extractOperations({
      servers: [{ url: `${SERVER}/tools/fc-get-weather-jingsu` }],
      paths: {
        "/weather": {
          post: {
            operationId: "getWeatherByCity",
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/WeatherRequest" } } },
            },
          },
        },
      },
      components: {
        schemas: {
          WeatherRequest: {
            type: "object",
            properties: { city: { type: "string", description: "城市名称" } },
            required: ["city"],
          },
        },
      },
    });
    expect(ops).toHaveLength(1);
    // serverUrl 保留完整 /tools/{name}，joinUrl 后即 .../tools/fc-get-weather-jingsu/weather
    expect(ops[0].serverUrl).toBe(`${SERVER}/tools/fc-get-weather-jingsu`);
    // $ref 被解析成具体 schema（含 required:[city]），而不是 {$ref:...}
    expect(ops[0].inputSchema).toEqual({
      type: "object",
      properties: { city: { type: "string", description: "城市名称" } },
      required: ["city"],
    });
  });

  it("leaves unresolvable $ref untouched (no components / unknown name) instead of dropping it", () => {
    const ops = extractOperations({
      paths: {
        "/p": {
          post: {
            operationId: "op",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } },
          },
        },
      },
    });
    expect(ops[0].inputSchema).toEqual({ $ref: "#/components/schemas/Missing" });
  });

  it("derives inputSchema from parameters when no requestBody (required + optional + schema fallback)", () => {
    const ops = extractOperations({
      servers: [{ url: SERVER }],
      paths: {
        "/search": {
          get: {
            operationId: "search",
            summary: "搜索",
            parameters: [
              { name: "q", required: true, schema: { type: "string" } },
              { name: "limit" }, // 无 schema → 回落 {type:string}
              { invalid: "no-name" }, // 无 name → 跳过
            ],
          },
        },
      },
    });
    expect(ops[0].description).toBe("搜索");
    expect(ops[0].inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "string" } },
      required: ["q"],
    });
  });

  it("omits required[] when no parameter is required", () => {
    const ops = extractOperations({
      servers: [{ url: SERVER }],
      paths: { "/x": { get: { operationId: "x", parameters: [{ name: "a" }] } } },
    });
    expect(ops[0].inputSchema).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("skips non-HTTP methods and non-object operations; derives a fallback id when operationId is missing", () => {
    const ops = extractOperations({
      servers: [{ url: SERVER }],
      paths: {
        "/p": {
          post: { operationId: "ok" },
          parameters: [{ name: "shared" }], // 非 HTTP method（path-level parameters）→ 跳过
          get: { summary: "no operationId" }, // 无 operationId → 从 method+path 派生回退名（不再静默跳过）
          put: null, // 非对象 → 跳过
        },
      },
    });
    // post 有显式 id；get 缺 operationId → 派生 get__p（method_path 净化）；parameters/put 跳过。
    expect(ops.map((o) => o.operationId).sort()).toEqual(["get__p", "ok"]);
  });

  it("defaults serverUrl to '' when servers missing", () => {
    const ops = extractOperations({ paths: { "/p": { get: { operationId: "g" } } } });
    expect(ops[0].serverUrl).toBe("");
  });
});

describe("locateEntryOperation", () => {
  const single = extractOperations({ servers: [{ url: SERVER }], paths: { "/only": { post: { operationId: "whatever" } } } });
  const multi = extractOperations({
    servers: [{ url: SERVER }],
    paths: { "/invoke": { post: { operationId: "invoke" } }, "/cancel": { post: { operationId: "cancel" } } },
  });

  it("single operation → used directly regardless of reserved id", () => {
    expect(locateEntryOperation(single, "invoke")?.operationId).toBe("whatever");
  });
  it("multiple operations → matches reserved id", () => {
    expect(locateEntryOperation(multi, "invoke")?.operationId).toBe("invoke");
  });
  it("multiple operations without reserved id → undefined", () => {
    expect(locateEntryOperation(multi, "download")).toBeUndefined();
  });
});

describe("joinUrl", () => {
  it("returns path when serverUrl is empty (SANDBOX_TEMPLATE lazy fill)", () => {
    expect(joinUrl("", "/contexts/execute")).toBe("/contexts/execute");
  });
  it("joins trailing-slash server + leading-slash path without doubling", () => {
    expect(joinUrl("https://h/", "/p")).toBe("https://h/p");
  });
  it("adds a slash when path has no leading slash", () => {
    expect(joinUrl("https://h", "p")).toBe("https://h/p");
  });
});

function agent(overrides: Partial<Resource>): Resource {
  return {
    resourceId: "agt-1",
    resourceName: "researcher",
    resourceType: "AGENT",
    protocol: "ag-ui",
    ...overrides,
  } as Resource;
}

describe("deriveAgentEndpoint", () => {
  it("derives endpoint from the invoke entry operation", () => {
    const url = deriveAgentEndpoint(
      agent({ openapiConfig: { servers: [{ url: SERVER }], paths: { "/invoke": { post: { operationId: "invoke" } } } } }),
    );
    expect(url).toBe(`${SERVER}/invoke`);
  });
  it("returns '' when no entry operation can be located", () => {
    expect(deriveAgentEndpoint(agent({ openapiConfig: { servers: [{ url: SERVER }], paths: {} } }))).toBe("");
    expect(deriveAgentEndpoint(agent({}))).toBe("");
  });
});

describe("deriveSkillDownloadUrl", () => {
  it("derives the download endpoint", () => {
    const url = deriveSkillDownloadUrl(
      agent({
        resourceType: "SKILL",
        protocol: "openapi",
        openapiConfig: { servers: [{ url: SERVER }], paths: { "/skills/x/download": { get: { operationId: "download" } } } },
      }),
    );
    expect(url).toBe(`${SERVER}/skills/x/download`);
  });
  it("returns '' when no download operation", () => {
    expect(deriveSkillDownloadUrl(agent({ resourceType: "SKILL", openapiConfig: {} }))).toBe("");
  });
});

describe("delegationProtocol", () => {
  it("maps protocol to delegation protocol, defaulting ag-ui", () => {
    expect(delegationProtocol(agent({ protocol: "chat-completions" }))).toBe("chat-completions");
    expect(delegationProtocol(agent({ protocol: "runloop" }))).toBe("runloop");
    expect(delegationProtocol(agent({ protocol: "a2a" }))).toBe("a2a");
    expect(delegationProtocol(agent({ protocol: "ag-ui" }))).toBe("ag-ui");
    expect(delegationProtocol(agent({ protocol: "openapi" }))).toBe("ag-ui");
    expect(delegationProtocol(agent({ protocol: "mcp" }))).toBe("ag-ui");
  });
});
