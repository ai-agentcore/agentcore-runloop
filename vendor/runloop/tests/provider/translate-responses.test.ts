import { describe, it, expect } from "vitest";
import {
  responsesRequestToChatCompletions,
  chatCompletionChunkToResponsesEvents,
  createResponsesState,
  buildToolNameRewriteMap,
  flattenResponsesTools,
} from "@/provider/translate-responses.js";
import type { ChatCompletionChunk } from "@/provider/types.js";

// codex 把 MCP/子 agent 工具包成 type:"namespace" 分组（L-044）。
const NAMESPACE_TOOLS = [
  { type: "function", name: "read", parameters: { type: "object" } },
  {
    type: "namespace",
    name: "mcp__agentcore",
    tools: [
      { type: "function", name: "calc", parameters: { type: "object" } },
      { type: "prompt", name: "ignore_me" }, // 非 function：应被跳过
    ],
  },
  { type: "namespace", name: "mcp__empty" }, // tools 非数组：整组跳过
];

describe("flattenResponsesTools / buildToolNameRewriteMap (L-044 namespace)", () => {
  it("flattens namespace tools to fully-qualified function names", () => {
    const flat = flattenResponsesTools(NAMESPACE_TOOLS as never);
    const names = flat.map((t) => t.function.name);
    expect(names).toContain("read");
    expect(names).toContain("mcp__agentcore__calc");
    expect(names).not.toContain("ignore_me"); // 非 function 子项被跳过
    expect(names).not.toContain("mcp__empty");
  });

  it("returns empty for undefined tools", () => {
    expect(flattenResponsesTools(undefined)).toEqual([]);
  });

  it("builds the flat-name → {namespace,name} rewrite map", () => {
    const map = buildToolNameRewriteMap({ tools: NAMESPACE_TOOLS } as never);
    expect(map.get("mcp__agentcore__calc")).toEqual({ namespace: "mcp__agentcore", name: "calc" });
    expect(map.has("mcp__empty")).toBe(false);
  });

  it("returns empty map when no tools present", () => {
    expect(buildToolNameRewriteMap({}).size).toBe(0);
  });
});

