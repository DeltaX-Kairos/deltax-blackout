/**
 * process-rig.ts — Main process rig orchestrator for M4.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md):
 * - Explicit lifecycle: created -> starting -> running -> closing -> closed / expired.
 * - Exactly one start ever, concurrent start rejected, cleanup on startup failure.
 * - TTL validation (finite integer 1..120000) and begins at constructor resource allocation.
 * - Only known compiled child worker code via fork with execArgv:[] and minimal env.
 * - Unified async cleanup for close, expiry, and failure (stops server, sockets, children, handles).
 * - Accurate resource counting: queue has 1 SQLite handle, pool has 44 / 90.
 *   Exited workers contribute 0 handles. Live workers report verified handles.
 * - Freshness binds actual material state (queue jobs, statuses, worker states).
 *   Reconciled on material changes and before observe/propose/stage/apply.
 * - Deep-copy/freeze internal records; caller cannot mutate internal state.
 * - Single in-flight operation; mark action executed before awaits.
 * - Scaling derives needed workers solely from validated targetWorkerCount (1..4) minus live workers.
 * - Child READY verified (PID, ID, handles); reject exit/error/timeout during handshake.
 * - Worker ACK/ERROR verified (PID, activeJobId, 64-char hex resultHash).
 * - Preserves final snapshot so observe and exportEvidence work after close/expiry.
 */

import fs from "node:fs";
import path from "node:path";
import { fork, ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DurableQueue } from "./queue.js";
import { HandleManager } from "./handles.js";
import { IngestionServer } from "./ingestion.js";
import {
  computeRigBasisDigest,
  computeRigPayloadDigest,
  RigBasisProjection,
  WorkerSummary,
} from "./digest.js";
import {
  RIG_LIMITS,
  RigStatus,
  RigObservation,
  RigProposal,
  StagedRigAction,
  ApplyResult,
  RigReceipt,
  RigEvidenceBundle,
  RigMeasuredCounters,
  ProcessRigOptions,
  WorkerToParentIpcMessage,
  ParentToWorkerIpcMessage,
} from "./types.js";

interface ManagedWorker {
  workerId: string;
  process: ChildProcess;
  pid: number;
  paused: boolean;
  activeJobId: string | null;
  handles: number;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  handshakeComplete: boolean;
}

// Global singleton instance guard — at most one active rig globally
let activeRigInstance: ProcessRig | null = null;

