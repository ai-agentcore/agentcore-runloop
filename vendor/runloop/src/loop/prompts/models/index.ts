import type { PromptTemplate } from "../loader.js";
import { renderTemplate } from "../loader.js";
import { MODEL_BASE_PROMPT } from "./base.js";

/**
 * 各模型族在通用规约之上追加的差异化提示，按 model 名前缀匹配（大小写不敏感）。
 * 新增一个模型 = 在此加一条 [前缀, 补充文本]。空补充 → 仅用通用 base。
 */
const QWEN_ADDENDUM = `## 针对当前模型的补充
- 任务需要平台能力或文件/命令操作时，必须真的调用对应工具，禁止用文字「假装」已完成、或用 shell 模拟工具结果。
- 一次聚焦一个工具调用，拿到结果再决定下一步（当前不并行工具调用）。
- 默认用中文回复用户。`;

const MODEL_ADDENDA: Array<[string, string]> = [["qwen", QWEN_ADDENDUM]];

const DEFAULT_FAMILY = "default";

interface ModelMatch {
  family: string;
  addendum: string;
}

function matchModel(modelName?: string): ModelMatch {
  const lower = modelName?.toLowerCase() ?? "";
  for (const [prefix, addendum] of MODEL_ADDENDA) {
    if (lower === prefix || lower.startsWith(prefix)) {
      return { family: prefix, addendum };
    }
  }
  return { family: DEFAULT_FAMILY, addendum: "" };
}

/** 按模型名选模型操作规约：通用 base + 该模型族的补充（无补充则仅 base）。 */
export function selectModelPrompt(modelName?: string): PromptTemplate {
  const { family, addendum } = matchModel(modelName);
  const template = addendum ? `${MODEL_BASE_PROMPT}\n\n${addendum}` : MODEL_BASE_PROMPT;
  return {
    name: `model/${family}`,
    description: `模型操作规约（${family}）`,
    template,
  };
}

/** 渲染模型操作规约（当前无模板变量，保持与其它 prompt 渲染一致的入口）。 */
export function renderModelPrompt(template: PromptTemplate): string {
  return renderTemplate(template.template);
}

/** 已知模型族的提示词清单（供 registry 注册 / 测试）。 */
export const modelPrompts: PromptTemplate[] = [
  selectModelPrompt(undefined),
  ...MODEL_ADDENDA.map(([prefix]) => selectModelPrompt(prefix)),
];

export { MODEL_BASE_PROMPT } from "./base.js";
