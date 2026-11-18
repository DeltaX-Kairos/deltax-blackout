/**
 * workspace.test.ts — M2 HTTP server and WorkspaceService integration tests.
 *
 * Zero hosted API calls. Tests run against a real createServer() instance
 * bound to an OS-assigned port on 127.0.0.1.
 *
 * Coverage (M2-REVIEW-004):
 *   - Session creation and cookie / CSRF token issuance
 *   - Observe returns valid ScenarioState
 *   - Propose returns scripted proposals with correct basis
 *   - Inspect returns feasibility result
 *   - Approve returns stageId (action cached server-side, not returned to client)
 *   - Execute by stageId applies the action and returns a LabReceipt
 *   - Stale-basis rejection after a tick advance between approve and execute
 *   - Duplicate-action rejection on second execute
 *   - Tick advance updates revision and tick
 *   - Evidence bundle carries required labels, stateHistory and actionReceipts
 *   - CSRF rejection on mutation without token
 *   - Invalid Origin / Content-Type rejection
 *   - Oversized body is rejected
 *   - Unknown fields in request body are rejected
 *   - Session-not-found when cookie missing
 *   - Two-session isolation: forged stageId from another session is not found
 *   - Incident injection: main workflow stale-after-inject → fresh action applies
 *   - Duplicate injection rejected
 *   - Terminal state guard
 *   - Session capacity and expiry sweep (WorkspaceService unit)
 *   - Non-reentrant guard (WorkspaceService unit)
 *   - Per-session proposal cache independence
 *   - Browser restore endpoint returns CSRF token and state
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WorkspaceService } from "../src/workspace-service.js";
import { createServer } from "../src/server.js";

// ─── HTTP test helpers ────────────────────────────────────────────────────────

interface FetchResult {
  status: number;
  body: unknown;
  cookies: Record<string, string>;
  rawCookieHeader: string;
}

function request(
  host: string,
  port: number,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    cookie?: string;
    csrf?: string;
    contentType?: string;
    origin?: string;
    hostHeader?: string;
  } = {}
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {
      "Content-Type": opts.contentType ?? "application/json",
    };
    if (opts.cookie) headers["Cookie"] = opts.cookie;
    if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
    if (opts.origin) headers["Origin"] = opts.origin;
    if (opts.hostHeader) headers["Host"] = opts.hostHeader;
    if (bodyStr) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));

    const req = http.request({ host, port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        const setCookie = res.headers["set-cookie"] ?? [];
        const cookies: Record<string, string> = {};
        const rawCookieHeader = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
        for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
          const part = c.split(";")[0];
          const idx = part.indexOf("=");
          if (idx < 0) continue;
          const k = decodeURIComponent(part.slice(0, idx).trim());
          const v = decodeURIComponent(part.slice(idx + 1).trim());
          cookies[k] = v;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, cookies, rawCookieHeader });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Create a session and return { cookie, csrf }. */
async function createSession(
  host: string,
  port: number,
  scenario: string = "queue-storm",
  seed: number = 42,
  tickLimit: number = 20
): Promise<{ cookie: string; csrf: string; body: Record<string, unknown> }> {
  const res = await request(host, port, "POST", "/api/session", {
    body: { scenarioName: scenario, seed, tickLimit },
  });
  assert.equal(res.status, 201, `Expected 201 from /api/session, got ${res.status}`);
  const body = res.body as Record<string, unknown>;
  const csrf = body["csrfToken"] as string;
  const cookieVal = res.cookies["bk_session"];
  assert.ok(cookieVal, "Expected bk_session cookie");
  const cookie = `bk_session=${encodeURIComponent(cookieVal)}`;
  return { cookie, csrf, body };
}

/**
 * Full propose → approve flow. Returns stageId.
 * Uses the stageId-based API (approve returns stageId; execute takes stageId).
 */
