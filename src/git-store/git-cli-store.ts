import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type {
  CommitInput,
  CommitObject,
  ObjectStore,
  RefEntry,
  Sha,
  TreeEntry,
  TreeEntryMode,
  TreeEntryType,
  WorktreeInfo,
  WorktreeStore,
} from "./types.ts";

const ZERO_SHA = "0000000000000000000000000000000000000000";

function normalizeModeForBinaryTree(mode: TreeEntryMode): string {
  return mode === "040000" ? "40000" : mode;
}

function normalizeModeFromBinaryTree(mode: string): TreeEntryMode {
  return (mode === "40000" ? "040000" : mode) as TreeEntryMode;
}

function gitTreeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.type === "tree" ? `${entry.name}/` : entry.name, "utf8");
}

function encodeBinaryTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(gitTreeSortKey(a), gitTreeSortKey(b)));
  const chunks: Buffer[] = [];
  for (const e of sorted) {
    chunks.push(Buffer.from(`${normalizeModeForBinaryTree(e.mode)} ${e.name}\0`, "utf8"));
    chunks.push(Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(chunks);
}

function decodeBinaryTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const spaceIdx = body.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const rawMode = body.subarray(offset, spaceIdx).toString("ascii");
    const nullIdx = body.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = body.subarray(spaceIdx + 1, nullIdx).toString("utf8");
    const shaStart = nullIdx + 1;
    const shaEnd = shaStart + 20;
    const sha = body.subarray(shaStart, shaEnd).toString("hex");
    const mode = normalizeModeFromBinaryTree(rawMode);
    const type: TreeEntryType = mode === "040000" ? "tree" : "blob";
    entries.push({ mode, type, sha, name });
    offset = shaEnd;
  }
  return entries;
}

function parseCommitRaw(sha: Sha, raw: string): CommitObject {
  const splitIdx = raw.indexOf("\n\n");
  const headerBlock = splitIdx === -1 ? raw : raw.slice(0, splitIdx);
  const message = splitIdx === -1 ? "" : raw.slice(splitIdx + 2);

  let tree = "";
  const parents: Sha[] = [];
  let author = "";
  let timestampSec = 0;

  for (const line of headerBlock.split("\n")) {
    if (line.startsWith("tree ")) {
      tree = line.slice(5).trim();
    } else if (line.startsWith("parent ")) {
      parents.push(line.slice(7).trim());
    } else if (line.startsWith("author ")) {
      const rest = line.slice(7);
      const match = rest.match(/^(.*)\s+(\d+)\s+[+-]\d{4}$/);
      if (match) {
        author = match[1]!;
        timestampSec = Number(match[2]);
      } else {
        author = rest;
      }
    }
  }

  return { sha, tree, parents, message, author, timestampSec };
}

const DEFAULT_DETACHED_EXCLUDES = [
  "# git-harness default detached excludes (compiled binaries, VM images, archives & caches)",
  "*.so",
  "*.so.*",
  "*.dylib",
  "*.dll",
  "*.pyc",
  "*.pyo",
  "*.o",
  "*.a",
  "*.whl",
  "*.pt",
  "*.pth",
  "*.ckpt",
  "*.bin",
  "*.safetensors",
  "*.onnx",
  "*.gguf",
  "*.h5",
  "*.hdf5",
  "*.parquet",
  "*.img",
  "*.iso",
  "*.qcow2",
  "*.vmdk",
  "*.vdi",
  "*.raw",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.tar.xz",
  "*.tar.zst",
  "*.zst",
  "*.gz",
  "*.bz2",
  "*.xz",
  "*.zip",
  "*.7z",
  "*.rar",
  "*.deb",
  "*.rpm",
  "*.mp4",
  "*.mkv",
  "*.avi",
  "*.mov",
  "*.wav",
  "*.flac",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "node_modules/",
  ".venv/",
].join("\n") + "\n";

const DEFAULT_MAX_DETACHED_FILE_BYTES = 25 * 1024 * 1024;

