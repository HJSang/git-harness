import type { RuntimeHook } from "../runtime/types.ts";
import type { SkillStore } from "./skill-store.ts";

/**
 * Pluggable Layer 2 `RuntimeHook` implementing Turn-0 progressive disclosure:
 * appends only the compact skill catalog (`name: description`) into the cacheable
 * system prompt prefix, leaving full `SKILL.md` bodies to be loaded on demand via
 * `read({ path: "skill://<name>/SKILL.md" })`.
 */
export function createSkillCatalogHook(skills: SkillStore): RuntimeHook {
  return {
    name: "skill-catalog",
    preTurn(ctx) {
      const catalog = skills.renderCatalog();
      if (!catalog) return;
      const block = `\n\n## Available Skills\n${catalog}`;
      const first = ctx.messages[0];
      if (first && first.role === "system") {
        ctx.messages[0] = { ...first, content: first.content + block };
      } else {
        ctx.messages.unshift({ role: "system", content: block.trim() });
      }
    },
  };
}
