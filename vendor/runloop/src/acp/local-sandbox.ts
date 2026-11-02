import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

/** Server-generated policy. No full-disk read grant and no shared /tmp grant. */
export async function localSandboxConfig(
  policy: { userRoot: string; readRoots: string[] }, cwd: string, cli: string,
): Promise<string[]> {
  const userRoot = await realpath(policy.userRoot);
  const workingDirectory = await realpath(cwd);
  const rel = relative(userRoot, workingDirectory);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Local sandbox cwd escapes user root");
  }
  const searchPaths = (process.env.PATH ?? "").split(delimiter);
  const candidates = cli.includes("/") ? [cli] : searchPaths.map(path => join(path, cli));
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
      break;
    } catch { /* Try the next PATH entry. */ }
  }
  if (!executable) throw new Error("Local sandbox CLI unavailable");
  // The npm wrapper launches the platform binary in a sibling package.
  let runtimeRoot = dirname(executable);
  for (let path = runtimeRoot; dirname(path) !== path; path = dirname(path)) {
    if (path.endsWith(`${sep}node_modules`)) {
      runtimeRoot = path;
      break;
    }
  }
  const temp = join(workingDirectory, ".agentcore-tmp");
  await mkdir(temp, { recursive: true });
  if ((await lstat(temp)).isSymbolicLink()) throw new Error("Local sandbox temp directory must not be a symlink");
  const resolvedReadRoots = await Promise.all(policy.readRoots.map(path => realpath(path)));
  const readRoots = [...new Set([runtimeRoot, ...policy.readRoots, ...resolvedReadRoots])];
  const q = JSON.stringify;
  return [
    "", "[permissions.agentcore_local.filesystem]", '\":minimal\" = "read"',
    ...readRoots.map(path => `${q(path)} = "read"`),
    `${q(userRoot)} = "write"`,
    "", "[permissions.agentcore_local.network]", "enabled = false",
    "", "[shell_environment_policy]", 'inherit = "none"',
    "", "[shell_environment_policy.set]",
    `PATH = ${q(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}`,
    `HOME = ${q(temp)}`, `TMPDIR = ${q(temp)}`, 'LANG = "C.UTF-8"',
  ];
}

/** Pin complete tables at CLI precedence, so workspace config cannot widen them. */
export function localSandboxOverrides(lines: string[]): string[] {
  const tables: Record<string, string[]> = {};
  let section = "";
  for (const line of lines) {
    if (line.startsWith("[")) {
      section = line.slice(1, -1);
      tables[section] = [];
    } else if (line.trim()) {
      tables[section]?.push(line);
    }
  }
  const inline = (key: string) => `{ ${tables[key].join(", ")} }`;
  return [
    'default_permissions="agentcore_local"', 'approval_policy="never"',
    `permissions={ agentcore_local={ filesystem=${inline("permissions.agentcore_local.filesystem")}, network=${inline("permissions.agentcore_local.network")} } }`,
    `shell_environment_policy={ inherit="none", set=${inline("shell_environment_policy.set")} }`,
    'features.shell_tool=true', 'features.use_legacy_landlock=false', 'web_search="disabled"',
  ];
}

/** Probe with the same user, environment and policy before starting inference. */
export async function verifyLocalSandbox(
  cli: string, cwd: string, overrides: string[],
  env: NodeJS.ProcessEnv, identity: { uid?: number; gid?: number },
): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile(cli, ["sandbox", "-P", "agentcore_local", "-C", cwd,
      ...overrides.flatMap(value => ["-c", value]), "--", "/bin/true"],
    { cwd, env, ...identity, timeout: 15000, maxBuffer: 64 * 1024 }, error => {
      if (error) reject(new Error("LOCAL_SANDBOX_UNAVAILABLE: Codex OS sandbox preflight failed; unrestricted execution is disabled", { cause: error }));
      else resolve();
    });
  });
}
