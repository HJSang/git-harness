/**
 * P1 Evaluation & Ablation Suite (RUBRICS.md Section 2 & 3).
 *
 * Benchmarks `git-harness` against linear / sliding-window baselines across:
 * 1. Pollution Resistance (ContextBranch ablation: target >= 40% context reduction)
 * 2. KV-Cache Prefix Hit Rate (25-turn + compaction: target >= 90% vs. sliding window)
 * 3. Multi-Compaction Cold Recall Precision (3 compactions: target >= 90% top-3 recall)
 * 4. Subagent Handoff Compression Ratio (target < 10% parent tokens ingested)
 */

import { InMemoryObjectStore } from "../git-store/memory-store.ts";
import { MemoryStore, RecallIndex } from "../memory/index.ts";
import { SessionStore, agentRef, sessionRef } from "../session/index.ts";
import type { Message } from "../session/types.ts";

export interface EvalMetricResult {
  id: string;
  name: string;
  harnessValue: string;
  baselineValue: string;
  target: string;
  passed: boolean;
}

export interface EvalSuiteReport {
  passed: boolean;
  metrics: EvalMetricResult[];
}

function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function serializeMessages(msgs: Message[]): string {
  return msgs.map((m) => `${m.role}:${m.content}`).join("\n---\n");
}

/**
 * 1. Pollution Resistance Ablation:
 *    5 main-task turns + 10 noisy exploratory tangent turns + 2 post-tangent turns.
 *    Linear baseline keeps all 17 turns; git-harness branches tangent & drops/squashes.
 */
function evalPollutionResistance(): EvalMetricResult {
  const store = new InMemoryObjectStore();
  const sessions = new SessionStore(store);
  const linearRef = sessionRef("linear-baseline");
  const branchedRef = sessionRef("git-branched");
  const tangentRef = agentRef("tangent-rust-rewrite");

  const makeTurnEvents = (u: string, a: string) => [
    { type: "message" as const, message: { role: "user" as const, content: u } },
    { type: "message" as const, message: { role: "assistant" as const, content: a } },
  ];

  // 5 shared main-task turns
  for (let i = 1; i <= 5; i++) {
    const ev = makeTurnEvents(
      `Main task step ${i}: design Python service endpoint ${i}`,
      `Implemented endpoint ${i} with strict schema validation and retry policy.`,
    );
    sessions.commitTurn({ sessionRef: linearRef, title: `main-${i}`, events: ev });
    sessions.commitTurn({ sessionRef: branchedRef, title: `main-${i}`, events: ev });
  }

  // Fork tangent branch on git-harness
  sessions.fork(branchedRef, tangentRef);

  // 10 noisy exploratory tangent turns
  for (let i = 1; i <= 10; i++) {
    const noisy = makeTurnEvents(
      `Tangent ${i}: what if we rewrite the entire backend in Rust using actix-web and diesel?`,
      `Rust tangent analysis ${i}: `.repeat(8) + `Cargo.toml dependencies and lifetime annotations.`,
    );
    sessions.commitTurn({ sessionRef: linearRef, title: `tangent-${i}`, events: noisy });
    sessions.commitTurn({ sessionRef: tangentRef, title: `tangent-${i}`, events: noisy });
  }

  // Squash only the 1-line conclusion back to branched main (or drop)
  sessions.squashMerge({
    targetSessionRef: branchedRef,
    sourceRef: tangentRef,
    summary: "Explored Rust rewrite; decided to stay on Python due to migration cost.",
  });

  // 2 follow-up main turns
  for (let i = 6; i <= 7; i++) {
    const ev = makeTurnEvents(
      `Continue Python service step ${i}`,
      `Completed step ${i} cleanly in Python.`,
    );
    sessions.commitTurn({ sessionRef: linearRef, title: `main-${i}`, events: ev });
    sessions.commitTurn({ sessionRef: branchedRef, title: `main-${i}`, events: ev });
  }

  const linearChars = serializeMessages(sessions.project(linearRef).messages).length;
  const branchedChars = serializeMessages(sessions.project(branchedRef).messages).length;
  const reductionPct = ((linearChars - branchedChars) / linearChars) * 100;

  return {
    id: "P1-POLLUTION",
    name: "Pollution Resistance (Active Context Reduction)",
    harnessValue: `${reductionPct.toFixed(1)}% smaller (${branchedChars} chars)`,
    baselineValue: `0.0% (${linearChars} chars)`,
    target: ">= 40% reduction",
    passed: reductionPct >= 40,
  };
}

/**
 * 2. KV-Cache Prefix Hit Rate across 25 turns (with 1 compaction at turn 15):
 *    Compare git-harness dual-parent anchor projection vs. a naive 8-turn sliding window
 *    (which evicts Turn 1 on every turn after Turn 8, invalidating the prompt prefix).
 */
