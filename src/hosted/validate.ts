/**
 * Hosted request and response validation.
 * Enforces all structural, security, and schema requirements from HOSTED-BUILD-SPEC.md.
 */

import {
  EVALUATION_API_VERSION,
  EVALUATION_PROFILE_ID,
  RESERVED_REFUSAL_ID,
  EVALUATION_REQUEST_BODY_LIMIT,
  type HostedEvaluationRequest,
  type HostedRawResult,
  type HostedCandidate,
  type HostedResultObject,
  type HostedGateRecord,
  type HostedTrace,
  type HostedCommercialReceipt,
  type HostedAuthority,
  type HostedReasonCode,
  type EvidenceLabel,
} from "./types.js";

const CANDIDATE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;
const CONTEXT_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;

export const EXPECTED_GATES = [
  "HES-G01", "HES-G02", "HES-G03", "HES-G04",
  "HES-G05", "HES-G06", "HES-G07", "HES-G08",
  "HES-G09", "HES-G10", "HES-G11", "HES-G12",
] as const;

export const KNOWN_REASON_CODES: readonly HostedReasonCode[] = [
  "candidate_selected_within_bounded_evaluation",
  "no_submitted_candidate_passed_all_gates",
  "all_submitted_candidates_shadow_only",
  "insufficient_bounded_support",
  "identity_or_authority_gate_closed",
  "resource_or_trace_gate_closed",
  "policy_conflict",
] as const;

export const KNOWN_EVIDENCE_LABELS: readonly EvidenceLabel[] = [
  "operator_reported",
  "contract_validated",
  "runtime_observed",
  "inferred",
  "unresolved",
] as const;

export const FORBIDDEN_CONTEXT_KEYWORDS = [
  "tenant", "principal", "domain", "mode", "amount", "price", "quote",
  "payer", "network", "asset", "facilitator", "payee", "entitlement",
  "commercial_terms", "policy", "authority", "release", "payment",
  "authorization", "credential", "secret", "token", "password",
  "url", "uri", "callback", "webhook", "file", "path", "command", "script",
  "execute", "actuate", "control", "destination",
] as const;

export function isForbiddenContextKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const forbidden of FORBIDDEN_CONTEXT_KEYWORDS) {
    const normForbidden = forbidden.replace(/[^a-z0-9]/g, "");
    if (normalized.includes(normForbidden)) {
      return true;
    }
  }
  return false;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates an evaluation request against the closed hosted contract.
 */
