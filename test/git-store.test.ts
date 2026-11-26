import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCliStore, InMemoryObjectStore } from "../src/git-store/index.ts";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored_dir/\n*.tmp\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain=v1"], { cwd: dir, encoding: "utf8" });
}

function gitLogOneline(dir: string): string {
  return execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
}

test("InMemoryObjectStore: blobs, trees, commits, CAS refs, notes, workspace", () => {
  const store = new InMemoryObjectStore();
  const blobSha = store.writeBlob("hello world");
  assert.equal(Buffer.from(store.readBlob(blobSha)).toString("utf8"), "hello world");

  const treeSha = store.writeTree([
    { mode: "100644", type: "blob", sha: blobSha, name: "hello.txt" },
  ]);
  assert.equal(store.resolvePath(treeSha, "hello.txt")?.sha, blobSha);

  const c1 = store.commitTree({ tree: treeSha, parents: [], message: "first" });
  store.updateRef("refs/harness/sessions/s1", c1, "");
  assert.equal(store.readRef("refs/harness/sessions/s1"), c1);

  // CAS violation must throw
  assert.throws(() => store.updateRef("refs/harness/sessions/s1", c1, "wrong-sha"));

  store.writeNote("refs/notes/harness/evals", c1, "score=1.0");
  assert.equal(store.readNote("refs/notes/harness/evals", c1), "score=1.0");

  store.setWorkspaceFile("src/a.ts", "v1");
  const snap1 = store.snapshotWorkspace();
  store.setWorkspaceFile("src/a.ts", "v2");
  store.setWorkspaceFile("src/extra.ts", "junk");
  store.materializeWorkspace(snap1);
  assert.equal(Buffer.from(store.workspace.get("src/a.ts")!).toString("utf8"), "v1");
  assert.equal(store.workspace.has("src/extra.ts"), false);
});

