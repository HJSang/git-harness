import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCliStore, InMemoryObjectStore } from "../src/git-store/index.ts";
import {
  RuntimeAgentRunner,
  SubagentOrchestrator,
  createSubagentTool,
} from "../src/orchestrator/index.ts";
import { AgentRuntime, MockModelAdapter, createCoreTools } from "../src/runtime/index.ts";
import { SessionStore, sessionRef } from "../src/session/index.ts";
import {
  SkillStore,
  createSkillCatalogHook,
  parseSkillFrontmatter,
} from "../src/skills/index.ts";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-skill-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("parseSkillFrontmatter: parses standard SKILL.md YAML frontmatter and rejects malformed docs", () => {
  const ok = parseSkillFrontmatter(
    "---\nname: debug-tpu\ndescription: Diagnose XLA and TPU compilation stalls\n---\n# Steps\n1. Check logs.\n",
  );
  assert.ok(ok);
  assert.equal(ok.name, "debug-tpu");
  assert.equal(ok.description, "Diagnose XLA and TPU compilation stalls");
  assert.match(ok.body, /Check logs/);

  assert.equal(parseSkillFrontmatter("# Missing frontmatter"), null);
  assert.equal(parseSkillFrontmatter("---\nname: only-name\n---\nbody"), null);
});

test("SkillStore (standalone InMemory): anti-poisoning promotion gates + provenance parent2", async () => {
  const mem = new InMemoryObjectStore();
  const skills = new SkillStore(mem, { includeGlobalDirs: false });

  // 1. Missing frontmatter rejected
  skills.propose("bad-fm", {
    skillName: "broken-skill",
    message: "missing frontmatter",
    files: [{ path: "SKILL.md", content: "# No YAML frontmatter here" }],
  });
  const r1 = await skills.promote("bad-fm");
  assert.equal(r1.promoted, false);
  assert.equal(r1.failedGates?.[0]?.name, "valid-frontmatter");
  assert.equal(skills.readSkillsSha(), null);
  skills.reject("bad-fm");

  // 2. Secret leak rejected
  skills.propose("secret-leak", {
    skillName: "deploy-skill",
    message: "deploy steps",
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: deploy-skill\ndescription: Deploy service\n---\nUse key sk-proj-1234567890abcdefghijklmnop\n",
      },
    ],
  });
  const r2 = await skills.promote("secret-leak");
  assert.equal(r2.promoted, false);
  assert.equal(r2.failedGates?.[0]?.name, "no-secrets");
  assert.equal(skills.readSkillsSha(), null);
  skills.reject("secret-leak");

  // 3. Abandoned source ref rejected
  skills.propose("abandoned-src", {
    skillName: "bad-src",
    message: "from failed branch",
    sourceRef: "refs/harness/abandoned/failed-try",
    files: [{ path: "SKILL.md", content: "---\nname: bad-src\ndescription: Bad\n---\nBody\n" }],
  });
  const r3 = await skills.promote("abandoned-src");
  assert.equal(r3.promoted, false);
  assert.equal(r3.failedGates?.[0]?.name, "non-abandoned-source");
  skills.reject("abandoned-src");

  // 4. Clean skill with references/ passes all gates and commits cleanly
  const prop = skills.propose("clean-1", {
    skillName: "git-audit",
    message: "add git-audit skill",
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: git-audit\ndescription: Audit repository invariants\n---\nCheck references/checklist.md\n",
      },
      {
        path: "references/checklist.md",
        content: "1. Run git fsck\n2. Check clean status\n",
      },
    ],
  });
  const r4 = await skills.promote("clean-1");
  assert.equal(r4.promoted, true);
  assert.ok(r4.commitSha);
  assert.equal(skills.list().length, 1);
  assert.equal(skills.readFile("git-audit", "references/checklist.md"), "1. Run git fsck\n2. Check clean status\n");
  assert.deepEqual(mem.readCommit(r4.commitSha!).parents, [prop.sha]);
});

