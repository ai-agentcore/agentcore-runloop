import type { RunRequest } from '../types/api.js';
import { convertResources } from '../resources/converter.js';
import { superAgentPrompt } from './prompts/index.js';
import { renderTemplate } from './prompts/loader.js';
import { selectModelPrompt, renderModelPrompt } from './prompts/models/index.js';
import { buildResourcePrompt, type ResourceMode } from './prompts/resources/index.js';
import { renderToolList } from './prompts/resources/render.js';
import { sanitizeToolName, CLIENT_TOOL_PREFIX } from '../mcp/tool-registry.js';
import type { McpToolDescriptor } from '../mcp/types.js';

export type { ResourceMode } from './prompts/resources/index.js';

function joinMarkdown(lines: string[]) {
  return lines.join('\n\n');
}

/**
 * 客户端工具（HITL / 用户交互）引导段——**仅当请求带 clientTools 时注入**。
 * 客户端工具各自带 description，但模型（尤其 qwen）不一定据此主动调用、常默认走纯文本提问
 * （线上实测：缺城市的天气问题，模型用纯文本问而非调 client tool）。这里给一条**系统级总则**——
 * 需要与用户交互时优先调对应客户端工具，把「该不该用工具问用户」从各工具自述的窄触发条件提升为
 * 原则（具体选哪个仍以各工具 description 为准）。
 */
