import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { LoopRunner } from "../vendor/runloop/src/loop/runner.js";
import { RunRequestSchema } from "../vendor/runloop/src/types/api.js";
import { registerTrustedOutboundUrl } from "../vendor/runloop/src/sidecar/ssrf.js";
import type { RunRequest } from "../vendor/runloop/src/types/api.js";
import type { RunloopEvent } from "../vendor/runloop/src/types/events.js";
import type { Config } from "./config.js";
import { createInternalApi } from "./internal-api.js";
import { createRuntime, RuntimeInitializationError, type Manifest, type Runtime } from "./runtime.js";
import { installSkills } from "./workspace.js";
import { AgUiInputSchema, AgUiStream, agUiRequest, SessionIdSchema, type AgUiInput } from "./ag-ui.js";
import { DEFAULT_UID, SessionWorkspaceError, sessionWorkdir, UidSchema } from "./session-workspace.js";
import {
  ARTIFACT_CONVERSATION_HEADER,
  ARTIFACT_UID_HEADER,
  publishArtifactBytes,
  withArtifactTool,
} from "./artifacts.js";
import { createStsBroker, STS_BROKER_PATH, type StsBroker } from "./sts-broker.js";
import type { AgentLoopTelemetry } from "./agentloop.js";
import { materializeAttachmentEvents, materializeAttachmentEventsToSandbox } from "./attachment-materializer.js";
import { errorDiagnostics, errorDiagnosticsSummary, logSafeError } from "./error-diagnostics.js";
import { logStartupTiming, measureStartup, type StartupTimingRecorder } from "./startup-timing.js";
import { AgentSandboxProvider } from "./sandbox/agent-sandbox-provider.js";
import { SandboxAcquireError, SandboxManager } from "./sandbox/manager.js";
import { createManagedAgentSandboxVolumeResolver } from "./sandbox/volume-resolver.js";
import { LazySandboxExecution } from "./sandbox/lazy-execution.js";
import { posix } from "node:path";

