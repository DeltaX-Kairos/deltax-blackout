# Requirements Document

## Introduction

This Kiro-generated requirements draft is refined by the reviewed implementation and [M1 verification](../../../../docs/M1-VERIFICATION.md).

Blackout is an incident recovery lab that demonstrates a complete recurrent recovery loop: observe system state, generate typed remediation proposals, inspect feasibility constraints, (optionally) request a bounded external evaluation, recheck the current basis, confirm and apply one action, observe the resulting state, and reconsider. M1 delivers an executable deterministic TypeScript recovery core with two fictional scenarios (queue storm and database pressure), a deterministic state machine, immutable revision history, SHA-256 basis digests, single-use action execution, stale-basis rejection, property-based tests, and a runnable CLI demonstration. The hosted DeltaX Evaluate path is explicitly unconfigured in M1; typed boundaries are prepared but no network calls are made. All workload and telemetry are simulated and labelled as such.

---

## Glossary

- **Recovery_Core**: The TypeScript module that owns the full observe → propose → inspect → (Evaluate boundary) → recheck → approve → apply → observe → reconsider state machine.
- **Scenario**: A named, fully self-contained fictional incident description including initial system state, event stream, seed, and expected termination condition. M1 ships two: Queue_Storm and Database_Pressure.
- **State_Machine**: The pure deterministic function that accepts a `ScenarioState` and a `Tick` and returns the next `ScenarioState` without side effects or external calls.
- **ScenarioState**: An immutable value capturing all observable quantities at a single point in lab time, bound to a revision number and a SHA-256 basis digest.
- **Revision**: A monotonically incrementing integer that identifies each distinct `ScenarioState`. Every mutation of state produces a new revision; prior revisions are never modified.
- **Basis_Digest**: The canonical SHA-256 hex string computed deterministically from a `ScenarioState`. Used to verify that the state at proposal time still matches the state at apply time.
- **Tick**: A discrete, injected unit of lab time. The State_Machine advances only when a `Tick` is supplied; wall-clock time is never read.
- **Clock**: The injected interface that emits `Tick` values. All time-dependent logic inside the Recovery_Core references only the injected Clock, never `Date.now()` or `performance.now()`.
- **RNG**: The injected seeded pseudo-random number generator. All non-deterministic simulation draws use only the injected RNG, never `Math.random()`.
- **Proposal**: A typed, immutable record describing one candidate remediation action, its predicted effects, its stated assumptions, its `operator_reported_support` value in [0, 1], and the `revision` and `Basis_Digest` of the state from which it was generated.
- **Proposal_Source**: The labelled origin of a Proposal. M1 sources are scripted (rule-based). Every Proposal carries a `source` field whose value accurately identifies its origin.
- **Feasibility_Rule**: A named, explicitly coded constraint that the Feasibility_Inspector evaluates against a Proposal and the current `ScenarioState`. Rules include capacity floor, replica availability, maximum resource use, observation freshness, and action applicability.
- **Feasibility_Inspector**: The module that applies all Feasibility_Rules to a Proposal and returns a `FeasibilityResult` containing a `pass` boolean and a list of violated rule names.
- **Action**: A concrete lab operation derived from an approved Proposal, bound to a unique `action_id`, the `revision` and `Basis_Digest` at approval time, and a single-use token.
- **Action_Ledger**: The append-only store of every Action that has been submitted for execution. Used to enforce single-use and detect duplicate `action_id` values.
- **Stale_Basis**: The condition in which the `Basis_Digest` stored in an Action no longer matches the `Basis_Digest` of the current `ScenarioState` at the time of execution. A Stale_Basis causes the Executor to reject the Action without applying it.
- **Executor**: The module that applies an Action to the current `ScenarioState` once and only once, producing a new `ScenarioState` and a `LabReceipt`. The Executor rejects duplicate or stale Actions.
- **LabReceipt**: An immutable record capturing the `action_id`, `revision` before execution, `Basis_Digest` before execution, the applied action description, the resulting `revision`, the resulting `Basis_Digest`, and a `lab_note` field set to the string `"local lab, no hosted evaluation performed"`.
- **Event_Log**: The append-only, causally ordered sequence of `LabEvent` records produced throughout a scenario run. Each event carries a `tick`, a `revision`, a `Basis_Digest`, and a typed event kind.
- **LabEvent**: One entry in the Event_Log. Each entry references the revision and digest of the state that caused it; events are never retroactively modified.
- **Prediction**: The set of expected post-action metric values recorded in a Proposal before execution. Predictions are stored separately from observed results and never overwritten by them.
- **Observed_Result**: The actual metric values read from the `ScenarioState` after an Action is applied. Distinguished from Predictions in every display and data structure.
- **Evaluate_Boundary**: The typed TypeScript interface that describes the shape of a future hosted DeltaX Evaluate request and response. In M1 the boundary is defined but all calls return an `EvaluateResult` with `status: "unconfigured"`. No network requests are issued.
- **EvaluateResult**: The discriminated union `{ status: "unconfigured" } | { status: "selected"; candidate_id: string; trace: HesTrace; receipt: EvaluateReceipt } | { status: "governed_noop_refusal"; trace: HesTrace }`. Only `unconfigured` is reachable in M1.
- **HesTrace**: A typed record holding the twelve HES-G01 through HES-G12 gate assertion values returned by the hosted engine in future milestones.
- **CLI_Runner**: The Node.js script that instantiates the Recovery_Core with a chosen scenario and seed, drives the full recovery loop to termination, prints labelled output to stdout, and exits with code 0 on success.
- **Property_Test**: A fast-check property-based test that generates arbitrary inputs and asserts a universal invariant about the Recovery_Core without making any hosted calls.
- **Invariant_Hook**: The single Kiro hook configured in `.kiro/hooks/` that runs the focused invariant test suite after a file is saved in the `src/` directory.
- **Builder_Report**: The `BUILDER-REPORT.md` file at the workspace root documenting every actual command run, test result, denied tool, and unresolved item produced during M1.

