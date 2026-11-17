# M1 local verification

Verified locally by Codex after Kiro implementation and focused review. This is an initial development checkpoint, not a completed Kiroween submission.

## Actual results
- Type check: `node /private/tmp/blackout-toolchain/package/bin/npm-cli.js run typecheck` — exit 0.
- Package test command: `node /private/tmp/blackout-toolchain/package/bin/npm-cli.js test` — exit 0, 50 tests passed, zero failed/skipped. This command recompiles then runs the compiled tests. Nine tests use fast-check; the remainder cover focused examples and regressions.
- Queue demo: `run demo:queue-storm` via the same npm CLI — exit 0, seed42, recovery at tick30, 32 revisions, 42 events.
- Database demo: `run demo:db-pressure` — exit 0, seed99, recovery at tick25, 27 revisions, 37 events.
- Both demonstrations explicitly report simulated telemetry, scripted proposals and unconfigured hosted Evaluate. No hosted API call was made.

## Review fixes exercised
Actual executable payload is recomputed against recorded confirmation; proposal identity is checked separately. Revision plus material digest must remain current. Consumed action state is monotonic. Rejected and replayed actions cannot alter operational state. Returned history/state is copied or frozen. Invalid ticks/parameters are rejected. Provider timeout/error remains distinct from missing configuration, and timeout timers are cleared.

## Reproduction and environment
Node 22.23.2; official npm 10.9.2 was extracted to an isolated temporary toolchain with registry SHA-512 integrity verified because this Mac's existing npm wrapper was broken. No global repair was applied. Package scripts use local tsc directly and CommonJS consistently. Normal npm installations can use README commands. Dependencies are pinned in package-lock.json.

## Evidence limits
Hosted Evaluate transport/credential, real model proposal generation, browser UX, actual workload rig, judge hosting, public source/license release, user study and submission remain later milestones. Local test success does not establish these capabilities. The configured Kiro hook and actual automatic hook firing are tracked separately in KIRO-EVIDENCE.md.
