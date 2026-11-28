#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatEvalReport, runP1AblationSuite } from "../eval/index.ts";
import { GitCliStore } from "../git-store/index.ts";
import {
  MemoryStore,
  RecallIndex,
  createPinnedMemoryHook,
  createRecallTool,
} from "../memory/index.ts";
import { McpStdioClient, loadMcpTools } from "../mcp/index.ts";
import {
  RuntimeAgentRunner,
  SubagentOrchestrator,
  createSubagentTool,
} from "../orchestrator/index.ts";
import { HarnessRpcServer } from "../rpc/index.ts";
import {
  AgentRuntime,
  AnthropicAdapter,
  OpenAICompatAdapter,
  createAdapterFromModelsConfig,
  createApprovalHook,
  createCoreTools,
  createStuckLoopHook,
  findModelsConfigPath,
  loadModelsConfig,
  type ModelAdapter,
  type RuntimeHook,
  type Tool,
} from "../runtime/index.ts";
import { createOsSandboxExecutor } from "../sandbox/index.ts";
import {
  SESSION_REF_PREFIX,
  SessionStore,
  createHistoryTool,
  sessionRef,
  type SessionCommitRecord,
} from "../session/index.ts";
import { SkillStore, createSkillCatalogHook } from "../skills/index.ts";

export function formatSessionLog(records: SessionCommitRecord[], currentHead: string | null): string {
  if (records.length === 0) return "(no turns committed yet)";
  return records
    .map((r) => {
      const marker = r.sha === currentHead ? "*" : " ";
      const short = r.sha.slice(0, 8);
      const kind = r.kind.padEnd(14);
      const model = r.trailers["Model"] ? ` [${r.trailers["Model"]}]` : "";
      const parents =
        r.parents.length > 1
          ? ` (merge: ${r.parents.map((p) => p.slice(0, 7)).join(", ")})`
          : "";
      return `${marker} ${short}  ${kind}  ${r.title}${model}${parents}`;
    })
    .join("\n");
}

function buildModelFromEnv(overrides?: {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  modelsConfigPath?: string;
  cwd?: string;
}): ModelAdapter | null {
  const provider = (overrides?.provider ?? process.env.HARNESS_PROVIDER ?? "").toLowerCase();

  // Direct OpenAI-compatible custom endpoint (e.g. local SGLang / vLLM) when --base-url is passed
  if (overrides?.baseUrl && (!provider || provider === "openai" || provider === "sglang" || provider === "vllm" || provider === "custom")) {
    return new OpenAICompatAdapter({
      model: overrides.model ?? process.env.HARNESS_MODEL ?? "default",
      apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY ?? "EMPTY",
      baseUrl: overrides.baseUrl,
      maxTokens: overrides.maxTokens,
      temperature: overrides.temperature,
      reasoningEffort: overrides.reasoningEffort,
    });
  }

  // 1. Check Pi-compatible `models.json` (explicit --models, repo models.json, ~/.git-harness, ~/.pi/agent)
  const cfgPath = findModelsConfigPath(overrides?.modelsConfigPath, overrides?.cwd);
  if (cfgPath) {
    const config = loadModelsConfig(cfgPath);
    if (!provider || config.providers[provider]) {
      try {
        const adapter = createAdapterFromModelsConfig({
          config,
          provider: provider || undefined,
          model: overrides?.model ?? process.env.HARNESS_MODEL,
          baseUrl: overrides?.baseUrl,
          apiKey: overrides?.apiKey,
          maxTokens: overrides?.maxTokens,
          temperature: overrides?.temperature,
          reasoningEffort: overrides?.reasoningEffort,
        });
        if (adapter) return adapter;
      } catch (err) {
        // If user explicitly targeted this provider or config file, surface the error immediately.
        if (overrides?.modelsConfigPath || (provider && config.providers[provider])) {
          throw err;
        }
      }
    }
  }

  if (provider === "anthropic" || (!provider && process.env.ANTHROPIC_API_KEY)) {
    const apiKey = overrides?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for anthropic provider");
    return new AnthropicAdapter({
      model: overrides?.model ?? process.env.HARNESS_MODEL ?? "claude-sonnet-4-5",
      apiKey,
      baseUrl: overrides?.baseUrl ?? process.env.ANTHROPIC_BASE_URL,
      maxTokens: overrides?.maxTokens,
      reasoningEffort: overrides?.reasoningEffort,
    });
  }

  if (provider === "deepseek" || (!provider && process.env.DEEPSEEK_API_KEY)) {
    const apiKey = overrides?.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for deepseek provider");
    return new OpenAICompatAdapter({
      model: overrides?.model ?? process.env.HARNESS_MODEL ?? "deepseek-chat",
      apiKey,
      baseUrl: overrides?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
      maxTokens: overrides?.maxTokens,
      temperature: overrides?.temperature,
      reasoningEffort: overrides?.reasoningEffort,
    });
  }

  if (provider === "openai" || (!provider && process.env.OPENAI_API_KEY)) {
    const apiKey = overrides?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for openai provider");
    return new OpenAICompatAdapter({
      model: overrides?.model ?? process.env.HARNESS_MODEL ?? "gpt-4.1",
      apiKey,
      baseUrl: overrides?.baseUrl ?? process.env.OPENAI_BASE_URL,
      maxTokens: overrides?.maxTokens,
      temperature: overrides?.temperature,
      reasoningEffort: overrides?.reasoningEffort,
    });
  }

  return null;
}