---

## Requirements

### Requirement 1: Deterministic State Machine

**User Story:** As a lab engineer, I want a deterministic state machine with explicit PRNG state, so that I can replay any scenario identically given the same seed and event stream.

#### Acceptance Criteria

1. THE Recovery_Core SHALL accept an injected Clock and an injected RNG as constructor parameters and use no other source of time or randomness.
2. WHEN the State_Machine is called twice with identical `ScenarioState`, identical `Tick`, and identical RNG state, THE State_Machine SHALL return byte-for-byte identical `ScenarioState` values both times.
3. THE State_Machine SHALL be a pure function: it SHALL read only its input parameters and SHALL NOT modify any external mutable state or perform I/O.
4. WHEN the Recovery_Core is initialized with a given integer seed, THE RNG SHALL produce the same sequence of values on every initialization with that seed.
5. THE Recovery_Core SHALL expose a `currentRevision` accessor that returns the monotonically increasing integer revision of the most recent `ScenarioState`.
6. IF the State_Machine receives a `Tick` value less than or equal to the `Tick` of the most recent `ScenarioState`, THEN THE State_Machine SHALL reject the input and return an error indicating out-of-order tick without modifying the current `ScenarioState`.
7. IF the Recovery_Core is initialized without a Clock or RNG argument, THEN THE Recovery_Core SHALL throw an error indicating a missing dependency before accepting any further calls.

---

### Requirement 2: Immutable Revision History and SHA-256 Basis Digests

**User Story:** As a lab engineer, I want every state snapshot to be immutable and content-addressed, so that I can detect when the basis has changed between proposal time and apply time.

#### Acceptance Criteria

1. WHEN the State_Machine produces a new `ScenarioState`, THE Recovery_Core SHALL assign it a revision number exactly one greater than the previous revision number, starting at 1 for the first revision, and SHALL never reuse or modify prior revision numbers.
2. THE Recovery_Core SHALL compute a SHA-256 hex digest of the canonical JSON serialization of each `ScenarioState`, where canonical serialization means UTF-8 encoded JSON with object keys sorted lexicographically and no insignificant whitespace, and store the resulting 64-character lowercase hexadecimal string as the `Basis_Digest` field of that state.
3. WHEN two `ScenarioState` values differ in any field, THE Recovery_Core SHALL produce distinct `Basis_Digest` values for each, using the documented material projection and SHA-256 collision resistance; no absolute mathematical uniqueness guarantee is claimed.
4. FOR ALL valid `ScenarioState` values, serializing then deserializing then recomputing the `Basis_Digest` SHALL yield a digest identical to the one computed during the original storage operation.
5. THE Recovery_Core SHALL make all prior `ScenarioState` revisions accessible by revision number and SHALL not alter any stored revision after creation.
6. IF the State_Machine produces a new `ScenarioState` whose canonical JSON serialization is identical to an already-stored revision, THE Recovery_Core SHALL still assign it the next revision number and store it as a distinct revision entry with its own `Basis_Digest`.
7. IF a revision lookup is requested for a revision number that does not exist, THEN THE Recovery_Core SHALL return an error response indicating the revision was not found without altering any stored state.

