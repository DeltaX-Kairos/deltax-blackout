# Current Kiro assignment — M1

Implement only M1 from docs/PROJECT-PLAN.md. Begin by reading AGENTS.md and all project docs. Use Kiro's spec workflow to create requirements, design and task files under .kiro/specs/blackout/. Treat the founder's direction as Kiro-primary with hosted DeltaX Evaluate central to the eventual product.

Produce a real local core and readable CLI demo, with minimal TypeScript dependencies. Two fictional scenarios: queue storm and database pressure. Build deterministic state/ticks, explicit units, immutable evidence snapshots and canonical basis digests, typed remediation proposals, explicit inspectable feasibility rules, revision/digest-bound local action confirmation, idempotent one-use application, and causal result history. Apply action effects to the lab and advance observations. Distinguish predicted and observed results. Show stale-basis rejection after an intervening event and a recovery step on the fresh basis. Bounded run must terminate.

Hosted path for M1 is UNCONFIGURED. Prepare typed boundaries only after reading docs/EVALUATE-INTEGRATION.md. Do not call the API or invent its outcomes. CLI output must say local lab, no hosted evaluation performed. The first runnable local demo is an invariant proof, not the eventual hackathon submission.

Create specs, steering, the source, package scripts and focused example/property tests. Use fast-check if sensible. Tests must prove determinism, no mutation on rejected actions, freshness, action deduplication, capacity constraints, bounded termination and event-chain causality. Do not merely assert hardcoded demo text. Keep dependencies small and pin via lockfile. Make one meaningful Kiro hook for focused invariant verification using the current documented schema; test its behavior and report whether the automatic event really fired. Do not fabricate use of a custom agent or MCP; those are later milestones.

Write BUILDER-REPORT.md with actual files, test outcomes and unrun work. Stop for Codex review at a coherent M1 checkpoint. No Git actions or effects beyond local source/tests/docs. Request approval for needed project-local commands. Never use trust-all-tools.