const IdSchema = SessionIdSchema;
export const RequestSchema = RunRequestSchema.omit({
  model: true,
  resources: true,
  credentials: true,
  headers: true,
  features: true,
  agent: true,
}).extend({
  uid: UidSchema.default(DEFAULT_UID),
  conversationId: IdSchema.optional(),
  runId: IdSchema.optional(),
  agent: z.object({
    cli: z.string().optional(),
    systemPrompt: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

export interface Runner {
  run(request: RunRequest): AsyncGenerator<RunloopEvent>;
  interrupt(conversationId: string, reason?: string): boolean;
  initialize(agentCli?: string): Promise<{ elapsedMs: number }>;
  resolveCliCommand(name: string): string;
  setExecutionBackend?(conversationId: string, backend: import("../vendor/runloop/src/sidecar/exec-backend.js").ExecBackend | undefined): void;
}

interface AppOptions {
  runner?: Runner;
  runtime?: Runtime;
  internalToken?: string;
  stsBroker?: StsBroker;
  agentLoop?: AgentLoopTelemetry;
  sandboxManager?: SandboxManager;
}

function tokenMatches(actual: string | undefined, token: string): boolean {
  const supplied = Buffer.from(actual ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function loopbackBaseUrl(config: Config): string {
  return `http://127.0.0.1:${config.port}`;
}

function skillInstruction(config: Config, skill: Manifest["skills"][number]): string {
  if (config.execution === "tools-only") {
    return `- ${skill.name}: ${skill.description}; use the AgentCore load_skills and read_skill_file tools`;
  }
  const skillFile = join(skill.root, "SKILL.md");
  return [
    `- ${skill.name}: ${skill.description}; read ${JSON.stringify(skillFile)}.`,
    `  Resolve every relative file or script path against ${JSON.stringify(skill.root)}, regardless of the current working directory.`,
  ].join("\n");
}

function buildSystemPrompt(
  config: Config,
  workspace: string,
  cwd: string | undefined,
  sandboxed: boolean,
  skills: Manifest["skills"],
  requestPrompt: string | undefined,
  resourceWarnings: Manifest["resourceWarnings"] = [],
): string {
  const sections: Array<string | undefined> = [
    "You are an AgentCore agent. AgentCore provides your model, MCP tools and managed skills.",
    config.systemPrompt,
    requestPrompt,
  ];
  if (cwd) {
    if (sandboxed) {
      sections.push(
        `File and shell tools run only in the isolated sandbox working directory: ${JSON.stringify(cwd)}. ` +
        "Managed skills are materialized inside that sandbox; use the absolute managed skill paths below.",
      );
    } else {
      sections.push(
        `File and shell tools use the local deployment user/session working directory: ${JSON.stringify(cwd)}. ` +
        `Session configuration and managed skills are stored separately in ${JSON.stringify(workspace)}; ` +
        "use the absolute managed skill paths below.",
      );
    }
  }
  if (cwd && config.artifactRoot) {
    sections.push(
      "Keep working files and intermediate outputs in the current session working directory. " +
      "For every final user-visible file, validate it and then call publish_artifact. " +
      "Do not write to the OSS mount directly. Present only the artifact.path returned by publish_artifact as the final file path.",
    );
  }
  if (skills.length > 0) {
    const guide = skills.map(skill => skillInstruction(config, skill)).join("\n");
    sections.push(`Available managed skills:\n${guide}`);
  }
  if (resourceWarnings.length > 0) {
    const unavailable = resourceWarnings.filter(warning => (
      warning.code === "RESOURCE_UNAVAILABLE" || warning.code === "RESOURCE_TIMEOUT"
    ));
    if (unavailable.length > 0) {
      const list = unavailable.map(warning => `- ${warning.kind}: ${warning.resource}`).join("\n");
      sections.push(
        "The following developer-configured resources are unavailable for this run. " +
        "Do not claim to have or use them; mention this only when relevant:\n" + list,
      );
    }
    const refreshing = resourceWarnings.filter(warning => (
      warning.code === "RESOURCE_WARMING" || warning.code === "RESOURCE_STALE"
    ));
    if (refreshing.length > 0) {
      const list = refreshing.map(warning => `- ${warning.kind}: ${warning.resource}`).join("\n");
      sections.push(
        "The following developer-configured resources are still refreshing. Cached tools shown in this run may be used, " +
        "but a call can fail until its backing service is healthy; mention this only when relevant:\n" + list,
      );
    }
  }
  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}

function workspaceErrorDetail(error: unknown): string {
  if (!(error instanceof SessionWorkspaceError)) return "";
  return ` (${error.step}:${error.fsCode})`;
}

function resolveRunCwd(config: Config, uid: string, conversationId: string): Promise<string | undefined> {
  if (!config.workdir) return Promise.resolve(undefined);
  return sessionWorkdir(config.workdir, uid, conversationId);
}

class ResourcePreparationError extends Error {
  constructor(readonly code: string, cause: unknown) {
    super("AgentCore resource preparation failed");
    this.name = "ResourcePreparationError";
    this.cause = cause;
  }
}

async function prepareResource<T>(code: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof RuntimeInitializationError) throw error;
    throw new ResourcePreparationError(code, error);
  }
}

function safeErrorType(error: unknown): string {
  const candidate = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate) ? candidate : "UnknownError";
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

export function createApp(config: Config, options: AppOptions = {}) {
  process.env.AGENTCORE_REMOTE_SHELL = config.execution === "tools-only" ? "1" : "0";

  const baseUrl = loopbackBaseUrl(config);
  const internalToken = options.internalToken ?? randomBytes(32).toString("hex");
  const recordStartupTiming: StartupTimingRecorder = timing => {
    let observed = false;
    try { observed = options.agentLoop?.recordStartupTiming?.(timing) === true; } catch {}
    if (!observed) logStartupTiming(timing);
  };
  const runtime = options.runtime ?? createRuntime(config, recordStartupTiming);
  const runner = options.runner ?? new LoopRunner({
    workspacesDir: config.workspacesDir,
    imageCredentialProvider: name => runtime.credential(name),
  });
  const stsBroker = options.stsBroker ?? createStsBroker(config.stsBroker);
  const sandboxManager = config.sandbox
    ? options.sandboxManager ?? new SandboxManager(
      new AgentSandboxProvider(
        config.sandbox,
        name => runtime.credential(name),
        config.sandbox.volumeName ? createManagedAgentSandboxVolumeResolver() : undefined,
      ),
      { timeoutMs: config.sandbox.timeoutMs },
    )
    : undefined;
  const active = new Set<string>();
  const sandboxSessionKey = (uid: string, conversationId: string) => JSON.stringify([uid, conversationId]);
  const sandboxExecutions = new Map<string, LazySandboxExecution>();
  const app = new Hono();
  let runnerInitialization: Promise<{ elapsedMs: number }> | undefined;

  const initialize = async () => {
    if (!runnerInitialization) {
      const current = measureStartup(recordStartupTiming, {
        phase: "runner_initialize", resourceKind: "runner", resource: config.agentCli,
      }, () => runner.initialize(config.agentCli));
      runnerInitialization = current;
      void current.catch(() => {
        if (runnerInitialization === current) runnerInitialization = undefined;
      });
    }
    const [initialized, manifest] = await Promise.all([runnerInitialization, runtime.manifest()]);
    const resourceWarnings = manifest.resourceWarnings ?? [];
    return {
      ...initialized,
      resourceStatus: resourceWarnings.length > 0 ? "degraded" as const : "ready" as const,
      resourceWarnings,
    };
  };

  registerTrustedOutboundUrl(`${baseUrl}/mcp`);
  app.route("/", createInternalApi(config, runtime, internalToken, {
    artifactPublisher: config.execution === "sandbox" && config.artifactRoot && sandboxManager
      ? async (uid, conversationId, arguments_) => {
          if (typeof arguments_.source_path !== "string" || !arguments_.source_path.trim()) {
            throw new Error("source_path is required");
          }
          const execution = sandboxExecutions.get(sandboxSessionKey(uid, conversationId));
          const workspace = execution
            ? await execution.workspace()
            : sandboxManager.workspace(uid, conversationId);
          if (!workspace) throw new Error("source_path workspace is unavailable");
          const source = arguments_.source_path.trim();
          const info = await workspace.getInfo(source);
          if (info.type !== "file" || info.symlinkTarget) throw new Error("source_path must be a regular file");
          if (info.size > 32 * 1024 * 1024) throw new Error("source_path exceeds the publish limit");
          const bytes = await workspace.readFile(source);
          if (bytes.byteLength !== info.size) throw new Error("source_path changed while publishing");
          return publishArtifactBytes(config.artifactRoot!, uid, conversationId, posix.basename(source), bytes, arguments_);
        }
      : undefined,
  }));

  app.get("/", context => context.json({
    name: "agentcore-runloop",
    protocols: ["ag-ui", "runloop"],
    endpoint: "/ag-ui/agent",
  }));
  app.get("/health", context => context.json({ status: "ok", activeRuns: active.size }));
  app.get("/healthz", context => context.json({ status: "ok" }));
  app.get("/readyz", context => {
    try {
      runner.resolveCliCommand(config.agentCli);
      return context.json({ status: "ready" });
    } catch {
      return context.json({ status: "not_ready" }, 503);
    }
  });

  app.use("/v1/*", async (context, next) => {
    if (context.req.path === STS_BROKER_PATH) {
      await next();
      return;
    }
    if (config.apiToken && !tokenMatches(context.req.header("Authorization"), config.apiToken)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.post(STS_BROKER_PATH, context => stsBroker(context.req.raw));

  app.post("/v1/interrupt", async context => {
    const body = await context.req.json().catch(() => null);
    const input = z.object({ conversationId: IdSchema, reason: z.string().optional() }).safeParse(body);
    if (!input.success) return context.json({ error: "Invalid request" }, 400);
    const success = runner.interrupt(input.data.conversationId, input.data.reason);
    return context.json({ success });
  });

  app.get("/v1/runs", context => {
    const runs = [...active].map(conversationId => ({ conversationId, status: "running" }));
    return context.json({ runs });
  });

  app.post("/initialize", async context => {
    if (config.apiToken && !tokenMatches(context.req.header("Authorization"), config.apiToken)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    try {
      return context.json({ status: "ok", ...await initialize() });
    } catch (error) {
      logSafeError("resource_initialization_failed", "initialize", error);
      return context.json({ status: "not_ready", diagnostics: errorDiagnostics(error) }, 503);
    }
  });

  app.post("/v1/run", async context => {
    const body = await context.req.json().catch(() => null);
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    return execute(context, parsed.data);
  });

  function agUiError(context: Context, code: string, message: string, diagnostics?: Record<string, unknown>) {
    context.header("X-Accel-Buffering", "no");
    const response = streamSSE(context, stream => stream.writeSSE({
      data: JSON.stringify({ type: "RUN_ERROR", code, message, ...(diagnostics ? { diagnostics } : {}) }),
    }));
    response.headers.set("Cache-Control", "no-cache, no-transform");
    return response;
  }

  function failure(
    context: Context,
    agui: AgUiInput | undefined,
    code: string,
    message: string,
    status: 400 | 409 | 503,
    diagnostics?: Record<string, unknown>,
  ) {
    if (agui) return agUiError(context, code, message, diagnostics);
    return context.json({ code, error: message, ...(diagnostics ? { diagnostics } : {}) }, status);
  }

  const aguiHandler = async (context: Context) => {
    if (config.apiToken && !tokenMatches(context.req.header("Authorization"), config.apiToken)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const body = await context.req.json().catch(() => null);
    const parsed = AgUiInputSchema.safeParse(body);
    if (!parsed.success) {
      return agUiError(context, "INVALID_REQUEST", "Invalid AG-UI input; supply text messages, safe threadId/runId, state, tools, context and forwardedProps");
    }
    try {
      return execute(context, agUiRequest(parsed.data), parsed.data);
    } catch {
      return agUiError(context, "INVALID_REQUEST", "Invalid JSON object in historical tool arguments");
    }
  };

  for (const route of ["/ag-ui/agent", "/invocations", "/"]) app.post(route, aguiHandler);

  async function execute(context: Context, input: z.infer<typeof RequestSchema>, agui?: AgUiInput) {
    const conversationId = input.conversationId ?? randomUUID();
    const runId = input.runId ?? randomUUID();
    if (active.has(conversationId)) {
      return failure(context, agui, "THREAD_BUSY", "Conversation already running", 409);
    }

    const cli = input.agent?.cli ?? config.agentCli;
    if (cli !== "codex") {
      return failure(context, agui, "INVALID_ENGINE", "Only codex is supported", 400);
    }
    try {
      runner.resolveCliCommand(cli);
    } catch {
      return failure(context, agui, "INVALID_ENGINE", "Unknown agent CLI", 400);
    }

    const executionUid = input.uid;

    active.add(conversationId);
    let request: RunRequest;
    let sandboxExecution: LazySandboxExecution | undefined;
    const sessionKey = sandboxSessionKey(executionUid, conversationId);
    try {
      const manifest = await prepareResource("RESOURCE_MANIFEST_FAILED", () => runtime.manifest());
      if (sandboxManager && config.sandbox) {
        sandboxExecution = new LazySandboxExecution(
          sandboxManager,
          executionUid,
          conversationId,
          config.sandbox.root,
          manifest.skills,
          { runId, resource: config.sandbox.template },
        );
        sandboxExecutions.set(sessionKey, sandboxExecution);
      }
      const managedTools = withArtifactTool(manifest.tools, Boolean(config.artifactRoot));
      const workspace = join(config.workspacesDir, conversationId);
      await prepareResource("RUNTIME_WORKSPACE_FAILED", () => mkdir(workspace, { recursive: true }).then(() => undefined));

      let cwd: string | undefined;
      if (sandboxExecution) {
        cwd = sandboxExecution.root;
      } else {
        try {
          cwd = await resolveRunCwd(config, executionUid, conversationId);
        } catch (error) {
          active.delete(conversationId);
          runner.setExecutionBackend?.(conversationId, undefined);
          const detail = workspaceErrorDetail(error);
          const message = `Configured workspace is not ready; check AGENTCORE_WORKDIR mount and permissions${detail}`;
          return failure(context, agui, "WORKSPACE_NOT_READY", message, 503);
        }
      }

      if (input.events.some(event => event.type === "user.attachment")) {
        const attachmentOptions = {
          downloads: agui?.forwardedProps.attachmentDownloads ?? [],
          timeoutMs: config.attachmentDownloadTimeoutMs,
        };
        try {
          if (sandboxExecution) {
            const sandboxWorkspace = await sandboxExecution.workspace();
            await materializeAttachmentEventsToSandbox(input.events, sandboxWorkspace, attachmentOptions);
          } else {
            await materializeAttachmentEvents(input.events, { root: cwd ?? workspace, ...attachmentOptions });
          }
        } catch {
          active.delete(conversationId);
          runner.setExecutionBackend?.(conversationId, undefined);
          await sandboxExecution?.release().catch(() => {});
          sandboxExecutions.delete(sessionKey);
          return failure(context, agui, "ATTACHMENT_NOT_READY", "Attachment could not be prepared; request a fresh download ticket", 503);
        }
      }

      let skills = manifest.skills;
      if (config.execution === "local") {
        skills = await prepareResource("SKILL_INSTALLATION_FAILED", () => installSkills(workspace, manifest.skills));
      } else if (sandboxExecution) {
        skills = sandboxExecution.skills;
      }
      const { uid: _uid, ...runtimeInput } = input;
      const timeoutMs = Math.min(input.agent?.timeoutMs ?? config.timeoutMs, config.timeoutMs);
      const systemPrompt = buildSystemPrompt(
        config, workspace, cwd, Boolean(sandboxExecution), skills, input.agent?.systemPrompt, manifest.resourceWarnings,
      );
      const agent: NonNullable<RunRequest["agent"]> = { ...input.agent, cli, timeoutMs, systemPrompt };
      if (cwd) agent.cwd = cwd;

      const resources: RunRequest["resources"] = [];
      if (managedTools.length > 0) {
        resources.push({
          resourceId: "agentcore-managed",
          resourceName: "agentcore",
          resourceType: "MCP",
          protocol: "mcp",
          mcpConfig: {
            transport: "http",
            url: `${baseUrl}/mcp`,
            headers: {
              Authorization: `Bearer ${internalToken}`,
              [ARTIFACT_UID_HEADER]: executionUid,
              [ARTIFACT_CONVERSATION_HEADER]: conversationId,
            },
          },
          toolManifest: managedTools,
        });
      }

      request = {
        ...runtimeInput,
        conversationId,
        runId,
        agent,
        model: {
          provider: "openai-compatible",
          model: manifest.model.name,
          baseUrl: `${baseUrl}/model/v1`,
          apiKey: internalToken,
        },
        features: { toolBridge: "mcp", execViaMcp: config.execution !== "local" },
        resources,
      };
      if (config.execution === "local") {
        request.localSandbox = {
          userRoot: dirname(await realpath(cwd!)),
          readRoots: skills.map(skill => skill.root),
        };
      }
      runner.setExecutionBackend?.(conversationId, sandboxExecution);
    } catch (error) {
      active.delete(conversationId);
      runner.setExecutionBackend?.(conversationId, undefined);
      await sandboxExecution?.release().catch(() => {});
      sandboxExecutions.delete(sessionKey);
      if (error instanceof SandboxAcquireError) {
        const { code: _code, ...safeDiagnostics } = errorDiagnostics(error);
        const diagnostics = { stage: error.stage, reason: error.reason, ...safeDiagnostics };
        if (error.code === "SANDBOX_NOT_READY") {
          logSafeError("sandbox_acquire_failed", error.stage, error, {
            reason: error.reason,
            resource: config.sandbox?.template ?? "sandbox",
            runId,
            conversationId,
          });
        }
        return failure(
          context,
          agui,
          error.code,
          error.code === "USER_SANDBOX_BUSY" ? "The conversation sandbox is already running another task" : "The configured sandbox is not ready",
          error.code === "USER_SANDBOX_BUSY" ? 409 : 503,
          error.code === "SANDBOX_NOT_READY" ? diagnostics : undefined,
        );
      }
      logSafeError("resource_preparation_failed", "request_preparation", error, { runId, conversationId });
      const diagnostics = errorDiagnosticsSummary(error);
      if (error instanceof RuntimeInitializationError) {
        return failure(context, agui, error.code, `${error.message} (${diagnostics})`, 503);
      }
      return failure(
        context,
        agui,
        "RESOURCES_NOT_READY",
        `AgentCore resources are not ready; check SDK configuration and permissions (${diagnostics})`,
        503,
      );
    }

    context.header("X-Conversation-Id", conversationId);
    context.header("X-Run-Id", runId);
    context.header("X-Accel-Buffering", "no");
    const codec = agui ? new AgUiStream(agui) : undefined;
    const response = streamSSE(context, async stream => {
      const latestUserInput = [...request.events].reverse().find(event => event.type === "user.message");
      let observation: ReturnType<AgentLoopTelemetry["startRun"]> | undefined;
      try {
        observation = options.agentLoop?.startRun({
          conversationId,
          runId,
          userId: executionUid,
          model: request.model?.model,
          input: latestUserInput?.type === "user.message" && typeof latestUserInput.content === "string"
            ? latestUserInput.content
            : undefined,
        });
      } catch {
        // Observability is intentionally fail-open and never owns request availability.
      }
      stream.onAbort(() => { runner.interrupt(conversationId, "client_disconnected"); });
      const heartbeat = setInterval(() => {
        void stream.write(":heartbeat\n\n").catch(() => {});
      }, 5000);
      try {
        if (codec) {
          for (const event of codec.start()) await stream.writeSSE({ data: JSON.stringify(event) });
        }
        for await (const event of runner.run(request)) {
          if (event.type === "run.error") {
            console.error(JSON.stringify({
              event: "agent_run_failed", stage: "runner", code: event.error.code, runId, conversationId,
            }));
          }
          try { observation?.observe(event); } catch {}
          if (stream.aborted) {
            runner.interrupt(conversationId, "client_disconnected");
            break;
          }
          if (codec) {
            for (const item of codec.push(event)) await stream.writeSSE({ data: JSON.stringify(item) });
          } else {
            await stream.writeSSE({ event: event.type, id: event.id, data: JSON.stringify(event) });
          }
        }
        if (codec && !stream.aborted) {
          for (const event of codec.finish()) await stream.writeSSE({ data: JSON.stringify(event) });
        }
      } catch (error) {
        if (!codec) throw error;
        console.error(JSON.stringify({
          event: "agent_run_stream_failed", stage: "stream", code: "INTERNAL_ERROR", runId, conversationId,
          errorType: safeErrorType(error),
          ...(safeErrorCode(error) ? { causeCode: safeErrorCode(error) } : {}),
        }));
        if (!stream.aborted) {
          for (const event of codec.fail("INTERNAL_ERROR", "Agent execution failed; check server logs")) {
            await stream.writeSSE({ data: JSON.stringify(event) });
          }
        }
      } finally {
        try { observation?.finish("stream_closed"); } catch {}
        clearInterval(heartbeat);
        runner.interrupt(conversationId, "stream_closed");
        runner.setExecutionBackend?.(conversationId, undefined);
        await sandboxExecution?.release().catch(() => {});
        sandboxExecutions.delete(sessionKey);
        active.delete(conversationId);
      }
    });
    response.headers.set("Cache-Control", "no-cache, no-transform");
    return response;
  }

  return { app, runner, runtime, active, stsBroker, sandboxManager, initialize };
}
