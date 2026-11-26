# git-harness Evaluation Rubrics (`RUBRICS.md`)

> **Purpose:** Define objective, falsifiable criteria for what makes `git-harness` a *great* agent harness—before writing implementation code—and prevent over-engineering or unverified "Git ceremony."

We optimize for **three workloads** through **one minimal, loosely coupled core**:
1. **Interactive HITL coding** (low latency, effortless rewind, zero Git friction)
2. **Autonomous long-horizon / multi-agent execution** (horizon stability, compaction fidelity, verified subagent merges)
3. **Research & reproducible evals** (deterministic replay, fork-and-diff A/B runs, model portability)

---

## 0. Architectural Simplicity & Decoupling Rubric (Design Gate)

Every component must earn its existence and stay independently usable, replaceable, and testable.

| Criterion | Concrete Check | Anti-Pattern to Reject |
| :--- | :--- | :--- |
| **Acyclic, shallow dependency graph** | Strict layered DAG: `git-store` → `session` → `runtime` → optional `{orchestrator, memory, surfaces}`. No upward or circular imports. | Core loop importing subagent logic, memory DBs, or TUI code. |
| **Narrow, mockable interfaces** | Every layer depends on minimal traits/interfaces (`ObjectStore`, `ModelAdapter`, `Tool`, `Sandbox`, `Hook`), not concrete implementations. | Hardcoding a single LLM SDK, filesystem layout, or CLI framework into the loop. |
| **Standalone testability** | Each module passes its full unit test suite in isolation (e.g., `session` and `runtime` run against an in-memory `ObjectStore` + mock model in `< 1s`). | Requiring live API keys or Docker to test projection/compaction logic. |
| **Minimal external dependencies** | Zero required SaaS, zero external DB servers, zero heavy agent frameworks. Core needs only Git + standard HTTP/JSON. | Bundling vector DB daemons, ORM layers, or multi-megabyte orchestration frameworks. |
| **Composable workflows, not baked-in modes** | Plan mode, TDD loops, Best-of-N racing, and memory gardening are built *on top of* core primitives (hooks + branches), not `if/else` flags in the core loop. | Hardcoded workflow state machines inside the core execution loop. |
| **Scaffolding deletion test** | If tomorrow's model needs zero prompt tricks, the core primitives (co-atomic rewind, cache-preserving anchors, worktree isolation, verified promotion, audit trail) still deliver full value. | Heavy prompt-engineering scaffolding baked into core abstractions. |

---

## 1. P0 Invariants (Must-Pass Automated Gates)

P0 checks are **binary pass/fail**. Any PR or MVP milestone that violates a P0 invariant blocks merge.

### 1.1 State Integrity & Reversibility
- **P0-1 Co-Atomic Rewind:** After $N$ turns with file creates/edits/deletes, `rewind(T_k)` restores *both* session state and working-tree files with **0-byte diff** against ground truth at `T_k`.
- **P0-2 Zero Host-Repo Pollution:** After 100 turns, 10 subagent runs, and 5 rewinds, the user's `git status`, `git log`, `git branch`, and real staging index contain **zero** stray harness files, untracked temp artifacts, or unwanted commits.
- **P0-3 Crash & Model-Swap Resilience:** Killing the process (`SIGKILL`) mid-turn leaves no corrupted refs, dangling lock files, or orphaned temp indexes; resuming (even with a different `ModelAdapter`) continues cleanly from the last committed turn.
- **P0-4 Prompt Determinism:** Given the same session commit SHA, `project(HEAD)` emits **byte-identical** message sequences across runs and machines.

### 1.2 Performance & Cache Discipline
- **P0-5 Prefix-Cache Invariance:** Across consecutive turns between compaction anchors (`T_i → T_{i+1}`), the serialized prompt prefix up to `T_i` is **byte-for-byte identical** (verified by automated prefix-diff test).
- **P0-6 Git Plumbing Latency Budget:**
  - `snapshot_workspace` + `commit_turn`: `< 50 ms` p95 on a 10k-file repo; `< 200 ms` p95 on a 100k-file repo (with large `.gitignore`d directories such as `node_modules` / `target`).
  - `project(HEAD)`: `< 10 ms` p95.
- **P0-7 Lean Turn-0 Prompt Tax:** Default core system prompt + 4 core tool schemas stay under **1,500 tokens** (Pi-class leanness).

### 1.3 Safety, Containment & Isolation
- **P0-8 Pre-Effect Blocking:** A denying `pre_tool` hook or sandbox policy blocks execution **before** any filesystem mutation or shell side effect occurs (verified by test).
- **P0-9 Subagent Blast-Radius Containment:** Concurrent subagents running in worktrees cannot mutate the parent working tree or sibling branches; aborting a subagent leaves **0 residual diff and 0 parent context lines**.
- **P0-10 Memory Anti-Poisoning:** Unverified/aborted turns or failed subagent branches never auto-commit to `refs/harness/memory`.

---

