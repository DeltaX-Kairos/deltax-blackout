# Blackout judging release — November 17, 2026

[Live workspace](https://blackout.deltaxevaluate.com/) · [Uninterrupted demonstration](https://www.youtube.com/watch?v=jLotIWJG7CU) · [Public source](https://github.com/DeltaX-Kairos/deltax-blackout) · [Judge click path](JUDGES.md)

The live workspace uses a dedicated judge login, supplied privately. Credentials are not in this repository. This release does not itself register or submit a contest entry.

## Current judge policy

- 100 cumulative hosted review reservations, including all development history, errors and unknown outcomes.
- Six reviews per persistent browser identity: three complete two-review walkthroughs.
- One active hosted request globally; no automatic retries. An unknown outcome retains its reservation and identity lock.
- At release verification, six reviews were already completed/selected and 94 reservations remained. Read `/api/live/status` after judge authentication for current counts. A browser limit is distinct from a provider outage.
- The Evaluate account's gateway quota is independent of these app limits. Resetting the account quota does not erase the application's request history.

Development defaults remain ten total and two per identity. Only the server operator can configure `BLACKOUT_MAX_TOTAL_ATTEMPTS=100` and `BLACKOUT_MAX_BROWSER_ATTEMPTS=6`. Canonical integer parsing rejects invalid or out-of-range values with a sanitized error; browser requests cannot raise limits.

The existing local preview was stopped before transferring the exact ledger. The judging host remains its sole active spending authority. Later allowance changes preserved the file rather than initializing a new budget.

## Public deployment rehearsal

The public HTTPS workspace independently reproduced the recorded local workflow:

1. Real hosted review selected scale verification; the separate local projection was 72/100 connections.
2. Pressure changed the evidence to 94 connections. Applying the staged action produced a stale-basis rejection and left workers unchanged.
3. Fresh scaling projected 118/100 and was locally blocked. A second actual hosted review selected the feasible load-cap verification.
4. Explicit confirmation applied the fictional cap at 60 messages per ten-second tick. After three model ticks, queue depth was 4,615 and error rate 35.9%.
5. Both public review responses passed schema checks and all twelve service gate records. Model values remain simulated, not production outcomes or a measured isolated benefit of the selector.

The separate measured worker rig completed 24 real fictional jobs through SQLite and a fixed child worker. Close reported confirmed child exit, zero active/paused workers and zero managed handles. It made zero hosted calls. This known workload is not an arbitrary-code sandbox.

[Sanitized deployment summary](evidence/public-deployment-summary.json). Original request/binding/envelope exports, ownership identifiers and deployment receipts remain in ignored private artifacts.

## Hosting and access

One dedicated AWS Lightsail 2 GB Ubuntu host serves the app through Caddy HTTPS and judge authentication. Node listens on loopback. The service runs as a separate OS user; its root-owned credential environment and private durable ledger are excluded from source and child-worker environments. Host/Origin checks, Secure cookies and CSRF protection remain enabled.

The founder approved retention through January 29, 2027 at 1 PM Pacific, using existing AWS Free-plan credits. The balance showed $100 available at provisioning. The $12/month bundle's nominal November–January cost is at most $36 before tax or out-of-bundle usage; this is not a hard AWS spending cap or a promise about other account usage. No paid-plan upgrade, payment method, snapshots or extra managed services were added. [AWS Lightsail billing documentation](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html).

The discontinued Handoff Desk instance, its detached static IP and obsolete DNS record were removed under the founder's separate retirement approval. Its source and local archive remain preserved.

## Verification and media integrity

The updated tree compiled and passed **350 tests in 50 suites**, with zero failed, skipped or cancelled. The suite blocks live provider fetches; controller restart and unknown-lock cases use offline fixtures. An npm advisory check identified a Zod memory-exhaustion advisory; pinning the patched 4.6.7 release produced zero reported vulnerabilities. [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

The original 147.14-second screen-recording stream remains uninterrupted and unchanged. The published cut uses one fixed Kokoro `af_heart` library narrator, no pitch shifting or time stretching, and uploaded English captions. It shows the original development allowance; the current judging policy above was expanded afterward. The public video description links the verified live workspace.

Antigravity implemented the bounded allowance configuration and tests after Kiro's recorded quota exhaustion. Codex reviewed the diff, applied the dependency patch, executed independent checks, managed deployment and verified public results. No proprietary Evaluate engine implementation is included.
