/**
 * Canonical JSON serialisation and SHA-256 basis digest.
 *
 * Material projection (SPEC-REVIEW-002 §3):
 *   Exactly: { scenarioId, tick, operationalState }
 *   Excluded: basisDigest (self-reference), revision (index), status,
 *             terminationReason, tickLimit, any event log or history.
 *
 * "Distinct digests for different states" is an engineering goal, not a theorem.
 * SHA-256 is collision resistant in practice; we do not assert collision freedom
 * as an absolute mathematical guarantee (SPEC-REVIEW-001 §1).
 */

import { createHash } from "node:crypto";
import type { ScenarioState, OperationalState } from "./types.js";

/**
 * The subset of ScenarioState fields used to compute the basisDigest.
 */
export interface MaterialProjection {
  scenarioId: string;
  tick: number;
  operationalState: OperationalState;
}

/**
 * Extract the material projection from a ScenarioState.
 * This is the documented, stable projection used for digest computation.
 */
export function materialProjection(state: ScenarioState): MaterialProjection {
  return {
    scenarioId: state.scenarioId,
    tick: state.tick,
    operationalState: state.operationalState,
  };
}

/**
 * Produce a canonical JSON string: UTF-8, keys sorted lexicographically,
 * no insignificant whitespace, deterministic across all Node versions.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJson(value));
}

function sortedJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortedJson);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortedJson(obj[key]);
  }
  return sorted;
}

/**
 * Compute the SHA-256 hex digest of the canonical material projection.
 * Returns a 64-character lowercase hex string.
 */
export function computeBasisDigest(state: Omit<ScenarioState, "basisDigest"> & { basisDigest?: string }): string {
  const projection = {
    scenarioId: state.scenarioId,
    tick: state.tick,
    operationalState: state.operationalState,
  };
  const json = canonicalJson(projection);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Compute the SHA-256 hex digest of an arbitrary serialisable value.
 * Used for proposal payload digests.
 */
export function computePayloadDigest(value: unknown): string {
  const json = canonicalJson(value);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * The executable payload projection used to bind an Action to its confirmation.
 * Exactly: { actionType, parameters, basisRevision, basisDigest }
 *
 * CORE-REVIEW-003 §1: the executor recomputes this from the received Action
 * fields and compares to the stored confirmation digest. Mutating any of these
 * four fields while keeping the original digest string causes rejection.
 */
export interface ExecutablePayloadProjection {
  actionType: string;
  parameters: Record<string, number | string | boolean | null>;
  basisRevision: number;
  basisDigest: string;
}

export function computeExecutablePayloadDigest(
  projection: ExecutablePayloadProjection
): string {
  return computePayloadDigest(projection);
}