export function validateEvaluationRequest(req: unknown): ValidationResult {
  const errors: string[] = [];

  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return { valid: false, errors: ["Request must be a non-null JSON object."] };
  }

  const obj = req as Record<string, unknown>;
  const allowedTopKeys = new Set(["profile_id", "objective", "context", "candidates"]);
  for (const k of Object.keys(obj)) {
    if (!allowedTopKeys.has(k)) {
      errors.push(`Disallowed top-level request field '${k}'.`);
    }
  }

  if (obj.profile_id !== EVALUATION_PROFILE_ID) {
    errors.push(`Invalid profile_id: expected '${EVALUATION_PROFILE_ID}', got '${String(obj.profile_id)}'.`);
  }

  if (typeof obj.objective !== "string" || obj.objective.trim().length === 0 || obj.objective.length > 1024) {
    errors.push("Objective must be a non-blank string between 1 and 1024 characters.");
  }

  // Context validation: <= 16 scalar fields
  if (!obj.context || typeof obj.context !== "object" || Array.isArray(obj.context)) {
    errors.push("Context must be a non-null object.");
  } else {
    const ctx = obj.context as Record<string, unknown>;
    const keys = Object.keys(ctx);
    if (keys.length > 16) {
      errors.push(`Context exceeds limit: allowed <= 16 keys, found ${keys.length}.`);
    }

    for (const key of keys) {
      if (!CONTEXT_KEY_REGEX.test(key) || key.length > 64) {
        errors.push(`Context key '${key}' does not match required regex ^[A-Za-z][A-Za-z0-9_.-]{0,63}$.`);
      }
      if (isForbiddenContextKey(key)) {
        errors.push(`Context key '${key}' contains forbidden selector, credential, or control keyword.`);
      }

      const val = ctx[key];
      if (val === null) {
        continue;
      }
      if (typeof val === "string") {
        if (val.length > 256) {
          errors.push(`Context field '${key}' string length (${val.length}) exceeds 256 characters.`);
        }
      } else if (typeof val === "number") {
        if (!Number.isFinite(val) || Math.abs(val) > 1e9) {
          errors.push(`Context field '${key}' must be a finite number within +/-1e9.`);
        }
      } else if (typeof val === "boolean") {
        // ok
      } else {
        errors.push(`Context field '${key}' must be a scalar (string, number, boolean, or null), got ${typeof val}.`);
      }
    }
  }

  // Candidates validation: 1..8
  if (!Array.isArray(obj.candidates) || obj.candidates.length < 1 || obj.candidates.length > 8) {
    errors.push(
      `Candidates must be an array of 1 to 8 items, found ${Array.isArray(obj.candidates) ? obj.candidates.length : "non-array"}.`
    );
  } else {
    const seenIds = new Set<string>();
    const allowedCandidateKeys = new Set([
      "candidate_id",
      "semantic_class",
      "description",
      "operator_reported_support",
    ]);

    for (let i = 0; i < obj.candidates.length; i++) {
      const c = obj.candidates[i];
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        errors.push(`Candidate at index ${i} is not a valid object.`);
        continue;
      }

      const cObj = c as Record<string, unknown>;
      for (const ck of Object.keys(cObj)) {
        if (!allowedCandidateKeys.has(ck)) {
          errors.push(`Candidate[${i}] contains disallowed field '${ck}'.`);
        }
      }

      if (typeof cObj.candidate_id !== "string" || !CANDIDATE_ID_REGEX.test(cObj.candidate_id)) {
        errors.push(`Candidate[${i}].candidate_id '${String(cObj.candidate_id)}' fails regex ^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$.`);
      }

      if (cObj.candidate_id === RESERVED_REFUSAL_ID) {
        errors.push(`Candidate[${i}].candidate_id uses reserved refusal id '${RESERVED_REFUSAL_ID}'.`);
      }

      if (typeof cObj.candidate_id === "string") {
        if (seenIds.has(cObj.candidate_id)) {
          errors.push(`Duplicate candidate_id '${cObj.candidate_id}' at index ${i}.`);
        }
        seenIds.add(cObj.candidate_id);
      }

      const validClasses = ["analyze", "compare", "draft", "validate", "external"];
      if (typeof cObj.semantic_class !== "string" || !validClasses.includes(cObj.semantic_class)) {
        errors.push(`Candidate[${i}].semantic_class '${String(cObj.semantic_class)}' is not one of: ${validClasses.join(", ")}.`);
      }

      if (typeof cObj.description !== "string" || cObj.description.trim().length === 0 || cObj.description.length > 512) {
        errors.push(`Candidate[${i}].description must be a non-blank string between 1 and 512 characters.`);
      }

      if (
        typeof cObj.operator_reported_support !== "number" ||
        !Number.isFinite(cObj.operator_reported_support) ||
        cObj.operator_reported_support < 0 ||
        cObj.operator_reported_support > 1
      ) {
        errors.push(`Candidate[${i}].operator_reported_support must be a finite number within [0, 1].`);
      }
    }
  }

  // Size limit: UTF-8 encoded body <= 32768 bytes
  try {
    const encodedLength = Buffer.byteLength(JSON.stringify(req), "utf8");
    if (encodedLength > EVALUATION_REQUEST_BODY_LIMIT) {
      errors.push(`Encoded request body (${encodedLength} bytes) exceeds limit of ${EVALUATION_REQUEST_BODY_LIMIT} bytes.`);
    }
  } catch {
    errors.push("Request cannot be serialized to JSON.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates and unwraps the raw hosted response body.
 * Returns a typed HostedRawResult on success.
 * Throws ValidationError on any violation.
 */
export function validateHostedResponse(
  raw: unknown,
  submittedCandidates?: HostedCandidate[]
): HostedRawResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("response root is not an object");
  }

  const obj = raw as Record<string, unknown>;

  // Envelope fields: receipt_id, evaluated_at, counted, result
  requireString(obj, "receipt_id", "eval_");
  requireString(obj, "evaluated_at");
  requireBoolean(obj, "counted");
  requireObject(obj, "result");

  const receipt_id = obj.receipt_id as string;
  const evaluated_at = obj.evaluated_at as string;
  const counted = obj.counted as boolean;
  const result = obj.result as Record<string, unknown>;

  validateTimestamp(evaluated_at, "evaluated_at");

  // Validate result object
  const validResult = validateResultObject(result, submittedCandidates);

  return {
    receipt_id,
    evaluated_at,
    counted,
    result: validResult,
  };
}

