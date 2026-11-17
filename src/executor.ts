/**
 * Executor: applies an Action to the current ScenarioState once and only once.
 *
 * Guards (checked in order):
 * 0. Terminal state: reject execution against a terminal scenario.
 * 1. Duplicate/consumed: action.actionId already consumed → reject, no mutation.
 *    (checked BEFORE stale-basis so a consumed+stale does not accidentally apply)
 * 2. Stale basis: action.basisDigest !== currentState.basisDigest → reject, no mutation.
 *    Also checks action.basisRevision !== currentState.revision.
 * 3. Unconfirmed / tampered payload: recompute executable payload projection from the
 *    received action fields and compare against the stored confirmation digest.
 *    A caller who keeps the original payloadDigest but changes actionType, parameters,
 *    basisRevision, or basisDigest will produce a mismatching recomputed digest.
 * 4. Parameter validation: reject non-finite, fractional, or negative values where
 *    the action type requires integer resource counts. Never clamp invalid inputs.
 * 5. Feasibility & downstream capacity constraint (CORE-REVIEW-006): reject actions
 *    that violate feasibility rules or exceed downstream DB connection budget (<=100).
 *    Independent of predictedEffects; rejected confirmed actions produce no mutation.
 * 6. Apply action, produce new ScenarioState, emit LabReceipt.
 *
 * CORE-REVIEW-003 fixes:
 *   §1  Recompute digest from action fields; don't trust the string.
 *   §2  Check consumed BEFORE stale-basis; never downgrade consumed status.
 *   §3  Check basisRevision; reject terminal state; validate params; never clamp invalid.
 *   §6  EventLog imported as value (not type) so static method call compiles.
 *
 * CORE-REVIEW-006 fix:
 *   Enforce downstream DB connection budget (<= 100) independently in executor;
 *   no mutation on rejected confirmed action.
 */

import type {
  Action,
  ScenarioState,
  ExecutionResult,
  LabReceipt,
  ObservedEffects,
  QueueStormOperationalState,
  DatabasePressureOperationalState,
} from "./types.js";
import { FLOORS } from "./types.js";
import { computeBasisDigest, computeExecutablePayloadDigest } from "./digest.js";
// Item 6 fix: import EventLog as a value, not a type, so EventLog.makeEventId compiles.
import { EventLog } from "./event-log.js";
import type { ActionLedger } from "./action-ledger.js";
import type { Proposal } from "./types.js";
import { inspectFeasibility } from "./feasibility.js";

export interface ExecutorDeps {
  ledger: ActionLedger;
  eventLog: EventLog;
  proposals: Map<string, Proposal>;
}

