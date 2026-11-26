# git-harness Architecture & Design (`v0.1`)

> **Goal:** Design a minimal, composable agent harness from first principles where Git's object model is the native state substrate for sessions, checkpoints, compaction, memory, and subagent orchestration.
>
> **Guiding Constraints:** Extreme simplicity, loose coupling between components, and falsifiable evaluation criteria (see [RUBRICS.md](./RUBRICS.md)).

---

## 0. Modularity & Decoupling Principle

`git-harness` is structured as a **strict, acyclic stack of small, independent modules**. Each layer depends on at most one narrow interface below it, has zero upward dependencies, and can be unit-tested or used standalone:

```text
┌─────────────────────────────────────────────────────────────┐
│ Layer 5: surfaces       CLI / TUI / JSON-RPC / Batch Eval   │  (thin frontends)
├──────────────────────────────┬──────────────────────────────┤
│ Layer 3: orchestrator (opt.) │ Layer 4: memory (opt.)       │  (independent siblings;
│   subagents, worktrees,      │   refs/harness/memory +      │   neither knows about
│   review gates, meta-agents  │   disposable FTS5 recall     │   the other)
├──────────────────────────────┴──────────────────────────────┤
│ Layer 2: runtime        Minimal 4-tool loop + hooks + bus   │  (depends only on traits)
├─────────────────────────────────────────────────────────────┤
│ Layer 1: session        Turn DAG, rewind, anchor projection │  (no LLM SDKs, no tools)
├─────────────────────────────────────────────────────────────┤
│ Layer 0: git-store      Pure Git plumbing & shadow refs     │  (zero AI/LLM concepts)
└─────────────────────────────────────────────────────────────┘
```

### Narrow Boundary Contracts
- **`ObjectStore` (`git-store` → `session`):** `write_blob`, `write_tree`, `commit`, `update_ref`, `read_ref`, `snapshot_workspace`, `materialize_tree`, `add_worktree`. Swappable with an in-memory store for millisecond unit tests.
- **`ModelAdapter` (`runtime`):** Stateless `complete(messages, tools) → stream<Event>`. Zero provider lock-in; models can be swapped mid-session.
- **`Tool` & `Hook` (`runtime`):** Pure functions/interceptors (`pre_turn`, `pre_tool`, `post_tool`, `on_compact`). Workflows like Plan mode, approval policies, and memory injection attach here instead of bloating the core loop.
- **`AgentRunner` (`orchestrator`):** Anything that executes inside a workspace + context ref and yields a branch commit—so native `runtime` loops and external CLIs (Claude Code, Codex, Pi) plug in identically.

### Composing the Three Target Workloads Without Core Bloat
- **Interactive HITL coding:** `git-store` + `session` + `runtime` (with approval hook) + CLI/TUI.
- **Autonomous long-horizon / multi-agent:** Above + sandbox + `orchestrator` + `memory` + headless runner.
- **Research & reproducible evals:** `git-store` + `session` (fork/replay) + `runtime` (swappable `ModelAdapter`) + batch runner + `git notes` scoring.

---

## 1. Landscape Study: Lessons from Four Harnesses

Before designing a new harness, we distilled the load-bearing ideas from four production/open-source agent harnesses:

| Harness | Core Philosophy | Key Architectural Takeaways |
| :--- | :--- | :--- |
| **Codex** (OpenAI) | Decoupled control plane & sandbox | Rust core + JSON-RPC App Server (`Thread → Turn → Item`) shared across CLI/IDE/cloud; clean boundary between **sandbox isolation** (`exec-server` / BYOC) and **approval policies**; automated compaction; parallel subagents; `AGENTS.md`. |
| **Claude Code** (Anthropic) | Co-evolved full-featured coding loop | Multi-layer compaction; independent pre-edit **checkpoints** for safe rewind; lifecycle **hooks** for guardrails; isolated **subagents** + **`git worktree`**; `CLAUDE.md` + auto-memory; read-only Plan mode; skills & MCP. |
| **Pi** (Mario Zechner) | *"Primitives, not features"* minimalism | Minimal 4-tool core (`read`, `write`, `edit`, `bash`) + sub-1k-token system prompt; **deterministic tree-structured JSONL sessions** (`id` + `parentId`, `/tree` branching); non-destructive cache-aware compaction; deep TypeScript extensions. |
| **DeepSeek Harness (`dsh`)** | Plugin microkernel (Cordis) | Fully swappable loop, model adapter, storage, and sandbox; **append-only event-sourced session log** decoupled from the active prompt view; **adaptive progressive compaction** (`active → faded → archived` + anchor summaries); strict **prefix-caching discipline**; `dsh-recall` hybrid index; **meta-harness** subagents wrapping Claude Code / Codex. |