function validateResultObject(
  result: Record<string, unknown>,
  submittedCandidates?: HostedCandidate[]
): HostedResultObject {
  // Required: outcome, selected_candidate_id, trace, commercial_receipt, authority, reason_codes
  requireString(result, "outcome");
  const outcome = result.outcome as string;
  if (outcome !== "selected" && outcome !== "governed_noop_refusal") {
    throw new ValidationError(`unknown outcome: ${outcome}`);
  }

  // selected_candidate_id validation
  const selected_candidate_id = result.selected_candidate_id;
  if (outcome === "selected") {
    if (typeof selected_candidate_id !== "string" || !selected_candidate_id.trim()) {
      throw new ValidationError("outcome is 'selected' but selected_candidate_id is null or empty");
    }
    if (submittedCandidates) {
      const match = submittedCandidates.find((c) => c.candidate_id === selected_candidate_id);
      if (!match) {
        throw new ValidationError(`selected_candidate_id '${selected_candidate_id}' does not match any submitted candidate`);
      }
      if (match.semantic_class === "external") {
        throw new ValidationError(
          `selected_candidate_id '${selected_candidate_id}' has semantic_class 'external', which is shadow-only and cannot be selected`
        );
      }
    }
  } else {
    // outcome === "governed_noop_refusal"
    if (selected_candidate_id !== null) {
      throw new ValidationError(`outcome is 'governed_noop_refusal' but selected_candidate_id is not null (${String(selected_candidate_id)})`);
    }
  }

  // Optional metadata: api_version, profile_id, request_id
  if ("api_version" in result) {
    if (result.api_version !== EVALUATION_API_VERSION) {
      throw new ValidationError(`api_version '${String(result.api_version)}' does not match expected '${EVALUATION_API_VERSION}'`);
    }
  }
  if ("profile_id" in result) {
    if (result.profile_id !== EVALUATION_PROFILE_ID) {
      throw new ValidationError(`profile_id '${String(result.profile_id)}' does not match expected '${EVALUATION_PROFILE_ID}'`);
    }
  }
  if ("request_id" in result) {
    if (typeof result.request_id !== "string" || !UUID_REGEX.test(result.request_id)) {
      throw new ValidationError(`request_id '${String(result.request_id)}' is not a valid UUID`);
    }
  }

  requireObject(result, "trace");
  requireObject(result, "commercial_receipt");
  requireObject(result, "authority");
  requireArray(result, "reason_codes");

  // Validate reason_codes
  const rawCodes = result.reason_codes as unknown[];
  if (rawCodes.length === 0) {
    throw new ValidationError("reason_codes array must not be empty");
  }
  const validReasonCodes: HostedReasonCode[] = [];
  for (let i = 0; i < rawCodes.length; i++) {
    const code = rawCodes[i];
    if (typeof code !== "string" || !code.trim()) {
      throw new ValidationError(`reason_codes[${i}] must be a non-blank string`);
    }
    if (!KNOWN_REASON_CODES.includes(code as HostedReasonCode)) {
      throw new ValidationError(`reason_codes[${i}] contains unknown code '${code}'`);
    }
    validReasonCodes.push(code as HostedReasonCode);
  }

  // Validate authority, trace, commercial_receipt
  const authority = validateAuthority(result.authority as Record<string, unknown>);
  const trace = validateTrace(result.trace as Record<string, unknown>);
  const commercial_receipt = validateCommercialReceipt(
    result.commercial_receipt as Record<string, unknown>,
    trace.committed_at
  );

  // Reject unexpected fields in security-critical result object
  const allowedResultKeys = [
    "outcome",
    "selected_candidate_id",
    "trace",
    "commercial_receipt",
    "authority",
    "reason_codes",
    "api_version",
    "profile_id",
    "request_id",
  ];
  checkNoUnexpectedFields(result, allowedResultKeys, "result");

  return {
    ...(result.request_id !== undefined ? { request_id: result.request_id as string } : {}),
    ...(result.api_version !== undefined ? { api_version: result.api_version as string } : {}),
    ...(result.profile_id !== undefined ? { profile_id: result.profile_id as string } : {}),
    outcome: outcome as "selected" | "governed_noop_refusal",
    selected_candidate_id: selected_candidate_id as string | null,
    reason_codes: validReasonCodes,
    trace,
    commercial_receipt,
    authority,
  };
}

