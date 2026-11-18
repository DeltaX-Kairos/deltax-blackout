# Blackout hosted adapter implementation contract

Checked against the current official public reference on 2026-11-17:
- https://deltaxevaluate.com/developers
- https://deltaxevaluate.com/developers/evaluate/account-reference.md
- https://deltaxevaluate.com/developers/evaluate/v1#beta2

This is a new application adapter, not engine code or a port of another contest app. Do not read private credentials or make network calls during implementation/tests.

## Transport
Pinned customer endpoints only:
POST https://access-api.deltaxevaluate.com/api/builder/oauth/token
POST https://access-api.deltaxevaluate.com/api/builder/evaluations
OAuth URL-encoded grant_type=client_credentials, client_id, client_secret, scope=deltax:evaluate. 4096-byte token body maximum. Credentials provided through server environment only. Bearer dxbt_ token, lifetime 900 seconds, scope deltax:evaluate; cache until 60 seconds before expiry. One exchange in flight, never persist tokens to receipt ledger. No redirects, no automatic retries, no provider response text or secret values in errors/logs. Bounded active deadline covers headers and streaming body. 16 KiB token response; 64 KiB evaluation response. Fetch injectable for offline tests, pinned endpoints cannot be overridden by request/user.

Evaluation request header X-DeltaX-API-Version: 2026-09-16.beta2, stable Idempotency-Key matching ^[A-Za-z0-9._~-]{16,128}$. Exactly profile_id,objective,context,candidates. Profile deltax-hosted-bounded-review-evaluation-v1. Nonblank objective <=1024. Context <=16 scalar fields: string <=256, finite number abs<=1e9, boolean/null; safe letter-start key<=64. Block credential/control/destination context keys and normalized variants as described by the official account reference. Prefer building our own fixed context (scenario_id, observation_revision, observation_digest, telemetry_kind, tick, queue_depth, error_rate). No secrets or arbitrary caller context.

1–8 candidates, exactly candidate_id,semantic_class,description,operator_reported_support. Unique safe ids <=64, reserved governed_noop_refusal forbidden. Review classes analyze/compare/draft/validate; external shadow only. Description nonblank <=512; support finite [0,1]. Request UTF-8 and canonicalized body <=32768. Use review candidates such as 'Analyze scaling workers to 12'; never mislabel an external execution command as a review activity. The application maps the selected review candidate to the separately displayed local proposal, requiring an explicit human action after analysis, feasibility and freshness checks.

Support is caller reported from scripted assumptions, not engine confidence or telemetry verification. Keep exact proposal payload hash, basis revision/digest, admissible candidate mapping, body SHA-256 and idempotency key in an immutable application record. Evaluate does not infer our feasibility rules from prose. Only locally feasible review options go to hosted selection; other proposals remain visible with local rejection explanations.

## Response
Accept the real account gateway envelope: receipt_id (eval_... nonempty), evaluated_at (valid timestamp), counted (boolean), result (object). Keep raw sanitized result together with account receipt_id; evaluator commercial_receipt.receipt_id is different. Do not default missing response metadata and pretend it was returned. Some gateway result metadata is omitted; verify api_version/profile_id/request_id when present and record whether explicitly returned. The request's pinned version/profile remain known from our request, not an invented provider field.

Require selected or governed_noop_refusal outcome, known reason_codes, selected id in our submitted review set or null on refusal. Require trace with nonempty UUID trace_id, 64-hex request_digest,candidate_field_digest,release_set_digest,policy_digest; exactly ordered HES-G01..HES-G12 decisions, pass/fail with nonblank reason_code; known evidence_labels; valid committed_at. Require trace flags submitted_candidate_executed,external_effect,learning_applied,operator_reported_context_verified all exactly false. Require commercial_receipt UUID receipt_id,64-hex receipt_sha256,commercial_binding_sha256,mode free_beta,valid committed_at matching trace. Require exact five authority fields all false: selected_is_executed,selected_is_correct_or_safe,response_authorizes_downstream_action,response_is_professional_advice,trace_is_certification_or_legal_non_repudiation. Reject unexpected fields in security-critical objects and malformed nested values before exposing selection. Trace gate reasons are service checks, not per-candidate ranking explanations.

Validate provider hash formats. Do not invent the provider's undocumented hash algorithm or claim cross-system attestation. Our locally computed body/basis/payload digests bind the stored transport record and execution gate. Hashes establish integrity references, not authenticity of supplied observations, safety or legal nonrepudiation.

Treat HTTP 202, transport errors/timeouts, malformed completed responses as unknown with the original immutable body/key reserved; never start a new request to escape unknown. Distinguish auth/invalid/quota/rejected and refusal from unknown. Never automatically retry. A 429 does not itself prove account exhaustion. User gets a specific sanitized status and cannot trigger new work on the same uncertain review. Evidence export includes provider records but no credentials.

## Budget and persistence
Free account has 100 evaluations/month shared across credentials. Project-specific credential pending approval. Default live disabled. Initial proposed application allowance: 10 attempts total, reserved before provider exchange; one active request globally, <=2 new evaluations per session. Persist reservation and exact body/key to an ignored private JSONL ledger using exclusive append with bounded records and validated startup replay; count unknowns as reserved. Missing/corrupt/truncated ledger with existing credentials must disable live rather than reset capacity. Restrict file permissions 0600. On successful response persist receipt before unlocking the execution UI. Configuration caps cannot be raised by browser. Offline mode never fabricates a hosted receipt.

## Required offline tests
Closed request validation; chosen option maps to submitted admissible candidate; refusal; malicious authority true; malformed gates/digests/envelope; size limits including streaming body; deadline after headers; 202/429/auth/error distinct; zero retries; OAuth reuse; concurrent request refused; body mutation invalidates mapping; stale live result never authorizes current action; persistent unknown reservation survives restart; corrupt ledger disables live. No tests call real hosts.
