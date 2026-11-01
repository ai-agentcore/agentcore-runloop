// 标签治理（高基数防护）——可观测性的核心纪律。
//
// 暴露给 metrics 的标签一律是**受控的低基数枚举**，绝不放入：
//   prompt 文本、模型输出、工具参数、runId / conversationId / toolCallId /
//   accountId / userId / traceId、原始 error message。
//
// 与 super-agent observability 的差别：runloop 已有结构化字段（ErrorCode 枚举、
// run.end.reason、内置工具名集合），因此这里**直接从结构化字段映射**，不做
// super-agent 那种 error message / tool name 的字符串启发式猜测。

export type Labels = Record<string, string>;

const StatusSuccess = "success";
const StatusError = "error";
const StatusInterrupted = "interrupted";
const StatusTimeout = "timeout";
const StatusSuspended = "suspended";
const StatusUnknown = "unknown";

/** run.end.reason → 低基数 status 标签。reason 本身已是 spec 枚举。 */
export function runStatusFromReason(reason: unknown): string {
  switch (reason) {
    case "completed":
      return StatusSuccess;
    case "error":
      return StatusError;
    case "interrupted":
      return StatusInterrupted;
    case "timeout":
      return StatusTimeout;
    case "hitl_pending":
    case "tool_pending":
      return StatusSuspended;
    default:
      return StatusUnknown;
  }
}

/** ErrorCode 枚举值（已是有界集合）→ 规范化为小写 snake 标签；空则 none。 */
export function normalizeErrorCode(code: unknown): string {
  const raw = String(code ?? "").trim();
  if (!raw) return "none";
  return raw.toLowerCase();
}

/** toolresult.end.isError → 工具调用 status。 */
export function toolStatus(isError: unknown): string {
  return isError ? "failure" : StatusSuccess;
}

/**
 * 工具名 → 有界的 tool_type 标签。
 * 工具名（如平台资源名、codex 全限定 mcp__agentcore__<name>）是潜在高基数，
 * 绝不能直接做标签——这里归一到一小撮类别。
 */
export function classifyToolType(toolName: unknown): string {
  let name = String(toolName ?? "").trim();
  // 剥掉 codex 全限定前缀**正好是** `mcp__agentcore__`（聚合器 server 名固定 agentcore）。不能用贪婪的
  // `^mcp__<任意>__`：AD-029 的 MCP 型工具名本身以 `mcp__<资源>__` 起头（如 `mcp__calc__add`），贪婪剥会把
  // type+资源段误吃掉（L-054，同 codex-adapter mcp_tool_call 还原）。
  name = name.replace(/^mcp__agentcore__/, "");
  name = name.toLowerCase();

  if (name === "") return StatusUnknown;
  if (name === "bash") return "exec";
  if (["read_file", "write_file", "edit_file", "grep", "glob"].includes(name)) return "file";
  if (name === "request_user_input" || name === "request_confirmation") return "hitl";
  // 统一命名 `<type>__<name>__<op>`（AD-029）：按类型首段分类（agent→subagent，其余资源→platform）；
  // 兼容旧式 `<name>_delegate` / `delegate_to_*`。
  if (name.startsWith("agent__") || name.endsWith("_delegate") || name.includes("delegate")) return "subagent";
  // 其余视为平台资源工具（FunctionCall / Skill / Sandbox / 下游 MCP 等）。
  return "platform";
}

/**
 * 模型名 → model 标签。模型 id 是有界集合（claude-* / gpt-* / qwen-* 等），
 * 可直接作标签用于成本维度切分；但 model 来自各 agent CLI 上报，需防御异常值：
 * 归一为小写并限长，空值回落 unknown，超长或含非常规字符回落 other，避免高基数。
 */
export function normalizeModel(model: unknown): string {
  const raw = String(model ?? "").trim().toLowerCase();
  if (!raw) return StatusUnknown;
  if (raw.length > 64 || !/^[a-z0-9][a-z0-9._/:-]*$/.test(raw)) return "other";
  return raw;
}

/** HTTP 状态码 → status_class（2xx / 4xx / 5xx …）。 */
export function httpStatusClass(status: number): string {
  if (!Number.isFinite(status) || status <= 0) return "0";
  return `${Math.floor(status / 100)}xx`;
}

/** HTTP 状态码 → 有界 error_type 标签。 */
export function httpErrorType(status: number): string {
  if (!Number.isFinite(status) || status < 400) return "none";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 503) return "upstream_unavailable";
  if (status < 500) return "invalid_request";
  return "internal_error";
}

/**
 * HTTP 路径归一：把疑似 id 的段替换为 :id，避免高基数。
 * 仅在框架未暴露路由模板时兜底使用。
 */
export function normalizeHttpPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg === "") return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/[0-9a-fA-F-]{16,}/.test(seg)) return ":id";
      if (/[0-9]/.test(seg) && seg.length >= 12) return ":id";
      return seg;
    })
    .join("/");
}
