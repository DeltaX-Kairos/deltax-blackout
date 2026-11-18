/**
 * WorkspaceService — server-side session and RecoveryCore lifecycle manager.
 *
 * Each session owns exactly one RecoveryCore instance. A per-session
 * non-reentrant operation guard ensures that concurrent mutation requests
 * are serialised (second caller gets an error, not a race).
 *
 * Sessions expire after SESSION_TTL_MS of inactivity. A periodic sweep
 * removes expired sessions from the map.
 *
 * The service never trusts client-supplied revision or digest as the actual
 * current state. It always reads revision/digest from the living RecoveryCore.
 *
 * Integrated with HostedController:
 * - Server owns bindings and candidates.
 * - Staging requires a matching selected hosted review when configured.
 * - Local unconfigured mode operates as a direct lab.
 * - Evidence bundles include state history snapshots and review records.
 */

import { RecoveryCore, ApprovalError } from "./recovery-core.js";
import type { ScenarioName, InjectResult } from "./recovery-core.js";
import { TickClock } from "./clock.js";
import { Mulberry32 } from "./rng.js";
import { inspectFeasibility } from "./feasibility.js";
import { CEILINGS } from "./types.js";
import { randomBytes } from "node:crypto";
import type {
  ScenarioState,
  Proposal,
  Action,
  ExecutionResult,
  LabReceipt,
  LabEvent,
  IncidentInjectionKind,
} from "./types.js";
import type {
  HostedController,
  SanitizedReviewRecord,
  HostedStatusInfo,
} from "./hosted-controller.js";

export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_SESSIONS = 100;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** Maximum staged actions kept per session before oldest is evicted. */
const MAX_STAGED = 20;

export interface SessionRecord {
  sessionId: string;
  clientIdentity: string;
  core: RecoveryCore;
  scenarioName: ScenarioName;
  seed: number;
  createdAt: number; // Date.now()
  lastActivityAt: number; // Date.now()
  /** True while an operation is in flight — prevents reentrant mutations. */
  busy: boolean;
  /** Server-side CSRF token for this session. */
  csrfToken: string;
  /** Staged actions keyed by random stageId. Bounded to MAX_STAGED. */
  stagedActions: Map<string, Action>;
  /** Collected lab receipts for evidence export. */
  actionReceipts: LabReceipt[];
  /** Collected hosted review records for evidence export. */
  reviewHistory: SanitizedReviewRecord[];
}

export interface ObserveSnapshot {
  sessionId: string;
  state: ScenarioState;
  events: readonly LabEvent[];
  history: ScenarioState[];
}

export interface ProposeSnapshot {
  sessionId: string;
  proposals: Proposal[];
  currentRevision: number;
  currentDigest: string;
}

export interface InspectSnapshot {
  sessionId: string;
  proposal: Proposal;
  feasibility: {
    pass: boolean;
    violatedRules: string[];
    resourceProjection?: { observed: number; projected: number; limit: number };
  };
}

export interface ApproveSnapshot {
  sessionId: string;
  action: Action;
  stageId: string;
}

export interface ExecuteSnapshot {
  sessionId: string;
  result: ExecutionResult;
  receipt: LabReceipt | null;
}

export interface AdvanceTickSnapshot {
  sessionId: string;
  state: ScenarioState;
}

export interface EvidenceBundle {
  sessionId: string;
  scenarioName: ScenarioName;
  seed: number;
  exportedAt: string; // ISO 8601
  currentState: ScenarioState;
  events: readonly LabEvent[];
  labNote: string;
  evaluateStatus: string;
  /** All sources are scripted in local mode; labelled explicitly. */
  proposalSources: string;
  /** Telemetry label: all state history is simulated. */
  stateHistoryLabel: "simulated telemetry";
  /** State snapshots at each revision. */
  stateHistory: ScenarioState[];
  /** Lab receipts from every applied action. */
  actionReceipts: LabReceipt[];
  /** Hosted review records. */
  reviews?: SanitizedReviewRecord[];
}

export interface RestoreSnapshot {
  sessionId: string;
  csrfToken: string;
  state: ScenarioState;
  events: readonly LabEvent[];
  history: ScenarioState[];
  liveStatus: HostedStatusInfo | null;
  review: SanitizedReviewRecord | null;
}

