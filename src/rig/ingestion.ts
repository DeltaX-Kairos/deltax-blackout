/**
 * ingestion.ts — Loopback HTTP ingestion endpoint for the M4 Process Rig.
 *
 * Requirements (docs/PROCESS-RIG-PLAN.md & docs/RIG-REVIEW-008.md §1, §7):
 * - Ephemeral loopback HTTP ingestion endpoint (127.0.0.1:0).
 * - Exact loopback Host checking (rejects localhost.evil, 127.0.0.1.attacker).
 * - Random private owner header token (x-rig-token).
 * - Strict JSON media type, origin verification, and closed request shape.
 * - Safe alphanumeric IDs and UTF-8 byte cap (1024 bytes).
 * - Single 413 on oversize, immediately destroys request and stops buffering.
 * - Bounded request deadlines and complete socket closure on teardown.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import type { DurableQueue } from "./queue.js";
import { RIG_LIMITS } from "./types.js";

export interface IngestionMetrics {
  admittedCount: number;
  rejectedCount: number;
  startedAt: number;
  port: number;
}

export class IngestionServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private admittedCount: number = 0;
  private rejectedCount: number = 0;
  private readonly startedAt: number = Date.now();
  private readonly queue: DurableQueue;
  private readonly isCappedFn: () => boolean;
  private readonly onJobAdmitted?: (jobId: string) => void;
  private readonly ingestionToken: string = randomBytes(16).toString("hex");
  private readonly requireToken: boolean;

  constructor(
    queue: DurableQueue,
    isCappedFn: () => boolean,
    onJobAdmitted?: (jobId: string) => void,
    options: { requireToken?: boolean } = {}
  ) {
    this.queue = queue;
    this.isCappedFn = isCappedFn;
    this.onJobAdmitted = onJobAdmitted;
    this.requireToken = options.requireToken ?? false;
  }

  public getIngestionToken(): string {
    return this.ingestionToken;
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Bounded timeouts to prevent hanging sockets
      this.server.requestTimeout = 5000;
      this.server.headersTimeout = 3000;

      this.server.on("error", reject);

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address() as AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  public getPort(): number {
    return this.port;
  }

  public getMetrics(): IngestionMetrics {
    return {
      admittedCount: this.admittedCount,
      rejectedCount: this.rejectedCount,
      startedAt: this.startedAt,
      port: this.port,
    };
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 1. Exact Host header validation — only loopback host allowed (rejects localhost.evil, etc.)
    const hostHeader = (req.headers["host"] || "").trim();
    const validHostPattern = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
    if (!validHostPattern.test(hostHeader)) {
      this.rejectedCount++;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Access denied: non-loopback host" }));
      return;
    }

    // 2. Origin check — reject cross-origin mutation attempts
    const origin = req.headers["origin"];
    if (origin) {
      const validOriginPattern = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
      if (!validOriginPattern.test(origin)) {
        this.rejectedCount++;
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied: cross-origin mutation rejected" }));
        return;
      }
    }

    if (req.headers["sec-fetch-site"] === "cross-site") {
      this.rejectedCount++;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Access denied: cross-site fetch rejected" }));
      return;
    }

    // 3. Private owner header token validation
    const providedToken = req.headers["x-rig-token"];
    if (providedToken) {
      if (providedToken !== this.ingestionToken) {
        this.rejectedCount++;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid x-rig-token" }));
        return;
      }
    } else if (this.requireToken) {
      this.rejectedCount++;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required x-rig-token" }));
      return;
    }

    const url = req.url || "/";

    if (req.method === "GET" && (url === "/metrics" || url === "/health")) {
      const counters = this.queue.getCounters();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          port: this.port,
          admitted: this.admittedCount,
          rejected: this.rejectedCount,
          queue: counters,
        })
      );
      return;
    }

    if (req.method === "POST" && url === "/ingest") {
      this.handleIngest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private handleIngest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Media type validation: strict application/json required
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      this.rejectedCount++;
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Content-Type must be application/json" }));
      return;
    }

    // Check if ingestion is currently capped by operator policy
    if (this.isCappedFn()) {
      this.rejectedCount++;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Ingestion capped by operator policy" }));
      return;
    }

    const chunks: Buffer[] = [];
    let bytesReceived = 0;
    const maxBodyBytes = 16 * 1024; // 16 KB request body limit
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBodyBytes) {
        aborted = true;
        this.rejectedCount++;
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request payload too large" }));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;

      let parsed: Record<string, unknown>;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        this.rejectedCount++;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed JSON body" }));
        return;
      }

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.rejectedCount++;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body must be a JSON object" }));
        return;
      }

      // Strict closed shape validation: reject unknown fields
      const allowedKeys = new Set(["jobId", "payload"]);
      for (const key of Object.keys(parsed)) {
        if (!allowedKeys.has(key)) {
          this.rejectedCount++;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown field in request body: ${key}` }));
          return;
        }
      }

      const rawPayload = parsed["payload"];
      if (typeof rawPayload !== "string") {
        this.rejectedCount++;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid payload string" }));
        return;
      }

      // UTF-8 byte cap validation (max 1024 bytes)
      const payloadBytes = Buffer.byteLength(rawPayload, "utf8");
      if (payloadBytes === 0 || payloadBytes > RIG_LIMITS.MAX_PAYLOAD_BYTES) {
        this.rejectedCount++;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Payload byte size (${payloadBytes}) must be between 1 and ${RIG_LIMITS.MAX_PAYLOAD_BYTES} bytes`,
          })
        );
        return;
      }

      // Safe alphanumeric identifier validation
      let jobId: string;
      if (parsed["jobId"] !== undefined) {
        if (typeof parsed["jobId"] !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(parsed["jobId"])) {
          this.rejectedCount++;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid jobId: must be 1-64 alphanumeric characters, dash, or underscore" }));
          return;
        }
        jobId = parsed["jobId"];
      } else {
        jobId = `job-${this.admittedCount + 1}-${Date.now()}`;
      }

      // Enqueue in durable SQLite queue (enforces 64-job cap)
      const admitted = this.queue.enqueue(jobId, rawPayload);
      if (!admitted) {
        this.rejectedCount++;
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Queue capacity reached (max ${RIG_LIMITS.MAX_JOBS} jobs)`,
          })
        );
        return;
      }

      this.admittedCount++;
      if (this.onJobAdmitted) {
        this.onJobAdmitted(jobId);
      }

      const counters = this.queue.getCounters();
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          admitted: true,
          jobId,
          queueDepth: counters.pending + counters.inFlight,
          totalAdmitted: this.admittedCount,
        })
      );
    });
  }

  public async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    return new Promise((resolve) => {
      this.server?.closeIdleConnections?.();
      this.server?.closeAllConnections?.();
      this.server?.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}
