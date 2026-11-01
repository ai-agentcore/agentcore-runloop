import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
function isDataRoot(value: string): boolean {
  if (!isAbsolute(value)) return false;
  const root = resolve(value);
  const reserved = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/dev", "/sys", "/System", "/Library"];
  return root !== sep && !reserved.some(path => root === path || root.startsWith(`${path}/`));
}
const schema = z.object({
  AGENTCORE_HOST: z.string().default("127.0.0.1"),
  AGENTCORE_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  AGENTCORE_RUNLOOP_API_TOKEN: z.string().min(32),
  AGENTCORE_WORKDIR: z.string().refine(isDataRoot),
  AGENTCORE_SANDBOX_UID: id,
  AGENTCORE_SANDBOX_SESSION_ID: id,
  AGENTCORE_SANDBOX_CLI: z.string().default("codex"),
});
export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error("INVALID_SANDBOX_CONFIGURATION");
  const c = result.data;
  return { host: c.AGENTCORE_HOST, port: c.AGENTCORE_PORT,
    token: c.AGENTCORE_RUNLOOP_API_TOKEN, root: c.AGENTCORE_WORKDIR,
    uid: c.AGENTCORE_SANDBOX_UID, sessionId: c.AGENTCORE_SANDBOX_SESSION_ID,
    cli: c.AGENTCORE_SANDBOX_CLI };
}
export type SandboxConfig = ReturnType<typeof loadSandboxConfig>;
