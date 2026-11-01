import { describe, it, expect } from "vitest";
import { buildAssistantMessage } from "../../src/provider/proxy.js";
import { createResponsesState } from "../../src/provider/translate-responses.js";

// 回归：codex WS 路径重建会话历史时，namespace 工具的 tool_call 名必须**还原成扁平名**
// `{namespace}__{name}`（与 tools[] 一致），否则模型从历史里学到裸名 `shell` 并复用，
// 回程 toolNameMap.get("shell") 落空 → codex 路由不到 → `unsupported call: shell`（线上实测）。
describe("buildAssistantMessage (namespace tool round-trip)", () => {
  it("re-flattens a namespaced tool call back to {namespace}__{name}", () => {
    const state = createResponsesState("resp-1");
    state.completedToolCalls.push({
      id: "call_1",
      name: "bash",
      namespace: "mcp__agentcore",
      args: '{"command":"ls"}',
    });

    const msgs = buildAssistantMessage(state);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].tool_calls?.[0].function.name).toBe("mcp__agentcore__bash");
  });

  it("leaves a plain (non-namespaced) tool call name untouched", () => {
    const state = createResponsesState("resp-2");
    state.completedToolCalls.push({ id: "call_2", name: "update_plan", args: "{}" });

    const msgs = buildAssistantMessage(state);

    expect(msgs[0].tool_calls?.[0].function.name).toBe("update_plan");
  });
});
