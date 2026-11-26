import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { formatEvalReport, runP1AblationSuite } from "../src/eval/index.ts";
import { InMemoryObjectStore } from "../src/git-store/index.ts";
import { MemoryStore, RecallIndex } from "../src/memory/index.ts";
import { SubagentOrchestrator } from "../src/orchestrator/index.ts";
import { HarnessRpcServer } from "../src/rpc/index.ts";
import { AgentRuntime, MockModelAdapter } from "../src/runtime/index.ts";
import { SessionStore } from "../src/session/index.ts";

test("P1 Ablation Suite: all 4 rubric benchmarks pass against linear/sliding-window baselines", () => {
  const report = runP1AblationSuite();
  assert.equal(report.passed, true, `\n${formatEvalReport(report)}`);
  assert.equal(report.metrics.length, 4);
  for (const m of report.metrics) {
    assert.equal(m.passed, true, `Metric failed: ${m.id} (${m.harnessValue} vs ${m.target})`);
  }
});

test("HarnessRpcServer: full JSON-RPC 2.0 dispatch (turn, session, memory, recall, subagent) + stdio framing", async () => {
  const mem = new InMemoryObjectStore();
  const sessions = new SessionStore(mem);
  const memory = new MemoryStore(mem);
  const recall = new RecallIndex({ store: mem, sessions, memory });
  const orchestrator = new SubagentOrchestrator({ store: mem, sessions, workspaceRoot: "/mem" });
  const runtime = new AgentRuntime({
    sessions,
    model: new MockModelAdapter("rpc-mock", () => ({
      content: "RPC reply with ERR_RPC_5512",
      toolCalls: [],
    })),
    workspaceRoot: "/mem",
    tools: [],
  });

  const server = new HarnessRpcServer({
    store: mem,
    sessions,
    memory,
    recall,
    runtime,
    orchestrator,
  });

  try {
    // 1. Run turn via JSON-RPC
    const rTurn = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "turn.run",
      params: { session: "demo", input: "Check RPC error" },
    });
    assert.equal(rTurn.error, undefined);
    const turnSha = (rTurn.result as { commitSha: string }).commitSha;
    assert.ok(turnSha);

    // 2. Compact + rebuild recall + search archived turn via JSON-RPC
    const rCompact = await server.handleRequest({
      id: 2,
      method: "turn.compact",
      params: { session: "demo", summary: "Handled RPC check." },
    });
    assert.equal(rCompact.error, undefined);

    await server.handleRequest({ id: 3, method: "recall.rebuild" });
    const rSearch = await server.handleRequest({
      id: 4,
      method: "recall.search",
      params: { query: "ERR_RPC_5512" },
    });
    const hits = rSearch.result as Array<{ sha: string }>;
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.sha, turnSha);

    // 3. Memory propose + promote (blocked secret vs clean)
    await server.handleRequest({
      id: 5,
      method: "memory.propose",
      params: {
        id: "p-clean",
        files: [{ path: "facts/rpc.md", content: "RPC uses NDJSON 2.0." }],
      },
    });
    const rPromote = await server.handleRequest({
      id: 6,
      method: "memory.promote",
      params: { id: "p-clean" },
    });
    assert.equal((rPromote.result as { promoted: boolean }).promoted, true);

    // 4. Unknown method returns standard JSON-RPC -32601
    const rErr = await server.handleRequest({ id: 7, method: "does.not.exist" });
    assert.equal(rErr.error?.code, -32601);

    // 5. Stdio NDJSON framing end-to-end
    const inStream = new PassThrough();
    const outStream = new PassThrough();
    let rawOut = "";
    outStream.on("data", (chunk) => {
      rawOut += chunk.toString("utf8");
    });

    const serveDone = server.serveStdio(inStream, outStream);
    inStream.write(JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "memory.list" }) + "\n");
    inStream.write("{malformed json\n");
    inStream.end();
    await serveDone;

    const lines = rawOut.trim().split("\n").map((l) => JSON.parse(l) as { id: unknown; result?: unknown; error?: { code: number } });
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0]!.result, ["facts/rpc.md"]);
    assert.equal(lines[1]!.error?.code, -32700);
  } finally {
    recall.close();
  }
});
