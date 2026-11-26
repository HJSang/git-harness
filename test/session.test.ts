import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCliStore, InMemoryObjectStore } from "../src/git-store/index.ts";
import { SessionStore, agentRef, sessionRef } from "../src/session/index.ts";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-sess-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 0;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("SessionStore (standalone InMemory): P0-4 determinism & P0-5 strict KV-cache prefix invariance", () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const ref = sessionRef("kv-test");

  mem.setWorkspaceFile("a.txt", "1");
  const t1 = sessions.commitTurn({
    sessionRef: ref,
    title: "turn 1",
    events: [
      { type: "message", message: { role: "user", content: "Inspect a.txt" } },
      { type: "message", message: { role: "assistant", content: "a.txt contains 1." } },
    ],
    metadata: { model: "model-a", tokensIn: 100, tokensOut: 20, cacheRead: 0 },
    timestampSec: 1700000100,
  });

  const p1 = sessions.project(t1, { systemPrompt: "You are a concise coding agent." });
  // P0-4: byte-identical prompt determinism across calls
  const p1Again = sessions.project(t1, { systemPrompt: "You are a concise coding agent." });
  assert.equal(JSON.stringify(p1), JSON.stringify(p1Again));

  mem.setWorkspaceFile("a.txt", "2");
  const t2 = sessions.commitTurn({
    sessionRef: ref,
    title: "turn 2",
    events: [
      { type: "message", message: { role: "user", content: "Change a.txt to 2" } },
      { type: "thinking", content: "editing file" },
      { type: "message", message: { role: "assistant", content: "Updated a.txt to 2." } },
    ],
    metadata: { model: "model-b", tokensIn: 180, tokensOut: 25, cacheRead: 120 },
    timestampSec: 1700000200,
  });

  const p2 = sessions.project(t2, { systemPrompt: "You are a concise coding agent." });

  // P0-5: prefix up to T1 is byte-for-byte identical in T2!
  assert.equal(
    JSON.stringify(p2.messages.slice(0, p1.messages.length)),
    JSON.stringify(p1.messages),
  );
  assert.equal(p2.messages.length, p1.messages.length + 2);
});

test("SessionStore (standalone InMemory): dual-parent compaction anchors preserve raw trace & prefix stability", () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const ref = sessionRef("compact-test");

  const t1 = sessions.commitTurn({
    sessionRef: ref,
    title: "t1",
    events: [{ type: "message", message: { role: "user", content: "m1" } }],
  });
  const t2 = sessions.commitTurn({
    sessionRef: ref,
    title: "t2",
    events: [{ type: "message", message: { role: "assistant", content: "m2" } }],
  });

  // First compaction anchor A1 (parent1 = t2)
  const a1 = sessions.compact({
    sessionRef: ref,
    summary: "Summary of t1..t2: m1 -> m2",
  });
  const a1Rec = sessions.readCommit(a1);
  assert.equal(a1Rec.kind, "compact");
  assert.deepEqual(a1Rec.parents, [t2]);

  const t3 = sessions.commitTurn({
    sessionRef: ref,
    title: "t3",
    events: [{ type: "message", message: { role: "user", content: "m3" } }],
  });
  const t4 = sessions.commitTurn({
    sessionRef: ref,
    title: "t4",
    events: [{ type: "message", message: { role: "assistant", content: "m4" } }],
  });

  // Projection stops at A1 (excludes raw t1, t2) while keeping prefix invariant from t3 -> t4
  const p3 = sessions.project(t3, { systemPrompt: "SYS" });
  const p4 = sessions.project(t4, { systemPrompt: "SYS" });
  assert.equal(p3.anchorSha, a1);
  assert.deepEqual(p3.commitChain, [a1, t3]);
  assert.deepEqual(p4.commitChain, [a1, t3, t4]);
  assert.equal(
    JSON.stringify(p4.messages.slice(0, p3.messages.length)),
    JSON.stringify(p3.messages),
  );

  // Second compaction anchor A2: dual parents [A1, t4]
  const a2 = sessions.compact({
    sessionRef: ref,
    summary: "Summary through t4: m1..m4 complete",
  });
  const a2Rec = sessions.readCommit(a2);
  assert.deepEqual(a2Rec.parents, [a1, t4]);

  // First-parent chain gives anchors [A2, A1, t2, t1], while A2^2 preserves raw [t4, t3, A1]
  assert.equal(a2Rec.parents[0], a1);
  assert.equal(a2Rec.parents[1], t4);
  assert.equal(sessions.readCommit(t1).events[0]?.type, "message");
});

