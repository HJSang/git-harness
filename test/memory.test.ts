import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCliStore, InMemoryObjectStore } from "../src/git-store/index.ts";
import {
  MemoryStore,
  RecallIndex,
  createPinnedMemoryHook,
  createRecallTool,
  noSecretsGate,
  nonAbandonedSourceGate,
} from "../src/memory/index.ts";
import { AgentRuntime, MockModelAdapter, createCoreTools } from "../src/runtime/index.ts";
import { SessionStore, agentRef, sessionRef } from "../src/session/index.ts";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-mem-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("MemoryStore (standalone InMemory): progressive disclosure + P0-10 anti-poisoning promotion gates", async () => {
  const mem = new InMemoryObjectStore();
  const memory = new MemoryStore(mem);

  // Trusted put into system/ and facts/
  memory.put({
    message: "seed project rules",
    files: [
      { path: "system/rules.md", content: "Never modify migration files." },
      { path: "facts/testing.md", content: "Run tests with npm test." },
    ],
  });

  assert.deepEqual(memory.list(), ["facts/testing.md", "system/rules.md"]);
  assert.match(memory.renderPinnedSystemMemory(), /Never modify migration files/);
  assert.doesNotMatch(memory.renderPinnedSystemMemory(), /npm test/);

  const headBefore = mem.readRef(memory.ref);

  // P0-10 Test 1: Secret leak proposal is BLOCKED and refs/harness/memory stays untouched
  memory.propose("leak-1", {
    message: "add env note",
    files: [{ path: "facts/env.md", content: "API key is sk-proj-1234567890abcdefghijklmnop" }],
  });
  const blockedSecret = await memory.promote("leak-1", [noSecretsGate()]);
  assert.equal(blockedSecret.promoted, false);
  assert.equal(blockedSecret.failedGates?.[0]?.name, "no-secrets");
  assert.equal(mem.readRef(memory.ref), headBefore);
  memory.reject("leak-1");

  // P0-10 Test 2: Proposal sourced from an abandoned branch is BLOCKED
  memory.propose("abandoned-1", {
    message: "hallucinated convention",
    files: [{ path: "facts/wrong.md", content: "Use YAML everywhere." }],
    sourceRef: "refs/harness/abandoned/failed-try",
  });
  const blockedAbandoned = await memory.promote("abandoned-1", [
    noSecretsGate(),
    nonAbandonedSourceGate(mem),
  ]);
  assert.equal(blockedAbandoned.promoted, false);
  assert.equal(blockedAbandoned.failedGates?.[0]?.name, "non-abandoned-source");
  assert.equal(mem.readRef(memory.ref), headBefore);
  memory.reject("abandoned-1");

  // Clean proposal passes all gates and commits with parent2 = proposal commit for auditability
  const goodProp = memory.propose("clean-1", {
    message: "record build decision",
    files: [{ path: "decisions/001-node24.md", content: "Zero-dep Node 24 TypeScript core." }],
  });
  const promoted = await memory.promote("clean-1", [noSecretsGate(), nonAbandonedSourceGate(mem)]);
  assert.equal(promoted.promoted, true);
  assert.ok(promoted.commitSha);
  assert.equal(memory.read("decisions/001-node24.md"), "Zero-dep Node 24 TypeScript core.");
  assert.deepEqual(mem.readCommit(promoted.commitSha!).parents, [headBefore, goodProp.sha]);
});

test("RecallIndex: cold recall retrieves exact details hidden behind compaction anchors & squash-merged subagents", () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const memory = new MemoryStore(mem);
  const mainRef = sessionRef("main");
  const subRef = agentRef("debug-1");

  // Turn 1 contains an exact error code that will be compacted away
  const t1 = sessions.commitTurn({
    sessionRef: mainRef,
    title: "investigate timeout",
    events: [
      {
        type: "message",
        message: { role: "assistant", content: "Observed ERR_POOL_EXHAUSTED_9042 in db/pool.ts:118." },
      },
    ],
  });

  // Compact away Turn 1 into a high-level summary that omits the exact code
  sessions.compact({
    sessionRef: mainRef,
    summary: "Investigated a database connection issue.",
  });

  // Fork subagent with a specific finding, squash-merge it, then delete the subagent ref!
  sessions.fork(mainRef, subRef);
  const s1 = sessions.commitTurn({
    sessionRef: subRef,
    title: "subagent trace",
    events: [
      {
        type: "message",
        message: { role: "assistant", content: "Found retry backoff bug in middleware/retry.ts:77." },
      },
    ],
  });
  sessions.squashMerge({
    targetSessionRef: mainRef,
    sourceRef: subRef,
    summary: "Retry middleware fixed.",
  });
  mem.deleteRef(subRef);

  memory.put({
    message: "add convention",
    files: [{ path: "facts/deploy.md", content: "Canary rollout uses region us-west-2." }],
  });

  // Verify active projected prompt does NOT contain the compacted error code or subagent file line
  const activeText = JSON.stringify(sessions.project(mainRef).messages);
  assert.doesNotMatch(activeText, /ERR_POOL_EXHAUSTED_9042/);
  assert.doesNotMatch(activeText, /middleware\/retry\.ts:77/);

  // Rebuild disposable FTS5 RecallIndex from Git DAG -> finds BOTH archived commits + memory!
  const index = new RecallIndex({ store: mem, sessions, memory });
  try {
    const stats = index.rebuild();
    assert.ok(stats.indexedCommits >= 4);
    assert.equal(stats.indexedMemoryFiles, 1);

    const hitCompacted = index.search({ query: "ERR_POOL_EXHAUSTED_9042" });
    assert.equal(hitCompacted.length, 1);
    assert.equal(hitCompacted[0]!.sha, t1);

    const hitSubagent = index.search({ query: "middleware/retry.ts:77" });
    assert.equal(hitSubagent.length, 1);
    assert.equal(hitSubagent[0]!.sha, s1);

    const hitMemory = index.search({ query: "us-west-2", source: "memory" });
    assert.equal(hitMemory.length, 1);
    assert.equal(hitMemory[0]!.path, "facts/deploy.md");
  } finally {
    index.close();
  }
});

