import type { Tool } from "../runtime/types.ts";
import { SubagentOrchestrator, commandGate } from "./orchestrator.ts";
import type { AgentRunner, SpawnContextMode } from "./types.ts";

export interface SubagentToolOptions {
  orchestrator: SubagentOrchestrator;
  /** Factory producing the `AgentRunner` (native runtime or external CLI) for each subagent invocation. */
  createRunner: (agentId: string) => AgentRunner;
  /** Default workspace isolation behavior (default: false for lightweight read-only subagents). */
  defaultIsolateWorkspace?: boolean;
  /** Optional skill loader for skill-scoped subagents (`subagent({ task, skills: "a,b" })`). */
  loadSkillBody?: (skillName: string) => string | null;
}

/**
 * Pluggable `subagent` Tool allowing a parent LLM to spawn an isolated Git-backed
 * subagent, optionally run a verification gate in its worktree, and squash-merge
 * (or drop) the result back into the parent session & workspace.
 *
 * Keeps Layer 2 (`runtime`) 100% decoupled from Layer 3 (`orchestrator`).
 */
export function createSubagentTool(options: SubagentToolOptions): Tool {
  let seq = 0;

  return {
    parallelSafe: true,
    schema: {
      name: "subagent",
      description:
        "Delegate a scoped subtask to an isolated Git-branched subagent (optionally in a separate git worktree with a verification command) and return its concise summary + diff.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Clear task instructions for the subagent" },
          agentId: { type: "string", description: "Optional short identifier (e.g. 'explore-auth')" },
          contextMode: {
            type: "string",
            description: "'fork' (inherit parent context, default) or 'orphan' (clean slate)",
          },
          isolateWorkspace: {
            type: "boolean",
            description: "Run in an isolated git worktree for code edits (default false)",
          },
          verifyCommand: {
            type: "string",
            description: "Optional shell command that must exit 0 inside the subagent workspace before merging",
          },
          dropOnComplete: {
            type: "boolean",
            description: "If true, archive the subagent branch without merging into parent session or workspace",
          },
          applyWorkspaceChanges: {
            type: "boolean",
            description:
              "When merging (dropOnComplete=false), whether to apply file edits to parent workspace (default true; set false for read-only research that still records DAG provenance)",
          },
          skills: {
            type: "string",
            description: "Optional comma-separated skill names to inject into this subagent's task context",
          },
        },
        required: ["task"],
      },
    },
    async execute(args, ctx) {
      let task = String(args.task ?? "").trim();
      if (!task) {
        return { output: "subagent error: 'task' must be non-empty", isError: true };
      }

      if (args.skills && options.loadSkillBody) {
        const names = (Array.isArray(args.skills) ? args.skills : String(args.skills).split(","))
          .map((s) => String(s).trim())
          .filter(Boolean);
        const blocks: string[] = [];
        for (const name of names) {
          const body = options.loadSkillBody(name);
          if (body) blocks.push(`## Skill: ${name}\n\n${body.trim()}`);
        }
        if (blocks.length > 0) {
          task = `${blocks.join("\n\n")}\n\n## Task\n\n${task}`;
        }
      }

      const rawId = args.agentId
        ? String(args.agentId).replace(/[^a-zA-Z0-9_-]/g, "-")
        : `sub-${Date.now()}-${++seq}`;
      const contextMode: SpawnContextMode = args.contextMode === "orphan" ? "orphan" : "fork";
      const isolateWorkspace =
        args.isolateWorkspace !== undefined
          ? Boolean(args.isolateWorkspace)
          : (options.defaultIsolateWorkspace ?? false);
      const verifyCommand = args.verifyCommand ? String(args.verifyCommand).trim() : "";
      const dropOnComplete = Boolean(args.dropOnComplete ?? false);
      const applyWorkspaceChanges =
        args.applyWorkspaceChanges !== undefined ? Boolean(args.applyWorkspaceChanges) : true;

      const handle = options.orchestrator.spawn({
        agentId: rawId,
        parentSessionRef: ctx.sessionRef,
        contextMode,
        isolateWorkspace,
      });

      try {
        const runner = options.createRunner(rawId);
        const runRes = await options.orchestrator.run(handle, task, runner, ctx.signal);
        const diff = options.orchestrator.diffHandle(handle, runRes.tipSha);
        const tipShort = runRes.tipSha.slice(0, 8);
        const truncNote =
          runRes.stopReason === "max_steps"
            ? `[status: reached maxSteps=${runRes.steps ?? "?"} — synthesized partial progress; inspect full trace via history({ action: "show", targetSha: "${tipShort}" }) or recall]`
            : "";

        if (dropOnComplete) {
          const archiveRef = `refs/harness/archive/agents/${rawId}`;
          await options.orchestrator.integrate(handle, {
            mode: "drop",
            archiveAs: archiveRef,
          });
          return {
            output: [
              `Subagent ${rawId} completed (archived at ${archiveRef}, tip=${tipShort}; inspect via history show ${tipShort} or recall):`,
              truncNote,
              runRes.summary,
            ]
              .filter(Boolean)
              .join("\n"),
            subagentUsage: runRes.usage,
            subagentSteps: runRes.steps,
          };
        }

        const gates = verifyCommand ? [commandGate("verify", verifyCommand)] : undefined;
        const intRes = await options.orchestrator.integrate(handle, {
          mode: "squash",
          summary: runRes.summary,
          gates,
          applyWorkspaceChanges,
        });

        if (!intRes.integrated) {
          options.orchestrator.cleanupHandleWorktree(handle);
          return {
            output: [
              `Subagent ${rawId} NOT merged (${intRes.reason ?? "rejected"}).`,
              truncNote,
              `Summary: ${runRes.summary}`,
              intRes.review
                ? `Verification output:\n${intRes.review.checks.map((c) => `- ${c.name}: ${c.passed ? "PASS" : "FAIL"} (${c.output})`).join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
            isError: true,
            subagentUsage: runRes.usage,
            subagentSteps: runRes.steps,
          };
        }

        const changed = [
          ...diff.added.map((f) => `+${f}`),
          ...diff.modified.map((f) => `~${f}`),
          ...diff.deleted.map((f) => `-${f}`),
        ];

        return {
          output: [
            `Subagent ${rawId} merged -> ${intRes.mergeCommitSha?.slice(0, 8) ?? "ok"} (source tip=${tipShort})`,
            truncNote,
            applyWorkspaceChanges
              ? changed.length > 0
                ? `Files: ${changed.join(", ")}`
                : "Files: (no workspace changes)"
              : "Files: (workspace changes skipped — provenance-only merge)",
            `Summary: ${runRes.summary}`,
          ]
            .filter(Boolean)
            .join("\n"),
          subagentUsage: runRes.usage,
          subagentSteps: runRes.steps,
        };
      } catch (err) {
        await options.orchestrator.integrate(handle, { mode: "drop" }).catch(() => {
          options.orchestrator.cleanupHandleWorktree(handle);
        });
        return { output: `subagent ${rawId} failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}
