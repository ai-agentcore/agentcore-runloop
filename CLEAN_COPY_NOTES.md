# 干净源码副本交接

整理日期：2026-11-01。

> 以下记录的是复制完成时的状态。本次上传前的新增检查、脱敏、依赖更新及未解决事项见 [安全检查记录](docs/security-review-2026-11-01.md)。本副本随后已初始化为独立 Git 仓库。

## 当前状态

- 基于 `agentcore-runloop` 的 `codex/pure-sandbox-service` 工作区，源 HEAD 为 `d27bee3`，包含复制时所有未提交和未跟踪的非忽略源码。
- 当前默认入口为 Pure Sandbox 服务；旧 Agent 模式代码和说明仍保留。请先读 `README.md`、`AGENTS.md`、`docs/agent-mode-reference.md`。
- 未初始化 Git、未创建远端仓库、未上传 GitHub；未包含源仓库 Git 历史或 remote 配置。
- 源项目没有被修改。

## 已排除或清理

- 排除 `.git`、Git 忽略的文件、运行工作区、认证文件、日志、抓包、依赖、构建产物和缓存。
- 排除历史验证目录 `verification/`、`VERIFICATION.md` 和历史报告目录 `artifacts/`。文档中可能仍存在对这些历史材料的引用。
- 保留 `.env.example` 的空 Token 配置；不包含真实环境文件。
- `package-lock.json` 中 74 个内部 npm registry URL 改为 `registry.npmjs.org`，包版本、tarball 路径和完整性校验不变。
- `vendor/runloop/UPSTREAM.json` 删除个人机器路径，保留 upstream commit 和补丁说明。

## 检查范围与下一步

- 已对源工作区和本地全部 33 个提交做静态凭证规则检查；未发现需复制文件中的明确真实云密钥或私钥。测试代码包含模拟凭证，不应作为生产配置使用。
- 本地被忽略的 3 个 Codex `auth.json` 含认证值，未复制。
- 已核对复制前后 `src/`、`tests/`、`scripts/` 文件内容一致，并检查清理后的内部域名和个人路径引用。
- 未重新安装依赖或运行测试；公共 registry 中各固定版本的可获取性尚未验证。继续处理时先运行 `npm ci`，再按 `AGENTS.md` 运行 typecheck、coverage 和 build。
- 此副本不是已完成的开源发布。正式公开前还需确认 vendored 源码许可、依赖可获取性、文档准确性和发布范围。不要在未确认的情况下补写或更改许可证。
