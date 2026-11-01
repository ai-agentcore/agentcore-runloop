import type { ProviderConfig, ChatCompletionRequest } from "./types.js";

export async function* streamChatCompletions(
  config: ProviderConfig,
  body: ChatCompletionRequest,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const requestBody = {
    ...body,
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (config.temperature !== undefined && body.temperature === undefined) {
    requestBody.temperature = config.temperature;
  }
  if (config.maxTokens !== undefined && body.max_tokens === undefined) {
    requestBody.max_tokens = config.maxTokens;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstream ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          yield trimmed.slice(6);
        }
      }
    }

    if (buffer.trim() && buffer.trim() !== "data: [DONE]") {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ")) {
        yield trimmed.slice(6);
      }
    }
  } finally {
    // Closing the downstream stream must also release its upstream connection.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* streamClaudeMessages(
  config: ProviderConfig,
  body: Record<string, unknown>
): AsyncGenerator<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;

  const requestBody: Record<string, unknown> = {
    ...body,
    model: config.model,
    stream: true,
  };
  if (config.maxTokens !== undefined && body.max_tokens === undefined) {
    requestBody.max_tokens = config.maxTokens;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstream ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("data: ")) {
        yield trimmed.slice(6);
      }
    }
  }
}
