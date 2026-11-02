/**
 * 多协议 test-agent 能力测试 harness。
 *
 * 把仓库内的 `multi-protocol-agent.cjs`（零依赖、单进程多协议 mock agent：A2A / AG-UI / OpenAI-chat，
 * 含 HITL 链路）spawn 成子进程，再用 runloop 自己的 `callSubAgent` 按各协议委派过去，收集 runloop
 * **翻译后**的事件 + 返回值，断言「runloop 对该协议/该 HITL 形态的消费是否正确」。
 *
 * 这是「agent 能力测试」：被测对象是 **runloop 的多协议 + HITL 消费链路**，test-agent 只是对端。
 * 当前已知红：AG-UI interrupt 协议（RUN_FINISHED.outcome）未被 runloop 接住（G1）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callSubAgent } from "@/sidecar/sub-agent-caller.js";
import { EventType } from "@/types/events.js";
import type { RunloopEvent } from "@/types/events.js";
import type { Resource } from "@/types/resources.js";

const AGENT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "multi-protocol-agent.cjs");

export const CREDS = { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou", accountId: "123" };

/** 取一个空闲端口（listen 0 → 读端口 → 关闭）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface AgentHandle {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

/** spawn test-agent 子进程并等待 /health 就绪。 */
export async function startAgent(): Promise<AgentHandle> {
  const port = await freePort();
  const proc = spawn(process.execPath, [AGENT_SCRIPT], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 8000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`test-agent 未在 ${port} 就绪；stderr=${stderr}`);
    }
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) break;
    } catch { /* 尚未起来，重试 */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    port,
    baseUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode != null) return resolve();
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } resolve(); }, 1000);
      }),
  };
}

/**
 * 构建扁平 AGENT Resource：委派端点 = serverUrl + invoke operation path（AD-027）；协议 = protocol。
 * auth.mode=agentrun + 测试关掉 agentrun 域名白名单（见 capability.test 的 beforeAll）即可连 127.0.0.1。
 */
export function agentResource(
  baseUrl: string,
  protocol: "a2a" | "ag-ui" | "chat-completions" | "runloop",
  path: string,
): Resource {
  return {
    resourceId: "r1",
    resourceName: "test-agent",
    resourceType: "AGENT",
    protocol,
    openapiConfig: {
      openapi: "3.0.0",
      servers: [{ url: baseUrl }],
      paths: { [path]: { post: { operationId: "invoke" } } },
    },
    auth: { mode: "none" },
  } as Resource;
}

export interface DelegateResult {
  events: RunloopEvent[];
  ret: string;
  /** 子 agent 触发了 HITL 挂起（runloop 产出了 toolcall.suspend / 返回 __hitl_suspended）。 */
  suspended: boolean;
  /** 委派失败（结构化终态错误）。 */
  error?: string;
  /** 累积的 message.delta 文本。 */
  text: string;
}

/**
 * 用 callSubAgent 委派到 test-agent，收集 runloop 翻译后的事件 + 返回值。
 * 传 resumeEvents（含 user.command{resolve}）则走向下 resume（HITL 恢复），task 置空。
 */
export async function delegate(
  agent: Resource,
  task: string,
  resumeEvents?: unknown[],
  extra?: { clientTools?: { name: string; description?: string; parameters?: Record<string, unknown> }[] },
): Promise<DelegateResult> {
  const events: RunloopEvent[] = [];
  const ret = await callSubAgent(agent, task, CREDS, {
    emit: (e) => events.push(e),
    conversationId: "c-test",
    toolCallId: "d-1",
    ...(resumeEvents ? { resumeEvents } : {}),
    ...(extra?.clientTools ? { clientTools: extra.clientTools } : {}),
  });
  let parsed: { __hitl_suspended?: boolean; isError?: boolean; error?: string } | null = null;
  try { parsed = JSON.parse(ret); } catch { parsed = null; }
  const suspended = Boolean(parsed?.__hitl_suspended) || events.some((e) => e.type === EventType.ToolcallSuspend);
  const error = parsed?.isError ? String(parsed.error) : undefined;
  const text = events
    .filter((e) => e.type === EventType.MessageDelta)
    .map((e) => (e as { content?: string }).content ?? "")
    .join("");
  return { events, ret, suspended, error, text };
}
