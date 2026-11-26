import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCliStore, InMemoryObjectStore } from "../src/git-store/index.ts";
import {
  ExternalCliRunner,
  REVIEW_NOTES_REF,
  RuntimeAgentRunner,
  SubagentOrchestrator,
  commandGate,
  createSubagentTool,
} from "../src/orchestrator/index.ts";
import { AgentRuntime, MockModelAdapter, createCoreTools } from "../src/runtime/index.ts";
import { RecallIndex, createRecallTool } from "../src/memory/index.ts";
import { SessionStore, createHistoryTool, sessionRef } from "../src/session/index.ts";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-orch-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("Orchestrator (standalone InMemory): fork, squash-merge, and drop with zero parent pollution", async () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const orch = new SubagentOrchestrator({ store: mem, sessions, workspaceRoot: "/mem" });
  const mainRef = sessionRef("main");

  sessions.commitTurn({
    sessionRef: mainRef,
    title: "root",
    events: [{ type: "message", message: { role: "user", content: "Plan refactor" } }],
  });

  const beforeHead = mem.readRef(mainRef);

  // Subagent 1: aborted (drop) -> zero parent pollution
  const badHandle = orch.spawn({
    agentId: "bad-spike",
    parentSessionRef: mainRef,
    contextMode: "fork",
  });
  const badRunner = new RuntimeAgentRunner({
    store: mem,
    model: new MockModelAdapter("m", () => ({ content: "dead end", toolCalls: [] })),
    tools: [],
  });
  await orch.run(badHandle, "Try bad idea", badRunner);
  const dropRes = await orch.integrate(badHandle, { mode: "drop" });
  assert.equal(dropRes.integrated, false);
  assert.equal(mem.readRef(mainRef), beforeHead);
  assert.equal(mem.readRef(badHandle.ref), null);

  // Subagent 2: squash-merge -> parent gets concise summary + full trace preserved on parent2
  const goodHandle = orch.spawn({
    agentId: "good-research",
    parentSessionRef: mainRef,
    contextMode: "fork",
  });
  const goodRunner = new RuntimeAgentRunner({
    store: mem,
    model: new MockModelAdapter("m", () => ({ content: "Use strategy X", toolCalls: [] })),
    tools: [],
  });
  const runRes = await orch.run(goodHandle, "Research strategy", goodRunner);
  const mergeRes = await orch.integrate(goodHandle, {
    mode: "squash",
    summary: runRes.summary,
  });
  assert.equal(mergeRes.integrated, true);
  assert.ok(mergeRes.mergeCommitSha);
  const rec = sessions.readCommit(mergeRes.mergeCommitSha!);
  assert.equal(rec.parents[0], beforeHead);
  assert.equal(rec.parents[1], runRes.tipSha);
});