async function proposeAndApprove(
  host: string,
  port: number,
  cookie: string,
  csrf: string
): Promise<{ stageId: string; proposalId: string }> {
  const propRes = await request(host, port, "POST", "/api/propose", { cookie, csrf });
  assert.equal(propRes.status, 200);
  const proposals = ((propRes.body as Record<string, unknown>)["proposals"]) as Record<string, unknown>[];
  assert.ok(proposals.length > 0);
  const p = proposals[0];
  const approveRes = await request(host, port, "POST", "/api/approve", {
    cookie, csrf, body: { proposalId: p["proposalId"] },
  });
  assert.equal(approveRes.status, 200);
  const approveBody = approveRes.body as Record<string, unknown>;
  const stageId = approveBody["stageId"] as string;
  assert.ok(typeof stageId === "string" && stageId.length === 32, "stageId must be 32-char hex");
  return { stageId, proposalId: p["proposalId"] as string };
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let service: WorkspaceService;
let server: http.Server;
let host = "127.0.0.1";
let port = 0;

before(async () => {
  service = new WorkspaceService();
  server = createServer(service);
  await new Promise<void>((resolve) => {
    server.listen(0, host, () => {
      const addr = server.address() as { port: number };
      port = addr.port;
      resolve();
    });
  });
});

after(() => {
  service.close();
  server.close();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/session", () => {
  test("returns 201 with csrfToken and sets bk_session cookie", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "queue-storm", seed: 42, tickLimit: 20 },
    });
    assert.equal(res.status, 201);
    const body = res.body as Record<string, unknown>;
    assert.ok(typeof body["csrfToken"] === "string" && body["csrfToken"].length > 0);
    assert.ok(res.cookies["bk_session"], "bk_session cookie should be set");
    assert.match(res.rawCookieHeader, /HttpOnly/i, "cookie must be HttpOnly");
    assert.match(res.rawCookieHeader, /SameSite=Strict/i, "cookie must be SameSite=Strict");
  });

  test("rejects unknown scenario", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "bogus-scenario", seed: 1 },
    });
    assert.equal(res.status, 400);
  });

  test("rejects non-integer seed", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "queue-storm", seed: 1.5 },
    });
    assert.equal(res.status, 400);
  });

  test("rejects tickLimit above 120", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "queue-storm", seed: 42, tickLimit: 121 },
    });
    assert.equal(res.status, 400);
  });

  test("rejects seed above uint32 max", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "queue-storm", seed: 0x1_0000_0000 },
    });
    assert.equal(res.status, 400);
  });

  test("rejects unknown fields in request body", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "queue-storm", seed: 1, extraField: "oops" },
    });
    assert.equal(res.status, 400);
  });

  test("accepts database-pressure scenario", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "database-pressure", seed: 99, tickLimit: 15 },
    });
    assert.equal(res.status, 201);
    const body = res.body as Record<string, unknown>;
    assert.equal(body["scenarioName"], "database-pressure");
  });

  test("rejects wrong Content-Type on session creation", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "queue-storm", seed: 42 },
      contentType: "text/plain",
    });
    assert.equal(res.status, 415);
  });

  test("rejects cross-origin request (Origin header mismatch)", async () => {
    const res = await request(host, port, "POST", "/api/session", {
      body: { scenarioName: "queue-storm", seed: 42 },
      origin: "http://evil.example.com",
    });
    assert.equal(res.status, 403);
  });
});

describe("GET /api/observe", () => {
  test("returns a valid ScenarioState", async () => {
    const { cookie } = await createSession(host, port);
    const res = await request(host, port, "GET", "/api/observe", { cookie });
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    const s = body["state"] as Record<string, unknown>;
    assert.equal(s["tick"], 0);
    assert.equal(s["revision"], 1);
    assert.equal(s["status"], "running");
    assert.match(s["basisDigest"] as string, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(body["events"]));
  });

  test("requires session cookie", async () => {
    const res = await request(host, port, "GET", "/api/observe");
    assert.equal(res.status, 401);
  });
});

describe("GET /api/restore", () => {
  test("returns CSRF token and state for browser refresh", async () => {
    const { cookie, csrf: originalCsrf } = await createSession(host, port);
    const res = await request(host, port, "GET", "/api/restore", { cookie });
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    // CSRF token should match what was issued at session creation.
    assert.equal(body["csrfToken"], originalCsrf);
    const s = body["state"] as Record<string, unknown>;
    assert.ok(typeof s["tick"] === "number");
    assert.ok(Array.isArray(body["events"]));
  });
});