---

### Requirement 3: Queue Storm Scenario

**User Story:** As a lab engineer, I want a fully specified Queue Storm scenario, so that I can observe a realistic backpressure incident and validate recovery proposals against it.

#### Acceptance Criteria

1. THE Queue_Storm scenario SHALL initialize with named fictional service components: an API gateway, a message queue, a worker pool, and a database, with explicit simulated metric values for queue depth, worker count, error rate, and database connection count.
2. WHEN the Queue_Storm scenario starts, THE State_Machine SHALL inject a queue-storm event into the Event_Log at tick 0 that records the initial queue depth, worker count, and basis digest.
3. THE Queue_Storm scenario SHALL generate at least two typed Proposal values: one proposing increased worker scaling and one proposing queue throttling, each with stated assumptions and predicted outcome metrics.
4. WHEN a worker-scaling Action is applied to the Queue_Storm scenario, THE Executor SHALL update the worker count in the resulting `ScenarioState` and record the observed metric change separately from the Prediction.
5. WHEN a queue-throttling Action is applied to the Queue_Storm scenario, THE Executor SHALL update the queue ingestion rate in the resulting `ScenarioState` and record the observed metric change separately from the Prediction.
6. THE Queue_Storm scenario SHALL terminate within 100 ticks under any applied recovery action or under no action.

---

### Requirement 4: Database Pressure Scenario

**User Story:** As a lab engineer, I want a fully specified Database Pressure scenario, so that I can observe a replica-availability incident and validate recovery proposals against it.

#### Acceptance Criteria

1. THE Database_Pressure scenario SHALL initialize with named fictional service components: a primary database, one or more read replicas, an application server pool, and a connection pool, with explicit simulated metric values for replica availability, connection count, query latency, and error rate.
2. WHEN the Database_Pressure scenario starts, THE State_Machine SHALL inject a database-pressure event into the Event_Log at tick 0 that records the replica availability, connection count, and basis digest.
3. THE Database_Pressure scenario SHALL generate at least two typed Proposal values: one proposing connection pool reduction and one proposing replica failover, each with stated assumptions and predicted outcome metrics.
4. WHEN a connection-pool-reduction Action is applied to the Database_Pressure scenario, THE Executor SHALL update the connection count in the resulting `ScenarioState` and record the observed metric change separately from the Prediction.
5. WHEN a replica-failover Action is applied to the Database_Pressure scenario, THE Executor SHALL update the replica availability in the resulting `ScenarioState` and record the observed metric change separately from the Prediction.
6. THE Database_Pressure scenario SHALL terminate within 100 ticks under any applied recovery action or under no action.

---

### Requirement 5: Proposal Generation and Labelling

**User Story:** As a lab engineer, I want every proposal to carry accurate source labelling and a complete evidence record, so that I can distinguish scripted lab proposals from future model-generated ones.

#### Acceptance Criteria

1. THE Recovery_Core SHALL generate each Proposal with a `source` field that identifies its origin as `"scripted"` for all M1 proposals and SHALL never use the value `"hosted-evaluate"` or `"model"` in M1.
2. WHEN a Proposal is created, THE Recovery_Core SHALL bind it to the `revision` and `Basis_Digest` of the `ScenarioState` from which it was derived.
3. THE Recovery_Core SHALL store the Proposal's `operator_reported_support` as a number in the closed interval [0, 1].
4. THE Recovery_Core SHALL store Prediction values in a `predicted_effects` field on the Proposal and SHALL never overwrite those values after the Proposal is created.
5. WHEN a Proposal is generated, THE Recovery_Core SHALL record a `ProposalCreated` event in the Event_Log containing the proposal ID, source label, revision, and basis digest.

---

### Requirement 6: Feasibility Inspection

**User Story:** As a lab engineer, I want every proposal to pass through explicitly coded feasibility rules before an action is confirmed, so that the lab rejects unsafe or inapplicable operations.

#### Acceptance Criteria

