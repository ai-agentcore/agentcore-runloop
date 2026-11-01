import type { ClientTool, Credentials, Resource } from "../types/resources.js";
import type { RunloopEvent } from "../types/events.js";
import { EventType } from "../types/events.js";
import { buildSignedRequest } from "./agentrun-sign.js";
import { assertOutboundAllowed, assertAgentrunHostAllowed, SsrfBlockedError } from "./ssrf.js";
import { translateChildEvent } from "./event-translator.js";
import { deriveAgentEndpoint, delegationProtocol } from "../mcp/openapi.js";
import { compressEvents } from "../events/compress.js";
import { buildA2aRequestBody, buildA2aResumeBody, extractA2aError, extractA2aText, isA2aCardUrl, chooseA2aServiceEndpoint } from "./a2a.js";
import { logResourceRequest, logResourceResponse, type ResourceCallLogger } from "./resource-log.js";
import { rewriteToInternalEndpoint } from "./internal-endpoint.js";
import { envPositiveInt } from "../util/env.js";
import { createHash } from "node:crypto";

export type SubAgentEmit = (event: RunloopEvent) => void;

/**
 * 委派会话的确定性 threadId（AG-UI 会话关联）。
 *
 * 由 `(conversationId, 委派 toolCallId)` 派生 → 同一次委派的**初始调用（run1）与 HITL resume（run2）
 * 拿到一致的 threadId**（run2 的委派 toolCallId 由 suspend.parentToolCallId 恢复，与 run1 同值），
 * 让「服务端自管会话」的子 agent 能把两次调用关联到同一会话、找回挂起的 HITL。
 * 不同委派（不同 toolCallId）→ 不同 thread。镜像 super_agent `subagent-tool.ts` 的
 * `thread_<md5(...)>` 约定。runloop/a2a 协议各有自己的续接机制（events / taskId），不用此 threadId。
 */
function deriveThreadId(conversationId?: string, toolCallId?: string): string | undefined {
  if (!conversationId && !toolCallId) return undefined;
  const h = createHash("md5").update(`${conversationId ?? ""}::${toolCallId ?? ""}`).digest("hex");
  return `thread_${h}`;
}

// 子 agent 委派超时：
//  - 总时长（墙钟，覆盖建连 + 整个 SSE 流消费）默认 1h，且**硬上限 1h**——调用方/env 传更大也夹到 1h。
//  - 空闲超时：连续无任何输出（无 SSE 字节）超过该时长即主动断开（每收到一段流数据就重置）。
//  二者经 env 覆盖（毫秒，正整数）：AGENTCORE_SUBAGENT_TIMEOUT_MS / AGENTCORE_SUBAGENT_IDLE_TIMEOUT_MS。
const MAX_SUBAGENT_TIMEOUT_MS = 3_600_000; // 1h 硬顶
const DEFAULT_SUBAGENT_TIMEOUT_MS = 3_600_000; // 默认总时长 = 1h
const DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS = 300_000; // 默认空闲 5min 无输出则断开

/**
 * 解析子 agent 委派的总时长 / 空闲超时（毫秒）。
 * 优先级：显式 options > env > 默认；总时长再夹到 1h 硬上限（空闲同夹，避免设成离谱值）。
 */
export function resolveSubAgentTimeouts(opts?: { timeout?: number; idleTimeout?: number }): {
  totalMs: number;
  idleMs: number;
} {
  const total = opts?.timeout ?? envPositiveInt("AGENTCORE_SUBAGENT_TIMEOUT_MS", DEFAULT_SUBAGENT_TIMEOUT_MS);
  const idle = opts?.idleTimeout ?? envPositiveInt("AGENTCORE_SUBAGENT_IDLE_TIMEOUT_MS", DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS);
  return {
    totalMs: Math.min(total, MAX_SUBAGENT_TIMEOUT_MS),
    idleMs: Math.min(idle, MAX_SUBAGENT_TIMEOUT_MS),
  };
}

