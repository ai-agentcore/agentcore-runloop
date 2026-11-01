/**
 * ⚠ 未接入 / 不可用（L1）：尚未在 tool-registry 注册为工具，apiKey 来源也未定，生产链路不会调用它。
 * 待密钥方案落地后按下方 TODO 注册；在那之前请勿当作已生效能力引用。
 *
 * Web search caller — 参考 super-agent 的 web_search context tool 实现。
 *
 * 调用契约（与 super-agent 一致）：
 *   POST ${WEB_SEARCH_URL}
 *   Authorization: Bearer ${WEB_SEARCH_API_KEY}
 *   Body: { query, history: [] }
 *   Response: { result: { search_result: [{title, link, snippet, content, position}] }, usage: {...} }
 *
 * TODO: API key 来源尚未确定（受信网关注入 / 调用方下发 per-tenant token），
 *       当前 callWebSearch 的 apiKey 参数留空字符串占位，上层尚未注册为可用工具。
 *       待密钥方案落地后：
 *       1. 确定 apiKey 传入来源（RunRequest / 受信网关 session token / 环境变量）
 *       2. 在 tool-registry.ts 的 buildToolDescriptors 注册 web_search descriptor
 *       3. 在 handleToolCall 加 web_search 分支调用本模块
 */

export interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  content: string;
  position: number;
}

export interface WebSearchResponse {
  result: {
    search_result: WebSearchResult[];
  };
  usage?: Record<string, unknown>;
}

export async function callWebSearch(
  query: string,
  url: string,
  apiKey: string,
  timeout = 30_000,
): Promise<string> {
  if (!url) {
    return JSON.stringify({ error: "web search URL not configured" });
  }
  // TODO: apiKey 来源待定，当前允许空字符串（不鉴权）以便联调
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, history: [] }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return JSON.stringify({ error: `web search returned ${response.status}`, detail: errText });
    }

    const data = await response.json() as WebSearchResponse;
    return JSON.stringify(data);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return JSON.stringify({ error: "web search timed out" });
    }
    return JSON.stringify({ error: String(err) });
  } finally {
    clearTimeout(timer);
  }
}
