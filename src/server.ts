/**
 * Blackout M2 — Node HTTP server.
 *
 * Security model:
 * - Binds to 127.0.0.1 by default (PORT env override for the port number only).
 * - Random opaque HttpOnly SameSite=Strict cookie per session. CSRF token
 *   stored in SessionRecord server-side; double-submit token required on all
 *   mutation requests.
 * - JSON body capped at 64 KB with read deadline. Unknown fields rejected.
 * - Strict allowlist of action types and input schemas; rejects anything off-list.
 * - Origin header checked on mutation routes against dynamic allowlist (uses
 *   actual server port from server.address(), not env var). DNS-rebinding
 *   protection: trusted origins are built from known loopback literals only.
 * - Sec-Fetch-Site header rejected if present and cross-site on mutations.
 * - POST /api/session and mutation routes require Content-Type: application/json.
 * - Invalid percent-encoded cookies or unroutable URLs return 400.
 * - Per-session non-reentrant guard provided by WorkspaceService.
 * - Execute accepts stageId only; raw Action payload never sent client→server.
 * - Local mode labelling: no hosted evaluation; no fake provider success.
 * - Evidence export is session-scoped and labels every telemetry/proposal source.
 *
 * Routes:
 *   POST   /api/session              — create session (scenarioName, seed, tickLimit?)
 *   GET    /api/observe              — observe current state
 *   POST   /api/propose              — generate and cache proposals
 *   GET    /api/inspect/:proposalId  — pure-read feasibility check (no event side-effect)
 *   POST   /api/approve              — approve a proposal → stageId (action cached server-side)
 *   POST   /api/execute              — execute by stageId
 *   POST   /api/inject               — inject typed incident
 *   POST   /api/tick                 — advance one tick
 *   GET    /api/evidence             — export evidence bundle (JSON download)
 *   GET    /api/restore              — restore session state + CSRF after page refresh
 *   DELETE /api/session              — destroy session
 *   GET    /                         — serve index.html
 *   GET    /app.js                   — serve app.js
 *   GET    /styles.css               — serve styles.css
 *
 * Changes (M2-REVIEW-004):
 * §1 __dirname + require.main===module (CommonJS output). WEB_DIR two levels up.
 * §2 Origin allowlist built from actual server port. Sec-Fetch-Site and
 *    Content-Type checks on mutations. CSRF token stored in SessionRecord.
 *    Cookie/URL decode errors → 400. Session creation protected by origin check.
 * §3 /api/execute accepts stageId only; stageId safe-identifier validation.
 * §4 Close schemas: unknown-field rejection on propose/tick; seed uint32 max;
 *    tickLimit max 120; request/header timeout; body read deadline.
 * §5 CSRF map removed (now lives in SessionRecord via WorkspaceService).
 *    Bounded staged-action map per session (in WorkspaceService).
 * §6 /api/inject endpoint for typed IncidentInjectionKind.
 * §7 /api/restore endpoint for browser refresh. /api/evidence includes
 *    stateHistory and actionReceipts. No raw sessionId in public bundle display.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  WorkspaceService,
  SessionBusyError,
  SessionNotFoundError,
  StageNotFoundError,
} from "./workspace-service.js";
import type { ScenarioName } from "./recovery-core.js";
import type { IncidentInjectionKind } from "./types.js";

// __dirname is available in CommonJS TypeScript output.
// WEB_DIR resolves relative to the compiled server.js in dist/src/,
// so we go up two levels to reach the repo root and then into src/web.
const WEB_DIR = path.resolve(__dirname, "..", "..", "src", "web");

// ─── Allowed values ───────────────────────────────────────────────────────────

const ALLOWED_SCENARIOS: ScenarioName[] = ["queue-storm", "database-pressure"];

const ALLOWED_INJECTION_KINDS: IncidentInjectionKind[] = [
  "database-pressure-queue-storm",
  "replica-loss",
];

/** uint32 max — seed must fit in this range per brief. */
const SEED_MAX = 0xFFFF_FFFF;

/** Maximum tick limit per M2-REVIEW-004 §4. */
const TICK_LIMIT_MAX = 120;

/** Allowed origins for CSRF protection on mutations. Built from server's actual port. */
function allowedOrigins(port: number): Set<string> {
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
}

/** Safe stageId pattern: hex string of 32 characters. */
const STAGE_ID_RE = /^[0-9a-f]{32}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Parse cookie header. Returns empty record if header is absent.
 * Returns null if any value cannot be percent-decoded (triggers 400).
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> | null {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const rawV = part.slice(idx + 1).trim();
    try {
      result[k] = decodeURIComponent(rawV);
    } catch {
      return null; // malformed percent-encoding → caller returns 400
    }
  }
  return result;
}

function setCookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Read the full request body, enforcing a byte cap and an optional time deadline. */
function readBody(req: http.IncomingMessage, maxBytes = 65_536, deadlineMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        req.destroy();
        reject(new HttpError(408, "Request body read timeout"));
      }
    }, deadlineMs);

    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Return a structured 413 before closing; never retain further chunks.
        req.resume();
        done = true;
        clearTimeout(timer);
        reject(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/** Parse JSON body. Throws HttpError 400 on invalid JSON. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/** Assert value is a plain object (not null, not array). */
function assertObject(val: unknown, label: string): Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    throw new HttpError(400, `${label} must be a JSON object`);
  }
  return val as Record<string, unknown>;
}

/** Reject any keys in obj not present in allowed set. */
function rejectUnknownFields(obj: Record<string, unknown>, allowed: Set<string>, context: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new HttpError(400, `Unknown field "${k}" in ${context}`);
    }
  }
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  // Return a bounded, sanitised error message (no stack traces or internal paths).
  const safe = String(message).slice(0, 256);
  sendJson(res, status, { error: safe });
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function createServer(service: WorkspaceService): http.Server {
  const SESSION_COOKIE = "bk_session";
  const CSRF_HEADER = "x-csrf-token";

  // Origins are populated once the server is bound (in the returned server's listen callback).
  // We start with an empty set; the server.on("listening") handler below fills it.
  let _origins: Set<string> = new Set();

  function checkCsrfFromRecord(req: http.IncomingMessage, sessionId: string): void {
    const record = service.getSession(sessionId);
    const clientToken = req.headers[CSRF_HEADER];
    if (!record.csrfToken || clientToken !== record.csrfToken) {
      throw new HttpError(403, "CSRF token missing or invalid");
    }
  }

  function checkOriginAndSecFetch(req: http.IncomingMessage): void {
    // Reject cross-site preflight indicator from modern browsers.
    const secFetchSite = req.headers["sec-fetch-site"];
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none") {
      throw new HttpError(403, "Cross-site request rejected");
    }
    const origin = req.headers["origin"];
    // No Origin header: same-origin browser fetch or non-browser client.
    // Allow in local mode (127.0.0.1 binding is the network guard).
    if (!origin) return;
    // Build origins is deferred until listening, but _origins may be empty at test startup.
    // If the set is populated, enforce it; if empty, trust the loopback network.
    if (!_origins.has(origin)) {
      throw new HttpError(403, `Origin not allowed`);
    }
  }

  function requireJsonContentType(req: http.IncomingMessage): void {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.startsWith("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
  }

  const server = http.createServer(async (req, res) => {
    // Set request/header timeout — prevents slow-loris connections.
    req.socket.setTimeout(30_000);

    // Codex integration review: reject DNS-rebinding Host values, including on reads.
    if (!_origins.has(`http://${req.headers.host ?? ""}`)) {
      return sendError(res, 403, "Host not allowed");
    }

    let pathname: string;
    try {
      // Build URL using a fixed loopback base so the host header is not trusted for routing.
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      pathname = url.pathname;
    } catch {
      return sendError(res, 400, "Invalid request URL");
    }

    const method = req.method ?? "GET";

    try {
      // Static assets — no auth required.
      if (method === "GET" && pathname === "/") {
        return serveFile(res, path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8");
      }
      if (method === "GET" && pathname === "/app.js") {
        return serveFile(res, path.join(WEB_DIR, "app.js"), "application/javascript; charset=utf-8");
      }
      if (method === "GET" && pathname === "/styles.css") {
        return serveFile(res, path.join(WEB_DIR, "styles.css"), "text/css; charset=utf-8");
      }

      // ─── POST /api/session — create or reset session ────────────────────
      if (method === "POST" && pathname === "/api/session") {
        checkOriginAndSecFetch(req);
        requireJsonContentType(req);
        const bodyStr = await readBody(req);
        const payload = assertObject(parseJson(bodyStr), "request body");

        const ALLOWED_SESSION_FIELDS = new Set(["scenarioName", "seed", "tickLimit"]);
        rejectUnknownFields(payload, ALLOWED_SESSION_FIELDS, "/api/session body");

        const rawScenario = payload["scenarioName"];
        const rawSeed = payload["seed"];
        const rawTickLimit = payload["tickLimit"];

        if (!ALLOWED_SCENARIOS.includes(rawScenario as ScenarioName)) {
          throw new HttpError(400, `scenarioName must be one of: ${ALLOWED_SCENARIOS.join(", ")}`);
        }
        if (typeof rawSeed !== "number" || !Number.isInteger(rawSeed) || rawSeed < 0 || rawSeed > SEED_MAX) {
          throw new HttpError(400, `seed must be a non-negative integer ≤ ${SEED_MAX}`);
        }
        if (rawTickLimit !== undefined) {
          if (typeof rawTickLimit !== "number" || !Number.isInteger(rawTickLimit) || rawTickLimit < 1 || rawTickLimit > TICK_LIMIT_MAX) {
            throw new HttpError(400, `tickLimit must be a positive integer ≤ ${TICK_LIMIT_MAX}`);
          }
        }

        // Parse cookies — guard against invalid percent-encoding.
        const cookies = parseCookies(req.headers["cookie"]);
        if (cookies === null) throw new HttpError(400, "Invalid cookie encoding");
        let sessionId = cookies[SESSION_COOKIE];

        // Always create a fresh core when /api/session is called.
        if (sessionId && service.hasSession(sessionId)) {
          service.destroySession(sessionId);
        }
        sessionId = generateToken(16);
        const csrfToken = generateToken(24);
        const record = service.createSession(
          sessionId,
          rawScenario as ScenarioName,
          rawSeed as number,
          rawTickLimit as number | undefined,
          csrfToken
        );

        res.setHeader("Set-Cookie", setCookieHeader(SESSION_COOKIE, sessionId, 3600));
        return sendJson(res, 201, {
          csrfToken,
          scenarioName: record.scenarioName,
          seed: record.seed,
          createdAt: record.createdAt,
        });
      }

      // All remaining routes require a valid session cookie.
      const cookies = parseCookies(req.headers["cookie"]);
      if (cookies === null) throw new HttpError(400, "Invalid cookie encoding");
      const sessionId = cookies[SESSION_COOKIE];
      if (!sessionId) throw new HttpError(401, "No session cookie — call POST /api/session first");

      // ─── GET /api/observe ───────────────────────────────────────────────
      if (method === "GET" && pathname === "/api/observe") {
        const snap = await service.observe(sessionId);
        return sendJson(res, 200, snap);
      }

      // ─── GET /api/restore — browser refresh restore ─────────────────────
      if (method === "GET" && pathname === "/api/restore") {
        const snap = await service.restoreSession(sessionId);
        return sendJson(res, 200, snap);
      }

      // ─── POST /api/propose ──────────────────────────────────────────────
      if (method === "POST" && pathname === "/api/propose") {
        checkOriginAndSecFetch(req);
        checkCsrfFromRecord(req, sessionId);
        // POST propose accepts an empty body or no body; reject arbitrary fields.
        const bodyStr = req.headers["content-length"] !== "0"
          ? await readBody(req)
          : "{}";
        if (bodyStr.trim() !== "" && bodyStr.trim() !== "{}") {
          const payload = assertObject(parseJson(bodyStr), "request body");
          rejectUnknownFields(payload, new Set(), "/api/propose body (no fields accepted)");
        }
        const snap = await service.proposeAndCache(sessionId);
        return sendJson(res, 200, snap);
      }

      // ─── GET /api/inspect/:proposalId — pure-read feasibility ──────────
      // Inspection is a pure read: feasibility is computed but no mutation event
      // is emitted on the GET path (the POST /api/approve path records events).
      if (method === "GET" && pathname.startsWith("/api/inspect/")) {
        let proposalId: string;
        try {
          proposalId = decodeURIComponent(pathname.slice("/api/inspect/".length));
        } catch {
          throw new HttpError(400, "Invalid proposalId encoding");
        }
        if (!proposalId || proposalId.length > 256) throw new HttpError(400, "Invalid proposalId");
        const snap = await service.inspectCached(sessionId, proposalId);
        return sendJson(res, 200, snap);
      }

      // ─── POST /api/approve ──────────────────────────────────────────────
      if (method === "POST" && pathname === "/api/approve") {
        checkOriginAndSecFetch(req);
        checkCsrfFromRecord(req, sessionId);
        requireJsonContentType(req);
        const bodyStr = await readBody(req);
        const payload = assertObject(parseJson(bodyStr), "request body");
        rejectUnknownFields(payload, new Set(["proposalId"]), "/api/approve body");
        const rawProposalId = payload["proposalId"];
        if (typeof rawProposalId !== "string" || !rawProposalId || rawProposalId.length > 256) {
          throw new HttpError(400, "proposalId must be a non-empty string ≤ 256 chars");
        }
        const snap = await service.approve(sessionId, rawProposalId);
        // Return stageId to the client, not the raw Action object.
        return sendJson(res, 200, {
          stageId: snap.stageId,
          stagedEffect: {
            actionType: snap.action.actionType, parameters: snap.action.parameters,
            basisRevision: snap.action.basisRevision, basisDigest: snap.action.basisDigest,
            payloadDigest: snap.action.payloadDigest,
          },
        });
      }

      // ─── POST /api/execute — stageId only ──────────────────────────────
      if (method === "POST" && pathname === "/api/execute") {
        checkOriginAndSecFetch(req);
        checkCsrfFromRecord(req, sessionId);
        requireJsonContentType(req);
        const bodyStr = await readBody(req);
        const payload = assertObject(parseJson(bodyStr), "request body");
        rejectUnknownFields(payload, new Set(["stageId"]), "/api/execute body");
        const rawStageId = payload["stageId"];
        if (typeof rawStageId !== "string" || !STAGE_ID_RE.test(rawStageId)) {
          throw new HttpError(400, "stageId must be a 32-character hex string");
        }
        const snap = await service.executeByStageId(sessionId, rawStageId);
        return sendJson(res, 200, snap);
      }

      // ─── POST /api/inject ───────────────────────────────────────────────
      if (method === "POST" && pathname === "/api/inject") {
        checkOriginAndSecFetch(req);
        checkCsrfFromRecord(req, sessionId);
        requireJsonContentType(req);
        const bodyStr = await readBody(req);
        const payload = assertObject(parseJson(bodyStr), "request body");
        rejectUnknownFields(payload, new Set(["kind"]), "/api/inject body");
        const rawKind = payload["kind"];
        if (!ALLOWED_INJECTION_KINDS.includes(rawKind as IncidentInjectionKind)) {
          throw new HttpError(400, `kind must be one of: ${ALLOWED_INJECTION_KINDS.join(", ")}`);
        }
        const result = await service.injectIncident(sessionId, rawKind as IncidentInjectionKind);
        return sendJson(res, 200, result);
      }

      // ─── POST /api/tick ─────────────────────────────────────────────────
      if (method === "POST" && pathname === "/api/tick") {
        checkOriginAndSecFetch(req);
        checkCsrfFromRecord(req, sessionId);
        // POST tick accepts an empty body or no body; reject arbitrary fields.
        const bodyStr = req.headers["content-length"] !== "0"
          ? await readBody(req)
          : "{}";
        if (bodyStr.trim() !== "" && bodyStr.trim() !== "{}") {
          const payload = assertObject(parseJson(bodyStr), "request body");
          rejectUnknownFields(payload, new Set(), "/api/tick body (no fields accepted)");
        }
        const snap = await service.advanceTick(sessionId);
        return sendJson(res, 200, snap);
      }

      // ─── GET /api/evidence ──────────────────────────────────────────────
      if (method === "GET" && pathname === "/api/evidence") {
        const bundle = await service.exportEvidence(sessionId);
        // Omit raw sessionId from the downloadable public bundle.
        const { sessionId: _sid, ...publicBundle } = bundle;
        void _sid;
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="blackout-evidence.json"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(JSON.stringify(publicBundle, null, 2));
      }

      // ─── DELETE /api/session ────────────────────────────────────────────
      if (method === "DELETE" && pathname === "/api/session") {
        checkOriginAndSecFetch(req);
        checkCsrfFromRecord(req, sessionId);
        service.destroySession(sessionId);
        res.setHeader("Set-Cookie", setCookieHeader(SESSION_COOKIE, "", 0));
        return sendJson(res, 200, { destroyed: true });
      }

      // ─── 404 ────────────────────────────────────────────────────────────
      return sendError(res, 404, `No route: ${method} ${pathname}`);

    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader("Connection", "close");
        return sendError(res, err.status, err.message);
      }
      if (err instanceof SessionNotFoundError) {
        return sendError(res, 404, err.message);
      }
      if (err instanceof SessionBusyError) {
        return sendError(res, 409, err.message);
      }
      if (err instanceof StageNotFoundError) {
        return sendError(res, 404, err.message);
      }
      // Approval errors, stale basis, feasibility, etc. — 422 Unprocessable Entity.
      const message = err instanceof Error ? err.message : String(err);
      return sendError(res, 422, message);
    }
  });

  // Populate _origins once the server knows its actual port.
  server.on("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      _origins = allowedOrigins(addr.port);
    }
  });

  return server;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
// In CommonJS output, require.main === module is the idiomatic direct-run check.
if (require.main === module) {
  const service = new WorkspaceService();
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const server = createServer(service);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Blackout lab running at http://127.0.0.1:${port}`);
  });
  process.on("SIGTERM", () => { service.close(); server.close(); });
  process.on("SIGINT", () => { service.close(); server.close(); process.exit(0); });
}
