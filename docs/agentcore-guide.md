# 在 AgentCore 上使用

[返回首页](../README.md) · [English](agentcore-guide.en.md)

本教程将当前示例部署为可在 AgentCore 控制台调试、也可由业务应用调用的 Codex Agent 服务。首次使用先完成模型对话，再按需接入 MCP 和 Skill。以下以仓库自带 Dockerfile 的镜像路径为主；代码包的准备要求见文末。

## 1. 准备资源

准备目标 Workspace、可访问的模型连接及模型名称，并为 Agent 配置相应执行角色。镜像仓库、运行架构、网络与创建页面的具体要求以 [AgentCore 官方部署指南](https://help.aliyun.com/zh/agentcore/high-code-agent-deployment-guide)为准。当前官方镜像要求为 `linux/amd64`；不要直接推送 Apple Silicon 默认构建的 ARM 镜像。

对本示例，先记录两项配置：

| 配置 | 填写内容 |
| --- | --- |
| `AGENTCORE_MODEL_CONNECTION` | Workspace 中实际存在且可访问的模型连接资源名 |
| `AGENTCORE_MODEL_NAME` | 该连接支持的模型名称 |

本示例通过 `AgentCore.auto()` 使用平台配置和工作负载身份。无需把模型 API Key 写进源码，也不要自行覆盖 `AGENTCORE_CONTROL_ENDPOINT`。首次对话先不配置 MCP、Skill、文件交付或图片能力。

## 2. 构建并推送镜像

在项目根目录执行。将镜像地址替换为你准备的 ACR 仓库地址，并先按仓库说明完成登录：

```sh
export AGENT_IMAGE='<ACR仓库地址>/agentcore-runloop:0.1.1'
docker buildx build --platform linux/amd64 --load -t "$AGENT_IMAGE" .
docker push "$AGENT_IMAGE"
```

Dockerfile 会安装 Node 运行依赖、编译 TypeScript，并安装 Codex CLI `0.155.0`、Git 和最小 Python 3；默认命令为 `node scripts/start.mjs`。不需要在本机提前生成 `dist/`。

镜像中不应包含 `.env`、认证文件或业务数据。仓库的 `.dockerignore` 已排除常见敏感文件，新增文件时仍需检查构建上下文。

## 3. 创建并配置 Agent

在目标 Workspace 中创建 Agent，选择 **自定义代码 / 镜像 → 容器镜像**，选中上一步的镜像版本。平台创建流程和仓库访问要求请参照官方指南；本项目对应的配置如下：

| 项目 | 本示例的值 |
| --- | --- |
| 启动命令 | `node scripts/start.mjs`（与镜像 CMD 一致） |
| 服务端口 | `8080` |
| 健康检查 | `/readyz`，端口 `8080` |
| 对话协议 | `AGUI` |
| 协议 Path | `/ag-ui/agent` |
| 执行角色 | 能访问本次配置的模型连接及后续所需资源 |

添加以下环境变量，替换两个资源占位值：

```env
AGENTCORE_MODEL_CONNECTION=<模型连接资源名>
AGENTCORE_MODEL_NAME=<该连接支持的模型名称>
AGENTCORE_AGENT_CLI=codex
AGENTCORE_MODEL_ENABLE_THINKING=false
AGENTCORE_SYSTEM_PROMPT=你是一个可靠的助手，请根据用户要求完成任务。
IMAGE_ABLE=0
HOST=0.0.0.0
PORT=8080
```

这里的 `HOST`、`PORT` 是当前代码实际读取的名称。镜像已设置这两个值，显式填写可便于核对。`IMAGE_ABLE=0` 关闭首次体验不需要的图片工具。不要在云端设置 `AGENTCORE_MOCK=true`，否则得到的是模拟响应。

不要将内部 `/model/v1/chat/completions` 声明为公共聊天协议；它是供 Codex 使用的受内部 Token 保护的模型适配接口。

若另外配置了 `AGENTCORE_RUNLOOP_API_TOKEN`，调用方还需提供 `Authorization: Bearer <该Token>`。这是应用自己的鉴权，与平台 Endpoint 鉴权分开；内部模型/MCP Token 则由进程随机生成，不需要手动配置。

## 4. 完成首次对话

创建后等待实例和 Endpoint 就绪，在控制台调试中选择 AGUI，发送：

> 请用一句话介绍你能如何帮助用户完成任务。

检查流式事件和最终回答。`/readyz` 成功仅说明就绪检查通过，不代表模型资源可用；本次真实对话才会验证模型调用链路。若出现 `Fixture AgentCore response.`，检查是否误启用了 mock。

然后再测试工具执行，例如让 Agent 在当前工作目录创建一个小文本文件并读回。默认 local 执行要求部署环境允许 Codex 原生 OS 沙箱；出现 `LOCAL_SANDBOX_UNAVAILABLE` 时应检查目标环境，不要关闭隔离来绕过预检。

## 5. 从业务应用调用

使用 Agent Endpoint 页面给出的**完整 AG-UI 调用地址和鉴权说明**，不要将控制台网址当作 API 地址，也不要自行猜测网关前缀。以下客户端变量由你在可信终端或服务端配置中设置：

- `AGENT_INVOKE_URL`：完整调用地址。
- `AGENT_AUTH_HEADER`、`AGENT_API_KEY`：页面指定的鉴权 Header 名称与值。

在项目根目录发送仓库中的示例请求：

```sh
curl -N "$AGENT_INVOKE_URL" \
  -H 'Content-Type: application/json' \
  -H "${AGENT_AUTH_HEADER}: ${AGENT_API_KEY}" \
  --data-binary @examples/ag-ui.json
```

如果启用了应用层 Bearer Token，另加对应的 `Authorization` 头。不要把任何 Key 放进前端公开代码。示例 JSON 使用固定 `threadId` 和 `runId`；实际接入时，新请求使用新的 `runId`，同一对话沿用 `threadId`，新对话更换 `threadId`。

## 6. 接入工具与 Skill

模型调用通过后，再逐项增加平台资源：

```env
AGENTCORE_MCP_SERVERS=<MCP资源名>
AGENTCORE_SKILLS=<Skill名称>@<版本>
AGENTCORE_SYSTEM_PROMPT=请结合已配置的工具和技能完成用户任务。
```

资源需要在当前 Workspace 可用，并有相应权限。MCP 和 Skill 支持逗号分隔多项；Skill 省略版本时按实现解析最新版，固定版本更便于复现。更新部署后，选择确实需要该工具或 Skill 的任务验证。

文件交付、附件、遥测及完整配置见[配置与实现参考](reference.md)。首次接入不需要一次性配置全部能力。

## 代码包部署说明

平台支持 Node.js 22 代码包，且不会替应用安装依赖或编译源码，详见[官方代码包要求](https://help.aliyun.com/zh/agentcore/high-code-agent-deployment-guide)。当前仓库提供 Dockerfile，但没有现成的可上传 ZIP 或自动打包命令。

准备本项目的代码包时，需要至少包含：

```text
package.json
scripts/start.mjs
dist/src/...
dist/vendor/runloop/src/...
node_modules/...
```

此外必须准备 Linux x86_64 兼容的 Codex CLI 及其原生可执行文件，并使 `codex` 位于启动进程的 `PATH` 中；仅打包应用的 `node_modules` 不会包含 Dockerfile 全局安装的 Codex。运行环境还需满足 Shell、Git、所用 Skill 的依赖及 Codex 原生隔离条件。

先在 Linux 构建环境完成 `npm ci`、`npm run build` 和生产依赖准备，再按实际包根配置 `node scripts/start.mjs`。如需配置 CLI 的 `PATH`，可由包内启动脚本设置后启动 Node。不要将 macOS 的 `node_modules` 或 CLI 二进制直接打包上传，也不要假设平台代码包运行时自带本项目所需版本的 Codex。

代码包准备好后，选择相应 Node.js 运行时，按镜像路径相同的端口、AGUI Path 和环境变量配置，并重新执行首次对话验证。在完成这些准备前，可先使用镜像路径。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| 启动提示缺少模型变量 | 两个模型变量都必填；mock 仅用于本地 |
| `Agent CLI codex is unavailable` | CLI 是否安装、可执行，且位于 `PATH` |
| 找不到编译产物或模块 | 包内是否有 `dist/` 和运行依赖；启动目录是否正确 |
| 404 或调试协议不匹配 | 应声明 AGUI 和 `/ag-ui/agent`，并使用正确的调用 URL |
| 401 | 分别检查平台 Endpoint 鉴权和可选应用 Bearer Token |
| 进程就绪但无法对话 | 检查模型名称、连接资源、角色权限和网络 |
| 工具不可用或资源 degraded | 检查对应 MCP / Skill 的资源配置和安全诊断字段 |
| `LOCAL_SANDBOX_UNAVAILABLE` | 检查目标 OS 沙箱能力、目录权限及运行时策略 |

排错时保留错误码、请求或会话 ID；不要分享完整凭证头。教程给出配置和验证步骤，不代表已在你的 Workspace 完成部署。体验结束后按需停止或删除测试 Agent，避免保留不需要的运行资源。
