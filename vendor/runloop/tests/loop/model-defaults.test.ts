import { describe, it, expect } from "vitest";
import { isStagingEnv, applyModelEnvDefaults } from "@/loop/model-defaults.js";
import type { ModelConfig } from "@/types/resources.js";

const FULL: ModelConfig = { provider: "openai-compatible", model: "qwen", baseUrl: "https://up", apiKey: "real-key" };
const STAGING = {
  AGENTCORE_ENV: "pre",
  AGENTCORE_DEFAULT_MODEL_PROVIDER: "env-provider",
  AGENTCORE_DEFAULT_MODEL_NAME: "env-model",
  AGENTCORE_DEFAULT_MODEL_BASE_URL: "https://env-base",
  AGENTCORE_DEFAULT_MODEL_API_KEY: "env-key",
} as unknown as NodeJS.ProcessEnv;

describe("model-defaults", () => {
  it("isStagingEnv: 仅 pre/staging（大小写/空白容错）启用", () => {
    expect(isStagingEnv({ AGENTCORE_ENV: "pre" } as never)).toBe(true);
    expect(isStagingEnv({ AGENTCORE_ENV: " Staging " } as never)).toBe(true);
    expect(isStagingEnv({ AGENTCORE_ENV: "production" } as never)).toBe(false);
    expect(isStagingEnv({} as never)).toBe(false);
  });

  it("非预发环境 → 原样返回，绝不注入默认", () => {
    const env = { ...STAGING, AGENTCORE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(applyModelEnvDefaults(undefined, env)).toBeUndefined();
    expect(applyModelEnvDefaults({ provider: "p", model: "m" } as ModelConfig, env)).toEqual({ provider: "p", model: "m" });
  });

  it("预发 + 客户端缺 baseUrl/apiKey → 用 env 补，provider/model 保留客户端值", () => {
    const r = applyModelEnvDefaults({ provider: "openai-compatible", model: "qwen" } as ModelConfig, STAGING);
    expect(r).toEqual({ provider: "openai-compatible", model: "qwen", baseUrl: "https://env-base", apiKey: "env-key" });
  });

  it("预发 + 客户端已传的字段优先、不被 env 覆盖", () => {
    const r = applyModelEnvDefaults(FULL, STAGING);
    expect(r).toEqual(FULL);
  });

  it("预发 + 客户端完全不传 model → 全部用 env 默认", () => {
    const r = applyModelEnvDefaults(undefined, STAGING);
    expect(r).toEqual({ provider: "env-provider", model: "env-model", baseUrl: "https://env-base", apiKey: "env-key" });
  });

  it("预发但既没传 model 又没配任何默认 env → 返回原值（交下游校验）", () => {
    expect(applyModelEnvDefaults(undefined, { AGENTCORE_ENV: "pre" } as never)).toBeUndefined();
  });

  it("预发 + 只配了 baseUrl/apiKey 默认（无 provider/model 默认）→ 仅补这两项", () => {
    const env = { AGENTCORE_ENV: "staging", AGENTCORE_DEFAULT_MODEL_BASE_URL: "https://b", AGENTCORE_DEFAULT_MODEL_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
    const r = applyModelEnvDefaults({ provider: "p", model: "m" } as ModelConfig, env);
    expect(r).toEqual({ provider: "p", model: "m", baseUrl: "https://b", apiKey: "k" });
  });

  it("预发 + 无 model + env 仅配 baseUrl/apiKey → provider 兜底 openai-compatible（L6）", () => {
    const env = { AGENTCORE_ENV: "pre", AGENTCORE_DEFAULT_MODEL_BASE_URL: "https://b", AGENTCORE_DEFAULT_MODEL_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
    const r = applyModelEnvDefaults(undefined, env);
    expect(r?.provider).toBe("openai-compatible"); // 不再产出 provider:undefined
    expect(r?.baseUrl).toBe("https://b");
    expect(r?.apiKey).toBe("k");
  });
});
