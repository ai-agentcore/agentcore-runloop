import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import type { RunRequest } from "../types/api.js";
import type { RunloopEvent } from "../types/events.js";
import { EventType, ErrorCode } from "../types/events.js";
import { compressEvents } from "../events/compress.js";
import { normalizeInputEvents } from "../events/normalize.js";
import { createEvent } from "../events/factory.js";
import { convertResources } from "../resources/converter.js";
import { resolvePendingHitl, derivePolicies } from "../hitl/resume.js";
import { OpenAIHitlPhrasing } from "../hitl/phrasing.js";
import { OpenAIHitlSurfaceMapper } from "../hitl/surface-map.js";
import { CliAgentAdapter, type AgentAdapter } from "../acp/adapter.js";
import { StreamJsonAdapter } from "../acp/stream-json-adapter.js";
import { AcpAdapter, AcpServerAdapter } from "../acp/acp-adapter.js";
import { CodexAdapter } from "../acp/codex-adapter.js";
import { AgentCliRegistry, validateAgentCli, type AgentCliEntry } from "../acp/registry.js";
import type { LlmJudge } from "../hitl/judge.js";
import { RunManager } from "./run.js";
import { applyModelEnvDefaults } from "./model-defaults.js";
import { ModelProviderProxy } from "../provider/proxy.js";
import { SidecarServer } from "../sidecar/server.js";
import { EXEC_TOOLS_PROMPT, remoteExecPrompt } from "../sidecar/file-tools.js";
import { setupWorkspaceTools } from "../sidecar/workspace.js";
import { AgentrunMcpServer } from "../mcp/server.js";
import { collectDelegationToolNames, sanitizeToolName, buildOutboundNameMap } from "../mcp/tool-registry.js";
import { Logger, loggerOptionsFromEnv, type LoggerOptions } from "../util/logger.js";
import { buildSystemPrompt, resolveResourceMode } from "./prompt-builder.js";
import { buildExtraTools } from "./extra-tools.js";
import { MergeNormalizer } from "../events/merge-normalizer.js";
import { imageCredentialName, type ImageCredentialProvider } from "../sidecar/image-tools.js";
import type { ExecBackend } from "../sidecar/exec-backend.js";

export type AdapterType = "cli" | "stream-json" | "acp" | "acp-server" | "codex";

export interface RunnerOptions {
  defaultAdapterType?: AdapterType;
  llmJudge?: LlmJudge;
  agentRegistry?: Record<string, AgentCliEntry>;
  allowUnregisteredAgents?: boolean;
  logDir?: string;
  workspacesDir?: string;
  imageCredentialProvider?: ImageCredentialProvider;
}

export class LoopRunner {
  private runManager = new RunManager();
  private defaultAdapterType: AdapterType;
  private llmJudge: LlmJudge | null;
  private registry: AgentCliRegistry;
  private allowUnregisteredAgents: boolean;
  private logDir: string | undefined;
  private workspacesDir: string | undefined;
  private loggerConfig: LoggerOptions;
  private imageCredentialProvider: ImageCredentialProvider | undefined;
  private executionBackends = new Map<string, ExecBackend>();

  constructor(options: RunnerOptions = {}) {
    this.defaultAdapterType = options.defaultAdapterType ?? "acp-server";
    this.llmJudge = options.llmJudge ?? null;
    this.registry = new AgentCliRegistry(options.agentRegistry);
    this.allowUnregisteredAgents = options.allowUnregisteredAgents ?? false;
    this.logDir = options.logDir ?? process.env.AGENTCORE_LOG_DIR;
    const ws = options.workspacesDir ?? process.env.AGENTCORE_WORKSPACES_DIR;
    this.workspacesDir = ws ? resolve(ws) : undefined;
    this.loggerConfig = this.loggerOptions();
    this.imageCredentialProvider = options.imageCredentialProvider;
  }

  private loggerOptions(): LoggerOptions {
    return loggerOptionsFromEnv({
      logDir: this.logDir,
    });
  }

  getRegistry(): AgentCliRegistry {
    return this.registry;
  }

  getRunManager(): RunManager {
    return this.runManager;
  }

  prepareRun(conversationId?: string): string {
    const session = this.runManager.create(conversationId);
    return session.conversationId;
  }

  setExecutionBackend(conversationId: string, backend: ExecBackend | undefined): void {
    if (backend) this.executionBackends.set(conversationId, backend);
    else this.executionBackends.delete(conversationId);
  }

