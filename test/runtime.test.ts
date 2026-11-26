import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCliStore, InMemoryObjectStore } from "../src/git-store/index.ts";
import {
  AgentRuntime,
  AnthropicAdapter,
  MockModelAdapter,
  OpenAICompatAdapter,
  createAdapterFromModelsConfig,
  createApprovalHook,
  createCoreTools,
  createStuckLoopHook,
  loadModelsConfig,
  type RuntimeEvent,
  type RuntimeHook,
  type Tool,
} from "../src/runtime/index.ts";
import { SessionStore, createHistoryTool, sessionRef } from "../src/session/index.ts";
import { formatSessionLog } from "../src/cli/main.ts";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-rt-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello world\n");
  execFileSync("git", ["add", "hello.txt"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("Runtime P0-7: Turn-0 system prompt + 4 core tool schemas stay well under 1,500 tokens", () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const model = new MockModelAdapter("mock", () => ({ content: "ok", toolCalls: [] }));
  const runtime = new AgentRuntime({ sessions, model, workspaceRoot: "/tmp" });

  const spec = runtime.getPromptOverheadSpec();
  const serialized = spec.systemPrompt + "\n" + JSON.stringify(spec.toolSchemas);
  // Conservative upper-bound estimate: ~3.5 chars/token (English + JSON punctuation)
  const approxTokens = Math.ceil(serialized.length / 3.5);

  assert.equal(spec.toolSchemas.length, 4);
  assert.ok(
    approxTokens < 1500,
    `Expected Turn-0 prompt tax < 1500 tokens, got ~${approxTokens} (${serialized.length} chars)`,
  );
});

test("Models config loader: parses Pi-compatible models.json and expands $ENV_VAR", () => {
  const cfgPath = path.resolve(import.meta.dirname, "..", "models.json");
  const cfg = loadModelsConfig(cfgPath);
  const adapter = createAdapterFromModelsConfig({
    config: cfg,
    provider: "openai",
    env: { OPENAI_API_KEY: "test-secret-value" },
  });
  assert.ok(adapter);
  assert.equal(adapter.id, "gpt-4.1");

  // Missing env key fails cleanly with actionable hint
  assert.throws(
    () => createAdapterFromModelsConfig({ config: cfg, provider: "openai", env: {} }),
    /\$OPENAI_API_KEY/,
  );
});

test("Runtime P0-8: denying preTool hook blocks filesystem & bash side effects BEFORE execution", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("safety");

    const denyWritesAndBash: RuntimeHook = {
      name: "read-only-policy",
      preTool(ctx) {
        if (ctx.toolName === "write" || ctx.toolName === "bash") {
          return { allow: false, reason: "read-only mode forbids mutations" };
        }
        return { allow: true };
      },
    };

    const model = new MockModelAdapter("mock-model", (_req, step) => {
      if (step === 0) {
        return {
          content: "Attempting write and bash",
          toolCalls: [
            {
              id: "tc-1",
              name: "write",
              arguments: JSON.stringify({ path: "pwned.txt", content: "bad" }),
            },
            {
              id: "tc-2",
              name: "bash",
              arguments: JSON.stringify({ command: "touch pwned-bash.txt" }),
            },
          ],
          usage: { tokensIn: 200, tokensOut: 30 },
        };
      }
      return {
        content: "Understood, mutations are blocked.",
        toolCalls: [],
        usage: { tokensIn: 260, tokensOut: 15 },
      };
    });

    const events: RuntimeEvent[] = [];
    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: repo,
      hooks: [denyWritesAndBash],
      onEvent: (ev) => events.push(ev),
    });

    const res = await runtime.runTurn({
      sessionRef: ref,
      userInput: "Try modifying files",
    });

    // Neither file may exist on disk — blocked BEFORE execution!
    assert.equal(fs.existsSync(path.join(repo, "pwned.txt")), false);
    assert.equal(fs.existsSync(path.join(repo, "pwned-bash.txt")), false);
    assert.equal(res.toolCallsExecuted, 0);
    assert.equal(events.filter((e) => e.type === "tool_blocked").length, 2);
    assert.match(res.assistantText, /blocked/i);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime tools: workspace boundary blocks ../ path escape", async () => {
  const repo = initTempGitRepo();
  try {
    const tools = createCoreTools({ enforceWorkspaceBoundary: true });
    const readTool = tools.find((t) => t.schema.name === "read")!;
    const writeTool = tools.find((t) => t.schema.name === "write")!;

    const readRes = await readTool.execute({ path: "../etc/passwd" }, { workspaceRoot: repo, sessionRef: "s" });
    assert.equal(readRes.isError, true);
    assert.match(readRes.output, /escapes workspace root/i);

    const writeRes = await writeTool.execute(
      { path: "../escape.txt", content: "nope" },
      { workspaceRoot: repo, sessionRef: "s" },
    );
    assert.equal(writeRes.isError, true);
    assert.match(writeRes.output, /escapes workspace root/i);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime E2E: 4-tool loop + KV-cache prefix stability + model swap + co-atomic rewind + auto-compact", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("e2e-loop");

    // Turn 1 (Model A): write -> edit -> read -> bash
    const modelA = new MockModelAdapter("model-a", (_req, step) => {
      if (step === 0) {
        return {
          content: "Creating calc.mjs",
          toolCalls: [
            {
              id: "c1",
              name: "write",
              arguments: JSON.stringify({
                path: "calc.mjs",
                content: "export const add = (a, b) => a - b;\n",
              }),
            },
          ],
          usage: { tokensIn: 300, tokensOut: 40 },
        };
      }
      if (step === 1) {
        return {
          content: "Fixing operator to +",
          toolCalls: [
            {
              id: "c2",
              name: "edit",
              arguments: JSON.stringify({
                path: "calc.mjs",
                oldText: "a - b",
                newText: "a + b",
              }),
            },
            {
              id: "c3",
              name: "read",
              arguments: JSON.stringify({ path: "calc.mjs" }),
            },
          ],
          usage: { tokensIn: 400, tokensOut: 45, cacheRead: 290 },
        };
      }
      if (step === 2) {
        return {
          content: "Running quick node verification",
          toolCalls: [
            {
              id: "c4",
              name: "bash",
              arguments: JSON.stringify({
                command: `node -e "import('./calc.mjs').then(m => console.log(m.add(2, 3)))"`,
              }),
            },
          ],
          usage: { tokensIn: 480, tokensOut: 30, cacheRead: 390 },
        };
      }
      return {
        content: "Implemented calc.mjs and verified add(2, 3) === 5.",
        toolCalls: [],
        usage: { tokensIn: 520, tokensOut: 25, cacheRead: 470 },
      };
    });

    const runtime = new AgentRuntime({
      sessions,
      model: modelA,
      workspaceRoot: repo,
      autoCompactThresholdTokens: 900,
    });

    const r1 = await runtime.runTurn({
      sessionRef: ref,
      userInput: "Create calc.mjs with add(a, b) and verify it",
    });

    assert.equal(r1.toolCallsExecuted, 4);
    assert.equal(r1.compactedAnchorSha, undefined);
    assert.equal(
      fs.readFileSync(path.join(repo, "calc.mjs"), "utf8"),
      "export const add = (a, b) => a + b;\n",
    );

    const projectedAfterT1 = sessions.project(ref, {
      systemPrompt: runtime.getPromptOverheadSpec().systemPrompt,
    });

    // Turn 2 (Swap to Model B mid-session — hits autoCompactThresholdTokens=900)
    const modelB = new MockModelAdapter("model-b", (_req, step) => {
      if (step === 0) {
        return {
          content: "Adding a buggy file",
          toolCalls: [
            {
              id: "c5",
              name: "write",
              arguments: JSON.stringify({ path: "broken.mjs", content: "throw new Error('boom');\n" }),
            },
          ],
          usage: { tokensIn: 950, tokensOut: 30, cacheRead: 510 },
        };
      }
      if (step === 1) {
        return {
          content: "Wrote broken.mjs.",
          toolCalls: [],
          usage: { tokensIn: 1020, tokensOut: 20, cacheRead: 940 },
        };
      }
      // Step 2 is the auto-compaction summary call!
      return {
        content: "Goal: calc.mjs implemented (add verified); broken.mjs added in turn 2.",
        toolCalls: [],
        usage: { tokensIn: 1050, tokensOut: 30 },
      };
    });

    runtime.setModel(modelB);
    const r2 = await runtime.runTurn({
      sessionRef: ref,
      userInput: "Add broken.mjs",
    });

    // P0-5: Turn 2's first model request MUST share byte-for-byte prefix with Turn 1's projected messages!
    const t2FirstReqMsgs = modelB.recordedRequests[0]!.messages;
    assert.equal(
      JSON.stringify(t2FirstReqMsgs.slice(0, projectedAfterT1.messages.length)),
      JSON.stringify(projectedAfterT1.messages),
    );

    // Auto-compaction triggered and produced a dual-parent/anchor commit
    assert.ok(r2.compactedAnchorSha);
    assert.equal(gitStore.readRef(ref), r2.compactedAnchorSha);

    // CLI log formatter renders nicely
    const logText = formatSessionLog(sessions.logFirstParent(ref), gitStore.readRef(ref));
    assert.match(logText, /compact/);
    assert.match(logText, /model-b/);

    // Rewind back to Turn 1: restores BOTH session AND files (broken.mjs disappears, calc.mjs remains!)
    sessions.rewind(ref, r1.commitSha);
    assert.equal(fs.existsSync(path.join(repo, "broken.mjs")), false);
    assert.equal(
      fs.readFileSync(path.join(repo, "calc.mjs"), "utf8"),
      "export const add = (a, b) => a + b;\n",
    );

    // Host repo history still untouched and passes strict fsck
    const hostLog = execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" })
      .trim()
      .split("\n");
    assert.equal(hostLog.length, 1);
    execFileSync("git", ["fsck", "--full", "--strict"], { cwd: repo, stdio: "pipe" });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime detached gitDir + intra-turn checkpoints + intra-turn auto-compact + profiler NDJSON", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-nongit-"));
  const detachedDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-gd-"));
  const gitDir = path.join(detachedDir, "harness.git");
  const profilePath = path.join(detachedDir, "profile.jsonl");
  try {
    fs.writeFileSync(path.join(workDir, "input.txt"), "seed\n");

    const gitStore = new GitCliStore({ repoRoot: workDir, gitDir });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("autonomous");

    const model = new MockModelAdapter("mock-auto", (_req, step) => {
      if (step === 0) {
        return {
          content: "Step 1: write out.txt",
          toolCalls: [
            {
              id: "s1",
              name: "write",
              arguments: JSON.stringify({ path: "out.txt", content: "v1\n" }),
            },
          ],
          usage: { tokensIn: 500, tokensOut: 20, cacheRead: 0 },
        };
      }
      if (step === 1) {
        return {
          content: "Step 2: edit out.txt (triggers intra-turn auto-compact at 1000 tokens)",
          toolCalls: [
            {
              id: "s2",
              name: "edit",
              arguments: JSON.stringify({ path: "out.txt", oldText: "v1", newText: "v2" }),
            },
          ],
          usage: { tokensIn: 1100, tokensOut: 25, cacheRead: 480 },
        };
      }
      if (step === 2) {
        // Compaction summary call triggered mid-turn after step 2!
        return {
          content: "Goal: wrote and edited out.txt to v2.",
          toolCalls: [],
          usage: { tokensIn: 1150, tokensOut: 15 },
        };
      }
      // Step 3 continues seamlessly on compacted messages!
      return {
        content: "All done after intra-turn compaction.",
        toolCalls: [],
        usage: { tokensIn: 300, tokensOut: 15, cacheRead: 200 },
      };
    });

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: workDir,
      defaultCheckpointEverySteps: 1,
      autoCompactThresholdTokens: 1000,
      profileLogPath: profilePath,
    });

    const res = await runtime.runTurn({
      sessionRef: ref,
      userInput: "Create and update out.txt",
    });

    // Zero .git folder dropped inside non-Git workDir!
    assert.equal(fs.existsSync(path.join(workDir, ".git")), false);
    assert.equal(fs.readFileSync(path.join(workDir, "out.txt"), "utf8"), "v2\n");
    assert.equal(res.checkpointsCommitted, 3);
    assert.ok(res.compactedAnchorSha);

    // Profiler wrote 3 structured NDJSON step rows
    const rows = fs
      .readFileSync(profilePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { step: number; checkpointSha?: string; compactedAnchorSha?: string });
    assert.equal(rows.length, 3);
    assert.ok(rows[0]!.checkpointSha);
    assert.ok(rows[1]!.compactedAnchorSha);

    // Step 3 prompt was re-projected from the compacted anchor (contains summary, far fewer msgs)
    const step3Req = model.recordedRequests[3]!;
    assert.match(JSON.stringify(step3Req.messages), /Compacted Session Summary/);

    execFileSync("git", ["--git-dir", gitDir, "fsck", "--full", "--strict"], { stdio: "pipe" });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(detachedDir, { recursive: true, force: true });
  }
});

