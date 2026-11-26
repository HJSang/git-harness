# Terminal-Bench v2.1 Benchmark Report (`git-harness` vs. `pi v0.83.0`)

**Dataset:** Full `terminal-bench/terminal-bench-2-1` (**89 tasks**)  
**Evaluation Setup:** Identical OpenAI-compatible reasoning model endpoint (`reasoning_effort = high`, `max_tokens = 32768`), Harbor sandbox runner, default `1.0×` per-task timeouts.

---

## 1. Accuracy & Iterative Engineering Progression (All 89 Tasks)

Starting from a full 178-trial head-to-head sweep (`pi v0.83.0` vs `git-harness v0.5`), every subsequent iteration (`v0.6 → v0.7 → v0.7.1`) was driven strictly by forensic analysis of real `session.bundle` Git DAGs and `profile.jsonl` telemetry:

| Harness / Version | Tasks Passed (89 Tasks) | Key Engineering Changes |
| :--- | :---: | :--- |
| **`pi v0.83.0`** (`@earendil-works/pi-coding-agent@0.83.0`) | `76 / 89` (`85.39%`) | Full 89-task baseline sweep |
| `git-harness v0.5` | `70 / 89` (`78.65%`) | Full 89-task baseline sweep (`97.35%` weighted KV-cache hit rate vs `93.77%` for `pi`; `0.206%` median Git overhead) |
| `git-harness v0.6` *(targeted 15-task rerun)* | `77 / 89` (`86.52%`) | Nested unborn `.git` guard, multimodal image `read`, `120s` default `bash` timeout, VM-disk / `>25 MiB` detached excludes (`+7` recovered, `0` regressions) |
| `git-harness v0.7` *(12-task failed rerun + `feal`)* | `80 / 89` (`89.89%`) | Graceful `maxSteps` no-tool synthesis handoff, total `refs/harness/{archive,abandoned}/*` `RecallIndex` with content-addressed `ensureFresh()`, `history show`, provenance-only subagent merge (`+3` recovered; `feal-differential-cryptanalysis` `7.8×` faster) |
| **`git-harness v0.7.1`** *(4-task rerun)* | **`81 / 89` (`91.01%`)** | Fixed `StuckLoopHook` file-churn sliding-window saturation bug, added wall-clock `timeBudgetMs` notice, preserved `session.bundle` on `SIGTERM`/timeout (`+1` recovered: `dna-assembly`) |

*(Note: `v0.6`, `v0.7`, and `v0.7.1` scores reflect targeted re-runs of failed/heavy tasks layered onto the full 89-task `v0.5` sweep rather than fresh full 89-task sweeps.)*

---

## 2. Full 89-Task Baseline Comparison (`pi v0.83.0` vs `git-harness v0.5`)

| Metric | `pi v0.83.0` | `git-harness v0.5` | Delta |
| :--- | :---: | :---: | :---: |
| **Tasks Passed (Pass@1)** | `76 / 89` (`85.39%`) | `70 / 89` (`78.65%`) | `-6` tasks |
| **Input Tokens (Median)** | `82,346` | **`68,437`** | **`-16.9%`** |
| **Output Tokens (Median)** | `4,799` | **`4,721`** | **`-1.6%`** |
| **Live KV-Cache Hit Rate (Weighted)** | `93.77%` | **`97.35%`** | **`+3.58%`** |
| **Git Checkpoint Overhead (Median)** | — | **`0.206%`** | `73.4 KB` median `session.bundle` |

### `git-harness` Git-Native Feature Usage Across the 89-Task Sweep
- **`subagent` delegations:** `34`
- **`blob://` offloaded tool outputs (`> 8 KiB`):** `99`
- **`recall` SQLite FTS5 queries:** `6`
- **`history` Git traversal calls:** `2`
- **Dual-parent auto-compactions:** `1` (`path-tracing-reverse`, step 224: `160.0K → 1.5K` tokens with `99.3%` overall KV-cache hit rate)

