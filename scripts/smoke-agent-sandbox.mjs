import assert from "node:assert/strict";
import { Sandbox } from "e2b";

const DEFAULT_TEMPLATE = "code-interpreter-v1";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_SANDBOX_ROOT = "/workspace";

class ConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ConfigurationError";
    this.code = code;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`missing_${name.toLowerCase()}`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function apiOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ConfigurationError("invalid_agentcore_sandbox_api_url");
  }
  return url.origin;
}

function sandboxDomain(value) {
  if (value.includes("://") || value.includes("/") || value.includes("@") || value.includes(":")) {
    throw new ConfigurationError("invalid_agentcore_sandbox_domain");
  }
  const url = new URL(`https://${value}`);
  if (url.hostname !== value) throw new ConfigurationError("invalid_agentcore_sandbox_domain");
  return value;
}

function diagnostic(error, stage) {
  const source = error && typeof error === "object" ? error : {};
  const response = source.response && typeof source.response === "object" ? source.response : {};
  const message = typeof source.message === "string" ? source.message : "";
  const safeHttpStatus = typeof source.message === "string"
    ? Number(source.message.match(/^(\d{3}):/)?.[1])
    : undefined;
  const knownReason = /executionRoleArn/i.test(message)
    ? "execution_role_required"
    : /volume[^\n]*(not found|does not exist)|not found[^\n]*volume/i.test(message)
      ? "volume_not_found"
      : /same team|team[^\n]*(mismatch|different)/i.test(message)
        ? "volume_team_mismatch"
        : /volume[^\n]*(unsupported|not support)/i.test(message)
          ? "volume_not_supported"
          : undefined;
  return {
    result: "failed",
    stage,
    errorType: source.name || "UnknownError",
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(Number.isInteger(source.status) ? { httpStatus: source.status } : {}),
    ...(Number.isInteger(response.status) ? { httpStatus: response.status } : {}),
    ...(Number.isInteger(safeHttpStatus) ? { httpStatus: safeHttpStatus } : {}),
    ...(knownReason ? { reason: knownReason } : {}),
    ...(typeof source.requestId === "string" ? { requestId: source.requestId } : {}),
    ...(Number.isInteger(source.exitCode) ? { exitCode: source.exitCode } : {}),
  };
}

let sandbox;
let stage = "configuration";

try {
  const apiKey = required("AGENTCORE_SANDBOX_API_KEY");
  const apiUrl = apiOrigin(required("AGENTCORE_SANDBOX_API_URL"));
  const domain = sandboxDomain(required("AGENTCORE_SANDBOX_DOMAIN"));
  const template = process.env.AGENTCORE_SANDBOX_TEMPLATE?.trim() || DEFAULT_TEMPLATE;
  const timeoutMs = positiveInteger("AGENTCORE_SANDBOX_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const requestTimeoutMs = positiveInteger("AGENTCORE_SANDBOX_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
  const volumeName = process.env.AGENTCORE_SANDBOX_VOLUME_NAME?.trim();
  const volumeMountPath = process.env.AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH?.trim();
  if (Boolean(volumeName) !== Boolean(volumeMountPath)) {
    throw new ConfigurationError("incomplete_agentcore_sandbox_volume_configuration");
  }
  const sandboxRoot = process.env.AGENTCORE_SANDBOX_ROOT?.trim() || DEFAULT_SANDBOX_ROOT;
  const probeId = crypto.randomUUID();
  const smokeRoot = `${sandboxRoot}/.agentcore-sandbox-smoke-${probeId}`;
  const marker = `agentcore-smoke-${Date.now()}-${probeId}`;
  const file = `${smokeRoot}/probe.txt`;

  stage = "create";
  sandbox = await Sandbox.create(template, {
    apiKey,
    apiUrl,
    domain,
    timeoutMs,
    requestTimeoutMs,
    allowInternetAccess: false,
    ...(volumeName && volumeMountPath ? { volumeMounts: { [volumeMountPath]: volumeName } } : {}),
    metadata: { purpose: "agentcore_sandbox_smoke" },
  });

  stage = "health";
  assert.equal(await sandbox.isRunning(), true, "sandbox is not running");

  stage = "command";
  const command = await sandbox.commands.run(
    `set -eu; mkdir -p '${smokeRoot}'; printf '%s' '${marker}' > '${file}'; printf 'command-ok'`,
    { timeoutMs: 30_000 },
  );
  assert.equal(command.exitCode, 0, "sandbox command returned a non-zero exit code");
  assert.equal(command.stdout, "command-ok", "sandbox command returned unexpected output");

  stage = "capabilities";
  const capabilityResult = await sandbox.commands.run(
    "for tool in node git python3; do if command -v \"$tool\" >/dev/null 2>&1; then printf '%s=present\\n' \"$tool\"; else printf '%s=absent\\n' \"$tool\"; fi; done",
    { timeoutMs: 30_000 },
  );
  assert.equal(capabilityResult.exitCode, 0, "sandbox capability check failed");
  const capabilities = Object.fromEntries(capabilityResult.stdout.trim().split("\n").map(line => line.split("=")));

  stage = "filesystem-read";
  assert.equal(await sandbox.files.read(file), marker, "filesystem content mismatch");
  const info = await sandbox.files.getInfo(file);
  assert.equal(info.type, "file", "filesystem probe is not a regular file");

  stage = "filesystem-write";
  const sdkMarker = `${marker}-sdk`;
  await sandbox.files.write(file, sdkMarker);
  assert.equal(await sandbox.files.read(file), sdkMarker, "SDK filesystem write was not persisted");

  stage = "cleanup-probe";
  await sandbox.files.remove(file);
  await sandbox.files.remove(smokeRoot);
  assert.equal(await sandbox.files.exists(file), false, "filesystem probe cleanup failed");

  console.log(JSON.stringify({
    result: "passed",
    template,
    capabilities,
    checks: ["create", "health", "command", "filesystem-read", "filesystem-write", "cleanup"],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify(diagnostic(error, stage), null, 2));
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await sandbox.kill();
    } catch (error) {
      console.error(JSON.stringify(diagnostic(error, "kill"), null, 2));
      process.exitCode = 1;
    }
  }
}