test("Runtime v0.2: bash supports pipefail, oversized outputs offload to Git blob://<sha>, and read-only steps skip snapshots", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("v02-offload");

    // Seed a 500-line file (~21 KB): stays inline for explicit `read` (default 32KB read threshold),
    // while `bash` output > 2048 bytes IS offloaded to a Git blob!
    const lines = Array.from({ length: 500 }, (_, i) => `LINE_${i + 1}: payload_value_${i + 1}_padding_text`);
    fs.writeFileSync(path.join(repo, "big.txt"), lines.join("\n") + "\n");

    let capturedBlobUri = "";
    const model = new MockModelAdapter("mock-v02", (req, step) => {
      if (step === 0) {
        return {
          content: "Test pipefail + large bash output offloading and explicit read staying inline",
          toolCalls: [
            {
              id: "b1",
              name: "bash",
              arguments: JSON.stringify({ command: "set -o pipefail; cat big.txt | cat" }),
            },
            {
              id: "r1",
              name: "read",
              arguments: JSON.stringify({ path: "big.txt", startLine: 1, endLine: 200 }),
            },
          ],
        };
      }
      if (step === 1) {
        // bash output (>2048B) MUST be offloaded; explicit read (~8KB < 32KB) MUST stay inline!
        const bashMsg = req.messages.find((m) => m.role === "tool" && m.name === "bash")!;
        const readMsg = req.messages.find((m) => m.role === "tool" && m.name === "read")!;
        const match = bashMsg.content.match(/blob:\/\/([0-9a-f]{40})/);
        assert.ok(match, "Expected oversized bash output to be offloaded to blob://<sha>");
        assert.doesNotMatch(readMsg.content, /offloaded .* to Git blob/);
        capturedBlobUri = `blob://${match[1]}`;
        return {
          content: "Inspecting line 250 from offloaded Git blob",
          toolCalls: [
            {
              id: "r2",
              name: "read",
              arguments: JSON.stringify({ path: capturedBlobUri, startLine: 250, endLine: 251 }),
            },
          ],
        };
      }
      const blobMsg = req.messages.at(-1)!;
      assert.match(blobMsg.content, /LINE_250: payload_value_250/);
      return { content: "Verified pipefail, tool-aware offloading, and blob read.", toolCalls: [] };
    });

    let snapshotCalls = 0;
    const origSnap = gitStore.snapshotWorkspace.bind(gitStore);
    gitStore.snapshotWorkspace = () => {
      snapshotCalls++;
      return origSnap();
    };

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: repo,
      defaultCheckpointEverySteps: 1,
      offloadOutputThresholdBytes: 2048,
    });

    const res = await runtime.runTurn({
      sessionRef: ref,
      userInput: "Verify v0.2 features",
    });

    assert.equal(res.checkpointsCommitted, 3);
    assert.ok(capturedBlobUri.startsWith("blob://"));
    // Step 1 ran bash (1 snapshot); Step 2 ran ONLY read (readOnly=true -> skipped!); Step 3 had 0 tools (skipped!)
    assert.equal(snapshotCalls, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime v0.4: history tool (log/diff/rewind) + commit://<sha>/<path> read + StuckLoopHook", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("v04-history");

    // Seed clean checkpoint T1
    fs.writeFileSync(path.join(repo, "app.txt"), "clean-v1\n");
    const t1 = sessions.commitTurn({
      sessionRef: ref,
      title: "clean baseline",
      events: [{ type: "message", message: { role: "assistant", content: "Baseline clean-v1 saved." } }],
    });

    // Mutate file and trigger 2 failing bash calls (threshold=2) -> StuckLoopHook injects recovery nudge!
    fs.writeFileSync(path.join(repo, "app.txt"), "broken-v2\n");
    let sawStuckNotice = false;
    let sawOldCommitContent = false;

    const model = new MockModelAdapter("mock-v04", (req, step) => {
      if (step === 0) {
        return {
          content: "Run failing test 1",
          toolCalls: [{ id: "f1", name: "bash", arguments: JSON.stringify({ command: "exit 1" }) }],
        };
      }
      if (step === 1) {
        return {
          content: "Run failing test 2",
          toolCalls: [{ id: "f2", name: "bash", arguments: JSON.stringify({ command: "exit 1" }) }],
        };
      }
      if (step === 2) {
        const lastTool = req.messages.at(-1)!;
        if (/Harness Stuck-Loop Notice/.test(lastTool.content)) sawStuckNotice = true;
        return {
          content: "Inspecting history diff, reading old commit file, and rewinding",
          toolCalls: [
            { id: "h1", name: "history", arguments: JSON.stringify({ action: "diff", fromSha: t1.slice(0, 8) }) },
            {
              id: "r1",
              name: "read",
              arguments: JSON.stringify({ path: `commit://${t1.slice(0, 8)}/workspace/app.txt` }),
            },
            { id: "h2", name: "history", arguments: JSON.stringify({ action: "rewind", targetSha: t1.slice(0, 8) }) },
          ],
        };
      }
      const readRes = req.messages.find((m) => m.role === "tool" && m.name === "read");
      if (readRes && /clean-v1/.test(readRes.content)) sawOldCommitContent = true;
      return { content: "Rewound cleanly to baseline.", toolCalls: [] };
    });

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: repo,
      defaultCheckpointEverySteps: 1,
      tools: [
        ...createCoreTools({
          readBlob: (sha) => sessions.readBlob(sha),
          readCommitFile: (sha, p) => sessions.readCommitFile(sha, p),
        }),
        createHistoryTool(sessions),
      ],
      hooks: [createStuckLoopHook({ sessions, failureStreakThreshold: 2 })],
    });

    await runtime.runTurn({ sessionRef: ref, userInput: "Fix app.txt" });

    assert.equal(sawStuckNotice, true);
    assert.equal(sawOldCommitContent, true);
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "clean-v1\n");
    assert.ok(gitStore.listRefs("refs/harness/abandoned/").length >= 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime v0.5: parallel tool waves run read-only tools concurrently while preserving deterministic order & write barriers", async () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const ref = sessionRef("parallel-waves");

  let activeRead = 0;
  let maxConcurrentRead = 0;
  const orderLog: string[] = [];

  const slowRead: Tool = {
    readOnly: true,
    schema: {
      name: "slow_read",
      description: "Async read-only tool for concurrency verification",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, delayMs: { type: "number" } },
        required: ["id"],
      },
    },
    async execute(args) {
      const id = String(args.id);
      const delayMs = Number(args.delayMs ?? 40);
      activeRead++;
      maxConcurrentRead = Math.max(maxConcurrentRead, activeRead);
      orderLog.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, delayMs));
      activeRead--;
      orderLog.push(`end:${id}`);
      return { output: `read-result-${id}` };
    },
  };

  const barrierWrite: Tool = {
    schema: {
      name: "barrier_write",
      description: "Mutating tool that must act as an ordering barrier",
      parameters: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
    },
    async execute(args) {
      // No read should still be in-flight when barrier executes!
      assert.equal(activeRead, 0);
      orderLog.push(`write:${String(args.tag)}`);
      return { output: `wrote-${String(args.tag)}` };
    },
  };

  let observedToolOrder: string[] = [];
  const model = new MockModelAdapter("parallel-mock", (req, step) => {
    if (step === 0) {
      return {
        content: "Running 3 slow reads (reverse delays), then a write barrier, then a final read",
        toolCalls: [
          { id: "t1", name: "slow_read", arguments: JSON.stringify({ id: "A", delayMs: 70 }) },
          { id: "t2", name: "slow_read", arguments: JSON.stringify({ id: "B", delayMs: 25 }) },
          { id: "t3", name: "slow_read", arguments: JSON.stringify({ id: "C", delayMs: 10 }) },
          { id: "t4", name: "barrier_write", arguments: JSON.stringify({ tag: "W1" }) },
          { id: "t5", name: "slow_read", arguments: JSON.stringify({ id: "D", delayMs: 10 }) },
        ],
      };
    }
    observedToolOrder = req.messages.filter((m) => m.role === "tool").map((m) => m.content);
    return { content: "All waves completed in deterministic order.", toolCalls: [] };
  });

  const runtime = new AgentRuntime({
    sessions,
    model,
    workspaceRoot: "/tmp",
    tools: [slowRead, barrierWrite],
  });

  const res = await runtime.runTurn({ sessionRef: ref, userInput: "Run parallel waves" });
  assert.equal(res.toolCallsExecuted, 5);
  // First 3 slow_read calls overlapped concurrently!
  assert.equal(maxConcurrentRead, 3);
  // Barrier ran AFTER A, B, C ended and BEFORE D started!
  const writeIdx = orderLog.indexOf("write:W1");
  assert.ok(orderLog.indexOf("end:A") < writeIdx);
  assert.ok(orderLog.indexOf("end:B") < writeIdx);
  assert.ok(orderLog.indexOf("end:C") < writeIdx);
  assert.ok(writeIdx < orderLog.indexOf("start:D"));
  // Deterministic message ordering MUST match original toolCalls order (A, B, C, W1, D) even though C finished first!
  assert.deepEqual(observedToolOrder, [
    "read-result-A",
    "read-result-B",
    "read-result-C",
    "wrote-W1",
    "read-result-D",
  ]);
});