  async initialize(agentCli?: string): Promise<{ elapsedMs: number }> {
    const log = new Logger("runner", this.loggerConfig);
    const started = Date.now();
    const { execFileSync } = await import("node:child_process");

    const cliNames = agentCli ? [agentCli] : this.registry.listRegistered();
    const available = cliNames.filter((name) => {
      const entry = this.registry.resolve(name);
      if (!entry) return false;
      try { execFileSync("which", [entry.command], { stdio: "ignore" }); return true; }
      catch { return false; }
    });

    if (available.length === 0) {
      log.info("initialize skipped: no CLI binaries found", { cliNames });
      return { elapsedMs: Date.now() - started };
    }

    const tmpDir = await mkdtemp(join(tmpdir(), "runloop-init-"));
    try {
      const { writeFileSync } = await import("node:fs");

      await Promise.all(available.map(async (name) => {
        const entry = this.registry.resolve(name)!;
        // 数据驱动预热：CLI 在注册表声明 prewarm 规格，runner 通用执行（不再硬编码 codex flags）。
        // 未声明 prewarm 的 CLI（如 claude-code）直接跳过——新增 CLI 只动注册表，不动这里。
        const spec = entry.prewarm;
        if (!spec) return;

        const home = join(tmpDir, `home-${name}`);
        await mkdir(home, { recursive: true });
        for (const [rel, content] of Object.entries(spec.configFiles ?? {})) {
          writeFileSync(join(home, rel), content);
        }
        const env: Record<string, string> = { ...process.env as Record<string, string>, ...(spec.env ?? {}) };
        if (spec.homeEnvVar) env[spec.homeEnvVar] = home;

        await new Promise<void>((resolve) => {
          const proc = spawn(entry.command, spec.args, {
            cwd: tmpDir,
            env,
            stdio: ["ignore", "pipe", "ignore"],
          });

          let gotStdout = false;
          proc.stdout?.on("data", () => {
            if (!gotStdout) {
              gotStdout = true;
              proc.kill();
            }
          });

          proc.on("exit", () => resolve());
          proc.on("error", () => resolve());

          setTimeout(() => { if (!proc.killed) proc.kill(); }, 15_000);
        });

        log.info("cli pre-warmed", { name, command: entry.command });
      }));
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    const elapsedMs = Date.now() - started;
    log.info("initialize completed", { available, elapsedMs });
    return { elapsedMs };
  }

  async *run(request: RunRequest, preparedConversationId?: string, preparedRunId?: string, traceId?: string): AsyncGenerator<RunloopEvent> {
    const cid = preparedConversationId ?? request.conversationId;
    // 复用旧 RunState 时重置 run 级瞬态（fresh abortController + 清 hitlPending），避免继承上个 run 已
    // abort 的 signal 或残留 hitlPending（H6）。HTTP 路径经 prepareRun→create 本就 fresh，重置幂等无害。
    const session = this.runManager.beginRun(cid);
    const runId = preparedRunId ?? request.runId ?? nanoid();
    // 请求级日志用 traceId（HTTP 层从 header 解析，AD-022）；无则回落 runId。
    const runLoggerConfig: LoggerOptions = { ...this.loggerConfig, traceId: traceId ?? runId };
    const log = new Logger("runner", runLoggerConfig);
    const eventLog = new Logger("event", runLoggerConfig);

    // 所有出站事件统一带上 runId（绑定到事件创建处，使 SSE 事件名副其实、利于上游追踪）。
    const stampRunId = (e: RunloopEvent): RunloopEvent => {
      if (!e.runId) (e as { runId?: string }).runId = runId;
      return e;
    };

    const maxTurns = request.agent?.maxTurns;
    const timeoutMs = request.agent?.timeoutMs;

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        this.runManager.interrupt(session.conversationId, "timeout");
      }, timeoutMs);
    }

    let proxy: ModelProviderProxy | null = null;
    let sidecar: SidecarServer | null = null;
    let mcpServer: AgentrunMcpServer | null = null;
    // 提到 try 外，让 catch 的 run.error 路径也能在终止前 flush 未闭合 message（L10）。
    let normalizer: MergeNormalizer | null = null;
    const injectedEvents: RunloopEvent[] = [];
    let notifyInjected: (() => void) | null = null;
    // 注入事件入队 + 单发唤醒：sidecar（HITL suspend / 嵌套）与进程内 MCP server（codex 原生工具调用）共用，
    // 两路都把子事件/生命周期注入主 SSE 流。
    const injectEmit = (event: RunloopEvent): void => {
      injectedEvents.push(stampRunId(event));
      if (notifyInjected) { const cb = notifyInjected; notifyInjected = null; cb(); }
    };

    try {
      const agentCli = request.agent?.cli ?? "codex";
      const sessionStart = createEvent(EventType.RunStart, session.conversationId, {
        runId,
        agentCli,
        model: request.model?.model,
      });
      this.logEvent(eventLog, sessionStart);
      yield sessionStart;

      const normalized = normalizeInputEvents(request.events, session.conversationId);

      // turnIndex 跨 run 单调递增：从历史末个 turn.end.turnIndex 推导起始值。
      let startTurnIndex = 0;
      for (const e of normalized) {
        if (e.type === EventType.TurnEnd) {
          const ti = (e as { turnIndex?: number }).turnIndex;
          if (typeof ti === "number") startTurnIndex = Math.max(startTurnIndex, ti + 1);
        }
      }

      const resources = request.resources
        ? convertResources(request.resources, { extractNonMcp: true })
        : { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" };
      // 非 MCP 资源暴露方式：features.toolBridge 控制，默认 mcp（进程内 agentcore-mcp server，
      // codex 原生调用）；cli 为降级（.tools/agentrun shell 隧道）。runner 据此 gate MCP server / CLI 脚本。
      const resourceMode = resolveResourceMode(request);
      // 部署形态（AGENTCORE_REMOTE_SHELL）+ Sandbox 共同决定 shell/文件执行后端，与 execViaMcp 正交：
      //  - **传入 Sandbox（任一实例形态）**：执行/文件一律路由到该隔离沙箱数据面（远端后端，密钥不外泄），
      //    注入内置工具、关 codex 内建 shell。这是 Sandbox 语义本身——给了沙箱就用沙箱的 shell。
      //  - **系统实例**（env 已设）：runloop 持系统级密钥、多租共享。codex **永不**碰本地 shell
      //    （shell_tool=false 恒成立、本地 bash/file 一律不注入）；无 Sandbox = 零执行能力（纯推理 + 平台工具）。
      //  - **用户实例**（默认，env 未设）且**无 Sandbox**：危险环境，本地 shell 允许，归属由 features.execViaMcp 决定。
      const remoteShell =
        process.env.AGENTCORE_REMOTE_SHELL === "1" || process.env.AGENTCORE_REMOTE_SHELL === "true";
      const sandboxResources = resources.nonMcpResources?.sandboxes ?? [];
      // 远端执行后端：**只要传入了 Sandbox 就用它**（不再要求 AGENTCORE_REMOTE_SHELL）。多 Sandbox 取首个，
      // 其余仍作各自的 openapi 工具暴露。SidecarServer 收到该资源即构建 RemoteSandboxBackend（见 server.ts）。
      const remoteExecSandbox = sandboxResources[0];
      const configuredExecBackend = this.executionBackends.get(session.conversationId);
      const hasRemoteSandbox = Boolean(remoteExecSandbox || configuredExecBackend);
      // 命令执行归属（AD-030，仅「用户实例 + 无 Sandbox」时生效）：features.execViaMcp 显式优先 → 缺省默认 true
      // （走我们的 MCP）；env AGENTCORE_EXEC_VIA_MCP=0 为运维全局 kill-switch（仅当请求未显式指定时生效）。
      const execViaMcp =
        typeof request.features?.execViaMcp === "boolean"
          ? request.features.execViaMcp
          : process.env.AGENTCORE_EXEC_VIA_MCP !== "0";
      // 是否注入内置执行/文件工具（bash/read_file/...）：
      //  - 有 Sandbox → 一定注入，后端 = 远端隔离沙箱（无视 remoteShell / execViaMcp）；
      //  - 无 Sandbox：系统实例 = 零执行（不注入）；用户实例 = 跟随 execViaMcp（后端 = 本地 bash）。
      const execToolsEnabled = hasRemoteSandbox ? true : remoteShell ? false : execViaMcp;
      const configuredImageCredential = imageCredentialName();
      const imageToolsEnabled = (execToolsEnabled || Boolean(request.localSandbox)) && !hasRemoteSandbox && !!this.imageCredentialProvider
        && !!configuredImageCredential && configuredImageCredential !== "0";
      // 是否关掉 codex 内建 shell（shell_tool=false）：有 Sandbox → 关（改走沙箱）；
      //  无 Sandbox：系统实例恒关、用户实例跟随 execViaMcp。
      const disableBuiltinShell = hasRemoteSandbox ? true : remoteShell ? true : execViaMcp;
      // 注入执行工具时保证有一份（可能为空的）非 MCP 资源容器，让 sidecar/mcp server 能启动并挂载工具。
      if ((execToolsEnabled || imageToolsEnabled) && !resources.nonMcpResources) {
        resources.nonMcpResources = { tools: [], skills: [], subAgents: [], sandboxes: [], mcpServers: [] };
      }
      // 执行后端沙箱（remoteExecSandbox）从「openapi 工具暴露」剔除：它经 RemoteSandboxBackend 当 bash/文件
      // 后端消费（SidecarServer 经 remoteExecSandbox 选项单独拿到完整资源，含数据面 operation），其数据面
      // operation 不应再作为模型工具暴露——否则模型同时看到内置 bash/read_file 与 <sandbox>_exec/<sandbox>_read_file，
      // 重复且混淆。两处派生工具的入口都要剔除，保持一致（否则系统提示词描述了一个 MCP 工具列表里不存在的工具）：
      //   ① MCP 工具列表（buildToolIndex 读 nonMcpResources.sandboxes）；
      //   ② 系统提示词「平台工具」段（buildSystemPrompt 内部 convertResources(request.resources) 重新派生）。
      // 其余沙箱（多 Sandbox 场景）仍按 openapi 工具暴露。
      let promptRequest = request;
      if (remoteExecSandbox && resources.nonMcpResources) {
        resources.nonMcpResources.sandboxes = resources.nonMcpResources.sandboxes.filter(
          (s) => s !== remoteExecSandbox,
        );
        promptRequest = { ...request, resources: request.resources?.filter((r) => r !== remoteExecSandbox) };
      }
      // 系统提示词：入参完整 RunRequest（身份 + 用户 prompt + 逐资源类型 section，按 mode 选模板）。
      // 用 promptRequest（已剔除执行后端沙箱）保证提示词工具列表 == MCP 工具列表。
      // execToolsEnabled 同时决定 skill 读取措辞：有 shell→read_file 读 .agents/skills/；无 shell→get_skill。
      let systemPrompt = buildSystemPrompt(promptRequest, { execToolsEnabled });
      if (execToolsEnabled) {
        systemPrompt += "\n\n" + EXEC_TOOLS_PROMPT;
        // 远端隔离沙箱说明（系统实例 + Sandbox）：执行环境/工作目录/装依赖/skill 同步位置。
        if (hasRemoteSandbox) {
          systemPrompt += "\n\n" + remoteExecPrompt(request.agent?.cwd);
        }
      }
      // 会话 workspace 目录（提前计算：execViaMcp 下要作为 shell 工具的执行 cwd 传给 sidecar）。
      let workspaceDir: string | undefined;
      if (this.workspacesDir) {
        workspaceDir = join(this.workspacesDir, session.conversationId);
        await mkdir(workspaceDir, { recursive: true });
      }

      const onSuspend = () => {
        // HITL 硬执行屏障：sidecar 决定挂起后，立即中断 codex（复用 interrupt 的 AbortController），
        // 拒绝后续工具调用，本轮只产 turn.end{hitl_pending} + run.end{hitl_pending}。
        session.hitlPending = true;
        session.abortController.abort("hitl_pending");
      };

      // Client tool 暂停屏障（消费通道 2）：模型调客户端声明的工具 → runloop 不执行、立即中断 codex，
      // 本轮以 tool_pending 收尾，等客户端下次 run 回传 toolresult.end 续跑。与 onSuspend 平行、互不影响。
      const clientTools = request.clientTools ?? [];
      const hasClientTools = clientTools.length > 0;
      const onToolPending = () => {
        session.toolPending = true;
        session.abortController.abort("tool_pending");
      };

      // Phase 2 会话级粘性授权：从历史派生 always-allow/always-reject 工具集合。
      const hitlPolicies = derivePolicies(normalized);

      const nonMcp = resources.nonMcpResources;
      if (nonMcp) {
        sidecar = new SidecarServer({
          resources: nonMcp,
          credentials: request.credentials,
          conversationId: session.conversationId,
          hitl: request.hitl,
          headers: request.headers,
          onSuspend,
          llmJudge: this.llmJudge ?? undefined,
          // HITL NL 降级措辞（AD-026 增补）：直连 session 上游模型 out-of-band 生成 prompt + 触发词（不入 transcript）；
          // 无 model 配置时 sidecar 自动回落静态模板。
          phrasing: request.model?.baseUrl && request.model?.apiKey
            ? new OpenAIHitlPhrasing({
                model: request.model.model,
                baseUrl: request.model.baseUrl,
                apiKey: request.model.apiKey,
              })
            : undefined,
          // F3 呈现映射（AD-026 增补）：同 phrasing，直连 session 上游模型 out-of-band 把 suspend 映射到
          // 最适合渲染的客户端工具（不入 transcript）；无 model 配置时 sidecar 自动回落静态映射。
          surfaceMapper: request.model?.baseUrl && request.model?.apiKey
            ? new OpenAIHitlSurfaceMapper({
                model: request.model.model,
                baseUrl: request.model.baseUrl,
                apiKey: request.model.apiKey,
              })
            : undefined,
          // F3 候选：客户端声明的工具（消费通道 2），供呈现映射在 needsLlm 时选择。
          clientTools: request.clientTools,
          grantedAllow: hitlPolicies.allow,
          grantedReject: hitlPolicies.reject,
          emit: injectEmit,
          execShell: execToolsEnabled,
          imageCredentialProvider: imageToolsEnabled ? this.imageCredentialProvider : undefined,
          imageCredentialName: configuredImageCredential,
          // Local CLI and MCP file/shell tools must share the deployment cwd.
          workdir: remoteShell || hasRemoteSandbox ? workspaceDir : (request.agent?.cwd ?? workspaceDir),
          remoteExecSandbox,
          remoteExecCwd: request.agent?.cwd,
          execBackend: configuredExecBackend,
          logger: runLoggerConfig,
        });
        await sidecar.start();
        log.info("sidecar started", { baseUrl: sidecar.baseUrl });
      }

      // agentcore-mcp server（AD-021）：把非 MCP 资源包装为 codex 原生 MCP 工具 + 注入客户端工具（消费通道 2）。
      // 启动条件：①有非 MCP 资源且 mcp/exec 模式（codex 原生调用，cli 模式走 shell 隧道不起）；②或有 client tools
      //（即使无任何平台资源也要起，让模型能调客户端工具并触发 tool_pending）。工具执行复用 sidecar.gatedExecute
      //（HITL 主轨闸门），client tool 命中则短路成暂停（onToolPending）。
      const needMcpServer = (nonMcp && (resourceMode === "mcp" || execToolsEnabled)) || hasClientTools;
      if (needMcpServer) {
        mcpServer = new AgentrunMcpServer({
          resources: nonMcp ?? { tools: [], skills: [], subAgents: [], sandboxes: [], mcpServers: [] },
          credentials: request.credentials,
          conversationId: session.conversationId,
          headers: request.headers,
          emit: injectEmit,
          executeTool: sidecar ? (name, args) => sidecar!.gatedExecute(name, args) : undefined,
          // 非资源工具门控（HITL 辅轨 / 内置执行工具 / skill 读取工具）：抽到 buildExtraTools 纯函数，
          // 保证「无 shell 场景下 skill 工具仍注入、执行工具不注入」可被直接断言（见 extra-tools.test.ts）。
          extraTools: sidecar
            ? buildExtraTools({
                hitlEnabled: sidecar.hitlEnabled,
                execToolsEnabled,
                imageToolsEnabled,
                hasSkills: (nonMcp?.skills?.length ?? 0) > 0,
              })
            : [],
          clientTools,
          onToolPending: hasClientTools ? onToolPending : undefined,
          logger: runLoggerConfig,
        });
        await mcpServer.start();
        resources.mcpConfig.mcpServers["agentcore"] = { type: "http", url: `${mcpServer.baseUrl}/mcp` };
        log.info("agentrun mcp server started", { baseUrl: mcpServer.baseUrl });
      }

      // HITL execute-on-resume：在启动 codex 之前处理历史中已审批的挂起 toolcall，
      // 把结果折进新模型输入（压缩 transcript）并作为 toolresult 事件注入 SSE（外部投影）。
      const hitlResume = await resolvePendingHitl(normalized, {
        conversationId: session.conversationId,
        runId,
        sidecar,
        credentials: request.credentials,
        // 嵌套审批向下转发（父层永不代执行子层 op）：经 sidecar resume 调用子 agent。
        forwardNested: sidecar ? (input) => sidecar!.forwardNestedResolution(input) : undefined,
      });
      if (hitlResume.error) {
        const errEvent = createEvent(EventType.RunError, session.conversationId, {
          runId,
          error: { code: ErrorCode.HitlUnresolved, message: hitlResume.error },
        });
        this.logEvent(eventLog, errEvent);
        yield errEvent;
        const endEvent = createEvent(EventType.RunEnd, session.conversationId, { runId, reason: "error" });
        this.logEvent(eventLog, endEvent);
        yield endEvent;
        this.runManager.setError(session.conversationId);
        return;
      }
      // NL 通道重问（AD-026 增补）：用户回复未匹配且未达上限 → 注入提示消息、跳过 codex，以 hitl_pending 结束本轮。
      if (hitlResume.reask) {
        for (const e of hitlResume.events) {
          stampRunId(e);
          session.events.push(e);
          this.logEvent(eventLog, e);
          yield e;
        }
        yield* this.emitEnd(eventLog, session.conversationId, runId, "hitl_pending", normalizer);
        this.runManager.complete(session.conversationId);
        return;
      }
      for (const e of hitlResume.events) {
        stampRunId(e);
        session.events.push(e);
        this.logEvent(eventLog, e);
        yield e;
      }

      const messages = compressEvents([...normalized, ...hitlResume.events], {
        continuationHint: true,
      });
      log.info("compressed messages", {
        count: messages.length,
        roles: messages.map((m) => m.role),
        contentLengths: messages.map((m) => m.content.length),
      });

      // 预发环境（AGENTCORE_ENV=pre|staging）下，为客户端未提供的 model 字段（主要 baseUrl/apiKey）补 env 默认值，
      // 方便联调时客户端不传模型凭证；线上绝不注入（见 model-defaults）。
      const model = applyModelEnvDefaults(request.model);
      if (!model?.baseUrl || !model?.apiKey) {
        throw new Error(
          "model.baseUrl and model.apiKey are required — agent CLI must not call upstream LLM directly"
        );
      }

      let providerBaseUrl: string | undefined;
      if (model.baseUrl && model.apiKey) {
        proxy = new ModelProviderProxy({
          config: {
            provider: model.provider,
            model: model.model,
            baseUrl: model.baseUrl,
            apiKey: model.apiKey,
            maxTokens: model.maxTokens,
            temperature: model.temperature,
          },
          // 凭证隔离：proxy 颁发 session token（adapter 用作 API key）；强制校验由 env 开关（默认关，
          // 避免影响 codex WS 握手鉴权，待确认后开启）。
          requireAuth: process.env.AGENTCORE_PROXY_REQUIRE_AUTH === "1",
          logger: runLoggerConfig,
        });
        await proxy.start();
        providerBaseUrl = proxy.baseUrl;
        log.info("provider proxy started", { providerBaseUrl });
      }

      // workspaceDir 已在前面提前计算并 mkdir（execViaMcp 需要它作为 shell 工具的执行 cwd）。
      if (workspaceDir) {
        if (sidecar && resources.nonMcpResources) {
          // cli 模式生成 .tools/agentrun shell 隧道（指向 sidecar 端口）；mcp 模式不生成。
          // credentials 用于 SKILL downloadUrl 的 RAM 签名下载。
          await setupWorkspaceTools(workspaceDir, resources.nonMcpResources, systemPrompt, {
            cliSidecarPort: resourceMode === "cli" ? sidecar.port : undefined,
            credentials: request.credentials,
            logger: log,
            // 有 Sandbox：skill 改由沙箱内直接下载（Change B），本地不落盘（「有沙箱不用落本地盘」）。
            skipSkillDownload: hasRemoteSandbox,
          });
          log.info("workspace tools generated", { workspaceDir, resourceMode });
          // 有 Sandbox：在沙箱内 curl 下载解包 skill（remote cwd 下），让沙箱内 read_file/bash 可读可跑。
          if (remoteExecSandbox) {
            await sidecar.initRemoteSandbox({ localWorkspaceDir: workspaceDir });
          }
        }
        log.info("session workspace", { workspaceDir });
      }

      const resolvedCommand = this.resolveCliCommand(agentCli);
      const adapter = this.createAdapter(resolvedCommand, request, runLoggerConfig);
      let serverToolNames: Set<string> | undefined;
      if (adapter.supportsServerToolEvents && mcpServer) {
        sidecar?.enableToolEvents();
        serverToolNames = mcpServer.enableToolEvents();
      }

      // 模型指令由 adapter 自产（codex → per-model 提示词；其它 adapter 不实现则 undefined）。
      // runner 不再特判 `adapterType === "codex"`——新增 CLI 只实现 adapter，runner 零改动。
      const modelInstructions = adapter.prepareModelInstructions?.(request);

      const generator = adapter.run({
        conversationId: session.conversationId,
        messages,
        config: resources,
        model,
        // codex 本地 spawn 目录：远端执行（有 Sandbox 或系统实例）下 agent.cwd 表示**沙箱内**运行目录
        // （可能本地不存在），故 codex 一律留在本地 workspaceDir；纯本地模式 agent.cwd 仍作本地 cwd。
        cwd: remoteShell || hasRemoteSandbox ? workspaceDir : (request.agent?.cwd ?? workspaceDir),
        systemPrompt,
        modelInstructions,
        signal: session.abortController.signal,
        providerBaseUrl,
        workspaceDir,
        onStreamDelta: proxy ? (listener) => proxy!.onTextDelta(listener) : undefined,
        env: request.agent?.env,
        startTurnIndex,
        providerToken: proxy?.sessionToken,
        serverToolNames,
        delegationToolNames: resources.nonMcpResources
          ? collectDelegationToolNames(resources.nonMcpResources)
          : undefined,
        // 客户端工具的最终名集合（净化名，与 MCP server 暴露名一致）：adapter 据此抑制 codex 自产的重复卡片
        //（同委派抑制，AD-024）——权威 toolcall.start/end 由 MCP server 经 injectEmit 发，codex 的不重复渲染。
        clientToolNames: hasClientTools
          ? new Set(clientTools.map((ct) => `client__${sanitizeToolName(ct.name)}`))
          : undefined,
        // adapter 只关心「是否关掉内建 shell」（shell_tool=false）——系统实例恒关、用户实例跟随 execViaMcp。
        execViaMcp: disableBuiltinShell,
        localSandbox: request.localSandbox,
      });

      let turnCount = 0;

      // adapter 事件流和 sidecar 注入事件流在此合并。归一化器在合并点统一维护 message 开闭真相，
      // 保证 tool_call.start 前 message 已关闭（详见 MergeNormalizer）。
      normalizer = new MergeNormalizer(session.conversationId);
      // 外发工具名还原（「压缩仅限内部逻辑」）：超 codex 64 字符线限时工具名被压缩成 `<head>_<hash>`，
      // 但那只是 codex wire 的需要——外发/存储/日志的事件 toolName 还原成原始 `<type>__<name>__<op>`。
      // 常态 map 为空（无超长名）→ 零开销。
      const outboundNameMap = buildOutboundNameMap(nonMcp ?? { tools: [], skills: [], subAgents: [], sandboxes: [], mcpServers: [] });
      const restoreOutboundName = (e: RunloopEvent): RunloopEvent => {
        const tn = (e as { toolName?: string }).toolName;
        const raw = tn ? outboundNameMap.get(tn) : undefined;
        return raw ? ({ ...e, toolName: raw } as RunloopEvent) : e;
      };
      const emitNormalized = function* (this: LoopRunner, event: RunloopEvent): Generator<RunloopEvent> {
        for (const e0 of normalizer!.normalize(event)) {
          // 中心出口统一补 runId：adapter 产出 + normalizer 补生成的事件都经此，
          // 否则它们由 createEvent 创建、不带 runId（只有显式带 runId 的 run.start/run.end 例外）。
          const e = stampRunId(restoreOutboundName(e0));
          session.events.push(e);
          this.logEvent(eventLog, e);
          yield e;
        }
      }.bind(this);

      const iter = generator[Symbol.asyncIterator]();
      let pendingNext = iter.next();
      let genDone = false;

      while (!genDone) {
        // 重新装载唤醒器。
        const waitInjected = new Promise<"injected">(r => { notifyInjected = () => r("injected"); });

        // 关键：在 await 之前先排空已积压的注入事件。notifyInjected 是单发唤醒器，
        // 若 sidecar 在上一轮 `yield`（SSE 背压）挂起期间触发过一次后被置 null，后续 emit 只入队
        // 不再唤醒；若此时直接 await race，这些事件会被压到下一个 adapter 事件（委派期间可能 ~18s）
        // 才发出——live 流式被静默缓冲，正是本次修复要消除的现象。先排空可消除该 lost-wakeup。
        if (injectedEvents.length > 0) {
          while (injectedEvents.length > 0) {
            yield* emitNormalized(injectedEvents.shift()!);
          }
          continue;
        }

        const result = await Promise.race([pendingNext, waitInjected]);

        // 先 flush 所有已注入的事件
        while (injectedEvents.length > 0) {
          const injected = injectedEvents.shift()!;
          yield* emitNormalized(injected);
        }

        if (result === "injected") {
          // 只是 sidecar 注入，adapter 还没产出，继续等
          continue;
        }

        // adapter 产出了事件
        if (result.done) {
          genDone = true;
          break;
        }
        const event = result.value;
        pendingNext = iter.next();

        yield* emitNormalized(event);

        if (event.type === EventType.TurnEnd) {
          turnCount++;
          if (maxTurns && turnCount >= maxTurns && !session.abortController.signal.aborted) {
            this.runManager.complete(session.conversationId);
            yield* this.emitEnd(eventLog, session.conversationId, runId, "completed", normalizer);
            return;
          }
        }

        if (session.abortController.signal.aborted) {
          if (session.hitlPending) {
            // HITL 挂起屏障：本轮只产 turn.end{hitl_pending} + run.end{hitl_pending}，结果延迟到下一个 run。
            for (const e of normalizer!.normalize(createEvent(EventType.TurnEnd, session.conversationId, { runId, turnIndex: turnCount, stopReason: "hitl_pending" }))) {
              session.events.push(e);
              this.logEvent(eventLog, e);
              yield e;
            }
            yield* this.emitEnd(eventLog, session.conversationId, runId, "hitl_pending", normalizer);
            this.runManager.complete(session.conversationId);
            return;
          }
          if (session.toolPending) {
            // Client tool 暂停屏障：本轮只产 turn.end{tool_pending} + run.end{tool_pending}，
            // 等客户端执行该工具后下次 run 回传 toolresult.end，compressEvents 折进 transcript 续跑。
            for (const e of normalizer!.normalize(createEvent(EventType.TurnEnd, session.conversationId, { runId, turnIndex: turnCount, stopReason: "tool_pending" }))) {
              session.events.push(e);
              this.logEvent(eventLog, e);
              yield e;
            }
            yield* this.emitEnd(eventLog, session.conversationId, runId, "tool_pending", normalizer);
            this.runManager.complete(session.conversationId);
            return;
          }
          const abortReason = session.abortController.signal.reason;
          const isTimeout = abortReason === "timeout";
          const interrupt = createEvent(EventType.RunInterrupt, session.conversationId, {
            runId,
            reason: isTimeout ? "timeout" : "user_interrupt",
          });
          this.logEvent(eventLog, interrupt);
          yield interrupt;
          yield* this.emitEnd(eventLog, session.conversationId, runId, isTimeout ? "timeout" : "interrupted", normalizer);
          break;
        }
      }

      if (!session.abortController.signal.aborted) {
        this.runManager.complete(session.conversationId);
        yield* this.emitEnd(eventLog, session.conversationId, runId, "completed", normalizer);
      }
    } catch (err) {
      this.runManager.setError(session.conversationId);
      const sessionError = createEvent(EventType.RunError, session.conversationId, {
        runId,
        error: {
          code: ErrorCode.LoopError,
          message: err instanceof Error ? err.message : String(err),
        },
      });
      log.error("loop error", {
        error: { code: ErrorCode.LoopError, message: err instanceof Error ? err.message : String(err) },
      });
      this.logEvent(eventLog, sessionError);
      yield sessionError;
      yield* this.emitEnd(eventLog, session.conversationId, runId, "error", normalizer);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (mcpServer) {
        await mcpServer.stop();
      }
      if (sidecar) {
        await sidecar.stop();
      }
      if (proxy) {
        await proxy.stop();
      }
      this.executionBackends.delete(session.conversationId);
    }
  }

  /**
   * 产出 run.end（流末事件，恒产出）；L-033。
   * run.end 前先 flush 归一化器（L10）：流末不得有未闭合 message（assertBaseInvariants），
   * 但子 agent 漏发 message-end 时孤儿 message 会带到此处，flush 补一条 message.end 使流自洽。
   * normalizer 为空（HITL 早期路径、合并循环尚未建立）时无需 flush。
   */
  private *emitEnd(
    eventLog: Logger,
    conversationId: string,
    runId: string,
    reason: "completed" | "interrupted" | "error" | "timeout" | "hitl_pending" | "tool_pending",
    normalizer?: MergeNormalizer | null,
  ): Generator<RunloopEvent> {
    if (normalizer) {
      for (const e of normalizer.flush()) {
        this.logEvent(eventLog, e);
        yield e;
      }
    }
    const end = createEvent(EventType.RunEnd, conversationId, { runId, reason });
    this.logEvent(eventLog, end);
    yield end;
  }


  private logEvent(logger: Logger, event: RunloopEvent): void {
    logger.event(event);
  }

  interrupt(conversationId: string, reason?: string): boolean {
    const interrupted = this.runManager.interrupt(conversationId, reason);
    void this.executionBackends.get(conversationId)?.interrupt?.().catch(() => {});
    return interrupted;
  }

  resolveCliCommand(agentCli: string): string {
    const entry = this.registry.resolve(agentCli);
    if (entry) return entry.command;

    if (!this.allowUnregisteredAgents) {
      throw new Error(`Agent CLI "${agentCli}" is not registered. Available: ${this.registry.listRegistered().join(", ")}`);
    }

    if (!validateAgentCli(agentCli)) {
      throw new Error(`Agent CLI "${agentCli}" contains invalid characters`);
    }

    return agentCli;
  }

  private createAdapter(
    cliCommand: string,
    request: RunRequest,
    loggerConfig?: LoggerOptions,
  ): AgentAdapter {
    const resolvedAgentCli = request.agent?.cli ?? "codex";
    const registryEntry = this.registry.resolve(resolvedAgentCli);
    const adapterType =
      (request as Record<string, unknown>).adapterType as AdapterType | undefined ??
      registryEntry?.adapterType ??
      this.defaultAdapterType;

    const hitlEnabled = request.hitl?.enabled ?? false;
    const permissionMode = hitlEnabled ? "default" : "bypass_permissions";

    switch (adapterType) {
      case "stream-json":
        return new StreamJsonAdapter(cliCommand, { permissionMode });
      case "acp":
        return new AcpAdapter(cliCommand, { logger: loggerConfig });
      case "acp-server":
        return new AcpServerAdapter(cliCommand, {
          logger: loggerConfig,
          defaultArgs: registryEntry?.defaultArgs,
        });
      case "codex":
        return new CodexAdapter(cliCommand, { logger: loggerConfig });
      case "cli":
      default:
        return new CliAgentAdapter(cliCommand, { permissionMode });
    }
  }
}
