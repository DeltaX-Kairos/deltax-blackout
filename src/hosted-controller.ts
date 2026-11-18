/**
 * HostedController — orchestrates DeltaX Evaluate hosted review boundary.
 *
 * Requirements (WORKSPACE-FINISH-SPEC.md & CONTROLLER-REVIEW-010.md):
 * 1. Server owns bindings and candidates.
 * 2. Uses actual HostedReviewClient.evaluate(request, binding) and ReviewResult.
 * 3. Bounded verification activities (e.g. 'Validate the proposed scaling plan...')
 *    not simply prefixing execution commands with Analyze.
 * 4. Objective selects the next verification activity, not executing repair.
 * 5. Caller-reported support preserved unchanged as labelled fixture input.
 * 6. Local feasibility gate failure uses 'all_local_candidates_infeasible', zero provider spend.
 * 7. After selection, runs and stores a fresh local inspect report for the bound proposal.
 * 8. Configured mode enabled ONLY when BLACKOUT_ENABLE_HOSTED=true; missing config is
 *    configured-disabled, never silent manual unconfigured fallback.
 * 9. Replays local ledger BEFORE status can report available (read-only, no OAuth).
 * 10. Unknown identity lock survives restart by inspecting persisted unknown OR orphan reserved entries.
 * 11. Execution re-validates the bound selected review identity/status/basis/payload for the exact staged action.
 * 12. Defensive deep copies for all returned controller records and snapshots.
 */

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { canonicalJson } from "./digest.js";
import {
  EVALUATION_PROFILE_ID,
  MAX_TOTAL_ATTEMPTS,
  MAX_PER_SESSION_ATTEMPTS,
  type HostedCandidate,
  type HostedEvaluationRequest,
  type ReviewBinding,
  type ReviewResult,
  type FetchFn,
  type CandidateSemanticClass,
  type EvaluationContext,
  type HostedRawResult,
} from "./hosted/types.js";
import { HostedReviewClient } from "./hosted/client.js";
import { ReservationLedger } from "./hosted/ledger.js";
import { inspectFeasibility } from "./feasibility.js";
import { CEILINGS } from "./types.js";
import type { ScenarioState, Proposal, Action } from "./types.js";

export interface HostedAllowance {
  totalMax: number;
  totalUsed: number;
  sessionMax: number;
  sessionUsed: number;
  sessionRemaining: number;
  activeConcurrent: number;
}

export type HostedStatusType =
  | "unconfigured"
  | "available"
  | "busy"
  | "disabled"
  | "refused"
  | "unknown";

export interface HostedStatusInfo {
  configured: boolean;
  status: HostedStatusType;
  allowance: HostedAllowance;
  active: boolean;
  detail?: string;
  review?: SanitizedReviewRecord | null;
}

export interface LocalInspectReport {
  proposalId: string;
  actionType: string;
  parameters: Record<string, unknown>;
  evaluatedAt: string;
  feasibility: {
    pass: boolean;
    violatedRules: string[];
    resourceProjection?: { observed: number; projected: number; limit: number };
  };
  basisRevision: number;
  basisDigest: string;
}

export interface SanitizedReviewRecord {
  idempotencyKey?: string;
  status: "selected" | "refused" | "unknown" | "rejected" | "disabled";
  outcome?: "selected" | "governed_noop_refusal";
  selectedCandidateId: string | null;
  selectedProposalId: string | null;
  basisRevision: number;
  basisDigest: string;
  payloadDigest?: string;
  evaluatedAt: string;
  receiptId?: string;
  commercialReceiptId?: string;
  traceId?: string;
  reasonCodes?: string[];
  eligibleCandidates: Array<{
    candidateId: string;
    proposalId: string;
    description: string;
    support: number;
  }>;
  rejectedCandidates: Array<{
    proposalId: string;
    violatedRules: string[];
  }>;
  detail?: string;
  source: "hosted_evaluate" | "local_feasibility_gate";
  request?: {
    profile_id: string;
    objective: string;
    context: Record<string, string | number | boolean | null>;
    candidates: HostedCandidate[];
  };
  binding?: {
    idempotencyKey: string;
    sessionId: string;
    basisRevision: number;
    basisDigest: string;
    candidatePayloadHashes: Record<string, string>;
  };
  envelope?: HostedRawResult;
  localInspectReport?: LocalInspectReport;
}

