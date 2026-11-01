import { describe, it, expect } from "vitest";
import { JsonResourceLoader, CliResourceLoader } from "@/resources/loader.js";

describe("JsonResourceLoader", () => {
  it("loads valid resources from JSON data", async () => {
    const data = [
      {
        resourceId: "mcp-1",
        resourceName: "test-tool",
        resourceType: "MCP",
        protocol: "mcp",
        description: "a tool",
        mcpConfig: { transport: "stdio" },
      },
      {
        resourceId: "agent-1",
        resourceName: "test-agent",
        resourceType: "AGENT",
        protocol: "ag-ui",
        description: "an agent",
        openapiConfig: {
          servers: [{ url: "https://agent.example" }],
          paths: { "/invoke": { post: { operationId: "invoke" } } },
        },
      },
      {
        resourceId: "sb-1",
        resourceName: "test-sandbox",
        resourceType: "SANDBOX",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://data.example/sandboxes/sb-1" }],
          paths: { "/contexts/execute": { post: { operationId: "sbx_exec" } } },
        },
      },
    ];

    const loader = new JsonResourceLoader(data);
    const resources = await loader.load();

    expect(resources).toHaveLength(3);
    expect(resources[0].resourceType).toBe("MCP");
    expect(resources[0].resourceName).toBe("test-tool");
    expect(resources[1].resourceType).toBe("AGENT");
    expect(resources[2].resourceType).toBe("SANDBOX");
  });

  it("loads empty resources", async () => {
    const loader = new JsonResourceLoader([]);
    const resources = await loader.load();
    expect(resources).toHaveLength(0);
  });

  it("throws on invalid data", async () => {
    const loader = new JsonResourceLoader([{ invalid: true }]);
    await expect(loader.load()).rejects.toThrow();
  });

  it("validates resource types", async () => {
    const loader = new JsonResourceLoader([
      { resourceId: "x", resourceName: "t", resourceType: "INVALID", protocol: "openapi" },
    ]);
    await expect(loader.load()).rejects.toThrow();
  });
});

describe("CliResourceLoader", () => {
  it("loads resources from a command that outputs JSON", async () => {
    const json = JSON.stringify([
      {
        resourceId: "mcp-cli",
        resourceName: "cli-tool",
        resourceType: "MCP",
        protocol: "mcp",
        mcpConfig: { transport: "stdio" },
      },
    ]);
    const loader = new CliResourceLoader("sh", ["-c", `echo '${json}'`]);
    const resources = await loader.load();

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceName).toBe("cli-tool");
  });

  it("loads empty resources from command", async () => {
    const loader = new CliResourceLoader("sh", ["-c", "echo '[]'"]);
    const resources = await loader.load();
    expect(resources).toHaveLength(0);
  });

  it("throws when command fails", async () => {
    const loader = new CliResourceLoader("nonexistent_command_12345");
    await expect(loader.load()).rejects.toThrow();
  });

  it("throws when command outputs invalid JSON", async () => {
    const loader = new CliResourceLoader("echo", ["not json"]);
    await expect(loader.load()).rejects.toThrow();
  });

  it("throws when command outputs invalid resource schema", async () => {
    const loader = new CliResourceLoader("sh", [
      "-c",
      `echo '[{"invalid":true}]'`,
    ]);
    await expect(loader.load()).rejects.toThrow();
  });
});
