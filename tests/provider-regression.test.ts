import { expect, it } from "vitest";
import { buildToolNameRewriteMap, responsesRequestToChatCompletions } from "../vendor/runloop/src/provider/translate-responses.js";

it("preserves Codex structured tool output for the AgentCore model", () => {
  const result = responsesRequestToChatCompletions({ model: "qwen", input: [
    { type: "function_call", call_id: "call-1", name: "echo", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: [
      { type: "input_text", text: "fixture-echo-ok" },
      { type: "input_text", text: "second block" },
    ] },
  ] });
  expect(result.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call-1", content: "fixture-echo-ok\nsecond block" });
});

it("exposes the AgentCore image bridge under Codex native image tool names", () => {
  const body = { model: "qwen", tools: [{
    type: "namespace", name: "mcp__agentcore", tools: [
      { type: "function", name: "view_image", description: "view", parameters: { type: "object" } },
      { type: "function", name: "imagegen", description: "generate", parameters: { type: "object" } },
    ],
  }] };
  const result = responsesRequestToChatCompletions(body);
  expect(result.tools?.map(tool => tool.function.name)).toEqual(["view_image", "image_gen__imagegen"]);
  expect(buildToolNameRewriteMap(body)).toEqual(new Map([
    ["view_image", { namespace: "mcp__agentcore", name: "view_image" }],
    ["image_gen__imagegen", { namespace: "mcp__agentcore", name: "imagegen" }],
  ]));
});