function validateAuthority(authority: Record<string, unknown>): HostedAuthority {
  requireExactlyFalse(authority, "selected_is_executed");
  requireExactlyFalse(authority, "selected_is_correct_or_safe");
  requireExactlyFalse(authority, "response_authorizes_downstream_action");
  requireExactlyFalse(authority, "response_is_professional_advice");
  requireExactlyFalse(authority, "trace_is_certification_or_legal_non_repudiation");

  const allowedAuthorityKeys = [
    "selected_is_executed",
    "selected_is_correct_or_safe",
    "response_authorizes_downstream_action",
    "response_is_professional_advice",
    "trace_is_certification_or_legal_non_repudiation",
  ];
  checkNoUnexpectedFields(authority, allowedAuthorityKeys, "authority");

  return {
    selected_is_executed: false,
    selected_is_correct_or_safe: false,
    response_authorizes_downstream_action: false,
    response_is_professional_advice: false,
    trace_is_certification_or_legal_non_repudiation: false,
  };
}

function validateTrace(trace: Record<string, unknown>): HostedTrace {
  requireString(trace, "trace_id");
  requireString(trace, "request_digest");
  requireString(trace, "candidate_field_digest");
  requireString(trace, "release_set_digest");
  requireString(trace, "policy_digest");
  requireString(trace, "committed_at");

  validateUUID(trace.trace_id as string, "trace_id");
  validateHex64(trace.request_digest as string, "request_digest");
  validateHex64(trace.candidate_field_digest as string, "candidate_field_digest");
  validateHex64(trace.release_set_digest as string, "release_set_digest");
  validateHex64(trace.policy_digest as string, "policy_digest");
  validateTimestamp(trace.committed_at as string, "trace.committed_at");

  // lambda_decisions: exactly 12 gates, ordered HES-G01..HES-G12
  if (!Array.isArray(trace.lambda_decisions) || trace.lambda_decisions.length !== 12) {
    throw new ValidationError(
      `lambda_decisions must contain exactly 12 ordered decisions, found ${Array.isArray(trace.lambda_decisions) ? trace.lambda_decisions.length : "non-array"}`
    );
  }

  const decisions: HostedGateRecord[] = [];
  for (let i = 0; i < 12; i++) {
    const gate = trace.lambda_decisions[i];
    if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
      throw new ValidationError(`gate ${i} is not an object`);
    }
    const gateObj = gate as Record<string, unknown>;
    requireString(gateObj, "gate_id");
    requireOneOf(gateObj, "disposition", ["pass", "fail"]);
    requireString(gateObj, "reason_code");

    const expectedGate = EXPECTED_GATES[i];
    if (gateObj.gate_id !== expectedGate) {
      throw new ValidationError(`gate ${i} must be ${expectedGate}, got ${String(gateObj.gate_id)}`);
    }

    const reasonCode = (gateObj.reason_code as string).trim();
    if (!reasonCode) {
      throw new ValidationError(`gate ${i} reason_code is blank`);
    }

    decisions.push({
      gate_id: gateObj.gate_id as string,
      disposition: gateObj.disposition as "pass" | "fail",
      reason_code: reasonCode,
    });
  }

  // Trace flags: all exactly false
  requireExactlyFalse(trace, "submitted_candidate_executed");
  requireExactlyFalse(trace, "external_effect");
  requireExactlyFalse(trace, "learning_applied");
  requireExactlyFalse(trace, "operator_reported_context_verified");

  // evidence_labels: array of valid EvidenceLabels
  requireArray(trace, "evidence_labels");
  const rawLabels = trace.evidence_labels as unknown[];
  const labels: EvidenceLabel[] = [];
  for (let i = 0; i < rawLabels.length; i++) {
    const label = rawLabels[i];
    if (typeof label !== "string" || !KNOWN_EVIDENCE_LABELS.includes(label as EvidenceLabel)) {
      throw new ValidationError(`evidence_labels[${i}] '${String(label)}' is not a known evidence label`);
    }
    labels.push(label as EvidenceLabel);
  }

  const allowedTraceKeys = [
    "trace_id",
    "request_digest",
    "candidate_field_digest",
    "release_set_digest",
    "policy_digest",
    "lambda_decisions",
    "submitted_candidate_executed",
    "external_effect",
    "learning_applied",
    "operator_reported_context_verified",
    "evidence_labels",
    "committed_at",
  ];
  checkNoUnexpectedFields(trace, allowedTraceKeys, "trace");

  return {
    trace_id: trace.trace_id as string,
    request_digest: trace.request_digest as string,
    candidate_field_digest: trace.candidate_field_digest as string,
    release_set_digest: trace.release_set_digest as string,
    policy_digest: trace.policy_digest as string,
    lambda_decisions: decisions as unknown as HostedTrace["lambda_decisions"],
    evidence_labels: labels,
    submitted_candidate_executed: false,
    external_effect: false,
    learning_applied: false,
    operator_reported_context_verified: false,
    committed_at: trace.committed_at as string,
  };
}