test("SkillStore E2E: filesystem + Git discovery, skill:// read activation, and skill-scoped subagents", async () => {
  const repo = initTempGitRepo();
  try {
    // Seed a workspace filesystem skill under `.agents/skills/local-helper/SKILL.md`
    const wsSkillDir = path.join(repo, ".agents", "skills", "local-helper");
    fs.mkdirSync(wsSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(wsSkillDir, "SKILL.md"),
      "---\nname: local-helper\ndescription: Workspace helper skill\n---\nAlways run npm test first.\n",
    );

    const gitStore = new GitCliStore({ repoRoot: repo });
    const sessions = new SessionStore(gitStore);
    const skills = new SkillStore(gitStore, {
      workspaceRoot: repo,
      includeGlobalDirs: false,
    });
    const orch = new SubagentOrchestrator({ store: gitStore, sessions, workspaceRoot: repo });

    // Also commit a Git-versioned skill onto `refs/harness/skills`
    skills.put({
      skillName: "git-audit",
      message: "seed git-audit",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: git-audit\ndescription: Strict Git audit workflow\n---\nVerify checklist in references/items.md.\n",
        },
        {
          path: "references/items.md",
          content: "INVARIANT_42: Zero repo pollution.\n",
        },
      ],
    });

    const list = skills.list();
    assert.deepEqual(
      list.map((s) => `${s.name}:${s.source}`),
      ["git-audit:git", "local-helper:workspace"],
    );

    let subagentSawInjectedSkill = false;
    const subModel = new MockModelAdapter("sub", (req) => {
      if (req.messages.some((m) => m.content.includes("Always run npm test first."))) {
        subagentSawInjectedSkill = true;
      }
      return { content: "Subagent verified with local-helper skill.", toolCalls: [] };
    });

    const parentModel = new MockModelAdapter("parent", (req, step) => {
      if (step === 0) {
        // System prompt must contain compact catalog for BOTH skills (progressive disclosure)
        const sys = req.messages[0]!.content;
        assert.match(sys, /git-audit: Strict Git audit workflow/);
        assert.match(sys, /local-helper: Workspace helper skill/);
        // Full body MUST NOT be pre-loaded into Turn-0 system prompt!
        assert.doesNotMatch(sys, /INVARIANT_42/);
        return {
          content: "Activating git-audit skill and spawning skill-scoped subagent",
          toolCalls: [
            {
              id: "r1",
              name: "read",
              arguments: JSON.stringify({ path: "skill://git-audit/references/items.md" }),
            },
            {
              id: "s1",
              name: "subagent",
              arguments: JSON.stringify({
                agentId: "scoped-worker",
                task: "Audit build",
                skills: "local-helper",
                dropOnComplete: true,
              }),
            },
          ],
        };
      }
      const readMsg = req.messages.find((m) => m.role === "tool" && m.name === "read")!;
      assert.match(readMsg.content, /INVARIANT_42/);
      return { content: "Loaded INVARIANT_42 via skill:// and ran scoped subagent.", toolCalls: [] };
    });

    const coreTools = createCoreTools({
      readSkillFile: (name, rel) => skills.readFileBytes(name, rel),
    });

    const runtime = new AgentRuntime({
      sessions,
      model: parentModel,
      workspaceRoot: repo,
      tools: [
        ...coreTools,
        createSubagentTool({
          orchestrator: orch,
          loadSkillBody: (name) => skills.readFile(name, "SKILL.md"),
          createRunner: () => new RuntimeAgentRunner({ model: subModel, store: gitStore }),
        }),
      ],
      hooks: [createSkillCatalogHook(skills)],
    });

    const res = await runtime.runTurn({
      sessionRef: sessionRef("skills-e2e"),
      userInput: "Run git audit",
    });

    assert.equal(res.toolCallsExecuted, 2);
    assert.equal(subagentSawInjectedSkill, true);
    execFileSync("git", ["fsck", "--full", "--strict"], { cwd: repo, stdio: "pipe" });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
