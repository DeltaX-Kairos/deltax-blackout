/**
 * OAuth client_credentials flow for DeltaX Evaluate.
 *
 * Rules:
 * - Pinned endpoint: https://access-api.deltaxevaluate.com/api/builder/oauth/token
 * - Request <= 4096 bytes.
 * - Response <= 16 KiB (16384 bytes).
 * - Active deadline: race fetch and every chunk of streaming read against timeout.
 * - Token cached until 60 s before expiry (lifetime 900 s).
 * - Exactly one exchange in flight at a time (concurrent callers share the same promise).
 * - Token value, client_secret, and raw response bodies are NEVER leaked in logs or errors.
 * - Scope validation: verifies token_type Bearer and deltax:evaluate scope.
 * - Redirects rejected: redirect: "manual".
 * - No automatic retries.
 */

import {
  EVALUATION_OAUTH_TOKEN_ENDPOINT,
  EVALUATION_OAUTH_SCOPE,
  TOKEN_RESPONSE_LIMIT,
  OAUTH_REQUEST_BODY_LIMIT,
  type FetchFn,
} from "./types.js";
import {
  raceWithDeadline,
  readStreamingBodyWithDeadline,
  DeadlineExceededError,
  ResponseSizeExceededError,
  InvalidContentTypeError,
} from "./deadline.js";

const TOKEN_LIFETIME_S = 900;
const EXPIRY_MARGIN_S = 60;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  fetch: FetchFn;
  timeoutMs?: number;
}

interface CachedToken {
  value: string;
  expiresAt: number; // Date.now() ms
}

export class OAuthClient {
  private readonly _clientId: string;
  private readonly _clientSecret: string;
  private readonly _fetch: FetchFn;
  private readonly _timeoutMs: number;
  private _cached: CachedToken | null = null;
  private _inflight: Promise<string> | null = null;

  constructor(config: OAuthConfig) {
    this._clientId = config.clientId;
    this._clientSecret = config.clientSecret;
    this._fetch = config.fetch;
    this._timeoutMs = config.timeoutMs ?? 10000;
  }

  /**
   * Returns a valid bearer token, reusing the cache when possible.
   * At most one HTTP exchange is in flight; concurrent callers share the same promise.
   * Never includes credentials or token values in thrown errors.
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this._cached && this._cached.expiresAt > now) {
      return this._cached.value;
    }

    if (this._inflight !== null) {
      return this._inflight;
    }

    this._inflight = this._exchange().finally(() => {
      this._inflight = null;
    });

    return this._inflight;
  }

  private async _exchange(): Promise<string> {
    const bodyStr = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this._clientId,
      client_secret: this._clientSecret,
      scope: EVALUATION_OAUTH_SCOPE,
    }).toString();

    if (Buffer.byteLength(bodyStr, "utf8") > OAUTH_REQUEST_BODY_LIMIT) {
      throw new OAuthTransportError("OAuth request body exceeds limit");
    }

    const controller = new AbortController();
    const startTime = Date.now();
    const timeoutMs = this._timeoutMs;

    const getRemainingTimeout = (stage: string) => {
      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        throw new DeadlineExceededError(`${stage} timed out: total timeout ${timeoutMs}ms exceeded`);
      }
      return remaining;
    };

    let response: Response;
    try {
      const fetchTimeout = getRemainingTimeout("OAuth token request");
      response = await raceWithDeadline(
        this._fetch(EVALUATION_OAUTH_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: bodyStr,
          redirect: "manual",
          signal: controller.signal,
        }),
        fetchTimeout,
        "OAuth token request",
        controller.signal
      );
    } catch (err) {
      controller.abort();
      if (err instanceof DeadlineExceededError) {
        throw new OAuthTransportError("OAuth token request timed out");
      }
      throw new OAuthTransportError("OAuth token request failed (transport error)");
    }

    // Reject redirects
    if (
      (response.status >= 300 && response.status < 400) ||
      response.type === "opaqueredirect"
    ) {
      controller.abort();
      throw new OAuthTransportError("OAuth endpoint returned unexpected redirect");
    }

    if (!response.ok) {
      controller.abort();
      throw new OAuthHttpError(response.status);
    }

    // Bounded streaming read with active deadline
    let raw: string;
    try {
      const bodyTimeout = getRemainingTimeout("OAuth token response read");
      raw = await readStreamingBodyWithDeadline(
        response,
        TOKEN_RESPONSE_LIMIT,
        bodyTimeout,
        "OAuth token response",
        controller.signal
      );
    } catch (err) {
      controller.abort();
      if (err instanceof DeadlineExceededError) {
        throw new OAuthTransportError("OAuth token response read timed out");
      }
      if (err instanceof ResponseSizeExceededError) {
        throw new OAuthParseError(`OAuth token response exceeds ${TOKEN_RESPONSE_LIMIT}-byte limit`);
      }
      if (err instanceof InvalidContentTypeError) {
        throw new OAuthParseError("OAuth endpoint returned invalid content-type");
      }
      throw new OAuthTransportError("OAuth token response read failed");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OAuthParseError("OAuth token response is not valid JSON");
    }

    const { token, expiresIn } = extractToken(parsed);

    const lifetime = expiresIn > 0 ? expiresIn : TOKEN_LIFETIME_S;
    const cacheDuration = Math.max(0, lifetime - EXPIRY_MARGIN_S);

    this._cached = {
      value: token,
      expiresAt: Date.now() + cacheDuration * 1000,
    };

    return token;
  }

  /** Clears the cached token (for testing). */
  clearCache(): void {
    this._cached = null;
  }
}

function extractToken(parsed: unknown): { token: string; expiresIn: number } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OAuthParseError("OAuth response root is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.access_token !== "string" || !obj.access_token) {
    throw new OAuthParseError("OAuth response missing access_token string");
  }
  const token = obj.access_token;
  if (!token.startsWith("dxbt_")) {
    throw new OAuthParseError("OAuth token does not carry expected bearer prefix");
  }

  if (typeof obj.token_type !== "string" || obj.token_type.toLowerCase() !== "bearer") {
    throw new OAuthParseError("OAuth response invalid token_type: expected Bearer");
  }

  if (typeof obj.scope !== "string" || !obj.scope.includes(EVALUATION_OAUTH_SCOPE)) {
    throw new OAuthParseError(`OAuth response scope does not include required scope '${EVALUATION_OAUTH_SCOPE}'`);
  }

  let expiresIn = TOKEN_LIFETIME_S;
  if ("expires_in" in obj) {
    if (typeof obj.expires_in !== "number" || !Number.isFinite(obj.expires_in) || obj.expires_in <= 0) {
      throw new OAuthParseError("OAuth response expires_in must be a positive finite number");
    }
    expiresIn = obj.expires_in;
  }

  return { token, expiresIn };
}

export class OAuthTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthTransportError";
  }
}

export class OAuthHttpError extends Error {
  public readonly status: number;

  constructor(status: number) {
    super(`OAuth token endpoint returned HTTP ${status}`);
    this.name = "OAuthHttpError";
    this.status = status;
  }
}

export class OAuthParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthParseError";
  }
}
