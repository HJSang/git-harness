"""
Harbor BaseInstalledAgent adapter for `git-harness`.

Usage with Harbor:
  PYTHONPATH=/path/to/git-harness/harbor harbor run \
    -d terminal-bench/terminal-bench-2-1 \
    --agent git_harness_agent:GitHarnessAgent \
    -m gpt-4.1
"""

from __future__ import annotations

import json
import os
import shlex
import tarfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class GitHarnessAgent(BaseInstalledAgent):
    """Harbor 0.20.0 adapter that installs and runs `git-harness` with Git profiling."""

    def __init__(
        self,
        logs_dir: Path,
        max_steps: int = 120,
        checkpoint_every: int = 1,
        auto_compact_tokens: int = 160000,
        offload_bytes: int = 8192,
        provider: str = "openai",
        base_url: str | None = None,
        api_key: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        time_budget_sec: int | None = None,
        *args,
        **kwargs,
    ):
        super().__init__(logs_dir, *args, **kwargs)
        self._max_steps = int(max_steps)
        self._checkpoint_every = int(checkpoint_every)
        self._auto_compact_tokens = int(auto_compact_tokens)
        self._offload_bytes = int(offload_bytes)
        self._provider = provider
        self._base_url = base_url
        self._api_key = api_key
        self._max_tokens = int(max_tokens) if max_tokens is not None else None
        self._temperature = float(temperature) if temperature is not None else None
        self._reasoning_effort = reasoning_effort
        self._time_budget_sec = int(time_budget_sec) if time_budget_sec is not None else None

    @staticmethod
    def name() -> str:
        return "git-harness"

    def version(self) -> str | None:
        return self._version or "0.1.0"

    async def install(self, environment: BaseEnvironment) -> None:
        # Pack lightweight source tarball (~40 KB, zero node_modules!) and upload into sandbox
        repo_root = Path(__file__).resolve().parent.parent
        tarball_path = self.logs_dir / "git-harness.tar.gz"
        with tarfile.open(tarball_path, "w:gz") as tf:
            for item in ("src", "package.json", "models.json", "tsconfig.json"):
                src_item = repo_root / item
                if src_item.exists():
                    tf.add(src_item, arcname=item)

        install_script = Path(__file__).parent / "install-git-harness.sh.j2"

        await environment.upload_file(
            source_path=tarball_path,
            target_path="/installed-agent/git-harness.tar.gz",
        )
        await environment.upload_file(
            source_path=install_script,
            target_path="/installed-agent/install.sh",
        )
        await self.exec_as_root(
            environment,
            command="bash /installed-agent/install.sh",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped_instruction = shlex.quote(instruction)
        model_flag = f"--model {shlex.quote(self.model_name)}" if self.model_name else ""
        extra_flags = []
        if self._base_url:
            extra_flags.append(f"--base-url {shlex.quote(self._base_url)}")
        if self._api_key:
            extra_flags.append(f"--api-key {shlex.quote(self._api_key)}")
        if self._max_tokens is not None:
            extra_flags.append(f"--max-tokens {self._max_tokens}")
        if self._temperature is not None:
            extra_flags.append(f"--temperature {self._temperature}")
        if self._reasoning_effort:
            extra_flags.append(f"--reasoning-effort {shlex.quote(self._reasoning_effort)}")
        if self._time_budget_sec is not None:
            extra_flags.append(f"--time-budget-sec {self._time_budget_sec}")
        extra_flags_str = " ".join(extra_flags)

        # Use fast local detached GIT_DIR at /tmp/harness.git (zero pollution in /app),
        # keep /logs/agent/session.bundle fresh periodically & on SIGTERM/EXIT trap so even
        # hard-timed-out trials preserve their full forensic Git DAG.
        cmd = (
            "mkdir -p /logs/agent && "
            "rm -rf /tmp/harness.git && "
            "export_harness_artifacts() { "
            "GIT_DIR=/tmp/harness.git git bundle create /logs/agent/session.bundle.tmp --glob='refs/harness/*' >/dev/null 2>&1 "
            "&& mv -f /logs/agent/session.bundle.tmp /logs/agent/session.bundle || true; "
            "GIT_DIR=/tmp/harness.git node -e '"
            'const { execFileSync } = require("child_process"); '
            'const fs = require("fs"); '
            'const g = (a) => { try { return execFileSync("git", a, { encoding: "utf8" }).trim(); } catch { return ""; } }; '
            'const refs = g(["for-each-ref", "--format=%(refname) %(objectname)", "refs/harness/"]).split("\\n").filter(Boolean); '
            'const countObj = g(["count-objects", "-v"]); '
            'const commits = g(["log", "--all", "--format=%H|%P|%s", "--glob=refs/harness/*"]).split("\\n").filter(Boolean); '
            'const wTrees = new Set(g(["log", "--all", "--format=%(trailers:key=Workspace-Tree,valueonly)", "--glob=refs/harness/*"]).split("\\n").map(s=>s.trim()).filter(Boolean)); '
            'fs.writeFileSync("/logs/agent/git-stats.json", JSON.stringify({ refs, commitCount: commits.length, uniqueWorkspaceTrees: wTrees.size, countObjects: countObj }, null, 2));'
            "' || true; }; "
            "trap export_harness_artifacts EXIT TERM INT; "
            "node /installed-agent/git-harness/src/cli/main.ts "
            '--repo "$(pwd)" '
            "--git-dir /tmp/harness.git "
            "--models /installed-agent/git-harness/models.json "
            f"--provider {shlex.quote(self._provider)} "
            f"{model_flag} "
            f"{extra_flags_str} "
            "--session main "
            f"--max-steps {self._max_steps} "
            f"--checkpoint-every {self._checkpoint_every} "
            f"--auto-compact-tokens {self._auto_compact_tokens} "
            f"--offload-bytes {self._offload_bytes} "
            "--bundle-out /logs/agent/session.bundle "
            "--allow-outside-workspace "
            "--no-stream "
            "--profile /logs/agent/profile.jsonl "
            f"run -- {escaped_instruction} "
            "2>&1 | tee /logs/agent/git-harness.log; "
            "EXIT_CODE=${PIPESTATUS[0]:-$?}; "
            "export_harness_artifacts; "
            "exit $EXIT_CODE"
        )

        env: dict[str, str] = {}
        for k in (
            "HARNESS_PROVIDER",
            "HARNESS_MODEL",
            "HARNESS_TIME_BUDGET_SEC",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_BASE_URL",
        ):
            if k in os.environ:
                env[k] = os.environ[k]
        if self._extra_env:
            env.update(self._extra_env)

        await self.exec_as_agent(environment, command=cmd, env=env)

        # Pull profile.jsonl locally (if not already synced) to populate Harbor AgentContext metrics
        local_profile = self.logs_dir / "profile.jsonl"
        if not local_profile.exists():
            try:
                await environment.download_file(
                    source_path="/logs/agent/profile.jsonl",
                    target_path=local_profile,
                )
            except Exception:
                pass

        self._populate_context_from_profile(local_profile, context)

    def _populate_context_from_profile(self, profile_path: Path, context: AgentContext) -> None:
        if not profile_path.exists():
            return
        total_in = 0
        total_out = 0
        total_cache = 0
        total_git_ms = 0.0
        total_model_ms = 0.0
        total_tools_ms = 0.0
        steps = 0
        compactions = 0

        for line in profile_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            steps += 1
            total_in += int(row.get("tokensIn") or 0)
            total_out += int(row.get("tokensOut") or 0)
            total_cache += int(row.get("cacheRead") or 0)
            total_git_ms += float(row.get("gitCheckpointMs") or 0.0)
            total_model_ms += float(row.get("modelLatencyMs") or 0.0)
            total_tools_ms += float(row.get("toolsLatencyMs") or 0.0)
            if row.get("compactedAnchorSha"):
                compactions += 1

        context.n_input_tokens = total_in
        context.n_output_tokens = total_out
        context.n_cache_tokens = total_cache
        context.metadata = {
            **(context.metadata or {}),
            "git_harness_steps": steps,
            "git_harness_compactions": compactions,
            "git_harness_cache_hit_rate": round(total_cache / total_in, 4) if total_in > 0 else 0.0,
            "git_harness_git_ms": round(total_git_ms, 2),
            "git_harness_model_ms": round(total_model_ms, 2),
            "git_harness_tools_ms": round(total_tools_ms, 2),
        }