/**
 * 把 resume 的子帧历史重建为 AG-UI RunAgentInput（AD-026 增补 · 向下 resume）。
 * ag-ui 子 agent 不认 runloop 的 {events} body，必须发 messages；审批决策（user.command{resolve}）
 * 既追加为一条显式 user message（只读 messages 的 agent 也能感知），又放进 forwardedProps.resume（结构化）。
 */
function buildAgUiResumeBody(resumeEvents: unknown[], opts: { threadId?: string; serverManagesHistory?: boolean }): string {
  const events = resumeEvents as RunloopEvent[];
  // 会话能力契约（AD-026 增补）：
  //  - serverManagesHistory=true：子 agent 服务端按 threadId 自管会话（含挂起的 HITL）→ 只发**增量**
  //    （最新审批决策），不重发原始任务/历史，靠一致 threadId 关联到服务端已存的会话。
  //  - false/缺省（无状态 agent）：下发**完整** messages（原始任务 + 子轨迹 + 审批决策），让其自行重建
  //    上下文——否则只发 [suspend, resolve] 这种薄片，无状态/跨实例子 agent 找不到挂起点、HITL 恢复失败（死循环根因）。
  const messages = opts.serverManagesHistory
    ? []
    : compressEvents(events).map((m, i) => ({ id: `m-${i}`, role: m.role, content: m.content }));
  const resolveCmd = events.find(
    (e) => (e as { type?: string }).type === EventType.UserCommand && (e as { command?: string }).command === "resolve",
  ) as { toolCallId?: string; targetEventId?: string; selectedOptionId?: string; payload?: unknown } | undefined;
  if (resolveCmd) {
    messages.push({
      id: "m-resume",
      role: "user",
      content: `[HITL 审批结果] 工具调用 ${resolveCmd.toolCallId ?? ""} 的用户选择：${resolveCmd.selectedOptionId ?? ""}`,
    });
  }
  return JSON.stringify({
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    messages,
    ...(resolveCmd
      ? {
          // AG-UI 现行标准：顶层 RunAgentInput.resume:[{interruptId,status,payload}]（标准 ag-ui 子 agent 读这个）。
          // interruptId = 子 interrupt 的 id（向上透传时记在 suspend.toolCallId，见 event-translator 的 RUN_FINISHED 分支），
          // 故 targetEventId/toolCallId 二选一回引同一值。
          resume: [aguiResumeEntry(resolveCmd)],
          // 兼容旧约定：保留 forwardedProps.resume，兼容现有 runloop 子 agent / 旧 bridge（零回归）。
          forwardedProps: { resume: { toolCallId: resolveCmd.toolCallId, selectedOptionId: resolveCmd.selectedOptionId, payload: resolveCmd.payload } },
        }
      : {}),
  });
}

/**
 * user.command{resolve} → AG-UI 标准 resume 条目（见 docs.ag-ui.com/concepts/interrupts）。
 *
 * AG-UI 权威语义：「拒绝（denial）」是**有效答复**、不是「放弃」——否决靠 `payload` 表达，而非单独的 status：
 * - selectedOptionId 含 **cancel**（放弃/撂挑子）⇒ status:"cancelled"，且**省略 payload**（spec：payload should be omitted）；
 * - 含 **reject/deny**（明确否决）⇒ status:"resolved"，把否决信号合并进 payload（保留已有字段，但 `approved:false` **权威**、不被 payload 里矛盾的 approved 覆盖——「拒绝必须被尊重」）；
 * - 其它（批准 / 取值 / approve_with_changes）⇒ status:"resolved"，payload 原样带。
 * reject/deny 与 cancel 分开判定（旧实现把三者都错当成 cancelled，违反 spec）；匹配大小写不敏感（/i）。
 */
