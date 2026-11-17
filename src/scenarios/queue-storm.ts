/**
 * Queue Storm scenario — fictional incident definition.
 *
 * Incident: an API gateway is receiving elevated traffic that overwhelms the
 * message queue. Workers cannot drain the backlog fast enough. Database
 * connections are approaching capacity.
 *
 * All data is fictional and explicitly simulated.
 */

import type {
  ScenarioState,
  Proposal,
  QueueStormOperationalState,
} from "../types.js";
import { DEFAULT_TICK_LIMIT } from "../types.js";
import { computeBasisDigest, computeExecutablePayloadDigest } from "../digest.js";
import type { Rng } from "../rng.js";

export const QUEUE_STORM_SCENARIO_ID = "queue-storm";

export function initialQueueStormState(): Omit<ScenarioState, "basisDigest"> {
  const operationalState: QueueStormOperationalState = {
    kind: "queue-storm",
    arrivalRatePerTick: 120,   // 120 requests/tick (simulated)
    queueDepth: 4800,          // 4800 messages backlogged (simulated)
    workerCount: 4,            // only 4 workers (simulated)
    ingestionRateCap: null,    // uncapped initially
    errorRate: 0.42,           // 42% error rate (simulated)
    dbConnectionCount: 48,     // 48 open DB connections (simulated)
  };

  const partial = {
    scenarioId: QUEUE_STORM_SCENARIO_ID,
    tick: 0,
    revision: 1,
    status: "running" as const,
    operationalState,
    tickLimit: DEFAULT_TICK_LIMIT,
  };

  return partial;
}

/** Build a full initial state with digest. */
export function makeInitialQueueStormState(): ScenarioState {
  const partial = initialQueueStormState();
  const basisDigest = computeBasisDigest(partial);
  return { ...partial, basisDigest };
}

/**
 * Generate scripted proposals for the current Queue Storm state.
 * Returns two proposals: scale workers and throttle queue.
 */
export function generateQueueStormProposals(
  state: ScenarioState,
  rng: Rng
): Proposal[] {
  const os = state.operationalState as QueueStormOperationalState;

  // Proposal 1: Scale workers up
  const targetWorkers = Math.min(os.workerCount * 3, 12);
  const scaleWorkersParameters: Record<string, number | string | boolean | null> = {
    targetWorkerCount: targetWorkers,
  };
  const scaleWorkersPayloadProjection = {
    actionType: "scale-workers" as const,
    parameters: scaleWorkersParameters,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const scaleWorkersPayload = {
    source: "scripted" as const,
    description: "[scripted] Scale worker pool from " + os.workerCount + " to " + targetWorkers + " workers",
    assumptions: [
      "Database can handle additional connection load from new workers",
      "Worker startup time is negligible compared to queue drain time",
      "Arrival rate stays below " + (targetWorkers * 30) + " req/tick after scaling",
    ],
    predictedEffects: {
      workerCount: targetWorkers,
      queueDepth: Math.round(os.queueDepth * 0.4),
      errorRate: parseFloat((os.errorRate * 0.5).toFixed(2)),
      dbConnectionCount: os.dbConnectionCount + (targetWorkers - os.workerCount) * 3,
    },
    operatorReportedSupport: 0.80 + rng.next() * 0.1,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "analyze" as const,
    actionType: "scale-workers" as const,
    parameters: scaleWorkersParameters,
  };
  const scaleWorkersId = "prop-qs-scale-" + state.revision;
  const scaleWorkersPayloadDigest = computeExecutablePayloadDigest(scaleWorkersPayloadProjection);

  // Proposal 2: Throttle queue ingestion
  const capRate = Math.round(os.arrivalRatePerTick * 0.5);
  const throttleParameters: Record<string, number | string | boolean | null> = { capRate };
  const throttlePayloadProjection = {
    actionType: "throttle-queue" as const,
    parameters: throttleParameters,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const throttlePayload = {
    source: "scripted" as const,
    description: "[scripted] Apply queue ingestion cap of " + capRate + " msgs/tick",
    assumptions: [
      "Throttling reduces error rate by shedding excess load",
      "Shed requests return 429; clients implement backoff",
      "Ingestion cap holds while backlog drains",
    ],
    predictedEffects: {
      ingestionRateCap: capRate,
      queueDepth: Math.round(os.queueDepth * 0.7),
      errorRate: parseFloat((os.errorRate * 0.6).toFixed(2)),
      workerCount: os.workerCount,
    },
    operatorReportedSupport: 0.65 + rng.next() * 0.1,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "compare" as const,
    actionType: "throttle-queue" as const,
    parameters: throttleParameters,
  };
  const throttleId = "prop-qs-throttle-" + state.revision;
  const throttlePayloadDigest = computeExecutablePayloadDigest(throttlePayloadProjection);

  return [
    { proposalId: scaleWorkersId, payloadDigest: scaleWorkersPayloadDigest, ...scaleWorkersPayload },
    { proposalId: throttleId, payloadDigest: throttlePayloadDigest, ...throttlePayload },
  ];
}

/**
 * Natural termination condition: queue depth < 100 and error rate < 0.05.
 */
export function isQueueStormResolved(state: ScenarioState): boolean {
  if (state.operationalState.kind !== "queue-storm") return false;
  const os = state.operationalState as QueueStormOperationalState;
  return os.queueDepth < 100 && os.errorRate < 0.05;
}
