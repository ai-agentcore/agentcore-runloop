import type {
  ChatCompletionRequest,
  ChatCompletionMessage,
  ChatCompletionChunk,
} from "./types.js";

interface ResponsesInput {
  type: string;
  [key: string]: unknown;
}

export function responsesRequestToChatCompletions(
  body: Record<string, unknown>
): ChatCompletionRequest {
  const messages: ChatCompletionMessage[] = [];

  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions as string });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    // codex 通常**无 previous_response_id、每轮发完整 input 数组**（function_call + function_call_output
    // 交替/批量）。必须把 `function_call` 项翻译成 assistant 的 `tool_calls`，否则 `function_call_output`
    // 翻成的 tool 消息没有匹配的 assistant.tool_calls[].id → 上游模型视为孤儿工具结果而忽略 → 反复重调
    // 同一工具（写文件成功仍循环重写，见 L-054）。连续的 function_call 批进同一条 assistant 消息（兼容并行
    // 工具调用：tool 结果须紧跟其 assistant.tool_calls）。
    let pendingToolCalls: NonNullable<ChatCompletionMessage["tool_calls"]> = [];
    const flushToolCalls = () => {
      if (pendingToolCalls.length > 0) {
        messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
        pendingToolCalls = [];
      }
    };
    for (const item of input as ResponsesInput[]) {
      if (item.type === "message") {
        flushToolCalls();
        const role = (item.role as string) === "developer" ? "system" : (item.role as string) ?? "user";
        const content = Array.isArray(item.content)
          ? (item.content as { text?: string }[]).map((c) => c.text ?? "").join("")
          : String(item.content ?? "");
        messages.push({ role: role as ChatCompletionMessage["role"], content });
      } else if (item.type === "function_call") {
        // namespace 工具回写扁平 Chat 名 `{ns}__{name}`（与 flattenResponsesTools 暴露给模型的名一致），
        // 否则模型从历史学到裸名复用 → codex 回程 route 不回（同 buildAssistantMessage，L-044）。
        const ns = item.namespace as string | undefined;
        const bare = String(item.name ?? "");
        const rawArgs = item.arguments;
        pendingToolCalls.push({
          id: String(item.call_id ?? ""),
          type: "function",
          function: {
            name: ns ? chatToolName(ns, bare) : bare,
            arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {}),
          },
        });
      } else if (item.type === "function_call_output") {
        flushToolCalls();
        messages.push({
          role: "tool",
          // Codex 0.155 may return structured content blocks. String(array)
          // loses all tool text and causes the model to repeat successful calls.
          content: Array.isArray(item.output)
            ? item.output.map((block: unknown) => {
                if (typeof block === "string") return block;
                if (block && typeof block === "object" && "text" in block && typeof block.text === "string") return block.text;
                return JSON.stringify(block);
              }).join("\n")
            : typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          tool_call_id: item.call_id as string,
        });
      }
    }
    flushToolCalls();
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  const ccTools = flattenResponsesTools(body.tools as Record<string, unknown>[] | undefined);

  return {
    model: body.model as string,
    messages,
    stream: true,
    tools: ccTools.length ? ccTools : undefined,
    temperature: body.temperature as number | undefined,
    max_tokens: body.max_output_tokens as number | undefined,
  };
}

type ChatTool = { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } };

const asChatTool = (t: Record<string, unknown>, name: string): ChatTool => ({
  type: "function",
  function: {
    name,
    description: t.description as string | undefined,
    parameters: t.parameters as Record<string, unknown> | undefined,
  },
});

/**
 * 把 Responses 的 tools[] 翻译成 Chat Completions 的 function 工具。
 * codex 会把 MCP / multi_agent 工具包进私有的 `type:"namespace"` 分组（Chat Completions 无此概念），
 * 这里**展开**：每个 namespace 的嵌套 function 提升为顶层 function，名字用**全限定** `{namespace}__{tool}`
 * （codex 的 namespace 名本身即 `mcp__{server}`，拼出来正好是 codex 约定的 `mcp__{server}__{tool}`），
 * 以便模型回传的 tool_call 名能被 codex 反解 route 回对应 MCP server / 子 agent。
 * 不展开（旧 filter 只留 type==="function"）会把整组工具连同里面的函数丢掉 → 模型根本看不到这些工具。
 */
export interface ToolNameParts { namespace: string; name: string }

const nativeImageAlias = (namespace: string, name: string): string | undefined => {
  if (namespace !== "mcp__agentcore") return undefined;
  if (name === "view_image") return "view_image";
  if (name === "imagegen") return "image_gen__imagegen";
  return undefined;
};

