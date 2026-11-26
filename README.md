# git-harness

A first-principles coding agent harness where **Git is a first-class resident**—not a bolted-on tool. Zero npm dependencies, running directly on Node.js (`>= 22.18` / `24`).

## Core Thesis

Modern coding agent harnesses repeatedly reinvent partial versions of Git across disconnected subsystems:

- **Tree-structured session logs** → a custom commit DAG
- **Pre-edit file checkpoints & rewind** → custom tree snapshots
- **Compaction & cold recall** → append-only history + projected views
- **Subagent worktrees** → isolated code branches disconnected from conversation state
- **Versioned skills & persistent memory** → unversioned markdown folders

`git-harness` unifies all of these onto Git's native content-addressed object model (blobs, trees, commits, shadow refs, worktrees, and notes) while keeping the user's normal branches and `git status` completely clean.

## Key Capabilities

- **Co-Atomic Turn Commits & Persistent Shadow Index**: Every turn (and optional intra-turn checkpoint) snapshots both conversation events and the working tree via a private `GIT_INDEX_FILE` shadow index (`0.206%` median Git overhead in Terminal-Bench v2.1), enabling one-command atomic rewind of conversation + files without touching the host repo's staging area.
- **Shadow Ref Namespaces**: Sessions (`refs/harness/sessions/*`), subagents (`refs/harness/agents/*`), archived/abandoned branches (`refs/harness/archive/*`, `refs/harness/abandoned/*`), persistent memory (`refs/harness/memory`), and versioned skills (`refs/harness/skills`) live in isolated refs using Git plumbing.
- **Cache-Aware, Non-Destructive Compaction & `blob://` Offloading**: First-parent prompt projection keeps prompt prefixes byte-identical (`97.35%` weighted live KV-cache hit rate in Terminal-Bench v2.1). Dual-parent compaction anchors reset active context while preserving 100% of raw history for cold recall. Oversized tool outputs offload cleanly to `blob://<sha>`, and `read` supports multimodal images (`.png`/`.jpg`/`.webp`/`.gif`) and `commit://<sha>/<path>`.
- **Lossless Subagent Orchestration & Meta-Harness**: Spawn parallel subagents on isolated Git branches (+ linked worktrees seeded with uncommitted parent edits), run verification gates recorded as Git notes, and `squash` (with optional `applyWorkspaceChanges: false` provenance-only merge), `cherry-pick`, or `drop` cleanly. Reaching `maxSteps` triggers a graceful no-tool synthesis handoff, and archived subagents remain immediately inspectable via `history show` and auto-refreshed SQLite FTS5 `recall`.
- **Streaming, Guardrails, HITL Approvals, MCP & OS Sandboxing**: Zero-dependency SSE streaming (OpenAI-compatible & Anthropic), `StuckLoopHook` (failure streaks, file-churn oscillation, step & wall-clock budgets), interactive `--approve` pre-effect hook, stdio MCP client (`--mcp`), and OS kernel sandboxing (`--sandbox` / `--sandbox-no-net` via macOS `sandbox-exec` or Linux `bwrap`).

## Documentation & Benchmarks

- [DESIGN.md](./DESIGN.md) — First-principles architecture, 6-layer module boundaries, comparative harness study, and Git ref/object schema.
- [RUBRICS.md](./RUBRICS.md) — Evaluation rubrics: simplicity/decoupling gates, P0 automated invariants, P1 benchmark targets, and Git-first litmus tests.
- [BENCHMARK_TB21.md](./BENCHMARK_TB21.md) — Terminal-Bench v2.1 (89 tasks) evaluation comparing `git-harness` (`81/89` = `91.01%` combined through `v0.7.1`, `97.35%` weighted KV-cache hit rate, `0.206%` median Git overhead) against `pi v0.83.0` (`76/89` = `85.39%`).

## Quick Start

Requires **Node.js >= 22.18** (Node 24 recommended) and `git`. No `npm install` needed.

```bash
# Run full unit & E2E test suite (43 tests)
npm test

# Run 10,000-file P0-6 latency benchmark
npm run bench

# Run P1 ablation & rubric scorecard (pollution, KV-cache, cold recall, handoff compression)
npm run eval

# Offline Git session / memory / skills / recall / JSON-RPC commands (no API key required)
node src/cli/main.ts sessions
node src/cli/main.ts log
node src/cli/main.ts memory list
node src/cli/main.ts skills list
node src/cli/main.ts recall "query terms"
node src/cli/main.ts rpc

# Interactive coding session (set OPENAI_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY)
export OPENAI_API_KEY="sk-..."
node src/cli/main.ts --provider openai --model gpt-4.1 --session main

# Headless autonomous run with profiling, periodic bundle export, approvals, OS sandbox, or MCP
node src/cli/main.ts --provider anthropic --model claude-sonnet-4-5 \
  --checkpoint-every 1 --offload-bytes 8192 --time-budget-sec 900 \
  --profile /tmp/profile.jsonl --bundle-out /tmp/session.bundle \
  run -- "Fix the failing tests and explain the root cause"
```

## Module Layout

- `src/git-store/` — **Layer 0**: pure Git object/ref plumbing, persistent shadow index, detached `--git-dir` with automatic large-file/unborn-repo guards, worktrees, notes, plus `InMemoryObjectStore`.
- `src/session/` — **Layer 1**: turn DAG, co-atomic rewind, dual-parent compaction anchors, KV-cache-preserving `project()`, and `history` tool (`log`, `branches`, `show`, `diff`, `rewind`).
- `src/runtime/` — **Layer 2**: minimal 4-tool loop (`read`, `write`, `edit`, `bash`) with wave-parallel execution, graceful `maxSteps` synthesis handoff, `RuntimeHook`s (`StuckLoopHook`, `ApprovalHook`), zero-dep streaming OpenAI/Anthropic/Mock adapters, and Pi-compatible `models.json` loader.
- `src/orchestrator/` — **Layer 3** *(optional)*: Git-native subagent `spawn`/`review`/`integrate` (`squash`, `cherry-pick`, `drop`) + `ExternalCliRunner` meta-harness adapter.
- `src/memory/` — **Layer 4** *(optional)*: persistent `refs/harness/memory`, P0-10 anti-poisoning promotion gates, disposable SQLite FTS5 `RecallIndex` (`node:sqlite`) with content-addressed `ensureFresh()`, and pluggable `recall` tool / pinned-memory hook.
- `src/skills/` — **Layer 4** *(optional)*: Git-native versioned skills (`refs/harness/skills` + FS discovery), `skill://<name>/SKILL.md` progressive disclosure, and anti-poisoning promotion gates.
- `src/mcp/` — **Layer 4** *(optional)*: thin zero-dep JSON-RPC 2.0 MCP stdio client (`McpStdioClient`, `loadMcpTools`).
- `src/sandbox/` — **Layer 4** *(optional)*: OS kernel `bash` sandboxing (`sandbox-exec` on macOS, `bwrap` on Linux).
- `src/rpc/` & `src/cli/` — **Layer 5**: thin NDJSON JSON-RPC 2.0 server & streaming interactive/headless CLI.
- `src/eval/` & `harbor/` — P1 ablation suite, step profiler analyzer, and generic Harbor benchmark runner adapter.

## License

[MIT](./LICENSE)
