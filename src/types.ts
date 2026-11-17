/**
 * Blackout M1 — shared types
 * All workload and telemetry are simulated. Labels are explicit.
 *
 * SPEC-REVIEW-002 corrections applied:
 * - EvaluateReceipt raw field is commercial_receipt (not receipt)
 * - selected_candidate_id is string | null
 * - EvaluateResult status "error" added for adapter exceptions/timeouts
 * - Digest projection documented precisely: scenarioId + tick + operationalState only
 * - Action confirmation binding: an Action carries a confirmed proposal payload hash
 * - StaleBasiRejected typo preserved in event name per requirements, corrected in comments
 */

// ─── Tick ────────────────────────────────────────────────────────────────────

/** One discrete unit of lab time. Tick 0 is initial state. Each tick = 10 simulated seconds. */
export type Tick = number;

/** Seconds of simulated time per tick. */
export const TICK_SECONDS = 10;

// ─── Operational state variants ──────────────────────────────────────────────

export interface QueueStormOperationalState {
  kind: "queue-storm";
  /** Simulated API gateway — requests arriving per tick. */
  arrivalRatePerTick: number;
  /** Depth of the backing message queue (messages). Floor = 0. */
  queueDepth: number;
  /** Number of active worker processes. Floor = 1. Ceiling = 20. */
  workerCount: number;
  /** Queue ingestion rate cap (messages accepted per tick). null = uncapped. */
  ingestionRateCap: number | null;
  /** Request error rate [0, 1]. */
  errorRate: number;
  /** Number of open database connections. Floor = 1. */
  dbConnectionCount: number;
}

export interface DatabasePressureOperationalState {
  kind: "database-pressure";
  /** Number of application server instances. */
  appServerCount: number;
  /** Fraction of read replicas currently available [0, 1]. */
  replicaAvailability: number;
  /** Number of open connections in the connection pool. Floor = 1. Ceiling = 200. */
  connectionCount: number;
  /** Average query latency in simulated milliseconds. */
  queryLatencyMs: number;
  /** Request error rate [0, 1]. */
  errorRate: number;
  /** Whether replica failover has been triggered. */
  failoverTriggered: boolean;
}

export type OperationalState =
  | QueueStormOperationalState
  | DatabasePressureOperationalState;

// ─── ScenarioState ───────────────────────────────────────────────────────────

export type ScenarioStatus =
  | "running"
  | "terminated-naturally"
  | "terminated-by-limit";

export type TerminationReason = "condition-met" | "tick-limit-reached";

/**
 * Immutable snapshot of all observable quantities at a single point in lab time.
 * Bound to a revision number and a SHA-256 basis digest.
 *
 * Digest projection (SPEC-REVIEW-002 §3):
 *   The basisDigest is SHA-256 over the canonical JSON of:
 *     { scenarioId, tick, operationalState }
 *   — exactly these three fields, nothing else.
 *   This excludes: basisDigest itself (avoids self-reference),
 *   revision (an index, not material state),
 *   status/terminationReason (derived from operationalState + tick),
 *   tickLimit (scenario config, not runtime state),
 *   eventLog and revisionHistory (unbounded, excluded per SPEC-REVIEW-001 §1).
 *
 *   Revision is checked independently as a monotonic counter.
 *   Two states with the same (scenarioId, tick, operationalState) but
 *   different revision numbers will share a basisDigest — the revision
 *   counter distinguishes them in the ledger; the digest identifies
 *   material state content.
 */
export interface ScenarioState {
  scenarioId: string;
  tick: Tick;
  revision: number;
  /**
   * SHA-256 hex over canonical JSON of { scenarioId, tick, operationalState }.
   * See projection note above. 64 lowercase hex characters.
   */
  basisDigest: string;
  status: ScenarioStatus;
  terminationReason?: TerminationReason;
  operationalState: OperationalState;
  /** Tick limit for this run. */
  tickLimit: number;
}

// ─── Proposals ───────────────────────────────────────────────────────────────

/** Labelled origin of a proposal. M1 uses only "scripted". */
export type ProposalSource = "scripted" | "hosted-evaluate" | "model";

export interface PredictedEffects {
  [metricName: string]: number | string | boolean | null;
}

