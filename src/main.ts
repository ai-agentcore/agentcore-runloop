import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createAgentLoopTelemetry } from "./agentloop.js";

const config = loadConfig();
const agentLoop = createAgentLoopTelemetry(config.agentLoop);
const { app, runner, runtime, active, stsBroker, sandboxManager, initialize } = createApp(config, { agentLoop });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  const startup = {
    service: "agentcore-runloop",
    runtime: "node",
    port: info.port,
    execution: config.execution,
    executionRoot: config.execution === "sandbox" ? config.sandbox?.root : config.workdir ?? "per-session",
    agentWorkdir: config.workdir ?? "not-configured",
    workspacesDir: config.workspacesDir,
    agentLoop: agentLoop.state,
  };
  console.log(JSON.stringify(startup));
  console.log(JSON.stringify({
    service: "agentcore-runloop",
    state: "ready",
    resources: "warming",
  }));
  void initialize().catch(() => {});
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const id of active) runner.interrupt(id, "shutdown");
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  await runtime.close().catch(() => {});
  await agentLoop.shutdown().catch(() => {});
  stsBroker?.close();
  sandboxManager?.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
