import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProcess } from "./process.js";
import type { AgentAdapter, AgentRunParams } from "./adapter.js";
import type { AgentCliConfig } from "../resources/converter.js";
import { EventType, type RunloopEvent } from "../types/events.js";
import { createEvent } from "../events/factory.js";
import { EventStateMachine } from "../events/state-machine.js";
import { Logger, type LoggerOptions } from "../util/logger.js";
import { nanoid } from "nanoid";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpAdapterOptions {
  logger?: LoggerOptions;
}

export abstract class BaseAcpAdapter implements AgentAdapter {
  protected log: Logger;

  constructor(
    protected readonly cliCommand: string,
    options?: AcpAdapterOptions
  ) {
    this.log = new Logger("acp", options?.logger ?? {});
  }

  abstract run(params: AgentRunParams): AsyncGenerator<RunloopEvent>;
  abstract interrupt(): void;

  protected trace(direction: ">>>" | "<<<", data: string): void {
    this.log.debug(direction === ">>>" ? "acp out" : "acp in", { data: data.slice(0, 500) });
  }

  protected mapSessionUpdate(
    update: Record<string, unknown>,
    conversationId: string,
    enqueue: (event: RunloopEvent) => void,
    sm: EventStateMachine
  ): void {
    const updateType =
      (update.sessionUpdate as string) ?? (update.type as string);

    this.log.debug("session update", { updateType, update: JSON.stringify(update).slice(0, 200) });

    switch (updateType) {
      case "message":
      case "agent_message_chunk":
      case "content":
      case "content_chunk": {
        const raw = update.textContent ?? update.content ?? update.text;
        let text: string | undefined;
        if (typeof raw === "string") {
          text = raw;
        } else if (raw && typeof raw === "object") {
          const block = raw as { type?: string; text?: string };
          if (block.type === "text" && block.text) text = block.text;
        }
        if (text) {
          for (const e of sm.textDelta(text)) enqueue(e);
        }
        break;
      }

      case "tool_call":
      case "tool_call_update": {
        const toolCall = (update.toolCall ?? update) as Record<string, unknown>;
        const status = toolCall.status as string;
        const toolCallId = (toolCall.toolCallId as string) ?? nanoid();
        const toolName = (toolCall.name as string) ?? "unknown";

        if (status === "pending" || status === "in_progress") {
          for (const e of sm.toolCallStart(toolCallId, toolName)) enqueue(e);
        } else if (status === "completed") {
          for (const e of sm.toolCallResult(toolCallId, toolCall.rawOutput ?? toolCall.content)) enqueue(e);
        } else if (status === "failed") {
          for (const e of sm.toolCallError(toolCallId, { code: "TOOL_FAILED", message: String(toolCall.rawOutput ?? "unknown error") })) enqueue(e);
        }
        break;
      }

      case "plan": {
        const entries = update.entries as Array<{ content: string; status: string; priority?: string }> | undefined;
        if (entries) {
          enqueue(createEvent(EventType.PlanUpdate, conversationId, { entries }));
        }
        break;
      }

      case "available_commands_update":
      case "config_option_update":
      case "current_mode_update":
        break;
    }
  }

  protected handleAgentRequest(
    msg: JsonRpcMessage,
    conversationId: string,
    enqueue: (event: RunloopEvent) => void,
    respond: (id: number, result: Record<string, unknown>) => void
  ): void {
    const method = msg.method!;
    const id = msg.id!;

    if (method === "session/request_permission") {
      const params = msg.params as Record<string, unknown>;
      const toolCall = params?.toolCall as Record<string, unknown>;
      const options = params?.options as
        | Array<{ optionId: string; name: string; kind: string }> | undefined;

      enqueue(createEvent(EventType.ToolcallSuspend, conversationId, {
        toolCallId: (toolCall?.toolCallId as string) ?? nanoid(),
        toolName: (toolCall?.name as string) ?? "unknown",
        args: (toolCall?.input as Record<string, unknown>) ?? {},
        reason: "model_request" as const,
        options: (options ?? []).map((o) => ({ optionId: o.optionId, label: o.name, kind: o.kind })),
      }));

      const allowOption = options?.find((o) => o.kind === "allow_once");
      respond(id, { outcome: { outcome: "selected", optionId: allowOption?.optionId ?? "allow" } });
      return;
    }

    respond(id, {});
  }

