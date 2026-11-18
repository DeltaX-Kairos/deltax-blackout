/**
 * Read-only Kiro evidence observer for DeltaX Blackout.
 *
 * Implements a stdio-only MCP server exposing recorded recovery evidence
 * from docs/evidence/mcp-lab.json as defined in docs/MCP-BUILD-012.md.
 *
 * Constraints & Guarantees:
 * - Read-only: strictly exposes static recorded evidence; no evaluation, no state mutation.
 * - Stdio-only: stdout is reserved strictly for JSON-RPC protocol transport; errors go to stderr.
 * - Single fixed fixture: resolved from compiled __dirname, bounded to <= 256 KiB.
 * - SHA-256 byte digest computed and stamped across all tool outputs.
 * - Strict empty input schemas for all tools; unauthorized args/tools rejected.
 * - stdio buffer size bounded to <= 1 MiB.
 * - Clean EOF shutdown on stdin close.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// ─── Constants & Limits ────────────────────────────────────────────────────────

export const MAX_EVIDENCE_FILE_BYTES = 256 * 1024; // 256 KiB
export const MAX_STDIO_BUFFER_BYTES = 1024 * 1024; // 1 MiB
export const EXPECTED_SCHEMA = "blackout-recorded-model-evidence-v1";
export const EXPECTED_SOURCE_LABEL =
  "recorded deterministic model fixture; no hosted evaluation; not current browser state";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface OperationalState {
  kind: string;
  arrivalRatePerTick: number;
  queueDepth: number;
  workerCount: number;
  ingestionRateCap: number | null;
  errorRate: number;
  dbConnectionCount: number;
}

export interface ScenarioStateSnapshot {
  scenarioId: string;
  tick: number;
  revision: number;
  status: string;
  operationalState: OperationalState;
  tickLimit: number;
  basisDigest: string;
}

export interface ActionReceipt {
  actionId: string;
  revisionBefore: number;
  digestBefore: string;
  appliedActionDescription: string;
  revisionAfter: number;
  digestAfter: string;
  predictedEffects?: Record<string, unknown>;
  observedEffects?: Record<string, unknown>;
  labNote?: string;
}

export interface DemonstratedRejection {
  kind: string;
  actionDigest: string;
  currentDigest: string;
  currentRevision: number;
}

export interface McpLabEvidence {
  schema: string;
  sourceLabel: string;
  scenarioName: string;
  seed: number;
  exportedAt: string;
  currentState: ScenarioStateSnapshot;
  stateHistory: ScenarioStateSnapshot[];
  actionReceipts: ActionReceipt[];
  demonstratedRejection: DemonstratedRejection;
  sourceDigest: string;
}

// ─── Evidence Loader ───────────────────────────────────────────────────────────

/**
 * Resolves the fixed evidence file path from compiled __dirname.
 * Never accepts caller path, environment variable, or URL override.
 */
export function resolveEvidenceFilePath(): string {
  // Compiled output: dist/src/mcp-observer.js -> ../../docs/evidence/mcp-lab.json
  const distCandidate = path.resolve(__dirname, "../../docs/evidence/mcp-lab.json");
  if (fs.existsSync(distCandidate)) {
    return distCandidate;
  }
  // Uncompiled ts-node execution: src/mcp-observer.ts -> ../docs/evidence/mcp-lab.json
  const srcCandidate = path.resolve(__dirname, "../docs/evidence/mcp-lab.json");
  if (fs.existsSync(srcCandidate)) {
    return srcCandidate;
  }
  // Default to standard compiled relative path
  return distCandidate;
}

/**
 * Recursively deep-freezes an object structure to prevent runtime tampering.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Sanitizes an error message for safe stderr output without multiline or control chars.
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.replace(/[\r\n\t]+/g, " ").trim();
  }
  return String(err).replace(/[\r\n\t]+/g, " ").trim();
}

/**
 * Reads, verifies, digests, and freezes the evidence fixture once at initialization.
 */
