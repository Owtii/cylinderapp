/**
 * Fixed-capacity object pool with a free-list. No allocation after construction,
 * which is the whole point: the per-frame path must not create garbage.
 */
export class Pool {
  /**
   * @param {number} capacity
   * @param {() => object} factory Called `capacity` times up front.
   */
  constructor(capacity, factory) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    /** Indices of free slots. */
    this.free = new Int32Array(capacity);
    this.freeCount = capacity;
    /** Dense list of active indices, for iteration without scanning. */
    this.active = new Int32Array(capacity);
    this.activeCount = 0;
    /** Where each index lives inside `active`, or -1 when free. */
    this.activeSlot = new Int32Array(capacity).fill(-1);

    for (let i = 0; i < capacity; i++) {
      this.items[i] = factory(i);
      this.free[i] = capacity - 1 - i; // pop from the end → hand out 0,1,2...
    }
  }

  /** @returns {number} index of the acquired slot, or -1 when exhausted. */
  acquire() {
    if (this.freeCount === 0) return -1;
    const idx = this.free[--this.freeCount];
    this.activeSlot[idx] = this.activeCount;
    this.active[this.activeCount++] = idx;
    return idx;
  }

  /** Release a slot previously returned by `acquire`. Safe to call twice. */
  release(idx) {
    const slot = this.activeSlot[idx];
    if (slot < 0) return;
    const last = this.active[--this.activeCount];
    this.active[slot] = last;
    this.activeSlot[last] = slot;
    this.activeSlot[idx] = -1;
    this.free[this.freeCount++] = idx;
  }

  /** Oldest-first eviction target: the index that has been active longest. */
  oldestActive() {
    return this.activeCount > 0 ? this.active[0] : -1;
  }

  releaseAll() {
    while (this.activeCount > 0) this.release(this.active[this.activeCount - 1]);
  }

  get(idx) {
    return this.items[idx];
  }

  get isFull() {
    return this.freeCount === 0;
  }
}

/**
 * A ring allocator: never fails, recycles the oldest entry when full. Used where
 * dropping the newest event would be worse than stealing the oldest (fragments,
 * particles, popups).
 */
export class RingPool {
  constructor(capacity, factory) {
    this.pool = new Pool(capacity, factory);
    /** Monotonic acquisition order, for oldest-first stealing. */
    this.order = new Float64Array(capacity);
    this.counter = 0;
  }

  acquire() {
    let idx = this.pool.acquire();
    if (idx === -1) {
      // Steal the oldest active entry.
      let oldest = -1;
      let oldestOrder = Infinity;
      const a = this.pool.active;
      for (let i = 0; i < this.pool.activeCount; i++) {
        const k = a[i];
        if (this.order[k] < oldestOrder) {
          oldestOrder = this.order[k];
          oldest = k;
        }
      }
      if (oldest === -1) return -1;
      this.pool.release(oldest);
      idx = this.pool.acquire();
    }
    this.order[idx] = this.counter++;
    return idx;
  }

  release(idx) { this.pool.release(idx); }
  releaseAll() { this.pool.releaseAll(); }
  get(idx) { return this.pool.items[idx]; }
  get items() { return this.pool.items; }
  get active() { return this.pool.active; }
  get activeCount() { return this.pool.activeCount; }
  get capacity() { return this.pool.capacity; }
}
