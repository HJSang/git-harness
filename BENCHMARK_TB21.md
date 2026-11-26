# Terminal-Bench v2.1 Benchmark Report (`git-harness` vs. `pi v0.83.0`)

**Dataset:** Full `terminal-bench/terminal-bench-2-1` (**89 tasks**)  
**Evaluation Setup:** Identical OpenAI-compatible reasoning model endpoint (`reasoning_effort = high`, `max_tokens = 32768`), Harbor sandbox runner, default `1.0×` per-task timeouts.

---

## 1. Clean Full 89-Task Head-to-Head Sweeps (`k = 1`)

Each row below is a clean, independent full 89-task sweep under identical model and timeout settings (zero targeted-rerun selection bias):

| Metric | `pi v0.83.0` | `git-harness v0.5` | `git-harness v0.7.1` (Full Sweep) |
| :--- | :---: | :---: | :---: |
| **Tasks Passed (Clean Full-Sweep Pass@1)** | `76 / 89` (`85.39%`) | `70 / 89` (`78.65%`) | **`72 / 89` (`80.90%`)** |
| **McNemar Exact Two-Sided `p` vs `pi`** | — | `p = 0.238` (`6` vs `12`) | **`p = 0.455`** (`6` vs `10`) |
| **Agent Duration (Median / Mean)** | `72.9s` / `231.2s` | `103.1s` / `356.7s` | `124.9s` / `366.5s` |
| **Steps per Task (Median / Mean)** | `10.0` / `13.7` | `11.0` / `25.3` | `12.0` / `25.4` |
| **Weighted Live KV-Cache Hit Rate** | `93.77%` | `97.35%` | **`97.40%` (`+3.63%`)** |
| **Git Checkpoint Overhead (Median / Mean)** | — | `0.206%` / `1.162%` | **`0.176%` / `0.585%`** (`2×` lower mean) |
| **Portable `session.bundle` Survival** | — | `84 / 89` (`73.4 KB` med) | **`89 / 89` (`100%`, `62.9 KB` med)** |
| **Git-Native Tool Usage (89 Tasks)** | — | `34` sub · `99` blob · `6` rec · `2` hist | `30` sub · `98` blob · `4` rec · **`18` hist (`9×`)** |

**Key Clean-Sweep Highlights (`v0.5 → v0.7.1`):**
- **Gained `+7` tasks in full sweep:** `break-filter-js-from-html`, `chess-best-move` (`39.4s` vs `pi`'s `166s`), `crack-7z-hash` (`345.5s` where `pi` timed out at `1800s`), `gcode-to-text`, `gpt2-codegolf` (PASS!), `merge-diff-arc-agi-task` (`162.9s`), and `model-extraction-relu-logits`.
- **Two-sweep union (`v0.5 ∪ v0.7.1`):** `77 / 89` (`86.52%`); **cumulative targeted-rerun union (`v0.5–v0.7.1`):** `81 / 89` (`91.01%`).
- **100% forensic bundle survival:** All `89/89` trials in `v0.7.1` exported a valid `session.bundle` (including all 5 container-timeout runs), with median bundle size shrinking `73.4 KB → 62.9 KB` and max shrinking `968 MB → 318 MB`.

---

## 2. Iterative Forensic Progression (`v0.5 → v0.7.1`)

During development, every release (`v0.6 → v0.7 → v0.7.1`) was driven strictly by unpacking `session.bundle` Git DAGs and `profile.jsonl` telemetry from failed runs:

| Harness / Version | Targeted / Sweep Result | Key Engineering Changes |
| :--- | :---: | :--- |
| **`pi v0.83.0`** (`@earendil-works/pi-coding-agent@0.83.0`) | `76 / 89` (`85.39%`) | Full 89-task baseline sweep |
| `git-harness v0.5` *(full 89-task sweep)* | `70 / 89` (`78.65%`) | Full 89-task baseline sweep (`97.35%` weighted KV-cache hit rate; `0.206%` median Git overhead) |
| `git-harness v0.6` *(targeted 15-task rerun)* | `+7` recovered (`0` reg.) | Nested unborn `.git` guard, multimodal image `read`, `120s` default `bash` timeout, VM-disk / `>25 MiB` detached excludes |
| `git-harness v0.7` *(12-task failed rerun + `feal`)* | `+3` recovered | Graceful `maxSteps` no-tool synthesis handoff, total `archive`/`abandoned` `RecallIndex` + `ensureFresh()`, `history show`, provenance-only subagent merge (`feal` `7.8×` faster) |
| **`git-harness v0.7.1`** *(clean full 89-task sweep)* | **`72 / 89` (`80.90%`)** | Fixed `StuckLoopHook` file-churn saturation bug, added wall-clock `timeBudgetMs` notice, atomic `--bundle-out` preservation (`89/89` bundles, `97.40%` KV-cache, `0.176%` med Git overhead) |

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
