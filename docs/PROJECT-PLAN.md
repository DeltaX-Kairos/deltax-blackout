# Blackout project and judging plan

## Audience and product claim
For platform and integration engineers evaluating recovery agents. When a queue backs up, restarting workers may look sensible until database capacity or replica health changes. The product must show what the agent knew, why its candidate was eligible, what changed, and what was actually applied to the lab.

The central demonstration is a complete recurrent loop: observe state at t -> propose alternatives -> inspect constraints -> request hosted DeltaX Evaluate -> validate its response -> recheck the current basis -> approve and apply an exact lab action once -> observe the resulting state -> reconsider. Repeated HTTP calls alone are not recurrence; time, state, observations, outcomes and memory must participate.

## Demo experience
1. Open a service topology with API, queue, workers and database; traffic, failed requests, backlog and resource headroom are visible. All workload is explicitly simulated.
2. Trigger a queue-storm incident. Two or three proposed remedies show their evidence, assumptions and effects. Scripted proposal providers are identified; later model proposals use the same schema.
3. Request a bounded hosted Evaluate review. Show its actual selection/refusal, receipt, evidence labels and non-authority facts.
4. Inject database pressure before apply. The previous revision/digest is stale; the attempted action is rejected. Show a second observation and the revised viable choices.
5. Human confirms one exact action against current state. Local deterministic execution applies it once, then plots recovery and exports a JSON evidence bundle.
6. Optional comparison: the same seed and event stream with a naive fixed policy, reporting backlog, failed requests, steps and constraint violations. Do not attribute local-rule improvements to Evaluate without an ablation that isolates it.

First-play must be understandable without editing JSON. Advanced users can edit a scenario and repeat a seed. Meaningful accessible transitions, reduced motion and stable labels. Full context remains visible in recording; use focus shading, never rapid zoom cuts.

## Technical design
TypeScript core plus Node backend, React UI if useful. Pure deterministic state machine with injected clock/RNG, immutable revisions, canonical SHA-256 basis digests, append-only causal events and explicit action IDs. Server owns hosted OAuth and response validation. A declared scenario model owns simulation; no arbitrary shell/container execution. Typed observability tools form an MCP surface for Kiro to inspect scenario state and propose tests. Model adapters stay optional and bounded.

Local constraints include capacity floor, replica availability, maximum resource use, observation freshness and action applicability. Forecasts must expose assumptions and remain separate from observed results. Evaluate receives bounded candidate representations and caller-reported support under its existing contract. It neither interprets arbitrary metrics nor authorizes downstream execution. Every receipt stores scenario/revision/digest/candidate-set binding. Freshness checks and single-use action IDs guard the separate execution boundary.

## Kiro utilization strategy
Use Kiro Spec for requirements/design/tasks, steering for invariants, a scoped custom agent for adversarial recovery tests, property-based tests for state/action properties, and a post-edit hook to run focused invariants. Add an actual read-only MCP tool for scenario evidence once the executable core is stable. Capture what Kiro changed and which features were exercised. New features are earned through working code and tests, not extra logos or empty configuration.

## Milestones
M1: Kiro-generated spec package and executable pure recovery core; 2 scenarios, deterministic seed/tick, proposal checks, stale-basis rejection, single-use execution, actual outcome/event history and meaningful property tests. Runnable textual local demonstration. No credentials/network.
M2: polished workspace; Node-owned session state; HTTP API; topology/timeline, explanations, clear error/unknown states, downloadable evidence; browser test of the main loop.
M3: exact hosted Evaluate transport with current official contract, synthetic transport tests, credential/budget plan; approved bounded live integration; no synthetic provider success.
M4: Kiro-driven MCP observation and adversarial test workflow; optional real model proposal provider; same-seed baseline versus governed ablation and reproducible results.
M5: independent user test, reliability pass, public release/source/license review, stable judge hosting, continuous end-to-end demo, captions, Kiro build write-up, submission verification.

## Score evidence
| Criterion | Evidence the judge can inspect |
| --- | --- |
| Impact | Familiar queue/backpressure incident; outcome metrics and failure tradeoffs; external usability observations when obtained |
| Implementation | Working Kiro spec, hook, test and MCP records; real Evaluate receipt; reproducible immutable state transition chain |
| Design | One clear incident-to-recovery path, visible basis changes and comprehensible refusals |
| Innovation | Recurrent action review during changing conditions; replayable counterfactual comparison |
| Presentation | <3 minute real demonstration: trigger, evaluate, invalidate, recover, inspect result |

## Decision gates
Start M1 now. Live evaluator traffic waits for a project-specific credential and bounded allowance. No old Codegeist credentials are reused. No paid Kiro upgrade, cloud provisioning or publication. Stage the exact reviewable plans when those become necessary. Keep all runtime source in this fresh app; do not port engine internals or earlier contest applications.
