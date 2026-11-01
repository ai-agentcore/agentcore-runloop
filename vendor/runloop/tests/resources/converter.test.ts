import { describe, it, expect } from "vitest";
import { convertResources } from "@/resources/converter.js";
import type { Resource } from "@/types/resources.js";

describe("convertResources (no options)", () => {
  it("returns empty config for empty resources", () => {
    const result = convertResources([]);
    expect(result.mcpConfig.mcpServers).toEqual({});
    expect(result.systemPromptAppend).toBe("");
    expect(result.nonMcpResources).toBeUndefined();
  });

  it("MCP 聚合：下游 MCP 不再直写 codex mcp.json（无 extractNonMcp 时不返回 nonMcpResources）", () => {
    const result = convertResources([{
      resourceId: "r-remote", resourceName: "remote-tool", resourceType: "MCP", protocol: "mcp",
      mcpConfig: { transport: "http", url: "https://example.com/mcp" },
    }]);
    // 聚合模型：codex mcp.json 只放聚合器（由 runner 注入），下游 MCP 进 nonMcp.mcpServers，不写这里。
    expect(result.mcpConfig.mcpServers).toEqual({});
    expect(result.nonMcpResources).toBeUndefined();
  });

  it("does not turn FUNCTIONCALL tools into systemPromptAppend", () => {
    const result = convertResources([
      {
        resourceId: "r-calc",
        resourceName: "calculator",
        resourceType: "FUNCTIONCALL",
        protocol: "openapi",
        description: "Math operations",
        openapiConfig: {
          openapi: "3.0.0",
          servers: [{ url: "https://api.calc" }],
          paths: { "/add": { post: { operationId: "add" } } },
        },
      },
    ]);
    expect(result.systemPromptAppend).toBe("");
    expect(result.nonMcpResources).toBeUndefined();
  });

  it("does not turn SKILL tools into systemPromptAppend", () => {
    const result = convertResources([
      {
        resourceId: "r-review",
        resourceName: "code-review",
        resourceType: "SKILL",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
          paths: { "/skills/code-review/download": { get: { operationId: "download" } } },
        },
      },
    ]);
    expect(result.systemPromptAppend).toBe("");
    expect(result.nonMcpResources).toBeUndefined();
  });

  it("does not turn sandboxes into systemPromptAppend", () => {
    const result = convertResources([
      {
        resourceId: "sb-123",
        resourceName: "sandbox",
        resourceType: "SANDBOX",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://data.example/sandboxes/sb-123" }],
          paths: { "/contexts/execute": { post: { operationId: "sbx_exec" } } },
        },
      },
    ]);
    expect(result.systemPromptAppend).toBe("");
    expect(result.nonMcpResources).toBeUndefined();
  });

  it("does not turn sub-agents into systemPromptAppend", () => {
    const result = convertResources([
      {
        resourceId: "r-res",
        resourceName: "researcher",
        resourceType: "AGENT",
        protocol: "ag-ui",
        description: "Web research agent",
        openapiConfig: {
          servers: [{ url: "https://agent.example.com" }],
          paths: { "/invoke": { post: { operationId: "invoke" } } },
        },
        auth: { mode: "agentrun" },
      },
    ]);
    expect(result.systemPromptAppend).toBe("");
    expect(result.nonMcpResources).toBeUndefined();
  });

  it("handles mixed resource types", () => {
    const resources: Resource[] = [
      {
        resourceId: "r-mcp",
        resourceName: "mcp-tool",
        resourceType: "MCP",
        protocol: "mcp",
        mcpConfig: { transport: "stdio", command: "tool" },
      },
      {
        resourceId: "r-func",
        resourceName: "func-tool",
        resourceType: "FUNCTIONCALL",
        protocol: "openapi",
        description: "A function",
        openapiConfig: {
          servers: [{ url: "https://api.func" }],
          paths: { "/run": { post: { operationId: "run" } } },
        },
      },
      {
        resourceId: "r-skill",
        resourceName: "skill-tool",
        resourceType: "SKILL",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
          paths: { "/skills/skill-tool/download": { get: { operationId: "download" } } },
        },
      },
      {
        resourceId: "sb-1",
        resourceName: "sandbox",
        resourceType: "SANDBOX",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://data.example/sandboxes/sb-1" }],
          paths: { "/contexts/execute": { post: { operationId: "sbx_exec" } } },
        },
      },
      {
        resourceId: "r-helper",
        resourceName: "helper",
        resourceType: "AGENT",
        protocol: "ag-ui",
        description: "helps",
        openapiConfig: {
          servers: [{ url: "https://helper.example.com" }],
          paths: { "/invoke": { post: { operationId: "invoke" } } },
        },
      },
    ];
    const result = convertResources(resources);
    // 聚合：MCP 不再进 codex mcp.json（容器空）；无 extractNonMcp 故 nonMcpResources 不返回。
    expect(Object.keys(result.mcpConfig.mcpServers)).toHaveLength(0);
    expect(result.systemPromptAppend).toBe("");
    expect(result.nonMcpResources).toBeUndefined();
  });
});