### Related Research & Prior Art
- **Git Context Controller (GCC)** (`arXiv:2508.00031`): Agent-invoked `COMMIT`, `BRANCH`, `MERGE`, `CONTEXT` primitives over a `.GCC/` workspace.
- **ContextBranch**: Conversational `checkpoint`, `branch`, `switch`, and selective `inject` (cherry-pick) to prevent multi-turn context pollution.
- **Letta Context Repositories (MemFS)**: Git-backed filesystem memory with progressive disclosure (`system/` pinned to prompt) and `git worktree` background reflection/defragmentation.
- **Rekal** (`arXiv:2607.14390`): Git-bound session ledgers via post-commit hooks + orphan branches + disposable local SQLite hybrid indexes.

---

## 2. First-Principles Harness Requirements

Every serious coding-agent harness converges on **8 core subsystems**:

1. **Minimal Execution Loop & Tool Core** — Model ↔ tool dispatch (`read`, `write`, `edit`, `bash` + extensible tools/MCP).
2. **Immutable, Branchable Session Store** — Save, resume, fork, replay, and navigate non-linear trajectories.
3. **Context Projection & Cache-Aware Compaction** — Separate *stored history* from *projected prompt view*; compact without losing provenance or thrashing KV-cache prefixes.
4. **Co-Atomic Checkpointing & Rewind** — Roll back conversation state and workspace file changes together.
5. **Workspace & Execution Isolation** — Prevent concurrent collisions and limit blast radius (worktrees + OS sandbox + approval gates).
6. **Subagent Orchestration & Meta-Harnessing** — Spawn isolated workers with scoped context/tools, verify diffs/outputs, and merge distilled results.
7. **Persistent Memory & Cold Recall** — Cross-session memory + on-demand retrieval over compacted/archived traces.
8. **Governance, Extensibility & Observability** — Lifecycle hooks, permissions, cost/token accounting, and multi-surface (CLI/UI/RPC) sync.

### The Unifying Insight
Existing harnesses reimplement Git fragments in silos (JSONL parent-pointer trees, ad-hoc file checkpoint directories, separate event logs, bolted-on worktrees), causing **code state and reasoning state to drift apart**.

Using Git's content-addressed DAG as the single native substrate eliminates that duplication and makes **co-atomic state management** the default.

---

## 3. Core Architecture: Git as First Resident

### 3.1 Shadow Ref Namespaces (Zero Pollution)
All harness state is written via **Git plumbing** (`hash-object`, `mktree`, `commit-tree`, `update-ref`, or `gix`/`libgit2` in-process) into dedicated private namespaces. The user's normal branches (`refs/heads/*`), staging index, and `git status` remain untouched.

```text
User refs (untouched):
  refs/heads/main
  refs/heads/feature/*

Harness refs (private namespaces):
  refs/harness/sessions/<session-id>   # Main session DAG (co-atomic turn commits)
  refs/harness/agents/<agent-id>       # Subagent branches (forked or orphan)
  refs/harness/memory                  # Persistent cross-session memory (orphan branch)
  refs/notes/harness/evals             # Annotations, eval scores, review metadata
```

*(Optionally, for repos where touching `.git` is undesirable, all `refs/harness/*` can live in a paired bare repo linked via a `Code-Repo` + `Code-Tree` reference.)*

