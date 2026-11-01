import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProcess } from "./process.js";
import { resolveAgentUser, buildSandboxEnv, chownRecursive } from "./sandbox-user.js";
import type { AgentAdapter, AgentRunParams } from "./adapter.js";
import type { CompressedMessage } from "../events/compress.js";
import type { ModelConfig } from "../types/resources.js";
import type { RunRequest } from "../types/api.js";
import { buildModelPrompt } from "../loop/prompt-builder.js";
import { EventType, type RunloopEvent } from "../types/events.js";
import { createEvent } from "../events/factory.js";
import { EventStateMachine } from "../events/state-machine.js";
import { isDelegationCommand } from "../sidecar/delegation.js";
import { Logger, type LoggerOptions } from "../util/logger.js";

/**
 * codex 全限定 MCP 工具名（`mcp__agentcore__<name>`）是否命中某权威名集合（委派 / 客户端工具）。
 * 命中 ⟺ rawName === name（裸名）或 rawName === `mcp__agentcore__<name>`（聚合器全限定名，server 名固定 agentcore）。
 * **精确匹配、不用 `endsWith(\`__${n}\`)` 后缀匹配**：后缀匹配会让集合里的短名（如某工具的 op 段 `exec`）
 * 误伤同后缀的别的工具卡片（如 `mcp__agentcore__sandbox__mybox__exec`，评审 P1-1）。当前委派名恒
 * `agent__x__delegate`、客户端名恒 `client__x`，实际难触发，但收紧为精确匹配消除该隐患。
 * 抽成模块级纯函数：委派与客户端工具的 mcp_tool_call 卡片抑制共用同一判定（AD-024 / AD-026 增补）。
 */
function matchesQualifiedName(rawName: string, names: Set<string>): boolean {
  for (const n of names) {
    if (rawName === n || rawName === `mcp__agentcore__${n}`) return true;
  }
  return false;
}

/** item.completed 已识别处理的 itemType 集合；其余记 debug 日志以便排查 codex 版本差异。 */
const KNOWN_COMPLETED_ITEM_TYPES = new Set<string>([
  "agent_message", "message", "reasoning",
  "tool_call", "function_call", "command_execution",
  "tool_result", "function_call_output", "mcp_tool_call",
  "todo_list", "update_plan", "plan", "web_search",
]);

export class CodexAdapter implements AgentAdapter {
  readonly supportsServerToolEvents = true;
  private agentProcess: AgentProcess | null = null;
  private tmpDir: string | null = null;
  private isWorkspaceTmp = false;
  private nativeHome?: string;
  private unsubscribeStream: (() => void) | null = null;
  private log: Logger;
  /** 本次 run 的委派工具名集合（识别委派、抑制 codex 重复卡片；见 AgentRunParams.delegationToolNames）。 */
  private delegationToolNames: Set<string> = new Set();
  /** 本次 run 的客户端工具名集合（消费通道 2）：与委派同样抑制 codex 自产的重复 mcp_tool_call 卡片。 */
  private clientToolNames: Set<string> = new Set();
  private serverToolNames: Set<string> = new Set();
  /** Codex reports the same MCP item at start, updates, and completion. */
  private mcpCalls = new Map<string, { argumentsSent: boolean; completed: boolean }>();

  constructor(
    private readonly cliCommand: string,
    options?: { logger?: LoggerOptions }
  ) {
    this.log = new Logger("codex", options?.logger ?? {});
  }

  /** codex 的模型指令 = per-model codex 提示词（AD-023）。由 codex-adapter 持有，runner 不再特判 codex。 */
  prepareModelInstructions(request: RunRequest): string | undefined {
    return buildModelPrompt(request);
  }

