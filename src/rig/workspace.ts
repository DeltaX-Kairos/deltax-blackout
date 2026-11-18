/**
 * workspace.ts — Reusable Process Rig Workspace API for M4.
 *
 * Requirements (docs/RIG-FINISH-011.md §2):
 * - Export class RigWorkspace (and types) with async methods:
 *   start(ownerId), status(ownerId), propose(ownerId), stage(ownerId, proposalId),
 *   apply(ownerId, stageId), injectPressure(ownerId), close(ownerId),
 *   evidence(ownerId), shutdown().
 * - Single in-flight operation mutex per workspace.
 * - Enforce ownerId, strict inputs, and one operation at a time.
 * - Disposable rig with real file-backed SQLite queue in private temp directory
 *   (0700 dir, 0600 db file). Never expose file paths to callers.
 * - Starts 1 paused worker and admits exactly 24 server-generated fictional jobs
 *   via loopback HTTP ingestion API with x-rig-token.
 * - At most 1 global rig active at a time.
 * - Bounded history of 20 completed runs.
 * - Finite start allowances: max 10 total starts / 2 starts per owner in controller lifetime.
 * - Pure status(): does not start a rig or auto-propose.
 * - Stage resolves exact proposal from last server-side set, returning human-readable effect.
 * - Apply returns actual result and refreshed observation; uncertain effects cannot be retried.
 * - Persists final snapshot/evidence after expiry or close.
 * - Exposes explicit measured-lab source labels, zero hosted calls.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { ProcessRig } from "./process-rig.js";
import {
  RigStatus,
  RigObservation,
  RigProposal,
  StagedRigAction,
  ApplyResult,
  RigEvidenceBundle,
  RIG_LIMITS,
} from "./types.js";

export interface RigSourceLabels {
  source: string;
  telemetryType: string;
  resourceType: string;
  workloadType: string;
  distinction: string;
}

export interface RigWorkspaceStartResult {
  success: boolean;
  ownerId: string;
  status: RigStatus;
  observation: RigObservation;
  proposals: RigProposal[];
  sourceLabels: RigSourceLabels;
  expiryMs: number;
}

export interface RigWorkspaceStatusResult {
  active: boolean;
  status: RigStatus | "idle";
  observation: RigObservation | null;
  proposals: RigProposal[];
  historyCount: number;
  sourceLabels: RigSourceLabels;
}

export interface RigWorkspaceProposeResult {
  observation: RigObservation;
  proposals: RigProposal[];
}

export interface RigWorkspaceStageResult {
  staged: StagedRigAction;
  observation: RigObservation;
  humanReadableEffect: string;
}

export interface RigWorkspaceApplyResult {
  result: ApplyResult;
  observation: RigObservation;
}

export interface RigWorkspacePressureResult {
  success: boolean;
  observation: RigObservation;
}

export interface RigWorkspaceCloseResult {
  success: boolean;
  finalObservation: RigObservation;
  finalEvidence: RigEvidenceBundle;
}

export interface RigHistoricalRun {
  runId: string;
  ownerId: string;
  startedAt: number;
  closedAt: number;
  finalObservation: RigObservation;
  finalEvidence: RigEvidenceBundle;
}

export interface RigWorkspaceOptions {
  maxLifetimeMs?: number;
  maxHistory?: number;
  maxTotalStarts?: number;
  maxStartsPerOwner?: number;
}

const DEFAULT_SOURCE_LABELS: RigSourceLabels = {
  source: "measured-process-rig",
  telemetryType: "measured process telemetry",
  resourceType: "managed SQLite handles",
  workloadType: "fictional workload",
  distinction:
    "measured local process rig, zero hosted calls, not deterministic model prediction or hosted Evaluate",
};

function deepClone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

const MAX_INGEST_RESPONSE_BYTES = 64 * 1024;
const INGEST_TIMEOUT_MS = 5000;

function sendLoopbackIngest(
  port: number,
  token: string,
  payload: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const postData = JSON.stringify({ payload });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ingest",
        headers: {
          Host: `127.0.0.1:${port}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(postData)),
          "x-rig-token": token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on("data", (c: Buffer) => {
          totalBytes += c.length;
          if (totalBytes > MAX_INGEST_RESPONSE_BYTES) {
            res.destroy();
            req.destroy();
            finish(() =>
              reject(
                new Error(
                  `Ingestion response exceeded cap of ${MAX_INGEST_RESPONSE_BYTES} bytes`
                )
              )
            );
            return;
          }
          chunks.push(c);
        });

        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {}
          finish(() => resolve({ status: res.statusCode ?? 0, body }));
        });

        res.on("error", (err) => {
          finish(() => reject(err));
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish(() =>
        reject(
          new Error(
            `Loopback ingestion request timed out after ${INGEST_TIMEOUT_MS}ms`
          )
        )
      );
    }, INGEST_TIMEOUT_MS);
    timer.unref?.();

    req.on("error", (err) => {
      finish(() => reject(err));
    });

    req.write(postData);
    req.end();
  });
}

function formatHumanReadableEffect(
  actionType: string,
  parameters: Record<string, unknown>,
  currentLiveWorkers: number
): string {
  switch (actionType) {
    case "scale-workers": {
      const target = Number(parameters["targetWorkerCount"] ?? 4);
      const needed = Math.max(0, target - currentLiveWorkers);
      return `Scale workers to ${target} (spawns ${needed} new workers, reserves ${needed * 3} SQLite handles)`;
    }
    case "resume-worker": {
      const workerId = String(parameters["workerId"] || "worker-1");
      return `Resume paused ${workerId} (0 additional SQLite handles, drains pending queue)`;
    }
    case "cap-ingestion": {
      return "Cap loopback ingestion (rejects any further incoming jobs with HTTP 429)";
    }
    default:
      return `Execute ${actionType}`;
  }
}

export class RigWorkspace {
  private activeRig: ProcessRig | null = null;
  private activeTempDir: string | null = null;
  private activeDbPath: string | null = null;
  private activeOwnerId: string | null = null;
  private activeStartedAt: number = 0;
  private activeExpiryMs: number = 0;

  private cachedProposals: Map<string, RigProposal> = new Map();
  private cachedStagedAction: StagedRigAction | null = null;

  private isOperationInProgress: boolean = false;
  private totalStarts: number = 0;
  private readonly ownerStarts: Map<string, number> = new Map();
  private readonly history: RigHistoricalRun[] = [];
  private readonly allTempDirs: string[] = [];

  private readonly maxLifetimeMs: number;
  private readonly maxHistory: number;
  private readonly maxTotalStarts: number;
  private readonly maxStartsPerOwner: number;

  constructor(options: RigWorkspaceOptions = {}) {
    this.maxLifetimeMs = options.maxLifetimeMs ?? RIG_LIMITS.MAX_LIFETIME_MS;
    this.maxHistory = options.maxHistory ?? 20;
    this.maxTotalStarts = options.maxTotalStarts ?? 10;
    this.maxStartsPerOwner = options.maxStartsPerOwner ?? 2;
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOperationInProgress) {
      throw new Error("Another rig workspace operation is currently in progress");
    }
    this.isOperationInProgress = true;
    try {
      return await fn();
    } finally {
      this.isOperationInProgress = false;
    }
  }

  private assertValidOwnerId(ownerId: unknown): asserts ownerId is string {
    if (!ownerId || typeof ownerId !== "string" || !ownerId.trim()) {
      throw new Error("Owner ID is required and must be a non-empty string");
    }
  }

  private assertRigOwner(callerOwnerId: string): void {
    if (this.activeOwnerId && this.activeOwnerId !== callerOwnerId) {
      throw new Error("Access denied: caller does not match rig owner (owner mismatch)");
    }
  }

  private archiveActiveRigIfExpired(): void {
    if (this.activeRig && this.activeRig.getStatus() === "expired") {
      try {
        const obs = this.activeRig.observe(this.activeOwnerId!);
        const ev = this.activeRig.exportEvidence(this.activeOwnerId!);
        this.recordHistory(this.activeOwnerId!, obs, ev);
      } catch {}
      this.activeRig = null;
      this.activeOwnerId = null;
      this.activeStartedAt = 0;
      this.cachedProposals.clear();
      this.cachedStagedAction = null;
    }
  }

  private recordHistory(
    ownerId: string,
    observation: RigObservation,
    evidence: RigEvidenceBundle
  ): void {
    const run: RigHistoricalRun = {
      runId: `rig-run-${Date.now()}-${randomBytes(4).toString("hex")}`,
      ownerId,
      startedAt: this.activeStartedAt || Date.now(),
      closedAt: Date.now(),
      finalObservation: deepClone(observation),
      finalEvidence: deepClone(evidence),
    };
    this.history.push(run);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Start a new disposable process rig:
   * - Checks allowances (10 total / 2 per owner)
   * - Enforces at most 1 global rig
   * - Creates private temp dir (0700) and SQLite db (0600)
   * - Spawns 1 paused worker
   * - Ingests exactly 24 server-generated fictional jobs via loopback HTTP
   * - Returns initial observation and proposals
   */
  public async start(ownerId: string): Promise<RigWorkspaceStartResult> {
    this.assertValidOwnerId(ownerId);

    return this.withMutex(async () => {
      this.archiveActiveRigIfExpired();

      // Check start allowances
      if (this.totalStarts >= this.maxTotalStarts) {
        throw new Error(
          `Workspace start allowance exhausted (max ${this.maxTotalStarts} total starts per controller lifetime)`
        );
      }
      const ownerCount = this.ownerStarts.get(ownerId) || 0;
      if (ownerCount >= this.maxStartsPerOwner) {
        throw new Error(
          `Owner start allowance exhausted (max ${this.maxStartsPerOwner} starts per owner)`
        );
      }

      // Check global singleton
      if (
        this.activeRig &&
        (this.activeRig.isOpen() || this.activeRig.getStatus() === "closing")
      ) {
        throw new Error("Cannot start rig: a process rig is already active in this workspace");
      }

      // Create app-owned private temporary directory (0700)
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blackout-rig-"));
      try {
        fs.chmodSync(tempDir, 0o700);
      } catch {}
      this.allTempDirs.push(tempDir);

      // Create private SQLite database file (0600)
      const dbPath = path.join(tempDir, "queue.db");
      const fd = fs.openSync(dbPath, "w", 0o600);
      fs.closeSync(fd);
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {}

      // Construct and start process rig
      const rig = new ProcessRig({
        ownerId,
        dbPath,
        lifetimeMs: this.maxLifetimeMs,
      });

      this.activeRig = rig;
      this.activeTempDir = tempDir;
      this.activeDbPath = dbPath;
      this.activeOwnerId = ownerId;
      this.activeStartedAt = Date.now();
      this.activeExpiryMs = Date.now() + this.maxLifetimeMs;

      this.totalStarts++;
      this.ownerStarts.set(ownerId, ownerCount + 1);

      let port: number;
      try {
        port = await rig.start();
      } catch (err) {
        this.activeRig = null;
        this.activeOwnerId = null;
        this.activeStartedAt = 0;
        throw err;
      }

      // Admit exactly 24 server-generated fictional jobs via authenticated loopback HTTP
      const token = rig.getIngestionToken();
      for (let i = 1; i <= 24; i++) {
        const payload = `fictional-batch-job-${i}-${randomBytes(4).toString("hex")}`;
        const res = await sendLoopbackIngest(port, token, payload);
        if (res.status !== 202 && res.status !== 200) {
          await rig.close();
          this.activeRig = null;
          this.activeOwnerId = null;
          this.activeStartedAt = 0;
          throw new Error(
            `Failed to ingest server fictional job ${i}/24: HTTP status ${res.status}`
          );
        }
      }

      // Generate initial proposals
      const proposals = rig.propose(ownerId);
      this.cachedProposals.clear();
      for (const p of proposals) {
        this.cachedProposals.set(p.proposalId, p);
      }

      const observation = rig.observe(ownerId);

      return {
        success: true,
        ownerId,
        status: observation.status,
        observation: deepClone(observation),
        proposals: deepClone(proposals),
        sourceLabels: deepClone(DEFAULT_SOURCE_LABELS),
        expiryMs: this.activeExpiryMs,
      };
    });
  }

  /**
   * Pure status inspection. Does NOT start a rig or auto-propose.
   */
  public async status(ownerId: string): Promise<RigWorkspaceStatusResult> {
    this.assertValidOwnerId(ownerId);

    return this.withMutex(async () => {
      this.archiveActiveRigIfExpired();

      if (!this.activeRig) {
        return {
          active: false,
          status: "idle",
          observation: null,
          proposals: [],
          historyCount: this.history.length,
          sourceLabels: deepClone(DEFAULT_SOURCE_LABELS),
        };
      }

      this.assertRigOwner(ownerId);
      const observation = this.activeRig.observe(ownerId);
      const proposals = Array.from(this.cachedProposals.values());

      return {
        active: this.activeRig.isOpen(),
        status: observation.status,
        observation: deepClone(observation),
        proposals: deepClone(proposals),
        historyCount: this.history.length,
        sourceLabels: deepClone(DEFAULT_SOURCE_LABELS),
      };
    });
  }

  /**
   * Propose candidate recovery actions from current state.
   */
  public async propose(ownerId: string): Promise<RigWorkspaceProposeResult> {
    this.assertValidOwnerId(ownerId);

    return this.withMutex(async () => {
      this.archiveActiveRigIfExpired();

      if (!this.activeRig || this.activeRig.getStatus() !== "running") {
        throw new Error("Cannot propose: no active rig running in this workspace");
      }

      this.assertRigOwner(ownerId);
      const proposals = this.activeRig.propose(ownerId);
      this.cachedProposals.clear();
      for (const p of proposals) {
        this.cachedProposals.set(p.proposalId, p);
      }

      const observation = this.activeRig.observe(ownerId);

      return {
        observation: deepClone(observation),
        proposals: deepClone(proposals),
      };
    });
  }

  /**
   * Stage a proposal by proposalId from the last server-side set.
   * Returns staged action and human-readable effect description.
   */
  public async stage(ownerId: string, proposalId: string): Promise<RigWorkspaceStageResult> {
    this.assertValidOwnerId(ownerId);
    if (!proposalId || typeof proposalId !== "string") {
      throw new Error("proposalId must be a non-empty string");
    }

    return this.withMutex(async () => {
      this.archiveActiveRigIfExpired();

      if (!this.activeRig || this.activeRig.getStatus() !== "running") {
        throw new Error("Cannot stage: no active rig running in this workspace");
      }

      this.assertRigOwner(ownerId);

      if (!this.cachedProposals.has(proposalId)) {
        throw new Error(
          `Proposal "${proposalId}" not found in last server-side proposals set. Refresh proposals.`
        );
      }

      const staged = this.activeRig.stageAction(ownerId, proposalId);
      this.cachedStagedAction = staged;

      const observation = this.activeRig.observe(ownerId);
      const humanReadableEffect = formatHumanReadableEffect(
        staged.actionType,
        staged.parameters,
        observation.measuredCounters.activeWorkers + observation.measuredCounters.pausedWorkers
      );

      return {
        staged: deepClone(staged),
        observation: deepClone(observation),
        humanReadableEffect,
      };
    });
  }

  /**
   * Confirm and apply a staged action by stageId.
   * Returns actual result and refreshed observation.
   * Uncertain effects are not automatically retried.
   */
  public async apply(ownerId: string, stageId: string): Promise<RigWorkspaceApplyResult> {
    this.assertValidOwnerId(ownerId);
    if (!stageId || typeof stageId !== "string") {
      throw new Error("stageId must be a non-empty string");
    }

    return this.withMutex(async () => {
      this.archiveActiveRigIfExpired();

      if (!this.activeRig) {
        throw new Error("Cannot apply: no active rig in this workspace");
      }

      this.assertRigOwner(ownerId);

      const result = await this.activeRig.apply(ownerId, stageId);
      if (result.kind === "applied") {
        this.cachedStagedAction = null;
      }

      const observation = this.activeRig.observe(ownerId);

      return {
        result: deepClone(result),
        observation: deepClone(observation),
      };
    });
  }

  /**
   * Inject named database pressure (reserves extra handles to 90 / parent total 91).
   */
  public async injectPressure(ownerId: string): Promise<RigWorkspacePressureResult> {
    this.assertValidOwnerId(ownerId);

    return this.withMutex(async () => {
      this.archiveActiveRigIfExpired();

      if (!this.activeRig || this.activeRig.getStatus() !== "running") {
        throw new Error("Cannot inject pressure: rig is not running");
      }

      this.assertRigOwner(ownerId);
      this.activeRig.injectPressure(ownerId);
      const observation = this.activeRig.observe(ownerId);

      return {
        success: true,
        observation: deepClone(observation),
      };
    });
  }

  /**
   * Close active rig and archive final snapshots into history.
   */
  public async close(ownerId: string): Promise<RigWorkspaceCloseResult> {
    this.assertValidOwnerId(ownerId);

    return this.withMutex(async () => {
      if (!this.activeRig) {
        throw new Error("Cannot close: no active rig in this workspace");
      }

      this.assertRigOwner(ownerId);

      await this.activeRig.close();
      const finalObservation = this.activeRig.observe(ownerId);
      const finalEvidence = this.activeRig.exportEvidence(ownerId);

      this.recordHistory(ownerId, finalObservation, finalEvidence);

      this.activeRig = null;
      this.activeOwnerId = null;
      this.activeStartedAt = 0;
      this.cachedProposals.clear();
      this.cachedStagedAction = null;

      return {
        success: true,
        finalObservation: deepClone(finalObservation),
        finalEvidence: deepClone(finalEvidence),
      };
    });
  }

  /**
   * Export evidence bundle. Works during active run or after close/expiry for recent runs.
   */
  public async evidence(ownerId: string): Promise<RigEvidenceBundle> {
    this.assertValidOwnerId(ownerId);

    return this.withMutex(async () => {
      if (this.activeRig) {
        this.assertRigOwner(ownerId);
        return this.activeRig.exportEvidence(ownerId);
      }

      // Search history for last run matching ownerId
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].ownerId === ownerId) {
          return deepClone(this.history[i].finalEvidence);
        }
      }

      throw new Error("No evidence found for caller (owner mismatch or no recorded run)");
    });
  }

  /**
   * Complete workspace shutdown. Closes any active rig and cleans temporary dirs.
   */
  public async shutdown(): Promise<void> {
    return this.withMutex(async () => {
      if (this.activeRig) {
        try {
          await this.activeRig.close();
        } catch {}
        this.activeRig = null;
      }
      this.activeOwnerId = null;
      this.activeStartedAt = 0;
      this.cachedProposals.clear();
      this.cachedStagedAction = null;

      for (const dir of this.allTempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
      this.allTempDirs.length = 0;
    });
  }
}
