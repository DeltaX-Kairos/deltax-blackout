/**
 * Clock interface and implementation.
 * All time-dependent logic inside the Recovery_Core references only the
 * injected Clock — never Date.now() or performance.now().
 */

export interface Clock {
  currentTick(): number;
}

/**
 * Explicit-advance clock for deterministic simulation.
 * Callers call advance() to move to the next tick.
 */
export class TickClock implements Clock {
  private _tick: number;

  constructor(initialTick = 0) {
    this._tick = initialTick;
  }

  currentTick(): number {
    return this._tick;
  }

  /**
   * Advance to the given tick. Rejects out-of-order advances.
   */
  advance(toTick: number): void {
    if (toTick <= this._tick) {
      throw new Error(
        `TickClock: cannot advance to tick ${toTick} from current tick ${this._tick} (must be strictly greater)`
      );
    }
    this._tick = toTick;
  }

  /** Advance by exactly 1 tick. */
  next(): number {
    this._tick += 1;
    return this._tick;
  }
}