describe("convertResources (with extractNonMcp)", () => {
  it("extracts non-MCP resources into nonMcpResources", () => {
    const resources: Resource[] = [
      {
        resourceId: "r-fc1",
        resourceName: "fc1",
        resourceType: "FUNCTIONCALL",
        protocol: "openapi",
        description: "f",
        openapiConfig: {
          servers: [{ url: "https://api.fc1" }],
          paths: { "/run": { post: { operationId: "fc1_run" } } },
        },
      },
      {
        resourceId: "r-sk1",
        resourceName: "sk1",
        resourceType: "SKILL",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
          paths: { "/skills/sk1/download": { get: { operationId: "download" } } },
        },
      },
      {
        resourceId: "r-bot",
        resourceName: "bot",
        resourceType: "AGENT",
        protocol: "ag-ui",
        openapiConfig: {
          servers: [{ url: "https://bot.example.com" }],
          paths: { "/invoke": { post: { operationId: "invoke" } } },
        },
        auth: { mode: "agentrun" },
      },
      {
        resourceId: "sb1",
        resourceName: "sb1",
        resourceType: "SANDBOX",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://data.example/sandboxes/sb1" }],
          paths: { "/contexts/execute": { post: { operationId: "sbx_exec" } } },
        },
      },
    ];
    const result = convertResources(resources, { extractNonMcp: true });

    expect(result.systemPromptAppend).toBe("");
    expect(result.nonMcpResources).toBeDefined();
    expect(result.nonMcpResources!.tools).toHaveLength(1);
    expect(result.nonMcpResources!.skills).toHaveLength(1);
    expect(result.nonMcpResources!.subAgents).toHaveLength(1);
    expect(result.nonMcpResources!.sandboxes).toHaveLength(1);
  });

  it("keeps MCP tools in mcpConfig", () => {
    const resources: Resource[] = [
      {
        resourceId: "r-mcp1",
        resourceName: "mcp1",
        resourceType: "MCP",
        protocol: "mcp",
        mcpConfig: { transport: "stdio", command: "mcp" },
      },
      {
        resourceId: "r-fc1",
        resourceName: "fc1",
        resourceType: "FUNCTIONCALL",
        protocol: "openapi",
        description: "f",
        openapiConfig: {
          servers: [{ url: "https://api.fc1" }],
          paths: { "/run": { post: { operationId: "fc1_run" } } },
        },
      },
    ];
    const result = convertResources(resources, { extractNonMcp: true });

    // 聚合：MCP 进 nonMcp.mcpServers，codex mcp.json 容器空；func 进 tools。
    expect(Object.keys(result.mcpConfig.mcpServers)).toHaveLength(0);
    expect(result.nonMcpResources?.mcpServers).toHaveLength(1);
    expect(result.nonMcpResources?.tools).toHaveLength(1);
  });

  it("MCP-only：nonMcpResources 含 mcpServers（聚合后不再 undefined）", () => {
    const resources: Resource[] = [
      {
        resourceId: "r-mcp1",
        resourceName: "mcp1",
        resourceType: "MCP",
        protocol: "mcp",
        mcpConfig: { transport: "http", url: "https://h/mcp" },
        toolManifest: [{ name: "t1" }],
      } as Resource,
    ];
    const result = convertResources(resources, { extractNonMcp: true });
    expect(result.nonMcpResources?.mcpServers).toHaveLength(1);
  });

  it("returns undefined nonMcpResources for empty resources", () => {
    const result = convertResources([], { extractNonMcp: true });
    expect(result.nonMcpResources).toBeUndefined();
  });

  it("collects knowledge bases and memories into nonMcpResources tools", () => {
    const resources: Resource[] = [
      {
        resourceId: "r-kb1",
        resourceName: "kb1",
        resourceType: "KNOWLEDGE_BASE",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://api.kb1" }],
          paths: { "/retrieve": { post: { operationId: "kb1_retrieve" } } },
        },
      },
      {
        resourceId: "r-mem1",
        resourceName: "mem1",
        resourceType: "MEMORY",
        protocol: "openapi",
        description: "long-term",
        openapiConfig: {
          servers: [{ url: "https://api.mem1" }],
          paths: { "/query": { post: { operationId: "mem1_query" } } },
        },
      },
    ];
    const result = convertResources(resources, { extractNonMcp: true });
    // KNOWLEDGE_BASE / MEMORY fold into the generic `tools` bucket.
    expect(result.nonMcpResources?.tools).toHaveLength(2);
    const names = result.nonMcpResources?.tools.map((t) => t.resourceName);
    expect(names).toContain("kb1");
    expect(names).toContain("mem1");
  });
});
