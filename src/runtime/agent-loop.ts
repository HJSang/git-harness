import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Sha } from "../git-store/types.ts";
import type { SessionStore } from "../session/session-store.ts";
import type { Message, TurnEvent } from "../session/types.ts";
import { createCoreTools } from "./tools.ts";
import type {
  ModelAdapter,
  ModelUsage,
  RunTurnInput,
  RunTurnResult,
  RuntimeEvent,
  RuntimeHook,
  StepProfileEntry,
  Tool,
  ToolCallProfile,
} from "./types.ts";

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a concise, precise software engineering agent operating inside a Git-backed harness.",
  "Use the provided tools (read, write, edit, bash) to inspect files, apply minimal edits, and verify changes with tests.",
  "Large tool outputs may be offloaded to Git blobs ('blob://<sha>'); inspect specific line ranges via read({ path: 'blob://<sha>', startLine, endLine }).",
  "When available, use 'subagent' for isolated exploration or independent verification before finalizing.",
  "Never fabricate file contents or command outputs.",
].join(" ");

const COMPACTION_PROMPT = [
  "Produce a dense, structured checkpoint summary of this session so work can continue without losing critical state.",
  "Include exact sections:",
  "1. Goal & constraints (all user requirements and non-negotiables)",
  "2. Current state (files read/modified, exact symbols/paths)",
  "3. Verified facts & test outcomes",
  "4. Rejected approaches / dead ends (so we do not repeat them)",
  "5. Next concrete steps",
].join("\n");

const MAX_STEPS_SYNTHESIS_PROMPT = [
  "[Harness Notice: Step budget reached — tools are now disabled.]",
  "Do NOT narrate future actions. Immediately synthesize a complete, concrete handoff of everything discovered or produced so far:",
  "- Exact values, equations, constants, root causes, or verified results",
  "- Exact file paths created or modified (including any /tmp prototypes)",
  "- What remains unfinished, if anything",
].join("\n");

export interface AgentRuntimeOptions {
  sessions: SessionStore;
  model: ModelAdapter;
  workspaceRoot: string;
  /** Defaults to Pi-style 4-tool core (`read`, `write`, `edit`, `bash`). */
  tools?: Tool[];
  /** Defaults to concise system prompt (< 1,500 tokens combined with core tool schemas). */
  systemPrompt?: string;
  hooks?: RuntimeHook[];
  onEvent?: (event: RuntimeEvent) => void;
  /** Optional callback receiving per-step latency, token/cache, and Git checkpoint metrics. */
  onProfile?: (entry: StepProfileEntry) => void;
  /** Optional NDJSON file path to append `StepProfileEntry` rows for offline profiling. */
  profileLogPath?: string;
  /** Default max model->tool iterations per turn (default: 16). */
  defaultMaxSteps?: number;
  /** Default intra-turn checkpoint interval in steps (0 = commit once at end of turn). */
  defaultCheckpointEverySteps?: number;
  /** Optional input-token threshold to automatically create a dual-parent compaction anchor. */
  autoCompactThresholdTokens?: number;
  /**
   * Optional byte threshold above which noisy tool outputs (e.g. `bash`) are stored as immutable
   * Git blobs (`blob://<sha>`) and replaced in active context with a head+tail preview (0 = disabled).
   */
  offloadOutputThresholdBytes?: number;
  /**
   * Separate, higher threshold for explicit `read` tool calls so medium source files (9–24 KB)
   * are not prematurely offloaded (defaults to `max(32768, offloadOutputThresholdBytes * 4)`).
   */
  readOffloadThresholdBytes?: number;
  /**
   * Execute contiguous read-only / parallel-safe tool calls (`read`, `recall`, `subagent`)
   * concurrently via `Promise.all` while keeping host-workspace mutations ordered (default: true).
   */
  parallelToolCalls?: boolean;
  /** Default streaming mode for model text/thinking deltas via `RuntimeEvent` (default: false). */
  stream?: boolean;
  /**
   * When `maxSteps` is hit mid-tool-loop, run one final no-tool synthesis call
   * so callers receive a complete handoff instead of pre-tool narration (default: true).
   */
  synthesizeOnMaxSteps?: boolean;
}

