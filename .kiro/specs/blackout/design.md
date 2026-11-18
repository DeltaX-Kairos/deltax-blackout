# Design — Blackout M1

## Overview

M1 delivers a deterministic TypeScript recovery core with two fictional incident scenarios, a deterministic state machine, immutable revision history, SHA-256 basis digests, single-use action execution, stale-basis rejection, a typed (unconfigured) DeltaX Evaluate boundary, an append-only causal event log, property-based tests, and a labelled CLI demonstration. No network calls are made.

---

## Module structure

```
src/
  types.ts            — All shared types and discriminated unions
  digest.ts           — Canonical JSON serialiser + SHA-256 basis digest
  clock.ts            — Clock interface + TickClock implementation
  rng.ts              — RNG interface + seeded Mulberry32 implementation
  state-machine.ts    — Pure transition function advance(state, tick, rng) → state
  proposals.ts        — Scripted proposal generator per scenario
  feasibility.ts      — FeasibilityInspector: 5 named rules
  action-ledger.ts    — Append-only action ledger (single-use guard)
  executor.ts         — Executor: stale-basis + duplicate guards, applies action
  event-log.ts        — Append-only LabEvent log
  evaluate-boundary.ts — EvaluateAdapter interface + NullEvaluateAdapter
  recovery-core.ts    — Orchestrator wiring all modules
  scenarios/
    queue-storm.ts    — Queue Storm scenario definition
    database-pressure.ts — Database Pressure scenario definition
  cli.ts              — CLI runner (entry point)
tests/
  invariants.test.ts  — Property-based tests (fast-check)
  unit.test.ts        — Deterministic unit tests
```

---

## Key design decisions

### SPEC-REVIEW-001 issue 1 — Digest self-reference

The `Basis_Digest` field is **excluded** from the canonical serialisation used to compute the digest. The projection serialised is every `ScenarioState` field except `basisDigest` itself, `eventLog`, and `revisionHistory` (unbounded arrays). This avoids self-reference and keeps the hash stable across replay. The requirement language in requirements.md §2.3 says "two states with differing field values" share no digest; this is a practical engineering goal, not an absolute mathematical theorem — we do not claim SHA-256 is collision-free as a theorem.

### SPEC-REVIEW-001 issue 2 — Provider outcome preservation

`EvaluateResult` is a discriminated union with three variants: `unconfigured`, `selected`, and `governed_noop_refusal`. An absent adapter returns `unconfigured`. An adapter exception/timeout returns `{ status: "error", detail: string }` (a fourth variant added per the review). These are never promoted to `selected`. M1 makes no calls; only `unconfigured` is reachable.

### SPEC-REVIEW-001 issue 3 — Hosted response shapes

`EvaluateResponse` matches the documented contract exactly:
- `outcome`: `"selected"` | `"governed_noop_refusal"`
- `selected_candidate_id`: string (present when outcome is `"selected"`)
- `trace.lambda_decisions`: ordered array of exactly 12 `HesGateRecord` entries (HES-G01..HES-G12)
- `commercial_receipt`: `EvaluateReceipt` on the transport response; the product wrapper is separate
- Authority flags: all `false`

A product-level `EvaluateResult` wraps transport but does not rename fields.

### SPEC-REVIEW-001 issue 5 — Rejected attempts and state preservation

A rejected action (stale basis or duplicate) appends an audit event and may consume the action ID in the ledger, but **does not modify** `operationalState`, `tick`, or `revision`. State is structurally immutable (new objects on every transition); rejection returns the same current state reference.

### SPEC-REVIEW-001 issue 6 — Units and temporal causality

- **Tick**: 10 simulated seconds. `tickSeconds = 10`.
- **Request arrival rate**: requests per tick (integer).
- **Queue depth**: number of queued messages (integer).
- **Worker count**: number of active workers (integer, floor=1).
- **DB connections**: number of open connections (integer, floor=1).
- **Replica availability**: fraction [0, 1].
- Predictions are recorded at proposal time. Observed results are read from the state **after** the action is applied. These are stored in separate fields and never merged.
- Termination by tick limit is recorded as `reason: "tick-limit-reached"` and is **not** a recovery success.

