import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { JsonSchemaProperty, Tool, ToolResult } from "../runtime/types.ts";

export interface McpStdioClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout in ms (default: 30000). */
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

export interface McpToolCallResponse {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "resource"; resource?: { uri?: string; text?: string } }
    | Record<string, unknown>
  >;
  isError?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Thin, zero-dependency Model Context Protocol (MCP) JSON-RPC 2.0 stdio client.
 * Lives cleanly outside the core runtime; discovered MCP tools plug in as standard Layer 2 `Tool`s.
 */
export class McpStdioClient {
  private readonly options: McpStdioClientOptions;
  private readonly timeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrTail: string[] = [];
  private connected = false;

  constructor(options: McpStdioClientOptions) {
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /** Spawn the MCP server process and complete the MCP `initialize` handshake. */
  async connect(): Promise<{ serverInfo?: { name?: string; version?: string }; protocolVersion?: string }> {
    if (this.connected && this.child) return {};

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        }
      }
    });

    child.on("error", (err) => {
      this.rejectAll(new Error(`MCP server process error: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      this.connected = false;
      const tail = this.stderrTail.length > 0 ? `\nstderr:\n${this.stderrTail.join("\n")}` : "";
      this.rejectAll(
        new Error(`MCP server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})${tail}`),
      );
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl = rl;
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
      try {
        msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { code?: number; message?: string } };
      } catch {
        return;
      }
      if (msg.id === undefined) return; // server notification
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`MCP error (${msg.error.code ?? -1}): ${msg.error.message ?? "unknown"}`));
      } else {
        entry.resolve(msg.result);
      }
    });

    const initResult = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: this.options.clientName ?? "git-harness",
        version: this.options.clientVersion ?? "0.5.0",
      },
    })) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };

    this.notify("notifications/initialized");
    this.connected = true;
    return initResult ?? {};
  }

  /** Fetch all tools exposed by the MCP server (following pagination cursors if present). */
  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.connected) await this.connect();
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const res = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpToolDefinition[];
        nextCursor?: string;
      };
      if (Array.isArray(res?.tools)) {
        tools.push(...res.tools);
      }
      cursor = res?.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Invoke a named MCP tool with JSON arguments. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.connected) await this.connect();
    const res = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as McpToolCallResponse;

    const parts: string[] = [];
    for (const block of res?.content ?? []) {
      if (block && typeof block === "object") {
        if ("type" in block && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (
          "type" in block &&
          block.type === "resource" &&
          "resource" in block &&
          block.resource &&
          typeof block.resource === "object"
        ) {
          const r = block.resource as { uri?: string; text?: string };
          parts.push(r.text ?? `[resource: ${r.uri ?? "unknown"}]`);
        } else {
          parts.push(JSON.stringify(block));
        }
      }
    }

    return {
      output: parts.join("\n") || "(empty MCP response)",
      isError: Boolean(res?.isError),
    };
  }

  /** Cleanly shut down the child MCP server process and reject any in-flight requests. */
  async close(): Promise<void> {
    this.connected = false;
    this.rejectAll(new Error("MCP client closed"));
    this.rl?.close();
    this.rl = null;
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    }
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child) throw new Error("MCP client is not started");
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error("MCP client is not started"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

export interface LoadMcpToolsOptions {
  /** Optional prefix prepended to exposed tool names (e.g. `"gh_"`). */
  prefix?: string;
  /** Optional tool names known to be pure read-only (enables parallel execution & snapshot skipping). */
  readOnlyTools?: string[];
}

/**
 * Discover tools from a connected `McpStdioClient` and adapt them to standard Layer 2 `Tool`s.
 */
export async function loadMcpTools(
  client: McpStdioClient,
  options?: LoadMcpToolsOptions,
): Promise<Tool[]> {
  const defs = await client.listTools();
  const prefix = options?.prefix ?? "";
  const readOnlySet = new Set(options?.readOnlyTools ?? []);

  return defs.map((def) => {
    const properties: Record<string, JsonSchemaProperty> = {};
    for (const [k, v] of Object.entries(def.inputSchema?.properties ?? {})) {
      properties[k] = {
        type: typeof v?.type === "string" ? v.type : "string",
        description: typeof v?.description === "string" ? v.description : undefined,
      };
    }

    const exposedName = `${prefix}${def.name}`;
    const isReadOnly = readOnlySet.has(def.name) || readOnlySet.has(exposedName);

    return {
      readOnly: isReadOnly || undefined,
      schema: {
        name: exposedName,
        description: def.description ?? `MCP tool ${def.name}`,
        parameters: {
          type: "object",
          properties,
          required: def.inputSchema?.required,
        },
      },
      async execute(args): Promise<ToolResult> {
        try {
          return await client.callTool(def.name, args);
        } catch (err) {
          return {
            output: `MCP tool '${def.name}' error: ${(err as Error).message}`,
            isError: true,
          };
        }
      },
    };
  });
}
