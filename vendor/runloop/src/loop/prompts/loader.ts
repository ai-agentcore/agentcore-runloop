export interface PromptTemplate {
  name: string;
  description: string;
  template: string;
  variables?: Record<string, string>;
}

export function renderTemplate(
  template: string,
  vars: Record<string, string> = {},
): string {
  return template.replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (_, key) => vars[key] ?? "",
  );
}

export class PromptRegistry {
  private templates = new Map<string, PromptTemplate>();

  register(prompt: PromptTemplate): void {
    this.templates.set(prompt.name, prompt);
  }

  get(name: string): PromptTemplate | undefined {
    return this.templates.get(name);
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  render(name: string, overrides?: Record<string, string>): string {
    const prompt = this.templates.get(name);
    if (!prompt) throw new Error(`Prompt template "${name}" not found`);
    const vars = { ...prompt.variables, ...overrides };
    return renderTemplate(prompt.template, vars);
  }

  list(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }
}
