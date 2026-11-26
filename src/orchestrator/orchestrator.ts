import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitCliStore } from "../git-store/git-cli-store.ts";
import type { ObjectStore, Sha, TreeEntry, WorktreeStore } from "../git-store/types.ts";
import { SessionStore, agentRef } from "../session/session-store.ts";
import type {
  AgentRunner,
  AgentRunnerResult,
  IntegrateOptions,
  IntegrateResult,
  ReviewCheckResult,
  ReviewGate,
  ReviewReport,
  SpawnOptions,
  SubagentHandle,
  WorkspaceDiff,
} from "./types.ts";

export const REVIEW_NOTES_REF = "refs/notes/harness/reviews";

export interface SubagentOrchestratorOptions {
  store: ObjectStore;
  sessions: SessionStore;
  workspaceRoot: string;
  /** Optional worktree capability (automatically used when `store` implements `WorktreeStore`). */
  worktrees?: WorktreeStore;
}

function isWorktreeStore(store: unknown): store is WorktreeStore {
  return (
    typeof store === "object" &&
    store !== null &&
    typeof (store as WorktreeStore).addWorktree === "function" &&
    typeof (store as WorktreeStore).removeWorktree === "function"
  );
}

/**
 * Helper to create a shell-based `ReviewGate` (e.g., `commandGate("tests", "npm test")`).
 */
export function commandGate(name: string, command: string, timeoutMs = 120_000): ReviewGate {
  return {
    name,
    check(ctx) {
      return new Promise((resolve) => {
        execFile(
          "/bin/sh",
          ["-c", command],
          { cwd: ctx.handle.workspaceRoot, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
            resolve({
              passed: !error,
              output: output || (error ? error.message : "ok"),
            });
          },
        );
      });
    },
  };
}

/**
 * Layer 3 (`orchestrator`) — Git-native subagent lifecycle:
 * `spawn` (branch + optional isolated worktree) -> `run` (native or external meta-agent)
 * -> `review` (automated gates + git notes) -> `integrate` (`squash` | `cherry-pick` | `drop`).
 */
export class SubagentOrchestrator {
  private readonly store: ObjectStore;
  private readonly sessions: SessionStore;
  private readonly workspaceRoot: string;
  private readonly worktrees?: WorktreeStore;
  private readonly integrationLocks = new Map<string, Promise<void>>();

  constructor(options: SubagentOrchestratorOptions) {
    this.store = options.store;
    this.sessions = options.sessions;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.worktrees =
      options.worktrees ?? (isWorktreeStore(options.store) ? options.store : undefined);
  }