### 3.2 Co-Atomic Turn Commit Schema
Each completed turn (or checkpoint boundary) creates one immutable commit on `refs/harness/sessions/<id>`:

```text
<turn-commit-tree>/
├── turn/
│   ├── events.jsonl        # Append-only Turn/Item records (user, thinking, tool_call, tool_result)
│   └── state.json          # Active mode, plan pointer, pinned files, compaction anchor SHA
├── workspace/              # Subtree SHA produced via shadow GIT_INDEX_FILE write-tree
└── summary.md              # Present on compaction-anchor or squash-merge commits
```

Commit message trailers record structured metadata for zero-infrastructure observability:
```text
turn: implement retry middleware

Harness-Kind: turn | compact | subagent-merge | checkpoint
Agent-Id: root
Model: <model-id>
Tokens-In: 48210
Tokens-Out: 1420
Cache-Read: 46100
Code-Base-SHA: <user HEAD sha>
Workspace-Tree: <shadow tree sha>
```

### 3.3 Zero-Pollution Workspace Checkpoints
Before/after tool mutations, the harness snapshots the working directory using a temporary index file (`GIT_INDEX_FILE=/tmp/harness-idx-<id>`):
1. Populate temporary index from the working tree (respecting `.gitignore` + configurable size caps).
2. Run `git write-tree` → returns a deduplicated, content-addressed `workspace_tree_sha`.
3. Attach `workspace_tree_sha` to the turn commit.

**Atomic Rewind (`rewind <commit-sha>`):**
1. Move `refs/harness/sessions/<id>` to `<commit-sha>` (or fork a new branch from `<commit-sha>` to keep the abandoned attempt reachable).
2. Materialize `<commit-sha>:workspace` into the working tree.
Both conversation history and files are now guaranteed consistent.

---

## 4. Context Projection & Cache-Aware Compaction

A Git DAG is non-linear; an LLM prompt is a 1D token stream. We enforce a strict separation between **storage** (the full DAG) and **projection** (`project(HEAD) → Message[]`).

### Dual-Parent Anchor Compaction
Compaction **never rewrites or deletes raw commits**:

```text
raw history:   T1 ── T2 ── T3 ── T4 ── T5 (raw_tip)
               │                       │
anchors/main:  A0 ─────────────────── A1 (compact anchor) ── T6 ── T7 (HEAD)
                                      ▲
                                      ├── parent1 = A0  (first-parent chain)
                                      └── parent2 = T5  (archived raw trace)
```

- **Projection rule:** Walk `--first-parent` backward from `HEAD` until the most recent `Harness-Kind: compact` anchor (`A1`), then emit `[system_prompt + memory_pinned, A1.summary.md, T6, T7]`.
- **KV-Cache Invariance:** Between anchors, every new turn (`T6`, `T7`, ...) strictly appends to the exact same token prefix → maximizes prompt/KV-cache hit rates.
- **Lossless Cold Recall:** `A1^2` (`T5`) keeps the full raw trajectory reachable via Git traversal or a disposable derived SQLite/FTS5 index (`recall` tool) rebuilt directly from `refs/harness/*`.

---

## 5. Subagent Orchestration & Meta-Harnessing

Every subagent is modeled as a **branch (+ optional worktree)** with PR-style integration:

```text
refs/harness/sessions/main:  T2 ───────────────────────────────────── M1 (squash) ──►
                              ├── refs/harness/agents/explore-1 ── e1 ── e2 ──┤
                              ├── refs/harness/agents/coder-a   ── c1 ── c2 ──┤  (worktree + CI gate)
                              └── refs/harness/agents/spike-b   ── s1 (aborted; ref dropped)
```

