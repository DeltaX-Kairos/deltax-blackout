/**
 * tests/hosted-workspace.test.ts — Offline integration tests for hosted review workspace.
 *
 * Requirements:
 * - Uses node:test and node:assert/strict only.
 * - Zero live network calls; all tests use injected mock fetch.
 * - Synthetic test fixtures (explicitly synthetic, never real provider receipts).
 * - Loopback HTTP server on 127.0.0.1.
 * - Test coverage:
 *   1. GET /api/live/status: read-only, no fetch called, no secrets exposed, reports allowance.
 *   2. Local unconfigured mode: /api/evaluate fails informatively, direct local staging/exec works, evidence bundle labelled unconfigured.
 *   3. Hosted configured mode: valid selection mapping, eligible activity derivation, receipt persistence, staging requires selected proposal, execution succeeds.
 *   4. Governance refusal: governed_noop_refusal blocks staging (refusal cannot stage).
 *   5. Unknown outcome: locks identity, retries blocked, cannot fall through to local execution, survives session reset.
 *   6. Stale review rejection: advancing tick invalidates previous review basis.
 *   7. Budget enforcement: max 2 per cookie identity, reset session does NOT reset identity or budget, max 10 global.
 *   8. Zero eligible candidates: local feasibility refusal with NO provider fetch or budget spend.
 *   9. Security gates: CSRF, Origin, Host, Content-Type, empty body check on /api/evaluate.
 *  10. Restore & history: /api/observe history snapshots and /api/restore review state.
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkspaceService } from "../src/workspace-service.js";
import { createServer, type IRigWorkspace } from "../src/server.js";
import { HostedController } from "../src/hosted-controller.js";
import { HostedReviewClient } from "../src/hosted/client.js";
import { ReservationLedger } from "../src/hosted/ledger.js";
import { INVALID_ATTEMPT_LIMITS_ERROR } from "../src/release-config.js";
import {
  type HostedGateRecord,
  type HostedReasonCode,
  type FetchFn,
} from "../src/hosted/types.js";
import { EXPECTED_GATES } from "../src/hosted/validate.js";

// ─── HTTP test helpers ────────────────────────────────────────────────────────

interface FetchResult {
  status: number;
  body: any;
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
    secFetchSite?: string;
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
    if (opts.secFetchSite) headers["sec-fetch-site"] = opts.secFetchSite;
    if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));

    const req = http.request({ host, port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
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
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function makeCookieString(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = decodeURIComponent(part.slice(0, idx).trim());
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    result[k] = v;
  }
  return result;
}

// ─── Synthetic Fixture Generator ──────────────────────────────────────────────

function makeSyntheticResponse(opts?: {
  outcome?: "selected" | "governed_noop_refusal";
  selectedCandidateId?: string | null;
  receiptId?: string;
  reasonCodes?: HostedReasonCode[];
}) {
  const outcome = opts?.outcome ?? "selected";
  const selectedCandidateId =
    opts?.selectedCandidateId !== undefined
      ? opts.selectedCandidateId
      : outcome === "selected"
      ? "cand_scale_workers_12"
      : null;

  const gates: HostedGateRecord[] = EXPECTED_GATES.map((g) => ({
    gate_id: g,
    disposition: "pass" as const,
    reason_code: "synthetic-pass-assertion",
  }));

  const trace = {
    trace_id: "11111111-2222-4333-8444-555555555555",
    request_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    candidate_field_digest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    release_set_digest: "123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
    policy_digest: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    lambda_decisions: gates as any,
    evidence_labels: ["operator_reported", "contract_validated"],
    submitted_candidate_executed: false,
    external_effect: false,
    learning_applied: false,
    operator_reported_context_verified: false,
    committed_at: "2026-11-17T12:00:00.000Z",
  };

  const commercial_receipt = {
    receipt_id: "66666666-7777-4888-9999-aaaaaaaaaaaa",
    receipt_sha256: "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    commercial_binding_sha256: "aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999",
    mode: "free_beta",
    committed_at: "2026-11-17T12:00:00.000Z",
  };

  const authority = {
    selected_is_executed: false,
    selected_is_correct_or_safe: false,
    response_authorizes_downstream_action: false,
    response_is_professional_advice: false,
    trace_is_certification_or_legal_non_repudiation: false,
  };

  return {
    receipt_id: opts?.receiptId ?? "eval_synthetic_test_receipt_001",
    evaluated_at: "2026-11-17T12:00:00.000Z",
    counted: true,
    result: {
      outcome,
      selected_candidate_id: selectedCandidateId,
      reason_codes: opts?.reasonCodes ?? ["candidate_selected_within_bounded_evaluation"],
      trace,
      commercial_receipt,
      authority,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Hosted Review Workspace Integration", () => {
  let tmpDir: string;
  let ledgerPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bk-test-hosted-ws-"));
    ledgerPath = join(tmpDir, "test.ledger.jsonl");
    const ledger = new ReservationLedger(ledgerPath);
    await ledger.initFresh();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  // ─── 1. Status endpoint ─────────────────────────────────────────────────────

  test("GET /api/live/status reports unconfigured when no client injected", async () => {
    const service = new WorkspaceService();
    const server = createServer(service);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const res = await request("127.0.0.1", addr.port, "GET", "/api/live/status", {
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.configured, false);
      assert.equal(res.body.status, "unconfigured");
      assert.equal(res.body.allowance.totalMax, 10);
      assert.equal(res.body.allowance.totalUsed, 0);
      assert.equal(res.body.allowance.sessionMax, 2);
    } finally {
      service.close();
      server.close();
    }
  });

  test("GET /api/live/status reports available when configured and does not call provider", async () => {
    let fetchCalled = false;
    const fakeFetch: FetchFn = async () => {
      fetchCalled = true;
      throw new Error("Provider should not be called on status");
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const res = await request("127.0.0.1", addr.port, "GET", "/api/live/status", {
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.configured, true);
      assert.equal(res.body.status, "available");
      assert.equal(res.body.allowance.totalMax, 10);
      assert.equal(res.body.allowance.totalUsed, 0);
      assert.equal(res.body.allowance.sessionRemaining, 2);
      assert.equal(fetchCalled, false, "Status check must never call provider");
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 2. Local unconfigured fallback ─────────────────────────────────────────

  test("Local unconfigured mode: evaluate returns error, local direct action works", async () => {
    const service = new WorkspaceService();
    const server = createServer(service);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      // 1. Create session
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(start.status, 201);
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      // 2. /api/evaluate returns 422 indicating unconfigured
      const evalRes = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalRes.status, 422);
      assert.match(evalRes.body.error, /unconfigured/i);

      // 3. Propose and stage work directly in local mode
      const prop = await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(prop.status, 200);
      const pId = prop.body.proposals[0].proposalId;

      const app = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
        cookie,
        csrf,
        body: { proposalId: pId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(app.status, 200);
      assert.ok(app.body.stageId);

      // 4. Execute works directly
      const exec = await request("127.0.0.1", addr.port, "POST", "/api/execute", {
        cookie,
        csrf,
        body: { stageId: app.body.stageId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(exec.status, 200);
      assert.equal(exec.body.result.kind, "applied");
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 3. Hosted configured mode: valid selection and staging flow ────────────

  test("Hosted configured: evaluate maps selected candidate, staging requires selection, exec succeeds", async () => {
    let capturedEvalBody: any = null;

    const fakeFetch: FetchFn = async (url, init) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        capturedEvalBody = JSON.parse(init?.body as string);
        const firstCandId = capturedEvalBody.candidates[0].candidate_id;
        const synthetic = makeSyntheticResponse({
          outcome: "selected",
          selectedCandidateId: firstCandId,
          receiptId: "eval_test_gateway_rec_001",
        });
        return new Response(JSON.stringify(synthetic), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      // 1. Create session
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(start.status, 201);
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      // Untouched configured session evidence check (Finding 3):
      // A configured session before any review/action must return local lab note and empty reviews/receipts
      const untouchedEv = await request("127.0.0.1", addr.port, "GET", "/api/evidence", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(untouchedEv.status, 200);
      assert.equal(untouchedEv.body.labNote, "local lab, no hosted evaluation performed");
      assert.equal(untouchedEv.body.proposalSources, "scripted");
      assert.deepEqual(untouchedEv.body.reviews, []);
      assert.deepEqual(untouchedEv.body.actionReceipts, []);

      // 2. Propose candidates
      const prop = await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(prop.status, 200);
      assert.ok(prop.body.proposals.length > 0);

      // Attempting to stage WITHOUT evaluate must fail in configured mode
      const unreviewedApprove = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
        cookie,
        csrf,
        body: { proposalId: prop.body.proposals[0].proposalId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(unreviewedApprove.status, 422);
      assert.match(unreviewedApprove.body.error, /hosted review is configured/i);

      // 3. Request hosted evaluation
      const evalRes = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.body.status, "selected");
      assert.equal(evalRes.body.outcome, "selected");
      assert.ok(evalRes.body.selectedProposalId);
      assert.equal(evalRes.body.receiptId, "eval_test_gateway_rec_001");

      // Verify wire request used semantic class 'analyze' and authentic verification description
      assert.ok(capturedEvalBody);
      assert.equal(capturedEvalBody.candidates[0].semantic_class, "analyze");
      assert.match(capturedEvalBody.candidates[0].description, /^Validate/);

      // 4. Staging the SELECTED proposal succeeds
      const app = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
        cookie,
        csrf,
        body: { proposalId: evalRes.body.selectedProposalId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(app.status, 200);
      assert.ok(app.body.stageId);

      // 5. Staging a DIFFERENT (unselected) proposal fails
      const otherProposal = prop.body.proposals.find(
        (p: any) => p.proposalId !== evalRes.body.selectedProposalId
      );
      if (otherProposal) {
        const otherApp = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
          cookie,
          csrf,
          body: { proposalId: otherProposal.proposalId },
          hostHeader: `127.0.0.1:${addr.port}`,
          origin: `http://127.0.0.1:${addr.port}`,
        });
        assert.equal(otherApp.status, 422);
        assert.match(otherApp.body.error, /hosted review selected/i);
      }

      // 6. Execute the staged action
      const exec = await request("127.0.0.1", addr.port, "POST", "/api/execute", {
        cookie,
        csrf,
        body: { stageId: app.body.stageId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(exec.status, 200);
      assert.equal(exec.body.result.kind, "applied");

      // 7. Evidence download includes review record
      const ev = await request("127.0.0.1", addr.port, "GET", "/api/evidence", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(ev.status, 200);
      assert.ok(ev.body.reviews && ev.body.reviews.length > 0);
      assert.equal(ev.body.reviews[0].receiptId, "eval_test_gateway_rec_001");
      assert.equal(ev.body.proposalSources, "scripted");
      assert.equal(
        ev.body.labNote,
        "hosted review evaluated; local lab action applied with explicit operator confirmation"
      );
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 4. Governance refusal ──────────────────────────────────────────────────

  test("Governance refusal blocks staging", async () => {
    const fakeFetch: FetchFn = async (url) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        const synthetic = makeSyntheticResponse({
          outcome: "governed_noop_refusal",
          selectedCandidateId: null,
          reasonCodes: ["no_submitted_candidate_passed_all_gates"],
        });
        return new Response(JSON.stringify(synthetic), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      const propSnap = await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(propSnap.status, 200);
      const validProposalId = propSnap.body.proposals[0].proposalId;

      const evalRes = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.body.status, "refused");
      assert.equal(evalRes.body.selectedCandidateId, null);

      // Staging must fail
      const app = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
        cookie,
        csrf,
        body: { proposalId: validProposalId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(app.status, 422);
      assert.match(app.body.error, /refused/i);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 5. Unknown outcome locking ─────────────────────────────────────────────

  test("Unknown outcome blocks retrying and staging, surviving session reset", async () => {
    const fakeFetch: FetchFn = async (url) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        // Return 202 -> unknown
        return new Response("Processing in progress", { status: 202 });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      const propSnap = await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(propSnap.status, 200);
      const validProposalId = propSnap.body.proposals[0].proposalId;

      const evalRes = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.body.status, "unknown");
      const uncertainEvidence = await request("127.0.0.1", addr.port, "GET", "/api/evidence", {
        cookie, hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(uncertainEvidence.status, 200);
      assert.match(uncertainEvidence.body.labNote, /attempted; no completed review confirmed/);


      // Retrying evaluate is blocked
      const retryEval = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(retryEval.status, 422);
      assert.match(retryEval.body.error, /uncertain|blocked/i);

      // Staging is blocked
      const app = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
        cookie,
        csrf,
        body: { proposalId: validProposalId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(app.status, 422);
      assert.match(app.body.error, /uncertain/i);

      // Reset session — new session run with same client identity is STILL blocked
      const reset = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        cookie,
        body: { scenarioName: "queue-storm", seed: 43 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(reset.status, 201);
      const newCookie = makeCookieString({ ...start.cookies, ...reset.cookies });
      const newCsrf = reset.body.csrfToken;

      const evalAfterReset = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie: newCookie,
        csrf: newCsrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalAfterReset.status, 422);
      assert.match(evalAfterReset.body.error, /uncertain|blocked/i);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 6. Stale review rejection ──────────────────────────────────────────────

  test("Advancing a tick invalidates review basis (stale basis rejection)", async () => {
    let callCount = 0;
    const fakeFetch: FetchFn = async (url, init) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        callCount++;
        const parsed = JSON.parse(init?.body as string);
        const synthetic = makeSyntheticResponse({
          outcome: "selected",
          selectedCandidateId: parsed.candidates[0].candidate_id,
        });
        return new Response(JSON.stringify(synthetic), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      const evalRes = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.body.status, "selected");

      // Advance tick (increments revision)
      await request("127.0.0.1", addr.port, "POST", "/api/tick", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      // Attempt to stage using the previous review
      const app = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
        cookie,
        csrf,
        body: { proposalId: evalRes.body.selectedProposalId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(app.status, 422);
      assert.match(app.body.error, /stale/i);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 7. Budget enforcement ──────────────────────────────────────────────────

  test("Enforces max 2 evaluations per cookie identity across session resets", async () => {
    let callCount = 0;
    const fakeFetch: FetchFn = async (url, init) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        callCount++;
        const parsed = JSON.parse(init?.body as string);
        const synthetic = makeSyntheticResponse({
          outcome: "selected",
          selectedCandidateId: parsed.candidates[0].candidate_id,
        });
        return new Response(JSON.stringify(synthetic), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      // 1. Session 1, evaluation 1
      const s1 = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie1 = makeCookieString(s1.cookies);
      const csrf1 = s1.body.csrfToken;

      await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie: cookie1,
        csrf: csrf1,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      const eval1 = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie: cookie1,
        csrf: csrf1,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(eval1.status, 200);

      // 2. Reset session (Session 2), retaining bk_identity cookie
      const s2 = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        cookie: cookie1,
        body: { scenarioName: "queue-storm", seed: 43 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie2 = makeCookieString({ ...s1.cookies, ...s2.cookies });
      const csrf2 = s2.body.csrfToken;

      await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie: cookie2,
        csrf: csrf2,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      // Evaluation 2 (attempt 2 for this identity) succeeds
      const eval2 = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie: cookie2,
        csrf: csrf2,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(eval2.status, 200);

      // 3. Reset session (Session 3) and attempt evaluation 3 -> MUST BE REJECTED with 429
      const s3 = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        cookie: cookie2,
        body: { scenarioName: "queue-storm", seed: 44 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie3 = makeCookieString({ ...s1.cookies, ...s2.cookies, ...s3.cookies });
      const csrf3 = s3.body.csrfToken;

      await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie: cookie3,
        csrf: csrf3,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      const eval3 = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie: cookie3,
        csrf: csrf3,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(eval3.status, 429);
      assert.match(eval3.body.error, /budget exceeded/i);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 8. Zero eligible candidates (local refusal) ────────────────────────────

  test("Zero locally feasible candidates results in local refusal without fetch call", async () => {
    let fetchCalled = false;
    const fakeFetch: FetchFn = async () => {
      fetchCalled = true;
      throw new Error("Provider should not be called when 0 candidates are eligible");
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      // Inject replica loss or database pressure so all proposals fail feasibility
      // In queue-storm, inject db-pressure makes dbConnectionCount = 94.
      // Then generate proposals, all scale proposals violate max-resource-use.
      // Wait, throttle-queue might be feasible? Let's check:
      // If we manually filter in test or if all proposals are infeasible:
      // In database-pressure scenario, if replicaAvailability = 0 (replica-loss),
      // let's test zero eligible candidates with a scenario where all candidates fail!
      // Or we can mock inspectFeasibility or test with a scenario state where all fail.
      // Let's create session with database-pressure and inject replica-loss:
      const sDb = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        cookie,
        body: { scenarioName: "database-pressure", seed: 99 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const dbCookie = makeCookieString({ ...start.cookies, ...sDb.cookies });
      const dbCsrf = sDb.body.csrfToken;

      // Inject replica-loss
      await request("127.0.0.1", addr.port, "POST", "/api/inject", {
        cookie: dbCookie,
        csrf: dbCsrf,
        body: { kind: "replica-loss" },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      // Now propose at current revision
      const dbProp = await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie: dbCookie,
        csrf: dbCsrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(dbProp.status, 200);

      // Advance 6 ticks so all cached proposals exceed the freshness threshold (revisionAge > 5)
      for (let i = 0; i < 6; i++) {
        await request("127.0.0.1", addr.port, "POST", "/api/tick", {
          cookie: dbCookie,
          csrf: dbCsrf,
          hostHeader: `127.0.0.1:${addr.port}`,
          origin: `http://127.0.0.1:${addr.port}`,
        });
      }

      const evalRes = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie: dbCookie,
        csrf: dbCsrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.body.status, "refused");
      assert.equal(evalRes.body.source, "local_feasibility_gate");
      assert.equal(fetchCalled, false, "Must not call fetch when 0 candidates are eligible");
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 9. Security gates on /api/evaluate ──────────────────────────────────────

  test("Security gates on /api/evaluate: CSRF, Origin, Host, Content-Type, empty body check", async () => {
    const service = new WorkspaceService();
    const server = createServer(service);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      // Missing CSRF token
      const noCsrf = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(noCsrf.status, 403);

      // Wrong Origin
      const badOrigin = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: "http://attacker.com",
      });
      assert.equal(badOrigin.status, 403);

      // Wrong Host (DNS rebinding)
      const badHost = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: "attacker.com",
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(badHost.status, 403);

      // Non-empty body / unknown fields
      const badBody = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: { injectedField: "malicious" },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(badBody.status, 400);

      // Cross-site Sec-Fetch-Site
      const crossSite = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
        secFetchSite: "cross-site",
      });
      assert.equal(crossSite.status, 403);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 10. History snapshots and Restore ───────────────────────────────────────

  test("/api/observe returns chronological history and /api/restore restores review state", async () => {
    let capturedEvalBody: any = null;
    const fakeFetch: FetchFn = async (url, init) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        capturedEvalBody = JSON.parse(init?.body as string);
        const firstCandId = capturedEvalBody.candidates[0].candidate_id;
        const synthetic = makeSyntheticResponse({
          outcome: "selected",
          selectedCandidateId: firstCandId,
          receiptId: "eval_restore_test_001",
        });
        return new Response(JSON.stringify(synthetic), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      // Advance two ticks
      await request("127.0.0.1", addr.port, "POST", "/api/tick", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      await request("127.0.0.1", addr.port, "POST", "/api/tick", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      // Observe should contain history array with 3 snapshots (initial, t1, t2)
      const obs = await request("127.0.0.1", addr.port, "GET", "/api/observe", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(obs.status, 200);
      assert.ok(Array.isArray(obs.body.history));
      assert.equal(obs.body.history.length, 3);
      assert.equal(obs.body.history[0].tick, 0);
      assert.equal(obs.body.history[1].tick, 1);
      assert.equal(obs.body.history[2].tick, 2);

      // Perform evaluation
      const evalRes = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.body.status, "selected");

      // /api/restore should return state, history, liveStatus, and current review
      const restore = await request("127.0.0.1", addr.port, "GET", "/api/restore", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(restore.status, 200);
      assert.equal(restore.body.csrfToken, csrf);
      assert.equal(restore.body.state.tick, 2);
      assert.ok(Array.isArray(restore.body.history));
      assert.ok(restore.body.liveStatus);
      assert.equal(restore.body.liveStatus.configured, true);
      assert.ok(restore.body.review);
      assert.equal(restore.body.review.status, "selected");
      assert.equal(restore.body.review.receiptId, "eval_restore_test_001");
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 11. Configured-disabled mode with missing credentials/ledger ──────────

  test("BLACKOUT_ENABLE_HOSTED=true with missing credentials reports configured-disabled", async () => {
    // Enabled via options without credentials
    const controller = new HostedController({ enabled: true });
    assert.equal(controller.isConfigured, true);
    assert.equal(controller.isConfigDisabled, true);

    const status = await controller.getStatus("some_client_id");
    assert.equal(status.configured, true);
    assert.equal(status.status, "disabled");
    assert.match(status.detail!, /Missing required/i);

    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const res = await request("127.0.0.1", addr.port, "GET", "/api/live/status", {
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.configured, true);
      assert.equal(res.body.status, "disabled");
      assert.match(res.body.detail, /Missing required/i);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 12. Missing, empty, corrupt ledger disables without provider call ──────

  test("Missing, empty, and corrupt ledger files disable live mode without provider call", async () => {
    let fetchCalled = false;
    const fakeFetch: FetchFn = async () => {
      fetchCalled = true;
      throw new Error("Provider should not be called when ledger is corrupt/missing");
    };

    // Case A: Missing ledger file
    const missingLedgerPath = join(tmpDir, "missing.ledger.jsonl");
    const clientMissing = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath: missingLedgerPath,
      fetch: fakeFetch,
    });
    const controllerMissing = new HostedController({ client: clientMissing });
    const statusMissing = await controllerMissing.getStatus("test_identity");
    assert.equal(statusMissing.status, "disabled");
    assert.equal(fetchCalled, false);

    // Case B: Empty ledger file
    const emptyLedgerPath = join(tmpDir, "empty.ledger.jsonl");
    await writeFile(emptyLedgerPath, "");
    const clientEmpty = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath: emptyLedgerPath,
      fetch: fakeFetch,
    });
    const controllerEmpty = new HostedController({ client: clientEmpty });
    const statusEmpty = await controllerEmpty.getStatus("test_identity");
    assert.equal(statusEmpty.status, "disabled");
    assert.equal(fetchCalled, false);

    // Case C: Corrupt ledger file (missing final newline or invalid JSON)
    const corruptLedgerPath = join(tmpDir, "corrupt.ledger.jsonl");
    await writeFile(corruptLedgerPath, "{\"version\":\"deltax-blackout-hosted-ledger-v1\"}\n{not-valid-json}\n");
    const clientCorrupt = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath: corruptLedgerPath,
      fetch: fakeFetch,
    });
    const controllerCorrupt = new HostedController({ client: clientCorrupt });
    const statusCorrupt = await controllerCorrupt.getStatus("test_identity");
    assert.equal(statusCorrupt.status, "disabled");
    assert.equal(fetchCalled, false);
  });

  // ─── 13. Unknown identity lock survives restart ────────────────────────────

  test("Persisted unknown ledger entry locks identity across controller restart", async () => {
    const fakeFetch: FetchFn = async (url) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        // Return 202 -> unknown transition written to disk
        return new Response("Pending review", { status: 202 });
      }
      return new Response("Not found", { status: 404 });
    };

    const client1 = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client1.init();

    const controller1 = new HostedController({ client: client1 });
    const service1 = new WorkspaceService(controller1);
    const server1 = createServer(service1, controller1);
    await new Promise<void>((resolve) => server1.listen(0, "127.0.0.1", resolve));
    const addr1 = server1.address() as any;

    let cookie: string;
    let csrf: string;

    try {
      const start = await request("127.0.0.1", addr1.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr1.port}`,
        origin: `http://127.0.0.1:${addr1.port}`,
      });
      cookie = makeCookieString(start.cookies);
      csrf = start.body.csrfToken;

      await request("127.0.0.1", addr1.port, "POST", "/api/propose", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr1.port}`,
        origin: `http://127.0.0.1:${addr1.port}`,
      });

      const evalRes = await request("127.0.0.1", addr1.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr1.port}`,
        origin: `http://127.0.0.1:${addr1.port}`,
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.body.status, "unknown");
    } finally {
      service1.close();
      server1.close();
    }

    // Server restarted: new HostedReviewClient, new HostedController, new server instance
    // replaying the SAME ledgerPath
    const client2 = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client2.init();

    const controller2 = new HostedController({ client: client2 });
    const service2 = new WorkspaceService(controller2);
    const server2 = createServer(service2, controller2);
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
    const addr2 = server2.address() as any;

    try {
      // Reconnected client with same cookie identity must be locked on restart
      const statusRes = await request("127.0.0.1", addr2.port, "GET", "/api/live/status", {
        cookie,
        hostHeader: `127.0.0.1:${addr2.port}`,
      });
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.status, "unknown");

      // Attempting to evaluate in a new session with the same cookie is blocked
      const newSession = await request("127.0.0.1", addr2.port, "POST", "/api/session", {
        cookie,
        body: { scenarioName: "queue-storm", seed: 99 },
        hostHeader: `127.0.0.1:${addr2.port}`,
        origin: `http://127.0.0.1:${addr2.port}`,
      });
      assert.equal(newSession.status, 201);
      const newCookie = makeCookieString({ ...parseCookies(cookie), ...newSession.cookies });
      const newCsrf = newSession.body.csrfToken;

      const evalAfterRestart = await request("127.0.0.1", addr2.port, "POST", "/api/evaluate", {
        cookie: newCookie,
        csrf: newCsrf,
        body: {},
        hostHeader: `127.0.0.1:${addr2.port}`,
        origin: `http://127.0.0.1:${addr2.port}`,
      });
      assert.equal(evalAfterRestart.status, 422);
      assert.match(evalAfterRestart.body.error, /uncertain|blocked/i);
    } finally {
      service2.close();
      server2.close();
    }
  });

  // ─── 14. Orphan reservation locks identity on restart ──────────────────────

  test("Orphan reservation lacking terminal persistence locks identity on restart", async () => {
    // Manually append an unfinalized reservation entry to the ledger with valid bodySha256
    const ledger = new ReservationLedger(ledgerPath);
    const requestBody = JSON.stringify({ test: "request" });
    const bodySha256 = createHash("sha256").update(requestBody).digest("hex");
    const basisDigest = createHash("sha256").update("basis").digest("hex");

    await ledger.reserve({
      idempotencyKey: "test_orphan_key_12345678",
      bodySha256,
      sessionId: "orphan_browser_identity_123",
      basisRevision: 1,
      basisDigest,
      requestBody,
    });
    // Do NOT transition: leaves entry in 'reserved' state

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: async () => new Response("Not found", { status: 404 }),
    });
    await client.init();
    assert.equal(client.isDisabled, false, "Client must not be disabled by replay");

    const controller = new HostedController({ client });
    // Identity lock inspection should detect the orphan reservation as uncertain
    const lock = controller.isIdentityLocked("orphan_browser_identity_123");
    assert.equal(lock.locked, true);
    assert.match(lock.reason!, /unfinalized reservation|uncertain/i);
  });

  // ─── 15. Execution re-checks current review ─────────────────────────────────

  test("Subsequent refused review invalidates an old staged action at execute time", async () => {
    let mode: "selected" | "refused" = "selected";

    const fakeFetch: FetchFn = async (url, init) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        const parsed = JSON.parse(init?.body as string);
        if (mode === "selected") {
          const synthetic = makeSyntheticResponse({
            outcome: "selected",
            selectedCandidateId: parsed.candidates[0].candidate_id,
          });
          return new Response(JSON.stringify(synthetic), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } else {
          const synthetic = makeSyntheticResponse({
            outcome: "governed_noop_refusal",
            selectedCandidateId: null,
            reasonCodes: ["no_submitted_candidate_passed_all_gates"],
          });
          return new Response(JSON.stringify(synthetic), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
    });
    await client.init();

    const controller = new HostedController({ client });
    const service = new WorkspaceService(controller);
    const server = createServer(service, controller);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;

      await request("127.0.0.1", addr.port, "POST", "/api/propose", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });

      // 1. Evaluate in selected mode
      const eval1 = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(eval1.status, 200);
      assert.equal(eval1.body.status, "selected");

      // 2. Stage the selected proposal -> returns stageId
      const app = await request("127.0.0.1", addr.port, "POST", "/api/approve", {
        cookie,
        csrf,
        body: { proposalId: eval1.body.selectedProposalId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(app.status, 200);
      const stageId = app.body.stageId;

      // 3. Before executing stageId, a new evaluation runs that returns REFUSED
      mode = "refused";
      const eval2 = await request("127.0.0.1", addr.port, "POST", "/api/evaluate", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(eval2.status, 200);
      assert.equal(eval2.body.status, "refused");

      // 4. Attempting to execute the old stageId must now be blocked
      const exec = await request("127.0.0.1", addr.port, "POST", "/api/execute", {
        cookie,
        csrf,
        body: { stageId },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(exec.status, 422);
      assert.match(exec.body.error, /refused|blocked/i);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 16. Rig mount: uninstalled state and static allowlist ─────────────────

  test("When rig module is absent, /api/rig/* returns 503 and static allowlist restricts paths", async () => {
    const service = new WorkspaceService();
    // Injected rigWorkspace is explicitly null (module not installed)
    const server = createServer(service, undefined, null);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      // 1. Static allowlist: /rig/ serves file (or 404 text/plain if not on disk)
      const rigHtmlRes = await request("127.0.0.1", addr.port, "GET", "/rig/", {
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      // Either 200 (if file exists) or 404 text/plain (file absent), but NOT JSON error { error: "No route..." }
      if (rigHtmlRes.status === 404) {
        assert.equal(typeof rigHtmlRes.body, "string");
        assert.match(rigHtmlRes.body, /not found/i);
      }

      // 2. /api/rig/status without session cookie returns 401
      const noSession = await request("127.0.0.1", addr.port, "GET", "/api/rig/status", {
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(noSession.status, 401);

      // 3. Create session
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);

      // 4. Arbitrary path under /rig/ with valid session is NOT in static allowlist -> returns 404 JSON { error: "No route..." }
      const arbitraryRes = await request("127.0.0.1", addr.port, "GET", "/rig/evil.json", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(arbitraryRes.status, 404);
      assert.match(arbitraryRes.body.error, /no route/i);

      // 5. With session cookie, /api/rig/status returns 503 (rig unavailable)
      const rigStatus = await request("127.0.0.1", addr.port, "GET", "/api/rig/status", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(rigStatus.status, 503);
      assert.match(rigStatus.body.error, /not available/i);
    } finally {
      service.close();
      server.close();
    }
  });

  // ─── 17. Rig mount: security gates, dispatch and lifecycle coordination ─────

  test("Mounted RigWorkspace dispatches with server-owned session ID, enforces security gates, and coordinates lifecycle", async () => {
    const rigCalls: string[] = [];
    let rigOwnerPassed: string | null = null;
    let isRigRunning = false;
    let shutdownCalled = false;

    const fakeRig: IRigWorkspace = {
      async start(ownerId: string) {
        rigCalls.push("start");
        rigOwnerPassed = ownerId;
        isRigRunning = true;
        return { status: "running", ownerId, pending: 24, workers: 1 };
      },
      async status(ownerId: string) {
        rigCalls.push("status");
        rigOwnerPassed = ownerId;
        return { status: isRigRunning ? "running" : "idle", active: isRigRunning, ownerId };
      },
      async propose(ownerId: string) {
        rigCalls.push("propose");
        return { proposals: [{ proposalId: "rig-prop-1", actionType: "scale" }] };
      },
      async stage(ownerId: string, proposalId: string) {
        rigCalls.push(`stage:${proposalId}`);
        return { stageId: "rig-stage-123", proposalId };
      },
      async apply(ownerId: string, stageId: string) {
        rigCalls.push(`apply:${stageId}`);
        return { result: "applied", stageId };
      },
      async injectPressure(ownerId: string) {
        rigCalls.push("pressure");
        return { pressureInjected: true };
      },
      async close(ownerId: string) {
        rigCalls.push("close");
        isRigRunning = false;
        return { closed: true, ownerId };
      },
      async evidence(ownerId: string) {
        rigCalls.push("evidence");
        return { evidenceLabel: "measured process telemetry", runs: [] };
      },
      async shutdown() {
        shutdownCalled = true;
      },
    };

    const service = new WorkspaceService();
    const server = createServer(service, undefined, fakeRig);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;

    try {
      const start = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        body: { scenarioName: "queue-storm", seed: 42 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      const cookie = makeCookieString(start.cookies);
      const csrf = start.body.csrfToken;
      const expectedSessionId = start.cookies["bk_session"];

      // 1. GET /api/rig/status — DNS rebinding protection (Host header check)
      const forgedHost = await request("127.0.0.1", addr.port, "GET", "/api/rig/status", {
        cookie,
        hostHeader: "attacker.com",
      });
      assert.equal(forgedHost.status, 403);

      // 2. GET /api/rig/status — valid dispatch passes server-resolved sessionId
      const statusRes = await request("127.0.0.1", addr.port, "GET", "/api/rig/status", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(statusRes.status, 200);
      assert.equal(rigOwnerPassed, expectedSessionId);
      assert.equal(statusRes.body.status, "idle");

      // 3. POST /api/rig/start — CSRF protection (missing CSRF -> 403)
      const missingCsrf = await request("127.0.0.1", addr.port, "POST", "/api/rig/start", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(missingCsrf.status, 403);

      // 4. POST /api/rig/start — Origin protection (untrusted Origin -> 403)
      const badOrigin = await request("127.0.0.1", addr.port, "POST", "/api/rig/start", {
        cookie,
        csrf,
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: "http://attacker.com",
      });
      assert.equal(badOrigin.status, 403);

      // 5. POST /api/rig/start — closed schema (unexpected fields -> 400)
      const extraFields = await request("127.0.0.1", addr.port, "POST", "/api/rig/start", {
        cookie,
        csrf,
        body: { malicious: true },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(extraFields.status, 400);

      // 6. POST /api/rig/start — valid start
      const startRes = await request("127.0.0.1", addr.port, "POST", "/api/rig/start", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(startRes.status, 200);
      assert.equal(startRes.body.status, "running");
      assert.equal(isRigRunning, true);

      // 7. POST /api/rig/propose
      const propRes = await request("127.0.0.1", addr.port, "POST", "/api/rig/propose", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(propRes.status, 200);

      // 8. POST /api/rig/stage — closed schema check
      const badStage = await request("127.0.0.1", addr.port, "POST", "/api/rig/stage", {
        cookie,
        csrf,
        body: { proposalId: "p1", extra: "forbidden" },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(badStage.status, 400);

      const stageRes = await request("127.0.0.1", addr.port, "POST", "/api/rig/stage", {
        cookie,
        csrf,
        body: { proposalId: "rig-prop-1" },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(stageRes.status, 200);
      assert.equal(stageRes.body.stageId, "rig-stage-123");

      // 9. POST /api/rig/apply
      const applyRes = await request("127.0.0.1", addr.port, "POST", "/api/rig/apply", {
        cookie,
        csrf,
        body: { stageId: "rig-stage-123" },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(applyRes.status, 200);
      assert.equal(applyRes.body.result, "applied");

      // 10. POST /api/rig/pressure
      const pressRes = await request("127.0.0.1", addr.port, "POST", "/api/rig/pressure", {
        cookie,
        csrf,
        body: {},
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(pressRes.status, 200);
      assert.equal(pressRes.body.pressureInjected, true);

      // 11. GET /api/rig/evidence
      const evRes = await request("127.0.0.1", addr.port, "GET", "/api/rig/evidence", {
        cookie,
        hostHeader: `127.0.0.1:${addr.port}`,
      });
      assert.equal(evRes.status, 200);
      assert.equal(evRes.body.evidenceLabel, "measured process telemetry");

      // 12. Session reset coordinates cleanup of active rig
      assert.equal(isRigRunning, true);
      const resetRes = await request("127.0.0.1", addr.port, "POST", "/api/session", {
        cookie,
        body: { scenarioName: "database-pressure", seed: 99 },
        hostHeader: `127.0.0.1:${addr.port}`,
        origin: `http://127.0.0.1:${addr.port}`,
      });
      assert.equal(resetRes.status, 201);
      // Rig was closed during session reset cleanup
      assert.equal(isRigRunning, false);
      assert.ok(rigCalls.includes("close"));
    } finally {
      service.close();
      server.close();
      // Server close coordinates rig shutdown
      assert.equal(shutdownCalled, true);
    }
  });

  // ─── 18. Trusted server attempt limits (100 total / 6 browser) ──────────────

  async function withEnv<T>(
    overrides: Record<string, string | undefined>,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
      prev[k] = process.env[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  }

  async function appendCompletedReservation(
    ledger: ReservationLedger,
    opts: {
      idempotencyKey: string;
      sessionId: string;
      basisRevision?: number;
      receiptId: string;
    }
  ): Promise<void> {
    const requestBody = JSON.stringify({
      profile_id: "deltax-hosted-bounded-review-evaluation-v1",
      objective: "Validate proposed scaling plan without changing services",
      context: { tick: 0 },
      candidates: [
        {
          candidate_id: "cand_scale_workers_12",
          semantic_class: "analyze",
          description: "Validate scaling plan",
          operator_reported_support: 0.8,
        },
      ],
    });
    const bodySha256 = createHash("sha256").update(requestBody, "utf8").digest("hex");
    const basisDigest = createHash("sha256").update(`basis:${opts.idempotencyKey}`, "utf8").digest("hex");
    const payloadHash = createHash("sha256").update(`payload:${opts.idempotencyKey}`, "utf8").digest("hex");

    await ledger.reserve({
      idempotencyKey: opts.idempotencyKey,
      bodySha256,
      sessionId: opts.sessionId,
      basisRevision: opts.basisRevision ?? 1,
      basisDigest,
      requestBody,
      candidateIds: ["cand_scale_workers_12"],
      candidatePayloadHashes: { cand_scale_workers_12: payloadHash },
    });

    await ledger.recordTransition(opts.idempotencyKey, {
      state: "selected",
      httpStatus: 200,
      detail: "candidate_selected",
      selectedCandidateId: "cand_scale_workers_12",
      rawEnvelope: makeSyntheticResponse({
        outcome: "selected",
        selectedCandidateId: "cand_scale_workers_12",
        receiptId: opts.receiptId,
      }) as any,
    });
  }

  test("Real default controller in createServer exposes 100/6 limits and retains 6 prior historical reservations", async () => {
    const priorIdentityA = "a".repeat(32);
    const priorIdentityB = "b".repeat(32);
    const priorIdentityC = "c".repeat(32);
    const histLedger = new ReservationLedger(ledgerPath);

    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_attempt_000000000001",
      sessionId: priorIdentityA,
      receiptId: "eval_hist_001",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_attempt_000000000002",
      sessionId: priorIdentityA,
      receiptId: "eval_hist_002",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_attempt_000000000003",
      sessionId: priorIdentityB,
      receiptId: "eval_hist_003",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_attempt_000000000004",
      sessionId: priorIdentityB,
      receiptId: "eval_hist_004",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_attempt_000000000005",
      sessionId: priorIdentityC,
      receiptId: "eval_hist_005",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_attempt_000000000006",
      sessionId: priorIdentityC,
      receiptId: "eval_hist_006",
    });

    await withEnv(
      {
        BLACKOUT_ENABLE_HOSTED: "true",
        BLACKOUT_CLIENT_ID: "test_client_id",
        BLACKOUT_CLIENT_SECRET: "test_client_secret",
        BLACKOUT_LEDGER_PATH: ledgerPath,
        BLACKOUT_MAX_TOTAL_ATTEMPTS: "100",
        BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
      },
      async () => {
        const service = new WorkspaceService();
        const server = createServer(service);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as any;

        try {
          // Existing historical browser identity retains its 2 counted attempts out of 6
          const priorStatus = await request("127.0.0.1", addr.port, "GET", "/api/live/status", {
            cookie: `bk_identity=${priorIdentityA}`,
            hostHeader: `127.0.0.1:${addr.port}`,
          });
          assert.equal(priorStatus.status, 200);
          assert.equal(priorStatus.body.configured, true);
          assert.equal(priorStatus.body.status, "available");
          assert.equal(priorStatus.body.active, false);
          assert.deepEqual(priorStatus.body.allowance, {
            totalMax: 100,
            totalUsed: 6,
            sessionMax: 6,
            sessionUsed: 2,
            sessionRemaining: 4,
            activeConcurrent: 0,
          });

          // Fresh browser identity sees all 6 historical attempts counted against 100 total
          const freshStatus = await request("127.0.0.1", addr.port, "GET", "/api/live/status", {
            hostHeader: `127.0.0.1:${addr.port}`,
          });
          assert.equal(freshStatus.status, 200);
          assert.equal(freshStatus.body.configured, true);
          assert.equal(freshStatus.body.status, "available");
          assert.deepEqual(freshStatus.body.allowance, {
            totalMax: 100,
            totalUsed: 6,
            sessionMax: 6,
            sessionUsed: 0,
            sessionRemaining: 6,
            activeConcurrent: 0,
          });
        } finally {
          service.close();
          server.close();
        }
      }
    );
  });

  test("100/6 limits persist per-identity counts, unknown locks, and active concurrency across restart", async () => {
    const identityA = "a".repeat(32);
    const identityB = "b".repeat(32);
    const identityC = "c".repeat(32);
    const lockedIdentity = "d".repeat(32);
    const busyIdentity = "e".repeat(32);

    const histLedger = new ReservationLedger(ledgerPath);
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_restart_00000000001",
      sessionId: identityA,
      receiptId: "eval_hist_r01",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_restart_00000000002",
      sessionId: identityA,
      receiptId: "eval_hist_r02",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_restart_00000000003",
      sessionId: identityB,
      receiptId: "eval_hist_r03",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_restart_00000000004",
      sessionId: identityB,
      receiptId: "eval_hist_r04",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_restart_00000000005",
      sessionId: identityC,
      receiptId: "eval_hist_r05",
    });
    await appendCompletedReservation(histLedger, {
      idempotencyKey: "hist_restart_00000000006",
      sessionId: identityC,
      receiptId: "eval_hist_r06",
    });

    const fakeFetch: FetchFn = async (url, init) => {
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "dxbt_test_token_123",
            token_type: "Bearer",
            expires_in: 900,
            scope: "deltax:evaluate",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/evaluations")) {
        const parsed = JSON.parse(init?.body as string);
        const synthetic = makeSyntheticResponse({
          outcome: "selected",
          selectedCandidateId: parsed.candidates[0].candidate_id,
        });
        return new Response(JSON.stringify(synthetic), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    // Run 4 additional evaluations for identityA (total 6 for identityA, 10 overall)
    const client1 = new HostedReviewClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      ledgerPath,
      fetch: fakeFetch,
      maxAttempts: 100,
      maxPerSession: 6,
    });
    await client1.init();

    const controller1 = new HostedController({
      client: client1,
      maxAttempts: 100,
      maxPerSession: 6,
    });
    const service1 = new WorkspaceService(controller1);
    const server1 = createServer(service1, controller1);
    await new Promise<void>((resolve) => server1.listen(0, "127.0.0.1", resolve));
    const addr1 = server1.address() as any;

    try {
      let currentIdentityCookie = `bk_identity=${identityA}`;
      for (let i = 0; i < 4; i++) {
        const s = await request("127.0.0.1", addr1.port, "POST", "/api/session", {
          cookie: currentIdentityCookie,
          body: { scenarioName: "queue-storm", seed: 42 + i },
          hostHeader: `127.0.0.1:${addr1.port}`,
          origin: `http://127.0.0.1:${addr1.port}`,
        });
        assert.equal(s.status, 201);
        const sessionCookie = makeCookieString({
          bk_identity: identityA,
          bk_session: s.cookies["bk_session"],
        });
        currentIdentityCookie = `bk_identity=${identityA}`;
        const csrf = s.body.csrfToken;

        const prop = await request("127.0.0.1", addr1.port, "POST", "/api/propose", {
          cookie: sessionCookie,
          csrf,
          hostHeader: `127.0.0.1:${addr1.port}`,
          origin: `http://127.0.0.1:${addr1.port}`,
        });
        assert.equal(prop.status, 200);

        const ev = await request("127.0.0.1", addr1.port, "POST", "/api/evaluate", {
          cookie: sessionCookie,
          csrf,
          body: {},
          hostHeader: `127.0.0.1:${addr1.port}`,
          origin: `http://127.0.0.1:${addr1.port}`,
        });
        assert.equal(ev.status, 200);
        assert.equal(ev.body.status, "selected");
      }

      // 7th attempt for identityA is rejected with 429
      const s7 = await request("127.0.0.1", addr1.port, "POST", "/api/session", {
        cookie: currentIdentityCookie,
        body: { scenarioName: "queue-storm", seed: 99 },
        hostHeader: `127.0.0.1:${addr1.port}`,
        origin: `http://127.0.0.1:${addr1.port}`,
      });
      assert.equal(s7.status, 201);
      const cookie7 = makeCookieString({
        bk_identity: identityA,
        bk_session: s7.cookies["bk_session"],
      });
      await request("127.0.0.1", addr1.port, "POST", "/api/propose", {
        cookie: cookie7,
        csrf: s7.body.csrfToken,
        hostHeader: `127.0.0.1:${addr1.port}`,
        origin: `http://127.0.0.1:${addr1.port}`,
      });
      const eval7 = await request("127.0.0.1", addr1.port, "POST", "/api/evaluate", {
        cookie: cookie7,
        csrf: s7.body.csrfToken,
        body: {},
        hostHeader: `127.0.0.1:${addr1.port}`,
        origin: `http://127.0.0.1:${addr1.port}`,
      });
      assert.equal(eval7.status, 429);
      assert.match(eval7.body.error, /budget exceeded/i);
    } finally {
      service1.close();
      server1.close();
    }

    // Restart with real default controller configured via env for 100/6
    await withEnv(
      {
        BLACKOUT_ENABLE_HOSTED: "true",
        BLACKOUT_CLIENT_ID: "test_client_id",
        BLACKOUT_CLIENT_SECRET: "test_client_secret",
        BLACKOUT_LEDGER_PATH: ledgerPath,
        BLACKOUT_MAX_TOTAL_ATTEMPTS: "100",
        BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
      },
      async () => {
        const service2 = new WorkspaceService();
        const server2 = createServer(service2);
        await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
        const addr2 = server2.address() as any;

        try {
          const exhaustedStatus = await request("127.0.0.1", addr2.port, "GET", "/api/live/status", {
            cookie: `bk_identity=${identityA}`,
            hostHeader: `127.0.0.1:${addr2.port}`,
          });
          assert.equal(exhaustedStatus.status, 200);
          assert.equal(exhaustedStatus.body.status, "disabled");
          assert.deepEqual(exhaustedStatus.body.allowance, {
            totalMax: 100,
            totalUsed: 10,
            sessionMax: 6,
            sessionUsed: 6,
            sessionRemaining: 0,
            activeConcurrent: 0,
          });

          const otherStatus = await request("127.0.0.1", addr2.port, "GET", "/api/live/status", {
            cookie: `bk_identity=${identityB}`,
            hostHeader: `127.0.0.1:${addr2.port}`,
          });
          assert.equal(otherStatus.status, 200);
          assert.equal(otherStatus.body.status, "available");
          assert.deepEqual(otherStatus.body.allowance, {
            totalMax: 100,
            totalUsed: 10,
            sessionMax: 6,
            sessionUsed: 2,
            sessionRemaining: 4,
            activeConcurrent: 0,
          });
        } finally {
          service2.close();
          server2.close();
        }

        // Persist an unknown outcome and verify lock survives restart under 100/6
        const ledgerUnknown = new ReservationLedger(ledgerPath, 100, 6);
        const reqBodyUnknown = JSON.stringify({ test: "unknown-lock" });
        await ledgerUnknown.reserve({
          idempotencyKey: "unknown_restart_0000001",
          bodySha256: createHash("sha256").update(reqBodyUnknown).digest("hex"),
          sessionId: lockedIdentity,
          basisRevision: 1,
          basisDigest: createHash("sha256").update("basis-unknown").digest("hex"),
          requestBody: reqBodyUnknown,
        });
        await ledgerUnknown.recordTransition("unknown_restart_0000001", {
          state: "unknown",
          httpStatus: 202,
          detail: "pending_202",
        });

        const service3 = new WorkspaceService();
        const server3 = createServer(service3);
        await new Promise<void>((resolve) => server3.listen(0, "127.0.0.1", resolve));
        const addr3 = server3.address() as any;

        try {
          const lockedStatus = await request("127.0.0.1", addr3.port, "GET", "/api/live/status", {
            cookie: `bk_identity=${lockedIdentity}`,
            hostHeader: `127.0.0.1:${addr3.port}`,
          });
          assert.equal(lockedStatus.status, 200);
          assert.equal(lockedStatus.body.status, "unknown");
          assert.equal(lockedStatus.body.allowance.totalMax, 100);
          assert.equal(lockedStatus.body.allowance.totalUsed, 11);
          assert.equal(lockedStatus.body.allowance.sessionMax, 6);
          assert.equal(lockedStatus.body.allowance.sessionUsed, 1);
          assert.equal(lockedStatus.body.allowance.sessionRemaining, 5);
        } finally {
          service3.close();
          server3.close();
        }

        // Persist an unfinalized active reservation and verify one-active concurrency under 100/6
        const ledgerBusy = new ReservationLedger(ledgerPath, 100, 6);
        const reqBodyBusy = JSON.stringify({ test: "active-concurrency" });
        await ledgerBusy.reserve({
          idempotencyKey: "active_restart_00000001",
          bodySha256: createHash("sha256").update(reqBodyBusy).digest("hex"),
          sessionId: busyIdentity,
          basisRevision: 1,
          basisDigest: createHash("sha256").update("basis-busy").digest("hex"),
          requestBody: reqBodyBusy,
        });

        const service4 = new WorkspaceService();
        const server4 = createServer(service4);
        await new Promise<void>((resolve) => server4.listen(0, "127.0.0.1", resolve));
        const addr4 = server4.address() as any;

        try {
          const busyStatus = await request("127.0.0.1", addr4.port, "GET", "/api/live/status", {
            cookie: `bk_identity=${identityB}`,
            hostHeader: `127.0.0.1:${addr4.port}`,
          });
          assert.equal(busyStatus.status, 200);
          assert.equal(busyStatus.body.status, "busy");
          assert.equal(busyStatus.body.active, true);
          assert.equal(busyStatus.body.allowance.activeConcurrent, 1);
          assert.equal(busyStatus.body.allowance.totalMax, 100);
          assert.equal(busyStatus.body.allowance.totalUsed, 12);
          assert.equal(busyStatus.body.allowance.sessionMax, 6);
        } finally {
          service4.close();
          server4.close();
        }
      }
    );
  });

  test("createServer preserves explicitly injected controller and ignores request limit parameters", async () => {
    await withEnv(
      {
        BLACKOUT_MAX_TOTAL_ATTEMPTS: "100",
        BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
      },
      async () => {
        const client = new HostedReviewClient({
          clientId: "test_client_id",
          clientSecret: "test_client_secret",
          ledgerPath,
          fetch: async () => new Response("Not found", { status: 404 }),
        });
        await client.init();
        const injectedController = new HostedController({ client });
        const service = new WorkspaceService(injectedController);
        const server = createServer(service, injectedController);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as any;

        try {
          const res = await request(
            "127.0.0.1",
            addr.port,
            "GET",
            "/api/live/status?maxTotalAttempts=100&maxBrowserAttempts=6",
            {
              hostHeader: `127.0.0.1:${addr.port}`,
            }
          );
          assert.equal(res.status, 200);
          assert.equal(res.body.allowance.totalMax, 10);
          assert.equal(res.body.allowance.sessionMax, 2);
        } finally {
          service.close();
          server.close();
        }
      }
    );

    // Default controller with env limits absent ignores request query params and uses 10/2 defaults
    await withEnv(
      {
        BLACKOUT_MAX_TOTAL_ATTEMPTS: undefined,
        BLACKOUT_MAX_BROWSER_ATTEMPTS: undefined,
      },
      async () => {
        const defaultService = new WorkspaceService();
        const defaultServer = createServer(defaultService);
        await new Promise<void>((resolve) => defaultServer.listen(0, "127.0.0.1", resolve));
        const addr = defaultServer.address() as any;

        try {
          const res = await request(
            "127.0.0.1",
            addr.port,
            "GET",
            "/api/live/status?maxTotalAttempts=100&maxBrowserAttempts=6",
            {
              hostHeader: `127.0.0.1:${addr.port}`,
            }
          );
          assert.equal(res.status, 200);
          assert.equal(res.body.allowance.totalMax, 10);
          assert.equal(res.body.allowance.sessionMax, 2);
        } finally {
          defaultService.close();
          defaultServer.close();
        }
      }
    );
  });

  test("createServer rejects invalid limit env configuration with fixed sanitized error", async () => {
    await withEnv(
      {
        BLACKOUT_MAX_TOTAL_ATTEMPTS: "4",
        BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
      },
      async () => {
        const service = new WorkspaceService();
        try {
          assert.throws(() => createServer(service), {
            message: INVALID_ATTEMPT_LIMITS_ERROR,
          });
        } finally {
          service.close();
        }
      }
    );

    await withEnv(
      {
        BLACKOUT_MAX_TOTAL_ATTEMPTS: "CANARY_INVALID_LIMIT_777",
        BLACKOUT_MAX_BROWSER_ATTEMPTS: "2",
      },
      async () => {
        const service = new WorkspaceService();
        let caught: Error | undefined;
        try {
          createServer(service);
        } catch (err) {
          caught = err as Error;
        } finally {
          service.close();
        }
        assert.ok(caught);
        assert.equal(caught.message, INVALID_ATTEMPT_LIMITS_ERROR);
        assert.ok(!caught.message.includes("CANARY_INVALID_LIMIT_777"));
      }
    );
  });
});