/** Thrown when an operation is attempted on a busy session. */
export class SessionBusyError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is busy — concurrent operations are not allowed`);
    this.name = "SessionBusyError";
  }
}

/** Thrown when a session ID is not found. */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found or expired`);
    this.name = "SessionNotFoundError";
  }
}

export class WorkspaceService {
  private readonly _sessions = new Map<string, SessionRecord>();
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;
  private _hostedController: HostedController | null = null;

  constructor(hostedController?: HostedController) {
    this._hostedController = hostedController ?? null;
    this._sweepTimer = setInterval(() => this._sweepExpired(), SWEEP_INTERVAL_MS);
    // Allow Node to exit cleanly even if the interval is pending.
    if (this._sweepTimer.unref) {
      this._sweepTimer.unref();
    }
  }

  setHostedController(controller: HostedController | null): void {
    this._hostedController = controller;
  }

  get hostedController(): HostedController | null {
    return this._hostedController;
  }

  /**
   * Create a new session. The caller supplies the sessionId and CSRF token.
   * clientIdentity preserves the browser's persistent budget identity across session resets.
   */
  createSession(
    sessionId: string,
    scenarioName: ScenarioName,
    seed: number,
    tickLimit?: number,
    csrfToken: string = "",
    clientIdentity?: string
  ): SessionRecord {
    if (this._sessions.size >= MAX_SESSIONS) {
      this._sweepExpired();
      if (this._sessions.size >= MAX_SESSIONS) {
        throw new Error("Server is at session capacity. Try again later.");
      }
    }

    const core = new RecoveryCore({
      clock: new TickClock(0),
      rng: new Mulberry32(seed),
      scenarioName,
      seed,
      tickLimit,
    });

    const now = Date.now();
    const record: SessionRecord = {
      sessionId,
      clientIdentity: clientIdentity || sessionId,
      core,
      scenarioName,
      seed,
      createdAt: now,
      lastActivityAt: now,
      busy: false,
      csrfToken,
      stagedActions: new Map(),
      actionReceipts: [],
      reviewHistory: [],
    };
    this._sessions.set(sessionId, record);
    return record;
  }