test("Runtime v0.5: StuckLoopHook detects file-churn oscillation (even with exit-0 probes) + step-budget warning", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("churn-budget");

    let sawChurnNotice = false;
    let sawBudgetNotice = false;

    const model = new MockModelAdapter("churn-mock", (req, step) => {
      const toolTexts = req.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
      if (/Harness File-Churn Notice/.test(toolTexts)) sawChurnNotice = true;
      if (/Harness Budget Notice/.test(toolTexts)) sawBudgetNotice = true;

      if (step < 4) {
        // Edit hello.txt and run an exit-0 probe each step (resets failureStreak, tests file-churn + budget!)
        return {
          content: `Iteration ${step}`,
          toolCalls: [
            {
              id: `w-${step}`,
              name: "write",
              arguments: JSON.stringify({ path: "hello.txt", content: `attempt-${step}\n` }),
            },
            {
              id: `b-${step}`,
              name: "bash",
              arguments: JSON.stringify({ command: "echo probe-ok" }),
            },
          ],
        };
      }
      return { content: "Stepping back after notices.", toolCalls: [] };
    });

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: repo,
      defaultMaxSteps: 5,
      hooks: [
        createStuckLoopHook({
          sessions,
          fileChurnThreshold: 3,
          budgetWarningRatio: 0.75,
        }),
      ],
    });

    await runtime.runTurn({ sessionRef: ref, userInput: "Iterate on hello.txt" });
    assert.equal(sawChurnNotice, true, "Expected file-churn notice after 3 writes to hello.txt");
    assert.equal(sawBudgetNotice, true, "Expected step-budget notice at >=75% of maxSteps");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime v0.5: OpenAICompatAdapter & AnthropicAdapter SSE streaming + AgentRuntime delta events", async () => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
      assert.equal(body.stream, true, "Expected stream: true in SSE request body");

      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = [
          { choices: [{ delta: { reasoning_content: "think-" } }] },
          { choices: [{ delta: { reasoning_content: "ok" } }] },
          { choices: [{ delta: { content: "Hello " } }] },
          { choices: [{ delta: { content: "world!" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"hello.txt"}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          {
            choices: [],
            usage: { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 90 } },
          },
        ];
        for (const f of frames) {
          res.write(`data: ${JSON.stringify(f)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events: Array<[string, unknown]> = [
          [
            "message_start",
            { type: "message_start", message: { usage: { input_tokens: 200, cache_read_input_tokens: 150 } } },
          ],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } }],
          ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi " } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Claude" } }],
          [
            "content_block_start",
            { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "bash" } },
          ],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' } },
          ],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 22 } }],
        ];
        for (const [ev, payload] of events) {
          res.write(`event: ${ev}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. OpenAI-compatible SSE stream
    const oai = new OpenAICompatAdapter({
      model: "mock-oai",
      apiKey: "test",
      baseUrl: `${baseUrl}/v1`,
    });
    const oaiDeltas: Array<{ type: string; text: string }> = [];
    const oaiRes = await oai.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: (d) => oaiDeltas.push(d),
    });
    assert.equal(oaiRes.content, "Hello world!");
    assert.equal(oaiRes.thinking, "think-ok");
    assert.equal(oaiRes.stopReason, "tool_use");
    assert.deepEqual(oaiRes.toolCalls, [{ id: "call_1", name: "read", arguments: '{"path":"hello.txt"}' }]);
    assert.deepEqual(oaiRes.usage, { tokensIn: 120, tokensOut: 15, cacheRead: 90 });
    assert.deepEqual(
      oaiDeltas.map((d) => `${d.type}:${d.text}`),
      ["thinking:think-", "thinking:ok", "text:Hello ", "text:world!"],
    );

    // 2. Anthropic SSE stream
    const anth = new AnthropicAdapter({
      model: "mock-anth",
      apiKey: "test",
      baseUrl,
    });
    const anthDeltas: Array<{ type: string; text: string }> = [];
    const anthRes = await anth.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: (d) => anthDeltas.push(d),
    });
    assert.equal(anthRes.content, "Hi Claude");
    assert.equal(anthRes.thinking, "plan");
    assert.equal(anthRes.stopReason, "tool_use");
    assert.deepEqual(anthRes.toolCalls, [{ id: "tu_1", name: "bash", arguments: '{"command":"echo hi"}' }]);
    assert.deepEqual(anthRes.usage, { tokensIn: 200, tokensOut: 22, cacheRead: 150 });
    assert.deepEqual(
      anthDeltas.map((d) => `${d.type}:${d.text}`),
      ["thinking:plan", "text:Hi ", "text:Claude"],
    );

    // 3. AgentRuntime stream: true forwards text_delta & thinking_delta events
    const mem = new InMemoryObjectStore();
    const sessions = new SessionStore(mem);
    const streamModel = new MockModelAdapter("stream-mock", (req) => {
      req.onDelta?.({ type: "thinking", text: "hmm" });
      req.onDelta?.({ type: "text", text: "streamed " });
      req.onDelta?.({ type: "text", text: "reply" });
      return { content: "streamed reply", thinking: "hmm", toolCalls: [] };
    });
    const events: RuntimeEvent[] = [];
    const rt = new AgentRuntime({
      sessions,
      model: streamModel,
      workspaceRoot: "/tmp",
      stream: true,
      onEvent: (ev) => events.push(ev),
    });
    await rt.runTurn({ sessionRef: sessionRef("stream-rt"), userInput: "say hi" });
    assert.deepEqual(
      events.filter((e) => e.type === "text_delta" || e.type === "thinking_delta"),
      [
        { type: "thinking_delta", step: 1, text: "hmm" },
        { type: "text_delta", step: 1, text: "streamed " },
        { type: "text_delta", step: 1, text: "reply" },
      ],
    );
  } finally {
    server.close();
  }
});

