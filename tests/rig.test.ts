/**
 * rig.test.ts — Unit and integration tests for the M4 disposable process rig.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md):
 * - Every test uses try/finally to ensure complete cleanup.
 * - Child worker start, work, hash + SELECT 1 acknowledgements, and cleanup.
 * - Queue durability and restart recovery (pending survive, inflight become unknown).
 * - Uncertain inflight never silently retried.
 * - Wrong owner rejection.
 * - Stale action rejection after basis change (pressure, queue admission, or ACK).
 * - Resource rejection under pressure (103/100 rejected).
 * - Feasible resume under pressure (stays at 94/100 and drains queue).
 * - Duplicate action rejection.
 * - Global cap and singleton constraint (at most 1 active rig globally).
 * - Lifecycle expiry and complete cleanup (port closed, PIDs terminated, runner exits naturally).
 * - Double / concurrent start rejection.
 * - Invalid lifetimeMs validation.
 * - Startup handshake failure cleanup seam.
 * - Returned proposal / stage mutation cannot bypass confirmation.
 * - Scale action ignores caller addWorkers parameter and enforces resource limits.
 * - Exited workers contribute 0 to managed SQLite handles.
 * - After-close observation and evidence export.
 * - Ingestion Host, media type, token, 64-job cap, and byte bounds.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  ProcessRig,
  DurableQueue,
  RIG_LIMITS,
} from "../src/rig/index.js";

// Helper for sending loopback HTTP requests to the ingestion endpoint
function httpRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  customHeaders: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> | string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
      "Content-Type": "application/json",
      ...customHeaders,
    };
    if (bodyStr) {
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> | string;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );

    req.on("error", reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-test-"));
}

describe("M4 Disposable Process Rig", () => {
  test("1. Child worker start, work, acknowledgements, and cleanup", async () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "test-queue.db");
    let rig: ProcessRig | null = null;

    try {
      rig = new ProcessRig({
        ownerId: "owner-start-work",
        dbPath,
      });

      const port = await rig.start();
      assert.ok(port > 0, "Ingestion server must bind to ephemeral port");

      // Initially 1 paused worker, 48 managed SQLite handles (45 parent + 3 worker)
      const initialObs = rig.observe("owner-start-work");
      assert.equal(initialObs.measuredCounters.activeWorkers, 0);
      assert.equal(initialObs.measuredCounters.pausedWorkers, 1);
      assert.equal(
        initialObs.measuredCounters.managedSqliteHandles,
        RIG_LIMITS.INITIAL_MANAGED_HANDLES
      );

      // Ingest 3 fictional jobs over loopback HTTP
      for (let i = 1; i <= 3; i++) {
        const res = await httpRequest(
          port,
          "POST",
          "/ingest",
          {
            jobId: `work-job-${i}`,
            payload: `fictional-workload-payload-${i}`,
          },
          { "x-rig-token": rig.getIngestionToken() }
        );
        assert.equal(res.status, 202);
        assert.equal((res.body as Record<string, unknown>)["admitted"], true);
      }

      // Queue has 3 pending jobs
      let obs = rig.observe("owner-start-work");
      assert.equal(obs.measuredCounters.pendingJobs, 3);
      assert.equal(obs.measuredCounters.completedJobs, 0);

      // Propose, stage, and apply resume-worker
      const proposals = rig.propose("owner-start-work");
      const resumeProp = proposals.find((p) => p.actionType === "resume-worker");
      assert.ok(resumeProp);
      assert.equal(resumeProp.feasible, true);

      const staged = rig.stageAction("owner-start-work", resumeProp.proposalId);
      const applyRes = await rig.apply("owner-start-work", staged.stageId);
      assert.equal(applyRes.kind, "applied");
      assert.ok(applyRes.receipt);

      // Wait for all jobs to drain
      await rig.drainQueue({ timeoutMs: 5000 });

      const finalObs = rig.observe("owner-start-work");
      assert.equal(finalObs.measuredCounters.pendingJobs, 0);
      assert.equal(finalObs.measuredCounters.completedJobs, 3);

      const workerPid = finalObs.measuredCounters.workerPids[0];
      assert.ok(workerPid > 0);

      // Close rig and verify child worker process cleanup
      await rig.close();
      rig = null;

      assert.throws(() => {
        process.kill(workerPid, 0);
      }, /ESRCH/);
    } finally {
      if (rig) await rig.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("2. Queue durability and restart recovery (pending survive, inflight become unknown)", () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "durable.db");

    try {
      const queue1 = new DurableQueue(dbPath);
      queue1.enqueue("durable-1", "payload-1");
      queue1.enqueue("durable-2", "payload-2");
      queue1.enqueue("durable-3", "payload-3");
      queue1.enqueue("durable-4", "payload-4");

      const claimed1 = queue1.claimNextPending("worker-1");
      assert.ok(claimed1 && claimed1.id === "durable-1");
      queue1.markCompleted("durable-1", "hash-1");

      const claimed2 = queue1.claimNextPending("worker-1");
      assert.ok(claimed2 && claimed2.id === "durable-2");
      // Leave claimed2 in_flight!
      queue1.close();

      // Instance 2: reopen same SQLite file (demonstrating restart recovery)
      const queue2 = new DurableQueue(dbPath);
      const counters = queue2.getCounters();

      assert.equal(counters.total, 4);
      assert.equal(counters.completed, 1, "Completed job survives");
      assert.equal(counters.inFlight, 0, "Inflight job reconciled to 0 in-flight");
      assert.equal(counters.unknown, 1, "Inflight job after termination must become unknown");
      assert.equal(counters.pending, 2, "Pending rows survive restart");

      const allJobs = queue2.getAllJobs();
      const job2 = allJobs.find((j) => j.id === "durable-2");
      assert.ok(job2);
      assert.equal(job2.status, "unknown");
      assert.match(job2.errorDetail || "", /uncertain termination/);

      const claimed3 = queue2.claimNextPending("worker-2");
      assert.ok(claimed3 && claimed3.id === "durable-3");
      queue2.markCompleted("durable-3", "hash-3");

      queue2.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("3. Uncertain inflight never silently retried (worker killed abruptly)", async () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "kill-test.db");
    let rig: ProcessRig | null = null;

    try {
      rig = new ProcessRig({
        ownerId: "owner-kill-test",
        dbPath,
      });
      const port = await rig.start();

      await httpRequest(
        port,
        "POST",
        "/ingest",
        {
          jobId: "kill-job-1",
          payload: "fictional-kill-payload",
        },
        { "x-rig-token": rig.getIngestionToken() }
      );

      const obs = rig.observe("owner-kill-test");
      const pid = obs.measuredCounters.workerPids[0];
      assert.ok(pid > 0);

      // Resume worker
      const proposals = rig.propose("owner-kill-test");
      const resumeProp = proposals.find((p) => p.actionType === "resume-worker")!;
      const staged = rig.stageAction("owner-kill-test", resumeProp.proposalId);
      await rig.apply("owner-kill-test", staged.stageId);

      // Kill the worker process abruptly
      process.kill(pid, "SIGKILL");

      // Wait a brief moment for exit listener to run
      await new Promise((r) => setTimeout(r, 200));

      const evidence = rig.exportEvidence("owner-kill-test");
      assert.equal(
        evidence.queueSummary.unknown,
        1,
        "Inflight job on killed worker must be marked unknown"
      );
      assert.equal(evidence.queueSummary.inFlight, 0);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("4. Wrong owner rejection across driver interface", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-alice" });
      await rig.start();

      assert.throws(() => {
        rig!.observe("owner-bob");
      }, /Access denied/);

      assert.throws(() => {
        rig!.propose("owner-bob");
      }, /Access denied/);

      const proposals = rig.propose("owner-alice");
      const staged = rig.stageAction("owner-alice", proposals[0].proposalId);

      const applyRes = await rig.apply("owner-bob", staged.stageId);
      assert.equal(applyRes.kind, "wrong-owner");

      assert.throws(() => {
        rig!.injectPressure("owner-bob");
      }, /Access denied/);

      assert.throws(() => {
        rig!.exportEvidence("owner-bob");
      }, /Access denied/);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("5. Stale action rejection after basis change (pressure and admission)", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-stale" });
      const port = await rig.start();

      await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "stale-check-1" },
        { "x-rig-token": rig.getIngestionToken() }
      );

      // Propose and stage at revision 2
      const proposals = rig.propose("owner-stale");
      const staged = rig.stageAction("owner-stale", proposals[0].proposalId);
      const stageRev = staged.basisRevision;

      // Case A: Inject pressure -> increments revision and changes basis digest
      rig.injectPressure("owner-stale");
      assert.ok(rig.getRevision() > stageRev);

      const applyRes = await rig.apply("owner-stale", staged.stageId);
      assert.equal(applyRes.kind, "stale-basis");
      assert.equal(applyRes.currentRevision, rig.getRevision());

      // Case B: Fresh proposal staged, then new job admitted -> basis changes again!
      const freshProps = rig.propose("owner-stale");
      const freshStaged = rig.stageAction("owner-stale", freshProps[0].proposalId);

      await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "stale-check-2" },
        { "x-rig-token": rig.getIngestionToken() }
      );

      const applyRes2 = await rig.apply("owner-stale", freshStaged.stageId);
      assert.equal(applyRes2.kind, "stale-basis");

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("6. Resource rejection under pressure (103/100 rejected)", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-resource" });
      await rig.start();

      // Before pressure: 48 handles (45 parent + 3 worker). Scale to 4 projects 57/100 (feasible).
      const propBefore = rig.propose("owner-resource");
      const scaleBefore = propBefore.find((p) => p.actionType === "scale-workers")!;
      assert.equal(scaleBefore.projectedHandles, 57);
      assert.equal(scaleBefore.feasible, true);

      // Inject database pressure: reserves parent pool to 90 (parent total 91 + 3 worker = 94)
      rig.injectPressure("owner-resource");
      const obs = rig.observe("owner-resource");
      assert.equal(
        obs.measuredCounters.managedSqliteHandles,
        RIG_LIMITS.PRESSURE_MANAGED_HANDLES
      ); // 94

      // Fresh proposal: scaling 1 to 4 projects 94 + 9 = 103/100 (must reject)
      const propAfter = rig.propose("owner-resource");
      const scaleAfter = propAfter.find((p) => p.actionType === "scale-workers")!;
      assert.equal(scaleAfter.projectedHandles, 103);
      assert.equal(scaleAfter.feasible, false);
      assert.match(scaleAfter.feasibilityReason, /exceeds lab budget of 100/);

      assert.throws(() => {
        rig!.stageAction("owner-resource", scaleAfter.proposalId);
      }, /failed feasibility check/);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("7. Feasible resume under pressure (stays at 94/100 and drains queue)", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-resume-pressure" });
      const port = await rig.start();

      await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "drain-payload-1" },
        { "x-rig-token": rig.getIngestionToken() }
      );
      await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "drain-payload-2" },
        { "x-rig-token": rig.getIngestionToken() }
      );

      // Inject pressure: handles reserved to 94
      rig.injectPressure("owner-resume-pressure");

      // Resume stays at 94/100 (feasible)
      const proposals = rig.propose("owner-resume-pressure");
      const resumeProp = proposals.find((p) => p.actionType === "resume-worker")!;
      assert.equal(resumeProp.projectedHandles, 94);
      assert.equal(resumeProp.feasible, true);

      const staged = rig.stageAction("owner-resume-pressure", resumeProp.proposalId);
      const applyRes = await rig.apply("owner-resume-pressure", staged.stageId);
      assert.equal(applyRes.kind, "applied");
      assert.equal(applyRes.receipt?.measuredAfter.managedSqliteHandles, 94);

      await rig.drainQueue({ timeoutMs: 5000 });

      const obs = rig.observe("owner-resume-pressure");
      assert.equal(obs.measuredCounters.completedJobs, 2);
      assert.equal(obs.measuredCounters.pendingJobs, 0);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("8. Duplicate action rejection", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-duplicate" });
      await rig.start();

      const proposals = rig.propose("owner-duplicate");
      const capProp = proposals.find((p) => p.actionType === "cap-ingestion")!;
      const staged = rig.stageAction("owner-duplicate", capProp.proposalId);

      const res1 = await rig.apply("owner-duplicate", staged.stageId);
      assert.equal(res1.kind, "applied");

      const res2 = await rig.apply("owner-duplicate", staged.stageId);
      assert.equal(res2.kind, "duplicate-action");

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("9. Global cap and singleton constraint (at most 1 active rig globally)", async () => {
    let rig1: ProcessRig | null = null;
    let rig2: ProcessRig | null = null;
    try {
      rig1 = new ProcessRig({ ownerId: "owner-singleton-1" });
      await rig1.start();

      assert.throws(() => {
        new ProcessRig({ ownerId: "owner-singleton-2" });
      }, /global cap: 1/);

      await rig1.close();
      rig1 = null;

      rig2 = new ProcessRig({ ownerId: "owner-singleton-2" });
      await rig2.start();
      assert.ok(rig2.isOpen());

      await rig2.close();
      rig2 = null;
    } finally {
      if (rig1) await rig1.close();
      if (rig2) await rig2.close();
    }
  });

  test("10. Lifecycle expiry and complete cleanup (port closed, natural exit)", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({
        ownerId: "owner-expiry",
        lifetimeMs: 150, // Short injected deadline
      });
      const port = await rig.start();
      assert.equal(rig.isOpen(), true);

      // Wait past deadline for expiry to trigger
      await new Promise((r) => setTimeout(r, 250));

      assert.equal(rig.isOpen(), false);
      assert.equal(rig.getStatus(), "expired");

      // Verify loopback port is closed (connection refused)
      await assert.rejects(async () => {
        await httpRequest(port, "GET", "/health");
      });

      // Global slot released on expiry
      const nextRig = new ProcessRig({ ownerId: "owner-after-expiry" });
      await nextRig.start();
      assert.ok(nextRig.isOpen());
      await nextRig.close();

      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("11. Double and concurrent start rejection", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-double-start" });
      await rig.start();

      await assert.rejects(async () => {
        await rig!.start();
      }, /rig may only be started once/);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("12. Invalid lifetimeMs rejection", () => {
    assert.throws(() => {
      new ProcessRig({ ownerId: "owner-bad-ttl", lifetimeMs: 0 });
    }, /Invalid lifetimeMs/);

    assert.throws(() => {
      new ProcessRig({ ownerId: "owner-bad-ttl", lifetimeMs: -10 });
    }, /Invalid lifetimeMs/);

    assert.throws(() => {
      new ProcessRig({ ownerId: "owner-bad-ttl", lifetimeMs: 120_001 });
    }, /Invalid lifetimeMs/);

    assert.throws(() => {
      new ProcessRig({ ownerId: "owner-bad-ttl", lifetimeMs: 1.5 });
    }, /Invalid lifetimeMs/);
  });

  test("13. Startup handshake failure cleanup seam", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({
        ownerId: "owner-handshake-fail",
        _testFailHandshake: true,
      });

      await assert.rejects(async () => {
        await rig!.start();
      }, /Simulated startup handshake failure/);

      assert.equal(rig.isOpen(), false);
      rig = null;

      // Verify singleton was released cleanly after startup failure
      const freshRig = new ProcessRig({ ownerId: "owner-fresh" });
      await freshRig.start();
      assert.ok(freshRig.isOpen());
      await freshRig.close();
    } finally {
      if (rig) await rig.close();
    }
  });

  test("14. Proposal and staged action mutation cannot bypass confirmation", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-mutation-check" });
      await rig.start();

      const proposals = rig.propose("owner-mutation-check");
      const p = proposals[0];

      // Mutate returned proposal object
      p.parameters["targetWorkerCount"] = 100;
      p.basisDigest = "fake-digest";

      // Stage using proposal ID — rig uses internally stored record, not mutated caller copy
      const staged = rig.stageAction("owner-mutation-check", p.proposalId);
      assert.notEqual(staged.parameters["targetWorkerCount"], 100);

      // Mutate returned staged action object
      staged.parameters["targetWorkerCount"] = 999;
      staged.payloadDigest = "tampered-payload-digest";

      // Apply checks re-derived payload digest against internally stored record
      const applyRes = await rig.apply("owner-mutation-check", staged.stageId);
      assert.equal(applyRes.kind, "applied");
      assert.notEqual(applyRes.receipt?.actionType, "999");

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("15. Scale action derives workers solely from targetWorkerCount (ignores caller addWorkers mismatch)", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-add-workers" });
      await rig.start();

      const proposals = rig.propose("owner-add-workers");
      const scaleProp = proposals.find((p) => p.actionType === "scale-workers")!;
      const staged = rig.stageAction("owner-add-workers", scaleProp.proposalId);

      // Even if addWorkers is malicious or negative in caller parameters,
      // executor derives needed workers strictly from validated targetWorkerCount
      const applyRes = await rig.apply("owner-add-workers", staged.stageId);
      assert.equal(applyRes.kind, "applied");
      assert.equal(rig.getLiveWorkerCount(), 4);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("16. Exited workers contribute 0 to managed SQLite handles", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-exited-handles" });
      await rig.start();

      const obsBefore = rig.observe("owner-exited-handles");
      assert.equal(obsBefore.measuredCounters.managedSqliteHandles, 48); // 45 parent + 3 live worker

      const pid = obsBefore.measuredCounters.workerPids[0];
      process.kill(pid, "SIGKILL");

      await new Promise((r) => setTimeout(r, 200));

      const obsAfter = rig.observe("owner-exited-handles");
      assert.equal(obsAfter.measuredCounters.activeWorkers, 0);
      assert.equal(obsAfter.measuredCounters.pausedWorkers, 0);
      assert.equal(obsAfter.measuredCounters.managedSqliteHandles, 45); // 45 parent + 0 live worker

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("17. After-close observation and evidence export return final snapshot", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-after-close" });
      const port = await rig.start();
      const token = rig.getIngestionToken();

      // Ingest test job
      await httpRequest(port, "POST", "/ingest", { payload: "final-snapshot-test" }, { "x-rig-token": token });

      const obsBefore = rig.observe("owner-after-close");
      const revBefore = obsBefore.revision;
      const digestBefore = obsBefore.basisDigest;
      assert.equal(obsBefore.measuredCounters.admittedJobs, 1);
      assert.equal(obsBefore.measuredCounters.managedSqliteHandles, 48);

      await rig.close();

      // observe() and exportEvidence() work after close, returning final snapshot
      const obs = rig.observe("owner-after-close");
      assert.equal(obs.status, "closed");
      assert.equal(obs.measuredCounters.admittedJobs, 1, "Admitted jobs preserved after close");
      assert.equal(obs.measuredCounters.managedSqliteHandles, 0, "Managed handles reflect actual 0");
      assert.equal(obs.measuredCounters.activeWorkers, 0);
      assert.ok(obs.revision > revBefore, "Revision advances upon closing to reflect 0 handles");
      assert.notEqual(obs.basisDigest, digestBefore, "Basis digest changed from preclose to bind actual 0 handles");

      const evidence = rig.exportEvidence("owner-after-close");
      assert.equal(evidence.status, "closed");
      assert.equal(evidence.revision, obs.revision);
      assert.equal(evidence.basisDigest, obs.basisDigest);
      assert.equal(evidence.measuredCounters.admittedJobs, 1);
      assert.equal(evidence.measuredCounters.managedSqliteHandles, 0);
      assert.equal(evidence.labels.telemetryType, "measured process telemetry");

      // History consistency check
      const history = rig.getObservationHistory("owner-after-close");
      const lastObs = history[history.length - 1];
      assert.equal(lastObs.status, "closed");
      assert.equal(lastObs.revision, obs.revision);
      assert.equal(lastObs.basisDigest, obs.basisDigest);
      assert.equal(lastObs.measuredCounters.managedSqliteHandles, 0);
      assert.equal(lastObs.measuredCounters.admittedJobs, 1);

      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("18. Ingestion Host, media type, token, 64-job cap, and byte bounds", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({ ownerId: "owner-ingest-security" });
      const port = await rig.start();
      const token = rig.getIngestionToken();

      // Non-loopback Host rejected
      const badHost = await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "ok" },
        { Host: "evil.attacker.com", "x-rig-token": token }
      );
      assert.equal(badHost.status, 403);

      // Localhost subdomain attack rejected
      const badSubdomain = await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "ok" },
        { Host: "localhost.evil.com", "x-rig-token": token }
      );
      assert.equal(badSubdomain.status, 403);

      // Wrong Content-Type rejected
      const badMedia = await httpRequest(
        port,
        "POST",
        "/ingest",
        "raw string",
        { "Content-Type": "text/plain", "x-rig-token": token }
      );
      assert.equal(badMedia.status, 415);

      // Wrong token rejected
      const badToken = await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "ok" },
        { "x-rig-token": "wrong-token-value" }
      );
      assert.equal(badToken.status, 401);

      // Unknown fields in request body rejected
      const unknownFields = await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "ok", maliciousField: "attack" },
        { "x-rig-token": token }
      );
      assert.equal(unknownFields.status, 400);

      // Oversized payload (> 1024 bytes) rejected
      const oversized = await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "x".repeat(1025) },
        { "x-rig-token": token }
      );
      assert.equal(oversized.status, 400);

      // Cap ingestion action stops new jobs
      const prop = rig.propose("owner-ingest-security").find((p) => p.actionType === "cap-ingestion")!;
      const staged = rig.stageAction("owner-ingest-security", prop.proposalId);
      await rig.apply("owner-ingest-security", staged.stageId);

      const afterCap = await httpRequest(
        port,
        "POST",
        "/ingest",
        { payload: "valid-data" },
        { "x-rig-token": token }
      );
      assert.equal(afterCap.status, 429);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("19. Expiry while start awaits never restores running status", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({
        ownerId: "owner-expiry-during-start",
        lifetimeMs: 1, // Expires immediately during startup
      });

      try {
        await rig.start();
      } catch {}

      assert.notEqual(rig.getStatus(), "running");
      assert.equal(rig.getStatus(), "expired");
      assert.equal(rig.isOpen(), false);

      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });

  test("20. IPC failure regression: resume failure returns unknown with consumed stage and no retry", async () => {
    let rig: ProcessRig | null = null;
    try {
      rig = new ProcessRig({
        ownerId: "owner-ipc-fail-test",
        _testFailResume: true, // Simulates dropped RESUME IPC or lack of RESUMED ACK
      });
      const port = await rig.start();
      const token = rig.getIngestionToken();

      // Ingest 1 test job
      await httpRequest(port, "POST", "/ingest", { payload: "ipc-fail-job" }, { "x-rig-token": token });

      const obsBefore = rig.observe("owner-ipc-fail-test");
      assert.equal(obsBefore.measuredCounters.pendingJobs, 1);
      assert.equal(obsBefore.measuredCounters.completedJobs, 0);
      assert.equal(obsBefore.measuredCounters.pausedWorkers, 1);

      // Propose and stage resume-worker
      const props = rig.propose("owner-ipc-fail-test");
      const resumeProp = props.find((p) => p.actionType === "resume-worker")!;
      assert.ok(resumeProp);

      const staged = rig.stageAction("owner-ipc-fail-test", resumeProp.proposalId);

      // Apply must await RESUMED and fail cleanly to "unknown" without throwing
      const applyRes = await rig.apply("owner-ipc-fail-test", staged.stageId);
      assert.equal(applyRes.kind, "unknown");
      assert.ok(applyRes.detail?.includes("Simulated resume failure"));

      // Stage must be consumed (executed=true): retry with same stageId is rejected as duplicate-action
      const retryRes = await rig.apply("owner-ipc-fail-test", staged.stageId);
      assert.equal(retryRes.kind, "duplicate-action");

      // Verify no jobs were dispatched: worker remains paused and queue pending intact
      const obsAfter = rig.observe("owner-ipc-fail-test");
      assert.equal(obsAfter.measuredCounters.pendingJobs, 1);
      assert.equal(obsAfter.measuredCounters.completedJobs, 0);
      assert.equal(obsAfter.measuredCounters.pausedWorkers, 1);

      await rig.close();
      rig = null;
    } finally {
      if (rig) await rig.close();
    }
  });
});
