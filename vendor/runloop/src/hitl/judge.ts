import type { HitlDecision } from "./rules.js";

export interface LlmJudgeConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface LlmJudgeInput {
  toolName: string;
  args: Record<string, unknown>;
  context?: string;
}

export interface LlmJudge {
  evaluate(input: LlmJudgeInput): Promise<HitlDecision>;
}

export class OpenAILlmJudge implements LlmJudge {
  constructor(private readonly config: LlmJudgeConfig) {}

  async evaluate(input: LlmJudgeInput): Promise<HitlDecision> {
    const prompt = this.buildPrompt(input);

    try {
      const response = await fetch(
        `${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.apiKey
              ? { Authorization: `Bearer ${this.config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              {
                role: "system",
                content: JUDGE_SYSTEM_PROMPT,
              },
              { role: "user", content: prompt },
            ],
            max_tokens: 100,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        }
      );

      if (!response.ok) {
        return { action: "ask", reason: `LLM judge API error: ${response.status}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";

      return this.parseResponse(content);
    } catch (err) {
      return {
        action: "ask",
        reason: `LLM judge failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private buildPrompt(input: LlmJudgeInput): string {
    const parts = [
      `Tool: ${input.toolName}`,
      `Arguments: ${JSON.stringify(input.args)}`,
    ];
    if (input.context) {
      parts.push(`Context: ${input.context}`);
    }
    return parts.join("\n");
  }

  private parseResponse(content: string): HitlDecision {
    const lower = content.toLowerCase();

    if (lower.includes("allow") || lower.includes("pass")) {
      return { action: "allow", reason: content };
    }
    if (lower.includes("block") || lower.includes("deny")) {
      return { action: "block", reason: content };
    }
    return { action: "ask", reason: content };
  }
}

const JUDGE_SYSTEM_PROMPT = `You are a security judge evaluating whether a tool call should be allowed, blocked, or escalated to a human.

Evaluate the tool call and respond with exactly one of:
- ALLOW: The tool call is safe and expected
- BLOCK: The tool call is dangerous or clearly malicious
- ASK: The tool call needs human review

Respond with the decision word followed by a brief reason.`;

export class StaticLlmJudge implements LlmJudge {
  constructor(private readonly defaultAction: "allow" | "block" | "ask" = "ask") {}

  async evaluate(_input: LlmJudgeInput): Promise<HitlDecision> {
    return { action: this.defaultAction, reason: "static judge" };
  }
}