function aguiResumeEntry(cmd: {
  toolCallId?: string;
  targetEventId?: string;
  selectedOptionId?: string;
  payload?: unknown;
}): { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown } {
  // interruptId 必须是**子 agent 自己发出的 interrupt id**——向上透传时记在 suspend/user.command 的
  // `toolCallId`（如 ag-ui 的 hitl_auth_r1_...）。**优先 toolCallId**，targetEventId 只兜底：
  // 嵌套 HITL 下 super_agent 重建的 user.command 会同时带 `targetEventId`（= 父 runloop 的 suspend 事件 id，
  // 一个 nanoid `e_xxx`，对子 agent 毫无意义）。旧实现 `targetEventId ?? toolCallId` 把这个父 nanoid 发给子 agent
  // → 子 agent parseTaskId 失败 → HITL_RESUME_REJECTED → 父看到委派失败 → 重新委派 → 死循环（预发实锤）。
  const interruptId = cmd.toolCallId ?? cmd.targetEventId ?? "";
  const id = cmd.selectedOptionId ?? "";
  // cancel = 放弃（撂挑子），唯一映射到 cancelled 的情况；payload 省略。
  if (/cancel/i.test(id)) {
    return { interruptId, status: "cancelled" };
  }
  // reject/deny = 明确否决，但仍是「有效答复」→ resolved，否决信号放进 payload（{approved:false}）。
  if (/reject|deny/i.test(id)) {
    const base = cmd.payload && typeof cmd.payload === "object" && !Array.isArray(cmd.payload)
      ? (cmd.payload as Record<string, unknown>)
      : {};
    // 顺序关键：先铺开 base、再写 approved:false，确保否决信号权威（base 里矛盾的 approved 不能翻盘）。
    return { interruptId, status: "resolved", payload: { ...base, approved: false } };
  }
  // 其它（批准 / 取值 / approve_with_changes）→ resolved，payload 原样透传。
  return {
    interruptId,
    status: "resolved",
    ...(cmd.payload !== undefined ? { payload: cmd.payload } : {}),
  };
}

/**
 * 调用子 agent，返回流式事件和最终文本结果。
 *
 * 子 agent 的 SSE 事件通过 event-translator 翻译为带 parentToolCallId 的 runloop 事件，
 * 经 emit 回调注入主 SSE 流，支持 N 级嵌套委派的调用树重建。
 * 同时累积文本作为 tool_call.result 的 result 字段返回给 codex。
 */
