import "dotenv/config";
import { parseArgs } from "node:util";
import { RunloopClient, EventType, type RunRequest, type RunloopEvent, type InputEvent } from "../client/index.js";

const { values, positionals } = parseArgs({
  options: {
    url: { type: "string", short: "u", default: "http://localhost:3000" },
    agent: { type: "string", short: "a", default: "qodercli" },
    model: { type: "string", short: "m" },
    cwd: { type: "string" },
    interrupt: { type: "string", short: "i" },
    sessions: { type: "boolean", short: "l", default: false },
    health: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    raw: { type: "boolean", short: "r", default: false },
    debug: { type: "boolean", short: "d", default: false },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const baseUrl = values.url as string;
let debug = values.debug as boolean;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

if (values.health) {
  await fetchHealth();
} else if (values.sessions) {
  await fetchSessions();
} else if (values.interrupt) {
  await interruptSession(values.interrupt as string);
} else if (positionals.length > 0) {
  await runPrompt(positionals.join(" "));
} else {
  await interactiveMode();
}

function printHelp() {
  console.log(`runloop CLI — test helper for runloop server

Usage:
  pnpm cli [options] [prompt]

Options:
  -u, --url <url>       Server URL (default: http://localhost:3000)
  -a, --agent <name>    Agent CLI to use (default: qodercli)
  -m, --model <model>   Model name
  --cwd <dir>           Working directory for agent
  -i, --interrupt <id>  Interrupt a session
  -l, --sessions        List active sessions
  --health              Check server health
  -r, --raw             Show raw JSON events
  -d, --debug           Show request/response details (URL, headers, body)
  -h, --help            Show help

Interactive commands:
  /sessions             List active sessions
  /health               Health check
  /interrupt <id>       Interrupt a session
  /debug                Toggle debug mode
  quit / exit           Exit

Examples:
  pnpm cli "hello world"
  pnpm cli --debug "hello world"
  pnpm cli --agent qodercli --debug "list files"
  pnpm cli --sessions
  pnpm cli --interrupt <session-id>
`);
}

function debugLog(label: string, content: string) {
  if (!debug) return;
  console.log(`${C.gray}[debug] ${label}${C.reset}`);
  for (const line of content.split("\n")) {
    console.log(`${C.gray}  ${line}${C.reset}`);
  }
}

function debugRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string
) {
  if (!debug) return;
  console.log(`\n${C.gray}${"─".repeat(60)}${C.reset}`);
  debugLog(`${C.bold}REQUEST${C.reset}`, `${method} ${url}`);
  debugLog(
    "Headers",
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")
  );
  if (body) {
    try {
      debugLog("Body", JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      debugLog("Body", body);
    }
  }
  console.log(`${C.gray}${"─".repeat(60)}${C.reset}\n`);
}

function debugResponse(
  status: number,
  headers: Headers,
  bodyPreview?: string
) {
  if (!debug) return;
  console.log(`${C.gray}${"─".repeat(60)}${C.reset}`);
  debugLog(`${C.bold}RESPONSE${C.reset}`, `HTTP ${status}`);
  const headerEntries: string[] = [];
  headers.forEach((v, k) => headerEntries.push(`${k}: ${v}`));
  debugLog("Headers", headerEntries.join("\n"));
  if (bodyPreview) {
    debugLog("Body (preview)", bodyPreview.slice(0, 500));
  }
  console.log(`${C.gray}${"─".repeat(60)}${C.reset}\n`);
}

async function debugFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const method = init?.method ?? "GET";
  const headers = (init?.headers as Record<string, string>) ?? {};
  const body = init?.body as string | undefined;

  debugRequest(method, url, headers, body);

  const res = await fetch(url, init);

  debugResponse(res.status, res.headers);

  return res;
}

async function fetchHealth() {
  const res = await debugFetch(`${baseUrl}/health`);
  const data = await res.json();
  console.log("Health:", JSON.stringify(data, null, 2));
}

async function fetchSessions() {
  const res = await debugFetch(`${baseUrl}/v1/runs`);
  const data = await res.json();
  console.log("Sessions:", JSON.stringify(data, null, 2));
}

async function interruptSession(conversationId: string) {
  const body = JSON.stringify({ conversationId });
  const res = await debugFetch(`${baseUrl}/v1/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await res.json();
  console.log("Interrupt result:", JSON.stringify(data, null, 2));
}

async function runPrompt(prompt: string) {
  const modelConfig = {
    provider: process.env.MODEL_PROVIDER ?? "openai-compatible",
    model: (values.model as string | undefined) ?? process.env.MODEL_NAME ?? "qwen3.7-max",
    baseUrl: process.env.BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY,
  };
  const credentials = {
    accessKeyId: process.env.ACCESS_KEY_ID ?? "cli-test-ak",
    accessKeySecret: process.env.ACCESS_KEY_SECRET ?? "cli-test-sk",
  };

  const req: RunRequest = {
    agent: { cli: (values.agent as string) ?? "codex", cwd: values.cwd as string | undefined },
    events: [
      {
        type: EventType.UserMessage,
        content: prompt,
      },
    ],
    model: modelConfig,
    credentials,
  };

  const body = JSON.stringify(req);

  const res = await debugFetch(`${baseUrl}/v1/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Error ${res.status}: ${errText}`);
    process.exit(1);
  }

  await processSSEStream(res);
}

async function interactiveMode() {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("runloop interactive mode (type 'quit' to exit)");
  console.log(
    `Server: ${baseUrl} | Agent: ${values.agent} | Debug: ${debug ? "on" : "off"}\n`
  );

  const events: InputEvent[] = [];

  const promptUser = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (trimmed === "quit" || trimmed === "exit") {
        rl.close();
        process.exit(0);
      }

      if (trimmed === "/sessions") {
        await fetchSessions();
        promptUser();
        return;
      }

      if (trimmed === "/health") {
        await fetchHealth();
        promptUser();
        return;
      }

      if (trimmed.startsWith("/interrupt ")) {
        await interruptSession(trimmed.slice(11).trim());
        promptUser();
        return;
      }

      if (trimmed === "/debug") {
        debug = !debug;
        console.log(`Debug mode: ${debug ? "on" : "off"}`);
        promptUser();
        return;
      }

      if (!trimmed) {
        promptUser();
        return;
      }

      events.push({
        type: EventType.UserMessage,
        content: trimmed,
      });

      const interactiveReq: RunRequest = {
        agent: { cli: (values.agent as string) ?? "codex", cwd: values.cwd as string | undefined },
        events,
        model: {
          provider: process.env.MODEL_PROVIDER ?? "openai-compatible",
          model: (values.model as string | undefined) ?? process.env.MODEL_NAME ?? "qwen3.7-max",
          baseUrl: process.env.BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY,
        },
        credentials: {
          accessKeyId: process.env.ACCESS_KEY_ID ?? "cli-test-ak",
          accessKeySecret: process.env.ACCESS_KEY_SECRET ?? "cli-test-sk",
        },
      };
      const body = JSON.stringify(interactiveReq);

      try {
        const res = await debugFetch(`${baseUrl}/v1/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        if (!res.ok) {
          console.error(`Error ${res.status}: ${await res.text()}`);
        } else {
          const newEvents = await processSSEStream(res);
          events.push(...(newEvents as unknown as InputEvent[]));
        }
      } catch (err) {
        console.error(
          "Request failed:",
          err instanceof Error ? err.message : err
        );
      }

      promptUser();
    });
  };

  promptUser();
}