export interface ObservedEffects {
  [metricName: string]: number | string | boolean | null;
}

/**
 * A typed, immutable record describing one candidate remediation action.
 * Bound to the revision and basisDigest of the state from which it was derived.
 */
export interface Proposal {
  proposalId: string;
  source: ProposalSource;
  /** Human-readable description of the proposed action. */
  description: string;
  /** Assumptions made when generating this proposal. */
  assumptions: string[];
  /**
   * Expected post-action metric values.
   * Never overwritten after creation.
   */
  predictedEffects: PredictedEffects;
  /** Declared support level [0, 1]. */
  operatorReportedSupport: number;
  /** Revision of the state from which this proposal was generated. */
  basisRevision: number;
  /** Basis digest of the state from which this proposal was generated. */
  basisDigest: string;
  /** Semantic class as defined in EVALUATE-INTEGRATION.md. */
  semanticClass: "analyze" | "compare" | "draft" | "validate" | "external";
  /** Short action type for the executor to dispatch on. */
  actionType: ActionType;
  /**
   * Action parameters (e.g. targetWorkerCount, capRate, targetConnectionCount).
   * These are part of the executable payload that is digested for confirmation binding.
   */
  parameters: Record<string, number | string | boolean | null>;
  /**
   * Canonical digest of the executable payload projection:
   *   { actionType, parameters, basisRevision, basisDigest }
   * (excludes proposalId — an index, not a material executable field)
   * Used to bind an Action to an exact recorded confirmation.
   * SPEC-REVIEW-002 §5 / CORE-REVIEW-003 §1: the executor recomputes this
   * projection from the received Action fields and compares to stored digest.
   */
  payloadDigest: string;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type ActionType =
  | "scale-workers"
  | "throttle-queue"
  | "reduce-connections"
  | "replica-failover";

/**
 * A concrete lab operation derived from an approved Proposal.
 * Bound to a unique action_id, the revision and basisDigest at approval time,
 * and the payloadDigest of the confirmed proposal.
 *
 * SPEC-REVIEW-002 §5: The executor must verify that the payloadDigest
 * matches a recorded confirmation entry in the ActionLedger before applying.
 * A caller cannot fabricate a valid Action by merely setting the right basis digest.
 */
export interface Action {
  actionId: string;
  proposalId: string;
  actionType: ActionType;
  /** Parameters specific to this action. */
  parameters: Record<string, number | string | boolean | null>;
  /** Revision at which this action was approved. */
  basisRevision: number;
  /** Basis digest at which this action was approved. Must match current state at execute time. */
  basisDigest: string;
  /**
   * SHA-256 digest of the executable payload projection:
   *   { actionType, parameters, basisRevision, basisDigest }
   * The executor recomputes this from the received Action fields (CORE-REVIEW-003 §1)
   * and compares against the stored confirmation digest. Carrying the original digest
   * string while mutating actionType/parameters/basisRevision/basisDigest will fail.
   */
  payloadDigest: string;
}

/** A recorded confirmation binding an action ID to its proposal payload digest and basis. */
export interface ActionConfirmation {
  actionId: string;
  proposalId: string;
  payloadDigest: string;
  basisRevision: number;
  basisDigest: string;
  confirmedAt: Tick;
}

// ─── Feasibility ─────────────────────────────────────────────────────────────

export type FeasibilityRuleName =
  | "capacity-floor"
  | "replica-availability"
  | "max-resource-use"
  | "observation-freshness"
  | "action-applicability";

export interface FeasibilityResult {
  pass: boolean;
  violatedRules: FeasibilityRuleName[];
}

// ─── Lab receipts ────────────────────────────────────────────────────────────

/**
 * Immutable record capturing the outcome of one action execution.
 * Distinguishes predicted from observed effects.
 */
export interface LabReceipt {
  actionId: string;
  revisionBefore: number;
  digestBefore: string;
  appliedActionDescription: string;
  revisionAfter: number;
  digestAfter: string;
  /** Predictions taken from the original Proposal. Never overwritten by observed. */
  predictedEffects: PredictedEffects;
  /** Actual observed metric values from the resulting ScenarioState. Independently populated. */
  observedEffects: ObservedEffects;
  /**
   * Describes the execution boundary; any hosted review is recorded separately.
   */
  labNote: "local model effect; no hosted call during execution";
}

// ─── Execution results ───────────────────────────────────────────────────────

export type ExecutionResult =
  | { kind: "applied"; newState: ScenarioState; receipt: LabReceipt }
  | {
      kind: "stale-basis";
      actionDigest: string;
      currentDigest: string;
      currentRevision: number;
    }
  | { kind: "duplicate-action"; actionId: string }
  | { kind: "unconfirmed-payload"; actionId: string; detail: string }
  | { kind: "feasibility-failed"; result: FeasibilityResult };

// ─── Event log ───────────────────────────────────────────────────────────────

export interface BaseLabEvent {
  eventId: string;
  tick: Tick;
  revision: number;
  basisDigest: string;
}

export interface ScenarioStartedEvent extends BaseLabEvent {
  kind: "ScenarioStarted";
  scenarioId: string;
  seed: number;
}

export interface TickAdvancedEvent extends BaseLabEvent {
  kind: "TickAdvanced";
  previousTick: Tick;
}

export interface ProposalCreatedEvent extends BaseLabEvent {
  kind: "ProposalCreated";
  proposalId: string;
  source: ProposalSource;
}

export interface FeasibilityRejectedEvent extends BaseLabEvent {
  kind: "FeasibilityRejected";
  proposalId: string;
  violatedRules: FeasibilityRuleName[];
}

export interface ActionApprovedEvent extends BaseLabEvent {
  kind: "ActionApproved";
  actionId: string;
  proposalId: string;
}

export interface ActionAppliedEvent extends BaseLabEvent {
  kind: "ActionApplied";
  actionId: string;
  revisionAfter: number;
  digestAfter: string;
}

/**
 * StaleBasiRejected — name preserved from requirements.md (intentional typo in spec).
 * Meaning: execution was rejected because the action's basis digest is stale.
 */
export interface StaleBasiRejectedEvent extends BaseLabEvent {
  kind: "StaleBasiRejected";
  actionId: string;
  actionDigest: string;
  currentDigest: string;
}

export interface DuplicateActionRejectedEvent extends BaseLabEvent {
  kind: "DuplicateActionRejected";
  actionId: string;
}

export interface UnconfirmedPayloadRejectedEvent extends BaseLabEvent {
  kind: "UnconfirmedPayloadRejected";
  actionId: string;
  detail: string;
}

export interface ScenarioTerminatedEvent extends BaseLabEvent {
  kind: "ScenarioTerminated";
  reason: TerminationReason;
}

export interface EvaluateUnconfiguredEvent extends BaseLabEvent {
  kind: "EvaluateUnconfigured";
  note: string;
}

/**
 * Typed incident injection kinds.
 * "database-pressure-queue-storm": inject elevated DB connections into a queue-storm scenario.
 * "replica-loss": inject reduced replica availability into a database-pressure scenario.
 */
export type IncidentInjectionKind =
  | "database-pressure-queue-storm"
  | "replica-loss";

export interface IncidentInjectedEvent extends BaseLabEvent {
  kind: "IncidentInjected";
  injectionKind: IncidentInjectionKind;
  description: string;
}

export type LabEvent =
  | ScenarioStartedEvent
  | TickAdvancedEvent
  | ProposalCreatedEvent
  | FeasibilityRejectedEvent
  | ActionApprovedEvent
  | ActionAppliedEvent
  | StaleBasiRejectedEvent
  | DuplicateActionRejectedEvent
  | UnconfirmedPayloadRejectedEvent
  | ScenarioTerminatedEvent
  | EvaluateUnconfiguredEvent
  | IncidentInjectedEvent;

// ─── DeltaX Evaluate boundary ────────────────────────────────────────────────

/**
 * One candidate submitted for evaluation.
 * Semantic class "external" is shadow-only per EVALUATE-INTEGRATION.md.
 */
export interface EvaluateCandidate {
  candidate_id: string;
  semantic_class: "analyze" | "compare" | "draft" | "validate" | "external";
  description: string;
  operator_reported_support: number;
}

export interface EvaluateRequest {
  profile_id: string;
  objective: string;
  context: Record<string, string | number | boolean | null>;
  candidates: EvaluateCandidate[];
}

/**
 * One of the twelve HES gate records returned in the trace.
 */
export type HesGateKey =
  | "HES-G01" | "HES-G02" | "HES-G03" | "HES-G04"
  | "HES-G05" | "HES-G06" | "HES-G07" | "HES-G08"
  | "HES-G09" | "HES-G10" | "HES-G11" | "HES-G12";

export interface HesGateRecord {
  gate: HesGateKey;
  assertion: string;
  value: boolean;
}

export interface HesTrace {
  /** Exactly 12 gate records, ordered HES-G01..HES-G12. */
  lambda_decisions: [
    HesGateRecord, HesGateRecord, HesGateRecord, HesGateRecord,
    HesGateRecord, HesGateRecord, HesGateRecord, HesGateRecord,
    HesGateRecord, HesGateRecord, HesGateRecord, HesGateRecord,
  ];
}

/**
 * Raw commercial receipt returned by the hosted engine.
 * Field name is commercial_receipt per SPEC-REVIEW-002.
 */
export interface EvaluateCommercialReceipt {
  receipt_id: string;
  scenario_id: string;
  revision: number;
  basis_digest: string;
  candidate_set_digest: string;
  /**
   * All authority flags are false per EVALUATE-INTEGRATION.md.
   * Selection is not execution, correctness/safety assurance, downstream authority,
   * professional advice, or certification.
   */
  is_execution_authorization: false;
  is_safety_certification: false;
  is_correctness_assurance: false;
  is_downstream_authority: false;
  is_professional_advice: false;
}

/**
 * Raw hosted response — selected outcome.
 * selected_candidate_id is string | null per SPEC-REVIEW-002.
 */
export interface EvaluateResponseSelected {
  outcome: "selected";
  selected_candidate_id: string | null;
  trace: HesTrace;
  commercial_receipt: EvaluateCommercialReceipt;
}

/**
 * Raw hosted response — refusal also carries a commercial_receipt.
 */
export interface EvaluateResponseRefusal {
  outcome: "governed_noop_refusal";
  selected_candidate_id: null;
  trace: HesTrace;
  commercial_receipt: EvaluateCommercialReceipt;
}

export type EvaluateResponse =
  | EvaluateResponseSelected
  | EvaluateResponseRefusal;

/**
 * Product-level result wrapping the transport response.
 * Wraps but does not rename raw protocol fields.
 *
 * "unconfigured": adapter absent — M1 state.
 * "selected": a valid candidate was selected.
 * "governed_noop_refusal": engine refused; receipt still present.
 * "error": adapter threw or timed out — preserved as unknown, never promoted to selected.
 *
 * SPEC-REVIEW-001 §2 / SPEC-REVIEW-002 §2: unconfigured ≠ error/unknown.
 * An absent adapter is unconfigured. An exception/timeout is an error.
 */
export type EvaluateResult =
  | { status: "unconfigured" }
  | {
      status: "selected";
      candidate_id: string;
      trace: HesTrace;
      commercial_receipt: EvaluateCommercialReceipt;
    }
  | {
      status: "governed_noop_refusal";
      trace: HesTrace;
      commercial_receipt: EvaluateCommercialReceipt;
    }
  | { status: "error"; detail: string };

/** Adapter interface for the hosted DeltaX Evaluate service. */
export interface EvaluateAdapter {
  evaluate(request: EvaluateRequest): Promise<EvaluateResult>;
}

// ─── Floor/ceiling constants ──────────────────────────────────────────────────

export const FLOORS = {
  workerCount: 1,
  dbConnectionCount: 1,
  connectionCount: 1,
} as const;

export const CEILINGS = {
  workerCount: 20,
  connectionCount: 200,
  /**
   * Explicit documented fictional queue downstream DB connection budget (CORE-REVIEW-006).
   * Separately tracked from the database-pressure scenario's 200 connection pool ceiling.
   * Projected queue DB demand: current.dbConnectionCount + (targetWorkerCount - current.workerCount) * 3 <= 100.
   */
  queueDbConnections: 100,
} as const;

export const DEFAULT_TICK_LIMIT = 100;
export const DEFAULT_FRESHNESS_THRESHOLD_TICKS = 5;
