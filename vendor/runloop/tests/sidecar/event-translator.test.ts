import { describe, expect, it } from "vitest";
import { translateChildEvent } from "@/sidecar/event-translator.js";
import { EventType } from "@/types/events.js";

const OPTS = { conversationId: "conv-1", parentToolCallId: "d-parent" };

describe("translateChildEvent", () => {
  describe("runloop protocol", () => {
    it("translates message.delta with parentToolCallId", () => {
      const events = translateChildEvent(
        { type: "message.delta", content: "hello", conversationId: "child-conv", id: "x", timestamp: 1 },
        "runloop",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageDelta);
      expect((events[0] as any).content).toBe("hello");
      expect((events[0] as any).parentToolCallId).toBe("d-parent");
      expect(events[0].conversationId).toBe("conv-1");
    });

    it("preserves child's own parentToolCallId for deeper nesting", () => {
      const events = translateChildEvent(
        { type: "toolcall.start", toolCallId: "d-grandchild", toolName: "delegate_to_x",
          parentToolCallId: "d-child-internal", conversationId: "child-conv", id: "x", timestamp: 1 },
        "runloop",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect((events[0] as any).parentToolCallId).toBe("d-child-internal");
      expect((events[0] as any).toolCallId).toBe("d-grandchild");
    });

    it("sets parentToolCallId on child top-level events (no existing parent)", () => {
      const events = translateChildEvent(
        { type: "message.start", role: "assistant", conversationId: "child-conv", id: "x", timestamp: 1 },
        "runloop",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect((events[0] as any).parentToolCallId).toBe("d-parent");
    });

    it("skips run lifecycle events", () => {
      for (const type of ["run.start", "run.end", "run.interrupt", "run.error", "run.usage"]) {
        const events = translateChildEvent(
          { type, conversationId: "c", id: "x", timestamp: 1 },
          "runloop",
          OPTS,
        );
        expect(events).toHaveLength(0);
      }
    });

    it("translates toolresult.delta (grandchild streaming)", () => {
      const events = translateChildEvent(
        { type: "toolresult.delta", toolCallId: "d-gc", delta: "chunk",
          parentToolCallId: "d-child-inner", conversationId: "c", id: "x", timestamp: 1 },
        "runloop",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.ToolresultDelta);
      expect((events[0] as any).parentToolCallId).toBe("d-child-inner");
      expect((events[0] as any).delta).toBe("chunk");
    });
  });

  describe("ag-ui protocol", () => {
    it("translates TEXT_MESSAGE_CONTENT to message.delta", () => {
      const events = translateChildEvent(
        { type: "TEXT_MESSAGE_CONTENT", delta: "world" },
        "ag-ui",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageDelta);
      expect((events[0] as any).content).toBe("world");
      expect((events[0] as any).parentToolCallId).toBe("d-parent");
    });

    it("translates TOOL_CALL_START to toolcall.start", () => {
      const events = translateChildEvent(
        { type: "TOOL_CALL_START", toolCallId: "tc-1", toolCallName: "search" },
        "ag-ui",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.ToolcallStart);
      expect((events[0] as any).toolCallId).toBe("tc-1");
      expect((events[0] as any).toolName).toBe("search");
      expect((events[0] as any).parentToolCallId).toBe("d-parent");
    });

    it("translates TOOL_CALL_END to toolresult.end", () => {
      const events = translateChildEvent(
        { type: "TOOL_CALL_END", toolCallId: "tc-1", result: "done" },
        "ag-ui",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.ToolresultEnd);
    });

    it("skips RUN_STARTED/RUN_FINISHED", () => {
      expect(translateChildEvent({ type: "RUN_STARTED" }, "ag-ui", OPTS)).toHaveLength(0);
      expect(translateChildEvent({ type: "RUN_FINISHED" }, "ag-ui", OPTS)).toHaveLength(0);
    });

    it("handles lowercase ag-ui event types", () => {
      const events = translateChildEvent(
        { type: "text_message_content", delta: "hi" },
        "ag-ui",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageDelta);
    });

    // 子 agent 思考流映射（附记修复）：ag-ui 0.0.57 REASONING_*（及旧 THINKING_*）→ runloop reasoning.*。
    it("maps REASONING_MESSAGE_START/CONTENT/END to reasoning.start/delta/end (parentToolCallId 透传)", () => {
      const start = translateChildEvent({ type: "REASONING_MESSAGE_START" }, "ag-ui", OPTS);
      expect(start).toHaveLength(1);
      expect(start[0].type).toBe(EventType.ReasoningStart);
      expect((start[0] as any).parentToolCallId).toBe("d-parent");

      const content = translateChildEvent({ type: "REASONING_MESSAGE_CONTENT", delta: "思考中" }, "ag-ui", OPTS);
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe(EventType.ReasoningDelta);
      expect((content[0] as any).content).toBe("思考中");

      const end = translateChildEvent({ type: "REASONING_MESSAGE_END" }, "ag-ui", OPTS);
      expect(end).toHaveLength(1);
      expect(end[0].type).toBe(EventType.ReasoningEnd);
    });

    it("maps REASONING_MESSAGE_CHUNK to reasoning.delta", () => {
      const e = translateChildEvent({ type: "REASONING_MESSAGE_CHUNK", delta: "chunk" }, "ag-ui", OPTS);
      expect(e).toHaveLength(1);
      expect(e[0].type).toBe(EventType.ReasoningDelta);
      expect((e[0] as any).content).toBe("chunk");
    });

    it("maps deprecated THINKING_TEXT_MESSAGE_* to reasoning.* too", () => {
      expect(translateChildEvent({ type: "THINKING_TEXT_MESSAGE_START" }, "ag-ui", OPTS)[0].type).toBe(EventType.ReasoningStart);
      expect(translateChildEvent({ type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "x" }, "ag-ui", OPTS)[0].type).toBe(EventType.ReasoningDelta);
      expect(translateChildEvent({ type: "THINKING_TEXT_MESSAGE_END" }, "ag-ui", OPTS)[0].type).toBe(EventType.ReasoningEnd);
    });

    it("ignores the outer REASONING_START/END / THINKING_START/END wrappers (避免双 start/end)", () => {
      for (const t of ["REASONING_START", "REASONING_END", "THINKING_START", "THINKING_END"]) {
        expect(translateChildEvent({ type: t }, "ag-ui", OPTS), t).toHaveLength(0);
      }
    });
  });

  describe("chat-completions protocol", () => {
    it("translates delta.content to message.delta", () => {
      const events = translateChildEvent(
        { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
        "chat-completions",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageDelta);
      expect((events[0] as any).content).toBe("hi");
      expect((events[0] as any).parentToolCallId).toBe("d-parent");
    });

    it("translates finish_reason=stop to message.end", () => {
      const events = translateChildEvent(
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "chat-completions",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageEnd);
    });

    it("returns empty for empty choices", () => {
      expect(translateChildEvent({ choices: [] }, "chat-completions", OPTS)).toHaveLength(0);
    });
  });

  describe("5-level nesting reconstruction", () => {
    it("parentToolCallId chain supports arbitrary depth", () => {
      // Simulate: A delegates to B, B delegates to C, C delegates to D, D delegates to E
      // E produces a message.delta — it should carry D's toolCallId as parentToolCallId
      // In practice, each level's sub-agent-caller sets parentToolCallId = its own delegation toolCallId.
      // For runloop children, deeper events already carry their own parentToolCallId.

      // Level 1: B's events as seen by A (parentToolCallId = d-A)
      const bText = translateChildEvent(
        { type: "message.delta", content: "B says", conversationId: "b-conv", id: "x", timestamp: 1 },
        "runloop",
        { conversationId: "root-conv", parentToolCallId: "d-A" },
      );
      expect((bText[0] as any).parentToolCallId).toBe("d-A");

      // B calls C — B's events include toolcall.start with toolCallId=d-B
      const bCallC = translateChildEvent(
        { type: "toolcall.start", toolCallId: "d-B", toolName: "delegate_to_C",
          conversationId: "b-conv", id: "x", timestamp: 1 },
        "runloop",
        { conversationId: "root-conv", parentToolCallId: "d-A" },
      );
      expect((bCallC[0] as any).parentToolCallId).toBe("d-A");
      expect((bCallC[0] as any).toolCallId).toBe("d-B");

      // C's text — in B's stream it has parentToolCallId=d-B; when relayed to A, preserved
      const cText = translateChildEvent(
        { type: "message.delta", content: "C says",
          parentToolCallId: "d-B",
          conversationId: "b-conv", id: "x", timestamp: 1 },
        "runloop",
        { conversationId: "root-conv", parentToolCallId: "d-A" },
      );
      // parentToolCallId=d-B preserved (deeper nesting), NOT overwritten to d-A
      expect((cText[0] as any).parentToolCallId).toBe("d-B");

      // C calls D — same pattern
      const cCallD = translateChildEvent(
        { type: "toolcall.start", toolCallId: "d-C", toolName: "delegate_to_D",
          parentToolCallId: "d-B",
          conversationId: "b-conv", id: "x", timestamp: 1 },
        "runloop",
        { conversationId: "root-conv", parentToolCallId: "d-A" },
      );
      expect((cCallD[0] as any).parentToolCallId).toBe("d-B");
      expect((cCallD[0] as any).toolCallId).toBe("d-C");

      // D calls E, E's text — parentToolCallId=d-D
      const eText = translateChildEvent(
        { type: "message.delta", content: "E says",
          parentToolCallId: "d-D",
          conversationId: "b-conv", id: "x", timestamp: 1 },
        "runloop",
        { conversationId: "root-conv", parentToolCallId: "d-A" },
      );
      expect((eText[0] as any).parentToolCallId).toBe("d-D");

      // Reconstruction: client sees:
      // - bText.parentToolCallId = d-A → belongs to delegation d-A (A→B)
      // - bCallC.parentToolCallId = d-A, toolCallId = d-B → B starts delegation d-B (B→C)
      // - cText.parentToolCallId = d-B → belongs to delegation d-B (B→C)
      // - cCallD.parentToolCallId = d-B, toolCallId = d-C → C starts delegation d-C (C→D)
      // - eText.parentToolCallId = d-D → belongs to delegation d-D (D→E)
      // Full chain: d-A → d-B → d-C → d-D → E's text
    });
  });

  describe("HITL 字段透传（AD-026 增补：prompt + options[].matchWords 向上透传）", () => {
    it("runloop 子 suspend：prompt/matchWords 原样透传 + 设 parentToolCallId", () => {
      const events = translateChildEvent(
        {
          type: "toolcall.suspend", toolCallId: "tc-1", toolName: "drop_db", reason: "static_rule",
          prompt: "确认删除？", options: [
            { optionId: "approve", label: "允", kind: "allow_once", matchWords: ["是", "可以"] },
            { optionId: "reject", label: "拒", kind: "reject_once", matchWords: ["否"] },
          ],
          conversationId: "child", id: "x", timestamp: 1,
        },
        "runloop",
        OPTS,
      );
      expect(events).toHaveLength(1);
      const sus = events[0] as any;
      expect(sus.type).toBe(EventType.ToolcallSuspend);
      expect(sus.prompt).toBe("确认删除？");
      expect(sus.options[0].matchWords).toEqual(["是", "可以"]);
      expect(sus.parentToolCallId).toBe("d-parent");
    });

    it("ag-ui INTERRUPT 携带 prompt/matchWords → 透传到父级 suspend", () => {
      const events = translateChildEvent(
        {
          type: "INTERRUPT",
          value: {
            toolName: "drop_db", prompt: "是否允许删除？",
            options: [
              { optionId: "approve", label: "允", kind: "allow_once", matchWords: ["是"] },
              { optionId: "reject", label: "拒", kind: "reject_once", matchWords: ["否"] },
            ],
          },
        },
        "ag-ui",
        OPTS,
      );
      const sus = events[0] as any;
      expect(sus.type).toBe(EventType.ToolcallSuspend);
      expect(sus.prompt).toBe("是否允许删除？");
      expect(sus.options[0].matchWords).toEqual(["是"]);
    });

    it("ag-ui INTERRUPT 不带 options → 默认 approve/reject 带默认 matchWords（嵌套 NL 通道补全）", () => {
      const events = translateChildEvent(
        { type: "INTERRUPT", value: { toolName: "drop_db", prompt: "确认？" } },
        "ag-ui",
        OPTS,
      );
      const sus = events[0] as any;
      expect(sus.type).toBe(EventType.ToolcallSuspend);
      const approve = sus.options.find((o: any) => o.optionId === "approve");
      const reject = sus.options.find((o: any) => o.optionId === "reject");
      expect(approve?.matchWords).toContain("好的");
      expect(reject?.matchWords).toContain("取消");
    });
  });

  // AG-UI 现行标准 interrupt 协议：HITL 经 RUN_FINISHED + outcome:{type:"interrupt",interrupts:[...]} 信号，
  // 而非独立 INTERRUPT 事件（见 docs.ag-ui.com/concepts/interrupts）。复现 G1：当前 RUN_FINISHED 分支
  // 无条件返回 []，标准 ag-ui 子 agent 的 HITL 中断会被静默吞掉、不产出 toolcall.suspend。
  describe("AG-UI 标准 interrupt 协议（RUN_FINISHED.outcome）— 复现 G1", () => {
    it("RUN_FINISHED.outcome.interrupts → 应翻译成父级 toolcall.suspend（id/toolCallId/message 透传）", () => {
      const events = translateChildEvent(
        {
          type: "RUN_FINISHED",
          outcome: {
            type: "interrupt",
            interrupts: [
              {
                id: "int-1",
                reason: "tool_call",
                message: "确认删除数据库？",
                toolCallId: "tc-99",
                responseSchema: { type: "object", properties: { approved: { type: "boolean" } } },
                expiresAt: "2030-01-01T00:00:00Z",
              },
            ],
          },
        },
        "ag-ui",
        OPTS,
      );
      const sus = events.find((e: any) => e.type === EventType.ToolcallSuspend) as any;
      expect(sus, "RUN_FINISHED.outcome interrupt 应翻译成 toolcall.suspend（当前被静默丢弃）").toBeDefined();
      expect(sus.toolCallId).toBe("tc-99");
      expect(sus.prompt).toBe("确认删除数据库？");
      expect(sus.parentToolCallId).toBe("d-parent");
    });

    it("interrupt 无 toolCallId → 用 interrupt id 作锚；自带 options 透传；无 message 不带 prompt", () => {
      const events = translateChildEvent(
        {
          type: "RUN_FINISHED",
          outcome: {
            type: "interrupt",
            interrupts: [
              { id: "int-x", reason: "input_required", options: [{ optionId: "ok", label: "好", kind: "allow_once", matchWords: ["好"] }] },
            ],
          },
        },
        "ag-ui",
        OPTS,
      );
      const sus = events[0] as any;
      expect(sus.type).toBe(EventType.ToolcallSuspend);
      expect(sus.toolCallId).toBe("int-x"); // 无 toolCallId → 用 interrupt id
      expect(sus.toolName).toBe("interrupt"); // 无 toolName → 默认
      expect(sus.prompt).toBeUndefined(); // 无 message → 不带 prompt
      expect(sus.options[0].optionId).toBe("ok"); // 自带 options 透传（非默认）
    });

    it("interrupt 无 id/toolCallId → child-<parent> 兜底锚", () => {
      const events = translateChildEvent(
        { type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ reason: "confirmation", message: "确认?" }] } },
        "ag-ui",
        OPTS,
      );
      expect((events[0] as any).toolCallId).toBe("child-d-parent");
    });

    it("outcome 非 interrupt / interrupts 缺失 → 不翻译（正常收尾）", () => {
      expect(translateChildEvent({ type: "RUN_FINISHED", outcome: { type: "success" } }, "ag-ui", OPTS)).toHaveLength(0);
      expect(translateChildEvent({ type: "RUN_FINISHED", outcome: { type: "interrupt" } }, "ag-ui", OPTS)).toHaveLength(0);
    });

    // P1（G3+G4）：input_required 取值类中断 → suspend 透传 responseSchema + interactionKind，
    // 且**不套默认 approve/reject**（取值不是是非题），让上游按 schema 渲染输入框。
    it("input_required interrupt → suspend 带 responseSchema/interactionKind，且 options 为空（不套是非选项）", () => {
      const events = translateChildEvent(
        {
          type: "RUN_FINISHED",
          outcome: {
            type: "interrupt",
            interrupts: [
              {
                id: "int-i",
                reason: "input_required",
                message: "要哪个城市？",
                responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
              },
            ],
          },
        },
        "ag-ui",
        OPTS,
      );
      const sus = events[0] as any;
      expect(sus.type).toBe(EventType.ToolcallSuspend);
      expect(sus.interactionKind, "应透传 AG-UI 语义类别 input_required").toBe("input_required");
      expect(sus.responseSchema, "应透传 responseSchema").toMatchObject({ properties: { value: { type: "string" } } });
      expect(sus.options, "取值类不套默认 approve/reject → options 为空").toEqual([]);
      expect(sus.prompt).toBe("要哪个城市？");
    });

    it("confirmation interrupt → interactionKind=confirmation，仍套默认 approve/reject", () => {
      const events = translateChildEvent(
        { type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "int-c", reason: "confirmation", message: "确认?" }] } },
        "ag-ui",
        OPTS,
      );
      const sus = events[0] as any;
      expect(sus.interactionKind).toBe("confirmation");
      expect(sus.options.length, "是非题仍套默认选项").toBeGreaterThan(0);
    });
  });

  // AG-UI HITL 机制①（tool-call）：客户端在 RunAgentInput.tools[] 声明工具时，agent 走 TOOL_CALL_* 触发人介入
  // （而非机制② RUN_FINISHED.outcome interrupt）。runloop 委派子 agent 时把父级 clientTools 转发进 tools[]，
  // 子 agent 对这些**转发的客户端工具**发 TOOL_CALL 即「请客户端执行」=挂起 → 必须翻成 toolcall.suspend 向上冒泡，
  // 而非当成普通嵌套 toolcall（否则 tool-call 触发的 HITL 被静默吞掉，run 卡死/委派被当成功）。
  describe("AG-UI HITL 机制①（tool-call：转发的客户端工具 TOOL_CALL → toolcall.suspend）", () => {
    function optsWithClientTools(names: string[]) {
      return {
        conversationId: "conv-1",
        parentToolCallId: "d-parent",
        clientToolNames: new Set(names),
        aguiToolCalls: new Map<string, { toolName: string; args: string }>(),
      };
    }

    it("子 agent 对转发的客户端工具发 TOOL_CALL_START/ARGS/END → toolcall.suspend（toolName=被调工具，沿链冒泡）", () => {
      const opts = optsWithClientTools(["super_agent_confirm"]);
      const out = [
        ...translateChildEvent({ type: "TOOL_CALL_START", toolCallId: "tc-x", toolCallName: "super_agent_confirm" }, "ag-ui", opts),
        ...translateChildEvent({ type: "TOOL_CALL_ARGS", toolCallId: "tc-x", delta: JSON.stringify({ prompt: "确认删除?", reason: "confirmation" }) }, "ag-ui", opts),
        ...translateChildEvent({ type: "TOOL_CALL_END", toolCallId: "tc-x" }, "ag-ui", opts),
      ];
      const sus = out.find((e) => e.type === EventType.ToolcallSuspend) as any;
      expect(sus, "转发客户端工具的 TOOL_CALL 必须翻成 toolcall.suspend").toBeDefined();
      expect(sus.toolCallId).toBe("tc-x");
      expect(sus.toolName).toBe("super_agent_confirm");
      expect(sus.parentToolCallId).toBe("d-parent");
      expect(sus.prompt).toBe("确认删除?");
      expect(sus.interactionKind).toBe("confirmation");
      expect(sus.options.length, "confirmation 套默认 approve/reject").toBeGreaterThan(0);
      // 不得把它当普通工具结果（toolresult.end，会被误当委派已完成）。
      const result = out.find((e) => e.type === EventType.ToolresultEnd);
      expect(result, "客户端 HITL 工具的 END 不应产 toolresult.end").toBeUndefined();
    });

    it("非转发工具的 TOOL_CALL（子 agent 自己的工具）→ 仍按普通嵌套 toolcall 翻译（零行为变化）", () => {
      const opts = optsWithClientTools(["super_agent_confirm"]);
      const out = [
        ...translateChildEvent({ type: "TOOL_CALL_START", toolCallId: "tc-y", toolCallName: "search" }, "ag-ui", opts),
        ...translateChildEvent({ type: "TOOL_CALL_END", toolCallId: "tc-y" }, "ag-ui", opts),
      ];
      expect(out.find((e) => e.type === EventType.ToolcallSuspend), "非客户端工具不应挂起").toBeUndefined();
      expect(out.find((e) => e.type === EventType.ToolcallStart)).toBeDefined();
    });
  });

  // A2A（Agent2Agent）协议：SSE 事件包在 JSON-RPC 信封 {jsonrpc,id,result:<event>} 里，翻译器解包 result。
  // EVENT 四态：message(role agent) / task / status-update / artifact-update（含 append/lastChunk/final）。
  describe("a2a protocol", () => {
    const wrap = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id: "1", result });

    it("artifact-update 文本 parts → message.delta（解包 JSON-RPC result）", () => {
      const events = translateChildEvent(
        wrap({ kind: "artifact-update", taskId: "t1", artifact: { parts: [{ kind: "text", text: "cnVu" }] }, append: true }),
        "a2a",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageDelta);
      expect((events[0] as any).content).toBe("cnVu");
      expect((events[0] as any).parentToolCallId).toBe("d-parent");
    });

    it("message(role agent) 多个文本 parts 拼接 → message.delta", () => {
      const events = translateChildEvent(
        wrap({ kind: "message", role: "agent", parts: [{ kind: "text", text: "hi" }, { kind: "text", text: " there" }] }),
        "a2a",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect((events[0] as any).content).toBe("hi there");
    });

    it("status-update working + status.message 文本 → message.delta", () => {
      const events = translateChildEvent(
        wrap({ kind: "status-update", taskId: "t1", status: { state: "working", message: { role: "agent", parts: [{ kind: "text", text: "处理中" }] } }, final: false }),
        "a2a",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageDelta);
      expect((events[0] as any).content).toBe("处理中");
    });

    it("status-update final completed → message.end", () => {
      const events = translateChildEvent(
        wrap({ kind: "status-update", taskId: "t1", status: { state: "completed" }, final: true }),
        "a2a",
        OPTS,
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.MessageEnd);
    });

    it("status-update input-required → toolcall.suspend（嵌套 HITL，带 prompt + 默认 options）", () => {
      const events = translateChildEvent(
        wrap({ kind: "status-update", taskId: "t1", status: { state: "input-required", message: { role: "agent", parts: [{ kind: "text", text: "需要你确认删除吗？" }] } }, final: false }),
        "a2a",
        OPTS,
      );
      expect(events).toHaveLength(1);
      const sus = events[0] as any;
      expect(sus.type).toBe(EventType.ToolcallSuspend);
      expect(sus.prompt).toBe("需要你确认删除吗？");
      expect(sus.reason).toBe("model_request");
      expect(sus.options.length).toBeGreaterThanOrEqual(2);
      expect(sus.parentToolCallId).toBe("d-parent");
      // 嵌套 NL 通道补全：默认 approve/reject 必须带 matchWords，否则真实首轮 input-required 的
      // NL 回复（"好的"）在 resolvePendingHitl 里匹配不到任何 option → 重问直至自动拒绝。
      const approve = sus.options.find((o: any) => o.optionId === "approve");
      const reject = sus.options.find((o: any) => o.optionId === "reject");
      expect(approve?.matchWords).toContain("好的");
      expect(reject?.matchWords).toContain("取消");
    });

    it("task event with input-required → toolcall.suspend", () => {
      const events = translateChildEvent(wrap({ kind: "task", id: "t1", status: { state: "input-required" } }), "a2a", OPTS);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.ToolcallSuspend);
    });

    it("task 快照（working）不产出文本事件", () => {
      expect(translateChildEvent(wrap({ kind: "task", id: "t1", status: { state: "working" } }), "a2a", OPTS)).toHaveLength(0);
    });

    it("JSON-RPC error 信封 → 不翻译成事件（交 extractChildError 处理）", () => {
      expect(translateChildEvent({ jsonrpc: "2.0", id: "1", error: { code: -32603, message: "boom" } }, "a2a", OPTS)).toHaveLength(0);
    });

    it("空 parts / 未知 kind / 无内容 part → 不产出事件", () => {
      expect(translateChildEvent(wrap({ kind: "artifact-update", artifact: { parts: [] } }), "a2a", OPTS)).toHaveLength(0);
      expect(translateChildEvent(wrap({ kind: "heartbeat" }), "a2a", OPTS)).toHaveLength(0);
      // text part 缺 text 字段、无 file/data → 无可识别内容 → 不产出
      expect(translateChildEvent(wrap({ kind: "message", role: "agent", parts: [{ kind: "text" }] }), "a2a", OPTS)).toHaveLength(0);
    });

    it("多模态 part（file/data）→ message.delta 文本表征（不 dump base64）", () => {
      const file = translateChildEvent(
        wrap({ kind: "artifact-update", artifact: { parts: [{ kind: "file", file: { name: "chart.png", mimeType: "image/png", uri: "https://x/c.png" } }] } }),
        "a2a",
        OPTS,
      );
      expect(file).toHaveLength(1);
      expect((file[0] as any).content).toBe("[file: chart.png (image/png) https://x/c.png]");

      const data = translateChildEvent(
        wrap({ kind: "message", role: "agent", parts: [{ kind: "data", data: { ok: true } }] }),
        "a2a",
        OPTS,
      );
      expect((data[0] as any).content).toBe('{"ok":true}');
    });

    it("未包 JSON-RPC 信封时直接当作 A2A 事件处理（解包容错）", () => {
      const events = translateChildEvent({ kind: "message", role: "agent", parts: [{ kind: "text", text: "raw" }] }, "a2a", OPTS);
      expect((events[0] as any).content).toBe("raw");
    });
  });
});