export interface GitCliStoreOptions {
  /** Path to the Git repository working tree root. */
  repoRoot: string;
  /**
   * Optional detached `GIT_DIR` path (e.g., `/logs/agent/harness.git`).
   * Lets `git-harness` manage non-Git workspaces without creating a `.git/` folder
   * inside `repoRoot`. Auto-initialized as a bare git dir if absent.
   */
  gitDir?: string;
  /** Optional extra gitignore patterns written to `<detachedGitDir>/info/exclude`. */
  detachedExcludes?: string[];
  /** Auto-exclude untracked files larger than this byte limit in detached mode (default: 25 MiB; 0 disables). */
  maxDetachedFileBytes?: number;
  /** Optional git binary path (defaults to `"git"`). */
  gitBin?: string;
  /** Default author name used for harness commits. */
  authorName?: string;
  /** Default author email used for harness commits. */
  authorEmail?: string;
}

/**
 * Layer 0 concrete implementation backed by a real Git repository.
 *
 * Design guarantees:
 * - Zero pollution to user branches, `git status`, or `.git/index`.
 * - Native in-process loose Git object I/O (`zlib` + `sha1`) for sub-millisecond
 *   blob/tree/commit writes & reads, with transparent `git` CLI fallback for packfiles
 *   and SHA-256 repos.
 * - Immutable content-addressed in-memory cache for already-seen SHAs.
 * - Workspace snapshots use an isolated temporary `GIT_INDEX_FILE` seeded from
 *   `.git/index` (when present) so Git reuses the stat cache on large repos.
 */
export class GitCliStore implements ObjectStore, WorktreeStore {
  public readonly repoRoot: string;
  public readonly detachedGitDir?: string;
  private readonly gitBin: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly gitDir: string;
  private readonly commonDir: string;
  private readonly objectsDir: string;
  private readonly nativeLooseSha1: boolean;
  private readonly maxDetachedFileBytes: number;
  private readonly dynamicDetachedExcludes = new Set<string>();

  // Git objects are mathematically immutable (SHA -> content), so caching is 100% sound.
  private readonly blobCache = new Map<Sha, Uint8Array>();
  private readonly treeCache = new Map<Sha, TreeEntry[]>();
  private readonly commitCache = new Map<Sha, CommitObject>();

