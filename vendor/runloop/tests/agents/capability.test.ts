/**
 * 多协议 test-agent 能力矩阵：用 runloop 的委派链路（callSubAgent + event-translator）打这个
 * 仓库内 mock agent，验证「runloop 对各协议/各 HITL 形态的消费能力」。
 *
 * ✅ 通过 = runloop 已正确支持；❌ 失败 = 已知缺口（保持红、后续修复，不 skip）。
 * 已知红（截至接入时）：
 *   - AG-UI interrupt 协议（RUN_FINISHED.outcome → 应产 toolcall.suspend）：G1，translateAguiEvent 当前丢弃。
 * 说明：ag-ui 委派当前不发 RunAgentInput.tools[]，故 test-agent 走 interrupt 协议（机制②）而非 tool-call
 * 机制①（见 multi-protocol-agent.cjs 注释）；机制① 需 runloop 转发 client tools，属另一通道，暂不在此矩阵。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { __setAgentrunHostCheckForTest } from "@/sidecar/ssrf.js";
import { startAgent, agentResource, delegate, type AgentHandle } from "./harness.js";

let agent: AgentHandle;

beforeAll(async () => {
  // auth.mode=agentrun 管路类用例：关掉 agentrun 域名白名单以连 127.0.0.1（沿用 sub-agent-caller.test 约定，
  // 不削弱生产；SSRF 拦截行为另由专门用例覆盖）。
  __setAgentrunHostCheckForTest(false);
  agent = await startAgent();
}, 20_000);

afterAll(async () => {
  __setAgentrunHostCheckForTest(true);
  await agent?.stop();
});

describe("协议支持 · echo 基线（委派应取回文本、不挂起）", () => {
  it("a2a echo → 返回文本", async () => {
    const r = await delegate(agentResource(agent.baseUrl, "a2a", "/a2a"), "你好，请简单回应");
    expect(r.error, r.error).toBeUndefined();
    expect(r.suspended).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("ag-ui echo → 返回文本", async () => {
    const r = await delegate(agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent"), "你好，请简单回应");
    expect(r.error, r.error).toBeUndefined();
    expect(r.suspended).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("chat-completions echo → 返回文本", async () => {
    const r = await delegate(agentResource(agent.baseUrl, "chat-completions", "/openai/v1/chat/completions"), "你好，请简单回应");
    expect(r.error, r.error).toBeUndefined();
    expect(r.suspended).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });
});

// HITL 不再有独立 path —— /a2a 与 /ag-ui/agent 这两个**统一端点**按**关键词**触发 HITL（仿「文章」长文，
// 见 multi-protocol-agent.cjs 的 parseMode）。关键词 → 对应模式；前缀 confirm: 等仍兼容，此处用关键词验证新路径。
const HITL_KW = { confirm: "删除生产数据库", input: "请提供出发城市", auth: "请授权调用付费接口" } as const;

describe("HITL 能力 · A2A（关键词触发 → toolcall.suspend，统一 /a2a 端点）", () => {
  for (const mode of ["confirm", "input", "auth"] as const) {
    it(`a2a hitl ${mode}（关键词触发，无前缀/无独立 path）→ 挂起`, async () => {
      const r = await delegate(agentResource(agent.baseUrl, "a2a", "/a2a"), HITL_KW[mode]);
      expect(r.suspended, `a2a ${mode} 应产出 toolcall.suspend`).toBe(true);
    });
  }
});

describe("HITL 能力 · AG-UI interrupt 协议（关键词触发 → RUN_FINISHED.outcome → toolcall.suspend，统一 /ag-ui/agent 端点）", () => {
  for (const mode of ["confirm", "input", "auth"] as const) {
    it(`ag-ui hitl ${mode}（关键词触发，无前缀/无独立 path）→ 挂起`, async () => {
      const r = await delegate(agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent"), HITL_KW[mode]);
      expect(r.suspended, `ag-ui ${mode} interrupt 应产出 toolcall.suspend`).toBe(true);
      const sus = r.events.find((e) => e.type === "toolcall.suspend") as { prompt?: string } | undefined;
      expect(sus?.prompt, "suspend 应带 interrupt.message 作 NL 提问").toBeTruthy();
    });
  }
});

describe("HITL 往返 · AG-UI（关键词触发 suspend → 标准顶层 resume[] → 完成）[G1+G2]", () => {
  it("confirm：批准 → 子 agent 完成（HITL_CONFIRM_DONE）", async () => {
    const sub = agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent");
    const r1 = await delegate(sub, HITL_KW.confirm);
    expect(r1.suspended).toBe(true);
    const sus = r1.events.find((e) => e.type === "toolcall.suspend") as { toolCallId?: string } | undefined;
    expect(sus?.toolCallId).toBeTruthy();
    // 向下 resume：user.command{resolve} 经 buildAgUiResumeBody 发标准顶层 resume[]（G2）
    const resumeEvents = [
      { type: "user.command", command: "resolve", toolCallId: sus!.toolCallId, selectedOptionId: "approve", payload: { approved: true }, id: "rsv", timestamp: 2, conversationId: "c-test" },
    ];
    const r2 = await delegate(sub, "", resumeEvents);
    expect(r2.suspended).toBe(false);
    expect(r2.ret, "批准后子 agent 应执行并回确定性 marker").toContain("HITL_CONFIRM_DONE");
  });

  it("confirm：拒绝（reject → status:cancelled）→ 子 agent 收到取消", async () => {
    const sub = agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent");
    const r1 = await delegate(sub, HITL_KW.confirm);
    const sus = r1.events.find((e) => e.type === "toolcall.suspend") as { toolCallId?: string } | undefined;
    const resumeEvents = [
      { type: "user.command", command: "resolve", toolCallId: sus!.toolCallId, selectedOptionId: "reject", id: "rsv", timestamp: 2, conversationId: "c-test" },
    ];
    const r2 = await delegate(sub, "", resumeEvents);
    expect(r2.suspended).toBe(false);
    expect(r2.ret, "拒绝后子 agent 应走取消分支").toContain("HITL_CANCELLED");
  });
});

describe("HITL 能力 · AG-UI input_required（关键词触发取值类，G3+G4）", () => {
  it("input suspend 透传 responseSchema + interactionKind + 空 options（不套是非选项）", async () => {
    const r = await delegate(agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent"), HITL_KW.input);
    expect(r.suspended).toBe(true);
    const sus = r.events.find((e) => e.type === "toolcall.suspend") as any;
    expect(sus.interactionKind, "应标记 AG-UI 语义类别 input_required").toBe("input_required");
    expect(sus.responseSchema, "应透传 responseSchema").toBeTruthy();
    expect(sus.options, "取值类不套默认 approve/reject").toEqual([]);
  });

  it("input 往返（结构化 payload 提供值）→ 子 agent 完成 HITL_INPUT_DONE", async () => {
    const sub = agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent");
    const r1 = await delegate(sub, HITL_KW.input);
    const sus = r1.events.find((e) => e.type === "toolcall.suspend") as { toolCallId?: string } | undefined;
    const resumeEvents = [
      { type: "user.command", command: "resolve", toolCallId: sus!.toolCallId, payload: { value: "北京" }, id: "rsv", timestamp: 2, conversationId: "c-test" },
    ];
    const r2 = await delegate(sub, "", resumeEvents);
    expect(r2.ret).toContain("HITL_INPUT_DONE");
    expect(r2.ret).toContain("北京");
  });
});

// AG-UI HITL 机制①（tool-call）：客户端在 RunAgentInput.tools[] 声明工具 → 子 agent 走 TOOL_CALL_* 触发人介入
// （而非机制② interrupt）。runloop 委派时把父级 clientTools 转发进 tools[]，子 agent 对其发 TOOL_CALL →
// runloop 翻成 toolcall.suspend 向上冒泡。验证「toolcall 触发的 HITL」在 ag-ui 子 agent 委派下完整支持。
describe("HITL 能力 · AG-UI 机制①（转发 clientTools → tool-call 触发 → toolcall.suspend → resume）", () => {
  const CONFIRM_TOOL = {
    name: "super_agent_confirm",
    description: "向用户弹出确认对话框",
    parameters: { type: "object", properties: { prompt: { type: "string" } } },
  };

  it("转发 clientTools → 子 agent 走 tool-call（非 interrupt）→ 产 toolcall.suspend（toolName=被调工具）", async () => {
    const sub = agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent");
    const r = await delegate(sub, HITL_KW.confirm, undefined, { clientTools: [CONFIRM_TOOL] });
    expect(r.suspended, "tool-call 机制应产出 toolcall.suspend").toBe(true);
    const sus = r.events.find((e) => e.type === "toolcall.suspend") as
      | { toolName?: string; parentToolCallId?: string }
      | undefined;
    expect(sus, "应有 toolcall.suspend").toBeTruthy();
    // 机制① 的标志：suspend 由 TOOL_CALL 触发，toolName = 被调客户端工具（interrupt 回退会是 'interrupt'）。
    expect(sus!.toolName).toBe("super_agent_confirm");
    expect(sus!.parentToolCallId, "沿委派链冒泡").toBe("d-1");
  });

  it("往返：tool-call 触发 suspend → 批准 → 子 agent 完成（HITL_CONFIRM_DONE）", async () => {
    const sub = agentResource(agent.baseUrl, "ag-ui", "/ag-ui/agent");
    const r1 = await delegate(sub, HITL_KW.confirm, undefined, { clientTools: [CONFIRM_TOOL] });
    expect(r1.suspended).toBe(true);
    const sus = r1.events.find((e) => e.type === "toolcall.suspend") as { toolCallId?: string } | undefined;
    expect(sus?.toolCallId).toBeTruthy();
    const resumeEvents = [
      { type: "user.command", command: "resolve", toolCallId: sus!.toolCallId, selectedOptionId: "approve", payload: { approved: true }, id: "rsv", timestamp: 2, conversationId: "c-test" },
    ];
    const r2 = await delegate(sub, "", resumeEvents, { clientTools: [CONFIRM_TOOL] });
    expect(r2.ret, "批准后子 agent 应执行并回确定性 marker").toContain("HITL_CONFIRM_DONE");
  });
});
