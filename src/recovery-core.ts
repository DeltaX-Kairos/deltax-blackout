/**
 * RecoveryCore — the main orchestrator.
 *
 * Wires: Clock, Rng, EventLog, ActionLedger, Executor, FeasibilityInspector,
 * EvaluateAdapter (injected; NullEvaluateAdapter in M1).
 *
 * Throws if Clock or Rng are absent at construction time.
 *
 * CORE-REVIEW-003 fixes applied:
 *   §4  approve() verifies the proposal is in _proposals (came from propose()),
 *       that feasibility passes against the current state, and that the proposal's
 *       basisDigest matches the current state. Stale/fabricated proposals are rejected.
 *   §5  All stored states/proposals/receipts are deep-frozen. Getters return
 *       deep copies so callers cannot mutate internal history.
 */

import type {
  ScenarioState,
  Proposal,
  Action,
  ActionConfirmation,
  ExecutionResult,
  FeasibilityResult,
  EvaluateAdapter,
  EvaluateRequest,
  EvaluateResult,
  LabEvent,
  TerminationReason,
} from "./types.js";
import type { Clock } from "./clock.js";
import type { Rng } from "./rng.js";
import { EventLog } from "./event-log.js";
import { ActionLedger } from "./action-ledger.js";
import { inspectFeasibility } from "./feasibility.js";
import type { FeasibilityConfig } from "./feasibility.js";
import { executeAction } from "./executor.js";
import { NullEvaluateAdapter } from "./evaluate-boundary.js";
import { advance } from "./state-machine.js";
import { computeExecutablePayloadDigest } from "./digest.js";

import {
  makeInitialQueueStormState,
  generateQueueStormProposals,
  QUEUE_STORM_SCENARIO_ID,
} from "./scenarios/queue-storm.js";
import {
  makeInitialDatabasePressureState,
  generateDatabasePressureProposals,
  DB_PRESSURE_SCENARIO_ID,
} from "./scenarios/database-pressure.js";

export type ScenarioName = "queue-storm" | "database-pressure";

export interface RecoveryCoreOptions {
  clock: Clock;
  rng: Rng;
  scenarioName: ScenarioName;
  seed: number;
  evaluateAdapter?: EvaluateAdapter;
  feasibilityConfig?: FeasibilityConfig;
  tickLimit?: number;
}

export interface ObserveResult {
  state: ScenarioState;
  events: readonly LabEvent[];
}

export interface ProposeResult {
  proposals: Proposal[];
}

export interface InspectResult {
  proposal: Proposal;
  feasibility: FeasibilityResult;
}

export interface ApproveResult {
  action: Action;
}

