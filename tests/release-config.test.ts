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