function mergeUsage(acc: ModelUsage, next?: ModelUsage): ModelUsage {
  if (!next) return acc;
  return {
    tokensIn: (acc.tokensIn ?? 0) + (next.tokensIn ?? 0),
    tokensOut: (acc.tokensOut ?? 0) + (next.tokensOut ?? 0),
    cacheRead: (acc.cacheRead ?? 0) + (next.cacheRead ?? 0),
  };
}

/**
 * Layer 2 (`runtime`) — Minimal model <-> tool loop with synchronous pre-effect
 * hook interception, deterministic KV-cache-preserving projection, intra-turn
 * Git checkpointing & auto-compaction, and step-level profiling telemetry.
 */
export class AgentRuntime {
  private readonly sessions: SessionStore;
  private model: ModelAdapter;
  private readonly workspaceRoot: string;
  private readonly toolsByName = new Map<string, Tool>();
  private readonly systemPrompt: string;
  private readonly hooks: RuntimeHook[];
  private readonly onEvent?: (event: RuntimeEvent) => void;
  private readonly onProfile?: (entry: StepProfileEntry) => void;
  private readonly profileLogPath?: string;
  private readonly defaultMaxSteps: number;
  private readonly defaultCheckpointEverySteps: number;
  private readonly autoCompactThresholdTokens?: number;
  private readonly offloadOutputThresholdBytes: number;
  private readonly readOffloadThresholdBytes: number;
  private readonly parallelToolCalls: boolean;
  private readonly stream: boolean;
  private readonly synthesizeOnMaxSteps: boolean;

  constructor(options: AgentRuntimeOptions) {
    this.sessions = options.sessions;
    this.model = options.model;
    this.workspaceRoot = options.workspaceRoot;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.hooks = options.hooks ? [...options.hooks] : [];
    this.onEvent = options.onEvent;
    this.onProfile = options.onProfile;
    this.profileLogPath = options.profileLogPath;
    this.defaultMaxSteps = options.defaultMaxSteps ?? 16;
    this.defaultCheckpointEverySteps = options.defaultCheckpointEverySteps ?? 0;
    this.autoCompactThresholdTokens = options.autoCompactThresholdTokens;
    this.offloadOutputThresholdBytes = options.offloadOutputThresholdBytes ?? 0;
    this.readOffloadThresholdBytes =
      options.readOffloadThresholdBytes ??
      (this.offloadOutputThresholdBytes > 0
        ? Math.max(32_768, this.offloadOutputThresholdBytes * 4)
        : 0);
    this.parallelToolCalls = options.parallelToolCalls ?? true;
    this.stream = options.stream ?? false;
    this.synthesizeOnMaxSteps = options.synthesizeOnMaxSteps ?? true;

    for (const tool of options.tools ??
      createCoreTools({
        readBlob: (sha) => this.sessions.readBlob(sha),
        readCommitFile: (sha, p) => this.sessions.readCommitFile(sha, p),
      })) {
      this.toolsByName.set(tool.schema.name, tool);
    }
  }

  /** Swap the underlying LLM adapter seamlessly mid-session (P0-3 / model portability). */
  setModel(model: ModelAdapter): void {
    this.model = model;
  }

  getModel(): ModelAdapter {
    return this.model;
  }

  /** Expose Turn-0 prompt + tool schemas for auditing prompt tax (P0-7). */
  getPromptOverheadSpec(): {
    systemPrompt: string;
    toolSchemas: ReturnType<AgentRuntime["getToolSchemas"]>;
  } {
    return {
      systemPrompt: this.systemPrompt,
      toolSchemas: this.getToolSchemas(),
    };
  }

