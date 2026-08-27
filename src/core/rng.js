/**
 * Deterministic PRNG (mulberry32). Level generation is seeded so a run can be
 * replayed and so chunk content is stable regardless of frame timing.
 */
export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  reseed(seed) {
    this.seed = seed >>> 0;
    this.state = this.seed;
    return this;
  }

  /** [0,1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [lo,hi) */
  range(lo, hi) {
    return lo + (hi - lo) * this.next();
  }

  /** Integer in [lo,hi] inclusive. */
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  /** ±amount */
  spread(amount) {
    return (this.next() * 2 - 1) * amount;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * Weighted pick. `weights[i]` corresponds to `items[i]`. Returns the item.
   * Allocation-free.
   */
  pickWeighted(items, weights) {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += weights[i];
    if (total <= 0) return items[0];
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}

/** A shared scratch RNG for non-deterministic cosmetic use (particles, audio). */
export const fxRng = new Rng(0xC0FFEE);
