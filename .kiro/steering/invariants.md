# Blackout invariants — focused verification

This steering document defines the core invariants that must hold across all Blackout source changes.

## Immutability invariants

1. **Rejected actions never mutate state**: A stale-basis, duplicate, or unconfirmed action must not modify any operational metrics or revision number.
2. **Deep-frozen historical snapshots**: No stored ScenarioState, Proposal, or LabReceipt may be mutated through getters or external references.
3. **Digest stability**: Two states with identical (scenarioId, tick, operationalState) must produce identical basisDigest, regardless of revision number.

## Ledger invariants

4. **Single-use action consumption**: An action.actionId may be marked consumed exactly once; subsequent submissions must be rejected as duplicate.
5. **Monotonic terminal state**: Once an action is marked consumed or rejected-terminal, it must never transition back to a non-terminal state.
6. **Confirmation binding**: An Action's payloadDigest must match the stored confirmation digest recomputed from { actionType, parameters, basisRevision, basisDigest }.

## Proposal invariants

7. **ProposalId binding**: action.proposalId must exactly match confirmation.proposalId; changing only this field must cause rejection.
8. **Stale proposal rejection**: approve() must reject proposals whose basisDigest does not match the CURRENT state; callers must re-propose after state changes.
9. **Feasibility precondition**: approve() must reject proposals that fail feasibility checks against the current state.

## Execution invariants

10. **Basis freshness**: execute() must check both basisRevision and basisDigest; mismatches must be rejected before any mutation.
11. **Parameter validation**: Invalid parameters (non-finite, fractional, negative resource counts, unknown action types) must be rejected; never clamped or coerced.
12. **Terminal state guard**: No action may execute against a scenario in terminal status (terminated-naturally or terminated-by-limit).

## Observable causality

13. **Event ordering**: ScenarioStarted must be the first event; ScenarioTerminated must be the last event after termination.
14. **Revision monotonicity**: Each applied action or tick advancement must increment the revision counter exactly once.
15. **Tick sequence**: advanceTick() must reject out-of-order tick requests and not mutate state for already-terminal scenarios.

## Evaluate boundary

16. **Unconfigured ≠ error**: An absent adapter returns status "unconfigured"; exceptions/timeouts return status "error"; neither is promoted to "selected".
17. **Timeout cleanup**: SafeEvaluateAdapter must clear its timeout handle in a finally block to prevent lingering timers.
18. **Local lab labeling**: All M1 receipts must carry labNote "local lab, no hosted evaluation performed"; no receipt may claim hosted evaluation occurred.

## Deterministic termination

19. **Bounded execution**: Given a tickLimit, the scenario must terminate at or before that tick with status terminated-by-limit or terminated-naturally.
20. **RNG determinism**: Two runs with identical (scenarioName, seed, tickLimit, action sequence) must produce identical final state and event log.

---

**Verification scope**: These invariants are checked via focused unit tests and property-based tests. The `test:invariants` script runs a dedicated test suite. The PostFileSave hook (see .kiro/hooks/invariant-check.json) automatically triggers invariant verification when TypeScript source files change.

**Evidence preservation**: Actual test outcomes are reported in BUILDER-REPORT.md. Do not fabricate test results or hook firing evidence.