  getToolSchemas() {
    return [...this.toolsByName.values()].map((t) => t.schema);
  }

  /**
   * Run one user turn (potentially spanning many model <-> tool steps),
   * optionally flushing intra-turn co-atomic Git checkpoints and auto-compacting
   * mid-turn when token pressure crosses `autoCompactThresholdTokens`.
   */
  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.emit({ type: "turn_start", sessionRef: input.sessionRef, userInput: input.userInput });

    const projStart = performance.now();
    let baseMessages: Message[];
    try {
      baseMessages = this.sessions.project(input.sessionRef, {
        systemPrompt: this.systemPrompt,
      }).messages;
    } catch {
      baseMessages = this.systemPrompt ? [{ role: "system", content: this.systemPrompt }] : [];
    }
    const initialProjectMs = performance.now() - projStart;

    const userMsg: Message = { role: "user", content: input.userInput };
    let workingMessages: Message[] = [...baseMessages, userMsg];

    for (const hook of this.hooks) {
      await hook.preTurn?.({
        sessionRef: input.sessionRef,
        userInput: input.userInput,
        messages: workingMessages,
      });
    }

    const allTurnEvents: TurnEvent[] = [{ type: "message", message: userMsg }];
    let pendingEvents: TurnEvent[] = [{ type: "message", message: userMsg }];
    let pendingUsage: ModelUsage = {};

    const maxSteps = input.maxSteps ?? this.defaultMaxSteps;
    const checkpointEvery = input.checkpointEverySteps ?? this.defaultCheckpointEverySteps;
    const toolSchemas = this.getToolSchemas();

    let totalUsage: ModelUsage = {};
    let lastStepTokensIn = 0;
    let steps = 0;
    let toolCallsExecuted = 0;
    let finalAssistantText = "";
    let lastCommitSha: Sha | null = null;
    let lastWorkspaceTree: Sha | null = null;
    let checkpointsCommitted = 0;
    let lastCompactedAnchorSha: Sha | undefined;

    const flushCheckpoint = (
      label: string,
      mayHaveMutatedWorkspace: boolean,
    ): { sha: Sha; elapsedMs: number; workspaceTree: Sha | null; changed: boolean } => {
      const t0 = performance.now();
      const shouldSnap =
        (input.snapshotWorkspace ?? true) &&
        (mayHaveMutatedWorkspace || (checkpointsCommitted === 0 && lastWorkspaceTree === null));
      const sha = this.sessions.commitTurn({
        sessionRef: input.sessionRef,
        title: label,
        events: pendingEvents,
        state: input.state,
        snapshotWorkspace: shouldSnap,
        metadata: {
          agentId: input.agentId ?? "root",
          model: this.model.id,
          tokensIn: pendingUsage.tokensIn,
          tokensOut: pendingUsage.tokensOut,
          cacheRead: pendingUsage.cacheRead,
        },
      });
      const elapsedMs = performance.now() - t0;
      const rec = this.sessions.readCommit(sha);
      const changed = lastWorkspaceTree !== null ? rec.workspaceTree !== lastWorkspaceTree : true;
      lastWorkspaceTree = rec.workspaceTree;
      lastCommitSha = sha;
      pendingEvents = [];
      pendingUsage = {};
      checkpointsCommitted++;
      this.emit({ type: "turn_committed", sessionRef: input.sessionRef, commitSha: sha });
      return { sha, elapsedMs, workspaceTree: rec.workspaceTree, changed };
    };

    let pendingMayMutate = false;
    let completedNormally = false;
    let maxTokensContinuations = 0;
    const MAX_INLINE_IMAGES_PER_WINDOW = 4;
    let inlineImagesInWindow = workingMessages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    const shouldSynthesizeOnMaxSteps = input.synthesizeOnMaxSteps ?? this.synthesizeOnMaxSteps;