1. THE Feasibility_Inspector SHALL evaluate each of the following named rules against every Proposal before it may become an Action: `capacity-floor`, `replica-availability`, `max-resource-use`, `observation-freshness`, and `action-applicability`.
2. WHEN any Feasibility_Rule is violated, THE Feasibility_Inspector SHALL return a `FeasibilityResult` with `pass: false` and a list containing the names of all violated rules.
3. WHEN all Feasibility_Rules pass, THE Feasibility_Inspector SHALL return a `FeasibilityResult` with `pass: true` and an empty violated-rules list.
4. WHEN the `observation-freshness` rule is evaluated and the age of the `ScenarioState` referenced by the Proposal exceeds the configured freshness threshold in ticks, THE Feasibility_Inspector SHALL include `observation-freshness` in the violated-rules list.
5. WHEN the `capacity-floor` rule is evaluated and the proposed action would reduce any resource metric below its defined minimum floor, THE Feasibility_Inspector SHALL include `capacity-floor` in the violated-rules list.
6. WHEN a Proposal fails feasibility inspection, THE Recovery_Core SHALL record a `FeasibilityRejected` event in the Event_Log containing the proposal ID, the violated rule names, revision, and basis digest.

---

### Requirement 7: Stale-Basis Rejection

**User Story:** As a lab engineer, I want action execution to be rejected when the system state has changed since the action was approved, so that the lab never applies a decision made against obsolete information.

#### Acceptance Criteria

1. WHEN the Executor receives an Action and the `Basis_Digest` stored in the Action does not match the `Basis_Digest` of the current `ScenarioState`, THE Executor SHALL reject the Action without modifying any state.
2. WHEN the Executor rejects an Action due to stale basis, THE Executor SHALL return a `StaleBasiRejection` result containing the Action's stored digest, the current digest, and the current revision, and SHALL record a `StaleBasiRejected` event in the Event_Log.
3. WHEN an intervening event advances the scenario revision between proposal approval and execution attempt, THE Recovery_Core SHALL present the updated `ScenarioState` and updated feasible proposals to the caller before a new Action may be confirmed.
4. THE CLI_Runner SHALL demonstrate one complete stale-basis rejection cycle: propose against state at revision N, inject an event that advances state to revision N+1, attempt execution against the stale N digest, observe rejection, re-observe current state, and confirm a new Action against the fresh basis.

---

### Requirement 8: Single-Use Action Execution

**User Story:** As a lab engineer, I want each action to execute exactly once, so that the lab cannot accidentally apply the same remediation twice.

#### Acceptance Criteria

1. THE Action_Ledger SHALL record every Action submitted to the Executor by its `action_id` immediately upon submission.
2. WHEN the Executor receives an Action whose `action_id` is already present in the Action_Ledger, THE Executor SHALL reject the Action without modifying any state and SHALL return a `DuplicateActionRejection` result.
3. WHEN the Executor successfully applies an Action, THE Action_Ledger SHALL mark the `action_id` as consumed, and no subsequent call with the same `action_id` SHALL succeed.
4. THE Recovery_Core SHALL generate each `action_id` as a value that is unique within the scenario run; the same `action_id` SHALL never be reused across different Actions in the same run.

---

### Requirement 9: Append-Only Causal Event Log

**User Story:** As a lab engineer, I want an append-only event log that records every state transition with its causal context, so that I can audit the full history of the scenario run.

#### Acceptance Criteria

1. THE Event_Log SHALL accept only append operations; previously written `LabEvent` entries SHALL never be modified or deleted.
2. WHEN any state transition occurs, THE Recovery_Core SHALL append a `LabEvent` to the Event_Log before the transition is considered complete.
3. THE Event_Log SHALL store each `LabEvent` with the `tick`, `revision`, and `Basis_Digest` of the state that caused the event.
4. WHEN the Event_Log is serialized to JSON, THE Recovery_Core SHALL produce a valid JSON array where entry order matches append order, and parsing then re-serializing SHALL produce an identical array (round-trip property).
5. THE Event_Log SHALL contain at least the following typed event kinds: `ScenarioStarted`, `TickAdvanced`, `ProposalCreated`, `FeasibilityRejected`, `ActionApproved`, `ActionApplied`, `StaleBasiRejected`, `DuplicateActionRejected`, and `ScenarioTerminated`.

---

### Requirement 10: Predicted vs. Observed Result Separation

**User Story:** As a lab engineer, I want predictions and actual observations to be stored and displayed separately, so that I can compare expected outcomes to real lab outcomes.

#### Acceptance Criteria