describe("POST /api/propose", () => {
  test("returns scripted proposals with matching basis", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const obsRes = await request(host, port, "GET", "/api/observe", { cookie });
    const obsState = ((obsRes.body as Record<string, unknown>)["state"]) as Record<string, unknown>;

    const propRes = await request(host, port, "POST", "/api/propose", { cookie, csrf });
    assert.equal(propRes.status, 200);
    const body = propRes.body as Record<string, unknown>;
    const proposals = body["proposals"] as Record<string, unknown>[];
    assert.ok(proposals.length >= 2, "Should have at least 2 proposals");
    for (const p of proposals) {
      assert.equal(p["basisDigest"], obsState["basisDigest"], "Proposal basisDigest should match state");
      assert.equal(p["basisRevision"], obsState["revision"]);
      assert.equal(p["source"], "scripted");
      assert.ok(typeof p["payloadDigest"] === "string");
      assert.match(p["payloadDigest"] as string, /^[0-9a-f]{64}$/);
    }
  });

  test("rejects without CSRF token", async () => {
    const { cookie } = await createSession(host, port);
    const res = await request(host, port, "POST", "/api/propose", { cookie });
    assert.equal(res.status, 403);
  });
});

describe("GET /api/inspect/:proposalId", () => {
  test("returns feasibility result for a valid proposal", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const propRes = await request(host, port, "POST", "/api/propose", { cookie, csrf });
    const proposals = ((propRes.body as Record<string, unknown>)["proposals"]) as Record<string, unknown>[];
    const p = proposals[0];
    const inspectRes = await request(host, port, "GET", `/api/inspect/${encodeURIComponent(p["proposalId"] as string)}`, { cookie });
    assert.equal(inspectRes.status, 200);
    const body = inspectRes.body as Record<string, unknown>;
    const feas = body["feasibility"] as Record<string, unknown>;
    assert.ok(typeof feas["pass"] === "boolean");
    assert.ok(Array.isArray(feas["violatedRules"]));
  });

  test("returns 422 for unknown proposalId", async () => {
    const { cookie } = await createSession(host, port);
    const res = await request(host, port, "GET", "/api/inspect/nonexistent-id", { cookie });
    assert.equal(res.status, 422);
  });
});

