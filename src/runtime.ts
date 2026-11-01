import { createHash, randomUUID } from "node:crypto";
import { AgentCore, type Tool } from "alibabacloud-agentcore-sdk";
import type { MCPClient } from "alibabacloud-agentcore-sdk/mcp";
import type { ModelClient, ModelMessage, ModelParameters, ModelResponse } from "alibabacloud-agentcore-sdk/model";
import { skillTools, type Skill } from "alibabacloud-agentcore-sdk/skill";
import type { Config } from "./config.js";
import { errorDiagnostics, logSafeError, type ErrorDiagnostics } from "./error-diagnostics.js";
import { measureStartup, type StartupTimingRecorder } from "./startup-timing.js";
import {
  loadMcpManifestCatalog,
  saveMcpManifestCatalog,
  type CachedMcpTool,
  type McpManifestCatalog,
} from "./mcp-manifest-cache.js";

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface SkillDescriptor {
  name: string;
  version?: string;
  description: string;
  root: string;
  instruction: string;
}

export interface ResourceWarning {
  kind: "mcp" | "skill";
  resource: string;
  code: "RESOURCE_UNAVAILABLE" | "RESOURCE_TIMEOUT" | "RESOURCE_WARMING" | "RESOURCE_STALE";
  diagnostics: ErrorDiagnostics & { stage?: McpDiscoveryStage };
}

export interface Manifest {
  model: { connection: string; name: string };
  tools: ToolDescriptor[];
  skills: SkillDescriptor[];
  resourceWarnings?: ResourceWarning[];
}

export class RuntimeInitializationError extends Error {
  readonly code = "MODEL_RESOURCE_NOT_READY" as const;

  constructor(cause?: unknown) {
    super("The configured AgentCore model resource is not ready");
    this.name = "RuntimeInitializationError";
    this.cause = cause;
  }
}

export interface Runtime {
  manifest(): Promise<Manifest>;
  completion(messages: readonly ModelMessage[], parameters: ModelParameters, signal?: AbortSignal): Promise<ModelResponse>;
  stream(messages: readonly ModelMessage[], parameters: ModelParameters, signal?: AbortSignal): AsyncGenerator<ModelResponse>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  credential(name: string): Promise<string>;
  close(): Promise<void>;
}

interface InvokableTool {
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
  invoke(arguments_: Record<string, unknown>): Promise<unknown>;
}

