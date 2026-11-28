import type { SessionStore } from "../session/session-store.ts";
import type { PreToolContext, RuntimeHook } from "./types.ts";

export interface StuckLoopHookOptions {
  sessions: SessionStore;
  /** Consecutive failing bash/edit tool calls before injecting a Git recovery nudge (default: 4). */
  failureStreakThreshold?: number;
  /** Edits/writes to the same file inside `fileChurnWindow` before flagging edit oscillation (default: 6; 0 disables). */
  fileChurnThreshold?: number;
  /** Sliding window of recent edit/write operations tracked for file-churn detection (default: 15). */
  fileChurnWindow?: number;
  /** Fraction of `maxSteps` at which to inject a one-time wrap-up budget warning (default: 0.75; 0 disables). */
  budgetWarningRatio?: number;
  /** Optional wall-clock turn budget in milliseconds for time-budget wrap-up notices. */
  timeBudgetMs?: number;
  /** Fraction of `timeBudgetMs` at which to inject a one-time wall-clock wrap-up warning (default: 0.70; 0 disables). */
  timeWarningRatio?: number;
  /** Optional clock override for deterministic unit testing (defaults to `Date.now`). */
  now?: () => number;
  /** Whether the `subagent` tool is available in this session (default: true). */
  subagentsEnabled?: boolean;
}

/**
 * Lightweight `RuntimeHook` that detects:
 * 1. Consecutive failing edit/bash streaks,
 * 2. Repeated file-edit oscillation (editing the same file >= N times without converging,
 *    even when interleaved with exit-0 probe commands or continuing past `fileChurnWindow`),
 * 3. Approaching the turn step budget (>= 75% of `maxSteps`), and
 * 4. Approaching an optional wall-clock `timeBudgetMs` (>= 70% elapsed),
 * appending KV-cache-friendly Git recovery hints onto `tool_result` outputs.
 */
export function createStuckLoopHook(options: StuckLoopHookOptions): RuntimeHook {
  const failureThreshold = options.failureStreakThreshold ?? 4;
  const churnThreshold = options.fileChurnThreshold ?? 6;
  const churnWindow = options.fileChurnWindow ?? 15;
  const budgetRatio = options.budgetWarningRatio ?? 0.75;
  const timeBudgetMs = options.timeBudgetMs ?? 0;
  const timeWarningRatio = options.timeWarningRatio ?? 0.7;
  const now = options.now ?? (() => Date.now());
  const subagentsEnabled = options.subagentsEnabled ?? true;

  let failureStreak = 0;
  let lastCleanSha: string | null = null;
  let recentEditedPaths: string[] = [];
  const cumulativeEditsByPath = new Map<string, number>();
  let budgetWarnedTurn = false;
  let timeWarnedTurn = false;
  let turnStartMs = now();

  function resolveAnchorHint(sessionRef: string): string {
    const recent = options.sessions.logFirstParent(sessionRef, 20);
    const fallbackSha = recent.at(-1)?.sha ?? null;
    const anchor = (lastCleanSha ?? fallbackSha)?.slice(0, 8);
    const subagentSuffix = subagentsEnabled
      ? ", or spawn an 'orphan' subagent to rethink the root cause from first principles"
      : ", or reconsider your approach from first principles";
    return anchor
      ? `Last clean checkpoint: ${anchor}. Try history({ action: "diff", fromSha: "${anchor}" }), history({ action: "rewind", targetSha: "${anchor}" })${subagentSuffix}.`
      : subagentsEnabled
        ? `Try history({ action: "log" }) or spawn an 'orphan' subagent to diagnose the root cause with fresh eyes.`
        : `Try history({ action: "log" }) to inspect recent steps and rethink the root cause with fresh eyes.`;
  }

  return {
    name: "stuck-loop-detector",
    preTurn() {
      budgetWarnedTurn = false;
      timeWarnedTurn = false;
      turnStartMs = now();
    },
    postTool(ctx) {
      const notices: string[] = [];

      if (ctx.toolName === "subagent" || ctx.toolName === "history") {
        failureStreak = 0;
        recentEditedPaths = [];
        cumulativeEditsByPath.clear();
      } else if (ctx.toolName === "bash" || ctx.toolName === "edit" || ctx.toolName === "write") {
        // 1. Consecutive failure streak detector
        if (ctx.result.isError) {
          failureStreak++;
          if (failureThreshold > 0 && failureStreak >= failureThreshold && failureStreak % failureThreshold === 0) {
            notices.push(
              `[Harness Stuck-Loop Notice: ${failureStreak} consecutive failing edit/bash steps. ${resolveAnchorHint(ctx.sessionRef)}]`,
            );
          }
        } else if (ctx.toolName === "bash") {
          failureStreak = 0;
          lastCleanSha = options.sessions.logFirstParent(ctx.sessionRef, 1)[0]?.sha ?? lastCleanSha;
        }

        // 2. File-edit churn oscillation detector (tracks both sliding window & monotonic cumulative count
        //    so sustained edits past `churnWindow` never hit a modulo dead-zone!)
        if ((ctx.toolName === "edit" || ctx.toolName === "write") && churnThreshold > 0) {
          const targetPath = typeof ctx.args.path === "string" ? ctx.args.path.trim() : "";
          if (targetPath) {
            recentEditedPaths.push(targetPath);
            if (recentEditedPaths.length > churnWindow) {
              recentEditedPaths.shift();
            }
            const cumulative = (cumulativeEditsByPath.get(targetPath) ?? 0) + 1;
            cumulativeEditsByPath.set(targetPath, cumulative);
            const windowCount = recentEditedPaths.filter((p) => p === targetPath).length;
            if (windowCount >= churnThreshold && cumulative % churnThreshold === 0) {
              notices.push(
                `[Harness File-Churn Notice: '${targetPath}' has been modified ${cumulative} times (${windowCount} in the last ${recentEditedPaths.length} edits) without converging. Step back and inspect the root cause. ${resolveAnchorHint(ctx.sessionRef)}]`,
              );
            }
          }
        }
      }

      // 3. Step-budget warning (fires at most once per turn when crossing budgetWarningRatio)
      if (
        !budgetWarnedTurn &&
        budgetRatio > 0 &&
        ctx.step !== undefined &&
        ctx.maxSteps !== undefined &&
        ctx.maxSteps >= 4 &&
        ctx.step >= Math.floor(ctx.maxSteps * budgetRatio)
      ) {
        budgetWarnedTurn = true;
        const pct = Math.round((ctx.step / ctx.maxSteps) * 100);
        notices.push(
          `[Harness Budget Notice: step ${ctx.step}/${ctx.maxSteps} (${pct}% of step budget used). Prioritize verifying your current solution and wrapping up cleanly.]`,
        );
      }

      // 4. Wall-clock time-budget warning (fires at most once per turn when crossing timeWarningRatio)
      if (!timeWarnedTurn && timeBudgetMs > 0 && timeWarningRatio > 0) {
        const elapsedMs = Math.max(0, now() - turnStartMs);
        if (elapsedMs >= timeBudgetMs * timeWarningRatio) {
          timeWarnedTurn = true;
          const elapsedSec = Math.round(elapsedMs / 1000);
          const budgetSec = Math.round(timeBudgetMs / 1000);
          const pct = Math.min(100, Math.round((elapsedMs / timeBudgetMs) * 100));
          notices.push(
            `[Harness Time-Budget Notice: ${elapsedSec}s / ${budgetSec}s elapsed (${pct}% of wall-clock budget). Lock in your best verified solution now and avoid speculative long-running commands.]`,
          );
        }
      }

      if (notices.length > 0) {
        return {
          ...ctx.result,
          output: `${ctx.result.output}\n\n${notices.join("\n")}`,
        };
      }
    },
  };
}

