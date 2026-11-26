import type { Sha } from "../git-store/types.ts";

export type SkillSourceKind = "git" | "workspace" | "global";

export interface SkillMeta {
  name: string;
  description: string;
  source: SkillSourceKind;
  /** Filesystem directory (for workspace/global skills) or Git ref (`refs/harness/skills`). */
  location: string;
  sha?: Sha;
}

export interface SkillFile {
  /** Path relative to the skill directory, e.g. `"SKILL.md"`, `"references/checklist.md"`, `"scripts/check.sh"`. */
  path: string;
  content: string;
}

export interface SkillWriteInput {
  skillName: string;
  files: SkillFile[];
  message: string;
  sourceSha?: Sha;
  sourceRef?: string;
  agentId?: string;
}

export interface SkillProposal {
  id: string;
  ref: string;
  sha: Sha;
  skillName: string;
  message: string;
  files: SkillFile[];
  sourceSha?: Sha;
  sourceRef?: string;
  agentId?: string;
}

export interface SkillGateResult {
  passed: boolean;
  reason?: string;
}

export interface SkillGate {
  name: string;
  check(proposal: SkillProposal): Promise<SkillGateResult> | SkillGateResult;
}

export interface SkillPromoteResult {
  promoted: boolean;
  commitSha?: Sha;
  failedGates?: Array<{ name: string; reason: string }>;
}

export interface SkillStoreOptions {
  /** Git ref storing versioned skills (defaults to `"refs/harness/skills"`). */
  ref?: string;
  /** Optional workspace root to scan for `.agents/skills`, `.claude/skills`, `.skills`. */
  workspaceRoot?: string;
  /** Additional filesystem skill directories to scan (in priority order). */
  extraDirs?: string[];
  /** Include global `~/.git-harness/skills` and `~/.pi/agent/skills` roots (default: true). */
  includeGlobalDirs?: boolean;
}
