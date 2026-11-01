import type { RouteHandlers, SSEEvent } from "./routes.js";
import type { RunRequest } from "../types/api.js";
import type { LoopRunner } from "../loop/runner.js";
import { Logger, type LoggerOptions } from "../util/logger.js";
import { nanoid } from "nanoid";
import { EventType } from "../types/events.js";
import type { MetricsCollector } from "../observability/collector.js";
import { instrumentEventStream } from "../observability/events.js";

function maskSecret(value?: string): string | undefined {
  return value ? "***" : value;
}

function redactRunRequest(req: RunRequest): RunRequest {
  return {
    ...req,
    model: req.model ? {
      ...req.model,
      apiKey: maskSecret(req.model.apiKey),
    } : undefined,
    credentials: req.credentials ? {
      ...req.credentials,
      // accessKeyId/accessKeySecret 必填、恒为密钥 → 直接掩码（无 maskSecret 的 undefined 死分支）
      accessKeyId: "***",
      accessKeySecret: "***",
      securityToken: maskSecret(req.credentials.securityToken),
    } : undefined,
  };
}

export function createHandlers(
  loopRunner: LoopRunner,
  baseLoggerOptions: LoggerOptions,
  metricsCollector?: MetricsCollector,
): RouteHandlers {
  return {
    health: async () => ({
      status: "ok" as const,
      version: "0.1.0",
      activeRuns: loopRunner.getRunManager().getActiveRuns(),
    }),

    async *run(req, ctx) {
      const agentCli = req.agent?.cli ?? "codex";
      try {
        loopRunner.resolveCliCommand(agentCli);
      } catch (err) {
        throw new RouteError(400, `Invalid agent CLI: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 同一 conversationId 不允许并发 run（L-029）：已有 running run 则 409 拒绝，避免旧 run 失控。
      if (req.conversationId && loopRunner.getRunManager().hasRunning(req.conversationId)) {
        throw new RouteError(409, `Conversation "${req.conversationId}" already has a running run`);
      }

      const conversationId = loopRunner.prepareRun(req.conversationId);
      const runId = req.runId ?? nanoid();
      // traceId 解析优先级（AD-022）：x-trace-id → x-request-id → x-fc-request-id（FC 平台每请求注入）→ conversationId
      const traceId =
        ctx.header("x-trace-id") ??
        ctx.header("x-request-id") ??
        ctx.header("x-fc-request-id") ??
        conversationId;
      ctx.setHeader("X-Trace-Id", traceId);
      const httpLog = new Logger("http", { ...baseLoggerOptions, traceId });
      httpLog.request({
        method: "POST",
        path: "/v1/run",
        conversationId,
        runId,
        uid: req.credentials?.accountId,
        agentCli,
        eventCount: req.events.length,
        eventTypes: req.events.map((e) => e.type),
        model: req.model ? {
          provider: req.model.provider,
          model: req.model.model,
          baseUrl: req.model.baseUrl,
          modelAuthConfigured: Boolean(req.model.apiKey),
        } : undefined,
        hasCredentials: Boolean(req.credentials),
        hasSystemPrompt: Boolean(req.agent?.systemPrompt),
        body: redactRunRequest(req),
      });
      ctx.setHeader("X-Conversation-Id", conversationId);
      ctx.setHeader("X-Run-Id", runId);

      const started = Date.now();
      let eventCount = 0;
      let firstTokenSeen = false;
      // 事件流派生指标：每个 run 一个 observer（闭包维护 run/tool 起始时刻），
      // 在唯一出站漏斗上观测，绝不影响事件流本身（observer 内部已 try/catch）。
      const observeEvent = metricsCollector ? instrumentEventStream(metricsCollector) : undefined;
      for await (const event of loopRunner.run(req, conversationId, runId, traceId)) {
        eventCount++;
        observeEvent?.(event);
        // 首 token 耗时（TTFT）：首个 message.delta 即模型吐给用户的第一个 token。
        if (!firstTokenSeen && (event as SSEEvent).type === EventType.MessageDelta) {
          firstTokenSeen = true;
          httpLog.first_token({ conversationId, runId, ttftMs: Date.now() - started });
        }
        yield event as SSEEvent;
      }
      httpLog.run_complete({
        conversationId,
        runId,
        eventCount,
        durationMs: Date.now() - started,
      });
    },

    interrupt: async (req) => {
      const success = loopRunner.interrupt(req.conversationId, req.reason);
      return { success };
    },

    initialize: async () => {
      const result = await loopRunner.initialize();
      return { status: "ok" as const, ...result };
    },

    listRuns: async (ctx) => {
      const statusFilter = ctx.query("status");
      const runs = loopRunner
        .getRunManager()
        .listRuns()
        .filter((s) => !statusFilter || s.status === statusFilter)
        .map((s) => ({
          conversationId: s.conversationId,
          status: s.status,
          eventCount: s.events.length,
        }));
      return { runs };
    },
  };
}

export class RouteError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