    while (steps < maxSteps) {
      steps++;
      const stepProjectMs = steps === 1 ? initialProjectMs : 0;
      const promptMessageCount = workingMessages.length;

      const shouldStream = input.stream ?? this.stream;
      const modelStart = performance.now();
      const response = await this.model.complete({
        messages: workingMessages,
        tools: toolSchemas,
        signal: input.signal,
        onDelta: shouldStream
          ? (delta) => {
              this.emit(
                delta.type === "thinking"
                  ? { type: "thinking_delta", step: steps, text: delta.text }
                  : { type: "text_delta", step: steps, text: delta.text },
              );
            }
          : undefined,
      });
      const modelLatencyMs = performance.now() - modelStart;

      totalUsage = mergeUsage(totalUsage, response.usage);
      pendingUsage = mergeUsage(pendingUsage, response.usage);
      if (response.usage?.tokensIn !== undefined) {
        lastStepTokensIn = response.usage.tokensIn;
      }

      this.emit({
        type: "model_response",
        step: steps,
        content: response.content,
        toolCallCount: response.toolCalls.length,
        usage: response.usage,
      });

      if (response.thinking) {
        const thinkingEv: TurnEvent = { type: "thinking", content: response.thinking };
        allTurnEvents.push(thinkingEv);
        pendingEvents.push(thinkingEv);
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: response.content,
        ...(response.thinking ? { thinking: response.thinking } : {}),
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      };

      workingMessages.push(assistantMsg);
      const assistantEv: TurnEvent = { type: "message", message: assistantMsg };
      allTurnEvents.push(assistantEv);
      pendingEvents.push(assistantEv);
      finalAssistantText = response.content;

      const toolProfiles: ToolCallProfile[] = [];
      const toolsStart = performance.now();

      type PreparedCall = {
        tc: (typeof response.toolCalls)[number];
        parsedArgs: Record<string, unknown>;
        parseError: string | null;
        tool?: Tool;
        toolOffloadThreshold: number;
        canRunParallel: boolean;
      };

      const prepared: PreparedCall[] = response.toolCalls.map((tc) => {
        let parsedArgs: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const parsed = JSON.parse(tc.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedArgs = parsed as Record<string, unknown>;
          } else {
            parseError = "Tool arguments must be a JSON object";
          }
        } catch (err) {
          parseError = `Invalid JSON tool arguments: ${(err as Error).message}`;
        }
        const tool = this.toolsByName.get(tc.name);
        let toolOffloadThreshold =
          tc.name === "read" ? this.readOffloadThresholdBytes : this.offloadOutputThresholdBytes;
        if (tool?.offloadThresholdBytes !== undefined) {
          toolOffloadThreshold = tool.offloadThresholdBytes;
        }
        const canRunParallel =
          this.parallelToolCalls && Boolean(tool && (tool.parallelSafe ?? tool.readOnly));
        return { tc, parsedArgs, parseError, tool, toolOffloadThreshold, canRunParallel };
      });

      // Partition into order-preserving execution waves:
      // contiguous parallel-safe calls (`read`, `recall`, `subagent`) run via `Promise.all`,
      // while host-workspace mutating calls (`write`, `edit`, `bash`, `history`) act as barriers.
      const waves: PreparedCall[][] = [];
      for (const item of prepared) {
        const lastWave = waves.at(-1);
        if (item.canRunParallel && lastWave && lastWave[0]!.canRunParallel) {
          lastWave.push(item);
        } else {
          waves.push([item]);
        }
      }