const chatToolName = (namespace: string, name: string): string =>
  nativeImageAlias(namespace, name) ?? `${namespace}__${name}`;

/**
 * 出站(给模型)把 namespace 工具展平成 Chat 合法名 `{ns}__{tool}`；回程(给 codex)codex 的
 * `ResponseItem::FunctionCall` 有**独立的 `namespace` + `name` 字段**（`ToolName::new(namespace, name)`,
 * 见 codex-rs/core/src/tools/router.rs），不是解析单个字符串——所以无论怎么拼扁平名 codex 都 route 不回。
 * 这里建「Chat 扁平名 → {namespace, 裸 name}」映射,回程翻译 function_call 时拆回两个字段,codex 才能
 * `ToolName::new` 还原、route 回对应 MCP server / 子 agent。两端都是我们的,故可控。
 */
export function buildToolNameRewriteMap(body: Record<string, unknown>): Map<string, ToolNameParts> {
  const map = new Map<string, ToolNameParts>();
  for (const t of (body.tools as Record<string, unknown>[] | undefined) ?? []) {
    if (t.type !== "namespace" || !Array.isArray(t.tools)) continue;
    const ns = t.name as string;
    for (const sub of t.tools as Record<string, unknown>[]) {
      if (sub.type !== "function") continue;
      const bare = sub.name as string;
      map.set(chatToolName(ns, bare), { namespace: ns, name: bare });
    }
  }
  return map;
}

export function flattenResponsesTools(tools: Record<string, unknown>[] | undefined): ChatTool[] {
  const out: ChatTool[] = [];
  const names = new Set<string>();
  const add = (tool: ChatTool) => {
    if (!names.has(tool.function.name)) { names.add(tool.function.name); out.push(tool); }
  };
  for (const t of tools ?? []) {
    if (t.type === "function") {
      add(asChatTool(t, t.name as string));
    } else if (t.type === "namespace" && Array.isArray(t.tools)) {
      // 展开用**全限定名** `{namespace}__{tool}`（codex namespace 名即 `mcp__{server}`，拼出 `mcp__{server}__{tool}`）。
      // 这是 codex 的「flattened」MCP 调用格式：codex ≥ PR#17556（2026-04-12 合入）注册了别名、能反解 route 回 MCP server；
      // 更老的 codex（如镜像里 0.137）只认带冒号的 `mcp__{server}__:{tool}`（冒号非 Chat 合法函数名、无法表达）→ unsupported call。
      const ns = t.name as string;
      for (const sub of t.tools as Record<string, unknown>[]) {
        if (sub.type !== "function") continue;
        add(asChatTool(sub, chatToolName(ns, sub.name as string)));
      }
    }
  }
  return out;
}

export interface ResponsesState {
  responseId: string;
  outputIndex: number;
  itemId: string;
  contentPartIndex: number;
  hasStartedMessage: boolean;
  hasStartedContent: boolean;
  hasCompleted: boolean;
  accumulatedText: string;
  toolCalls: Map<number, { id: string; name: string; namespace?: string; args: string }>;
  completedToolCalls: Array<{ id: string; name: string; namespace?: string; args: string }>;
  /** 回程 tool_call 名拆分表（Chat 扁平名 → {namespace, 裸 name}），见 buildToolNameRewriteMap。 */
  toolNameMap?: Map<string, ToolNameParts>;
}

export function createResponsesState(responseId: string, toolNameMap?: Map<string, ToolNameParts>): ResponsesState {
  return {
    responseId,
    outputIndex: 0,
    itemId: `item_0`,
    contentPartIndex: 0,
    hasStartedMessage: false,
    hasStartedContent: false,
    hasCompleted: false,
    accumulatedText: "",
    toolCalls: new Map(),
    completedToolCalls: [],
    toolNameMap,
  };
}