test("Orchestrator E2E: P0-9 parallel isolated worktrees, verifier gate rejection, conflict detection, clean merge", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const orch = new SubagentOrchestrator({ store: gitStore, sessions, workspaceRoot: repo });
    const mainRef = sessionRef("main");

    // Parent has an UNCOMMITTED edit -> subagent worktrees MUST inherit it cleanly!
    fs.writeFileSync(path.join(repo, "shared.txt"), "uncommitted-parent-state\n");
    sessions.commitTurn({
      sessionRef: mainRef,
      title: "parent setup",
      events: [{ type: "message", message: { role: "user", content: "Build module A and module B in parallel" } }],
    });

    // Spawn 2 parallel isolated worktree subagents
    const hA = orch.spawn({ agentId: "worker-a", parentSessionRef: mainRef, isolateWorkspace: true });
    const hB = orch.spawn({ agentId: "worker-b", parentSessionRef: mainRef, isolateWorkspace: true });

    // Both worktrees inherited parent's uncommitted file!
    assert.equal(fs.readFileSync(path.join(hA.workspaceRoot, "shared.txt"), "utf8"), "uncommitted-parent-state\n");
    assert.equal(fs.readFileSync(path.join(hB.workspaceRoot, "shared.txt"), "utf8"), "uncommitted-parent-state\n");

    const runnerA = new RuntimeAgentRunner({
      model: new MockModelAdapter("m-a", (_req, step) => {
        if (step === 0) {
          return {
            content: "Writing modA.mjs",
            toolCalls: [
              {
                id: "a1",
                name: "write",
                arguments: JSON.stringify({ path: "modA.mjs", content: "export const a = 42;\n" }),
              },
            ],
          };
        }
        return { content: "Implemented modA.mjs (a=42).", toolCalls: [] };
      }),
    });

    const runnerB = new RuntimeAgentRunner({
      model: new MockModelAdapter("m-b", (_req, step) => {
        if (step === 0) {
          return {
            content: "Writing modB.mjs",
            toolCalls: [
              {
                id: "b1",
                name: "write",
                arguments: JSON.stringify({ path: "modB.mjs", content: "export const b = 99;\n" }),
              },
            ],
          };
        }
        return { content: "Implemented modB.mjs (b=99).", toolCalls: [] };
      }),
    });

    // Run both concurrently!
    const [resA, resB] = await Promise.all([
      orch.run(hA, "Create modA.mjs", runnerA),
      orch.run(hB, "Create modB.mjs", runnerB),
    ]);

    // P0-9 Blast-radius isolation: parent workspace does NOT have modA or modB yet!
    assert.equal(fs.existsSync(path.join(repo, "modA.mjs")), false);
    assert.equal(fs.existsSync(path.join(repo, "modB.mjs")), false);
    assert.equal(fs.existsSync(path.join(hA.workspaceRoot, "modB.mjs")), false);
    assert.equal(fs.existsSync(path.join(hB.workspaceRoot, "modA.mjs")), false);

    // Verification gate rejection blocks merge BEFORE touching parent workspace!
    const failGate = commandGate("failing-check", "exit 1");
    const blocked = await orch.integrate(hA, {
      mode: "squash",
      summary: resA.summary,
      gates: [failGate],
    });
    assert.equal(blocked.integrated, false);
    assert.equal(blocked.review?.passed, false);
    assert.equal(fs.existsSync(path.join(repo, "modA.mjs")), false);
    // Review report persisted as Git note!
    assert.ok(gitStore.readNote(REVIEW_NOTES_REF, resA.tipSha));

    // Passing verification gate merges worker-a AND worker-b cleanly (disjoint files)
    const passGateA = commandGate("verify-a", `node -e "import('./modA.mjs').then(m => { if (m.a !== 42) process.exit(1); })"`);
    const passGateB = commandGate("verify-b", `node -e "import('./modB.mjs').then(m => { if (m.b !== 99) process.exit(1); })"`);

    const intA = await orch.integrate(hA, { mode: "squash", summary: resA.summary, gates: [passGateA] });
    const intB = await orch.integrate(hB, { mode: "squash", summary: resB.summary, gates: [passGateB] });

    assert.equal(intA.integrated, true);
    assert.equal(intB.integrated, true);
    assert.equal(fs.readFileSync(path.join(repo, "modA.mjs"), "utf8"), "export const a = 42;\n");
    assert.equal(fs.readFileSync(path.join(repo, "modB.mjs"), "utf8"), "export const b = 99;\n");

    // Worktrees cleaned up automatically!
    assert.equal(fs.existsSync(hA.workspaceRoot), false);
    assert.equal(fs.existsSync(hB.workspaceRoot), false);

    // Conflict detection test: parent modifies base.txt after subagent spawns, subagent also modifies base.txt
    const hConflict = orch.spawn({ agentId: "worker-conflict", parentSessionRef: mainRef, isolateWorkspace: true });
    fs.writeFileSync(path.join(repo, "base.txt"), "parent-edited\n");
    const conflictRunner = new ExternalCliRunner({
      name: "meta-sh",
      command: "/bin/sh",
      buildArgs: () => ["-c", "printf 'subagent-edited\\n' > base.txt && echo 'edited base.txt'"],
    });
    await orch.run(hConflict, "Edit base.txt", conflictRunner);
    const conflictRes = await orch.integrate(hConflict, { mode: "squash", summary: "edited base.txt" });
    assert.equal(conflictRes.integrated, false);
    assert.deepEqual(conflictRes.conflictFiles, ["base.txt"]);
    // Parent file was NOT clobbered!
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "parent-edited\n");
    await orch.integrate(hConflict, { mode: "drop" });
    assert.equal(fs.existsSync(hConflict.workspaceRoot), false);

    // Strict Git fsck & host log still clean (only 1 user commit)
    execFileSync("git", ["fsck", "--full", "--strict"], { cwd: repo, stdio: "pipe" });
    const hostCommits = execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" })
      .trim()
      .split("\n");
    assert.equal(hostCommits.length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Orchestrator E2E: meta-harness ExternalCliRunner + cherry-pick salvage from failed branch", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const orch = new SubagentOrchestrator({ store: gitStore, sessions, workspaceRoot: repo });
    const mainRef = sessionRef("main");

    sessions.commitTurn({
      sessionRef: mainRef,
      title: "start",
      events: [{ type: "message", message: { role: "user", content: "Try 2 steps" } }],
    });

    const handle = orch.spawn({
      agentId: "external-meta",
      parentSessionRef: mainRef,
      isolateWorkspace: true,
    });

    // Commit 1 (good helper file) via ExternalCliRunner (simulates wrapping Claude Code / Codex CLI!)
    const step1 = await orch.run(
      handle,
      "Create good helper",
      new ExternalCliRunner({
        name: "mock-codex-cli",
        command: "/bin/sh",
        buildArgs: () => ["-c", "printf 'export const ok = true;\\n' > helper.mjs && echo 'created helper.mjs'"],
      }),
    );

    // Commit 2 (breaks things by adding junk.mjs)
    await orch.run(
      handle,
      "Add broken experiment",
      new ExternalCliRunner({
        name: "mock-codex-cli",
        command: "/bin/sh",
        buildArgs: () => ["-c", "printf 'BROKEN\\n' > junk.mjs && echo 'broke it'"],
      }),
    );

    // Cherry-pick ONLY step1 — helper.mjs lands in parent, junk.mjs does NOT!
    const cp = await orch.integrate(handle, {
      mode: "cherry-pick",
      commitSha: step1.tipSha,
      summary: "Salvaged helper.mjs from external runner step 1",
    });

    assert.equal(cp.integrated, true);
    assert.equal(fs.readFileSync(path.join(repo, "helper.mjs"), "utf8"), "export const ok = true;\n");
    assert.equal(fs.existsSync(path.join(repo, "junk.mjs")), false);
    assert.equal(fs.existsSync(handle.workspaceRoot), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("createSubagentTool: parent AgentRuntime delegates verified & rejected tasks via pluggable tool", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const orch = new SubagentOrchestrator({ store: gitStore, sessions, workspaceRoot: repo });
    const mainRef = sessionRef("tool-parent");

    const subagentTool = createSubagentTool({
      orchestrator: orch,
      createRunner(agentId) {
        if (agentId === "bad-worker") {
          return new ExternalCliRunner({
            name: "bad-cli",
            command: "/bin/sh",
            buildArgs: () => ["-c", "printf 'BROKEN' > bad.mjs && echo 'wrote bad.mjs'"],
          });
        }
        return new ExternalCliRunner({
          name: "good-cli",
          command: "/bin/sh",
          buildArgs: () => ["-c", "printf 'export const ok = 7;\\n' > good.mjs && echo 'wrote good.mjs'"],
        });
      },
    });

    const parentModel = new MockModelAdapter("parent-model", (_req, step) => {
      if (step === 0) {
        return {
          content: "Delegating two subtasks",
          toolCalls: [
            {
              id: "sub-1",
              name: "subagent",
              arguments: JSON.stringify({
                agentId: "bad-worker",
                task: "Write bad.mjs",
                isolateWorkspace: true,
                verifyCommand: "exit 1",
              }),
            },
            {
              id: "sub-2",
              name: "subagent",
              arguments: JSON.stringify({
                agentId: "good-worker",
                task: "Write good.mjs",
                isolateWorkspace: true,
                verifyCommand: `node -e "import('./good.mjs').then(m => { if (m.ok !== 7) process.exit(1); })"`,
              }),
            },
          ],
        };
      }
      return { content: "bad-worker was rejected by gate; good-worker merged cleanly.", toolCalls: [] };
    });

    const runtime = new AgentRuntime({
      sessions,
      model: parentModel,
      workspaceRoot: repo,
      tools: [...createCoreTools(), subagentTool],
    });

    const res = await runtime.runTurn({
      sessionRef: mainRef,
      userInput: "Delegate good and bad workers",
    });

    assert.equal(res.toolCallsExecuted, 2);
    assert.equal(fs.existsSync(path.join(repo, "bad.mjs")), false);
    assert.equal(fs.readFileSync(path.join(repo, "good.mjs"), "utf8"), "export const ok = 7;\n");
    execFileSync("git", ["fsck", "--full", "--strict"], { cwd: repo, stdio: "pipe" });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("createSubagentTool on detached gitDir (non-Git workspace) runs RuntimeAgentRunner cleanly", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-sub-nongit-"));
  const gdParent = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-sub-gd-"));
  const gitDir = path.join(gdParent, "harness.git");
  try {
    fs.writeFileSync(path.join(workDir, "data.txt"), "42\n");
    const gitStore = new GitCliStore({ repoRoot: workDir, gitDir });
    const sessions = new SessionStore(gitStore);
    const orch = new SubagentOrchestrator({ store: gitStore, sessions, workspaceRoot: workDir });
    const mainRef = sessionRef("main");

    const subModel = new MockModelAdapter("sub", () => ({
      content: "Independently verified data.txt === 42.",
      toolCalls: [],
      usage: { tokensIn: 1200, tokensOut: 45, cacheRead: 900 },
    }));
    const parentModel = new MockModelAdapter("parent", (_req, step) => {
      if (step === 0) {
        return {
          content: "Spawning independent verifier",
          toolCalls: [
            {
              id: "s1",
              name: "subagent",
              arguments: JSON.stringify({
                agentId: "independent-check",
                task: "Verify data.txt",
                isolateWorkspace: false,
                dropOnComplete: true,
              }),
            },
          ],
        };
      }
      return { content: "Subagent verified cleanly.", toolCalls: [] };
    });

    const subTool = createSubagentTool({
      orchestrator: orch,
      createRunner: () => new RuntimeAgentRunner({ model: subModel, store: gitStore, gitDir }),
    });

    const profiles: Array<{ toolCalls: Array<{ subagentUsage?: { tokensIn?: number } }> }> = [];
    const runtime = new AgentRuntime({
      sessions,
      model: parentModel,
      workspaceRoot: workDir,
      tools: [...createCoreTools(), subTool],
      onProfile: (p) => profiles.push(p),
    });

    const res = await runtime.runTurn({ sessionRef: mainRef, userInput: "Check data.txt with subagent" });
    assert.equal(res.toolCallsExecuted, 1);
    assert.equal(fs.existsSync(path.join(workDir, ".git")), false);
    // Dropped exploration subagent ref is archived (not lost!) AND its token usage rolled up into profile!
    assert.equal(gitStore.readRef("refs/harness/agents/independent-check"), null);
    assert.ok(gitStore.readRef("refs/harness/archive/agents/independent-check"));
    assert.equal(profiles[0]?.toolCalls[0]?.subagentUsage?.tokensIn, 1200);
    execFileSync("git", ["--git-dir", gitDir, "fsck", "--full", "--strict"], { stdio: "pipe" });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(gdParent, { recursive: true, force: true });
  }
});

test("Orchestrator v0.5: parallel subagent tool calls execute concurrently and squash-merge without CAS collisions", async () => {
  const repo = initTempGitRepo();
  try {
    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const orch = new SubagentOrchestrator({ store: gitStore, sessions, workspaceRoot: repo });
    const mainRef = sessionRef("parallel-subs");

    sessions.commitTurn({
      sessionRef: mainRef,
      title: "seed",
      events: [{ type: "message", message: { role: "user", content: "seed" } }],
    });

    let activeSubs = 0;
    let maxConcurrentSubs = 0;

    const subTool = createSubagentTool({
      orchestrator: orch,
      createRunner(agentId) {
        return new RuntimeAgentRunner({
          model: new MockModelAdapter(`m-${agentId}`, async (_req, step) => {
            if (step === 0) {
              activeSubs++;
              maxConcurrentSubs = Math.max(maxConcurrentSubs, activeSubs);
              await new Promise((r) => setTimeout(r, agentId === "p-one" ? 80 : 40));
              activeSubs--;
              return {
                content: `Writing ${agentId}.txt`,
                toolCalls: [
                  {
                    id: `w-${agentId}`,
                    name: "write",
                    arguments: JSON.stringify({ path: `${agentId}.txt`, content: `from ${agentId}\n` }),
                  },
                ],
              };
            }
            return { content: `Completed ${agentId}`, toolCalls: [] };
          }),
        });
      },
    });

    let observedToolOutputs: string[] = [];
    const parentModel = new MockModelAdapter("parent-par", (req, step) => {
      if (step === 0) {
        return {
          content: "Spawning two isolated subagents in parallel",
          toolCalls: [
            {
              id: "ps-1",
              name: "subagent",
              arguments: JSON.stringify({ agentId: "p-one", task: "Create p-one.txt", isolateWorkspace: true }),
            },
            {
              id: "ps-2",
              name: "subagent",
              arguments: JSON.stringify({ agentId: "p-two", task: "Create p-two.txt", isolateWorkspace: true }),
            },
          ],
        };
      }
      observedToolOutputs = req.messages.filter((m) => m.role === "tool").map((m) => m.content);
      return { content: "Both parallel subagents merged cleanly.", toolCalls: [] };
    });

    const runtime = new AgentRuntime({
      sessions,
      model: parentModel,
      workspaceRoot: repo,
      tools: [...createCoreTools(), subTool],
    });

    const res = await runtime.runTurn({ sessionRef: mainRef, userInput: "Run two workers in parallel" });
    assert.equal(res.toolCallsExecuted, 2);
    assert.equal(maxConcurrentSubs, 2, "Expected both subagent calls to execute concurrently");
    assert.equal(fs.readFileSync(path.join(repo, "p-one.txt"), "utf8"), "from p-one\n");
    assert.equal(fs.readFileSync(path.join(repo, "p-two.txt"), "utf8"), "from p-two\n");
    // Tool result ordering stays deterministic (p-one first, p-two second) even though p-two finished faster!
    assert.match(observedToolOutputs[0] ?? "", /Subagent p-one merged/);
    assert.match(observedToolOutputs[1] ?? "", /Subagent p-two merged/);
    execFileSync("git", ["fsck", "--full", "--strict"], { cwd: repo, stdio: "pipe" });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Orchestrator v0.7: dropped maxSteps subagent synthesizes + is immediately inspectable via recall & history show, plus provenance-only merge", async () => {
  const repo = initTempGitRepo();
  try {
    const store = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(store);
    const orch = new SubagentOrchestrator({ store, sessions, workspaceRoot: repo });
    const recallIndex = new RecallIndex({ store, sessions });
    const mainRef = sessionRef("feal-regression");

    let subagentTipShort = "";
    const subModel = new MockModelAdapter("sub-mock", (req, step) => {
      if (step === 0) {
        return {
          content: "Running final prototype...",
          toolCalls: [
            {
              id: "s-read",
              name: "read",
              arguments: JSON.stringify({ path: "base.txt" }),
            },
          ],
        };
      }
      assert.equal(req.tools.length, 0, "Subagent synthesis step must disable tools");
      return {
        content: "SYNTHESIZED_FEAL_KEY: DELTA_P=0x0200000082800000",
        toolCalls: [],
      };
    });

    const researchModel = new MockModelAdapter("research-mock", (_req, step) => {
      if (step === 0) {
        return {
          content: "Writing scratch note in worktree",
          toolCalls: [
            {
              id: "r-w",
              name: "write",
              arguments: JSON.stringify({ path: "scratch-only.txt", content: "should not enter parent workspace\n" }),
            },
          ],
        };
      }
      return { content: "Research complete without polluting parent workspace.", toolCalls: [] };
    });

    const subagentTool = createSubagentTool({
      orchestrator: orch,
      createRunner: (agentId) =>
        new RuntimeAgentRunner({
          model: agentId === "research-prov" ? researchModel : subModel,
          store,
          tools: createCoreTools(),
          maxSteps: agentId === "research-prov" ? 4 : 1,
        }),
    });

    let sawRecallHit = false;
    let sawHistoryShow = false;
    let sawTruncStatus = false;

    const parentModel = new MockModelAdapter("parent-mock", (req, step) => {
      const toolOutputs = req.messages.filter((m) => m.role === "tool").map((m) => m.content);
      if (step === 0) {
        return {
          content: "Delegate orphan exploration",
          toolCalls: [
            {
              id: "p-sub",
              name: "subagent",
              arguments: JSON.stringify({
                agentId: "feal-orphan",
                task: "Derive FEAL differential",
                contextMode: "orphan",
                dropOnComplete: true,
              }),
            },
          ],
        };
      }
      if (step === 1) {
        const subOut = toolOutputs[0] ?? "";
        sawTruncStatus = /reached maxSteps=1/.test(subOut) && /SYNTHESIZED_FEAL_KEY/.test(subOut);
        const m = subOut.match(/tip=([0-9a-f]{8})/);
        subagentTipShort = m ? m[1]! : "";
        return {
          content: "Verify recall and history show on archived subagent",
          toolCalls: [
            {
              id: "p-rec",
              name: "recall",
              arguments: JSON.stringify({ query: "SYNTHESIZED_FEAL_KEY" }),
            },
            {
              id: "p-show",
              name: "history",
              arguments: JSON.stringify({ action: "show", targetSha: subagentTipShort }),
            },
          ],
        };
      }
      if (step === 2) {
        sawRecallHit = toolOutputs.some((o) => o.includes("refs/harness/archive/agents/feal-orphan"));
        sawHistoryShow = toolOutputs.some((o) => o.includes("Agent-Id: feal-orphan") && o.includes("SYNTHESIZED_FEAL_KEY"));
        return {
          content: "Run provenance-only research merge",
          toolCalls: [
            {
              id: "p-prov",
              name: "subagent",
              arguments: JSON.stringify({
                agentId: "research-prov",
                task: "Explore in isolated worktree without applying workspace edits",
                isolateWorkspace: true,
                dropOnComplete: false,
                applyWorkspaceChanges: false,
              }),
            },
          ],
        };
      }
      return { content: "All invariants verified.", toolCalls: [] };
    });

    const parentRuntime = new AgentRuntime({
      sessions,
      model: parentModel,
      workspaceRoot: repo,
      defaultCheckpointEverySteps: 1,
      tools: [...createCoreTools(), createHistoryTool(sessions), createRecallTool(recallIndex), subagentTool],
    });

    const res = await parentRuntime.runTurn({
      sessionRef: mainRef,
      userInput: "Verify subagent handoff, archive recall, history show, and provenance-only merge",
    });

    assert.equal(res.stopReason, "completed");
    assert.equal(sawTruncStatus, true, "Parent must see maxSteps notice + synthesized findings from dropped subagent");
    assert.equal(sawRecallHit, true, "Auto-refreshed recall must immediately find archived dropped subagent");
    assert.equal(sawHistoryShow, true, "history show must inspect archived subagent tip directly");

    // Provenance-only merge must have attached parent2 on main WITHOUT writing scratch-only.txt to parent workspace!
    assert.equal(fs.existsSync(path.join(repo, "scratch-only.txt")), false);
    const mainLog = sessions.logFirstParent(mainRef, 10);
    assert.ok(
      mainLog.some((c) => c.kind === "subagent-merge" && c.parents.length === 2 && c.trailers["Agent-Id"] === "research-prov"),
      "Expected provenance-only dual-parent subagent-merge commit on main",
    );

    recallIndex.close();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
