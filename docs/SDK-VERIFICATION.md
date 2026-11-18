# Hosted SDK verification — November17,2026

The isolated actual TypeScript build and all72 SDK tests passed. Codex ran the suite with global fetch replaced by a throwing guard; all provider responses were injected synthetic fixtures. No real hosted result is claimed by these tests.

Verified behaviors include strict current gateway contract/authority validation, selected/refused receipt persistence and replay, exclusive concurrent reservations from two ledger instances, total/per-identity limits across restart, unknown reservations consuming allowance, corrupt/truncated/hash-mismatch history disabling, bounded OAuth/evaluation reads and active deadlines, no automatic retry, sanitized failures, full202 reconciliation metadata and failed persistence exposing no selection.

Actual command: node node_modules/typescript/bin/tsc -p /private/tmp/blackout-sdk-final-tsconfig.json; node --require /private/tmp/blackout-offline-fetch-guard.cjs --test --test-timeout=12000 /private/tmp/blackout-sdk-verified/tests/hosted.test.js. Logs: /private/tmp/blackout-sdk-final-build.log and /private/tmp/blackout-sdk-final-tests.log.72passed,0failed,0cancelled.

Antigravity authored and hardened the SDK after Kiro quota exhaustion. Codex found three final integration defects and repaired them narrowly: missing HostedCandidate type import; typed receipt fixture normalization; and a normalizer that added absent optional fields with undefined values, causing a valid receipt to fail a second validation during replay. The normalizer now preserves absence rather than inventing provider metadata.

Founder approved a dedicated Blackout credential, Mac Passwords storage and local server use up to10 development attempts. It was created and saved, and both saved values were independently checked through Passwords without printing them. The local copy is under gitignored .blackout-private,0700directory/0600file. The attempt ledger was explicitly initialized on a nonexistent file and replayed with zero attempts. No evaluation or OAuth request has occurred yet. Server/controller/UI integration and real-provider verification remain separate checks.

These checks establish application behavior under the tested process/file model. The local ledger is not administrator-tamper-resistant or a cross-host distributed budget service. No cloud/deployment authority follows from this verification.
