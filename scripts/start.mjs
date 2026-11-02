import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);

const cli = process.env.AGENTCORE_AGENT_CLI ?? "codex";
const check = spawnSync(cli, ["--version"], { stdio: "ignore" });
if (check.status !== 0) throw new Error(`Agent CLI ${cli} is unavailable; install it before starting`);

const mock = process.argv.includes("--mock");
if (mock) {
  process.env.AGENTCORE_MOCK = "true";
  console.log("Local fixture mode: real CLI with an in-process Node.js AgentCore fixture.");
}

const built = resolve(root, "dist/src/main.js");
if (!existsSync(built)) throw new Error("Compiled server is missing; run npm run build or use npm run dev");
await import(new URL("../dist/src/main.js", import.meta.url));