export function loadLabEvidence(overridePath?: string): Readonly<McpLabEvidence> {
  const filePath = overridePath ?? resolveEvidenceFilePath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Evidence file not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`Evidence file size ${stat.size} exceeds maximum ${MAX_EVIDENCE_FILE_BYTES} bytes`);
  }

  const rawBytes = fs.readFileSync(filePath);
  if (rawBytes.length > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`Evidence byte count ${rawBytes.length} exceeds maximum ${MAX_EVIDENCE_FILE_BYTES} bytes`);
  }

  const sourceDigest = createHash("sha256").update(rawBytes).digest("hex");
  const parsed = JSON.parse(rawBytes.toString("utf-8"));

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Evidence file is not a valid JSON object");
  }
  if (parsed.schema !== EXPECTED_SCHEMA) {
    throw new Error(`Invalid schema: expected '${EXPECTED_SCHEMA}', got '${parsed.schema}'`);
  }
  if (parsed.sourceLabel !== EXPECTED_SOURCE_LABEL) {
    throw new Error(`Invalid sourceLabel: expected '${EXPECTED_SOURCE_LABEL}', got '${parsed.sourceLabel}'`);
  }
  if (typeof parsed.scenarioName !== "string" || !parsed.scenarioName.trim()) {
    throw new Error("Evidence file missing or invalid scenarioName");
  }
  if (
    typeof parsed.seed !== "number" ||
    !Number.isInteger(parsed.seed) ||
    !Number.isFinite(parsed.seed)
  ) {
    throw new Error(`Evidence file missing or invalid seed: expected finite integer, got '${parsed.seed}'`);
  }
  if (
    typeof parsed.exportedAt !== "string" ||
    !parsed.exportedAt.trim() ||
    Number.isNaN(Date.parse(parsed.exportedAt))
  ) {
    throw new Error(`Evidence file missing or invalid exportedAt: expected valid ISO timestamp string, got '${parsed.exportedAt}'`);
  }
  if (!parsed.currentState || typeof parsed.currentState !== "object") {
    throw new Error("Evidence file missing currentState");
  }
  if (!Array.isArray(parsed.stateHistory)) {
    throw new Error("Evidence file missing stateHistory array");
  }
  if (!Array.isArray(parsed.actionReceipts)) {
    throw new Error("Evidence file missing actionReceipts array");
  }
  if (!parsed.demonstratedRejection || typeof parsed.demonstratedRejection !== "object") {
    throw new Error("Evidence file missing demonstratedRejection");
  }

  // Strictly curate top-level fields; do not dump unvalidated arbitrary fields
  const curated: McpLabEvidence = {
    schema: parsed.schema,
    sourceLabel: parsed.sourceLabel,
    scenarioName: parsed.scenarioName,
    seed: parsed.seed,
    exportedAt: parsed.exportedAt,
    currentState: JSON.parse(JSON.stringify(parsed.currentState)),
    stateHistory: JSON.parse(JSON.stringify(parsed.stateHistory)),
    actionReceipts: JSON.parse(JSON.stringify(parsed.actionReceipts)),
    demonstratedRejection: JSON.parse(JSON.stringify(parsed.demonstratedRejection)),
    sourceDigest,
  };

  return deepFreeze(curated);
}

// ─── Server Factory ────────────────────────────────────────────────────────────

/**
 * Creates and configures the read-only McpServer instance with the 3 required tools.
 */
export function createObserverServer(evidence?: Readonly<McpLabEvidence>): McpServer {
  const labEvidence = evidence ?? loadLabEvidence();

  const server = new McpServer(
    {
      name: "blackout-observer",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool 1: blackout_observe
  server.registerTool(
    "blackout_observe",
    {
      title: "Recorded Snapshot",
      description:
        "Returns the recorded current scenario state from the fixed offline fixture (docs/evidence/mcp-lab.json). Recorded deterministic model fixture; no hosted evaluation; not current browser state.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const payload = {
        currentState: labEvidence.currentState,
        seed: labEvidence.seed,
        sourceLabel: labEvidence.sourceLabel,
        exportedAt: labEvidence.exportedAt,
        sourceDigest: labEvidence.sourceDigest,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
      };
    }
  );

  // Tool 2: blackout_history
  server.registerTool(
    "blackout_history",
    {
      title: "Blackout State History",
      description:
        "Returns recorded bounded state history from the fixed offline fixture (docs/evidence/mcp-lab.json). Recorded deterministic model fixture; no hosted evaluation; not current browser state.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const payload = {
        stateHistory: labEvidence.stateHistory,
        sourceLabel: labEvidence.sourceLabel,
        exportedAt: labEvidence.exportedAt,
        sourceDigest: labEvidence.sourceDigest,
        scenarioName: labEvidence.scenarioName,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
      };
    }
  );

  // Tool 3: blackout_action_outcomes
  server.registerTool(
    "blackout_action_outcomes",
    {
      title: "Blackout Action Outcomes and Rejections",
      description:
        "Returns recorded action receipts and demonstrated rejections from the fixed offline fixture (docs/evidence/mcp-lab.json). Recorded deterministic model fixture; no hosted evaluation; not current browser state.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const payload = {
        actionReceipts: labEvidence.actionReceipts,
        demonstratedRejection: labEvidence.demonstratedRejection,
        sourceLabel: labEvidence.sourceLabel,
        exportedAt: labEvidence.exportedAt,
        sourceDigest: labEvidence.sourceDigest,
        scenarioName: labEvidence.scenarioName,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
      };
    }
  );

  return server;
}

// ─── Entry Point ───────────────────────────────────────────────────────────────

/**
 * Starts the stdio MCP observer server.
 */
export function startObserverServer(): void {
  try {
    const evidence = loadLabEvidence();
    const server = createObserverServer(evidence);

    const transport = new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: MAX_STDIO_BUFFER_BYTES,
    });

    transport.onclose = () => {
      process.exit(0);
    };

    process.stdin.on("end", () => {
      process.exit(0);
    });

    process.stdin.on("close", () => {
      process.exit(0);
    });

    serveStdio(() => server, {
      transport,
      legacy: "serve",
      onerror: (err) => {
        process.stderr.write(`[blackout-observer] Transport error: ${sanitizeErrorMessage(err)}\n`);
      },
    });
  } catch (error) {
    const msg = sanitizeErrorMessage(error);
    process.stderr.write(`[blackout-observer] Fatal startup failure: ${msg}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  startObserverServer();
}