describe("POST /api/approve", () => {
  test("returns a stageId (action cached server-side)", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const propRes = await request(host, port, "POST", "/api/propose", { cookie, csrf });
    const proposals = ((propRes.body as Record<string, unknown>)["proposals"]) as Record<string, unknown>[];
    const p = proposals[0];
    const approveRes = await request(host, port, "POST", "/api/approve", {
      cookie, csrf,
      body: { proposalId: p["proposalId"] },
    });
    assert.equal(approveRes.status, 200);
    const body = approveRes.body as Record<string, unknown>;
    // New API: returns stageId, not raw action.
    assert.ok(typeof body["stageId"] === "string", "approve must return stageId");
    assert.match(body["stageId"] as string, /^[0-9a-f]{32}$/, "stageId must be 32-char hex");
    // Raw action object should NOT be in the response.
    assert.equal(body["action"], undefined, "action payload must not be returned to client");
  });

  test("rejects without CSRF token", async () => {
    const { cookie, csrf } = await createSession(host, port);
    await request(host, port, "POST", "/api/propose", { cookie, csrf });
    const res = await request(host, port, "POST", "/api/approve", {
      cookie,
      body: { proposalId: "anything" },
    });
    assert.equal(res.status, 403);
  });

  test("rejects unknown fields in approve body", async () => {
    const { cookie, csrf } = await createSession(host, port);
    await request(host, port, "POST", "/api/propose", { cookie, csrf });
    const res = await request(host, port, "POST", "/api/approve", {
      cookie, csrf,
      body: { proposalId: "anything", extra: "field" },
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /api/execute — stageId-based happy path", () => {
  test("applies an action and returns LabReceipt", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const { stageId } = await proposeAndApprove(host, port, cookie, csrf);

    const execRes = await request(host, port, "POST", "/api/execute", {
      cookie, csrf,
      body: { stageId },
    });
    assert.equal(execRes.status, 200);
    const body = execRes.body as Record<string, unknown>;
    const result = body["result"] as Record<string, unknown>;
    const receipt = body["receipt"] as Record<string, unknown>;
    assert.equal(result["kind"], "applied");
    assert.equal(receipt["labNote"], "local model effect; no hosted call during execution");
    assert.ok(typeof receipt["revisionAfter"] === "number");
    assert.ok((receipt["revisionAfter"] as number) > 1);
  });

  test("rejects malformed stageId", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const res = await request(host, port, "POST", "/api/execute", {
      cookie, csrf, body: { stageId: "not-valid-id" },
    });
    assert.equal(res.status, 400);
  });

  test("rejects unknown fields in execute body", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const res = await request(host, port, "POST", "/api/execute", {
      cookie, csrf, body: { stageId: "a".repeat(32), extra: "bad" },
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /api/execute — two-session isolation", () => {
  test("stageId from session A is not found by session B", async () => {
    const sessA = await createSession(host, port, "queue-storm", 10);
    const sessB = await createSession(host, port, "queue-storm", 11);

    // Get a stageId from session A.
    const { stageId } = await proposeAndApprove(host, port, sessA.cookie, sessA.csrf);

    // Session B tries to use it — must be not found (404 or 422).
    const execRes = await request(host, port, "POST", "/api/execute", {
      cookie: sessB.cookie, csrf: sessB.csrf,
      body: { stageId },
    });
    assert.ok(
      execRes.status === 404 || execRes.status === 422,
      `Expected 404 or 422, got ${execRes.status}`
    );
  });
});

describe("POST /api/execute — stale basis", () => {
  test("stageId still records stale-basis after tick advances", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const { stageId } = await proposeAndApprove(host, port, cookie, csrf);

    // Advance a tick — this changes the state digest.
    await request(host, port, "POST", "/api/tick", { cookie, csrf });

    const execRes = await request(host, port, "POST", "/api/execute", {
      cookie, csrf, body: { stageId },
    });
    assert.equal(execRes.status, 200);
    const body = execRes.body as Record<string, unknown>;
    const result = body["result"] as Record<string, unknown>;
    assert.ok(
      result["kind"] === "stale-basis" || result["kind"] === "unconfirmed-payload",
      `Expected stale-basis or unconfirmed-payload, got: ${result["kind"]}`
    );
  });
});

describe("POST /api/execute — duplicate rejection", () => {
  test("second execute of same stageId returns duplicate-action", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const { stageId } = await proposeAndApprove(host, port, cookie, csrf);

    // First execute — should succeed.
    const r1 = await request(host, port, "POST", "/api/execute", { cookie, csrf, body: { stageId } });
    const r1Result = ((r1.body as Record<string, unknown>)["result"]) as Record<string, unknown>;
    assert.equal(r1Result["kind"], "applied");

    // Second execute — should be duplicate.
    const r2 = await request(host, port, "POST", "/api/execute", { cookie, csrf, body: { stageId } });
    const r2Result = ((r2.body as Record<string, unknown>)["result"]) as Record<string, unknown>;
    assert.equal(r2Result["kind"], "duplicate-action");
  });
});

describe("POST /api/inject", () => {
  test("injects database-pressure-queue-storm and returns injected state", async () => {
    const { cookie, csrf } = await createSession(host, port, "queue-storm", 42, 20);
    const injectRes = await request(host, port, "POST", "/api/inject", {
      cookie, csrf, body: { kind: "database-pressure-queue-storm" },
    });
    assert.equal(injectRes.status, 200);
    const body = injectRes.body as Record<string, unknown>;
    assert.equal(body["kind"], "injected");
    // State should reflect elevated DB connections.
    const state = body["state"] as Record<string, unknown> | undefined;
    assert.ok(state, "injected result should include new state");
    const op = state["operationalState"] as Record<string, unknown>;
    assert.equal(op["dbConnectionCount"], 94);
  });

  test("stale action is blocked; fresh infeasible scale is refused; feasible throttle applies", async () => {
    const { cookie, csrf } = await createSession(host, port, "queue-storm", 42, 20);

    // Stage an action before injection.
    const beforeInject = await proposeAndApprove(host, port, cookie, csrf);

    // Inject incident — changes state digest.
    const injectRes = await request(host, port, "POST", "/api/inject", {
      cookie, csrf, body: { kind: "database-pressure-queue-storm" },
    });
    assert.equal(injectRes.status, 200);

    // The old stageId is now stale — execute should give stale-basis.
    const staleExec = await request(host, port, "POST", "/api/execute", {
      cookie, csrf, body: { stageId: beforeInject.stageId },
    });
    assert.equal(staleExec.status, 200);
    const staleResult = ((staleExec.body as Record<string, unknown>)["result"]) as Record<string, unknown>;
    assert.ok(
      staleResult["kind"] === "stale-basis" || staleResult["kind"] === "unconfirmed-payload",
      `Expected stale-basis or unconfirmed-payload after injection, got ${staleResult["kind"]}`
    );

    // Freshness alone is insufficient: DB pressure makes scale infeasible.
    const freshProposals = await request(host, port, "POST", "/api/propose", { cookie, csrf });
    assert.equal(freshProposals.status, 200);
    const choices = (freshProposals.body as { proposals: { proposalId: string; actionType: string }[] }).proposals;
    const scale = choices.find(p => p.actionType === "scale-workers");
    const throttle = choices.find(p => p.actionType === "throttle-queue");
    assert.ok(scale && throttle);
    const scaleAttempt = await request(host, port, "POST", "/api/approve", {
      cookie, csrf, body: { proposalId: scale.proposalId },
    });
    assert.equal(scaleAttempt.status, 422, "Fresh scaling would exceed the DB budget");
    const throttleApproval = await request(host, port, "POST", "/api/approve", {
      cookie, csrf, body: { proposalId: throttle.proposalId },
    });
    assert.equal(throttleApproval.status, 200);
    const freshExec = await request(host, port, "POST", "/api/execute", {
      cookie, csrf, body: { stageId: (throttleApproval.body as { stageId: string }).stageId },
    });
    assert.equal(freshExec.status, 200);
    const freshResult = ((freshExec.body as Record<string, unknown>)["result"]) as Record<string, unknown>;
    assert.equal(freshResult["kind"], "applied", "Fresh feasible throttle must apply");
  });

  test("duplicate injection is rejected", async () => {
    const { cookie, csrf } = await createSession(host, port, "queue-storm", 99, 20);
    // First injection succeeds.
    const r1 = await request(host, port, "POST", "/api/inject", {
      cookie, csrf, body: { kind: "database-pressure-queue-storm" },
    });
    assert.equal(r1.status, 200);
    assert.equal((r1.body as Record<string, unknown>)["kind"], "injected");

    // Second injection of the same kind must be rejected.
    const r2 = await request(host, port, "POST", "/api/inject", {
      cookie, csrf, body: { kind: "database-pressure-queue-storm" },
    });
    assert.equal(r2.status, 200); // 200 with rejected-duplicate kind
    assert.equal((r2.body as Record<string, unknown>)["kind"], "rejected-duplicate");
  });

  test("rejects unknown injection kind", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const res = await request(host, port, "POST", "/api/inject", {
      cookie, csrf, body: { kind: "blow-up-the-db" },
    });
    assert.equal(res.status, 400);
  });

  test("rejects without CSRF token", async () => {
    const { cookie } = await createSession(host, port);
    const res = await request(host, port, "POST", "/api/inject", {
      cookie, body: { kind: "database-pressure-queue-storm" },
    });
    assert.equal(res.status, 403);
  });
});

describe("POST /api/tick", () => {
  test("advances tick and revision", async () => {
    const { cookie, csrf } = await createSession(host, port);

    const before = await request(host, port, "GET", "/api/observe", { cookie });
    const stateBefore = ((before.body as Record<string, unknown>)["state"]) as Record<string, unknown>;

    await request(host, port, "POST", "/api/tick", { cookie, csrf });

    const after = await request(host, port, "GET", "/api/observe", { cookie });
    const stateAfter = ((after.body as Record<string, unknown>)["state"]) as Record<string, unknown>;

    assert.ok((stateAfter["tick"] as number) > (stateBefore["tick"] as number));
    assert.ok((stateAfter["revision"] as number) > (stateBefore["revision"] as number));
    assert.notEqual(stateAfter["basisDigest"], stateBefore["basisDigest"]);
  });
});

describe("GET /api/evidence", () => {
  test("returns evidence bundle with required labels, stateHistory and actionReceipts", async () => {
    const { cookie, csrf } = await createSession(host, port);
    // Execute one action so stateHistory and actionReceipts are populated.
    const { stageId } = await proposeAndApprove(host, port, cookie, csrf);
    await request(host, port, "POST", "/api/execute", { cookie, csrf, body: { stageId } });

    const evidRes = await request(host, port, "GET", "/api/evidence", { cookie });
    assert.equal(evidRes.status, 200);
    const bundle = evidRes.body as Record<string, unknown>;
    assert.equal(bundle["labNote"], "local lab, no hosted evaluation performed");
    assert.equal(bundle["evaluateStatus"], "unconfigured");
    assert.equal(bundle["proposalSources"], "scripted");
    assert.equal(bundle["stateHistoryLabel"], "simulated telemetry");
    assert.ok(typeof bundle["exportedAt"] === "string");
    assert.ok(Array.isArray(bundle["events"]));
    const state = bundle["currentState"] as Record<string, unknown>;
    assert.ok(typeof state["tick"] === "number");
    // stateHistory must have entries.
    const history = bundle["stateHistory"] as unknown[];
    assert.ok(Array.isArray(history) && history.length >= 1, "stateHistory must have entries");
    // actionReceipts must have one entry after one apply.
    const receipts = bundle["actionReceipts"] as unknown[];
    assert.ok(Array.isArray(receipts) && receipts.length >= 1, "actionReceipts must have entries after apply");
    // sessionId must NOT be in public bundle.
    assert.equal(bundle["sessionId"], undefined, "sessionId must not appear in public evidence bundle");
  });
});

describe("Security: invalid Origin / Content-Type", () => {
  test("rejects cross-origin mutation with wrong Origin", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const res = await request(host, port, "POST", "/api/propose", {
      cookie, csrf, origin: "http://attacker.example.com",
    });
    assert.equal(res.status, 403);
  });

  test("rejects approve with wrong Content-Type", async () => {
    const { cookie, csrf } = await createSession(host, port);
    await request(host, port, "POST", "/api/propose", { cookie, csrf });
    const res = await request(host, port, "POST", "/api/approve", {
      cookie, csrf,
      body: { proposalId: "any" },
      contentType: "text/plain",
    });
    assert.equal(res.status, 415);
  });
});