### Core Lifecycle Primitives
- **`spawn(base_ref | orphan, scope, worktree?)`**:
  - Forking from parent's `HEAD` gives the subagent exact context inheritance and KV-cache prefix sharing; spawning from an orphan ref gives a clean slate.
  - Code-mutating subagents receive an isolated `git worktree` at `Code-Base-SHA` (or parent's current `Workspace-Tree`).
- **`step(...)`**: Subagent commits turns locally onto `refs/harness/agents/<id>`. Crashes or model swaps simply resume from the branch tip SHA.
- **`review(agent_ref)`**: Runs automated gates (tests, linters, secret scan, optional reviewer subagent) against `git diff base..agent_ref`. Results can be attached via `git notes`.
- **`integrate(agent_ref, mode)`**:
  - `squash`: Commits a concise summary + verified code diff onto parent session (`parent2 = agent_ref` preserves full trace).
  - `cherry-pick <sha>`: Salvage a single useful commit from an otherwise failed subagent.
  - `drop`: Delete ref + remove worktree with zero parent pollution.
- **Meta-Harness Adapter:** External CLIs (Claude Code, Codex, Pi, etc.) can run as subagents inside a provisioned worktree; on completion, the harness captures the resulting code diff and session transcript as a commit on `refs/harness/agents/<id>`.

### Handling Concurrent Merges
- **Code conflicts:** Partition file ownership upfront where possible; serialize integration through a lightweight **merge queue** (rebase → re-test → merge) or delegate resolution to a dedicated resolver subagent.
- **Semantic memory conflicts:** Merging divergent findings into `refs/harness/memory` uses an **LLM semantic merge step** rather than plain 3-way text merge.

---

## 6. Persistent Memory (`refs/harness/memory`)

Long-term project/agent memory lives on a dedicated orphan branch `refs/harness/memory`:

```text
memory/
├── system/          # Always pinned into the cacheable system prompt prefix
├── decisions/       # Architectural decisions linked to code/session SHAs
├── facts/           # Discovered project conventions, build/test commands
└── episodes/        # Indexed pointers to past compacted sessions
```

- **Auditable & Portable:** Standard `git log` explains *why* a memory changed; `git push/fetch origin refs/harness/memory` syncs across machines.
- **Background Maintenance:** Idle "gardener" subagents check out `refs/harness/memory` in a worktree, deduplicate/defragment files, and open a merge request gated by review.
- **Disposable Derived Index:** Hybrid search (BM25/FTS5 + optional embeddings) lives in a local cache (e.g., `.git/harness-cache/index.db`) that can be wiped and rebuilt deterministically from Git objects.

---

## 7. Explicit Boundaries: What Git Should *Not* Do

To stay true to first principles, these responsibilities remain **outside** Git:

1. **Hot Turn Loop & Streaming:** Active token streaming and in-flight tool execution run in memory; Git flushes only at turn/checkpoint boundaries.
2. **OS Sandboxing & Pre-Tool Interception:** Git isolates state, not syscalls or network access. Execution isolation requires OS sandboxes (Seatbelt/Landlock/containers/microVMs) and synchronous pre-tool permission hooks.
3. **Ephemeral Live Steering:** Real-time cancellation, heartbeats, and inter-agent signals belong on an in-memory event bus / JSON-RPC stream (Codex App Server style).
4. **Semantic Search & Conflict Resolution:** Handled by disposable derived indexes and LLM merge drivers operating *on top of* Git objects.

---

## 8. Phased MVP Roadmap

- **Phase 0 — Git Object & Shadow Ref Core:** In-process Git plumbing layer (`commit_turn`, `snapshot_workspace`, `rewind`, `fork`, `project_prompt`) with zero working-tree pollution and unit tests verifying KV-cache prefix stability.
- **Phase 1 — Minimal Pi-Style Agent Loop:** 4-tool core (`read`, `write`, `edit`, `bash`), dual-parent compaction anchors, CLI + `/tree` + `/rewind` commands.
- **Phase 2 — Git-Native Subagents:** `spawn` (branch + worktree), verifier gates, `squash` / `cherry-pick` / `drop` integration, and meta-harness wrapper.
- **Phase 3 — Persistent Memory & Cold Recall:** `refs/harness/memory` with progressive disclosure, disposable SQLite FTS5 recall index, and background memory gardener subagents.