  async *run(params: AgentRunParams): AsyncGenerator<RunloopEvent> {
    const { conversationId, messages, config, model, cwd, systemPrompt, signal } =
      params;
    this.delegationToolNames = params.delegationToolNames ?? new Set();
    this.clientToolNames = params.clientToolNames ?? new Set();
    this.serverToolNames = params.serverToolNames ?? new Set();
    this.mcpCalls.clear();

    if (params.workspaceDir) {
      this.tmpDir = join(params.workspaceDir, ".runloop");
      await mkdir(this.tmpDir, { recursive: true });
      this.isWorkspaceTmp = true;
    } else {
      this.tmpDir = await mkdtemp(join(tmpdir(), "runloop-codex-"));
    }
    const fullSystemPrompt = [systemPrompt, config.systemPromptAppend]
      .filter(Boolean)
      .join("\n\n");
    const args = await this.buildArgs(model, cwd, Boolean(params.localSandbox));
    const transcript = this.buildTranscript(messages);

    this.agentProcess = new AgentProcess();
    const sm = new EventStateMachine(conversationId);

    const queue: RunloopEvent[] = [];
    let resolveNext: ((value: IteratorResult<RunloopEvent>) => void) | null = null;
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

    const enqueueAll = (events: RunloopEvent[]) => {
      for (const event of events) enqueue(event);
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
    const spawnTime = Date.now();
    let firstStdoutTime = 0;

    yield createEvent(EventType.TurnStart, conversationId, { turnIndex });

    if (params.onStreamDelta) {
      this.unsubscribeStream = params.onStreamDelta((content: string) => {
        enqueueAll(sm.textDelta(content));
      });
    }

    this.agentProcess.on("stdout", (line: string) => {
      if (!firstStdoutTime) {
        firstStdoutTime = Date.now();
        this.log.info("first stdout", { elapsedMs: firstStdoutTime - spawnTime });
      }
      const events = this.mapCodexLine(line, conversationId, sm, spawnTime);
      if (events) {
        enqueueAll(events);
        if (events.some(e => e.type === EventType.RunError)) {
          this.agentProcess?.kill();
        }
      }
    });

    this.agentProcess.on("stderr", (data: string) => {
      this.log.info("stderr", { data: data.trimEnd() });
    });

    this.agentProcess.on("exit", (code: number | null) => {
      this.log.info("process exit", {
        code,
        elapsedMs: Date.now() - spawnTime,
        sinceLastStdout: firstStdoutTime ? Date.now() - firstStdoutTime : null,
      });
      enqueueAll(sm.flush());
      enqueue(
        createEvent(EventType.TurnEnd, conversationId, {
          turnIndex,
          stopReason: code === 0 && !signal?.aborted ? "end_turn" : "cancelled",
        })
      );
      finish();
    });

    this.agentProcess.on("error", (err: Error) => {
      enqueueAll(sm.flush());
      enqueue(
        createEvent(EventType.RunError, conversationId, {
          error: { code: "PROCESS_ERROR", message: err.message },
        })
      );
      finish();
    });

    const onAbort = () => this.interrupt();
    signal?.addEventListener("abort", onAbort, { once: true });

    // 上游自配 env 先铺底，runloop 必备变量（OPENAI_API_KEY/CODEX_HOME/NO_PROXY）随后覆盖、上游覆盖不了。
    const env: Record<string, string> = { ...(params.env ?? {}) };
    const configLines: string[] = [];
    let sandboxOverrides: string[] = [];

    // 系统提示词只在 system#1（codex 的 base_instructions，经 model_instructions_file 注入）出现一次：
    //   = codex 操作规约（per-model 提示词 modelInstructions） + 我们的系统提示词（身份/环境/资源）。
    // 我们的部分放最后，在指令优先级上覆盖 codex 的 “You are Codex” 身份声明。
    // 不再写 developer_instructions（消除原 system#2 这条重复 developer 消息）。
    const baseInstructions = [params.modelInstructions, fullSystemPrompt]
      .filter(Boolean)
      .join("\n\n");

    // codex 默认把 cwd/AGENTS.md 当 project doc 注入成一条 user 消息（原 user#1，与 system#1 内容重复）。
    // 系统提示词已并入 system#1，故关掉它：codex `read_project_docs` 见 project_doc_max_bytes==0 直接返回 None，
    // 不再读取 AGENTS.md。（顶层 key，必须放在 [features] 段之前。）
    configLines.push("project_doc_max_bytes = 0");
    // Runloop exposes compatible MCP-backed image entries; disable Codex's own provider-bound viewer.
    configLines.push("tools.view_image = false");

    if (params.providerBaseUrl) {
      env.OPENAI_API_KEY = params.providerToken ?? "runloop-proxy";
      env.NO_PROXY = "127.0.0.1,localhost";
      env.no_proxy = "127.0.0.1,localhost";
      configLines.push(`openai_base_url = "${params.providerBaseUrl}/v1"`);
    } else if (model?.apiKey) {
      env.OPENAI_API_KEY = model.apiKey;
      if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }

    if (params.localSandbox) {
      configLines.push('default_permissions = "agentcore_local"');
      configLines.push('web_search = "disabled"');
    }

    // codex 内置的 codex_apps MCP server 会连接 chatgpt.com/backend-api/wham/apps，
    // 在非 OpenAI 环境下握手超时 30s 严重拖慢启动。通过 Feature::Apps 关闭。
    // [features] 必须在所有顶层 key 之后，TOML section header 前。
    configLines.push("");
    configLines.push("[features]");
    configLines.push("apps = false");
    // plugins = false：禁用 codex 插件市场。否则 codex 每个会话启动时会把整套「OpenAI Curated」
    // 市场仓库 git clone 到 $CODEX_HOME/.tmp/plugins（带 .git，每会话一份、从不回收 → 磁盘暴涨）。
    // runloop 用 skills（.agents/skills/ + get_skill），从不用 codex 插件市场，关掉无副作用。
    // plugins 与 skills 是相互独立的 feature，关 plugins 不影响 skills。
    configLines.push("plugins = false");
    // 关掉 codex 自带、与 runloop 能力重复/纯噪声的工具族（AD-030 待办）。实测（codex 0.141 +
    // 本地 runloop proxy 抓 tools[]）：加这两行后工具数 20→12，输入 token ~11.7k→8.7k。
    // - multi_agent：codex 原生 Collab 子 agent（spawn_agent/wait_agent/send_input/multi_agent_v1__* 等），
    //   与 runloop 自有的子 agent 委派打架，关掉。验证：5 个 multi_agent_v1__* 工具消失。
    // - goals：codex 原生 goals（create_goal/get_goal/update_goal），runloop 不用。验证：3 个 goal 工具消失。
    configLines.push("multi_agent = false");
    configLines.push("goals = false");
    // request_user_input（codex 原生「向用户提问」工具）**无法**用任何 config/feature 从工具列表移除——
    // codex `tool_config.rs` 把它写死为 `include = !is_subagent_session`，普通 exec 会话恒带（要彻底
    // 去掉只能在 proxy 翻译层 strip tools[]）。此处显式 `=false` 不是删工具，而是钉住「安全降级」行为：
    // codex exec 跑在 ModeKind::Default，该 flag=false 时模型若调它，codex 返回 "unavailable in Default
    // mode" 给模型（RespondToModel，模型可恢复、转去调 client__super_agent_*），且其工具描述也会自述
    // 「仅 Plan 模式可用」。若 flag=true 反而会进 exec 不支持的 ServerRequest 路径而挂起（L-045）。
    configLines.push("default_mode_request_user_input = false");
    configLines.push("view_image = false");
    configLines.push("image_generation = false");
    // execViaMcp（AD-030，由 runner 据 features.execViaMcp 解析后传入）：关掉 codex 内建 shell 工具，
    // 迫使模型改调我们自有的 `shell` MCP 工具（执行经 runloop 统一工具路径：handleToolCall →
    // sidecar.gatedExecute 主轨，可换远端沙箱后端）。codex `tool_config.rs`：
    // !features.shell_tool → ConfigShellToolType::Disabled。
    if (params.execViaMcp) {
      configLines.push("shell_tool = false");
    }

    const mcpServers = config.mcpConfig.mcpServers;
    for (const [name, entry] of Object.entries(mcpServers)) {
      configLines.push("");
      configLines.push(`[mcp_servers.${name}]`);
      if (entry.url) {
        configLines.push(`url = "${entry.url}"`);
      }
      if (entry.command) {
        configLines.push(`command = "${entry.command}"`);
        if (entry.args?.length) {
          configLines.push(`args = [${entry.args.map(a => `"${a}"`).join(", ")}]`);
        }
      }
    }

    if (configLines.length > 0 || params.providerBaseUrl || baseInstructions) {
      let codexHome = join(this.tmpDir!, "codex-home");
      if (params.localSandbox) {
        // Codex refuses to create sandbox helper aliases under OS temporary directories.
        const root = process.env.AGENTCORE_CODEX_HOME_ROOT ?? join(process.cwd(), ".agentcore-codex");
        await mkdir(root, { recursive: true });
        this.nativeHome = await mkdtemp(join(root, "session-"));
        codexHome = this.nativeHome;
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(codexHome, { recursive: true });

      // Disable only Codex-bundled skills; AgentCore-managed workspace skills remain enabled.
      // System skills are reinstalled by Codex, so deleting their files is not sufficient.
      const skillHome = await realpath(codexHome);
      const disabledSkills = ["imagegen", "openai-docs", "plugin-creator", "review-agent", "skill-creator", "skill-installer"]
        .map(name => `{path=${JSON.stringify(join(skillHome, "skills", ".system", name, "SKILL.md"))},enabled=false}`);
      args.splice(args.length - 1, 0, "-c", `skills.config=[${disabledSkills.join(",")}]`);

      if (baseInstructions) {
        const instructionsPath = join(codexHome, "model-instructions.md");
        writeFileSync(instructionsPath, baseInstructions);
        configLines.unshift(`model_instructions_file = "${instructionsPath}"`);
      }

      if (params.localSandbox) {
        const { localSandboxConfig, localSandboxOverrides } = await import("./local-sandbox.js");
        const sandboxLines = await localSandboxConfig(params.localSandbox, cwd!, this.cliCommand);
        configLines.push(...sandboxLines);
        sandboxOverrides = localSandboxOverrides(sandboxLines);
        args.splice(args.length - 1, 0, "--ignore-rules", ...sandboxOverrides.flatMap(value => ["-c", value]));
      }
      writeFileSync(join(codexHome, "config.toml"), configLines.join("\n") + "\n");
      if (params.providerBaseUrl) {
        // Codex 0.155 requires auth_mode + OPENAI_API_KEY. The old mode field selects
        // ChatGPT auth and waits up to 5s for user settings before the first model call.
        // Store only the per-session proxy token, never the upstream model credential.
        writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: env.OPENAI_API_KEY }));
      }
      env.CODEX_HOME = codexHome;
    }

