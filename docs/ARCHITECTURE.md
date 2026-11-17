# Blackout: a decision has an evidence lifetime

Blackout is a recovery rehearsal workspace for platform engineers. It makes the interval between reviewing an action and applying it observable. A decision about a healthy database does not remain usable after capacity changes.

## Boundaries

| Component | Owns | Does not establish |
|---|---|---|
| Kiro | Original specifications, core/workspace implementation, invariant tests and configured build hooks | Runtime approval or production recovery |
| Scripted proposer | Finite alternatives, explicit assumptions and caller-reported fixture support | An independent confidence estimate or a deployed autonomous agent |
| Hosted DeltaX Evaluate | A bounded selection or refusal, trace, commercial receipt and non-authority flags | Telemetry truth, downstream permission, execution or safety certification |
| Blackout controller | Current state, history, candidate mapping, immutable review binding and execution gates | Independent attestation of the host |
| Human | Confirmation of the exact displayed local effect | A blanket authorization for later revisions or different payloads |
| Disposable process rig | Actual child acknowledgements, durable queue records and managed SQLite handle counts | Production database connections, production throughput or adversarial code isolation |

## Temporal contract

An observation has a revision and a SHA-256 digest of material state. Proposals bind to that observation. A hosted request separately records its exact serialized body, stable idempotency key and local candidate-payload mapping before dispatch. The provider receipt retains its own hashes; these are not relabelled as application hashes.

Before an effect, the application checks current revision, material digest, executable payload, resource rules, session ownership and one-use action identity again. The human confirms the displayed effect. Selection remains a separate event from execution. A stale decision produces a refusal with no action effect; the next observation starts another bounded review cycle. This history is application-owned temporal memory, not a claim that the hosted evaluator learns across requests.

## Two distinct kinds of evidence

The deterministic model uses seeded inputs and explicit ten-second ticks. Its graphs are model outcomes. The process rig uses known worker code, a SQLite job queue and real IPC acknowledgements. Its graphs are measured lab counts. Neither is customer evidence. Predictions remain separate from observations, and no improvement is attributed to Evaluate without an ablation that isolates its contribution.

The rig forks a fixed local worker module with bounded data and a minimal environment. It never accepts arbitrary source code, shell commands or a caller-selected executable. A same-user child process can still access the host filesystem; this is process separation for a trusted workload, not an untrusted-code sandbox or remote execution attestation.

## Failure and spending semantics

A request has no automatic retry. Timeouts, interrupted transport, malformed completed responses and HTTP202 preserve uncertainty. An uncertain reservation continues to consume application allowance. Missing, truncated or corrupt configured history disables hosted access; it never creates a fresh budget. An explicit fresh initialization is allowed only on a nonexistent file.

Development limits are ten attempts in total including history, two per persistent browser identity, and one globally active request. These are application limits in addition to the account gateway allowance. A browser limit is not a provider outage. A new scenario is not a new browser identity. Credentials and request ledgers stay outside source and browser bundles.

## Repository-scale extension

The next boundary is execution attestation: a stronger worker identity, a pinned workload image, restricted filesystem/network access and verified termination before releasing resources. Repository-wide remediation would additionally require reviewed diffs, a reproducible build/test environment and evidence binding across all changed files. Blackout makes those obligations explicit rather than treating a larger command surface as a sufficient extension.

Implementation and live-verification status is recorded separately in the verification documents. This architecture description is not a statement that an untested checkpoint has been deployed.
