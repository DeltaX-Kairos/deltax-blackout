# Blackout

**A recovery decision has an evidence lifetime.**

A recovery rehearsal for platform engineers: hosted DeltaX Evaluate selects bounded verification work; the application rechecks the current evidence, requires human confirmation, applies one exact lab effect and records the outcome.

**Private review build:** 290 automated checks pass. Four actual hosted reviews completed, including the two in the final uninterrupted **2:27 review video**. The stale-decision/recovery flow and the measured rig’s 24-job drain and cleanup are verified. Public hosting, source disclosure and contest submission await approval.

- [Judge click path](docs/JUDGES.md)
- [Architecture and execution boundaries](docs/ARCHITECTURE.md)
- [Actual Kiro usage and fallback attribution](docs/KIRO-EVIDENCE.md)
- [Observed live results and limitations](docs/LIVE-VERIFICATION.md)
- [Hosted SDK verification](docs/SDK-VERIFICATION.md)
- [Publication review](docs/RELEASE-REVIEW.md)

## Run

Use the pinned Node.js 22.23.2 runtime (see `.nvmrc`):

```sh
npm ci --ignore-scripts
npm test
npm run server
```

Open http://127.0.0.1:3000. The default is an explicit local model with no hosted evaluation. Model observations use seeded inputs and ten-second ticks. Proposals are scripted; their support is caller-reported fixture input, not model confidence.

The default test command blocks live fetches. SDK fixtures and official MCP protocol tests are offline; the real worker tests use only loopback HTTP, fixed child code and SQLite.

## The incident-to-recovery loop

1. Start Queue Storm with seed 42. Observe 4,800 queued messages, 4 workers and 48 database connections.
2. Generate alternatives. Scaling from 4 to 12 projects 72/100 connections. With hosted access configured, request a real bounded review before staging the selected verification plan.
3. Stage the exact effect, then inject database pressure. The current observation changes to 94 connections at a new revision and SHA-256 basis.
4. Attempt the old stage: the application records a stale-basis rejection without changing workers.
5. Refresh alternatives. Scaling now projects 118/100 and is rejected by the local resource gate. Review the feasible cap, then explicitly confirm its 60-messages-per-tick effect.
6. Advance three model ticks. The observed model backlog is 4,615 versus 4,800. Export the state, review, action and outcome records. This is a model outcome, not a production recovery claim or an ablation of Evaluate.

Database Pressure is a second deterministic scenario. Every selected hosted review remains separate from local feasibility, confirmation and execution authority.

## Real process rig

Open `/rig/` for the separate manual measured lab. It uses a file-backed SQLite queue, an authenticated loopback ingestion endpoint and fixed child worker code. It never invokes hosted Evaluate.

Start 24 fictional jobs with one paused worker and 48 managed SQLite handles. Stage scaling to 4 workers, inject pressure to 94 handles and check the stale stage. Fresh scaling would need 103/100 handles; resuming the existing worker stays at 94 and drains the queue. Closing confirms worker termination and zero managed handles. Snapshots, queue totals, worker details and applied-action receipts can be downloaded.

Caps: one rig per application process, four workers, 64 jobs, 120 seconds, 100 managed handles. In-flight work lost with a child becomes unknown and is not silently reassigned. These are actual local process/SQLite observations, separate from the simulated model and from production database telemetry. The known-code child process is not an adversarial-code sandbox or execution attestation.

## Hosted integration

Use the [customer gateway contract](https://deltaxevaluate.com/developers/evaluate/account-reference.md). The app does not require or expose engine source. Credentials stay on the server. Local verification used a dedicated credential and a ten-attempt application allowance, including history, unknowns and errors; two attempts per persistent browser identity and one globally active request. There are no automatic retries.

Build first, explicitly initialize a new private ledger, then supply credentials through a private environment file:

```sh
node dist/src/hosted-controller.js /private/path/attempts.jsonl
node --env-file=/private/path/blackout.env dist/src/server.js
```

The environment contains `BLACKOUT_ENABLE_HOSTED=true`, `BLACKOUT_CLIENT_ID`, `BLACKOUT_CLIENT_SECRET` and `BLACKOUT_LEDGER_PATH`. Do not commit this file. Missing/corrupt history disables configured access; initialization never resets an existing ledger. Status and startup do not exchange tokens or request evaluations. Explicit enable with incomplete configuration fails closed instead of falling back to manual action.

The actual gateway envelope, account/evaluator receipt IDs, twelve service gate records, authority flags and provider digests are retained. Source/basis/payload hashes are separate application integrity references. They are not relabelled as signatures, safety certificates or independently verified provider hash algorithms. A response never authorizes an action.

## Kiro

Kiro CLI authored the original specifications, recovery core, workspace and invariant suite. Real source-edit sessions triggered PostFileSave hooks. Its monthly quota was exhausted; the founder authorized Antigravity, which completed the hosted transport, controller and measured rig. Codex reviewed, tested and applied documented narrow integration/configuration repairs.

Root `.kiro` contains the actual specifications, steering and hooks. The project-local MCP observer exposes three read-only tools over a clearly labelled recorded fictional fixture. Nine official-client protocol tests exercise those tools; this does not claim a Kiro model tool call after quota exhaustion. [Build evidence](docs/KIRO-EVIDENCE.md) records the distinction.

## Judge hosting preparation

The application remains loopback-only. `BLACKOUT_PUBLIC_ORIGIN` optionally allows one validated HTTPS origin and enables Secure cookies for a TLS reverse proxy. `deployment/Caddyfile.example` adds private jury authentication while preserving Host/Origin checks. The Docker recipe is prepared but has not been built locally; direct Node operation is verified. No server, DNS record or judge password has been created for Blackout.

MIT applies to this new application. DeltaX Evaluate is a pre-existing external service with separate access terms. No customer evidence, external usability study or production safety claim is asserted.
