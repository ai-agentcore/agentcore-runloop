import { writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProcess } from "./process.js";
import type { AgentAdapter, AgentRunParams } from "./adapter.js";
import type { AgentCliConfig } from "../resources/converter.js";
import type { CompressedMessage } from "../events/compress.js";
import type { ModelConfig } from "../types/resources.js";
import { EventType, type RunloopEvent } from "../types/events.js";
import { createEvent } from "../events/factory.js";
import { EventStateMachine } from "../events/state-machine.js";

interface StreamJsonMessage {
  type: "system" | "assistant" | "result";
  subtype?: string;
  [key: string]: unknown;
}

export class StreamJsonAdapter implements AgentAdapter {
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
      this.tmpDir = await mkdtemp(join(tmpdir(), "runloop-stream-"));
    }
    const args = await this.buildArgs(
      config,
      messages,
      model,
      cwd,
      systemPrompt
    );

    this.agentProcess = new AgentProcess();

    const queue: RunloopEvent[] = [];
    let resolveNext: ((value: IteratorResult<RunloopEvent>) => void) | null =
      null;
    let done = false;

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
      const events = this.parseStreamLine(line, conversationId, sm);
      if (events) {
        for (const event of events) {
          enqueue(event);
        }
      }
    });

    this.agentProcess.on("stderr", () => {});

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
      enqueue(
        createEvent(EventType.RunError, conversationId, {
          error: { code: "PROCESS_ERROR", message: err.message },
        })
      );
      finish();
    });

    if (signal) {
      signal.addEventListener("abort", () => this.interrupt());
    }

    this.agentProcess.spawn({
      command: this.cliCommand,
      args,
      cwd: cwd ?? process.cwd(),
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

  private parseStreamLine(
    line: string,
    conversationId: string,
    sm: EventStateMachine
  ): RunloopEvent[] | null {
    let data: StreamJsonMessage;
    try {
      data = JSON.parse(line);
    } catch {
      if (line.trim()) {
        return sm.textDelta(line);
      }
      return null;
    }

    const events: RunloopEvent[] = [];

    switch (data.type) {
      case "assistant": {
        const msg = data.message as Record<string, unknown> | undefined;
        const contentBlocks = (msg?.content ?? data.content) as
          | Array<{ type: string; text?: string }>
          | string
          | undefined;

        let textContent: string | undefined;
        if (typeof contentBlocks === "string") {
          textContent = contentBlocks;
        } else if (Array.isArray(contentBlocks)) {
          const texts = contentBlocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!);
          if (texts.length > 0) textContent = texts.join("");
        }

        if (textContent) {
          events.push(...sm.textDelta(textContent));
        }

        const usage = msg?.usage as Record<string, unknown> | undefined;
        if (usage) {
          events.push(...sm.usage({
            inputTokens: usage.input_tokens as number | undefined,
            outputTokens: usage.output_tokens as number | undefined,
            cacheReadTokens: usage.cache_read_input_tokens as number | undefined,
          }));
        }

        const toolUse = data.tool_use as
          | { name?: string; id?: string; input?: Record<string, unknown> }
          | undefined;
        if (toolUse?.name) {
          const tcId = toolUse.id ?? `tc-${Date.now()}`;
          events.push(...sm.toolCallStart(tcId, toolUse.name));
          if (toolUse.input) {
            events.push(...sm.toolCallExecuting(tcId, toolUse.input));
          }
        }

        const toolResult = data.tool_result as
          | { id?: string; content?: unknown; is_error?: boolean }
          | undefined;
        if (toolResult) {
          const tcId = toolResult.id ?? `tc-${Date.now()}`;
          if (toolResult.is_error) {
            events.push(...sm.toolCallError(tcId, {
              code: "TOOL_ERROR",
              message: String(toolResult.content),
            }));
          } else {
            events.push(...sm.toolCallResult(tcId, toolResult.content));
          }
        }
        break;
      }

      case "result": {
        events.push(...sm.flush());
        const resultUsage = data.usage as Record<string, unknown> | undefined;
        if (resultUsage) {
          events.push(...sm.usage({
            inputTokens: resultUsage.input_tokens as number | undefined,
            outputTokens: resultUsage.output_tokens as number | undefined,
            cacheReadTokens: resultUsage.cache_read_input_tokens as number | undefined,
            model: data.model as string | undefined,
            costUsd: data.total_cost_usd as number | undefined,
          }));
        }
        break;
      }

      case "system":
        break;
    }

    return events.length > 0 ? events : null;
  }

  private async buildArgs(
    config: AgentCliConfig,
    messages: CompressedMessage[],
    model?: ModelConfig,
    cwd?: string,
    systemPrompt?: string
  ): Promise<string[]> {
    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream",
    ];

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

  private async cleanup(): Promise<void> {
    if (this.tmpDir && !this.isWorkspaceTmp) {
      try {
        await rm(this.tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    this.tmpDir = null;
  }
}
