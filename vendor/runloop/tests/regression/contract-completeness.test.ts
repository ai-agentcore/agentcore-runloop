import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { chatCompletionChunkToResponsesEvents, createResponsesState } from "@/provider/translate-responses.js";
import { buildToolIndex } from "@/mcp/tool-registry.js";
import { callSubAgent } from "@/sidecar/sub-agent-caller.js";
import type { Resource, NonMcpResources } from "@/types/resources.js";

/**
 * 契约完备性测试：每条断言一个 spec/types 承诺的「契约行为」。这些原是审计发现、经红/绿确认的 silent-gap，
 * 现已修复 → 转为**正向回归守护**：finish_reason=length 收尾保文 / openapi 缺 operationId 派生回退 /
 * 子 agent auth.mode=none 不签名。若契约行为再被破坏，这些会转红。
 */

function startMockAgent(handler: (req: any, res: any) => void): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, server }));
  });
}

describe("契约完备性（确认 silent-gap 是否真漏）", () => {
  let mockServer: Server | null = null;
  afterEach(() => { if (mockServer) { mockServer.close(); mockServer = null; } });

  // 契约：Responses 翻译——模型因 max_tokens 截断（finish_reason=length）时，已累计的助手文本仍须被收尾
  // （codex 靠 response.output_item.done 生成 item.completed，见 L-018），否则整段回复丢失。
  it("Responses 翻译在 finish_reason=length 时仍收尾并保住已累计文本", () => {
    const state = createResponsesState("resp_len");
    chatCompletionChunkToResponsesEvents(
      { id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "部分回答" }, finish_reason: null }] } as never,
      state,
    );
    const out = chatCompletionChunkToResponsesEvents(
      { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "length" }] } as never,
      state,
    ).join("");

    expect(out).toContain("response.output_item.done");
    expect(out).toContain("部分回答");
  });

  // 契约：openapiConfig 每个 operation = 一个工具（spec/types：operationId 必须存在）。资源被收下却产出
  // 0 个工具、且全程无任何 warn/error = 静默吞掉（资源看着挂上、模型却调不到）。
  it("openapi 资源缺 operationId 不被静默吞掉（资源在 → 至少 1 个工具或显式报错）", () => {
    const noOpId = {
      resourceId: "fc", resourceName: "weather", resourceType: "FUNCTIONCALL", protocol: "openapi",
      openapiConfig: { openapi: "3.0.0", servers: [{ url: "https://x" }], paths: { "/w": { post: { summary: "查天气" } } } },
    } as Resource;
    const resources: NonMcpResources = { tools: [noOpId], skills: [], subAgents: [], sandboxes: [], mcpServers: [] };

    // 期望：要么派生出工具，要么 buildToolIndex 抛出可定位错误；当前是「静默 0 工具、不报错」。
    let tools: ReturnType<typeof buildToolIndex> = [];
    let threw = false;
    try { tools = buildToolIndex(resources); } catch { threw = true; }
    expect(threw || tools.length > 0).toBe(true);
  });

  // 契约：ResourceAuth.mode=none ⇒ runloop 只透传 headers、**不**注入 AGENTRUN 签名（openapi-caller / mcp-proxy 都尊重）。
  // 子 agent 委派也应尊重，否则外部 ag-ui/chat-completions 子 agent（靠 headers Bearer）被强行签名。
  it("子 agent 委派 auth.mode=none 时不注入 AGENTRUN 签名头", async () => {
    let captured: Record<string, string | string[] | undefined> = {};
    const { port, server } = await startMockAgent((req, res) => {
      captured = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"type":"RUN_FINISHED"}\n\n');
    });
    mockServer = server;

    const agent = {
      resourceId: "a1", resourceName: "bot", resourceType: "AGENT", protocol: "ag-ui",
      openapiConfig: { openapi: "3.0.0", servers: [{ url: `http://127.0.0.1:${port}` }], paths: { "/invoke": { post: { operationId: "invoke" } } } },
      auth: { mode: "none" },
    } as Resource;

    await callSubAgent(agent, "hi", { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou", accountId: "123" });
    expect(captured["agentrun-authorization"]).toBeUndefined();
  });
});
