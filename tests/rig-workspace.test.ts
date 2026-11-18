/**
 * rig-workspace.test.ts — Integration tests for RigWorkspace API.
 *
 * Requirements (docs/RIG-FINISH-011.md):
 * - All tests use try/finally for complete cleanup.
 * - Full actual start with 24 server-generated fictional jobs admitted via loopback HTTP.
 * - Stage scaling, inject pressure (reserving 94 handles), attempt apply -> stale rejection.
 * - Scale 103/100 rejected (infeasible-resource).
 * - Feasible resume-worker at 94 handles -> drains all 24 jobs to completion.
 * - Duplicate apply blocked (already-applied).
 * - Wrong owner rejected.
 * - Close/expiry evidence retained and accessible via evidence(ownerId).
 * - Start allowance enforcement (2 per owner, 10 total).
 * - Pure status() checks.
 * - Zero hosted calls, local disposable rig only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RigWorkspace } from "../src/rig/index.js";

describe("RigWorkspace Integration", () => {
  test("1. Full lifecycle: start 24 jobs, stage, inject pressure, stale reject, scale 103 reject, resume drains 24, close and evidence", async () => {
    const ws = new RigWorkspace({
      maxLifetimeMs: 60000,
      maxStartsPerOwner: 2,
      maxTotalStarts: 10,
    });
    const ownerId = "owner-workspace-lifecycle";

    try {
      // 1. Pure status check before start
      const preStatus = await ws.status(ownerId);
      assert.equal(preStatus.active, false);
      assert.equal(preStatus.status, "idle");
      assert.equal(preStatus.observation, null);

      // 2. Start rig with 24 jobs
      const startResult = await ws.start(ownerId);
      assert.equal(startResult.success, true);
      assert.equal(startResult.ownerId, ownerId);
      assert.equal(startResult.status, "running");

      const obs1 = startResult.observation;
      assert.equal(obs1.measuredCounters.admittedJobs, 24);
      assert.equal(obs1.measuredCounters.pendingJobs, 24);
      assert.equal(obs1.measuredCounters.inFlightJobs, 0);
      assert.equal(obs1.measuredCounters.completedJobs, 0);
      assert.equal(obs1.measuredCounters.activeWorkers, 0);
      assert.equal(obs1.measuredCounters.pausedWorkers, 1);
      // 45 parent handles (44 pool + 1 queue) + 3 worker handles = 48
      assert.equal(obs1.measuredCounters.managedSqliteHandles, 48);

      // Check proposals generated on start
      assert.ok(startResult.proposals.length >= 2);
      const scaleProp = startResult.proposals.find((p) => p.actionType === "scale-workers")!;
      assert.ok(scaleProp, "scale-workers proposal should exist");

      // 3. Stage scaling action (scale 1 to 4 workers: projects 48 + 9 = 57 handles)
      const stageResult = await ws.stage(ownerId, scaleProp.proposalId);
      assert.ok(stageResult.staged.stageId);
      assert.equal(stageResult.staged.actionType, "scale-workers");
      assert.ok(stageResult.humanReadableEffect.includes("Scale workers"));

      // 4. Inject database pressure (reserves extra pool handles to 90; parent total 91 + 3 worker = 94)
      const pressureResult = await ws.injectPressure(ownerId);
      assert.equal(pressureResult.success, true);
      assert.equal(pressureResult.observation.measuredCounters.managedSqliteHandles, 94);
      assert.equal(pressureResult.observation.measuredCounters.pressureInjected, true);

      // 5. Attempt apply of previously staged scaling action:
      // Must be rejected with stale-basis because revision/digest changed upon pressure injection!
      const staleApply = await ws.apply(ownerId, stageResult.staged.stageId);
      assert.equal(staleApply.result.kind, "stale-basis");

      // 6. Refresh proposals: under pressure (94 handles), scaling to 4 workers would require
      // 94 + 9 = 103 handles (exceeding budget of 100).
      const rePropose = await ws.propose(ownerId);
      const scaleProp2 = rePropose.proposals.find((p) => p.actionType === "scale-workers")!;
      assert.ok(scaleProp2);
      assert.equal(scaleProp2.projectedHandles, 103);
      assert.equal(scaleProp2.feasible, false);

      // Attempting to stage the infeasible proposal (103/100) must be rejected at stage()
      await assert.rejects(async () => {
        await ws.stage(ownerId, scaleProp2.proposalId);
      }, /failed feasibility check/);

      // Verify counters remain unchanged (94 handles, 1 paused worker, 24 pending)
      const obsAfterInfeasible = await ws.status(ownerId);
      assert.equal(obsAfterInfeasible.observation!.measuredCounters.managedSqliteHandles, 94);
      assert.equal(obsAfterInfeasible.observation!.measuredCounters.pausedWorkers, 1);
      assert.equal(obsAfterInfeasible.observation!.measuredCounters.pendingJobs, 24);

      // 7. Select resume-worker proposal:
      // Worker-1 is paused. Resuming worker-1 requires 0 additional handles (stays at 94/100).
      const resumeProp = rePropose.proposals.find((p) => p.actionType === "resume-worker")!;
      assert.ok(resumeProp);
      assert.equal(resumeProp.projectedHandles, 94);
      assert.equal(resumeProp.feasible, true);

      const stageResume = await ws.stage(ownerId, resumeProp.proposalId);
      assert.equal(stageResume.staged.actionType, "resume-worker");

      // Apply resume-worker: must succeed
      const applyResume = await ws.apply(ownerId, stageResume.staged.stageId);
      assert.equal(applyResume.result.kind, "applied");
      assert.ok(applyResume.result.receipt);
      assert.equal(applyResume.result.receipt.actionType, "resume-worker");

      // 8. Verify duplicate apply of the same stageId is blocked
      const dupApply = await ws.apply(ownerId, stageResume.staged.stageId);
      assert.equal(dupApply.result.kind, "duplicate-action");

      // 9. Allow worker-1 to drain the 24 pending jobs
      // Poll status until all 24 jobs are completed or timeout
      const pollStart = Date.now();
      let completedCount = 0;
      while (Date.now() - pollStart < 15000) {
        const current = await ws.status(ownerId);
        if (current.observation) {
          completedCount = current.observation.measuredCounters.completedJobs;
          if (completedCount >= 24) {
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(completedCount, 24, "All 24 fictional jobs should drain to completion");

      const finalRunningStatus = await ws.status(ownerId);
      assert.equal(finalRunningStatus.observation!.measuredCounters.pendingJobs, 0);
      assert.equal(finalRunningStatus.observation!.measuredCounters.inFlightJobs, 0);
      assert.equal(finalRunningStatus.observation!.measuredCounters.completedJobs, 24);
      assert.equal(finalRunningStatus.observation!.measuredCounters.admittedJobs, 24);

      const preCloseRev = finalRunningStatus.observation!.revision;
      const preCloseDigest = finalRunningStatus.observation!.basisDigest;

      // 10. Close rig and verify final-snapshot regression
      const closeResult = await ws.close(ownerId);
      assert.equal(closeResult.success, true);
      assert.equal(closeResult.finalObservation.status, "closed");
      assert.equal(closeResult.finalObservation.measuredCounters.admittedJobs, 24, "admittedJobs preserved as 24 after close");
      assert.equal(closeResult.finalObservation.measuredCounters.completedJobs, 24);
      assert.equal(closeResult.finalObservation.measuredCounters.activeWorkers, 0);
      assert.equal(closeResult.finalObservation.measuredCounters.managedSqliteHandles, 0, "managedSqliteHandles is actual 0");

      // Regression assertions:
      assert.ok(closeResult.finalObservation.revision > preCloseRev, "Revision advances upon closing to reflect 0 handles");
      assert.notEqual(closeResult.finalObservation.basisDigest, preCloseDigest, "Digest changes from pre-close to reflect 0 handles");

      // 11. Fetch evidence after close: must return archived evidence bundle
      const evidence = await ws.evidence(ownerId);
      assert.equal(evidence.ownerId, ownerId);
      assert.equal(evidence.status, "closed");
      assert.equal(evidence.revision, closeResult.finalObservation.revision);
      assert.equal(evidence.basisDigest, closeResult.finalObservation.basisDigest);
      assert.equal(evidence.measuredCounters.admittedJobs, 24);
      assert.equal(evidence.measuredCounters.managedSqliteHandles, 0);
      assert.equal(evidence.queueSummary.completed, 24);
      assert.equal(evidence.receipts.length >= 1, true);
      assert.equal(evidence.labels.telemetryType, "measured process telemetry");
    } finally {
      await ws.shutdown();
    }
  });

  test("2. Security & Boundaries: Wrong owner rejection", async () => {
    const ws = new RigWorkspace({ maxLifetimeMs: 30000 });
    const realOwner = "real-owner";
    const imposter = "imposter-attacker";

    try {
      await ws.start(realOwner);

      // Imposter cannot inspect status of real owner's rig
      await assert.rejects(async () => {
        await ws.status(imposter);
      }, /Access denied/);

      // Imposter cannot propose
      await assert.rejects(async () => {
        await ws.propose(imposter);
      }, /Access denied/);

      // Imposter cannot inject pressure
      await assert.rejects(async () => {
        await ws.injectPressure(imposter);
      }, /Access denied/);

      // Imposter cannot close
      await assert.rejects(async () => {
        await ws.close(imposter);
      }, /Access denied/);

      // Imposter cannot access evidence
      await assert.rejects(async () => {
        await ws.evidence(imposter);
      }, /Access denied/);

      await ws.close(realOwner);
    } finally {
      await ws.shutdown();
    }
  });

  test("3. Allowance constraints: Max starts per owner and global singleton", async () => {
    const ws = new RigWorkspace({
      maxLifetimeMs: 30000,
      maxStartsPerOwner: 2,
      maxTotalStarts: 4,
    });
    const ownerA = "owner-quota-test";
    const ownerB = "owner-b-test";

    try {
      // Run 1: ownerA starts
      await ws.start(ownerA);

      // Attempting to start another rig while ownerA's rig is active violates global singleton (below total cap)
      await assert.rejects(async () => {
        await ws.start(ownerB);
      }, /already active/);

      // Close Run 1
      await ws.close(ownerA);

      // Run 2: ownerA starts and closes
      await ws.start(ownerA);
      await ws.close(ownerA);

      // Run 3: ownerA has reached their limit of 2 starts
      await assert.rejects(async () => {
        await ws.start(ownerA);
      }, /Owner start allowance exhausted/);

      // Another owner (ownerB) can start up to their own limit (total starts is now 2 / 4)
      await ws.start(ownerB);
      await ws.close(ownerB);

      // ownerB run 2 (total starts is now 3 / 4)
      await ws.start(ownerB);
      await ws.close(ownerB);

      // Now total starts has reached 4 (2 for A + 2 for B)
      await assert.rejects(async () => {
        await ws.start("owner-c-test");
      }, /Workspace start allowance exhausted/);
    } finally {
      await ws.shutdown();
    }
  });

  test("4. Expiry evidence preservation and pure status", async () => {
    const ws = new RigWorkspace({
      maxLifetimeMs: 300, // Short injected deadline
    });
    const owner = "owner-short-ttl";

    try {
      await ws.start(owner);

      // Wait for rig to expire
      await new Promise((r) => setTimeout(r, 600));

      // Pure status should report expired
      const status = await ws.status(owner);
      assert.ok(status.status === "expired" || status.status === "idle");

      // Evidence remains accessible
      const evidence = await ws.evidence(owner);
      assert.equal(evidence.ownerId, owner);
      assert.ok(evidence.status === "expired" || evidence.status === "closed");
    } finally {
      await ws.shutdown();
    }
  });

  test("5. Final-snapshot regression: admitted 24, zero handles, revision/digest changed from pre-close, history consistent", async () => {
    const ws = new RigWorkspace({ maxLifetimeMs: 30000 });
    const owner = "owner-snapshot-regression";

    try {
      const startRes = await ws.start(owner);
      assert.equal(startRes.observation.measuredCounters.admittedJobs, 24);
      assert.equal(startRes.observation.measuredCounters.managedSqliteHandles, 48);

      const preCloseRev = startRes.observation.revision;
      const preCloseDigest = startRes.observation.basisDigest;

      const closeRes = await ws.close(owner);
      assert.equal(closeRes.finalObservation.status, "closed");
      assert.equal(closeRes.finalObservation.measuredCounters.admittedJobs, 24, "admittedJobs preserved as 24");
      assert.equal(closeRes.finalObservation.measuredCounters.managedSqliteHandles, 0, "managedSqliteHandles is actual 0");
      assert.equal(closeRes.finalObservation.measuredCounters.activeWorkers, 0);

      // Revision and basis digest must advance to reflect transition to 0 handles
      assert.ok(closeRes.finalObservation.revision > preCloseRev);
      assert.notEqual(closeRes.finalObservation.basisDigest, preCloseDigest);

      // Evidence snapshot matches observation snapshot
      assert.equal(closeRes.finalEvidence.revision, closeRes.finalObservation.revision);
      assert.equal(closeRes.finalEvidence.basisDigest, closeRes.finalObservation.basisDigest);
      assert.equal(closeRes.finalEvidence.measuredCounters.admittedJobs, 24);
      assert.equal(closeRes.finalEvidence.measuredCounters.managedSqliteHandles, 0);
    } finally {
      await ws.shutdown();
    }
  });
});