function resolveWorkerScriptPath(): string {
  const candidates = [
    path.join(__dirname, "worker.js"),
    path.resolve(process.cwd(), "dist", "src", "rig", "worker.js"),
    path.join(__dirname, "worker.ts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(__dirname, "worker.js");
}

function getSanitizedEnv(): NodeJS.ProcessEnv {
  const ALLOWED_ENV = new Set([
    "NODE_ENV",
    "PATH",
    "HOME",
    "LANG",
    "TZ",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (ALLOWED_ENV.has(key)) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function deepClone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export class ProcessRig {
  private readonly ownerId: string;
  private readonly lifetimeMs: number;
  private readonly workerModulePath: string;
  private readonly queue: DurableQueue;
  private readonly handles: HandleManager;
  private ingestion: IngestionServer | null = null;
  private capturedAdmittedCount: number = 0;

  private readonly workers = new Map<string, ManagedWorker>();
  private _status: RigStatus = "created";
  private _revision: number = 1;
  private _basisDigest: string = "";
  private _ingestionCapped: boolean = false;
  private _isApplying: boolean = false;
  private readonly _testFailHandshake: boolean;
  private readonly _testFailResume: boolean;

  private readonly proposals = new Map<string, RigProposal>();
  private readonly stagedActions = new Map<string, StagedRigAction>();
  private readonly receipts: RigReceipt[] = [];
  private readonly observationHistory: RigObservation[] = [];
  private finalObservationSnapshot: RigObservation | null = null;
  private finalEvidenceSnapshot: RigEvidenceBundle | null = null;

  private lifetimeTimer: NodeJS.Timeout | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private drainResolvers: Array<() => void> = [];
  private readonly resumeResolvers = new Map<string, Array<(ok: boolean) => void>>();

  constructor(options: ProcessRigOptions) {
    if (!options.ownerId || typeof options.ownerId !== "string") {
      throw new Error("ProcessRig requires a non-empty string ownerId");
    }

    // Validate lifetimeMs: finite integer 1..120000
    if (options.lifetimeMs !== undefined) {
      if (
        !Number.isInteger(options.lifetimeMs) ||
        options.lifetimeMs < 1 ||
        options.lifetimeMs > RIG_LIMITS.MAX_LIFETIME_MS
      ) {
        throw new Error(
          `Invalid lifetimeMs: must be a finite integer between 1 and ${RIG_LIMITS.MAX_LIFETIME_MS}`
        );
      }
      this.lifetimeMs = options.lifetimeMs;
    } else {
      this.lifetimeMs = RIG_LIMITS.MAX_LIFETIME_MS;
    }

    if (
      activeRigInstance !== null &&
      (activeRigInstance.isOpen() || activeRigInstance.getStatus() === "closing")
    ) {
      throw new Error(
        "Cannot create process rig: another rig is already active globally (global cap: 1)"
      );
    }

    this.ownerId = options.ownerId;
    this.workerModulePath = resolveWorkerScriptPath();
    this._testFailHandshake = options._testFailHandshake ?? false;
    this._testFailResume = options._testFailResume ?? false;

    // Allocate resources and claim singleton
    this.queue = new DurableQueue(options.dbPath || ":memory:");
    this.handles = new HandleManager(() => this.queue.isOpen());

    activeRigInstance = this;

    // Begin TTL bounding timer at resource allocation
    this.lifetimeTimer = setTimeout(() => {
      void this.cleanup("expired");
    }, this.lifetimeMs);
    this.lifetimeTimer.unref?.();

    // Reconcile initial material basis
    this.reconcileState();
  }

  public static getActiveRig(): ProcessRig | null {
    return activeRigInstance;
  }

  public isOpen(): boolean {
    return (
      this._status === "created" ||
      this._status === "starting" ||
      this._status === "running" ||
      this._status === "closing"
    );
  }

  public getStatus(): RigStatus {
    return this._status;
  }

  public getRevision(): number {
    return this._revision;
  }

  public getBasisDigest(): string {
    return this._basisDigest;
  }

  public getOwnerId(): string {
    return this.ownerId;
  }

  public getIngestionToken(): string {
    return this.ingestion?.getIngestionToken() || "";
  }

  /**
   * Start the rig:
   * 1. Only one start ever; reject concurrent / repeated start.
   * 2. Start loopback HTTP ingestion server.
   * 3. Spawn initial paused child worker process.
   * 4. Complete startup or clean up entirely on failure.
   */
  public async start(): Promise<number> {
    if (this._status !== "created") {
      throw new Error(`Cannot start rig in status "${this._status}": rig may only be started once`);
    }

    this._status = "starting";

    try {
      // 1. Loopback HTTP ingestion
      this.ingestion = new IngestionServer(
        this.queue,
        () => this._ingestionCapped,
        () => {
          this.capturedAdmittedCount++;
          this.reconcileState();
          this.dispatchPendingJobs();
        }
      );
      const port = await this.ingestion.start();

      // Check if expiry or cleanup started while awaiting ingestion start
      if (this._status !== "starting") {
        throw new Error(
          `Rig startup aborted: status changed to "${this._status}" during ingestion start`
        );
      }

      // 2. Start initial worker (paused)
      await this.spawnWorker("worker-1", true);

      // Check if expiry or cleanup started while awaiting spawnWorker
      if (this._status !== "starting") {
        throw new Error(
          `Rig startup aborted: status changed to "${this._status}" during worker startup`
        );
      }

      this._status = "running";
      this.reconcileState();

      return port;
    } catch (err) {
      await this.cleanup("closed");
      throw err;
    }
  }

  private assertOwner(callerOwnerId: string): void {
    if (callerOwnerId !== this.ownerId) {
      throw new Error("Access denied: caller does not match rig owner (owner mismatch)");
    }
  }

  /**
   * Verified live workers: alive and handshake confirmed.
   * Exited workers contribute 0 handles.
   */
  public getLiveWorkerCount(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      if (!w.exited && w.handshakeComplete) {
        count++;
      }
    }
    return count;
  }

  public getVerifiedLiveWorkerHandles(): number {
    let handles = 0;
    for (const w of this.workers.values()) {
      if (!w.exited && w.handshakeComplete) {
        handles += w.handles;
      }
    }
    return handles;
  }

  /**
   * Reconcile actual material state.
   * Recomputes basisDigest from:
   * - queue job identities, statuses, result hashes
   * - worker identities, live, paused, activeJobId
   * - handles and ingestion state
   */
  public reconcileState(): void {
    const queueJobs = this.queue.getJobSummaries();
    const queueCounters = this.queue.getCounters();

    const workersSummary: WorkerSummary[] = [];
    for (const [id, w] of this.workers.entries()) {
      workersSummary.push({
        workerId: id,
        pid: w.pid,
        live: !w.exited && w.handshakeComplete,
        paused: w.paused,
        activeJobId: w.activeJobId,
      });
    }

    const liveHandles = this.getVerifiedLiveWorkerHandles();
    const managedSqliteHandles = this.handles.getManagedSqliteHandles(liveHandles);

    const projection: RigBasisProjection = {
      ownerId: this.ownerId,
      workers: workersSummary,
      queueJobs,
      queueBacklog: queueCounters.pending + queueCounters.inFlight,
      queueCompleted: queueCounters.completed,
      queueFailed: queueCounters.failed,
      queueUnknown: queueCounters.unknown,
      managedSqliteHandles,
      maxDbHandleBudget: RIG_LIMITS.MAX_DB_HANDLE_BUDGET,
      ingestionCapped: this._ingestionCapped,
      pressureInjected: this.handles.isPressureInjected,
    };

    const newDigest = computeRigBasisDigest(projection);
    if (this._basisDigest === "") {
      this._basisDigest = newDigest;
    } else if (newDigest !== this._basisDigest) {
      this._revision++;
      this._basisDigest = newDigest;
    }

    // Record bounded chronological observation history
    const currentObs: RigObservation = {
      ownerId: this.ownerId,
      revision: this._revision,
      basisDigest: this._basisDigest,
      status: this._status,
      measuredCounters: this.getMeasuredCounters(),
      labels: {
        telemetryType: "measured process telemetry",
        resourceType: "managed SQLite handles",
        workloadType: "fictional workload",
        distinction:
          "measured local process rig, not deterministic model prediction or hosted Evaluate",
      },
    };

    this.observationHistory.push(deepClone(currentObs));
    if (this.observationHistory.length > 50) {
      this.observationHistory.shift();
    }
  }

  public getMeasuredCounters(): RigMeasuredCounters {
    const qc = this.queue.getCounters();
    const workerPids: number[] = [];
    let activeWorkers = 0;
    let pausedWorkers = 0;

    for (const w of this.workers.values()) {
      if (!w.exited && w.handshakeComplete) {
        workerPids.push(w.pid);
        if (w.paused) pausedWorkers++;
        else activeWorkers++;
      }
    }

    const admittedJobs = this.ingestion
      ? Math.max(this.ingestion.getMetrics().admittedCount, this.capturedAdmittedCount, qc.total)
      : Math.max(this.capturedAdmittedCount, qc.total);

    return {
      admittedJobs,
      pendingJobs: qc.pending,
      inFlightJobs: qc.inFlight,
      completedJobs: qc.completed,
      failedJobs: qc.failed,
      unknownJobs: qc.unknown,
      activeWorkers,
      pausedWorkers,
      workerPids,
      managedSqliteHandles: this.handles.getManagedSqliteHandles(
        this.getVerifiedLiveWorkerHandles()
      ),
      maxDbHandleBudget: RIG_LIMITS.MAX_DB_HANDLE_BUDGET,
      ingestionCapped: this._ingestionCapped,
      pressureInjected: this.handles.isPressureInjected,
      ingestionPort: this.ingestion?.getPort() ?? 0,
    };
  }

  // ─── Driver Interface ────────────────────────────────────────────────────────

  /**
   * Observe current rig state and measured process counters.
   * Works after close/expiry by returning the final snapshot.
   */
  public observe(callerOwnerId: string): RigObservation {
    this.assertOwner(callerOwnerId);

    if (this._status === "closed" || this._status === "expired") {
      if (this.finalObservationSnapshot) {
        return deepClone(this.finalObservationSnapshot);
      }
    }

    this.reconcileState();

    return deepClone({
      ownerId: this.ownerId,
      revision: this._revision,
      basisDigest: this._basisDigest,
      status: this._status,
      measuredCounters: this.getMeasuredCounters(),
      labels: {
        telemetryType: "measured process telemetry",
        resourceType: "managed SQLite handles",
        workloadType: "fictional workload",
        distinction:
          "measured local process rig, not deterministic model prediction or hosted Evaluate",
      },
    });
  }

  public getObservationHistory(callerOwnerId: string): RigObservation[] {
    this.assertOwner(callerOwnerId);
    return deepClone(this.observationHistory);
  }

  /**
   * Propose bounded remedies evaluated against actual current counters.
   */
  public propose(callerOwnerId: string): RigProposal[] {
    this.assertOwner(callerOwnerId);

    if (this._status !== "running") {
      throw new Error(`Cannot propose in status ${this._status}`);
    }

    this.reconcileState();

    const proposals: RigProposal[] = [];
    const liveWorkers = this.getLiveWorkerCount();
    const liveHandles = this.getVerifiedLiveWorkerHandles();
    const currentHandles = this.handles.getManagedSqliteHandles(liveHandles);

    // 1. Resume existing paused worker (if any live paused worker exists)
    const pausedWorker = Array.from(this.workers.values()).find(
      (w) => w.paused && !w.exited && w.handshakeComplete
    );
    if (pausedWorker) {
      const pResume: RigProposal = {
        proposalId: `prop-resume-r${this._revision}`,
        actionType: "resume-worker",
        description: `Resume existing paused worker ${pausedWorker.workerId} to drain pending jobs within current handle limit`,
        parameters: { workerId: pausedWorker.workerId },
        basisRevision: this._revision,
        basisDigest: this._basisDigest,
        projectedHandles: currentHandles,
        feasible: currentHandles <= RIG_LIMITS.MAX_DB_HANDLE_BUDGET,
        feasibilityReason: `Managed SQLite handles remain at ${currentHandles}/${RIG_LIMITS.MAX_DB_HANDLE_BUDGET}`,
        payloadDigest: computeRigPayloadDigest({
          actionType: "resume-worker",
          parameters: { workerId: pausedWorker.workerId },
          basisRevision: this._revision,
          basisDigest: this._basisDigest,
        }),
      };
      proposals.push(pResume);
    }

    // 2. Scale workers to 4
    const neededWorkers = Math.max(0, RIG_LIMITS.MAX_WORKERS - liveWorkers);
    const feasibility = this.handles.checkFeasibility(liveWorkers, neededWorkers);
    const pScale: RigProposal = {
      proposalId: `prop-scale-r${this._revision}`,
      actionType: "scale-workers",
      description: `Scale worker pool from ${liveWorkers} to ${RIG_LIMITS.MAX_WORKERS} workers (+${neededWorkers * RIG_LIMITS.HANDLES_PER_WORKER} managed handles)`,
      parameters: {
        targetWorkerCount: RIG_LIMITS.MAX_WORKERS,
      },
      basisRevision: this._revision,
      basisDigest: this._basisDigest,
      projectedHandles: feasibility.projectedHandles,
      feasible: feasibility.feasible,
      feasibilityReason: feasibility.reason,
      payloadDigest: computeRigPayloadDigest({
        actionType: "scale-workers",
        parameters: {
          targetWorkerCount: RIG_LIMITS.MAX_WORKERS,
        },
        basisRevision: this._revision,
        basisDigest: this._basisDigest,
      }),
    };
    proposals.push(pScale);

    // 3. Cap loopback ingestion
    const pCap: RigProposal = {
      proposalId: `prop-cap-r${this._revision}`,
      actionType: "cap-ingestion",
      description: "Cap loopback ingestion endpoint to prevent new jobs from entering the queue",
      parameters: { capped: true },
      basisRevision: this._revision,
      basisDigest: this._basisDigest,
      projectedHandles: currentHandles,
      feasible: true,
      feasibilityReason: `Ingestion cap does not increase managed handles (${currentHandles}/${RIG_LIMITS.MAX_DB_HANDLE_BUDGET})`,
      payloadDigest: computeRigPayloadDigest({
        actionType: "cap-ingestion",
        parameters: { capped: true },
        basisRevision: this._revision,
        basisDigest: this._basisDigest,
      }),
    };
    proposals.push(pCap);

    this.proposals.clear();
    for (const p of proposals) {
      this.proposals.set(p.proposalId, deepClone(p));
    }

    return proposals.map((p) => deepClone(p));
  }

  /**
   * Stage a human action based on a proposal.
   * Returns a deep-cloned immutable staged action.
   */
  public stageAction(callerOwnerId: string, proposalId: string): StagedRigAction {
    this.assertOwner(callerOwnerId);

    if (this._status !== "running") {
      throw new Error(`Cannot stage action in status ${this._status}`);
    }

    this.reconcileState();

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found or expired; propose() required`);
    }

    if (proposal.basisDigest !== this._basisDigest) {
      throw new Error(
        `Proposal ${proposalId} basis is stale (proposal digest=${proposal.basisDigest.slice(0, 16)}…, current digest=${this._basisDigest.slice(0, 16)}…); re-propose required`
      );
    }

    if (!proposal.feasible) {
      throw new Error(
        `Proposal ${proposalId} failed feasibility check: ${proposal.feasibilityReason}`
      );
    }

    const stageId = randomBytes(16).toString("hex");
    const actionId = `rig-act-${proposal.actionType}-r${this._revision}-${stageId.slice(0, 8)}`;

    const staged: StagedRigAction = {
      stageId,
      actionId,
      ownerId: this.ownerId,
      proposalId: proposal.proposalId,
      actionType: proposal.actionType,
      parameters: deepClone(proposal.parameters),
      basisRevision: this._revision,
      basisDigest: this._basisDigest,
      payloadDigest: proposal.payloadDigest,
      stagedAt: Date.now(),
      executed: false,
    };

    this.stagedActions.set(stageId, deepClone(staged));
    return deepClone(staged);
  }

  public stage(callerOwnerId: string, proposalId: string): StagedRigAction {
    return this.stageAction(callerOwnerId, proposalId);
  }

  /**
   * Apply a staged action once.
   * Gates:
   * 1. Single in-flight guard (non-reentrant).
   * 2. Mark one-use BEFORE awaits.
   * 3. Re-verify payload digest from independently stored parameters.
   * 4. Strict closed parameter schema.
   * 5. Resource check against actual live counters immediately before effect.
   */
  public async apply(callerOwnerId: string, stageId: string): Promise<ApplyResult> {
    if (callerOwnerId !== this.ownerId) {
      return { kind: "wrong-owner", detail: "Caller ownerId does not match rig ownerId" };
    }

    if (this._status !== "running") {
      return { kind: "expired", detail: `Rig is ${this._status}` };
    }

    if (this._isApplying) {
      return { kind: "busy", detail: "Another apply operation is currently in flight" };
    }

    this._isApplying = true;

    try {
      this.reconcileState();

      const staged = this.stagedActions.get(stageId);
      if (!staged) {
        return { kind: "not-staged", detail: `Stage ID ${stageId} not found` };
      }

      if (staged.executed) {
        return { kind: "duplicate-action", detail: `Action ${staged.actionId} already executed` };
      }

      // Mark action one-use BEFORE any awaits to prevent re-entrant execution
      staged.executed = true;

      // Gate A: Check basis freshness against current state
      if (staged.basisDigest !== this._basisDigest) {
        return {
          kind: "stale-basis",
          currentRevision: this._revision,
          currentDigest: this._basisDigest,
          detail: `Action basis digest (${staged.basisDigest.slice(0, 16)}…) does not match current state digest (${this._basisDigest.slice(0, 16)}…)`,
        };
      }

      // Gate B: Re-verify payload digest integrity against stored parameters
      const recomputedPayloadDigest = computeRigPayloadDigest({
        actionType: staged.actionType,
        parameters: staged.parameters,
        basisRevision: staged.basisRevision,
        basisDigest: staged.basisDigest,
      });
      if (recomputedPayloadDigest !== staged.payloadDigest) {
        return {
          kind: "stale-basis",
          detail: "Action payload digest mismatch (tampered or unconfirmed payload)",
        };
      }

      // Gate C: Resource check against current actual live workers immediately before effect
      const liveWorkers = this.getLiveWorkerCount();
      let neededWorkers = 0;

      if (staged.actionType === "scale-workers") {
        const rawTarget = staged.parameters["targetWorkerCount"];
        if (
          typeof rawTarget !== "number" ||
          !Number.isInteger(rawTarget) ||
          rawTarget < 1 ||
          rawTarget > RIG_LIMITS.MAX_WORKERS
        ) {
          return { kind: "infeasible-resource", detail: "Invalid targetWorkerCount parameter" };
        }
        // Derive additional workers solely from validated targetWorkerCount and live workers
        neededWorkers = Math.max(0, rawTarget - liveWorkers);
        const feasibility = this.handles.checkFeasibility(liveWorkers, neededWorkers);
        if (!feasibility.feasible) {
          return {
            kind: "infeasible-resource",
            detail: feasibility.reason,
          };
        }
      }

      // Execution
      const measuredBefore = this.getMeasuredCounters();
      const revisionBefore = this._revision;
      const digestBefore = this._basisDigest;

      if (this._status !== "running") {
        return { kind: "expired", detail: `Rig is ${this._status}` };
      }

      if (staged.actionType === "resume-worker") {
        const workerId = String(staged.parameters["workerId"] || "worker-1");
        const worker = this.workers.get(workerId);
        if (!worker || worker.exited || !worker.handshakeComplete) {
          return {
            kind: "unknown",
            detail: `Target worker ${workerId} is not available or exited`,
          };
        }

        // Test seam for simulated resume failure
        if (this._testFailResume) {
          return {
            kind: "unknown",
            detail: `Simulated resume failure for ${workerId}`,
          };
        }

        if (worker.paused) {
          const resumePromise = new Promise<boolean>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                resolve(false);
              }
            }, 2000);
            timer.unref?.();

            const list = this.resumeResolvers.get(workerId) || [];
            list.push((ok) => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(ok);
              }
            });
            this.resumeResolvers.set(workerId, list);
          });

          const sent = this.safeChildSend(worker.process, { type: "RESUME" });
          if (!sent) {
            return {
              kind: "unknown",
              detail: `Failed to deliver RESUME IPC message to ${workerId}`,
            };
          }

          const confirmed = await resumePromise;
          if (!confirmed || worker.paused || worker.exited || this._status !== "running") {
            return {
              kind: "unknown",
              detail: `Worker ${workerId} failed to acknowledge RESUME within deadline`,
            };
          }

          if (this._status === "running") {
            this.dispatchPendingJobs();
          }
        }
      } else if (staged.actionType === "scale-workers") {
        const currentCount = this.workers.size;
        try {
          for (let i = 1; i <= neededWorkers; i++) {
            if (this._status !== "running") {
              return { kind: "expired", detail: `Rig is ${this._status} during scale operation` };
            }
            await this.spawnWorker(`worker-${currentCount + i}`, false);
            if (this._status !== "running") {
              return { kind: "expired", detail: `Rig is ${this._status} during scale operation` };
            }
          }
        } catch (scaleErr) {
          this.reconcileState();
          return {
            kind: "unknown",
            detail: `Partial scale operation failed: ${scaleErr instanceof Error ? scaleErr.message : String(scaleErr)}`,
          };
        }
        if (this._status === "running") {
          this.dispatchPendingJobs();
        }
      } else if (staged.actionType === "cap-ingestion") {
        this._ingestionCapped = true;
      }

      if (this._status !== "running") {
        return { kind: "expired", detail: `Rig is ${this._status}` };
      }

      this.reconcileState();
      const measuredAfter = this.getMeasuredCounters();

      const receipt: RigReceipt = {
        actionId: staged.actionId,
        actionType: staged.actionType,
        revisionBefore,
        digestBefore,
        revisionAfter: this._revision,
        digestAfter: this._basisDigest,
        appliedAt: Date.now(),
        measuredBefore,
        measuredAfter,
        labNote: "measured local process rig, zero hosted calls",
      };

      this.receipts.push(deepClone(receipt));
      return { kind: "applied", receipt: deepClone(receipt) };
    } finally {
      this._isApplying = false;
    }
  }

  /**
   * Inject named database pressure: reserves extra SQLite pool handles to 90
   * (parent total 91 including queue).
   */
  public injectPressure(callerOwnerId: string): void {
    this.assertOwner(callerOwnerId);

    if (this._status !== "running") {
      throw new Error(`Cannot inject pressure: rig is ${this._status}`);
    }

    this.handles.injectPressure();
    this.reconcileState();
  }

  // ─── Child Worker Process Lifecycle ──────────────────────────────────────────

  private safeChildSend(
    child: ChildProcess,
    msg: ParentToWorkerIpcMessage,
    callback?: (err: Error | null) => void
  ): boolean {
    if (!child.connected) {
      if (callback) callback(new Error("Worker process is not connected"));
      return false;
    }
    try {
      child.send(msg, (err) => {
        if (callback) callback(err);
      });
      return true;
    } catch (err) {
      if (callback) callback(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private async spawnWorker(workerId: string, paused: boolean): Promise<ManagedWorker> {
    const child = fork(this.workerModulePath, [], {
      execArgv: [],
      env: getSanitizedEnv(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    // Persistent error handler to prevent unhandled 'error' events (such as write EPIPE)
    child.on("error", (_err) => {
      // Suppressed on child process; handshake and exit listeners govern lifecycle
    });

    const pid = child.pid || 0;
    const worker: ManagedWorker = {
      workerId,
      process: child,
      pid,
      paused,
      activeJobId: null,
      handles: RIG_LIMITS.HANDLES_PER_WORKER,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      handshakeComplete: false,
    };

    this.workers.set(workerId, worker);

    child.on("message", (msg: unknown) => {
      this.handleWorkerMessage(worker, msg as WorkerToParentIpcMessage);
    });

    child.on("exit", (code, signal) => {
      worker.exited = true;
      worker.exitCode = code;
      worker.handshakeComplete = false;

      // Uncertain inflight never silently retried
      if (worker.activeJobId && this.queue.isOpen()) {
        this.queue.markUnknown(
          worker.activeJobId,
          `Child worker ${worker.pid} exited unexpectedly (code ${code}, signal ${signal})`
        );
        worker.activeJobId = null;
        this.checkDrain();
      }

      const resolvers = this.resumeResolvers.get(workerId);
      if (resolvers) {
        this.resumeResolvers.delete(workerId);
        for (const r of resolvers) r(false);
      }

      this.reconcileState();
    });

    // Internal test seam: simulate startup handshake failure
    if (this._testFailHandshake) {
      try {
        child.kill("SIGKILL");
      } catch {}
      throw new Error("Simulated startup handshake failure");
    }

    // Bounded child READY handshake
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            child.kill("SIGKILL");
          } catch {}
          reject(new Error(`Worker ${workerId} startup handshake timed out`));
        }
      }, RIG_LIMITS.HANDSHAKE_TIMEOUT_MS);

      const onExit = (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Worker ${workerId} exited with code ${code} during handshake`));
        }
      };

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Worker ${workerId} error during handshake: ${err.message}`));
        }
      };

      const onReady = (msg: unknown) => {
        const m = msg as WorkerToParentIpcMessage;
        if (m && m.type === "READY") {
          // Strictly verify owned PID, workerId, and handles
          if (
            m.workerId === workerId &&
            m.pid === child.pid &&
            m.handles === RIG_LIMITS.HANDLES_PER_WORKER
          ) {
            settled = true;
            clearTimeout(timeout);
            child.removeListener("exit", onExit);
            child.removeListener("error", onError);
            child.removeListener("message", onReady);
            worker.handshakeComplete = true;

            const nextMsg: ParentToWorkerIpcMessage = paused
              ? { type: "PAUSE" }
              : { type: "RESUME" };
            this.safeChildSend(child, nextMsg, (sendErr) => {
              if (sendErr) {
                reject(
                  new Error(
                    `Worker ${workerId} failed to send initial pause/resume: ${sendErr.message}`
                  )
                );
                return;
              }
              resolve();
            });
          } else {
            settled = true;
            clearTimeout(timeout);
            try {
              child.kill("SIGKILL");
            } catch {}
            reject(new Error(`Worker ${workerId} sent invalid READY handshake credentials`));
          }
        }
      };

      child.once("exit", onExit);
      child.once("error", onError);
      child.on("message", onReady);
      this.safeChildSend(child, { type: "INIT", workerId }, (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Worker ${workerId} INIT send failed: ${err.message}`));
        }
      });
    });

    return worker;
  }

  private handleWorkerMessage(worker: ManagedWorker, msg: WorkerToParentIpcMessage): void {
    if (!msg || typeof msg !== "object") {
      return;
    }

    switch (msg.type) {
      case "ACK": {
        // Validate PID, activeJobId, and hash format (64-char lowercase hex)
        if (
          msg.workerPid === worker.pid &&
          msg.jobId === worker.activeJobId &&
          typeof msg.resultHash === "string" &&
          /^[0-9a-f]{64}$/.test(msg.resultHash)
        ) {
          if (this.queue.isOpen()) {
            this.queue.markCompleted(msg.jobId, msg.resultHash);
          }
          worker.activeJobId = null;
          this.reconcileState();
          this.checkDrain();

          if (!worker.paused && !worker.exited && this._status === "running") {
            this.dispatchPendingJobs();
          }
        }
        break;
      }

      case "ERROR": {
        if (msg.workerPid === worker.pid && msg.jobId === worker.activeJobId) {
          if (this.queue.isOpen()) {
            this.queue.markFailed(msg.jobId, msg.error);
          }
          worker.activeJobId = null;
          this.reconcileState();
          this.checkDrain();

          if (!worker.paused && !worker.exited && this._status === "running") {
            this.dispatchPendingJobs();
          }
        }
        break;
      }

      case "PAUSED": {
        if (msg.workerId === worker.workerId) {
          worker.paused = true;
          this.reconcileState();
        }
        break;
      }

      case "RESUMED": {
        if (msg.workerId === worker.workerId) {
          worker.paused = false;
          this.reconcileState();
          const resolvers = this.resumeResolvers.get(worker.workerId);
          if (resolvers) {
            this.resumeResolvers.delete(worker.workerId);
            for (const r of resolvers) r(true);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private dispatchPendingJobs(): void {
    if (this._status !== "running" || !this.queue.isOpen()) {
      return;
    }

    for (const worker of this.workers.values()) {
      if (worker.exited || worker.paused || worker.activeJobId !== null || !worker.handshakeComplete) {
        continue;
      }

      const job = this.queue.claimNextPending(worker.workerId);
      if (!job) {
        continue;
      }

      worker.activeJobId = job.id;
      this.reconcileState();

      const msg: ParentToWorkerIpcMessage = {
        type: "JOB",
        jobId: job.id,
        payload: job.payload,
        hashRounds: 50,
      };
      const sent = this.safeChildSend(worker.process, msg, (err) => {
        if (err && worker.activeJobId && this.queue.isOpen()) {
          this.queue.markUnknown(worker.activeJobId, `IPC send error: ${err.message}`);
          worker.activeJobId = null;
          this.reconcileState();
          this.checkDrain();
        }
      });
      if (!sent && worker.activeJobId && this.queue.isOpen()) {
        this.queue.markUnknown(
          worker.activeJobId,
          "Worker process disconnected for job dispatch"
        );
        worker.activeJobId = null;
        this.reconcileState();
        this.checkDrain();
      }
    }
  }

  private checkDrain(): void {
    const qc = this.queue.getCounters();
    if (qc.pending === 0 && qc.inFlight === 0) {
      while (this.drainResolvers.length > 0) {
        const resolve = this.drainResolvers.shift();
        resolve?.();
      }
    }
  }

  public async drainQueue(options: { timeoutMs?: number } = {}): Promise<void> {
    const timeout = options.timeoutMs ?? 5000;
    const qc = this.queue.getCounters();
    if (qc.pending === 0 && qc.inFlight === 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`drainQueue timed out after ${timeout}ms`));
      }, timeout);

      this.drainResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });

      this.dispatchPendingJobs();
    });
  }

  public async waitForCompleted(targetCompleted: number, timeoutMs: number = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const qc = this.queue.getCounters();
      if (qc.completed >= targetCompleted) {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
      this.dispatchPendingJobs();
    }
    throw new Error(
      `waitForCompleted(${targetCompleted}) timed out after ${timeoutMs}ms (completed=${this.queue.getCounters().completed})`
    );
  }

  // ─── Evidence Export ─────────────────────────────────────────────────────────

  public exportEvidence(callerOwnerId: string): RigEvidenceBundle {
    this.assertOwner(callerOwnerId);

    if (this._status === "closed" || this._status === "expired") {
      if (this.finalEvidenceSnapshot) {
        return deepClone(this.finalEvidenceSnapshot);
      }
    }

    this.reconcileState();

    const counters = this.getMeasuredCounters();
    const queueSummary = this.queue.getCounters();
    const workersList = Array.from(this.workers.values()).map((w) => ({
      workerId: w.workerId,
      pid: w.pid,
      paused: w.paused,
      handles: !w.exited && w.handshakeComplete ? w.handles : 0,
      exited: w.exited,
    }));

    return deepClone({
      ownerId: this.ownerId,
      revision: this._revision,
      basisDigest: this._basisDigest,
      status: this._status,
      labels: {
        telemetryType: "measured process telemetry",
        resourceType: "managed SQLite handles",
        workloadType: "fictional workload",
        distinction:
          "measured local process rig, not deterministic model prediction or hosted Evaluate",
      },
      measuredCounters: counters,
      dbBudget: {
        maxDbHandleBudget: RIG_LIMITS.MAX_DB_HANDLE_BUDGET,
        currentManagedHandles: counters.managedSqliteHandles,
        parentReservedHandles: this.handles.parentTotalHandleCount,
        workerHandles: this.getVerifiedLiveWorkerHandles(),
      },
      workers: workersList,
      queueSummary,
      receipts: deepClone(this.receipts),
      exportedAt: new Date().toISOString(),
    });
  }

  // ─── Unified Async Cleanup ───────────────────────────────────────────────────

  private async cleanup(finalStatus: "closed" | "expired"): Promise<void> {
    if (this._status === "closed" || this._status === "expired") {
      return;
    }

    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = (async () => {
      this._status = "closing";

      if (this.lifetimeTimer) {
        clearTimeout(this.lifetimeTimer);
        this.lifetimeTimer = null;
      }

      for (const resolvers of this.resumeResolvers.values()) {
        for (const r of resolvers) r(false);
      }
      this.resumeResolvers.clear();

      // 1. Close loopback HTTP ingestion server and capture admission count
      if (this.ingestion) {
        try {
          this.capturedAdmittedCount = Math.max(
            this.capturedAdmittedCount,
            this.ingestion.getMetrics().admittedCount,
            this.queue.getCounters().total
          );
          await this.ingestion.close();
        } catch {}
        this.ingestion = null;
      }

      // 2. Terminate child worker processes with bounded escalation (SHUTDOWN -> SIGTERM -> SIGKILL)
      // and verify exit is observed before reporting zero resources or releasing singleton.
      const shutdownPromises: Promise<{ workerId: string; confirmedDead: boolean }>[] = [];
      for (const w of this.workers.values()) {
        if (w.exited) {
          shutdownPromises.push(Promise.resolve({ workerId: w.workerId, confirmedDead: true }));
          continue;
        }

        shutdownPromises.push(
          new Promise<{ workerId: string; confirmedDead: boolean }>((resolve) => {
            let settled = false;
            let termTimer: NodeJS.Timeout | null = null;
            let killTimer: NodeJS.Timeout | null = null;
            let deadlineTimer: NodeJS.Timeout | null = null;

            const clearAllTimers = () => {
              if (termTimer) {
                clearTimeout(termTimer);
                termTimer = null;
              }
              if (killTimer) {
                clearTimeout(killTimer);
                killTimer = null;
              }
              if (deadlineTimer) {
                clearTimeout(deadlineTimer);
                deadlineTimer = null;
              }
            };

            const finish = (confirmedDead: boolean) => {
              if (settled) return;
              settled = true;
              clearAllTimers();
              resolve({ workerId: w.workerId, confirmedDead });
            };

            const onExit = (code: number | null) => {
              w.exited = true;
              w.exitCode = code;
              finish(true);
            };

            w.process.once("exit", onExit);

            // Escalation timer 1: SIGTERM after 100ms
            termTimer = setTimeout(() => {
              if (settled) return;
              try {
                w.process.kill("SIGTERM");
              } catch {}

              // Escalation timer 2: SIGKILL after another 100ms
              killTimer = setTimeout(() => {
                if (settled) return;
                try {
                  w.process.kill("SIGKILL");
                } catch {}
              }, 100);
              killTimer.unref?.();
            }, 100);
            termTimer.unref?.();

            // Bounded final deadline: 500ms
            deadlineTimer = setTimeout(() => {
              w.process.removeListener("exit", onExit);
              finish(false);
            }, 500);
            deadlineTimer.unref?.();

            // Step 0: graceful SHUTDOWN IPC message
            this.safeChildSend(w.process, { type: "SHUTDOWN" }, (sendErr) => {
              if (sendErr && !settled) {
                try {
                  w.process.kill("SIGTERM");
                } catch {}
              }
            });
          })
        );
      }

      const results = await Promise.all(shutdownPromises);
      const allDead = results.every((r) => r.confirmedDead);

      if (!allDead) {
        // Retain lease/status closing and return cleanup-unknown if an owned child cannot be confirmed dead by a bounded final deadline.
        throw new Error(
          "cleanup-unknown: one or more child workers could not be confirmed dead within deadline"
        );
      }

      // 3. Close SQLite handles and queue FIRST (queue caches final records and supports reads after close)
      try {
        this.handles.close();
      } catch {}
      try {
        this.queue.close();
      } catch {}

      // 4. Reconcile actual final 0 state and status (computes final basis digest reflecting actual 0 handles)
      this._status = finalStatus;
      this.reconcileState();

      // 5. Build final snapshots directly from actual measured counters (no synthetic overwrites)
      try {
        const counters = this.getMeasuredCounters();
        const queueSummary = this.queue.getCounters();
        const workersList = Array.from(this.workers.values()).map((w) => ({
          workerId: w.workerId,
          pid: w.pid,
          paused: w.paused,
          handles: 0,
          exited: true,
        }));

        this.finalObservationSnapshot = deepClone({
          ownerId: this.ownerId,
          revision: this._revision,
          basisDigest: this._basisDigest,
          status: finalStatus,
          measuredCounters: counters,
          labels: {
            telemetryType: "measured process telemetry",
            resourceType: "managed SQLite handles",
            workloadType: "fictional workload",
            distinction:
              "measured local process rig, not deterministic model prediction or hosted Evaluate",
          },
        });

        this.finalEvidenceSnapshot = deepClone({
          ownerId: this.ownerId,
          revision: this._revision,
          basisDigest: this._basisDigest,
          status: finalStatus,
          labels: {
            telemetryType: "measured process telemetry",
            resourceType: "managed SQLite handles",
            workloadType: "fictional workload",
            distinction:
              "measured local process rig, not deterministic model prediction or hosted Evaluate",
          },
          measuredCounters: counters,
          dbBudget: {
            maxDbHandleBudget: RIG_LIMITS.MAX_DB_HANDLE_BUDGET,
            currentManagedHandles: counters.managedSqliteHandles,
            parentReservedHandles: this.handles.parentTotalHandleCount,
            workerHandles: 0,
          },
          workers: workersList,
          queueSummary,
          receipts: deepClone(this.receipts),
          exportedAt: new Date().toISOString(),
        });
      } catch {}

      // 6. Release global singleton slot ONLY AFTER cleanup confirmed
      if (activeRigInstance === this) {
        activeRigInstance = null;
      }
    })();

    return this.cleanupPromise;
  }

  public async close(): Promise<void> {
    return this.cleanup("closed");
  }
}
