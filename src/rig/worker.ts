/**
 * worker.ts — Child worker module for the M4 Process Rig.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md §1, §6, §7):
 * - Project-owned Node child worker processes (known compiled module only via fork).
 * - Scrub inherited credential env and accept only fixed structured IPC jobs.
 * - Same-user process separation is NOT adversarial sandboxing.
 * - Manages exactly 3 SQLite handles.
 * - Performs bounded SHA-256 hash computation and SELECT 1 on a managed SQLite handle.
 * - Fixed worker code hashes arbitrary bounded DATA; no eval, shell, or file paths from payload.
 * - Acknowledges exact assigned job ID and reports matching owned PID via IPC.
 * - IPC-controlled pause and resume before dispatch.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { ParentToWorkerIpcMessage, WorkerToParentIpcMessage } from "./types.js";

// Scrub inherited credential environment immediately on process start.
const ALLOWED_ENV_VARS = new Set([
  "NODE_ENV",
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
]);

for (const key of Object.keys(process.env)) {
  if (!ALLOWED_ENV_VARS.has(key)) {
    delete process.env[key];
  }
}

let workerId = "unknown";
let isPaused = true;
const handles: DatabaseSync[] = [];

function openWorkerHandles(): void {
  // Each worker maintains exactly 3 managed SQLite handles.
  while (handles.length < 3) {
    handles.push(new DatabaseSync(":memory:"));
  }
}

function closeWorkerHandles(): void {
  while (handles.length > 0) {
    const h = handles.pop();
    try {
      h?.close();
    } catch {
      // Ignored on teardown
    }
  }
}

process.on("error", () => {
  // Suppress unhandled errors on child IPC stream
});

function sendToParent(msg: WorkerToParentIpcMessage): void {
  if (process.send && process.connected) {
    try {
      process.send(msg, (_err) => {
        // Callback suppresses unhandled write EPIPE if parent disconnected
      });
    } catch {}
  }
}

function computeBoundedHash(payload: string, rounds: number): string {
  // Bounded cryptographic hash computation over arbitrary input data
  const clampedRounds = Math.max(1, Math.min(rounds || 50, 1000));
  let hash = createHash("sha256").update(payload, "utf8").digest("hex");
  for (let r = 1; r < clampedRounds; r++) {
    hash = createHash("sha256").update(hash, "utf8").digest("hex");
  }
  return hash;
}

process.on("message", (rawMsg: unknown) => {
  if (!rawMsg || typeof rawMsg !== "object") {
    return;
  }

  const msg = rawMsg as ParentToWorkerIpcMessage;

  switch (msg.type) {
    case "INIT": {
      workerId = String(msg.workerId || "worker-1");
      openWorkerHandles();
      sendToParent({
        type: "READY",
        workerId,
        pid: process.pid,
        handles: handles.length,
      });
      break;
    }

    case "PAUSE": {
      isPaused = true;
      sendToParent({ type: "PAUSED", workerId });
      break;
    }

    case "RESUME": {
      isPaused = false;
      sendToParent({ type: "RESUMED", workerId });
      break;
    }

    case "JOB": {
      if (isPaused) {
        sendToParent({
          type: "ERROR",
          jobId: msg.jobId,
          error: "Worker is currently paused",
          workerPid: process.pid,
        });
        return;
      }

      try {
        // 1. Execute SELECT 1 on managed SQLite handle
        if (handles.length > 0) {
          const stmt = handles[0].prepare("SELECT 1 AS ok;");
          stmt.get();
        }

        // 2. Perform bounded hash computation over arbitrary input data
        const resultHash = computeBoundedHash(msg.payload, msg.hashRounds);

        // 3. Acknowledge exact assigned job ID with owned PID
        sendToParent({
          type: "ACK",
          jobId: msg.jobId,
          resultHash,
          workerPid: process.pid,
        });
      } catch (err) {
        const errorDetail = err instanceof Error ? err.message : String(err);
        sendToParent({
          type: "ERROR",
          jobId: msg.jobId,
          error: errorDetail,
          workerPid: process.pid,
        });
      }
      break;
    }

    case "SHUTDOWN": {
      closeWorkerHandles();
      process.exit(0);
      break;
    }

    default: {
      // Discard unrecognized messages without execution
      break;
    }
  }
});

process.on("disconnect", () => {
  closeWorkerHandles();
  process.exit(0);
});

process.on("uncaughtException", () => {
  closeWorkerHandles();
  process.exit(1);
});
