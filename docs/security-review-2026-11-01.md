# 上传前安全检查（2026-11-01）

## 范围与结论

检查当前源码副本（初始 347 个文件，包括隐藏文件和 vendored 测试），覆盖常见云 AK、GitHub/OpenAI Token、JWT、私钥、URL 内嵌凭证、硬编码敏感字段及高熵字符串。人工复核命中项后，未发现明确真实密钥；命中内容均为测试夹具或示例域名。这是静态检查结论，不是密钥不存在的绝对保证，也不是完整渗透测试。

此副本原本没有 `.git`，本次使用全新历史，不携带来源项目历史、认证文件、环境文件或运行日志。`.env.example` 的 API Token 保持为空。

## 已处理

- 补强 `.gitignore`：排除会话临时目录、附件、生成图片、SSH 默认私钥名和抓包文件。
- 补强 `.dockerignore`：排除嵌套认证文件、环境文件、Codex 会话配置及会话产物，保留空值环境模板。
- vendored 测试中的一组疑似实际云账户 ID 统一替换为示例 ID；该 ID 并非认证凭证。
- 更新锁文件中的兼容依赖：MCP SDK 1.32.2、Hono 4.13.16、Zod 4.6.7、Undici 7.30.1、body-parser 2.4.0、fast-uri 3.1.9、ip-address 10.7.5、qs 6.17.1，以及 SDK 内嵌的 Hono Node adapter 2.1.5。未强制升级或降级不兼容的大版本。

## 尚未解决的依赖告警

公共 npm registry 的 `npm audit --omit=dev` 从 26 个受影响依赖条目降至 19 个（5 high、14 moderate、0 critical）。这些计数包含同一底层问题向父依赖传播的条目，不等于独立漏洞数，也不代表每项在当前服务入口均可利用。

- OpenTelemetry 1.x 链路仍有 baggage/Jaeger 传播器告警。需要迁移相关 SDK、exporter 和 telemetry 封装后单独验证；不以跨大版本 override 掩盖兼容性问题。
- AgentCore SDK 的 `@ag-ui/core` 内嵌 Zod 3.x 仍被报告受影响；根项目 Zod 4.x 更新不会替代此嵌套依赖。审计未提供该 SDK 链路的自动修复方案。
- 根项目 `@hono/node-server` 1.x 仍有静态路径解码告警，需评估迁移至 2.x。
- e2b 的 glob/minimatch 依赖仍有告警。审计建议的 e2b 2.0.3 是降级，不自动采用。

在上述迁移完成前，不应把本次上传视为生产安全验收通过。真实凭证继续只在部署环境注入；不要提交到仓库。

## 验证与限制

- 执行类型检查、coverage 测试、构建和规定的 upstream 测试；最终结果以本次交付说明为准。
- 额外运行 sidecar 与远端 shell 测试：418 项通过、1 项失败。失败位于 `vendor/runloop/tests/sidecar/server.test.ts` 的远端 bash 路由测试，返回 `Local MCP ...` 文本而测试预期 JSON；使用原始账户 ID 复测也失败，与账户 ID 脱敏无关，尚未修复。
- 验证使用本机 Node 23.9.0（满足项目 >=22 条件），未重新运行 Node 22 容器或真实云部署验证。
- 本次仓库为私有仓库；未添加许可证或声称已完成开源许可审核。
