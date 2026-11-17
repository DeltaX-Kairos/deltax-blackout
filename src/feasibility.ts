/**
 * FeasibilityInspector: evaluates five named rules against a Proposal
 * and the current ScenarioState.
 */

import type {
  Proposal,
  ScenarioState,
  FeasibilityResult,
  FeasibilityRuleName,
  QueueStormOperationalState,
  DatabasePressureOperationalState,
} from "./types.js";
import { DEFAULT_FRESHNESS_THRESHOLD_TICKS, FLOORS, CEILINGS } from "./types.js";

export interface FeasibilityConfig {
  freshnessThresholdTicks: number;
}

const DEFAULT_CONFIG: FeasibilityConfig = {
  freshnessThresholdTicks: DEFAULT_FRESHNESS_THRESHOLD_TICKS,
};

/**
 * Evaluate all five feasibility rules.
 */
export function inspectFeasibility(
  proposal: Proposal,
  currentState: ScenarioState,
  config: FeasibilityConfig = DEFAULT_CONFIG
): FeasibilityResult {
  const violated: FeasibilityRuleName[] = [];

  // 1. observation-freshness
  const age = currentState.tick - proposal.basisRevision; // using basisRevision as a tick proxy
  // More precisely, compare the basis tick (which we store in basisRevision) to current tick.
  // We store basisRevision as the revision number, not the tick. We need to check state tick vs proposal basis tick.
  // The proposal.basisDigest encodes the state at proposal time; we compare the stateAge below.
  // Since we don't store basisTick separately, we use proposal.basisRevision as an index,
  // and compare currentState.revision - proposal.basisRevision as a proxy for how many
  // state advances have happened since the proposal was generated.
  const revisionAge = currentState.revision - proposal.basisRevision;
  if (revisionAge > config.freshnessThresholdTicks) {
    violated.push("observation-freshness");
  }

  // 2. capacity-floor
  if (checkCapacityFloorViolation(proposal, currentState)) {
    violated.push("capacity-floor");
  }

  // 3. max-resource-use
  if (checkMaxResourceUseViolation(proposal, currentState)) {
    violated.push("max-resource-use");
  }

  // 4. replica-availability
  if (checkReplicaAvailabilityViolation(proposal, currentState)) {
    violated.push("replica-availability");
  }

  // 5. action-applicability
  if (checkActionApplicabilityViolation(proposal, currentState)) {
    violated.push("action-applicability");
  }

  return {
    pass: violated.length === 0,
    violatedRules: violated,
  };
}

function checkCapacityFloorViolation(proposal: Proposal, state: ScenarioState): boolean {
  const os = state.operationalState;
  if (os.kind === "queue-storm") {
    if (proposal.actionType === "scale-workers") {
      const targetWorkers = (proposal.parameters ?? {})["targetWorkerCount"] as number | undefined;
      if (targetWorkers !== undefined && targetWorkers < FLOORS.workerCount) {
        return true;
      }
    }
  }
  if (os.kind === "database-pressure") {
    if (proposal.actionType === "reduce-connections") {
      const targetConns = (proposal.parameters ?? {})["targetConnectionCount"] as number | undefined;
      if (targetConns !== undefined && targetConns < FLOORS.connectionCount) {
        return true;
      }
    }
  }
  return false;
}

function checkMaxResourceUseViolation(proposal: Proposal, state: ScenarioState): boolean {
  const os = state.operationalState;
  if (os.kind === "queue-storm") {
    if (proposal.actionType === "scale-workers") {
      const targetWorkers = (proposal.parameters ?? {})["targetWorkerCount"] as number | undefined;
      if (targetWorkers !== undefined && targetWorkers > CEILINGS.workerCount) {
        return true;
      }
    }
  }
  if (os.kind === "database-pressure") {
    if (proposal.actionType === "reduce-connections") {
      const targetConns = (proposal.parameters ?? {})["targetConnectionCount"] as number | undefined;
      if (targetConns !== undefined && targetConns > CEILINGS.connectionCount) {
        return true;
      }
    }
  }
  return false;
}

function checkReplicaAvailabilityViolation(proposal: Proposal, state: ScenarioState): boolean {
  if (state.operationalState.kind === "database-pressure") {
    const os = state.operationalState as DatabasePressureOperationalState;
    if (proposal.actionType === "replica-failover") {
      // Failover requires at least one replica to fail over to (availability < 1 means degraded)
      // But if availability is 0 (no replicas available at all), failover is impossible.
      if (os.replicaAvailability === 0) {
        return true;
      }
      // If failover already triggered, disallow a second failover.
      if (os.failoverTriggered) {
        return true;
      }
    }
  }
  return false;
}

function checkActionApplicabilityViolation(proposal: Proposal, state: ScenarioState): boolean {
  const os = state.operationalState;
  // Queue-storm actions cannot be applied to database-pressure state and vice versa.
  if (os.kind === "queue-storm") {
    if (proposal.actionType === "reduce-connections" || proposal.actionType === "replica-failover") {
      return true;
    }
  }
  if (os.kind === "database-pressure") {
    if (proposal.actionType === "scale-workers" || proposal.actionType === "throttle-queue") {
      return true;
    }
  }
  // Throttle-queue requires uncapped ingestion to be meaningful.
  if (os.kind === "queue-storm" && proposal.actionType === "throttle-queue") {
    const qs = os as QueueStormOperationalState;
    if (qs.ingestionRateCap !== null) {
      // Already throttled; re-throttling is inapplicable.
      return true;
    }
  }
  return false;
}
