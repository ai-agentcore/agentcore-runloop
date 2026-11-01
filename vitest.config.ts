import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["tests/**/*.test.ts"], testTimeout: 30000, pool: "forks", maxWorkers: 1,
  coverage: {
    provider: "v8", include: ["src/**/*.ts"], exclude: ["src/main.ts"],
    thresholds: { branches: 87, lines: 95, functions: 95, statements: 95 },
  },
} });
