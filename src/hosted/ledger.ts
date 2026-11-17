/**
 * Durable JSONL reservation ledger for DeltaX Evaluate.
 *
 * Rules:
 * - Scoped exclusive file lock (.lock via O_CREAT | O_EXCL) for all mutations.
 * - Reload and validate committed history under lock.
 * - Require format header: {"version":"deltax-blackout-hosted-ledger-v1","format":"jsonl","createdAt":...}\n.
 * - Mode 0o600 on ledger file and lock file.
 * - Require final newline on replay. Missing final newline throws LedgerCorruptError.
 * - Missing, empty-without-header, malformed, or digest-mismatch file throws and disables live mode.
 * - Recomputes body SHA-256 and validates request JSON on replay.
 * - Enforces body/basis/payload digests 64hex, revision integer >= 1, safe bounded key/session.
 * - Enforces caps: max 10 total distinct attempts, max 2 per session, max 1 active concurrent in-flight.
 * - Enforces file size cap for append as well as replay.
 * - Single transition from reserved to terminal state. Unknown remains counted in allowance.
 * - Terminal entries must match reservation session, basis, and mapping.
 * - Stores and validates full validated rawEnvelope on completion.
 * - Preserves reconciliation diagnostics for 202 / errors.
 * - fsync on every write before returning.
 * - No automatic stale-lock deletion.
 * - Defensive deep copies on all reads.
 * - Fixed error codes for policy rejections (no interpolated raw IDs).
 */

import { promises as fs, constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  LEDGER_HEADER_VERSION,
  MAX_LEDGER_FILE_BYTES,
  MAX_LEDGER_ENTRY_BYTES,
  MAX_TOTAL_ATTEMPTS,
  MAX_PER_SESSION_ATTEMPTS,
  type LedgerEntry,
  type LedgerEntryState,
  type HostedRawResult,
  type HostedCandidate,
  type ReviewBinding,
  type ReconciliationDiagnostics,
} from "./types.js";
import { validateHostedResponse } from "./validate.js";

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const CANDIDATE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

export interface ReservationParams {
  idempotencyKey: string;
  bodySha256: string;
  sessionId: string;
  basisRevision: number;
  basisDigest: string;
  requestBody: string;
  candidateIds?: string[];
  candidatePayloadHashes?: Record<string, string>;
}

export interface TransitionParams {
  state: "selected" | "refused" | "unknown" | "error";
  httpStatus?: number | null;
  detail?: string;
  selectedCandidateId?: string | null;
  rawEnvelope?: HostedRawResult;
  binding?: ReviewBinding;
  diagnostics?: ReconciliationDiagnostics;
}

export class ReservationLedger {
  private readonly _path: string;
  private readonly _lockPath: string;
  private readonly _maxAttempts: number;
  private readonly _maxPerSession: number;
  private _entries: LedgerEntry[] = [];
  private _replayed = false;
  private _activeKey: string | null = null;

  constructor(
    ledgerPath: string,
    maxAttempts = MAX_TOTAL_ATTEMPTS,
    maxPerSession = MAX_PER_SESSION_ATTEMPTS
  ) {
    if (!Number.isFinite(maxAttempts) || !Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(maxPerSession) || !Number.isInteger(maxPerSession) || maxPerSession <= 0) {
      throw new Error("maxPerSession must be a positive integer");
    }

    this._path = ledgerPath;
    this._lockPath = `${ledgerPath}.lock`;
    this._maxAttempts = maxAttempts;
    this._maxPerSession = maxPerSession;
  }

