# Blackout

Recovery actions can expire while the incident changes.

Blackout is an incident recovery lab for platform and integration engineers. It separates a proposed remedy, the evidence used to review it, explicit human confirmation, and the local action that actually runs. A changed revision or payload invalidates the old confirmation.

**Current checkpoint:** the deterministic core and browser workspace are independently verified with **122 passing tests**. The hosted DeltaX Evaluate SDK is under a separate security review; no Blackout hosted call has been made. The measured process rig and final judge release are in progress. This repository remains private pending release approval.

## Run the local lab

Use Node.js 22 or newer:

```sh
npm ci
npm test
npm run server
```

Open http://127.0.0.1:3000. The server binds to loopback. In the current local mode, workload and telemetry are explicitly simulated, proposals are scripted, and **no hosted evaluation is performed**.

1. Start **Queue Storm**, seed **42**.
2. Generate proposals and inspect scaling workers from 4 to 12. Its projected database demand is **72 / 100**.
3. Inject database pressure. Connections rise to **94** and the observation gets a new revision and digest.
4. Try the old staged action: it is rejected as stale.
5. Generate fresh proposals. Scaling now projects **118 / 100** and is refused by the local resource rule.
6. Choose the feasible ingestion cap, confirm the exact lab effect, and advance observations. Export the evidence bundle to inspect the state/action/outcome chain.

The database-pressure scenario provides a second fictional failure case. Terminal states, duplicate actions, malformed parameters, cross-session stages and uncertain provider outcomes must never silently become new effects.

## Where hosted Evaluate fits

The complete workflow is observe → propose → check local constraints → request bounded hosted review → retain the actual selection or refusal → recheck current evidence → human confirms → apply once → observe again. The application owns temporal history and execution authority. Evaluate neither verifies caller-reported telemetry nor authorizes a downstream action.

Customer integration uses the [current account gateway](https://deltaxevaluate.com/developers/evaluate/account-reference.md), server-held credentials and a persistent attempt ledger. Development live access is disabled until its transport, response validation and reservation behavior pass review and project-specific credential use is approved. There are no credentials in this repository.

## Build and evidence

Kiro generated the initial specs, recovery core, workspace and invariant tests. Its monthly quota was exhausted during the hosted work; the founder authorized Antigravity as the coding fallback. Codex coordinates, reviews and independently verifies, with narrow integration repairs attributed in the evidence log.

- [Kiro and fallback build evidence](docs/KIRO-EVIDENCE.md)
- [Verified local workspace](docs/M2-VERIFICATION.md)
- [Project and judging plan](docs/PROJECT-PLAN.md)
- [Competition rules review](docs/COMPETITION-REVIEW.md)
- [Hosted integration specification](docs/HOSTED-BUILD-SPEC.md)
- [Measured process rig plan](docs/PROCESS-RIG-PLAN.md)

Hashes bind the recorded material state and exact executable payload. They are integrity references, not a safety certification, independent execution attestation or proof that supplied facts are true. The local simulation is a testing tool; it is not evidence of production recovery or customer impact.