test("SessionStore (standalone InMemory): fork + subagent squash-merge preserves parent prefix & full trace", () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const mainRef = sessionRef("main");
  const subRef = agentRef("explore-1");

  const t1 = sessions.commitTurn({
    sessionRef: mainRef,
    title: "root task",
    events: [{ type: "message", message: { role: "user", content: "Investigate auth bug" } }],
  });

  // Fork subagent at T1 (shares exact prefix T1!)
  sessions.fork(mainRef, subRef);
  const s1 = sessions.commitTurn({
    sessionRef: subRef,
    title: "noisy grep 1",
    events: [{ type: "message", message: { role: "assistant", content: "Read 30 files..." } }],
  });
  const s2 = sessions.commitTurn({
    sessionRef: subRef,
    title: "noisy grep 2",
    events: [{ type: "message", message: { role: "assistant", content: "Found null token bug in auth.ts:42" } }],
  });

  const beforeMerge = sessions.project(mainRef);
  const mergeSha = sessions.squashMerge({
    targetSessionRef: mainRef,
    sourceRef: subRef,
    summary: "Root cause: null token dereference at auth.ts:42.",
  });

  const mergeRec = sessions.readCommit(mergeSha);
  assert.equal(mergeRec.kind, "subagent-merge");
  assert.deepEqual(mergeRec.parents, [t1, s2]); // parent1 = main, parent2 = subagent tip

  const afterMerge = sessions.project(mainRef);
  // Parent KV-cache prefix preserved
  assert.equal(
    JSON.stringify(afterMerge.messages.slice(0, beforeMerge.messages.length)),
    JSON.stringify(beforeMerge.messages),
  );
  // Only 1 concise message ingested instead of noisy subagent turns s1, s2
  assert.equal(afterMerge.messages.length, beforeMerge.messages.length + 1);
  assert.match(afterMerge.messages.at(-1)!.content, /auth\.ts:42/);
  // Full raw subagent trace still reachable via parent2
  assert.equal(sessions.readCommit(mergeRec.parents[1]!).parents[0], s1);
});

test("End-to-end GitCliStore + SessionStore: P0-1 co-atomic rewind + P0-2 zero repo pollution + P0-3 model swap", () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("e2e");

    // Turn 1 (Model A): edit app.ts -> 1
    fs.writeFileSync(path.join(repo, "app.ts"), "export const x = 1;\n");
    const t1 = sessions.commitTurn({
      sessionRef: ref,
      title: "set x = 1",
      events: [
        { type: "message", message: { role: "user", content: "Set x to 1" } },
        { type: "message", message: { role: "assistant", content: "Set x = 1 in app.ts" } },
      ],
      metadata: { model: "claude-sonnet" },
    });

    // Turn 2 (Model B — mid-session model swap): bad edit + junk file
    fs.writeFileSync(path.join(repo, "app.ts"), "export const x = 999; // broken\n");
    fs.writeFileSync(path.join(repo, "bad-file.ts"), "should disappear on rewind\n");
    const t2 = sessions.commitTurn({
      sessionRef: ref,
      title: "bad experiment",
      events: [
        { type: "message", message: { role: "user", content: "Try setting x to 999" } },
        { type: "message", message: { role: "assistant", content: "Created bad-file.ts and set x=999" } },
      ],
      metadata: { model: "gpt-5" },
    });

    assert.equal(sessions.readCommit(t2).trailers["Model"], "gpt-5");

    // Co-atomic rewind back to T1, preserving abandoned branch T2 under a backup ref
    sessions.rewind(ref, t1, { preserveAbandonedAs: "refs/harness/abandoned/e2e-try1" });

    // Both session HEAD and working tree files match T1 with 0-byte diff
    assert.equal(gitStore.readRef(ref), t1);
    assert.equal(gitStore.readRef("refs/harness/abandoned/e2e-try1"), t2);
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf8"), "export const x = 1;\n");
    assert.equal(fs.existsSync(path.join(repo, "bad-file.ts")), false);

    // Projected prompt matches T1 exactly
    const projected = sessions.project(ref);
    assert.equal(projected.messages.length, 2);
    assert.equal(projected.messages[1]?.content, "Set x = 1 in app.ts");

    // Host repo branches & commit history completely untouched
    const logLines = execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" })
      .trim()
      .split("\n");
    assert.equal(logLines.length, 1);
    assert.match(logLines[0]!, /init/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
