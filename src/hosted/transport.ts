/**
 * Evaluation HTTP transport for DeltaX Evaluate.
 *
 * Rules:
 * - Pinned endpoint: https://access-api.deltaxevaluate.com/api/builder/evaluations
 * - Request headers: X-DeltaX-API-Version: 2026-09-16.beta2, Idempotency-Key, Authorization: Bearer <token>
 * - Redirects rejected: redirect: "manual"
 * - Bounded active deadline: timeout covers headers and streaming body read
 * - Streaming body cap: 65536 bytes (64 KiB)
 * - 202 accepted, transport timeouts, network failures, malformed completed responses treated as UNKNOWN
 * - 400, 401/403, 429 treated as ERROR / REJECTED
 * - Reconciliation metadata: preserves allowlisted diagnostics (receipt_id, unconfirmed_reason,
 *   upstream_status, retryable, retry_mode, retry_after, response_sha256, http_status)
 * - No automatic retries
 * - No credentials, tokens, canaries, or raw provider error text in errors or diagnostics
 */

import { createHash } from "node:crypto";
import {
  EVALUATION_ENDPOINT,
  EVALUATION_API_VERSION,
  EVALUATION_RESPONSE_LIMIT,
  EVALUATION_REQUEST_BODY_LIMIT,
  type FetchFn,
  type HostedCandidate,
  type HostedRawResult,
  type ReconciliationDiagnostics,
} from "./types.js";
import { validateHostedResponse } from "./validate.js";
import {
  raceWithDeadline,
  readStreamingBodyWithDeadline,
  DeadlineExceededError,
  ResponseSizeExceededError,
  InvalidContentTypeError,
} from "./deadline.js";

export interface DispatchEvaluationParams {
  token: string;
  idempotencyKey: string;
  requestBody: string;
  fetch: FetchFn;
  timeoutMs?: number;
  submittedCandidates?: HostedCandidate[];
}

export type TransportOutcome = "selected" | "refused" | "unknown" | "error";

export interface DispatchResult {
  outcome: TransportOutcome;
  httpStatus: number | null;
  detail: string;
  rawResult?: HostedRawResult;
  diagnostics?: ReconciliationDiagnostics;
}

export async function dispatchEvaluation(
  params: DispatchEvaluationParams
): Promise<DispatchResult> {
  const {
    token,
    idempotencyKey,
    requestBody,
    fetch: fetchFn,
    timeoutMs = 30000,
    submittedCandidates,
  } = params;

  if (Buffer.byteLength(requestBody, "utf8") > EVALUATION_REQUEST_BODY_LIMIT) {
    return {
      outcome: "error",
      httpStatus: 400,
      detail: "request_body_exceeds_limit",
    };
  }

  const controller = new AbortController();
  const startTime = Date.now();
  const totalTimeoutMs = timeoutMs ?? 30000;

  const getRemainingTimeout = (stage: string) => {
    const elapsed = Date.now() - startTime;
    const remaining = totalTimeoutMs - elapsed;
    if (remaining <= 0) {
      throw new DeadlineExceededError(`${stage} timed out: total timeout ${totalTimeoutMs}ms exceeded`);
    }
    return remaining;
  };

  let response: Response;
  try {
    const fetchTimeout = getRemainingTimeout("Evaluation request");
    response = await raceWithDeadline(
      fetchFn(EVALUATION_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-DeltaX-API-Version": EVALUATION_API_VERSION,
          "Idempotency-Key": idempotencyKey,
        },
        body: requestBody,
        redirect: "manual",
        signal: controller.signal,
      }),
      fetchTimeout,
      "Evaluation request",
      controller.signal
    );
  } catch (err) {
    controller.abort();
    const isTimeout = err instanceof DeadlineExceededError || controller.signal.aborted;
    return {
      outcome: "unknown",
      httpStatus: null,
      detail: isTimeout ? "request_timed_out" : "network_transport_error",
    };
  }

  // Handle redirect rejection
  if (
    (response.status >= 300 && response.status < 400) ||
    response.type === "opaqueredirect"
  ) {
    controller.abort();
    return {
      outcome: "error",
      httpStatus: response.status,
      detail: "redirect_rejected",
    };
  }

  // Handle HTTP 202 Accepted
  if (response.status === 202) {
    const elapsed = Date.now() - startTime;
    const remainingMs = Math.max(0, totalTimeoutMs - elapsed);
    const diagnostics = await readBoundedDiagnostics(
      response,
      remainingMs,
      controller.signal
    );
    return {
      outcome: "unknown",
      httpStatus: 202,
      detail: "received_202_accepted",
      diagnostics,
    };
  }

  // Handle 400 Bad Request
  if (response.status === 400) {
    const elapsed = Date.now() - startTime;
    const remainingMs = Math.max(0, totalTimeoutMs - elapsed);
    const diagnostics = await readBoundedDiagnostics(
      response,
      remainingMs,
      controller.signal
    );
    return {
      outcome: "error",
      httpStatus: 400,
      detail: "provider_rejected_request",
      diagnostics,
    };
  }

  // Handle 401 / 403 Auth Failure
  if (response.status === 401 || response.status === 403) {
    const elapsed = Date.now() - startTime;
    const remainingMs = Math.max(0, totalTimeoutMs - elapsed);
    const diagnostics = await readBoundedDiagnostics(
      response,
      remainingMs,
      controller.signal
    );
    return {
      outcome: "error",
      httpStatus: response.status,
      detail: "authentication_failed",
      diagnostics,
    };
  }

  // Handle 429 Quota / Rate Limit
  if (response.status === 429) {
    const elapsed = Date.now() - startTime;
    const remainingMs = Math.max(0, totalTimeoutMs - elapsed);
    const diagnostics = await readBoundedDiagnostics(
      response,
      remainingMs,
      controller.signal
    );
    return {
      outcome: "error",
      httpStatus: 429,
      detail: "rate_limited",
      diagnostics,
    };
  }

  // Handle 5xx or other non-200 status
  if (response.status !== 200) {
    const elapsed = Date.now() - startTime;
    const remainingMs = Math.max(0, totalTimeoutMs - elapsed);
    const diagnostics = await readBoundedDiagnostics(
      response,
      remainingMs,
      controller.signal
    );
    return {
      outcome: "unknown",
      httpStatus: response.status,
      detail: "unexpected_http_status",
      diagnostics,
    };
  }

  // Response status is 200. Read streaming body with active bounded deadline.
  let rawBodyText: string;
  try {
    const bodyTimeout = getRemainingTimeout("Evaluation response body");
    rawBodyText = await readStreamingBodyWithDeadline(
      response,
      EVALUATION_RESPONSE_LIMIT,
      bodyTimeout,
      "Evaluation response",
      controller.signal
    );
  } catch (err) {
    controller.abort();
    if (err instanceof DeadlineExceededError) {
      return {
        outcome: "unknown",
        httpStatus: 200,
        detail: "request_timed_out",
      };
    }
    if (err instanceof ResponseSizeExceededError) {
      return {
        outcome: "unknown",
        httpStatus: 200,
        detail: "response_exceeds_limit",
      };
    }
    if (err instanceof InvalidContentTypeError) {
      return {
        outcome: "unknown",
        httpStatus: 200,
        detail: "invalid_content_type",
      };
    }
    return {
      outcome: "unknown",
      httpStatus: 200,
      detail: "streaming_read_failed",
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBodyText);
  } catch {
    return {
      outcome: "unknown",
      httpStatus: 200,
      detail: "malformed_json_response",
    };
  }

  // Validate response shape against closed contract
  let validated: HostedRawResult;
  try {
    validated = validateHostedResponse(parsed, submittedCandidates);
  } catch {
    return {
      outcome: "unknown",
      httpStatus: 200,
      detail: "response_contract_validation_failed",
    };
  }

  if (validated.result.outcome === "selected") {
    return {
      outcome: "selected",
      httpStatus: 200,
      detail: "candidate_selected",
      rawResult: validated,
    };
  }

  return {
    outcome: "refused",
    httpStatus: 200,
    detail: "governed_noop_refusal",
    rawResult: validated,
  };
}

