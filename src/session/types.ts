import type { Sha } from "../git-store/types.ts";

export type HarnessCommitKind = "turn" | "compact" | "subagent-merge" | "checkpoint";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
}

export interface ImageAttachment {
  mimeType: string;
  /** Base64-encoded image bytes (without `data:` URI prefix). */
  data: string;
}

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCallRecord[];
  images?: ImageAttachment[];
}

export type TurnEvent =
  | { type: "message"; message: Message }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError?: boolean }
  | { type: "note"; content: string };

export interface SessionState {
  version: 1;
  mode?: string;
  pinnedFiles?: string[];
  compactionAnchor?: Sha | null;
  metadata?: Record<string, unknown>;
}

export interface TurnMetadata {
  agentId?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  codeBaseSha?: Sha | null;
}

export interface CommitTurnInput {
  sessionRef: string;
  title: string;
  events: TurnEvent[];
  state?: Partial<Omit<SessionState, "version">>;
  metadata?: TurnMetadata;
  /** Whether to capture a shadow workspace snapshot into the turn commit (default: true). */
  snapshotWorkspace?: boolean;
  timestampSec?: number;
}

export interface CompactInput {
  sessionRef: string;
  summary: string;
  title?: string;
  state?: Partial<Omit<SessionState, "version">>;
  metadata?: TurnMetadata;
  /** Capture a fresh workspace snapshot instead of inheriting rawTip's workspace tree (default: false). */
  snapshotWorkspace?: boolean;
  timestampSec?: number;
}

export interface SquashMergeInput {
  targetSessionRef: string;
  sourceRef: string;
  summary: string;
  title?: string;
  /** Optional explicit events to record on the parent; defaults to a single distilled handoff message. */
  events?: TurnEvent[];
  state?: Partial<Omit<SessionState, "version">>;
  metadata?: TurnMetadata;
  snapshotWorkspace?: boolean;
  timestampSec?: number;
}

export interface RewindOptions {
  /** Whether to also restore workspace files from the target commit's workspace tree (default: true). */
  restoreWorkspace?: boolean;
  /** Optional ref to preserve the abandoned HEAD before moving `sessionRef`. */
  preserveAbandonedAs?: string;
}

export interface ProjectOptions {
  /** Optional pinned system prompt emitted as the first message (cacheable prefix). */
  systemPrompt?: string;
}

export interface ProjectedPrompt {
  headSha: Sha;
  anchorSha: Sha | null;
  /** Chronological commit SHAs contributing to this prompt projection. */
  commitChain: Sha[];
  messages: Message[];
}

export interface SessionCommitRecord {
  sha: Sha;
  parents: Sha[];
  kind: HarnessCommitKind;
  title: string;
  trailers: Record<string, string>;
  events: TurnEvent[];
  state: SessionState;
  summary: string | null;
  workspaceTree: Sha | null;
  timestampSec: number;
}
