# Hosted Evaluate integration boundary

The hosted service is pre-existing proprietary technology. New app code must use the hosted API; no engine source copy or modification. This reference is from the separately verified Release Review integration and must be checked against CURRENT official docs before any live call. Do not reuse its credential.

API: https://api.deltaxevaluate.com/v1/evaluations. Reference API version 2026-09-16.beta2; profile deltax-hosted-bounded-review-evaluation-v1. Free beta OAuth client credentials are server-side only; current access route/audience must be verified before integration.

Request: closed fields profile_id, objective (1..1024 chars), context (at most16 scalar fields), candidates (1..8). Candidate: candidate_id (1..64, unique safe ID), semantic_class analyze|compare|draft|validate|external, description (1..512), operator_reported_support [0,1]. External class is shadow-only. Body <=32768 bytes. Context strings<=256; finite numbers within +/-1e9; boolean/null allowed. Do not send control selectors, commands, user secrets or action authorization to the engine. Evaluate is a bounded review service, not a telemetry risk oracle. Declare the application support formula and provenance.

Response outcomes selected or governed_noop_refusal. Selected ID must identify a submitted non-external candidate. Preserve trace (12 HES-G01..HES-G12 gates), digests, evidence labels and commercial receipt. All returned authority flags must be false: selection is not execution, correctness/safety assurance, downstream authority, professional advice or certification. Trace assertions include no submitted execution, external effect, learning or independent verification of operator-reported context.

Use a strict transport adapter; no redirects or automatic retries. Validate schema, IDs and authority. Retain uncertain outcome after a timeout. Synthetic fixtures only in tests and identified as synthetic. Unconfigured or failed service never becomes a successful result. Scenario events/app decisions own temporal memory. A fresh app basis must be checked after a real response and again before lab execution.

M1 makes no network calls and must clearly expose unconfigured hosted state. Subsequent integration needs current contract review, new app credential, hard application budget, request ledger, test transport, then one authorized live test.
