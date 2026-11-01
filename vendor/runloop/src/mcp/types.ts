import type { Resource, Credentials } from "../types/resources.js";
import type { RunloopEvent } from "../types/events.js";
import type { SandboxProvisioner } from "../sidecar/sandbox-provisioner.js";
import type { ExecBackend } from "../sidecar/exec-backend.js";
import type { ResourceCallLogger } from "../sidecar/resource-log.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * 所有资源都聚合在进程内 agentrun-mcp 聚合器后面（codex 只连它）。按 runloop 业务处理方式分组
 * （每项是扁平 Resource，溯源轴 resourceType 区分细分行为）：
 * - tools：FUNCTIONCALL / KNOWLEDGE_BASE / MEMORY（openapi）—— openapi 工具调用（每 operation 一个工具）
 * - skills：SKILL —— 安装期下载解包，不暴露为模型工具
 * - subAgents：AGENT —— 委派（protocol 为委派协议）
 * - sandboxes：SANDBOX / SANDBOX_TEMPLATE（openapi）—— openapi 操作 + 实例生命周期
 * - mcpServers：protocol=mcp —— 下游 MCP server，聚合器代理（toolManifest 注册工具 + 懒连下游转发）
 */
export interface NonMcpResources {
  tools: Resource[];
  skills: Resource[];
  subAgents: Resource[];
  sandboxes: Resource[];
  /** protocol=mcp 下游 MCP server（聚合代理）。消费侧一律 `?? []` 守护（容忍旧测试字面量缺省）。 */
  mcpServers: Resource[];
}

export interface ToolCallContext {
  imageTools?: import("../sidecar/image-tools.js").ImageTools;
  resources: NonMcpResources;
  credentials?: Credentials;
  emit?: (event: RunloopEvent) => void;
  conversationId?: string;
  /** 委派/工具调用的 id —— 由调用方（sidecar）透传，使生命周期事件与流式 output_delta 共享一个 id。 */
  toolCallId?: string;
  /** Enable server-owned lifecycle events for adapters that suppress duplicate CLI items. */
  emitToolLifecycle?: boolean;
  /** 透传到下游 agentrun 资源调用的全局 header（与资源级 headers 合并，资源级优先）。 */
  headers?: Record<string, string>;
  /** HITL execute-on-resume 的下游幂等键（H5）：openapi 调用带 x-idempotency-key，让支持的下游去重（exactly-once）。 */
  idempotencyKey?: string;
  /** 内置 `shell` 工具的执行工作目录（Option B：执行从 codex 内建 shell 剥离到我们的工具路径）。 */
  workdir?: string;
  /**
   * 执行/文件工具后端（系统实例 AGENTCORE_REMOTE_SHELL + 传入 Sandbox）：bash/文件工具路由到隔离沙箱数据面。
   * 未设（默认/用户实例）→ 走本地 executeShell / executeFileTool。
   */
  execBackend?: ExecBackend;
  /** HITL 挂起屏障回调——子 agent 触发 HITL（嵌套）时由委派 handler 调用，通知 runner 中断本轮。 */
  onSuspend?: () => void;
  /** 沙箱实例生命周期编排（SANDBOX_TEMPLATE 懒创建/回收）；session 级，由 sidecar 注入并在结束时 recycle。 */
  sandboxProvisioner?: SandboxProvisioner;
  /**
   * 资源调用日志器（由 sidecar / MCP server 注入其 `agentrun` Logger）：子 agent 委派 / openapi 工具 /
   * 下游 MCP 的出站请求与响应内容经此记录，便于排查（如子 agent 404）。缺省（如单测）则不记录。
   */
  log?: ResourceCallLogger;
}