  /** Retrieve a session record, throwing if absent or expired. */
  getSession(sessionId: string): SessionRecord {
    const record = this._sessions.get(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    if (Date.now() - record.lastActivityAt > SESSION_TTL_MS) {
      this._sessions.delete(sessionId);
      throw new SessionNotFoundError(sessionId);
    }
    record.lastActivityAt = Date.now();
    return record;
  }

  /** True if sessionId exists and has not expired. */
  hasSession(sessionId: string): boolean {
    try {
      this.getSession(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run fn inside a non-reentrant per-session lock.
   * Throws SessionBusyError if the session is already processing an operation.
   */
  async withSession<T>(sessionId: string, fn: (record: SessionRecord) => Promise<T>): Promise<T> {
    const record = this.getSession(sessionId);
    if (record.busy) throw new SessionBusyError(sessionId);
    record.busy = true;
    try {
      return await fn(record);
    } finally {
      record.busy = false;
    }
  }

  // ─── Core operations (all go through withSession) ─────────────────────────

  async observe(sessionId: string): Promise<ObserveSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      const { state, events } = rec.core.observe();
      const history: ScenarioState[] = [];
      for (let r = 1; r <= state.revision; r++) {
        const snap = rec.core.getRevision(r);
        if (snap) history.push(snap);
      }
      return { sessionId, state, events, history };
    });
  }

  /**
   * Proposal cache keyed by [sessionId][proposalId].
   */
  private _proposalCache = new Map<string, Map<string, Proposal>>();

  getProposalCache(sessionId: string): Map<string, Proposal> | undefined {
    return this._proposalCache.get(sessionId);
  }

  async proposeAndCache(sessionId: string): Promise<ProposeSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      const { proposals } = rec.core.propose();
      const state = rec.core.currentState;
      const byId = new Map(proposals.map((p) => [p.proposalId, p]));
      this._proposalCache.set(sessionId, byId);
      return {
        sessionId,
        proposals,
        currentRevision: state.revision,
        currentDigest: state.basisDigest,
      };
    });
  }

  async inspectCached(sessionId: string, proposalId: string): Promise<InspectSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      const cache = this._proposalCache.get(sessionId);
      const proposal = cache?.get(proposalId);
      if (!proposal) {
        throw new Error(`Proposal ${proposalId} not found — call propose first`);
      }
      const feasibility = inspectFeasibility(proposal, rec.core.currentState);
      const op = rec.core.currentState.operationalState;
      const target = proposal.parameters.targetWorkerCount;
      const resourceProjection =
        op.kind === "queue-storm" &&
        proposal.actionType === "scale-workers" &&
        typeof target === "number" &&
        Number.isFinite(target)
          ? {
              observed: op.dbConnectionCount,
              projected: op.dbConnectionCount + (target - op.workerCount) * 3,
              limit: CEILINGS.queueDbConnections,
            }
          : undefined;
      return { sessionId, proposal, feasibility: { ...feasibility, resourceProjection } };
    });
  }

  /**
   * Approve a proposal: creates an Action via RecoveryCore, caches it server-side
   * under a random stageId, and returns the stageId.
   * If hosted review is configured, verifies that the proposal matches the selected review.
   */
  async approve(sessionId: string, proposalId: string): Promise<ApproveSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      const cache = this._proposalCache.get(sessionId);
      const proposal = cache?.get(proposalId);
      if (!proposal) {
        throw new Error(`Proposal ${proposalId} not found — call propose first`);
      }

      // If hosted review is configured, enforce selection gate
      if (this._hostedController) {
        const check = this._hostedController.validateStageAllowed(
          rec.clientIdentity,
          proposal,
          rec.core.currentState
        );
        if (!check.allowed) {
          throw new ApprovalError(check.reason || "Staging rejected by hosted review gate");
        }
      }

      const { action } = rec.core.approve(proposal);

      // Assign a random stageId and cache the action server-side.
      const stageId = randomBytes(16).toString("hex");

      // Evict oldest if at capacity (FIFO by insertion order).
      if (rec.stagedActions.size >= MAX_STAGED) {
        const firstKey = rec.stagedActions.keys().next().value;
        if (firstKey !== undefined) rec.stagedActions.delete(firstKey);
      }
      rec.stagedActions.set(stageId, action);

      return { sessionId, action, stageId };
    });
  }

  /**
   * Execute the action referenced by stageId.
   */
  async executeByStageId(sessionId: string, stageId: string): Promise<ExecuteSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      const action = rec.stagedActions.get(stageId);
      if (!action) {
        throw new StageNotFoundError(stageId);
      }

      if (this._hostedController) {
        const check = this._hostedController.validateExecutionAllowed(
          rec.clientIdentity,
          action,
          rec.core.currentState
        );
        if (!check.allowed) {
          throw new Error(check.reason || "Execution rejected by hosted review gate");
        }
      }

      const result = rec.core.execute(action);
      const receipt = result.kind === "applied" ? result.receipt : null;
      if (receipt) {
        rec.actionReceipts.push(receipt);
      }
      return { sessionId, result, receipt };
    });
  }

  /**
   * Execute the action object directly (for unit tests).
   */
  async execute(sessionId: string, action: Action): Promise<ExecuteSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      if (this._hostedController) {
        const check = this._hostedController.validateExecutionAllowed(
          rec.clientIdentity,
          action,
          rec.core.currentState
        );
        if (!check.allowed) {
          throw new Error(check.reason || "Execution rejected by hosted review gate");
        }
      }

      const result = rec.core.execute(action);
      const receipt = result.kind === "applied" ? result.receipt : null;
      if (receipt) {
        rec.actionReceipts.push(receipt);
      }
      return { sessionId, result, receipt };
    });
  }

  async advanceTick(sessionId: string): Promise<AdvanceTickSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      const state = rec.core.advanceTick();
      return { sessionId, state };
    });
  }

  async injectIncident(
    sessionId: string,
    kind: IncidentInjectionKind
  ): Promise<InjectResult & { sessionId: string }> {
    return this.withSession(sessionId, async (rec) => {
      const result = rec.core.injectIncident(kind);
      return { ...result, sessionId };
    });
  }

  addReviewRecord(sessionId: string, record: SanitizedReviewRecord): void {
    const rec = this.getSession(sessionId);
    rec.reviewHistory.push(record);
  }

  async evaluate(sessionId: string): Promise<SanitizedReviewRecord> {
    return this.withSession(sessionId, async (rec) => {
      let cached = this._proposalCache.get(sessionId);
      if (!cached || cached.size === 0) {
        const { proposals } = rec.core.propose();
        cached = new Map(proposals.map((p) => [p.proposalId, p]));
        this._proposalCache.set(sessionId, cached);
      }
      const proposals = Array.from(cached.values());
      if (!this._hostedController) {
        throw new Error("Hosted review is unconfigured in local demo mode");
      }
      const review = await this._hostedController.evaluate({
        clientIdentity: rec.clientIdentity,
        state: rec.core.currentState,
        proposals,
      });
      rec.reviewHistory.push(review);
      return review;
    });
  }

  async exportEvidence(sessionId: string): Promise<EvidenceBundle> {
    return this.withSession(sessionId, async (rec) => {
      const { state, events } = rec.core.observe();
      const history: ScenarioState[] = [];
      for (let r = 1; r <= state.revision; r++) {
        const snap = rec.core.getRevision(r);
        if (snap) history.push(snap);
      }

      const isConfigured = this._hostedController?.isConfigured ?? false;
      let reviewStatus = "unconfigured";
      if (isConfigured && this._hostedController) {
        const live = await this._hostedController.getStatus(rec.clientIdentity);
        reviewStatus = live.status;
      }

      const reviews = rec.reviewHistory.length > 0 ? [...rec.reviewHistory] : [];
      const hasReview = reviews.some((r) => r.source === "hosted_evaluate" &&
        (r.status === "selected" || r.status === "refused") && r.envelope !== undefined);
      const hasAttempt = reviews.some((r) => r.source === "hosted_evaluate");
      const hasAction = rec.actionReceipts.length > 0;

      let labNote: string;
      if (isConfigured && hasAttempt && !hasReview) {
        labNote = "hosted review attempted; no completed review confirmed";
      } else if (!isConfigured || (!hasReview && !hasAction)) {
        labNote = "local lab, no hosted evaluation performed";
      } else if (hasReview && hasAction) {
        labNote = "hosted review evaluated; local lab action applied with explicit operator confirmation";
      } else if (hasReview && !hasAction) {
        labNote = "hosted review evaluated; no local lab action applied";
      } else {
        labNote = "local lab, no hosted evaluation performed";
      }

      return {
        sessionId,
        scenarioName: rec.scenarioName,
        seed: rec.seed,
        exportedAt: new Date().toISOString(),
        currentState: JSON.parse(JSON.stringify(state)),
        events: JSON.parse(JSON.stringify(events)),
        labNote,
        evaluateStatus: reviewStatus,
        proposalSources: "scripted",
        stateHistoryLabel: "simulated telemetry",
        stateHistory: JSON.parse(JSON.stringify(history)),
        actionReceipts: JSON.parse(JSON.stringify(rec.actionReceipts)),
        reviews: JSON.parse(JSON.stringify(reviews)),
      };
    });
  }

  async restoreSession(sessionId: string): Promise<RestoreSnapshot> {
    return this.withSession(sessionId, async (rec) => {
      const { state, events } = rec.core.observe();
      const history: ScenarioState[] = [];
      for (let r = 1; r <= state.revision; r++) {
        const snap = rec.core.getRevision(r);
        if (snap) history.push(snap);
      }
      const liveStatus = this._hostedController
        ? await this._hostedController.getStatus(rec.clientIdentity)
        : null;
      const review = this._hostedController?.getReview(rec.clientIdentity) ?? null;
      return {
        sessionId,
        csrfToken: rec.csrfToken,
        state: JSON.parse(JSON.stringify(state)),
        events: JSON.parse(JSON.stringify(events)),
        history: JSON.parse(JSON.stringify(history)),
        liveStatus,
        review,
      };
    });
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  destroySession(sessionId: string): void {
    if (this._sessions.get(sessionId)?.busy) throw new SessionBusyError(sessionId);
    this._sessions.delete(sessionId);
    this._proposalCache.delete(sessionId);
  }

  private _sweepExpired(): void {
    const now = Date.now();
    for (const [id, rec] of this._sessions) {
      if (!rec.busy && now - rec.lastActivityAt > SESSION_TTL_MS) {
        this._sessions.delete(id);
        this._proposalCache.delete(id);
      }
    }
  }

  /** Stop background sweep timer — call during server shutdown. */
  close(): void {
    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  get sessionCount(): number {
    return this._sessions.size;
  }
}

/** Thrown when a stageId is not found in the session's staged-action map. */
export class StageNotFoundError extends Error {
  constructor(stageId: string) {
    super(`Stage ${stageId} not found — it may belong to a different session or never existed`);
    this.name = "StageNotFoundError";
  }
}