export type ApprovalDecision =
  | boolean
  | "allow"
  | "deny"
  | "always"
  | { allow: boolean; always?: boolean; reason?: string };

export interface ApprovalHookOptions {
  /** Async interactive prompt / policy callback invoked before mutating or shell tool calls. */
  confirm: (ctx: PreToolContext) => Promise<ApprovalDecision> | ApprovalDecision;
  /** Tool names automatically approved without prompting (defaults to read-only tools: `read`, `recall`). */
  autoApproveTools?: string[];
  /** Custom predicate returning true when a tool call should bypass confirmation. */
  isReadOnlyCall?: (ctx: PreToolContext) => boolean;
}

const DEFAULT_AUTO_APPROVE_TOOLS = new Set(["read", "recall"]);

/**
 * Interactive Human-in-the-Loop (HITL) pre-effect approval hook (P0-8).
 * Auto-approves pure read-only tools (including non-rewind `history` inspection)
 * and prompts the user before `write`, `edit`, `bash`, `subagent`, `history(rewind)`, or MCP tools.
 */
export function createApprovalHook(options: ApprovalHookOptions): RuntimeHook {
  const allowedTools = new Set(options.autoApproveTools ?? [...DEFAULT_AUTO_APPROVE_TOOLS]);

  const isSafeReadOnly =
    options.isReadOnlyCall ??
    ((ctx: PreToolContext) => {
      if (allowedTools.has(ctx.toolName)) return true;
      if (ctx.toolName === "history" && ctx.args.action !== "rewind") return true;
      return false;
    });

  return {
    name: "interactive-approval",
    async preTool(ctx) {
      if (isSafeReadOnly(ctx)) {
        return { allow: true };
      }
      const decision = await options.confirm(ctx);
      if (decision === true || decision === "allow") {
        return { allow: true };
      }
      if (decision === "always") {
        allowedTools.add(ctx.toolName);
        return { allow: true };
      }
      if (decision === false || decision === "deny") {
        return { allow: false, reason: `User denied ${ctx.toolName}` };
      }
      if (decision.allow) {
        if (decision.always) allowedTools.add(ctx.toolName);
        return { allow: true };
      }
      return { allow: false, reason: decision.reason ?? `User denied ${ctx.toolName}` };
    },
  };
}