  /**
   * Scoped exclusive lock file via O_CREAT | O_EXCL.
   * Polls briefly for contention; throws ConcurrencyLimitError on timeout.
   * Cleans up handle and unlinks lock file in finally.
   * Never deletes stale locks automatically.
   */
  private async _withLock<T>(fn: () => Promise<T>): Promise<T> {
    const maxWaitMs = 3000;
    const pollIntervalMs = 15;
    const startTime = Date.now();
    let handle: fs.FileHandle | null = null;

    while (true) {
      try {
        handle = await fs.open(
          this._lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600
        );
        break;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error && (error.code === "EEXIST" || error.code === "EACCES")) {
          if (Date.now() - startTime >= maxWaitMs) {
            throw new ConcurrencyLimitError("concurrency_limit_exceeded");
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        throw err;
      }
    }

    try {
      return await fn();
    } finally {
      try {
        if (handle) {
          await handle.close();
        }
      } finally {
        await fs.unlink(this._lockPath).catch(() => undefined);
      }
    }
  }

  /**
   * Explicitly initializes a fresh ledger file with format header and mode 0o600.
   * Fails if the file already exists (wx mode).
   */
  async initFresh(): Promise<void> {
    try {
      const handle = await fs.open(
        this._path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      try {
        const header = JSON.stringify({
          version: LEDGER_HEADER_VERSION,
          format: "jsonl",
          createdAt: new Date().toISOString(),
        }) + "\n";
        await handle.writeFile(header, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw new LedgerInitError(
        `Failed to initialize fresh ledger at '${this._path}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this._entries = [];
    this._replayed = true;
    this._activeKey = null;
  }

  /**
   * Reads, parses, and validates the ledger file from disk.
   * Throws LedgerMissingError if missing, LedgerCorruptError if corrupt/truncated/headerless.
   */
  private async _readAndValidateLedger(): Promise<{
    entries: LedgerEntry[];
    activeKey: string | null;
    distinctKeys: Set<string>;
  }> {
    let stat;
    try {
      stat = await fs.stat(this._path);
    } catch {
      throw new LedgerMissingError(`Ledger file missing or inaccessible at '${this._path}'`);
    }

    if (stat.size > MAX_LEDGER_FILE_BYTES) {
      throw new LedgerCorruptError(`Ledger file size (${stat.size} bytes) exceeds limit of ${MAX_LEDGER_FILE_BYTES} bytes`);
    }

    if (stat.size === 0) {
      throw new LedgerCorruptError("Ledger is empty and missing required format header");
    }

    let raw: string;
    try {
      raw = await fs.readFile(this._path, "utf8");
    } catch (err) {
      throw new LedgerCorruptError(`Failed to read ledger file: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Require final newline
    if (!raw.endsWith("\n")) {
      throw new LedgerCorruptError("Ledger file is truncated: missing required final newline");
    }

    const lines = raw.split("\n");
    lines.pop(); // Remove trailing empty string from split on final \n

    if (lines.length === 0) {
      throw new LedgerCorruptError("Ledger file contains no lines");
    }

    // Line 1: format header
    const headerLine = lines[0];
    let headerParsed: unknown;
    try {
      headerParsed = JSON.parse(headerLine);
    } catch {
      throw new LedgerCorruptError("Ledger header line is not valid JSON");
    }

    if (
      !headerParsed ||
      typeof headerParsed !== "object" ||
      Array.isArray(headerParsed)
    ) {
      throw new LedgerCorruptError("Ledger header is not an object");
    }

    const headerObj = headerParsed as Record<string, unknown>;
    if (headerObj.version !== LEDGER_HEADER_VERSION) {
      throw new LedgerCorruptError(`Ledger header version mismatch: expected '${LEDGER_HEADER_VERSION}'`);
    }
    if (headerObj.format !== "jsonl") {
      throw new LedgerCorruptError("Ledger header format must be 'jsonl'");
    }
    if (typeof headerObj.createdAt !== "string" || isNaN(Date.parse(headerObj.createdAt))) {
      throw new LedgerCorruptError("Ledger header createdAt must be a valid ISO timestamp");
    }

    // Lines 2..N: records
    const entries: LedgerEntry[] = [];
    const reservationsByKey = new Map<string, LedgerEntry>();
    const terminalStateByKey = new Map<string, LedgerEntryState>();

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > MAX_LEDGER_ENTRY_BYTES) {
        throw new LedgerCorruptError(`Line ${i + 1} exceeds record limit of ${MAX_LEDGER_ENTRY_BYTES} bytes`);
      }

      if (!line.trim()) {
        throw new LedgerCorruptError(`Line ${i + 1} is empty/truncated`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new LedgerCorruptError(`Line ${i + 1} is not valid JSON`);
      }

      const entry = validateLedgerEntry(parsed, i + 1);

      if (entry.state === "reserved") {
        if (reservationsByKey.has(entry.idempotencyKey)) {
          throw new LedgerCorruptError(`Line ${i + 1}: duplicate reservation record for key '${entry.idempotencyKey}'`);
        }
        if (!entry.requestBody) {
          throw new LedgerCorruptError(`Line ${i + 1}: reservation record missing requestBody`);
        }

        // Validate recomputed bodySha256
        const recomputedSha = createHash("sha256").update(entry.requestBody, "utf8").digest("hex");
        if (recomputedSha !== entry.bodySha256) {
          throw new LedgerCorruptError(
            `Line ${i + 1}: body SHA-256 mismatch for key '${entry.idempotencyKey}' (recomputed ${recomputedSha} != stored ${entry.bodySha256})`
          );
        }

        // Validate request body is valid JSON
        try {
          JSON.parse(entry.requestBody);
        } catch {
          throw new LedgerCorruptError(`Line ${i + 1}: request body for key '${entry.idempotencyKey}' is not valid JSON`);
        }

        reservationsByKey.set(entry.idempotencyKey, entry);
      } else {
        // Terminal transition
        if (!reservationsByKey.has(entry.idempotencyKey)) {
          throw new LedgerCorruptError(
            `Line ${i + 1}: transition to '${entry.state}' without preceding reservation for key '${entry.idempotencyKey}'`
          );
        }
        if (terminalStateByKey.has(entry.idempotencyKey)) {
          throw new LedgerCorruptError(
            `Line ${i + 1}: duplicate terminal transition for key '${entry.idempotencyKey}' (already '${terminalStateByKey.get(entry.idempotencyKey)}')`
          );
        }

        const res = reservationsByKey.get(entry.idempotencyKey)!;

        // Terminal entries must match reservation session/basis/mapping
        if (entry.sessionId !== res.sessionId) {
          throw new LedgerCorruptError(`Line ${i + 1}: terminal entry sessionId mismatch`);
        }
        if (entry.basisRevision !== res.basisRevision) {
          throw new LedgerCorruptError(`Line ${i + 1}: terminal entry basisRevision mismatch`);
        }
        if (entry.basisDigest !== res.basisDigest) {
          throw new LedgerCorruptError(`Line ${i + 1}: terminal entry basisDigest mismatch`);
        }
        if (entry.bodySha256 !== res.bodySha256) {
          throw new LedgerCorruptError(`Line ${i + 1}: terminal entry bodySha256 mismatch`);
        }
        if (res.candidatePayloadHashes && entry.candidatePayloadHashes) {
          const resHashes = res.candidatePayloadHashes;
          const entryHashes = entry.candidatePayloadHashes;
          const rKeys = Object.keys(resHashes).sort();
          const eKeys = Object.keys(entryHashes).sort();
          if (
            rKeys.length !== eKeys.length ||
            !rKeys.every((k, idx) => k === eKeys[idx] && resHashes[k] === entryHashes[k])
          ) {
            throw new LedgerCorruptError(`Line ${i + 1}: terminal entry candidatePayloadHashes mismatch`);
          }
        }

        // Validate saved full envelope against submitted candidates on replay
        if (entry.rawEnvelope) {
          let submittedCandidates: HostedCandidate[] | undefined;
          if (res.requestBody) {
            try {
              const reqObj = JSON.parse(res.requestBody);
              if (reqObj && Array.isArray(reqObj.candidates)) {
                submittedCandidates = reqObj.candidates;
              }
            } catch {
              // Ignore
            }
          }

          try {
            validateHostedResponse(entry.rawEnvelope, submittedCandidates);
          } catch {
            throw new LedgerCorruptError(`Line ${i + 1}: rawEnvelope failed response contract validation on replay`);
          }

          if (entry.state === "selected") {
            if (entry.rawEnvelope.result.outcome !== "selected") {
              throw new LedgerCorruptError(`Line ${i + 1}: selected transition rawEnvelope outcome must be 'selected'`);
            }
            if (entry.rawEnvelope.result.selected_candidate_id !== entry.selectedCandidateId) {
              throw new LedgerCorruptError(`Line ${i + 1}: selectedCandidateId mismatch with rawEnvelope`);
            }
          } else if (entry.state === "refused") {
            if (entry.rawEnvelope.result.outcome !== "governed_noop_refusal") {
              throw new LedgerCorruptError(`Line ${i + 1}: refused transition rawEnvelope outcome must be 'governed_noop_refusal'`);
            }
            if (entry.selectedCandidateId !== null && entry.selectedCandidateId !== undefined) {
              throw new LedgerCorruptError(`Line ${i + 1}: selectedCandidateId must be null for refused transition`);
            }
          }
        }

        terminalStateByKey.set(entry.idempotencyKey, entry.state);
      }

      entries.push(entry);
    }

    // Determine active key (reserved without terminal transition)
    let activeKey: string | null = null;
    for (const key of reservationsByKey.keys()) {
      if (!terminalStateByKey.has(key)) {
        activeKey = key;
        break;
      }
    }

    return {
      entries,
      activeKey,
      distinctKeys: new Set(reservationsByKey.keys()),
    };
  }

  /**
   * Replays an existing ledger file and validates all entries.
   * Missing, corrupt, or truncated ledger throws to disable live mode.
   * Returns defensive deep copies.
   */
  async replay(): Promise<LedgerEntry[]> {
    const { entries, activeKey } = await this._readAndValidateLedger();
    this._entries = entries;
    this._activeKey = activeKey;
    this._replayed = true;

    return JSON.parse(JSON.stringify(this._entries));
  }

  /**
   * Reserves an evaluation attempt BEFORE token exchange and HTTP dispatch.
   * Synchronized via scoped exclusive lock file across promises and instances.
   * Syncs to disk with fsync before returning.
   */
  async reserve(params: ReservationParams): Promise<void> {
    await this._withLock(async () => {
      // Reload and validate committed history under lock
      const { entries, activeKey, distinctKeys } = await this._readAndValidateLedger();
      this._entries = entries;
      this._activeKey = activeKey;
      this._replayed = true;

      // Guard 1: Active in-flight concurrency (max 1 active globally)
      if (this._activeKey !== null) {
        throw new ConcurrencyLimitError("concurrency_limit_exceeded");
      }

      // Guard 2: Total attempts budget (max 10 total distinct attempts)
      if (distinctKeys.size >= this._maxAttempts && !distinctKeys.has(params.idempotencyKey)) {
        throw new BudgetExceededError("budget_exceeded");
      }

      // Guard 3: Per-session budget (max 2 per session)
      const sessionKeys = this.getDistinctKeysForSession(params.sessionId);
      if (sessionKeys.size >= this._maxPerSession && !sessionKeys.has(params.idempotencyKey)) {
        throw new SessionBudgetExceededError("session_budget_exceeded");
      }

      // Guard 4: Duplicate key rejection
      if (distinctKeys.has(params.idempotencyKey)) {
        throw new DuplicateIdempotencyKeyError("duplicate_idempotency_key");
      }

      const entry: LedgerEntry = {
        timestamp: new Date().toISOString(),
        idempotencyKey: params.idempotencyKey,
        bodySha256: params.bodySha256,
        sessionId: params.sessionId,
        basisRevision: params.basisRevision,
        basisDigest: params.basisDigest,
        state: "reserved",
        requestBody: params.requestBody,
        candidateIds: params.candidateIds,
        candidatePayloadHashes: params.candidatePayloadHashes,
      };

      await this._appendWithSync(entry);
      this._entries.push(entry);
      this._activeKey = params.idempotencyKey;
    });
  }

  /**
   * Records completion, unknown, or error transition for an in-flight reservation.
   * Synchronized via scoped exclusive lock file across promises and instances.
   * Syncs to disk with fsync before returning.
   */
  async recordTransition(idempotencyKey: string, params: TransitionParams): Promise<void> {
    await this._withLock(async () => {
      // Reload and validate committed history under lock
      const { entries, activeKey } = await this._readAndValidateLedger();
      this._entries = entries;
      this._activeKey = activeKey;
      this._replayed = true;

      // Find original reservation
      const reservation = this._entries.find(
        (e) => e.idempotencyKey === idempotencyKey && e.state === "reserved"
      );
      if (!reservation) {
        throw new Error(`Cannot record transition: no reservation found for key '${idempotencyKey}'`);
      }

      // Check duplicate transition
      const existingTransition = this._entries.find(
        (e) => e.idempotencyKey === idempotencyKey && e.state !== "reserved"
      );
      if (existingTransition) {
        throw new Error(`Idempotency key '${idempotencyKey}' has already transitioned to '${existingTransition.state}'`);
      }

      const entry: LedgerEntry = {
        timestamp: new Date().toISOString(),
        idempotencyKey,
        bodySha256: reservation.bodySha256,
        sessionId: reservation.sessionId,
        basisRevision: reservation.basisRevision,
        basisDigest: reservation.basisDigest,
        state: params.state,
        httpStatus: params.httpStatus ?? null,
        detail: params.detail,
        selectedCandidateId: params.selectedCandidateId ?? null,
        candidateIds: reservation.candidateIds,
        rawEnvelope: params.rawEnvelope,
        candidatePayloadHashes: reservation.candidatePayloadHashes,
        diagnostics: params.diagnostics,
      };

      await this._appendWithSync(entry);
      this._entries.push(entry);

      if (this._activeKey === idempotencyKey) {
        this._activeKey = null;
      }
    });
  }

  private async _appendWithSync(entry: LedgerEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_LEDGER_ENTRY_BYTES) {
      throw new Error(`Ledger entry exceeds maximum line limit (${bytes} > ${MAX_LEDGER_ENTRY_BYTES} bytes)`);
    }

    // Enforce file size cap on append
    let currentSize = 0;
    try {
      const stat = await fs.stat(this._path);
      currentSize = stat.size;
    } catch {
      // If file doesn't exist yet, size is 0
    }

    if (currentSize + bytes > MAX_LEDGER_FILE_BYTES) {
      throw new BudgetExceededError("Ledger file exceeds maximum file size limit");
    }

    const handle = await fs.open(this._path, constants.O_WRONLY | constants.O_APPEND, 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync(); // fsync to guarantee persistence before returning
    } finally {
      await handle.close();
    }
  }

  /** Returns all distinct idempotency keys across all reservation entries. */
  getDistinctKeys(): Set<string> {
    return new Set(this._entries.filter((e) => e.state === "reserved").map((e) => e.idempotencyKey));
  }

  /** Returns all distinct idempotency keys for a given session. */
  getDistinctKeysForSession(sessionId: string): Set<string> {
    const set = new Set<string>();
    for (const e of this._entries) {
      if (e.state === "reserved" && e.sessionId === sessionId) {
        set.add(e.idempotencyKey);
      }
    }
    return set;
  }

  /** Total evaluation attempts count (counts all attempts including unknown/errors). */
  countTotalAttempts(): number {
    return this.getDistinctKeys().size;
  }

  /** Session evaluation attempts count. */
  countSessionAttempts(sessionId: string): number {
    return this.getDistinctKeysForSession(sessionId).size;
  }

  /** Whether an active un-transitioned reservation is currently in-flight. */
  hasActiveReservation(): boolean {
    return this._activeKey !== null;
  }

  /** Current active in-flight idempotency key, if any. */
  get activeKey(): string | null {
    return this._activeKey;
  }

  /** Read-only defensive deep copy of all entries. */
  getEntries(): LedgerEntry[] {
    return JSON.parse(JSON.stringify(this._entries));
  }

  hasKey(key: string): boolean {
    return this.getDistinctKeys().has(key);
  }
}

function validateLedgerEntry(parsed: unknown, lineNumber: number): LedgerEntry {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LedgerCorruptError(`Line ${lineNumber}: entry is not a valid JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.timestamp !== "string" || isNaN(Date.parse(obj.timestamp))) {
    throw new LedgerCorruptError(`Line ${lineNumber}: timestamp must be a valid ISO timestamp`);
  }
  if (typeof obj.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_REGEX.test(obj.idempotencyKey)) {
    throw new LedgerCorruptError(`Line ${lineNumber}: idempotencyKey must be 16..128 safe chars`);
  }
  if (typeof obj.sessionId !== "string" || !SESSION_ID_REGEX.test(obj.sessionId) || obj.sessionId.length === 0) {
    throw new LedgerCorruptError(`Line ${lineNumber}: sessionId must be 1..128 safe chars`);
  }
  if (
    typeof obj.basisRevision !== "number" ||
    !Number.isInteger(obj.basisRevision) ||
    obj.basisRevision < 1
  ) {
    throw new LedgerCorruptError(`Line ${lineNumber}: basisRevision must be an integer >= 1`);
  }
  if (typeof obj.basisDigest !== "string" || !SHA256_HEX_REGEX.test(obj.basisDigest)) {
    throw new LedgerCorruptError(`Line ${lineNumber}: basisDigest must be a 64-hex string`);
  }
  if (typeof obj.bodySha256 !== "string" || !SHA256_HEX_REGEX.test(obj.bodySha256)) {
    throw new LedgerCorruptError(`Line ${lineNumber}: bodySha256 must be a 64-hex string`);
  }

  const validStates = ["reserved", "selected", "refused", "unknown", "error"];
  if (typeof obj.state !== "string" || !validStates.includes(obj.state)) {
    throw new LedgerCorruptError(`Line ${lineNumber}: state '${String(obj.state)}' is invalid`);
  }

  // Validate candidateIds if present
  let candidateIds: string[] | undefined;
  if (obj.candidateIds !== undefined) {
    if (!Array.isArray(obj.candidateIds) || obj.candidateIds.length < 1 || obj.candidateIds.length > 8) {
      throw new LedgerCorruptError(`Line ${lineNumber}: candidateIds must be an array of 1..8 items`);
    }
    for (const cid of obj.candidateIds) {
      if (typeof cid !== "string" || !CANDIDATE_ID_REGEX.test(cid)) {
        throw new LedgerCorruptError(`Line ${lineNumber}: invalid candidate_id in candidateIds`);
      }
    }
    candidateIds = obj.candidateIds as string[];
  }

  // Validate candidatePayloadHashes if present
  let candidatePayloadHashes: Record<string, string> | undefined;
  if (obj.candidatePayloadHashes !== undefined) {
    if (typeof obj.candidatePayloadHashes !== "object" || obj.candidatePayloadHashes === null || Array.isArray(obj.candidatePayloadHashes)) {
      throw new LedgerCorruptError(`Line ${lineNumber}: candidatePayloadHashes must be an object`);
    }
    const hashes = obj.candidatePayloadHashes as Record<string, unknown>;
    candidatePayloadHashes = {};
    for (const [cid, h] of Object.entries(hashes)) {
      if (!CANDIDATE_ID_REGEX.test(cid)) {
        throw new LedgerCorruptError(`Line ${lineNumber}: invalid candidate_id key in candidatePayloadHashes`);
      }
      if (typeof h !== "string" || !SHA256_HEX_REGEX.test(h)) {
        throw new LedgerCorruptError(`Line ${lineNumber}: invalid 64-hex SHA-256 for candidate '${cid}'`);
      }
      candidatePayloadHashes[cid] = h;
    }
  }

  // Validate rawEnvelope if present
  let rawEnvelope: HostedRawResult | undefined;
  if (obj.rawEnvelope !== undefined) {
    try {
      rawEnvelope = validateHostedResponse(obj.rawEnvelope);
    } catch {
      throw new LedgerCorruptError(`Line ${lineNumber}: rawEnvelope failed response contract validation`);
    }

    if (obj.state === "selected") {
      if (rawEnvelope.result.outcome !== "selected") {
        throw new LedgerCorruptError(`Line ${lineNumber}: rawEnvelope outcome must be 'selected'`);
      }
      if (rawEnvelope.result.selected_candidate_id !== obj.selectedCandidateId) {
        throw new LedgerCorruptError(`Line ${lineNumber}: rawEnvelope selected_candidate_id does not match entry`);
      }
    } else if (obj.state === "refused") {
      if (rawEnvelope.result.outcome !== "governed_noop_refusal") {
        throw new LedgerCorruptError(`Line ${lineNumber}: rawEnvelope outcome must be 'governed_noop_refusal'`);
      }
      if (obj.selectedCandidateId !== null && obj.selectedCandidateId !== undefined) {
        throw new LedgerCorruptError(`Line ${lineNumber}: selectedCandidateId must be null for refused state`);
      }
    }
  }

  // Validate diagnostics if present
  let diagnostics: ReconciliationDiagnostics | undefined;
  if (obj.diagnostics !== undefined) {
    if (typeof obj.diagnostics !== "object" || obj.diagnostics === null || Array.isArray(obj.diagnostics)) {
      throw new LedgerCorruptError(`Line ${lineNumber}: diagnostics must be an object`);
    }
    const d = obj.diagnostics as Record<string, unknown>;
    if (typeof d.http_status !== "number" || !Number.isInteger(d.http_status)) {
      throw new LedgerCorruptError(`Line ${lineNumber}: diagnostics http_status must be an integer`);
    }
    if (typeof d.bodyComplete !== "boolean") {
      throw new LedgerCorruptError(`Line ${lineNumber}: diagnostics bodyComplete must be a boolean`);
    }
    if (d.bodyComplete) {
      if (typeof d.response_sha256 !== "string" || !SHA256_HEX_REGEX.test(d.response_sha256)) {
        throw new LedgerCorruptError(`Line ${lineNumber}: diagnostics response_sha256 must be 64-hex string when bodyComplete is true`);
      }
    } else {
      if (d.response_sha256 !== undefined) {
        throw new LedgerCorruptError(`Line ${lineNumber}: diagnostics response_sha256 must be undefined when bodyComplete is false`);
      }
    }
    if (d.receipt_id !== undefined && (typeof d.receipt_id !== "string" || !d.receipt_id.startsWith("eval_"))) {
      throw new LedgerCorruptError(`Line ${lineNumber}: diagnostics receipt_id must start with eval_`);
    }
    diagnostics = obj.diagnostics as ReconciliationDiagnostics;
  }

  return {
    timestamp: obj.timestamp,
    idempotencyKey: obj.idempotencyKey,
    bodySha256: obj.bodySha256,
    sessionId: obj.sessionId,
    basisRevision: obj.basisRevision,
    basisDigest: obj.basisDigest,
    state: obj.state as LedgerEntryState,
    requestBody: typeof obj.requestBody === "string" ? obj.requestBody : undefined,
    httpStatus: typeof obj.httpStatus === "number" ? obj.httpStatus : null,
    detail: typeof obj.detail === "string" ? obj.detail : undefined,
    selectedCandidateId: typeof obj.selectedCandidateId === "string" ? obj.selectedCandidateId : null,
    candidateIds,
    rawEnvelope,
    candidatePayloadHashes,
    diagnostics,
  };
}

export class LedgerMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerMissingError";
  }
}

export class LedgerCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCorruptError";
  }
}

export class LedgerInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInitError";
  }
}

export class ConcurrencyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyLimitError";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class SessionBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBudgetExceededError";
  }
}

export class DuplicateIdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateIdempotencyKeyError";
  }
}
