import type { Sha } from "../git-store/types.ts";

export interface MemoryFile {
  /** Path inside `refs/harness/memory`, e.g. `system/rules.md`, `facts/build.md`, `decisions/001-git.md`. */
  path: string;
  content: string;
}

export interface MemoryWriteInput {
  files: MemoryFile[];
  /** Optional relative paths to remove from memory. */
  deletes?: string[];
  message: string;
  sourceSha?: Sha;
  sourceRef?: string;
  agentId?: string;
}

export interface MemoryProposal {
  id: string;
  ref: string;
  sha: Sha;
  message: string;
  files: MemoryFile[];
  deletes: string[];
  sourceSha?: Sha;
  sourceRef?: string;
  agentId?: string;
}

export interface MemoryGateResult {
  passed: boolean;
  reason?: string;
}

/**
 * Governance gate evaluated before promoting a memory proposal into `refs/harness/memory` (P0-10).
 */
export interface MemoryGate {
  name: string;
  check(proposal: MemoryProposal): Promise<MemoryGateResult> | MemoryGateResult;
}

export interface PromoteResult {
  promoted: boolean;
  commitSha?: Sha;
  failedGates?: Array<{ name: string; reason: string }>;
}

export type RecallSourceKind = "session" | "memory";

export interface RecallQuery {
  query: string;
  source?: RecallSourceKind;
  limit?: number;
}

export interface RecallHit {
  source: RecallSourceKind;
  ref: string;
  sha: Sha;
  path: string;
  title: string;
  snippet: string;
  score: number;
  timestampSec: number;
}

export interface RecallIndexStats {
  indexedCommits: number;
  indexedMemoryFiles: number;
  totalDocuments: number;
}
