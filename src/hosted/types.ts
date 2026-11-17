/**
 * Hosted transport types for DeltaX Evaluate boundary.
 *
 * Pinned customer endpoints:
 * - Token Endpoint: https://access-api.deltaxevaluate.com/api/builder/oauth/token
 * - Evaluation Endpoint: https://access-api.deltaxevaluate.com/api/builder/evaluations
 * - API Version: 2026-09-16.beta2
 * - Profile ID: deltax-hosted-bounded-review-evaluation-v1
 * - Scope: deltax:evaluate
 */

export const EVALUATION_ENDPOINT = "https://access-api.deltaxevaluate.com/api/builder/evaluations";
export const EVALUATION_OAUTH_TOKEN_ENDPOINT = "https://access-api.deltaxevaluate.com/api/builder/oauth/token";
export const EVALUATION_API_VERSION = "2026-09-16.beta2";
export const EVALUATION_PROFILE_ID = "deltax-hosted-bounded-review-evaluation-v1";
export const EVALUATION_OAUTH_SCOPE = "deltax:evaluate";
export const RESERVED_REFUSAL_ID = "governed_noop_refusal";

/** Ledger format constants. */
export const LEDGER_HEADER_VERSION = "deltax-blackout-hosted-ledger-v1";
export const MAX_LEDGER_FILE_BYTES = 8388608; // 8 MiB
export const MAX_LEDGER_ENTRY_BYTES = 262144; // 256 KiB

/** Maximum payload sizes from spec. */
export const OAUTH_REQUEST_BODY_LIMIT = 4096; // 4 KiB
export const TOKEN_RESPONSE_LIMIT = 16384; // 16 KiB
export const EVALUATION_REQUEST_BODY_LIMIT = 32768; // 32 KiB
export const EVALUATION_RESPONSE_LIMIT = 65536; // 64 KiB

/** Budget limits. */
export const MAX_TOTAL_ATTEMPTS = 10;
export const MAX_PER_SESSION_ATTEMPTS = 2;
export const MAX_ACTIVE_CONCURRENT = 1;

/** Native-compatible fetch signature. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Candidate semantic classes. */
export type CandidateSemanticClass = "analyze" | "compare" | "draft" | "validate" | "external";

export interface HostedCandidate {
  candidate_id: string; // 1..64 chars, ^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$
  semantic_class: CandidateSemanticClass;
  description: string; // 1..512 chars
  operator_reported_support: number; // finite [0, 1]
}

export type ContextScalar = string | number | boolean | null;
export type EvaluationContext = Record<string, ContextScalar>;

export interface HostedEvaluationRequest {
  profile_id: string;
  objective: string; // 1..1024 chars
  context: EvaluationContext; // <= 16 scalar fields
  candidates: HostedCandidate[]; // 1..8 items
}

export type EvaluationOutcome = "selected" | "governed_noop_refusal";
export type GateDisposition = "pass" | "fail";

export interface HostedGateRecord {
  gate_id: string; // Ordered HES-G01 through HES-G12
  disposition: GateDisposition;
  reason_code: string; // non-blank string from service
}

export type EvidenceLabel =
  | "operator_reported"
  | "contract_validated"
  | "runtime_observed"
  | "inferred"
  | "unresolved";

export interface HostedTrace {
  trace_id: string; // UUID
  request_digest: string; // 64 hex
  candidate_field_digest: string; // 64 hex
  release_set_digest: string; // 64 hex
  policy_digest: string; // 64 hex
  /** Exactly 12 HES gate records, ordered HES-G01..HES-G12. */
  lambda_decisions: [
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
    HostedGateRecord,
  ];
  evidence_labels: EvidenceLabel[];
  submitted_candidate_executed: false;
  external_effect: false;
  learning_applied: false;
  operator_reported_context_verified: false;
  committed_at: string; // ISO 8601
}

export interface HostedCommercialReceipt {
  receipt_id: string; // UUID
  receipt_sha256: string; // 64 hex
  commercial_binding_sha256: string; // 64 hex
  mode: "free_beta";
  committed_at: string; // ISO 8601 matching trace
}

