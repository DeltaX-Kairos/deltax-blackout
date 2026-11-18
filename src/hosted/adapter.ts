/**
 * HostedEvaluateAdapter — legacy compatibility adapter for EvaluateAdapter.
 *
 * Wraps HostedReviewClient. Does NOT alias commercial_binding_sha256 as
 * candidate_set_digest (legacy equivalence removed).
 */

import { createHash } from "node:crypto";
import type {
  EvaluateAdapter,
  EvaluateRequest,
  EvaluateResult,
  HesTrace,
  HesGateKey,
  EvaluateCommercialReceipt,
} from "../types.js";
import { canonicalJson } from "../digest.js";
import {
  EVALUATION_PROFILE_ID,
  type HostedAdapterConfig,
  type HostedEvaluationRequest,
  type HostedCandidate,
  type HostedTrace,
  type HostedCommercialReceipt,
  type ReviewBinding,
} from "./types.js";
import { HostedReviewClient } from "./client.js";
import type { ReservationLedger } from "./ledger.js";
import type { OAuthClient } from "./oauth.js";

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export class HostedEvaluateAdapter implements EvaluateAdapter {
  private readonly _client: HostedReviewClient;
  private readonly _config: HostedAdapterConfig;

  constructor(config: HostedAdapterConfig) {
    this._config = Object.freeze({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetch: config.fetch,
      ledgerPath: config.ledgerPath,
      sessionId: config.sessionId,
      maxAttempts: config.maxAttempts,
      maxPerSession: config.maxPerSession,
      timeoutMs: config.timeoutMs,
    });
    this._client = new HostedReviewClient({
      clientId: this._config.clientId,
      clientSecret: this._config.clientSecret,
      fetch: this._config.fetch,
      ledgerPath: this._config.ledgerPath,
      maxAttempts: this._config.maxAttempts,
      maxPerSession: this._config.maxPerSession,
      timeoutMs: this._config.timeoutMs,
    });
  }

  async init(): Promise<void> {
    await this._client.init();
  }

  async evaluate(request: EvaluateRequest): Promise<EvaluateResult> {
    const candidates: HostedCandidate[] = request.candidates.map((c) => ({
      candidate_id: c.candidate_id,
      semantic_class: c.semantic_class,
      description: c.description,
      operator_reported_support: c.operator_reported_support,
    }));

    const evalRequest: HostedEvaluationRequest = {
      profile_id: EVALUATION_PROFILE_ID,
      objective: request.objective,
      context: request.context,
      candidates,
    };

    // Precompute candidate payload hashes
    const candidatePayloadHashes: Record<string, string> = {};
    for (const c of candidates) {
      candidatePayloadHashes[c.candidate_id] = createHash("sha256")
        .update(canonicalJson(c), "utf8")
        .digest("hex");
    }

    const canonicalBody = canonicalJson(evalRequest);
    const bodySha256 = createHash("sha256").update(canonicalBody, "utf8").digest("hex");

    const rawIdempotencyKey = request.context["idempotency_key"];
    const idempotencyKey =
      typeof rawIdempotencyKey === "string" && IDEMPOTENCY_KEY_REGEX.test(rawIdempotencyKey)
        ? rawIdempotencyKey
        : `bk-eval-${bodySha256.slice(0, 24)}`;

    const rawSessionId = request.context["session_id"];
    const sessionId =
      this._config.sessionId ??
      (typeof rawSessionId === "string" && SESSION_ID_REGEX.test(rawSessionId) && rawSessionId.length > 0
        ? rawSessionId
        : "default-session");

    const rawRev = request.context["observation_revision"];
    const basisRevision =
      typeof rawRev === "number" && Number.isInteger(rawRev) && rawRev >= 1
        ? rawRev
        : 1;

    const rawDigest = request.context["observation_digest"];
    const basisDigest =
      typeof rawDigest === "string" && SHA256_HEX_REGEX.test(rawDigest)
        ? rawDigest
        : "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const binding: ReviewBinding = {
      idempotencyKey,
      sessionId,
      basisRevision,
      basisDigest,
      candidatePayloadHashes,
    };

    const reviewResult = await this._client.evaluate(evalRequest, binding);

    if (reviewResult.status === "completed") {
      const hesTrace = convertToHesTrace(reviewResult.envelope.result.trace);
      const receipt = convertToEvaluateReceipt(
        reviewResult.envelope.result.commercial_receipt,
        request
      );

      return {
        status: "selected",
        candidate_id: reviewResult.selectedCandidateId,
        trace: hesTrace,
        commercial_receipt: receipt,
      };
    }

    if (reviewResult.status === "refused") {
      const hesTrace = convertToHesTrace(reviewResult.envelope.result.trace);
      const receipt = convertToEvaluateReceipt(
        reviewResult.envelope.result.commercial_receipt,
        request
      );

      return {
        status: "governed_noop_refusal",
        trace: hesTrace,
        commercial_receipt: receipt,
      };
    }

    if (reviewResult.status === "unknown") {
      return {
        status: "error",
        detail: `unknown outcome: ${reviewResult.detail}`,
      };
    }

    // rejected or disabled
    return {
      status: "error",
      detail: reviewResult.detail,
    };
  }

  get ledger(): ReservationLedger {
    return this._client.ledger;
  }

  get oauth(): OAuthClient {
    return this._client.oauth;
  }

  get isDisabled(): boolean {
    return this._client.isDisabled;
  }
}

function convertToHesTrace(trace: HostedTrace): HesTrace {
  const decisions = trace.lambda_decisions.map((d) => ({
    gate: d.gate_id as HesGateKey,
    assertion: d.reason_code,
    value: d.disposition === "pass",
  })) as HesTrace["lambda_decisions"];
  return { lambda_decisions: decisions };
}

function convertToEvaluateReceipt(
  cr: HostedCommercialReceipt,
  req: EvaluateRequest
): EvaluateCommercialReceipt {
  return {
    receipt_id: cr.receipt_id,
    scenario_id: String(req.context["scenario_id"] ?? "queue-storm"),
    revision: Number(req.context["observation_revision"] ?? 1),
    basis_digest: String(req.context["observation_digest"] ?? ""),
    candidate_set_digest: "", // Misleading commercial hash equivalence removed
    is_execution_authorization: false,
    is_safety_certification: false,
    is_correctness_assurance: false,
    is_downstream_authority: false,
    is_professional_advice: false,
  };
}