export async function callSubAgent(
  agent: Resource,
  task: string,
  credentials: Credentials,
  options?: {
    emit?: SubAgentEmit;
    conversationId?: string;
    toolCallId?: string;
    /** 总时长超时（毫秒）。默认 1h，且硬上限 1h（更大值会被夹到 1h）；env AGENTCORE_SUBAGENT_TIMEOUT_MS 可调小。 */
    timeout?: number;
    /** 空闲超时（毫秒）：连续无任何输出超过该时长则主动断开。默认 5min，env AGENTCORE_SUBAGENT_IDLE_TIMEOUT_MS 可覆盖。 */
    idleTimeout?: number;
    /** 顶层 request.headers（全局），与资源级 agent.headers 合并、签名 header 优先级最高。 */
    globalHeaders?: Record<string, string>;
    /** HITL 嵌套 resume：向 runloop 子 agent 续发完整 events[]（含 user.command{resolve}），而非新 task。 */
    resumeEvents?: unknown[];
    /**
     * 父级的客户端工具（AG-UI HITL 机制①）。转发进 ag-ui 子 agent 的 `RunAgentInput.tools[]`，
     * 子 agent 据此可走 tool-call 触发人介入（对这些工具发 TOOL_CALL → runloop 翻成 toolcall.suspend
     * 向上冒泡）。仅 ag-ui 委派使用；缺省/空 → 子 agent 回退 interrupt 协议（机制②），零行为变化。
     */
    clientTools?: ClientTool[];
    /** 资源调用日志器（记录委派的出站请求/响应内容，便于排查 404 等）。 */
    log?: ResourceCallLogger;
  },
): Promise<string> {
  const rawUrl = deriveAgentEndpoint(agent);
  const protocol = delegationProtocol(agent);

  if (!rawUrl) {
    return JSON.stringify({ error: "sub-agent has no url, cannot invoke" });
  }

  const authMode = agent.auth?.mode ?? "none";

  // SSRF 守卫（H1/R1）：所有子 agent invoke 端点都校验，不再把 auth.mode 当信任边界。
  // 非 agentrun → IP 级 assertOutboundAllowed；agentrun → 域名白名单（DNS 前判定，VPC dns-mapping 安全）。
  try {
    await assertSubAgentTargetAllowed(rawUrl, authMode);
  } catch (err) {
    if (err instanceof SsrfBlockedError) return JSON.stringify({ error: `blocked sub-agent target: ${err.message}` });
    throw err;
  }

  // A2A agent-card 发现：委派端点为 AgentCard URL（.well-known/agent-card.json）时，先抓 card 解析出真正的
  // service endpoint，再对它发 message/stream（解析出的端点二次 SSRF 校验——card 可能指向别处，防绕过）。
  let endpoint = rawUrl;
  if (protocol === "a2a" && isA2aCardUrl(rawUrl)) {
    const resolved = await resolveA2aCardEndpoint(rawUrl, agent, authMode, credentials, options?.globalHeaders);
    if (typeof resolved !== "string") return resolved.errorResult; // card 无端点 / SSRF 拦截 / 抓取失败
    endpoint = resolved;
  }

  // 按委派协议构造请求体（resume 续接走各协议的续发体；初始委派走各协议的入站体）。
  // AG-UI 委派的确定性 threadId（初始委派与 HITL resume 一致）——让「服务端自管会话」的子 agent 关联两次调用。
  const threadId = deriveThreadId(options?.conversationId, options?.toolCallId);
  const serverManagesHistory = agent.serverManagesHistory === true;

  let body: string;
  if (options?.resumeEvents) {
    body =
      protocol === "runloop"
        ? JSON.stringify({ events: options.resumeEvents, credentials }) // runloop：event-sourced 续接
        : protocol === "a2a"
        ? buildA2aResumeBody(options.resumeEvents) // a2a：message/stream 续发审批决策（带 taskId）
        : buildAgUiResumeBody(options.resumeEvents, { threadId, serverManagesHistory }); // ag-ui：重建 RunAgentInput（不发 runloop 协议）
  } else if (protocol === "a2a") {
    body = buildA2aRequestBody(task); // A2A JSON-RPC message/stream
  } else if (protocol === "chat-completions") {
    body = JSON.stringify({ model: agent.resourceName, messages: [{ role: "user", content: task }], stream: true });
  } else {
    // ag-ui RunAgentInput。转发父级 clientTools 进 tools[]（HITL 机制①）：子 agent 据此可走 tool-call
    // 触发人介入（对这些工具发 TOOL_CALL）；不转发则子 agent 回退 interrupt 协议（机制②）。
    // threadId 让「服务端自管会话」的子 agent 把后续 HITL resume 关联到本次委派会话。
    body = JSON.stringify({
      ...(threadId ? { threadId } : {}),
      messages: [{ role: "user", content: [{ type: "text", text: task }] }],
      ...(options?.clientTools?.length ? { tools: options.clientTools } : {}),
    });
  }

  // 鉴权按 auth.mode（AD-027 鉴权轴，与 openapi-caller / mcp-proxy 一致）：agentrun → RAM 签名；
  // none → 只透传 headers、不注入 AGENTRUN 签名（外部 ag-ui/chat-completions 子 agent 靠 headers 里的
  // Bearer/apikey 自鉴权，被强行签名会破坏其鉴权）。对**实际端点** endpoint 签名（可能是 card 解析出的）。
  const signed = authMode === "agentrun"
    ? buildSignedRequest("POST", endpoint, body, credentials, "application/json")
    : { url: endpoint, headers: {} as Record<string, string> };

  const controller = new AbortController();
  const { totalMs, idleMs } = resolveSubAgentTimeouts(options);
  let abortReason: "total" | "idle" | undefined;
  // 总时长：墙钟硬顶（含整个流消费），到点 abort。
  const totalTimer = setTimeout(() => {
    abortReason = "total";
    controller.abort();
  }, totalMs);
  // 空闲：连续无输出超 idleMs 即 abort；每收到一段流数据 armIdle() 重置（持续有输出的长任务不被误杀）。
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = "idle";
      controller.abort();
    }, idleMs);
  };
  armIdle(); // 建连 + 首字节也纳入空闲窗口

  // 翻译器使用的协议标识 = 委派协议（delegationProtocol 已归一为该 union）
  const translatorProtocol: "ag-ui" | "chat-completions" | "runloop" | "a2a" = protocol;

  // 记录委派出站请求（实际端点 + 协议 + 请求体）：缺协议子路径导致的 404 之类靠这条日志直接定位。
  logResourceRequest(options?.log, {
    target: "subagent",
    toolName: agent.resourceName,
    protocol,
    method: "POST",
    url: endpoint,
    body,
  });
  const startedAt = Date.now();

  try {
    const response = await fetch(rewriteToInternalEndpoint(signed.url), {
      method: "POST",
      headers: {
        // 全局 headers 铺底 → 资源级 headers 覆盖 → runloop 签名/必备 header 优先级最高、覆盖之
        ...(options?.globalHeaders ?? {}),
        ...(agent.headers ?? {}),
        ...signed.headers,
        accept: "text/event-stream",
      },
      body,
      signal: controller.signal,
      redirect: "error", // 不跟随重定向，防 302 绕过 SSRF 守卫（H1）。
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      logResourceResponse(options?.log, {
        target: "subagent",
        toolName: agent.resourceName,
        status: response.status,
        ok: false,
        durationMs: Date.now() - startedAt,
        body: errText,
      });
      return JSON.stringify({ error: `sub-agent returned ${response.status}`, detail: errText });
    }

    if (!response.body) {
      logResourceResponse(options?.log, { target: "subagent", toolName: agent.resourceName, status: response.status, ok: false, durationMs: Date.now() - startedAt, body: "(no body)" });
      return JSON.stringify({ error: "sub-agent returned no body" });
    }

    const accumulated: string[] = [];
    let childError: string | undefined;
    let suspendedEventId: string | undefined;
    let suspendedToolCallId: string | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const canEmit = options?.emit && options.conversationId && options.toolCallId;
    // 机制①：转发的 clientTools 名集合 + 跨事件累积器（START/ARGS/END → toolcall.suspend）。
    const clientToolNames = options?.clientTools?.length
      ? new Set(options.clientTools.map((t) => t.name))
      : undefined;
    const translateOpts = canEmit ? {
      conversationId: options!.conversationId!,
      parentToolCallId: options!.toolCallId!,
      ...(clientToolNames ? { clientToolNames, aguiToolCalls: new Map<string, { toolName: string; args: string }>() } : {}),
    } : null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle(); // 收到任意流数据即重置空闲计时
      buffer += decoder.decode(value, { stream: true });

      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const json = dataLine.slice(6);
        try {
          const event = JSON.parse(json);

          // 子 agent 经 SSE 内 run.error / RUN_ERROR / A2A 错误信封报错（HTTP 200 的常规报错方式）。
          // translateChildEvent 会丢弃这类事件（返回 []），若不在此捕获，委派会被当成"无输出的成功"上报给父 codex（H10）。
          if (!childError) {
            const e = extractChildError(event, translatorProtocol);
            if (e) childError = e;
          }

          // 翻译子 agent 事件并注入主流
          if (translateOpts) {
            const translated = translateChildEvent(event, translatorProtocol, translateOpts);
            for (const e of translated) {
              options!.emit!(e);
              // 累积文本用于最终 result
              if (e.type === EventType.MessageDelta && "content" in e) {
                accumulated.push((e as any).content as string);
              }
              // 子 agent 触发了 HITL（嵌套）：记下挂起，委派本轮不产 toolresult（AD-026 嵌套向上透传）。
              if (e.type === EventType.ToolcallSuspend) {
                suspendedEventId = (e as { id?: string }).id;
                suspendedToolCallId = (e as { toolCallId?: string }).toolCallId;
              }
            }
          } else {
            // 无 emit（嵌套 resume 转发 / 兼容旧调用方式）：直接提取文本。
            const text = translatorProtocol === "a2a" ? extractA2aText(event) : extractTextLegacy(event);
            if (text) accumulated.push(text);
          }
        } catch { /* skip non-JSON SSE lines */ }
      }
    }

    // 流消费完毕：记录子 agent 实际返回内容。HTTP 可能 200 但内容是错误文本（如子 agent 自身模型/下游失败、
    // 经普通 assistant 文本返回而非 RUN_ERROR）——此处把真实响应体落日志，便于区分「链路通但子 agent 内部失败」。
    const accumulatedText = accumulated.join("");
    logResourceResponse(options?.log, {
      target: "subagent",
      toolName: agent.resourceName,
      status: response.status,
      ok: !childError,
      durationMs: Date.now() - startedAt,
      body: childError
        ? `[child error] ${childError}`
        : suspendedEventId || suspendedToolCallId
        ? "[suspended]"
        : accumulatedText || "(no text output)",
    });

    // 子 agent 挂起（HITL）：返回挂起标记，委派 handler 据此不产 toolresult、触发父级 suspend 屏障。
    if (suspendedEventId || suspendedToolCallId) {
      return JSON.stringify({ __hitl_suspended: true, suspendEventId: suspendedEventId, toolCallId: suspendedToolCallId });
    }
    // 子 agent 报错：返回结构化终态错误（首键 error → tool-registry 置 isError=true），明确勿重试，
    // 避免父 codex 把失败当成功、或陷入对同一子 agent 的重试放大循环（H10）。
    if (childError) {
      return JSON.stringify({
        error: childError,
        isError: true,
        terminal: true,
        hint: "子 Agent 或其下游服务返回错误，请勿自动重试同一子 Agent；换方案或回问用户。",
        ...(accumulated.length ? { partial: accumulated.join("") } : {}),
      });
    }
    return accumulated.join("") || JSON.stringify({ result: "sub-agent completed with no text output" });
  } catch (err) {
    const timedOut = (err as Error).name === "AbortError";
    const timeoutMsg =
      abortReason === "idle"
        ? `sub-agent idle timeout: no output for ${idleMs}ms`
        : `sub-agent call timed out after ${totalMs}ms`;
    logResourceResponse(options?.log, {
      target: "subagent",
      toolName: agent.resourceName,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: timedOut ? timeoutMsg : String(err),
    });
    if (timedOut) {
      return JSON.stringify({ error: timeoutMsg });
    }
    return JSON.stringify({ error: String(err) });
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

/** 子 agent 目标端点 SSRF 校验（按 auth.mode 分流，初始端点与 card 解析端点共用）。 */
async function assertSubAgentTargetAllowed(url: string, authMode: string): Promise<void> {
  if (authMode !== "agentrun") await assertOutboundAllowed(url);
  else assertAgentrunHostAllowed(url);
}

/**
 * A2A agent-card 发现：GET card URL（按 auth.mode 鉴权）→ 解析 service endpoint。成功返回端点字符串；
 * 失败返回 `{ errorResult }`（callSubAgent 直接把 errorResult 作为结构化错误返回）。card 解析出的端点
 * 再过一次 SSRF（card 可能指向别处，防绕过）。
 */
async function resolveA2aCardEndpoint(
  cardUrl: string,
  agent: Resource,
  authMode: string,
  credentials: Credentials,
  globalHeaders?: Record<string, string>,
): Promise<string | { errorResult: string }> {
  // GET card：agentrun 签名（无 body、不传 content-type）/ none 只透传 headers。
  const signed = authMode === "agentrun"
    ? buildSignedRequest("GET", cardUrl, "", credentials)
    : { url: cardUrl, headers: {} as Record<string, string> };
  try {
    const res = await fetch(rewriteToInternalEndpoint(signed.url), {
      method: "GET",
      headers: { ...(globalHeaders ?? {}), ...(agent.headers ?? {}), ...signed.headers, accept: "application/json" },
      redirect: "error", // 不跟随重定向（防 302 绕过 SSRF）。
    });
    if (!res.ok) return { errorResult: JSON.stringify({ error: `a2a agent-card fetch returned ${res.status}` }) };
    const card = await res.json().catch(() => undefined);
    // 平台托管 a2a（auth=agentrun）忽略 card 内 localhost url，用 cardUrl 的 invocations 基址（L-052）。
    const resolved = chooseA2aServiceEndpoint(card, cardUrl, authMode);
    if (!resolved) return { errorResult: JSON.stringify({ error: "a2a agent-card has no service endpoint url" }) };
    await assertSubAgentTargetAllowed(resolved, authMode); // 二次 SSRF（card 可能指向别处）
    return resolved;
  } catch (err) {
    if (err instanceof SsrfBlockedError) return { errorResult: JSON.stringify({ error: `blocked sub-agent target: ${err.message}` }) };
    return { errorResult: JSON.stringify({ error: `a2a agent-card fetch failed: ${String(err)}` }) };
  }
}

/**
 * 从子 agent SSE 事件提取错误信息（若该事件是错误事件）。覆盖 runloop（`run.error`）、
 * ag-ui（`RUN_ERROR`）、a2a（JSON-RPC error 信封 / 失败终态）三种协议的报错形态；非错误事件返回 undefined。
 */
function extractChildError(
  event: Record<string, unknown>,
  protocol: "ag-ui" | "chat-completions" | "runloop" | "a2a",
): string | undefined {
  // a2a 的报错形态（JSON-RPC 信封 / 失败终态）与 type 无关，单独处理。
  if (protocol === "a2a") return extractA2aError(event);

  const type = event.type as string | undefined;
  if (!type) return undefined;
  // runloop: { type: "run.error", error: { code, message } }
  if (type === "run.error") {
    const err = event.error as { message?: string; code?: string } | undefined;
    return err?.message ?? err?.code ?? "sub-agent run error";
  }
  // ag-ui: { type: "RUN_ERROR", message, code? }（或嵌套 error）
  if (type === "RUN_ERROR" || type === "run_error") {
    const err = event.error as { message?: string } | string | undefined;
    return (event.message as string | undefined)
      ?? (typeof err === "string" ? err : err?.message)
      ?? "sub-agent run error";
  }
  return undefined;
}

/** 旧版文本提取（无 emit 时的 fallback，含 runloop message.delta 修复） */
function extractTextLegacy(event: Record<string, unknown>): string | undefined {
  const type = event.type as string;
  if (type === "TEXT_MESSAGE_CONTENT" || type === "text_message_content") {
    return event.delta as string | undefined;
  }
  if (type === "message.delta") {
    return event.content as string | undefined;
  }
  if (type === "message_chunk" || type === "MESSAGE_CHUNK") {
    return event.chunk as string | undefined;
  }
  const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
  if (Array.isArray(choices)) {
    return choices[0]?.delta?.content;
  }
  return undefined;
}
