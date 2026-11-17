/**
 * Deterministic state transition with an explicitly injected seeded PRNG.
 * advance(state, nextTick, rng) → ScenarioState
 *
 * Rules:
 * - No I/O or global time/randomness; explicitly advances the supplied PRNG.
 * - Rejects out-of-order ticks (nextTick must be > state.tick).
 * - In a terminal state, returns the state unchanged (rejects further ticks).
 * - Advances scenario metrics per tick according to scenario-specific rules.
 * - Checks natural termination condition after each tick.
 * - Transitions to tick-limit terminal state when tick == tickLimit.
 */

import type {
  ScenarioState,
  QueueStormOperationalState,
  DatabasePressureOperationalState,
  OperationalState,
  TerminationReason,
} from "./types.js";
import { FLOORS } from "./types.js";
import { computeBasisDigest } from "./digest.js";
import type { Rng } from "./rng.js";
import {
  isQueueStormResolved,
  QUEUE_STORM_SCENARIO_ID,
} from "./scenarios/queue-storm.js";
import {
  isDatabasePressureResolved,
  DB_PRESSURE_SCENARIO_ID,
} from "./scenarios/database-pressure.js";

export type AdvanceResult =
  | { kind: "ok"; state: ScenarioState }
  | { kind: "out-of-order-tick"; currentTick: number; requestedTick: number }
  | { kind: "already-terminal"; state: ScenarioState };

/**
 * Advance the state machine to the next tick.
 *
 * CORE-REVIEW-003 §7: Tick validation happens BEFORE the RNG is consumed.
 * Non-finite, non-integer, or out-of-sequence ticks are rejected with no RNG side-effect.
 *
 * The injected Rng is a stateful PRNG: calling rng.next() advances its internal counter.
 * This function therefore has a side-effect on the RNG object for valid advances.
 * The transition is deterministic given the same RNG state at the point of call;
 * replaying requires restoring the RNG to its pre-call state externally.
 * Tests that need replay must clone the RNG state before calling advance().
 */
export function advance(
  state: ScenarioState,
  nextTick: number,
  rng: Rng
): AdvanceResult {
  // Reject already-terminal states (no RNG consumed).
  if (state.status !== "running") {
    return { kind: "already-terminal", state };
  }

  // Reject non-finite, non-integer, and out-of-order ticks BEFORE consuming RNG.
  if (!Number.isFinite(nextTick)) {
    return {
      kind: "out-of-order-tick",
      currentTick: state.tick,
      requestedTick: nextTick,
    };
  }
  if (!Number.isInteger(nextTick)) {
    return {
      kind: "out-of-order-tick",
      currentTick: state.tick,
      requestedTick: nextTick,
    };
  }
  if (nextTick <= state.tick) {
    return {
      kind: "out-of-order-tick",
      currentTick: state.tick,
      requestedTick: nextTick,
    };
  }

  // All validation passed — now consume RNG to advance metrics.
  const newOp = advanceOperationalState(state.operationalState, state, rng);

  // Build partial new state (without basisDigest).
  const partial: Omit<ScenarioState, "basisDigest"> = {
    scenarioId: state.scenarioId,
    tick: nextTick,
    revision: state.revision + 1,
    status: "running",
    operationalState: newOp,
    tickLimit: state.tickLimit,
  };

  // Check termination.
  let terminationReason: TerminationReason | undefined;
  if (checkNaturalTermination(state.scenarioId, partial.operationalState)) {
    partial.status = "terminated-naturally";
    terminationReason = "condition-met";
  } else if (nextTick >= state.tickLimit) {
    partial.status = "terminated-by-limit";
    terminationReason = "tick-limit-reached";
  }

  if (terminationReason !== undefined) {
    (partial as ScenarioState).terminationReason = terminationReason;
  }

  const basisDigest = computeBasisDigest(partial);
  const newState: ScenarioState = { ...partial, basisDigest };

  return { kind: "ok", state: newState };
}

function checkNaturalTermination(scenarioId: string, op: OperationalState): boolean {
  if (scenarioId === QUEUE_STORM_SCENARIO_ID) {
    // We need a ScenarioState shell to call the checker.
    return isQueueStormResolved({ operationalState: op } as ScenarioState);
  }
  if (scenarioId === DB_PRESSURE_SCENARIO_ID) {
    return isDatabasePressureResolved({ operationalState: op } as ScenarioState);
  }
  return false;
}

function advanceOperationalState(
  op: OperationalState,
  state: ScenarioState,
  rng: Rng
): OperationalState {
  if (op.kind === "queue-storm") {
    return advanceQueueStorm(op, rng);
  }
  if (op.kind === "database-pressure") {
    return advanceDatabasePressure(op, rng);
  }
  return op;
}

function advanceQueueStorm(
  op: QueueStormOperationalState,
  rng: Rng
): QueueStormOperationalState {
  // Per tick: workers drain messages, new messages arrive.
  const drainCapacity = op.workerCount * 30; // each worker handles ~30 msgs/tick
  const arrivals = op.ingestionRateCap !== null
    ? Math.min(op.arrivalRatePerTick, op.ingestionRateCap)
    : op.arrivalRatePerTick;

  const netDrain = drainCapacity - arrivals;
  let newQueueDepth = Math.max(0, op.queueDepth - netDrain);

  // Add a small random variance (simulated noise).
  newQueueDepth = Math.max(0, newQueueDepth + Math.round((rng.next() - 0.5) * 20));

  // Error rate decays as queue drains.
  const queueRatio = op.queueDepth > 0 ? newQueueDepth / Math.max(op.queueDepth, 1) : 0;
  const newErrorRate = Math.max(0, Math.min(1, op.errorRate * (0.85 + queueRatio * 0.1)));

  // DB connections: scale up with workers, with noise.
  const newDbConns = Math.max(
    FLOORS.dbConnectionCount,
    op.dbConnectionCount + Math.round((rng.next() - 0.6) * 2)
  );

  return {
    ...op,
    queueDepth: Math.round(newQueueDepth),
    errorRate: parseFloat(newErrorRate.toFixed(4)),
    dbConnectionCount: newDbConns,
  };
}

function advanceDatabasePressure(
  op: DatabasePressureOperationalState,
  rng: Rng
): DatabasePressureOperationalState {
  // Latency decays slowly unless failover has been triggered.
  const decayFactor = op.failoverTriggered ? 0.6 : 0.88;
  let newLatency = op.queryLatencyMs * decayFactor + (rng.next() - 0.5) * 30;
  newLatency = Math.max(50, newLatency);

  // Error rate decays with latency improvements.
  const latencyRatio = newLatency / op.queryLatencyMs;
  const newErrorRate = Math.max(0, Math.min(1, op.errorRate * (0.75 + latencyRatio * 0.2)));

  // Connection count: slowly reduces if error rate is falling.
  let newConns = op.connectionCount;
  if (op.errorRate > 0.1) {
    newConns = Math.max(FLOORS.connectionCount, op.connectionCount - Math.round(rng.next() * 3));
  }

  // Replica availability: once failover triggered, converges to 1.0 over 3 ticks.
  let newReplicaAvail = op.replicaAvailability;
  if (op.failoverTriggered && op.replicaAvailability < 1.0) {
    newReplicaAvail = Math.min(1.0, op.replicaAvailability + 0.35);
  }

  return {
    ...op,
    queryLatencyMs: Math.round(newLatency),
    errorRate: parseFloat(newErrorRate.toFixed(4)),
    connectionCount: Math.max(FLOORS.connectionCount, newConns),
    replicaAvailability: parseFloat(newReplicaAvail.toFixed(4)),
  };
}
