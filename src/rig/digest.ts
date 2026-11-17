/**
 * digest.ts — Canonical JSON serialisation and SHA-256 basis / payload digests
 * for the M4 Process Rig.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md §4):
 * - Material projection binds actual material state:
 *   - Queue job identity, status, resultHash
 *   - Worker identity, live, paused, active-job
 *   - Managed handles and ingestion state
 * - Same counts with different jobs/workers is a distinct basis.
 * - Deterministic lexicographical key sorting and SHA-256 lowercase hex output.
 */

import { createHash } from "node:crypto";

export interface QueueJobSummary {
  id: string;
  status: string;
  payloadHash: string;
  resultHash: string | null;
}

export interface WorkerSummary {
  workerId: string;
  pid: number;
  live: boolean;
  paused: boolean;
  activeJobId: string | null;
}

export interface RigBasisProjection {
  ownerId: string;
  workers: WorkerSummary[];
  queueJobs: QueueJobSummary[];
  queueBacklog: number;
  queueCompleted: number;
  queueFailed: number;
  queueUnknown: number;
  managedSqliteHandles: number;
  maxDbHandleBudget: number;
  ingestionCapped: boolean;
  pressureInjected: boolean;
}

export interface RigPayloadProjection {
  actionType: string;
  parameters: Record<string, number | string | boolean | null>;
  basisRevision: number;
  basisDigest: string;
}

/**
 * Produce a canonical JSON string: UTF-8, keys sorted lexicographically,
 * no insignificant whitespace, deterministic across platforms.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJson(value));
}

function sortedJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortedJson);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortedJson(obj[key]);
  }
  return sorted;
}

/**
 * Compute SHA-256 hex digest over canonical JSON.
 */
export function computeDigest(value: unknown): string {
  const json = canonicalJson(value);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Compute the basis digest from a material projection of the rig state.
 */
export function computeRigBasisDigest(projection: RigBasisProjection): string {
  return computeDigest(projection);
}

/**
 * Compute the payload digest used to bind a staged action to its confirmed parameters.
 */
export function computeRigPayloadDigest(projection: RigPayloadProjection): string {
  return computeDigest(projection);
}
