export { PromptRegistry, renderTemplate } from "./loader.js";
export type { PromptTemplate } from "./loader.js";

export { superAgentPrompt, subAgentCoordinationPrompt } from "./super-agent.js";

export {
  modelPrompts,
  selectModelPrompt,
  renderModelPrompt,
  MODEL_BASE_PROMPT,
} from "./models/index.js";

import { PromptRegistry } from "./loader.js";
import { superAgentPrompt, subAgentCoordinationPrompt } from "./super-agent.js";
import { modelPrompts } from "./models/index.js";

export function createDefaultRegistry(): PromptRegistry {
  const registry = new PromptRegistry();
  registry.register(superAgentPrompt);
  registry.register(subAgentCoordinationPrompt);
  for (const p of modelPrompts) {
    registry.register(p);
  }
  return registry;
}
