import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    globals: true,
    testTimeout: 15_000,
    pool: "forks",
    maxWorkers: 1,
    setupFiles: ["./tests/setup.ts"],
    exclude: [
      "workspaces/**",
      "node_modules/**",
      ".claude/**",
      "eval/**",
      "tests/e2e/**",
      "tests/agents/**", // 多协议 test-agent 能力矩阵（make test-agents）：含已知红用例，不进默认 test/CI 门禁
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // 覆盖率门禁：**逐文件强制**（perFile:true，一个文件低就直接红，不被同目录高覆盖文件平均掩盖）。
      // **branches 是主指标**——行覆盖高不代表分支都覆盖（一行里的多判定/三元/短路分支可能漏测）。
      //
      // **按目录配阈值：默认 95%、实在达不到的目录放宽**（你的诉求）。机制说明（vitest 3.x 关键约束）：
      //   vitest 的顶层 threshold key（branches/lines/…）对**所有**文件生效，即使被 glob 命中也照查——glob 只能
      //   在其之上**加严**、无法**放宽**。所以这里**不设顶层 key**，改为**每个目录一条 glob**：达标目录给 95，
      //   集成/进程/WS/上游 + 防御分支密集、实在达不到 95 的目录按**当前实测下取整**放宽（锁现状、只能升不能降）。
      //   嵌套 glob 取交集（更严者生效）：loop/prompts/** 的 95 会盖过 loop/** 的 85，故 prompts 子树仍吃满 95；
      //   要在放宽目录里单独把某个达标文件钉到 95，再加一条更具体的 file glob 即可（更严生效）。
      //   **新增目录必须在此补一条**（否则不被门禁覆盖）；某目录补齐到 95 后即可上调/删成默认 95。
      thresholds: {
        perFile: true,
        // ── 达标目录：默认 95% ──
        "src/client/**/*.ts": { branches: 95, functions: 95, lines: 95, statements: 95 },
        "src/types/**/*.ts": { branches: 95, functions: 95, lines: 95, statements: 95 },
        "src/loop/prompts/**/*.ts": { branches: 95, functions: 95, lines: 95, statements: 95 },
        // ── 放宽目录：实测下取整（实在达不到 95；锁现状、待补齐后上调） ──
        "src/events/**/*.ts": { branches: 94, functions: 94, lines: 95, statements: 95 },
        "src/resources/**/*.ts": { branches: 94, functions: 95, lines: 95, statements: 95 },
        "src/server/**/*.ts": { branches: 93, functions: 95, lines: 95, statements: 95 },
        "src/util/**/*.ts": { branches: 92, functions: 93, lines: 95, statements: 95 },
        "src/mcp/**/*.ts": { branches: 90, functions: 93, lines: 95, statements: 95 },
        "src/loop/**/*.ts": { branches: 84, functions: 65, lines: 82, statements: 82 },
        "src/observability/**/*.ts": { branches: 83, functions: 95, lines: 95, statements: 95 },
        "src/provider/**/*.ts": { branches: 82, functions: 95, lines: 90, statements: 90 },
        "src/hitl/**/*.ts": { branches: 82, functions: 95, lines: 95, statements: 95 },
        "src/sidecar/**/*.ts": { branches: 81, functions: 95, lines: 91, statements: 91 },
        "src/acp/**/*.ts": { branches: 71, functions: 90, lines: 90, statements: 90 },
      },
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**", "src/**/index.ts", "src/acp/acp-adapter.ts", "src/mcp/types.ts", "src/provider/types.ts", "src/server/routes.ts"],
    },
  },
});
