import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// test-agent 是零依赖 CJS fixture（多协议 mock agent）。这里只测它「与协议无关的 HITL 决策核心」hitlCore，
// 重点是**跨 FC 实例**恢复：真实部署里 test-agent 是无状态 FC，每次委派可能落到不同实例，
// run1 挂起时写进实例 A 内存的 pendingHitl，到 run2 恢复打到实例 B → 内存空。
// 旧实现 takePendingHitl 落空即 HITL_RESUME_REJECTED → 父 agent 看到委派失败 → 重新委派 → 死循环（预发实锤）。
// 修复方向：taskId 已编码 mode+round（parseTaskId），内存没命中就从 taskId 重建 → 真正无状态可恢复。
const require_ = createRequire(import.meta.url);
const agent = require_(
  join(dirname(fileURLToPath(import.meta.url)), "multi-protocol-agent.cjs"),
) as {
  hitlCore: (text: string, resumeId: string) => { kind: string; mode: string; id: string; text?: string };
  parseTaskId: (id: string) => { mode: string; round: number } | null;
  pendingHitl: Map<string, unknown>;
  interruptResume: (body: unknown) => { id: string; text: string } | null;
};

describe("test-agent hitlCore —— 跨 FC 实例无状态恢复", () => {
  beforeEach(() => agent.pendingHitl.clear());

  it("首轮 auth → suspend，taskId 可解析出 mode/round", () => {
    const d = agent.hitlCore("auth: 删除数据库", "");
    expect(d.kind).toBe("suspend");
    expect(d.mode).toBe("auth");
    expect(agent.parseTaskId(d.id)).toMatchObject({ mode: "auth", round: 1 });
  });

  it("跨实例（内存清空）resume 批准 → 从 taskId 重建并完成，不再 HITL_RESUME_REJECTED", () => {
    const first = agent.hitlCore("auth: 删除数据库", "");
    const taskId = first.id;
    agent.pendingHitl.clear(); // 模拟换 FC 实例：内存 pending 全丢
    const d = agent.hitlCore("approve", taskId);
    expect(d.kind).toBe("complete");
    expect(d.text).toContain("HITL_AUTH_DONE");
    expect(d.text).not.toContain("HITL_RESUME_REJECTED");
  });

  it("跨实例 resume 拒绝 → cancelled（仍能识别拒绝）", () => {
    const first = agent.hitlCore("confirm: 上线", "");
    const taskId = first.id;
    agent.pendingHitl.clear();
    const d = agent.hitlCore("否", taskId);
    expect(d.text).toContain("HITL_CANCELLED");
  });

  it("内存命中时行为不变（confirm 批准 → 完成）", () => {
    const first = agent.hitlCore("confirm: 上线", "");
    const d = agent.hitlCore("是", first.id); // 不清内存
    expect(d.kind).toBe("complete");
    expect(d.text).toContain("HITL_CONFIRM_DONE");
  });

  it("真正非法 taskId（无法解析）→ 仍拒绝（防乱传恢复标识）", () => {
    const d = agent.hitlCore("approve", "not-a-valid-task-id");
    expect(d.text).toContain("HITL_RESUME_REJECTED");
  });
});

describe("test-agent interruptResume —— AG-UI status:resolved = 批准（非取值 payload 不再判「不明确」）", () => {
  // 预发实锤：super_agent 下发 resume:[{interruptId, status:"resolved", payload:{action:"confirm"}}]。
  // 旧逻辑 payloadToText({action:"confirm"}) → JSON.stringify → 非批准词 → hitlCore 判「回答不明确」→ 再次挂起 → 死循环。
  // 修复：status:"resolved" 即 AG-UI 标准批准信号；payload 仅在带【具体取值】时覆盖（input 取值类）。
  it("status:resolved + payload{action:confirm}（生产形态）→ 批准词「是」", () => {
    const r = agent.interruptResume({ resume: [{ interruptId: "hitl_auth_r1_1_a", status: "resolved", payload: { action: "confirm" } }] });
    expect(r?.text).toBe("是");
  });

  it("status:resolved + 无 payload → 批准词「是」", () => {
    const r = agent.interruptResume({ resume: [{ interruptId: "hitl_confirm_r1_1_a", status: "resolved" }] });
    expect(r?.text).toBe("是");
  });

  it("status:resolved + payload{value:北京}（取值类）→ 保留取值「北京」", () => {
    const r = agent.interruptResume({ resume: [{ interruptId: "hitl_input_r1_1_a", status: "resolved", payload: { value: "北京" } }] });
    expect(r?.text).toBe("北京");
  });

  it("status:cancelled → 拒绝词「取消」", () => {
    const r = agent.interruptResume({ resume: [{ interruptId: "hitl_auth_r1_1_a", status: "cancelled" }] });
    expect(r?.text).toBe("取消");
  });

  it("端到端：生产形态 resume + 跨实例内存清空 → 子 agent 完成（HITL_AUTH_DONE，不再挂起/拒绝）", () => {
    const first = agent.hitlCore("auth: 删除数据库", "");
    agent.pendingHitl.clear(); // 换 FC 实例
    const ir = agent.interruptResume({ resume: [{ interruptId: first.id, status: "resolved", payload: { action: "confirm" } }] });
    const d = agent.hitlCore(ir!.text, ir!.id);
    expect(d.kind).toBe("complete");
    expect(d.text).toContain("HITL_AUTH_DONE");
    expect(d.text).not.toContain("HITL_RESUME_REJECTED");
  });
});
