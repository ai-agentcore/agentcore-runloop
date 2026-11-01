import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { StsBrokerConfig } from "./sts-broker.js";
import { loadAgentLoopConfig, type AgentLoopConfig } from "./agentloop.js";

export interface SkillReference {
  name: string;
  version?: string;
}

export interface SandboxConfig {
  credential: string;
  apiKey?: string;
  apiUrl: string;
  domain: string;
  template: string;
  root: string;
  teamId?: string;
  volumeName?: string;
  volumeMountPath?: string;
  timeoutMs: number;
  commandTimeoutMs: number;
  requestTimeoutMs: number;
  allowInternetAccess: boolean;
}

export interface Config {
  host: string;
  port: number;
  apiToken?: string;
  workspacesDir: string;
  workdir?: string;
  artifactRoot?: string;
  execution: "tools-only" | "local" | "sandbox";
  sandbox?: SandboxConfig;
  agentCli: string;
  timeoutMs: number;
  attachmentDownloadTimeoutMs: number;
  mcpInitialWaitMs: number;
  mcpDiscoveryTimeoutMs: number;
  mcpDiscoveryTimeouts: Record<string, number>;
  systemPrompt?: string;
  modelConnection: string;
  modelName: string;
  modelEnableThinking: boolean;
  mcpServers: string[];
  skills: SkillReference[];
  skillWorkspace: string;
  stsBroker: StsBrokerConfig;
  agentLoop: AgentLoopConfig;
  mock: boolean;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseBoolean(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return defaultValue;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${key} must be true/false or 1/0`);
}

function parseUniqueNames(raw: string | undefined, key: string): string[] {
  const names = (raw ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error(`Duplicate resource name in ${key}`);
  return names;
}

export function parseSkillReferences(raw: string | undefined): SkillReference[] {
  const references: SkillReference[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const parts = value.split("@");
    if (parts.length > 2) throw new Error("AGENTCORE_SKILLS entries must be name or name@version");
    const name = parts[0]?.trim();
    const version = parts[1]?.trim();
    if (!name || (parts.length === 2 && !version)) {
      throw new Error("AGENTCORE_SKILLS entries must have non-empty names and versions");
    }
    if (references.some(reference => reference.name === name)) {
      throw new Error("Duplicate Skill name in AGENTCORE_SKILLS");
    }
    references.push(version ? { name, version } : { name });
  }
  return references;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, key: string): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, key: string): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}

function parseHttpsOrigin(raw: string | undefined, key: string): string {
  const value = optionalText(raw);
  if (!value) throw new Error(`${key} is required when AGENTCORE_EXECUTION=sandbox`);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${key} must be a valid HTTPS origin`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== "/") {
    throw new Error(`${key} must be a valid HTTPS origin`);
  }
  return parsed.origin;
}

function parseSandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig {
  const credential = optionalText(env.AGENTCORE_SANDBOX_CREDENTIAL) ?? "AGENT_SANDBOX_API_KEY";
  const apiKey = optionalText(env.AGENTCORE_SANDBOX_API_KEY);
  const domain = optionalText(env.AGENTCORE_SANDBOX_DOMAIN);
  const template = optionalText(env.AGENTCORE_SANDBOX_TEMPLATE);
  const teamId = optionalText(env.AGENTCORE_SANDBOX_TEAM_ID);
  const volumeName = optionalText(env.AGENTCORE_SANDBOX_VOLUME_NAME);
  const configuredVolumeMountPath = optionalText(env.AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH);
  if (!domain || domain.includes("://") || domain.includes("/") || domain.includes("?") || domain.includes("#")) {
    throw new Error("AGENTCORE_SANDBOX_DOMAIN must be a hostname when AGENTCORE_EXECUTION=sandbox");
  }
  if (!template) throw new Error("AGENTCORE_SANDBOX_TEMPLATE is required when AGENTCORE_EXECUTION=sandbox");
  if (teamId && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(teamId)) {
    throw new Error("AGENTCORE_SANDBOX_TEAM_ID must be a valid Team identifier");
  }
  if (Boolean(volumeName) !== Boolean(configuredVolumeMountPath)) {
    throw new Error("AGENTCORE_SANDBOX_VOLUME_NAME and AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH must be configured together");
  }
  const volumeMountPath = configuredVolumeMountPath ? resolve(configuredVolumeMountPath) : undefined;
  if (configuredVolumeMountPath && (
    !isAbsolute(configuredVolumeMountPath) || configuredVolumeMountPath === "/" || volumeMountPath !== configuredVolumeMountPath
  )) {
    throw new Error("AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH must be a normalized absolute sandbox path other than /");
  }
  const root = optionalText(env.AGENTCORE_SANDBOX_ROOT) ?? volumeMountPath ?? "/workspace";
  if (!isAbsolute(root)) throw new Error("AGENTCORE_SANDBOX_ROOT must be an absolute sandbox path");
  if (volumeMountPath && root !== volumeMountPath && !root.startsWith(`${volumeMountPath}/`)) {
    throw new Error("AGENTCORE_SANDBOX_ROOT must be the configured volume mount path or one of its descendants");
  }
  return {
    credential,
    ...(apiKey ? { apiKey } : {}),
    apiUrl: parseHttpsOrigin(env.AGENTCORE_SANDBOX_API_URL, "AGENTCORE_SANDBOX_API_URL"),
    domain,
    template,
    root: resolve(root),
    ...(teamId ? { teamId } : {}),
    ...(volumeName && volumeMountPath ? { volumeName, volumeMountPath } : {}),
    timeoutMs: parsePositiveInteger(env.AGENTCORE_SANDBOX_TIMEOUT_MS, 21_600_000, "AGENTCORE_SANDBOX_TIMEOUT_MS"),
    commandTimeoutMs: parsePositiveInteger(
      env.AGENTCORE_SANDBOX_COMMAND_TIMEOUT_MS, 3_600_000, "AGENTCORE_SANDBOX_COMMAND_TIMEOUT_MS",
    ),
    requestTimeoutMs: parsePositiveInteger(
      env.AGENTCORE_SANDBOX_REQUEST_TIMEOUT_MS, 60_000, "AGENTCORE_SANDBOX_REQUEST_TIMEOUT_MS",
    ),
    allowInternetAccess: parseBoolean(env, "AGENTCORE_SANDBOX_ALLOW_INTERNET", false),
  };
}

function parseMcpDiscoveryTimeouts(raw: string | undefined, mcpServers: readonly string[]): Record<string, number> {
  const entries: Array<[string, number]> = [];
  const resources = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const separator = value.lastIndexOf("=");
    const resource = value.slice(0, separator).trim();
    const timeout = value.slice(separator + 1).trim();
    if (separator < 1 || !timeout) {
      throw new Error("AGENTCORE_MCP_DISCOVERY_TIMEOUTS entries must be name=milliseconds");
    }
    if (!mcpServers.includes(resource)) {
      throw new Error(`Unknown MCP name in AGENTCORE_MCP_DISCOVERY_TIMEOUTS: ${resource}`);
    }
    if (resources.has(resource)) {
      throw new Error(`Duplicate MCP name in AGENTCORE_MCP_DISCOVERY_TIMEOUTS: ${resource}`);
    }
    resources.add(resource);
    entries.push([resource, parsePositiveInteger(timeout, 0, `MCP discovery timeout for ${resource}`)]);
  }
  return Object.fromEntries(entries);
}

