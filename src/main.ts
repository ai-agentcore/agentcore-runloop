import { serve } from "@hono/node-server";
import { loadSandboxConfig } from "./sandbox-service/config.js";
import { NativeExecutor } from "./sandbox-service/executor.js";
import { createSandboxApp } from "./sandbox-service/app.js";

const config = loadSandboxConfig();
const executor = new NativeExecutor(config);
const app = createSandboxApp(config.token, executor);
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
console.log(JSON.stringify({ service: "agentcore-sandbox", port: config.port }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  server.close();
  await executor.close();
  clearTimeout(deadline);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
