import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryObjectStore } from "../src/git-store/index.ts";
import { McpStdioClient, loadMcpTools } from "../src/mcp/index.ts";
import { AgentRuntime, MockModelAdapter, createCoreTools } from "../src/runtime/index.ts";
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  createOsSandboxExecutor,
  detectAvailableSandbox,
} from "../src/sandbox/index.ts";
import { SessionStore, sessionRef } from "../src/session/index.ts";

const MOCK_MCP_SERVER_SCRIPT = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo_upper",
            description: "Uppercase the provided text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "Text to uppercase" } },
              required: ["text"],
            },
          },
          {
            name: "fail_tool",
            description: "Always returns an MCP tool error",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo_upper") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: String(args.text ?? "").toUpperCase() }] },
      }) + "\\n");
      return;
    }
    if (name === "fail_tool") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "boom from mcp" }], isError: true },
      }) + "\\n");
      return;
    }
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: "Method not found" },
  }) + "\\n");
});
`;

test("MCP client: spawns stdio server, discovers tools, executes inside AgentRuntime, and handles errors", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-mcp-"));
  const serverPath = path.join(tmpDir, "mock-mcp.mjs");
  fs.writeFileSync(serverPath, MOCK_MCP_SERVER_SCRIPT, "utf8");

  const client = new McpStdioClient({
    command: process.execPath,
    args: [serverPath],
    cwd: tmpDir,
  });

  try {
    const init = await client.connect();
    assert.equal(init.serverInfo?.name, "mock-mcp");

    const mcpTools = await loadMcpTools(client, { prefix: "mcp_", readOnlyTools: ["echo_upper"] });
    assert.deepEqual(
      mcpTools.map((t) => t.schema.name),
      ["mcp_echo_upper", "mcp_fail_tool"],
    );
    assert.equal(mcpTools[0]!.readOnly, true);

    const mem = new InMemoryObjectStore();
    const sessions = new SessionStore(mem);
    const ref = sessionRef("mcp-rt");

    let seenOutputs: string[] = [];
    const model = new MockModelAdapter("mcp-mock", (req, step) => {
      if (step === 0) {
        return {
          content: "Calling MCP tools",
          toolCalls: [
            { id: "m1", name: "mcp_echo_upper", arguments: JSON.stringify({ text: "hello mcp" }) },
            { id: "m2", name: "mcp_fail_tool", arguments: JSON.stringify({}) },
          ],
        };
      }
      seenOutputs = req.messages.filter((m) => m.role === "tool").map((m) => m.content);
      return { content: "MCP tools finished.", toolCalls: [] };
    });

    const runtime = new AgentRuntime({
      sessions,
      model,
      workspaceRoot: tmpDir,
      tools: mcpTools,
    });

    const res = await runtime.runTurn({ sessionRef: ref, userInput: "Run MCP tools" });
    assert.equal(res.toolCallsExecuted, 2);
    assert.deepEqual(seenOutputs, ["HELLO MCP", "boom from mcp"]);
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OS Sandbox: Seatbelt profile & bwrap arg builders + fail-closed when unavailable", () => {
  const sbpl = buildSeatbeltProfile({
    writablePaths: ["/workspace/proj"],
    allowNetwork: false,
  });
  assert.match(sbpl, /\(deny file-write\*\)/);
  assert.match(sbpl, /\(allow file-write\* \(subpath "\/workspace\/proj"\)\)/);
  assert.match(sbpl, /\(deny network\*\)/);

  const bwrap = buildBwrapArgs({
    workspaceRoot: "/workspace/proj",
    cwd: "/workspace/proj",
    extraWritablePaths: ["/tmp/cache"],
    allowNetwork: false,
    shellBin: "/bin/bash",
    command: "echo ok",
  });
  assert.ok(bwrap.includes("--ro-bind"));
  assert.ok(bwrap.includes("--unshare-net"));
  assert.ok(bwrap.includes("/tmp/cache"));

  assert.throws(
    () =>
      createOsSandboxExecutor({
        workspaceRoot: "/tmp",
        backend: "none" as unknown as "auto",
        required: true,
      }),
    /No OS sandbox backend available/,
  );
});

test("OS Sandbox live: restricts bash writes strictly to workspaceRoot (blocks sibling dir writes)", async () => {
  const backend = detectAvailableSandbox();
  if (backend === "none") {
    return; // Skip live kernel test only on unsupported platforms
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-harness-sb-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);

  try {
    const execCommand = createOsSandboxExecutor({
      workspaceRoot: workspace,
      allowNetwork: false,
    });
    const tools = createCoreTools({ execCommand });
    const bash = tools.find((t) => t.schema.name === "bash")!;

    // 1. Write inside workspace MUST succeed
    const okRes = await bash.execute(
      { command: "printf 'allowed\\n' > inside.txt && cat inside.txt" },
      { workspaceRoot: workspace, sessionRef: "sb" },
    );
    assert.equal(okRes.isError, undefined);
    assert.match(okRes.output, /allowed/);
    assert.equal(fs.readFileSync(path.join(workspace, "inside.txt"), "utf8"), "allowed\n");

    // 2. Write outside workspace (even via bash redirect) MUST be blocked by OS kernel!
    const escapedPath = path.join(outside, "pwned.txt");
    const blockedRes = await bash.execute(
      { command: `printf 'nope\\n' > "${escapedPath}"` },
      { workspaceRoot: workspace, sessionRef: "sb" },
    );
    assert.equal(blockedRes.isError, true, `Expected kernel sandbox to block write outside workspace, got: ${blockedRes.output}`);
    assert.equal(fs.existsSync(escapedPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