function parseStsBroker(env: NodeJS.ProcessEnv): StsBrokerConfig {
  const keyId = optionalText(env.AGENTCORE_STS_BROKER_KEY_ID);
  const encodedSecret = optionalText(env.AGENTCORE_STS_BROKER_SECRET);
  if (Boolean(keyId) !== Boolean(encodedSecret) || (keyId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(keyId))
    || (encodedSecret !== undefined && !/^[a-fA-F0-9]{64}$/.test(encodedSecret))) {
    throw new Error("AGENTCORE_STS_BROKER_KEY_ID and AGENTCORE_STS_BROKER_SECRET must form a valid STS broker configuration");
  }
  const durationSeconds = parsePositiveInteger(env.AGENTCORE_STS_DURATION_SECONDS, 900, "AGENTCORE_STS_DURATION_SECONDS");
  if (durationSeconds < 900 || durationSeconds > 3600) throw new Error("AGENTCORE_STS_DURATION_SECONDS must be between 900 and 3600");
  return {
    ...(keyId && encodedSecret ? { keyId, secret: Buffer.from(encodedSecret, "hex") } : {}),
    durationSeconds,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mock = parseBoolean(env, "AGENTCORE_MOCK", false);
  const modelConnection = optionalText(env.AGENTCORE_MODEL_CONNECTION);
  const modelName = optionalText(env.AGENTCORE_MODEL_NAME);
  if (!mock && (!modelConnection || !modelName)) {
    throw new Error("AGENTCORE_MODEL_CONNECTION and AGENTCORE_MODEL_NAME are required");
  }

  const execution = env.AGENTCORE_EXECUTION ?? "local";
  if (execution !== "tools-only" && execution !== "local" && execution !== "sandbox") {
    throw new Error("AGENTCORE_EXECUTION must be tools-only, local or sandbox");
  }

  const sandbox = execution === "sandbox" ? parseSandboxConfig(env) : undefined;

  const artifactRoot = optionalText(env.AGENTCORE_ARTIFACT_ROOT);
  if (artifactRoot && execution === "tools-only") {
    throw new Error("AGENTCORE_ARTIFACT_ROOT requires AGENTCORE_EXECUTION=local or sandbox");
  }

  const configuredWorkdir = optionalText(env.AGENTCORE_WORKDIR);
  const workdir = configuredWorkdir ?? (execution === "local" ? join(tmpdir(), "agentcore-user-work") : undefined);
  if (workdir) {
    if (execution === "tools-only") {
      throw new Error("AGENTCORE_WORKDIR requires AGENTCORE_EXECUTION=local or sandbox");
    }
    if (!isAbsolute(workdir)) throw new Error("AGENTCORE_WORKDIR must be an absolute container path");
  }

  if (artifactRoot) {
    if (!isAbsolute(artifactRoot)) throw new Error("AGENTCORE_ARTIFACT_ROOT must be an absolute container path");
    if (workdir && resolve(artifactRoot) === resolve(workdir)) throw new Error("AGENTCORE_ARTIFACT_ROOT must differ from AGENTCORE_WORKDIR");
  }

  const port = parsePositiveInteger(env.PORT, 8080, "PORT");
  if (port > 65535) throw new Error("PORT must not exceed 65535");
  const workspacesDir = resolve(env.AGENTCORE_WORKSPACES_DIR ?? "./workspaces");
  const skillWorkspace = resolve(
    optionalText(env.AGENTCORE_SKILL_WORKSPACE_DIR) ?? join(workspacesDir, ".agentcore-skills"),
  );
  const mcpServers = parseUniqueNames(env.AGENTCORE_MCP_SERVERS, "AGENTCORE_MCP_SERVERS");

  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    apiToken: optionalText(env.AGENTCORE_RUNLOOP_API_TOKEN),
    workspacesDir,
    workdir,
    artifactRoot,
    execution,
    sandbox,
    agentCli: env.AGENTCORE_AGENT_CLI ?? "codex",
    timeoutMs: parsePositiveInteger(env.AGENTCORE_RUN_TIMEOUT_MS, 21_600_000, "AGENTCORE_RUN_TIMEOUT_MS"),
    attachmentDownloadTimeoutMs: parsePositiveInteger(
      env.AGENTCORE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      1_800_000,
      "AGENTCORE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
    ),
    mcpInitialWaitMs: parseNonNegativeInteger(env.AGENTCORE_MCP_INITIAL_WAIT_MS, 300, "AGENTCORE_MCP_INITIAL_WAIT_MS"),
    mcpDiscoveryTimeoutMs: parsePositiveInteger(
      env.AGENTCORE_MCP_DISCOVERY_TIMEOUT_MS,
      10000,
      "AGENTCORE_MCP_DISCOVERY_TIMEOUT_MS",
    ),
    mcpDiscoveryTimeouts: parseMcpDiscoveryTimeouts(env.AGENTCORE_MCP_DISCOVERY_TIMEOUTS, mcpServers),
    systemPrompt: optionalText(env.AGENTCORE_SYSTEM_PROMPT),
    modelConnection: modelConnection ?? "fixture-model",
    modelName: modelName ?? "fixture-model",
    modelEnableThinking: parseBoolean(env, "AGENTCORE_MODEL_ENABLE_THINKING", false),
    mcpServers,
    skills: parseSkillReferences(env.AGENTCORE_SKILLS),
    skillWorkspace,
    stsBroker: parseStsBroker(env),
    agentLoop: loadAgentLoopConfig(env),
    mock,
  };
}
