# Local capture verification and public release

The capture record below describes the original local build. The later public HTTPS release and current judging limits are independently verified in [HOSTED-RELEASE.md](HOSTED-RELEASE.md). The application release is not a contest submission.

## Independent automated checks

`npm test` compiled the complete TypeScript tree and ran **290 tests in 46 suites: 290 passed, zero failed, skipped or cancelled**. The test launcher blocks global live fetch; hosted SDK/controller tests use injected providers. Rig tests create actual bounded local processes and SQLite objects. MCP tests use the official client and stdio transport. Release tests exercise actual local HTTP origin/cookie behavior; they do not establish an actual TLS deployment. Static JavaScript syntax checks passed. Final Git staging found trailing whitespace in one HTML line and a test-file EOF; those were removed after capture without changing markup or behavior. The exact captured and release file digests are preserved in the private manifest.

## Fresh uninterrupted browser take

The final take is **147.14 seconds, normal speed**, with all captured page states retained in order. It is one browser session moving from the model to the explicitly separate measured rig. Explanatory framing and library narration do not replace or accelerate the browser footage. There were zero capture errors. The source manifest binds the run to runtime-source digest `5feac6d52e00356fddfef3da64721ff465778340a8af49649138a3fc7b15c4d0`.

Queue Storm seed42 begins at r1/t0 with4800messages,4workers,48connections. The first real hosted response selected verification of scale-up: receipt `eval_90925b783a924608be2c235ac2478cf0`. Its local projection was72/100. Injected pressure changed the state to r2/94connections. Applying the old stage was rejected for stale basis; workers remained4.

Fresh scale-up projected118/100 and was locally blocked. The second real hosted response selected verification of the load cap: receipt `eval_f068e41ef58b49fa8848036f11612b18`. Explicit human confirmation applied cap60/10s at r3. Three observations reached r6/t3: backlog4615, error35.9%,94connections. These are model outcomes, not a production benchmark or a measured ablation of the selector's value.

The measured rig admitted24fixed fictional jobs to a real SQLite queue and started one paused child worker. It measured48managed handles, then94under pressure. Fresh scaling projected103/100 and was blocked. Human-confirmed resume received an actual worker acknowledgement and drained24jobs. Close observed child termination and zero remaining managed handles. This is a trusted local workload, not arbitrary-code sandbox isolation.

At the end of the original local capture, four total reviews had completed/selected, with zero unknown outcomes and six reservations remaining under the then-approved ten-attempt ceiling. Each recording browser used its original two-attempt allowance. That capture did not reset or increase a budget. The subsequent public rehearsal added two completed reviews; the founder then authorized additional judge capacity. See the current release record for 100/six limits and preserved history. The rig makes zero hosted calls.

Sanitized checked summaries are in `docs/evidence/hosted-browser-run-summary.json` and `measured-rig-run.json`. Original request/binding/envelope exports and capture manifests are retained in ignored private artifacts. Browser identity is excluded from public evidence.

## Release status

Source and the corrected video are public. The dedicated AWS host, DNS, HTTPS, judge authentication, hosted gateway receipts and measured cleanup have been verified. Docker remains unbuilt on this Mac. Kiroween eligibility, registration and final submission have not been performed as part of this release.