      for (const wave of waves) {
        type AuthorizedItem = PreparedCall & {
          blocked: boolean;
          blockedReason: string | null;
          preResult?: {
            output: string;
            isError?: boolean;
            subagentUsage?: ModelUsage;
            subagentSteps?: number;
          };
        };

        // 1. Run `preTool` hooks synchronously in program order (keeps approvals & policies deterministic).
        const authorized: AuthorizedItem[] = [];
        for (const item of wave) {
          const tcEv: TurnEvent = {
            type: "tool_call",
            id: item.tc.id,
            name: item.tc.name,
            arguments: item.tc.arguments,
          };
          allTurnEvents.push(tcEv);
          pendingEvents.push(tcEv);

          if (item.parseError) {
            authorized.push({
              ...item,
              blocked: false,
              blockedReason: null,
              preResult: { output: item.parseError, isError: true },
            });
            continue;
          }
          if (!item.tool) {
            authorized.push({
              ...item,
              blocked: false,
              blockedReason: null,
              preResult: { output: `Unknown tool: ${item.tc.name}`, isError: true },
            });
            continue;
          }

          let args = item.parsedArgs;
          let blockedReason: string | null = null;
          for (const hook of this.hooks) {
            if (!hook.preTool) continue;
            const decision = await hook.preTool({
              sessionRef: input.sessionRef,
              toolName: item.tc.name,
              args,
              workspaceRoot: this.workspaceRoot,
            });
            if (!decision.allow) {
              blockedReason = decision.reason ?? `Blocked by hook ${hook.name ?? "unnamed"}`;
              break;
            }
            if (decision.args) {
              args = decision.args;
            }
          }

          if (blockedReason !== null) {
            this.emit({ type: "tool_blocked", toolName: item.tc.name, reason: blockedReason });
            authorized.push({
              ...item,
              parsedArgs: args,
              blocked: true,
              blockedReason,
              preResult: { output: `Blocked by policy: ${blockedReason}`, isError: true },
            });
          } else {
            if (!item.tool.readOnly) {
              pendingMayMutate = true;
            }
            authorized.push({ ...item, parsedArgs: args, blocked: false, blockedReason: null });
          }
        }

        // 2. Execute allowed calls (concurrently if wave has > 1 parallel-safe calls).
        const executed = await Promise.all(
          authorized.map(async (item) => {
            const tcStart = performance.now();
            if (item.preResult) {
              return { item, result: item.preResult, executedTool: false, durationMs: performance.now() - tcStart };
            }
            this.emit({ type: "tool_start", toolName: item.tc.name, args: item.parsedArgs });
            const result = await item.tool!.execute(item.parsedArgs, {
              workspaceRoot: this.workspaceRoot,
              sessionRef: input.sessionRef,
              signal: input.signal,
            });
            return { item, result, executedTool: true, durationMs: performance.now() - tcStart };
          }),
        );

        // 3. Finalize `postTool` hooks, blob offloading, events, and messages in EXACT original call order!
        for (const entry of executed) {
          const { item } = entry;
          let result = entry.result;

          if (entry.executedTool) {
            toolCallsExecuted++;
            for (const hook of this.hooks) {
              if (!hook.postTool) continue;
              const modified = await hook.postTool({
                sessionRef: input.sessionRef,
                toolName: item.tc.name,
                args: item.parsedArgs,
                result,
                step: steps,
                maxSteps,
              });
              if (modified) result = modified;
            }
            this.emit({
              type: "tool_end",
              toolName: item.tc.name,
              isError: Boolean(result.isError),
              outputPreview: result.output.slice(0, 120),
            });
          }

          // Optional Git-blob offloading for oversized tool outputs (keeps active window lean & lossless!)
          const rawOutputBytes = Buffer.byteLength(result.output, "utf8");
          let offloadedBlobSha: Sha | undefined;
          let promptOutput = result.output;
          const alreadyReadingBlob =
            item.tc.name === "read" &&
            typeof item.parsedArgs.path === "string" &&
            item.parsedArgs.path.startsWith("blob://");

          if (
            item.toolOffloadThreshold > 0 &&
            !alreadyReadingBlob &&
            rawOutputBytes > item.toolOffloadThreshold
          ) {
            offloadedBlobSha = this.sessions.writeBlob(result.output);
            const previewBudget = Math.max(1024, Math.floor(item.toolOffloadThreshold * 0.45));
            const head = result.output.slice(0, previewBudget);
            const tail = result.output.slice(-Math.floor(previewBudget * 0.6));
            const lineCount = result.output.split("\n").length;
            promptOutput =
              `${head}\n\n` +
              `... [offloaded ${rawOutputBytes} bytes (${lineCount} lines) to Git blob://${offloadedBlobSha} — use read({ path: "blob://${offloadedBlobSha}", startLine, endLine }) for exact middle lines] ...\n\n` +
              tail;
          }

          toolProfiles.push({
            name: item.tc.name,
            durationMs: entry.durationMs,
            outputBytes: rawOutputBytes,
            offloadedBlobSha,
            subagentUsage: result.subagentUsage,
            subagentSteps: result.subagentSteps,
            isError: Boolean(result.isError),
            blocked: item.blocked || undefined,
          });

          const trEv: TurnEvent = {
            type: "tool_result",
            id: item.tc.id,
            name: item.tc.name,
            output: promptOutput,
            isError: result.isError,
          };
          allTurnEvents.push(trEv);
          pendingEvents.push(trEv);

          let attachedImages = result.images;
          if (attachedImages && attachedImages.length > 0) {
            if (inlineImagesInWindow + attachedImages.length > MAX_INLINE_IMAGES_PER_WINDOW) {
              attachedImages = undefined;
              promptOutput = `${promptOutput}\n[Harness Notice: inline image budget (${MAX_INLINE_IMAGES_PER_WINDOW}) reached for the current context window; analyze remaining images programmatically (e.g., Python/PIL/OpenCV) to avoid prompt bloat.]`;
            } else {
              inlineImagesInWindow += attachedImages.length;
            }
          }
          const toolMsg: Message = {
            role: "tool",
            name: item.tc.name,
            toolCallId: item.tc.id,
            content: promptOutput,
            ...(attachedImages && attachedImages.length > 0 ? { images: attachedImages } : {}),
          };
          workingMessages.push(toolMsg);
          const toolMsgEv: TurnEvent = { type: "message", message: toolMsg };
          allTurnEvents.push(toolMsgEv);
          pendingEvents.push(toolMsgEv);
        }
      }