export interface HostedControllerOptions {
  client?: HostedReviewClient;
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  ledgerPath?: string;
  fetch?: FetchFn;
  maxAttempts?: number;
  maxPerSession?: number;
  timeoutMs?: number;
}

/**
 * Builds an authentic verification activity description for candidate proposals.
 * Complies with CONTROLLER-REVIEW-010 §2 (bounded verification activity, not execution command).
 */
export function buildVerificationDescription(proposal: Proposal, state: ScenarioState): string {
  const op = state.operationalState;
  if (op.kind === "queue-storm") {
    if (proposal.actionType === "scale-workers") {
      const target = proposal.parameters.targetWorkerCount ?? 12;
      return `Validate the proposed scaling plan to ${target} workers against current worker count (${op.workerCount}) and the 100-connection lab limit; produce a constraint report without changing services.`.slice(0, 512);
    }
    if (proposal.actionType === "throttle-queue") {
      const cap = proposal.parameters.ingestionRateCap ?? 500;
      return `Validate queue ingestion rate throttle to ${cap} req/tick against arrival rate (${op.arrivalRatePerTick}) and queue depth (${op.queueDepth}); evaluate queue pressure without executing ingestion changes.`.slice(0, 512);
    }
  } else if (op.kind === "database-pressure") {
    if (proposal.actionType === "reduce-connections") {
      const target = proposal.parameters.targetConnectionCount ?? 120;
      return `Validate reducing connection pool ceiling to ${target} against active query latency (${op.queryLatencyMs} ms) and ${op.appServerCount} app servers; assess pool saturation without altering pool settings.`.slice(0, 512);
    }
    if (proposal.actionType === "replica-failover") {
      const avail = (op.replicaAvailability * 100).toFixed(0);
      return `Validate read-replica failover readiness against current replica availability (${avail}%) and query latency (${op.queryLatencyMs} ms); evaluate failover readiness without initiating cluster failover.`.slice(0, 512);
    }
  }
  return `Validate proposal '${proposal.proposalId}' against current operational constraints at revision ${state.revision}; evaluate feasibility and produce a constraint report without modifying running services.`.slice(0, 512);
}

export class HostedController {
  private readonly _client: HostedReviewClient | null = null;
  private readonly _configured: boolean;
  private readonly _configDisabled: boolean;
  private readonly _configDisabledReason: string | null = null;
  private readonly _maxTotalAttempts: number;
  private readonly _maxPerSessionAttempts: number;
  private _isEvaluationPending = false;
  private readonly _identityReviews = new Map<string, SanitizedReviewRecord>();
  private readonly _unknownIdentities = new Set<string>();

  constructor(opts?: HostedControllerOptions) {
    this._maxTotalAttempts = opts?.maxAttempts ?? MAX_TOTAL_ATTEMPTS;
    this._maxPerSessionAttempts = opts?.maxPerSession ?? MAX_PER_SESSION_ATTEMPTS;

    // Injected test client is allowed deliberately
    if (opts?.client) {
      this._client = opts.client;
      this._configured = true;
      this._configDisabled = false;
      return;
    }

    const envEnabled =
      process.env.BLACKOUT_ENABLE_HOSTED === "true" || opts?.enabled === true;

    // Default local mode only when explicit enable is off
    if (!envEnabled) {
      this._configured = false;
      this._configDisabled = false;
      this._client = null;
      return;
    }

    // Explicit enable is ON: must be configured.
    this._configured = true;

    const clientId = opts?.clientId || process.env.BLACKOUT_CLIENT_ID || "";
    const clientSecret = opts?.clientSecret || process.env.BLACKOUT_CLIENT_SECRET || "";
    const ledgerPath = opts?.ledgerPath || process.env.BLACKOUT_LEDGER_PATH || "";

    // BLACKOUT_ENABLE_HOSTED=true with missing credentials/ledger must be configured-disabled,
    // NEVER silent manual unconfigured fallback (CONTROLLER-REVIEW-010 §3).
    if (!clientId || !clientSecret || !ledgerPath) {
      this._configDisabled = true;
      this._configDisabledReason =
        "Missing required hosted configuration: BLACKOUT_CLIENT_ID, BLACKOUT_CLIENT_SECRET, or BLACKOUT_LEDGER_PATH";
      this._client = null;
      return;
    }

    this._configDisabled = false;
    this._client = new HostedReviewClient({
      clientId,
      clientSecret,
      ledgerPath,
      fetch: opts?.fetch ?? (globalThis.fetch as unknown as FetchFn),
      maxAttempts: this._maxTotalAttempts,
      maxPerSession: this._maxPerSessionAttempts,
      timeoutMs: opts?.timeoutMs,
    });
  }

