import { createHash } from "node:crypto";
import type {
  CommitInput,
  CommitObject,
  ObjectStore,
  RefEntry,
  Sha,
  TreeEntry,
} from "./types.ts";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288f14904eb";

function sha1Hex(prefix: string, body: Uint8Array): Sha {
  const hash = createHash("sha1");
  hash.update(`${prefix} ${body.byteLength}\0`);
  hash.update(body);
  return hash.digest("hex");
}

function toBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : new Uint8Array(content);
}

/**
 * Pure in-memory implementation of `ObjectStore` for deterministic, sub-millisecond
 * standalone unit tests of upper layers (`session`, `runtime`, `orchestrator`, `memory`).
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly blobs = new Map<Sha, Uint8Array>();
  private readonly trees = new Map<Sha, TreeEntry[]>();
  private readonly commits = new Map<Sha, CommitObject>();
  private readonly refs = new Map<string, Sha>();
  private readonly notes = new Map<string, Map<Sha, string>>();

  /** Simulated working directory (relative path -> UTF-8 bytes) for rewind tests. */
  public readonly workspace = new Map<string, Uint8Array>();
  public hostHead: Sha | null = null;
  private clockSec = 1_700_000_000;

  constructor() {
    this.trees.set(EMPTY_TREE_SHA, []);
  }

  writeBlob(content: Uint8Array | string): Sha {
    const bytes = toBytes(content);
    const sha = sha1Hex("blob", bytes);
    if (!this.blobs.has(sha)) {
      this.blobs.set(sha, bytes);
    }
    return sha;
  }

  readBlob(sha: Sha): Uint8Array {
    const data = this.blobs.get(sha);
    if (!data) {
      throw new Error(`Blob not found: ${sha}`);
    }
    return new Uint8Array(data);
  }

  writeTree(entries: TreeEntry[]): Sha {
    const sorted = [...entries].sort((a, b) => {
      const aKey = a.type === "tree" ? `${a.name}/` : a.name;
      const bKey = b.type === "tree" ? `${b.name}/` : b.name;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
    if (sorted.length === 0) {
      return EMPTY_TREE_SHA;
    }
    const serialized = sorted.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join("\n");
    const sha = sha1Hex("tree", Buffer.from(serialized, "utf8"));
    if (!this.trees.has(sha)) {
      this.trees.set(sha, sorted);
    }
    return sha;
  }

  readTree(treeSha: Sha): TreeEntry[] {
    const entries = this.trees.get(treeSha);
    if (!entries) {
      throw new Error(`Tree not found: ${treeSha}`);
    }
    return entries.map((e) => ({ ...e }));
  }

  resolvePath(commitOrTreeSha: Sha, relPath: string): TreeEntry | null {
    const commit = this.commits.get(commitOrTreeSha);
    let currentTreeSha = commit ? commit.tree : commitOrTreeSha;
    const parts = relPath.split("/").filter(Boolean);
    if (parts.length === 0) {
      return { mode: "040000", type: "tree", sha: currentTreeSha, name: "" };
    }
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      const entries = this.trees.get(currentTreeSha);
      if (!entries) return null;
      const match = entries.find((e) => e.name === segment);
      if (!match) return null;
      if (i === parts.length - 1) {
        return { ...match };
      }
      if (match.type !== "tree") return null;
      currentTreeSha = match.sha;
    }
    return null;
  }

  commitTree(input: CommitInput): Sha {
    if (!this.trees.has(input.tree)) {
      throw new Error(`Tree not found for commit: ${input.tree}`);
    }
    for (const p of input.parents) {
      if (!this.commits.has(p)) {
        throw new Error(`Parent commit not found: ${p}`);
      }
    }
    const authorName = input.authorName ?? "git-harness";
    const authorEmail = input.authorEmail ?? "harness@local";
    const timestampSec = input.timestampSec ?? ++this.clockSec;
    const author = `${authorName} <${authorEmail}>`;
    const body = [
      `tree ${input.tree}`,
      ...input.parents.map((p) => `parent ${p}`),
      `author ${author} ${timestampSec} +0000`,
      `committer ${author} ${timestampSec} +0000`,
      "",
      input.message,
    ].join("\n");
    const sha = sha1Hex("commit", Buffer.from(body, "utf8"));
    this.commits.set(sha, {
      sha,
      tree: input.tree,
      parents: [...input.parents],
      message: input.message,
      author,
      timestampSec,
    });
    return sha;
  }

  readCommit(sha: Sha): CommitObject {
    const commit = this.commits.get(sha);
    if (!commit) {
      throw new Error(`Commit not found: ${sha}`);
    }
    return { ...commit, parents: [...commit.parents] };
  }

  readRef(ref: string): Sha | null {
    return this.refs.get(ref) ?? null;
  }

  updateRef(ref: string, newSha: Sha, expectedOldSha?: Sha): void {
    const current = this.refs.get(ref) ?? "";
    if (expectedOldSha !== undefined && current !== expectedOldSha) {
      throw new Error(
        `CAS ref update failed for ${ref}: expected "${expectedOldSha}", actual "${current}"`,
      );
    }
    this.refs.set(ref, newSha);
  }

  deleteRef(ref: string): void {
    this.refs.delete(ref);
  }

  listRefs(prefix: string): RefEntry[] {
    const out: RefEntry[] = [];
    for (const [ref, sha] of this.refs.entries()) {
      if (ref.startsWith(prefix)) {
        out.push({ ref, sha });
      }
    }
    return out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  snapshotWorkspace(): Sha {
    return this.buildNestedTree(this.workspace);
  }

  materializeWorkspace(treeSha: Sha): void {
    this.workspace.clear();
    this.flattenTree(treeSha, "", this.workspace);
  }

  readHostHead(): Sha | null {
    return this.hostHead;
  }

  writeNote(notesRef: string, targetSha: Sha, body: string): void {
    let bucket = this.notes.get(notesRef);
    if (!bucket) {
      bucket = new Map<Sha, string>();
      this.notes.set(notesRef, bucket);
    }
    bucket.set(targetSha, body);
  }

  readNote(notesRef: string, targetSha: Sha): string | null {
    return this.notes.get(notesRef)?.get(targetSha) ?? null;
  }

  /** Helper for tests to write a workspace file directly. */
  setWorkspaceFile(relPath: string, content: string | Uint8Array): void {
    this.workspace.set(relPath, toBytes(content));
  }

  /** Helper for tests to delete a workspace file directly. */
  deleteWorkspaceFile(relPath: string): void {
    this.workspace.delete(relPath);
  }

  private buildNestedTree(files: Map<string, Uint8Array>): Sha {
    type DirNode = { files: Map<string, Uint8Array>; dirs: Map<string, DirNode> };
    const root: DirNode = { files: new Map(), dirs: new Map() };

    for (const [relPath, bytes] of files.entries()) {
      const parts = relPath.split("/").filter(Boolean);
      if (parts.length === 0) continue;
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
      cur.files.set(parts[parts.length - 1]!, bytes);
    }

    const writeNode = (node: DirNode): Sha => {
      const entries: TreeEntry[] = [];
      for (const [name, bytes] of node.files.entries()) {
        entries.push({ mode: "100644", type: "blob", sha: this.writeBlob(bytes), name });
      }
      for (const [name, sub] of node.dirs.entries()) {
        entries.push({ mode: "040000", type: "tree", sha: writeNode(sub), name });
      }
      return this.writeTree(entries);
    };

    return writeNode(root);
  }

  private flattenTree(treeSha: Sha, prefix: string, out: Map<string, Uint8Array>): void {
    for (const entry of this.readTree(treeSha)) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === "tree") {
        this.flattenTree(entry.sha, fullPath, out);
      } else {
        out.set(fullPath, this.readBlob(entry.sha));
      }
    }
  }
}
