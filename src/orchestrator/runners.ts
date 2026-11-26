import { execFile } from "node:child_process";
import { GitCliStore } from "../git-store/git-cli-store.ts";
import type { ObjectStore } from "../git-store/types.ts";
import { AgentRuntime, type AgentRuntimeOptions } from "../runtime/agent-loop.ts";
import { SessionStore } from "../session/session-store.ts";
import type { AgentRunner, AgentRunnerContext, AgentRunnerResult } from "./types.ts";

export interface RuntimeRunnerFactoryOptions
  extends Omit<AgentRuntimeOptions, "sessions" | "workspaceRoot"> {
  /**
   * Optional custom `ObjectStore` (reused directly when `!ctx.isolatedWorktree`, e.g.,
   * in-memory tests or detached `--git-dir` non-Git workspaces!).
   */
  store?: ObjectStore;
  /** Optional detached `GIT_DIR` forwarded when opening a fresh `GitCliStore`. */
  gitDir?: string;
  maxSteps?: number;
}

/**
 * Native runner that executes Layer 2 `AgentRuntime` inside the subagent's
 * assigned branch ref and workspace/worktree.
 */
export class RuntimeAgentRunner implements AgentRunner {
  public readonly name: string;
  private readonly options: RuntimeRunnerFactoryOptions;

  constructor(options: RuntimeRunnerFactoryOptions) {
    this.name = `runtime:${options.model.id}`;
    this.options = options;
  }

  async run(ctx: AgentRunnerContext): Promise<AgentRunnerResult> {
    const store =
      !ctx.isolatedWorktree && this.options.store
        ? this.options.store
        : new GitCliStore({
            repoRoot: ctx.workspaceRoot,
            gitDir: ctx.isolatedWorktree ? undefined : this.options.gitDir,
          });
    const sessions = new SessionStore(store);
    const runtime = new AgentRuntime({
      ...this.options,
      sessions,
      workspaceRoot: ctx.workspaceRoot,
    });

    const result = await runtime.runTurn({
      sessionRef: ctx.agentRef,
      userInput: ctx.task,
      agentId: ctx.agentId,
      maxSteps: this.options.maxSteps,
      signal: ctx.signal,
    });

    return {
      tipSha: result.commitSha,
      summary: result.assistantText,
      exitCode: 0,
      usage: result.usage,
      steps: result.steps,
      stopReason: result.stopReason,
    };
  }
}

export interface ExternalCliRunnerOptions {
  /** Human-readable name (e.g., `"claude-code"`, `"codex"`, `"custom-script"`). */
  name: string;
  /** Executable binary to invoke (e.g., `"claude"`, `"codex"`, `"/bin/sh"`). */
  command: string;
  /** Build CLI args from the task & context. */
  buildArgs: (ctx: AgentRunnerContext) => string[];
  /** Optional extra env vars. */
  env?: Record<string, string>;
  /** Execution timeout in ms (default: 300_000). */
  timeoutMs?: number;
  /** Optional `ObjectStore` override (defaults to `GitCliStore` at `ctx.workspaceRoot`). */
  store?: ObjectStore;
}

/**
 * Meta-harness runner (inspired by DeepSeek Harness `dsh`):
 * wraps any external CLI agent (Claude Code, Codex, Pi, custom scripts) inside
 * an isolated Git worktree and commits its stdout/stderr + resulting workspace
 * tree onto `refs/harness/agents/<id>`.
 */
export class ExternalCliRunner implements AgentRunner {
  public readonly name: string;
  private readonly opts: ExternalCliRunnerOptions;

  constructor(options: ExternalCliRunnerOptions) {
    this.name = options.name;
    this.opts = options;
  }

  async run(ctx: AgentRunnerContext): Promise<AgentRunnerResult> {
    const args = this.opts.buildArgs(ctx);
    const timeout = this.opts.timeoutMs ?? 300_000;

    const { stdout, stderr, exitCode } = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      execFile(
        this.opts.command,
        args,
        {
          cwd: ctx.workspaceRoot,
          env: { ...process.env, ...this.opts.env },
          timeout,
          maxBuffer: 32 * 1024 * 1024,
          signal: ctx.signal,
        },
        (error, out, err) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ stdout: out, stderr: err, exitCode: code });
        },
      );
    });

    const combined = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ""]
      .filter(Boolean)
      .join("\n\n");

    const store = this.opts.store ?? new GitCliStore({ repoRoot: ctx.workspaceRoot });
    const sessions = new SessionStore(store);

    const tipSha = sessions.commitTurn({
      sessionRef: ctx.agentRef,
      title: `external(${this.name}): ${ctx.task.slice(0, 60)}`,
      events: [
        { type: "message", message: { role: "user", content: ctx.task } },
        {
          type: "message",
          message: { role: "assistant", content: combined || `(exit ${exitCode})` },
        },
      ],
      metadata: {
        agentId: ctx.agentId,
        model: `external:${this.name}`,
      },
      snapshotWorkspace: true,
    });

    return {
      tipSha,
      summary: combined || `(external runner ${this.name} exited with code ${exitCode})`,
      exitCode,
    };
  }
}
