import { describe, expect, it } from "vitest";
import { AgentRunResourceManager } from "./e2e/agentrun-resource-manager.js";

function createManager(namePrefix?: string): AgentRunResourceManager {
  return new AgentRunResourceManager({
    credentials: {
      accessKeyId: "ak",
      accessKeySecret: "sk",
      region: "cn-hangzhou",
    },
    namePrefix,
  });
}

describe("AgentRunResourceManager", () => {
  it("generates e2e-runloop resource names", () => {
    const manager = createManager();

    expect(manager.generateName("Skill Resource")).toMatch(
      /^e2e-runloop-skill-resource-[a-f0-9-]{8}$/
    );
  });

  it("rejects non e2e-runloop resource names", () => {
    const manager = createManager("not-e2e");

    expect(() => manager.generateName("skill")).toThrow(
      /must start with e2e-runloop-/
    );
  });
});