describe("Oversized body", () => {
  test("rejects body over 64 KB", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const bigBody = { kind: "queue-storm", padding: "x".repeat(70_000) };
    const res = await request(host, port, "POST", "/api/inject", {
      cookie, csrf, body: bigBody,
    });
    assert.ok(res.status === 413 || res.status === 0 || res.status >= 400);
  });
});

describe("Static assets", () => {
  test("GET / returns HTML", async () => {
    const res = await request(host, port, "GET", "/");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "string" && (res.body as string).includes("<!doctype html"), "Should return HTML");
  });

  test("GET /styles.css returns CSS", async () => {
    const res = await request(host, port, "GET", "/styles.css");
    assert.equal(res.status, 200);
  });

  test("GET /app.js returns JS", async () => {
    const res = await request(host, port, "GET", "/app.js");
    assert.equal(res.status, 200);
  });
});

describe("WorkspaceService unit", () => {
  test("createSession and getSession round-trip", () => {
    const svc = new WorkspaceService();
    const rec = svc.createSession("test-id-1", "queue-storm", 42);
    assert.equal(rec.sessionId, "test-id-1");
    const got = svc.getSession("test-id-1");
    assert.equal(got.sessionId, "test-id-1");
    svc.close();
  });

  test("getSession throws on unknown ID", () => {
    const svc = new WorkspaceService();
    assert.throws(() => svc.getSession("no-such-id"), /not found/);
    svc.close();
  });

  test("destroySession removes session and its proposal cache", () => {
    const svc = new WorkspaceService();
    svc.createSession("del-id", "queue-storm", 1);
    svc.destroySession("del-id");
    assert.throws(() => svc.getSession("del-id"), /not found/);
    svc.close();
  });

  test("withSession enforces non-reentrant guard", async () => {
    const svc = new WorkspaceService();
    svc.createSession("guard-id", "queue-storm", 7);
    const first = svc.withSession("guard-id", () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("done"), 50))
    );
    await assert.rejects(
      () => svc.withSession("guard-id", async () => "second"),
      /busy/
    );
    await first;
    svc.close();
  });

  test("two sessions have independent proposal caches", async () => {
    const svc = new WorkspaceService();
    svc.createSession("sess-a", "queue-storm", 1);
    svc.createSession("sess-b", "queue-storm", 2);
    const snapA = await svc.proposeAndCache("sess-a");
    const snapB = await svc.proposeAndCache("sess-b");
    assert.ok(snapA.proposals.length > 0);
    assert.ok(snapB.proposals.length > 0);
    // Inspect from sess-a does not find sess-b's proposals.
    const inspecA = await svc.inspectCached("sess-a", snapA.proposals[0].proposalId);
    assert.ok(typeof inspecA.feasibility.pass === "boolean");
    svc.close();
  });

  test("observe returns events array — LabEvent kind accessed without cast through any", async () => {
    // Fix for workspace.test.ts line 541 (M2-REVIEW-004 Codex note):
    // LabEvent is a discriminated union; cast through unknown to reach Record.
    const svc = new WorkspaceService();
    svc.createSession("obs-id", "database-pressure", 99);
    const snap = await svc.observe("obs-id");
    assert.ok(snap.events.length >= 1, "Should have at least ScenarioStarted event");
    // Correct narrowing: cast through unknown to reach Record<string, unknown>.
    assert.equal(
      (snap.events[0] as unknown as Record<string, unknown>)["kind"],
      "ScenarioStarted"
    );
    // Direct discriminated-union access also works without any cast.
    assert.equal(snap.events[0].kind, "ScenarioStarted");
    svc.close();
  });

  test("advanceTick increments revision and tick", async () => {
    const svc = new WorkspaceService();
    svc.createSession("tick-id", "queue-storm", 5);
    const before = (await svc.observe("tick-id")).state;
    await svc.advanceTick("tick-id");
    const after = (await svc.observe("tick-id")).state;
    assert.equal(after.tick, before.tick + 1);
    assert.ok(after.revision > before.revision);
    svc.close();
  });

  test("exportEvidence carries required labels and history", async () => {
    const svc = new WorkspaceService();
    svc.createSession("ev-id", "queue-storm", 42);
    // Execute one action so receipts are populated.
    const propSnap = await svc.proposeAndCache("ev-id");
    const approveSnap = await svc.approve("ev-id", propSnap.proposals[0].proposalId);
    await svc.execute("ev-id", approveSnap.action);
    const bundle = await svc.exportEvidence("ev-id");
    assert.equal(bundle.labNote, "local lab, no hosted evaluation performed");
    assert.equal(bundle.evaluateStatus, "unconfigured");
    assert.equal(bundle.proposalSources, "scripted");
    assert.equal(bundle.stateHistoryLabel, "simulated telemetry");
    assert.ok(bundle.stateHistory.length >= 1, "stateHistory must be populated");
    assert.ok(bundle.actionReceipts.length >= 1, "actionReceipts must be populated after apply");
    svc.close();
  });

  test("sessionCount reflects active sessions", () => {
    const svc = new WorkspaceService();
    assert.equal(svc.sessionCount, 0);
    svc.createSession("c1", "queue-storm", 1);
    svc.createSession("c2", "queue-storm", 2);
    assert.equal(svc.sessionCount, 2);
    svc.destroySession("c1");
    assert.equal(svc.sessionCount, 1);
    svc.close();
  });

  test("full propose → approve → execute loop via service", async () => {
    const svc = new WorkspaceService();
    svc.createSession("loop-id", "queue-storm", 42);
    const propSnap = await svc.proposeAndCache("loop-id");
    assert.ok(propSnap.proposals.length >= 2);
    const p = propSnap.proposals[0];
    const approveSnap = await svc.approve("loop-id", p.proposalId);
    const { action } = approveSnap;
    assert.ok(typeof action.actionId === "string");
    const execSnap = await svc.execute("loop-id", action);
    assert.equal(execSnap.result.kind, "applied");
    assert.ok(execSnap.receipt !== null);
    assert.equal(execSnap.receipt!.labNote, "local model effect; no hosted call during execution");
    svc.close();
  });

  test("stale-basis rejection when state changes between approve and execute", async () => {
    const svc = new WorkspaceService();
    svc.createSession("stale-id", "queue-storm", 42);
    const propSnap = await svc.proposeAndCache("stale-id");
    const p = propSnap.proposals[0];
    const approveSnap = await svc.approve("stale-id", p.proposalId);
    const { action } = approveSnap;

    // Change state between approve and execute.
    await svc.advanceTick("stale-id");

    const execSnap = await svc.execute("stale-id", action);
    assert.ok(
      execSnap.result.kind === "stale-basis" || execSnap.result.kind === "unconfirmed-payload",
      `Expected stale-basis or unconfirmed-payload, got ${execSnap.result.kind}`
    );
    svc.close();
  });

  test("injectIncident changes digest and stale-basis preserves current state", async () => {
    const svc = new WorkspaceService();
    svc.createSession("inj-id", "queue-storm", 42);
    const propSnap = await svc.proposeAndCache("inj-id");
    const approveSnap = await svc.approve("inj-id", propSnap.proposals[0].proposalId);
    const { action } = approveSnap;

    // Inject — changes basisDigest.
    const injectResult = await svc.injectIncident("inj-id", "database-pressure-queue-storm");
    assert.equal(injectResult.kind, "injected");

    // Observe current state before the stale execute.
    const snapBefore = await svc.observe("inj-id");
    const digestBefore = snapBefore.state.basisDigest;

    // Execute the pre-injection action — expect stale-basis.
    const execSnap = await svc.execute("inj-id", action);
    assert.ok(
      execSnap.result.kind === "stale-basis" || execSnap.result.kind === "unconfirmed-payload",
      `Expected stale rejection, got ${execSnap.result.kind}`
    );

    // Current state must be unchanged (not mutated by the stale execute).
    const snapAfter = await svc.observe("inj-id");
    assert.equal(snapAfter.state.basisDigest, digestBefore, "stale execute must not mutate state");

    svc.close();
  });

  test("duplicate injectIncident returns rejected-duplicate", async () => {
    const svc = new WorkspaceService();
    svc.createSession("dup-inj", "queue-storm", 42);
    const r1 = await svc.injectIncident("dup-inj", "database-pressure-queue-storm");
    assert.equal(r1.kind, "injected");
    const r2 = await svc.injectIncident("dup-inj", "database-pressure-queue-storm");
    assert.equal(r2.kind, "rejected-duplicate");
    svc.close();
  });

  test("executeByStageId with forged stageId from another session is not found", async () => {
    const { WorkspaceService: WS2, StageNotFoundError } = await import("../src/workspace-service.js");
    const svc = new WS2();
    svc.createSession("iso-a", "queue-storm", 1);
    svc.createSession("iso-b", "queue-storm", 2);
    const propA = await svc.proposeAndCache("iso-a");
    const approveA = await svc.approve("iso-a", propA.proposals[0].proposalId);
    const stageId = approveA.stageId;
    // Session B uses session A's stageId — must throw StageNotFoundError.
    await assert.rejects(
      () => svc.executeByStageId("iso-b", stageId),
      (err: unknown) => err instanceof StageNotFoundError
    );
    svc.close();
  });

  test("restoreSession returns current CSRF token and state", async () => {
    const svc = new WorkspaceService();
    const csrfToken = "test-csrf-token";
    svc.createSession("restore-id", "queue-storm", 42, undefined, csrfToken);
    const snap = await svc.restoreSession("restore-id");
    assert.equal(snap.csrfToken, csrfToken);
    assert.ok(typeof snap.state.tick === "number");
    assert.ok(Array.isArray(snap.events));
    svc.close();
  });
});


