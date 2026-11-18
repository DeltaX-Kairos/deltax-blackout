/**
 * Release configuration and public origin validation for DeltaX Blackout.
 *
 * Implements strict canonical HTTPS origin resolution per docs/RELEASE-CONFIG-014.md:
 * - Empty / unset inputs resolve to null.
 * - Non-empty inputs must be an exact canonical HTTPS domain origin.
 * - Rejects credentials, paths (other than /), queries, fragments, non-443 ports,
 *   localhost/loopback domains, and IP literals (IPv4 and IPv6).
 * - Fails closed with a fixed sanitized configuration error without echoing raw input.
 * - Node built-ins URL and net only. No network lookups or hostname guessing.
 */

import * as net from "node:net";

export const INVALID_ORIGIN_ERROR =
  "Invalid public origin configuration: must be a canonical HTTPS domain origin without credentials, path, query, fragment, non-443 port, or IP/localhost.";

/**
 * Resolves and validates a server-operator-supplied public origin environment variable.
 *
 * @param raw - Raw environment string (e.g. process.env.PUBLIC_ORIGIN)
 * @returns Canonical origin string (e.g. "https://blackout.example.com") or null if unset/empty.
 * @throws Error with fixed sanitized message if invalid. Never echoes raw input.
 */
export function resolvePublicOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }

  // Reject input with leading/trailing whitespace as non-canonical
  if (raw !== trimmed) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Reject internal whitespace/control characters
  if (raw.includes(" ") || raw.includes("\t") || raw.includes("\n") || raw.includes("\r")) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Must use exact HTTPS protocol
  if (parsed.protocol !== "https:") {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // No credentials permitted
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // No path other than empty or root "/"
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  if (raw.includes("?") || raw.includes("#")) throw new Error(INVALID_ORIGIN_ERROR);

  // No query string
  if (parsed.search !== "") {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // No fragment / hash
  if (parsed.hash !== "") {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Port: must be omitted or explicitly 443
  if (parsed.port !== "" && parsed.port !== "443") {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Strip brackets from IPv6 hostname if present
  const cleanHost = host.replace(/^\[|\]$/g, "");

  // Rejects IP literals (IPv4 and IPv6)
  if (net.isIP(cleanHost) !== 0) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Rejects localhost, loopback, or local domains
  if (
    cleanHost === "localhost" ||
    cleanHost.endsWith(".localhost") ||
    cleanHost.endsWith(".local") ||
    cleanHost === "0.0.0.0"
  ) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Domain structure: must have at least one dot separating domain and TLD
  if (!cleanHost.includes(".")) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Validate domain labels (RFC 1035 / RFC 1123)
  const labels = cleanHost.split(".");
  if (labels.length < 2) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  for (const label of labels) {
    if (!label || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/.test(label)) {
      throw new Error(INVALID_ORIGIN_ERROR);
    }
  }

  // Top-level domain must be at least 2 alpha characters and not all digits
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld)) {
    throw new Error(INVALID_ORIGIN_ERROR);
  }

  // Canonical origin: lowercase, https, no port if default 443, no trailing slash
  return parsed.origin;
}

/**
 * Determines whether cookies should be configured with the Secure attribute
 * based on the resolved deployment origin.
 *
 * @param origin - The resolved canonical origin or null
 * @returns true if origin is HTTPS, false otherwise
 */
export function deploymentCookieSecure(origin: string | null): boolean {
  if (typeof origin !== "string") {
    return false;
  }
  return origin.startsWith("https://");
}