describe("responsesRequestToChatCompletions", () => {
  it("converts string input", () => {
    const result = responsesRequestToChatCompletions({
      model: "gpt-4",
      input: "hello",
    });
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(result.model).toBe("gpt-4");
    expect(result.stream).toBe(true);
  });

  it("converts instructions to system message", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      instructions: "be helpful",
      input: "hi",
    });
    expect(result.messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(result.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("converts array input with messages", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ text: "hello" }] },
        { type: "message", role: "developer", content: "system msg" },
      ],
    });
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("hello");
    expect(result.messages[1].role).toBe("system");
  });

  it("converts function_call_output to tool message", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      input: [
        { type: "function_call_output", call_id: "tc-1", output: "result" },
      ],
    });
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "result",
      tool_call_id: "tc-1",
    });
  });

  // L-054 回归：codex 无 previous_response_id 时每轮发完整 input（function_call + function_call_output），
  // 必须把 function_call 翻成 assistant.tool_calls，否则 tool 结果孤儿 → 上游模型反复重调同一工具（写文件
  // 成功仍死循环）。
  it("converts function_call to assistant tool_calls so tool results are not orphaned", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ text: "写文件" }] },
        { type: "function_call", call_id: "tc-1", name: "write_file", namespace: "mcp__agentcore", arguments: '{"file_path":"a.txt"}' },
        { type: "function_call_output", call_id: "tc-1", output: '{"ok":true}' },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: "写文件" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc-1", type: "function", function: { name: "mcp__agentcore__write_file", arguments: '{"file_path":"a.txt"}' } },
        ],
      },
      { role: "tool", content: '{"ok":true}', tool_call_id: "tc-1" },
    ]);
    // tool 结果有匹配的 assistant.tool_calls[].id（不再是孤儿）
    const toolMsg = result.messages.find((m) => m.role === "tool");
    const asst = result.messages.find((m) => m.role === "assistant");
    expect(asst?.tool_calls?.[0].id).toBe(toolMsg?.tool_call_id);
  });

  it("batches consecutive function_call items into one assistant message (parallel tool calls)", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      input: [
        { type: "function_call", call_id: "a", name: "f1", arguments: "{}" },
        { type: "function_call", call_id: "b", name: "f2", arguments: "{}" },
        { type: "function_call_output", call_id: "a", output: "ra" },
        { type: "function_call_output", call_id: "b", output: "rb" },
      ],
    });
    const assistants = result.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls?.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("function_call without namespace keeps the bare name + stringifies object arguments", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      input: [
        { type: "function_call", call_id: "tc-9", name: "exec_command", arguments: { cmd: "ls" } },
      ],
    });
    const tc = result.messages[0].tool_calls![0];
    expect(tc.function.name).toBe("exec_command");
    expect(JSON.parse(tc.function.arguments)).toEqual({ cmd: "ls" });
  });

  it("only includes system messages from our instructions — no extra injected content", () => {
    const ourPrompt = "你是 AgentRun 的超级 Agent\n\n## 环境与依赖安装\n...";
    const result = responsesRequestToChatCompletions({
      model: "qwen3.7-max",
      instructions: ourPrompt,
      input: [
        { type: "message", role: "user", content: [{ text: "今天有什么新闻" }] },
      ],
    });

    const systemMessages = result.messages.filter(m => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe(ourPrompt);

    const userMessages = result.messages.filter(m => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe("今天有什么新闻");
  });

  it("does not leak developer messages as extra system messages", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      instructions: "our-only-system-prompt",
      input: [
        { type: "message", role: "developer", content: "dev-injected" },
        { type: "message", role: "user", content: [{ text: "hi" }] },
      ],
    });

    const systemMessages = result.messages.filter(m => m.role === "system");
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0].content).toBe("our-only-system-prompt");
    expect(systemMessages[1].content).toBe("dev-injected");
  });

  it("converts tools", () => {
    const result = responsesRequestToChatCompletions({
      model: "m",
      input: "hi",
      tools: [
        { type: "function", name: "read", description: "read a file", parameters: { type: "object" } },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].function.name).toBe("read");
  });
});

