/**
 * Layer 0 (`git-store`) — Pure content-addressed Git object/ref interface.
 *
 * Deliberately contains ZERO AI/LLM concepts so it can be tested, reused,
 * and swapped independently of upper harness layers.
 */

export type Sha = string;

export type TreeEntryMode = "100644" | "100755" | "120000" | "040000";

export type TreeEntryType = "blob" | "tree";

export interface TreeEntry {
  mode: TreeEntryMode;
  type: TreeEntryType;
  sha: Sha;
  name: string;
}

export interface CommitInput {
  tree: Sha;
  parents: Sha[];
  message: string;
  authorName?: string;
  authorEmail?: string;
  timestampSec?: number;
}

export interface CommitObject {
  sha: Sha;
  tree: Sha;
  parents: Sha[];
  message: string;
  author: string;
  timestampSec: number;
}

export interface RefEntry {
  ref: string;
  sha: Sha;
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  head?: Sha;
}

/**
 * Narrow storage contract consumed by upper layers (`session`, `orchestrator`, `memory`).
 * Implemented by `GitCliStore` (real Git repo) and `InMemoryObjectStore` (fast unit tests).
 */
export interface ObjectStore {
  /** Write raw bytes as a content-addressed blob and return its SHA. */
  writeBlob(content: Uint8Array | string): Sha;

  /** Read blob bytes by SHA. */
  readBlob(sha: Sha): Uint8Array;

  /** Write a tree from direct child entries and return its SHA. */
  writeTree(entries: TreeEntry[]): Sha;

  /** List direct child entries of a tree SHA. */
  readTree(treeSha: Sha): TreeEntry[];

  /** Resolve a path (`a/b/c.txt`) inside a commit or tree SHA to its entry, or null if absent. */
  resolvePath(commitOrTreeSha: Sha, relPath: string): TreeEntry | null;

  /** Create an immutable commit object and return its SHA. */
  commitTree(input: CommitInput): Sha;

  /** Read a commit object's metadata and message by SHA. */
  readCommit(sha: Sha): CommitObject;

  /** Read the SHA a ref currently points to, or null if it does not exist. */
  readRef(ref: string): Sha | null;

  /**
   * Atomically update a ref.
   * If `expectedOldSha` is provided, performs compare-and-swap (use `""` to require non-existence).
   */
  updateRef(ref: string, newSha: Sha, expectedOldSha?: Sha): void;

  /** Delete a ref if it exists. */
  deleteRef(ref: string): void;

  /** List all refs matching a prefix (e.g. `refs/harness/sessions/`). */
  listRefs(prefix: string): RefEntry[];

  /**
   * Snapshot the current working directory into a Git tree SHA using an isolated
   * shadow index, without modifying the user's real staging index or branches.
   */
  snapshotWorkspace(): Sha;

  /**
   * Restore the working directory to match `treeSha` exactly (for non-ignored files),
   * without touching the user's real staging index, `HEAD`, or ignored directories.
   */
  materializeWorkspace(treeSha: Sha): void;

  /** Read the host repo's current HEAD commit SHA, or null if unborn/non-repo. */
  readHostHead(): Sha | null;

  /** Attach or overwrite a note on a target SHA under a notes ref namespace. */
  writeNote(notesRef: string, targetSha: Sha, body: string): void;

  /** Read a note attached to a target SHA under a notes ref namespace, or null if absent. */
  readNote(notesRef: string, targetSha: Sha): string | null;
}

/** Optional worktree management capability for code-mutating subagents. */
export interface WorktreeStore {
  addWorktree(dirPath: string, commitish: string, branchName?: string): WorktreeInfo;
  removeWorktree(dirPath: string, force?: boolean): void;
  listWorktrees(): WorktreeInfo[];
}
