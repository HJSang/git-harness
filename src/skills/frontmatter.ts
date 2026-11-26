export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  body: string;
}

/**
 * Zero-dependency parser for standard `SKILL.md` YAML frontmatter:
 *
 * ```markdown
 * ---
 * name: my-skill
 * description: One-line description of when to use this skill
 * ---
 * # Instructions...
 * ```
 */
export function parseSkillFrontmatter(markdown: string): ParsedSkillFrontmatter | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const endIdx = normalized.indexOf("\n---", 4);
  if (endIdx === -1) return null;

  const header = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 4).replace(/^\n+/, "");

  let name = "";
  let description = "";

  for (const line of header.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase();
    const rawVal = match[2]!.trim().replace(/^["']|["']$/g, "");
    if (key === "name") name = rawVal;
    else if (key === "description") description = rawVal;
  }

  if (!name || !description) return null;
  return { name, description, body };
}