  /** Serialize workspace + parent ref integration per target session so parallel subagents never race on CAS refs. */
  private async withIntegrationLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.integrationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.integrationLocks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.integrationLocks.get(key) === chained) {
        this.integrationLocks.delete(key);
      }
    }
  }

  /**
   * Spawn a subagent on its own branch ref (`refs/harness/agents/<id>`) and optional
   * isolated Git worktree seeded with the parent's exact current workspace snapshot.
   */
  spawn(options: SpawnOptions): SubagentHandle {
    const ref = agentRef(options.agentId);
    const contextMode = options.contextMode ?? "fork";
    const parentHead = this.store.readRef(options.parentSessionRef);

    let baseCommitSha: Sha | null = null;
    if (contextMode === "fork" && parentHead) {
      baseCommitSha = this.sessions.fork(parentHead, ref);
    }

    const baseWorkspaceTree = this.store.snapshotWorkspace();

    let agentWorkspaceRoot = this.workspaceRoot;
    let isolatedWorktree = false;

    if (options.isolateWorkspace) {
      if (!this.worktrees) {
        throw new Error(
          "Cannot isolateWorkspace: underlying ObjectStore does not support WorktreeStore",
        );
      }
      let worktreeCommitish = this.store.readHostHead();
      if (!worktreeCommitish) {
        worktreeCommitish = this.store.commitTree({
          tree: baseWorkspaceTree,
          parents: [],
          message: "harness: base workspace snapshot for worktree\n\nHarness-Kind: checkpoint\n",
        });
        this.store.updateRef("refs/harness/base", worktreeCommitish);
      }
      const wtDir =
        options.worktreePath ??
        path.join(
          os.tmpdir(),
          `git-harness-wt-${options.agentId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        );
      this.worktrees.addWorktree(wtDir, worktreeCommitish);

      // Seed the worktree with parent's exact current working tree (including uncommitted edits!).
      const wtStore = new GitCliStore({ repoRoot: wtDir });
      wtStore.materializeWorkspace(baseWorkspaceTree);

      agentWorkspaceRoot = wtDir;
      isolatedWorktree = true;
    }

    return {
      agentId: options.agentId,
      ref,
      parentSessionRef: options.parentSessionRef,
      baseCommitSha,
      baseWorkspaceTree,
      workspaceRoot: agentWorkspaceRoot,
      isolatedWorktree,
    };
  }

  /** Execute any `AgentRunner` (native runtime or external CLI) on the spawned handle. */
  async run(
    handle: SubagentHandle,
    task: string,
    runner: AgentRunner,
    signal?: AbortSignal,
  ): Promise<AgentRunnerResult> {
    return runner.run({
      agentId: handle.agentId,
      agentRef: handle.ref,
      workspaceRoot: handle.workspaceRoot,
      isolatedWorktree: handle.isolatedWorktree,
      task,
      signal,
    });
  }

  /** Compute exact workspace file diff between a baseline tree and target commit/tree. */
  diffTrees(baseTree: Sha | null, targetTree: Sha | null): WorkspaceDiff {
    const baseMap = baseTree ? this.flattenTreeMap(baseTree) : new Map<string, Sha>();
    const targetMap = targetTree ? this.flattenTreeMap(targetTree) : new Map<string, Sha>();

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [file, sha] of targetMap.entries()) {
      const prev = baseMap.get(file);
      if (prev === undefined) added.push(file);
      else if (prev !== sha) modified.push(file);
    }
    for (const file of baseMap.keys()) {
      if (!targetMap.has(file)) deleted.push(file);
    }

    added.sort();
    modified.sort();
    deleted.sort();
    return { added, modified, deleted };
  }

  /** Diff a subagent's current tip workspace against its spawn baseline. */
  diffHandle(handle: SubagentHandle, commitSha?: Sha): WorkspaceDiff {
    const tip = commitSha ?? this.store.readRef(handle.ref);
    if (!tip) return { added: [], modified: [], deleted: [] };
    const rec = this.sessions.readCommit(tip);
    return this.diffTrees(handle.baseWorkspaceTree, rec.workspaceTree);
  }

  /**
   * Run automated verification gates against a subagent's output and attach the
   * structured review report as a Git note under `refs/notes/harness/reviews`.
   */
  async review(handle: SubagentHandle, gates: ReviewGate[], commitSha?: Sha): Promise<ReviewReport> {
    const tipSha = commitSha ?? this.store.readRef(handle.ref);
    if (!tipSha) {
      throw new Error(`Cannot review subagent ${handle.agentId}: no commits on ${handle.ref}`);
    }
    const diff = this.diffHandle(handle, tipSha);
    const checks: ReviewCheckResult[] = [];

    for (const gate of gates) {
      const t0 = performance.now();
      const res = await gate.check({ handle, tipSha, diff });
      checks.push({
        name: gate.name,
        passed: res.passed,
        output: res.output,
        durationMs: performance.now() - t0,
      });
    }

    const report: ReviewReport = {
      agentId: handle.agentId,
      tipSha,
      passed: checks.every((c) => c.passed),
      checks,
    };

    this.store.writeNote(REVIEW_NOTES_REF, tipSha, JSON.stringify(report, null, 2) + "\n");
    return report;
  }

  /**
   * Integrate a subagent back into its parent session & workspace (`squash` or `cherry-pick`)
   * or cleanly abort (`drop`) with zero parent context or workspace pollution (P0-9).
   */
  async integrate(handle: SubagentHandle, options: IntegrateOptions): Promise<IntegrateResult> {
    const cleanupWorktree = options.cleanupWorktree ?? true;

    if (options.mode === "drop") {
      if (options.archiveAs) {
        const tip = this.store.readRef(handle.ref);
        if (tip) {
          this.store.updateRef(options.archiveAs, tip);
        }
      }
      if (!(options.keepRef ?? false)) {
        this.store.deleteRef(handle.ref);
      }
      if (cleanupWorktree) {
        this.cleanupHandleWorktree(handle);
      }
      return { mode: "drop", integrated: false, reason: "dropped by coordinator" };
    }

    const sourceSha =
      options.mode === "cherry-pick"
        ? options.commitSha
        : this.store.readRef(handle.ref);

    if (!sourceSha) {
      throw new Error(
        options.mode === "cherry-pick"
          ? "cherry-pick mode requires options.commitSha"
          : `No commits found on subagent ref ${handle.ref}`,
      );
    }

    // 1. Run verification gates BEFORE mutating parent workspace or parent session.
    let reviewReport: ReviewReport | undefined;
    if (options.gates && options.gates.length > 0) {
      reviewReport = await this.review(handle, options.gates, sourceSha);
      if (!reviewReport.passed) {
        return {
          mode: options.mode,
          integrated: false,
          review: reviewReport,
          reason: `Verification gate(s) failed: ${reviewReport.checks
            .filter((c) => !c.passed)
            .map((c) => c.name)
            .join(", ")}`,
        };
      }
    }

    // 2-4. Serialize delta conflict-check + workspace apply + parent CAS squashMerge per parentSessionRef.
    return this.withIntegrationLock(handle.parentSessionRef, () => {
      // 2. Compute exact workspace delta to apply.
      const sourceRec = this.sessions.readCommit(sourceSha);
      const deltaBaseTree =
        options.mode === "cherry-pick" && sourceRec.parents[0]
          ? this.sessions.readCommit(sourceRec.parents[0]).workspaceTree
          : handle.baseWorkspaceTree;

      const diff = this.diffTrees(deltaBaseTree, sourceRec.workspaceTree);
      const hasFileChanges =
        diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;

      // 3. Apply file deltas safely into parent workspace (with conflict detection!).
      if ((options.applyWorkspaceChanges ?? true) && handle.isolatedWorktree && hasFileChanges) {
        const parentCurrentTree = this.store.snapshotWorkspace();
        const conflictFiles = this.detectWorkspaceConflicts(
          deltaBaseTree,
          parentCurrentTree,
          sourceRec.workspaceTree,
          diff,
        );
        if (conflictFiles.length > 0) {
          return {
            mode: options.mode,
            integrated: false,
            review: reviewReport,
            diff,
            conflictFiles,
            reason: `Workspace merge conflict on ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
          };
        }

        if (sourceRec.workspaceTree) {
          this.applyWorkspaceDelta(sourceRec.workspaceTree, diff);
        }
      }

      // 4. Squash-merge distilled summary into parent session ref (preserving parent KV-cache prefix + full subagent trace on parent2).
      const summary = options.summary ?? sourceRec.summary ?? sourceRec.title;
      const mergeCommitSha = this.sessions.squashMerge({
        targetSessionRef: handle.parentSessionRef,
        sourceRef: sourceSha,
        summary,
        title: `${options.mode}(${handle.agentId}): ${summary.slice(0, 56)}`,
        snapshotWorkspace: true,
        metadata: { agentId: handle.agentId },
      });

      if (!(options.keepRef ?? true)) {
        this.store.deleteRef(handle.ref);
      }
      if (cleanupWorktree) {
        this.cleanupHandleWorktree(handle);
      }

      return {
        mode: options.mode,
        integrated: true,
        mergeCommitSha,
        review: reviewReport,
        diff,
      };
    });
  }

  /** Remove an isolated worktree created for `handle` (safe no-op if not isolated). */
  cleanupHandleWorktree(handle: SubagentHandle): void {
    if (!handle.isolatedWorktree || !this.worktrees) return;
    if (fs.existsSync(handle.workspaceRoot)) {
      this.worktrees.removeWorktree(handle.workspaceRoot, true);
    }
  }

  private detectWorkspaceConflicts(
    baseTree: Sha | null,
    parentCurrentTree: Sha,
    subagentTree: Sha | null,
    subDiff: WorkspaceDiff,
  ): string[] {
    const baseMap = baseTree ? this.flattenTreeMap(baseTree) : new Map<string, Sha>();
    const parentMap = this.flattenTreeMap(parentCurrentTree);
    const subMap = subagentTree ? this.flattenTreeMap(subagentTree) : new Map<string, Sha>();

    const conflicts: string[] = [];
    const touched = [...subDiff.added, ...subDiff.modified, ...subDiff.deleted];

    for (const file of touched) {
      const baseSha = baseMap.get(file);
      const parentSha = parentMap.get(file);
      const subSha = subMap.get(file);
      // Conflict if parent changed this file relative to base AND to a different content than subagent.
      if (parentSha !== baseSha && parentSha !== subSha) {
        conflicts.push(file);
      }
    }
    return conflicts;
  }

  private applyWorkspaceDelta(sourceTreeSha: Sha, diff: WorkspaceDiff): void {
    for (const rel of [...diff.added, ...diff.modified]) {
      const entry = this.store.resolvePath(sourceTreeSha, rel);
      if (!entry || entry.type !== "blob") continue;
      const bytes = this.store.readBlob(entry.sha);
      const abs = path.join(this.workspaceRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      if (entry.mode === "100755") {
        fs.chmodSync(abs, 0o755);
      }
    }
    for (const rel of diff.deleted) {
      const abs = path.join(this.workspaceRoot, rel);
      fs.rmSync(abs, { force: true });
    }
  }

  private flattenTreeMap(treeSha: Sha, prefix = "", out = new Map<string, Sha>()): Map<string, Sha> {
    const entries: TreeEntry[] = this.store.readTree(treeSha);
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === "tree") {
        this.flattenTreeMap(e.sha, rel, out);
      } else {
        out.set(rel, e.sha);
      }
    }
    return out;
  }
}
