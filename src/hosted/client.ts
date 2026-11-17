/**
 * HostedReviewClient — primary client for DeltaX Evaluate boundary.
 *
 * Implements evaluate(request, binding) where binding is separate server-owned metadata:
 * - Stable idempotency key (16..128 safe chars)
 * - Session/run identity (1..128 safe chars)
 * - Basis revision (integer >= 1) / digest (64-hex SHA-256)
 * - Candidate ID -> exact local proposal payload hashes (64-hex SHA-256)
 *
 * Guarantees:
 * - Request and binding are deep cloned on method entry before any await.
 * - Request context selectors (idempotency_key, session_id) NEVER override binding.
 * - Reservation persisted before network dispatch.
 * - Full validated raw envelope persisted before returning completed selection or refusal.
 * - Failed persistence step on ANY outcome consistently disables live mode with fixed code.
 * - Failed persistence CANNOT expose a usable selection.
 * - Returns discriminated union: completed | refused | unknown | rejected | disabled.
 * - Fixed error codes for policy rejections (no interpolated raw IDs).
 * - No retries, no token/secret leakage.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../digest.js";
import {
  type HostedReviewClientConfig,
  type HostedEvaluationRequest,
  type ReviewBinding,
  type ReviewResult,
} from "./types.js";
import { validateEvaluationRequest } from "./validate.js";
import { OAuthClient } from "./oauth.js";
import {
  ReservationLedger,
  ConcurrencyLimitError,
  BudgetExceededError,
  SessionBudgetExceededError,
  DuplicateIdempotencyKeyError,
  LedgerMissingError,
  LedgerCorruptError,
} from "./ledger.js";
import { dispatchEvaluation } from "./transport.js";

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export class HostedReviewClient {
  private readonly _oauth: OAuthClient;
  private readonly _ledger: ReservationLedger;
  private readonly _config: HostedReviewClientConfig;
  private _disabled = false;
  private _disabledReason: string | null = null;
  private _initialized = false;

  constructor(config: HostedReviewClientConfig) {
    this._config = Object.freeze({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetch: config.fetch,
      ledgerPath: config.ledgerPath,
      maxAttempts: config.maxAttempts,
      maxPerSession: config.maxPerSession,
      timeoutMs: config.timeoutMs,
    });
    this._oauth = new OAuthClient({
      clientId: this._config.clientId,
      clientSecret: this._config.clientSecret,
      fetch: this._config.fetch,
      timeoutMs: this._config.timeoutMs,
    });
    this._ledger = new ReservationLedger(
      this._config.ledgerPath,
      this._config.maxAttempts,
      this._config.maxPerSession
    );
  }

  /**
   * Initializes the client by replaying the ledger.
   * If missing or corrupt, disables the client.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    try {
      await this._ledger.replay();
      this._initialized = true;
    } catch {
      this._disabled = true;
      this._disabledReason = "ledger_disabled";
      this._initialized = true;
    }
  }

  /**
   * Evaluates candidate actions with explicit server-owned ReviewBinding.
   */
  async evaluate(
    request: HostedEvaluationRequest,
    binding: ReviewBinding
  ): Promise<ReviewResult> {
    // 1. Deep clone request and binding on method entry BEFORE any await
    const clonedRequest: HostedEvaluationRequest = structuredClone(request);
    const clonedBinding: ReviewBinding = structuredClone(binding);

    if (!this._initialized) {
      await this.init();
    }

    if (this._disabled) {
      return {
        status: "disabled",
        detail: "hosted_review_disabled",
        binding: clonedBinding,
      };
    }

    // Validate ReviewBinding
    const bindingError = validateReviewBinding(clonedBinding, clonedRequest);
    if (bindingError) {
      return {
        status: "rejected",
        detail: "invalid_review_binding",
        httpStatus: null,
        binding: clonedBinding,
      };
    }

    // Validate request against closed contract
    const validation = validateEvaluationRequest(clonedRequest);
    if (!validation.valid) {
      return {
        status: "rejected",
        detail: "invalid_evaluation_request",
        httpStatus: null,
        binding: clonedBinding,
      };
    }

    // Canonical JSON and SHA-256
    const canonicalBody = canonicalJson(clonedRequest);
    const bodySha256 = createHash("sha256").update(canonicalBody, "utf8").digest("hex");

    // 2. Persist immutable reservation BEFORE token exchange and HTTP dispatch
    try {
      await this._ledger.reserve({
        idempotencyKey: clonedBinding.idempotencyKey,
        bodySha256,
        sessionId: clonedBinding.sessionId,
        basisRevision: clonedBinding.basisRevision,
        basisDigest: clonedBinding.basisDigest,
        requestBody: canonicalBody,
        candidateIds: clonedRequest.candidates.map((c) => c.candidate_id),
        candidatePayloadHashes: clonedBinding.candidatePayloadHashes,
      });
    } catch (err) {
      if (err instanceof ConcurrencyLimitError) {
        return {
          status: "rejected",
          detail: "concurrency_limit_exceeded",
          httpStatus: null,
          binding: clonedBinding,
        };
      }
      if (err instanceof BudgetExceededError) {
        return {
          status: "rejected",
          detail: "budget_exceeded",
          httpStatus: null,
          binding: clonedBinding,
        };
      }
      if (err instanceof SessionBudgetExceededError) {
        return {
          status: "rejected",
          detail: "session_budget_exceeded",
          httpStatus: null,
          binding: clonedBinding,
        };
      }
      if (err instanceof DuplicateIdempotencyKeyError) {
        return {
          status: "rejected",
          detail: "duplicate_idempotency_key",
          httpStatus: null,
          binding: clonedBinding,
        };
      }
      if (err instanceof LedgerCorruptError || err instanceof LedgerMissingError) {
        this._disabled = true;
        this._disabledReason = "ledger_disabled";
        return {
          status: "disabled",
          detail: "ledger_disabled",
          binding: clonedBinding,
        };
      }
      return {
        status: "rejected",
        detail: "reservation_failed",
        httpStatus: null,
        binding: clonedBinding,
      };
    }

    // 3. Obtain OAuth bearer token
    let token: string;
    try {
      token = await this._oauth.getToken();
    } catch {
      try {
        await this._ledger.recordTransition(clonedBinding.idempotencyKey, {
          state: "error",
          detail: "oauth_token_exchange_failed",
          binding: clonedBinding,
        });
      } catch {
        this._disabled = true;
        this._disabledReason = "ledger_persistence_failed";
        return {
          status: "disabled",
          detail: "ledger_persistence_failed",
          binding: clonedBinding,
        };
      }
      return {
        status: "rejected",
        detail: "oauth_token_exchange_failed",
        httpStatus: null,
        binding: clonedBinding,
      };
    }

    // 4. Dispatch evaluation request
    const dispatch = await dispatchEvaluation({
      token,
      idempotencyKey: clonedBinding.idempotencyKey,
      requestBody: canonicalBody,
      fetch: this._config.fetch,
      timeoutMs: this._config.timeoutMs,
      submittedCandidates: clonedRequest.candidates,
    });

    // 5. Record transition and return discriminated union result
    if (dispatch.outcome === "selected" && dispatch.rawResult) {
      try {
        await this._ledger.recordTransition(clonedBinding.idempotencyKey, {
          state: "selected",
          httpStatus: dispatch.httpStatus,
          detail: "candidate_selected",
          selectedCandidateId: dispatch.rawResult.result.selected_candidate_id,
          rawEnvelope: dispatch.rawResult,
          binding: clonedBinding,
        });
      } catch {
        // Failed persistence step CANNOT expose a usable selection!
        this._disabled = true;
        this._disabledReason = "ledger_persistence_failed";
        return {
          status: "disabled",
          detail: "ledger_persistence_failed",
          binding: clonedBinding,
        };
      }

      return {
        status: "completed",
        outcome: "selected",
        selectedCandidateId: dispatch.rawResult.result.selected_candidate_id!,
        envelope: dispatch.rawResult,
        binding: clonedBinding,
      };
    }

    if (dispatch.outcome === "refused" && dispatch.rawResult) {
      try {
        await this._ledger.recordTransition(clonedBinding.idempotencyKey, {
          state: "refused",
          httpStatus: dispatch.httpStatus,
          detail: "governed_noop_refusal",
          selectedCandidateId: null,
          rawEnvelope: dispatch.rawResult,
          binding: clonedBinding,
        });
      } catch {
        this._disabled = true;
        this._disabledReason = "ledger_persistence_failed";
        return {
          status: "disabled",
          detail: "ledger_persistence_failed",
          binding: clonedBinding,
        };
      }

      return {
        status: "refused",
        outcome: "governed_noop_refusal",
        selectedCandidateId: null,
        envelope: dispatch.rawResult,
        binding: clonedBinding,
      };
    }

    if (dispatch.outcome === "unknown") {
      try {
        await this._ledger.recordTransition(clonedBinding.idempotencyKey, {
          state: "unknown",
          httpStatus: dispatch.httpStatus,
          detail: dispatch.detail,
          binding: clonedBinding,
          diagnostics: dispatch.diagnostics,
        });
      } catch {
        this._disabled = true;
        this._disabledReason = "ledger_persistence_failed";
        return {
          status: "disabled",
          detail: "ledger_persistence_failed",
          binding: clonedBinding,
        };
      }

      return {
        status: "unknown",
        detail: dispatch.detail,
        httpStatus: dispatch.httpStatus,
        binding: clonedBinding,
        diagnostics: dispatch.diagnostics,
      };
    }

    // dispatch.outcome === "error"
    try {
      await this._ledger.recordTransition(clonedBinding.idempotencyKey, {
        state: "error",
        httpStatus: dispatch.httpStatus,
        detail: dispatch.detail,
        binding: clonedBinding,
        diagnostics: dispatch.diagnostics,
      });
    } catch {
      this._disabled = true;
      this._disabledReason = "ledger_persistence_failed";
      return {
        status: "disabled",
        detail: "ledger_persistence_failed",
        binding: clonedBinding,
      };
    }

    return {
      status: "rejected",
      detail: dispatch.detail,
      httpStatus: dispatch.httpStatus,
      binding: clonedBinding,
      diagnostics: dispatch.diagnostics,
    };
  }

  get ledger(): ReservationLedger {
    return this._ledger;
  }

  get oauth(): OAuthClient {
    return this._oauth;
  }

  get isDisabled(): boolean {
    return this._disabled;
  }
}

