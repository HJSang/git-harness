/**
 * P0-6 Latency Benchmark: measures `snapshotWorkspace` + `commitTurn` + `project`
 * on a realistic repo with 10,000 tracked files + ignored cache directory.
 *
 * Target (RUBRICS.md P0-6):
 *   - snapshotWorkspace + commitTurn: < 50 ms p95 on 10k-file repo
 *   - project(HEAD): < 10 ms p95
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitCliStore } from "../src/git-store/index.ts";
import { SessionStore, sessionRef } from "../src/session/index.ts";

const FILE_COUNT = Number(process.env.BENCH_FILES ?? 10_000);
const TURNS = Number(process.env.BENCH_TURNS ?? 20);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-bench-"));
try {
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Bench"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "bench@local"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");

  // Create 100 subdirs x (FILE_COUNT/100) files
  const dirs = 100;
  const perDir = Math.ceil(FILE_COUNT / dirs);
  let created = 0;
  for (let d = 0; d < dirs && created < FILE_COUNT; d++) {
    const sub = path.join(repo, "pkg", `mod_${d}`);
    fs.mkdirSync(sub, { recursive: true });
    for (let f = 0; f < perDir && created < FILE_COUNT; f++) {
      fs.writeFileSync(path.join(sub, `file_${f}.ts`), `export const n_${created} = ${created};\n`);
      created++;
    }
  }

  // Also add an ignored directory to verify `.gitignore` skipping stays fast
  const nm = path.join(repo, "node_modules", "fake-dep");
  fs.mkdirSync(nm, { recursive: true });
  for (let i = 0; i < 500; i++) {
    fs.writeFileSync(path.join(nm, `dep_${i}.js`), `module.exports = ${i};\n`);
  }

  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", `seed ${created} files`], { cwd: repo, stdio: "ignore" });

  const gitStore = new GitCliStore({ repoRoot: repo });
  const sessions = new SessionStore(gitStore);
  const ref = sessionRef("bench");

  const commitLatencies: number[] = [];
  const projectLatencies: number[] = [];

  for (let i = 0; i < TURNS; i++) {
    // Modify 1 file per turn (typical coding-agent turn)
    fs.writeFileSync(
      path.join(repo, "pkg", "mod_0", "file_0.ts"),
      `export const n_0 = ${i + 1};\n`,
    );

    const t0 = performance.now();
    sessions.commitTurn({
      sessionRef: ref,
      title: `bench turn ${i}`,
      events: [
        { type: "message", message: { role: "user", content: `Step ${i}` } },
        { type: "message", message: { role: "assistant", content: `Completed step ${i}` } },
      ],
      metadata: { model: "bench-model", tokensIn: 1000 + i * 50, tokensOut: 40 },
    });
    commitLatencies.push(performance.now() - t0);

    const p0 = performance.now();
    sessions.project(ref, { systemPrompt: "System prompt" });
    projectLatencies.push(performance.now() - p0);
  }

  // Also measure 100% COLD projection (brand-new GitCliStore with empty cache)
  const coldStart = performance.now();
  const coldSessions = new SessionStore(new GitCliStore({ repoRoot: repo }));
  const coldProj = coldSessions.project(ref, { systemPrompt: "System prompt" });
  const coldMs = performance.now() - coldStart;

  console.log(`Repo size: ${created} tracked files + 500 ignored files (${TURNS} turns)`);
  console.log(
    `commitTurn (incl. snapshotWorkspace): p50=${percentile(commitLatencies, 50).toFixed(1)}ms  p95=${percentile(commitLatencies, 95).toFixed(1)}ms  max=${Math.max(...commitLatencies).toFixed(1)}ms`,
  );
  console.log(
    `project(HEAD) warm:                   p50=${percentile(projectLatencies, 50).toFixed(1)}ms  p95=${percentile(projectLatencies, 95).toFixed(1)}ms  max=${Math.max(...projectLatencies).toFixed(1)}ms`,
  );
  console.log(
    `project(HEAD) cold (${coldProj.messages.length} msgs):       ${coldMs.toFixed(1)}ms`,
  );
} finally {
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
