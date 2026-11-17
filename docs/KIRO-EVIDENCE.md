# Kiro build evidence

## Setup and authorship
Fresh private repository: DeltaX-Kairos/deltax-blackout. Kiro CLI 3.4.0 installed through the official checksum-verifying installer. Builder ID sign-in was verified. The founder chose Kiro as primary builder and explicitly removed the earlier Antigravity requirement.

Kiro authored the core modules, scenario models, CLI, property/example/regression tests, initial specs/design/tasks and steering. Codex authored the competition/product brief, review packets and verification notes and applied the narrow CommonJS/script and portable hook configuration corrections, and clarified transition comments about explicit PRNG consumption. No engine internals were copied. The existing hosted Evaluate service is a future external integration in this app, presently unconfigured.

## Actual sessions
- sess_ae9fb1aa-f7d9-4b02-940d-c151e0f3bb70: Spec mode; generated requirements and refinement. Detailed refinement intentionally stopped; no claim of completed automated spec approval.
- sess_41f78128-1ab5-4e73-a091-0122e15f2ebd: core/CLI implementation and review fixes, direct Kiro coding.
- sess_0ad14e08-1e85-4d33-beda-5d8d97b29bdf: focused provenance/timer/test fixes. Hook writes denied in noninteractive mode; no permissions bypass.
- sess_23683d30-d5b9-423a-9aca-75518e11291a: narrow configuration attempt intentionally stopped; final configuration corrections attributed to Codex.

## Verification
See M1-VERIFICATION.md: final independent typecheck, 50 tests and both compiled demo commands passed. Test results were not inferred from generated text.

## Hook observation
The portable PostFileSave invariant-check hook is configured. A Kiro source-edit probe was attempted but produced no native completion evidence before it was stopped. Automatic firing remains unverified and must be checked during the next Kiro session. A manually invoked test command is not evidence of the hook firing. Record the native result below when observed.

## Further Kiro use planned
Read-only scenario MCP tooling, adversarial recovery workflow, actual process rig and UI implementation are later tasks. Their use is not claimed by the existence of this plan.

## M2 continuation — 2026-11-17

- Kiro native session `sess_6627ebb0-295a-406a-9003-4c4fb270e5bc` authored the initial workspace service, HTTP server, HTML/CSS/JS and HTTP tests. Its run completed. Independent initial checks found two HTTP failures and a TypeScript test cast error; this was not a verified release.
- Kiro session `sess_9b20aaf2-e693-4b44-bb6c-a7149db69f16` handles review004; substantive fixes are still being verified. Its native stream emitted invariant-check PostFileSave hook updates with status completed. This establishes actual event firing, not that the full current build passed. Native command/test output must establish that separately.
- A separate attempted hosted-module session `sess_503c21b0-1752-46d7-8d2b-6100906f6b72` hit a native `ClientThrottleError` HTTP429 before code generation. It was stopped with SIGINT. Reconciliation of native logs and disk found a partial src/hosted/oauth.ts written just before shutdown; its companion types and tests remained incomplete. The stopped backend was verified absent before continuation. This was not evidence that credits were exhausted.
- Native interactive /usage displayed KIRO FREE,34.72 of50 plan credits consumed, resetting2026-12-01. Antigravity fallback has not yet been triggered. Noninteractive '/usage' was interpreted as model input and is not a reliable quota check on this installed CLI.
- Codex narrow integration fixes: preserved CommonJS; fixed a test event narrowing; [hidden] CSS specificity; arrival-rate unit formatting. Independent browser readback verified the local stale-action/fresh-action flow. Codex authored review and transport specification documents.

Raw native session streams remain in /private/tmp/blackout-kiro-m2*.jsonl and the local Kiro session store. No live Evaluate traffic has occurred for Blackout.

## Authorized fallback activated

Kiro session `sess_3f0cfc0b-f956-422f-bbb1-b9dc8903a42c` ended with native `UsageLimitReachedError`: monthly usage limit reached (request cc2e4607-f27a-461e-9171-463b722e508a). No paid upgrade was attempted. The founder explicitly authorized Antigravity as the coding fallback when Kiro credits run out. All remaining Kiro writers were stopped and disk state reconciled before fallback ownership. Antigravity edits/tests must be attributed separately. Kiro remains the actual primary author of the specs, core and workspace; incomplete Kiro-generated hosted/capacity files need correction and are not a verified integration.

Antigravity fallback: initial Gemini4ArgonHigh session reported its individual model quota before source edits (reset75h54m), no upgrade attempted. Switched to the available standard Gemini3.8FlashHigh coding model with sandbox and exact workspace trust. The CLI reports pre-existing invalid terminal permission-rule syntax; this project will not alter global permissions. File tools are used for source; Codex runs verification commands. No engine source or credentials are part of the assignment.

Antigravity Gemini3.8FlashHigh authored the final resource projection guard, independent executor feasibility check and node:test capacity regressions. Codex ran the isolated compiler and120tests, all passed, then updated the existing HTTP integration case to choose a feasible throttle after rejecting fresh excess scaling. No hosted calls were made; unfinished SDK files remain excluded from that isolated check.
