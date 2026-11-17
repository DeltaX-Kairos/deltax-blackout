/**
 * types.ts — Definitions, interfaces, and constants for the M4 Process Rig.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md):
 * - Explicit lifecycle: created, starting, running, closing, closed, expired.
 * - Hard caps: 1 global rig, 4 workers, 64 jobs/run, 120s max lifetime.
 * - 100-handle managed SQLite budget.
 * - Initial state: 1 paused worker, 48 managed SQLite handles (45 parent + 3 worker).
 *   Parent total 45 includes 1 queue handle + 44 pool handles.
 * - Pressure injection: reserves handles to 94 (91 parent + 3 worker).
 *   Parent total 91 includes 1 queue handle + 90 pool handles.
 * - Scale 1 -> 4 (+3 workers = +9 handles):
 *     Before pressure: 48 + 9 = 57/100 (feasible).
 *     After pressure: 94 + 9 = 103/100 (must reject).
 * - Resume existing worker: stays at 94/100 (feasible) and drains queue.
 * - Immutable snapshot revision, canonical basisDigest, and executable payloadDigest.
 * - Explicit labels distinguishing measured process telemetry and managed SQLite
 *   handles from deterministic model predictions.
 */

export const RIG_LIMITS = {
  MAX_WORKERS: 4,
  MAX_JOBS: 64,
  MAX_LIFETIME_MS: 120_000,
  MAX_DB_HANDLE_BUDGET: 100,
  HANDLES_PER_WORKER: 3,
  INITIAL_WORKERS: 1,
  EXTRA_POOL_INITIAL: 44,
  EXTRA_POOL_PRESSURE: 90,
  INITIAL_PARENT_HANDLES: 45, // 1 queue + 44 pool
  INITIAL_MANAGED_HANDLES: 48, // 45 parent + 3 worker
  PRESSURE_PARENT_HANDLES: 91, // 1 queue + 90 pool
  PRESSURE_MANAGED_HANDLES: 94, // 91 parent + 3 worker
  MAX_PAYLOAD_BYTES: 1024,
  HANDSHAKE_TIMEOUT_MS: 3000,
} as const;

export type RigJobStatus = "pending" | "in_flight" | "completed" | "failed" | "unknown";

export type RigStatus = "created" | "starting" | "running" | "closing" | "closed" | "expired";

export type RigActionType = "resume-worker" | "scale-workers" | "cap-ingestion";

export interface RigJobRecord {
  id: string;
  payload: string;
  status: RigJobStatus;
  workerId: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  resultHash: string | null;
  errorDetail: string | null;
}

export interface RigMeasuredCounters {
  admittedJobs: number;
  pendingJobs: number;
  inFlightJobs: number;
  completedJobs: number;
  failedJobs: number;
  unknownJobs: number;
  activeWorkers: number;
  pausedWorkers: number;
  workerPids: number[];
  managedSqliteHandles: number;
  maxDbHandleBudget: number;
  ingestionCapped: boolean;
  pressureInjected: boolean;
  ingestionPort: number;
}

export interface RigLabels {
  telemetryType: "measured process telemetry";
  resourceType: "managed SQLite handles";
  workloadType: "fictional workload";
  distinction: "measured local process rig, not deterministic model prediction or hosted Evaluate";
}

export interface RigObservation {
  ownerId: string;
  revision: number;
  basisDigest: string;
  status: RigStatus;
  measuredCounters: RigMeasuredCounters;
  labels: RigLabels;
}

export interface RigProposal {
  proposalId: string;
  actionType: RigActionType;
  description: string;
  parameters: Record<string, number | string | boolean | null>;
  basisRevision: number;
  basisDigest: string;
  projectedHandles: number;
  feasible: boolean;
  feasibilityReason: string;
  payloadDigest: string;
}

export interface StagedRigAction {
  stageId: string;
  actionId: string;
  ownerId: string;
  proposalId: string;
  actionType: RigActionType;
  parameters: Record<string, number | string | boolean | null>;
  basisRevision: number;
  basisDigest: string;
  payloadDigest: string;
  stagedAt: number;
  executed: boolean;
}

export interface RigReceipt {
  actionId: string;
  actionType: RigActionType;
  revisionBefore: number;
  digestBefore: string;
  revisionAfter: number;
  digestAfter: string;
  appliedAt: number;
  measuredBefore: RigMeasuredCounters;
  measuredAfter: RigMeasuredCounters;
  labNote: "measured local process rig, zero hosted calls";
}

export type ApplyResultKind =
  | "applied"
  | "stale-basis"
  | "duplicate-action"
  | "infeasible-resource"
  | "wrong-owner"
  | "expired"
  | "not-staged"
  | "busy"
  | "unknown";

export interface ApplyResult {
  kind: ApplyResultKind;
  receipt?: RigReceipt;
  detail?: string;
  currentRevision?: number;
  currentDigest?: string;
}

export interface RigEvidenceBundle {
  ownerId: string;
  revision: number;
  basisDigest: string;
  status: RigStatus;
  labels: RigLabels;
  measuredCounters: RigMeasuredCounters;
  dbBudget: {
    maxDbHandleBudget: number;
    currentManagedHandles: number;
    parentReservedHandles: number;
    workerHandles: number;
  };
  workers: Array<{
    workerId: string;
    pid: number;
    paused: boolean;
    handles: number;
    exited: boolean;
  }>;
  queueSummary: {
    total: number;
    pending: number;
    inFlight: number;
    completed: number;
    failed: number;
    unknown: number;
  };
  receipts: RigReceipt[];
  exportedAt: string;
}

export type WorkerToParentIpcMessage =
  | { type: "READY"; workerId: string; pid: number; handles: number }
  | { type: "ACK"; jobId: string; resultHash: string; workerPid: number }
  | { type: "ERROR"; jobId: string; error: string; workerPid: number }
  | { type: "PAUSED"; workerId: string }
  | { type: "RESUMED"; workerId: string };

export type ParentToWorkerIpcMessage =
  | { type: "INIT"; workerId: string; dbPath?: string }
  | { type: "JOB"; jobId: string; payload: string; hashRounds: number }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "SHUTDOWN" };

export interface ProcessRigOptions {
  ownerId: string;
  dbPath?: string;
  lifetimeMs?: number;
  /** Internal test seam for testing startup handshake failure */
  _testFailHandshake?: boolean;
  /** Internal test seam for testing resume IPC failure */
  _testFailResume?: boolean;
}