## 2. P1 Benchmark Targets (Quantitative Eval Suite)

P1 checks measure whether `git-harness` **measurably outperforms** a stripped-down linear baseline (and is competitive with Codex, Claude Code, Pi, and `dsh`) **holding the underlying LLM constant**.

### 2.1 Long-Horizon Effectiveness
| Metric | How to Measure | Target |
| :--- | :--- | :--- |
| **Pass@1 vs. Linear Baseline** | Fixed model on multi-file coding & debugging tasks (e.g., SWE-bench subset / Terminal-Bench) | `>= +5%` on long-horizon (`25+` turn) tasks; parity (`±1%`) on short (`<10` turn) tasks |
| **Horizon Stability** | Ratio of pass rate on `30–80` turn tasks vs. `5–15` turn tasks | Minimal degradation across compaction boundaries |
| **Dead-End Recovery Rate** | Tasks seeded with a misleading clue or failing initial approach | Higher recovery rate via branch/rewind than linear self-correction |

### 2.2 Token, Cache & Cost Economics
| Metric | How to Measure | Target |
| :--- | :--- | :--- |
| **Prompt / KV-Cache Hit Rate** | `cache_read_tokens / total_input_tokens` on 20+ turn sessions | `>= 90%` (stretch: `>= 95%`, matching `dsh`) |
| **Cost-per-Solved-Task** | Total USD / total tokens divided by solved tasks | Lower than linear baseline on long-horizon tasks |
| **Harness Wall-Time Overhead** | `(total_time - llm_time - tool_exec_time) / total_time` | `< 2%` |

### 2.3 Context Hygiene & Compaction Fidelity
| Metric | How to Measure | Target |
| :--- | :--- | :--- |
| **Post-Compaction Constraint Retention** | Needle/invariant retention quiz after 1, 3, and 5 compactions (original requirements, failing tests, rejected paths) | `>= 95%` recall of active constraints |
| **Pollution Resistance** | ContextBranch-style eval: inject a 10-turn exploratory tangent, switch/squash back, score main-task accuracy | `>= 40%` active context reduction with zero quality loss vs. clean control |
| **Cold Recall Precision** | Query exact details (line numbers, error codes, prior decisions) pushed behind a compaction anchor | `>= 90%` top-3 retrieval accuracy via derived index / Git traversal |

### 2.4 Multi-Agent Scaling & Integration Quality
| Metric | How to Measure | Target |
| :--- | :--- | :--- |
| **Subagent ROI** | Quality and wall-clock speedup vs. single-agent baseline at **equal token budget** | Positive speedup or accuracy gain on decomposable tasks |
| **Handoff Compression Ratio** | `tokens_ingested_by_parent / total_subagent_tokens` | `< 10%` (summary + verified diff only) while keeping full trace reachable |
| **Verification Gate Catch Rate** | % of broken subagent branches rejected by automated CI/verifier before merging to `main` | `100%` for test-covered regressions |

### 2.5 Auditability & UX
| Metric | How to Measure | Target |
| :--- | :--- | :--- |
| **Time-to-Why** | Time for a human developer to trace why an edit or memory update occurred using CLI (`log`/`diff`/`show`) | `< 30 seconds` |
| **Invisible-Until-Needed Friction** | Manual Git actions required by the user on a normal 3–10 turn task | **0** |
| **Model Portability** | Swap between at least 2 distinct LLM providers mid-session on the same `refs/harness/sessions/<id>` | Seamless resume with zero schema migration |

---

## 3. The Four Git-First Litmus Tests

Before promoting any new Git feature from experimental to core, it must pass all four:

1. **The Ablation Test:** Disable the Git feature (fall back to linear history / no branching) with the same LLM. If it does not measurably improve pass rate, cost-per-solve, pollution resistance, or rewind safety, **cut it**.
2. **The Latency Test:** Does it stay within P0-6 (`< 50 ms` on 10k files) without blocking streaming UX?
3. **The Zero-Leakage Test:** Does a user who never invokes Git commands see a completely clean repository?
4. **The Decoupling Test:** Can you delete or swap this module without modifying any other layer?

---

## 4. Workload-Specific Weighting

Because the core is decoupled, each surface/profile weights the rubrics differently without changing core semantics:

| Workload Profile | Highest-Weighted Rubrics | Modules Enabled |
| :--- | :--- | :--- |
| **Interactive HITL** | Latency (P0-6), Co-Atomic Rewind (P0-1), Zero Friction, Pre-Effect Approval (P0-8) | `git-store` + `session` + `runtime` + `cli` |
| **Autonomous Long-Horizon** | Horizon Stability, Cache Hit Rate (P0-5), Subagent ROI, Verification Gates, Anti-Poisoning (P0-10) | Above + `orchestrator` + `memory` + sandbox |
| **Research & Evals** | Prompt Determinism (P0-4), Model Portability, Fork/Diff A/B Replay, Cost Trailers | `git-store` + `session` + `runtime` + batch runner |
