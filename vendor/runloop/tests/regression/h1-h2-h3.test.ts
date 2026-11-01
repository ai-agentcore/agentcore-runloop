import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/loop/prompt-builder.js";
import { convertResources } from "@/resources/converter.js";
import { createApp } from "@/server/index.js";
import type { Resource } from "@/types/resources.js";
import type { RunRequest } from "@/types/api.js";

describe("H2: Resource injection completeness", () => {
  it("extracts sub-agents to nonMcpResources and describes them in the system prompt", () => {
    const resources: Resource[] = [
      {
        resourceId: "agent-researcher",
        resourceName: "researcher",
        resourceType: "AGENT",
        description: "Research agent",
        protocol: "ag-ui",
        openapiConfig: {
          servers: [{ url: "https://acct.agentrun-data.cn-hangzhou.aliyuncs.com" }],
          paths: { "/invoke": { post: { operationId: "invoke" } } },
        },
        auth: { mode: "agentrun" },
      } as Resource,
    ];

    const prompt = buildSystemPrompt({ resources } as unknown as RunRequest);
    expect(prompt).toContain("researcher");

    const withOpts = convertResources(resources, { extractNonMcp: true });
    expect(withOpts.nonMcpResources).toBeDefined();
    expect(withOpts.nonMcpResources!.subAgents[0].resourceName).toBe("researcher");
  });

  it("extracts sandboxes to nonMcpResources and describes them in the system prompt", () => {
    const resources: Resource[] = [
      {
        resourceId: "sb-123",
        resourceName: "sb-123",
        resourceType: "SANDBOX",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://sandbox.example.com" }],
          paths: { "/exec": { post: { operationId: "sandbox_sb_123_exec", description: "exec in sandbox" } } },
        },
      } as Resource,
    ];

    const prompt = buildSystemPrompt({ resources } as unknown as RunRequest);
    // 工具名 = 净化 operationId（连字符→下划线，对齐 codex 不动点）
    expect(prompt).toContain("sandbox_sb_123_exec");

    const config = convertResources(resources, { extractNonMcp: true });
    // 扁平模型：sandbox 归入 nonMcpResources.sandboxes，稳定 id 走 resourceId
    expect(config.nonMcpResources?.sandboxes[0].resourceId).toBe("sb-123");
    expect(config.nonMcpResources?.sandboxes[0].resourceType).toBe("SANDBOX");
  });
});

describe("H3: Request body error handling", () => {
  it("returns 400 for malformed JSON body in /v1/run", async () => {
    const app = createApp();
    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON body in /v1/interrupt", async () => {
    const app = createApp();
    const res = await app.request("/v1/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid",
    });
    expect(res.status).toBe(400);
  });
});