test("Memory + Recall plugins integrate cleanly into AgentRuntime on real GitCliStore + disposable DB rebuild", async () => {
  const repo = initTempGitRepo();
  const dbPath = path.join(repo, ".git", "harness-cache", "recall.db");
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const memory = new MemoryStore(gitStore);
    const ref = sessionRef("mem-e2e");

    memory.put({
      message: "pin core invariant",
      files: [
        { path: "system/invariants.md", content: "Always keep Turn-0 prompt under 1500 tokens." },
        { path: "facts/secret-recipe.md", content: "Benchmark runs with node test/bench.ts." },
      ],
    });

    const index = new RecallIndex({ store: gitStore, sessions, memory, dbPath });
    index.rebuild();

    // Wipe the SQLite DB completely and verify deterministic rebuild from Git objects!
    index.close();
    fs.rmSync(dbPath, { force: true });

    const rebuiltIndex = new RecallIndex({ store: gitStore, sessions, memory, dbPath });
    try {
      const stats = rebuiltIndex.rebuild();
      assert.equal(stats.indexedMemoryFiles, 2);

      const model = new MockModelAdapter("mock", (_req, step) => {
        if (step === 0) {
          return {
            content: "Checking recall for benchmark command",
            toolCalls: [
              {
                id: "r1",
                name: "recall",
                arguments: JSON.stringify({ query: "benchmark test/bench.ts", source: "memory" }),
              },
            ],
          };
        }
        return { content: "Found benchmark command: node test/bench.ts", toolCalls: [] };
      });

      const runtime = new AgentRuntime({
        sessions,
        model,
        workspaceRoot: repo,
        tools: [...createCoreTools(), createRecallTool(rebuiltIndex, memory)],
        hooks: [createPinnedMemoryHook(memory)],
      });

      const res = await runtime.runTurn({
        sessionRef: ref,
        userInput: "How do I run the benchmark?",
      });

      // System prompt received pinned `system/invariants.md` automatically via hook!
      assert.match(model.recordedRequests[0]!.messages[0]!.content, /1500 tokens/);
      assert.equal(res.toolCallsExecuted, 1);
      assert.match(res.assistantText, /node test\/bench\.ts/);

      // Host working tree & git history still 100% clean, strict fsck passes!
      assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: repo, encoding: "utf8" }), "");
      execFileSync("git", ["fsck", "--full", "--strict"], { cwd: repo, stdio: "pipe" });
    } finally {
      rebuiltIndex.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("RecallIndex v0.7: indexes refs/harness/archive/* & refs/harness/abandoned/* and auto-refreshes via ensureFresh()", () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const index = new RecallIndex({ store: mem, sessions });

  // Initial build on empty repo
  index.rebuild();
  assert.equal(index.ensureFresh(), false, "Unchanged refs should skip rebuild");

  // Commit directly under an archived subagent ref (as dropOnComplete does)
  const archSha = sessions.commitTurn({
    sessionRef: "refs/harness/archive/agents/sub-feal-1",
    title: "Orphan FEAL crypto derivation",
    events: [
      {
        type: "tool_call",
        id: "w1",
        name: "write",
        arguments: JSON.stringify({ path: "/tmp/feal_attack.py", content: "DELTA_P = 0x0200000082800000" }),
      },
      { type: "message", message: { role: "assistant", content: "Derived FEAL differential DELTA_P_UNIQUE_8280" } },
    ],
    snapshotWorkspace: false,
  });

  // Also commit an abandoned rewind branch
  sessions.commitTurn({
    sessionRef: "refs/harness/abandoned/agent-rewind-1",
    title: "Abandoned experiment",
    events: [{ type: "message", message: { role: "assistant", content: "Abandoned clue ABANDONED_CLUE_771" } }],
    snapshotWorkspace: false,
  });

  // Content-addressed freshness check must detect new refs automatically!
  assert.equal(index.ensureFresh(), true, "New archive/abandoned refs must trigger rebuild");
  assert.equal(index.ensureFresh(), false, "Second call with same refs must be a no-op");

  const archHits = index.search({ query: "DELTA_P_UNIQUE_8280" });
  assert.equal(archHits.length, 1);
  assert.equal(archHits[0]!.sha, archSha);
  assert.equal(archHits[0]!.ref, "refs/harness/archive/agents/sub-feal-1");

  const toolArgHits = index.search({ query: "feal_attack" });
  assert.equal(toolArgHits.length, 1);

  const abandHits = index.search({ query: "ABANDONED_CLUE_771" });
  assert.equal(abandHits.length, 1);
  assert.equal(abandHits[0]!.ref, "refs/harness/abandoned/agent-rewind-1");

  index.close();
});