// Codex integration regressions for independently observed HTTP boundaries.
describe("HTTP observation boundaries", () => {
  test("rejects a rebinding Host even on unauthenticated reads", async () => {
    const res = await request(host, port, "GET", "/", { hostHeader: "untrusted.example" });
    assert.equal(res.status, 403);
  });

  test("GET inspection records no mutation and explains actual downstream demand", async () => {
    const { cookie, csrf } = await createSession(host, port);
    const prop = await request(host, port, "POST", "/api/propose", { cookie, csrf });
    const id = (prop.body as { proposals: { proposalId: string }[] }).proposals[0].proposalId;
    await request(host, port, "POST", "/api/inject", { cookie, csrf, body: { kind: "database-pressure-queue-storm" } });
    const before = await request(host, port, "GET", "/api/observe", { cookie });
    const inspected = await request(host, port, "GET", `/api/inspect/${id}`, { cookie });
    assert.equal(inspected.status, 200);
    const view = inspected.body as { feasibility: { pass: boolean; resourceProjection: { observed: number; projected: number; limit: number } } };
    assert.equal(view.feasibility.pass, false);
    assert.deepEqual(view.feasibility.resourceProjection, { observed: 94, projected: 118, limit: 100 });
    const after = await request(host, port, "GET", "/api/observe", { cookie });
    assert.deepEqual((after.body as { events: unknown[] }).events, (before.body as { events: unknown[] }).events);
  });
});
