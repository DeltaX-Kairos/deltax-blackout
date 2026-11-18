/**
 * CLI Runner — drives a complete scenario end-to-end and prints labelled output.
 *
 * Usage:
 *   node -r ts-node/register src/cli.ts --scenario queue-storm --seed 42
 *   node -r ts-node/register src/cli.ts --scenario database-pressure --seed 99
 *
 * All printed state metrics are labelled [simulated].
 * All proposal sources are labelled [scripted].
 * Evaluate status is labelled [Evaluate] local lab, no hosted evaluation performed.
 *
 * Exit 0 on success; exit 1 on error.
 */

import { RecoveryCore, type ScenarioName, ApprovalError } from "./recovery-core.js";
import { TickClock } from "./clock.js";
import { Mulberry32 } from "./rng.js";
import type { Proposal, Action } from "./types.js";

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(): { scenarioName: ScenarioName; seed: number } {
  const args = process.argv.slice(2);
  let scenarioName: ScenarioName | undefined;
  let seed: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      const v = args[i + 1];
      if (v === "queue-storm" || v === "database-pressure") {
        scenarioName = v;
      } else {
        fatal("Unknown scenario: " + v + ". Valid options: queue-storm, database-pressure");
      }
      i++;
    } else if (args[i] === "--seed" && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (isNaN(n)) fatal("Seed must be an integer, got: " + args[i + 1]);
      seed = n;
      i++;
    }
  }

  if (!scenarioName) fatal("Missing --scenario. Usage: cli.ts --scenario <name> --seed <n>");
  if (seed === undefined) fatal("Missing --seed. Usage: cli.ts --scenario <name> --seed <n>");

  return { scenarioName: scenarioName!, seed: seed! };
}

