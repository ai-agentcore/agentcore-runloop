// 预发环境的 model 凭证默认值回退（方便测试时客户端不传 baseUrl/apiKey）。
//
// 线上 RunRequest 必须带 model.baseUrl/apiKey（agent CLI 不直连上游，见 runner 校验）。但预发联调时
// 让每个测试客户端都填一遍模型凭证很烦。此处提供：**仅预发环境**（AGENTCORE_ENV ∈ {pre, staging}）下，
// 为 model 中**客户端未提供**的字段用环境变量补默认值。线上（AGENTCORE_ENV 未设/其它值）**绝不**注入，
// 避免把默认凭证带到生产。
//
// 相关 env：
//   AGENTCORE_ENV=pre|staging                门控开关（仅这两个值启用回退）
//   AGENTCORE_DEFAULT_MODEL_PROVIDER         provider 默认（一般客户端已传，schema 必填）
//   AGENTCORE_DEFAULT_MODEL_NAME             model 名默认
//   AGENTCORE_DEFAULT_MODEL_BASE_URL         baseUrl 默认（主要诉求）
//   AGENTCORE_DEFAULT_MODEL_API_KEY          apiKey 默认（主要诉求）

import type { ModelConfig } from "../types/resources.js";

/** 是否预发环境（仅 AGENTCORE_ENV ∈ {pre, staging} 启用 model 默认值回退）。 */
export function isStagingEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AGENTCORE_ENV ?? "").trim().toLowerCase();
  return v === "pre" || v === "staging";
}

/**
 * 预发环境下，用环境变量为**缺失**的 model 字段补默认值（客户端已传的字段一律保留、优先）。
 * 非预发环境原样返回（绝不注入默认凭证）。若客户端与 env 都没有任何模型信息，返回原值（交下游校验报错）。
 */
export function applyModelEnvDefaults(
  model: ModelConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ModelConfig | undefined {
  if (!isStagingEnv(env)) return model;

  const provider = model?.provider ?? env.AGENTCORE_DEFAULT_MODEL_PROVIDER;
  const name = model?.model ?? env.AGENTCORE_DEFAULT_MODEL_NAME;
  const baseUrl = model?.baseUrl ?? env.AGENTCORE_DEFAULT_MODEL_BASE_URL;
  const apiKey = model?.apiKey ?? env.AGENTCORE_DEFAULT_MODEL_API_KEY;

  // 既没传 model 又没配任何默认 → 保持原样，交给下游原有校验报错。
  if (provider === undefined && name === undefined && baseUrl === undefined && apiKey === undefined) {
    return model;
  }

  const result: Partial<ModelConfig> = { ...model };
  if (provider !== undefined) result.provider = provider;
  if (name !== undefined) result.model = name;
  if (baseUrl !== undefined) result.baseUrl = baseUrl;
  if (apiKey !== undefined) result.apiKey = apiKey;
  // 预发兜底（L6）：env 只配了 baseUrl/apiKey、没配 provider（客户端也没传）时补一个最小默认 provider，
  // 避免下游 ModelProviderProxy 拿到 provider:undefined 报难懂错误。
  if (result.provider === undefined && (result.baseUrl !== undefined || result.apiKey !== undefined)) {
    result.provider = "openai-compatible";
  }
  return result as ModelConfig;
}
