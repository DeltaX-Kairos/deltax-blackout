# Blackout — when a recovery decision expires

Private submission draft. Live URL, public repository and public video are intentionally unset until approved and verified. Proposed category: Frankenstein.

## Inspiration

An incident does not pause while a team reviews a fix. A plan that fitted the database a moment ago may exceed its capacity by the time someone applies it. We wanted to make that gap visible, reproducible and testable—without giving an agent a production shell.

## What it does

Blackout is a recovery rehearsal for platform engineers. A deterministic incident model produces explicit, scripted alternatives. The real hosted DeltaX Evaluate API selects bounded verification work; Blackout retains its receipt, performs the local check and stages one exact effect for human confirmation.

Then the incident changes. A staged action tied to the old revision is rejected. Fresh scaling needs 118 connections against a limit of 100, so a separate local rule blocks it. A new hosted review selects verification of a feasible load cap. After explicit confirmation, the application observes subsequent model state and exports the review-to-outcome chain.

A clearly separate measured rig uses a real SQLite queue and known child-worker code. Under pressure, scaling projects 103 managed handles against a budget of 100. Resuming the existing worker adds none, drains 24 actual queued jobs, and closes with confirmed child termination and zero managed handles. The measured rig makes no hosted calls.

## How we built it with Kiro

Kiro CLI was our primary original builder. We used Spec mode for requirements, then direct implementation and review to develop the recovery core, scenarios, browser workspace and invariant tests. Root `.kiro` contains the actual specifications, steering, PostFileSave and SessionStart hooks, and a project-local read-only MCP observer configuration. Native session records show real hook completion events.

After Kiro reached its monthly usage limit, Antigravity completed the integration under an explicitly authorized fallback. Codex coordinated bounded assignments, reviewed the source, ran independent verification and applied documented narrow integration fixes. The build record distinguishes those contributions. The observer has real official-client protocol tests; we do not claim a native Kiro model tool invocation that quota exhaustion prevented.

## Engineering

- **Current-evidence execution:** revision, material-state digest, executable payload and resource constraints are checked again immediately before a confirmed effect.
- **Bounded hosted work:** durable reservations precede dispatch; exact request/receipt bindings survive local restart. Unknown outcomes remain counted and are not automatically retried.
- **Separate authority:** provider selection, local feasibility, human confirmation and execution are different events.
- **Measured process lifecycle:** fixed trusted child code, real IPC acknowledgements, bounded SQLite jobs, one active rig and termination observed before releasing its lease.
- **Reproducible evidence:** seeded model history, explicit source labels, actual provider envelopes and downloadable action/outcome records.

## Challenges and observed results

The complete offline suite passes 290 tests. Four authorized local hosted reviews completed; the final uninterrupted 2:27 take contains two of them, a stale-action rejection and a fresh recovery. Three ticks after the load cap, the model backlog moves from 4,800 to 4,615 and model error from 42.0% to 35.9%. Those are model outcomes, not a production benchmark or a measured isolated benefit of Evaluate.

The application owns temporal history; the hosted service is pre-existing and external. Scripted support values are caller-reported fixture inputs, not model confidence. SHA-256 bindings detect changes within the application model; they are not signatures or independent attestation. The rig separates a trusted workload into a child process and is not an arbitrary-code sandbox.

## What is next

The next boundary is stronger execution attestation: pinned worker identity, restricted filesystem/network access, reproducible workload images and verified cleanup. Real incident integrations would also need telemetry validation, reviewed effects and an evaluation that isolates selector value from the local resource gates. We built the rehearsal first so those obligations remain visible.

## Built with

Kiro CLI · TypeScript · Node.js · SQLite · MCP · DeltaX Evaluate · HTML/CSS/JavaScript · Antigravity (authorized fallback)