function exposedToolName(group: string, resource: string, name: string): string {
  const identity = `${group}:${resource}:${name}`;
  const slug = `${group}_${resource}_${name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `${slug}_${digest}`;
}

function skillOptions(version: string | undefined): { version?: string } | undefined {
  if (!version) return undefined;
  return { version };
}

function reportResourceFailure(stage: "model" | "mcp" | "skill", resource: string, error: unknown): void {
  logSafeError("agentcore_resource_failed", stage, error, { resource });
}

class McpDiscoveryTimeoutError extends Error {
  readonly code = "MCP_DISCOVERY_TIMEOUT";

  constructor(readonly stage: McpDiscoveryStage) {
    super("AgentCore MCP discovery timed out");
    this.name = "McpDiscoveryTimeoutError";
  }
}

type McpDiscoveryStage = "resolve" | "connect" | "list_tools";

const MCP_RECOVERY_BASE_DELAY_MS = 1_000;
const MCP_RECOVERY_MAX_DELAY_MS = 30_000;

async function withMcpDiscoveryTimeout<T>(
  operation: (signal: AbortSignal, setStage: (stage: McpDiscoveryStage) => void) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage: McpDiscoveryStage = "resolve";
  const controller = new AbortController();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new McpDiscoveryTimeoutError(stage);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      operation(controller.signal, current => { stage = current; }),
      timeout,
    ]);
  }
  finally { if (timer) clearTimeout(timer); }
}

function isMcpConnectFailure(error: unknown): boolean {
  return error instanceof Error && error.message === "MCP session open timed out";
}

function mcpRecoveryDelay(attempt: number): number {
  return Math.min(MCP_RECOVERY_BASE_DELAY_MS * (2 ** attempt), MCP_RECOVERY_MAX_DELAY_MS);
}

interface McpLoadResult {
  tools: CachedMcpTool[];
  warnings: ResourceWarning[];
}

interface McpDiscoveryState {
  resource: string;
  promise: Promise<McpLoadResult>;
  result?: McpLoadResult;
}

export class AgentCoreRuntime implements Runtime {
  private readonly core: AgentCore;
  private readonly tools = new Map<string, InvokableTool>();
  private initialization?: Promise<Manifest>;
  private currentManifest?: Manifest;
  private model?: ModelClient;
  private readonly mcpRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly mcpClients = new Map<string, MCPClient>();
  private readonly mcpToolNames = new Map<string, Set<string>>();
  private mcpCatalog: McpManifestCatalog = {};
  private pendingMcpDiscoveries: McpDiscoveryState[] = [];
  private cacheWrite: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly config: Config,
    core?: AgentCore,
    private readonly recordStartupTiming?: StartupTimingRecorder,
  ) {
    this.core = core ?? AgentCore.auto({ skillWorkspaceDir: config.skillWorkspace });
  }

  manifest(): Promise<Manifest> {
    if (this.currentManifest) return Promise.resolve(this.currentManifest);
    if (!this.initialization) {
      const initialization = this.initialize().then(manifest => {
        this.currentManifest = manifest;
        this.scheduleMcpRecoveries(manifest);
        this.observePendingMcpDiscoveries();
        return manifest;
      });
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = undefined;
      });
    }
    return this.initialization;
  }

  async completion(messages: readonly ModelMessage[], parameters: ModelParameters, signal?: AbortSignal): Promise<ModelResponse> {
    const model = await this.getModel();
    return model.completion(messages, parameters, { signal });
  }

  async *stream(messages: readonly ModelMessage[], parameters: ModelParameters, signal?: AbortSignal): AsyncGenerator<ModelResponse> {
    const model = await this.getModel();
    yield* model.stream(messages, parameters, { signal });
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    await this.manifest();
    const tool = this.tools.get(name);
    if (!tool) throw new Error("Unknown AgentCore tool");
    return tool.invoke(arguments_);
  }

  async credential(name: string): Promise<string> {
    const bound = await this.core.credentials.get(name);
    return bound.value;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.mcpRecoveryTimers.values()) clearTimeout(timer);
    this.mcpRecoveryTimers.clear();
    await this.cacheWrite.catch(() => undefined);
    await this.core.close();
  }

  private initialize(): Promise<Manifest> {
    return measureStartup(this.recordStartupTiming, { phase: "manifest" }, async () => {
      const modelPromise = measureStartup(this.recordStartupTiming, {
        phase: "model", resourceKind: "model", resource: this.config.modelConnection,
      }, () => this.core.model(this.config.modelConnection, {
        model: this.config.modelName,
        timeoutMs: this.config.timeoutMs,
      })).catch(error => {
        reportResourceFailure("model", this.config.modelConnection, error);
        throw new RuntimeInitializationError(error);
      });
      const discoveryStates = this.startMcpDiscoveries();
      const catalogPromise = this.loadMcpCatalog();
      const [model, managedSkills, catalog] = await Promise.all([
        modelPromise, this.loadSkills(), catalogPromise,
      ]);
      await this.waitForInitialMcpDiscoveries(discoveryStates);
      this.model = model;
      this.tools.clear();
      this.mcpToolNames.clear();
      this.mcpCatalog = catalog;

      const descriptors: ToolDescriptor[] = [];
      for (const [resource, cached] of Object.entries(catalog)) {
        this.replaceMcpDescriptors(resource, cached.tools, descriptors);
      }
      const warnings: ResourceWarning[] = [];
      for (const state of discoveryStates) {
        if (state.result) {
          this.applyInitialMcpResult(state.resource, state.result, descriptors, warnings);
          continue;
        }
        warnings.push(this.pendingMcpWarning(state.resource));
      }
      this.pendingMcpDiscoveries = discoveryStates.filter(state => !state.result);
      for (const tool of this.readOnlySkillTools(managedSkills.skills)) this.registerTool("skill", "managed", tool, descriptors);

      return {
        model: { connection: this.config.modelConnection, name: this.config.modelName },
        tools: descriptors,
        skills: managedSkills.skills.map(skill => ({
          name: skill.name,
          version: skill.version,
          description: skill.description,
          root: skill.root,
          instruction: skill.instruction,
        })),
        resourceWarnings: [...warnings, ...managedSkills.warnings],
      };
    });
  }

  private startMcpDiscoveries(): McpDiscoveryState[] {
    return this.config.mcpServers.map(resource => {
      const state: McpDiscoveryState = { resource, promise: Promise.resolve({ tools: [], warnings: [] }) };
      state.promise = this.discoverMcp(resource).then(result => {
        state.result = result;
        return result;
      });
      return state;
    });
  }

  private async waitForInitialMcpDiscoveries(states: McpDiscoveryState[]): Promise<void> {
    if (states.length === 0 || states.every(state => state.result) || this.config.mcpInitialWaitMs === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const softDeadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.config.mcpInitialWaitMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(states.map(state => state.promise)).then(() => undefined), softDeadline]);
    if (timer) clearTimeout(timer);
  }

  private async discoverMcp(resource: string, recordTiming = true): Promise<McpLoadResult> {
    const timeoutMs = Object.hasOwn(this.config.mcpDiscoveryTimeouts, resource)
      ? this.config.mcpDiscoveryTimeouts[resource]
      : this.config.mcpDiscoveryTimeoutMs;
    let client: MCPClient | undefined;
    let stage: McpDiscoveryStage = "resolve";
    try {
      const discovery = () => withMcpDiscoveryTimeout(async (signal, setStage) => {
        setStage("resolve");
        stage = "resolve";
        client = await this.core.mcp(resource, { sessionMs: timeoutMs, metadataMs: timeoutMs });
        this.mcpClients.set(resource, client);
        if (signal.aborted) {
          signal.throwIfAborted();
        }
        setStage("list_tools");
        stage = "list_tools";
        try {
          return await client.listTools({ signal });
        } catch (error) {
          if (isMcpConnectFailure(error)) {
            setStage("connect");
            stage = "connect";
          }
          throw error;
        }
      }, timeoutMs);
      let tools: Tool[];
      if (recordTiming) {
        tools = await measureStartup(this.recordStartupTiming, {
          phase: "mcp", resourceKind: "mcp", resource,
        }, discovery, error => error instanceof McpDiscoveryTimeoutError ? "timeout" : "error");
      } else {
        tools = await discovery();
      }
      return {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { ...tool.parameters },
        })),
        warnings: [],
      };
    } catch (error) {
      const failureStage = error instanceof McpDiscoveryTimeoutError ? error.stage : stage;
      logSafeError("agentcore_resource_failed", "mcp", error, { resource, operation: failureStage });
      const code = error instanceof McpDiscoveryTimeoutError ? "RESOURCE_TIMEOUT" : "RESOURCE_UNAVAILABLE";
      return {
        tools: [],
        warnings: [{
          kind: "mcp",
          resource,
          code,
          diagnostics: { stage: failureStage, ...errorDiagnostics(error) },
        }],
      };
    }
  }

  private scheduleMcpRecoveries(manifest: Manifest): void {
    for (const warning of manifest.resourceWarnings ?? []) {
      if (warning.kind === "mcp" && warning.code !== "RESOURCE_WARMING") {
        this.scheduleMcpRecovery(warning.resource, 0);
      }
    }
  }

  private observePendingMcpDiscoveries(): void {
    for (const state of this.pendingMcpDiscoveries.splice(0)) {
      void state.promise.then(result => this.applyLiveMcpResult(state.resource, result)).catch(error => {
        if (this.closed) return;
        logSafeError("agentcore_resource_failed", "mcp_background_discovery", error, { resource: state.resource });
        this.scheduleMcpRecovery(state.resource, 0);
      });
    }
  }

  private applyInitialMcpResult(
    resource: string,
    result: McpLoadResult,
    descriptors: ToolDescriptor[],
    warnings: ResourceWarning[],
  ): void {
    const warning = result.warnings[0];
    if (warning) {
      warnings.push(this.withStaleFallback(resource, warning));
      return;
    }
    this.replaceMcpDescriptors(resource, result.tools, descriptors);
    this.rememberMcpManifest(resource, result.tools);
  }

  private pendingMcpWarning(resource: string): ResourceWarning {
    return {
      kind: "mcp",
      resource,
      code: "RESOURCE_WARMING",
      diagnostics: { stage: "resolve", errorType: "McpDiscoveryPending" },
    };
  }

  private withStaleFallback(resource: string, warning: ResourceWarning): ResourceWarning {
    if (!this.mcpCatalog[resource]) return warning;
    return { ...warning, code: "RESOURCE_STALE" };
  }

  private async loadMcpCatalog(): Promise<McpManifestCatalog> {
    try {
      return await loadMcpManifestCatalog(this.config.workspacesDir, this.config.mcpServers);
    } catch (error) {
      logSafeError("agentcore_mcp_manifest_cache_failed", "load", error);
      return {};
    }
  }

  private rememberMcpManifest(resource: string, tools: CachedMcpTool[]): void {
    this.mcpCatalog = {
      ...this.mcpCatalog,
      [resource]: { updatedAt: new Date().toISOString(), tools },
    };
    const snapshot = this.mcpCatalog;
    this.cacheWrite = this.cacheWrite
      .then(() => saveMcpManifestCatalog(this.config.workspacesDir, snapshot))
      .catch(error => { logSafeError("agentcore_mcp_manifest_cache_failed", "save", error); });
  }

  private replaceMcpDescriptors(
    resource: string,
    definitions: readonly CachedMcpTool[],
    descriptors: ToolDescriptor[],
  ): void {
    const previous = this.mcpToolNames.get(resource) ?? new Set<string>();
    for (const name of previous) this.tools.delete(name);
    for (let index = descriptors.length - 1; index >= 0; index -= 1) {
      if (previous.has(descriptors[index].name)) descriptors.splice(index, 1);
    }
    const names = new Set<string>();
    for (const definition of definitions) {
      const proxy: InvokableTool = {
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        invoke: arguments_ => this.callManagedMcpTool(resource, definition.name, arguments_),
      };
      this.registerTool("mcp", resource, proxy, descriptors);
      names.add(exposedToolName("mcp", resource, definition.name));
    }
    this.mcpToolNames.set(resource, names);
  }

  private async callManagedMcpTool(
    resource: string,
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    let client = this.mcpClients.get(resource);
    if (!client) {
      const timeoutMs = Object.hasOwn(this.config.mcpDiscoveryTimeouts, resource)
        ? this.config.mcpDiscoveryTimeouts[resource]
        : this.config.mcpDiscoveryTimeoutMs;
      client = await this.core.mcp(resource, {
        sessionMs: timeoutMs,
        metadataMs: timeoutMs,
        toolMs: this.config.timeoutMs,
      });
      this.mcpClients.set(resource, client);
    }
    return client.callTool(name, arguments_);
  }

  private scheduleMcpRecovery(resource: string, attempt: number): void {
    if (this.closed || this.mcpRecoveryTimers.has(resource)) return;
    const timer = setTimeout(() => {
      this.mcpRecoveryTimers.delete(resource);
      void this.recoverMcp(resource, attempt).catch(error => {
        if (this.closed) return;
        logSafeError("agentcore_resource_failed", "mcp_recovery", error, { resource });
        this.scheduleMcpRecovery(resource, attempt + 1);
      });
    }, mcpRecoveryDelay(attempt));
    timer.unref?.();
    this.mcpRecoveryTimers.set(resource, timer);
  }

  private async recoverMcp(resource: string, attempt: number): Promise<void> {
    const result = await this.discoverMcp(resource, false);
    if (this.closed) return;
    const warning = result.warnings[0];
    if (warning) {
      this.replaceMcpWarning(resource, this.withStaleFallback(resource, warning));
      this.scheduleMcpRecovery(resource, attempt + 1);
      return;
    }
    this.applyLiveMcpResult(resource, result);
  }

  private applyLiveMcpResult(resource: string, result: McpLoadResult): void {
    if (this.closed) return;
    const warning = result.warnings[0];
    if (warning) {
      this.replaceMcpWarning(resource, this.withStaleFallback(resource, warning));
      this.scheduleMcpRecovery(resource, 0);
      return;
    }
    const current = this.currentManifest;
    if (!current) return;
    const tools = [...current.tools];
    this.replaceMcpDescriptors(resource, result.tools, tools);
    const resourceWarnings = (current.resourceWarnings ?? []).filter(entry => (
      entry.kind !== "mcp" || entry.resource !== resource
    ));
    this.rememberMcpManifest(resource, result.tools);
    this.currentManifest = { ...current, tools, resourceWarnings };
  }

  private replaceMcpWarning(resource: string, warning: ResourceWarning): void {
    const current = this.currentManifest;
    if (!current) return;
    const existing = (current.resourceWarnings ?? []).filter(entry => (
      entry.kind !== "mcp" || entry.resource !== resource
    ));
    const resourceWarnings = [...existing, warning];
    this.currentManifest = { ...current, resourceWarnings };
  }

  private async loadSkills(): Promise<{ skills: Skill[]; warnings: ResourceWarning[] }> {
    const results = await Promise.all(this.config.skills.map(async reference => {
      const resource = reference.version ? `${reference.name}@${reference.version}` : reference.name;
      try {
        const skill = await measureStartup(this.recordStartupTiming, {
          phase: "skill", resourceKind: "skill", resource,
        }, () => this.core.skills.managed(reference.name, skillOptions(reference.version)));
        return { skill, warning: undefined };
      } catch (error) {
        reportResourceFailure("skill", resource, error);
        return {
          skill: undefined,
          warning: {
            kind: "skill", resource, code: "RESOURCE_UNAVAILABLE", diagnostics: errorDiagnostics(error),
          } satisfies ResourceWarning,
        };
      }
    }));
    return {
      skills: results.flatMap(result => result.skill ? [result.skill] : []),
      warnings: results.flatMap(result => result.warning ? [result.warning] : []),
    };
  }

  private readOnlySkillTools(skills: readonly Skill[]): Tool[] {
    if (skills.length === 0) return [];
    return skillTools(skills).filter(tool => tool.name === "load_skills" || tool.name === "read_skill_file");
  }

  private registerTool(group: string, resource: string, tool: InvokableTool, descriptors: ToolDescriptor[]): void {
    const name = exposedToolName(group, resource, tool.name);
    if (this.tools.has(name)) throw new Error("Duplicate AgentCore tool identity");
    this.tools.set(name, tool);
    descriptors.push({ name, description: tool.description, inputSchema: { ...tool.parameters } });
  }

  private async getModel(): Promise<ModelClient> {
    await this.manifest();
    if (!this.model) throw new Error("AgentCore model is not initialized");
    return this.model;
  }
}

export class FixtureRuntime implements Runtime {
  private readonly toolName = exposedToolName("mcp", "fixture", "echo");

  async manifest(): Promise<Manifest> {
    return {
      model: { connection: "fixture-model", name: "fixture-model" },
      tools: [{ name: this.toolName, description: "Echo fixture input", inputSchema: { type: "object" } }],
      skills: [],
    };
  }

  async completion(messages: readonly ModelMessage[]): Promise<ModelResponse> {
    return this.response(messages, false);
  }

  async *stream(messages: readonly ModelMessage[]): AsyncGenerator<ModelResponse> {
    const response = this.response(messages, true);
    yield {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "Fixture AgentCore response." }, finish_reason: null }],
    };
    yield {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    if (name !== this.toolName) throw new Error("Unknown fixture tool");
    return { content: [{ type: "text", text: JSON.stringify(arguments_) }], isError: false };
  }

  async credential(): Promise<string> { return "fixture-api-key"; }

  async close(): Promise<void> {}

  private response(messages: readonly ModelMessage[], stream: boolean): ModelResponse {
    const content = messages.length ? "Fixture AgentCore response." : "Fixture model ready.";
    return {
      id: `fixture-${randomUUID()}`,
      object: stream ? "chat.completion.chunk" : "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fixture-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    };
  }
}

export function createRuntime(config: Config, recordStartupTiming?: StartupTimingRecorder): Runtime {
  if (config.mock) return new FixtureRuntime();
  return new AgentCoreRuntime(config, undefined, recordStartupTiming);
}
