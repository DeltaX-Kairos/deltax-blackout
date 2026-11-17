# Current assignment — complete Blackout, starting with M2

The founder explicitly requested a completion goal. M1 is committed at 3fe0763. Kiro remains the primary builder. If actual Kiro credits are exhausted, Antigravity is an authorized coding fallback. Codex coordinates independent verification and release preparation. Preserve actual attribution.

## Immediate bounded build: M2 workspace
Read AGENTS.md, docs/PROJECT-PLAN.md, src/types.ts and src/recovery-core.ts. Implement a working, polished browser workspace and a dependency-light Node HTTP server using the existing RecoveryCore. This task is implementation, not another spec rewrite. Do not spend time rewriting README or the builder report; give a short final implementation summary.

Use src/server.ts, src/workspace-service.ts and src/web/{index.html,app.js,styles.css}. Browser assets may be served from the repo source directory (no bundler required). Add meaningful tests under tests/workspace.test.ts and package scripts. No hosted calls or credentials yet. Use Node built-ins; Codex will run commands and install dependencies if needed.

Server owns sessions and core instances. Bind to 127.0.0.1 by default, explicit PORT, random opaque HttpOnly SameSite cookie, bounded expiring sessions, JSON body cap, strict allowlisted actions and input schema, origin/CSRF protection for mutation. Never accept raw executable payloads from clients. Use a per-session nonreentrant operation guard. Never trust client revision/digest as the actual current state. Local mode must say no hosted evaluation performed; no fake provider success. Evidence export is session scoped and labels every telemetry/proposal source.

A strong first-use path: queue-storm scene -> observe metric cards and service topology -> inspect 2–3 scripted candidates and local constraints -> stage one exact feasible local action -> inject database pressure/advance an observation -> attempt staged action and visibly reject stale basis -> fresh proposals -> human confirms exact current local lab effect -> advance ticks and plot actual model history. Support database-pressure scenario too. Current tick state, revision, digest, timeline and outcome stay visible. Distinguish local feasibility from hosted review. Provide hosted UNCONFIGURED card as a future integration slot.

Design: professional incident control room, dark ink canvas, warm white text, amber incident signals, teal recovery; high legibility, stable layouts, restrained animation with reduced-motion support. Main workspace uses topology/metrics left and decision workbench right, a lower evidence timeline. No excessive manifesto copy or gratuitous horror assets. Include context: a recovery action can become invalid while its review is in flight. Expose unknown/rejection states clearly. Keyboard operable buttons, labelled inputs and meaningful accessible announcements. Responsive without horizontal overflow. Use full-window context, not zoomed fragments.

After these files are complete, stop for independent tests. Do not make Git, network, cloud, credential, publishing, billing or account changes. Do not invoke shell; Codex runs typecheck/tests. Do not use trust-all or skip permissions. Later assigned steps cover real hosted transport, disposable process rig, MCP/hook evidence, comparison and release/video.

## Separate assigned M3 transport module
A separately prompted Kiro session may implement docs/HOSTED-BUILD-SPEC.md in src/hosted/** and tests/hosted.test.ts ONLY while the workspace correction session owns server/service/core/web/workspace tests. Do not modify each other's files or package scripts. No live calls or credentials. Codex integrates the modules after verification.

## Next narrowly assigned correction
A Kiro session explicitly prompted with CORE-REVIEW-006 owns that resource-constraint fix in src/types.ts,src/feasibility.ts,src/executor.ts and tests/capacity.test.ts only. The workspace implementation is checkpointed; do not otherwise rewrite it. Hosted module ownership is separate.

## Current fallback assignment — M2/M3 completion
Native Kiro monthly quota is now exhausted (UsageLimitReachedError recorded in docs/KIRO-EVIDENCE.md). Antigravity is authorized to code. Read docs/M2-REVIEW-004.md, docs/CORE-REVIEW-006.md, docs/M3-REVIEW-005.md and docs/HOSTED-BUILD-SPEC.md, plus the ACTUAL existing source APIs and node:test conventions. Finish these concrete corrections and the complete local browser/hosted adapter flow. Do not start rig/MCP/video in this assignment. No credentials or live calls. No Git, paid usage, publication, deployment, accounts, .env or Passwords access. Codex runs independent final tests. Avoid speculative refactors. Use existing CommonJS compilation and Node builtins. No npm global repair or new test framework. Current isolated M2/core baseline103tests passed; full build is not green due incomplete capacity/hosted files. Correct, then run tests only within this repo and report actual output.

## Current bounded fallback step: hosted SDK
CORE-REVIEW-006 is independently verified with120 core/workspace/capacity tests passing in isolation. Antigravity next owns src/hosted/** and tests/hosted.test.ts only. Finish actual OAuth and evaluation transport, strict current wire validation and a durable fail-closed reservation ledger from HOSTED-BUILD-SPEC/M3-REVIEW-005. Do not change already verified workspace/core files or wire UI in this step. Use file tools only; Codex executes checks. No live calls or credentials. After the SDK passes, a separate step wires WORKSPACE-FINISH-SPEC.

## Separately assigned M4 component (disjoint paths)
A separately prompted Antigravity builder may implement docs/PROCESS-RIG-PLAN.md in src/rig/** and tests/rig.test.ts ONLY. SDK builder owns src/hosted/** and tests/hosted.test.ts. Neither edits shared package/server/UI/core/docs or runs shell. Codex integrates and independently runs real local process tests. This separates file ownership, not effect authority: no credential/provider/cloud/Git changes.
