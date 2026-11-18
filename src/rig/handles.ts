/**
 * handles.ts — Managed SQLite handle tracking and budget policy for the M4 Process Rig.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md §3):
 * - Lab declares its own 100-handle DB budget.
 * - Count actual resources, including durable queue's 1 SQLite handle.
 * - Initial parent TOTAL: 45 (1 queue + 44 extra pool), worker 3 = 48.
 * - Pressure parent TOTAL: 91 (1 queue + 90 extra pool), worker 3 = 94.
 * - Extra pools are 44 and 90 respectively.
 * - Count only verified live child handle reports; exited workers contribute 0.
 * - Scale 1 to 4 is 57 before pressure, 103 after (must reject).
 * - Never synthesize claimed actual counts from workers.size.
 * - Evidence labels must say "managed SQLite handles".
 */

import { DatabaseSync } from "node:sqlite";
import { RIG_LIMITS } from "./types.js";

export class HandleManager {
  private readonly parentHandles: DatabaseSync[] = [];
  private _pressureInjected: boolean = false;
  private queueOpenCheck: () => boolean;

  constructor(queueOpenCheck: () => boolean = () => true) {
    this.queueOpenCheck = queueOpenCheck;
    this.openHandles(RIG_LIMITS.EXTRA_POOL_INITIAL); // 44 handles
  }

  private openHandles(count: number): void {
    for (let i = 0; i < count; i++) {
      this.parentHandles.push(new DatabaseSync(":memory:"));
    }
  }

  public get extraPoolHandleCount(): number {
    return this.parentHandles.length;
  }

  public get parentTotalHandleCount(): number {
    const queueHandle = this.queueOpenCheck() ? 1 : 0;
    return queueHandle + this.parentHandles.length;
  }

  public get isPressureInjected(): boolean {
    return this._pressureInjected;
  }

  /**
   * Inject named database pressure: reserves extra pool handles so that
   * parent pool has 90 handles (parent total 91 including queue).
   */
  public injectPressure(): void {
    if (this._pressureInjected) {
      return;
    }
    const needed = RIG_LIMITS.EXTRA_POOL_PRESSURE - this.parentHandles.length;
    if (needed > 0) {
      this.openHandles(needed);
    }
    this._pressureInjected = true;
  }

  /**
   * Return the actual current total of managed SQLite handles:
   * parent total handles + verified live worker handle reports.
   * Exited workers contribute 0.
   */
  public getManagedSqliteHandles(verifiedLiveWorkerHandles: number): number {
    return this.parentTotalHandleCount + verifiedLiveWorkerHandles;
  }

  /**
   * Calculate projected managed SQLite handles if worker count changes.
   */
  public projectHandles(liveWorkerCount: number, additionalWorkers: number): number {
    const targetWorkers = liveWorkerCount + additionalWorkers;
    return this.parentTotalHandleCount + targetWorkers * RIG_LIMITS.HANDLES_PER_WORKER;
  }

  /**
   * Check if a proposed worker addition is within the 100-handle lab budget.
   */
  public checkFeasibility(liveWorkerCount: number, additionalWorkers: number): {
    feasible: boolean;
    projectedHandles: number;
    budget: number;
    reason: string;
  } {
    const projected = this.projectHandles(liveWorkerCount, additionalWorkers);
    const budget = RIG_LIMITS.MAX_DB_HANDLE_BUDGET;
    const feasible = projected <= budget;
    const reason = feasible
      ? `Projected managed SQLite handles (${projected}/${budget}) within lab limit`
      : `Projected managed SQLite handles (${projected}/${budget}) exceeds lab budget of ${budget}`;
    return {
      feasible,
      projectedHandles: projected,
      budget,
      reason,
    };
  }

  /**
   * Close all deliberately reserved parent SQLite handles.
   */
  public close(): void {
    while (this.parentHandles.length > 0) {
      const handle = this.parentHandles.pop();
      try {
        handle?.close();
      } catch {
        // Ignored on teardown
      }
    }
  }
}