      const toolsLatencyMs = performance.now() - toolsStart;
      const willContinueAfterMaxTokens =
        response.toolCalls.length === 0 &&
        response.stopReason === "max_tokens" &&
        maxTokensContinuations < 2 &&
        steps < maxSteps &&
        !input.signal?.aborted;
      const isFinalStep =
        (response.toolCalls.length === 0 && !willContinueAfterMaxTokens) || steps >= maxSteps;
      const shouldAutoCompactNow =
        this.autoCompactThresholdTokens !== undefined &&
        lastStepTokensIn >= this.autoCompactThresholdTokens;
      const shouldFlushNow =
        isFinalStep ||
        shouldAutoCompactNow ||
        (checkpointEvery > 0 && steps % checkpointEvery === 0);

      let gitCheckpointMs = 0;
      let checkpointSha: Sha | undefined;
      let workspaceTreeSha: Sha | null | undefined;
      let workspaceChanged: boolean | undefined;
      let stepCompactedAnchorSha: Sha | undefined;

      if (shouldFlushNow && pendingEvents.length > 0) {
        const label =
          checkpointEvery > 0
            ? `${(input.title ?? input.userInput).slice(0, 56)} [step ${steps}]`
            : (input.title ?? input.userInput).slice(0, 72);
        const flushed = flushCheckpoint(label, pendingMayMutate);
        pendingMayMutate = false;
        gitCheckpointMs = flushed.elapsedMs;
        checkpointSha = flushed.sha;
        workspaceTreeSha = flushed.workspaceTree;
        workspaceChanged = flushed.changed;
      }

