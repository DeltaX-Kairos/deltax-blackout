/**
 * queue.ts — Durable node:sqlite parent job queue for the M4 Process Rig.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md §2, §3, §4):
 * - Durable SQLite parent queue using Node 22 built-in node:sqlite.
 * - Jobs contain only fixed-size fictional workload.
 * - Maximum capacity: 64 jobs per run.
 * - Persists queued, in-flight, completed, failed, and unknown records.
 * - Restart recovery: pending rows survive restart; inflight rows after uncertain
 *   termination become unknown and must not be blindly re-executed.
 * - Guard against late IPC/exit callbacks writing to a closed DB.
 * - Expose open state and job summaries for material projection.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { RigJobRecord, RigJobStatus } from "./types.js";
import type { QueueJobSummary } from "./digest.js";
import { RIG_LIMITS } from "./types.js";

export interface QueueCounters {
  total: number;
  pending: number;
  inFlight: number;
  completed: number;
  failed: number;
  unknown: number;
}

export class DurableQueue {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private _isOpen: boolean = true;
  private lastKnownJobs: RigJobRecord[] = [];

  constructor(location: string = ":memory:") {
    this.dbPath = location;
    this.db = new DatabaseSync(location);
    this.initSchema();
    this.reconcileInflightOnStartup();
  }

  public isOpen(): boolean {
    return this._isOpen;
  }

  private initSchema(): void {
    if (!this._isOpen) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rig_jobs (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        worker_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        result_hash TEXT,
        error_detail TEXT
      );
    `);
  }

  /**
   * On startup or recovery, any job that was in_flight when the parent process
   * or worker stopped is transitioned to unknown.
   * "inflight rows after uncertain termination become unknown and must not be blindly re-executed."
   */
  public reconcileInflightOnStartup(): number {
    if (!this._isOpen) return 0;
    const stmt = this.db.prepare(`
      UPDATE rig_jobs
      SET status = 'unknown',
          error_detail = 'reconciled after uncertain termination',
          completed_at = ?
      WHERE status = 'in_flight';
    `);
    const res = stmt.run(Date.now());
    return Number(res.changes);
  }

  /**
   * Enqueue a new fixed fictional job. Enforces the hard 64-job cap.
   * Returns true if admitted, false if cap was reached or queue is closed.
   */
  public enqueue(id: string, payload: string): boolean {
    if (!this._isOpen) return false;

    const countStmt = this.db.prepare("SELECT COUNT(*) AS count FROM rig_jobs;");
    const countRow = countStmt.get() as { count: number | bigint };
    const currentCount = Number(countRow.count);

    if (currentCount >= RIG_LIMITS.MAX_JOBS) {
      return false;
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO rig_jobs (id, payload, status, worker_id, created_at)
      VALUES (?, ?, 'pending', NULL, ?);
    `);
    insertStmt.run(id, payload, Date.now());
    return true;
  }

  /**
   * Claim the oldest pending job for a specific worker, atomically setting
   * its status to in_flight.
   */
  public claimNextPending(workerId: string): RigJobRecord | null {
    if (!this._isOpen) return null;

    const selectStmt = this.db.prepare(`
      SELECT id, payload, status, worker_id, created_at, started_at, completed_at, result_hash, error_detail
      FROM rig_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1;
    `);
    const row = selectStmt.get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const jobId = String(row["id"]);
    const now = Date.now();
    const updateStmt = this.db.prepare(`
      UPDATE rig_jobs
      SET status = 'in_flight',
          worker_id = ?,
          started_at = ?
      WHERE id = ? AND status = 'pending';
    `);
    const result = updateStmt.run(workerId, now, jobId);
    if (Number(result.changes) === 0) {
      return null;
    }

    return {
      id: jobId,
      payload: String(row["payload"]),
      status: "in_flight",
      workerId,
      createdAt: Number(row["created_at"]),
      startedAt: now,
      completedAt: null,
      resultHash: null,
      errorDetail: null,
    };
  }

  /**
   * Mark an in-flight job as completed with its cryptographic hash result.
   */
  public markCompleted(id: string, resultHash: string): void {
    if (!this._isOpen) return;

    const stmt = this.db.prepare(`
      UPDATE rig_jobs
      SET status = 'completed',
          result_hash = ?,
          completed_at = ?
      WHERE id = ?;
    `);
    stmt.run(resultHash, Date.now(), id);
  }

  /**
   * Mark a job as failed.
   */
  public markFailed(id: string, errorDetail: string): void {
    if (!this._isOpen) return;

    const sanitized = String(errorDetail).replace(/(?:\/[a-zA-Z0-9._-]+)+/g, "[redacted-path]");
    const stmt = this.db.prepare(`
      UPDATE rig_jobs
      SET status = 'failed',
          error_detail = ?,
          completed_at = ?
      WHERE id = ?;
    `);
    stmt.run(sanitized, Date.now(), id);
  }

  /**
   * Mark a job as unknown after an uncertain outcome (e.g. child crash/exit while in-flight).
   * Uncertain jobs are never blindly re-executed.
   */
  public markUnknown(id: string, reason: string): void {
    if (!this._isOpen) return;

    const sanitized = String(reason).replace(/(?:\/[a-zA-Z0-9._-]+)+/g, "[redacted-path]");
    const stmt = this.db.prepare(`
      UPDATE rig_jobs
      SET status = 'unknown',
          error_detail = ?,
          completed_at = ?
      WHERE id = ?;
    `);
    stmt.run(sanitized, Date.now(), id);
  }

  /**
   * Retrieve aggregate job status counters.
   */
  public getCounters(): QueueCounters {
    if (!this._isOpen) {
      const counters: QueueCounters = {
        total: 0,
        pending: 0,
        inFlight: 0,
        completed: 0,
        failed: 0,
        unknown: 0,
      };
      for (const j of this.lastKnownJobs) {
        counters.total++;
        if (j.status === "pending") counters.pending++;
        else if (j.status === "in_flight") counters.inFlight++;
        else if (j.status === "completed") counters.completed++;
        else if (j.status === "failed") counters.failed++;
        else if (j.status === "unknown") counters.unknown++;
      }
      return counters;
    }

    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM rig_jobs
      GROUP BY status;
    `).all() as Array<{ status: string; count: number | bigint }>;

    const counters: QueueCounters = {
      total: 0,
      pending: 0,
      inFlight: 0,
      completed: 0,
      failed: 0,
      unknown: 0,
    };

    for (const r of rows) {
      const cnt = Number(r.count);
      counters.total += cnt;
      if (r.status === "pending") counters.pending += cnt;
      else if (r.status === "in_flight") counters.inFlight += cnt;
      else if (r.status === "completed") counters.completed += cnt;
      else if (r.status === "failed") counters.failed += cnt;
      else if (r.status === "unknown") counters.unknown += cnt;
    }

    return counters;
  }

  /**
   * Retrieve all jobs ordered by created_at.
   */
  public getAllJobs(): RigJobRecord[] {
    if (!this._isOpen) {
      return [...this.lastKnownJobs];
    }

    const rows = this.db.prepare(`
      SELECT id, payload, status, worker_id, created_at, started_at, completed_at, result_hash, error_detail
      FROM rig_jobs
      ORDER BY created_at ASC;
    `).all() as Array<Record<string, unknown>>;

    const jobs = rows.map((r) => ({
      id: String(r["id"]),
      payload: String(r["payload"]),
      status: r["status"] as RigJobStatus,
      workerId: r["worker_id"] ? String(r["worker_id"]) : null,
      createdAt: Number(r["created_at"]),
      startedAt: r["started_at"] !== null ? Number(r["started_at"]) : null,
      completedAt: r["completed_at"] !== null ? Number(r["completed_at"]) : null,
      resultHash: r["result_hash"] !== null ? String(r["result_hash"]) : null,
      errorDetail: r["error_detail"] !== null ? String(r["error_detail"]) : null,
    }));

    this.lastKnownJobs = jobs;
    return jobs;
  }

  public getJobSummaries(): QueueJobSummary[] {
    const jobs = this.getAllJobs();
    return jobs.map((j) => ({
      id: j.id,
      status: j.status,
      payloadHash: createHash("sha256").update(j.payload, "utf8").digest("hex"),
      resultHash: j.resultHash,
    }));
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public close(): void {
    if (!this._isOpen) return;
    try {
      this.getAllJobs(); // Cache final snapshot before closing
    } catch {}
    this._isOpen = false;
    try {
      this.db.close();
    } catch {
      // Ignored if already closed
    }
  }
}
