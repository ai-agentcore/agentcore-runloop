import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AgentCore container runtime", () => {
  it("keeps the platform launcher runtime while shipping the Node harness", async () => {
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain("FROM node:22-bookworm-slim");
    expect(dockerfile).toContain("python3");
    expect(dockerfile).not.toContain("vendor/agentcore-sdk");
    expect(dockerfile).not.toContain("COPY bridge");
    expect(dockerfile).not.toMatch(/AGENTCORE_(?:WORKDIR|ARTIFACT_ROOT)=\//);
  });
});