1. THE Recovery_Core SHALL store Prediction values in the `predicted_effects` field of a Proposal and SHALL store Observed_Result values in the `observed_effects` field of the corresponding `LabReceipt`.
2. THE Recovery_Core SHALL never copy or overwrite `predicted_effects` values into `observed_effects` or vice versa; the two fields SHALL remain independently populated.
3. THE CLI_Runner SHALL display, for each applied Action, both the Prediction from the Proposal and the Observed_Result from the `LabReceipt`, clearly labelled as `"predicted"` and `"observed"` respectively.
4. WHEN a Proposal is created but no Action is applied from it, THE Recovery_Core SHALL retain the Proposal's `predicted_effects` unmodified and SHALL record no `observed_effects` for that Proposal.

---

### Requirement 11: Bounded Run Termination

**User Story:** As a lab engineer, I want every scenario run to terminate within a defined tick limit, so that the lab never hangs or runs indefinitely.

#### Acceptance Criteria

1. THE Recovery_Core SHALL enforce a configurable maximum tick count per scenario run with a default of 100 ticks.
2. WHEN the scenario reaches the maximum tick count without reaching its natural termination condition, THE State_Machine SHALL transition to a `terminated-by-limit` terminal state and THE Recovery_Core SHALL append a `ScenarioTerminated` event to the Event_Log with reason `"tick-limit-reached"`.
3. WHEN the scenario reaches its natural termination condition before the tick limit, THE Recovery_Core SHALL transition to a `terminated-naturally` terminal state and append a `ScenarioTerminated` event with reason `"condition-met"`.
4. WHILE the scenario is in any terminal state, THE State_Machine SHALL reject further tick advances and SHALL return the terminal `ScenarioState` unchanged.

---

### Requirement 12: DeltaX Evaluate Typed Boundary (Unconfigured in M1)

**User Story:** As a lab engineer, I want typed interfaces for the future DeltaX Evaluate integration, so that M1 code compiles cleanly against the boundary and the unconfigured state is explicit in every code path.

#### Acceptance Criteria

1. THE Evaluate_Boundary SHALL define TypeScript interfaces for `EvaluateRequest`, `EvaluateResponse`, and `EvaluateResult` matching the field shapes specified in `docs/EVALUATE-INTEGRATION.md`: `profile_id`, `objective`, `context`, `candidates` on the request; `selected` or `governed_noop_refusal` discriminant and `trace` on the response.
2. THE Evaluate_Boundary SHALL define the `HesTrace` type as a record of the twelve gates HES-G01 through HES-G12.
3. THE Evaluate_Boundary SHALL define an `EvaluateAdapter` interface with a single method `evaluate(request: EvaluateRequest): Promise<EvaluateResult>`.
4. THE Recovery_Core SHALL accept an injected `EvaluateAdapter` parameter and, in M1, SHALL use a `NullEvaluateAdapter` implementation that returns `{ status: "unconfigured" }` without issuing any network request.
5. WHEN the `NullEvaluateAdapter` returns `{ status: "unconfigured" }`, THE CLI_Runner SHALL print the line `"[Evaluate] local lab, no hosted evaluation performed"` to stdout.
6. THE Recovery_Core SHALL never treat an `EvaluateResult` with `status: "unconfigured"` as a selection or as a successful evaluation result.
7. IF the injected EvaluateAdapter is absent, the outcome is unconfigured. An adapter exception or timeout remains error/unknown and is never promoted to success or silently retried.

---

### Requirement 13: CLI Runner and Demo Output

**User Story:** As a lab engineer, I want a runnable CLI script that drives a complete scenario end-to-end and prints clearly labelled output, so that the M1 demo can be reviewed without editing any JSON.

#### Acceptance Criteria

1. THE CLI_Runner SHALL accept a scenario name and an integer seed as command-line arguments and SHALL initialize the Recovery_Core with those values.
2. WHEN the CLI_Runner completes a full scenario run, THE CLI_Runner SHALL print each of the following sections to stdout in order: scenario name and seed, tick-by-tick state summary, generated proposals with source labels, feasibility results, the stale-basis rejection demonstration, the applied action with both Prediction and Observed_Result, the full Event_Log as a formatted JSON array, and the Evaluate boundary status line.
3. THE CLI_Runner SHALL label every printed state metric as `"[simulated]"` and every proposal source as `"[scripted]"`.
4. WHEN the CLI_Runner completes without error, THE CLI_Runner SHALL exit with process exit code 0.
5. WHEN the CLI_Runner encounters an unrecoverable error, THE CLI_Runner SHALL print a human-readable error message to stderr and SHALL exit with process exit code 1.
6. THE CLI_Runner SHALL complete a full two-scenario demo run within 10 seconds of wall-clock time on a standard development machine.

