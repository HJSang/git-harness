import type { ObjectStore, RefEntry, Sha, TreeEntry } from "../git-store/types.ts";
import type {
  CommitTurnInput,
  CompactInput,
  HarnessCommitKind,
  Message,
  ProjectOptions,
  ProjectedPrompt,
  RewindOptions,
  SessionCommitRecord,
  SessionState,
  SquashMergeInput,
  TurnEvent,
  TurnMetadata,
} from "./types.ts";

export const SESSION_REF_PREFIX = "refs/harness/sessions/";
export const AGENT_REF_PREFIX = "refs/harness/agents/";
export const ARCHIVE_REF_PREFIX = "refs/harness/archive/";
export const ABANDONED_REF_PREFIX = "refs/harness/abandoned/";
export const MEMORY_REF = "refs/harness/memory";

export function sessionRef(sessionId: string): string {
  return `${SESSION_REF_PREFIX}${sessionId}`;
}

export function agentRef(agentId: string): string {
  return `${AGENT_REF_PREFIX}${agentId}`;
}

const decoder = new TextDecoder("utf-8");

function encodeJsonLines(events: TurnEvent[]): string {
  if (events.length === 0) return "";
  return events.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
}

function decodeJsonLines(raw: string): TurnEvent[] {
  if (!raw.trim()) return [];
  return raw
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

function formatCommitMessage(
  title: string,
  kind: HarnessCommitKind,
  metadata: TurnMetadata | undefined,
  workspaceTree: Sha | null,
  extraTrailers?: Record<string, string>,
): string {
  const trailers: Array<[string, string]> = [["Harness-Kind", kind]];
  if (metadata?.agentId) trailers.push(["Agent-Id", metadata.agentId]);
  if (metadata?.model) trailers.push(["Model", metadata.model]);
  if (metadata?.tokensIn !== undefined) trailers.push(["Tokens-In", String(metadata.tokensIn)]);
  if (metadata?.tokensOut !== undefined) trailers.push(["Tokens-Out", String(metadata.tokensOut)]);
  if (metadata?.cacheRead !== undefined) trailers.push(["Cache-Read", String(metadata.cacheRead)]);
  if (metadata?.codeBaseSha) trailers.push(["Code-Base-SHA", metadata.codeBaseSha]);
  if (workspaceTree) trailers.push(["Workspace-Tree", workspaceTree]);
  if (extraTrailers) {
    for (const [k, v] of Object.entries(extraTrailers)) {
      trailers.push([k, v]);
    }
  }
  const cleanTitle = title.replace(/\r?\n/g, " ").trim() || kind;
  return `${cleanTitle}\n\n${trailers.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;
}

function parseCommitMessage(message: string): { title: string; trailers: Record<string, string> } {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const title = (lines[0] ?? "").trim();
  const trailers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.+)$/);
    if (match) {
      trailers[match[1]!] = match[2]!.trim();
    }
  }
  return { title, trailers };
}

/**
 * Layer 1 (`session`) — Turn DAG, co-atomic rewind, dual-parent compaction anchors,
 * and deterministic KV-cache-preserving prompt projection.
 *
 * Depends ONLY on the narrow `ObjectStore` interface from Layer 0.
 */
export class SessionStore {
  private readonly store: ObjectStore;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  /** Commit a new turn onto `sessionRef`, atomically capturing events, state, and optional workspace snapshot. */
  commitTurn(input: CommitTurnInput): Sha {
    const prevHead = this.store.readRef(input.sessionRef);
    const prevRecord = prevHead ? this.readCommit(prevHead) : null;

    const prevAnchor =
      prevRecord?.kind === "compact"
        ? prevRecord.sha
        : (prevRecord?.state.compactionAnchor ?? null);

    const state: SessionState = {
      version: 1,
      mode: input.state?.mode ?? prevRecord?.state.mode,
      pinnedFiles: input.state?.pinnedFiles ?? prevRecord?.state.pinnedFiles,
      compactionAnchor:
        input.state?.compactionAnchor !== undefined ? input.state.compactionAnchor : prevAnchor,
      metadata: input.state?.metadata ?? prevRecord?.state.metadata,
    };

    const shouldSnapshot = input.snapshotWorkspace ?? true;
    const workspaceTree = shouldSnapshot
      ? this.store.snapshotWorkspace()
      : (prevRecord?.workspaceTree ?? null);

    const codeBaseSha =
      input.metadata?.codeBaseSha !== undefined
        ? input.metadata.codeBaseSha
        : this.store.readHostHead();

    const rootTree = this.writeCommitContentTree({
      events: input.events,
      state,
      workspaceTree,
      summary: null,
    });

    const message = formatCommitMessage(
      input.title,
      "turn",
      { ...input.metadata, codeBaseSha },
      workspaceTree,
    );

    const newSha = this.store.commitTree({
      tree: rootTree,
      parents: prevHead ? [prevHead] : [],
      message,
      timestampSec: input.timestampSec,
    });

    this.store.updateRef(input.sessionRef, newSha, prevHead ?? "");
    return newSha;
  }

  /**
   * Create a non-destructive dual-parent compaction anchor commit.
   *
   * - First compaction: `parents = [rawTip]`
   * - Subsequent compactions: `parents = [prevAnchor, rawTip]`
   *
   * `--first-parent` yields the clean anchor chain, while `parent2` preserves 100%
   * of raw history for auditing and cold recall.
   */
  compact(input: CompactInput): Sha {
    const rawTip = this.store.readRef(input.sessionRef);
    if (!rawTip) {
      throw new Error(`Cannot compact empty session: ${input.sessionRef}`);
    }
    const tipRecord = this.readCommit(rawTip);
    const prevAnchor =
      tipRecord.kind === "compact" ? tipRecord.sha : (tipRecord.state.compactionAnchor ?? null);

    const state: SessionState = {
      version: 1,
      mode: input.state?.mode ?? tipRecord.state.mode,
      pinnedFiles: input.state?.pinnedFiles ?? tipRecord.state.pinnedFiles,
      compactionAnchor: prevAnchor,
      metadata: input.state?.metadata ?? tipRecord.state.metadata,
    };

    const workspaceTree = input.snapshotWorkspace
      ? this.store.snapshotWorkspace()
      : tipRecord.workspaceTree;

    const rootTree = this.writeCommitContentTree({
      events: [],
      state,
      workspaceTree,
      summary: input.summary,
    });

    const parents = prevAnchor && prevAnchor !== rawTip ? [prevAnchor, rawTip] : [rawTip];
    const message = formatCommitMessage(
      input.title ?? "compact: session checkpoint",
      "compact",
      { ...input.metadata, codeBaseSha: this.store.readHostHead() },
      workspaceTree,
      { "Compacted-Tip": rawTip },
    );

    const anchorSha = this.store.commitTree({
      tree: rootTree,
      parents,
      message,
      timestampSec: input.timestampSec,
    });

    this.store.updateRef(input.sessionRef, anchorSha, rawTip);
    return anchorSha;
  }

  /**
   * Squash-merge a subagent branch into a parent session ref.
   *
   * `parent1` = parent session HEAD (preserves append-only KV-cache prefix on parent),
   * `parent2` = subagent branch tip (preserves full subagent trace for audit/recall).
   */
  squashMerge(input: SquashMergeInput): Sha {
    const sourceTip = this.resolveCommitSha(input.sourceRef);
    if (!sourceTip) {
      throw new Error(`Subagent source ref/commit not found: ${input.sourceRef}`);
    }

    const parentHead = this.store.readRef(input.targetSessionRef);
    const parentRecord = parentHead ? this.readCommit(parentHead) : null;
    const prevAnchor =
      parentRecord?.kind === "compact"
        ? parentRecord.sha
        : (parentRecord?.state.compactionAnchor ?? null);

    const state: SessionState = {
      version: 1,
      mode: input.state?.mode ?? parentRecord?.state.mode,
      pinnedFiles: input.state?.pinnedFiles ?? parentRecord?.state.pinnedFiles,
      compactionAnchor: prevAnchor,
      metadata: input.state?.metadata ?? parentRecord?.state.metadata,
    };

    const workspaceTree =
      (input.snapshotWorkspace ?? true)
        ? this.store.snapshotWorkspace()
        : (parentRecord?.workspaceTree ?? null);

    const events: TurnEvent[] = input.events ?? [
      {
        type: "message",
        message: {
          role: "user",
          content: `[Subagent Result (${input.sourceRef} @ ${sourceTip.slice(0, 8)})]\n\n${input.summary}`,
        },
      },
    ];

    const rootTree = this.writeCommitContentTree({
      events,
      state,
      workspaceTree,
      summary: input.summary,
    });

    const parents = parentHead ? [parentHead, sourceTip] : [sourceTip];
    const message = formatCommitMessage(
      input.title ?? `merge: ${input.sourceRef}`,
      "subagent-merge",
      { ...input.metadata, codeBaseSha: this.store.readHostHead() },
      workspaceTree,
      { "Merged-Source": input.sourceRef, "Merged-Tip": sourceTip },
    );

    const mergeSha = this.store.commitTree({
      tree: rootTree,
      parents,
      message,
      timestampSec: input.timestampSec,
    });

    this.store.updateRef(input.targetSessionRef, mergeSha, parentHead ?? "");
    return mergeSha;
  }

  /** Fork a new session/agent ref from any existing commit SHA or ref. */
  fork(fromCommitOrRef: string, newRef: string): Sha {
    const sha = this.resolveCommitSha(fromCommitOrRef);
    if (!sha) {
      throw new Error(`Cannot fork: source not found (${fromCommitOrRef})`);
    }
    this.store.readCommit(sha);
    this.store.updateRef(newRef, sha, "");
    return sha;
  }

  /**
   * Co-atomically rewind `sessionRef` to `targetSha` and (by default) materialize
   * `targetSha`'s workspace tree so conversation state and files stay 100% consistent.
   */
  rewind(sessionRefName: string, targetSha: Sha, opts?: RewindOptions): SessionCommitRecord {
    const currentHead = this.store.readRef(sessionRefName);
    const target = this.readCommit(targetSha);

    if (opts?.preserveAbandonedAs && currentHead) {
      this.store.updateRef(opts.preserveAbandonedAs, currentHead);
    }

    this.store.updateRef(sessionRefName, target.sha, currentHead ?? "");

    if (opts?.restoreWorkspace ?? true) {
      if (!target.workspaceTree) {
        throw new Error(`Cannot restore workspace: commit ${target.sha} has no workspace snapshot`);
      }
      this.store.materializeWorkspace(target.workspaceTree);
    }

    return target;
  }

  /**
   * Deterministic prompt projection `HEAD -> Message[]`.
   *
   * Walks `--first-parent` backward from `headSha` until the nearest `compact` anchor
   * (or root), reverses to chronological order, and emits byte-deterministic messages.
   * Guarantee: committing turn `T_{k+1}` on top of `T_k` strictly appends to `project(T_k)`.
   */
  project(commitOrRef: string, opts?: ProjectOptions): ProjectedPrompt {
    const headSha = this.resolveCommitSha(commitOrRef);
    if (!headSha) {
      throw new Error(`Cannot project: ref/commit not found (${commitOrRef})`);
    }

    const walked: SessionCommitRecord[] = [];
    let cursor: Sha | undefined = headSha;
    let anchorSha: Sha | null = null;

    while (cursor) {
      const rec = this.readCommit(cursor);
      walked.push(rec);
      if (rec.kind === "compact") {
        anchorSha = rec.sha;
        break;
      }
      cursor = rec.parents[0];
    }

    walked.reverse();

    const messages: Message[] = [];
    if (opts?.systemPrompt) {
      messages.push({ role: "system", content: opts.systemPrompt });
    }

    for (const rec of walked) {
      if (rec.kind === "compact" && rec.summary !== null) {
        const rawTip = rec.trailers["Compacted-Tip"] ?? rec.parents[1] ?? rec.parents[0];
        const hint = rawTip
          ? ` (pre-compaction raw tip: ${rawTip.slice(0, 8)}; use recall() or read("commit://${rawTip.slice(0, 8)}/turn/events.jsonl") for exact earlier details)`
          : "";
        messages.push({
          role: "user",
          content: `[Compacted Session Summary${hint}]\n\n${rec.summary}`,
        });
      }
      for (const ev of rec.events) {
        if (ev.type === "message") {
          messages.push(ev.message);
        }
      }
    }

    return {
      headSha,
      anchorSha,
      commitChain: walked.map((r) => r.sha),
      messages,
    };
  }

  /** Walk `--first-parent` history from `commitOrRef` (most recent first). */
  logFirstParent(commitOrRef: string, limit = 100): SessionCommitRecord[] {
    const headSha = this.resolveCommitSha(commitOrRef);
    if (!headSha) return [];
    const out: SessionCommitRecord[] = [];
    let cursor: Sha | undefined = headSha;
    while (cursor && out.length < limit) {
      const rec = this.readCommit(cursor);
      out.push(rec);
      cursor = rec.parents[0];
    }
    return out;
  }

  /** Decode a session commit into structured events, state, summary, and workspace tree SHA. */
  readCommit(sha: Sha): SessionCommitRecord {
    const commit = this.store.readCommit(sha);
    const { title, trailers } = parseCommitMessage(commit.message);
    const kind = (trailers["Harness-Kind"] as HarnessCommitKind | undefined) ?? "turn";

    const eventsEntry = this.store.resolvePath(commit.tree, "turn/events.jsonl");
    const events = eventsEntry
      ? decodeJsonLines(decoder.decode(this.store.readBlob(eventsEntry.sha)))
      : [];

    const stateEntry = this.store.resolvePath(commit.tree, "turn/state.json");
    const state: SessionState = stateEntry
      ? (JSON.parse(decoder.decode(this.store.readBlob(stateEntry.sha))) as SessionState)
      : { version: 1 };

    const summaryEntry = this.store.resolvePath(commit.tree, "summary.md");
    const summary = summaryEntry ? decoder.decode(this.store.readBlob(summaryEntry.sha)) : null;

    const workspaceEntry = this.store.resolvePath(commit.tree, "workspace");
    const workspaceTree =
      workspaceEntry && workspaceEntry.type === "tree"
        ? workspaceEntry.sha
        : (trailers["Workspace-Tree"] ?? null);

    return {
      sha: commit.sha,
      parents: commit.parents,
      kind,
      title,
      trailers,
      events,
      state,
      summary,
      workspaceTree,
      timestampSec: commit.timestampSec,
    };
  }

  /** List all refs under a prefix (defaults to `refs/harness/sessions/`). */
  listSessions(prefix = SESSION_REF_PREFIX): RefEntry[] {
    return this.store.listRefs(prefix);
  }

  /** Store an immutable content-addressed blob (e.g., offloaded oversized tool output). */
  writeBlob(content: Uint8Array | string): Sha {
    return this.store.writeBlob(content);
  }

  /** Read an immutable content-addressed blob by SHA. */
  readBlob(sha: Sha): Uint8Array {
    return this.store.readBlob(sha);
  }

  /**
   * Read a file inside any historical commit SHA (`commit://<sha>/<relPath>`),
   * e.g. `turn/events.jsonl`, `summary.md`, or `workspace/src/app.py`.
   * Accepts full 40-char SHAs or unambiguous short prefixes from `refs/harness/*`.
   */
  readCommitFile(commitShaOrPrefix: string, relPath: string): Uint8Array | null {
    const sha = this.resolveShortSha(commitShaOrPrefix);
    const entry = this.store.resolvePath(sha, relPath);
    if (!entry || entry.type !== "blob") return null;
    return this.store.readBlob(entry.sha);
  }

  /** Diff workspace files between two session commits. */
  diffCommits(fromShaOrPrefix: string, toShaOrPrefix: string): {
    added: string[];
    modified: string[];
    deleted: string[];
  } {
    const fromRec = this.readCommit(this.resolveShortSha(fromShaOrPrefix));
    const toRec = this.readCommit(this.resolveShortSha(toShaOrPrefix));
    const fromMap = fromRec.workspaceTree ? this.flattenTreeMap(fromRec.workspaceTree) : new Map<string, Sha>();
    const toMap = toRec.workspaceTree ? this.flattenTreeMap(toRec.workspaceTree) : new Map<string, Sha>();

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [file, sha] of toMap.entries()) {
      const prev = fromMap.get(file);
      if (prev === undefined) added.push(file);
      else if (prev !== sha) modified.push(file);
    }
    for (const file of fromMap.keys()) {
      if (!toMap.has(file)) deleted.push(file);
    }
    added.sort();
    modified.sort();
    deleted.sort();
    return { added, modified, deleted };
  }

  /** Resolve a full SHA, `refs/...` ref name, or unambiguous short prefix across reachable `refs/harness/*` commits. */
  resolveShortSha(shaOrPrefix: string): Sha {
    if (shaOrPrefix.startsWith("refs/")) {
      const tip = this.store.readRef(shaOrPrefix);
      if (tip) return tip;
      throw new Error(`Ref not found: ${shaOrPrefix}`);
    }
    if (/^[0-9a-f]{40,64}$/i.test(shaOrPrefix)) return shaOrPrefix;
    const refs = this.store.listRefs("refs/harness/");
    const seen = new Set<Sha>();
    const matches: Sha[] = [];
    for (const entry of refs) {
      const queue: Sha[] = [entry.sha];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (cur.startsWith(shaOrPrefix)) matches.push(cur);
        try {
          const c = this.store.readCommit(cur);
          for (const p of c.parents) if (!seen.has(p)) queue.push(p);
        } catch {
          // ignore non-commit refs
        }
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Ambiguous commit prefix "${shaOrPrefix}" (${matches.length} matches)`);
    }
    return shaOrPrefix;
  }

  private flattenTreeMap(treeSha: Sha, prefix = "", out = new Map<string, Sha>()): Map<string, Sha> {
    for (const e of this.store.readTree(treeSha)) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === "tree") this.flattenTreeMap(e.sha, rel, out);
      else out.set(rel, e.sha);
    }
    return out;
  }

  private resolveCommitSha(commitOrRef: string): Sha | null {
    if (commitOrRef.startsWith("refs/")) {
      return this.store.readRef(commitOrRef);
    }
    const asRef = this.store.readRef(commitOrRef);
    return asRef ?? commitOrRef;
  }

  private writeCommitContentTree(params: {
    events: TurnEvent[];
    state: SessionState;
    workspaceTree: Sha | null;
    summary: string | null;
  }): Sha {
    const eventsBlob = this.store.writeBlob(encodeJsonLines(params.events));
    const stateBlob = this.store.writeBlob(JSON.stringify(params.state, null, 2) + "\n");

    const turnTree = this.store.writeTree([
      { mode: "100644", type: "blob", sha: eventsBlob, name: "events.jsonl" },
      { mode: "100644", type: "blob", sha: stateBlob, name: "state.json" },
    ]);

    const rootEntries: TreeEntry[] = [
      { mode: "040000", type: "tree", sha: turnTree, name: "turn" },
    ];

    if (params.workspaceTree) {
      rootEntries.push({
        mode: "040000",
        type: "tree",
        sha: params.workspaceTree,
        name: "workspace",
      });
    }

    if (params.summary !== null) {
      const summaryBlob = this.store.writeBlob(params.summary);
      rootEntries.push({
        mode: "100644",
        type: "blob",
        sha: summaryBlob,
        name: "summary.md",
      });
    }

    return this.store.writeTree(rootEntries);
  }
}
