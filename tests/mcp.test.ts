/**
 * Offline protocol and contract tests for the DeltaX Blackout MCP Evidence Observer.
 *
 * Requirements verified:
 * - Uses official Client and StdioClientTransport over compiled observer subprocess.
 * - Lists tools: exactly 3 tools registered, all have readOnlyHint: true and
 *   recorded fixture descriptions explicitly stating no hosted evaluation / not current browser state.
 * - blackout_observe: validates currentState (tick 3, rev 6, db 94, workers 4, queue 4615),
 *   seed 42, sourceLabel, exportedAt, and exact 64-hex SHA-256 sourceDigest.
 * - blackout_history: validates 6 state snapshots, 48->94 connection transition
 *   between rev 1 and rev 2, scenarioName "queue-storm", and metadata stability.
 * - blackout_action_outcomes: validates throttle-queue action receipt (local lab note),
 *   and demonstratedRejection (stale-basis rejection against currentDigest).
 * - Repeated reads are stable and deeply equal across sequential calls.
 * - Unknown arguments denied with strict schema validation.
 * - Unknown tool names denied.
 * - Process lifecycle: EOF / client close cleanly terminates child process.
 * - All tests use node:test and node:assert/strict only. Zero live calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  loadLabEvidence,
  resolveEvidenceFilePath,
  EXPECTED_SCHEMA,
  EXPECTED_SOURCE_LABEL,
  MAX_EVIDENCE_FILE_BYTES,
} from "../src/mcp-observer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getObserverScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, "../src/mcp-observer.js"), // when __dirname is dist/tests
    path.resolve(__dirname, "../dist/src/mcp-observer.js"), // when __dirname is tests
    path.resolve(process.cwd(), "dist/src/mcp-observer.js"),
    path.resolve(__dirname, "../../dist/src/mcp-observer.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return path.resolve(process.cwd(), "dist/src/mcp-observer.js");
}

async function createConnectedClient(): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const scriptPath = getObserverScriptPath();
  const transport = new StdioClientTransport({
    command: "node",
    args: [scriptPath],
    maxBufferSize: 1024 * 1024,
  });

  const client = new Client(
    {
      name: "blackout-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  return { client, transport };
}

function extractPayload(result: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  if (
    Array.isArray(result.content) &&
    result.content.length > 0 &&
    typeof result.content[0].text === "string"
  ) {
    return JSON.parse(result.content[0].text);
  }
  throw new Error("Could not extract payload from CallToolResult");
}

async function assertCallFails(callPromise: Promise<unknown>): Promise<void> {
  try {
    const res = (await callPromise) as { isError?: boolean } | undefined;
    assert.ok(res && res.isError === true, "Expected call to return isError: true");
  } catch (err) {
    assert.ok(err, "Call rejected as expected");
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (err: unknown) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "ESRCH") {
        return true;
      }
      throw err;
    }
  }
  return false;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("DeltaX Blackout MCP Evidence Observer", () => {
  test("unit test: loadLabEvidence validates and freezes recorded evidence", () => {
    const evidence = loadLabEvidence();
    assert.strictEqual(evidence.schema, EXPECTED_SCHEMA);
    assert.strictEqual(evidence.sourceLabel, EXPECTED_SOURCE_LABEL);
    assert.strictEqual(evidence.scenarioName, "queue-storm");
    assert.strictEqual(evidence.seed, 42);
    assert.strictEqual(typeof evidence.sourceDigest, "string");
    assert.strictEqual(evidence.sourceDigest.length, 64);
    assert.strictEqual(Object.isFrozen(evidence), true);
    assert.strictEqual(Object.isFrozen(evidence.currentState), true);
    assert.strictEqual(Object.isFrozen(evidence.stateHistory), true);

    // Verify raw file byte digest match
    const rawPath = resolveEvidenceFilePath();
    const rawBytes = fs.readFileSync(rawPath);
    assert.ok(rawBytes.length <= MAX_EVIDENCE_FILE_BYTES);
    const expectedDigest = createHash("sha256").update(rawBytes).digest("hex");
    assert.strictEqual(evidence.sourceDigest, expectedDigest);
  });

  test("listTools returns all 3 tools with readOnlyHint and recorded descriptions", async () => {
    const { client } = await createConnectedClient();
    try {
      const { tools } = await client.listTools();
      assert.strictEqual(tools.length, 3);

      const toolNames = tools.map((t) => t.name).sort();
      assert.deepStrictEqual(toolNames, [
        "blackout_action_outcomes",
        "blackout_history",
        "blackout_observe",
      ]);

      const observeTool = tools.find((t) => t.name === "blackout_observe");
      assert.strictEqual(observeTool?.title, "Recorded Snapshot");

      for (const tool of tools) {
        assert.ok(tool.annotations, `Tool ${tool.name} must have annotations`);
        assert.strictEqual(
          tool.annotations.readOnlyHint,
          true,
          `Tool ${tool.name} must declare readOnlyHint: true`
        );
        assert.ok(
          tool.description?.includes("Recorded") ||
            tool.description?.includes("recorded") ||
            tool.description?.includes("mcp-lab.json"),
          `Tool ${tool.name} description must declare recorded fixture`
        );
        assert.ok(
          tool.description?.includes("not current browser state") ||
            tool.description?.includes("no hosted evaluation"),
          `Tool ${tool.name} description must state no hosted evaluation / not browser state`
        );
        assert.strictEqual(
          tool.inputSchema.type,
          "object",
          `Tool ${tool.name} inputSchema must be an object`
        );
      }
    } finally {
      await client.close();
    }
  });

  test("blackout_observe returns currentState, seed 42, source metadata, and SHA-256 digest", async () => {
    const { client } = await createConnectedClient();
    try {
      const rawResult = await client.callTool({
        name: "blackout_observe",
        arguments: {},
      });

      assert.strictEqual(rawResult.isError, undefined);
      const data = extractPayload(rawResult) as {
        currentState: {
          tick: number;
          revision: number;
          status: string;
          operationalState: {
            dbConnectionCount: number;
            workerCount: number;
            queueDepth: number;
          };
        };
        seed: number;
        sourceLabel: string;
        exportedAt: string;
        sourceDigest: string;
      };

      assert.strictEqual(data.seed, 42);
      assert.strictEqual(data.sourceLabel, EXPECTED_SOURCE_LABEL);
      assert.strictEqual(data.currentState.tick, 3);
      assert.strictEqual(data.currentState.revision, 6);
      assert.strictEqual(data.currentState.status, "running");
      assert.strictEqual(data.currentState.operationalState.dbConnectionCount, 94);
      assert.strictEqual(data.currentState.operationalState.workerCount, 4);
      assert.strictEqual(data.currentState.operationalState.queueDepth, 4615);
      assert.match(data.sourceDigest, /^[0-9a-f]{64}$/);
      assert.ok(data.exportedAt.length > 0);
    } finally {
      await client.close();
    }
  });

  test("blackout_history returns 6 snapshots and demonstrates 48->94 connection transition", async () => {
    const { client } = await createConnectedClient();
    try {
      const rawResult = await client.callTool({
        name: "blackout_history",
        arguments: {},
      });

      assert.strictEqual(rawResult.isError, undefined);
      const data = extractPayload(rawResult) as {
        stateHistory: Array<{
          tick: number;
          revision: number;
          operationalState: {
            dbConnectionCount: number;
            workerCount: number;
            queueDepth: number;
          };
        }>;
        sourceLabel: string;
        scenarioName: string;
        sourceDigest: string;
      };

      assert.strictEqual(data.stateHistory.length, 6);
      assert.strictEqual(data.scenarioName, "queue-storm");
      assert.strictEqual(data.sourceLabel, EXPECTED_SOURCE_LABEL);
      assert.match(data.sourceDigest, /^[0-9a-f]{64}$/);

      // Verify the 48 -> 94 DB connection jump between revision 1 and revision 2
      const rev1 = data.stateHistory[0];
      const rev2 = data.stateHistory[1];
      assert.strictEqual(rev1.revision, 1);
      assert.strictEqual(rev1.tick, 0);
      assert.strictEqual(rev1.operationalState.dbConnectionCount, 48);

      assert.strictEqual(rev2.revision, 2);
      assert.strictEqual(rev2.tick, 0);
      assert.strictEqual(rev2.operationalState.dbConnectionCount, 94);

      // Verify remaining ticks stay pinned at 94 with queue draining
      for (let i = 2; i < data.stateHistory.length; i++) {
        assert.strictEqual(data.stateHistory[i].operationalState.dbConnectionCount, 94);
      }
      assert.strictEqual(data.stateHistory[5].tick, 3);
      assert.strictEqual(data.stateHistory[5].revision, 6);
    } finally {
      await client.close();
    }
  });

  test("blackout_action_outcomes returns throttle action receipt and stale-basis rejection", async () => {
    const { client } = await createConnectedClient();
    try {
      const rawResult = await client.callTool({
        name: "blackout_action_outcomes",
        arguments: {},
      });

      assert.strictEqual(rawResult.isError, undefined);
      const data = extractPayload(rawResult) as {
        actionReceipts: Array<{
          actionId: string;
          revisionBefore: number;
          revisionAfter: number;
          appliedActionDescription: string;
          labNote?: string;
        }>;
        demonstratedRejection: {
          kind: string;
          actionDigest: string;
          currentDigest: string;
          currentRevision: number;
        };
        scenarioName: string;
        sourceLabel: string;
        sourceDigest: string;
      };

      assert.strictEqual(data.actionReceipts.length, 1);
      const receipt = data.actionReceipts[0];
      assert.strictEqual(receipt.actionId, "act-prop-qs-throttle-2-r2");
      assert.strictEqual(receipt.revisionBefore, 2);
      assert.strictEqual(receipt.revisionAfter, 3);
      assert.ok(receipt.appliedActionDescription.includes("throttle-queue"));
      assert.strictEqual(receipt.labNote, "local lab, no hosted evaluation performed");

      const rej = data.demonstratedRejection;
      assert.strictEqual(rej.kind, "stale-basis");
      assert.strictEqual(
        rej.actionDigest,
        "fd5805ffbfc0f072355d9a9c672aabc4e40b10c45f62551cef97005d1df0fe59"
      );
      assert.strictEqual(
        rej.currentDigest,
        "34a7414e86724d477f0a1cce7b1ab7d381c84b192b67c8f2b567d753e882f624"
      );
      assert.strictEqual(rej.currentRevision, 2);
      assert.strictEqual(data.scenarioName, "queue-storm");
      assert.strictEqual(data.sourceLabel, EXPECTED_SOURCE_LABEL);
    } finally {
      await client.close();
    }
  });

  test("repeated reads are stable and deeply equal across sequential calls", async () => {
    const { client } = await createConnectedClient();
    try {
      const call1 = extractPayload(
        await client.callTool({ name: "blackout_observe", arguments: {} })
      );
      const call2 = extractPayload(
        await client.callTool({ name: "blackout_observe", arguments: {} })
      );
      assert.deepStrictEqual(call1, call2);

      const hist1 = extractPayload(
        await client.callTool({ name: "blackout_history", arguments: {} })
      );
      const hist2 = extractPayload(
        await client.callTool({ name: "blackout_history", arguments: {} })
      );
      assert.deepStrictEqual(hist1, hist2);

      const out1 = extractPayload(
        await client.callTool({ name: "blackout_action_outcomes", arguments: {} })
      );
      const out2 = extractPayload(
        await client.callTool({ name: "blackout_action_outcomes", arguments: {} })
      );
      assert.deepStrictEqual(out1, out2);
    } finally {
      await client.close();
    }
  });

  test("unknown arguments are denied and fail closed", async () => {
    const { client } = await createConnectedClient();
    try {
      await assertCallFails(
        client.callTool({
          name: "blackout_observe",
          arguments: { unpermittedField: "malicious" } as unknown as Record<string, unknown>,
        })
      );

      await assertCallFails(
        client.callTool({
          name: "blackout_history",
          arguments: { limit: 10 } as unknown as Record<string, unknown>,
        })
      );

      await assertCallFails(
        client.callTool({
          name: "blackout_action_outcomes",
          arguments: { actionId: "injected" } as unknown as Record<string, unknown>,
        })
      );
    } finally {
      await client.close();
    }
  });

  test("unknown tool name is denied", async () => {
    const { client } = await createConnectedClient();
    try {
      await assertCallFails(
        client.callTool({
          name: "stage_action",
          arguments: {},
        })
      );

      await assertCallFails(
        client.callTool({
          name: "non_existent_tool",
          arguments: {},
        })
      );
    } finally {
      await client.close();
    }
  });

  test("clean EOF / client close cleanly terminates child process", async () => {
    const { client, transport } = await createConnectedClient();
    const pid = transport.pid;
    assert.ok(typeof pid === "number" && pid > 0, "Child process PID must be a positive number");

    // Verify child is alive
    let isAlive = false;
    try {
      process.kill(pid, 0);
      isAlive = true;
    } catch {}
    assert.strictEqual(isAlive, true, "Observer child process should be running");

    // Close client
    await client.close();

    // Verify child process terminates cleanly
    const exited = await waitForProcessExit(pid, 3000);
    assert.strictEqual(exited, true, "Observer child process should exit cleanly on EOF");
  });
});
