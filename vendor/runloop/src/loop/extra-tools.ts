import type { McpToolDescriptor } from "../mcp/types.js";
import { REQUEST_USER_INPUT_DESCRIPTOR } from "../sidecar/server.js";
import { SHELL_TOOL_DESCRIPTOR } from "../sidecar/shell-exec.js";
import { FILE_TOOL_DESCRIPTORS } from "../sidecar/file-tools.js";
import { SKILL_TOOL_DESCRIPTORS } from "../sidecar/skill-tools.js";
import { IMAGE_TOOL_DESCRIPTORS } from "../sidecar/image-tools.js";

/** buildExtraTools 的门控输入（均由 runner 解析的部署形态 / 资源派生）。 */
export interface ExtraToolsGate {
  /** HITL 已启用（辅轨 ask 原语 request_user_input）。 */
  hitlEnabled: boolean;
  /** 是否注入内置执行/文件工具（bash/read_file/...）。系统实例=仅当有 Sandbox；用户实例=execViaMcp。 */
  execToolsEnabled: boolean;
  /** 是否存在 SKILL 资源（skill 读取工具 get_skill，任何模式可用、与执行能力无关）。 */
  hasSkills: boolean;
  imageToolsEnabled?: boolean;
}

/**
 * - 辅轨 HITL ask 原语 `request_user_input` —— 仅 hitlEnabled。
 * - 内置执行/文件工具 `bash`/`read_file`/... —— 仅 execToolsEnabled（**无 shell / 零执行态下整组不注入**）。
 * - skill 读取工具 `get_skill` —— 仅 `hasSkills && !execToolsEnabled`：**只在无 shell（零执行态）注入**，
 *   作为读 skill 正文的唯一通道；有 shell 时 skill 已落盘/同步进沙箱，模型用 read_file/bash 读标准 skill 目录，
 *   不透出 get_skill（避免冗余的本地副本读法、与执行层读法分叉）。
 *
 * 抽成纯函数以便直接断言「无 shell 注入 get_skill、有 shell 不注入；执行工具反之」这类门控不变量
 * （runner.ts 内联拼装难以观测 MCP tool list）。
 */
export function buildExtraTools(gate: ExtraToolsGate): McpToolDescriptor[] {
  return [
    ...(gate.imageToolsEnabled && gate.execToolsEnabled ? IMAGE_TOOL_DESCRIPTORS : []),
    ...(gate.hitlEnabled ? [REQUEST_USER_INPUT_DESCRIPTOR] : []),
    ...(gate.execToolsEnabled ? [SHELL_TOOL_DESCRIPTOR, ...FILE_TOOL_DESCRIPTORS] : []),
    ...(gate.hasSkills && !gate.execToolsEnabled ? SKILL_TOOL_DESCRIPTORS : []),
  ];
}
