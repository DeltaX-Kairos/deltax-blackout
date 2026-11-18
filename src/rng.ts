/**
 * RNG interface and seeded Mulberry32 implementation.
 * All non-deterministic simulation draws use only the injected RNG — never Math.random().
 */

export interface Rng {
  /** Returns the next pseudo-random number in [0, 1). */
  next(): number;
  /** Returns the next integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number;
}

/**
 * Mulberry32: a fast, high-quality 32-bit seeded PRNG.
 * Produces the same sequence for the same seed on every initialisation.
 */
export class Mulberry32 implements Rng {
  private state: number;

  constructor(seed: number) {
    // Ensure a 32-bit unsigned integer seed.
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}