function fatal(msg: string): never {
  process.stderr.write("ERROR: " + msg + "\n");
  process.exit(1);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function hr(char = "─", width = 72): string {
  return char.repeat(width);
}

function printSection(title: string): void {
  console.log("\n" + hr() + "\n  " + title + "\n" + hr());
}

function printState(state: ReturnType<RecoveryCore["observe"]>["state"]): void {
  const os = state.operationalState;
  console.log("  Scenario:   " + state.scenarioId + " [simulated]");
  console.log("  Tick:       " + state.tick + " (" + (state.tick * 10) + "s simulated)");
  console.log("  Revision:   " + state.revision);
  console.log("  Status:     " + state.status);
  console.log("  Digest:     " + state.basisDigest.slice(0, 16) + "…");
  if (os.kind === "queue-storm") {
    console.log("  [simulated] queue depth:      " + os.queueDepth + " messages");
    console.log("  [simulated] worker count:     " + os.workerCount);
    console.log("  [simulated] arrival rate:     " + os.arrivalRatePerTick + " req/tick");
    console.log("  [simulated] ingestion cap:    " + (os.ingestionRateCap ?? "none"));
    console.log("  [simulated] error rate:       " + (os.errorRate * 100).toFixed(1) + "%");
    console.log("  [simulated] db connections:   " + os.dbConnectionCount);
  } else {
    console.log("  [simulated] app servers:      " + os.appServerCount);
    console.log("  [simulated] replica avail:    " + (os.replicaAvailability * 100).toFixed(0) + "%");
    console.log("  [simulated] connections:      " + os.connectionCount + " / 200");
    console.log("  [simulated] query latency:    " + os.queryLatencyMs + "ms");
    console.log("  [simulated] error rate:       " + (os.errorRate * 100).toFixed(1) + "%");
    console.log("  [simulated] failover:         " + os.failoverTriggered);
  }
}

function printProposal(p: Proposal, feasPass: boolean | null = null): void {
  console.log("  Proposal:   " + p.proposalId);
  console.log("  Source:     " + p.source + " [scripted]");
  console.log("  Desc:       " + p.description);
  console.log("  Basis rev:  " + p.basisRevision + "  digest: " + p.basisDigest.slice(0, 16) + "…");
  console.log("  Support:    " + (p.operatorReportedSupport * 100).toFixed(1) + "%");
  console.log("  Assumptions:");
  for (const a of p.assumptions) {
    console.log("    • " + a);
  }
  console.log("  [predicted]:");
  for (const [k, v] of Object.entries(p.predictedEffects)) {
    console.log("    " + k + ": " + v);
  }
  if (feasPass !== null) {
    console.log("  Feasibility: " + (feasPass ? "✓ PASS" : "✗ FAIL"));
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { scenarioName, seed } = parseArgs();

  const clock = new TickClock(0);
  const rng = new Mulberry32(seed);

  const core = new RecoveryCore({
    clock,
    rng,
    scenarioName,
    seed,
  });

  // ── Banner ────────────────────────────────────────────────────────────────
  console.log("\n" + hr("═") + "\n  BLACKOUT M1 — Incident Recovery Lab\n" + hr("═"));
  console.log("  Scenario: " + scenarioName + "   Seed: " + seed);
  console.log("  All workload and telemetry are simulated. No real infrastructure affected.");
  console.log("  [Evaluate] local lab, no hosted evaluation performed");

  // ── Initial observation ───────────────────────────────────────────────────
  printSection("INITIAL OBSERVATION (tick 0)");
  printState(core.observe().state);

  // ── Advance a few ticks ───────────────────────────────────────────────────
  printSection("ADVANCING TICKS 1–3");
  for (let t = 1; t <= 3; t++) {
    const st = core.advanceTick();
    console.log("\n  Tick " + t + " → revision " + st.revision + "  digest: " + st.basisDigest.slice(0, 16) + "…");
    if (st.operationalState.kind === "queue-storm") {
      const os = st.operationalState;
      console.log("  [simulated] queue=" + os.queueDepth + " workers=" + os.workerCount + " errorRate=" + (os.errorRate * 100).toFixed(1) + "%");
    } else {
      const os = st.operationalState;
      console.log("  [simulated] conns=" + os.connectionCount + " latency=" + os.queryLatencyMs + "ms errorRate=" + (os.errorRate * 100).toFixed(1) + "%");
    }
    if (st.status !== "running") {
      console.log("  [TERMINATED] reason: " + st.terminationReason);
      break;
    }
  }

  // ── Generate proposals ────────────────────────────────────────────────────
  printSection("PROPOSALS (scripted)");
  const { proposals } = core.propose();
  for (const p of proposals) {
    console.log("");
    printProposal(p);
  }

  // ── Feasibility inspection ────────────────────────────────────────────────
  printSection("FEASIBILITY INSPECTION");
  const inspected: Array<{ proposal: Proposal; pass: boolean }> = [];
  for (const p of proposals) {
    const { feasibility } = core.inspect(p);
    console.log("\n  " + p.proposalId + ": " + (feasibility.pass ? "✓ PASS" : "✗ FAIL"));
    if (!feasibility.pass) {
      console.log("    Violated rules: " + feasibility.violatedRules.join(", "));
    }
    inspected.push({ proposal: p, pass: feasibility.pass });
  }

  const feasibleProposals = inspected.filter((x) => x.pass).map((x) => x.proposal);
  if (feasibleProposals.length === 0) {
    // All proposals failed — advance more ticks and re-propose.
    console.log("\n  All proposals failed feasibility. Advancing 2 more ticks…");
    core.advanceTick();
    core.advanceTick();
    const { proposals: fresh } = core.propose();
    for (const p of fresh) {
      const { feasibility } = core.inspect(p);
      if (feasibility.pass) feasibleProposals.push(p);
    }
  }

  if (feasibleProposals.length === 0) {
    fatal("No feasible proposals found after re-proposal. Scenario may require more ticks.");
  }

  // Choose the first feasible proposal.
  const chosenProposal = feasibleProposals[0];

  // ── Stale-basis rejection demo ────────────────────────────────────────────
  printSection("STALE-BASIS REJECTION DEMO");

  const stateBeforeIntervent = core.observe().state;
  console.log("\n  Step 1: Approve action on revision " + stateBeforeIntervent.revision +
    "  digest: " + stateBeforeIntervent.basisDigest.slice(0, 16) + "…");

  const { action: staleAction } = core.approve(chosenProposal);
  console.log("  Action ID: " + staleAction.actionId);
  console.log("  Basis digest bound: " + staleAction.basisDigest.slice(0, 16) + "…");

  console.log("\n  Step 2: Inject intervening event (advance 1 tick) → state changes");
  const afterIntervent = core.advanceTick();
  console.log("  New revision: " + afterIntervent.revision + "  digest: " + afterIntervent.basisDigest.slice(0, 16) + "…");
  console.log("  Digest changed: " + (staleAction.basisDigest !== afterIntervent.basisDigest));

  console.log("\n  Step 3: Attempt to execute stale action…");
  const staleResult = core.execute(staleAction);
  if (staleResult.kind === "stale-basis") {
    console.log("  ✓ Rejected (stale basis)");
    console.log("    Action digest:  " + staleResult.actionDigest.slice(0, 16) + "…");
    console.log("    Current digest: " + staleResult.currentDigest.slice(0, 16) + "…");
    console.log("    Current rev:    " + staleResult.currentRevision);
  } else {
    console.log("  Unexpected result: " + staleResult.kind);
  }

  console.log("\n  Step 4: Re-observe current state and generate fresh proposals");
  const freshState = core.observe().state;
  console.log("  Revision: " + freshState.revision + "  digest: " + freshState.basisDigest.slice(0, 16) + "…");

  const { proposals: freshProposals } = core.propose();
  const freshFeasible: Proposal[] = [];
  for (const fp of freshProposals) {
    const { feasibility } = core.inspect(fp);
    if (feasibility.pass) freshFeasible.push(fp);
  }

  if (freshFeasible.length === 0) {
    // Edge case: advance more and try again
    core.advanceTick();
    const { proposals: freshProposals2 } = core.propose();
    for (const fp of freshProposals2) {
      const { feasibility } = core.inspect(fp);
      if (feasibility.pass) freshFeasible.push(fp);
    }
  }

  if (freshFeasible.length === 0) {
    fatal("No feasible fresh proposals found after stale-basis cycle.");
  }

  const freshChosen = freshFeasible[0];
  console.log("\n  Step 5: Approve fresh action on current basis (revision " + core.currentState.revision + ")");
  const { action: freshAction } = core.approve(freshChosen);
  console.log("  Action ID: " + freshAction.actionId);

  // ── Apply action ──────────────────────────────────────────────────────────
  printSection("APPLY ACTION");
  const execResult = core.execute(freshAction);

  if (execResult.kind === "applied") {
    const receipt = execResult.receipt;
    console.log("  ✓ Action applied");
    console.log("  Action ID:    " + receipt.actionId);
    console.log("  Lab note:     " + receipt.labNote);
    console.log("  Rev before:   " + receipt.revisionBefore + "  digest: " + receipt.digestBefore.slice(0, 16) + "…");
    console.log("  Rev after:    " + receipt.revisionAfter + "  digest: " + receipt.digestAfter.slice(0, 16) + "…");
    console.log("\n  [predicted]:");
    for (const [k, v] of Object.entries(receipt.predictedEffects)) {
      console.log("    " + k + ": " + v);
    }
    console.log("\n  [observed]:");
    for (const [k, v] of Object.entries(receipt.observedEffects)) {
      console.log("    " + k + ": " + v);
    }
    console.log("\n  Post-action state:");
    printState(execResult.newState);
  } else {
    console.log("  Execution failed: " + execResult.kind);
  }

  // ── Duplicate action rejection demo ───────────────────────────────────────
  printSection("DUPLICATE ACTION REJECTION DEMO");
  console.log("  Attempting to re-execute the same action ID: " + freshAction.actionId);
  // Re-approve to satisfy confirmation check, then mutate digest to test payload guard
  // But first demonstrate duplicate via the same consumed action:
  const dupResult = core.execute(freshAction);
  if (dupResult.kind === "stale-basis") {
    // After apply, state advanced so basis is stale — that's the first guard hit.
    console.log("  ✓ Rejected (stale basis — state changed after apply; also consumed)");
  } else if (dupResult.kind === "duplicate-action") {
    console.log("  ✓ Rejected (duplicate action — already consumed)");
  } else {
    console.log("  Result: " + dupResult.kind);
  }

  // ── Evaluate boundary ─────────────────────────────────────────────────────
  printSection("EVALUATE BOUNDARY (unconfigured in M1)");
  const evalResult = await core.evaluate({
    profile_id: "deltax-hosted-bounded-review-evaluation-v1",
    objective: "Select the best recovery candidate for " + scenarioName,
    context: { scenario: scenarioName, revision: core.currentRevision },
    candidates: freshProposals.slice(0, 2).map((p) => ({
      candidate_id: p.proposalId,
      semantic_class: p.semanticClass,
      description: p.description,
      operator_reported_support: p.operatorReportedSupport,
    })),
  });
  console.log("  Evaluate status: " + evalResult.status);
  console.log("  [Evaluate] local lab, no hosted evaluation performed");

  // ── Run remaining ticks to termination ────────────────────────────────────
  printSection("RUNNING TO TERMINATION");
  let iterations = 0;
  while (core.currentState.status === "running" && iterations < 200) {
    core.advanceTick();
    iterations++;
  }
  const finalState = core.currentState;
  console.log("  Terminated at tick " + finalState.tick + " (revision " + finalState.revision + ")");
  console.log("  Termination reason: " + (finalState.terminationReason ?? "natural"));
  console.log("  Final state:");
  printState(finalState);

  // ── Event log ─────────────────────────────────────────────────────────────
  printSection("EVENT LOG (causal history)");
  const events = core.eventLog.events;
  console.log("  Total events: " + events.length);
  console.log("");
  for (const ev of events) {
    const digest = ev.basisDigest.slice(0, 12) + "…";
    const base = "  [t" + ev.tick + " r" + ev.revision + " " + digest + "] " + ev.kind;
    if (ev.kind === "ProposalCreated") {
      console.log(base + " → " + ev.proposalId + " (" + ev.source + ")");
    } else if (ev.kind === "ActionApproved") {
      console.log(base + " → " + ev.actionId);
    } else if (ev.kind === "ActionApplied") {
      console.log(base + " → " + ev.actionId + " (now r" + ev.revisionAfter + ")");
    } else if (ev.kind === "StaleBasiRejected") {
      console.log(base + " → " + ev.actionId + " (action digest: " + ev.actionDigest.slice(0, 12) + "…)");
    } else if (ev.kind === "DuplicateActionRejected") {
      console.log(base + " → " + ev.actionId);
    } else if (ev.kind === "FeasibilityRejected") {
      console.log(base + " → " + ev.proposalId + " rules: " + ev.violatedRules.join(","));
    } else if (ev.kind === "ScenarioTerminated") {
      console.log(base + " reason=" + ev.reason);
    } else {
      console.log(base);
    }
  }

  // ── JSON event log dump ───────────────────────────────────────────────────
  printSection("FULL EVENT LOG (JSON)");
  console.log(core.eventLog.toJSON());

  // ── Summary ───────────────────────────────────────────────────────────────
  printSection("SUMMARY");
  console.log("  Scenario:     " + scenarioName + " [simulated]");
  console.log("  Seed:         " + seed);
  console.log("  Final tick:   " + finalState.tick);
  console.log("  Termination:  " + (finalState.terminationReason ?? "natural"));
  console.log("  Revisions:    " + finalState.revision);
  console.log("  Events:       " + events.length);
  console.log("  Evaluate:     unconfigured — local lab, no hosted evaluation performed");
  console.log("\n" + hr("═"));

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write("FATAL: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
});
