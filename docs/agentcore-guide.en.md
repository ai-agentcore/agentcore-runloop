# Using this project on AgentCore

[Back to README](../README.en.md) · [简体中文](agentcore-guide.md)

Deploy this sample as a Codex Agent service, test it in the AgentCore console, and call it from your application. Start with model-only conversation, then add MCP tools and Skills. The primary path uses the repository's Dockerfile. Code-package preparation is covered separately below.

## 1. Prepare resources

Prepare a target Workspace, an accessible model connection and model name, and an Agent execution role with the required resource access. Check registry, network and runtime requirements in the [official AgentCore deployment guide](https://help.aliyun.com/en/agentcore/high-code-agent-deployment-guide). The current image architecture requirement is `linux/amd64`; an Apple Silicon default ARM build is not interchangeable.

For this sample, record:

| Setting | Value |
| --- | --- |
| `AGENTCORE_MODEL_CONNECTION` | An accessible model connection resource in the Workspace |
| `AGENTCORE_MODEL_NAME` | A model name supported by that connection |

`AgentCore.auto()` reads platform configuration and workload identity. Do not embed a model API key in source or override `AGENTCORE_CONTROL_ENDPOINT`. Leave optional MCP, Skills, artifact and image configuration out of the first conversation.

## 2. Build and push the image

From the repository root, replace the image address with your ACR repository and authenticate using its instructions:

```sh
export AGENT_IMAGE='<ACR-repository>/agentcore-runloop:0.1.1'
docker buildx build --platform linux/amd64 --load -t "$AGENT_IMAGE" .
docker push "$AGENT_IMAGE"
```

The Dockerfile installs Node dependencies, compiles TypeScript, and installs Codex CLI `0.155.0`, Git and minimal Python 3. Its default command is `node scripts/start.mjs`. You do not need a local `dist/` directory before building.

Keep `.env`, authentication files and business data out of the image. `.dockerignore` excludes common sensitive files; review new files before including them in the build context.

## 3. Configure the Agent

Create an Agent in the target Workspace using **Custom code / image → Container image**, and select your image version. Refer to the official guide for platform-specific creation and registry access. Use these project settings:

| Setting | Value for this sample |
| --- | --- |
| Startup command | `node scripts/start.mjs`, matching the image CMD |
| Service port | `8080` |
| Health check | `/readyz`, port `8080` |
| Conversation protocol | `AGUI` |
| Protocol path | `/ag-ui/agent` |
| Execution role | Access to the configured model connection and subsequent resources |

Set the following environment variables, replacing the model placeholders:

```env
AGENTCORE_MODEL_CONNECTION=<model-connection-resource>
AGENTCORE_MODEL_NAME=<supported-model-name>
AGENTCORE_AGENT_CLI=codex
AGENTCORE_MODEL_ENABLE_THINKING=false
AGENTCORE_SYSTEM_PROMPT=You are a reliable assistant. Complete the user's task.
IMAGE_ABLE=0
HOST=0.0.0.0
PORT=8080
```

`HOST` and `PORT` are the names read by the current code, and the image already sets these values. `IMAGE_ABLE=0` disables image tools for the first deployment. Do not set `AGENTCORE_MOCK=true` in a real deployment.

Do not declare `/model/v1/chat/completions` as a public chat protocol. It is an internal, token-protected model adapter used by Codex.

If you additionally set `AGENTCORE_RUNLOOP_API_TOKEN`, callers must supply `Authorization: Bearer <that-token>`. This application authentication is separate from Endpoint authentication. The internal model/MCP token is randomly generated and requires no user configuration.

## 4. Verify a conversation

Once the instance and Endpoint are ready, select AGUI in console debugging and send:

> Describe in one sentence how you can help a user complete a task.

Check streamed events and a final answer. A successful `/readyz` check does not prove model resources are accessible; the real conversation verifies that path. If the answer is `Fixture AgentCore response.`, check whether mock mode was accidentally enabled.

Next, test tool execution by asking the Agent to create a small text file in its working directory and read it back. Default local execution requires the target environment to support the Codex native OS sandbox. Investigate `LOCAL_SANDBOX_UNAVAILABLE` rather than bypassing isolation.

## 5. Call from your application

Use the Endpoint page's **complete AG-UI invocation URL and authentication instructions**. Do not substitute the console URL or guess gateway prefixes. Configure these client variables in a trusted terminal or server:

- `AGENT_INVOKE_URL`: the complete invocation URL.
- `AGENT_AUTH_HEADER` and `AGENT_API_KEY`: the required authentication header name and value.

From the repository root:

```sh
curl -N "$AGENT_INVOKE_URL" \
  -H 'Content-Type: application/json' \
  -H "${AGENT_AUTH_HEADER}: ${AGENT_API_KEY}" \
  --data-binary @examples/ag-ui.json
```

Add the application `Authorization` header if you enabled its Bearer token. Never expose keys in public frontend code. The sample JSON has fixed `threadId` and `runId` values: generate a new `runId` per request, reuse `threadId` within a conversation, and use a new `threadId` for a new conversation.

## 6. Add tools and Skills

After model calls succeed, add resources incrementally:

```env
AGENTCORE_MCP_SERVERS=<MCP-resource-name>
AGENTCORE_SKILLS=<Skill-name>@<version>
AGENTCORE_SYSTEM_PROMPT=Use the configured tools and Skills to complete user tasks.
```

Resources must be available in the Workspace and accessible to the Agent. Multiple entries are comma-separated. Omitting a Skill version resolves the latest version according to the implementation; pinning a version improves reproducibility. Update the deployment and test a task that actually needs the resource.

See the [configuration and implementation reference (Chinese)](reference.md) for attachments, artifact delivery, telemetry and advanced settings. You do not need to enable every capability for the first deployment.

## Code-package deployment

AgentCore supports Node.js 22 packages and does not install dependencies or compile source on your behalf; see the [official code-package requirements](https://help.aliyun.com/en/agentcore/high-code-agent-deployment-guide). This repository provides a Dockerfile, but no ready-to-upload ZIP or automated packaging command.

A package for this project needs at least:

```text
package.json
scripts/start.mjs
dist/src/...
dist/vendor/runloop/src/...
node_modules/...
```

It also needs a Linux x86_64-compatible Codex CLI and its native executable, with `codex` available on the startup process's `PATH`. Packaging application `node_modules` does not include the Codex installation performed globally by the Dockerfile. The runtime must also provide the required Shell, Git, Skill dependencies and native isolation capabilities.

Prepare dependencies with `npm ci`, build with `npm run build`, and prepare production dependencies in a Linux build environment. Configure `node scripts/start.mjs` relative to the actual package root. If needed, a package startup script can set the CLI `PATH` before starting Node. Do not upload macOS dependencies or CLI binaries, or assume the managed runtime includes the required Codex version.

After preparing the package, choose the corresponding Node.js runtime, apply the same port, AGUI path and environment settings as the image path, and repeat the conversation check. Until these prerequisites are met, use the image path.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing model configuration | Both model variables are required outside local mock mode |
| `Agent CLI codex is unavailable` | CLI installation, executable permissions and `PATH` |
| Missing compiled entry or module | `dist/`, production dependencies and startup directory |
| 404 or protocol mismatch | AGUI declaration, `/ag-ui/agent` and invocation URL |
| 401 | Endpoint authentication and optional application Bearer token separately |
| Ready process but failed conversation | Model name, connection, execution role and network |
| Missing tool or degraded resources | MCP / Skill settings and safe diagnostic fields |
| `LOCAL_SANDBOX_UNAVAILABLE` | Target OS isolation support, directory permissions and runtime policy |

Keep error codes and request/conversation IDs for diagnosis, without sharing credential headers. This guide provides deployment and verification steps, not evidence of a deployment in your Workspace. Stop or delete test Agents when they are no longer needed.
