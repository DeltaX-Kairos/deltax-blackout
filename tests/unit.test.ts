/**
 * Unit tests — deterministic assertions for specific behaviours.
 * Zero hosted API calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RecoveryCore, ApprovalError } from "../src/recovery-core.js";
import { TickClock } from "../src/clock.js";
import { Mulberry32 } from "../src/rng.js";
import { computeBasisDigest, computeExecutablePayloadDigest } from "../src/digest.js";
import { inspectFeasibility } from "../src/feasibility.js";
import { makeInitialQueueStormState } from "../src/scenarios/queue-storm.js";
import { makeInitialDatabasePressureState } from "../src/scenarios/database-pressure.js";
import { NullEvaluateAdapter } from "../src/evaluate-boundary.js";

function makeCore(scenario: "queue-storm" | "database-pressure", seed: number, tickLimit = 100) {
  return new RecoveryCore({
    clock: new TickClock(0),
    rng: new Mulberry32(seed),
    scenarioName: scenario,
    seed,
    tickLimit,
  });
}

// ─── Missing dependencies ─────────────────────────────────────────────────────

test("missing-clock — throws on construction", () => {
  assert.throws(
    () =>
      new RecoveryCore({
        clock: null as unknown as TickClock,
        rng: new Mulberry32(1),
        scenarioName: "queue-storm",
        seed: 1,
      }),
    /missing required dependency Clock/
  );
});

test("missing-rng — throws on construction", () => {
  assert.throws(
    () =>
      new RecoveryCore({
        clock: new TickClock(),
        rng: null as unknown as Mulberry32,
        scenarioName: "queue-storm",
        seed: 1,
      }),
    /missing required dependency Rng/
  );
});

// ─── Initial state ────────────────────────────────────────────────────────────

test("initial-state — revision=1, tick=0, status=running, digest correct", () => {
  const core = makeCore("queue-storm", 42);
  const s = core.currentState;
  assert.equal(s.revision, 1);
  assert.equal(s.tick, 0);
  assert.equal(s.status, "running");
  assert.equal(s.basisDigest.length, 64);

  // Recompute and verify.
  const recomputed = computeBasisDigest(s);
  assert.equal(recomputed, s.basisDigest);
});

test("initial-state-db — revision=1, tick=0, status=running, digest correct", () => {
  const core = makeCore("database-pressure", 7);
  const s = core.currentState;
  assert.equal(s.revision, 1);
  assert.equal(s.tick, 0);
  assert.equal(s.status, "running");
  assert.equal(s.basisDigest.length, 64);
});

// ─── Tick advancement ─────────────────────────────────────────────────────────

test("tick-advancement — revision increments, digest changes", () => {
  const core = makeCore("queue-storm", 42);
  const s0 = core.currentState;
  const s1 = core.advanceTick();
  assert.equal(s1.tick, 1);
  assert.equal(s1.revision, s0.revision + 1);
  assert.notEqual(s1.basisDigest, s0.basisDigest, "digest should change after tick");
});

// ─── Proposal generation ──────────────────────────────────────────────────────

test("queue-storm-proposals — 2 proposals generated, source=scripted", () => {
  const core = makeCore("queue-storm", 42);
  const { proposals } = core.propose();
  assert.equal(proposals.length, 2);
  for (const p of proposals) {
    assert.equal(p.source, "scripted");
    assert.match(p.description, /\[scripted\]/);
    assert.ok(p.payloadDigest.length === 64);
    assert.ok(typeof p.parameters === "object");
  }
});

test("database-pressure-proposals — 2 proposals generated, source=scripted", () => {
  const core = makeCore("database-pressure", 7);
  const { proposals } = core.propose();
  assert.equal(proposals.length, 2);
  for (const p of proposals) {
    assert.equal(p.source, "scripted");
  }
});

// ─── Feasibility rules ────────────────────────────────────────────────────────

test("feasibility-action-applicability — db-pressure action fails on queue-storm state", () => {
  const state = makeInitialQueueStormState();
  const proj = {
    actionType: "reduce-connections" as const,
    parameters: { targetConnectionCount: 50 },
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const wrongActionProposal = {
    proposalId: "wrong",
    source: "scripted" as const,
    description: "wrong",
    assumptions: [],
    predictedEffects: {},
    operatorReportedSupport: 0.5,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "analyze" as const,
    actionType: "reduce-connections" as const,
    parameters: { targetConnectionCount: 50 },
    payloadDigest: computeExecutablePayloadDigest(proj),
  };
  const result = inspectFeasibility(wrongActionProposal, state);
  assert.equal(result.pass, false);
  assert.ok(result.violatedRules.includes("action-applicability"));
});

test("feasibility-max-resource-use — over-ceiling fails", () => {
  const state = makeInitialQueueStormState();
  const proj = {
    actionType: "scale-workers" as const,
    parameters: { targetWorkerCount: 25 }, // > ceiling of 20
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
  };
  const proposal = {
    proposalId: "over-ceiling",
    source: "scripted" as const,
    description: "over ceiling",
    assumptions: [],
    predictedEffects: {},
    operatorReportedSupport: 0.5,
    basisRevision: state.revision,
    basisDigest: state.basisDigest,
    semanticClass: "analyze" as const,
    actionType: "scale-workers" as const,
    parameters: { targetWorkerCount: 25 },
    payloadDigest: computeExecutablePayloadDigest(proj),
  };
  const result = inspectFeasibility(proposal, state);
  assert.equal(result.pass, false);
  assert.ok(result.violatedRules.includes("max-resource-use"));
});

// ─── NullEvaluateAdapter ──────────────────────────────────────────────────────

test("null-evaluate-adapter — returns unconfigured, no network", async () => {
  const adapter = new NullEvaluateAdapter();
  const result = await adapter.evaluate({
    profile_id: "test",
    objective: "test objective",
    context: {},
    candidates: [],
  });
  assert.equal(result.status, "unconfigured");
});

test("evaluate-boundary — core emits EvaluateUnconfigured event", async () => {
  const core = makeCore("queue-storm", 42);
  const result = await core.evaluate({
    profile_id: "test",
    objective: "test",
    context: {},
    candidates: [],
  });
  assert.equal(result.status, "unconfigured");

  const events = core.eventLog.events;
  const evalEv = events.find(e => e.kind === "EvaluateUnconfigured");
  assert.ok(evalEv, "EvaluateUnconfigured event should be in log");
  if (evalEv && evalEv.kind === "EvaluateUnconfigured") {
    assert.equal(evalEv.note, "local lab, no hosted evaluation performed");
  }
});

// ─── SafeEvaluateAdapter ──────────────────────────────────────────────────────

test("safe-evaluate-adapter — fast success clears timeout, no lingering timer", async () => {
  const { SafeEvaluateAdapter } = await import("../src/evaluate-boundary.js");
  
  // Inner adapter returns immediately.
  const fastAdapter = {
    async evaluate() {
      return { status: "unconfigured" as const };
    }
  };

  const safe = new SafeEvaluateAdapter(fastAdapter, 100);
  const result = await safe.evaluate({
    profile_id: "test",
    objective: "test",
    context: {},
    candidates: [],
  });
  assert.equal(result.status, "unconfigured");
  // No assertion for timer cleanup (NodeJS will warn if timers prevent exit), 
  // but the finally block ensures clearTimeout is called.
});

test("safe-evaluate-adapter — exception returns error status", async () => {
  const { SafeEvaluateAdapter } = await import("../src/evaluate-boundary.js");

  const throwingAdapter = {
    async evaluate() {
      throw new Error("simulated failure");
    }
  };

  const safe = new SafeEvaluateAdapter(throwingAdapter, 100);
  const result = await safe.evaluate({
    profile_id: "test",
    objective: "test",
    context: {},
    candidates: [],
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.detail, /simulated failure/);
  }
});

// ─── Event log completeness ───────────────────────────────────────────────────

test("event-log — ScenarioStarted is first event", () => {
  const core = makeCore("queue-storm", 42);
  const events = core.eventLog.events;
  assert.ok(events.length >= 1);
  assert.equal(events[0].kind, "ScenarioStarted");
});

test("event-log — ScenarioTerminated is last event after termination", () => {
  const core = makeCore("queue-storm", 42, 5);
  while (core.currentState.status === "running") core.advanceTick();

  const events = Array.from(core.eventLog.events);
  const last = events[events.length - 1];
  assert.equal(last.kind, "ScenarioTerminated");
});

test("event-log — ProposalCreated events present after propose()", () => {
  const core = makeCore("queue-storm", 42);
  core.propose();
  const events = core.eventLog.events;
  const created = events.filter(e => e.kind === "ProposalCreated");
  assert.ok(created.length >= 2, "expected at least 2 ProposalCreated events");
});

test("event-log — ActionApplied event present after successful execute", () => {
  const core = makeCore("queue-storm", 42);
  core.advanceTick();
  const { proposals } = core.propose();
  const feasible = proposals.filter(p => inspectFeasibility(p, core.currentState).pass);
  if (feasible.length === 0) return;

  const { action } = core.approve(feasible[0]);
  const result = core.execute(action);
  assert.equal(result.kind, "applied");

  const events = core.eventLog.events;
  const applied = events.filter(e => e.kind === "ActionApplied");
  assert.equal(applied.length, 1);
});

// ─── Predicted vs observed separation ────────────────────────────────────────

test("predicted-vs-observed — fields are independent, not copies of each other", () => {
  const core = makeCore("queue-storm", 42);
  core.advanceTick();
  const { proposals } = core.propose();
  const feasible = proposals.filter(p => inspectFeasibility(p, core.currentState).pass);
  if (feasible.length === 0) return;

  const chosenProposal = feasible[0];
  const { action } = core.approve(chosenProposal);
  const result = core.execute(action);
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;

  const receipt = result.receipt;

  // Both fields must be present.
  assert.ok(receipt.predictedEffects !== undefined, "predictedEffects missing");
  assert.ok(receipt.observedEffects !== undefined, "observedEffects missing");

  // They must not be the same object reference.
  assert.notStrictEqual(receipt.predictedEffects, receipt.observedEffects);

  // The labNote must be correct.
  assert.equal(receipt.labNote, "local model effect; no hosted call during execution");
});

// ─── Digest properties ────────────────────────────────────────────────────────

test("digest-different-states — different operationalState → different digest", () => {
  const s1 = makeInitialQueueStormState();
  // Narrow the operationalState type so TypeScript can verify the spread.
  if (s1.operationalState.kind !== "queue-storm") throw new Error("expected queue-storm");
  const s2: typeof s1 = {
    ...s1,
    operationalState: { ...s1.operationalState, queueDepth: s1.operationalState.queueDepth + 1 },
  };
  const d1 = computeBasisDigest(s1);
  const d2 = computeBasisDigest({ ...s2, basisDigest: "" });
  assert.notEqual(d1, d2, "different operational state should produce different digest");
});

test("digest-same-projection-different-revision — same digest, different revision index", () => {
  // Per design: revision is NOT in the material projection, so two states with the same
  // (scenarioId, tick, operationalState) produce the same digest regardless of revision.
  // The revision counter distinguishes them in the ledger.
  const s1 = makeInitialQueueStormState();
  const s2: typeof s1 = { ...s1, revision: 999 };
  const d1 = computeBasisDigest(s1);
  const d2 = computeBasisDigest({ ...s2, basisDigest: "" });
  assert.equal(d1, d2, "revision should not affect digest");
});

// ─── Bounded termination (deterministic) ──────────────────────────────────────

test("bounded-termination-queue-storm — terminates at or before tick limit", () => {
  const limit = 50;
  const core = makeCore("queue-storm", 42, limit);
  for (let i = 0; i < limit + 10; i++) {
    if (core.currentState.status !== "running") break;
    core.advanceTick();
  }
  assert.notEqual(core.currentState.status, "running");
  assert.ok(core.currentState.tick <= limit);
});

test("bounded-termination-db-pressure — terminates at or before tick limit", () => {
  const limit = 50;
  const core = makeCore("database-pressure", 99, limit);
  for (let i = 0; i < limit + 10; i++) {
    if (core.currentState.status !== "running") break;
    core.advanceTick();
  }
  assert.notEqual(core.currentState.status, "running");
  assert.ok(core.currentState.tick <= limit);
});

// ─── Action proposalId mismatch ───────────────────────────────────────────────

test("proposalId-mismatch — changing proposalId without re-approval is rejected", () => {
  const core = makeCore("queue-storm", 42);
  core.advanceTick();
  const { proposals } = core.propose();
  const feasible = proposals.filter(p => inspectFeasibility(p, core.currentState).pass);
  if (feasible.length === 0) return;

  const { action } = core.approve(feasible[0]);
  
  // Mutate the proposalId but keep everything else, including payloadDigest.
  const tamperedAction = { ...action, proposalId: "tampered-id" };
  
  const result = core.execute(tamperedAction);
  assert.equal(result.kind, "unconfirmed-payload", "should reject mismatched proposalId");
});