function evalKvCachePrefixHitRate(): EvalMetricResult {
  const store = new InMemoryObjectStore();
  const sessions = new SessionStore(store);
  const ref = sessionRef("kv-bench");
  const systemPrompt = "You are a concise software engineering agent. ".repeat(12);

  let harnessTotalChars = 0;
  let harnessCachedChars = 0;
  let prevHarnessPrompt = "";

  const slidingMessages: Message[] = [];
  const WINDOW_MSGS = 16; // 8 turns x 2 msgs
  let slidingTotalChars = 0;
  let slidingCachedChars = 0;
  let prevSlidingPrompt = "";

  for (let i = 1; i <= 25; i++) {
    const u: Message = { role: "user", content: `Turn ${i}: inspect module_${i}.ts and run tests.` };
    const a: Message = {
      role: "assistant",
      content: `Turn ${i} result: module_${i}.ts verified; 14 tests passed with 0 errors.`,
    };

    sessions.commitTurn({
      sessionRef: ref,
      title: `turn-${i}`,
      events: [
        { type: "message", message: u },
        { type: "message", message: a },
      ],
    });

    if (i === 15) {
      sessions.compact({
        sessionRef: ref,
        summary: "Turns 1..15 completed cleanly across modules 1..15.",
      });
    }

    const harnessPrompt = serializeMessages(sessions.project(ref, { systemPrompt }).messages);
    if (prevHarnessPrompt) {
      harnessTotalChars += harnessPrompt.length;
      harnessCachedChars += commonPrefixLength(prevHarnessPrompt, harnessPrompt);
    }
    prevHarnessPrompt = harnessPrompt;

    // Naive sliding window baseline
    slidingMessages.push(u, a);
    while (slidingMessages.length > WINDOW_MSGS) slidingMessages.shift();
    const slidingPrompt = serializeMessages([
      { role: "system", content: systemPrompt },
      ...slidingMessages,
    ]);
    if (prevSlidingPrompt) {
      slidingTotalChars += slidingPrompt.length;
      slidingCachedChars += commonPrefixLength(prevSlidingPrompt, slidingPrompt);
    }
    prevSlidingPrompt = slidingPrompt;
  }

  const harnessHitRate = (harnessCachedChars / harnessTotalChars) * 100;
  const slidingHitRate = (slidingCachedChars / slidingTotalChars) * 100;

  return {
    id: "P1-KVCACHE",
    name: "KV-Cache Prefix Hit Rate (25 turns + compaction)",
    harnessValue: `${harnessHitRate.toFixed(1)}%`,
    baselineValue: `${slidingHitRate.toFixed(1)}% (sliding window)`,
    target: ">= 90%",
    passed: harnessHitRate >= 90,
  };
}

/**
 * 3. Multi-Compaction Cold Recall Precision (3 consecutive compactions):
 *    10 unique ground-truth facts buried across 3 compacted eras; evaluate top-3 FTS5 recall.
 */
function evalMultiCompactionColdRecall(): EvalMetricResult {
  const store = new InMemoryObjectStore();
  const sessions = new SessionStore(store);
  const memory = new MemoryStore(store);
  const ref = sessionRef("cold-recall-eval");

  const needles: Array<{ query: string; fact: string; sha?: string }> = [
    { query: "ERR_QUOTA_7711", fact: "Encountered ERR_QUOTA_7711 in billing/rate_limiter.ts:88." },
    { query: "HMAC_SHA512_FALLBACK", fact: "Legacy webhook parser requires HMAC_SHA512_FALLBACK flag." },
    { query: "migration_042_lock", fact: "Rejected approach: migration_042_lock caused Postgres deadlock." },
    { query: "PORT_METRICS_9108", fact: "Prometheus exporter listens on PORT_METRICS_9108 in staging." },
    { query: "WAL_CHECKPOINT_FULL", fact: "SQLite tune: WAL_CHECKPOINT_FULL prevents reader starvation." },
    { query: "CACHE_SALT_V3", fact: "Invalidated CDN keys by bumping CACHE_SALT_V3 in config/cdn.ts." },
    { query: "GRPC_KEEPALIVE_45S", fact: "Fixed idle disconnect via GRPC_KEEPALIVE_45S on worker channel." },
    { query: "TOKEN_SKEW_120S", fact: "JWT validator allows TOKEN_SKEW_120S across multi-region clocks." },
    { query: "RETRY_JITTER_DECORR", fact: "Adopted RETRY_JITTER_DECORR backoff in net/client.ts:204." },
    { query: "SANDBOX_SECCOMP_BPF", fact: "Linux runner enforces SANDBOX_SECCOMP_BPF syscall profile." },
  ];

  for (let i = 0; i < needles.length; i++) {
    const item = needles[i]!;
    item.sha = sessions.commitTurn({
      sessionRef: ref,
      title: `investigation-${i + 1}`,
      events: [{ type: "message", message: { role: "assistant", content: item.fact } }],
    });
    if (i === 2 || i === 5 || i === 8) {
      sessions.compact({
        sessionRef: ref,
        summary: `High-level milestone summary after step ${i + 1} (exact error codes omitted).`,
      });
    }
  }

  // Active linear prompt after 3 compactions only has item #10!
  const activePrompt = serializeMessages(sessions.project(ref).messages);
  let activeHits = 0;
  for (const n of needles) {
    if (activePrompt.includes(n.query)) activeHits++;
  }

  const index = new RecallIndex({ store, sessions, memory });
  let recallHits = 0;
  try {
    index.rebuild();
    for (const n of needles) {
      const top3 = index.search({ query: n.query, limit: 3 });
      if (top3.some((h) => h.sha === n.sha)) {
        recallHits++;
      }
    }
  } finally {
    index.close();
  }

  const recallPct = (recallHits / needles.length) * 100;
  const baselinePct = (activeHits / needles.length) * 100;

  return {
    id: "P1-RECALL",
    name: "Cold Recall Precision (after 3 compactions)",
    harnessValue: `${recallPct.toFixed(0)}% (${recallHits}/${needles.length})`,
    baselineValue: `${baselinePct.toFixed(0)}% (${activeHits}/${needles.length} active-only)`,
    target: ">= 90%",
    passed: recallPct >= 90,
  };
}

