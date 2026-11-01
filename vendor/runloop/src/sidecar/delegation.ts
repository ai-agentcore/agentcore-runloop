/**
 * 子 Agent 委派的传输层标记 —— 单一真相源。
 *
 * 委派通过 codex 的 exec_command 跑 `.tools/agentrun call ...` shell 命令隧道化执行。
 * codex 只在命令结束时吐 item.completed，且用自己的 item_N id；而 sidecar 在执行期间
 * 就用 delegate-xxx id 流式发 output_delta —— 两套 id、时序错位。
 *
 * 根本修法：让 sidecar（委派层）拥有完整语义生命周期（start→output_delta*→result，同一 id），
 * adapter 检测到 exec_command 的 cmd 是 `.tools/agentrun call` 时抑制掉 codex 的重复卡片。
 * 该常量是 adapter 抑制判定与 workspace CLI 脚本生成的唯一共享标记，禁止内联字符串。
 */
/** 从 `.tools/agentrun call <tool> ...` 命令里解析被调用的工具名（cli 降级模式用）。 */
const CALL_RE = /\.tools\/agentrun\s+call\s+["']?(\S+)/;

/**
 * 判断一条 shell 命令（cli 降级模式）是否是子 Agent **委派** 调用。
 *
 * 严格统一命名 + 哈希压缩后委派名不再有固定 `delegate_to_` 前缀，故按**委派名集合**（权威来源
 * `collectDelegationToolNames`）判定：解析 `.tools/agentrun call <tool>` 的 `<tool>`，命中集合即委派。
 * 只对委派抑制 codex 卡片，因为只有委派的完整生命周期由 sidecar 拥有（见 AD-024）；其它 agentrun
 * 工具（sandbox/kb/memory/functioncall）的 sidecar 不发 tool_call 事件，抑制会让其在客户端消失。
 *
 * 解析「call 后紧跟的工具名」而非裸 includes，避免误伤仅在文本里提到该名的正常命令
 * （如 `grep "... call x_delegate" .`、`cat AGENTS.md`、echo 帮助文本、system prompt 内嵌示例）。
 */
export function isDelegationCommand(command: string, delegationToolNames: Set<string>): boolean {
  const name = CALL_RE.exec(command)?.[1]?.replace(/["']$/, "");
  return name !== undefined && delegationToolNames.has(name);
}
