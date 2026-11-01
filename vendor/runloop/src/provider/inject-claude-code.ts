/**
 * claude-code 的模型注入器（AD-012/AD-013）。
 *
 * claude-code 走 Anthropic Messages 协议，读 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`（不读 OPENAI_*）。
 * 把它指向本地 ModelProviderProxy 的 `/v1/messages` 入站路由（translate-messages 完成 Messages↔Chat 翻译），
 * 用 proxy 颁发的 session token 作 API key（proxy 校验入站 Authorization）。
 *
 * 与 codex 的注入（src/acp/codex-adapter.ts 写 config.toml + OPENAI_*）对称——本注入器供未来的
 * claude-code adapter 调用；当前生产 CLI 为 codex。
 */
export interface ClaudeCodeInjectOptions {
  /** ModelProviderProxy.baseUrl，如 http://127.0.0.1:54321 */
  proxyBaseUrl: string;
  /** ModelProviderProxy.sessionToken */
  token: string;
}

export function buildClaudeCodeEnv(opts: ClaudeCodeInjectOptions): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `${opts.proxyBaseUrl.replace(/\/+$/, "")}/v1`,
    ANTHROPIC_API_KEY: opts.token,
    // 绕过宿主 HTTP(S)_PROXY，否则本地 127.0.0.1 连接会被路由到外部代理（L-017）。
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}