function validateCommercialReceipt(
  receipt: Record<string, unknown>,
  traceCommittedAt: string
): HostedCommercialReceipt {
  requireString(receipt, "receipt_id");
  requireString(receipt, "receipt_sha256");
  requireString(receipt, "commercial_binding_sha256");
  requireString(receipt, "mode");
  requireString(receipt, "committed_at");

  validateUUID(receipt.receipt_id as string, "commercial_receipt.receipt_id");
  validateHex64(receipt.receipt_sha256 as string, "receipt_sha256");
  validateHex64(receipt.commercial_binding_sha256 as string, "commercial_binding_sha256");

  if (receipt.mode !== "free_beta") {
    throw new ValidationError(`mode must be "free_beta", got '${String(receipt.mode)}'`);
  }

  validateTimestamp(receipt.committed_at as string, "commercial_receipt.committed_at");

  if (receipt.committed_at !== traceCommittedAt) {
    throw new ValidationError("commercial_receipt.committed_at must match trace.committed_at");
  }

  const allowedReceiptKeys = [
    "receipt_id",
    "receipt_sha256",
    "commercial_binding_sha256",
    "mode",
    "committed_at",
  ];
  checkNoUnexpectedFields(receipt, allowedReceiptKeys, "commercial_receipt");

  return {
    receipt_id: receipt.receipt_id as string,
    receipt_sha256: receipt.receipt_sha256 as string,
    commercial_binding_sha256: receipt.commercial_binding_sha256 as string,
    mode: "free_beta",
    committed_at: receipt.committed_at as string,
  };
}

function requireString(obj: Record<string, unknown>, key: string, prefix?: string): void {
  if (typeof obj[key] !== "string") {
    throw new ValidationError(`${key} must be a string`);
  }
  const val = obj[key] as string;
  if (!val.trim()) {
    throw new ValidationError(`${key} must not be empty`);
  }
  if (prefix && !val.startsWith(prefix)) {
    throw new ValidationError(`${key} must start with "${prefix}"`);
  }
}

function requireBoolean(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== "boolean") {
    throw new ValidationError(`${key} must be a boolean`);
  }
}

function requireObject(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== "object" || obj[key] === null || Array.isArray(obj[key])) {
    throw new ValidationError(`${key} must be an object`);
  }
}

function requireArray(obj: Record<string, unknown>, key: string): void {
  if (!Array.isArray(obj[key])) {
    throw new ValidationError(`${key} must be an array`);
  }
}

function requireOneOf(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly string[]
): void {
  if (typeof obj[key] !== "string" || !allowed.includes(obj[key] as string)) {
    throw new ValidationError(`${key} must be one of: ${allowed.join(", ")}`);
  }
}

function requireExactlyFalse(obj: Record<string, unknown>, key: string): void {
  if (obj[key] !== false) {
    throw new ValidationError(`${key} must be exactly false`);
  }
}

function checkNoUnexpectedFields(
  obj: Record<string, unknown>,
  allowed: string[],
  label: string
): void {
  const unexpected = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unexpected.length > 0) {
    throw new ValidationError(`${label} has unexpected fields: ${unexpected.join(", ")}`);
  }
}

function validateUUID(value: string, label: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new ValidationError(`${label} is not a valid UUID: '${value}'`);
  }
}

function validateHex64(value: string, label: string): void {
  if (!SHA256_HEX_REGEX.test(value)) {
    throw new ValidationError(`${label} is not a valid 64-hex digest: '${value}'`);
  }
}

function validateTimestamp(value: string, label: string): void {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new ValidationError(`${label} is not a valid ISO 8601 timestamp: '${value}'`);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(`Hosted validation failed: ${message}`);
    this.name = "ValidationError";
  }
}
