import type { Resource } from "../types/resources.js";
import type { NonMcpResources } from "../mcp/types.js";

export interface AgentCliConfig {
  mcpConfigPath?: string;
  mcpConfig: McpServerConfig;
  systemPromptAppend: string;
  nonMcpResources?: NonMcpResources;
}

export interface McpServerConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type: "stdio" | "http" | "sse";
}

export interface ConvertResourcesOptions {
  extractNonMcp?: boolean;
}

/**
 * 把统一的扁平 Resource[] 转换为 agent CLI 配置。**MCP 聚合模型**：codex **只连**进程内
 * 按业务处理方式分组到 nonMcpResources：
 * - `protocol === "mcp"` → `mcpServers`（下游 MCP server，聚合器代理；codex 不直连下游）
 * - 其余按溯源 resourceType → `subAgents`(AGENT) / `skills`(SKILL) / `sandboxes`(SANDBOX*) / `tools`(其余 openapi)
 *
 * 返回的 `mcpConfig` 是空容器，仅供 runner 注入聚合器条目；下游 MCP 不再直写 codex mcp.json。
 */
export function convertResources(
  resources: Resource[] | undefined,
  options?: ConvertResourcesOptions
): AgentCliConfig {
  const mcpConfig: McpServerConfig = { mcpServers: {} };
  const useMcp = !!options?.extractNonMcp;

  const nonMcp: NonMcpResources = {
    tools: [],
    skills: [],
    subAgents: [],
    sandboxes: [],
    mcpServers: [],
  };

  for (const resource of resources ?? []) {
    if (resource.protocol === "mcp") {
      nonMcp.mcpServers.push(resource);
      continue;
    }
    // protocol ≠ mcp → 按溯源 resourceType 分组做业务处理
    switch (resource.resourceType) {
      case "AGENT":
        nonMcp.subAgents.push(resource);
        break;
      case "SKILL":
        nonMcp.skills.push(resource);
        break;
      case "SANDBOX":
      case "SANDBOX_TEMPLATE":
        nonMcp.sandboxes.push(resource);
        break;
      default:
        // FUNCTIONCALL / KNOWLEDGE_BASE / MEMORY / 其它 → 通用 openapi 工具调用
        nonMcp.tools.push(resource);
        break;
    }
  }

  const hasNonMcp =
    nonMcp.tools.length > 0 ||
    nonMcp.skills.length > 0 ||
    nonMcp.subAgents.length > 0 ||
    nonMcp.sandboxes.length > 0 ||
    nonMcp.mcpServers.length > 0;

  return {
    mcpConfig,
    systemPromptAppend: "",
    nonMcpResources: useMcp && hasNonMcp ? nonMcp : undefined,
  };
}
