# Blackout development live integration review

Purpose: demonstrate one real hosted Evaluate choice within the new incident recovery lab. All submitted incident data is fictional; no customer data or engine internals are used.

Proposed actions: create a dedicated credential named Blackout Kiroween under hello@deltaxevaluate.com in DeltaX Evaluate API access; save its one-time client ID/secret in Mac Passwords; use only in the local Blackout Node server. Do not reuse Release Review or other credentials. No deployment or public sharing in this step.

Initial total application allowance: at most 10 evaluation attempts, including unknown outcomes and history, with at most 2 per browser/session and one globally in flight. Exact requests and stable idempotency keys are reserved durably before sending. No automatic retries. Stop on uncertainty. OAuth tokens remain server memory only. Local server bound to 127.0.0.1. No payment method, billing change or paid plan. Free account allowance is shared across credentials, so inspect current usage first.

Approval is requested at the actual Create credential security grant after the implementation and its synthetic transport tests are ready. Creating this token grants Evaluate access under your account; Mac Passwords storage and local server use must be covered explicitly. Publication and judge-hosting are a separate reviewed release step.
