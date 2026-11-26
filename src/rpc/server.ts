import readline from "node:readline";
import type { ObjectStore, Sha } from "../git-store/types.ts";
import {
  MemoryStore,
  RecallIndex,
  noSecretsGate,
  nonAbandonedSourceGate,
} from "../memory/index.ts";
import {
  SubagentOrchestrator,
  type IntegrateMode,
  type SubagentHandle,
} from "../orchestrator/index.ts";
import type { AgentRuntime } from "../runtime/agent-loop.ts";
import { SESSION_REF_PREFIX, SessionStore, sessionRef } from "../session/session-store.ts";

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface HarnessRpcServerOptions {
  store: ObjectStore;
  sessions: SessionStore;
  memory?: MemoryStore;
  recall?: RecallIndex;
  runtime?: AgentRuntime;
  orchestrator?: SubagentOrchestrator;
}

/**
 * Layer 5 (`rpc`) — Thin, Codex-App-Server-inspired JSON-RPC 2.0 dispatcher
 * exposing `git-harness` primitives uniformly across CLI, IDE, Web UI, and eval runners.
 */
export class HarnessRpcServer {
  private readonly store: ObjectStore;
  private readonly sessions: SessionStore;
  private readonly memory: MemoryStore;
  private readonly recall: RecallIndex;
  private readonly runtime?: AgentRuntime;
  private readonly orchestrator?: SubagentOrchestrator;
  private readonly activeSubagents = new Map<string, SubagentHandle>();

  constructor(options: HarnessRpcServerOptions) {
    this.store = options.store;
    this.sessions = options.sessions;
    this.memory = options.memory ?? new MemoryStore(options.store);
    this.recall = options.recall ?? new RecallIndex({ store: options.store, sessions: options.sessions, memory: this.memory });
    this.runtime = options.runtime;
    this.orchestrator = options.orchestrator;
  }

  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    const params = req.params ?? {};