  get isConfigured(): boolean {
    return this._configured;
  }

  get isConfigDisabled(): boolean {
    return this._configDisabled;
  }

  get client(): HostedReviewClient | null {
    return this._client;
  }

  /**
   * Replays the local ledger before status can report available.
   * Read-only, no OAuth or external network calls.
   */
  async ensureInitialized(): Promise<void> {
    if (!this._configured || !this._client) return;
    await this._client.init();
  }

  /**
   * Checks if an identity is locked due to an uncertain / unknown review.
   * Inspects in-memory set, persisted unknown entries, and orphan reservations.
   * Survives restart (CONTROLLER-REVIEW-010 §4).
   */
  isIdentityLocked(clientIdentity: string): { locked: boolean; reason?: string } {
    if (this._unknownIdentities.has(clientIdentity)) {
      return {
        locked: true,
        reason: "Session identity has an uncertain review outcome; further evaluation is blocked",
      };
    }

    if (this._client) {
      try {
        const entries = this._client.ledger.getEntries();
        const identityEntries = entries.filter((e) => e.sessionId === clientIdentity);

        // 1. Terminal unknown state
        if (identityEntries.some((e) => e.state === "unknown")) {
          this._unknownIdentities.add(clientIdentity);
          return {
            locked: true,
            reason: "Persisted ledger contains an unknown review outcome for this session identity; further evaluation is blocked",
          };
        }

        // 2. Orphan reservation (reserved without terminal state)
        const reservedKeys = new Set(
          identityEntries.filter((e) => e.state === "reserved").map((e) => e.idempotencyKey)
        );
        const terminalKeys = new Set(
          identityEntries
            .filter((e) => e.state === "selected" || e.state === "refused" || e.state === "unknown" || e.state === "error")
            .map((e) => e.idempotencyKey)
        );
        for (const k of reservedKeys) {
          if (!terminalKeys.has(k)) {
            this._unknownIdentities.add(clientIdentity);
            return {
              locked: true,
              reason: "Persisted ledger contains an unfinalized reservation that lacked terminal persistence; outcome remains uncertain and further evaluation is blocked",
            };
          }
        }
      } catch {
        // Inaccessible ledger disables live status
      }
    }

    return { locked: false };
  }