export function executeAction(
  action: Action,
  currentState: ScenarioState,
  deps: ExecutorDeps
): ExecutionResult {
  const { ledger, eventLog, proposals } = deps;

  // Guard 0: reject execution against terminal state.
  if (currentState.status !== "running") {
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "UnconfirmedPayloadRejected", eventLog.length),
      kind: "UnconfirmedPayloadRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      actionId: action.actionId,
      detail: "scenario is in terminal state " + currentState.status,
    };
    eventLog.append(event);
    return { kind: "unconfirmed-payload", actionId: action.actionId, detail: event.detail };
  }

  // Guard 1: duplicate/consumed — checked FIRST so consumed+stale never re-applies.
  // CORE-REVIEW-003 §2: never downgrade consumed; never let a third submission apply.
  if (ledger.isConsumed(action.actionId)) {
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "DuplicateActionRejected", eventLog.length),
      kind: "DuplicateActionRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      actionId: action.actionId,
    };
    eventLog.append(event);
    // Do NOT call markRejected here — consumed must stay consumed.
    return { kind: "duplicate-action", actionId: action.actionId };
  }

  // Guard 2: stale basis (digest AND revision must both match).
  // CORE-REVIEW-003 §3: check basisRevision separately from digest.
  const digestMismatch = action.basisDigest !== currentState.basisDigest;
  const revisionMismatch = action.basisRevision !== currentState.revision;

  if (digestMismatch || revisionMismatch) {
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "StaleBasiRejected", eventLog.length),
      kind: "StaleBasiRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      actionId: action.actionId,
      actionDigest: action.basisDigest,
      currentDigest: currentState.basisDigest,
    };
    eventLog.append(event);
    ledger.markRejected(action.actionId, "rejected-stale");
    return {
      kind: "stale-basis",
      actionDigest: action.basisDigest,
      currentDigest: currentState.basisDigest,
      currentRevision: currentState.revision,
    };
  }

  // Guard 3: unconfirmed / tampered payload.
  // CORE-REVIEW-003 §1: recompute from the received action fields; do not trust payloadDigest string.
  const confirmation = ledger.getConfirmation(action.actionId);
  if (!confirmation) {
    const detail = "no confirmation record found for actionId " + action.actionId;
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "UnconfirmedPayloadRejected", eventLog.length),
      kind: "UnconfirmedPayloadRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      actionId: action.actionId,
      detail,
    };
    eventLog.append(event);
    ledger.markRejected(action.actionId, "rejected-unconfirmed");
    return { kind: "unconfirmed-payload", actionId: action.actionId, detail };
  }

  // Check that action.proposalId matches the recorded confirmation.
  // CORE-REVIEW-003 final follow-up: changing only proposalId must fail.
  if (action.proposalId !== confirmation.proposalId) {
    const detail =
      "proposalId mismatch: action=" + action.proposalId + " confirmation=" + confirmation.proposalId;
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "UnconfirmedPayloadRejected", eventLog.length),
      kind: "UnconfirmedPayloadRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      actionId: action.actionId,
      detail,
    };
    eventLog.append(event);
    ledger.markRejected(action.actionId, "rejected-unconfirmed");
    return { kind: "unconfirmed-payload", actionId: action.actionId, detail };
  }

  // Recompute digest from the ACTUAL received fields — catches mutations where caller
  // keeps original payloadDigest but changes actionType/parameters/basisRevision/basisDigest.
  const recomputedDigest = computeExecutablePayloadDigest({
    actionType: action.actionType,
    parameters: action.parameters,
    basisRevision: action.basisRevision,
    basisDigest: action.basisDigest,
  });

  if (recomputedDigest !== confirmation.payloadDigest) {
    const detail =
      "payload tampered: recomputed=" + recomputedDigest.slice(0, 16) + "… stored=" + confirmation.payloadDigest.slice(0, 16) + "…";
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "UnconfirmedPayloadRejected", eventLog.length),
      kind: "UnconfirmedPayloadRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      actionId: action.actionId,
      detail,
    };
    eventLog.append(event);
    ledger.markRejected(action.actionId, "rejected-unconfirmed");
    return { kind: "unconfirmed-payload", actionId: action.actionId, detail };
  }

  // Guard 4: parameter validation.
  // CORE-REVIEW-003 §3: reject invalid params; never clamp them silently.
  const paramError = validateParameters(action);
  if (paramError !== null) {
    const detail = "invalid parameters: " + paramError;
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "UnconfirmedPayloadRejected", eventLog.length),
      kind: "UnconfirmedPayloadRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      actionId: action.actionId,
      detail,
    };
    eventLog.append(event);
    ledger.markRejected(action.actionId, "rejected-unconfirmed");
    return { kind: "unconfirmed-payload", actionId: action.actionId, detail };
  }

  // Guard 5: feasibility and downstream DB capacity check (CORE-REVIEW-006).
  // Enforces actual projected DB demand <= 100 independently of predictedEffects.
  // Rejection of a confirmed action produces NO mutation of state or revision.
  const storedProposal = proposals.get(action.proposalId);
  const proposalForCheck: Proposal = {
    proposalId: action.proposalId,
    source: storedProposal?.source ?? "scripted",
    description: storedProposal?.description ?? "",
    assumptions: storedProposal?.assumptions ?? [],
    predictedEffects: storedProposal?.predictedEffects ?? {},
    operatorReportedSupport: storedProposal?.operatorReportedSupport ?? 1,
    basisRevision: action.basisRevision,
    basisDigest: action.basisDigest,
    semanticClass: storedProposal?.semanticClass ?? "draft",
    actionType: action.actionType,
    parameters: action.parameters,
    payloadDigest: action.payloadDigest,
  };

  const feasibilityResult = inspectFeasibility(proposalForCheck, currentState);
  if (!feasibilityResult.pass) {
    const event = {
      eventId: EventLog.makeEventId(currentState.tick, "FeasibilityRejected", eventLog.length),
      kind: "FeasibilityRejected" as const,
      tick: currentState.tick,
      revision: currentState.revision,
      basisDigest: currentState.basisDigest,
      proposalId: action.proposalId,
      violatedRules: feasibilityResult.violatedRules,
    };
    eventLog.append(event);
    return { kind: "feasibility-failed", result: feasibilityResult };
  }

  // Apply action.
  const proposal = proposals.get(action.proposalId);
  const predictedEffects = proposal?.predictedEffects ?? {};

  const newOp = applyActionToOperationalState(action, currentState);
  const newStatePartial: Omit<ScenarioState, "basisDigest"> = {
    scenarioId: currentState.scenarioId,
    tick: currentState.tick,
    revision: currentState.revision + 1,
    status: currentState.status,
    terminationReason: currentState.terminationReason,
    operationalState: newOp,
    tickLimit: currentState.tickLimit,
  };
  const newBasisDigest = computeBasisDigest(newStatePartial);
  const newState: ScenarioState = { ...newStatePartial, basisDigest: newBasisDigest };

  // Collect observed effects.
  const observedEffects: ObservedEffects = collectObservedEffects(action, newState);

  const receipt: LabReceipt = {
    actionId: action.actionId,
    revisionBefore: currentState.revision,
    digestBefore: currentState.basisDigest,
    appliedActionDescription: action.actionType + " (proposal: " + action.proposalId + ")",
    revisionAfter: newState.revision,
    digestAfter: newBasisDigest,
    predictedEffects,
    observedEffects,
    labNote: "local lab, no hosted evaluation performed",
  };

  // Mark consumed.
  ledger.markConsumed(action.actionId, currentState.tick);

  // Append ActionApplied event.
  eventLog.append({
    eventId: EventLog.makeEventId(currentState.tick, "ActionApplied", eventLog.length),
    kind: "ActionApplied",
    tick: currentState.tick,
    revision: currentState.revision,
    basisDigest: currentState.basisDigest,
    actionId: action.actionId,
    revisionAfter: newState.revision,
    digestAfter: newBasisDigest,
  });

  return { kind: "applied", newState, receipt };
}