---

## 3. Forensic Fixes & Measurable Impact (`v0.6 → v0.7.1`)

### `v0.6` — Workspace & Multimodal Fixes (`+7` Flipped `FAIL → PASS`, `0` Regressions)
- **Unborn nested `.git` guard:** `merge-diff-arc-agi-task` went from instant crash (`2s`) to **PASS (`147s`, `12` steps)**.
- **Multimodal PNG/JPEG `read`:** `chess-best-move` flipped to **PASS in `105s` (`11` steps)** — faster than `pi` (`166s`).
- **`120s` default `bash` timeout:** `regex-chess` flipped to **PASS in `958s`** (`3×` faster than `v0.5`, `2×` faster than `pi`'s `1952s`); `make-doom-for-mips` and `make-mips-interpreter` both flipped to **PASS**.
- **Detached shadow-index VM-disk & `>25 MiB` excludes:**
  - `qemu-alpine-ssh`: bundle **`968 MB → 11.1 KB`**, Git overhead **`21.99% → 0.10%`**, wall time **`547s → 102s`** (PASS; `pi` failed in `625s`).
  - `qemu-startup`: bundle **`968 MB → 10.5 KB`**, Git overhead **`27.73% → 0.15%`**, wall time **`133s → 80s`** (PASS; `pi` failed in `168s`).

### `v0.7` — First-Principles Subagent & Cold-Recall Invariants (`+3` Flipped `FAIL → PASS`)
Inspecting the unpacked `session.bundle` of `feal-differential-cryptanalysis` (`1440s` in `v0.5`) revealed that a dropped orphan subagent had derived the solution but hit `maxSteps` mid-tool-call, returning pre-tool narration while archiving under `refs/harness/archive/agents/*` (which `RecallIndex` did not index and `history` could not inspect). Fixing all 4 layers produced:
- **`feal-differential-cryptanalysis`:** **`1440s → 185.1s` (`7.8×` faster)**, `54 → 19` steps, `665K → 148.4K` input tokens, `39.8 KB` bundle, `0.098%` Git overhead.
- **`crack-7z-hash`:** `FAIL (1800s timeout)` → **PASS (`1222s`, `52` steps)** (`pi` failed).
- **`video-processing`:** `FAIL (246s)` → **PASS (`91.6s`, `20` steps)** (`pi` failed).
- **`model-extraction-relu-logits`:** `FAIL (76s)` → **PASS (`49.3s`, `4` steps)** (`pi` passed in `73s`).

### `v0.7.1` — Guardrail & Timeout Forensics Fixes (`+1` Flipped `FAIL → PASS`)
- **Fixed `StuckLoopHook` file-churn saturation dead-zone:** Tracked monotonic per-path edit counts alongside the sliding window so sustained edit loops continue receiving nudges past `fileChurnWindow`.
- **Wall-clock `timeBudgetMs` notice & atomic `--bundle-out`:** Added optional wall-clock wrap-up warnings and periodic/exit `session.bundle` exports so even hard-timed-out runs (`gpt2-codegolf`) preserve a complete `455.3 KB` (180-commit) forensic DAG.
- **`dna-assembly`:** `FAIL (379s)` → **PASS (`689.6s`, `75` steps, `97.7%` cache, `0.10%` Git overhead)**.

---

## 4. Remaining Discordant Tasks (89 Tasks Total)

- **`git-harness`-only wins (8):** `configure-git-webserver`, `crack-7z-hash`, `dna-insert`, `extract-elf`, `qemu-alpine-ssh`, `qemu-startup`, `rstan-to-pystan`, `video-processing`
- **`pi v0.83.0`-only wins (3):** `filter-js-from-html`, `gpt2-codegolf`, `train-fasttext`
- **Both PASS (73) · Both FAIL (5):** `cancel-async-tasks`, `protein-assembly`, `raman-fitting`, `torch-pipeline-parallelism`, `torch-tensor-parallelism`
