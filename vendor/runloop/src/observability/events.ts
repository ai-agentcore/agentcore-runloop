// 事件流派生指标：在出站 RunloopEvent 流上做闭包式埋点（每个 run 一个 observer）。
//
// 这是唯一的事件埋点漏斗——handlers.run 的 for-await 循环对每个事件调用本 observer，
// 既能覆盖 adapter 流也能覆盖 sidecar/MCP 注入流（两者都在该循环里汇合）。
//
// 关键约束：可观测性绝不能影响主链路。所有逻辑包在 try/catch 内，任何异常被吞掉。

import type { RunloopEvent } from "../types/events.js";
import { EventType } from "../types/events.js";
import type { MetricsCollector } from "./collector.js";
import {
  classifyToolType,
  normalizeErrorCode,
  normalizeModel,
  runStatusFromReason,
  toolStatus,
} from "./labels.js";

type EventObserver = (event: RunloopEvent) => void;

/**
 * 返回一个 per-run 的事件观察器。必须每个 run（每次 handlers.run 调用）新建一个，
 * 不要跨并发 run 共享——内部用闭包维护 run 起始时刻、per-tool 起始时刻等状态。
 */
export function instrumentEventStream(collector: MetricsCollector): EventObserver {
  let runStartMs = 0;
  let agentCli = "unknown";
  let runErrorType = "none";
  const toolStarts = new Map<string, { startMs: number; toolType: string }>();

  return (event: RunloopEvent) => {
    try {
      collector.observeEvent(event.type);

      switch (event.type) {
        case EventType.RunStart: {
          const e = event as { timestamp: number; agentCli?: string };
          runStartMs = e.timestamp;
          agentCli = e.agentCli || "unknown";
          runErrorType = "none";
          collector.incActiveRuns();
          break;
        }
        case EventType.RunError: {
          const e = event as { error?: { code?: string } };
          runErrorType = normalizeErrorCode(e.error?.code);
          break;
        }
        case EventType.ToolcallStart: {
          const e = event as { timestamp: number; toolCallId: string; toolName: string };
          toolStarts.set(e.toolCallId, {
            startMs: e.timestamp,
            toolType: classifyToolType(e.toolName),
          });
          break;
        }
        case EventType.ToolresultEnd: {
          const e = event as { timestamp: number; toolCallId: string; isError?: boolean };
          const start = toolStarts.get(e.toolCallId);
          collector.observeToolCall({
            toolType: start?.toolType ?? "unknown",
            status: toolStatus(e.isError),
            errorType: e.isError ? "tool_error" : "none",
            durationSeconds: start ? Math.max(0, (e.timestamp - start.startMs) / 1000) : undefined,
          });
          if (start) toolStarts.delete(e.toolCallId);
          break;
        }
        case EventType.TurnEnd: {
          collector.observeTurn();
          break;
        }
        case EventType.RunUsage: {
          // agentCli 由前置的 RunStart 事件填入闭包，此处复用做维度标签。
          const e = event as {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
            costUsd?: number;
            model?: string;
          };
          collector.observeUsage({
            agentCli,
            model: normalizeModel(e.model),
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            cacheReadTokens: e.cacheReadTokens,
            cacheWriteTokens: e.cacheWriteTokens,
            costUsd: e.costUsd,
          });
          break;
        }
        case EventType.RunEnd: {
          const e = event as { timestamp: number; reason?: string };
          collector.observeRun({
            agentCli,
            status: runStatusFromReason(e.reason),
            errorType: runErrorType,
            durationSeconds: runStartMs > 0 ? Math.max(0, (e.timestamp - runStartMs) / 1000) : undefined,
          });
          collector.decActiveRuns();
          break;
        }
        default:
          break;
      }
    } catch {
      // 指标采集失败绝不影响事件流，静默忽略。
    }
  };
}
