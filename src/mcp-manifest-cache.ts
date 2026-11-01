import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 1024 * 1024;

export interface CachedMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CachedMcpResource {
  updatedAt: string;
  tools: CachedMcpTool[];
}

export type McpManifestCatalog = Record<string, CachedMcpResource>;

export function mcpManifestCacheFile(workspacesDir: string): string {
  return join(workspacesDir, ".agentcore-mcp-tools-v1.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTool(value: unknown): CachedMcpTool | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name || value.name.length > 256) return undefined;
  if (typeof value.description !== "string" || !isRecord(value.inputSchema)) return undefined;
  return { name: value.name, description: value.description, inputSchema: value.inputSchema };
}

export async function loadMcpManifestCatalog(
  workspacesDir: string,
  configuredResources: readonly string[],
): Promise<McpManifestCatalog> {
  const file = mcpManifestCacheFile(workspacesDir);
  const info = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return {};
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) throw new Error("Invalid MCP manifest cache file");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.resources)) {
    throw new Error("Invalid MCP manifest cache format");
  }
  const configured = new Set(configuredResources);
  const catalog: McpManifestCatalog = {};
  for (const [resource, value] of Object.entries(parsed.resources)) {
    if (!configured.has(resource) || !isRecord(value) || typeof value.updatedAt !== "string" || !Array.isArray(value.tools)) continue;
    const tools = value.tools.map(parseTool);
    if (tools.some(tool => !tool)) continue;
    catalog[resource] = { updatedAt: value.updatedAt, tools: tools as CachedMcpTool[] };
  }
  return catalog;
}

export async function saveMcpManifestCatalog(workspacesDir: string, catalog: McpManifestCatalog): Promise<void> {
  await mkdir(workspacesDir, { recursive: true });
  const file = mcpManifestCacheFile(workspacesDir);
  const temporary = join(dirname(file), `.mcp-tools-${randomUUID()}.tmp`);
  const body = JSON.stringify({ version: CACHE_VERSION, resources: catalog });
  if (Buffer.byteLength(body) > MAX_CACHE_BYTES) throw new Error("MCP manifest cache exceeds size limit");
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
