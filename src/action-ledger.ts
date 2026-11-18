/**
 * Append-only action ledger.
 * Records every Action confirmation and execution, enforcing single-use.
 *
 * SPEC-REVIEW-002 §5: The ledger stores ActionConfirmation records so the
 * Executor can verify that an Action was derived from a recorded confirmation,
 * not caller-constructed with an arbitrary payload.
 */

import type { Action, ActionConfirmation } from "./types.js";

export type LedgerEntryStatus = "confirmed" | "consumed" | "rejected-duplicate" | "rejected-stale" | "rejected-unconfirmed";

export interface LedgerEntry {
  actionId: string;
  proposalId: string;
  payloadDigest: string;
  basisRevision: number;
  basisDigest: string;
  confirmedAt: number; // tick
  status: LedgerEntryStatus;
  executedAt?: number; // tick, set when status becomes "consumed"
}

export class ActionLedger {
  private readonly _entries = new Map<string, LedgerEntry>();
  private readonly _confirmations = new Map<string, ActionConfirmation>();

  /**
   * Record a confirmation for a proposal.
   * This must be called (by RecoveryCore.approve) before the Action can be executed.
   */
  recordConfirmation(confirmation: ActionConfirmation): void {
    if (this._confirmations.has(confirmation.actionId)) {
      throw new Error(
        `ActionLedger: confirmation already recorded for actionId ${confirmation.actionId}`
      );
    }
    this._confirmations.set(confirmation.actionId, Object.freeze({ ...confirmation }));

    // Also create a ledger entry in "confirmed" state.
    const entry: LedgerEntry = {
      actionId: confirmation.actionId,
      proposalId: confirmation.proposalId,
      payloadDigest: confirmation.payloadDigest,
      basisRevision: confirmation.basisRevision,
      basisDigest: confirmation.basisDigest,
      confirmedAt: confirmation.confirmedAt,
      status: "confirmed",
    };
    this._entries.set(confirmation.actionId, entry);
  }

  /**
   * Retrieve a recorded confirmation, if present.
   */
  getConfirmation(actionId: string): ActionConfirmation | undefined {
    return this._confirmations.get(actionId);
  }

  /**
   * Submit an action for tracking. Called by the Executor before applying.
   * Returns the entry if the action is new and unconfirmed-check passes; throws on duplicate.
   */
  submit(action: Action): LedgerEntry {
    const existing = this._entries.get(action.actionId);
    if (existing) {
      throw new DuplicateActionError(action.actionId);
    }
    // No entry yet — create one (should have been created by recordConfirmation).
    // This path only reached if confirmation wasn't recorded.
    throw new UnconfirmedActionError(action.actionId, "no confirmation record found");
  }

  /**
   * Check whether an action ID already has an entry in the ledger.
   */
  has(actionId: string): boolean {
    return this._entries.has(actionId);
  }

  /**
   * Check whether an action ID has been consumed (successfully executed).
   */
  isConsumed(actionId: string): boolean {
    return this._entries.get(actionId)?.status === "consumed";
  }

  /**
   * Mark an action ID as consumed (called by Executor on successful apply).
   */
  markConsumed(actionId: string, executedAt: number): void {
    const entry = this._entries.get(actionId);
    if (!entry) {
      throw new Error(`ActionLedger: no entry for actionId ${actionId}`);
    }
    if (entry.status === "consumed") {
      throw new Error(`ActionLedger: actionId ${actionId} is already consumed`);
    }
    this._entries.set(actionId, { ...entry, status: "consumed", executedAt });
  }

  /**
   * Mark an action ID with a rejection status.
   * CORE-REVIEW-003 §2: never downgrade a consumed entry — once consumed, always consumed.
   * A third submission after consumed+stale must still be rejected as duplicate/consumed.
   */
  markRejected(actionId: string, status: "rejected-duplicate" | "rejected-stale" | "rejected-unconfirmed"): void {
    const entry = this._entries.get(actionId);
    if (!entry) {
      // No confirmation entry yet — create a minimal tombstone so has() returns true.
      this._entries.set(actionId, {
        actionId,
        proposalId: "",
        payloadDigest: "",
        basisRevision: 0,
        basisDigest: "",
        confirmedAt: 0,
        status,
      });
      return;
    }
    // Never downgrade consumed to any rejection status.
    if (entry.status === "consumed") {
      return;
    }
    this._entries.set(actionId, { ...entry, status });
  }

  /** All entries (read-only). */
  get entries(): ReadonlyMap<string, LedgerEntry> {
    return this._entries;
  }
}

export class DuplicateActionError extends Error {
  constructor(public readonly actionId: string) {
    super(`Duplicate action: ${actionId}`);
    this.name = "DuplicateActionError";
  }
}

export class UnconfirmedActionError extends Error {
  constructor(public readonly actionId: string, detail: string) {
    super(`Unconfirmed action ${actionId}: ${detail}`);
    this.name = "UnconfirmedActionError";
  }
}