    try {
      const result = await this.dispatch(req.method, params);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.startsWith("Method not found:") ? -32601 : -32000;
      return { jsonrpc: "2.0", id, error: { code, message: msg } };
    }
  }

  /** Serve newline-delimited JSON-RPC 2.0 over stdin/stdout (ordered, backpressure-safe). */
  async serveStdio(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcRequest;
      } catch (err) {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
        };
        output.write(JSON.stringify(resp) + "\n");
        continue;
      }
      const resp = await this.handleRequest(parsed);
      output.write(JSON.stringify(resp) + "\n");
    }
  }

  private resolveSessionRef(params: Record<string, unknown>, key = "session"): string {
    const raw = String(params[key] ?? "default");
    return raw.startsWith("refs/") ? raw : sessionRef(raw);
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "session.list":
        return this.sessions.listSessions(SESSION_REF_PREFIX);

      case "session.log": {
        const ref = this.resolveSessionRef(params);
        const limit = params.limit ? Number(params.limit) : 50;
        return this.sessions.logFirstParent(ref, limit);
      }

      case "session.project": {
        const ref = this.resolveSessionRef(params);
        const systemPrompt = params.systemPrompt ? String(params.systemPrompt) : undefined;
        return this.sessions.project(ref, { systemPrompt });
      }

      case "session.fork": {
        const from = this.resolveSessionRef(params, "from");
        const to = this.resolveSessionRef(params, "to");
        return { sha: this.sessions.fork(from, to), ref: to };
      }

      case "session.rewind": {
        const ref = this.resolveSessionRef(params);
        const targetSha = String(params.targetSha ?? "");
        if (!targetSha) throw new Error("session.rewind requires params.targetSha");
        const restoreWorkspace = params.restoreWorkspace !== false;
        const preserveAbandonedAs = params.preserveAbandonedAs
          ? String(params.preserveAbandonedAs)
          : undefined;
        return this.sessions.rewind(ref, targetSha, { restoreWorkspace, preserveAbandonedAs });
      }

      case "turn.run": {
        if (!this.runtime) throw new Error("turn.run unavailable: no ModelAdapter/AgentRuntime configured");
        const ref = this.resolveSessionRef(params);
        const userInput = String(params.input ?? "");
        if (!userInput) throw new Error("turn.run requires params.input");
        return this.runtime.runTurn({
          sessionRef: ref,
          userInput,
          maxSteps: params.maxSteps ? Number(params.maxSteps) : undefined,
        });
      }

      case "turn.compact": {
        const ref = this.resolveSessionRef(params);
        if (params.summary) {
          const anchorSha = this.sessions.compact({
            sessionRef: ref,
            summary: String(params.summary),
          });
          return { anchorSha };
        }
        if (!this.runtime) throw new Error("turn.compact without params.summary requires AgentRuntime");
        const focus = params.focus ? String(params.focus) : undefined;
        const anchorSha = await this.runtime.compactSession(ref, focus);
        return { anchorSha };
      }

      case "memory.list":
        return this.memory.list(params.prefix ? String(params.prefix) : "");

      case "memory.read": {
        const filePath = String(params.path ?? "");
        if (!filePath) throw new Error("memory.read requires params.path");
        return { path: filePath, content: this.memory.read(filePath) };
      }

      case "memory.put": {
        const files = params.files as Array<{ path: string; content: string }> | undefined;
        if (!Array.isArray(files)) throw new Error("memory.put requires params.files[]");
        const message = String(params.message ?? "rpc memory update");
        const sha = this.memory.put({ files, message });
        return { sha };
      }

      case "memory.propose": {
        const id = String(params.id ?? `prop-${Date.now()}`);
        const files = params.files as Array<{ path: string; content: string }> | undefined;
        if (!Array.isArray(files)) throw new Error("memory.propose requires params.files[]");
        return this.memory.propose(id, {
          files,
          message: String(params.message ?? "memory proposal"),
          sourceRef: params.sourceRef ? String(params.sourceRef) : undefined,
          sourceSha: params.sourceSha ? (String(params.sourceSha) as Sha) : undefined,
        });
      }

      case "memory.promote": {
        const id = String(params.id ?? "");
        if (!id) throw new Error("memory.promote requires params.id");
        return this.memory.promote(id, [noSecretsGate(), nonAbandonedSourceGate(this.store)]);
      }

      case "memory.reject": {
        const id = String(params.id ?? "");
        if (!id) throw new Error("memory.reject requires params.id");
        this.memory.reject(id);
        return { rejected: true, id };
      }

      case "recall.rebuild":
        return this.recall.rebuild();

      case "recall.search": {
        const query = String(params.query ?? "");
        if (!query) throw new Error("recall.search requires params.query");
        return this.recall.search({
          query,
          source:
            params.source === "session" || params.source === "memory" ? params.source : undefined,
          limit: params.limit ? Number(params.limit) : 5,
        });
      }

      case "subagent.spawn": {
        if (!this.orchestrator) throw new Error("subagent.spawn unavailable: no orchestrator configured");
        const agentId = String(params.agentId ?? `agent-${Date.now()}`);
        const parentSessionRef = this.resolveSessionRef(params, "parentSession");
        const handle = this.orchestrator.spawn({
          agentId,
          parentSessionRef,
          contextMode: params.contextMode === "orphan" ? "orphan" : "fork",
          isolateWorkspace: Boolean(params.isolateWorkspace ?? false),
        });
        this.activeSubagents.set(agentId, handle);
        return handle;
      }

      case "subagent.diff": {
        if (!this.orchestrator) throw new Error("subagent.diff unavailable: no orchestrator configured");
        const agentId = String(params.agentId ?? "");
        const handle = this.activeSubagents.get(agentId);
        if (!handle) throw new Error(`Unknown active subagent: ${agentId}`);
        return this.orchestrator.diffHandle(handle);
      }

      case "subagent.integrate": {
        if (!this.orchestrator) throw new Error("subagent.integrate unavailable: no orchestrator configured");
        const agentId = String(params.agentId ?? "");
        const handle = this.activeSubagents.get(agentId);
        if (!handle) throw new Error(`Unknown active subagent: ${agentId}`);
        const mode = (params.mode ?? "squash") as IntegrateMode;
        const res = await this.orchestrator.integrate(handle, {
          mode,
          summary: params.summary ? String(params.summary) : undefined,
          commitSha: params.commitSha ? String(params.commitSha) : undefined,
        });
        if (res.integrated || mode === "drop") {
          this.activeSubagents.delete(agentId);
        }
        return res;
      }

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }
}