describe("chatCompletionChunkToResponsesEvents", () => {
  it("converts text content chunks", () => {
    const state = createResponsesState("resp-1");
    const chunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    };

    const events = chatCompletionChunkToResponsesEvents(chunk, state);
    const text = events.join("");
    expect(text).toContain("response.output_item.added");
    expect(text).toContain("response.content_part.added");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain('"delta":"hi"');
  });

  it("converts stop finish_reason", () => {
    const state = createResponsesState("resp-1");
    state.hasStartedMessage = true;
    state.hasStartedContent = true;
    state.accumulatedText = "hello world";

    const chunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };

    const events = chatCompletionChunkToResponsesEvents(chunk, state);
    const text = events.join("");
    expect(text).toContain("response.output_text.done");
    expect(text).toContain("response.output_item.done");
    expect(text).toContain('"text":"hello world"');
  });

  it("includes item_id in all text streaming events", () => {
    const state = createResponsesState("resp-1");

    const deltaChunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: { content: "tok" }, finish_reason: null }],
    };
    const deltaEvents = chatCompletionChunkToResponsesEvents(deltaChunk, state);
    for (const ev of deltaEvents) {
      const parsed = JSON.parse(ev.split("data: ")[1]);
      if (["response.content_part.added", "response.output_text.delta"].includes(parsed.type)) {
        expect(parsed.item_id).toBe("item_0");
      }
    }

    const stopChunk: ChatCompletionChunk = {
      id: "c2",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    const stopEvents = chatCompletionChunkToResponsesEvents(stopChunk, state);
    for (const ev of stopEvents) {
      const parsed = JSON.parse(ev.split("data: ")[1]);
      if (["response.output_text.done", "response.content_part.done"].includes(parsed.type)) {
        expect(parsed.item_id).toBe("item_0");
      }
    }
  });

  it("converts usage-only chunk to response.completed", () => {
    const state = createResponsesState("resp-1");
    const chunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const events = chatCompletionChunkToResponsesEvents(chunk, state);
    const text = events.join("");
    expect(text).toContain("response.completed");
    expect(text).toContain('"input_tokens":10');
    expect(text).toContain('"output_tokens":5');
  });

  it("converts tool_calls chunks", () => {
    const state = createResponsesState("resp-1");

    const startChunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "tc-1", type: "function", function: { name: "read_file", arguments: "" } }],
        },
        finish_reason: null,
      }],
    };

    const events1 = chatCompletionChunkToResponsesEvents(startChunk, state);
    expect(events1.join("")).toContain("response.output_item.added");
    expect(events1.join("")).toContain("function_call");

    const argsChunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"path":"test.txt"}' } }],
        },
        finish_reason: null,
      }],
    };

    const events2 = chatCompletionChunkToResponsesEvents(argsChunk, state);
    expect(events2.join("")).toContain("response.function_call_arguments.delta");

    const doneChunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: "tool_calls" }],
    };

    const events3 = chatCompletionChunkToResponsesEvents(doneChunk, state);
    const text = events3.join("");
    expect(text).toContain("response.function_call_arguments.done");
    expect(text).toContain("response.output_item.done");
  });

  it("fills an empty user message when input is empty", () => {
    const result = responsesRequestToChatCompletions({ model: "gpt-4", input: [] });
    expect(result.messages).toEqual([{ role: "user", content: "" }]);
  });
});

describe("translate-responses — 分支补全", () => {
  it("request: developer→system / 无 role→user / content 数组 text?? + 非数组 / output??", () => {
    const cc = responsesRequestToChatCompletions({
      model: "m",
      input: [
        { type: "message", role: "developer", content: [{ text: "d" }] }, // developer → system
        { type: "message", content: [{}, { text: "hi" }] },                // 无 role → user；{} → text ?? ""
        { type: "message", content: 123 },                                  // content 非数组 → String(content ?? "")
        { type: "function_call_output", call_id: "c1", output: undefined }, // output ?? ""
      ],
    } as never);
    expect(cc.messages.some((m) => m.role === "system")).toBe(true);
    expect(cc.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("stream: 无 choice / tool_call 全限定名拆 namespace + 无 args / 另一个无 name", () => {
    const map = new Map([["mcp__agentcore__calc", { name: "calc", namespace: "mcp__agentcore" }]]);
    const state = createResponsesState("r", map as never);
    // 无 choice → 返回（176）
    chatCompletionChunkToResponsesEvents({ id: "c", object: "chat.completion.chunk", model: "m", choices: [] } as ChatCompletionChunk, state);
    // tool_call：全限定名命中 map → emitName=calc / emitNs=mcp__agentcore（189/190/207/321）；无 arguments（195）
    const out = chatCompletionChunkToResponsesEvents({
      id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "mcp__agentcore__calc" } }] }, finish_reason: null }],
    } as ChatCompletionChunk, state).join("");
    expect(out).toContain("mcp__agentcore");
    // tool_call function 无 name（187 rawName ?? ""）
    chatCompletionChunkToResponsesEvents({
      id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 1, delta: { tool_calls: [{ index: 1, id: "t2", function: { arguments: "{}" } }] }, finish_reason: null }],
    } as ChatCompletionChunk, state);
  });

  it("stream: 累积文本 → done 时 output_text（298）", () => {
    const state = createResponsesState("r");
    state.hasStartedMessage = true;
    state.hasStartedContent = true;
    state.accumulatedText = "acc";
    const out = chatCompletionChunkToResponsesEvents({
      id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    } as ChatCompletionChunk, state).join("");
    expect(out).toContain('"text":"acc"');
  });
});