  protected buildTranscript(
    messages: Array<{ role: string; content: string }>,
    systemPrompt?: string,
    systemPromptAppend?: string
  ): string {
    const parts: string[] = [];
    if (systemPrompt) parts.push(systemPrompt);
    if (systemPromptAppend) parts.push(systemPromptAppend);
    for (const msg of messages) {
      if (msg.role === "system") parts.push(`[Context]\n${msg.content}`);
      else if (msg.role === "user") parts.push(msg.content);
      else if (msg.role === "assistant") parts.push(`[Assistant]\n${msg.content}`);
    }
    return parts.join("\n\n");
  }

  protected buildMcpServers(config: AgentCliConfig): Array<Record<string, unknown>> {
    return Object.entries(config.mcpConfig.mcpServers).map(([name, entry]) => ({
      name,
      ...(entry.command ? { command: entry.command, args: entry.args ?? [], env: entry.env ? Object.entries(entry.env).map(([k, v]) => ({ name: k, value: v })) : [] } : {}),
      ...(entry.url ? { url: entry.url } : {}),
    }));
  }
}

// --- ACP Process Mode: spawn per request, kill when done ---

export class AcpProcessAdapter extends BaseAcpAdapter {
  private agentProcess: AgentProcess | null = null;
  private pendingRequests = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  async *run(params: AgentRunParams): AsyncGenerator<RunloopEvent> {
    const { conversationId, messages, config, cwd, systemPrompt, signal } = params;

    this.agentProcess = new AgentProcess();
    const queue: RunloopEvent[] = [];
    let resolveNext: ((value: IteratorResult<RunloopEvent>) => void) | null = null;
    let done = false;

    const enqueue = (event: RunloopEvent) => {
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: event, done: false }); }
      else queue.push(event);
    };
    const finish = () => {
      done = true;
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined as unknown as RunloopEvent, done: true }); }
    };

    let turnIndex = params.startTurnIndex ?? 0;
    const sm = new EventStateMachine(conversationId);
    const respond = (id: number, result: Record<string, unknown>) => {
      const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
      this.trace(">>>", msg);
      this.agentProcess?.write(msg);
    };

    this.agentProcess.on("stdout", (line: string) => {
      this.trace("<<<", line);
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(line); } catch { return; }

      if (msg.id !== undefined && msg.method) {
        this.handleAgentRequest(msg, conversationId, enqueue, respond);
        return;
      }
      if (msg.id !== undefined && !msg.method) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) { this.pendingRequests.delete(msg.id); msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result ?? {}); }
        return;
      }
      if (msg.method === "session/update") {
        const p = msg.params as Record<string, unknown>;
        this.mapSessionUpdate((p?.update ?? p) as Record<string, unknown>, conversationId, enqueue, sm);
      }
    });
    this.agentProcess.on("stderr", () => {});
    this.agentProcess.on("exit", (code: number | null) => {
      this.rejectAllPending(new Error("process exited"));
      for (const e of sm.flush()) enqueue(e);
      enqueue(createEvent(EventType.TurnEnd, conversationId, { turnIndex, stopReason: code === 0 ? "end_turn" : "cancelled" }));
      finish();
    });
    this.agentProcess.on("error", (err: Error) => {
      this.rejectAllPending(err);
      for (const e of sm.flush()) enqueue(e);
      enqueue(createEvent(EventType.RunError, conversationId, { error: { code: "PROCESS_ERROR", message: err.message } }));
      finish();
    });

    if (signal) signal.addEventListener("abort", () => this.interrupt());

    this.agentProcess.spawn({ command: this.cliCommand, args: ["--acp"], cwd: cwd ?? process.cwd(), timeout: 300_000 });

    try {
      let initFailed = false;
      try {
        await this.sendRequest("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "runloop", version: "0.1.0" } });
        const mcpServers = this.buildMcpServers(config);
        const sessionResult = await this.sendRequest("session/new", { cwd: cwd ?? process.cwd(), mcpServers });
        const acpSessionId = (sessionResult?.conversationId as string) ?? nanoid();
        yield createEvent(EventType.TurnStart, conversationId, { turnIndex });
        const transcript = this.buildTranscript(messages, systemPrompt, config.systemPromptAppend);
        this.sendRequest("session/prompt", { conversationId: acpSessionId, prompt: [{ type: "text", text: transcript }] }).catch(() => {});
      } catch { initFailed = true; }

      while (!done && !initFailed) {
        if (queue.length > 0) yield queue.shift()!;
        else { const ev = await new Promise<IteratorResult<RunloopEvent>>((r) => { resolveNext = r; }); if (ev.done) break; yield ev.value; }
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      this.agentProcess?.kill();
    }
  }

  interrupt(): void { this.agentProcess?.kill(); }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.trace(">>>", msg);
    this.agentProcess?.write(msg);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      setTimeout(() => { if (this.pendingRequests.has(id)) { this.pendingRequests.delete(id); reject(new Error(`ACP request ${method} timed out`)); } }, 30_000);
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pendingRequests) p.reject(err);
    this.pendingRequests.clear();
  }
}