### SPEC-REVIEW-001 issue 4 — Hook schema

The hook is defined in `.kiro/hooks/invariant-check.json` using the verified current schema: version is the string v1, hooks is an array, trigger is PostFileSave, matcher is a regex string, and action.type is command. The portable command compiles with local TypeScript, then runs only dist/tests/invariants.test.js. Configuration authorship and actual automatic firing are recorded in docs/KIRO-EVIDENCE.md.

---

## State shape

```typescript
interface ScenarioState {
  scenarioId: string;
  tick: number;              // current tick number (integer ≥ 0)
  revision: number;          // monotonic integer starting at 1
  basisDigest: string;       // SHA-256 hex of canonical projection
  status: "running" | "terminated-naturally" | "terminated-by-limit";
  terminationReason?: "condition-met" | "tick-limit-reached";
  operationalState: OperationalState;  // scenario-specific metrics
}
```

The basis digest is SHA-256 over canonical `{ scenarioId, tick, operationalState }`. Revision is checked separately at execution. The digest itself, revision history and event log are excluded. The transition uses explicit seeded PRNG state and is deterministic; it does not claim a mutable PRNG is a pure function.

---

## Feasibility rules (all 5 required)

| Rule name | Condition that causes failure |
|---|---|
| `capacity-floor` | Action would reduce any metric below its defined floor |
| `replica-availability` | Required replicas are unavailable for the proposed action |
| `max-resource-use` | Action would push any resource above its ceiling |
| `observation-freshness` | State age (currentTick − proposalTick) > freshnessThreshold |
| `action-applicability` | Proposed action type is not applicable to current scenario state |

---

## Stale-basis rejection demo (CLI)

1. Advance to tick T, generate proposals on revision N.
2. Inject an intervening event (advance one more tick) → revision N+1, new digest.
3. Attempt to execute action bound to revision-N digest → `StaleBasiRejected`.
4. Re-observe current state at revision N+1.
5. Generate fresh proposals, confirm, execute → `ActionApplied`.

---

## Evaluate boundary

```typescript
type EvaluateResult =
  | { status: "unconfigured" }
  | { status: "selected"; candidate_id: string; trace: HesTrace; receipt: EvaluateReceipt }
  | { status: "governed_noop_refusal"; trace: HesTrace; receipt: EvaluateReceipt }
  | { status: "error"; detail: string };
```

M1: only `unconfigured` is returned. CLI prints `[Evaluate] local lab, no hosted evaluation performed`.

---

## Test plan

All tests run with zero network. Fast-check properties cover:

1. **Determinism**: same seed + events → identical states
2. **No mutation on rejection**: state unchanged after any rejection
3. **Observation freshness**: stale proposals fail feasibility
4. **Action deduplication**: second submit returns DuplicateActionRejection
5. **Capacity constraint**: below-floor actions fail feasibility
6. **Bounded termination**: always terminates ≤ tick limit
7. **Event-chain causality**: ticks non-decreasing, revisions non-decreasing
8. **Event log round-trip**: JSON serialize → deserialize → deeply equal
9. **Basis digest round-trip**: canonical JSON → SHA-256 → same digest

---

## Toolchain

- Node v22.23.2
- npm via `/private/tmp/blackout-toolchain/package/bin/npm-cli.js` (npm 10.9.2)
- TypeScript 5.x, `ts-node` for running scripts
- `fast-check` for property tests
- No test framework bundler; use Node's built-in `node:test` runner

---

## CLI invocation (target)

```
node dist/cli.js --scenario queue-storm --seed 42
node dist/cli.js --scenario database-pressure --seed 99
```

Or via ts-node during development:

```
npx ts-node src/cli.ts --scenario queue-storm --seed 42
```
