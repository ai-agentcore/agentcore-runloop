import { describe, it, expect, afterEach, vi } from "vitest";
import { SidecarServer, REQUEST_CONFIRMATION_TOOL } from "@/sidecar/server.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { RunloopEvent } from "@/types/events.js";

/**
 * openapi 工具（db_drop）现在走真实 HTTP。stub global.fetch：本地（127.0.0.1）放行，
 * 上游返回受控响应体（工具结果即该响应体）。HITL 控制流不变——只是被执行的 openapi 工具走 fetch。
 */
const realFetch = globalThis.fetch;
function stubUpstreamFetch(responseBody: unknown = { ok: true }, status = 200) {
  const spy = vi.fn((url: string | URL, init?: RequestInit) => {
    if (String(url).includes("127.0.0.1") || String(url).includes("localhost")) return realFetch(url as never, init);
    const text = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    return Promise.resolve(new Response(text, { status }));
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}
afterEach(() => vi.unstubAllGlobals());

function resources(): NonMcpResources {
  return {
    tools: [
      {
        resourceId: "fc-1", resourceName: "db_drop", resourceType: "FUNCTIONCALL", protocol: "openapi",
        openapiConfig: {
          openapi: "3.0.0",
          servers: [{ url: "https://api.db" }],
          paths: { "/db_drop": { post: { operationId: "db_drop" } } },
        },
      },
    ],
    skills: [],
    subAgents: [],
    sandboxes: [],
  };
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("Sidecar HITL suspend (AD-026 主轨/辅轨)", () => {
  it("static-rule (主轨) ask → emits toolcall.start/end/suspend, calls onSuspend, returns hitl_pending", async () => {
    const emitted: RunloopEvent[] = [];
    let suspendSignaled = false;
    const server = new SidecarServer({
      resources: resources(),
      conversationId: "conv-1",
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      hitl: { enabled: true, rules: [{ toolPattern: "function__db_drop*", action: "ask" }] },
      emit: (e) => emitted.push(e),
      onSuspend: () => { suspendSignaled = true; },
    });
    await server.start();
    try {
      // 严格统一命名（AD-027）：resourceName=db_drop + operationId=db_drop → 工具名 function__db_drop__db_drop（db_* 前缀仍匹配）
      const { json } = await post(server.baseUrl, "/call", { name: "function__db_drop__db_drop", args: { database: "testdb" } });
      expect(json.content[0].text).toContain("hitl_pending");
      expect(suspendSignaled).toBe(true);
      const types = emitted.map((e) => e.type);
      expect(types).toEqual(["toolcall.start", "toolcall.end", "toolcall.suspend"]);
      const suspend = emitted[2] as RunloopEvent & { reason?: string; options?: unknown[] };
      expect(suspend.reason).toBe("static_rule");
      expect(suspend.options).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it("HITL 闸覆盖范围：任意经 sidecar 路由的工具（含下游 MCP / 内置）均按 name 过闸 → ask 命中即挂起、不达执行", async () => {
    // gatedExecute 的闸（maybeSuspend）纯按 toolName 判定，在 handleToolCall 路由（→ openapi / 下游 MCP /
    // 内置 bash）之前执行。故凡经 sidecar 的工具调用都被覆盖——下游 MCP 工具只是另一个名字，同样过闸。
    // 这坐实 AD-026 #9 的范围声明：HITL 主轨覆盖「所有经 sidecar 的平台/下游 MCP/内置工具」。
    const emitted: RunloopEvent[] = [];
    let suspended = false;
    const server = new SidecarServer({
      resources: resources(),
      conversationId: "conv-scope",
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      hitl: { enabled: true, rules: [{ toolPattern: "github_mcp_*", action: "ask" }] },
      emit: (e) => emitted.push(e),
      onSuspend: () => { suspended = true; },
    });
    // 直接用一个「下游 MCP 工具风格」的名字（未注册为本地资源）调 gatedExecute——闸先于路由触发。
    const r = await server.gatedExecute("github_mcp_create_issue", { title: "x" });
    expect(r.content[0].text).toContain("hitl_pending");
    expect(suspended).toBe(true);
    expect(emitted.map((e) => e.type)).toEqual(["toolcall.start", "toolcall.end", "toolcall.suspend"]);
  });

  it("static-rule (主轨) block → 硬拒：不挂起、不执行、返回 blocked_by_policy(isError)，区别于 ask", async () => {
    const emitted: RunloopEvent[] = [];
    let suspendSignaled = false;
    const server = new SidecarServer({
      resources: resources(),
      conversationId: "conv-block",
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      hitl: { enabled: true, rules: [{ toolPattern: "function__db_drop*", action: "block" }] },
      emit: (e) => emitted.push(e),
      onSuspend: () => { suspendSignaled = true; },
    });
    await server.start();
    try {
      const fetchSpy = stubUpstreamFetch({ dropped: true }); // 若误执行会打到上游 fetch
      const { json } = await post(server.baseUrl, "/call", { name: "function__db_drop__db_drop", args: { database: "testdb" } });
      expect(json.isError).toBe(true);
      expect(json.content[0].text).toContain("blocked_by_policy");
      expect(suspendSignaled).toBe(false);   // 不挂起（区别于 ask）
      expect(emitted.length).toBe(0);        // 不产 toolcall.start/end/suspend 事件
      // 不执行：除本地放行外，不应有任何上游 fetch（工具未被执行）
      const upstreamCalls = fetchSpy.mock.calls.filter((c) => !String(c[0]).includes("127.0.0.1"));
      expect(upstreamCalls.length).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("suspend 携带 NL 降级字段：prompt（含工具名）+ 每 option 的 matchWords（默认词表兜底）", async () => {
    const emitted: RunloopEvent[] = [];
    const server = new SidecarServer({
      resources: resources(),
      conversationId: "conv-1",
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      hitl: { enabled: true, rules: [{ toolPattern: "function__db_drop*", action: "ask" }] },
      emit: (e) => emitted.push(e),
      onSuspend: () => {},
      // 不注入 phrasing → 走 StaticHitlPhrasing 兜底（无模型调用）
    });
    await server.start();
    try {
      await post(server.baseUrl, "/call", { name: "function__db_drop__db_drop", args: { database: "testdb" } });
      const suspend = emitted.find((e) => e.type === "toolcall.suspend") as RunloopEvent & {
        prompt?: string;
        options?: Array<{ optionId: string; matchWords?: string[] }>;
      };
      expect(typeof suspend.prompt).toBe("string");
      expect(suspend.prompt).toContain("function__db_drop__db_drop");
      const approve = suspend.options!.find((o) => o.optionId === "approve")!;
      const reject = suspend.options!.find((o) => o.optionId === "reject")!;
      expect(Array.isArray(approve.matchWords)).toBe(true);
      expect(approve.matchWords).toContain("是");
      expect(reject.matchWords).toContain("否");
    } finally {
      await server.stop();
    }
  });

  it("non-matching tool with hitl enabled → executes normally (no suspend)", async () => {
    let suspendSignaled = false;
    const server = new SidecarServer({
      resources: resources(),
      conversationId: "conv-1",
      hitl: { enabled: true, rules: [{ toolPattern: "other_*", action: "ask" }] },
      onSuspend: () => { suspendSignaled = true; },
    });
    const spy = stubUpstreamFetch({ executed: true });
    await server.start();
    try {
      const { json } = await post(server.baseUrl, "/call", { name: "function__db_drop__db_drop", args: {} });
      expect(suspendSignaled).toBe(false);
      // 未挂起 → 正常执行 openapi 工具（真实 fetch），结果即上游响应体
      expect(JSON.parse(json.content[0].text).executed).toBe(true);
      expect(spy.mock.calls.some((c) => !String(c[0]).includes("127.0.0.1"))).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("辅轨 ask 原语 listed in /tools when hitl enabled, and request_confirmation 别名 suspends on call (reason model_request)", async () => {
    const emitted: RunloopEvent[] = [];
    const server = new SidecarServer({
      resources: resources(),
      conversationId: "conv-1",
      hitl: { enabled: true },
      emit: (e) => emitted.push(e),
      onSuspend: () => {},
    });
    await server.start();
    try {
      const toolsRes = await fetch(`${server.baseUrl}/tools`);
      const { tools } = await toolsRes.json();
      // 暴露的辅轨工具是单一 ask 原语 request_user_input（吸收 request_confirmation）。
      expect(tools.some((t: { name: string }) => t.name === "request_user_input")).toBe(true);

      // request_confirmation 仍被识别为辅轨别名（向后兼容），调用即挂起。
      const { json } = await post(server.baseUrl, "/call", { name: REQUEST_CONFIRMATION_TOOL, args: { reason: "need ok" } });
      expect(json.content[0].text).toContain("hitl_pending");
      const suspend = emitted.find((e) => e.type === "toolcall.suspend") as RunloopEvent & { reason?: string };
      expect(suspend?.reason).toBe("model_request");
    } finally {
      await server.stop();
    }
  });

  it("辅轨 ask 原语 NOT listed when hitl disabled", async () => {
    const server = new SidecarServer({ resources: resources(), conversationId: "conv-1" });
    await server.start();
    try {
      const toolsRes = await fetch(`${server.baseUrl}/tools`);
      const { tools } = await toolsRes.json();
      expect(tools.some((t: { name: string }) => t.name === "request_user_input")).toBe(false);
      expect(tools.some((t: { name: string }) => t.name === REQUEST_CONFIRMATION_TOOL)).toBe(false);
    } finally {
      await server.stop();
    }
  });

  describe("ask 原语 request_user_input（单一 schema-驱动，吸收 request_confirmation）", () => {
    function askServer(emitted: RunloopEvent[]): SidecarServer {
      return new SidecarServer({
        resources: resources(),
        conversationId: "conv-ask",
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        hitl: { enabled: true },
        emit: (e) => emitted.push(e),
        onSuspend: () => {},
      });
    }
    type Suspend = RunloopEvent & {
      reason?: string;
      prompt?: string;
      interactionKind?: string;
      responseSchema?: Record<string, unknown>;
      options?: Array<{ optionId: string; label: string; kind: string; matchWords?: string[] }>;
    };
    const suspendOf = (emitted: RunloopEvent[]) =>
      emitted.find((e) => e.type === "toolcall.suspend") as Suspend;

    it("request_user_input listed in /tools when hitl enabled", async () => {
      const server = askServer([]);
      await server.start();
      try {
        const { tools } = await (await fetch(`${server.baseUrl}/tools`)).json();
        expect(tools.some((t: { name: string }) => t.name === "request_user_input")).toBe(true);
      } finally {
        await server.stop();
      }
    });

    it("省略 responseSchema → 二元确认（interactionKind=confirmation，approve/reject + matchWords），prompt 用 args.prompt", async () => {
      const emitted: RunloopEvent[] = [];
      const r = await askServer(emitted).gatedExecute("request_user_input", { prompt: "确认删除该表吗？" });
      expect(r.content[0].text).toContain("hitl_pending");
      const s = suspendOf(emitted);
      expect(s.reason).toBe("model_request");
      expect(s.interactionKind).toBe("confirmation");
      expect(s.prompt).toBe("确认删除该表吗？");
      expect(s.responseSchema).toBeUndefined();
      expect(s.options).toHaveLength(2);
      const approve = s.options!.find((o) => o.optionId === "approve")!;
      const reject = s.options!.find((o) => o.optionId === "reject")!;
      expect(approve.matchWords).toContain("是");
      expect(reject.matchWords).toContain("否");
    });

    it("responseSchema 带 enum → 多选（每个枚举值一个 option/matchWords，carry responseSchema，非 input_required）", async () => {
      const emitted: RunloopEvent[] = [];
      const schema = { enum: ["回滚", "热修", "灰度"] };
      await askServer(emitted).gatedExecute("request_user_input", { prompt: "选择发布策略", responseSchema: schema });
      const s = suspendOf(emitted);
      expect(s.prompt).toBe("选择发布策略");
      expect(s.interactionKind).not.toBe("input_required"); // 多选靠 matchWords 匹配，不走取值通道
      expect(s.responseSchema).toEqual(schema);
      expect(s.options!.map((o) => o.optionId)).toEqual(["回滚", "热修", "灰度"]);
      const opt = s.options!.find((o) => o.optionId === "热修")!;
      expect(opt.label).toBe("热修");
      expect(opt.matchWords).toEqual(["热修"]);
      expect(opt.kind).toBe("allow_once");
    });

    it("responseSchema 带 {type:string, enum} → 多选（enum 优先于 type）", async () => {
      const emitted: RunloopEvent[] = [];
      await askServer(emitted).gatedExecute("request_user_input", {
        prompt: "选一个",
        responseSchema: { type: "string", enum: ["A", "B"] },
      });
      const s = suspendOf(emitted);
      expect(s.options!.map((o) => o.optionId)).toEqual(["A", "B"]);
      expect(s.interactionKind).not.toBe("input_required");
    });

    it("responseSchema 无 enum（{type:string}）→ 取值（interactionKind=input_required、options 空、carry responseSchema）", async () => {
      const emitted: RunloopEvent[] = [];
      const schema = { type: "string" };
      await askServer(emitted).gatedExecute("request_user_input", { prompt: "请输入收件人邮箱", responseSchema: schema });
      const s = suspendOf(emitted);
      expect(s.prompt).toBe("请输入收件人邮箱");
      expect(s.interactionKind).toBe("input_required");
      expect(s.responseSchema).toEqual(schema);
      expect(s.options).toHaveLength(0);
    });

    it("request_confirmation 别名仍被识别为辅轨（吸收：等价于无 schema 的 request_user_input）", async () => {
      const emitted: RunloopEvent[] = [];
      const r = await askServer(emitted).gatedExecute("request_confirmation", { reason: "need ok" });
      expect(r.content[0].text).toContain("hitl_pending");
      const s = suspendOf(emitted);
      expect(s.reason).toBe("model_request");
      expect(s.interactionKind).toBe("confirmation");
      expect(s.options).toHaveLength(2);
    });
  });

  describe("呈现选择（surface / renderTool · AD-026 增补）", () => {
    type SurfaceSuspend = RunloopEvent & { surface?: string; renderTool?: string };
    const suspendOf = (emitted: RunloopEvent[]) =>
      emitted.find((e) => e.type === "toolcall.suspend") as SurfaceSuspend;

    it("无 clientCapabilities → surface=native（向后兼容）", async () => {
      const emitted: RunloopEvent[] = [];
      await new SidecarServer({
        resources: resources(),
        conversationId: "conv-s",
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        hitl: { enabled: true },
        emit: (e) => emitted.push(e),
        onSuspend: () => {},
      }).gatedExecute("request_user_input", { prompt: "确认吗？" });
      expect(suspendOf(emitted).surface).toBe("native");
    });

    it("renderTools 显式映射 → surface=client_tool + renderTool（确定性，不调 mapper）", async () => {
      const emitted: RunloopEvent[] = [];
      await new SidecarServer({
        resources: resources(),
        conversationId: "conv-s",
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        hitl: { enabled: true, clientCapabilities: { renderTools: { choice: "super_agent_choices" } } },
        emit: (e) => emitted.push(e),
        onSuspend: () => {},
      }).gatedExecute("request_user_input", { prompt: "选一个", responseSchema: { enum: ["A", "B", "C"] } });
      const s = suspendOf(emitted);
      expect(s.surface).toBe("client_tool");
      expect(s.renderTool).toBe("super_agent_choices");
    });

    it("nativeHitl + interactions 含该 kind → surface=native", async () => {
      const emitted: RunloopEvent[] = [];
      await new SidecarServer({
        resources: resources(),
        conversationId: "conv-s",
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        hitl: { enabled: true, clientCapabilities: { interactions: ["confirm"], nativeHitl: true } },
        emit: (e) => emitted.push(e),
        onSuspend: () => {},
      }).gatedExecute("request_user_input", { prompt: "确认吗？" });
      expect(suspendOf(emitted).surface).toBe("native");
    });

    it("needsLlm（renderTools 非空但无该 kind 映射）→ 调注入的 surfaceMapper 定 toolName", async () => {
      const emitted: RunloopEvent[] = [];
      const calls: unknown[] = [];
      await new SidecarServer({
        resources: resources(),
        conversationId: "conv-s",
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        hitl: { enabled: true, clientCapabilities: { renderTools: { choice: "super_agent_choices" } } },
        clientTools: [{ name: "super_agent_confirm", description: "确认" }],
        surfaceMapper: { map: async (input) => { calls.push(input); return { toolName: "super_agent_confirm" }; } },
        emit: (e) => emitted.push(e),
        onSuspend: () => {},
      }).gatedExecute("request_user_input", { prompt: "确认吗？" }); // confirm，无 renderTools.confirm
      const s = suspendOf(emitted);
      expect(calls).toHaveLength(1); // mapper 被调
      expect(s.surface).toBe("client_tool");
      expect(s.renderTool).toBe("super_agent_confirm");
    });

    it("needsLlm 且 mapper 返回空 → 回落 surface=nl", async () => {
      const emitted: RunloopEvent[] = [];
      await new SidecarServer({
        resources: resources(),
        conversationId: "conv-s",
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        hitl: { enabled: true, clientCapabilities: { renderTools: { choice: "super_agent_choices" } } },
        surfaceMapper: { map: async () => ({}) },
        emit: (e) => emitted.push(e),
        onSuspend: () => {},
      }).gatedExecute("request_user_input", { prompt: "确认吗？" });
      const s = suspendOf(emitted);
      expect(s.surface).toBe("nl");
      expect(s.renderTool).toBeUndefined();
    });

    it("空 capabilities 对象（无声明）→ surface=nl", async () => {
      const emitted: RunloopEvent[] = [];
      await new SidecarServer({
        resources: resources(),
        conversationId: "conv-s",
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        hitl: { enabled: true, clientCapabilities: {} },
        emit: (e) => emitted.push(e),
        onSuspend: () => {},
      }).gatedExecute("request_user_input", { prompt: "确认吗？" });
      expect(suspendOf(emitted).surface).toBe("nl");
    });
  });

  it("executeTool bypasses the HITL gate (used by execute-on-resume)", async () => {
    const spy = stubUpstreamFetch({ dropped: true });
    const server = new SidecarServer({
      resources: resources(),
      conversationId: "conv-1",
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      hitl: { enabled: true, rules: [{ toolPattern: "*", action: "ask" }] },
    });
    // even with a catch-all ask rule, executeTool must run the op directly (real HTTP)
    const r = await server.executeTool("function__db_drop__db_drop", { database: "x" });
    expect(r.isError ?? false).toBe(false);
    expect(JSON.parse(r.content[0].text).dropped).toBe(true);
    // 用历史 args 代执行真实 op：body 含 args
    expect((spy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ database: "x" }));
  });
});