      if (shouldAutoCompactNow) {
        stepCompactedAnchorSha = await this.compactSession(input.sessionRef);
        lastCompactedAnchorSha = stepCompactedAnchorSha;
        // Re-project compacted anchor into active workingMessages if continuing the turn!
        if (!isFinalStep) {
          workingMessages = this.sessions.project(input.sessionRef, {
            systemPrompt: this.systemPrompt,
          }).messages;
          inlineImagesInWindow = workingMessages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
        }
      }

      const tokensIn = response.usage?.tokensIn;
      const cacheRead = response.usage?.cacheRead;
      const cacheHitRate =
        tokensIn && tokensIn > 0 && cacheRead !== undefined ? cacheRead / tokensIn : undefined;

      this.recordProfile({
        timestamp: new Date().toISOString(),
        sessionRef: input.sessionRef,
        step: steps,
        model: this.model.id,
        modelLatencyMs: Number(modelLatencyMs.toFixed(2)),
        toolsLatencyMs: Number(toolsLatencyMs.toFixed(2)),
        gitCheckpointMs: Number(gitCheckpointMs.toFixed(2)),
        projectMs: Number(stepProjectMs.toFixed(2)),
        tokensIn,
        tokensOut: response.usage?.tokensOut,
        cacheRead,
        cacheHitRate: cacheHitRate !== undefined ? Number(cacheHitRate.toFixed(4)) : undefined,
        promptMessages: promptMessageCount,
        stopReason: response.stopReason,
        toolCalls: toolProfiles,
        checkpointSha,
        workspaceTreeSha,
        workspaceChanged,
        compactedAnchorSha: stepCompactedAnchorSha,
      });

      if (willContinueAfterMaxTokens) {
        maxTokensContinuations++;
        const contMsg: Message = {
          role: "user",
          content:
            "[Harness Notice: Your previous response hit max_tokens before emitting a tool call or final answer. Keep reasoning concise and immediately emit your next concrete tool call (splitting large files into smaller writes or scripts) or provide your final verified summary.]",
        };
        workingMessages.push(contMsg);
        const contEv: TurnEvent = { type: "message", message: contMsg };
        allTurnEvents.push(contEv);
        pendingEvents.push(contEv);
        continue;
      }

