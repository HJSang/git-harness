import type { ObjectStore, Sha, TreeEntry } from "../git-store/types.ts";
import { MEMORY_REF } from "../session/session-store.ts";
import type {
  MemoryFile,
  MemoryGate,
  MemoryProposal,
  MemoryWriteInput,
  PromoteResult,
} from "./types.ts";

export const MEMORY_PROPOSAL_PREFIX = "refs/harness/memory-proposals/";

const decoder = new TextDecoder("utf-8");

function normalizeRelPath(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
  if (!clean || clean.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`Invalid memory path: ${p}`);
  }
  return clean;
}

/**
 * Built-in P0-10 anti-poisoning gate: rejects obvious API keys, tokens, or private keys
 * before they can enter persistent `refs/harness/memory`.
 */
export function noSecretsGate(): MemoryGate {
  const patterns: Array<{ label: string; regex: RegExp }> = [
    { label: "private key header", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
    { label: "OpenAI/Anthropic-style secret key", regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { label: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  ];

  return {
    name: "no-secrets",
    check(proposal) {
      for (const file of proposal.files) {
        for (const p of patterns) {
          if (p.regex.test(file.content)) {
            return { passed: false, reason: `Detected ${p.label} in ${file.path}` };
          }
        }
      }
      return { passed: true };
    },
  };
}

/**
 * Built-in P0-10 anti-poisoning gate: rejects proposals sourced from abandoned/dropped
 * branches or unverified refs.
 */
export function nonAbandonedSourceGate(store: ObjectStore): MemoryGate {
  return {
    name: "non-abandoned-source",
    check(proposal) {
      if (proposal.sourceRef?.startsWith("refs/harness/abandoned/")) {
        return { passed: false, reason: `Source ref is abandoned: ${proposal.sourceRef}` };
      }
      if (proposal.sourceRef && store.readRef(proposal.sourceRef) === null) {
        return { passed: false, reason: `Source ref no longer exists (dropped): ${proposal.sourceRef}` };
      }
      return { passed: true };
    },
  };
}

/**
 * Layer 4 (`memory`) — Git-backed persistent memory stored on orphan ref `refs/harness/memory`.
 *
 * Conventions (progressive disclosure):
 * - `system/*`    — Always pinned into the cacheable system prompt prefix.
 * - `decisions/*` — Architectural rationale linked to code/session SHAs.
 * - `facts/*`     — Discovered repo conventions, build/test commands.
 * - `episodes/*`  — Curated cross-session learnings.
 */
export class MemoryStore {
  private readonly store: ObjectStore;
  public readonly ref: string;

  constructor(store: ObjectStore, ref = MEMORY_REF) {
    this.store = store;
    this.ref = ref;
  }

  /** Read a single memory file by path, or null if absent. */
  read(relPath: string): string | null {
    const head = this.store.readRef(this.ref);
    if (!head) return null;
    const entry = this.store.resolvePath(head, normalizeRelPath(relPath));
    if (!entry || entry.type !== "blob") return null;
    return decoder.decode(this.store.readBlob(entry.sha));
  }

  /** List all memory file paths (optionally filtered by prefix such as `"system/"`). */
  list(prefix = ""): string[] {
    const head = this.store.readRef(this.ref);
    if (!head) return [];
    const commit = this.store.readCommit(head);
    const map = this.flattenTree(commit.tree);
    return [...map.keys()]
      .filter((k) => !prefix || k.startsWith(prefix))
      .sort();
  }

  /** Read all files matching a prefix (e.g. `"system/"`). */
  readPrefix(prefix: string): MemoryFile[] {
    const paths = this.list(prefix);
    const out: MemoryFile[] = [];
    for (const p of paths) {
      const content = this.read(p);
      if (content !== null) out.push({ path: p, content });
    }
    return out;
  }

  /**
   * Render deterministic pinned memory block from `system/` files for injection
   * into the cacheable system prompt prefix.
   */
  renderPinnedSystemMemory(): string {
    const pinned = this.readPrefix("system/");
    if (pinned.length === 0) return "";
    return pinned
      .map((f) => `### ${f.path}\n${f.content.trim()}`)
      .join("\n\n");
  }

  /** Direct trusted write to `refs/harness/memory` (for human edits or verified updates). */
  put(input: MemoryWriteInput): Sha {
    const prevHead = this.store.readRef(this.ref);
    const currentFiles = prevHead
      ? this.flattenTree(this.store.readCommit(prevHead).tree)
      : new Map<string, Sha>();

    for (const del of input.deletes ?? []) {
      currentFiles.delete(normalizeRelPath(del));
    }
    for (const f of input.files) {
      currentFiles.set(normalizeRelPath(f.path), this.store.writeBlob(f.content));
    }

    const newTree = this.buildNestedTree(currentFiles);
    const msg = this.formatMemoryMessage(input);
    const commitSha = this.store.commitTree({
      tree: newTree,
      parents: prevHead ? [prevHead] : [],
      message: msg,
    });
    this.store.updateRef(this.ref, commitSha, prevHead ?? "");
    return commitSha;
  }

  /**
   * Stage an untrusted/automated memory update on `refs/harness/memory-proposals/<id>`
   * without touching `refs/harness/memory` until verified via `promote()` (P0-10).
   */
  propose(proposalId: string, input: MemoryWriteInput): MemoryProposal {
    const proposalRef = `${MEMORY_PROPOSAL_PREFIX}${proposalId}`;
    const normalizedFiles = input.files.map((f) => ({
      path: normalizeRelPath(f.path),
      content: f.content,
    }));
    const normalizedDeletes = (input.deletes ?? []).map(normalizeRelPath);

    const payloadBlob = this.store.writeBlob(
      JSON.stringify(
        {
          id: proposalId,
          message: input.message,
          files: normalizedFiles,
          deletes: normalizedDeletes,
          sourceSha: input.sourceSha,
          sourceRef: input.sourceRef,
          agentId: input.agentId,
        },
        null,
        2,
      ) + "\n",
    );

    const tree = this.store.writeTree([
      { mode: "100644", type: "blob", sha: payloadBlob, name: "proposal.json" },
    ]);

    const prevHead = this.store.readRef(this.ref);
    const sha = this.store.commitTree({
      tree,
      parents: prevHead ? [prevHead] : [],
      message: `proposal(${proposalId}): ${input.message}\n\nHarness-Kind: memory-proposal\n`,
    });

    this.store.updateRef(proposalRef, sha, "");
    return {
      id: proposalId,
      ref: proposalRef,
      sha,
      message: input.message,
      files: normalizedFiles,
      deletes: normalizedDeletes,
      sourceSha: input.sourceSha,
      sourceRef: input.sourceRef,
      agentId: input.agentId,
    };
  }

  /**
   * Run all `gates` against a staged proposal. Only commits to `refs/harness/memory`
   * if EVERY gate passes; otherwise leaves `refs/harness/memory` completely untouched.
   */
  async promote(proposalId: string, gates: MemoryGate[] = [noSecretsGate()]): Promise<PromoteResult> {
    const proposalRef = `${MEMORY_PROPOSAL_PREFIX}${proposalId}`;
    const propSha = this.store.readRef(proposalRef);
    if (!propSha) {
      throw new Error(`Memory proposal not found: ${proposalId}`);
    }
    const entry = this.store.resolvePath(propSha, "proposal.json");
    if (!entry) {
      throw new Error(`Malformed memory proposal ${proposalId}: missing proposal.json`);
    }
    const raw = JSON.parse(decoder.decode(this.store.readBlob(entry.sha))) as Omit<
      MemoryProposal,
      "ref" | "sha"
    >;
    const proposal: MemoryProposal = { ...raw, ref: proposalRef, sha: propSha };

    const failedGates: Array<{ name: string; reason: string }> = [];
    for (const gate of gates) {
      const res = await gate.check(proposal);
      if (!res.passed) {
        failedGates.push({ name: gate.name, reason: res.reason ?? "rejected" });
      }
    }

    if (failedGates.length > 0) {
      return { promoted: false, failedGates };
    }

    const prevHead = this.store.readRef(this.ref);
    const currentFiles = prevHead
      ? this.flattenTree(this.store.readCommit(prevHead).tree)
      : new Map<string, Sha>();

    for (const del of proposal.deletes) {
      currentFiles.delete(del);
    }
    for (const f of proposal.files) {
      currentFiles.set(f.path, this.store.writeBlob(f.content));
    }

    const newTree = this.buildNestedTree(currentFiles);
    const msg = this.formatMemoryMessage({
      files: proposal.files,
      deletes: proposal.deletes,
      message: proposal.message,
      sourceSha: proposal.sourceSha,
      sourceRef: proposal.sourceRef,
      agentId: proposal.agentId,
    });

    // parent1 = previous memory head, parent2 = audited proposal commit
    const parents = prevHead ? [prevHead, propSha] : [propSha];
    const commitSha = this.store.commitTree({ tree: newTree, parents, message: msg });
    this.store.updateRef(this.ref, commitSha, prevHead ?? "");
    this.store.deleteRef(proposalRef);

    return { promoted: true, commitSha };
  }

  /** Discard a staged proposal without touching `refs/harness/memory`. */
  reject(proposalId: string): void {
    this.store.deleteRef(`${MEMORY_PROPOSAL_PREFIX}${proposalId}`);
  }

  private formatMemoryMessage(input: MemoryWriteInput): string {
    const trailers: string[] = ["Harness-Kind: memory"];
    if (input.agentId) trailers.push(`Agent-Id: ${input.agentId}`);
    if (input.sourceRef) trailers.push(`Source-Ref: ${input.sourceRef}`);
    if (input.sourceSha) trailers.push(`Source-SHA: ${input.sourceSha}`);
    const title = input.message.replace(/\r?\n/g, " ").trim() || "memory update";
    return `${title}\n\n${trailers.join("\n")}\n`;
  }

  private flattenTree(treeSha: Sha, prefix = "", out = new Map<string, Sha>()): Map<string, Sha> {
    for (const e of this.store.readTree(treeSha)) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === "tree") {
        this.flattenTree(e.sha, full, out);
      } else {
        out.set(full, e.sha);
      }
    }
    return out;
  }

  private buildNestedTree(files: Map<string, Sha>): Sha {
    type DirNode = { files: Map<string, Sha>; dirs: Map<string, DirNode> };
    const root: DirNode = { files: new Map(), dirs: new Map() };

    for (const [rel, sha] of files.entries()) {
      const parts = rel.split("/").filter(Boolean);
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        let child = cur.dirs.get(seg);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          cur.dirs.set(seg, child);
        }
        cur = child;
      }
      cur.files.set(parts[parts.length - 1]!, sha);
    }

    const writeNode = (node: DirNode): Sha => {
      const entries: TreeEntry[] = [];
      for (const [name, sha] of node.files.entries()) {
        entries.push({ mode: "100644", type: "blob", sha, name });
      }
      for (const [name, sub] of node.dirs.entries()) {
        entries.push({ mode: "040000", type: "tree", sha: writeNode(sub), name });
      }
      return this.store.writeTree(entries);
    };

    return writeNode(root);
  }
}