test("GitCliStore: P0-2 zero host-repo pollution + exact workspace snapshot & materialize", () => {
  const repo = initTempGitRepo();
  try {
    const store = new GitCliStore({ repoRoot: repo });
    const initialLog = gitLogOneline(repo);
    const initialBranches = execFileSync("git", ["branch", "--list"], {
      cwd: repo,
      encoding: "utf8",
    });

    // Create ignored directory that MUST survive workspace materialization
    fs.mkdirSync(path.join(repo, "ignored_dir"), { recursive: true });
    fs.writeFileSync(path.join(repo, "ignored_dir/cache.bin"), "keep-me");

    // Stage a user change in the real index to ensure harness never touches `.git/index`
    fs.writeFileSync(path.join(repo, "staged.txt"), "staged-content\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: repo, stdio: "ignore" });
    const indexBefore = fs.readFileSync(path.join(repo, ".git/index"));

    // Snapshot T1
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src/app.ts"), "export const v = 1;\n");
    const snap1 = store.snapshotWorkspace();

    // Verify real `.git/index` is byte-for-byte untouched
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git/index")), indexBefore);

    // Mutate workspace: edit, create nested untracked file, delete README.md
    fs.writeFileSync(path.join(repo, "src/app.ts"), "export const v = 2;\n");
    fs.mkdirSync(path.join(repo, "src/nested"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src/nested/new.ts"), "temp\n");
    fs.rmSync(path.join(repo, "README.md"));

    // Materialize back to T1
    store.materializeWorkspace(snap1);

    // Exact 0-byte restoration
    assert.equal(fs.readFileSync(path.join(repo, "src/app.ts"), "utf8"), "export const v = 1;\n");
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# demo\n");
    assert.equal(fs.existsSync(path.join(repo, "src/nested/new.ts")), false);
    assert.equal(fs.existsSync(path.join(repo, "src/nested")), false);

    // Ignored cache survived untouched
    assert.equal(fs.readFileSync(path.join(repo, "ignored_dir/cache.bin"), "utf8"), "keep-me");

    // User's real `.git/index`, `git log`, and `git branch` untouched
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git/index")), indexBefore);
    assert.equal(gitLogOneline(repo), initialLog);
    assert.equal(
      execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" }),
      initialBranches,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("GitCliStore: shadow refs, CAS update, notes, and worktrees leave host clean", () => {
  const repo = initTempGitRepo();
  const wtDir = path.join(os.tmpdir(), `git-harness-wt-${Date.now()}`);
  try {
    const store = new GitCliStore({ repoRoot: repo });
    const blob = store.writeBlob("payload");
    const tree = store.writeTree([{ mode: "100644", type: "blob", sha: blob, name: "data.txt" }]);
    const c1 = store.commitTree({ tree, parents: [], message: "shadow commit 1", timestampSec: 1700000001 });

    store.updateRef("refs/harness/sessions/demo", c1, "");
    assert.equal(store.readRef("refs/harness/sessions/demo"), c1);
    assert.throws(() => store.updateRef("refs/harness/sessions/demo", c1, ""));

    store.writeNote("refs/notes/harness/evals", c1, "pass@1=true\n");
    assert.equal(store.readNote("refs/notes/harness/evals", c1), "pass@1=true\n");

    const wt = store.addWorktree(wtDir, "HEAD");
    assert.equal(fs.existsSync(path.join(wt.path, "README.md")), true);
    assert.ok(store.listWorktrees().some((w) => fs.realpathSync(w.path) === fs.realpathSync(wtDir)));
    store.removeWorktree(wtDir, true);

    // Host repo remains completely clean AND native loose objects pass strict `git fsck`
    assert.equal(gitStatus(repo), "");
    assert.equal(execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" }).trim(), "* main");
    execFileSync("git", ["fsck", "--full", "--strict"], { cwd: repo, stdio: "pipe" });
  } finally {
    fs.rmSync(wtDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("GitCliStore detached gitDir: excludes compiled binaries (*.so, *.pyc) & persists shadow index", () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-excl-work-"));
  const gdParent = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-excl-gd-"));
  const gitDir = path.join(gdParent, "harness.git");
  try {
    fs.mkdirSync(path.join(workDir, "pkg/__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "pkg/app.py"), "print('hi')\n");
    fs.writeFileSync(path.join(workDir, "pkg/_C.abi3.so"), Buffer.alloc(1024 * 1024, 0xaa));
    fs.writeFileSync(path.join(workDir, "pkg/__pycache__/app.cpython-312.pyc"), "bytecode");

    const store = new GitCliStore({ repoRoot: workDir, gitDir });
    const tree1 = store.snapshotWorkspace();

    // Persistent shadow index exists inside detached gitDir (NOT in workDir)
    assert.equal(fs.existsSync(path.join(gitDir, "harness-shadow.index")), true);
    assert.equal(fs.existsSync(path.join(workDir, ".git")), false);

    // Compiled .so and __pycache__/*.pyc are excluded; app.py is included!
    assert.ok(store.resolvePath(tree1, "pkg/app.py"));
    assert.equal(store.resolvePath(tree1, "pkg/_C.abi3.so"), null);
    assert.equal(store.resolvePath(tree1, "pkg/__pycache__/app.cpython-312.pyc"), null);

    // Second snapshot reuses shadow index and returns identical tree SHA
    const tree2 = store.snapshotWorkspace();
    assert.equal(tree2, tree1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(gdParent, { recursive: true, force: true });
  }
});

test("GitCliStore v0.6: handles nested unborn .git repos, VM images (*.img/*.iso), and >maxDetachedFileBytes files", () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-unborn-work-"));
  const gdParent = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-unborn-gd-"));
  const gitDir = path.join(gdParent, "harness.git");
  try {
    // Seed a nested unborn Git repo (exact `merge-diff-arc-agi-task` failure scenario!)
    const nestedRepo = path.join(workDir, "repo");
    fs.mkdirSync(nestedRepo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: nestedRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(nestedRepo, "uncommitted.py"), "x = 1\n");

    // Seed normal source file, VM disk image, and oversized custom-extension file
    fs.writeFileSync(path.join(workDir, "algo.py"), "def solve(): return 42\n");
    fs.writeFileSync(path.join(workDir, "disk.img"), Buffer.alloc(64 * 1024, 0x55));
    fs.writeFileSync(path.join(workDir, "huge.dat"), Buffer.alloc(200 * 1024, 0x77));

    const store = new GitCliStore({
      repoRoot: workDir,
      gitDir,
      maxDetachedFileBytes: 100 * 1024,
    });
    const tree1 = store.snapshotWorkspace();

    // Must succeed without crashing on nested unborn repo/, exclude disk.img and huge.dat, keep algo.py!
    assert.ok(store.resolvePath(tree1, "algo.py"));
    assert.equal(store.resolvePath(tree1, "disk.img"), null);
    assert.equal(store.resolvePath(tree1, "huge.dat"), null);
    assert.equal(store.resolvePath(tree1, "repo"), null);

    // Subsequent snapshots hit the fast path cleanly!
    fs.writeFileSync(path.join(workDir, "algo.py"), "def solve(): return 43\n");
    const tree2 = store.snapshotWorkspace();
    assert.notEqual(tree2, tree1);
    assert.ok(store.resolvePath(tree2, "algo.py"));
    execFileSync("git", ["--git-dir", gitDir, "fsck", "--full", "--strict"], { stdio: "pipe" });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(gdParent, { recursive: true, force: true });
  }
});
