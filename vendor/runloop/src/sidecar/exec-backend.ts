import type { McpToolResult } from "../mcp/types.js";

/** bash / 文件工具的执行后端。返回 null 表示「非本后端负责的工具名」，调用方继续走其它分发。 */
export interface ExecBackend {
  shell(command: string): Promise<McpToolResult>;
  file(name: string, args: Record<string, unknown>): Promise<McpToolResult | null>;
  /** Best-effort interruption of the currently running remote command. */
  interrupt?(): Promise<void>;
}