// --- ACP Server Mode: long-running process, reuse across requests ---

interface AcpServerConnectionOptions {
  command: string;
  logger: Logger;
  env?: Record<string, string>;
  defaultArgs?: string[];
  extraArgs?: string[];
}

class AcpServerConnection {
  private process: AgentProcess;
  private nextId = 1;
  private initialized = false;
  private log: Logger;
  private options: AcpServerConnectionOptions;
  private pendingRequests = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private updateListeners = new Map<string, (u: Record<string, unknown>) => void>();
  private requestHandlers = new Map<string, (m: JsonRpcMessage) => void>();

  constructor(options: AcpServerConnectionOptions) {
    this.process = new AgentProcess();
    this.log = options.logger;
    this.options = options;
  }

  async start(cwd: string): Promise<void> {
    if (this.initialized) return;
    this.process.on("stdout", (line: string) => this.handleLine(line));
    this.process.on("stderr", (data: string) => {
      this.log.debug("stderr", { data: data.trim() });
    });
    this.process.on("error", (err: Error) => {
      this.log.error("process error", { error: err.message });
      this.rejectAllPending(err);
      this.initialized = false;
    });
    this.process.on("exit", (code: number | null) => {
      this.log.info("process exit", { code });
      this.rejectAllPending(new Error(`ACP process exited with code ${code}`));
      this.initialized = false;
    });

    const args = [
      ...(this.options.defaultArgs ?? []),
      ...(this.options.extraArgs ?? []),
    ];
    this.process.spawn({
      command: this.options.command,
      args,
      cwd,
      env: this.options.env,
    });
    await this.sendRequest("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "runloop", version: "0.1.0" } });
    this.initialized = true;
  }

  async createSession(cwd: string, mcpServers: Array<Record<string, unknown>>): Promise<string> {
    const r = await this.sendRequest("session/new", { cwd, mcpServers });
    return (r?.conversationId as string) ?? nanoid();
  }

  async prompt(
    acpSessionId: string, text: string,
    onUpdate: (u: Record<string, unknown>) => void,
    onRequest: (m: JsonRpcMessage) => void
  ): Promise<Record<string, unknown>> {
    this.updateListeners.set(acpSessionId, onUpdate);
    this.requestHandlers.set(acpSessionId, onRequest);
    try {
      return await this.sendRequest("session/prompt", { conversationId: acpSessionId, prompt: [{ type: "text", text }] });
    } finally {
      this.updateListeners.delete(acpSessionId);
      this.requestHandlers.delete(acpSessionId);
    }
  }

  cancel(acpSessionId: string): void { this.sendNotification("session/cancel", { conversationId: acpSessionId }); }
  isAlive(): boolean { return this.initialized && !this.process.exited; }
  respondToAgent(id: number, result: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
    this.trace(">>>", msg);
    this.process.write(msg);
  }

  private handleLine(line: string): void {
    this.trace("<<<", line);
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.id !== undefined && msg.method) {
      const sid = (msg.params as Record<string, unknown>)?.conversationId as string | undefined;
      for (const [s, handler] of this.requestHandlers) { if (!sid || sid === s) { handler(msg); return; } }
      this.respondToAgent(msg.id!, {});
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = this.pendingRequests.get(msg.id); if (p) { this.pendingRequests.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? {}); }
      return;
    }
    if (msg.method === "session/update") {
      const params = msg.params as Record<string, unknown>;
      const sid = params?.conversationId as string | undefined;
      if (sid) { const l = this.updateListeners.get(sid); if (l) l((params.update ?? params) as Record<string, unknown>); }
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.trace(">>>", msg);
    this.process.write(msg);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      setTimeout(() => { if (this.pendingRequests.has(id)) { this.pendingRequests.delete(id); reject(new Error(`ACP ${method} timed out`)); } }, 300_000);
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.trace(">>>", msg);
    this.process.write(msg);
  }