  constructor(options: GitCliStoreOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.gitBin = options.gitBin ?? "git";
    this.authorName = options.authorName ?? "git-harness";
    this.authorEmail = options.authorEmail ?? "harness@local";
    this.maxDetachedFileBytes = options.maxDetachedFileBytes ?? DEFAULT_MAX_DETACHED_FILE_BYTES;

    if (options.gitDir) {
      this.detachedGitDir = path.resolve(options.gitDir);
      if (!fs.existsSync(path.join(this.detachedGitDir, "HEAD"))) {
        fs.mkdirSync(this.detachedGitDir, { recursive: true });
        execFileSync(this.gitBin, ["init", "--bare", this.detachedGitDir], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        const infoDir = path.join(this.detachedGitDir, "info");
        fs.mkdirSync(infoDir, { recursive: true });
        const extra =
          options.detachedExcludes && options.detachedExcludes.length > 0
            ? "\n" + options.detachedExcludes.join("\n") + "\n"
            : "";
        fs.writeFileSync(path.join(infoDir, "exclude"), DEFAULT_DETACHED_EXCLUDES + extra, "utf8");
      }
    }

    // Resolve gitDir + commonDir + objectFormat in one spawn.
    const meta = this.runGitText([
      "rev-parse",
      "--git-dir",
      "--git-common-dir",
      "--show-object-format",
    ])
      .trim()
      .split("\n");
    this.gitDir = path.resolve(this.repoRoot, meta[0] ?? ".git");
    this.commonDir = path.resolve(this.repoRoot, meta[1] ?? meta[0] ?? ".git");
    this.objectsDir = path.join(this.commonDir, "objects");
    this.nativeLooseSha1 = (meta[2]?.trim() ?? "sha1") === "sha1";
  }

  writeBlob(content: Uint8Array | string): Sha {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    let sha: Sha;
    if (this.nativeLooseSha1) {
      sha = this.writeLooseObject("blob", buf);
    } else {
      sha = this.runGitText(["hash-object", "-w", "--stdin"], { input: buf }).trim();
    }
    this.blobCache.set(sha, new Uint8Array(buf));
    return sha;
  }

  readBlob(sha: Sha): Uint8Array {
    const cached = this.blobCache.get(sha);
    if (cached) return new Uint8Array(cached);

    const loose = this.nativeLooseSha1 ? this.readLooseObject(sha) : null;
    const raw =
      loose && loose.type === "blob"
        ? loose.body
        : this.runGitRaw(["cat-file", "blob", sha]);

    const bytes = new Uint8Array(raw);
    this.blobCache.set(sha, bytes);
    return new Uint8Array(bytes);
  }

  writeTree(entries: TreeEntry[]): Sha {
    let sha: Sha;
    if (this.nativeLooseSha1) {
      const body = encodeBinaryTree(entries);
      sha = this.writeLooseObject("tree", body);
      this.treeCache.set(sha, decodeBinaryTree(body));
      return sha;
    }

    const payload =
      entries.length === 0
        ? ""
        : entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join("\n") + "\n";
    sha = this.runGitText(["mktree"], { input: payload }).trim();
    return sha;
  }

  readTree(treeSha: Sha): TreeEntry[] {
    const cached = this.treeCache.get(treeSha);
    if (cached) return cached.map((e) => ({ ...e }));

    if (this.nativeLooseSha1) {
      const loose = this.readLooseObject(treeSha);
      if (loose && loose.type === "tree") {
        const parsed = decodeBinaryTree(loose.body);
        this.treeCache.set(treeSha, parsed);
        return parsed.map((e) => ({ ...e }));
      }
    }

    const raw = this.runGitText(["ls-tree", "-z", treeSha]);
    const entries: TreeEntry[] = [];
    if (raw) {
      for (const record of raw.split("\0")) {
        if (!record) continue;
        const tabIdx = record.indexOf("\t");
        if (tabIdx === -1) continue;
        const meta = record.slice(0, tabIdx).split(" ");
        const name = record.slice(tabIdx + 1);
        if (meta.length !== 3) continue;
        entries.push({
          mode: meta[0] as TreeEntryMode,
          type: meta[1] as TreeEntryType,
          sha: meta[2]!,
          name,
        });
      }
    }
    this.treeCache.set(treeSha, entries);
    return entries.map((e) => ({ ...e }));
  }

  resolvePath(commitOrTreeSha: Sha, relPath: string): TreeEntry | null {
    const clean = relPath.replace(/^\/+|\/+$/g, "");
    let currentTreeSha = commitOrTreeSha;

    // If caller passed a commit SHA, unwrap its root tree.
    const cachedCommit = this.commitCache.get(commitOrTreeSha);
    if (cachedCommit) {
      currentTreeSha = cachedCommit.tree;
    } else if (this.nativeLooseSha1 && !this.treeCache.has(commitOrTreeSha)) {
      const loose = this.readLooseObject(commitOrTreeSha);
      if (loose?.type === "commit") {
        const parsed = parseCommitRaw(commitOrTreeSha, loose.body.toString("utf8"));
        this.commitCache.set(commitOrTreeSha, parsed);
        currentTreeSha = parsed.tree;
      } else if (loose?.type === "tree") {
        this.treeCache.set(commitOrTreeSha, decodeBinaryTree(loose.body));
      }
    }

    if (!clean) {
      return { mode: "040000", type: "tree", sha: currentTreeSha, name: "" };
    }

    const parts = clean.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      let entries: TreeEntry[];
      try {
        entries = this.readTree(currentTreeSha);
      } catch {
        return null;
      }
      const match = entries.find((e) => e.name === segment);
      if (!match) return null;
      if (i === parts.length - 1) return { ...match };
      if (match.type !== "tree") return null;
      currentTreeSha = match.sha;
    }
    return null;
  }

