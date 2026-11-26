/**
 * Multi-harness Harbor k=8 benchmark comparator.
 *
 * Usage:
 *   node src/eval/compare-harnesses.ts git-harness=/path/to/job1 codex=/path/to/job2 claude-code=/path/to/job3
 */

import fs from "node:fs";
import path from "node:path";

interface TrialRecord {
  task: string;
  reward: number | null;
  exception: string | null;
  durationSec: number | null;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  gitOverheadPct?: number;
}

function readTrials(jobDir: string): TrialRecord[] {
  const out: TrialRecord[] = [];
  if (!fs.existsSync(jobDir)) return out;

  for (const entry of fs.readdirSync(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const trialDir = path.join(jobDir, entry.name);
    const resultPath = path.join(trialDir, "result.json");
    if (!fs.existsSync(resultPath)) continue;

    const task = entry.name.split("__")[0] ?? entry.name;
    const r = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      verifier_result?: { rewards?: { reward?: number }; reward?: number };
      exception_info?: { exception_type?: string };
      agent_execution?: { started_at?: string; finished_at?: string };
      agent_result?: {
        n_input_tokens?: number;
        n_output_tokens?: number;
        n_cache_tokens?: number;
        metadata?: { git_harness_git_ms?: number; git_harness_model_ms?: number; git_harness_tools_ms?: number };
      };
    };

    const rawReward = r.verifier_result?.rewards?.reward ?? r.verifier_result?.reward;
    const reward = rawReward !== undefined ? Number(rawReward) : null;
    const exception = r.exception_info?.exception_type ?? null;

    let durationSec: number | null = null;
    if (r.agent_execution?.started_at && r.agent_execution?.finished_at) {
      durationSec =
        (Date.parse(r.agent_execution.finished_at) - Date.parse(r.agent_execution.started_at)) /
        1000;
    }

    let tokensIn = Number(r.agent_result?.n_input_tokens ?? 0);
    let tokensOut = Number(r.agent_result?.n_output_tokens ?? 0);
    let tokensCache = Number(r.agent_result?.n_cache_tokens ?? 0);
    let gitOverheadPct: number | undefined;

    // Fallback to trajectory.json if Harbor agent_result token fields are 0
    if (tokensIn === 0) {
      const trajPath = path.join(trialDir, "agent", "trajectory.json");
      if (fs.existsSync(trajPath)) {
        try {
          const traj = JSON.parse(fs.readFileSync(trajPath, "utf8")) as {
            final_metrics?: {
              total_prompt_tokens?: number;
              total_completion_tokens?: number;
              total_cached_tokens?: number;
              extra?: { total_cache_read_input_tokens?: number };
            };
          };
          tokensIn = Number(traj.final_metrics?.total_prompt_tokens ?? 0);
          tokensOut = Number(traj.final_metrics?.total_completion_tokens ?? 0);
          tokensCache = Number(
            traj.final_metrics?.total_cached_tokens ??
              traj.final_metrics?.extra?.total_cache_read_input_tokens ??
              0,
          );
        } catch {
          // ignore
        }
      }
    }

    const md = r.agent_result?.metadata;
    if (md?.git_harness_git_ms !== undefined) {
      const wall =
        (md.git_harness_git_ms ?? 0) +
        (md.git_harness_model_ms ?? 0) +
        (md.git_harness_tools_ms ?? 0);
      if (wall > 0) gitOverheadPct = (md.git_harness_git_ms / wall) * 100;
    }

    out.push({ task, reward, exception, durationSec, tokensIn, tokensOut, tokensCache, gitOverheadPct });
  }
  return out;
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function summarize(trials: TrialRecord[]) {
  const n = trials.length;
  const passed = trials.filter((t) => t.reward === 1).length;
  const graded = trials.filter((t) => t.reward !== null).length;
  const errors = trials.filter((t) => t.exception !== null).length;
  const durs = trials.map((t) => t.durationSec).filter((x): x is number => x !== null);
  const meanIn = n > 0 ? trials.reduce((a, b) => a + b.tokensIn, 0) / n : 0;
  const meanOut = n > 0 ? trials.reduce((a, b) => a + b.tokensOut, 0) / n : 0;
  const totIn = trials.reduce((a, b) => a + b.tokensIn, 0);
  const totCache = trials.reduce((a, b) => a + b.tokensCache, 0);
  const cacheRate = totIn > 0 ? (totCache / totIn) * 100 : 0;
  const gitPcts = trials.map((t) => t.gitOverheadPct).filter((x): x is number => x !== undefined);
  return {
    n,
    graded,
    passed,
    passAt1: n > 0 ? (passed / n) * 100 : 0,
    passAtK: passed > 0 ? 100 : 0,
    errors,
    medDurSec: median(durs),
    meanIn,
    meanOut,
    cacheRate,
    medGitPct: gitPcts.length > 0 ? median(gitPcts) : null,
  };
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node src/eval/compare-harnesses.ts <name>=<jobDir> ...");
  process.exit(1);
}

const byHarness = new Map<string, TrialRecord[]>();
const allTasks = new Set<string>();

for (const arg of args) {
  const eq = arg.indexOf("=");
  if (eq === -1) continue;
  const name = arg.slice(0, eq);
  const dir = arg.slice(eq + 1);
  const trials = readTrials(dir);
  byHarness.set(name, trials);
  for (const t of trials) allTasks.add(t.task);
}

const tasks = [...allTasks].sort();
const harnesses = [...byHarness.keys()];

const report: Record<string, unknown> = { tasks, perTask: {}, overall: {} };

for (const task of tasks) {
  const row: Record<string, unknown> = {};
  for (const h of harnesses) {
    const tTrials = (byHarness.get(h) ?? []).filter((t) => t.task === task);
    row[h] = summarize(tTrials);
  }
  (report.perTask as Record<string, unknown>)[task] = row;
}

for (const h of harnesses) {
  const trials = byHarness.get(h) ?? [];
  const overall = summarize(trials);
  const tasksSolvedAny = tasks.filter((task) =>
    trials.some((t) => t.task === task && t.reward === 1),
  ).length;
  (report.overall as Record<string, unknown>)[h] = {
    ...overall,
    passAtKTasks: `${tasksSolvedAny}/${tasks.length}`,
  };
}

console.log(JSON.stringify(report, null, 2));
