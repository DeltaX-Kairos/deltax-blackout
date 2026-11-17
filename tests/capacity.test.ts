/**
 * Capacity constraint tests for CORE-REVIEW-006.
 * Enforces downstream DB connection budget (<=100) for queue-storm scenarios.
 *
 * Rules verified:
 * - CEILINGS.queueDbConnections is 100, separately from database-pressure pool ceiling (200).
 * - Exact projected formula: current.dbConnectionCount + (targetWorkerCount - current.workerCount) * 3 <= 100.
 * - Initial 48 + 24 = 72 passes both inspection and executor.
 * - Injected 94 + 24 = 118 fails max-resource-use both at inspection and executor.
 * - High operator-reported support does not bypass constraint.
 * - Malicious understated predictedEffects does not bypass actual parameter projection.
 * - Boundary exact 100 passes; boundary 101 fails.
 * - Executing a rejected confirmed action produces NO mutation of state, revision, or ledger consumed status.
 * - Throttle queue remains feasible under DB pressure.
 * - Check numeric integer target before arithmetic — fail-closed on non-integer/malformed params.
 * - RecoveryCore integration: post-injection fresh scaling is rejected, throttling succeeds.
 *
 * All tests use node:test and node:assert/strict only. Zero hosted calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type {
  Proposal,
  ScenarioState,
  Action,
  ActionConfirmation,
  QueueStormOperationalState,
} from "../src/types.js";
import { CEILINGS, FLOORS } from "../src/types.js";
import { inspectFeasibility } from "../src/feasibility.js";
import { executeAction } from "../src/executor.js";
import { EventLog } from "../src/event-log.js";
import { ActionLedger } from "../src/action-ledger.js";
import { computeBasisDigest, computeExecutablePayloadDigest } from "../src/digest.js";
import { RecoveryCore, ApprovalError } from "../src/recovery-core.js";
import { TickClock } from "../src/clock.js";
import { Mulberry32 } from "../src/rng.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeQueueStormState(
  workerCount: number,
  dbConnectionCount: number,
  opts?: { tick?: number; revision?: number; ingestionRateCap?: number | null }
): ScenarioState {
  const tick = opts?.tick ?? 0;
  const revision = opts?.revision ?? 1;
  const ingestionRateCap = opts?.ingestionRateCap ?? null;
  const operationalState: QueueStormOperationalState = {
    kind: "queue-storm",
    arrivalRatePerTick: 120,
    queueDepth: 4800,
    workerCount,
    ingestionRateCap,
    errorRate: 0.42,
    dbConnectionCount,
  };
  const partial = {
    scenarioId: "queue-storm",
    tick,
    revision,
    status: "running" as const,
    tickLimit: 100,
    operationalState,
  };
  const basisDigest = computeBasisDigest(partial);
  return { ...partial, basisDigest };
}

function makeScaleProposal(
  proposalId: string,
  targetWorkerCount: unknown,
  state: ScenarioState,
  opts?: {
    predictedEffects?: Record<string, number | string | boolean | null>;
    operatorReportedSupport?: number;
    source?: "scripted" | "hosted-evaluate" | "model";
  }
): Proposal {
  const parameters: Record<string, number | string | boolean | null> = {
    targetWorkerCount: targetWorkerCount as number,
  };
  const payloadProjection = {
    actionType: "scale-workers" as const,
    parameters,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const qs = state.operationalState as QueueStormOperationalState;
  const defaultPredictedConns = typeof targetWorkerCount === "number"
    ? qs.dbConnectionCount + (targetWorkerCount - qs.workerCount) * 3
    : 0;

  return {
    proposalId,
    source: opts?.source ?? "scripted",
    description: `[scripted] Scale worker pool to ${targetWorkerCount}`,
    assumptions: ["Database capacity check"],
    predictedEffects: opts?.predictedEffects ?? {
      workerCount: targetWorkerCount as number,
      dbConnectionCount: defaultPredictedConns,
    },
    operatorReportedSupport: opts?.operatorReportedSupport ?? 0.85,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "analyze",
    actionType: "scale-workers",
    parameters,
    payloadDigest: computeExecutablePayloadDigest(payloadProjection),
  };
}

function makeThrottleProposal(
  proposalId: string,
  capRate: unknown,
  state: ScenarioState
): Proposal {
  const parameters: Record<string, number | string | boolean | null> = {
    capRate: capRate as number,
  };
  const payloadProjection = {
    actionType: "throttle-queue" as const,
    parameters,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  return {
    proposalId,
    source: "scripted",
    description: `[scripted] Apply queue ingestion cap of ${capRate} msgs/tick`,
    assumptions: ["Throttling sheds excess load"],
    predictedEffects: {
      ingestionRateCap: capRate as number,
    },
    operatorReportedSupport: 0.70,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "compare",
    actionType: "throttle-queue",
    parameters,
    payloadDigest: computeExecutablePayloadDigest(payloadProjection),
  };
}

function makeConfirmedAction(
  proposal: Proposal,
  state: ScenarioState,
  ledger: ActionLedger
): Action {
  const actionId = `act-${proposal.proposalId}-r${state.revision}`;
  const payloadProjection = {
    actionType: proposal.actionType,
    parameters: proposal.parameters,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const payloadDigest = computeExecutablePayloadDigest(payloadProjection);

  const action: Action = {
    actionId,
    proposalId: proposal.proposalId,
    actionType: proposal.actionType,
    parameters: { ...proposal.parameters },
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    payloadDigest,
  };

  const confirmation: ActionConfirmation = {
    actionId,
    proposalId: proposal.proposalId,
    payloadDigest,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    confirmedAt: state.tick,
  };
  ledger.recordConfirmation(confirmation);

  return action;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CORE-REVIEW-006: downstream queue DB connection budget", () => {
  test("constants — queueDbConnections is 100, distinct from database-pressure ceiling of 200", () => {
    assert.equal(CEILINGS.queueDbConnections, 100);
    assert.equal(CEILINGS.connectionCount, 200);
    assert.notEqual(CEILINGS.queueDbConnections, CEILINGS.connectionCount);
  });

  describe("Feasibility inspection", () => {
    test("initial 48 + 24 = 72 passes feasibility", () => {
      // Initial state: 4 workers, 48 DB connections. Scaling to 12 adds 8 workers * 3 = 24 connections.
      // Projected = 48 + 24 = 72 <= 100.
      const state = makeQueueStormState(4, 48);
      const proposal = makeScaleProposal("prop-qs-init", 12, state);

      const result = inspectFeasibility(proposal, state);
      assert.equal(result.pass, true);
      assert.deepEqual(result.violatedRules, []);
    });

    test("injected 94 + 24 = 118 fails max-resource-use", () => {
      // Injected state: 4 workers, 94 DB connections. Scaling to 12 adds 8 workers * 3 = 24 connections.
      // Projected = 94 + 24 = 118 > 100.
      const state = makeQueueStormState(4, 94);
      const proposal = makeScaleProposal("prop-qs-injected", 12, state);

      const result = inspectFeasibility(proposal, state);
      assert.equal(result.pass, false);
      assert.ok(result.violatedRules.includes("max-resource-use"));
    });

    test("high caller-reported support does not bypass constraint", () => {
      const state = makeQueueStormState(4, 94);
      const proposal = makeScaleProposal("prop-qs-high-support", 12, state, {
        operatorReportedSupport: 0.99,
        source: "hosted-evaluate",
      });

      const result = inspectFeasibility(proposal, state);
      assert.equal(result.pass, false);
      assert.ok(result.violatedRules.includes("max-resource-use"));
    });

    test("malicious understated predictedEffects does not bypass actual projection", () => {
      // Proposal maliciously claims it will only produce 50 DB connections.
      const state = makeQueueStormState(4, 94);
      const proposal = makeScaleProposal("prop-qs-deceptive", 12, state, {
        predictedEffects: { dbConnectionCount: 50, workerCount: 12 },
      });

      const result = inspectFeasibility(proposal, state);
      assert.equal(result.pass, false);
      assert.ok(result.violatedRules.includes("max-resource-use"));
    });

    test("boundary exact 100 passes feasibility", () => {
      // 94 connections, 4 workers -> target 6 workers adds 2 workers * 3 = 6 connections.
      // Projected = 94 + 6 = 100 <= 100.
      const state = makeQueueStormState(4, 94);
      const proposal = makeScaleProposal("prop-qs-exact-100", 6, state);

      const result = inspectFeasibility(proposal, state);
      assert.equal(result.pass, true);
      assert.deepEqual(result.violatedRules, []);
    });

    test("boundary 101 fails max-resource-use", () => {
      // 95 connections, 4 workers -> target 6 workers adds 2 workers * 3 = 6 connections.
      // Projected = 95 + 6 = 101 > 100.
      const state = makeQueueStormState(4, 95);
      const proposal = makeScaleProposal("prop-qs-boundary-101", 6, state);

      const result = inspectFeasibility(proposal, state);
      assert.equal(result.pass, false);
      assert.ok(result.violatedRules.includes("max-resource-use"));
    });

    test("throttle-queue remains feasible under DB pressure", () => {
      // High DB pressure state: 94 connections. Throttling does not add workers or DB connections.
      const state = makeQueueStormState(4, 94);
      const proposal = makeThrottleProposal("prop-qs-throttle", 60, state);

      const result = inspectFeasibility(proposal, state);
      assert.equal(result.pass, true);
      assert.deepEqual(result.violatedRules, []);
    });

    test("check numeric integer target before arithmetic — fail-closed on malformed params", () => {
      const state = makeQueueStormState(4, 48);

      const malformedCases = [
        "12",       // string
        12.5,       // float
        NaN,        // NaN
        Infinity,   // Infinity
        -Infinity,  // -Infinity
        undefined,  // missing
        null,       // null
        {},         // object
        [],         // array
      ];

      for (const badValue of malformedCases) {
        const proposal = makeScaleProposal("prop-qs-bad", badValue, state);
        const result = inspectFeasibility(proposal, state);
        assert.equal(result.pass, false, `Expected malformed value ${String(badValue)} to fail feasibility`);
      }
    });
  });

  describe("Executor independent enforcement", () => {
    test("initial 48 + 24 = 72 applies successfully and updates dbConnectionCount", () => {
      const state = makeQueueStormState(4, 48);
      const proposal = makeScaleProposal("prop-qs-exec-init", 12, state);
      const ledger = new ActionLedger();
      const eventLog = new EventLog();
      const action = makeConfirmedAction(proposal, state, ledger);
      const deps = { ledger, eventLog, proposals: new Map([[proposal.proposalId, proposal]]) };

      const result = executeAction(action, state, deps);
      assert.equal(result.kind, "applied");
      if (result.kind === "applied") {
        const qs = result.newState.operationalState as QueueStormOperationalState;
        assert.equal(qs.workerCount, 12);
        assert.equal(qs.dbConnectionCount, 72);
        assert.equal(result.receipt.observedEffects["workerCount"], 12);
        assert.equal(result.receipt.observedEffects["dbConnectionCount"], 72);
        assert.ok(ledger.isConsumed(action.actionId));
      }
    });

    test("injected 94 + 24 = 118 rejected with feasibility-failed at executor", () => {
      const state = makeQueueStormState(4, 94);
      const proposal = makeScaleProposal("prop-qs-exec-118", 12, state);
      const ledger = new ActionLedger();
      const eventLog = new EventLog();
      const action = makeConfirmedAction(proposal, state, ledger);
      const deps = { ledger, eventLog, proposals: new Map([[proposal.proposalId, proposal]]) };

      const result = executeAction(action, state, deps);
      assert.equal(result.kind, "feasibility-failed");
      if (result.kind === "feasibility-failed") {
        assert.ok(result.result.violatedRules.includes("max-resource-use"));
      }
    });

    test("executing rejected confirmed action produces NO mutation on state or revision", () => {
      const state = makeQueueStormState(4, 94, { tick: 3, revision: 5 });
      const proposal = makeScaleProposal("prop-qs-rejected-mutate", 12, state);
      const ledger = new ActionLedger();
      const eventLog = new EventLog();
      const action = makeConfirmedAction(proposal, state, ledger);
      const deps = { ledger, eventLog, proposals: new Map([[proposal.proposalId, proposal]]) };

      const initialDigest = state.basisDigest;
      const initialRevision = state.revision;
      const initialWorkers = (state.operationalState as QueueStormOperationalState).workerCount;
      const initialConns = (state.operationalState as QueueStormOperationalState).dbConnectionCount;

      const result = executeAction(action, state, deps);
      assert.equal(result.kind, "feasibility-failed");

      // Verify no mutation on state.
      const qs = state.operationalState as QueueStormOperationalState;
      assert.equal(qs.workerCount, initialWorkers);
      assert.equal(qs.dbConnectionCount, initialConns);
      assert.equal(state.revision, initialRevision);
      assert.equal(state.basisDigest, initialDigest);

      // Verify action is NOT consumed in ledger.
      assert.equal(ledger.isConsumed(action.actionId), false);

      // Verify FeasibilityRejected event logged, but NO ActionApplied event.
      const appliedEvents = eventLog.events.filter((e) => e.kind === "ActionApplied");
      assert.equal(appliedEvents.length, 0);
      const rejectedEvents = eventLog.events.filter((e) => e.kind === "FeasibilityRejected");
      assert.equal(rejectedEvents.length, 1);
    });

    test("boundary exact 100 applies at executor", () => {
      const state = makeQueueStormState(4, 94);
      const proposal = makeScaleProposal("prop-qs-exec-100", 6, state);
      const ledger = new ActionLedger();
      const eventLog = new EventLog();
      const action = makeConfirmedAction(proposal, state, ledger);
      const deps = { ledger, eventLog, proposals: new Map([[proposal.proposalId, proposal]]) };

      const result = executeAction(action, state, deps);
      assert.equal(result.kind, "applied");
      if (result.kind === "applied") {
        const qs = result.newState.operationalState as QueueStormOperationalState;
        assert.equal(qs.workerCount, 6);
        assert.equal(qs.dbConnectionCount, 100);
      }
    });

    test("boundary 101 rejected at executor", () => {
      const state = makeQueueStormState(4, 95);
      const proposal = makeScaleProposal("prop-qs-exec-101", 6, state);
      const ledger = new ActionLedger();
      const eventLog = new EventLog();
      const action = makeConfirmedAction(proposal, state, ledger);
      const deps = { ledger, eventLog, proposals: new Map([[proposal.proposalId, proposal]]) };

      const result = executeAction(action, state, deps);
      assert.equal(result.kind, "feasibility-failed");
      if (result.kind === "feasibility-failed") {
        assert.ok(result.result.violatedRules.includes("max-resource-use"));
      }
    });

    test("malicious understated predictedEffects rejected at executor independently", () => {
      const state = makeQueueStormState(4, 94);
      const proposal = makeScaleProposal("prop-qs-exec-deceptive", 12, state, {
        predictedEffects: { dbConnectionCount: 30, workerCount: 12 },
      });
      const ledger = new ActionLedger();
      const eventLog = new EventLog();
      const action = makeConfirmedAction(proposal, state, ledger);
      const deps = { ledger, eventLog, proposals: new Map([[proposal.proposalId, proposal]]) };

      const result = executeAction(action, state, deps);
      assert.equal(result.kind, "feasibility-failed");
      if (result.kind === "feasibility-failed") {
        assert.ok(result.result.violatedRules.includes("max-resource-use"));
      }
    });

    test("throttle-queue applies at executor under elevated DB pressure", () => {
      const state = makeQueueStormState(4, 94);
      const proposal = makeThrottleProposal("prop-qs-exec-throttle", 60, state);
      const ledger = new ActionLedger();
      const eventLog = new EventLog();
      const action = makeConfirmedAction(proposal, state, ledger);
      const deps = { ledger, eventLog, proposals: new Map([[proposal.proposalId, proposal]]) };

      const result = executeAction(action, state, deps);
      assert.equal(result.kind, "applied");
      if (result.kind === "applied") {
        const qs = result.newState.operationalState as QueueStormOperationalState;
        assert.equal(qs.ingestionRateCap, 60);
        assert.equal(qs.dbConnectionCount, 94);
        assert.equal(qs.workerCount, 4);
      }
    });
  });

  describe("RecoveryCore end-to-end integration", () => {
    test("initial scaling passes, injection invalidates scaling, throttle succeeds", () => {
      const clock = new TickClock(0);
      const rng = new Mulberry32(42);
      const core = new RecoveryCore({
        clock,
        rng,
        scenarioName: "queue-storm",
        seed: 42,
      });

      // 1. Initial observation: 4 workers, 48 connections.
      const initialOp = core.currentState.operationalState as QueueStormOperationalState;
      assert.equal(initialOp.workerCount, 4);
      assert.equal(initialOp.dbConnectionCount, 48);

      // 2. Initial propose: scale proposal is feasible (48 + 24 = 72 <= 100).
      const { proposals: initProposals } = core.propose();
      const scaleInit = initProposals.find((p) => p.actionType === "scale-workers");
      assert.ok(scaleInit !== undefined);
      const inspectInit = core.inspect(scaleInit);
      assert.equal(inspectInit.feasibility.pass, true);

      // 3. Inject incident: database-pressure-queue-storm elevates DB connections to 94.
      const injectResult = core.injectIncident("database-pressure-queue-storm");
      assert.equal(injectResult.kind, "injected");
      const injectedOp = core.currentState.operationalState as QueueStormOperationalState;
      assert.equal(injectedOp.dbConnectionCount, 94);

      // 4. Fresh propose on new basis (post-injection):
      const { proposals: freshProposals } = core.propose();
      const scaleFresh = freshProposals.find((p) => p.actionType === "scale-workers");
      const throttleFresh = freshProposals.find((p) => p.actionType === "throttle-queue");
      assert.ok(scaleFresh !== undefined);
      assert.ok(throttleFresh !== undefined);

      // Fresh scaling is infeasible (94 + 24 = 118 > 100).
      const inspectScale = core.inspect(scaleFresh);
      assert.equal(inspectScale.feasibility.pass, false);
      assert.ok(inspectScale.feasibility.violatedRules.includes("max-resource-use"));

      // Attempting to approve the infeasible scale proposal throws ApprovalError.
      assert.throws(() => core.approve(scaleFresh), ApprovalError);

      // Throttle proposal is still feasible.
      const inspectThrottle = core.inspect(throttleFresh);
      assert.equal(inspectThrottle.feasibility.pass, true);

      // Approve and execute throttle action — succeeds.
      const { action: throttleAction } = core.approve(throttleFresh);
      const execResult = core.execute(throttleAction);
      assert.equal(execResult.kind, "applied");
      if (execResult.kind === "applied") {
        const finalOp = core.currentState.operationalState as QueueStormOperationalState;
        assert.equal(finalOp.ingestionRateCap, throttleAction.parameters["capRate"]);
        assert.equal(finalOp.dbConnectionCount, 94);
      }
    });
  });
});