export function chatCompletionChunkToResponsesEvents(
  chunk: ChatCompletionChunk,
  state: ResponsesState
): string[] {
  const events: string[] = [];
  const choice = chunk.choices?.[0];

  if (!choice && chunk.usage) {
    state.hasCompleted = true;
    events.push(formatResponsesSSE("response.completed", {
      type: "response.completed",
      response: {
        id: state.responseId,
        object: "response",
        status: "completed",
        output: [],
        usage: {
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        },
      },
    }));
    return events;
  }

  if (!choice) return events;

  const delta = choice.delta;

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id) {
        const toolItemId = `item_${state.outputIndex}`;
        // namespace 工具：模型回传的是 Chat 扁平名 `{ns}__{tool}`，拆回 codex 要的 {namespace, 裸 name}
        // 两个独立字段（codex `ResponseItem::FunctionCall` 直接读这俩字段做 ToolName::new）。
        // 普通 flat 工具（exec_command）不命中映射 → 原样、无 namespace。
        const rawName = tc.function?.name ?? "";
        const parts = state.toolNameMap?.get(rawName);
        const emitName = parts?.name ?? rawName;
        const emitNs = parts?.namespace;
        state.toolCalls.set(tc.index, {
          id: tc.id,
          name: emitName,
          namespace: emitNs,
          args: tc.function?.arguments ?? "",
        });

        if (!state.hasStartedMessage) {
          events.push(formatResponsesSSE("response.output_item.added", {
            type: "response.output_item.added",
            output_index: state.outputIndex,
            item: {
              id: toolItemId,
              type: "function_call",
              call_id: tc.id,
              name: emitName,
              ...(emitNs ? { namespace: emitNs } : {}),
              arguments: "",
              status: "in_progress",
            },
          }));
          state.hasStartedMessage = true;
        }
      } else if (tc.function?.arguments) {
        const existing = state.toolCalls.get(tc.index);
        if (existing) {
          existing.args += tc.function.arguments;
          events.push(formatResponsesSSE("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            output_index: state.outputIndex,
            item_id: `item_${state.outputIndex}`,
            call_id: existing.id,
            delta: tc.function.arguments,
          }));
        }
      }
    }
  }

  if (delta.content !== undefined && delta.content !== null) {
    if (!state.hasStartedMessage) {
      events.push(formatResponsesSSE("response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.outputIndex,
        item: {
          id: state.itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      }));
      state.hasStartedMessage = true;
    }

    if (!state.hasStartedContent) {
      events.push(formatResponsesSSE("response.content_part.added", {
        type: "response.content_part.added",
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: state.contentPartIndex,
        part: { type: "output_text", text: "" },
      }));
      state.hasStartedContent = true;
    }

    if (delta.content) {
      state.accumulatedText += delta.content;
      events.push(formatResponsesSSE("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: state.contentPartIndex,
        delta: delta.content,
      }));
    }
  }

  // 任何「非 tool_calls 的终止」（stop / length / content_filter / 其它）都必须收尾并保住已累计文本——
  // codex 靠 response.output_item.done 生成 item.completed（L-018），否则 max_tokens 截断（finish_reason=length）
  // 时整段助手回复被悄悄丢弃。
  if (choice.finish_reason && choice.finish_reason !== "tool_calls") {
    if (state.hasStartedContent) {
      events.push(formatResponsesSSE("response.output_text.done", {
        type: "response.output_text.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: state.contentPartIndex,
        text: state.accumulatedText,
      }));
      events.push(formatResponsesSSE("response.content_part.done", {
        type: "response.content_part.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: state.contentPartIndex,
        part: { type: "output_text", text: state.accumulatedText },
      }));
    }
    events.push(formatResponsesSSE("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.outputIndex,
      item: {
        id: state.itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: state.hasStartedContent
          ? [{ type: "output_text", text: state.accumulatedText }]
          : [],
      },
    }));
  }

  if (choice.finish_reason === "tool_calls") {
    for (const [, tc] of state.toolCalls) {
      events.push(formatResponsesSSE("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        output_index: state.outputIndex,
        item_id: `item_${state.outputIndex}`,
        call_id: tc.id,
        arguments: tc.args,
      }));
      events.push(formatResponsesSSE("response.output_item.done", {
        type: "response.output_item.done",
        output_index: state.outputIndex,
        item: {
          id: `item_${state.outputIndex}`,
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          ...(tc.namespace ? { namespace: tc.namespace } : {}),
          arguments: tc.args,
          status: "completed",
        },
      }));
      state.outputIndex++;
    }
    state.completedToolCalls.push(...state.toolCalls.values());
    state.toolCalls.clear();
  }

  return events;
}

function formatResponsesSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function responsesCreatedEvent(responseId: string, model: string): string {
  return formatResponsesSSE("response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      model,
      output: [],
    },
  });
}

export function responsesCompletedEvent(responseId: string): string {
  return formatResponsesSSE("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
}

export function responsesErrorEvent(message: string): string {
  return formatResponsesSSE("error", {
    type: "error",
    error: {
      type: "server_error",
      message,
    },
  });
}
