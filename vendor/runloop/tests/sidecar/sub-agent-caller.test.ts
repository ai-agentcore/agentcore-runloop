import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { callSubAgent, resolveSubAgentTimeouts } from "@/sidecar/sub-agent-caller.js";
import { __setSsrfLookupForTest } from "@/sidecar/ssrf.js";
import type { RunloopEvent } from "@/types/events.js";
import type { Resource } from "@/types/resources.js";

// agentResource 用 auth.mode=agentrun + 本地 mock（127.0.0.1）端点验证签名/SSE 管路；agentrun 域名白名单
// （R1）会拦 loopback，故管路类用例临时关校验（不削弱生产），SSRF 拦截行为另由专门用例覆盖。



function startMockAgent(handler: (req: any, res: any) => void): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, server });
    });
  });
}

/**
 * 构建扁平 AGENT Resource：委派端点由 openapiConfig 的 `invoke` operation 派生
 * （serverUrl + /invoke）；协议 = protocol。serverUrl 省略时不带 server（端点为空）。
 */
function agentResource(opts: {
  resourceName: string;
  protocol?: "ag-ui" | "chat-completions" | "runloop" | "a2a";
  serverUrl?: string;
  headers?: Record<string, string>;
  serverManagesHistory?: boolean;
}): Resource {
  const { resourceName, protocol = "ag-ui", serverUrl, headers, serverManagesHistory } = opts;
  // 无 serverUrl 时不给 invoke operation → deriveAgentEndpoint 返回 ""（无可派生端点）
  const openapiConfig: Record<string, unknown> = serverUrl
    ? { openapi: "3.0.0", servers: [{ url: serverUrl }], paths: { "/invoke": { post: { operationId: "invoke" } } } }
    : { openapi: "3.0.0", paths: {} };
  return {
    resourceId: "r1",
    resourceName,
    resourceType: "AGENT",
    protocol,
    openapiConfig,
    ...(headers ? { headers } : {}),
    ...(serverManagesHistory !== undefined ? { serverManagesHistory } : {}),
    auth: { mode: "none" },
  } as Resource;
}

function sseResponse(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join("");
}

