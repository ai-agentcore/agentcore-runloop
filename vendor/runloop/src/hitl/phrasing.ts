/**
 * HITL NL 降级措辞服务（AD-026 增补）。
 *
 * 当上游为纯文本通道（无 clientTools）时，HITL 需要降级成自然语言提问 + 一组**显式触发词**
 * （肯定/否定，i18n、可多个），由 resume 时的纯代码匹配器（src/hitl/match.ts）做确定性判定。
 *
 * 关键约束：本服务的模型调用是 **out-of-band** 的（同 LlmJudge，独立 fetch、不进 codex 对话轨），
 * 产出只写进 suspend 事件 payload（持久化、replay 安全），绝不污染喂给 agent CLI 的 transcript。
 * 辅轨（request_confirmation）模型本就在环、可直接给词，无需调用本服务；主轨用 OpenAIHitlPhrasing，
 * 失败回落 StaticHitlPhrasing（静态模板 + 默认词表），不阻塞 suspend。
 */

export interface HitlPhrasingInput {
  toolName: string;
  args?: Record<string, unknown>;
  reason: "static_rule" | "model_request" | "llm_judge";
  /** 期望提问语言（i18n hint），默认 zh-CN */
  locale?: string;
}

export interface HitlPhrasingOutput {
  /** NL 降级的提问文本（i18n） */
  prompt: string;
  /** 肯定触发词（归一化后做完全相等匹配） */
  affirmativeWords: string[];
  /** 否定触发词 */
  negativeWords: string[];
}

export interface HitlPhrasing {
  phrase(input: HitlPhrasingInput): Promise<HitlPhrasingOutput>;
}

const ZH_AFFIRMATIVE = ["是", "是的", "对", "对的", "好", "好的", "可以", "行", "执行", "继续", "同意", "确认", "批准", "允许"];
const ZH_NEGATIVE = ["否", "不", "不行", "不要", "拒绝", "取消", "停止", "别", "算了"];
const EN_AFFIRMATIVE = ["yes", "y", "ok", "okay", "approve", "confirm", "allow", "go", "proceed"];
const EN_NEGATIVE = ["no", "n", "deny", "reject", "cancel", "stop", "abort"];

function isEnglish(locale?: string): boolean {
  return !!locale && locale.toLowerCase().startsWith("en");
}

/** 静态模板兜底：无需模型调用，纯模板 + 默认词表。 */
export class StaticHitlPhrasing implements HitlPhrasing {
  async phrase(input: HitlPhrasingInput): Promise<HitlPhrasingOutput> {
    return StaticHitlPhrasing.build(input);
  }

  static build(input: HitlPhrasingInput): HitlPhrasingOutput {
    if (isEnglish(input.locale)) {
      return {
        prompt: `Confirmation needed: allow running tool "${input.toolName}"? Reply "yes/ok" to approve, "no/cancel" to reject.`,
        affirmativeWords: [...EN_AFFIRMATIVE],
        negativeWords: [...EN_NEGATIVE],
      };
    }
    return {
      prompt: `需要你的确认：是否允许执行工具「${input.toolName}」？回复"是/可以/好的"批准，"否/不要/取消"拒绝。`,
      affirmativeWords: [...ZH_AFFIRMATIVE],
      negativeWords: [...ZH_NEGATIVE],
    };
  }
}

export interface HitlPhrasingConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

const PHRASING_SYSTEM_PROMPT = `你是一个 HITL 审批措辞助手。给定一个待用户确认的工具调用，请用与上下文一致的语言，生成一段简短、清晰的确认提问，并给出一组**显式的**肯定词和否定词（用于把用户的自然语言回复确定性地匹配为"同意/拒绝"）。

只输出一个 JSON 对象，不要任何额外文字或代码围栏，形如：
{"prompt": "<提问文本，需包含工具名>", "affirmativeWords": ["是","可以","好的"], "negativeWords": ["否","不要","取消"]}

要求：肯定词/否定词都应是用户可能用来明确表态的**单个短词**（便于完全相等匹配），各给 5~12 个，覆盖常见说法。`;

/** 从模型文本中提取首个 JSON 对象（容忍代码围栏 / 前后缀文字）。 */
function extractJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no json object");
  return JSON.parse(content.slice(start, end + 1));
}

/** out-of-band 模型调用版（仿 OpenAILlmJudge）；任何失败回落静态模板。 */
export class OpenAIHitlPhrasing implements HitlPhrasing {
  constructor(private readonly config: HitlPhrasingConfig) {}

  async phrase(input: HitlPhrasingInput): Promise<HitlPhrasingOutput> {
    const fallback = StaticHitlPhrasing.build(input);
    try {
      const response = await fetch(
        `${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              { role: "system", content: PHRASING_SYSTEM_PROMPT },
              { role: "user", content: `Tool: ${input.toolName}\nArguments: ${JSON.stringify(input.args ?? {})}\nLocale: ${input.locale ?? "zh-CN"}` },
            ],
            temperature: 0,
            max_tokens: 400,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        },
      );
      if (!response.ok) return fallback;

      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      const parsed = extractJson(content) as Partial<HitlPhrasingOutput>;

      const prompt = typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt.trim() : fallback.prompt;
      const modelAff = Array.isArray(parsed.affirmativeWords)
        ? parsed.affirmativeWords.filter((w): w is string => typeof w === "string")
        : [];
      const modelNeg = Array.isArray(parsed.negativeWords)
        ? parsed.negativeWords.filter((w): w is string => typeof w === "string")
        : [];
      // 模型词 + 静态默认词**并集**（去重）：保证常见确认/拒绝词恒命中（不被模型遗漏），
      // 模型再补上下文相关说法。空数组也安全（退化为纯默认词）。
      const affirmativeWords = [...new Set([...modelAff, ...fallback.affirmativeWords])];
      const negativeWords = [...new Set([...modelNeg, ...fallback.negativeWords])];

      return { prompt, affirmativeWords, negativeWords };
    } catch {
      return fallback;
    }
  }
}