async function readBoundedDiagnostics(
  response: Response,
  timeoutMs: number,
  signal: AbortSignal
): Promise<ReconciliationDiagnostics> {
  let bodyText = "";
  let bodyComplete = false;

  if (timeoutMs > 0 && !signal.aborted) {
    try {
      bodyText = await readStreamingBodyWithDeadline(
        response,
        EVALUATION_RESPONSE_LIMIT,
        timeoutMs,
        "Error response body",
        signal
      );
      bodyComplete = true;
    } catch {
      bodyComplete = false;
      bodyText = "";
    }
  }

  const diag: ReconciliationDiagnostics = {
    http_status: response.status,
    bodyComplete,
  };

  if (bodyComplete) {
    diag.response_sha256 = createHash("sha256").update(bodyText, "utf8").digest("hex");
  }

  const retryAfterHeader = response.headers?.get?.("retry-after");
  if (retryAfterHeader) {
    const num = Number(retryAfterHeader);
    diag.retry_after = Number.isFinite(num) ? num : retryAfterHeader.slice(0, 64);
  }

  if (bodyComplete && bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;

        // receipt_id: must start with eval_
        if (
          typeof obj.receipt_id === "string" &&
          obj.receipt_id.startsWith("eval_") &&
          obj.receipt_id.length <= 128
        ) {
          diag.receipt_id = obj.receipt_id;
        }

        // unconfirmed_reason: safe bounded reason code
        const rawReason = obj.unconfirmed_reason ?? obj.error;
        if (typeof rawReason === "string" && /^[a-z0-9_.-]{1,64}$/i.test(rawReason)) {
          diag.unconfirmed_reason = rawReason;
        }

        // upstream_status
        if (typeof obj.upstream_status === "number" && Number.isInteger(obj.upstream_status)) {
          diag.upstream_status = obj.upstream_status;
        }

        // retryable
        if (typeof obj.retryable === "boolean") {
          diag.retryable = obj.retryable;
        }

        // retry_mode
        if (typeof obj.retry_mode === "string" && /^[a-z0-9_.-]{1,32}$/i.test(obj.retry_mode)) {
          diag.retry_mode = obj.retry_mode;
        }

        // retry_after in body
        if (diag.retry_after === undefined) {
          const bodyRetry = obj.retry_after ?? obj.retry_after_seconds;
          if (typeof bodyRetry === "number" && Number.isFinite(bodyRetry)) {
            diag.retry_after = bodyRetry;
          }
        }
      }
    } catch {
      // Body not JSON
    }
  }

  return diag;
}
