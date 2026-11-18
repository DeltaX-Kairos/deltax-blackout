# Blackout M1 checkpoint tasks

Reconciled by Codex against actual files and independent verification after Kiro implementation. Initial generated function signatures were refined during review; source APIs and M1-VERIFICATION.md are authoritative for this checkpoint.

- [x] Project scaffold, pinned dependency lockfile and consistent CommonJS build/test/demo commands.
- [x] Typed scenario states, proposals, actions, events, receipts and unconfigured Evaluate seam.
- [x] Documented material SHA-256 projection; revision checked separately.
- [x] Explicit lab ticks and seeded deterministic PRNG, without a false pure-function claim.
- [x] Two fictional scenarios: queue storm and database pressure.
- [x] Five inspectable feasibility rules and bounded termination.
- [x] Recorded confirmations, actual executable-payload verification, proposal-ID match and monotonic consumed-action state.
- [x] Rejection of stale, terminal, unconfirmed, malformed and replayed actions without operational state mutation.
- [x] Defensive state/history access and causal event/receipt history.
- [x] Runnable CLI with explicit simulated/scripted/unconfigured labels; both demos independently observed recovering.
- [x] Nine fast-check properties and focused regressions; 50 tests total passed.
- [x] Type check and actual package commands passed; results recorded in docs/M1-VERIFICATION.md.
- [x] Kiro-authored steering and attributed builder/reviewer report.
- [x] Valid portable PostFileSave hook configuration, authored by Codex during configuration review.
- [ ] Observe the automatic hook firing in a completed Kiro session. The attempted probe did not produce native completion evidence; a manual test run is not proof of hook execution.

## Follow-on milestones

- [ ] Browser workspace and local service API.
- [ ] Exact current hosted Evaluate transport, dedicated credential and bounded live verification.
- [ ] Kiro MCP/adversarial workflow and real disposable service rig.
- [ ] User testing, public source/license release, stable judge hosting, public video and final submission.