async function processSSEStream(
  res: Response
): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = [];
  const reader = res.body?.getReader();
  if (!reader) return collected;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      lines.find((l) => l.startsWith("id: "));

      if (!dataLine) continue;

      const eventType = eventLine?.slice(7) ?? "unknown";
      const dataJson = dataLine.slice(6);

      if (debug) {
        const rawBlock = lines.join("\n");
        console.log(`${C.gray}[sse] ${rawBlock}${C.reset}`);
      }

      try {
        const event = JSON.parse(dataJson);
        collected.push(event);
        renderEvent(eventType, event);
      } catch {
        console.log(`[parse error] ${dataJson}`);
      }
    }
  }

  return collected;
}

function renderEvent(type: string, event: Record<string, unknown>) {
  if (values.raw) {
    console.log(JSON.stringify(event));
    return;
  }

  switch (type) {
    case "run.start":
      console.log(
        `${C.green}[run.start]${C.reset} agent=${event.agentCli} model=${event.model ?? "default"} session=${event.conversationId}`
      );
      break;

    case "run.end":
      console.log(
        `${C.green}[run.end]${C.reset} reason=${event.reason}`
      );
      break;

    case "run.error":
      console.log(
        `${C.red}[run.error]${C.reset}`,
        JSON.stringify(event.error)
      );
      break;

    case "run.interrupt":
      console.log(
        `${C.yellow}[run.interrupt]${C.reset} reason=${event.reason}`
      );
      break;

    case "message.start":
      process.stdout.write(`${C.cyan}[assistant]${C.reset} `);
      break;

    case "message.delta":
      process.stdout.write(event.content as string);
      break;

    case "message.end":
      console.log();
      break;

    case "toolcall.start":
      console.log(
        `${C.magenta}[tool]${C.reset} ${event.toolName}`
      );
      break;

    case "toolresult.delta":
      process.stdout.write(event.delta as string);
      break;

    case "toolresult.end":
      console.log(
        `${C.magenta}[tool.result]${C.reset}${event.isError ? ` ${C.red}(error)${C.reset}` : ""} ${truncateStr(JSON.stringify(event.result), 200)}`
      );
      break;

    case "toolcall.suspend":
      console.log(
        `${C.yellow}[toolcall.suspend]${C.reset} tool=${event.toolName} reason=${event.reason} options=${JSON.stringify(event.options)}`
      );
      break;

    case "turn.start":
      console.log(
        `${C.dim}--- turn ${event.turnIndex} ---${C.reset}`
      );
      break;

    case "turn.end":
      console.log(
        `${C.dim}--- turn end (${event.stopReason}) ---${C.reset}`
      );
      break;

    case "plan.update": {
      const entries = event.entries as Array<{
        content: string;
        status: string;
      }>;
      console.log(`${C.blue}[plan]${C.reset}`);
      for (const entry of entries) {
        const icon =
          entry.status === "completed"
            ? "x"
            : entry.status === "in_progress"
              ? ">"
              : " ";
        console.log(`  [${icon}] ${entry.content}`);
      }
      break;
    }

    case "run.usage":
      console.log(
        `${C.dim}[run.usage] in=${event.inputTokens ?? "?"} out=${event.outputTokens ?? "?"} cost=$${event.costUsd ?? "?"}${C.reset}`
      );
      break;

    default:
      console.log(
        `${C.dim}[${type}]${C.reset}`,
        JSON.stringify(event)
      );
  }
}

function truncateStr(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}
