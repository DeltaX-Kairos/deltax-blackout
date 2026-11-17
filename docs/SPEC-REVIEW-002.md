# Design review 002 — resolve before checkpoint

The M1 design is approved for implementation with these precise corrections:

- Hook file must match the ACTUAL official schema (https://kiro.dev/docs/hooks/): {"version":"v1","hooks":[{"name":"invariant-check","trigger":"PostFileSave","matcher":"(^|/)src/.*\\.ts$","action":{"type":"command","command":"..."}}]}. The draft uses version:1, event, pathMatcher and type:shell, which are wrong. Check schema with Kiro introspection. Hooks load at session start; report actual automatic firing separately from manual command success.
- Hosted raw response field is commercial_receipt, not receipt. Trace.lambda_decisions is the ordered 12-record array. The raw top-level selected_candidate_id is string or null. Keep any product wrapper names separate. For M1 an unconfigured-only seam is enough; do not call incomplete types an exact deployed protocol.
- Consolidate the digest design: choose one material projection, document exactly which fields are included, exclude the digest itself. Revision must be checked separately even if two revisions have identical operational fields. Remove the abandoned previous-digest paragraph and the contradictory all-fields wording.
- Correct requirements.md to agree with design/code: avoid absolute hash uniqueness; distinguish unconfigured vs error/unknown; refusal receipt; fix StaleBasiRejected typo. No recursive spec generation or per-requirement detailer is necessary.
- A local action must match an actual recorded confirmation of its exact proposal payload and current revision/digest. Do not accept a caller-created Action merely because it carries the right digest. Tests must mutate payload/action fields under an otherwise fresh basis and prove rejection.

Implement M1 directly, with local registry dependencies permitted. Use node /private/tmp/blackout-toolchain/package/bin/npm-cli.js for npm commands; the PATH wrapper failed in this environment. No hosted calls or other effects.