function buildClientToolsPrompt(clientTools: RunRequest['clientTools'], mode: ResourceMode): string {
  if (!clientTools || clientTools.length === 0) return '';
  // 与「平台工具」一致：每个工具 `### client__<name>` + 描述 + 参数 + 示例（复用 renderToolList）。
  // 描述对模型「是否调用该工具」权重很高，故必须带上（不能只列名字）。
  const descriptors: McpToolDescriptor[] = clientTools.map((ct) => ({
    name: `${CLIENT_TOOL_PREFIX}${sanitizeToolName(ct.name)}`,
    description: ct.description ?? `客户端工具「${ct.name}」：调用即暂停本轮、把请求交给用户处理。`,
    inputSchema: (ct.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
  }));
  return joinMarkdown([
    '## 与用户交互（客户端工具 / HITL）',
    '调用下面任一**客户端工具**会**暂停当前轮次**、把请求交给用户处理，用户回复后再继续；具体何时调用以各工具下方的描述为准。',
    renderToolList(descriptors, mode),
  ]);
}

/**
 * 客户端工具「强制引导」段——**置于系统提示词顶部（高优先级）**。本地实测（qwen3.7-max + 忠实工具集）：
 * 不加此段或放末尾，模型仅 ~60-88% 会调客户端工具、其余走纯文本；此段放顶部 → 8/8 稳定调用。
 * 客户端工具的 description 由客户端控制、runloop 改不了（且常自述偏窄），故唯一杠杆是系统提示词：
 * 在顶部用硬规则点名实际工具名 + 覆盖下文「或自然语言向用户询问」的竞争说法 + 一个具体例子。
 * 名字动态来自 request.clientTools（client__<sanitize(声明名)>），完整参数在文末渲染段。
 */
function buildClientToolSteering(clientTools: RunRequest['clientTools']): string {
  if (!clientTools || clientTools.length === 0) return '';
  const names = clientTools
    .map((ct) => `\`${CLIENT_TOOL_PREFIX}${sanitizeToolName(ct.name)}\``)
    .join('、');
  return joinMarkdown([
    // h1：本段 unshift 到系统提示词最顶部，而 base(`# 身份与核心约束`)/resource(`# 可用的 AgentRun 工具`)
    // 都是 h1。用 h2 会让「h2 先于 h1」标题层级倒挂（评审 P2-3）；改 h1 与其它顶层段同级、也贴合「最高优先级」语义。
    '# 与用户交互（强制 · 最高优先级，覆盖下文任何「可用自然语言向用户询问」的说法）',
    `当你需要向用户**提问、索取缺失的必要信息（如用户未指定的城市/时间/对象）、澄清歧义、或让用户在选项中选择**时，**必须调用下面这些客户端工具之一**（${names}，按各工具描述选最贴合的，完整参数见文末「与用户交互（客户端工具 / HITL）」段），**禁止用纯文本向用户提问**。例：用户问「今天天气如何」但没说城市 → 调用其中能向用户展示候选项的工具，question=「想查哪个城市？」、choices=[北京,上海,杭州]。`,
  ]);
}

/**
 * HITL ask 原语（request_user_input）引导段——**仅当 hitl.enabled 时注入**（与客户端工具 steering 同级）。
 * ask 原语的工具描述虽自带说明，但模型对「该不该停下来问用户、以及用哪种回复形态」的判断仍需明确引导，
 * 否则常默认走纯文本提问或擅自替用户决定。这里给出何时调用 + 三种 responseSchema 形态（仅确认 / 多选 / 取值）
 * 的简明规则。
 *
 * F1 声明才产生（AD-026 增补）：当 `hitl.clientCapabilities.interactions` 存在时，**只描述已声明的交互形态**
 * （声明 choice/input 才讲对应 responseSchema 形态）。但**二元确认（是非）始终保留**——它是安全主轨 + NL 地板
 * 永远可用的形态，不被 F1 掐掉（「别在 steering 里禁掉确认」）。interactions 未声明 → 讲全部三种（向后兼容）。
 */
function buildAskPrimitivePrompt(request: RunRequest): string {
  if (!request.hitl?.enabled) return '';
  const interactions = request.hitl?.clientCapabilities?.interactions;
  // 未声明 interactions → 三种形态全讲（向后兼容）；声明了 → confirm 始终在 + 按声明放开 choice/input。
  const showChoice = !interactions || interactions.includes('choice');
  const showInput = !interactions || interactions.includes('input');

  // 顶部意图描述按可用形态裁剪用语（只确认 / 含选择 / 含取值）。
  const actions = ['用户确认某操作'];
  if (showChoice) actions.push('在若干选项中做选择');
  if (showInput) actions.push('提供一个缺失的值');

  const lines = [
    '## 与用户交互（确认 / 提问 · request_user_input）',
    `当你需要**${actions.join('、')}**时，调用内置工具 \`request_user_input\`（调用后本轮会暂停、等用户回复再继续），不要用纯文本提问、也不要擅自替用户决定。\`prompt\` 为展示给用户的提问文本；按需要的回复形态传 \`responseSchema\`：`,
    // 二元确认：安全主轨 + NL 地板，始终保留（不受 F1 裁剪）。
    '- **只需用户确认（是/否）** → 不带 `responseSchema`。例：`request_user_input {"prompt":"确认删除该表吗？"}`',
  ];
  if (showChoice) {
    lines.push('- **要用户在选项中选一个** → 带 `responseSchema: {"enum":[...]}`。例：`request_user_input {"prompt":"选择发布策略","responseSchema":{"enum":["回滚","热修","灰度"]}}`');
  }
  if (showInput) {
    lines.push('- **要用户填写一个值** → 带 `responseSchema: {"type":"string"}`（或更具体的对象 schema）。例：`request_user_input {"prompt":"请输入收件人邮箱","responseSchema":{"type":"string"}}`');
  }
  return joinMarkdown(lines);
}

function withIndent(text: string, indent: string = '    '): string {
  return text
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
}

/** 从 RunRequest 解析资源暴露方式（features.toolBridge，缺省 mcp）。runner 据此 gate MCP server / CLI 脚本。 */
export function resolveResourceMode(request: RunRequest): ResourceMode {
  return (request.features?.toolBridge as string) === 'cli' ? 'cli' : 'mcp';
}

/**
 * 系统提示词主生成函数（写 AGENTS.md）。**入参为完整 RunRequest**，逐段编排：
 * 身份/环境硬约束 → 用户自定义 prompt → AgentRun 资源提示（按 features.toolBridge 选 mcp/cli 模板，
 * 每种资源类型由 prompts/resources/<type> 各自的生成函数渲染）。
 */
export function buildSystemPrompt(request: RunRequest, opts?: { execToolsEnabled?: boolean }): string {
  const parts = [renderTemplate(superAgentPrompt.template)];

  // 客户端工具存在时：强制引导段置于**最顶部**（高优先级，先于身份/资源/用户 prompt），
  // 覆盖下文「或自然语言向用户询问」的竞争说法。本地实测放顶部 8/8 触发，放末尾/不放仅 ~60-88%。
  const steering = buildClientToolSteering(request.clientTools);
  if (steering) parts.unshift(steering);

  const userPrompt = request.agent?.systemPrompt?.trim();
  if (userPrompt) {
    parts.push(joinMarkdown(['## 用户自定义提示', withIndent(userPrompt)]));
  }

  const mode = resolveResourceMode(request);
  const nonMcp = request.resources
    ? convertResources(request.resources, { extractNonMcp: true }).nonMcpResources
    : undefined;
  // execToolsEnabled 决定 skill 读取措辞：有 shell → read_file/bash 读 .agents/skills/；无 shell → get_skill（唯一通道）。
  // resourcePrompt 自带顶层标题 `# 可用的 AgentRun 工具`，**不再外包 `## AgentRun 资源提示`**——
  // 否则 h1（# 可用的…）嵌在 h2（## AgentRun 资源提示）下、标题层级倒挂。
  const resourcePrompt = nonMcp ? buildResourcePrompt(nonMcp, mode, opts?.execToolsEnabled ?? false) : '';
  if (resourcePrompt) {
    parts.push(resourcePrompt);
  }

  // 客户端工具（消费通道 2）存在时，注入 HITL/用户交互引导（否则模型常默认纯文本提问、不调工具）。
  const clientToolsPrompt = buildClientToolsPrompt(request.clientTools, mode);
  if (clientToolsPrompt) {
    parts.push(clientToolsPrompt);
  }

  // HITL 启用时：注入 ask 原语 request_user_input 引导（何时调 + 三种 responseSchema 形态）。
  const askPrompt = buildAskPrimitivePrompt(request);
  if (askPrompt) {
    parts.push(askPrompt);
  }

  return joinMarkdown(parts);
}

/**
 * 模型提示词主生成函数（作为下游 CLI 的 model-instructions / base_instructions 注入）。
 * **入参为完整 RunRequest**，按 model 名选模型操作规约（通用 base + 模型族补充，见 prompts/models/）。
 * 不再注入任何 agent CLI（如 codex）的私有身份/工具规约——身份与工具用法分别由 buildSystemPrompt
 * 与各工具 description 提供。当前仅 codex 适配器经 prepareModelInstructions 接入。
 */
export function buildModelPrompt(request: RunRequest): string {
  return renderModelPrompt(selectModelPrompt(request.model?.model));
}