function validateReviewBinding(
  binding: unknown,
  request: HostedEvaluationRequest
): string | null {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return "binding must be a non-null object";
  }

  const b = binding as Record<string, unknown>;

  if (typeof b.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_REGEX.test(b.idempotencyKey)) {
    return "idempotencyKey must be 16..128 safe characters";
  }

  if (typeof b.sessionId !== "string" || !SESSION_ID_REGEX.test(b.sessionId) || b.sessionId.length === 0) {
    return "sessionId must be 1..128 safe characters";
  }

  if (
    typeof b.basisRevision !== "number" ||
    !Number.isInteger(b.basisRevision) ||
    b.basisRevision < 1
  ) {
    return "basisRevision must be an integer >= 1";
  }

  if (typeof b.basisDigest !== "string" || !SHA256_HEX_REGEX.test(b.basisDigest)) {
    return "basisDigest must be a 64-hex SHA-256 string";
  }

  if (
    !b.candidatePayloadHashes ||
    typeof b.candidatePayloadHashes !== "object" ||
    Array.isArray(b.candidatePayloadHashes)
  ) {
    return "candidatePayloadHashes must be an object";
  }

  const hashes = b.candidatePayloadHashes as Record<string, unknown>;
  const candidateIds = request.candidates.map((c) => c.candidate_id);
  const hashKeys = Object.keys(hashes);

  // Closed mapping: exactly 1:1 match with request.candidates
  if (hashKeys.length !== candidateIds.length) {
    return "candidatePayloadHashes must match submitted candidates 1:1";
  }

  for (const cid of candidateIds) {
    const hash = hashes[cid];
    if (typeof hash !== "string" || !SHA256_HEX_REGEX.test(hash)) {
      return `candidatePayloadHashes missing or invalid 64-hex SHA-256 for candidate '${cid}'`;
    }
  }

  return null;
}
