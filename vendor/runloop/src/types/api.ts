// 此文件由 scripts/generate-server.ts 从 spec/openapi.json 自动生成，请勿手动编辑。
import { z } from "zod";
import {
  ModelConfigSchema,
  FeaturesSchema,
  CredentialsSchema,
  AgentConfigSchema,
  HitlConfigSchema,
  ClientToolSchema,
  ResourceSchema,
} from "./resources.js";
import { InputEventSchema } from "./events.js";

/** RunRequest */
export const RunRequestSchema = z.object({
  conversationId: z.string().describe("Conversation ID — stable across multiple runs in the same conversation. Decides the workspace directory. Auto-generated if omitted.").optional(),
  runId: z.string().describe("Run ID — unique identifier for this specific /v1/run invocation. Auto-generated if omitted. Used for tracing and logging.").optional(),
  events: z.array(InputEventSchema),
  model: ModelConfigSchema.optional(),
  agent: AgentConfigSchema.optional(),
  resources: z.array(ResourceSchema).optional(),
  clientTools: z.array(ClientToolSchema).optional(),
  credentials: CredentialsSchema.optional(),
  headers: z.record(z.string(), z.string()).describe("Extra HTTP headers forwarded to downstream agentrun resource calls (global default; merged with per-resource headers, resource-level wins). Runloop's own signing/required headers always win.").optional(),
  hitl: HitlConfigSchema.optional(),
  features: FeaturesSchema.optional(),
});
export type RunRequest = z.infer<typeof RunRequestSchema> & {
  /** Trusted server-only policy; deliberately absent from the public request schema. */
  localSandbox?: { userRoot: string; readRoots: string[] };
};

/** Client HITL capability declaration (AD-026 F1/F3). runloop uses it to (F1) only let the model trigger the listed interaction kinds, and to pick the surface per suspend: native event / map to client tool / NL. Safety main-track confirm + NL floor are not gated by F1. */
export const HitlClientCapabilitiesSchema = z.object({
  interactions: z.array(z.enum(["confirm","input","choice"])).describe("F1: interaction kinds the client supports and the model is allowed to trigger. Kinds not listed are not exposed to the model (except safety main-track confirm and the NL floor).").optional(),
  nativeHitl: z.boolean().describe("Client can consume native toolcall.suspend events directly; when true, listed interaction kinds are delivered as native events.").default(false).optional(),
  renderTools: z.record(z.string(), z.string()).describe("Optional explicit interaction-kind -> client tool name map for deterministic rendering, e.g. {\"choice\":\"super_agent_choices\"}. When an interaction has no explicit mapping and nativeHitl is false, runloop maps it to a suitable client tool (or NL) via a dedicated pure-HITL LLM call (F3).").optional(),
});
export type HitlClientCapabilities = z.infer<typeof HitlClientCapabilitiesSchema>;

/** InterruptRequest */
export const InterruptRequestSchema = z.object({
  conversationId: z.string(),
  reason: z.string().optional(),
});
export type InterruptRequest = z.infer<typeof InterruptRequestSchema>;

/** HealthResponse */
export const HealthResponseSchema = z.object({
  status: z.enum(["ok","degraded","error"]).optional(),
  version: z.string().optional(),
  activeRuns: z.number().int().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** RunInfo */
export const RunInfoSchema = z.object({
  conversationId: z.string().optional(),
  status: z.enum(["idle","running","interrupted","completed","error"]).optional(),
  eventCount: z.number().int().optional(),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

/** ErrorResponse */
export const ErrorResponseSchema = z.object({
  error: z.string().optional(),
  details: z.array(z.record(z.string(), z.any())).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** InitializeResponse */
export const InitializeResponseSchema = z.object({
  status: z.literal("ok"),
  elapsedMs: z.number().int().describe("Time taken to pre-warm in milliseconds"),
});
export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;
