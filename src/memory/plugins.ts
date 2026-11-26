import type { RuntimeHook, Tool } from "../runtime/types.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { RecallIndex } from "./recall-index.ts";
import type { RecallSourceKind } from "./types.ts";

/**
 * Pluggable Layer 2 `RuntimeHook` that appends pinned `system/*` files from
 * `refs/harness/memory` onto the system prompt message without coupling
 * `AgentRuntime` to `MemoryStore`.
 */
export function createPinnedMemoryHook(memory: MemoryStore): RuntimeHook {
  return {
    name: "pinned-memory",
    preTurn(ctx) {
      const pinned = memory.renderPinnedSystemMemory();
      if (!pinned) return;
      const block = `\n\n## Pinned Memory\n${pinned}`;
      const first = ctx.messages[0];
      if (first && first.role === "system") {
        ctx.messages[0] = { ...first, content: first.content + block };
      } else {
        ctx.messages.unshift({ role: "system", content: block.trim() });
      }
    },
  };
}

/**
 * Pluggable `recall` tool allowing an agent to search compacted cold history
 * (including `parent2` archives) and persistent `refs/harness/memory` files on demand.
 */
export function createRecallTool(index: RecallIndex, memory?: MemoryStore): Tool {
  return {
    readOnly: true,
    schema: {
      name: "recall",
      description:
        "Search archived session history (including compacted turns and subagents) and persistent project memory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, file paths, or error messages to search" },
          source: { type: "string", description: "Optional filter: 'session' or 'memory'" },
          memoryPath: { type: "string", description: "Optional exact memory file path to read directly" },
          limit: { type: "number", description: "Max hits to return (default 5)" },
        },
      },
    },
    execute(args) {
      if (args.memoryPath && memory) {
        const content = memory.read(String(args.memoryPath));
        if (content === null) {
          return { output: `Memory file not found: ${args.memoryPath}`, isError: true };
        }
        return { output: content };
      }

      const query = String(args.query ?? "").trim();
      if (!query) {
        return { output: "recall error: provide 'query' or 'memoryPath'", isError: true };
      }

      const rawSource = args.source ? String(args.source) : undefined;
      const source: RecallSourceKind | undefined =
        rawSource === "session" || rawSource === "memory" ? rawSource : undefined;

      // Content-addressed freshness check: rebuild only if any refs/harness/* SHA changed.
      index.ensureFresh();

      const hits = index.search({
        query,
        source,
        limit: args.limit ? Number(args.limit) : 5,
      });

      if (hits.length === 0) {
        return { output: `No recall matches for "${query}".` };
      }

      const formatted = hits
        .map(
          (h, i) =>
            `${i + 1}. [${h.source}] ${h.sha.slice(0, 8)} (${h.ref} :: ${h.path}) — ${h.title}\n   ${h.snippet}`,
        )
        .join("\n");
      return { output: formatted };
    },
  };
}