/**
 * Validate action parameters for the given action type.
 * Returns null if valid, or an error string if invalid.
 * CORE-REVIEW-003 §3: reject non-finite, fractional, negative, or unknown params.
 */
function validateParameters(action: Action): string | null {
  const params = action.parameters;

  if (action.actionType === "scale-workers") {
    const v = params["targetWorkerCount"];
    if (v === undefined || v === null) return "targetWorkerCount missing";
    if (typeof v !== "number") return "targetWorkerCount must be a number";
    if (!Number.isFinite(v)) return "targetWorkerCount must be finite";
    if (!Number.isInteger(v)) return "targetWorkerCount must be an integer";
    if (v < 1) return "targetWorkerCount must be >= 1";
    return null;
  }

  if (action.actionType === "throttle-queue") {
    const v = params["capRate"];
    if (v === undefined || v === null) return "capRate missing";
    if (typeof v !== "number") return "capRate must be a number";
    if (!Number.isFinite(v)) return "capRate must be finite";
    if (!Number.isInteger(v)) return "capRate must be an integer";
    if (v < 1) return "capRate must be >= 1";
    return null;
  }

  if (action.actionType === "reduce-connections") {
    const v = params["targetConnectionCount"];
    if (v === undefined || v === null) return "targetConnectionCount missing";
    if (typeof v !== "number") return "targetConnectionCount must be a number";
    if (!Number.isFinite(v)) return "targetConnectionCount must be finite";
    if (!Number.isInteger(v)) return "targetConnectionCount must be an integer";
    if (v < 1) return "targetConnectionCount must be >= 1";
    return null;
  }

  if (action.actionType === "replica-failover") {
    // No parameters required.
    return null;
  }

  return "unknown actionType: " + action.actionType;
}

function applyActionToOperationalState(
  action: Action,
  state: ScenarioState
): typeof state.operationalState {
  const op = state.operationalState;

  if (op.kind === "queue-storm") {
    const qs = op as QueueStormOperationalState;
    if (action.actionType === "scale-workers") {
      // Parameters already validated; use exact value (no clamping of valid params).
      const target = action.parameters["targetWorkerCount"] as number;
      // CORE-REVIEW-006: enforce downstream DB connection budget in executor
      // Projected total = current.dbConnectionCount + (targetWorkerCount - current.workerCount) * 3
      const projectedDbConns = qs.dbConnectionCount + (target - qs.workerCount) * 3;
      return {
        ...qs,
        workerCount: target,
        dbConnectionCount: projectedDbConns,
      };
    }
    if (action.actionType === "throttle-queue") {
      const capRate = action.parameters["capRate"] as number;
      return { ...qs, ingestionRateCap: capRate };
    }
  }

  if (op.kind === "database-pressure") {
    const db = op as DatabasePressureOperationalState;
    if (action.actionType === "reduce-connections") {
      const target = action.parameters["targetConnectionCount"] as number;
      return { ...db, connectionCount: target };
    }
    if (action.actionType === "replica-failover") {
      return {
        ...db,
        failoverTriggered: true,
        replicaAvailability: Math.min(1.0, db.replicaAvailability + 0.5),
      };
    }
  }

  // Unknown action type for the current state kind — should have been caught by validation.
  return op;
}

function collectObservedEffects(action: Action, newState: ScenarioState): ObservedEffects {
  const op = newState.operationalState;
  if (op.kind === "queue-storm") {
    const qs = op as QueueStormOperationalState;
    if (action.actionType === "scale-workers") {
      return { workerCount: qs.workerCount, dbConnectionCount: qs.dbConnectionCount };
    }
    if (action.actionType === "throttle-queue") {
      return { ingestionRateCap: qs.ingestionRateCap };
    }
  }
  if (op.kind === "database-pressure") {
    const db = op as DatabasePressureOperationalState;
    if (action.actionType === "reduce-connections") {
      return { connectionCount: db.connectionCount };
    }
    if (action.actionType === "replica-failover") {
      return { replicaAvailability: db.replicaAvailability, failoverTriggered: db.failoverTriggered };
    }
  }
  return {};
}