describe("callSubAgent", () => {
  let mockServer: Server | null = null;

  afterEach(() => {
    if (mockServer) {
      mockServer.close();
      mockServer = null;
    }
  });

  const creds = {
    accessKeyId: "ak",
    accessKeySecret: "sk",
    region: "cn-hangzhou",
    accountId: "123",
  };

  it("accumulates text from ag-ui SSE events", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "太阳" }),
        JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "从东方升起" }),
        JSON.stringify({ type: "RUN_FINISHED" }),
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "test", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "太阳从哪里升起", creds);

    expect(result).toBe("太阳从东方升起");
  });

  it("ag-ui RUN_ERROR (HTTP 200) → 结构化终态错误（isError/terminal/hint），不报成功 (H10)", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ type: "RUN_STARTED" }),
        JSON.stringify({ type: "RUN_ERROR", message: "downstream 503" }),
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "test", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "task", creds);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("downstream 503");
    expect(parsed.isError).toBe(true);
    expect(parsed.terminal).toBe(true);
    expect(parsed.hint).toContain("勿自动重试");
    // 首键为 error → tool-registry 的 startsWith('{"error"') 判定会置 isError=true。
    expect(result.startsWith('{"error"')).toBe(true);
  });

  it("runloop run.error (HTTP 200) → 结构化终态错误，不回落 no text output (H10)", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ type: "run.start" }),
        JSON.stringify({ type: "run.error", error: { code: "LOOP_ERROR", message: "boom" } }),
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "test", protocol: "runloop", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "task", creds);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("boom");
    expect(parsed.isError).toBe(true);
    expect(parsed.terminal).toBe(true);
  });

  it("accumulates text from chat-completions SSE chunks when protocol is chat-completions", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "cnVu" }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: { content: "bG9vcA==" }, index: 0 }] }),
        "[DONE]",
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "base64-bot", protocol: "chat-completions", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "runloop", creds);

    expect(result).toBe("cnVubG9vcA==");
  });

  it("sends an OpenAI chat-completions body for chat-completions protocol", async () => {
    let receivedBody = "";
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, index: 0 }] }),
          "[DONE]",
        ]));
        res.end();
      });
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "base64-bot", protocol: "chat-completions", serverUrl: `http://127.0.0.1:${port}` });
    await callSubAgent(agent, "runloop", creds);

    const parsed = JSON.parse(receivedBody);
    expect(parsed.model).toBe("base64-bot");
    expect(parsed.stream).toBe(true);
    expect(parsed.messages).toEqual([{ role: "user", content: "runloop" }]);
  });

  it("resume：ag-ui 子 agent 发 RunAgentInput（messages + forwardedProps.resume），不发 runloop {events}", async () => {
    let receivedBody = "";
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
      });
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "agui-bot", protocol: "ag-ui", serverUrl: `http://127.0.0.1:${port}` });
    await callSubAgent(agent, "", creds, {
      resumeEvents: [
        { type: "user.message", content: "把表删了", id: "x", timestamp: 1, conversationId: "c" },
        { type: "user.command", command: "resolve", toolCallId: "tc-1", selectedOptionId: "approve", id: "y", timestamp: 2, conversationId: "c" },
      ],
    });

    const parsed = JSON.parse(receivedBody);
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.events).toBeUndefined(); // 不再错发 runloop 协议
    expect(parsed.forwardedProps?.resume?.selectedOptionId).toBe("approve");
    expect(parsed.forwardedProps?.resume?.toolCallId).toBe("tc-1");
  });

  it("resume：runloop 子 agent 仍发 {events, credentials}", async () => {
    let receivedBody = "";
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "run.end" })}\n\n`);
        res.end();
      });
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "runloop-bot", protocol: "runloop", serverUrl: `http://127.0.0.1:${port}` });
    await callSubAgent(agent, "", creds, {
      resumeEvents: [{ type: "user.command", command: "resolve", toolCallId: "tc-1", selectedOptionId: "approve", id: "y", timestamp: 2, conversationId: "c" }],
    });

    const parsed = JSON.parse(receivedBody);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.messages).toBeUndefined();
  });

  it("resume：ag-ui interruptId 用子 interrupt id（toolCallId），不用父 targetEventId（嵌套 HITL 死循环根因）", async () => {
    // 预发实锤：super_agent 重建的 user.command 同时带 targetEventId（父 suspend 事件 id，如 e_xxx，runloop nanoid）
    // + toolCallId（子 agent 自己的 interrupt id hitl_auth_r1_...）。aguiResumeEntry 旧实现用 targetEventId →
    // 子 agent parseTaskId("e_xxx") 失败 → HITL_RESUME_REJECTED → 父看到委派失败 → 重新委派 → 死循环。
    // 子 agent 要的是它自己发出的 interrupt id（= toolCallId），父的 targetEventId 对它毫无意义。
    let receivedBody = "";
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "agui-bot", protocol: "ag-ui", serverUrl: `http://127.0.0.1:${port}` });
    await callSubAgent(agent, "", creds, {
      conversationId: "c", toolCallId: "delegate-A",
      resumeEvents: [
        { type: "user.command", command: "resolve", targetEventId: "e_parentSuspendNanoid", toolCallId: "hitl_auth_r1_1782800233064_fi1vq9", selectedOptionId: "approve", payload: { action: "confirm" }, id: "y", timestamp: 2, conversationId: "c" },
      ],
    });
    const parsed = JSON.parse(receivedBody);
    expect(parsed.resume?.[0]?.interruptId).toBe("hitl_auth_r1_1782800233064_fi1vq9"); // 子 interrupt id，可被 parseTaskId 解析
    expect(parsed.resume?.[0]?.interruptId).not.toBe("e_parentSuspendNanoid"); // 绝不能用父级 nanoid
  });

  // ── 会话能力契约（serverManagesHistory）+ 一致 threadId（嵌套 HITL 跨实例恢复的产品级修复）──
  it("ag-ui 委派 body 带确定性 threadId：同 conversationId+toolCallId → 同 threadId，不同委派 → 不同", async () => {
    const bodies: string[] = [];
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "agui-bot", protocol: "ag-ui", serverUrl: `http://127.0.0.1:${port}` });
    await callSubAgent(agent, "task1", creds, { conversationId: "conv-1", toolCallId: "delegate-A" });
    await callSubAgent(agent, "task2", creds, { conversationId: "conv-1", toolCallId: "delegate-A" });
    await callSubAgent(agent, "task3", creds, { conversationId: "conv-1", toolCallId: "delegate-B" });
    const t1 = JSON.parse(bodies[0]).threadId as string;
    expect(typeof t1).toBe("string");
    expect(t1.length).toBeGreaterThan(0);
    expect(JSON.parse(bodies[1]).threadId).toBe(t1); // 同委派 → 同 thread（run1 委派与 run2 resume 能对上）
    expect(JSON.parse(bodies[2]).threadId).not.toBe(t1); // 不同委派 toolCallId → 不同 thread
  });

  it("resume + serverManagesHistory=false（默认无状态）→ 完整 messages（含原始任务）+ threadId + 标准 resume[]", async () => {
    let receivedBody = "";
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "agui-bot", protocol: "ag-ui", serverUrl: `http://127.0.0.1:${port}`, serverManagesHistory: false });
    await callSubAgent(agent, "", creds, {
      conversationId: "c", toolCallId: "delegate-A",
      resumeEvents: [
        { type: "user.message", content: "授权给所有人阅读权限", id: "u", timestamp: 1, conversationId: "c" },
        { type: "user.command", command: "resolve", toolCallId: "hitl-1", selectedOptionId: "approve", id: "y", timestamp: 2, conversationId: "c" },
      ],
    });
    const parsed = JSON.parse(receivedBody);
    expect(JSON.stringify(parsed.messages)).toContain("授权给所有人阅读权限"); // 无状态 → 下发完整历史（含原始任务）
    expect(parsed.threadId).toBeTruthy();
    expect(parsed.resume?.[0]?.interruptId).toBe("hitl-1"); // 标准 ag-ui resume[] 仍带恢复标识
  });

  it("resume + serverManagesHistory=true（服务端自管会话）→ 只发增量（不含原始任务）+ 一致 threadId + resume[]", async () => {
    let receivedBody = "";
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "agui-bot", protocol: "ag-ui", serverUrl: `http://127.0.0.1:${port}`, serverManagesHistory: true });
    await callSubAgent(agent, "", creds, {
      conversationId: "c", toolCallId: "delegate-A",
      resumeEvents: [
        { type: "user.message", content: "授权给所有人阅读权限", id: "u", timestamp: 1, conversationId: "c" },
        { type: "user.command", command: "resolve", toolCallId: "hitl-1", selectedOptionId: "approve", id: "y", timestamp: 2, conversationId: "c" },
      ],
    });
    const parsed = JSON.parse(receivedBody);
    expect(JSON.stringify(parsed.messages)).not.toContain("授权给所有人阅读权限"); // 自管会话 → 只发增量、不重发历史
    expect(parsed.threadId).toBeTruthy(); // 靠 threadId 关联到服务端已存的会话
    expect(parsed.resume?.[0]?.interruptId).toBe("hitl-1");
  });

  it("emits events through callback", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "hello" }),
      ]));
      res.end();
    });
    mockServer = server;

    const emitted: RunloopEvent[] = [];
    const agent = agentResource({ resourceName: "test", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "test", creds, {
      emit: (e) => emitted.push(e),
      conversationId: "s1",
      toolCallId: "tc-1",
    });

    // ag-ui TEXT_MESSAGE_CONTENT → message.delta with parentToolCallId
    expect(emitted.length).toBe(1);
    expect(emitted[0].type).toBe("message.delta");
    expect((emitted[0] as any).content).toBe("hello");
    expect((emitted[0] as any).parentToolCallId).toBe("tc-1");
    expect(result).toBe("hello");
  });

  it("maps ag-ui 子 agent 思考流 REASONING_* → reasoning.* 注入父流（附记修复，集成路径）", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ type: "REASONING_START" }),                                   // 外层包裹 → 忽略
        JSON.stringify({ type: "REASONING_MESSAGE_START" }),                           // → reasoning.start
        JSON.stringify({ type: "REASONING_MESSAGE_CONTENT", delta: "先分析" }),          // → reasoning.delta
        JSON.stringify({ type: "REASONING_MESSAGE_CONTENT", delta: "再回答" }),          // → reasoning.delta
        JSON.stringify({ type: "REASONING_MESSAGE_END" }),                             // → reasoning.end
        JSON.stringify({ type: "REASONING_END" }),                                     // 外层包裹 → 忽略
        JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "答案" }),
        JSON.stringify({ type: "RUN_FINISHED" }),
      ]));
      res.end();
    });
    mockServer = server;

    const emitted: RunloopEvent[] = [];
    const agent = agentResource({ resourceName: "test", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "task", creds, { emit: (e) => emitted.push(e), conversationId: "s1", toolCallId: "tc-1" });

    const types = emitted.map((e) => e.type);
    // 干净的 reasoning 三件套（外层 REASONING_START/END 被忽略，不双 start/end）+ 文本。
    expect(types).toEqual(["reasoning.start", "reasoning.delta", "reasoning.delta", "reasoning.end", "message.delta"]);
    expect(emitted.every((e) => (e as any).parentToolCallId === "tc-1")).toBe(true);
    // 思考流不计入返回给父 codex 的文本 result（仅 message.delta 累积）。
    expect(result).toBe("答案");
  });

  // ── A2A（Agent2Agent）协议委派 ──────────────────────────────────────────
  it("sends a JSON-RPC message/stream body for a2a protocol", async () => {
    let receivedBody = "";
    const { port, server } = await startMockAgent((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", status: { state: "completed" }, final: true } })}\n\n`);
        res.end();
      });
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "a2a-bot", protocol: "a2a", serverUrl: `http://127.0.0.1:${port}` });
    await callSubAgent(agent, "runloop", creds);

    const parsed = JSON.parse(receivedBody);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("message/stream");
    expect(parsed.params.message.role).toBe("user");
    expect(parsed.params.message.parts).toEqual([{ kind: "text", text: "runloop" }]);
    expect(parsed.params.message.kind).toBe("message");
    expect(typeof parsed.params.message.messageId).toBe("string");
    expect(parsed.params.message.messageId.length).toBeGreaterThan(0);
  });

  it("accumulates text from a2a artifact-update + status-update(completed) stream", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "artifact-update", taskId: "t1", artifact: { parts: [{ kind: "text", text: "cnVu" }] }, append: true } }),
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "artifact-update", taskId: "t1", artifact: { parts: [{ kind: "text", text: "bG9vcA==" }] }, append: true, lastChunk: true } }),
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", taskId: "t1", status: { state: "completed" }, final: true } }),
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "a2a-bot", protocol: "a2a", serverUrl: `http://127.0.0.1:${port}` });
    expect(await callSubAgent(agent, "runloop", creds)).toBe("cnVubG9vcA==");
  });

  it("a2a JSON-RPC error 信封 (HTTP 200) → 结构化终态错误（H10）", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", status: { state: "working" }, final: false } }),
        JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32603, message: "a2a boom" } }),
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "a2a-bot", protocol: "a2a", serverUrl: `http://127.0.0.1:${port}` });
    const parsed = JSON.parse(await callSubAgent(agent, "task", creds));
    expect(parsed.error).toBe("a2a boom");
    expect(parsed.isError).toBe(true);
    expect(parsed.terminal).toBe(true);
  });

  it("a2a task 终态 failed → 结构化终态错误（取 status.message 文本）", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", taskId: "t1", status: { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: "downstream 503" }] } }, final: true } }),
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "a2a-bot", protocol: "a2a", serverUrl: `http://127.0.0.1:${port}` });
    const parsed = JSON.parse(await callSubAgent(agent, "task", creds));
    expect(parsed.error).toContain("downstream 503");
    expect(parsed.isError).toBe(true);
    expect(parsed.terminal).toBe(true);
  });

  it("a2a input-required → callSubAgent 返回 __hitl_suspended 标记（嵌套 HITL 向上透传）", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "task", id: "task-x", status: { state: "submitted" } } }),
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", taskId: "task-x", status: { state: "input-required", message: { role: "agent", parts: [{ kind: "text", text: "需要确认吗？" }] } }, final: false } }),
      ]));
      res.end();
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "a2a-bot", protocol: "a2a", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "做点事", creds, { emit: () => {}, conversationId: "s1", toolCallId: "tc-1" });
    const parsed = JSON.parse(result);
    expect(parsed.__hitl_suspended).toBe(true);
    expect(parsed.toolCallId).toBe("task-x"); // suspend 的 toolCallId = A2A taskId
  });

  it("a2a resume：发 message/stream 续接（带 taskId + payload.input），处理续接流文本", async () => {
    let body = "";
    const { port, server } = await startMockAgent((req, res) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c));
      req.on("end", () => {
        body = b;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseResponse([
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "artifact-update", artifact: { parts: [{ kind: "text", text: "DONE" }] } } }),
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", status: { state: "completed" }, final: true } }),
        ]));
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "a2a-bot", protocol: "a2a", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "", creds, {
      resumeEvents: [
        { type: "toolcall.suspend", toolCallId: "task-9", id: "s", timestamp: 1, conversationId: "c" },
        { type: "user.command", command: "resolve", toolCallId: "task-9", selectedOptionId: "approve", payload: { input: "继续吧" }, id: "r", timestamp: 2, conversationId: "c" },
      ],
    });
    const parsed = JSON.parse(body);
    expect(parsed.method).toBe("message/stream");
    expect(parsed.params.message.taskId).toBe("task-9");
    expect(parsed.params.message.parts[0].text).toBe("继续吧");
    expect(result).toBe("DONE");
  });

  it("a2a message event → message.delta 经 emit 注入（parentToolCallId 透传）", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "message", role: "agent", parts: [{ kind: "text", text: "hello" }] } }),
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", status: { state: "completed" }, final: true } }),
      ]));
      res.end();
    });
    mockServer = server;

    const emitted: RunloopEvent[] = [];
    const agent = agentResource({ resourceName: "a2a-bot", protocol: "a2a", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "test", creds, { emit: (e) => emitted.push(e), conversationId: "s1", toolCallId: "tc-1" });

    const delta = emitted.find((e) => e.type === "message.delta") as any;
    expect(delta.content).toBe("hello");
    expect(delta.parentToolCallId).toBe("tc-1");
    expect(result).toBe("hello");
  });

  it("a2a：委派端点为 agent-card URL → 先抓 card 解析 service endpoint 再 message/stream", async () => {
    let cardHit = false;
    let streamHit = false;
    let port = 0;
    const { port: p, server } = await startMockAgent((req, res) => {
      if (req.url?.includes("agent-card.json")) {
        cardHit = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "bot", url: `http://127.0.0.1:${port}/a2a-svc` }));
        return;
      }
      streamHit = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "artifact-update", artifact: { parts: [{ kind: "text", text: "OK" }] } } }),
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "status-update", status: { state: "completed" }, final: true } }),
      ]));
      res.end();
    });
    mockServer = server;
    port = p;
    const agent = {
      resourceId: "r", resourceName: "bot", resourceType: "AGENT", protocol: "a2a",
      openapiConfig: { openapi: "3.0.0", servers: [{ url: `http://127.0.0.1:${p}` }], paths: { "/.well-known/agent-card.json": { post: { operationId: "invoke" } } } },
      auth: { mode: "none" },
    } as Resource;
    const result = await callSubAgent(agent, "hi", creds);
    expect(cardHit).toBe(true);
    expect(streamHit).toBe(true);
    expect(result).toBe("OK");
  });


  it("a2a：card 解析出的 endpoint 落私网 → SSRF 二次拦截（防 card 重定向绕过）", async () => {
    __setSsrfLookupForTest(async (host: string) => (host === "127.0.0.1" ? [{ address: "203.0.113.1" }] : [{ address: "10.0.0.5" }]));
    try {
      const { port, server } = await startMockAgent((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: "http://internal.evil/a2a" })); // 解析到私网
      });
      mockServer = server;
      const agent = {
        resourceId: "r", resourceName: "bot", resourceType: "AGENT", protocol: "a2a",
        openapiConfig: { openapi: "3.0.0", servers: [{ url: `http://127.0.0.1:${port}` }], paths: { "/.well-known/agent-card.json": { post: { operationId: "invoke" } } } },
        auth: { mode: "none" },
      } as Resource;
      const result = JSON.parse(await callSubAgent(agent, "hi", creds));
      expect(result.error).toMatch(/blocked/i);
    } finally {
      __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]);
    }
  });

  it("returns error JSON for non-200 response", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "test", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "test", creds);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("403");
  });

  it("returns error for missing url", async () => {
    // no openapiConfig → deriveAgentEndpoint returns "" → no derivable invoke endpoint
    const agent = agentResource({ resourceName: "test" });
    const result = await callSubAgent(agent, "test", creds);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("no url");
  });

  // 资源调用日志：记录委派出站请求（url+body）与响应（status+body），404 详情可直接定位（本次 prod 排查的缺口）。
  it("logs the delegation request and the 404 response body", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"detail":"Not Found"}');
    });
    mockServer = server;
    const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const log = {
      info: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "info", msg, fields: fields ?? {} }),
      warn: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "warn", msg, fields: fields ?? {} }),
      error: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "error", msg, fields: fields ?? {} }),
      debug: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "debug", msg, fields: fields ?? {} }),
    };

    const agent = agentResource({ resourceName: "search-bot", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "find btc price", creds, { log });
    expect(JSON.parse(result).error).toContain("404");

    const req = logs.find((l) => l.msg === "resource request");
    expect(req).toBeDefined();
    expect(req!.fields).toMatchObject({ target: "subagent", toolName: "search-bot", method: "POST" });
    expect(String(req!.fields.url)).toContain(`127.0.0.1:${port}/invoke`);
    expect(String(req!.fields.body)).toContain("find btc price");

    // 失败响应落 warn，且 body 带上 404 详情（{"detail":"Not Found"}）——这正是排障关键。
    const resp = logs.find((l) => l.msg === "resource response");
    expect(resp).toBeDefined();
    expect(resp!.level).toBe("warn");
    expect(resp!.fields).toMatchObject({ target: "subagent", status: 404, ok: false });
    expect(String(resp!.fields.body)).toContain("Not Found");
  });

  // 链路通（HTTP 200）但子 agent 内部失败、经普通 assistant 文本返回错误（如「模型不存在」）：
  // resource response 的 body 必须落下流式累积的真实内容，便于区分「链路问题 vs 子 agent 内部失败」。
  it("logs streamed sub-agent content as the 200 response body", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "❌ API call failed: Resource Model(ohyee-test) does not exist." }),
      ]));
      res.end();
    });
    mockServer = server;
    const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const log = {
      info: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "info", msg, fields: fields ?? {} }),
      warn: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "warn", msg, fields: fields ?? {} }),
      error: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "error", msg, fields: fields ?? {} }),
      debug: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: "debug", msg, fields: fields ?? {} }),
    };

    const agent = agentResource({ resourceName: "search-bot", serverUrl: `http://127.0.0.1:${port}` });
    await callSubAgent(agent, "btc price", creds, { log });

    const resp = logs.find((l) => l.msg === "resource response");
    expect(resp).toBeDefined();
    expect(resp!.level).toBe("info"); // 200 + 无 RUN_ERROR → ok:true（子 agent 把错误当普通文本返回）
    expect(resp!.fields).toMatchObject({ target: "subagent", status: 200, ok: true });
    expect(String(resp!.fields.body)).toContain("Resource Model(ohyee-test) does not exist");
  });

  it("handles timeout", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // never close — simulate hang
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "test", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "test", creds, { timeout: 500 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("timed out");
  }, 5000);

  it("handles MESSAGE_CHUNK event type", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseResponse([
        JSON.stringify({ type: "MESSAGE_CHUNK", chunk: "chunk1" }),
        JSON.stringify({ type: "MESSAGE_CHUNK", chunk: "chunk2" }),
      ]));
      res.end();
    });
    mockServer = server;

    const agent = agentResource({ resourceName: "test", serverUrl: `http://127.0.0.1:${port}` });
    const result = await callSubAgent(agent, "test", creds);
    expect(result).toBe("chunk1chunk2");
  });

});