function resolvePrefixSha(sessions: SessionStore, refName: string, prefix: string): string {
  const history = sessions.logFirstParent(refName, 500);
  const matches = history.filter((r) => r.sha.startsWith(prefix));
  if (matches.length === 1) return matches[0]!.sha;
  if (matches.length > 1) {
    throw new Error(`Ambiguous SHA prefix "${prefix}" (${matches.length} matches)`);
  }
  return prefix;
}

function printHelp(): void {
  console.log(
    [
      "Commands:",
      "  /log, /tree            Show first-parent session history",
      "  /sessions              List all harness sessions",
      "  /fork <name>           Fork current session into a new session branch",
      "  /switch <name>         Switch active session branch",
      "  /rewind <sha>          Co-atomically rewind session + workspace to <sha>",
      "  /compact [focus]       Create a dual-parent compaction anchor commit",
      "  /memory [path]         List persistent memory files or read a specific path",
      "  /skills [name]         List available skills or read a skill's SKILL.md",
      "  /recall <query>        Search compacted session history & persistent memory",
      "  /status                Show current session ref, HEAD, and active model",
      "  /help                  Show this help",
      "  /quit                  Exit",
    ].join("\n"),
  );
}

function splitCommandLine(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function runCli(argv: string[]): Promise<void> {
  let repoRoot = process.cwd();
  let gitDir: string | undefined;
  let currentSessionId = "default";
  let provider: string | undefined;
  let modelName: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let maxTokens: number | undefined;
  let temperature: number | undefined;
  let reasoningEffort: string | undefined;
  let modelsConfigPath: string | undefined;
  let maxSteps: number | undefined;
  let checkpointEvery: number | undefined;
  let autoCompactTokens: number | undefined;
  let offloadBytes: number | undefined;
  let allowOutsideWorkspace = false;
  let profilePath: string | undefined;
  let bundleOutPath: string | undefined;
  let timeBudgetSec: number | undefined = process.env.HARNESS_TIME_BUDGET_SEC
    ? Number(process.env.HARNESS_TIME_BUDGET_SEC)
    : undefined;
  let enableStream = true;
  let enableApprove = false;
  let enableSandbox = false;
  let sandboxAllowNetwork = true;
  let parallelToolCalls = true;
  let enableSubagents = true;
  let enableStuckHook = true;
  const mcpCommands: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--repo" && argv[i + 1]) repoRoot = argv[++i]!;
    else if (arg === "--git-dir" && argv[i + 1]) gitDir = argv[++i]!;
    else if (arg === "--session" && argv[i + 1]) currentSessionId = argv[++i]!;
    else if (arg === "--provider" && argv[i + 1]) provider = argv[++i]!;
    else if (arg === "--model" && argv[i + 1]) modelName = argv[++i]!;
    else if (arg === "--base-url" && argv[i + 1]) baseUrl = argv[++i]!;
    else if (arg === "--api-key" && argv[i + 1]) apiKey = argv[++i]!;
    else if (arg === "--max-tokens" && argv[i + 1]) maxTokens = Number(argv[++i]!);
    else if (arg === "--temperature" && argv[i + 1]) temperature = Number(argv[++i]!);
    else if (arg === "--reasoning-effort" && argv[i + 1]) reasoningEffort = argv[++i]!;
    else if (arg === "--models" && argv[i + 1]) modelsConfigPath = argv[++i]!;
    else if (arg === "--max-steps" && argv[i + 1]) maxSteps = Number(argv[++i]!);
    else if (arg === "--checkpoint-every" && argv[i + 1]) checkpointEvery = Number(argv[++i]!);
    else if (arg === "--auto-compact-tokens" && argv[i + 1]) autoCompactTokens = Number(argv[++i]!);
    else if (arg === "--offload-bytes" && argv[i + 1]) offloadBytes = Number(argv[++i]!);
    else if (arg === "--allow-outside-workspace") allowOutsideWorkspace = true;
    else if (arg === "--profile" && argv[i + 1]) profilePath = argv[++i]!;
    else if (arg === "--bundle-out" && argv[i + 1]) bundleOutPath = argv[++i]!;
    else if (arg === "--time-budget-sec" && argv[i + 1]) timeBudgetSec = Number(argv[++i]!);
    else if (arg === "--no-stream") enableStream = false;
    else if (arg === "--approve") enableApprove = true;
    else if (arg === "--sandbox") enableSandbox = true;
    else if (arg === "--sandbox-no-net") {
      enableSandbox = true;
      sandboxAllowNetwork = false;
    } else if (arg === "--no-parallel-tools") parallelToolCalls = false;
    else if (arg === "--no-subagents") enableSubagents = false;
    else if (arg === "--no-stuck-hook") enableStuckHook = false;
    else if (arg === "--mcp" && argv[i + 1]) mcpCommands.push(argv[++i]!);
    else positional.push(arg);
  }

  const subcmd = positional[0];

  if (subcmd === "eval") {
    const report = runP1AblationSuite();
    console.log(formatEvalReport(report));
    if (!report.passed) process.exitCode = 1;
    return;
  }

  const gitStore = new GitCliStore({ repoRoot, gitDir });
  const sessions = new SessionStore(gitStore);
  const memory = new MemoryStore(gitStore);
  const skills = new SkillStore(gitStore, { workspaceRoot: gitStore.repoRoot });
  const orchestrator = new SubagentOrchestrator({
    store: gitStore,
    sessions,
    workspaceRoot: gitStore.repoRoot,
  });
  let activeRef = sessionRef(currentSessionId);

  // Offline Git inspection/navigation/memory/recall subcommands require NO API key.
  if (subcmd === "sessions") {
    const list = sessions.listSessions(SESSION_REF_PREFIX);
    if (list.length === 0) {
      console.log("(no sessions)");
    } else {
      for (const entry of list) {
        console.log(`${entry.ref.replace(SESSION_REF_PREFIX, "")}\t${entry.sha.slice(0, 8)}`);
      }
    }
    return;
  }

  if (subcmd === "log" || subcmd === "tree") {
    const head = gitStore.readRef(activeRef);
    console.log(formatSessionLog(sessions.logFirstParent(activeRef), head));
    return;
  }

  if (subcmd === "fork") {
    const targetName = positional[1];
    if (!targetName) throw new Error("Usage: git-harness fork <new-session-name>");
    const sha = sessions.fork(activeRef, sessionRef(targetName));
    console.log(`Forked ${currentSessionId} -> ${targetName} @ ${sha.slice(0, 8)}`);
    return;
  }

  if (subcmd === "rewind") {
    const rawTarget = positional[1];
    if (!rawTarget) throw new Error("Usage: git-harness rewind <sha-prefix>");
    const sha = resolvePrefixSha(sessions, activeRef, rawTarget);
    const rec = sessions.rewind(activeRef, sha, {
      preserveAbandonedAs: `refs/harness/abandoned/${currentSessionId}-${Date.now()}`,
    });
    console.log(`Rewound ${currentSessionId} + workspace to ${rec.sha.slice(0, 8)} (${rec.title})`);
    return;
  }

  if (subcmd === "memory") {
    const action = positional[1] ?? "list";
    if (action === "list") {
      const files = memory.list(positional[2] ?? "");
      console.log(files.length > 0 ? files.join("\n") : "(no memory files)");
      return;
    }
    if (action === "read") {
      const target = positional[2];
      if (!target) throw new Error("Usage: git-harness memory read <path>");
      const content = memory.read(target);
      if (content === null) throw new Error(`Memory file not found: ${target}`);
      console.log(content);
      return;
    }
    if (action === "put") {
      const target = positional[2];
      const text = positional.slice(3).join(" ");
      if (!target || !text) throw new Error("Usage: git-harness memory put <path> <content>");
      const sha = memory.put({
        files: [{ path: target, content: text + "\n" }],
        message: `cli: update ${target}`,
      });
      console.log(`Committed ${target} -> ${sha.slice(0, 8)}`);
      return;
    }
    throw new Error(`Unknown memory action: ${action} (expected list | read | put)`);
  }

  if (subcmd === "skills") {
    const action = positional[1] ?? "list";
    if (action === "list") {
      const list = skills.list();
      console.log(
        list.length > 0
          ? list.map((s) => `${s.name}\t[${s.source}]\t${s.description}`).join("\n")
          : "(no skills found)",
      );
      return;
    }
    if (action === "read") {
      const name = positional[2];
      const inner = positional[3] ?? "SKILL.md";
      if (!name) throw new Error("Usage: git-harness skills read <skill-name> [relative-path]");
      const content = skills.readFile(name, inner);
      if (content === null) throw new Error(`Skill file not found: ${name}/${inner}`);
      console.log(content);
      return;
    }
    if (action === "put") {
      const name = positional[2];
      const srcFile = positional[3];
      if (!name || !srcFile) throw new Error("Usage: git-harness skills put <skill-name> <SKILL.md-path>");
      const content = fs.readFileSync(srcFile, "utf8");
      const sha = skills.put({
        skillName: name,
        files: [{ path: "SKILL.md", content }],
        message: `cli: install skill ${name}`,
      });
      console.log(`Committed skill ${name} -> ${sha.slice(0, 8)}`);
      return;
    }
    if (action === "promote") {
      const proposalId = positional[2];
      if (!proposalId) throw new Error("Usage: git-harness skills promote <proposal-id>");
      const res = await skills.promote(proposalId);
      console.log(JSON.stringify(res, null, 2));
      if (!res.promoted) process.exitCode = 1;
      return;
    }
    throw new Error(`Unknown skills action: ${action} (expected list | read | put | promote)`);
  }

  if (subcmd === "recall") {
    const query = positional.slice(1).join(" ").trim();
    if (!query) throw new Error("Usage: git-harness recall <query>");
    const index = new RecallIndex({ store: gitStore, sessions, memory });
    try {
      index.rebuild();
      const hits = index.search({ query, limit: 8 });
      if (hits.length === 0) {
        console.log(`(no recall hits for "${query}")`);
      } else {
        for (const h of hits) {
          console.log(`[${h.source}] ${h.sha.slice(0, 8)} ${h.ref} :: ${h.path} — ${h.title}`);
          console.log(`  ${h.snippet}`);
        }
      }
    } finally {
      index.close();
    }
    return;
  }

  const model = buildModelFromEnv({
    provider,
    model: modelName,
    baseUrl,
    apiKey,
    maxTokens,
    temperature,
    reasoningEffort,
    modelsConfigPath,
    cwd: gitStore.repoRoot,
  });
  const recallDbPath = path.join(
    gitDir ? path.resolve(gitDir) : path.join(gitStore.repoRoot, ".git"),
    "harness-cache",
    "recall.db",
  );
  const recallIndex = new RecallIndex({ store: gitStore, sessions, memory, dbPath: recallDbPath });

  const mcpClients: McpStdioClient[] = [];
  let activeRl: readline.Interface | null = null;
  let streamedInCurrentStep = false;

  try {
    recallIndex.rebuild();

    const sandboxExecutor = enableSandbox
      ? createOsSandboxExecutor({
          workspaceRoot: gitStore.repoRoot,
          allowNetwork: sandboxAllowNetwork,
        })
      : undefined;

    const coreTools = createCoreTools({
      enforceWorkspaceBoundary: !allowOutsideWorkspace,
      execCommand: sandboxExecutor,
      readBlob: (sha) => sessions.readBlob(sha),
      readCommitFile: (sha, relPath) => sessions.readCommitFile(sha, relPath),
      readSkillFile: (skillName, relPath) => skills.readFileBytes(skillName, relPath),
    });

    const mcpTools: Tool[] = [];
    for (const rawCmd of mcpCommands) {
      const parts = splitCommandLine(rawCmd);
      const bin = parts[0];
      if (!bin) continue;
      const client = new McpStdioClient({
        command: bin,
        args: parts.slice(1),
        cwd: gitStore.repoRoot,
      });
      await client.connect();
      mcpClients.push(client);
      const loaded = await loadMcpTools(client);
      mcpTools.push(...loaded);
    }

    const hooks: RuntimeHook[] = [
      createPinnedMemoryHook(memory),
      createSkillCatalogHook(skills),
      ...(enableStuckHook
        ? [
            createStuckLoopHook({
              sessions,
              timeBudgetMs: timeBudgetSec && timeBudgetSec > 0 ? timeBudgetSec * 1000 : undefined,
              subagentsEnabled: enableSubagents,
            }),
          ]
        : []),
    ];

    const exportBundleAtomic = () => {
      if (!bundleOutPath) return;
      try {
        fs.mkdirSync(path.dirname(bundleOutPath), { recursive: true });
        const tmpPath = `${bundleOutPath}.tmp`;
        execFileSync(
          "git",
          ["--git-dir", gitStore.gitDir, "bundle", "create", tmpPath, "--glob=refs/harness/*"],
          { stdio: "ignore" },
        );
        fs.renameSync(tmpPath, bundleOutPath);
      } catch {
        // Ignore transient bundle errors (e.g., before first commit)
      }
    };
    let commitsSinceBundle = 0;

    if (enableApprove) {
      hooks.push(
        createApprovalHook({
          async confirm(ctx) {
            if (!activeRl) return false;
            const preview = JSON.stringify(ctx.args).slice(0, 140);
            const ans = (
              await activeRl.question(`\n[approve] Allow ${ctx.toolName}(${preview})? [y/N/a(lways)] `)
            )
              .trim()
              .toLowerCase();
            if (ans === "a" || ans === "always") return "always";
            return ans === "y" || ans === "yes";
          },
        }),
      );
    }

    const runtime = model
      ? new AgentRuntime({
          sessions,
          model,
          workspaceRoot: gitStore.repoRoot,
          defaultMaxSteps: maxSteps ?? (subcmd === "run" ? 80 : 24),
          defaultCheckpointEverySteps: checkpointEvery ?? 0,
          autoCompactThresholdTokens: autoCompactTokens,
          offloadOutputThresholdBytes: offloadBytes,
          profileLogPath: profilePath,
          parallelToolCalls,
          stream: enableStream && subcmd !== "rpc",
          tools: [
            ...coreTools,
            createHistoryTool(sessions),
            createRecallTool(recallIndex, memory),
            ...(enableSubagents
              ? [
                  createSubagentTool({
                    orchestrator,
                    loadSkillBody: (name) => skills.readFile(name, "SKILL.md"),
                    createRunner: () =>
                      new RuntimeAgentRunner({
                        model,
                        store: gitStore,
                        gitDir,
                        tools: [...coreTools, createRecallTool(recallIndex, memory)],
                        offloadOutputThresholdBytes: offloadBytes,
                        maxSteps: 30,
                      }),
                  }),
                ]
              : []),
            ...mcpTools,
          ],
          hooks,
          onEvent(ev) {
            if (ev.type === "text_delta") {
              if (!streamedInCurrentStep) {
                streamedInCurrentStep = true;
              }
              process.stdout.write(ev.text);
            } else if (ev.type === "model_response") {
              if (streamedInCurrentStep) {
                process.stdout.write("\n");
                streamedInCurrentStep = false;
              }
            } else if (ev.type === "tool_start") {
              console.log(`  [tool] ${ev.toolName}(${JSON.stringify(ev.args).slice(0, 100)})`);
            } else if (ev.type === "tool_blocked") {
              console.log(`  [blocked] ${ev.toolName}: ${ev.reason}`);
            } else if (ev.type === "turn_committed") {
              commitsSinceBundle++;
              if (bundleOutPath && (commitsSinceBundle === 1 || commitsSinceBundle % 10 === 0)) {
                exportBundleAtomic();
              }
            } else if (ev.type === "compacted") {
              recallIndex.rebuild();
              exportBundleAtomic();
              console.log(`  [compact] anchor ${ev.anchorSha.slice(0, 8)}`);
            }
          },
        })
      : undefined;

    if (subcmd === "rpc") {
      const server = new HarnessRpcServer({
        store: gitStore,
        sessions,
        memory,
        recall: recallIndex,
        runtime,
        orchestrator,
      });
      await server.serveStdio();
      return;
    }

    if (!runtime || !model) {
      throw new Error(
        "No model API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY (or use offline commands: log, tree, sessions, fork, rewind, memory, recall, eval, rpc).",
      );
    }

    if (subcmd === "compact") {
      const focus = positional.slice(1).join(" ") || undefined;
      const anchor = await runtime.compactSession(activeRef, focus);
      console.log(`Compacted ${currentSessionId} -> anchor ${anchor.slice(0, 8)}`);
      return;
    }

    if (subcmd === "run") {
      const prompt = positional.slice(1).join(" ").trim();
      if (!prompt) throw new Error("Usage: git-harness run <prompt>");
      const ac = new AbortController();
      const onSig = () => {
        ac.abort();
        exportBundleAtomic();
      };
      process.once("SIGTERM", onSig);
      process.once("SIGINT", onSig);
      try {
        const res = await runtime.runTurn({
          sessionRef: activeRef,
          userInput: prompt,
          signal: ac.signal,
        });
        exportBundleAtomic();
        if (!enableStream && res.assistantText) {
          console.log(res.assistantText);
        }
        console.log(
          `\n[committed ${res.commitSha.slice(0, 8)} | steps=${res.steps} | tools=${res.toolCallsExecuted} | stop=${res.stopReason}]`,
        );
      } finally {
        process.off("SIGTERM", onSig);
        process.off("SIGINT", onSig);
      }
      return;
    }

    // Interactive REPL
    console.log(
      `git-harness (repo=${gitStore.repoRoot}, session=${currentSessionId}, model=${model.id}${enableSandbox ? ", sandbox=on" : ""}${enableApprove ? ", approve=on" : ""}${mcpTools.length > 0 ? `, mcpTools=${mcpTools.length}` : ""})`,
    );
    console.log("Type a prompt or /help for session commands.");

    const rl = readline.createInterface({ input, output });
    activeRl = rl;
    try {
      while (true) {
        const line = (await rl.question(`\n[${currentSessionId}]> `)).trim();
        if (!line) continue;
        if (line === "/quit" || line === "/exit") break;
        if (line === "/help") {
          printHelp();
          continue;
        }
        if (line === "/log" || line === "/tree") {
          console.log(
            formatSessionLog(sessions.logFirstParent(activeRef), gitStore.readRef(activeRef)),
          );
          continue;
        }
        if (line === "/sessions") {
          const list = sessions.listSessions(SESSION_REF_PREFIX);
          for (const e of list) {
            console.log(`${e.ref.replace(SESSION_REF_PREFIX, "")}\t${e.sha.slice(0, 8)}`);
          }
          continue;
        }
        if (line === "/status") {
          const head = gitStore.readRef(activeRef);
          console.log(
            `session=${activeRef} head=${head ? head.slice(0, 8) : "(empty)"} model=${runtime.getModel().id}`,
          );
          continue;
        }
        if (line === "/memory") {
          const files = memory.list();
          console.log(files.length > 0 ? files.join("\n") : "(no memory files)");
          continue;
        }
        if (line.startsWith("/memory ")) {
          const p = line.slice(8).trim();
          console.log(memory.read(p) ?? `(not found: ${p})`);
          continue;
        }
        if (line === "/skills") {
          const list = skills.list();
          console.log(
            list.length > 0
              ? list.map((s) => `${s.name}\t[${s.source}]\t${s.description}`).join("\n")
              : "(no skills found)",
          );
          continue;
        }
        if (line.startsWith("/skills ")) {
          const name = line.slice(8).trim();
          console.log(skills.readFile(name, "SKILL.md") ?? `(not found: ${name})`);
          continue;
        }
        if (line.startsWith("/recall ")) {
          const q = line.slice(8).trim();
          recallIndex.rebuild();
          const hits = recallIndex.search({ query: q, limit: 5 });
          console.log(
            hits.length > 0
              ? hits.map((h) => `[${h.source}] ${h.sha.slice(0, 8)} ${h.path}: ${h.snippet}`).join("\n")
              : `(no hits for "${q}")`,
          );
          continue;
        }
        if (line.startsWith("/fork ")) {
          const name = line.slice(6).trim();
          const sha = sessions.fork(activeRef, sessionRef(name));
          console.log(`Forked -> ${name} @ ${sha.slice(0, 8)}`);
          continue;
        }
        if (line.startsWith("/switch ")) {
          currentSessionId = line.slice(8).trim();
          activeRef = sessionRef(currentSessionId);
          console.log(`Switched to session ${currentSessionId}`);
          continue;
        }
        if (line.startsWith("/rewind ")) {
          const prefix = line.slice(8).trim();
          const sha = resolvePrefixSha(sessions, activeRef, prefix);
          const rec = sessions.rewind(activeRef, sha, {
            preserveAbandonedAs: `refs/harness/abandoned/${currentSessionId}-${Date.now()}`,
          });
          console.log(`Rewound session + workspace -> ${rec.sha.slice(0, 8)} (${rec.title})`);
          continue;
        }
        if (line === "/compact" || line.startsWith("/compact ")) {
          const focus = line.slice(8).trim() || undefined;
          const anchor = await runtime.compactSession(activeRef, focus);
          console.log(`Compacted -> anchor ${anchor.slice(0, 8)}`);
          continue;
        }

        if (enableStream) process.stdout.write("\n");
        const res = await runtime.runTurn({ sessionRef: activeRef, userInput: line });
        recallIndex.rebuild();
        if (!enableStream && res.assistantText) {
          console.log(`\n${res.assistantText}`);
        }
        console.log(
          `\n[commit ${res.commitSha.slice(0, 8)} | steps=${res.steps} | tools=${res.toolCallsExecuted}]`,
        );
      }
    } finally {
      activeRl = null;
      rl.close();
    }
  } finally {
    for (const client of mcpClients) {
      await client.close();
    }
    recallIndex.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
}
