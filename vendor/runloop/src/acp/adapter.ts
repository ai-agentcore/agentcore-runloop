import type { AgentCliConfig } from "../resources/converter.js";
import type { CompressedMessage } from "../events/compress.js";
import type { ModelConfig } from "../types/resources.js";
import type { RunloopEvent } from "../types/events.js";
import type { RunRequest } from "../types/api.js";

export interface AgentAdapter {
  /** Opt in to lifecycle events emitted by the server instead of duplicate CLI items. */
  readonly supportsServerToolEvents?: boolean;
  run(params: AgentRunParams): AsyncGenerator<RunloopEvent>;
  interrupt(): void;
  /**
   * 可选：由 adapter 产出**它自己**的"模型指令"（区别于通用 systemPrompt）。
   * runner 无条件调用、不感知具体 CLI——codex 用它写 model-instructions 文件，
   * 这个判断从 runner 收敛进 adapter（AD-023 的 buildModelPrompt 由 codex-adapter 持有）。
   */
  prepareModelInstructions?(request: RunRequest): string | undefined;
}

export interface AgentRunParams {
  conversationId: string;
  messages: CompressedMessage[];
  config: AgentCliConfig;
  model?: ModelConfig;
  cwd?: string;
  systemPrompt?: string;
  /** adapter 自产的模型指令（由 adapter.prepareModelInstructions 产出；codex 写入 model-instructions 文件）。 */
  modelInstructions?: string;
  signal?: AbortSignal;
  providerBaseUrl?: string;
  workspaceDir?: string;
  onStreamDelta?: (listener: (content: string) => void) => (() => void);
  /** 上游自配、注入 agent CLI 进程的环境变量（runloop 必备变量优先级最高，仍过降权 env 白名单）。 */
  env?: Record<string, string>;
  /** 起始 turnIndex（跨 run 单调递增）——由 runner 从历史末个 turn.end.turnIndex 推导。 */
  startTurnIndex?: number;
  /** ModelProviderProxy 颁发的会话 token，用作 agent CLI 的 API key（proxy 校验入站 Authorization）。 */
  providerToken?: string;
  /**
   * 委派工具的最终名集合（权威来源 = `collectDelegationToolNames`）。adapter 据此识别「这是委派」
   * 并抑制 codex 自产的重复卡片（AD-024）——取代按 `delegate_to_` 字符串前缀猜（严格统一命名 +
   * 哈希压缩后名字不再有固定前缀，必须按集合判定）。
   */
  delegationToolNames?: Set<string>;
  /**
   * 客户端工具的最终名集合（消费通道 2）。adapter 据此抑制 codex 自产的重复 mcp_tool_call 卡片——
   * 权威 toolcall.start/end 由 agentcore-mcp server 经 injectEmit 发，codex 的卡片不重复渲染（同委派抑制）。
   */
  clientToolNames?: Set<string>;
  /** Exact names whose lifecycle is emitted by the run's MCP server. */
  serverToolNames?: Set<string>;
  /**
   * 命令执行是否走 runloop 自有 `shell` MCP 工具（AD-030）。runner 据 features.execViaMcp 解析后传入，
   * adapter 据此决定是否关掉自身内建 shell（codex：`[features] shell_tool = false`）。
   */
  execViaMcp?: boolean;
  localSandbox?: NonNullable<RunRequest["localSandbox"]>;
}
