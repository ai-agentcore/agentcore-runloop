import { describe, it, expect } from "vitest";
import {
  messagesRequestToChatCompletions,
  createClaudeState,
  claudeMessageStart,
  chatCompletionChunkToClaudeEvents,
  claudeFinalize,
  claudeErrorEvent,
} from "@/provider/translate-messages.js";
import type { ChatCompletionChunk } from "@/provider/types.js";

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: { completion_tokens: number }): ChatCompletionChunk {
  return { id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage: { prompt_tokens: 0, completion_tokens: usage.completion_tokens, total_tokens: usage.completion_tokens } } : {}) } as ChatCompletionChunk;
}

describe("translate-messages — request branches", () => {
  it("system as array, tool_result content as array, assistant tool_use only, image skipped", () => {
    const cc = messagesRequestToChatCompletions({
      model: "m",
      system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      tools: [{ name: "t", parameters: { type: "object" } }], // parameters fallback (no input_schema)
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: {} }] },
        { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "t", input: { x: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "res" }] }] },
      ],
    });
    expect(cc.messages[0]).toMatchObject({ role: "system", content: "a\nb" });
    expect(cc.messages.find((m) => m.role === "user")?.content).toBe("hi"); // image skipped
    const asst = cc.messages.find((m) => m.role === "assistant");
    expect(asst?.content).toBeNull(); // tool_use only → null content
    expect(asst?.tool_calls).toHaveLength(1);
    expect(cc.messages.find((m) => m.role === "tool")?.content).toBe("res");
    expect(cc.tools?.[0].function.parameters).toMatchObject({ type: "object" });
  });

  it("no system, string content, object tool_result, empty messages fallback", () => {
    const cc1 = messagesRequestToChatCompletions({ model: "m", messages: [{ role: "user", content: "plain" }] });
    expect(cc1.messages[0]).toMatchObject({ role: "user", content: "plain" });
    expect(cc1.tools).toBeUndefined();

    const cc2 = messagesRequestToChatCompletions({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "u", content: { nested: true } }] }] });
    expect(cc2.messages.find((m) => m.role === "tool")?.content).toBe(JSON.stringify({ nested: true }));

    const cc3 = messagesRequestToChatCompletions({ model: "m", messages: [] });
    expect(cc3.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("最大化空字段：system 块无 text、无 messages、各 block 缺字段 → 各 ?? 默认分支", () => {
    // system 块数组含无 text 的块（b.text ?? "" 右分支）+ 有 messages 让 system 被加入
    const cc = messagesRequestToChatCompletions({ model: "m", system: [{ type: "text", text: "x" }, { type: "text" }], messages: [{ role: "user", content: "q" }] } as never);
    expect(cc.messages[0]).toMatchObject({ role: "system", content: "x\n" });
    // 整体无 messages 字段（?? [] 分支）→ 空回落
    const ccNoMsg = messagesRequestToChatCompletions({ model: "m" } as never);
    expect(ccNoMsg.messages).toEqual([{ role: "user", content: "" }]);

    // 各 block 缺字段：text 块无 text、tool_use 无 id/name/input、tool_result 无 tool_use_id + content 各形态
    const cc2 = messagesRequestToChatCompletions({
      model: "m",
      messages: [
        { role: "assistant", content: [{ type: "text" }, { type: "tool_use" }] }, // 无 text / 无 id/name/input
        { role: "user", content: [
          { type: "tool_result" },                                   // 无 tool_use_id + content null（110 ?? "")
          { type: "tool_result", tool_use_id: "u", content: [{ type: "text" }, { type: "image", x: 1 }] }, // 块数组：无 text + 非 text
        ] },
      ],
    } as never);
    const asst = cc2.messages.find((m) => m.role === "assistant");
    expect(asst?.tool_calls?.[0]).toMatchObject({ id: "", function: { name: "", arguments: "{}" } });
    const tools = cc2.messages.filter((m) => m.role === "tool");
    expect(tools[0].content).toBe("");        // content null → ""
    expect(tools[1].content).toContain("image"); // 非 text 块 JSON.stringify
  });
});

describe("translate-messages — streaming branches", () => {
  it("text → tool block switch, finish closes block, mapFinishReason", () => {
    const s = createClaudeState("msg", "m");
    expect(claudeMessageStart(s)).toContain("message_start");
    const out: string[] = [];
    out.push(...chatCompletionChunkToClaudeEvents(chunk({ content: "hello" }), s)); // open text
    out.push(...chatCompletionChunkToClaudeEvents(chunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "{}" } }] }), s)); // switch to tool_use (closes text)
    out.push(...chatCompletionChunkToClaudeEvents(chunk({}, "tool_calls"), s)); // finish
    const j = out.join("");
    expect(j).toContain("content_block_stop"); // text block closed on switch
    expect(j).toContain('"type":"tool_use"');
    expect(j).toContain('"stop_reason":"tool_use"');
  });

  it("usage-only chunk updates tokens; text finish maps to end_turn; finalize is idempotent after stop", () => {
    const s = createClaudeState("msg", "m");
    const out: string[] = [];
    out.push(...chatCompletionChunkToClaudeEvents(chunk({}, null, { completion_tokens: 7 }), s)); // usage, no choice content
    out.push(...chatCompletionChunkToClaudeEvents(chunk({ content: "hi" }), s));
    out.push(...chatCompletionChunkToClaudeEvents(chunk({}, "stop"), s));
    const j = out.join("");
    expect(j).toContain('"stop_reason":"end_turn"');
    expect(j).toContain('"output_tokens":7');
    expect(claudeFinalize(s)).toEqual([]); // already stopped → no-op
  });

  it("finalize emits stop when stream never finished; length finish reason", () => {
    const s = createClaudeState("msg", "m");
    chatCompletionChunkToClaudeEvents(chunk({ content: "x" }), s); // open text, no finish
    const fin = claudeFinalize(s).join("");
    expect(fin).toContain("content_block_stop");
    expect(fin).toContain("message_stop");

    const s2 = createClaudeState("msg2", "m");
    const out = chatCompletionChunkToClaudeEvents(chunk({ content: "y" }, "length"), s2).join("");
    expect(out).toContain('"stop_reason":"max_tokens"');
  });

  it("error event", () => {
    expect(claudeErrorEvent("boom")).toContain("api_error");
    expect(claudeErrorEvent("boom")).toContain("boom");
  });

  it("no-choice chunk without usage is ignored", () => {
    const s = createClaudeState("msg", "m");
    expect(chatCompletionChunkToClaudeEvents({ id: "c", object: "chat.completion.chunk", model: "m", choices: [] } as ChatCompletionChunk, s)).toEqual([]);
  });

  it("usage 块无 completion_tokens（保留旧值）+ tool_call delta 无 name（?? \"\"）", () => {
    const s = createClaudeState("msg", "m");
    // 先有 usage 设 tokens
    chatCompletionChunkToClaudeEvents(chunk({}, null, { completion_tokens: 5 }), s);
    // usage 块但无 completion_tokens（179 的 ?? state.outputTokens 分支）
    chatCompletionChunkToClaudeEvents({ id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 1 } } as ChatCompletionChunk, s);
    // tool_call delta 无 function.name（207 的 ?? ""）
    const out = chatCompletionChunkToClaudeEvents(chunk({ tool_calls: [{ index: 0, id: "t", function: { arguments: "{}" } }] }), s).join("");
    expect(out).toContain('"name":""');
    const fin = claudeFinalize(s).join("");
    expect(fin).toContain('"output_tokens":5'); // 旧值保留
  });
});
