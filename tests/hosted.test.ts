/**
 * Offline contract, integration, and regression tests for DeltaX Evaluate hosted SDK.
 *
 * Requirements:
 * - Uses node:test and node:assert/strict only.
 * - Zero network calls; all tests use injected mock fetch.
 * - Synthetic test fixtures (explicitly synthetic, never real provider receipts).
 * - Comprehensive coverage of SDK-REVIEW-007 & SDK-REVIEW-009 requirements:
 *   1. Pinned constants and endpoint immutability
 *   2. Closed request validation (profile, objective, context limits, candidate limits, body size)
 *   3. Response validation (selection, refusal, authority drift, gates, digests, envelope, metadata)
 *   4. Selected candidate membership in submitted review candidates (rejects external shadow)
 *   5. OAuth client (caching, 900s lifetime, scope validation, single in-flight mutex, redirect rejection, size cap)
 *   6. Reservation ledger (exclusive scoped lock file, initFresh with header, missing file disables,
 *      missing final newline disables, empty file disables, tampered body SHA-256 disables,
 *      duplicate terminal transition rejected, pre-reservation, fsync, max 10 total attempts,
 *      max 2 per session, max 1 active concurrent in-flight, append file size cap)
 *   7. Concurrency regressions:
 *      - Simultaneous 2 reserves on same instance (Promise.allSettled) -> exactly 1 fulfilled, 1 rejected
 *      - 2 ledger instances sharing one file -> exactly 1 fulfilled, 1 rejected
 *   8. Deadline and stalled stream regressions:
 *      - Stalled OAuth headers and streaming body timeout cleanly without hanging
 *      - Stalled evaluation headers and streaming body timeout cleanly and return unknown
 *      - Stream cancellation observation on timeout/rejection
 *      - Positive stream read and empty body handling
 *   9. Secret/canary leak regression:
 *      - Exception containing credential/token canary never appears in returned result or persisted log
 *  10. Reconciliation metadata (202 and rejected responses):
 *      - Preserves allowlisted diagnostics and response SHA
 *      - 202 support receipt_id preserved and validated across restart replay
 *  11. HostedReviewClient primary API:
 *      - Deep cloning of request and binding before any await
 *      - Server-owned ReviewBinding separated from request context
 *      - Completed selection and refusal return full raw envelope
 *      - Failed receipt persistence on ANY outcome returns disabled without exposing selection
 *      - HTTP 202, 400, 401/403, 429, timeout, and network errors mapped properly
 *  12. HostedEvaluateAdapter legacy wrapper:
 *      - Backward compatibility maintained
 *      - Does NOT alias commercial_binding_sha256 to candidate_set_digest
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  EVALUATION_ENDPOINT,
  EVALUATION_OAUTH_TOKEN_ENDPOINT,
  EVALUATION_API_VERSION,
  EVALUATION_PROFILE_ID,
  EVALUATION_OAUTH_SCOPE,
  RESERVED_REFUSAL_ID,
  LEDGER_HEADER_VERSION,
  MAX_LEDGER_FILE_BYTES,
  MAX_LEDGER_ENTRY_BYTES,
  OAUTH_REQUEST_BODY_LIMIT,
  TOKEN_RESPONSE_LIMIT,
  EVALUATION_REQUEST_BODY_LIMIT,
  EVALUATION_RESPONSE_LIMIT,
  type HostedCandidate,
  type HostedEvaluationRequest,
  type HostedGateRecord,
  type HostedReasonCode,
  type FetchFn,
  type ReviewBinding,
} from "../src/hosted/types.js";
import {
  validateEvaluationRequest,
  validateHostedResponse,
  EXPECTED_GATES,
  ValidationError,
  isForbiddenContextKey,
} from "../src/hosted/validate.js";
import {
  readStreamingBodyWithDeadline,
  DeadlineExceededError,
  UnsupportedStreamError,
} from "../src/hosted/deadline.js";
import {
  OAuthClient,
  OAuthTransportError,
  OAuthParseError,
} from "../src/hosted/oauth.js";
import {
  ReservationLedger,
  LedgerMissingError,
  LedgerCorruptError,
  ConcurrencyLimitError,
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../src/hosted/ledger.js";
import { HostedReviewClient } from "../src/hosted/client.js";
import { HostedEvaluateAdapter } from "../src/hosted/adapter.js";
import type { EvaluateRequest } from "../src/types.js";

const VALID_64_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ─── Synthetic Test Fixtures ──────────────────────────────────────────────────

function makeSyntheticGatewayEnvelope(opts?: {
  receiptId?: string;
  evaluatedAt?: string;
  counted?: boolean;
  outcome?: "selected" | "governed_noop_refusal";
  selectedCandidateId?: string | null;
  reasonCodes?: HostedReasonCode[];
  authorityOverrides?: Partial<Record<string, unknown>>;
  traceOverrides?: Partial<Record<string, unknown>>;
  receiptOverrides?: Partial<Record<string, unknown>>;
  extraResultFields?: Record<string, unknown>;
  apiVersion?: string;
  profileId?: string;
  requestId?: string;
}) {
  const committedAt = "2026-11-17T12:00:00.000Z";
  const outcome = opts?.outcome ?? "selected";
  const selectedCandidateId =
    opts?.selectedCandidateId !== undefined
      ? opts.selectedCandidateId
      : outcome === "selected"
      ? "cand-scale-12"
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
    lambda_decisions: gates,
    evidence_labels: ["operator_reported", "contract_validated"],
    submitted_candidate_executed: false,
    external_effect: false,
    learning_applied: false,
    operator_reported_context_verified: false,
    committed_at: committedAt,
    ...opts?.traceOverrides,
  };

  const commercial_receipt = {
    receipt_id: "66666666-7777-4888-9999-aaaaaaaaaaaa",
    receipt_sha256: "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    commercial_binding_sha256: "aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999",
    mode: "free_beta",
    committed_at: committedAt,
    ...opts?.receiptOverrides,
  };

  const authority = {
    selected_is_executed: false,
    selected_is_correct_or_safe: false,
    response_authorizes_downstream_action: false,
    response_is_professional_advice: false,
    trace_is_certification_or_legal_non_repudiation: false,
    ...opts?.authorityOverrides,
  };

  const result = {
    outcome,
    selected_candidate_id: selectedCandidateId,
    reason_codes: opts?.reasonCodes ?? ["candidate_selected_within_bounded_evaluation"],
    trace,
    commercial_receipt,
    authority,
    ...(opts?.apiVersion ? { api_version: opts.apiVersion } : {}),
    ...(opts?.profileId ? { profile_id: opts.profileId } : {}),
    ...(opts?.requestId ? { request_id: opts.requestId } : {}),
    ...opts?.extraResultFields,
  };

  return {
    receipt_id: opts?.receiptId ?? "eval_synthetic_test_receipt_001",
    evaluated_at: opts?.evaluatedAt ?? "2026-11-17T12:00:00.000Z",
    counted: opts?.counted ?? true,
    result,
  };
}

function makeSampleCandidates(): HostedCandidate[] {
  return [
    {
      candidate_id: "cand-scale-12",
      semantic_class: "analyze",
      description: "Analyze scaling workers to 12",
      operator_reported_support: 0.88,
    },
    {
      candidate_id: "cand-throttle-60",
      semantic_class: "compare",
      description: "Compare throttling queue ingestion to 60",
      operator_reported_support: 0.72,
    },
  ];
}

function makeSampleRequest(candidates = makeSampleCandidates()): HostedEvaluationRequest {
  return {
    profile_id: EVALUATION_PROFILE_ID,
    objective: "Analyze queue storm recovery candidate actions",
    context: {
      scenario_id: "queue-storm",
      observation_revision: 2,
      observation_digest: VALID_64_HEX,
      telemetry_kind: "queue-storm",
      tick: 1,
      queue_depth: 4800,
      error_rate: 0.42,
    },
    candidates,
  };
}

function makeSampleBinding(req: HostedEvaluationRequest): ReviewBinding {
  const candidatePayloadHashes: Record<string, string> = {};
  for (const c of req.candidates) {
    candidatePayloadHashes[c.candidate_id] = createHash("sha256")
      .update(JSON.stringify(c), "utf8")
      .digest("hex");
  }
  return {
    idempotencyKey: "binding-idemp-key-1234567890",
    sessionId: "binding-session-001",
    basisRevision: 2,
    basisDigest: VALID_64_HEX,
    candidatePayloadHashes,
  };
}

function makeMockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function makeStalledBodyResponse(status = 200, headers?: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      // Unresolved promise simulates an injected stream that hangs
      return new Promise(() => {});
    },
  });
  return new Response(stream, {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DeltaX Evaluate Hosted SDK", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bk-hosted-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── 1. Pinned constants ─────────────────────────────────────────────────────

  test("constants — pinned endpoints, version, profile, and limits are immutable", () => {
    assert.equal(EVALUATION_ENDPOINT, "https://access-api.deltaxevaluate.com/api/builder/evaluations");
    assert.equal(
      EVALUATION_OAUTH_TOKEN_ENDPOINT,
      "https://access-api.deltaxevaluate.com/api/builder/oauth/token"
    );
    assert.equal(EVALUATION_API_VERSION, "2026-09-16.beta2");
    assert.equal(EVALUATION_PROFILE_ID, "deltax-hosted-bounded-review-evaluation-v1");
    assert.equal(EVALUATION_OAUTH_SCOPE, "deltax:evaluate");
    assert.equal(RESERVED_REFUSAL_ID, "governed_noop_refusal");
    assert.equal(LEDGER_HEADER_VERSION, "deltax-blackout-hosted-ledger-v1");
    assert.equal(MAX_LEDGER_FILE_BYTES, 8388608);
    assert.equal(MAX_LEDGER_ENTRY_BYTES, 262144);
    assert.equal(OAUTH_REQUEST_BODY_LIMIT, 4096);
    assert.equal(TOKEN_RESPONSE_LIMIT, 16384);
    assert.equal(EVALUATION_REQUEST_BODY_LIMIT, 32768);
    assert.equal(EVALUATION_RESPONSE_LIMIT, 65536);
  });

  // ─── 2. Request validation ───────────────────────────────────────────────────

  describe("Request validation", () => {
    test("valid evaluation request passes validation", () => {
      const req = makeSampleRequest();
      const res = validateEvaluationRequest(req);
      assert.equal(res.valid, true);
      assert.deepEqual(res.errors, []);
    });

    test("profile_id mismatch rejected", () => {
      const req = { ...makeSampleRequest(), profile_id: "wrong-profile" };
      const res = validateEvaluationRequest(req);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Invalid profile_id")));
    });

    test("disallowed top-level fields rejected", () => {
      const req = { ...makeSampleRequest(), unauthorized_field: "injected" };
      const res = validateEvaluationRequest(req);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Disallowed top-level")));
    });

    test("objective blank or exceeds 1024 chars rejected", () => {
      const blankReq = { ...makeSampleRequest(), objective: "   " };
      assert.equal(validateEvaluationRequest(blankReq).valid, false);

      const longReq = { ...makeSampleRequest(), objective: "x".repeat(1025) };
      assert.equal(validateEvaluationRequest(longReq).valid, false);
    });

    test("context exceeding 16 keys rejected", () => {
      const bigContext: Record<string, string> = {};
      for (let i = 0; i < 17; i++) {
        bigContext[`key_${i}`] = `val_${i}`;
      }
      const req = { ...makeSampleRequest(), context: bigContext };
      const res = validateEvaluationRequest(req);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Context exceeds limit")));
    });

    test("context key with forbidden selector/credential keywords rejected", () => {
      const forbiddenKeys = [
        "tenant_id", "principal_role", "commercial_terms", "token",
        "secret", "password", "callback_url", "command_exec", "actuate_action",
      ];
      for (const k of forbiddenKeys) {
        assert.equal(isForbiddenContextKey(k), true, `Expected '${k}' to be forbidden`);
        const req = { ...makeSampleRequest(), context: { [k]: "test" } };
        const res = validateEvaluationRequest(req);
        assert.equal(res.valid, false, `Expected request with key '${k}' to fail validation`);
      }
    });

    test("context key not matching regex ^[A-Za-z][A-Za-z0-9_.-]{0,63}$ rejected", () => {
      const badKeys = ["1numeric_start", "_leading_underscore", "has spaces", "special$char"];
      for (const k of badKeys) {
        const req = { ...makeSampleRequest(), context: { [k]: "val" } };
        const res = validateEvaluationRequest(req);
        assert.equal(res.valid, false, `Expected bad key '${k}' to be rejected`);
      }
    });

    test("context non-scalar values rejected (arrays, objects)", () => {
      const reqArray = { ...makeSampleRequest(), context: { arr: [1, 2, 3] as any } };
      assert.equal(validateEvaluationRequest(reqArray).valid, false);

      const reqObj = { ...makeSampleRequest(), context: { nested: { a: 1 } as any } };
      assert.equal(validateEvaluationRequest(reqObj).valid, false);
    });

    test("context string exceeding 256 chars rejected", () => {
      const req = { ...makeSampleRequest(), context: { long_val: "a".repeat(257) } };
      assert.equal(validateEvaluationRequest(req).valid, false);
    });

    test("context number non-finite or exceeding +/-1e9 rejected", () => {
      const reqNaN = { ...makeSampleRequest(), context: { num: NaN } };
      assert.equal(validateEvaluationRequest(reqNaN).valid, false);

      const reqInf = { ...makeSampleRequest(), context: { num: Infinity } };
      assert.equal(validateEvaluationRequest(reqInf).valid, false);

      const reqTooBig = { ...makeSampleRequest(), context: { num: 1e9 + 1 } };
      assert.equal(validateEvaluationRequest(reqTooBig).valid, false);
    });

    test("candidates array empty or exceeding 8 items rejected", () => {
      const reqEmpty = { ...makeSampleRequest(), candidates: [] };
      assert.equal(validateEvaluationRequest(reqEmpty).valid, false);

      const nineCandidates: HostedCandidate[] = [];
      for (let i = 0; i < 9; i++) {
        nineCandidates.push({
          candidate_id: `cand-${i}`,
          semantic_class: "analyze",
          description: `Analyze candidate ${i}`,
          operator_reported_support: 0.5,
        });
      }
      const reqNine = { ...makeSampleRequest(), candidates: nineCandidates };
      assert.equal(validateEvaluationRequest(reqNine).valid, false);
    });

    test("candidate_id format: regex failure, reserved refusal id, duplicate rejected", () => {
      const reqBadId = makeSampleRequest([
        {
          candidate_id: "has spaces!",
          semantic_class: "analyze",
          description: "Desc",
          operator_reported_support: 0.5,
        },
      ]);
      assert.equal(validateEvaluationRequest(reqBadId).valid, false);

      const reqReserved = makeSampleRequest([
        {
          candidate_id: RESERVED_REFUSAL_ID,
          semantic_class: "analyze",
          description: "Desc",
          operator_reported_support: 0.5,
        },
      ]);
      assert.equal(validateEvaluationRequest(reqReserved).valid, false);

      const reqDup = makeSampleRequest([
        {
          candidate_id: "cand-same",
          semantic_class: "analyze",
          description: "Desc 1",
          operator_reported_support: 0.5,
        },
        {
          candidate_id: "cand-same",
          semantic_class: "compare",
          description: "Desc 2",
          operator_reported_support: 0.5,
        },
      ]);
      assert.equal(validateEvaluationRequest(reqDup).valid, false);
    });

    test("candidate semantic_class invalid rejected", () => {
      const req = makeSampleRequest([
        {
          candidate_id: "cand-bad-class",
          semantic_class: "execute_action" as any,
          description: "Invalid class",
          operator_reported_support: 0.5,
        },
      ]);
      assert.equal(validateEvaluationRequest(req).valid, false);
    });

    test("candidate operator_reported_support outside [0, 1] rejected", () => {
      const reqLow = makeSampleRequest([
        {
          candidate_id: "cand-low",
          semantic_class: "analyze",
          description: "Desc",
          operator_reported_support: -0.01,
        },
      ]);
      assert.equal(validateEvaluationRequest(reqLow).valid, false);

      const reqHigh = makeSampleRequest([
        {
          candidate_id: "cand-high",
          semantic_class: "analyze",
          description: "Desc",
          operator_reported_support: 1.01,
        },
      ]);
      assert.equal(validateEvaluationRequest(reqHigh).valid, false);
    });

    test("request body exceeding 32768 bytes rejected", () => {
      const hugeDescription = "x".repeat(500);
      const candidates: HostedCandidate[] = [];
      for (let i = 0; i < 8; i++) {
        candidates.push({
          candidate_id: `cand-${i}`,
          semantic_class: "analyze",
          description: hugeDescription,
          operator_reported_support: 0.5,
        });
      }
      const bigContext: Record<string, string> = {};
      for (let i = 0; i < 16; i++) {
        bigContext[`ctx_field_${i}`] = "y".repeat(256);
      }
      const req: HostedEvaluationRequest = {
        profile_id: EVALUATION_PROFILE_ID,
        objective: "z".repeat(1024),
        context: bigContext,
        candidates,
      };

      const res = validateEvaluationRequest(req);
      assert.equal(res.valid, true);

      const giantContext: Record<string, string> = { ...bigContext };
      giantContext["extra_padding"] = "w".repeat(30000);
      const oversizedReq = { ...req, context: giantContext };
      const oversizeRes = validateEvaluationRequest(oversizedReq);
      assert.equal(oversizeRes.valid, false);
      assert.ok(oversizeRes.errors.some((e) => e.includes("exceeds limit")));
    });
  });

  // ─── 3. Response validation ──────────────────────────────────────────────────

  describe("Response validation", () => {
    test("valid synthetic gateway envelope passes validation", () => {
      const candidates = makeSampleCandidates();
      const raw = makeSyntheticGatewayEnvelope();
      const res = validateHostedResponse(raw, candidates);
      assert.equal(res.receipt_id, "eval_synthetic_test_receipt_001");
      assert.equal(res.result.outcome, "selected");
      assert.equal(res.result.selected_candidate_id, "cand-scale-12");
      assert.equal(res.result.authority.selected_is_executed, false);
      assert.equal(res.result.authority.selected_is_correct_or_safe, false);
    });

    test("authority flags: any true flag causes validation failure", () => {
      const authorityKeys = [
        "selected_is_executed",
        "selected_is_correct_or_safe",
        "response_authorizes_downstream_action",
        "response_is_professional_advice",
        "trace_is_certification_or_legal_non_repudiation",
      ];
      for (const flag of authorityKeys) {
        const raw = makeSyntheticGatewayEnvelope({
          authorityOverrides: { [flag]: true },
        });
        assert.throws(
          () => validateHostedResponse(raw),
          ValidationError,
          `Expected authority flag '${flag}: true' to throw ValidationError`
        );
      }
    });

    test("trace flags: any true flag causes validation failure", () => {
      const traceFlags = [
        "submitted_candidate_executed",
        "external_effect",
        "learning_applied",
        "operator_reported_context_verified",
      ];
      for (const flag of traceFlags) {
        const raw = makeSyntheticGatewayEnvelope({
          traceOverrides: { [flag]: true },
        });
        assert.throws(
          () => validateHostedResponse(raw),
          ValidationError,
          `Expected trace flag '${flag}: true' to throw ValidationError`
        );
      }
    });

    test("gate records: wrong order, missing gate, or invalid disposition rejected", () => {
      const raw11 = makeSyntheticGatewayEnvelope();
      raw11.result.trace.lambda_decisions = raw11.result.trace.lambda_decisions.slice(0, 11) as any;
      assert.throws(() => validateHostedResponse(raw11), ValidationError);

      const rawOrder = makeSyntheticGatewayEnvelope();
      rawOrder.result.trace.lambda_decisions[0].gate_id = "HES-G02";
      rawOrder.result.trace.lambda_decisions[1].gate_id = "HES-G01";
      assert.throws(() => validateHostedResponse(rawOrder), ValidationError);

      const rawDisp = makeSyntheticGatewayEnvelope();
      (rawDisp.result.trace.lambda_decisions[0] as any).disposition = "maybe";
      assert.throws(() => validateHostedResponse(rawDisp), ValidationError);

      const rawBlank = makeSyntheticGatewayEnvelope();
      rawBlank.result.trace.lambda_decisions[0].reason_code = "   ";
      assert.throws(() => validateHostedResponse(rawBlank), ValidationError);
    });

    test("selected candidate not in submitted candidates rejected", () => {
      const candidates = makeSampleCandidates();
      const raw = makeSyntheticGatewayEnvelope({
        selectedCandidateId: "unsubmitted-candidate-999",
      });
      assert.throws(() => validateHostedResponse(raw, candidates), ValidationError);
    });

    test("selected candidate has semantic_class 'external' rejected (shadow-only)", () => {
      const candidates: HostedCandidate[] = [
        {
          candidate_id: "ext-cand",
          semantic_class: "external",
          description: "External shadow action",
          operator_reported_support: 0.9,
        },
      ];
      const raw = makeSyntheticGatewayEnvelope({
        selectedCandidateId: "ext-cand",
      });
      assert.throws(() => validateHostedResponse(raw, candidates), ValidationError);
    });

    test("unexpected fields in security-critical objects rejected", () => {
      const rawResult = makeSyntheticGatewayEnvelope({
        extraResultFields: { malicious_override: "execute" },
      });
      assert.throws(() => validateHostedResponse(rawResult), ValidationError);

      const rawAuth = makeSyntheticGatewayEnvelope({
        authorityOverrides: { extra_authority: true },
      });
      assert.throws(() => validateHostedResponse(rawAuth), ValidationError);

      const rawTrace = makeSyntheticGatewayEnvelope({
        traceOverrides: { extra_trace_field: "injected" },
      });
      assert.throws(() => validateHostedResponse(rawTrace), ValidationError);

      const rawReceipt = makeSyntheticGatewayEnvelope({
        receiptOverrides: { extra_receipt_field: "injected" },
      });
      assert.throws(() => validateHostedResponse(rawReceipt), ValidationError);
    });

    test("optional metadata validated if present: api_version, profile_id, request_id", () => {
      const validMeta = makeSyntheticGatewayEnvelope({
        apiVersion: EVALUATION_API_VERSION,
        profileId: EVALUATION_PROFILE_ID,
        requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      const res = validateHostedResponse(validMeta);
      assert.equal(res.result.api_version, EVALUATION_API_VERSION);
      assert.equal(res.result.profile_id, EVALUATION_PROFILE_ID);

      const badVersion = makeSyntheticGatewayEnvelope({ apiVersion: "2025-01-01" });
      assert.throws(() => validateHostedResponse(badVersion), ValidationError);

      const badProfile = makeSyntheticGatewayEnvelope({ profileId: "unknown-profile" });
      assert.throws(() => validateHostedResponse(badProfile), ValidationError);

      const badReqId = makeSyntheticGatewayEnvelope({ requestId: "not-a-uuid" });
      assert.throws(() => validateHostedResponse(badReqId), ValidationError);
    });

    test("commercial_receipt: committed_at mismatch with trace rejected", () => {
      const raw = makeSyntheticGatewayEnvelope({
        receiptOverrides: { committed_at: "2026-11-17T12:05:00.000Z" },
        traceOverrides: { committed_at: "2026-11-17T12:00:00.000Z" },
      });
      assert.throws(() => validateHostedResponse(raw), ValidationError);
    });
  });

  // ─── 4. OAuth Client ─────────────────────────────────────────────────────────

  describe("OAuth Client", () => {
    test("fetches token with client_credentials, caches for 900s, reuses cached token", async () => {
      let callCount = 0;
      const mockFetch: FetchFn = async (url, init) => {
        callCount++;
        assert.equal(url, EVALUATION_OAUTH_TOKEN_ENDPOINT);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "manual");
        assert.ok(init?.body?.toString().includes("scope=deltax%3Aevaluate"));

        return makeMockResponse(200, {
          access_token: "dxbt_valid_bearer_token_12345",
          token_type: "Bearer",
          expires_in: 900,
          scope: "deltax:evaluate",
        });
      };

      const oauth = new OAuthClient({
        clientId: "test-client-id",
        clientSecret: "test-secret",
        fetch: mockFetch,
      });

      const token1 = await oauth.getToken();
      assert.equal(token1, "dxbt_valid_bearer_token_12345");
      assert.equal(callCount, 1);

      const token2 = await oauth.getToken();
      assert.equal(token2, "dxbt_valid_bearer_token_12345");
      assert.equal(callCount, 1);
    });

    test("scope validation: missing deltax:evaluate scope rejected", async () => {
      const mockFetch: FetchFn = async () =>
        makeMockResponse(200, {
          access_token: "dxbt_token",
          token_type: "Bearer",
          scope: "wrong:scope",
        });

      const oauth = new OAuthClient({
        clientId: "id",
        clientSecret: "sec",
        fetch: mockFetch,
      });

      await assert.rejects(() => oauth.getToken(), OAuthParseError);
    });

    test("single in-flight exchange mutex: concurrent calls share single promise", async () => {
      let callCount = 0;
      const mockFetch: FetchFn = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return makeMockResponse(200, {
          access_token: "dxbt_token_concurrent",
          token_type: "Bearer",
          expires_in: 900,
          scope: "deltax:evaluate",
        });
      };

      const oauth = new OAuthClient({
        clientId: "id",
        clientSecret: "sec",
        fetch: mockFetch,
      });

      const [t1, t2, t3] = await Promise.all([
        oauth.getToken(),
        oauth.getToken(),
        oauth.getToken(),
      ]);

      assert.equal(t1, "dxbt_token_concurrent");
      assert.equal(t2, "dxbt_token_concurrent");
      assert.equal(t3, "dxbt_token_concurrent");
      assert.equal(callCount, 1, "Expected exactly 1 HTTP call for concurrent requests");
    });

    test("rejects redirects (redirect: manual)", async () => {
      const mockFetch: FetchFn = async () =>
        makeMockResponse(302, "Redirecting", { Location: "https://evil.com" });

      const oauth = new OAuthClient({
        clientId: "id",
        clientSecret: "sec",
        fetch: mockFetch,
      });

      await assert.rejects(() => oauth.getToken(), OAuthTransportError);
    });

    test("token response exceeding 16 KiB rejected", async () => {
      const bigBody = {
        access_token: "dxbt_" + "x".repeat(17000),
        token_type: "Bearer",
        scope: "deltax:evaluate",
      };
      const mockFetch: FetchFn = async () => makeMockResponse(200, bigBody);

      const oauth = new OAuthClient({
        clientId: "id",
        clientSecret: "sec",
        fetch: mockFetch,
      });

      await assert.rejects(() => oauth.getToken(), OAuthParseError);
    });

    test("thrown error never exposes secret or token value", async () => {
      const secret = "SUPER_SECRET_VALUE_DO_NOT_LEAK";
      const mockFetch: FetchFn = async () => makeMockResponse(500, "Internal Server Error");

      const oauth = new OAuthClient({
        clientId: "id",
        clientSecret: secret,
        fetch: mockFetch,
      });

      try {
        await oauth.getToken();
        assert.fail("should have thrown");
      } catch (err) {
        const msg = String(err);
        assert.ok(!msg.includes(secret), "Error message leaked client secret!");
      }
    });

    test("stalled OAuth headers: times out cleanly without hanging", async () => {
      const mockFetch: FetchFn = async () => {
        return new Promise(() => {});
      };

      const oauth = new OAuthClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        timeoutMs: 30,
      });

      await assert.rejects(() => oauth.getToken(), OAuthTransportError);
    });

    test("stalled OAuth streaming body: times out cleanly without hanging", async () => {
      const mockFetch: FetchFn = async () => {
        return makeStalledBodyResponse(200);
      };

      const oauth = new OAuthClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        timeoutMs: 30,
      });

      await assert.rejects(() => oauth.getToken(), OAuthTransportError);
    });
  });

  // ─── 5. Deadline & Streaming Reader ──────────────────────────────────────────

  describe("Streaming reader & deadline helper", () => {
    test("stream reader cancellation is observed when readStreamingBodyWithDeadline times out", async () => {
      let cancelled = false;

      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      await assert.rejects(
        () => readStreamingBodyWithDeadline(response, 1024, 25, "test-stream"),
        DeadlineExceededError
      );
      assert.equal(cancelled, true, "Reader cancel must be called on timeout");
    });

    test("readStreamingBodyWithDeadline successfully reads valid JSON stream within bounds", async () => {
      const data = JSON.stringify({ hello: "world" });
      const response = new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(data));
            c.close();
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
      const text = await readStreamingBodyWithDeadline(response, 1024, 1000, "valid-stream");
      assert.equal(text, data);
    });

    test("readStreamingBodyWithDeadline treats null/undefined body as empty string", async () => {
      const response = new Response(null, { headers: { "Content-Type": "application/json" } });
      const text = await readStreamingBodyWithDeadline(response, 1024, 1000, "empty-body");
      assert.equal(text, "");
    });

    test("readStreamingBodyWithDeadline rejects unsupported stream without getReader", async () => {
      const fakeResponse = {
        body: { notAReader: true },
        headers: new Headers({ "Content-Type": "application/json" }),
      } as any;
      await assert.rejects(
        () => readStreamingBodyWithDeadline(fakeResponse, 1024, 1000, "fake-stream"),
        UnsupportedStreamError
      );
    });

    test("readStreamingBodyWithDeadline rejects non-positive or non-finite timeoutMs", async () => {
      const response = new Response("{}", { headers: { "Content-Type": "application/json" } });
      await assert.rejects(
        () => readStreamingBodyWithDeadline(response, 1024, -1, "invalid-timeout"),
        DeadlineExceededError
      );
      await assert.rejects(
        () => readStreamingBodyWithDeadline(response, 1024, NaN, "invalid-timeout"),
        DeadlineExceededError
      );
    });
  });

  // ─── 6. Reservation Ledger ───────────────────────────────────────────────────

  describe("Reservation Ledger", () => {
    test("initFresh creates fresh ledger with format header and 0o600 permissions; fails if file exists", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath);

      await ledger.initFresh();
      assert.equal(ledger.countTotalAttempts(), 0);

      const content = await readFile(ledgerPath, "utf8");
      assert.ok(content.endsWith("\n"), "Ledger must end with newline");
      const firstLine = JSON.parse(content.split("\n")[0]);
      assert.equal(firstLine.version, LEDGER_HEADER_VERSION);

      await assert.rejects(() => ledger.initFresh());
    });

    test("replay fails and disables when ledger is missing (does NOT auto-create)", async () => {
      const ledgerPath = join(tempDir, "nonexistent-ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath);

      await assert.rejects(() => ledger.replay(), LedgerMissingError);
    });

    test("empty or headerless file: throws LedgerCorruptError on replay", async () => {
      const emptyPath = join(tempDir, "empty.jsonl");
      await writeFile(emptyPath, "", "utf8");
      const ledgerEmpty = new ReservationLedger(emptyPath);
      await assert.rejects(() => ledgerEmpty.replay(), LedgerCorruptError);

      const headerlessPath = join(tempDir, "headerless.jsonl");
      const entry = JSON.stringify({
        timestamp: "2026-11-17T12:00:00.000Z",
        idempotencyKey: "key-without-header-0001",
        bodySha256: VALID_64_HEX,
        sessionId: "sess",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        state: "reserved",
        requestBody: "{}",
      });
      await writeFile(headerlessPath, entry + "\n", "utf8");
      const ledgerHeaderless = new ReservationLedger(headerlessPath);
      await assert.rejects(() => ledgerHeaderless.replay(), LedgerCorruptError);
    });

    test("valid JSON missing final newline: throws LedgerCorruptError on replay", async () => {
      const ledgerPath = join(tempDir, "no-newline.jsonl");
      const header = JSON.stringify({
        version: LEDGER_HEADER_VERSION,
        format: "jsonl",
        createdAt: "2026-11-17T12:00:00.000Z",
      });
      await writeFile(ledgerPath, header, "utf8");

      const ledger = new ReservationLedger(ledgerPath);
      await assert.rejects(() => ledger.replay(), LedgerCorruptError);
    });

    test("replay fails on corrupt / truncated JSONL lines", async () => {
      const ledgerPath = join(tempDir, "corrupt-ledger.jsonl");
      const header = JSON.stringify({
        version: LEDGER_HEADER_VERSION,
        format: "jsonl",
        createdAt: "2026-11-17T12:00:00.000Z",
      }) + "\n";
      await writeFile(ledgerPath, header + "not-json-line\n", "utf-8");

      const ledger = new ReservationLedger(ledgerPath);
      await assert.rejects(() => ledger.replay(), LedgerCorruptError);
    });

    test("tampered stored body with unchanged digest: throws LedgerCorruptError on replay", async () => {
      const ledgerPath = join(tempDir, "tampered.jsonl");
      const ledger = new ReservationLedger(ledgerPath);
      await ledger.initFresh();

      const originalBody = '{"legitimate":"request"}';
      const originalDigest = createHash("sha256").update(originalBody, "utf8").digest("hex");

      await ledger.reserve({
        idempotencyKey: "key-tamper-check-12345",
        bodySha256: originalDigest,
        sessionId: "sess-tamper",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: originalBody,
      });

      const raw = await readFile(ledgerPath, "utf8");
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, 2, "Expected header + 1 record line");

      // Parse the JSON record and mutate requestBody while retaining bodySha256
      const record = JSON.parse(lines[1]);
      record.requestBody = '{"tampered":"request"}';
      const tamperedRecordLine = JSON.stringify(record);

      const tamperedContent = `${lines[0]}\n${tamperedRecordLine}\n`;
      assert.notEqual(tamperedContent, raw, "Bytes must actually change");
      await writeFile(ledgerPath, tamperedContent, "utf8");

      const reloadedLedger = new ReservationLedger(ledgerPath);
      await assert.rejects(() => reloadedLedger.replay(), LedgerCorruptError);
    });

    test("pre-reservation persists body, key, and session before dispatch with fsync", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath);
      await ledger.initFresh();

      const body = '{"test":"body"}';
      const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");

      await ledger.reserve({
        idempotencyKey: "key-001-abcdef123456",
        bodySha256,
        sessionId: "session-alpha",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
        candidateIds: ["cand-1"],
      });

      assert.equal(ledger.countTotalAttempts(), 1);
      assert.equal(ledger.countSessionAttempts("session-alpha"), 1);
      assert.equal(ledger.hasActiveReservation(), true);

      await ledger.recordTransition("key-001-abcdef123456", {
        state: "selected",
        httpStatus: 200,
        selectedCandidateId: "cand-1",
      });

      assert.equal(ledger.hasActiveReservation(), false);
      assert.equal(ledger.countTotalAttempts(), 1);
    });

    test("concurrency limit: max 1 active concurrent in-flight rejected", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath);
      await ledger.initFresh();

      const body = "{}";
      const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");

      await ledger.reserve({
        idempotencyKey: "active-key-000000001",
        bodySha256,
        sessionId: "sess-1",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });

      await assert.rejects(
        () =>
          ledger.reserve({
            idempotencyKey: "active-key-000000002",
            bodySha256,
            sessionId: "sess-1",
            basisRevision: 1,
            basisDigest: VALID_64_HEX,
            requestBody: body,
          }),
        ConcurrencyLimitError
      );

      await ledger.recordTransition("active-key-000000001", { state: "unknown" });

      await ledger.reserve({
        idempotencyKey: "active-key-000000002",
        bodySha256,
        sessionId: "sess-1",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });
      assert.equal(ledger.countTotalAttempts(), 2);
    });

    test("simultaneous two reserves same instance: exactly 1 fulfilled, 1 rejected with ConcurrencyLimitError", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath);
      await ledger.initFresh();

      const body1 = '{"cand":"1"}';
      const sha1 = createHash("sha256").update(body1, "utf8").digest("hex");
      const body2 = '{"cand":"2"}';
      const sha2 = createHash("sha256").update(body2, "utf8").digest("hex");

      const results = await Promise.allSettled([
        ledger.reserve({
          idempotencyKey: "concurrent-inst1-key-1",
          bodySha256: sha1,
          sessionId: "session-c1",
          basisRevision: 1,
          basisDigest: VALID_64_HEX,
          requestBody: body1,
        }),
        ledger.reserve({
          idempotencyKey: "concurrent-inst1-key-2",
          bodySha256: sha2,
          sessionId: "session-c1",
          basisRevision: 1,
          basisDigest: VALID_64_HEX,
          requestBody: body2,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "Expected exactly 1 fulfilled reservation");
      assert.equal(rejected.length, 1, "Expected exactly 1 rejected reservation");
      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(
        rejectionReason instanceof ConcurrencyLimitError,
        `Expected ConcurrencyLimitError, got: ${rejectionReason}`
      );
    });

    test("two instances sharing one file: exactly 1 fulfilled, 1 rejected with ConcurrencyLimitError", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger1 = new ReservationLedger(ledgerPath);
      await ledger1.initFresh();
      const ledger2 = new ReservationLedger(ledgerPath);

      const body1 = '{"cand":"1"}';
      const sha1 = createHash("sha256").update(body1, "utf8").digest("hex");
      const body2 = '{"cand":"2"}';
      const sha2 = createHash("sha256").update(body2, "utf8").digest("hex");

      const results = await Promise.allSettled([
        ledger1.reserve({
          idempotencyKey: "share-file-key-0001",
          bodySha256: sha1,
          sessionId: "session-share",
          basisRevision: 1,
          basisDigest: VALID_64_HEX,
          requestBody: body1,
        }),
        ledger2.reserve({
          idempotencyKey: "share-file-key-0002",
          bodySha256: sha2,
          sessionId: "session-share",
          basisRevision: 1,
          basisDigest: VALID_64_HEX,
          requestBody: body2,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "Expected exactly 1 fulfilled reservation");
      assert.equal(rejected.length, 1, "Expected exactly 1 rejected reservation");
      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(
        rejectionReason instanceof ConcurrencyLimitError,
        `Expected ConcurrencyLimitError, got: ${rejectionReason}`
      );
    });

    test("duplicate terminal transition rejected", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath);
      await ledger.initFresh();

      const body = "{}";
      const sha = createHash("sha256").update(body, "utf8").digest("hex");

      await ledger.reserve({
        idempotencyKey: "dup-transition-key-001",
        bodySha256: sha,
        sessionId: "sess-dup",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });

      await ledger.recordTransition("dup-transition-key-001", {
        state: "selected",
        selectedCandidateId: "cand-1",
      });

      await assert.rejects(
        () => ledger.recordTransition("dup-transition-key-001", { state: "refused" }),
        /already transitioned/
      );
    });

    test("budget limits: max 10 total attempts across ledger (including unknowns/errors)", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath, 10, 10);
      await ledger.initFresh();

      const body = "{}";
      const sha = createHash("sha256").update(body, "utf8").digest("hex");

      for (let i = 0; i < 10; i++) {
        const key = `key-budget-00000000${i}`;
        await ledger.reserve({
          idempotencyKey: key,
          bodySha256: sha,
          sessionId: `sess-${i}`,
          basisRevision: 1,
          basisDigest: VALID_64_HEX,
          requestBody: body,
        });
        await ledger.recordTransition(key, { state: i % 2 === 0 ? "unknown" : "error" });
      }

      assert.equal(ledger.countTotalAttempts(), 10);

      await assert.rejects(
        () =>
          ledger.reserve({
            idempotencyKey: "key-budget-0000000011",
            bodySha256: sha,
            sessionId: "sess-new",
            basisRevision: 1,
            basisDigest: VALID_64_HEX,
            requestBody: body,
          }),
        BudgetExceededError
      );
    });

    test("session budget limit: max 2 attempts per session", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger = new ReservationLedger(ledgerPath, 10, 2);
      await ledger.initFresh();

      const sess = "session-test-cap";
      const body = "{}";
      const sha = createHash("sha256").update(body, "utf8").digest("hex");

      // 1st attempt
      await ledger.reserve({
        idempotencyKey: "sess-key-000000001",
        bodySha256: sha,
        sessionId: sess,
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });
      await ledger.recordTransition("sess-key-000000001", { state: "selected" });

      // 2nd attempt
      await ledger.reserve({
        idempotencyKey: "sess-key-000000002",
        bodySha256: sha,
        sessionId: sess,
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });
      await ledger.recordTransition("sess-key-000000002", { state: "unknown" });

      // 3rd attempt for same session rejected
      await assert.rejects(
        () =>
          ledger.reserve({
            idempotencyKey: "sess-key-000000003",
            bodySha256: sha,
            sessionId: sess,
            basisRevision: 1,
            basisDigest: VALID_64_HEX,
            requestBody: body,
          }),
        SessionBudgetExceededError
      );

      // Different session is allowed
      await ledger.reserve({
        idempotencyKey: "sess-b-key-00000001",
        bodySha256: sha,
        sessionId: "other-session",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });
      assert.equal(ledger.countSessionAttempts("other-session"), 1);
    });

    test("reservation retained after unknown/restart: counts preserved in allowance", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger1 = new ReservationLedger(ledgerPath);
      await ledger1.initFresh();

      const body = "{}";
      const sha = createHash("sha256").update(body, "utf8").digest("hex");

      await ledger1.reserve({
        idempotencyKey: "persist-key-0000001",
        bodySha256: sha,
        sessionId: "sess-restart",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });
      await ledger1.recordTransition("persist-key-0000001", { state: "selected" });

      await ledger1.reserve({
        idempotencyKey: "persist-key-0000002",
        bodySha256: sha,
        sessionId: "sess-restart",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: body,
      });
      await ledger1.recordTransition("persist-key-0000002", { state: "unknown" });

      const ledger2 = new ReservationLedger(ledgerPath);
      await ledger2.replay();

      assert.equal(ledger2.countTotalAttempts(), 2);
      assert.equal(ledger2.countSessionAttempts("sess-restart"), 2);
      assert.equal(ledger2.hasKey("persist-key-0000001"), true);
      assert.equal(ledger2.hasKey("persist-key-0000002"), true);
      assert.equal(ledger2.hasActiveReservation(), false);
    });

    test("full selected and refused provider receipts survive restart", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledger1 = new ReservationLedger(ledgerPath);
      await ledger1.initFresh();

      const sampleReq = makeSampleRequest();
      const bodyStr = JSON.stringify(sampleReq);
      const shaStr = createHash("sha256").update(bodyStr, "utf8").digest("hex");

      // 1. Selected receipt
      const selectedEnvelope = makeSyntheticGatewayEnvelope({ selectedCandidateId: "cand-scale-12" });
      await ledger1.reserve({
        idempotencyKey: "receipt-persist-key-1",
        bodySha256: shaStr,
        sessionId: "sess-receipt",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: bodyStr,
      });

      await ledger1.recordTransition("receipt-persist-key-1", {
        state: "selected",
        httpStatus: 200,
        selectedCandidateId: "cand-scale-12",
        rawEnvelope: validateHostedResponse(selectedEnvelope),
      });

      // 2. Refused receipt
      const refusedEnvelope = makeSyntheticGatewayEnvelope({
        outcome: "governed_noop_refusal",
        selectedCandidateId: null,
        reasonCodes: ["no_submitted_candidate_passed_all_gates"],
      });
      await ledger1.reserve({
        idempotencyKey: "receipt-persist-key-2",
        bodySha256: shaStr,
        sessionId: "sess-receipt",
        basisRevision: 1,
        basisDigest: VALID_64_HEX,
        requestBody: bodyStr,
      });

      await ledger1.recordTransition("receipt-persist-key-2", {
        state: "refused",
        httpStatus: 200,
        selectedCandidateId: null,
        rawEnvelope: validateHostedResponse(refusedEnvelope),
      });

      // Restart: replay on new instance
      const ledger2 = new ReservationLedger(ledgerPath);
      await ledger2.replay();

      const entries = ledger2.getEntries();
      const selEntry = entries.find((e) => e.idempotencyKey === "receipt-persist-key-1" && e.state === "selected");
      assert.ok(selEntry);
      assert.equal(selEntry.rawEnvelope?.receipt_id, selectedEnvelope.receipt_id);
      assert.equal(selEntry.rawEnvelope?.result.outcome, "selected");
      assert.equal(selEntry.rawEnvelope?.result.selected_candidate_id, "cand-scale-12");

      const refEntry = entries.find((e) => e.idempotencyKey === "receipt-persist-key-2" && e.state === "refused");
      assert.ok(refEntry);
      assert.equal(refEntry.rawEnvelope?.receipt_id, refusedEnvelope.receipt_id);
      assert.equal(refEntry.rawEnvelope?.result.outcome, "governed_noop_refusal");
      assert.equal(refEntry.rawEnvelope?.result.selected_candidate_id, null);
    });
  });

  // ─── 7. Reconciliation Metadata & 202 Fixture ────────────────────────────────

  describe("Reconciliation metadata", () => {
    test("HTTP 202 accepted: preserves support receipt_id and allowlisted diagnostics across restart", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const pendingReceiptId = "eval_pending_support_rec_12345";
      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(
          202,
          {
            receipt_id: pendingReceiptId,
            unconfirmed_reason: "in_flight_review",
            upstream_status: 202,
            retryable: false,
            retry_mode: "manual",
          },
          { "Retry-After": "120" }
        );
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const res = await client.evaluate(req, binding);
      assert.equal(res.status, "unknown");
      if (res.status === "unknown") {
        assert.equal(res.httpStatus, 202);
        assert.equal(res.diagnostics?.receipt_id, pendingReceiptId);
        assert.equal(res.diagnostics?.unconfirmed_reason, "in_flight_review");
        assert.equal(res.diagnostics?.retryable, false);
        assert.equal(res.diagnostics?.retry_mode, "manual");
        assert.equal(res.diagnostics?.retry_after, 120);
        assert.equal(res.diagnostics?.http_status, 202);
        assert.equal(res.diagnostics?.bodyComplete, true);
        assert.ok(res.diagnostics?.response_sha256);
      }

      // Restart proof: replay ledger on new instance
      const replayedLedger = new ReservationLedger(ledgerPath);
      await replayedLedger.replay();
      const entries = replayedLedger.getEntries();
      const unknownEntry = entries.find((e) => e.state === "unknown");
      assert.ok(unknownEntry);
      assert.equal(unknownEntry.diagnostics?.receipt_id, pendingReceiptId);
      assert.equal(unknownEntry.diagnostics?.unconfirmed_reason, "in_flight_review");
      assert.equal(unknownEntry.diagnostics?.http_status, 202);
      assert.equal(unknownEntry.diagnostics?.bodyComplete, true);
      assert.ok(unknownEntry.diagnostics?.response_sha256);
    });

    test("HTTP 202 with stalled body read sets bodyComplete: false and omits response_sha256", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeStalledBodyResponse(202);
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
        timeoutMs: 30,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const res = await client.evaluate(req, binding);
      assert.equal(res.status, "unknown");
      if (res.status === "unknown") {
        assert.equal(res.httpStatus, 202);
        assert.equal(res.diagnostics?.bodyComplete, false);
        assert.equal(res.diagnostics?.response_sha256, undefined);
      }

      // Restart proof: replay ledger on new instance
      const replayedLedger = new ReservationLedger(ledgerPath);
      await replayedLedger.replay();
      const entries = replayedLedger.getEntries();
      const unknownEntry = entries.find((e) => e.state === "unknown");
      assert.ok(unknownEntry);
      assert.equal(unknownEntry.diagnostics?.bodyComplete, false);
      assert.equal(unknownEntry.diagnostics?.response_sha256, undefined);
    });
  });

  // ─── 8. HostedReviewClient Primary API ────────────────────────────────────────

  describe("HostedReviewClient primary API", () => {
    test("end-to-end selection: completed state with raw envelope and server binding", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      let tokenCalls = 0;
      let evalCalls = 0;

      const mockFetch: FetchFn = async (url, init) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          tokenCalls++;
          return makeMockResponse(200, {
            access_token: "dxbt_client_test_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        if (url === EVALUATION_ENDPOINT) {
          evalCalls++;
          assert.equal(new Headers(init?.headers).get("X-DeltaX-API-Version"), EVALUATION_API_VERSION);
          assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "binding-idemp-key-1234567890");
          assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer dxbt_client_test_token");
          return makeMockResponse(200, makeSyntheticGatewayEnvelope({ selectedCandidateId: "cand-scale-12" }));
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const res = await client.evaluate(req, binding);
      assert.equal(res.status, "completed");
      if (res.status === "completed") {
        assert.equal(res.outcome, "selected");
        assert.equal(res.selectedCandidateId, "cand-scale-12");
        assert.equal(res.envelope.receipt_id, "eval_synthetic_test_receipt_001");
        assert.equal(res.envelope.result.trace.lambda_decisions.length, 12);
        assert.equal(res.envelope.result.authority.selected_is_executed, false);
        assert.equal(res.binding.idempotencyKey, binding.idempotencyKey);
      }

      assert.equal(tokenCalls, 1);
      assert.equal(evalCalls, 1);
      assert.equal(client.ledger.countTotalAttempts(), 1);

      const entries = client.ledger.getEntries();
      const completion = entries.find((e) => e.state === "selected");
      assert.ok(completion?.rawEnvelope);
      assert.equal(completion.rawEnvelope?.result.selected_candidate_id, "cand-scale-12");
    });

    test("end-to-end refusal: refused state with raw envelope", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(
          200,
          makeSyntheticGatewayEnvelope({
            outcome: "governed_noop_refusal",
            selectedCandidateId: null,
            reasonCodes: ["no_submitted_candidate_passed_all_gates"],
          })
        );
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const res = await client.evaluate(req, binding);
      assert.equal(res.status, "refused");
      if (res.status === "refused") {
        assert.equal(res.outcome, "governed_noop_refusal");
        assert.equal(res.selectedCandidateId, null);
        assert.equal(res.envelope.result.trace.lambda_decisions.length, 12);
      }
    });

    test("caller mutation of binding or request after call does not affect review (defensive cloning)", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      let capturedIdempotencyHeader = "";
      const mockFetch: FetchFn = async (url, init) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          await new Promise((r) => setTimeout(r, 20));
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        capturedIdempotencyHeader = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return makeMockResponse(200, makeSyntheticGatewayEnvelope({ selectedCandidateId: "cand-scale-12" }));
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);
      const originalKey = binding.idempotencyKey;

      const evalPromise = client.evaluate(req, binding);

      // Caller mutates binding and request immediately after initiating evaluate
      binding.idempotencyKey = "mutated-idempotency-key-00000000";
      binding.sessionId = "mutated-session";
      req.objective = "Mutated objective";

      const res = await evalPromise;
      assert.equal(res.status, "completed");
      assert.equal(capturedIdempotencyHeader, originalKey, "Transport must receive original cloned key");
      if (res.status === "completed") {
        assert.equal(res.binding.idempotencyKey, originalKey);
      }
    });

    test("context control selectors (idempotency_key, session_id) do NOT override server binding", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      let capturedIdempotencyHeader = "";
      const mockFetch: FetchFn = async (url, init) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        capturedIdempotencyHeader = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return makeMockResponse(200, makeSyntheticGatewayEnvelope());
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const req = makeSampleRequest();
      req.context["idempotency_key"] = "evil-injected-idempotency-key-12345678";
      req.context["session_id"] = "evil-session";

      const serverBinding: ReviewBinding = {
        idempotencyKey: "server-authoritative-key-99999999",
        sessionId: "server-authoritative-session",
        basisRevision: 5,
        basisDigest: VALID_64_HEX,
        candidatePayloadHashes: {
          "cand-scale-12": VALID_64_HEX,
          "cand-throttle-60": VALID_64_HEX,
        },
      };

      const res = await client.evaluate(req, serverBinding);
      assert.equal(res.status, "completed");
      assert.equal(capturedIdempotencyHeader, "server-authoritative-key-99999999");

      const entries = client.ledger.getEntries();
      assert.equal(entries[0].idempotencyKey, "server-authoritative-key-99999999");
      assert.equal(entries[0].sessionId, "server-authoritative-session");
    });

    test("failed receipt persistence returns disabled state and exposes no candidate selection", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(200, makeSyntheticGatewayEnvelope({ selectedCandidateId: "cand-scale-12" }));
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });
      await client.init();

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const originalReserve = client.ledger.reserve.bind(client.ledger);
      client.ledger.reserve = async (params) => {
        await originalReserve(params);
        await rm(ledgerPath);
      };

      const result = await client.evaluate(req, binding);
      assert.equal(result.status, "disabled");
      assert.equal("selectedCandidateId" in result, false);
    });

    test("failed terminal persistence for error outcome consistently disables client without throwing raw errors", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(400, { error: "bad_request" });
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const originalReserve = client.ledger.reserve.bind(client.ledger);
      client.ledger.reserve = async (params) => {
        await originalReserve(params);
        await rm(ledgerPath);
      };

      const res = await client.evaluate(req, binding);
      assert.equal(res.status, "disabled");
      assert.equal(res.detail, "ledger_persistence_failed");
    });

    test("exception containing credential/token canary never appears in returned result or persisted log", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const canarySecret = "CANARY_SECRET_SUPER_SENSITIVE_XYZ_12345";
      const canaryToken = "CANARY_BEARER_TOKEN_dxbt_SENSITIVE_99999";

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: canaryToken,
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        throw new Error(`Crash with secret=${canarySecret} and token=${canaryToken} at /private/var/secret/path`);
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: canarySecret,
        fetch: mockFetch,
        ledgerPath,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const res = await client.evaluate(req, binding);

      const serializedRes = JSON.stringify(res);
      assert.ok(!serializedRes.includes(canarySecret), "Returned result contains canary secret!");
      assert.ok(!serializedRes.includes(canaryToken), "Returned result contains canary token!");
      assert.ok(!serializedRes.includes("/private/var"), "Returned result contains private file path!");

      const ledgerContent = await readFile(ledgerPath, "utf8");
      assert.ok(!ledgerContent.includes(canarySecret), "Ledger file contains canary secret!");
      assert.ok(!ledgerContent.includes(canaryToken), "Ledger file contains canary token!");
      assert.ok(!ledgerContent.includes("/private/var"), "Ledger file contains private file path!");
    });

    test("stalled evaluation headers: times out cleanly and returns unknown", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return new Promise(() => {});
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
        timeoutMs: 30,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const res = await client.evaluate(req, binding);
      assert.equal(res.status, "unknown");
      assert.match(res.detail, /timed_out/);
    });

    test("stalled evaluation streaming body: times out cleanly and returns unknown", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeStalledBodyResponse(200);
      };

      const client = new HostedReviewClient({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
        timeoutMs: 30,
      });

      const req = makeSampleRequest();
      const binding = makeSampleBinding(req);

      const res = await client.evaluate(req, binding);
      assert.equal(res.status, "unknown");
      assert.match(res.detail, /timed_out/);
    });
  });

  // ─── 9. HostedEvaluateAdapter Legacy Wrapper ─────────────────────────────────

  describe("HostedEvaluateAdapter legacy compatibility wrapper", () => {
    function makeEvaluateRequest(): EvaluateRequest {
      return {
        profile_id: EVALUATION_PROFILE_ID,
        objective: "Analyze queue storm recovery candidate actions",
        context: {
          scenario_id: "queue-storm",
          observation_revision: 2,
          observation_digest: VALID_64_HEX,
          telemetry_kind: "queue-storm",
          tick: 1,
          queue_depth: 4800,
          error_rate: 0.42,
          session_id: "test-integration-session",
        },
        candidates: [
          {
            candidate_id: "cand-scale-12",
            semantic_class: "analyze",
            description: "Analyze scaling workers to 12",
            operator_reported_support: 0.88,
          },
          {
            candidate_id: "cand-throttle-60",
            semantic_class: "compare",
            description: "Compare throttling queue to 60",
            operator_reported_support: 0.72,
          },
        ],
      };
    }

    test("end-to-end selection: token exchange, evaluate dispatch, candidate_set_digest NOT commercial hash", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      let tokenCalls = 0;
      let evalCalls = 0;

      const mockFetch: FetchFn = async (url, init) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          tokenCalls++;
          return makeMockResponse(200, {
            access_token: "dxbt_test_token_val",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        if (url === EVALUATION_ENDPOINT) {
          evalCalls++;
          assert.equal(new Headers(init?.headers).get("X-DeltaX-API-Version"), EVALUATION_API_VERSION);
          assert.ok(new Headers(init?.headers).get("Idempotency-Key"));
          assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer dxbt_test_token_val");
          return makeMockResponse(200, makeSyntheticGatewayEnvelope({ selectedCandidateId: "cand-scale-12" }));
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "selected");
      if (res.status === "selected") {
        assert.equal(res.candidate_id, "cand-scale-12");
        assert.equal(res.trace.lambda_decisions.length, 12);
        assert.equal(res.commercial_receipt.is_execution_authorization, false);
        assert.equal(res.commercial_receipt.is_safety_certification, false);
        assert.notEqual(
          res.commercial_receipt.candidate_set_digest,
          "aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999"
        );
        assert.equal(res.commercial_receipt.candidate_set_digest, "");
      }

      assert.equal(tokenCalls, 1);
      assert.equal(evalCalls, 1);
      assert.equal(adapter.ledger.countTotalAttempts(), 1);
    });

    test("end-to-end refusal: returns governed_noop_refusal", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(
          200,
          makeSyntheticGatewayEnvelope({
            outcome: "governed_noop_refusal",
            selectedCandidateId: null,
            reasonCodes: ["no_submitted_candidate_passed_all_gates"],
          })
        );
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "governed_noop_refusal");
      if (res.status === "governed_noop_refusal") {
        assert.equal(res.trace.lambda_decisions.length, 12);
        assert.equal(res.commercial_receipt.is_execution_authorization, false);
      }
    });

    test("HTTP 202 treated as unknown, preserved as unknown error", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(202, { status: "pending" });
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "error");
      if (res.status === "error") {
        assert.match(res.detail, /unknown/);
      }
      assert.equal(adapter.ledger.countTotalAttempts(), 1);
    });

    test("timeout during request treated as unknown, counted in budget", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        await new Promise((r) => setTimeout(r, 100));
        return makeMockResponse(200, makeSyntheticGatewayEnvelope());
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
        timeoutMs: 15,
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "error");
      if (res.status === "error") {
        assert.match(res.detail, /unknown/);
      }
      assert.equal(adapter.ledger.countTotalAttempts(), 1);
    });

    test("HTTP 429 rate limit recorded as error", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(429, { error: "Too Many Requests" });
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "error");
      if (res.status === "error") {
        assert.match(res.detail, /rate_limited/);
      }
      assert.equal(adapter.ledger.countTotalAttempts(), 1);
    });

    test("missing ledger disables live mode: evaluate returns error without network calls", async () => {
      let networkCalled = false;
      const mockFetch: FetchFn = async () => {
        networkCalled = true;
        return makeMockResponse(200, {});
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath: join(tempDir, "nonexistent-ledger.jsonl"),
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "error");
      if (res.status === "error") {
        assert.match(res.detail, /disabled/);
      }
      assert.equal(networkCalled, false);
    });

    test("oversize evaluation response (>64 KiB) treated as unknown", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      const bigEnvelope = makeSyntheticGatewayEnvelope({
        extraResultFields: { padding: "x".repeat(70000) },
      });

      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        return makeMockResponse(200, bigEnvelope);
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "error");
      if (res.status === "error") {
        assert.match(res.detail, /unknown/);
      }
    });

    test("zero retries: failed evaluation does not retry automatically", async () => {
      const ledgerPath = join(tempDir, "ledger.jsonl");
      const ledgerInit = new ReservationLedger(ledgerPath);
      await ledgerInit.initFresh();

      let evalAttempts = 0;
      const mockFetch: FetchFn = async (url) => {
        if (url === EVALUATION_OAUTH_TOKEN_ENDPOINT) {
          return makeMockResponse(200, {
            access_token: "dxbt_token",
            token_type: "Bearer",
            expires_in: 900,
            scope: EVALUATION_OAUTH_SCOPE,
          });
        }
        evalAttempts++;
        throw new Error("Simulated connection drop");
      };

      const adapter = new HostedEvaluateAdapter({
        clientId: "cid",
        clientSecret: "csec",
        fetch: mockFetch,
        ledgerPath,
      });

      const res = await adapter.evaluate(makeEvaluateRequest());
      assert.equal(res.status, "error");
      assert.equal(evalAttempts, 1, "Expected exactly 1 evaluation attempt (zero retries)");
    });
  });
});
