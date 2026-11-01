import { writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProcess } from "./process.js";
import type { AgentCliConfig } from "../resources/converter.js";
import type { CompressedMessage } from "../events/compress.js";
import type { ModelConfig } from "../types/resources.js";
import {
  EventType,
  type RunloopEvent,
} from "../types/events.js";
import { createEvent } from "../events/factory.js";
import { EventStateMachine } from "../events/state-machine.js";
import type { RunRequest } from "../types/api.js";

export interface AgentAdapter {
  /** Opt in to lifecycle events emitted by the server instead of duplicate CLI items. */
  readonly supportsServerToolEvents?: boolean;
  run(params: AgentRunParams): AsyncGenerator<RunloopEvent>;
  interrupt(): void;
  /**
   * 可选：由 adapter 产出**它自己**的"模型指令"（区别于通用 systemPrompt）。
   * runner 无条件调用、不感知具体 CLI——codex 用它写 model-instructions 文件，
   * 其它 adapter（如未来 claude）不实现则返回 undefined。把"模型提示词是不是 codex 形态"
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

export class CliAgentAdapter implements AgentAdapter {
  private agentProcess: AgentProcess | null = null;
  private tmpDir: string | null = null;
  private isWorkspaceTmp = false;
  private permissionMode: string;

  constructor(
    private readonly cliCommand: string,
    options?: { permissionMode?: string }
  ) {
    this.permissionMode = options?.permissionMode ?? "bypass_permissions";
  }

  async *run(params: AgentRunParams): AsyncGenerator<RunloopEvent> {
    const { conversationId, messages, config, model, cwd, systemPrompt, signal } =
      params;

    if (params.workspaceDir) {
      this.tmpDir = join(params.workspaceDir, ".runloop");
      await mkdir(this.tmpDir, { recursive: true });
      this.isWorkspaceTmp = true;
    } else {
      this.tmpDir = await mkdtemp(join(tmpdir(), "runloop-"));
    }
    const args = await this.buildArgs(
      config,
      messages,
      model,
      cwd,
      systemPrompt
    );

    this.agentProcess = new AgentProcess();

    const events: RunloopEvent[] = [];
    let resolveNext: ((value: IteratorResult<RunloopEvent>) => void) | null =
      null;
    let done = false;

    const queue: RunloopEvent[] = [];

    const enqueue = (event: RunloopEvent) => {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    const finish = () => {
      done = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: undefined as unknown as RunloopEvent, done: true });
      }
    };

    let turnIndex = params.startTurnIndex ?? 0;
    const sm = new EventStateMachine(conversationId);

    yield createEvent(EventType.TurnStart, conversationId, { turnIndex });

    this.agentProcess.on("stdout", (line: string) => {
      const parsed = this.parseLine(line, conversationId, sm);
      if (parsed) {
        for (const event of parsed) {
          events.push(event);
          enqueue(event);
        }
      }
    });

    this.agentProcess.on("stderr", (data: string) => {
      // stderr is informational, not events
    });

    this.agentProcess.on("exit", (code: number | null) => {
      for (const e of sm.flush()) enqueue(e);
      enqueue(
        createEvent(EventType.TurnEnd, conversationId, {
          turnIndex,
          stopReason: code === 0 ? "end_turn" : "cancelled",
        })
      );
      finish();
    });

    this.agentProcess.on("error", (err: Error) => {
      for (const e of sm.flush()) enqueue(e);
      enqueue(
        createEvent(EventType.RunError, conversationId, {
          error: { code: "PROCESS_ERROR", message: err.message },
        })
      );
      finish();
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        this.interrupt();
      });
    }

    const env: Record<string, string> = {};
    if (params.providerBaseUrl) {
      env.OPENAI_BASE_URL = `${params.providerBaseUrl}/v1`;
      env.OPENAI_API_KEY = params.providerToken ?? "runloop-proxy";
      env.NO_PROXY = "127.0.0.1,localhost";
      env.no_proxy = "127.0.0.1,localhost";
    } else if (model?.apiKey) {
      env.OPENAI_API_KEY = model.apiKey;
      if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }

    this.agentProcess.spawn({
      command: this.cliCommand,
      args,
      cwd: cwd ?? process.cwd(),
      env,
      timeout: 300_000,
    });

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          const event = await new Promise<IteratorResult<RunloopEvent>>(
            (resolve) => {
              resolveNext = resolve;
            }
          );
          if (event.done) break;
          yield event.value;
        }
      }

      while (queue.length > 0) {
        yield queue.shift()!;
      }
    } finally {
      await this.cleanup();
    }
  }

  interrupt(): void {
    this.agentProcess?.kill();
  }

  private async buildArgs(
    config: AgentCliConfig,
    messages: CompressedMessage[],
    model?: ModelConfig,
    cwd?: string,
    systemPrompt?: string
  ): Promise<string[]> {
    const args: string[] = ["-p", "--output-format", "json"];

    if (Object.keys(config.mcpConfig.mcpServers).length > 0 && this.tmpDir) {
      const mcpPath = join(this.tmpDir, "mcp-config.json");
      await writeFile(mcpPath, JSON.stringify(config.mcpConfig, null, 2));
      args.push("--mcp-config", mcpPath);
    }

    if (model?.model) {
      args.push("--model", model.model);
    }

    if (cwd) {
      args.push("--cwd", cwd);
    }

    const fullSystemPrompt = [systemPrompt, config.systemPromptAppend]
      .filter(Boolean)
      .join("\n\n");

    if (fullSystemPrompt) {
      args.push("--system-prompt", fullSystemPrompt);
    }

    args.push("--permission-mode", this.permissionMode);

    const transcript = this.buildTranscript(messages);
    if (transcript) {
      args.push(transcript);
    }

    return args;
  }

  private buildTranscript(messages: CompressedMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        parts.push(`[Context]\n${msg.content}`);
      } else if (msg.role === "user") {
        parts.push(`[User]\n${msg.content}`);
      } else if (msg.role === "assistant") {
        parts.push(`[Assistant]\n${msg.content}`);
      }
    }

    return parts.join("\n\n");
  }

  private parseLine(
    line: string,
    conversationId: string,
    sm: EventStateMachine
  ): RunloopEvent[] | null {
    try {
      const data = JSON.parse(line);
      return this.mapCliOutput(data, conversationId, sm);
    } catch {
      if (line.trim()) {
        return sm.textDelta(line);
      }
      return null;
    }
  }

  private mapCliOutput(
    data: Record<string, unknown>,
    conversationId: string,
    sm: EventStateMachine
  ): RunloopEvent[] {
    const events: RunloopEvent[] = [];

    if (data.type === "result") {
      const result = data.result as string;
      if (result) {
        events.push(...sm.textComplete(result));
      }

      const usage = data.usage as Record<string, unknown> | undefined;
      if (usage) {
        events.push(...sm.usage({
          inputTokens: usage.input_tokens as number | undefined,
          outputTokens: usage.output_tokens as number | undefined,
          cacheReadTokens: usage.cache_read_input_tokens as number | undefined,
          model: data.model as string | undefined,
          costUsd: data.total_cost_usd as number | undefined,
        }));
      }
    }

    return events;
  }

  private async cleanup(): Promise<void> {
    if (this.tmpDir && !this.isWorkspaceTmp) {
      try {
        await rm(this.tmpDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
    this.tmpDir = null;
  }
}