  /**
   * Read-only status check.
   * Replays local ledger BEFORE status can say available (read-only, no OAuth).
   * Missing, empty, or corrupt ledger disables rather than swallowing as healthy zero usage.
   * NEVER calls OAuth or evaluation provider endpoints.
   */
  async getStatus(clientIdentity?: string): Promise<HostedStatusInfo> {
    if (!this._configured) {
      return {
        configured: false,
        status: "unconfigured",
        allowance: {
          totalMax: this._maxTotalAttempts,
          totalUsed: 0,
          sessionMax: this._maxPerSessionAttempts,
          sessionUsed: 0,
          sessionRemaining: this._maxPerSessionAttempts,
          activeConcurrent: 0,
        },
        active: false,
        review: clientIdentity ? this.getReview(clientIdentity) : null,
      };
    }

    if (this._configDisabled || !this._client) {
      return {
        configured: true,
        status: "disabled",
        allowance: {
          totalMax: this._maxTotalAttempts,
          totalUsed: 0,
          sessionMax: this._maxPerSessionAttempts,
          sessionUsed: 0,
          sessionRemaining: 0,
          activeConcurrent: 0,
        },
        active: false,
        detail: this._configDisabledReason || "Hosted review configuration disabled",
        review: clientIdentity ? this.getReview(clientIdentity) : null,
      };
    }

    // Replay local ledger before status can say available
    await this.ensureInitialized();

    if (this._client.isDisabled) {
      return {
        configured: true,
        status: "disabled",
        allowance: {
          totalMax: this._maxTotalAttempts,
          totalUsed: 0,
          sessionMax: this._maxPerSessionAttempts,
          sessionUsed: 0,
          sessionRemaining: 0,
          activeConcurrent: 0,
        },
        active: false,
        detail: "Hosted review ledger is missing or corrupt: live mode disabled",
        review: clientIdentity ? this.getReview(clientIdentity) : null,
      };
    }

    const ledger = this._client.ledger;
    let totalUsed = 0;
    let sessionUsed = 0;
    let hasActive = false;

    try {
      totalUsed = ledger.countTotalAttempts();
      sessionUsed = clientIdentity ? ledger.countSessionAttempts(clientIdentity) : 0;
      hasActive = ledger.hasActiveReservation();
    } catch {
      return {
        configured: true,
        status: "disabled",
        allowance: {
          totalMax: this._maxTotalAttempts,
          totalUsed: 0,
          sessionMax: this._maxPerSessionAttempts,
          sessionUsed: 0,
          sessionRemaining: 0,
          activeConcurrent: 0,
        },
        active: false,
        detail: "Ledger read error: live mode disabled",
        review: clientIdentity ? this.getReview(clientIdentity) : null,
      };
    }

    const isBusy = hasActive || this._isEvaluationPending;
    const remaining = Math.max(0, this._maxPerSessionAttempts - sessionUsed);

    let status: HostedStatusType = "available";
    if (clientIdentity && this.isIdentityLocked(clientIdentity).locked) {
      status = "unknown";
    } else if (isBusy) {
      status = "busy";
    } else if (sessionUsed >= this._maxPerSessionAttempts || totalUsed >= this._maxTotalAttempts) {
      status = "disabled";
    }

    const review = clientIdentity ? this.getReview(clientIdentity) : null;

    return {
      configured: true,
      status,
      allowance: {
        totalMax: this._maxTotalAttempts,
        totalUsed,
        sessionMax: this._maxPerSessionAttempts,
        sessionUsed,
        sessionRemaining: remaining,
        activeConcurrent: hasActive || this._isEvaluationPending ? 1 : 0,
      },
      active: isBusy,
      review,
    };
  }

  /**
   * Retrieves the current review record for a cookie identity, if any.
   * Returns a defensive deep copy.
   */
  getReview(clientIdentity: string): SanitizedReviewRecord | null {
    const r = this._identityReviews.get(clientIdentity);
    if (!r) return null;
    return JSON.parse(JSON.stringify(r));
  }

