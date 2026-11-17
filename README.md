# Blackout

A Kiroween 2026 project built with Kiro, using hosted DeltaX Evaluate in an incident recovery loop.

**Product hypothesis:** recovery agents need to reconsider an action when the evidence changes between diagnosis and execution. Blackout makes that transition runnable and inspectable in a deterministic service lab.

A judge triggers a cascading failure, watches alternatives form, inspects the hosted Evaluate response, changes the system before execution, and sees a stale action stopped and recovery reconsidered against fresh evidence.

## M1 Status: Local core verified

The local M1 core is verified. Automatic Kiro hook observation is recorded separately in docs/KIRO-EVIDENCE.md. The deterministic recovery core, two scenarios (queue-storm and database-pressure), proposal generation, feasibility checks, stale-basis rejection, single-use action execution, and full event/receipt history are implemented and tested.

### Build and Run

```bash
# Install dependencies (Node 22+ required)
npm install

# Compile TypeScript to dist/
npm run build

# Run all tests (50 tests total)
npm test

# Run only unit tests
npm run test:unit

# Run only invariant tests
npm run test:invariants

# Run queue-storm demo (seed 42, terminates ~tick 30)
npm run demo:queue-storm

# Run database-pressure demo (seed 99, terminates ~tick 25)
npm run demo:db-pressure

# Type-check without building
npm run typecheck
```

On this Mac, the pre-existing npm launcher is broken. Verification used the official npm 10.9.2 CLI at `/private/tmp/blackout-toolchain/package/bin/npm-cli.js`, invoked with Node, without changing the global installation. On a normal Node/npm installation, the commands above work directly.

### What Works

- **Deterministic state machine**: Fixed seed produces identical outcomes across runs
- **Two scenarios**: queue-storm (message backlog) and database-pressure (replica failover)
- **Proposal generation**: Scripted proposals with typed parameters and predicted effects
- **Feasibility rules**: capacity-floor, replica-availability, max-resource-use, observation-freshness, action-applicability
- **Approval binding**: Actions carry confirmed proposal payload digest; tampering is rejected
- **Stale-basis rejection**: Changing state between approval and execution rejects the action
- **Single-use execution**: Duplicate action IDs are rejected; consumed state is monotonic
- **Deep immutability**: All historical snapshots are frozen; getters return defensive copies
- **Event causality**: Full append-only event log from ScenarioStarted to ScenarioTerminated
- **Bounded termination**: Scenarios respect tickLimit; deterministic RNG ensures reproducibility
- **Evaluate boundary**: Typed but unconfigured for M1; no network calls made

### Test Coverage

- 50 tests total: nine fast-check property tests plus focused examples and regressions covering state transitions, freshness, confirmation binding, replay, immutability, outcome history and bounded termination
- SafeEvaluateAdapter timeout cleanup regression tests
- ProposalId mismatch rejection regression test

### M1 Limitations

- **No hosted Evaluate calls**: The adapter returns `{ status: "unconfigured" }`. M2+ will integrate the real API per docs/EVALUATE-INTEGRATION.md.
- **No UI**: CLI text output only. M2 adds browser timeline and evidence viewer.
- **No real workload**: Metrics are simulated via deterministic state transitions. M4 adds measured process telemetry.

### Evidence and Traceability

- Kiro is the primary author of the core, scenarios, tests, specs and steering. Codex authored the project brief and applied narrow launch/hook configuration corrections; see docs/KIRO-EVIDENCE.md for attribution.
- Builder report: see BUILDER-REPORT.md for actual commands, test results, and session evidence
- Specifications: requirements, design, and tasks are tracked in project docs

---

## Project Documentation

- [Build brief](BUILD-BRIEF.md)
- [Competition review](docs/COMPETITION-REVIEW.md)
- [Project and judging plan](docs/PROJECT-PLAN.md)
- [Hosted Evaluate contract reference](docs/EVALUATE-INTEGRATION.md)
- [Kiro evidence ledger](docs/KIRO-EVIDENCE.md)

Keep this repository private during development. Before contest submission, prepare the required public open-source release, executable demo and public video for founder approval. The proprietary Evaluate engine remains hosted; disclose it as a pre-existing dependency.