  private rejectAllPending(err: Error): void { for (const [, p] of this.pendingRequests) p.reject(err); this.pendingRequests.clear(); }
  private trace(dir: ">>>" | "<<<", data: string): void {
    this.log.debug(dir === ">>>" ? "acp out" : "acp in", { data: data.slice(0, 500) });
  }
}

const serverConnections = new Map<string, AcpServerConnection>();

export class AcpServerAdapter extends BaseAcpAdapter {
  private connection: AcpServerConnection | null = null;
  private acpSessionId: string | null = null;
  private defaultArgs: string[];

  constructor(
    cliCommand: string,
    options?: AcpAdapterOptions & { defaultArgs?: string[] }
  ) {
    super(cliCommand, options);
    this.defaultArgs = options?.defaultArgs ?? [];
  }

  async *run(params: AgentRunParams): AsyncGenerator<RunloopEvent> {
    const { conversationId, messages, config, cwd, systemPrompt, signal, model } = params;
    const workingDir = cwd ?? process.cwd();

    const { env, extraArgs, connKey } = this.buildModelConfig(model, params.providerBaseUrl, params.providerToken);

    let conn = serverConnections.get(connKey);
    if (!conn || !conn.isAlive()) {
      conn = new AcpServerConnection({
        command: this.cliCommand,
        logger: this.log,
        env,
        defaultArgs: this.defaultArgs,
        extraArgs,
      });
      serverConnections.set(connKey, conn);
    }
    this.connection = conn;

    try { await conn.start(workingDir); } catch (err) {
      yield createEvent(EventType.RunError, conversationId, { error: { code: "ACP_INIT_FAILED", message: err instanceof Error ? err.message : String(err) } });
      return;
    }

    let acpSessionId: string;
    try {
      acpSessionId = await conn.createSession(workingDir, this.buildMcpServers(config));
      this.acpSessionId = acpSessionId;
    } catch (err) {
      yield createEvent(EventType.RunError, conversationId, { error: { code: "ACP_SESSION_FAILED", message: err instanceof Error ? err.message : String(err) } });
      return;
    }

    const queue: RunloopEvent[] = [];
    let resolveNext: ((value: IteratorResult<RunloopEvent>) => void) | null = null;
    let done = false;
    const enqueue = (event: RunloopEvent) => {
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: event, done: false }); }
      else queue.push(event);
    };
    const finish = () => { done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined as unknown as RunloopEvent, done: true }); } };

    let turnIndex = params.startTurnIndex ?? 0;
    const sm = new EventStateMachine(conversationId);
    yield createEvent(EventType.TurnStart, conversationId, { turnIndex });
    if (signal) signal.addEventListener("abort", () => this.interrupt());

    const transcript = this.buildTranscript(messages, systemPrompt, config.systemPromptAppend);
    const respond = (id: number, result: Record<string, unknown>) => conn!.respondToAgent(id, result);

    conn.prompt(acpSessionId, transcript,
      (update) => this.mapSessionUpdate(update, conversationId, enqueue, sm),
      (msg) => this.handleAgentRequest(msg, conversationId, enqueue, respond)
    ).then((result) => {
      for (const e of sm.flush()) enqueue(e);
      const usage = result?.usage as Record<string, unknown> | undefined;
      if (usage) enqueue(createEvent(EventType.RunUsage, conversationId, { inputTokens: usage.inputTokens as number | undefined, outputTokens: usage.outputTokens as number | undefined }));
      enqueue(createEvent(EventType.TurnEnd, conversationId, { turnIndex, stopReason: (result?.stopReason as string) ?? "end_turn" }));
      finish();
    }).catch((err) => {
      for (const e of sm.flush()) enqueue(e);
      enqueue(createEvent(EventType.RunError, conversationId, { error: { code: "ACP_PROMPT_FAILED", message: err instanceof Error ? err.message : String(err) } }));
      finish();
    });

    while (!done) {
      if (queue.length > 0) yield queue.shift()!;
      else { const ev = await new Promise<IteratorResult<RunloopEvent>>((r) => { resolveNext = r; }); if (ev.done) break; yield ev.value; }
    }
    while (queue.length > 0) yield queue.shift()!;
  }

  interrupt(): void { if (this.connection && this.acpSessionId) this.connection.cancel(this.acpSessionId); }

  private buildModelConfig(
    model?: import("../types/resources.js").ModelConfig,
    providerBaseUrl?: string,
    providerToken?: string
  ): {
    env: Record<string, string>;
    extraArgs: string[];
    connKey: string;
  } {
    const env: Record<string, string> = {};
    const extraArgs: string[] = [];

    if (providerBaseUrl) {
      env.OPENAI_API_KEY = providerToken ?? "runloop-proxy";
      env.OPENAI_BASE_URL = `${providerBaseUrl}/v1`;
      env.NO_PROXY = "127.0.0.1,localhost";
      env.no_proxy = "127.0.0.1,localhost";
      extraArgs.push("-c", `openai_base_url="${providerBaseUrl}/v1"`);

      if (this.cliCommand.includes("codex")) {
        const codexHome = join(tmpdir(), `runloop-codex-acp-${process.pid}`);
        mkdirSync(codexHome, { recursive: true });
        writeFileSync(
          join(codexHome, "config.toml"),
          `openai_base_url = "${providerBaseUrl}/v1"\n`
        );
        // Codex 0.155 requires auth_mode + OPENAI_API_KEY. The old mode field selects
        // ChatGPT auth and waits up to 5s for user settings before the first model call.
        // Store only the per-session proxy token, never the upstream model credential.
        writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: env.OPENAI_API_KEY }));
        env.CODEX_HOME = codexHome;
      }
    } else {
      if (model?.apiKey) env.OPENAI_API_KEY = model.apiKey;
      if (model?.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }
    if (model?.model) {
      extraArgs.push("-c", `model="${model.model}"`);
    }

    const connKey = [
      this.cliCommand,
      providerBaseUrl ?? model?.baseUrl ?? "",
      model?.model ?? "",
    ].join("|");

    return { env, extraArgs, connKey };
  }
}

export { AcpProcessAdapter as AcpAdapter };