/** Deep-clone a JSON-serialisable value to prevent external mutation. */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class RecoveryCore {
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly evaluateAdapter: EvaluateAdapter;
  private readonly feasibilityConfig: FeasibilityConfig;

  private _currentState: ScenarioState;
  private readonly _revisionHistory: ScenarioState[] = [];
  private readonly _eventLog: EventLog;
  private readonly _actionLedger: ActionLedger;
  // Stores only proposals that came from propose() — not caller-constructed ones.
  private readonly _proposals = new Map<string, Proposal>();
  private _eventCounter = 0;

  constructor(options: RecoveryCoreOptions) {
    if (!options.clock) {
      throw new Error("RecoveryCore: missing required dependency Clock");
    }
    if (!options.rng) {
      throw new Error("RecoveryCore: missing required dependency Rng");
    }

    this.clock = options.clock;
    this.rng = options.rng;
    this.evaluateAdapter = options.evaluateAdapter ?? new NullEvaluateAdapter();
    this.feasibilityConfig = options.feasibilityConfig ?? { freshnessThresholdTicks: 5 };

    this._eventLog = new EventLog();
    this._actionLedger = new ActionLedger();

    // Build initial state and deep-freeze it.
    const initial = this._buildInitialState(options.scenarioName, options.tickLimit);
    this._currentState = deepFreeze(initial);
    this._revisionHistory.push(this._currentState);

    // Emit ScenarioStarted event.
    this._appendEvent({
      eventId: this._nextEventId("ScenarioStarted"),
      kind: "ScenarioStarted",
      tick: initial.tick,
      revision: initial.revision,
      basisDigest: initial.basisDigest,
      scenarioId: initial.scenarioId,
      seed: options.seed,
    });
  }

  // ─── Accessors (defensive copies) ────────────────────────────────────────

  get currentRevision(): number {
    return this._currentState.revision;
  }

  /**
   * Returns a deep copy of the current state.
   * CORE-REVIEW-003 §5: callers cannot mutate internal state through this getter.
   */
  get currentState(): ScenarioState {
    return deepCopy(this._currentState);
  }

  get eventLog(): EventLog {
    return this._eventLog;
  }

  // ─── Observe ─────────────────────────────────────────────────────────────

  observe(): ObserveResult {
    return {
      state: deepCopy(this._currentState),
      events: this._eventLog.events,
    };
  }

  /**
   * Look up a past revision by number.
   * Returns a deep copy so the stored revision cannot be mutated.
   */
  getRevision(revision: number): ScenarioState | undefined {
    const found = this._revisionHistory.find((s) => s.revision === revision);
    return found ? deepCopy(found) : undefined;
  }

  // ─── Advance tick ────────────────────────────────────────────────────────

  advanceTick(): ScenarioState {
    const nextTick = this._currentState.tick + 1;
    const result = advance(this._currentState, nextTick, this.rng);

    if (result.kind === "out-of-order-tick") {
      throw new Error(
        `RecoveryCore: out-of-order tick (current=${result.currentTick}, requested=${result.requestedTick})`
      );
    }
    if (result.kind === "already-terminal") {
      return deepCopy(this._currentState);
    }

    const previousTick = this._currentState.tick;
    this._currentState = deepFreeze(result.state);
    this._revisionHistory.push(this._currentState);

    this._appendEvent({
      eventId: this._nextEventId("TickAdvanced"),
      kind: "TickAdvanced",
      tick: result.state.tick,
      revision: result.state.revision,
      basisDigest: result.state.basisDigest,
      previousTick,
    });

    if (result.state.status !== "running") {
      this._appendTerminatedEvent(result.state.terminationReason ?? "tick-limit-reached");
    }

    return deepCopy(this._currentState);
  }

  // ─── Propose ─────────────────────────────────────────────────────────────

  propose(): ProposeResult {
    const state = this._currentState;
    let proposals: Proposal[];

    if (state.scenarioId === QUEUE_STORM_SCENARIO_ID) {
      proposals = generateQueueStormProposals(state, this.rng);
    } else if (state.scenarioId === DB_PRESSURE_SCENARIO_ID) {
      proposals = generateDatabasePressureProposals(state, this.rng);
    } else {
      proposals = [];
    }

    for (const p of proposals) {
      const frozen = deepFreeze(p);
      this._proposals.set(p.proposalId, frozen);
      this._appendEvent({
        eventId: this._nextEventId("ProposalCreated"),
        kind: "ProposalCreated",
        tick: state.tick,
        revision: state.revision,
        basisDigest: state.basisDigest,
        proposalId: p.proposalId,
        source: p.source,
      });
    }

    // Return deep copies.
    return { proposals: proposals.map(deepCopy) };
  }

  // ─── Inspect feasibility ─────────────────────────────────────────────────

  inspect(proposal: Proposal): InspectResult {
    const feasibility = inspectFeasibility(
      proposal,
      this._currentState,
      this.feasibilityConfig
    );

    if (!feasibility.pass) {
      this._appendEvent({
        eventId: this._nextEventId("FeasibilityRejected"),
        kind: "FeasibilityRejected",
        tick: this._currentState.tick,
        revision: this._currentState.revision,
        basisDigest: this._currentState.basisDigest,
        proposalId: proposal.proposalId,
        violatedRules: feasibility.violatedRules,
      });
    }

    return { proposal: deepCopy(proposal), feasibility };
  }

  // ─── Approve (confirm) ───────────────────────────────────────────────────

  /**
   * Approve a proposal, creating an Action bound to the current basis.
   *
   * CORE-REVIEW-003 §4 requirements:
   * 1. The proposal must be in _proposals (must have come from propose() on this core).
   * 2. The proposal's basisDigest must match the CURRENT state (not stale).
   * 3. Feasibility must pass against the current state.
   *
   * Throws ApprovalError for any violation. Callers must re-propose after state changes.
   */
  approve(proposal: Proposal): ApproveResult {
    const state = this._currentState;

    // Requirement 1: proposal must be known (came from this core's propose()).
    const storedProposal = this._proposals.get(proposal.proposalId);
    if (!storedProposal) {
      throw new ApprovalError(
        "proposal " + proposal.proposalId + " was not generated by this RecoveryCore instance"
      );
    }

    // Requirement 2: proposal basis must still match current state.
    // (Stale proposals must require re-proposal, not receive a new confirmation.)
    if (storedProposal.basisDigest !== state.basisDigest) {
      throw new ApprovalError(
        "proposal " + proposal.proposalId + " basis is stale: " +
        "proposal digest=" + storedProposal.basisDigest.slice(0, 16) + "… " +
        "current digest=" + state.basisDigest.slice(0, 16) + "… — re-propose required"
      );
    }

    // Requirement 3: feasibility must pass.
    const feasibility = inspectFeasibility(storedProposal, state, this.feasibilityConfig);
    if (!feasibility.pass) {
      throw new ApprovalError(
        "proposal " + proposal.proposalId + " failed feasibility: " + feasibility.violatedRules.join(", ")
      );
    }

    const actionId = `act-${storedProposal.proposalId}-r${state.revision}`;

    // Build the executable payload projection and compute its digest fresh.
    const payloadProjection = {
      actionType: storedProposal.actionType,
      parameters: storedProposal.parameters,
      basisRevision: state.revision,
      basisDigest: state.basisDigest,
    };
    const payloadDigest = computeExecutablePayloadDigest(payloadProjection);

    const action: Action = {
      actionId,
      proposalId: storedProposal.proposalId,
      actionType: storedProposal.actionType,
      parameters: deepCopy(storedProposal.parameters),
      basisRevision: state.revision,
      basisDigest: state.basisDigest,
      payloadDigest,
    };

    // Record the confirmation.
    const confirmation: ActionConfirmation = {
      actionId,
      proposalId: storedProposal.proposalId,
      payloadDigest,
      basisRevision: state.revision,
      basisDigest: state.basisDigest,
      confirmedAt: state.tick,
    };
    this._actionLedger.recordConfirmation(confirmation);

    this._appendEvent({
      eventId: this._nextEventId("ActionApproved"),
      kind: "ActionApproved",
      tick: state.tick,
      revision: state.revision,
      basisDigest: state.basisDigest,
      actionId,
      proposalId: storedProposal.proposalId,
    });

    return { action };
  }

  // ─── Execute ─────────────────────────────────────────────────────────────

  execute(action: Action): ExecutionResult {
    const result = executeAction(action, this._currentState, {
      ledger: this._actionLedger,
      eventLog: this._eventLog,
      proposals: this._proposals,
    });

    if (result.kind === "applied") {
      this._currentState = deepFreeze(result.newState);
      this._revisionHistory.push(this._currentState);
      // Return a copy in the result so caller cannot mutate internal state.
      return { ...result, newState: deepCopy(result.newState) };
    }

    return result;
  }

  // ─── Evaluate boundary ───────────────────────────────────────────────────

  async evaluate(request: EvaluateRequest): Promise<EvaluateResult> {
    let result: EvaluateResult;
    try {
      result = await this.evaluateAdapter.evaluate(request);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      result = { status: "error", detail };
    }

    if (result.status === "unconfigured" || result.status === "error") {
      this._appendEvent({
        eventId: this._nextEventId("EvaluateUnconfigured"),
        kind: "EvaluateUnconfigured",
        tick: this._currentState.tick,
        revision: this._currentState.revision,
        basisDigest: this._currentState.basisDigest,
        note: "local lab, no hosted evaluation performed",
      });
    }

    return result;
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private _buildInitialState(name: ScenarioName, tickLimit?: number): ScenarioState {
    let state: ScenarioState;
    if (name === "queue-storm") {
      state = makeInitialQueueStormState();
    } else {
      state = makeInitialDatabasePressureState();
    }
    if (tickLimit !== undefined) {
      state = { ...state, tickLimit };
    }
    return state;
  }

  private _appendEvent(event: LabEvent): void {
    this._eventLog.append(event);
    this._eventCounter += 1;
  }

  private _nextEventId(kind: string): string {
    return EventLog.makeEventId(this._currentState.tick, kind, this._eventCounter);
  }

  private _appendTerminatedEvent(reason: TerminationReason): void {
    this._appendEvent({
      eventId: this._nextEventId("ScenarioTerminated"),
      kind: "ScenarioTerminated",
      tick: this._currentState.tick,
      revision: this._currentState.revision,
      basisDigest: this._currentState.basisDigest,
      reason,
    });
  }
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * Deep-freeze a JSON-compatible object so that no stored snapshot can be mutated.
 * Returns the same reference (narrowed to Readonly).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return value;
}
