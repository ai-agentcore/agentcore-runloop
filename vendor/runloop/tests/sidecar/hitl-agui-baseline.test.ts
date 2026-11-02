import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { translateChildEvent } from "@/sidecar/event-translator.js";
import { callSubAgent } from "@/sidecar/sub-agent-caller.js";
import { EventType } from "@/types/events.js";
import type { Resource } from "@/types/resources.js";

/**
 * 表征测试（characterization）：固化「ag-ui 子 agent 触发 HITL」当前链路的现状基线。
 *
 * 讨论结论（AD-026 增补，待开发）涉及三段，本文件先确认每段的**当前行为**符合判断，
 * 开发时这些断言会被翻转/扩展为新行为：
 *   ① 向上透传：ag-ui INTERRUPT/CUSTOM → 父级 toolcall.suspend —— 已支持（应 PASS）。
 *   ② suspend 缺 NL 降级字段：当前 options 无 matchWords、事件无 prompt —— 待补（GAP，应 PASS）。
 *   ③ 向下 resume 硬编码 runloop 协议：ag-ui 子 agent 收到 {events} 而非 RunAgentInput —— 核心缺口（GAP，应 PASS）。
 */

const OPTS = { conversationId: "conv-1", parentToolCallId: "d-parent" };

function startMockAgent(handler: (req: any, res: any) => void): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, server });
    });
  });
}

/** 扁平 AGENT Resource：委派端点由 openapiConfig 的 invoke operation 派生。 */
function agUiAgent(serverUrl: string): Resource {
  return {
    resourceId: "r1",
    resourceName: "agui-bot",
    resourceType: "AGENT",
    protocol: "ag-ui",
    openapiConfig: {
      openapi: "3.0.0",
      servers: [{ url: serverUrl }],
      paths: { "/invoke": { post: { operationId: "invoke" } } },
    },
    auth: { mode: "none" },
  } as Resource;
}

const creds = { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou", accountId: "123" };

describe("HITL × ag-ui 子 agent —— 现状基线", () => {
  let mockServer: Server | null = null;
   // 子 agent 连本地 mock；R1 拦截另由专门用例覆盖
  afterEach(() => {
    if (mockServer) { mockServer.close(); mockServer = null; }

  });

  // ① 向上透传：子 agent 的 HITL 升级为父级 suspend，沿 parentToolCallId 向上（现状=已支持）
  it("① ag-ui INTERRUPT 升级为父级 toolcall.suspend，挂在 parentToolCallId 上", () => {
    const events = translateChildEvent(
      { type: "INTERRUPT", value: { toolName: "drop_db", args: { table: "users" } } },
      "ag-ui",
      OPTS,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.ToolcallSuspend);
    expect((events[0] as any).toolName).toBe("drop_db");
    expect((events[0] as any).parentToolCallId).toBe("d-parent");
    // 默认 approve/reject 两个选项
    expect((events[0] as any).options).toHaveLength(2);
  });

  // ② 嵌套默认 suspend 现已带 NL 降级所需的 matchWords（缺口已修：嵌套子 agent 不带 options 时，
  //    translateChildEvent 用 defaultHitlOptions 注入默认 approve/reject + 默认 matchWords，使真实首轮
  //    嵌套 HITL 的 NL resume 可命中）。prompt 仍仅在子 agent 自带 prompt 时透传（此处 INTERRUPT 无 prompt）。
  it("② 嵌套默认 suspend 的 options 带默认 matchWords（NL 降级通道补全）", () => {
    const sus = translateChildEvent({ type: "INTERRUPT" }, "ag-ui", OPTS)[0] as any;
    expect(sus.type).toBe(EventType.ToolcallSuspend);
    expect(sus.prompt).toBeUndefined(); // 子 agent 未给 prompt → 不透传（NL 提问文本可由上游据 options 自拼）
    expect(Array.isArray(sus.options)).toBe(true);
    const approve = sus.options.find((o: any) => o.optionId === "approve");
    const reject = sus.options.find((o: any) => o.optionId === "reject");
    expect(approve.matchWords).toContain("好的");
    expect(reject.matchWords).toContain("取消");
  });

  // ③ 向下 resume：对 ag-ui 子 agent 仍发 runloop 的 {events} body，而非 ag-ui RunAgentInput（核心缺口）
  // ③ 缺口已修（Unit5）：resume 对 ag-ui 子 agent 改发 RunAgentInput（messages + forwardedProps.resume），不再错发 runloop {events}
  it("③ resume 对 ag-ui 子 agent 发 RunAgentInput（messages），不再错发 runloop {events}", async () => {
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

    const agent = agUiAgent(`http://127.0.0.1:${port}`);
    await callSubAgent(agent, "", creds, {
      resumeEvents: [
        { type: "user.message", content: "把表删了", id: "x", timestamp: 1, conversationId: "c" },
        { type: "user.command", command: "resolve", toolCallId: "tc-1", selectedOptionId: "approve" },
      ],
    });

    const parsed = JSON.parse(receivedBody);
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.events).toBeUndefined();
    expect(parsed.forwardedProps?.resume?.selectedOptionId).toBe("approve");
  });
});
