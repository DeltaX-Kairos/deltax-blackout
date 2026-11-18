# Blackout final builder and independent verification report

Kiro is the primary original builder. It authored the specifications, core model/executor, scenario implementations, initial browser workspace and invariant/example/regression tests. Codex coordinated product requirements and review, ran the independent checks and applied narrow integration/configuration/display corrections. Actual Kiro session and hook evidence is recorded in `docs/KIRO-EVIDENCE.md`.

After Kiro returned a native monthly `UsageLimitReachedError`, the founder explicitly authorized Antigravity as the fallback. Antigravity completed the hosted SDK/controller, resource guard, measured process rig, recorded-evidence MCP observer and release configuration in bounded assignments. No paid model upgrade or global permission repair occurred. Codex ran verification; generated reports were not substituted for command results.

The original capture tree passed290automated tests. Two functional browser reviews and two final-recording reviews reached the actual hosted DeltaX Evaluate service; all four completed. The final uninterrupted take demonstrates stale rejection, a fresh resource gate, explicit confirmed recovery, real worker acknowledgements and cleanup. See `docs/LIVE-VERIFICATION.md` for observed values and limitations.

Narrow Codex corrections included CommonJS launch compatibility, strict optional schema normalization, response/test type fixes, durable export provenance, consumed/stale display labels, rig historical projections and closed-resource display, HTTPS origin integration and container asset paths. Codex did not copy or implement proprietary Evaluate engine internals. The service is called through its approved customer API.

Earlier failures, denied hook writes, quota exhaustion and incomplete checkpoints are retained in the milestone/review documents. PostFileSave and SessionStart hooks have actual native completion events. The observer has real protocol tests, but no native Kiro model invocation of an MCP tool is claimed after quota exhaustion.

The dedicated credential is saved in Mac Passwords and a private local server file. Secrets and the durable reservation ledger are excluded from Git and child environments. The later approved release deployed the app on AWS, made its source public and published the corrected video. Contest registration and submission remain separate; see docs/HOSTED-RELEASE.md for the current release evidence.

## Bounded Judging Allowance Update (Antigravity Fallback)
- **Attribution**: Implemented by Antigravity (Gemini 4 Hydrogen (High)) using file tools only (`read_file`, `edit_file`) per the founder-authorized bounded assignment.
- **Scope & Changed Files**:
  - `src/release-config.ts`: Added `resolveHostedAttemptLimits`, `INVALID_ATTEMPT_LIMITS_ERROR`, `DEFAULT_MAX_TOTAL_ATTEMPTS` (10), `DEFAULT_MAX_BROWSER_ATTEMPTS` (2), `MAX_TOTAL_ATTEMPTS_CEILING` (100), and `MAX_BROWSER_ATTEMPTS_CEILING` (6). Parses operator-only `BLACKOUT_MAX_TOTAL_ATTEMPTS` (canonical decimal `1..100`) and `BLACKOUT_MAX_BROWSER_ATTEMPTS` (canonical decimal `1..6`), defaults when absent, and rejects empty, malformed, whitespace, leading-zero, fraction, exponent, zero, negative, out-of-range, non-string, and `browser > total` values with one fixed sanitized error without echoing input.
  - `src/server.ts`: Wired `resolveHostedAttemptLimits(process.env)` into the default `HostedController` inside `createServer`, preserving explicitly injected controllers (`hostedController ?? service.hostedController`) and never reading limit configuration from requests.
  - `tests/release-config.test.ts`: Added offline unit tests for defaults, valid canonical decimal limits (including `100/6`), invalid inputs, `browser > total`, and canary non-echo verification.
  - `tests/hosted-workspace.test.ts`: Added offline integration tests using `ReservationLedger` and synthetic fixtures covering real default controller `100/6` public status via `GET /api/live/status` with 6 prior completed reservations retained, persistence across restarts (per-identity counts up to 6, 429 enforcement on 7th, unknown lock retention, 1-active concurrency), preservation of explicitly injected controllers, request parameter immunity, and fail-closed rejection of invalid limit env configuration.
  - `BUILDER-REPORT.md`: Recorded this attribution, changed files, denied/prohibited tool status, and unverified build/test status.
- **Commands / Tests Run**: None. Shell execution (`run_command`) was prohibited by the task instructions; Codex will run `tsc` build/typecheck and tests.
- **Unresolved / Pending Verification**: TypeScript compilation (`npm run typecheck` / `npm run build`) and offline test execution (`npm test` / `npm run test:hosted`) remain pending Codex verification.

## Independent release verification (Codex)

The allowance update compiled and passed 350 offline tests in 50 suites, zero failed/skipped/cancelled. Codex updated Zod to pinned 4.6.7 after npm reported GHSA-mrhx-c7xc-m3w5; the subsequent npm audit reported zero vulnerabilities. These commands were run by Codex, not claimed as Antigravity output. Public HTTPS rehearsal exports and the exact reservation history remain privately retained; sanitized observations are published in docs/evidence/public-deployment-summary.json.
