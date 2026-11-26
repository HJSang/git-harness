import type { Sha } from "../git-store/types.ts";
import type { ImageAttachment, Message, SessionState, ToolCallRecord, TurnEvent } from "../session/types.ts";

export interface JsonSchemaProperty {
  type: string;
  description?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  sessionRef: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  /** Optional multimodal image attachments (e.g. from reading `.png`/`.jpg` files). */
  images?: ImageAttachment[];
  /** Optional nested model usage (e.g., from `subagent` tool) for end-to-end cost attribution. */
  subagentUsage?: ModelUsage;
  subagentSteps?: number;
}

export interface Tool {
  schema: ToolSchema;
  /** True for pure read-only tools (`read`, `recall`) so the runtime can skip redundant workspace snapshots and run them in parallel. */
  readOnly?: boolean;
  /**
   * True when multiple invocations of this tool in the same model step can execute concurrently
   * via `Promise.all` (defaults to `Boolean(readOnly)`). Non-parallel tools act as ordering barriers.
   */
  parallelSafe?: boolean;
  /** Optional per-tool override for Git-blob output offloading threshold in bytes. */
  offloadThresholdBytes?: number;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> | ToolResult;
}

export interface ModelUsage {
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
}

export interface ModelStreamDelta {
  type: "text" | "thinking";
  text: string;
}

export interface ModelRequest {
  messages: Message[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  /** Optional streaming callback; when provided, adapters stream SSE chunks live. */
  onDelta?: (delta: ModelStreamDelta) => void;
}

export interface ModelResponse {
  content: string;
  thinking?: string;
  toolCalls: ToolCallRecord[];
  usage?: ModelUsage;
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "unknown";
}

/**
 * Narrow, provider-agnostic model interface.
 * Swap OpenAI / Anthropic / DeepSeek / local vLLM / Mock even mid-session.
 */
export interface ModelAdapter {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface PreTurnContext {
  sessionRef: string;
  userInput: string;
  messages: Message[];
}

export interface PreToolDecision {
  allow: boolean;
  reason?: string;
  /** Optional mutated arguments if the hook chooses to normalize inputs. */
  args?: Record<string, unknown>;
}

export interface PreToolContext {
  sessionRef: string;
  toolName: string;
  args: Record<string, unknown>;
  workspaceRoot: string;
}

export interface PostToolContext {
  sessionRef: string;
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  /** 1-based step index inside the current turn. */
  step?: number;
  /** Maximum step budget configured for the current turn. */
  maxSteps?: number;
}

export interface PostTurnContext {
  sessionRef: string;
  commitSha: Sha;
  events: TurnEvent[];
  usage: ModelUsage;
}

/**
 * Composable lifecycle interceptors (Plan mode, approval policies, guardrails,
 * memory injection all plug in here instead of bloating the core loop).
 */
export interface RuntimeHook {
  name?: string;
  preTurn?(ctx: PreTurnContext): Promise<void> | void;
  preTool?(ctx: PreToolContext): Promise<PreToolDecision> | PreToolDecision;
  postTool?(ctx: PostToolContext): Promise<ToolResult | void> | ToolResult | void;
  postTurn?(ctx: PostTurnContext): Promise<void> | void;
}

export type RuntimeEvent =
  | { type: "turn_start"; sessionRef: string; userInput: string }
  | { type: "text_delta"; step: number; text: string }
  | { type: "thinking_delta"; step: number; text: string }
  | { type: "model_response"; step: number; content: string; toolCallCount: number; usage?: ModelUsage }
  | { type: "tool_blocked"; toolName: string; reason: string }
  | { type: "tool_start"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; isError: boolean; outputPreview: string }
  | { type: "turn_committed"; sessionRef: string; commitSha: Sha }
  | { type: "compacted"; sessionRef: string; anchorSha: Sha };

export interface ToolCallProfile {
  name: string;
  durationMs: number;
  outputBytes: number;
  offloadedBlobSha?: Sha;
  subagentUsage?: ModelUsage;
  subagentSteps?: number;
  isError: boolean;
  blocked?: boolean;
}

export interface StepProfileEntry {
  timestamp: string;
  sessionRef: string;
  step: number;
  model: string;
  modelLatencyMs: number;
  toolsLatencyMs: number;
  gitCheckpointMs: number;
  projectMs: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheHitRate?: number;
  promptMessages: number;
  toolCalls: ToolCallProfile[];
  checkpointSha?: Sha;
  workspaceTreeSha?: Sha | null;
  workspaceChanged?: boolean;
  compactedAnchorSha?: Sha;
}

export interface RunTurnInput {
  sessionRef: string;
  userInput: string;
  title?: string;
  agentId?: string;
  state?: Partial<Omit<SessionState, "version">>;
  snapshotWorkspace?: boolean;
  maxSteps?: number;
  /** Flush a co-atomic Git checkpoint every N steps inside a long autonomous turn (0 = commit only at turn end). */
  checkpointEverySteps?: number;
  /** Stream model text/thinking deltas via `RuntimeEvent` (overrides runtime default). */
  stream?: boolean;
  /**
   * When `maxSteps` is exhausted mid-tool-loop, run one final no-tool synthesis call
   * so the caller receives a complete handoff instead of pre-tool narration (default: true).
   */
  synthesizeOnMaxSteps?: boolean;
  signal?: AbortSignal;
}

export interface RunTurnResult {
  commitSha: Sha;
  assistantText: string;
  steps: number;
  toolCallsExecuted: number;
  usage: ModelUsage;
  compactedAnchorSha?: Sha;
  checkpointsCommitted: number;
  /** `"completed"` when the model finished with no tool calls; `"max_steps"` when the step budget was hit. */
  stopReason: "completed" | "max_steps";
}