    // 降权运行：生产容器以 root 启动 runloop，把 codex 降到非 root 用户（默认 coder）跑，
    // 使 root 进程持有的平台密钥（/proc/mem、/proc/environ）对 codex 不可读、且无法抓包（AD-025）。
    // 开发/测试（非 root）下 resolveAgentUser() 返回 null，行为不变。
    const agentUser = resolveAgentUser();
    let spawnEnv = env;
    let replaceEnv = false;
    if (agentUser) {
      // 让降权用户能读写工作区与 CODEX_HOME（config.toml/auth.json/.tools 等此时已写好）
      if (params.workspaceDir) {
        await chownRecursive(params.workspaceDir, agentUser.uid, agentUser.gid);
      }
      if (this.tmpDir) {
        await chownRecursive(this.tmpDir, agentUser.uid, agentUser.gid);
      }
      if (this.nativeHome) await chownRecursive(this.nativeHome, agentUser.uid, agentUser.gid);
      if (params.localSandbox && cwd) {
        const { lchown } = await import("node:fs/promises");
        await lchown(params.localSandbox.userRoot, agentUser.uid, agentUser.gid);
        await lchown(cwd, agentUser.uid, agentUser.gid);
        await lchown(join(cwd, ".agentcore-tmp"), agentUser.uid, agentUser.gid);
      }
      spawnEnv = buildSandboxEnv(env, agentUser);
      replaceEnv = true;
    }