  commitTree(input: CommitInput): Sha {
    const authorName = input.authorName ?? this.authorName;
    const authorEmail = input.authorEmail ?? this.authorEmail;
    const timestampSec = input.timestampSec ?? Math.floor(Date.now() / 1000);

    if (this.nativeLooseSha1) {
      const authorLine = `${authorName} <${authorEmail}> ${timestampSec} +0000`;
      const lines = [
        `tree ${input.tree}`,
        ...input.parents.map((p) => `parent ${p}`),
        `author ${authorLine}`,
        `committer ${authorLine}`,
        "",
        input.message,
      ];
      const raw = lines.join("\n");
      const sha = this.writeLooseObject("commit", Buffer.from(raw, "utf8"));
      this.commitCache.set(sha, {
        sha,
        tree: input.tree,
        parents: [...input.parents],
        message: input.message,
        author: `${authorName} <${authorEmail}>`,
        timestampSec,
      });
      return sha;
    }

    const args = ["commit-tree", input.tree];
    for (const parent of input.parents) {
      args.push("-p", parent);
    }
    const dateStr = `${timestampSec} +0000`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
      GIT_AUTHOR_DATE: dateStr,
      GIT_COMMITTER_DATE: dateStr,
    };
    const sha = this.runGitText(args, { input: input.message, env }).trim();
    return sha;
  }

  readCommit(sha: Sha): CommitObject {
    const cached = this.commitCache.get(sha);
    if (cached) return { ...cached, parents: [...cached.parents] };

    let raw: string;
    const loose = this.nativeLooseSha1 ? this.readLooseObject(sha) : null;
    if (loose && loose.type === "commit") {
      raw = loose.body.toString("utf8");
    } else {
      raw = this.runGitText(["cat-file", "commit", sha]);
    }
    const parsed = parseCommitRaw(sha, raw);
    this.commitCache.set(sha, parsed);
    return { ...parsed, parents: [...parsed.parents] };
  }

  readRef(ref: string): Sha | null {
    // Fast path: loose ref file directly under commonDir (worktree-safe, avoids subprocess spawn).
    const loosePath = path.join(this.commonDir, ref);
    try {
      const content = fs.readFileSync(loosePath, "utf8").trim();
      if (/^[0-9a-f]{40,64}$/i.test(content)) {
        return content;
      }
    } catch {
      // Fall through to git rev-parse (handles packed-refs / symrefs).
    }
    const res = this.tryGitText(["rev-parse", "--verify", "--quiet", ref]);
    if (!res.ok) return null;
    const sha = res.stdout.trim();
    return sha || null;
  }

  updateRef(ref: string, newSha: Sha, expectedOldSha?: Sha): void {
    // Fast path: POSIX atomic lockfile CAS (identical to Git's files-backend protocol).
    // Falls back to `git update-ref` if the ref is packed or lock contention occurs.
    if (this.tryAtomicLooseUpdateRef(ref, newSha, expectedOldSha)) {
      return;
    }
    const args = ["update-ref", ref, newSha];
    if (expectedOldSha !== undefined) {
      args.push(expectedOldSha === "" ? ZERO_SHA : expectedOldSha);
    }
    this.runGitText(args);
  }

  deleteRef(ref: string): void {
    if (this.readRef(ref) === null) return;
    this.runGitText(["update-ref", "-d", ref]);
  }

  listRefs(prefix: string): RefEntry[] {
    const raw = this.runGitText([
      "for-each-ref",
      "--format=%(refname)\t%(objectname)",
      prefix,
    ]);
    if (!raw.trim()) return [];
    const refs: RefEntry[] = [];
    for (const line of raw.trimEnd().split("\n")) {
      const [ref, sha] = line.split("\t");
      if (ref && sha) {
        refs.push({ ref, sha });
      }
    }
    return refs;
  }

  snapshotWorkspace(): Sha {
    return this.withPersistentShadowIndex((env) => {
      this.addAllWorkspaceSafe(env);
      return this.runGitText(["write-tree"], { env }).trim();
    });
  }

  materializeWorkspace(treeSha: Sha): void {
    // Invalidate persistent shadow index so next snapshot reflects materialized mtimes cleanly.
    fs.rmSync(this.shadowIndexPath(), { force: true });

    const currentFiles = this.withTempIndex(/* seedFromRealIndex */ true, (env) => {
      this.addAllWorkspaceSafe(env);
      const raw = this.runGitText(["ls-files", "-z"], { env });
      return raw ? raw.split("\0").filter(Boolean) : [];
    });

    const targetRaw = this.runGitText(["ls-tree", "-r", "--name-only", "-z", treeSha]);
    const targetFiles = new Set(targetRaw ? targetRaw.split("\0").filter(Boolean) : []);

    const dirsToPrune = new Set<string>();
    for (const rel of currentFiles) {
      if (!targetFiles.has(rel)) {
        const abs = path.join(this.repoRoot, rel);
        fs.rmSync(abs, { force: true });
        dirsToPrune.add(path.dirname(abs));
      }
    }

    const sortedDirs = [...dirsToPrune].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      let cur = dir;
      while (cur.startsWith(this.repoRoot) && cur !== this.repoRoot) {
        try {
          const entries = fs.readdirSync(cur);
          if (entries.length === 0) {
            fs.rmdirSync(cur);
            cur = path.dirname(cur);
          } else {
            break;
          }
        } catch {
          break;
        }
      }
    }

    if (targetFiles.size > 0) {
      this.withTempIndex(/* seedFromRealIndex */ false, (env) => {
        this.runGitText(["read-tree", treeSha], { env });
        this.runGitText(["checkout-index", "-a", "-f"], { env });
      });
    }
  }

  readHostHead(): Sha | null {
    // Fast path: resolve `.git/HEAD` directly to avoid spawning a subprocess per turn.
    try {
      const headRaw = fs.readFileSync(path.join(this.gitDir, "HEAD"), "utf8").trim();
      if (headRaw.startsWith("ref: ")) {
        return this.readRef(headRaw.slice(5).trim());
      }
      if (/^[0-9a-f]{40,64}$/i.test(headRaw)) {
        return headRaw;
      }
    } catch {
      // Fall through to git CLI.
    }
    const res = this.tryGitText(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (!res.ok) return null;
    const sha = res.stdout.trim();
    return sha || null;
  }

  writeNote(notesRef: string, targetSha: Sha, body: string): void {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: this.authorName,
      GIT_AUTHOR_EMAIL: this.authorEmail,
      GIT_COMMITTER_NAME: this.authorName,
      GIT_COMMITTER_EMAIL: this.authorEmail,
    };
    this.runGitText(["notes", `--ref=${notesRef}`, "add", "-f", "-F", "-", targetSha], {
      input: body,
      env,
    });
  }

  readNote(notesRef: string, targetSha: Sha): string | null {
    const res = this.tryGitText(["notes", `--ref=${notesRef}`, "show", targetSha]);
    if (!res.ok) return null;
    return res.stdout;
  }

  addWorktree(dirPath: string, commitish: string, branchName?: string): WorktreeInfo {
    const absDir = path.resolve(dirPath);
    const args = ["worktree", "add"];
    if (branchName) {
      args.push("-b", branchName, absDir, commitish);
    } else {
      args.push("--detach", absDir, commitish);
    }
    this.runGitText(args);
    const head = this.tryGitText(["-C", absDir, "rev-parse", "HEAD"]);
    return {
      path: absDir,
      branch: branchName,
      head: head.ok ? head.stdout.trim() : undefined,
    };
  }

  removeWorktree(dirPath: string, force = true): void {
    const absDir = path.resolve(dirPath);
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(absDir);
    this.runGitText(args);
  }

  listWorktrees(): WorktreeInfo[] {
    const raw = this.runGitText(["worktree", "list", "--porcelain"]);
    const out: WorktreeInfo[] = [];
    let current: WorktreeInfo | null = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) out.push(current);
        current = { path: line.slice(9).trim() };
      } else if (line.startsWith("HEAD ") && current) {
        current.head = line.slice(5).trim();
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.slice(7).trim();
      }
    }
    if (current) out.push(current);
    return out;
  }

  private appendDetachedExclude(pattern: string): void {
    if (!this.detachedGitDir) return;
    const normalized = pattern.startsWith("/") ? pattern : `/${pattern}`;
    if (this.dynamicDetachedExcludes.has(normalized)) return;
    this.dynamicDetachedExcludes.add(normalized);
    const excludePath = path.join(this.detachedGitDir, "info", "exclude");
    try {
      fs.appendFileSync(excludePath, `${normalized}\n`, "utf8");
    } catch {
      // ignore if exclude file is unwritable
    }
  }

  private addAllWorkspaceSafe(env: NodeJS.ProcessEnv): void {
    // In detached mode, auto-exclude newly created oversized files (> maxDetachedFileBytes)
    // before `git add -A` hashes them into Git objects.
    if (this.detachedGitDir && this.maxDetachedFileBytes > 0) {
      const untracked = this.tryGitText(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { env },
      );
      if (untracked.ok && untracked.stdout) {
        for (const rel of untracked.stdout.split("\0")) {
          if (!rel) continue;
          const abs = path.join(this.repoRoot, rel);
          try {
            const st = fs.lstatSync(abs);
            if (st.isFile() && st.size > this.maxDetachedFileBytes) {
              this.appendDetachedExclude(rel);
            }
          } catch {
            // ignore vanishing files
          }
        }
      }
    }

    const first = this.tryGitText(["add", "-A"], { env });
    if (first.ok) return;

    // Handle nested unborn Git repos (`error: 'repo/' does not have a commit checked out`)
    // that cause `git add -A` to abort on gitlink creation.
    const unbornDirs = new Set<string>();
    const combinedErr = `${first.stderr}\n${first.stdout}`;
    for (const m of combinedErr.matchAll(/'([^']+)' does not have a commit checked out/g)) {
      const dir = m[1]!.replace(/\/+$/, "");
      if (dir) unbornDirs.add(dir);
    }

    // Also scan for any nested `.git` directories with unborn HEAD inside repoRoot.
    const findNestedUnborn = (dir: string, relPrefix: string, depth: number) => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".venv") continue;
        const absChild = path.join(dir, entry.name);
        const relChild = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (fs.existsSync(path.join(absChild, ".git"))) {
          const headCheck = this.tryGitText(["-C", absChild, "rev-parse", "--verify", "--quiet", "HEAD"]);
          if (!headCheck.ok) {
            unbornDirs.add(relChild);
          }
          continue;
        }
        findNestedUnborn(absChild, relChild, depth + 1);
      }
    };
    if (unbornDirs.size > 0 || combinedErr.includes("does not have a commit checked out")) {
      findNestedUnborn(this.repoRoot, "", 0);
    }

    if (unbornDirs.size > 0) {
      const pathspecs = [".", ...[...unbornDirs].map((d) => `:!${d}`)];
      if (this.detachedGitDir) {
        for (const d of unbornDirs) {
          this.appendDetachedExclude(`${d}/`);
        }
      }
      this.runGitText(["add", "-A", "--", ...pathspecs], { env });
      return;
    }

    // Re-run via runGitText to throw the original Git error cleanly.
    this.runGitText(["add", "-A"], { env });
  }

  private tryAtomicLooseUpdateRef(ref: string, newSha: Sha, expectedOldSha?: Sha): boolean {
    if (!ref.startsWith("refs/") || ref.includes("..")) return false;
    const refPath = path.join(this.commonDir, ref);
    const lockPath = `${refPath}.lock`;
    fs.mkdirSync(path.dirname(refPath), { recursive: true });

    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch {
      return false;
    }

    try {
      if (expectedOldSha !== undefined) {
        let current = "";
        try {
          current = fs.readFileSync(refPath, "utf8").trim();
        } catch {
          // If loose file doesn't exist, check packed-refs via readRef before concluding empty.
          current = this.readRef(ref) ?? "";
        }
        const expected = expectedOldSha === ZERO_SHA ? "" : expectedOldSha;
        if (current !== expected) {
          throw new Error(
            `CAS ref update failed for ${ref}: expected "${expected}", actual "${current}"`,
          );
        }
      }
      fs.writeFileSync(fd, `${newSha}\n`, "utf8");
      fs.closeSync(fd);
      fd = -1;
      fs.renameSync(lockPath, refPath);
      return true;
    } catch (err) {
      if (fd !== -1) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      fs.rmSync(lockPath, { force: true });
      throw err;
    }
  }

  private writeLooseObject(type: "blob" | "tree" | "commit", body: Buffer): Sha {
    const header = Buffer.from(`${type} ${body.byteLength}\0`, "utf8");
    const storeBuf = Buffer.concat([header, body]);
    const sha = createHash("sha1").update(storeBuf).digest("hex");

    const dir = path.join(this.objectsDir, sha.slice(0, 2));
    const objPath = path.join(dir, sha.slice(2));
    if (fs.existsSync(objPath)) {
      return sha;
    }

    fs.mkdirSync(dir, { recursive: true });
    const compressed = deflateSync(storeBuf);
    const tmpPath = path.join(
      dir,
      `.tmp-harness-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    try {
      fs.writeFileSync(tmpPath, compressed);
      fs.renameSync(tmpPath, objPath);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      if (!fs.existsSync(objPath)) {
        throw err;
      }
    }
    return sha;
  }

  private readLooseObject(sha: Sha): { type: string; body: Buffer } | null {
    const objPath = path.join(this.objectsDir, sha.slice(0, 2), sha.slice(2));
    let compressed: Buffer;
    try {
      compressed = fs.readFileSync(objPath);
    } catch {
      return null;
    }
    const raw = inflateSync(compressed);
    const nullIdx = raw.indexOf(0x00);
    if (nullIdx === -1) return null;
    const header = raw.subarray(0, nullIdx).toString("ascii");
    const spaceIdx = header.indexOf(" ");
    if (spaceIdx === -1) return null;
    return {
      type: header.slice(0, spaceIdx),
      body: raw.subarray(nullIdx + 1),
    };
  }

  private shadowIndexPath(): string {
    return path.join(this.gitDir, "harness-shadow.index");
  }

  /**
   * Reuse a persistent shadow index inside `gitDir` (completely separate from `.git/index`)
   * so Git preserves its stat cache across steps — critical for detached `--git-dir` workspaces
   * where `.git/index` does not exist.
   */
  private withPersistentShadowIndex<T>(fn: (env: NodeJS.ProcessEnv) => T): T {
    const idxPath = this.shadowIndexPath();
    const lockPath = `${idxPath}.lock`;
    // Clear stale lock if a prior process was SIGKILLed.
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
    }
    if (!fs.existsSync(idxPath)) {
      const realIndex = path.join(this.gitDir, "index");
      if (fs.existsSync(realIndex)) {
        fs.copyFileSync(realIndex, idxPath);
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: idxPath,
    };
    try {
      return fn(env);
    } catch (err) {
      // If shadow index became corrupt, reset and retry once via clean temp index.
      fs.rmSync(idxPath, { force: true });
      fs.rmSync(lockPath, { force: true });
      return this.withTempIndex(/* seedFromRealIndex */ true, fn);
    }
  }

  private withTempIndex<T>(seedFromRealIndex: boolean, fn: (env: NodeJS.ProcessEnv) => T): T {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-idx-"));
    const idxPath = path.join(tmpDir, "index");
    try {
      if (seedFromRealIndex) {
        const realIndex = path.join(this.gitDir, "index");
        if (fs.existsSync(realIndex)) {
          fs.copyFileSync(realIndex, idxPath);
        }
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: idxPath,
      };
      return fn(env);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private baseGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(extra ?? process.env) };
    if (this.detachedGitDir) {
      env.GIT_DIR = this.detachedGitDir;
      env.GIT_WORK_TREE = this.repoRoot;
    }
    return env;
  }

  private runGitText(
    args: string[],
    opts?: { input?: string | Buffer; env?: NodeJS.ProcessEnv },
  ): string {
    return execFileSync(this.gitBin, args, {
      cwd: this.repoRoot,
      encoding: "utf8",
      input: opts?.input,
      env: this.baseGitEnv(opts?.env),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private runGitRaw(args: string[]): Buffer {
    return execFileSync(this.gitBin, args, {
      cwd: this.repoRoot,
      input: undefined,
      env: this.baseGitEnv(),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private tryGitText(
    args: string[],
    opts?: { input?: string | Buffer; env?: NodeJS.ProcessEnv },
  ): { ok: boolean; stdout: string; stderr: string } {
    try {
      const stdout = this.runGitText(args, opts);
      return { ok: true, stdout, stderr: "" };
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      return {
        ok: false,
        stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? ""),
        stderr:
          typeof e.stderr === "string"
            ? e.stderr
            : (e.stderr?.toString("utf8") ?? e.message ?? ""),
      };
    }
  }
}
