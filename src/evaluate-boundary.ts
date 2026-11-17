/**
 * DeltaX Evaluate typed boundary.
 * M1: only the NullEvaluateAdapter is used; no network calls are made.
 *
 * SPEC-REVIEW-002 §2: unconfigured ≠ error. Absent adapter → unconfigured.
 * Exception/timeout → error. Neither is promoted to selected.
 */

import type { EvaluateAdapter, EvaluateRequest, EvaluateResult } from "./types.js";

/**
 * M1 implementation: returns unconfigured without any network request.
 */
export class NullEvaluateAdapter implements EvaluateAdapter {
  async evaluate(_request: EvaluateRequest): Promise<EvaluateResult> {
    return { status: "unconfigured" };
  }
}

/**
 * Wraps any adapter and catches exceptions/timeouts, returning status "error"
 * instead of re-throwing. Preserves unknown outcome on failure.
 * CORE-REVIEW-003 final: clear timeout in finally to avoid pending timers.
 */
export class SafeEvaluateAdapter implements EvaluateAdapter {
  constructor(
    private readonly inner: EvaluateAdapter,
    private readonly timeoutMs = 30_000
  ) {}

  async evaluate(request: EvaluateRequest): Promise<EvaluateResult> {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race<EvaluateResult>([
        this.inner.evaluate(request),
        new Promise<EvaluateResult>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("evaluate timeout")), this.timeoutMs);
        }),
      ]);
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { status: "error", detail };
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}
