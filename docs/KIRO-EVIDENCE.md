# Kiro build evidence

## Setup and authorship
Fresh private repository: DeltaX-Kairos/deltax-blackout. Kiro CLI 3.4.0 installed through the official checksum-verifying installer. Builder ID sign-in was verified. The founder chose Kiro as primary builder and explicitly removed the earlier Antigravity requirement.

Kiro authored the core modules, scenario models, CLI, property/example/regression tests, initial specs/design/tasks and steering. Codex authored the competition/product brief, review packets and verification notes and applied the narrow CommonJS/script and portable hook configuration corrections, and clarified transition comments about explicit PRNG consumption. No engine internals were copied. The existing hosted Evaluate service is a future external integration in this app, presently unconfigured.

## Actual sessions
- sess_ae9fb1aa-f7d9-4b02-940d-c151e0f3bb70: Spec mode; generated requirements and refinement. Detailed refinement intentionally stopped; no claim of completed automated spec approval.
- sess_41f78128-1ab5-4e73-a091-0122e15f2ebd: core/CLI implementation and review fixes, direct Kiro coding.
- sess_0ad14e08-1e85-4d33-beda-5d8d97b29bdf: focused provenance/timer/test fixes. Hook writes denied in noninteractive mode; no permissions bypass.
- sess_23683d30-d5b9-423a-9aca-75518e11291a: narrow configuration attempt intentionally stopped; final configuration corrections attributed to Codex.

## Verification
See M1-VERIFICATION.md: final independent typecheck, 50 tests and both compiled demo commands passed. Test results were not inferred from generated text.

## Hook observation
The portable PostFileSave invariant-check hook is configured. A Kiro source-edit probe was attempted but produced no native completion evidence before it was stopped. Automatic firing remains unverified and must be checked during the next Kiro session. A manually invoked test command is not evidence of the hook firing. Record the native result below when observed.

## Further Kiro use planned
Read-only scenario MCP tooling, adversarial recovery workflow, actual process rig and UI implementation are later tasks. Their use is not claimed by the existence of this plan.