---

### Requirement 14: Property-Based Tests

**User Story:** As a lab engineer, I want property-based tests covering core invariants, so that I can verify correctness across a wide range of inputs without hard-coding demo assertions.

#### Acceptance Criteria

1. THE Property_Test suite SHALL use the fast-check library and SHALL make zero hosted API calls.
2. THE Property_Test suite SHALL include a determinism property: for any valid seed and event stream, running the State_Machine twice with identical inputs SHALL produce identical `ScenarioState` outputs.
3. THE Property_Test suite SHALL include a no-mutation-on-rejection property: for any Action submitted to the Executor that is rejected (stale basis or duplicate), the `ScenarioState` before and after the rejection call SHALL be referentially equal or deeply equal.
4. THE Property_Test suite SHALL include an observation-freshness property: for any Proposal generated from a `ScenarioState` whose age in ticks exceeds the configured freshness threshold, the Feasibility_Inspector SHALL return `pass: false` with `observation-freshness` in the violated-rules list.
5. THE Property_Test suite SHALL include an action-deduplication property: for any `action_id`, submitting the same Action twice to the Executor SHALL result in a `DuplicateActionRejection` on the second submission regardless of the current `ScenarioState`.
6. THE Property_Test suite SHALL include a capacity-constraint property: for any Action that would reduce a resource metric below its defined floor, the Feasibility_Inspector SHALL return `pass: false` with `capacity-floor` in the violated-rules list.
7. THE Property_Test suite SHALL include a bounded-termination property: for any valid seed and scenario configuration with a tick limit of at most 200, the State_Machine SHALL reach a terminal state before or at the tick limit.
8. THE Property_Test suite SHALL include an event-chain-causality property: for any completed scenario run, every `LabEvent` in the Event_Log at index i SHALL have a `tick` value greater than or equal to the `tick` value of the event at index i-1, and the `revision` values SHALL be non-decreasing.
9. THE Property_Test suite SHALL include an Event_Log round-trip property: for any completed scenario run, serializing the Event_Log to JSON and deserializing it SHALL produce a list of `LabEvent` values that are deeply equal to the originals.
10. THE Property_Test suite SHALL include a Basis_Digest round-trip property: for any `ScenarioState`, serializing to canonical JSON then recomputing the SHA-256 digest SHALL reproduce the original `Basis_Digest`.

---

### Requirement 15: Kiro Invariant Hook

**User Story:** As a lab engineer, I want a Kiro hook that runs the focused invariant test suite automatically after source files are saved, so that regressions are caught immediately during development.

#### Acceptance Criteria

1. THE Invariant_Hook SHALL be defined as a single JSON file at `.kiro/hooks/invariant-check.json` using the documented Kiro v1 hook schema.
2. THE Invariant_Hook SHALL trigger on the `PostFileSave` event and SHALL match only files whose paths begin with `src/`.
3. WHEN the Invariant_Hook fires, THE Invariant_Hook SHALL execute the project's focused invariant test command (e.g., `npm run test:invariants`) as a shell command action.
4. THE Builder_Report SHALL record whether the Invariant_Hook automatic event actually fired during M1 development and SHALL report the actual exit code and output observed.

---

### Requirement 16: Builder Report

**User Story:** As a lab engineer, I want a BUILDER-REPORT.md that accurately documents every command, test outcome, and unresolved item from the M1 build, so that the evidence record is complete and not fabricated.

#### Acceptance Criteria

1. THE Builder_Report SHALL be located at `BUILDER-REPORT.md` in the workspace root and SHALL be updated after each significant build step.
2. THE Builder_Report SHALL list every shell command actually executed during M1, with its exit code and a brief description of its result.
3. THE Builder_Report SHALL list every property-based test by name and SHALL report its actual pass/fail status and, for any failing test, the fast-check counterexample.
4. THE Builder_Report SHALL list every tool call that was denied or could not be completed, with the reason.
5. THE Builder_Report SHALL list all unresolved items at the end of the M1 checkpoint, including any work deferred to M2 or later.
6. THE Builder_Report SHALL contain no fabricated test outcomes, no fabricated command outputs, and no claims of hosted Evaluate results.