test("Runtime v0.5: createApprovalHook auto-allows read-only calls, blocks denied mutations, and honors 'always'", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const ref = sessionRef("approval-test");

    const prompted: string[] = [];
    const approvalHook = createApprovalHook({
      confirm(ctx) {
        prompted.push(ctx.toolName);
        if (ctx.toolName === "bash") return "deny";
        if (ctx.toolName === "write") return "always";
        return "allow";
      },
    });

    const model = new MockModelAdapter("approve-mock", (_req, step) => {
      if (step === 0) {
        return {
          content: "Reading hello.txt, writing a.txt, writing b.txt, and running bash",
          toolCalls: [
            { id: "r1", name: "read", arguments: JSON.stringify({ path: "hello.txt" }) },
            { id: "w1", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "A\n" }) },
            { id: "w2", name: "write", arguments: JSON.stringify({ path: "b.txt", content: "B\n" }) },
            { id: "b1", name: "bash", arguments: JSON.stringify({ command: "touch should-not-exist.txt" }) },
          ],
        };
      }
      return { content: "Done.", toolCalls: [] };
    });

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: repo,
      hooks: [approvalHook],
    });

    const res = await runtime.runTurn({ sessionRef: ref, userInput: "Test approvals" });
    // `read` never prompted; `write` prompted ONCE (returned 'always' -> second write auto-approved); `bash` denied!
    assert.deepEqual(prompted, ["write", "bash"]);
    assert.equal(res.toolCallsExecuted, 3);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "A\n");
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "B\n");
    assert.equal(fs.existsSync(path.join(repo, "should-not-exist.txt")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime v0.6: read tool returns multimodal PNG images & OpenAI/Anthropic adapters serialize them", async () => {
  const repo = initTempGitRepo();
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(repo, "board.png"), pngBytes);

  const capturedPayloads: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      capturedPayloads.push({ path: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/chat/completions") {
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Saw red pixel." } }],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Saw red pixel." }],
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const tools = createCoreTools();
    const readTool = tools.find((t) => t.schema.name === "read")!;
    const res = await readTool.execute({ path: "board.png" }, { workspaceRoot: repo, sessionRef: "s" });
    assert.equal(res.isError, undefined);
    assert.match(res.output, /Image file: board\.png \(image\/png/);
    assert.equal(res.images?.length, 1);
    assert.equal(res.images?.[0]?.mimeType, "image/png");
    assert.equal(res.images?.[0]?.data, pngBytes.toString("base64"));

    const msgs = [
      { role: "user" as const, content: "Inspect board.png" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"board.png"}' }],
      },
      {
        role: "tool" as const,
        name: "read",
        toolCallId: "c1",
        content: res.output,
        images: res.images,
      },
    ];

    const oai = new OpenAICompatAdapter({ model: "m", apiKey: "k", baseUrl: `${baseUrl}/v1` });
    await oai.complete({ messages: msgs, tools: [] });
    const oaiToolMsg = (capturedPayloads[0]!.body.messages as Array<{ role: string; content: unknown }>)[2]!;
    assert.ok(Array.isArray(oaiToolMsg.content));
    assert.equal((oaiToolMsg.content as Array<{ type: string }>)[1]!.type, "image_url");

    const anth = new AnthropicAdapter({ model: "m", apiKey: "k", baseUrl });
    await anth.complete({ messages: msgs, tools: [] });
    const anthMsgs = capturedPayloads[1]!.body.messages as Array<{ role: string; content: Array<{ content: unknown }> }>;
    const toolResultContent = anthMsgs[2]!.content[0]!.content as Array<{ type: string }>;
    assert.ok(Array.isArray(toolResultContent));
    assert.equal(toolResultContent[1]!.type, "image");
  } finally {
    server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime v0.7: graceful no-tools synthesis handoff when maxSteps is reached mid-tool-loop", async () => {
  const repo = initTempGitRepo();
  try {
    const store = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(store);
    const ref = sessionRef("max-steps-synth");

    const seenToolCounts: number[] = [];
    const model = new MockModelAdapter("mock", (req, step) => {
      seenToolCounts.push(req.tools.length);
      if (step < 2) {
        return {
          content: `Working on step ${step}, about to write prototype...`,
          toolCalls: [
            {
              id: `w-${step}`,
              name: "write",
              arguments: JSON.stringify({ path: `proto-${step}.txt`, content: `DELTA_P=0x0200000082800000\n` }),
            },
          ],
        };
      }
      // Synthesis step (tools must be empty!)
      return {
        content: "FINAL HANDOFF: DELTA_P=0x0200000082800000 written to proto-1.txt.",
        toolCalls: [],
      };
    });

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: repo,
      defaultMaxSteps: 2,
    });

    const res = await runtime.runTurn({
      sessionRef: ref,
      userInput: "Derive differential attack",
    });

    assert.equal(res.stopReason, "max_steps");
    assert.equal(res.steps, 2);
    assert.equal(seenToolCounts.length, 3, "Expected 2 action steps + 1 no-tool synthesis step");
    assert.ok(seenToolCounts[0]! > 0 && seenToolCounts[1]! > 0);
    assert.equal(seenToolCounts[2], 0, "Synthesis call must disable all tools");
    assert.match(res.assistantText, /DELTA_P=0x0200000082800000/);

    // Verify synthesis is durably committed on the session branch
    const tip = sessions.readCommit(res.commitSha);
    assert.ok(
      tip.events.some(
        (e) => e.type === "message" && e.message.role === "assistant" && e.message.content.includes("FINAL HANDOFF"),
      ),
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime v0.7.1: StuckLoopHook continues firing past fileChurnWindow and emits wall-clock Time-Budget notice", async () => {
  const repo = initTempGitRepo();
  try {
    const store = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(store);
    const ref = sessionRef("churn-and-time");

    let fakeNow = 1_000_000;
    let churnNotices = 0;
    let timeNotices = 0;

    const model = new MockModelAdapter("mock", (req, step) => {
      const lastTool = [...req.messages].reverse().find((m) => m.role === "tool");
      if (lastTool?.content.includes("Harness File-Churn Notice")) churnNotices++;
      if (lastTool?.content.includes("Harness Time-Budget Notice")) timeNotices++;

      // Advance fake clock by 100s per step (crosses 70% of 600s budget on step 5)
      fakeNow += 100_000;

      if (step < 10) {
        return {
          content: `Edit ${step + 1}`,
          toolCalls: [
            {
              id: `e-${step}`,
              name: "write",
              arguments: JSON.stringify({ path: "gpt2.c", content: `// v${step}\n` }),
            },
          ],
        };
      }
      return { content: "Done.", toolCalls: [] };
    });

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: repo,
      defaultMaxSteps: 20,
      hooks: [
        createStuckLoopHook({
          sessions,
          fileChurnThreshold: 3,
          fileChurnWindow: 5, // Previously saturated at 5 (5 % 3 != 0) so edits 6 & 9 NEVER fired!
          timeBudgetMs: 600_000,
          timeWarningRatio: 0.7,
          now: () => fakeNow,
        }),
      ],
    });

    await runtime.runTurn({ sessionRef: ref, userInput: "Churn on gpt2.c" });
    assert.equal(churnNotices, 3, "Expected File-Churn notices at edits 3, 6, and 9 (no window saturation dead-zone)");
    assert.equal(timeNotices, 1, "Expected exactly one wall-clock Time-Budget notice at >=70% elapsed");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