export interface HostedAuthority {
  selected_is_executed: false;
  selected_is_correct_or_safe: false;
  response_authorizes_downstream_action: false;
  response_is_professional_advice: false;
  trace_is_certification_or_legal_non_repudiation: false;
}

export type HostedReasonCode =
  | "candidate_selected_within_bounded_evaluation"
  | "no_submitted_candidate_passed_all_gates"
  | "all_submitted_candidates_shadow_only"
  | "insufficient_bounded_support"
  | "identity_or_authority_gate_closed"
  | "resource_or_trace_gate_closed"
  | "policy_conflict";

export interface HostedResultObject {
  request_id?: string;
  api_version?: string;
  profile_id?: string;
  outcome: EvaluationOutcome;
  selected_candidate_id: string | null;
  reason_codes: HostedReasonCode[];
  trace: HostedTrace;
  commercial_receipt: HostedCommercialReceipt;
  authority: HostedAuthority;
}

export interface HostedRawResult {
  receipt_id: string; // Gateway receipt ID (eval_...)
  evaluated_at: string; // ISO 8601
  counted: boolean;
  result: HostedResultObject;
}

/**
 * Server-owned review binding metadata.
 * Kept separate from request context.
 */
export interface ReviewBinding {
  idempotencyKey: string;
  sessionId: string;
  basisRevision: number;
  basisDigest: string;
  candidatePayloadHashes: Record<string, string>; // candidate_id -> sha256 hex
}

/**
 * Allowlisted nonsensitive reconciliation diagnostics for 202 or rejected responses.
 * If body reading was incomplete or timed out: bodyComplete is false and response_sha256 is absent.
 */
export interface ReconciliationDiagnostics {
  http_status: number;
  bodyComplete: boolean;
  response_sha256?: string; // 64 hex when bodyComplete is true
  receipt_id?: string; // eval_... identifier
  unconfirmed_reason?: string;
  upstream_status?: number;
  retryable?: boolean;
  retry_mode?: string;
  retry_after?: string | number;
}

/**
 * Discriminated union of review results from HostedReviewClient.
 */
export type ReviewResult =
  | {
      status: "completed";
      outcome: "selected";
      selectedCandidateId: string;
      envelope: HostedRawResult;
      binding: ReviewBinding;
    }
  | {
      status: "refused";
      outcome: "governed_noop_refusal";
      selectedCandidateId: null;
      envelope: HostedRawResult;
      binding: ReviewBinding;
    }
  | {
      status: "unknown";
      detail: string;
      httpStatus: number | null;
      binding: ReviewBinding;
      diagnostics?: ReconciliationDiagnostics;
    }
  | {
      status: "rejected";
      detail: string;
      httpStatus: number | null;
      binding: ReviewBinding;
      diagnostics?: ReconciliationDiagnostics;
    }
  | {
      status: "disabled";
      detail: string;
      binding?: ReviewBinding;
    };

/**
 * Durable JSONL ledger entry.
 */
export type LedgerEntryState = "reserved" | "selected" | "refused" | "unknown" | "error";

export interface LedgerEntry {
  timestamp: string; // ISO 8601
  idempotencyKey: string;
  bodySha256: string;
  sessionId: string;
  basisRevision: number;
  basisDigest: string;
  state: LedgerEntryState;
  requestBody?: string;
  httpStatus?: number | null;
  detail?: string;
  selectedCandidateId?: string | null;
  candidateIds?: string[];
  rawEnvelope?: HostedRawResult;
  candidatePayloadHashes?: Record<string, string>;
  diagnostics?: ReconciliationDiagnostics;
}

export interface HostedAdapterConfig {
  clientId: string;
  clientSecret: string;
  fetch: FetchFn;
  ledgerPath: string;
  sessionId?: string;
  maxAttempts?: number;
  maxPerSession?: number;
  timeoutMs?: number;
}

export interface HostedReviewClientConfig {
  clientId: string;
  clientSecret: string;
  fetch: FetchFn;
  ledgerPath: string;
  maxAttempts?: number;
  maxPerSession?: number;
  timeoutMs?: number;
}
