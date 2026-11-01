/**
 * F3 纯 HITL LLM 映射（AD-026 增补 · 触发 ⊥ 呈现 两层模型）。
 *
 * decideHitlSurface（surface.ts）判定 needsLlm 时，用本服务把一个已产出的 suspend 映射到「最适合渲染它的
 * 客户端工具」。关键约束（仿 src/hitl/judge.ts / src/hitl/phrasing.ts）：模型调用是 **out-of-band** 的——
 * 独立 fetch、**只含 HITL 相关提示词**、不复用驱动 codex 的主模型上下文、不污染 transcript；
 * 失败/无合适工具回落静态映射（StaticHitlSurfaceMapper），不阻塞 suspend。能确定的不调 LLM。
 */
import type { HitlInteractionKind } from "./surface.js";

export interface HitlSurfaceMapInput {
  /** suspend 的提问文本（展示给用户）。 */
  prompt: string;
  /** 交互形态：confirm / input / choice。 */
  kind: HitlInteractionKind;
  /** 多选/确认的候选项标签（可选，仅作 LLM 上下文）。 */
  options?: string[];
  /** 可选客户端工具列表（name + description），供选择。 */
  clientTools?: Array<{ name: string; description?: string }>;
}

export interface HitlSurfaceMapOutput {
  /** 选中的客户端工具名；空 = 无合适工具、回落 NL。 */
  toolName?: string;
}

export interface HitlSurfaceMapper {
  map(input: HitlSurfaceMapInput): Promise<HitlSurfaceMapOutput>;
}

/**
 * 静态兜底映射：按 kind + 工具名/描述做简单确定性匹配（无模型调用）。
 *  - confirm → 名字/描述含 confirm 的工具；
 *  - choice → 含 choice/choices/select 的工具；
 *  - input → 无静态规则 → 空（回落 NL）。
 */
export class StaticHitlSurfaceMapper implements HitlSurfaceMapper {
  async map(input: HitlSurfaceMapInput): Promise<HitlSurfaceMapOutput> {
    return StaticHitlSurfaceMapper.build(input);
  }

  static build(input: HitlSurfaceMapInput): HitlSurfaceMapOutput {
    const tools = input.clientTools ?? [];
    if (tools.length === 0) return {};
    const pick = (keywords: string[]): string | undefined => {
      const hit = tools.find((t) => {
        const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
        return keywords.some((k) => hay.includes(k));
      });
      return hit?.name;
    };
    if (input.kind === "confirm") {
      const name = pick(["confirm"]);
      return name ? { toolName: name } : {};
    }
    if (input.kind === "choice") {
      const name = pick(["choice", "choices", "select"]);
      return name ? { toolName: name } : {};
    }
    // input：无静态匹配规则 → 回落 NL。
    return {};
  }
}

export interface HitlSurfaceMapperConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

const SURFACE_MAP_SYSTEM_PROMPT = `你是一个 HITL 渲染映射助手。给定一个需要呈现给用户的人机交互（确认 / 取值 / 多选）和一组客户端工具（name + description），请从这些工具里**选出最适合用来渲染该交互的一个**。

只输出一个 JSON 对象，不要任何额外文字或代码围栏，形如：
{"toolName": "<选中的工具名>"}

要求：toolName 必须是给定工具列表中的某个 name；若没有任何工具适合渲染该交互，输出 {"toolName": ""}（表示回落自然语言）。`;

/** 从模型文本中提取首个 JSON 对象（容忍代码围栏 / 前后缀文字）。 */
function extractJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no json object");
  return JSON.parse(content.slice(start, end + 1));
}

/** out-of-band 模型调用版（仿 OpenAIHitlPhrasing）；任何失败回落静态映射。 */
export class OpenAIHitlSurfaceMapper implements HitlSurfaceMapper {
  constructor(private readonly config: HitlSurfaceMapperConfig) {}

  async map(input: HitlSurfaceMapInput): Promise<HitlSurfaceMapOutput> {
    const tools = input.clientTools ?? [];
    // 无可选工具 → 直接回落 NL，不浪费一次模型调用。
    if (tools.length === 0) return {};

    try {
      const userContent = [
        `交互形态：${input.kind}`,
        `提问文本：${input.prompt}`,
        ...(input.options && input.options.length > 0 ? [`候选项：${JSON.stringify(input.options)}`] : []),
        `客户端工具：${JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description ?? "" })))}`,
      ].join("\n");

      const response = await fetch(`${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: SURFACE_MAP_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          temperature: 0,
          max_tokens: 200,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
      if (!response.ok) return StaticHitlSurfaceMapper.build(input);

      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      const parsed = extractJson(content) as { toolName?: unknown };
      const toolName = typeof parsed.toolName === "string" ? parsed.toolName.trim() : "";

      // 模型明确给空 → 回落 NL（它判定无合适工具）。
      if (!toolName) return {};
      // 模型给的名字必须在工具列表内（防臆造）；不在 → 回落静态映射兜底。
      if (tools.some((t) => t.name === toolName)) return { toolName };
      return StaticHitlSurfaceMapper.build(input);
    } catch {
      return StaticHitlSurfaceMapper.build(input);
    }
  }
}
