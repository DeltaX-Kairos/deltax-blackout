/**
 * Tests for release configuration and public origin validation.
 *
 * Verifies docs/RELEASE-CONFIG-014.md requirements:
 * - Empty / unset inputs resolve to null.
 * - Non-empty must be exact canonical HTTPS domain origin.
 * - Rejects HTTP, credentials, paths, queries, fragments, non-443 ports, localhost, and IP literals.
 * - Rejects non-domain hostnames, single-label names, and invalid labels.
 * - Throws fixed sanitized configuration error without echoing raw input (zero secret leakage).
 * - deploymentCookieSecure helper behavior.
 * - All tests use node:test and node:assert/strict only. Zero live calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePublicOrigin,
  deploymentCookieSecure,
  INVALID_ORIGIN_ERROR,
  resolveHostedAttemptLimits,
  INVALID_ATTEMPT_LIMITS_ERROR,
  DEFAULT_MAX_TOTAL_ATTEMPTS,
  DEFAULT_MAX_BROWSER_ATTEMPTS,
} from "../src/release-config.js";

describe("release-config: resolvePublicOrigin", () => {
  describe("empty and unset inputs", () => {
    test("undefined resolves to null", () => {
      assert.strictEqual(resolvePublicOrigin(undefined), null);
    });

    test("empty string resolves to null", () => {
      assert.strictEqual(resolvePublicOrigin(""), null);
    });

    test("whitespace-only string resolves to null", () => {
      assert.strictEqual(resolvePublicOrigin("   "), null);
      assert.strictEqual(resolvePublicOrigin("\t"), null);
      assert.strictEqual(resolvePublicOrigin("\n"), null);
    });
  });

  describe("valid canonical HTTPS origins", () => {
    test("standard HTTPS domain origin", () => {
      assert.strictEqual(
        resolvePublicOrigin("https://blackout.example.com"),
        "https://blackout.example.com"
      );
    });

    test("HTTPS domain origin with trailing slash is canonicalized without slash", () => {
      assert.strictEqual(
        resolvePublicOrigin("https://blackout.example.com/"),
        "https://blackout.example.com"
      );
    });

    test("HTTPS domain origin with explicit default port 443 is canonicalized", () => {
      assert.strictEqual(
        resolvePublicOrigin("https://blackout.example.com:443"),
        "https://blackout.example.com"
      );
    });

    test("HTTPS domain origin with explicit port 443 and trailing slash", () => {
      assert.strictEqual(
        resolvePublicOrigin("https://blackout.example.com:443/"),
        "https://blackout.example.com"
      );
    });

    test("multi-level subdomain origin", () => {
      assert.strictEqual(
        resolvePublicOrigin("https://judge.blackout.deltax.ai"),
        "https://judge.blackout.deltax.ai"
      );
    });

    test("hostname is canonicalized to lowercase", () => {
      assert.strictEqual(
        resolvePublicOrigin("https://BLACKOUT.EXAMPLE.COM"),
        "https://blackout.example.com"
      );
    });
  });

  describe("protocol validation", () => {
    test("rejects plain HTTP protocol", () => {
      assert.throws(() => resolvePublicOrigin("http://blackout.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects FTP protocol", () => {
      assert.throws(() => resolvePublicOrigin("ftp://blackout.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects WebSocket protocol", () => {
      assert.throws(() => resolvePublicOrigin("ws://blackout.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects javascript pseudo-protocol", () => {
      assert.throws(() => resolvePublicOrigin("javascript:void(0)"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });
  });

  describe("credentials rejection", () => {
    test("rejects origin with username", () => {
      assert.throws(() => resolvePublicOrigin("https://judge@blackout.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects origin with username and password", () => {
      assert.throws(() => resolvePublicOrigin("https://judge:secret@blackout.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });
  });

  describe("path, query, and fragment rejection", () => {
    test("rejects origin with non-root path", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com/api"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com/app/index.html"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects origin with double slash path", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com//"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects origin with query parameters", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com?token=123"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com/?token=123"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects origin with fragment hash", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com#overview"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com/#overview"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });
  });

  describe("port rejection", () => {
    test("rejects non-443 TLS port (e.g. 8443)", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com:8443"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects port 80", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com:80"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects standard local port 3000", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com:3000"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects port 444", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com:444"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });
  });

  describe("localhost, loopback, and IP literal rejection", () => {
    test("rejects localhost hostname", () => {
      assert.throws(() => resolvePublicOrigin("https://localhost"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://localhost:443"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects subdomains of localhost", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.localhost"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects .local domain", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout.local"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects IPv4 loopback literal (127.0.0.1)", () => {
      assert.throws(() => resolvePublicOrigin("https://127.0.0.1"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://127.0.0.1:443"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects 0.0.0.0 literal", () => {
      assert.throws(() => resolvePublicOrigin("https://0.0.0.0"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects IPv6 loopback literal ([::1])", () => {
      assert.throws(() => resolvePublicOrigin("https://[::1]"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://[::1]:443"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects private network IPv4 literals", () => {
      assert.throws(() => resolvePublicOrigin("https://192.168.1.1"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://10.0.0.1"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://172.16.0.1"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects public IPv4 literals", () => {
      assert.throws(() => resolvePublicOrigin("https://8.8.8.8"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://1.1.1.1"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });
  });

  describe("hostname structure validation", () => {
    test("rejects single label hostnames without TLD", () => {
      assert.throws(() => resolvePublicOrigin("https://singlelabel"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects labels with leading or trailing hyphens", () => {
      assert.throws(() => resolvePublicOrigin("https://-invalid.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://invalid-.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects consecutive dots (empty label)", () => {
      assert.throws(() => resolvePublicOrigin("https://blackout..example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects all-numeric TLDs", () => {
      assert.throws(() => resolvePublicOrigin("https://example.123"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects non-URL garbage strings", () => {
      assert.throws(() => resolvePublicOrigin("not-a-url"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("://missing-scheme"), {
        message: INVALID_ORIGIN_ERROR,
      });
    });

    test("rejects leading or trailing whitespace on non-empty input", () => {
      assert.throws(() => resolvePublicOrigin(" https://blackout.example.com"), {
        message: INVALID_ORIGIN_ERROR,
      });
      assert.throws(() => resolvePublicOrigin("https://blackout.example.com "), {
        message: INVALID_ORIGIN_ERROR,
      });
    });
  });

  describe("canary and sensitive data protection", () => {
    test("error message never echoes raw input or leaked credentials", () => {
      const canaryString = "CANARY_SECRET_AUTH_TOKEN_778899";
      let caughtError: Error | undefined;

      try {
        resolvePublicOrigin(`https://${canaryString}:mypassword@malicious.example.com/leak`);
      } catch (err) {
        caughtError = err as Error;
      }

      assert.ok(caughtError, "Expected validation to throw");
      assert.strictEqual(caughtError.message, INVALID_ORIGIN_ERROR);
      assert.ok(
        !caughtError.message.includes(canaryString),
        "Error message must never echo the raw input"
      );
      assert.ok(
        !caughtError.message.includes("mypassword"),
        "Error message must never echo password"
      );
    });
  });
});

describe("release-config: deploymentCookieSecure", () => {
  test("returns true for valid canonical HTTPS origin", () => {
    assert.strictEqual(deploymentCookieSecure("https://blackout.example.com"), true);
  });

  test("returns false for null origin", () => {
    assert.strictEqual(deploymentCookieSecure(null), false);
  });

  test("returns false for non-HTTPS origin", () => {
    assert.strictEqual(deploymentCookieSecure("http://blackout.example.com"), false);
  });

  test("returns false for empty string", () => {
    assert.strictEqual(deploymentCookieSecure(""), false);
  });
});

describe("release-config: resolveHostedAttemptLimits", () => {
  describe("defaults when absent", () => {
    test("defaults to 10 total and 2 browser when both env vars are absent", () => {
      assert.deepStrictEqual(resolveHostedAttemptLimits({}), {
        maxTotalAttempts: DEFAULT_MAX_TOTAL_ATTEMPTS,
        maxBrowserAttempts: DEFAULT_MAX_BROWSER_ATTEMPTS,
      });
      assert.deepStrictEqual(
        resolveHostedAttemptLimits({
          BLACKOUT_MAX_TOTAL_ATTEMPTS: undefined,
          BLACKOUT_MAX_BROWSER_ATTEMPTS: undefined,
        }),
        {
          maxTotalAttempts: 10,
          maxBrowserAttempts: 2,
        }
      );
    });

    test("defaults browser to 2 when only total is configured", () => {
      assert.deepStrictEqual(
        resolveHostedAttemptLimits({ BLACKOUT_MAX_TOTAL_ATTEMPTS: "100" }),
        { maxTotalAttempts: 100, maxBrowserAttempts: 2 }
      );
    });

    test("defaults total to 10 when only browser is configured within 1..6", () => {
      assert.deepStrictEqual(
        resolveHostedAttemptLimits({ BLACKOUT_MAX_BROWSER_ATTEMPTS: "6" }),
        { maxTotalAttempts: 10, maxBrowserAttempts: 6 }
      );
    });
  });

  describe("valid canonical decimal limits", () => {
    test("accepts judging target 100 total and 6 per browser identity", () => {
      assert.deepStrictEqual(
        resolveHostedAttemptLimits({
          BLACKOUT_MAX_TOTAL_ATTEMPTS: "100",
          BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
        }),
        { maxTotalAttempts: 100, maxBrowserAttempts: 6 }
      );
    });

    test("accepts minimum boundaries 1/1 and equal boundary 6/6", () => {
      assert.deepStrictEqual(
        resolveHostedAttemptLimits({
          BLACKOUT_MAX_TOTAL_ATTEMPTS: "1",
          BLACKOUT_MAX_BROWSER_ATTEMPTS: "1",
        }),
        { maxTotalAttempts: 1, maxBrowserAttempts: 1 }
      );
      assert.deepStrictEqual(
        resolveHostedAttemptLimits({
          BLACKOUT_MAX_TOTAL_ATTEMPTS: "6",
          BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
        }),
        { maxTotalAttempts: 6, maxBrowserAttempts: 6 }
      );
    });

    test("accepts intermediate valid limits", () => {
      assert.deepStrictEqual(
        resolveHostedAttemptLimits({
          BLACKOUT_MAX_TOTAL_ATTEMPTS: "42",
          BLACKOUT_MAX_BROWSER_ATTEMPTS: "4",
        }),
        { maxTotalAttempts: 42, maxBrowserAttempts: 4 }
      );
    });
  });

  describe("invalid attempt limits rejected with fixed sanitized error", () => {
    const invalidTotalCases = [
      "",
      " ",
      " 10",
      "10 ",
      "\t10",
      "10\n",
      "0",
      "00",
      "01",
      "010",
      "-1",
      "-10",
      "+10",
      "10.0",
      "10.5",
      "1e2",
      "1E1",
      "1e+2",
      "1_0",
      "0x64",
      "ten",
      "NaN",
      "Infinity",
      "101",
      "999",
      "99999999999999999999999",
    ];

    for (const bad of invalidTotalCases) {
      test(`rejects invalid BLACKOUT_MAX_TOTAL_ATTEMPTS: ${JSON.stringify(bad)}`, () => {
        assert.throws(
          () =>
            resolveHostedAttemptLimits({
              BLACKOUT_MAX_TOTAL_ATTEMPTS: bad,
              BLACKOUT_MAX_BROWSER_ATTEMPTS: "2",
            }),
          { message: INVALID_ATTEMPT_LIMITS_ERROR }
        );
      });
    }

    const invalidBrowserCases = [
      "",
      " ",
      " 2",
      "2 ",
      "\t6",
      "6\n",
      "0",
      "00",
      "02",
      "-1",
      "+2",
      "2.0",
      "2.5",
      "2e0",
      "1E0",
      "1_2",
      "0x6",
      "six",
      "7",
      "10",
      "100",
    ];

    for (const bad of invalidBrowserCases) {
      test(`rejects invalid BLACKOUT_MAX_BROWSER_ATTEMPTS: ${JSON.stringify(bad)}`, () => {
        assert.throws(
          () =>
            resolveHostedAttemptLimits({
              BLACKOUT_MAX_TOTAL_ATTEMPTS: "100",
              BLACKOUT_MAX_BROWSER_ATTEMPTS: bad,
            }),
          { message: INVALID_ATTEMPT_LIMITS_ERROR }
        );
      });
    }

    test("rejects browser > total", () => {
      assert.throws(
        () =>
          resolveHostedAttemptLimits({
            BLACKOUT_MAX_TOTAL_ATTEMPTS: "4",
            BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
          }),
        { message: INVALID_ATTEMPT_LIMITS_ERROR }
      );
      assert.throws(
        () =>
          resolveHostedAttemptLimits({
            BLACKOUT_MAX_TOTAL_ATTEMPTS: "5",
            BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
          }),
        { message: INVALID_ATTEMPT_LIMITS_ERROR }
      );
      // When browser is absent it defaults to 2, which exceeds explicit total=1
      assert.throws(
        () =>
          resolveHostedAttemptLimits({
            BLACKOUT_MAX_TOTAL_ATTEMPTS: "1",
          }),
        { message: INVALID_ATTEMPT_LIMITS_ERROR }
      );
    });

    test("rejects non-string runtime values", () => {
      assert.throws(
        () =>
          resolveHostedAttemptLimits({
            BLACKOUT_MAX_TOTAL_ATTEMPTS: null as unknown as string,
          }),
        { message: INVALID_ATTEMPT_LIMITS_ERROR }
      );
      assert.throws(
        () =>
          resolveHostedAttemptLimits({
            BLACKOUT_MAX_BROWSER_ATTEMPTS: 6 as unknown as string,
          }),
        { message: INVALID_ATTEMPT_LIMITS_ERROR }
      );
    });

    test("error message never echoes raw invalid input", () => {
      const canary = "CANARY_SECRET_LIMIT_VALUE_4455";
      let caughtError: Error | undefined;
      try {
        resolveHostedAttemptLimits({
          BLACKOUT_MAX_TOTAL_ATTEMPTS: canary,
          BLACKOUT_MAX_BROWSER_ATTEMPTS: "6",
        });
      } catch (err) {
        caughtError = err as Error;
      }
      assert.ok(caughtError);
      assert.strictEqual(caughtError.message, INVALID_ATTEMPT_LIMITS_ERROR);
      assert.ok(!caughtError.message.includes(canary));
    });
  });
});
