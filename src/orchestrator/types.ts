import type { Sha } from "../git-store/types.ts";
import type { ModelUsage } from "../runtime/types.ts";

export type SpawnContextMode = "fork" | "orphan";

export interface SpawnOptions {
  /** Unique identifier for this subagent (used as `refs/harness/agents/<agentId>`). */
  agentId: string;
  /** Parent session ref to fork from and eventually integrate back into. */
  parentSessionRef: string;
  /** `"fork"` inherits parent's context & KV-cache prefix; `"orphan"` starts clean (default: `"fork"`). */
  contextMode?: SpawnContextMode;
  /** Provision an isolated git worktree seeded with parent's current workspace (default: false). */
  isolateWorkspace?: boolean;
  /** Optional explicit worktree directory path (defaults to an isolated temp directory). */
  worktreePath?: string;
}

export interface SubagentHandle {
  agentId: string;
  ref: string;
  parentSessionRef: string;
  baseCommitSha: Sha | null;
  baseWorkspaceTree: Sha | null;
  workspaceRoot: string;
  isolatedWorktree: boolean;
}

export interface AgentRunnerContext {
  agentId: string;
  agentRef: string;
  workspaceRoot: string;
  isolatedWorktree: boolean;
  task: string;
  signal?: AbortSignal;
}

export interface AgentRunnerResult {
  tipSha: Sha;
  summary: string;
  exitCode?: number;
  usage?: ModelUsage;
  steps?: number;
  /** Whether the subagent finished normally or hit its step budget and synthesized partial progress. */
  stopReason?: "completed" | "max_steps";
}

/**
 * Narrow runner contract: native `AgentRuntime` loops AND external CLIs
 * (Claude Code, Codex, Pi, shell scripts) implement this exact same interface.
 */
export interface AgentRunner {
  readonly name: string;
  run(ctx: AgentRunnerContext): Promise<AgentRunnerResult>;
}

export interface WorkspaceDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface ReviewCheckResult {
  name: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface ReviewReport {
  agentId: string;
  tipSha: Sha;
  passed: boolean;
  checks: ReviewCheckResult[];
}

export interface ReviewGateContext {
  handle: SubagentHandle;
  tipSha: Sha;
  diff: WorkspaceDiff;
}

export interface ReviewGate {
  name: string;
  check(ctx: ReviewGateContext): Promise<{ passed: boolean; output: string }> | { passed: boolean; output: string };
}

export type IntegrateMode = "squash" | "cherry-pick" | "drop";

export interface IntegrateOptions {
  mode: IntegrateMode;
  /** Summary ingested into parent session (required for `squash` / `cherry-pick`). */
  summary?: string;
  /** Specific commit SHA to salvage when `mode === "cherry-pick"`. */
  commitSha?: Sha;
  /** Optional verification gates that MUST pass before merging into parent. */
  gates?: ReviewGate[];
  /** Apply file deltas from isolated worktree into parent workspace (default: true). */
  applyWorkspaceChanges?: boolean;
  /** Keep the agent ref after integration/drop (default: false for drop, true for squash/cherry-pick). */
  keepRef?: boolean;
  /** Optional archive ref (e.g. `refs/harness/archive/agents/<id>`) to preserve trace before deleting `handle.ref` on drop. */
  archiveAs?: string;
  /** Remove isolated worktree after integration/drop (default: true). */
  cleanupWorktree?: boolean;
}

export interface IntegrateResult {
  mode: IntegrateMode;
  integrated: boolean;
  mergeCommitSha?: Sha;
  review?: ReviewReport;
  diff?: WorkspaceDiff;
  conflictFiles?: string[];
  reason?: string;
}