describe("callSubAgent — 分支补全", () => {
  let mockServer: Server | null = null;
  afterEach(() => { if (mockServer) { mockServer.close(); mockServer = null; } });
  const creds = { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou", accountId: "123" };

  it("ag-ui resumeEvents → buildAgUiResumeBody（含 forwardedProps.resume + HITL 审批消息）", async () => {
    let body = "";
    const { port, server } = await startMockAgent((req, res) => {
      let b = ""; req.on("data", (c: Buffer) => (b += c)); req.on("end", () => {
        body = b;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseResponse([JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "ok" }), JSON.stringify({ type: "RUN_FINISHED" })]));
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "t", serverUrl: `http://127.0.0.1:${port}` });
    const resumeEvents = [
      { type: "user.message", role: "user", content: "hi", id: "u", timestamp: 1, conversationId: "c" },
      { type: "user.command", command: "resolve", toolCallId: "tc1", selectedOptionId: "approve", payload: { a: 1 }, id: "r", timestamp: 2, conversationId: "c" },
    ];
    await callSubAgent(agent, "", creds, { resumeEvents });
    const parsed = JSON.parse(body);
    expect(parsed.forwardedProps.resume).toMatchObject({ toolCallId: "tc1", selectedOptionId: "approve", payload: { a: 1 } });
    expect(JSON.stringify(parsed.messages)).toContain("HITL 审批结果");
  });

  // 复现 G2：AG-UI 现行 resume 协议要求前端在同 thread 发顶层 RunAgentInput.resume:
  // [{ interruptId, status:"resolved"|"cancelled", payload? }]（见 docs.ag-ui.com/concepts/interrupts）。
  // 当前 buildAgUiResumeBody 只塞 forwardedProps.resume（自定义约定），标准 ag-ui 子 agent 不读它。
  it("ag-ui resume → 应发标准顶层 RunAgentInput.resume 数组（复现 G2）", async () => {
    let body = "";
    const { port, server } = await startMockAgent((req, res) => {
      let b = ""; req.on("data", (c: Buffer) => (b += c)); req.on("end", () => {
        body = b;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseResponse([JSON.stringify({ type: "RUN_FINISHED" })]));
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "t", serverUrl: `http://127.0.0.1:${port}` });
    const resumeEvents = [
      { type: "user.command", command: "resolve", targetEventId: "int-1", toolCallId: "tc1", selectedOptionId: "approve", payload: { a: 1 }, id: "r", timestamp: 2, conversationId: "c" },
    ];
    await callSubAgent(agent, "", creds, { resumeEvents });
    const parsed = JSON.parse(body);
    expect(Array.isArray(parsed.resume), "应有标准顶层 resume 数组（当前仅 forwardedProps.resume）").toBe(true);
    expect(parsed.resume).toHaveLength(1);
    // interruptId 取子 interrupt id（toolCallId="tc1"），非父 targetEventId（"int-1")——见上「死循环根因」用例。
    expect(parsed.resume[0]).toMatchObject({ interruptId: "tc1", status: "resolved", payload: { a: 1 } });
  });

  // ── AG-UI interrupt resume status 语义（docs.ag-ui.com/concepts/interrupts）─────────
  // AG-UI 权威语义：「拒绝（denial）」是**有效答复** → status:"resolved" + payload 标明否决（{approved:false}）；
  // 只有「放弃/撂挑子（cancel）」才是 status:"cancelled"（且 payload 省略）。
  // 取回某次 ag-ui 委派 resume 体里的标准 resume[0]（mock 立即 RUN_FINISHED）。
  async function aguiResumeEntryOf(selectedOptionId: string, payload?: unknown): Promise<any> {
    let body = "";
    const { port, server } = await startMockAgent((req, res) => {
      let b = ""; req.on("data", (c: Buffer) => (b += c)); req.on("end", () => {
        body = b;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseResponse([JSON.stringify({ type: "RUN_FINISHED" })]));
        res.end();
      });
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "t", serverUrl: `http://127.0.0.1:${port}` });
    const cmd: Record<string, unknown> = { type: "user.command", command: "resolve", toolCallId: "tc1", selectedOptionId, id: "r", timestamp: 2, conversationId: "c" };
    if (payload !== undefined) cmd.payload = payload;
    await callSubAgent(agent, "", creds, { resumeEvents: [cmd] });
    return JSON.parse(body).resume[0];
  }

  it("ag-ui resume → reject 是有效答复：status=resolved + payload.approved=false（非 cancelled）", async () => {
    expect(await aguiResumeEntryOf("reject")).toEqual({ interruptId: "tc1", status: "resolved", payload: { approved: false } });
  });

  it("ag-ui resume → deny 同 reject：status=resolved + payload.approved=false", async () => {
    expect(await aguiResumeEntryOf("deny")).toEqual({ interruptId: "tc1", status: "resolved", payload: { approved: false } });
  });

  it("ag-ui resume → cancel 才是放弃：status=cancelled 且省略 payload（即使传了也不带）", async () => {
    const entry = await aguiResumeEntryOf("cancel", { ignored: true });
    expect(entry).toEqual({ interruptId: "tc1", status: "cancelled" });
    expect("payload" in entry).toBe(false);
  });

  it("ag-ui resume → approve：status=resolved，payload 原样透传（不注入 approved:false）", async () => {
    expect(await aguiResumeEntryOf("approve", { a: 1 })).toEqual({ interruptId: "tc1", status: "resolved", payload: { a: 1 } });
  });

  it("ag-ui resume → reject 且原本带对象 payload：合并后仍含原字段 + approved:false", async () => {
    expect(await aguiResumeEntryOf("reject", { note: "太危险" })).toEqual({ interruptId: "tc1", status: "resolved", payload: { approved: false, note: "太危险" } });
  });

  it("ag-ui resume → reject 时 payload 矛盾带 approved:true：approved:false 权威、不被翻盘（拒绝必须被尊重）", async () => {
    expect(await aguiResumeEntryOf("reject", { approved: true, note: "x" })).toEqual({ interruptId: "tc1", status: "resolved", payload: { approved: false, note: "x" } });
  });

  it("auth.mode≠agentrun（none）+ 私网端点 → SSRF 拦截返回 error（69/72/95）", async () => {
    // 全局 setup 注入的 SSRF 解析器放行 loopback；本例临时覆盖为「解析到私网」让 SSRF 真正拦截。
    __setSsrfLookupForTest(async () => [{ address: "10.0.0.5" }]);
    try {
      const agent = { resourceId: "r1", resourceName: "ext", resourceType: "AGENT", protocol: "ag-ui",
        openapiConfig: { openapi: "3.0.0", servers: [{ url: "http://internal.example/x" }], paths: { "/invoke": { post: { operationId: "invoke" } } } },
        auth: { mode: "none" } } as Resource;
      const r = JSON.parse(await callSubAgent(agent, "task", creds));
      expect(r.error).toMatch(/blocked sub-agent target/);
    } finally {
      __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]); // 恢复 setup 的放行解析器
    }
  });

  it("无 url（无 serverUrl）→ error", async () => {
    const agent = agentResource({ resourceName: "x" }); // 无 serverUrl → 无端点
    expect(JSON.parse(await callSubAgent(agent, "t", creds)).error).toMatch(/no url/);
  });


  it("SSE 含空 data 行 → 跳过、仍解析有效事件（156）", async () => {
    const { port, server } = await startMockAgent((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data:\n\ndata: \n\n" + sseResponse([JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "X" }), JSON.stringify({ type: "RUN_FINISHED" })]));
      res.end();
    });
    mockServer = server;
    const agent = agentResource({ resourceName: "t", serverUrl: `http://127.0.0.1:${port}` });
    expect(await callSubAgent(agent, "task", creds)).toBe("X");
  });

  // ── 超时（总时长 1h 硬顶 + 空闲断开） ──────────────────────────────────────
  describe("timeouts", () => {
    it("resolveSubAgentTimeouts: 默认 1h 总 + 5min 空闲", () => {
      expect(resolveSubAgentTimeouts()).toEqual({ totalMs: 3_600_000, idleMs: 300_000 });
    });

    it("resolveSubAgentTimeouts: 显式值优先，总时长夹到 1h 硬顶", () => {
      expect(resolveSubAgentTimeouts({ timeout: 99_999_999, idleTimeout: 1234 })).toEqual({ totalMs: 3_600_000, idleMs: 1234 });
      expect(resolveSubAgentTimeouts({ timeout: 5000 })).toMatchObject({ totalMs: 5000 });
    });

    it("resolveSubAgentTimeouts: env 覆盖、同样夹到 1h", () => {
      process.env.AGENTCORE_SUBAGENT_TIMEOUT_MS = "99999999";
      process.env.AGENTCORE_SUBAGENT_IDLE_TIMEOUT_MS = "7000";
      try {
        expect(resolveSubAgentTimeouts()).toEqual({ totalMs: 3_600_000, idleMs: 7000 });
      } finally {
        delete process.env.AGENTCORE_SUBAGENT_TIMEOUT_MS;
        delete process.env.AGENTCORE_SUBAGENT_IDLE_TIMEOUT_MS;
      }
    });

    it("空闲超时：长时间无输出 → 主动断开（idle timeout 错误）", async () => {
      const { port, server } = await startMockAgent((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseResponse([JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })]));
        // 之后不再写、不 end → 触发空闲断开
        req.on("error", () => {});
        res.on("error", () => {});
      });
      mockServer = server;
      const agent = agentResource({ resourceName: "t", serverUrl: `http://127.0.0.1:${port}` });
      const r = JSON.parse(await callSubAgent(agent, "task", creds, { idleTimeout: 80, timeout: 5000 }));
      expect(r.error).toMatch(/idle timeout/);
    });

    it("空闲计时随输出重置：间隔小于阈值的持续输出不被误杀", async () => {
      const { port, server } = await startMockAgent((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const deltas = ["a", "b", "c", "d"];
        let i = 0;
        const tick = (): void => {
          if (i < deltas.length) {
            res.write(sseResponse([JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: deltas[i++] })]));
            setTimeout(tick, 40); // 间隔 40ms < 空闲阈值 150ms
          } else {
            res.write(sseResponse([JSON.stringify({ type: "RUN_FINISHED" })]));
            res.end();
          }
        };
        tick();
      });
      mockServer = server;
      const agent = agentResource({ resourceName: "t", serverUrl: `http://127.0.0.1:${port}` });
      // 总耗时 ~160ms > idle(150ms)，但每 40ms 有输出重置空闲 → 应正常累积完成
      expect(await callSubAgent(agent, "task", creds, { idleTimeout: 150, timeout: 5000 })).toBe("abcd");
    });

    it("总时长超时：total < idle 时由总时长到点断开（total timeout 错误）", async () => {
      const { port, server } = await startMockAgent((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseResponse([JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })]));
        req.on("error", () => {});
        res.on("error", () => {});
      });
      mockServer = server;
      const agent = agentResource({ resourceName: "t", serverUrl: `http://127.0.0.1:${port}` });
      const r = JSON.parse(await callSubAgent(agent, "task", creds, { timeout: 100, idleTimeout: 5000 }));
      expect(r.error).toMatch(/timed out after/);
    });
  });
});
