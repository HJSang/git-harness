import type { Tool } from "../runtime/types.ts";
import { SessionStore } from "./session-store.ts";

/**
 * Compact Git-history traversal tool (`log`, `branches`, `diff`, `rewind`) so the
 * agent can inspect its own checkpoints, subagent lines, and workspace diffs — and
 * intentionally roll back workspace edits when stuck in a failing loop.
 */
export function createHistoryTool(sessions: SessionStore): Tool {
  return {
    schema: {
      name: "history",
      description:
        "Inspect Git session checkpoints, subagent branches (including archived subagents), commit event digests, and workspace diffs, or rewind workspace files to a known-good checkpoint.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "'log' | 'branches' | 'show' | 'diff' | 'rewind'",
          },
          limit: { type: "number", description: "Max commits for 'log' (default 12)" },
          fromSha: { type: "string", description: "Base commit SHA/prefix for 'diff'" },
          toSha: { type: "string", description: "Target commit SHA/prefix for 'diff' (defaults to current HEAD)" },
          targetSha: {
            type: "string",
            description: "Commit SHA/prefix or full refs/harness/... ref name for 'show' or 'rewind'",
          },
          tail: {
            type: "number",
            description: "Max recent turn events to include in 'show' digest (default 12)",
          },
        },
        required: ["action"],
      },
    },
    execute(args, ctx) {
      try {
        const action = String(args.action ?? "").trim();

        if (action === "log") {
          const limit = args.limit ? Number(args.limit) : 12;
          const recs = sessions.logFirstParent(ctx.sessionRef, limit);
          if (recs.length === 0) return { output: "(no checkpoints committed yet)" };
          const lines = recs.map((r) => {
            const pInfo = r.parents.length > 1 ? ` [merge:${r.parents.map((p) => p.slice(0, 7)).join(",")}]` : "";
            return `${r.sha.slice(0, 8)}  ${r.kind.padEnd(14)}  ${r.title}${pInfo}`;
          });
          return { output: lines.join("\n") };
        }

        if (action === "branches") {
          const refs = sessions.listSessions("refs/harness/");
          if (refs.length === 0) return { output: "(no harness refs)" };
          return {
            output: refs.map((r) => `${r.ref}  ${r.sha.slice(0, 8)}`).join("\n"),
          };
        }

        if (action === "show") {
          const rawTarget = String(args.targetSha ?? "").trim();
          if (!rawTarget) {
            return { output: "history show error: 'targetSha' is required", isError: true };
          }
          const resolved = sessions.resolveShortSha(rawTarget);
          const rec = sessions.readCommit(resolved);
          const tail = args.tail ? Math.max(1, Number(args.tail)) : 12;

          const header: string[] = [
            `Commit: ${rec.sha}`,
            `Kind: ${rec.kind}`,
            `Title: ${rec.title}`,
            `Parents: ${rec.parents.length > 0 ? rec.parents.map((p) => p.slice(0, 8)).join(", ") : "(root)"}`,
            `Workspace-Tree: ${rec.workspaceTree ? rec.workspaceTree.slice(0, 8) : "(none)"}`,
          ];
          const agentId = rec.trailers["Agent-Id"];
          const tokensIn = rec.trailers["Tokens-In"];
          if (agentId) header.push(`Agent-Id: ${agentId}`);
          if (tokensIn !== undefined) {
            header.push(
              `Tokens: in=${tokensIn} out=${rec.trailers["Tokens-Out"] ?? "0"} cache=${rec.trailers["Cache-Read"] ?? "0"}`,
            );
          }

          const sections: string[] = [header.join("\n")];
          if (rec.summary) {
            sections.push(`## Summary\n${rec.summary}`);
          }

          if (rec.events.length > 0) {
            const sliced = rec.events.slice(-tail);
            const skipped = rec.events.length - sliced.length;
            const digest = sliced.map((ev, i) => {
              const idx = skipped + i + 1;
              if (ev.type === "message") {
                const calls = ev.message.toolCalls?.length
                  ? ` [toolCalls: ${ev.message.toolCalls.map((tc) => tc.name).join(", ")}]`
                  : "";
                const body = ev.message.content.length > 600
                  ? `${ev.message.content.slice(0, 600)}…`
                  : ev.message.content;
                return `${idx}. [${ev.message.role}${calls}] ${body}`;
              }
              if (ev.type === "tool_call") {
                const argPreview = ev.arguments.length > 300 ? `${ev.arguments.slice(0, 300)}…` : ev.arguments;
                return `${idx}. [tool_call:${ev.name}] ${argPreview}`;
              }
              if (ev.type === "tool_result") {
                const outPreview = ev.output.length > 400 ? `${ev.output.slice(0, 400)}…` : ev.output;
                return `${idx}. [tool_result:${ev.name}${ev.isError ? " ERROR" : ""}] ${outPreview}`;
              }
              if (ev.type === "thinking") {
                const tPreview = ev.content.length > 240 ? `${ev.content.slice(0, 240)}…` : ev.content;
                return `${idx}. [thinking] ${tPreview}`;
              }
              return `${idx}. [note] ${ev.content}`;
            });
            sections.push(
              `## Events (showing last ${sliced.length} of ${rec.events.length})\n${digest.join("\n")}`,
            );
          }

          return { output: sections.join("\n\n") };
        }

        if (action === "diff") {
          const fromSha = String(args.fromSha ?? "").trim();
          if (!fromSha) return { output: "history diff error: 'fromSha' is required", isError: true };
          const toSha = args.toSha
            ? String(args.toSha).trim()
            : sessions.logFirstParent(ctx.sessionRef, 1)[0]?.sha;
          if (!toSha) return { output: "history diff error: session has no commits yet", isError: true };
          const d = sessions.diffCommits(fromSha, toSha);
          const parts = [
            ...d.added.map((f) => `+ ${f}`),
            ...d.modified.map((f) => `~ ${f}`),
            ...d.deleted.map((f) => `- ${f}`),
          ];
          return {
            output:
              parts.length > 0
                ? `Diff ${fromSha.slice(0, 8)}..${toSha.slice(0, 8)} (${parts.length} files):\n${parts.join("\n")}`
                : `No workspace file differences between ${fromSha.slice(0, 8)} and ${toSha.slice(0, 8)}.`,
          };
        }

        if (action === "rewind") {
          const rawTarget = String(args.targetSha ?? "").trim();
          if (!rawTarget) return { output: "history rewind error: 'targetSha' is required", isError: true };
          const resolved = sessions.resolveShortSha(rawTarget);
          const abandonedRef = `refs/harness/abandoned/agent-${Date.now()}`;
          const rec = sessions.rewind(ctx.sessionRef, resolved, {
            restoreWorkspace: true,
            preserveAbandonedAs: abandonedRef,
          });
          return {
            output: `Rewound workspace & session HEAD to ${rec.sha.slice(0, 8)} (${rec.title}). Previous attempt preserved at ${abandonedRef}.`,
          };
        }

        return {
          output: `Unknown history action "${action}" (expected log | branches | show | diff | rewind)`,
          isError: true,
        };
      } catch (err) {
        return { output: `history error: ${(err as Error).message}`, isError: true };
      }
    },
  };
}
