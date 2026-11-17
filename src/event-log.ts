/**
 * Append-only causal event log.
 * Entries are never modified or deleted after appending.
 */

import type { LabEvent } from "./types.js";

export class EventLog {
  private readonly _events: LabEvent[] = [];
  private _counter = 0;

  /**
   * Append a new event. The event is frozen after appending.
   */
  append(event: LabEvent): void {
    // Defensive deep-freeze to prevent mutation of stored events.
    this._events.push(Object.freeze({ ...event }) as LabEvent);
    this._counter += 1;
  }

  /** All events in append order (read-only view). */
  get events(): readonly LabEvent[] {
    return this._events;
  }

  get length(): number {
    return this._events.length;
  }

  /**
   * Serialise to a JSON array string.
   * Re-parsing the result and re-serialising produces an identical string (round-trip property).
   */
  toJSON(): string {
    return JSON.stringify(this._events);
  }

  /**
   * Deserialise from a JSON array string produced by toJSON().
   */
  static fromJSON(json: string): EventLog {
    const parsed = JSON.parse(json) as LabEvent[];
    if (!Array.isArray(parsed)) {
      throw new Error("EventLog.fromJSON: input is not a JSON array");
    }
    const log = new EventLog();
    for (const event of parsed) {
      log.append(event);
    }
    return log;
  }

  /**
   * Generate a unique event ID using a monotonic counter + tick + kind.
   */
  static makeEventId(tick: number, kind: string, counter: number): string {
    return `evt-${kind.toLowerCase()}-t${tick}-${counter}`;
  }
}