    if (params.localSandbox && !signal?.aborted) {
      try {
        const { verifyLocalSandbox } = await import("./local-sandbox.js");
        await verifyLocalSandbox(this.cliCommand, cwd!, sandboxOverrides,
          replaceEnv ? spawnEnv : { ...process.env, ...spawnEnv },
          { uid: agentUser?.uid, gid: agentUser?.gid });
      } catch (error) {
        await this.cleanup();
        throw error;
      }
    }
    if (signal?.aborted) {
      enqueue(createEvent(EventType.TurnEnd, conversationId, { turnIndex, stopReason: "cancelled" }));
      finish();
    } else {
      this.log.info("spawn", {
        command: this.cliCommand,
        argCount: args.length,
        cwd: cwd ?? process.cwd(),
        hasProxy: !!params.providerBaseUrl,
        mcpServerCount: Object.keys(config.mcpConfig.mcpServers).length,
        dropPrivilege: !!agentUser,
        agentUid: agentUser?.uid,
      });

      this.agentProcess.spawn({
        command: this.cliCommand,
        args,
        cwd: cwd ?? process.cwd(),
        env: spawnEnv,
        replaceEnv,
        uid: agentUser?.uid,
        gid: agentUser?.gid,
        // LoopRunner owns the configured run deadline and records timeout status.
        // A second hidden timer killed long tasks at 5min and reported exit(0) as success.
        // prompt 经 stdin 传入（codex `-`）。写完即 end 发 EOF，codex 据此开始执行。
        stdinData: transcript,
      });
    }

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          const event = await new Promise<IteratorResult<RunloopEvent>>(
            (resolve) => { resolveNext = resolve; }
          );
          if (event.done) break;
          yield event.value;
        }
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.unsubscribeStream) {
        this.unsubscribeStream();
        this.unsubscribeStream = null;
      }
      await this.cleanup();
    }
  }

  interrupt(): void {
    this.agentProcess?.kill();
  }

  private killAfterGracePeriod(): void {
    setTimeout(() => {
      if (this.agentProcess && !this.agentProcess.exited) {
        this.log.info("kill after grace period");
        this.agentProcess.kill();
      }
    }, 500);
  }

  private mapCodexLine(line: string, conversationId: string, sm: EventStateMachine, spawnTime: number): RunloopEvent[] | null {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      if (line.trim()) {
        return sm.textDelta(line);
      }
      return null;
    }
    const type = data.type as string | undefined;
    if (type) {
      this.log.info("codex event", { type, elapsedMs: Date.now() - spawnTime });
    }
    return this.mapCodexEvent(data, conversationId, sm);
  }

  private mapMcpToolCall(
    item: Record<string, unknown>,
    sm: EventStateMachine,
    completed: boolean,
  ): RunloopEvent[] {
    const rawName = (item.tool as string) ?? (item.name as string);
    // Server-owned calls (including delegation/client tools) must not create CLI cards.
    if (rawName && (
      matchesQualifiedName(rawName, this.delegationToolNames) ||
      matchesQualifiedName(rawName, this.clientToolNames) ||
      matchesQualifiedName(rawName, this.serverToolNames)
    )) return [];
    // An early item needs a stable ID and name to match its later result.
    if (!completed && (!item.id || !rawName)) return [];
    const toolCallId = (item.id as string) ?? `tc-${Date.now()}`;
    let call = this.mcpCalls.get(toolCallId);
    if (call?.completed) return [];
    const events: RunloopEvent[] = [];
    if (!call) {
      // Strip only our aggregator prefix; preserve namespaces such as mcp__calc__add.
      const normalizedName = (rawName ?? "unknown").replace(/^mcp__agentcore__/, "");
      const toolName = normalizedName === "imagegen" ? "image_gen.imagegen" : normalizedName;
      events.push(...sm.toolCallStart(toolCallId, toolName));
      call = { argumentsSent: false, completed: false };
      this.mcpCalls.set(toolCallId, call);
    }
    const rawArgs = item.arguments ?? item.input ?? item.args;
    if (!call.argumentsSent && rawArgs !== undefined && rawArgs !== null) {
      let args: unknown = rawArgs;
      if (typeof rawArgs === "string") {
        try { args = JSON.parse(rawArgs); }
        catch {
          // Updates may still contain partial JSON; keep the tool pending.
          if (!completed) return events;
          args = { raw: rawArgs };
        }
      }
      events.push(...sm.toolCallExecuting(toolCallId, args as Record<string, unknown>));
      call.argumentsSent = true;
    }
    if (completed) {
      const isError = item.status === "failed" || item.status === "error";
      events.push(...sm.toolCallResult(toolCallId, item.result ?? item.output ?? item.text ?? "", isError));
      call.completed = true;
    }
    return events;
  }

  private mapCodexEvent(
    data: Record<string, unknown>,
    conversationId: string,
    sm: EventStateMachine
  ): RunloopEvent[] {
    const events: RunloopEvent[] = [];
    const type = data.type as string;

    switch (type) {
      case "item.started":
      case "item.updated": {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "mcp_tool_call") {
          events.push(...this.mapMcpToolCall(item, sm, false));
        }
        break;
      }

      case "item.completed": {
        const item = data.item as Record<string, unknown> | undefined;
        if (!item) break;

        const itemType = item.type as string;

        if (itemType === "agent_message" || itemType === "message") {
          if (sm.currentState === "MESSAGE_OPEN") {
            events.push(...sm.flush());
          } else {
            const text = item.text as string | undefined;
            if (text) {
              events.push(...sm.textComplete(text));
            }
          }
        }

        // codex 的 reasoning（思考）→ reasoning.* 三件套（独立命名空间，不混入 assistant 正文）。
        // 已流式（REASONING_OPEN）则只补 end；否则非流式 → 一次性 start→delta→end。
        if (itemType === "reasoning") {
          if (sm.currentState === "REASONING_OPEN") {
            events.push(...sm.flush());
          } else {
            const text = (item.text as string | undefined) ?? (item.summary as string | undefined);
            if (text) {
              events.push(...sm.reasoningComplete(text));
            }
          }
        }

        if (itemType === "tool_call" || itemType === "function_call") {
          const toolCallId = (item.id as string) ?? `tc-${Date.now()}`;
          const toolName = (item.name as string) ?? (item.call_id as string) ?? "unknown";
          events.push(...sm.toolCallStart(toolCallId, toolName));
          const rawArgs = item.arguments ?? item.input;
          if (rawArgs !== undefined && rawArgs !== null) {
            // 模型可能产出截断/拼接的非法 JSON args 字符串（如 `{}{"k":"v"}`）。裸 JSON.parse 抛出
            // 会在同步 stdout 监听器内逸出 → 中断该 chunk 剩余行 / 进程级未捕获异常。失败降级为
            // { raw } 与 mcp_tool_call 分支同款守护（H9）。
            let args: unknown = rawArgs;
            if (typeof rawArgs === "string") {
              try { args = JSON.parse(rawArgs); } catch { args = { raw: rawArgs }; }
            }
            events.push(...sm.toolCallExecuting(toolCallId, args as Record<string, unknown>));
          }
        }

        if (itemType === "command_execution") {
          const command = (item.command as string) ?? "";
          // 委派调用（.tools/agentrun call）的生命周期由 sidecar 拥有（同一 id 的 start→output_delta→result）。
          // 抑制 codex 这张重复的 exec_command 卡片，避免双重渲染 + id 撕裂。
          // codex 自身的 loop 不受影响：它通过 stdout/exit 读取结果继续，与上游 SSE 无关。
          if (isDelegationCommand(command, this.delegationToolNames)) break;
          const toolCallId = (item.id as string) ?? `tc-${Date.now()}`;
          const exitCode = item.exit_code as number | null | undefined;
          events.push(...sm.toolCallStart(toolCallId, "exec_command"));
          events.push(...sm.toolCallExecuting(toolCallId, { cmd: command }));
          events.push(...sm.toolCallResult(
            toolCallId,
            item.aggregated_output ?? item.output ?? "",
            typeof exitCode === "number" ? exitCode !== 0 : false,
          ));
        }

        if (itemType === "tool_result" || itemType === "function_call_output") {
          const toolCallId = (item.call_id as string) ?? (item.id as string) ?? `tc-${Date.now()}`;
          const output = item.output ?? item.text;
          events.push(...sm.toolCallResult(toolCallId, output));
        }

        if (itemType === "mcp_tool_call") {
          events.push(...this.mapMcpToolCall(item, sm, true));
        }

        // 未识别的 item 类型：debug 日志记下真实形态（便于排查 codex 新版本 item 结构变化，如 mcp 调用字段）。
        if (!KNOWN_COMPLETED_ITEM_TYPES.has(itemType)) {
          this.log.info("unhandled codex item.completed", { itemType, keys: Object.keys(item) });
        }

        // codex 的 update_plan / todo_list 工具输出 → plan.update（L-039）
        if (itemType === "todo_list" || itemType === "update_plan" || itemType === "plan") {
          const rawEntries = (item.plan ?? item.items ?? item.entries) as
            | Array<Record<string, unknown>> | undefined;
          if (Array.isArray(rawEntries)) {
            const entries = rawEntries.map((p) => {
              const status = String(p.status ?? "pending");
              return {
                content: String(p.content ?? p.step ?? p.text ?? ""),
                status: status === "in_progress" || status === "completed" ? status : "pending",
                ...(p.priority ? { priority: String(p.priority) } : {}),
              };
            });
            for (const e of sm.flush()) events.push(e); // 关掉打开的 message，保持事件序合法
            events.push(createEvent(EventType.PlanUpdate, conversationId, { entries }));
          }
        }
        break;
      }

      case "item.streaming": {
        const item = data.item as Record<string, unknown> | undefined;
        if (!item) break;
        const text = (item.text as string) ?? (data.text as string);
        if (text) {
          // 按 item.type 分流：reasoning 流式 → reasoning.delta（独立命名空间，不泄进 message 正文）。
          const itemType = (item.type as string | undefined) ?? (item.item_type as string | undefined);
          if (itemType === "reasoning") {
            events.push(...sm.reasoningDelta(text));
          } else {
            events.push(...sm.textDelta(text));
          }
        }
        break;
      }

      case "turn.completed": {
        const usage = data.usage as Record<string, unknown> | undefined;
        if (usage) {
          events.push(...sm.usage({
            inputTokens: usage.input_tokens as number | undefined,
            outputTokens: usage.output_tokens as number | undefined,
            cacheReadTokens: usage.cached_input_tokens as number | undefined,
          }));
        }
        this.killAfterGracePeriod();
        break;
      }

      case "error": {
        const message = (data.message as string) ?? "Unknown codex error";
        if (message.includes("Reconnecting")) break;
        events.push(createEvent(EventType.RunError, conversationId, {
          error: { code: "CODEX_ERROR", message },
        }));
        break;
      }

      case "turn.failed": {
        const err = data.error as Record<string, unknown> | undefined;
        const message = (err?.message as string) ?? "Turn failed";
        events.push(createEvent(EventType.RunError, conversationId, {
          error: { code: "CODEX_TURN_FAILED", message },
        }));
        this.killAfterGracePeriod();
        break;
      }

      case "thread.started":
      case "turn.started":
        break;
    }

    return events;
  }

  private async buildArgs(
    model?: ModelConfig,
    cwd?: string,
    localSandbox = false,
  ): Promise<string[]> {
    const args: string[] = ["exec", "--json", "--skip-git-repo-check"];
    if (!localSandbox) args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("-c", 'approval_policy="never"');

    if (model?.model) {
      args.push("-m", model.model);
    }

    if (cwd) {
      args.push("-C", cwd);
    }

    // prompt（transcript）经 stdin 传入：positional `-` 告诉 codex 从 stdin 读 PROMPT。
    // 不再把 transcript 作为 positional argument——新版 codex（≥0.142）会把多词 positional 按空白
    // 拆成多个参数、报 "unexpected argument 'xxx'"（L-054）。stdin 通路不受 argv 解析影响。
    args.push("-");

    return args;
  }

  private buildTranscript(messages: CompressedMessage[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === "system") parts.push(`[Context]\n${msg.content}`);
      else if (msg.role === "user") parts.push(msg.content);
      else if (msg.role === "assistant") parts.push(`[Assistant]\n${msg.content}`);
    }
    return parts.join("\n\n");
  }

  private async cleanup(): Promise<void> {
    if (this.nativeHome) {
      await rm(this.nativeHome, { recursive: true, force: true }).catch(() => {});
      this.nativeHome = undefined;
    }
    if (this.tmpDir && !this.isWorkspaceTmp) {
      try { await rm(this.tmpDir, { recursive: true, force: true }); } catch {}
    }
    this.tmpDir = null;
  }
}
