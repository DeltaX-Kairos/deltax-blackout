/**
 * Bounded streaming response reader with active abort deadline.
 *
 * Rules:
 * - Races fetch and each pending reader.read against active deadline and abort signal.
 * - Cancels stream on ANY read timeout, rejection, overflow, or abort.
 * - Releases reader lock and cleans up timers/listeners in finally.
 * - Rejects non-JSON content-type.
 * - Rejects unsupported streams (no unbounded .text() fallback).
 * - Empty/null body treated as empty string.
 * - Does not leak raw exception messages or private tokens.
 */

export class DeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

export class ResponseSizeExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseSizeExceededError";
  }
}

export class InvalidContentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidContentTypeError";
  }
}

export class UnsupportedStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedStreamError";
  }
}

/**
 * Races a promise against an active timeout and optional AbortSignal.
 * Cleans up timer and listeners in finally.
 */
export async function raceWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new DeadlineExceededError(`${label} aborted`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DeadlineExceededError(`${label} timed out`);
  }

  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceededError(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    if (signal) {
      abortListener = () => {
        reject(new DeadlineExceededError(`${label} aborted`));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/**
 * Reads a response streaming body with active deadline and size limit.
 * Enforces JSON media type.
 * Cancels reader on ANY timeout or rejection.
 */
export async function readStreamingBodyWithDeadline(
  response: Response,
  limitBytes: number,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<string> {
  // Validate timeoutMs: finite bounded positive (up to 300s)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new DeadlineExceededError(`Invalid timeoutMs for ${label}: must be a finite positive number <= 300000, got ${timeoutMs}`);
  }

  // Validate limitBytes: finite positive
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    throw new Error(`Invalid limitBytes for ${label}: ${limitBytes}`);
  }

  // Strict JSON media type verification
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new InvalidContentTypeError(`${label} returned unsupported content-type: '${contentType}'`);
  }

  // Native missing/null body is treated as empty
  if (response.body === null || response.body === undefined) {
    return "";
  }

  // Body must support getReader(); do not buffer arbitrary text via .text() fallback
  if (typeof response.body.getReader !== "function") {
    throw new UnsupportedStreamError(`${label}: unsupported response body stream (missing getReader)`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const startTime = Date.now();

  try {
    while (true) {
      const elapsed = Date.now() - startTime;
      const remainingMs = Math.max(0, timeoutMs - elapsed);
      if (remainingMs <= 0 || signal?.aborted) {
        throw new DeadlineExceededError(`${label} timed out during streaming body read`);
      }

      const readResult = await raceWithDeadline(
        reader.read(),
        remainingMs,
        `${label} streaming chunk`,
        signal
      );

      if (readResult.done) {
        break;
      }

      if (readResult.value) {
        totalBytes += readResult.value.byteLength;
        if (totalBytes > limitBytes) {
          throw new ResponseSizeExceededError(`${label} exceeds limit of ${limitBytes} bytes`);
        }
        chunks.push(readResult.value);
      }
    }
  } catch (err) {
    // Cancel stream on ANY read timeout, rejection, overflow, or abort
    try {
      await reader.cancel();
    } catch {
      // Safe to ignore error during cancellation
    }
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Safe to ignore if lock was already released or reader was closed
    }
  }

  return new TextDecoder().decode(concatUint8Arrays(chunks));
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