  /**
   * Checks whether a staging request (approve) is allowed under current review rules.
   */
  validateStageAllowed(
    clientIdentity: string,
    proposal: Proposal,
    currentState: ScenarioState
  ): { allowed: boolean; reason?: string } {
    if (!this._configured) {
      return { allowed: true };
    }

    if (this._configDisabled) {
      return {
        allowed: false,
        reason: "Hosted review is configured but disabled; staging is blocked",
      };
    }

    const lock = this.isIdentityLocked(clientIdentity);
    if (lock.locked) {
      return { allowed: false, reason: lock.reason };
    }

    const review = this._identityReviews.get(clientIdentity);
    if (!review) {
      return {
        allowed: false,
        reason: "Hosted review is configured: a matching selected hosted review is required before staging.",
      };
    }

    if (review.status === "refused" || review.outcome === "governed_noop_refusal") {
      return {
        allowed: false,
        reason: "Review was refused by governance gates; cannot stage.",
      };
    }

    if (review.status === "unknown") {
      return {
        allowed: false,
        reason: "Review outcome is unknown; new operations are blocked.",
      };
    }

    if (review.status !== "selected") {
      return {
        allowed: false,
        reason: `Cannot stage: review status is ${review.status}.`,
      };
    }

    if (review.selectedProposalId !== proposal.proposalId) {
      return {
        allowed: false,
        reason: `Cannot stage proposal '${proposal.proposalId}': hosted review selected '${review.selectedProposalId}'.`,
      };
    }

    if (
      review.basisRevision !== currentState.revision ||
      review.basisDigest !== currentState.basisDigest
    ) {
      return {
        allowed: false,
        reason: "Hosted review basis is stale against current state. Re-evaluate required.",
      };
    }

    if (review.payloadDigest && review.payloadDigest !== proposal.payloadDigest) {
      return {
        allowed: false,
        reason: "Payload digest mismatch between hosted review binding and proposal.",
      };
    }

    return { allowed: true };
  }

  /**
   * Re-validates the bound selected review identity, status, basis, and payload
   * for the exact staged action at execution time (CONTROLLER-REVIEW-010 §5).
   * A new refused or rejected review invalidates the old staged action.
   */
  validateExecutionAllowed(
    clientIdentity: string,
    action: Action,
    currentState: ScenarioState
  ): { allowed: boolean; reason?: string } {
    if (!this._configured) {
      return { allowed: true };
    }

    if (this._configDisabled) {
      return {
        allowed: false,
        reason: "Hosted review is configured but disabled: execution is blocked",
      };
    }

    const lock = this.isIdentityLocked(clientIdentity);
    if (lock.locked) {
      return { allowed: false, reason: lock.reason };
    }

    const review = this._identityReviews.get(clientIdentity);
    if (!review) {
      return {
        allowed: false,
        reason: "Hosted review is configured: a matching selected hosted review is required before execution",
      };
    }

    if (review.status === "refused" || review.outcome === "governed_noop_refusal") {
      return {
        allowed: false,
        reason: "Current hosted review is refused by governance gates; execution cannot proceed",
      };
    }

    if (review.status === "unknown") {
      return {
        allowed: false,
        reason: "Current hosted review outcome is unknown; execution is blocked",
      };
    }

    if (review.status !== "selected") {
      return {
        allowed: false,
        reason: `Cannot execute: current hosted review status is '${review.status}'`,
      };
    }

    if (review.selectedProposalId !== action.proposalId) {
      return {
        allowed: false,
        reason: `Staged action proposal '${action.proposalId}' does not match current selected review proposal '${review.selectedProposalId}'`,
      };
    }

    if (
      review.basisRevision !== action.basisRevision ||
      review.basisDigest !== action.basisDigest
    ) {
      return {
        allowed: false,
        reason: "Staged action review basis does not match action basis",
      };
    }

    if (review.payloadDigest && review.payloadDigest !== action.payloadDigest) {
      return {
        allowed: false,
        reason: "Payload digest mismatch between hosted review binding and staged action",
      };
    }

    return { allowed: true };
  }

