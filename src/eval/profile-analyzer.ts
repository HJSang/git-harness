/**
 * Offline profiler for real Terminal-Bench / Harbor runs of `git-harness`.
 *
 * Reads a Harbor job directory containing `<task>__<id>/agent/{profile.jsonl,git-stats.json,session.bundle}`
 * and `<task>__<id>/result.json`, producing a structured Git + context management diagnostic report.
 */

import fs from "node:fs";
import path from "node:path";
import type { StepProfileEntry } from "../runtime/types.ts";

export interface TrialProfileSummary {
  task: string;
  trialDir: string;
  reward: number | null;
  exception: string | null;
  steps: number;
  compactions: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
  overallCacheHitRate: number;
  peakStepTokensIn: number;
  totalModelMs: number;
  totalToolsMs: number;
  totalGitMs: number;
  gitOverheadPct: number;
  p50GitMs: number;
  p95GitMs: number;
  maxGitMs: number;
  readOnlySteps: number;
  mutatingSteps: number;
  uniqueWorkspaceTrees: number;
  toolCounts: Record<string, number>;
  toolErrors: number;
  offloadedOutputs: number;
  subagentTokensIn: number;
  subagentTokensOut: number;
  subagentCacheRead: number;
  totalToolOutputKB: number;
  bundleSizeKB: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

export function analyzeTrialDir(trialDir: string): TrialProfileSummary | null {
  const resultPath = path.join(trialDir, "result.json");
  const profilePath = path.join(trialDir, "agent", "profile.jsonl");
  if (!fs.existsSync(resultPath) && !fs.existsSync(profilePath)) return null;

  const task = path.basename(trialDir).split("__")[0] ?? path.basename(trialDir);
  let reward: number | null = null;
  let exception: string | null = null;

  if (fs.existsSync(resultPath)) {
    const r = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      verifier_result?: { rewards?: { reward?: number }; reward?: number };
      exception_info?: { exception_type?: string };
    };
    const rw = r.verifier_result?.rewards?.reward ?? r.verifier_result?.reward;
    reward = rw !== undefined ? Number(rw) : null;
    exception = r.exception_info?.exception_type ?? null;
  }

  const rows: StepProfileEntry[] = fs.existsSync(profilePath)
    ? fs
        .readFileSync(profilePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as StepProfileEntry)
    : [];

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCacheRead = 0;
  let peakStepTokensIn = 0;
  let totalModelMs = 0;
  let totalToolsMs = 0;
  let totalGitMs = 0;
  let compactions = 0;
  let readOnlySteps = 0;
  let mutatingSteps = 0;
  let toolErrors = 0;
  let offloadedOutputs = 0;
  let subagentTokensIn = 0;
  let subagentTokensOut = 0;
  let subagentCacheRead = 0;
  let totalToolOutputBytes = 0;
  const gitLatencies: number[] = [];
  const toolCounts: Record<string, number> = {};
  const workspaceTrees = new Set<string>();

  for (const row of rows) {
    const tIn = row.tokensIn ?? 0;
    totalTokensIn += tIn;
    if (tIn > peakStepTokensIn) peakStepTokensIn = tIn;
    totalTokensOut += row.tokensOut ?? 0;
    totalCacheRead += row.cacheRead ?? 0;
    totalModelMs += row.modelLatencyMs ?? 0;
    totalToolsMs += row.toolsLatencyMs ?? 0;
    totalGitMs += row.gitCheckpointMs ?? 0;
    if (row.gitCheckpointMs !== undefined && row.gitCheckpointMs > 0) {
      gitLatencies.push(row.gitCheckpointMs);
    }
    if (row.compactedAnchorSha) compactions++;
    if (row.workspaceTreeSha) workspaceTrees.add(row.workspaceTreeSha);
    if (row.workspaceChanged === false) readOnlySteps++;
    else if (row.workspaceChanged === true) mutatingSteps++;

    for (const tc of row.toolCalls ?? []) {
      toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
      if (tc.isError) toolErrors++;
      if (tc.offloadedBlobSha) offloadedOutputs++;
      if (tc.subagentUsage) {
        subagentTokensIn += tc.subagentUsage.tokensIn ?? 0;
        subagentTokensOut += tc.subagentUsage.tokensOut ?? 0;
        subagentCacheRead += tc.subagentUsage.cacheRead ?? 0;
      }
      totalToolOutputBytes += tc.outputBytes ?? 0;
    }
  }

  const bundlePath = path.join(trialDir, "agent", "session.bundle");
  const bundleSizeKB = fs.existsSync(bundlePath)
    ? Number((fs.statSync(bundlePath).size / 1024).toFixed(1))
    : 0;

  const totalWall = totalModelMs + totalToolsMs + totalGitMs;

  return {
    task,
    trialDir,
    reward,
    exception,
    steps: rows.length,
    compactions,
    totalTokensIn,
    totalTokensOut,
    totalCacheRead,
    overallCacheHitRate: totalTokensIn > 0 ? totalCacheRead / totalTokensIn : 0,
    peakStepTokensIn,
    totalModelMs: Number(totalModelMs.toFixed(1)),
    totalToolsMs: Number(totalToolsMs.toFixed(1)),
    totalGitMs: Number(totalGitMs.toFixed(1)),
    gitOverheadPct: totalWall > 0 ? Number(((totalGitMs / totalWall) * 100).toFixed(3)) : 0,
    p50GitMs: Number(percentile(gitLatencies, 50).toFixed(1)),
    p95GitMs: Number(percentile(gitLatencies, 95).toFixed(1)),
    maxGitMs: Number((gitLatencies.length ? Math.max(...gitLatencies) : 0).toFixed(1)),
    readOnlySteps,
    mutatingSteps,
    uniqueWorkspaceTrees: workspaceTrees.size,
    toolCounts,
    toolErrors,
    offloadedOutputs,
    subagentTokensIn,
    subagentTokensOut,
    subagentCacheRead,
    totalToolOutputKB: Number((totalToolOutputBytes / 1024).toFixed(1)),
    bundleSizeKB,
  };
}

export function analyzeJobDir(jobDir: string): TrialProfileSummary[] {
  const summaries: TrialProfileSummary[] = [];
  for (const entry of fs.readdirSync(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summary = analyzeTrialDir(path.join(jobDir, entry.name));
    if (summary) summaries.push(summary);
  }
  return summaries.sort((a, b) => a.task.localeCompare(b.task));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node src/eval/profile-analyzer.ts <harbor-job-dir>");
    process.exit(1);
  }
  const summaries = analyzeJobDir(target);
  console.log(JSON.stringify(summaries, null, 2));
}
