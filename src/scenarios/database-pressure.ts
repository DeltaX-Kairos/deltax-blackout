/**
 * Database Pressure scenario — fictional incident definition.
 *
 * Incident: a primary database is under heavy load. One of two read replicas
 * has become unavailable. The connection pool is saturated, causing high query
 * latency and elevated error rates across the application tier.
 *
 * All data is fictional and explicitly simulated.
 */

import type {
  ScenarioState,
  Proposal,
  DatabasePressureOperationalState,
} from "../types.js";
import { DEFAULT_TICK_LIMIT } from "../types.js";
import { computeBasisDigest, computeExecutablePayloadDigest } from "../digest.js";
import type { Rng } from "../rng.js";

export const DB_PRESSURE_SCENARIO_ID = "database-pressure";

export function initialDatabasePressureState(): Omit<ScenarioState, "basisDigest"> {
  const operationalState: DatabasePressureOperationalState = {
    kind: "database-pressure",
    appServerCount: 6,         // 6 application servers (simulated)
    replicaAvailability: 0.5,  // 1 of 2 replicas available (simulated)
    connectionCount: 185,      // 185 / 200 connections used (simulated)
    queryLatencyMs: 1240,      // 1240ms avg query latency (simulated)
    errorRate: 0.31,           // 31% error rate (simulated)
    failoverTriggered: false,
  };

  const partial = {
    scenarioId: DB_PRESSURE_SCENARIO_ID,
    tick: 0,
    revision: 1,
    status: "running" as const,
    operationalState,
    tickLimit: DEFAULT_TICK_LIMIT,
  };

  return partial;
}

/** Build a full initial state with digest. */
export function makeInitialDatabasePressureState(): ScenarioState {
  const partial = initialDatabasePressureState();
  const basisDigest = computeBasisDigest(partial);
  return { ...partial, basisDigest };
}

/**
 * Generate scripted proposals for the current Database Pressure state.
 * Returns two proposals: reduce connections and replica failover.
 */
export function generateDatabasePressureProposals(
  state: ScenarioState,
  rng: Rng
): Proposal[] {
  const os = state.operationalState as DatabasePressureOperationalState;

  // Proposal 1: Reduce connection pool
  const targetConns = Math.max(Math.round(os.connectionCount * 0.6), 50);
  const reduceConnsParameters: Record<string, number | string | boolean | null> = {
    targetConnectionCount: targetConns,
  };
  const reduceConnsProjection = {
    actionType: "reduce-connections" as const,
    parameters: reduceConnsParameters,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const reduceConnsPayload = {
    source: "scripted" as const,
    description: "[scripted] Reduce connection pool from " + os.connectionCount + " to " + targetConns + " connections",
    assumptions: [
      "Reducing connections lowers DB lock contention",
      "App servers queue requests locally rather than failing",
      "Pool size stabilises at target within 2 ticks",
    ],
    predictedEffects: {
      connectionCount: targetConns,
      queryLatencyMs: Math.round(os.queryLatencyMs * 0.55),
      errorRate: parseFloat((os.errorRate * 0.6).toFixed(2)),
      replicaAvailability: os.replicaAvailability,
    },
    operatorReportedSupport: 0.75 + rng.next() * 0.1,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "analyze" as const,
    actionType: "reduce-connections" as const,
    parameters: reduceConnsParameters,
  };
  const reduceConnsId = "prop-db-reduce-" + state.revision;
  const reduceConnsPayloadDigest = computeExecutablePayloadDigest(reduceConnsProjection);

  // Proposal 2: Trigger replica failover
  const failoverParameters: Record<string, number | string | boolean | null> = {};
  const failoverProjection = {
    actionType: "replica-failover" as const,
    parameters: failoverParameters,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const failoverPayload = {
    source: "scripted" as const,
    description: "[scripted] Trigger failover — promote standby replica to read replica",
    assumptions: [
      "Standby replica is in sync and can serve reads",
      "Failover completes within 3 ticks",
      "Primary write load does not increase during failover",
    ],
    predictedEffects: {
      replicaAvailability: 1.0,
      queryLatencyMs: Math.round(os.queryLatencyMs * 0.4),
      errorRate: parseFloat((os.errorRate * 0.4).toFixed(2)),
      connectionCount: os.connectionCount,
      failoverTriggered: true,
    },
    operatorReportedSupport: 0.70 + rng.next() * 0.1,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "validate" as const,
    actionType: "replica-failover" as const,
    parameters: failoverParameters,
  };
  const failoverId = "prop-db-failover-" + state.revision;
  const failoverPayloadDigest = computeExecutablePayloadDigest(failoverProjection);

  return [
    { proposalId: reduceConnsId, payloadDigest: reduceConnsPayloadDigest, ...reduceConnsPayload },
    { proposalId: failoverId, payloadDigest: failoverPayloadDigest, ...failoverPayload },
  ];
}

/**
 * Natural termination condition: error rate < 0.05 and query latency < 300ms.
 */
export function isDatabasePressureResolved(state: ScenarioState): boolean {
  if (state.operationalState.kind !== "database-pressure") return false;
  const os = state.operationalState as DatabasePressureOperationalState;
  return os.errorRate < 0.05 && os.queryLatencyMs < 300;
}