  /**
   * Evaluates candidate actions using HostedReviewClient.
   *
   * Rules:
   * - Derives fixed request from current server state and cached proposals.
   * - Filters candidates with local feasibility rules; 0 eligible means local refusal with 'all_local_candidates_infeasible' and NO provider call.
   * - Sends eligible review activities (semantic class 'analyze') with authentic verification descriptions.
   * - Objective chooses next verification activity, not executing repair.
   * - Caller-reported support preserved unchanged as labelled fixture input.
   * - Persists reservation and validated response in ledger.
   * - After selection, runs and stores a fresh local inspect report for that bound proposal.
   */
  async evaluate(params: {
    clientIdentity: string;
    state: ScenarioState;
    proposals: Proposal[];
  }): Promise<SanitizedReviewRecord> {
    const { clientIdentity, state, proposals } = params;

    if (!this._configured) {
      throw new Error("Hosted review is unconfigured in local demo mode");
    }

    if (this._configDisabled || !this._client) {
      throw new Error(
        this._configDisabledReason || "Hosted review configuration is disabled"
      );
    }

    await this.ensureInitialized();

    if (this._client.isDisabled) {
      throw new Error("Hosted review client is disabled: missing or corrupt ledger");
    }

    const lock = this.isIdentityLocked(clientIdentity);
    if (lock.locked) {
      throw new Error(lock.reason);
    }

    if (this._isEvaluationPending || this._client.ledger.hasActiveReservation()) {
      throw new Error(
        "Another evaluation is currently in flight. Max 1 active concurrent evaluation allowed."
      );
    }

    const sessionUsed = this._client.ledger.countSessionAttempts(clientIdentity);
    if (sessionUsed >= this._maxPerSessionAttempts) {
      throw new Error(
        `Session evaluation budget exceeded: ${sessionUsed} attempts recorded (max ${this._maxPerSessionAttempts} per session identity).`
      );
    }

    const totalUsed = this._client.ledger.countTotalAttempts();
    if (totalUsed >= this._maxTotalAttempts) {
      throw new Error(
        `Total evaluation budget exceeded: ${totalUsed} attempts recorded (max ${this._maxTotalAttempts}).`
      );
    }

    if (state.status !== "running") {
      throw new Error("Cannot evaluate on a terminated scenario.");
    }

    // Step 1: Filter with local feasibility rules
    const candidateMap = new Map<
      string,
      { proposal: Proposal; feasible: boolean; violatedRules: string[] }
    >();
    const eligibleProposals: Proposal[] = [];
    const rejectedList: Array<{ proposalId: string; violatedRules: string[] }> = [];

    for (const p of proposals) {
      const feas = inspectFeasibility(p, state);
      candidateMap.set(p.proposalId, {
        proposal: p,
        feasible: feas.pass,
        violatedRules: feas.violatedRules,
      });
      if (feas.pass) {
        eligibleProposals.push(p);
      } else {
        rejectedList.push({
          proposalId: p.proposalId,
          violatedRules: feas.violatedRules,
        });
      }
    }

    // 0 eligible means local refusal with 'all_local_candidates_infeasible' and NO provider call (CONTROLLER-REVIEW-010 §2)
    if (eligibleProposals.length === 0) {
      const localRefusal: SanitizedReviewRecord = {
        status: "refused",
        outcome: "governed_noop_refusal",
        selectedCandidateId: null,
        selectedProposalId: null,
        basisRevision: state.revision,
        basisDigest: state.basisDigest,
        evaluatedAt: new Date().toISOString(),
        eligibleCandidates: [],
        rejectedCandidates: rejectedList,
        detail: "all_local_candidates_infeasible",
        source: "local_feasibility_gate",
      };
      this._identityReviews.set(clientIdentity, localRefusal);
      return JSON.parse(JSON.stringify(localRefusal));
    }

    // Step 2: Build verification candidates
    const candidateToProposal = new Map<string, Proposal>();
    const candidates: HostedCandidate[] = eligibleProposals.slice(0, 8).map((p) => {
      const safeCandId = `cand_${p.proposalId.replace(/[^A-Za-z0-9._~-]/g, "_")}`.slice(0, 64);
      candidateToProposal.set(safeCandId, p);
      return {
        candidate_id: safeCandId,
        semantic_class: "analyze" as CandidateSemanticClass,
        description: buildVerificationDescription(p, state),
        // Preserve original caller-reported support unchanged (CONTROLLER-REVIEW-010 §2)
        operator_reported_support: p.operatorReportedSupport,
      };
    });

    const context: EvaluationContext = {
      scenario_id: state.scenarioId,
      observation_revision: state.revision,
      observation_digest: state.basisDigest,
      telemetry_kind: state.operationalState.kind,
      tick: state.tick,
    };

    if (state.operationalState.kind === "queue-storm") {
      context.queue_depth = state.operationalState.queueDepth;
      context.error_rate = state.operationalState.errorRate;
      context.worker_count = state.operationalState.workerCount;
      context.db_connections = state.operationalState.dbConnectionCount;
    } else if (state.operationalState.kind === "database-pressure") {
      context.app_servers = state.operationalState.appServerCount;
      context.connection_count = state.operationalState.connectionCount;
      context.query_latency_ms = state.operationalState.queryLatencyMs;
      context.error_rate = state.operationalState.errorRate;
      context.replica_availability = state.operationalState.replicaAvailability;
    }

    const request: HostedEvaluationRequest = {
      profile_id: EVALUATION_PROFILE_ID,
      objective: `Select the bounded verification activity to evaluate remediation feasibility without executing changes at revision ${state.revision}`,
      context,
      candidates,
    };

    // Step 3: Build server-owned ReviewBinding
    const idempotencyKey = createHash("sha256")
      .update(
        `${clientIdentity}:${state.scenarioId}:${state.revision}:${state.basisDigest}:${Date.now()}:${randomBytes(8).toString("hex")}`
      )
      .digest("hex")
      .slice(0, 32);

    const candidatePayloadHashes: Record<string, string> = {};
    for (let i = 0; i < candidates.length; i++) {
      candidatePayloadHashes[candidates[i].candidate_id] = eligibleProposals[i].payloadDigest;
    }

    const binding: ReviewBinding = {
      idempotencyKey,
      sessionId: clientIdentity,
      basisRevision: state.revision,
      basisDigest: state.basisDigest,
      candidatePayloadHashes,
    };

    // Step 4: Dispatch via HostedReviewClient
    this._isEvaluationPending = true;
    let result: ReviewResult;
    try {
      result = await this._client.evaluate(request, binding);
    } finally {
      this._isEvaluationPending = false;
    }

    const eligibleSummaries = candidates.map((c) => ({
      candidateId: c.candidate_id,
      proposalId: candidateToProposal.get(c.candidate_id)!.proposalId,
      description: c.description,
      support: c.operator_reported_support,
    }));

    // Step 5: Map outcome
    if (result.status === "completed") {
      const selectedProposal = candidateToProposal.get(result.selectedCandidateId)!;
      const op = state.operationalState;
      const target = selectedProposal.parameters.targetWorkerCount;
      const resourceProjection =
        op.kind === "queue-storm" &&
        selectedProposal.actionType === "scale-workers" &&
        typeof target === "number" &&
        Number.isFinite(target)
          ? {
              observed: op.dbConnectionCount,
              projected: op.dbConnectionCount + (target - op.workerCount) * 3,
              limit: CEILINGS.queueDbConnections,
            }
          : undefined;

      // Run and store fresh local inspect report for the bound proposal (CONTROLLER-REVIEW-010 §2)
      const feas = inspectFeasibility(selectedProposal, state);
      const localInspectReport: LocalInspectReport = {
        proposalId: selectedProposal.proposalId,
        actionType: selectedProposal.actionType,
        parameters: selectedProposal.parameters,
        evaluatedAt: new Date().toISOString(),
        feasibility: {
          pass: feas.pass,
          violatedRules: feas.violatedRules,
          resourceProjection,
        },
        basisRevision: state.revision,
        basisDigest: state.basisDigest,
      };

      const record: SanitizedReviewRecord = {
        idempotencyKey: binding.idempotencyKey,
        status: "selected",
        outcome: "selected",
        selectedCandidateId: result.selectedCandidateId,
        selectedProposalId: selectedProposal.proposalId,
        basisRevision: binding.basisRevision,
        basisDigest: binding.basisDigest,
        payloadDigest: binding.candidatePayloadHashes[result.selectedCandidateId],
        evaluatedAt: result.envelope.evaluated_at,
        receiptId: result.envelope.receipt_id,
        commercialReceiptId: result.envelope.result.commercial_receipt.receipt_id,
        traceId: result.envelope.result.trace.trace_id,
        reasonCodes: result.envelope.result.reason_codes,
        eligibleCandidates: eligibleSummaries,
        rejectedCandidates: rejectedList,
        source: "hosted_evaluate",
        request: {
          profile_id: request.profile_id,
          objective: request.objective,
          context: request.context,
          candidates: request.candidates,
        },
        binding: {
          idempotencyKey: binding.idempotencyKey,
          sessionId: binding.sessionId,
          basisRevision: binding.basisRevision,
          basisDigest: binding.basisDigest,
          candidatePayloadHashes: binding.candidatePayloadHashes,
        },
        envelope: result.envelope,
        localInspectReport,
      };

      this._identityReviews.set(clientIdentity, record);
      return JSON.parse(JSON.stringify(record));
    }

    if (result.status === "refused") {
      const record: SanitizedReviewRecord = {
        idempotencyKey: binding.idempotencyKey,
        status: "refused",
        outcome: "governed_noop_refusal",
        selectedCandidateId: null,
        selectedProposalId: null,
        basisRevision: binding.basisRevision,
        basisDigest: binding.basisDigest,
        evaluatedAt: result.envelope.evaluated_at,
        receiptId: result.envelope.receipt_id,
        commercialReceiptId: result.envelope.result.commercial_receipt.receipt_id,
        traceId: result.envelope.result.trace.trace_id,
        reasonCodes: result.envelope.result.reason_codes,
        eligibleCandidates: eligibleSummaries,
        rejectedCandidates: rejectedList,
        source: "hosted_evaluate",
        request: {
          profile_id: request.profile_id,
          objective: request.objective,
          context: request.context,
          candidates: request.candidates,
        },
        binding: {
          idempotencyKey: binding.idempotencyKey,
          sessionId: binding.sessionId,
          basisRevision: binding.basisRevision,
          basisDigest: binding.basisDigest,
          candidatePayloadHashes: binding.candidatePayloadHashes,
        },
        envelope: result.envelope,
      };

      this._identityReviews.set(clientIdentity, record);
      return JSON.parse(JSON.stringify(record));
    }

    if (result.status === "unknown") {
      this._unknownIdentities.add(clientIdentity);
      const record: SanitizedReviewRecord = {
        idempotencyKey: binding.idempotencyKey,
        status: "unknown",
        selectedCandidateId: null,
        selectedProposalId: null,
        basisRevision: binding.basisRevision,
        basisDigest: binding.basisDigest,
        evaluatedAt: new Date().toISOString(),
        eligibleCandidates: eligibleSummaries,
        rejectedCandidates: rejectedList,
        detail: result.detail,
        source: "hosted_evaluate",
        binding: {
          idempotencyKey: binding.idempotencyKey,
          sessionId: binding.sessionId,
          basisRevision: binding.basisRevision,
          basisDigest: binding.basisDigest,
          candidatePayloadHashes: binding.candidatePayloadHashes,
        },
      };

      this._identityReviews.set(clientIdentity, record);
      return JSON.parse(JSON.stringify(record));
    }

    // rejected or disabled
    const record: SanitizedReviewRecord = {
      idempotencyKey: binding.idempotencyKey,
      status: result.status,
      selectedCandidateId: null,
      selectedProposalId: null,
      basisRevision: binding.basisRevision,
      basisDigest: binding.basisDigest,
      evaluatedAt: new Date().toISOString(),
      eligibleCandidates: eligibleSummaries,
      rejectedCandidates: rejectedList,
      detail: result.detail,
      source: "hosted_evaluate",
    };

    this._identityReviews.set(clientIdentity, record);
    return JSON.parse(JSON.stringify(record));
  }
}

/**
 * Explicit CLI script for fresh ledger initialization.
 * Does NOT access credentials from the environment or auto-execute.
 */
export async function initLedgerCli(targetPath?: string): Promise<void> {
  const p = targetPath || process.argv[2];
  if (!p) {
    console.error("Usage: node dist/src/hosted-controller.js <path-to-ledger-file>");
    process.exit(1);
  }
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const ledger = new ReservationLedger(p);
  await ledger.initFresh();
  console.log(`Initialized fresh ledger at: ${p}`);
}

if (require.main === module) {
  initLedgerCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
