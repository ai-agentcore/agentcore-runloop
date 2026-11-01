import { buildToolIndex } from "../../../mcp/tool-registry.js";
import type { NonMcpResources, McpToolDescriptor } from "../../../mcp/types.js";

/** 资源暴露方式（与 features.toolBridge 对应）：mcp=原生工具直接调用；cli=.tools/agentrun shell 隧道。 */
export type ResourceMode = "mcp" | "cli";

/**
 * 只取某一类资源的工具描述符。**对全量资源构建索引再按类别过滤**（而非只喂该类资源）——
 * 这样跨类别消歧（碰撞时加资源名前缀）后的最终名与 `handleToolCall` 路由名、模型 tool list 完全一致。
 */
export function descriptorsFor(nonMcp: NonMcpResources, key: keyof NonMcpResources): McpToolDescriptor[] {
  return buildToolIndex(nonMcp)
    .filter((t) => t.category === key)
    .map((t) => t.descriptor);
}

/**
 * 渲染一组工具为 markdown：每个工具 `### name` + 描述 + 参数 + **一个调用示例**（按 mode）。
 * - mcp：`直接调用工具 \`name\`，参数示例：{...}`
 * - cli：`.tools/agentrun call name '{...}'`
 */
/**
 * 按 schema 类型生成示例占位——只有 spec、没有真实样例时，占位也得**类型正确**：
 * array→`[]`、object→`{}`、boolean→`false`、number/integer→`0`，其余（含 string）→`<key>`。
 * 否则像 `choices`（array）被填成字符串 `"<choices>"`，与声明的 spec 类型不符、误导模型。
 */
function examplePlaceholder(type: string | undefined, key: string): unknown {
  switch (type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return `<${key}>`;
  }
}

export function renderToolList(descriptors: McpToolDescriptor[], mode: ResourceMode): string {
  const lines: string[] = [];
  for (const tool of descriptors) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);

    const props = (tool.inputSchema as { properties?: Record<string, unknown> })?.properties;
    if (props && Object.keys(props).length > 0) {
      const required = new Set((tool.inputSchema as { required?: string[] })?.required ?? []);
      lines.push("");
      lines.push("参数：");
      for (const [key, val] of Object.entries(props)) {
        const req = required.has(key) ? "（必填）" : "（可选）";
        lines.push(`- \`${key}\` ${req}: ${(val as { description?: string }).description ?? ""}`);
      }
    }

    const exampleArgs: Record<string, unknown> = {};
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        exampleArgs[key] = examplePlaceholder((val as { type?: string })?.type, key);
      }
    }
    lines.push("");
    lines.push("示例：");
    if (mode === "cli") {
      lines.push("```bash");
      lines.push(`.tools/agentrun call ${tool.name} '${JSON.stringify(exampleArgs)}'`);
      lines.push("```");
    } else {
      lines.push(`直接调用工具 \`${tool.name}\`，参数示例：\`${JSON.stringify(exampleArgs)}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}