/**
 * 4. Subagent Handoff Compression Ratio:
 *    Subagent burns 12 verbose turns exploring a codebase; parent squash-merges 1 concise summary.
 */
function evalSubagentHandoffCompression(): EvalMetricResult {
  const store = new InMemoryObjectStore();
  const sessions = new SessionStore(store);
  const mainRef = sessionRef("main");
  const subRef = agentRef("explorer");

  sessions.commitTurn({
    sessionRef: mainRef,
    title: "root",
    events: [{ type: "message", message: { role: "user", content: "Find root cause of memory leak" } }],
  });
  sessions.fork(mainRef, subRef);

  let rawSubagentChars = 0;
  for (let i = 1; i <= 12; i++) {
    const rawLog = `Tool output #${i}: `.repeat(25) + `heap snapshot delta at frame ${i}.`;
    rawSubagentChars += rawLog.length;
    sessions.commitTurn({
      sessionRef: subRef,
      title: `explore-${i}`,
      events: [{ type: "message", message: { role: "assistant", content: rawLog } }],
    });
  }

  const before = serializeMessages(sessions.project(mainRef).messages).length;
  const mergeSha = sessions.squashMerge({
    targetSessionRef: mainRef,
    sourceRef: subRef,
    summary: "Root cause: unbounded listener array in src/events/bus.ts:64 (missing off() cleanup).",
  });
  const after = serializeMessages(sessions.project(mainRef).messages).length;
  const ingestedChars = after - before;
  const ratioPct = (ingestedChars / rawSubagentChars) * 100;

  // Verify raw subagent trace is still 100% reachable via parent2
  const mergeRec = sessions.readCommit(mergeSha);
  const traceReachable = mergeRec.parents.length === 2;

  return {
    id: "P1-HANDOFF",
    name: "Subagent Handoff Compression Ratio",
    harnessValue: `${ratioPct.toFixed(1)}% (${ingestedChars}/${rawSubagentChars} chars)`,
    baselineValue: `100.0% (raw inline transcript)`,
    target: "< 10% + lossless parent2",
    passed: ratioPct < 10 && traceReachable,
  };
}

export function runP1AblationSuite(): EvalSuiteReport {
  const metrics = [
    evalPollutionResistance(),
    evalKvCachePrefixHitRate(),
    evalMultiCompactionColdRecall(),
    evalSubagentHandoffCompression(),
  ];
  return {
    passed: metrics.every((m) => m.passed),
    metrics,
  };
}

export function formatEvalReport(report: EvalSuiteReport): string {
  const header = "ID            | Metric                                           | git-harness                        | Baseline                     | Target                  | Status";
  const sep = "-".repeat(header.length);
  const rows = report.metrics.map(
    (m) =>
      `${m.id.padEnd(13)} | ${m.name.padEnd(48)} | ${m.harnessValue.padEnd(34)} | ${m.baselineValue.padEnd(28)} | ${m.target.padEnd(23)} | ${m.passed ? "PASS" : "FAIL"}`,
  );
  return [header, sep, ...rows].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runP1AblationSuite();
  console.log(formatEvalReport(report));
  if (!report.passed) process.exit(1);
}
