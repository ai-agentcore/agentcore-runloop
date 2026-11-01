import { describe, expect, it } from "vitest";
import {
  PromptRegistry,
  renderTemplate,
  type PromptTemplate,
} from "@/loop/prompts/loader.js";

describe("renderTemplate", () => {
  it("replaces {{ variable }} placeholders", () => {
    const result = renderTemplate("Hello {{ name }}, you are {{ role }}.", {
      name: "Alice",
      role: "admin",
    });
    expect(result).toBe("Hello Alice, you are admin.");
  });

  it("handles missing variables as empty string", () => {
    const result = renderTemplate("Hello {{ name }}!", {});
    expect(result).toBe("Hello !");
  });

  it("handles no variables", () => {
    const result = renderTemplate("No placeholders here.");
    expect(result).toBe("No placeholders here.");
  });

  it("handles multiple occurrences of the same variable", () => {
    const result = renderTemplate("{{ x }} and {{ x }}", { x: "OK" });
    expect(result).toBe("OK and OK");
  });

  it("tolerates whitespace variants in placeholders", () => {
    const result = renderTemplate("{{a}} {{  b  }} {{ c}}", {
      a: "1",
      b: "2",
      c: "3",
    });
    expect(result).toBe("1 2 3");
  });
});

describe("PromptRegistry", () => {
  const samplePrompt: PromptTemplate = {
    name: "test-prompt",
    description: "A test prompt",
    template: "Hello {{ who }}!",
    variables: { who: "world" },
  };

  it("registers and retrieves a prompt", () => {
    const registry = new PromptRegistry();
    registry.register(samplePrompt);

    expect(registry.has("test-prompt")).toBe(true);
    expect(registry.get("test-prompt")).toBe(samplePrompt);
  });

  it("renders with default variables", () => {
    const registry = new PromptRegistry();
    registry.register(samplePrompt);

    expect(registry.render("test-prompt")).toBe("Hello world!");
  });

  it("renders with overridden variables", () => {
    const registry = new PromptRegistry();
    registry.register(samplePrompt);

    expect(registry.render("test-prompt", { who: "Codex" })).toBe(
      "Hello Codex!",
    );
  });

  it("throws on unknown prompt name", () => {
    const registry = new PromptRegistry();
    expect(() => registry.render("nope")).toThrow('Prompt template "nope" not found');
  });

  it("lists all registered prompts", () => {
    const registry = new PromptRegistry();
    registry.register(samplePrompt);
    registry.register({
      name: "another",
      description: "Another",
      template: "x",
    });

    const names = registry.list().map((p) => p.name);
    expect(names).toContain("test-prompt");
    expect(names).toContain("another");
    expect(names).toHaveLength(2);
  });
});
