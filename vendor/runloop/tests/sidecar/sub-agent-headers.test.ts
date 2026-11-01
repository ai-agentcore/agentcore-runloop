import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { callSubAgent } from "@/sidecar/sub-agent-caller.js";
import { __setAgentrunHostCheckForTest } from "@/sidecar/ssrf.js";
import type { Resource } from "@/types/resources.js";

const creds = { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou", accountId: "123" };

describe("callSubAgent — header merge precedence (档1 headers passthrough)", () => {
  let server: Server | null = null;
  beforeEach(() => __setAgentrunHostCheckForTest(false)); // 连本地 mock；R1 拦截另由专门用例覆盖
  afterEach(() => { server?.close(); server = null; __setAgentrunHostCheckForTest(true); });

  it("merges global headers + resource headers; runloop signing header wins", async () => {
    let received: Record<string, string | string[] | undefined> = {};
    const { port } = await new Promise<{ port: number }>((resolve) => {
      server = createServer((req, res) => {
        received = req.headers;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => resolve({ port: (server!.address() as { port: number }).port }));
    });

    const agent: Resource = {
      resourceId: "a1", resourceName: "bot", resourceType: "AGENT",
      protocol: "ag-ui",
      openapiConfig: {
        openapi: "3.0.0",
        servers: [{ url: `http://127.0.0.1:${port}` }],
        paths: { "/invoke": { post: { operationId: "invoke" } } },
      },
      headers: { "X-Resource-Level": "res", "X-Shared": "from-resource" },
      auth: { mode: "agentrun" },
    };

    await callSubAgent(agent, "task", creds, {
      globalHeaders: { "X-Global": "glob", "X-Shared": "from-global" },
    });

    // global header present
    expect(received["x-global"]).toBe("glob");
    // resource-level header present and overrides the global with same name
    expect(received["x-resource-level"]).toBe("res");
    expect(received["x-shared"]).toBe("from-resource");
    // runloop signing header always present (wins)
    expect(received["agentrun-authorization"]).toBeDefined();
  });
});