      if (response.toolCalls.length === 0) {
        completedNormally = true;
        break;
      }
    }

    if (!completedNormally && shouldSynthesizeOnMaxSteps && !input.signal?.aborted) {
      const synthUserMsg: Message = { role: "user", content: MAX_STEPS_SYNTHESIS_PROMPT };
      workingMessages.push(synthUserMsg);
      const synthUserEv: TurnEvent = { type: "message", message: synthUserMsg };
      allTurnEvents.push(synthUserEv);
      pendingEvents.push(synthUserEv);

      const shouldStream = input.stream ?? this.stream;
      const synthStart = performance.now();
      const synthResp = await this.model.complete({
        messages: workingMessages,
        tools: [],
        signal: input.signal,
        onDelta: shouldStream
          ? (delta) => {
              this.emit(
                delta.type === "thinking"
                  ? { type: "thinking_delta", step: steps + 1, text: delta.text }
                  : { type: "text_delta", step: steps + 1, text: delta.text },
              );
            }
          : undefined,
      });
      const synthMs = performance.now() - synthStart;
      totalUsage = mergeUsage(totalUsage, synthResp.usage);
      pendingUsage = mergeUsage(pendingUsage, synthResp.usage);

      this.emit({
        type: "model_response",
        step: steps + 1,
        content: synthResp.content,
        toolCallCount: 0,
        usage: synthResp.usage,
      });

      if (synthResp.thinking) {
        const thinkingEv: TurnEvent = { type: "thinking", content: synthResp.thinking };
        allTurnEvents.push(thinkingEv);
        pendingEvents.push(thinkingEv);
      }

      const synthAssistantMsg: Message = { role: "assistant", content: synthResp.content };
      workingMessages.push(synthAssistantMsg);
      const synthAssistantEv: TurnEvent = { type: "message", message: synthAssistantMsg };
      allTurnEvents.push(synthAssistantEv);
      pendingEvents.push(synthAssistantEv);
      if (synthResp.content.trim().length > 0) {
        finalAssistantText = synthResp.content;
      }

      const flushed = flushCheckpoint(
        `${(input.title ?? input.userInput).slice(0, 52)} [synthesis]`,
        pendingMayMutate,
      );
      pendingMayMutate = false;

      const synthTokensIn = synthResp.usage?.tokensIn;
      const synthCacheRead = synthResp.usage?.cacheRead;
      const synthCacheRate =
        synthTokensIn && synthTokensIn > 0 && synthCacheRead !== undefined
          ? synthCacheRead / synthTokensIn
          : undefined;
      this.recordProfile({
        timestamp: new Date().toISOString(),
        sessionRef: input.sessionRef,
        step: steps + 1,
        model: this.model.id,
        modelLatencyMs: Number(synthMs.toFixed(2)),
        toolsLatencyMs: 0,
        gitCheckpointMs: Number(flushed.elapsedMs.toFixed(2)),
        projectMs: 0,
        tokensIn: synthTokensIn,
        tokensOut: synthResp.usage?.tokensOut,
        cacheRead: synthCacheRead,
        cacheHitRate: synthCacheRate !== undefined ? Number(synthCacheRate.toFixed(4)) : undefined,
        promptMessages: workingMessages.length - 1,
        toolCalls: [],
        checkpointSha: flushed.sha,
        workspaceTreeSha: flushed.workspaceTree,
        workspaceChanged: flushed.changed,
      });
    }

    if (!lastCommitSha || pendingEvents.length > 0) {
      const flushed = flushCheckpoint((input.title ?? input.userInput).slice(0, 72), pendingMayMutate);
      lastCommitSha = flushed.sha;
    }

    for (const hook of this.hooks) {
      await hook.postTurn?.({
        sessionRef: input.sessionRef,
        commitSha: lastCommitSha,
        events: allTurnEvents,
        usage: totalUsage,
      });
    }

    return {
      commitSha: lastCommitSha,
      assistantText: finalAssistantText,
      steps,
      toolCallsExecuted,
      usage: totalUsage,
      compactedAnchorSha: lastCompactedAnchorSha,
      checkpointsCommitted,
      stopReason: completedNormally ? "completed" : "max_steps",
    };
  }

  /**
   * Ask the active `ModelAdapter` to distill the active session window into a
   * structured summary, then commit a non-destructive dual-parent compaction anchor.
   */
  async compactSession(sessionRefName: string, extraInstruction?: string): Promise<Sha> {
    const projected = this.sessions.project(sessionRefName, {
      systemPrompt: this.systemPrompt,
    });
    const prompt = extraInstruction
      ? `${COMPACTION_PROMPT}\n\nAdditional focus: ${extraInstruction}`
      : COMPACTION_PROMPT;

    const response = await this.model.complete({
      messages: [...projected.messages, { role: "user", content: prompt }],
      tools: [],
    });

    const anchorSha = this.sessions.compact({
      sessionRef: sessionRefName,
      summary: response.content.trim() || "(empty summary)",
      metadata: {
        model: this.model.id,
        tokensIn: response.usage?.tokensIn,
        tokensOut: response.usage?.tokensOut,
        cacheRead: response.usage?.cacheRead,
      },
    });

    this.emit({ type: "compacted", sessionRef: sessionRefName, anchorSha });
    return anchorSha;
  }

  private emit(event: RuntimeEvent): void {
    this.onEvent?.(event);
  }

  private recordProfile(entry: StepProfileEntry): void {
    this.onProfile?.(entry);
    if (this.profileLogPath) {
      fs.mkdirSync(path.dirname(this.profileLogPath), { recursive: true });
      fs.appendFileSync(this.profileLogPath, JSON.stringify(entry) + "\n", "utf8");
    }
  }
}
