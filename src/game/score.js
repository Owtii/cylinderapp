import { TUNING, CLEAN, PLOW } from '../tuning.js';

/**
 * Run statistics and the perfect chain.
 *
 * There is no points system in v2 — your weight IS your score, and the house is the
 * target. What this tracks is the chain (consecutive smashes without a block, which
 * ignites the roller and adds a music layer), the medal thresholds, and the numbers
 * the run-end screen needs to make someone press restart.
 */
export class Score {
  constructor() {
    this.best = { weight: 0, medal: null };
    this.smashTimes = new Float64Array(16);
    this.reset();
  }

  reset() {
    this.chain = 0;
    this.bestChain = 0;
    this.smashed = 0;
    this.absorbed = 0;
    this.blocked = 0;
    this.nearMisses = 0;
    this.zonesCleared = 0;
    this.smashTimes.fill(-Infinity);
    this.smashCursor = 0;
    this.startTime = 0;
  }

  registerSmash(weight, outcome, simTime) {
    this.smashed++;
    if (isFinite(weight)) this.absorbed += weight;
    this.chain++;
    if (this.chain > this.bestChain) this.bestChain = this.chain;
    this.smashTimes[this.smashCursor] = simTime;
    this.smashCursor = (this.smashCursor + 1) % this.smashTimes.length;
    return this.chain;
  }

  registerBlock() {
    this.blocked++;
    this.chain = 0;
  }

  registerNearMiss() {
    this.nearMisses++;
  }

  /** True when `n` smashes landed inside `window` seconds — the slow-motion trigger. */
  smashesWithin(n, windowSeconds, simTime) {
    if (n > this.smashTimes.length) return false;
    let count = 0;
    for (let i = 0; i < this.smashTimes.length; i++) {
      // Unused slots hold -Infinity, so the window test alone rejects them; a zero
      // sentinel would collide with simTime 0 on the run's first fixed step.
      if (simTime - this.smashTimes[i] <= windowSeconds) count++;
    }
    return count >= n;
  }

  get ignited() {
    return this.chain >= TUNING.score.chainIgniteAt;
  }

  /** 0..1 intensity for the music layering. */
  get chainIntensity() {
    return Math.min(1, this.chain / (TUNING.score.chainIgniteAt * 1.5));
  }

  /** Which medal a final weight earns, or null. */
  medalFor(weight) {
    const h = TUNING.finale.houseWeight;
    const M = TUNING.medals;
    if (weight >= h * M.gold) return 'gold';
    if (weight >= h * M.silver) return 'silver';
    if (weight >= h * M.bronze) return 'bronze';
    return null;
  }

  /** The threshold the player is reaching for next, for the run-end screen. */
  nextMedal(weight) {
    const h = TUNING.finale.houseWeight;
    const M = TUNING.medals;
    if (weight < h * M.bronze) return { name: 'bronze', at: h * M.bronze };
    if (weight < h * M.silver) return { name: 'silver', at: h * M.silver };
    if (weight < h * M.gold) return { name: 'gold', at: h * M.gold };
    return null;
  }

  finish(weight) {
    const medal = this.medalFor(weight);
    if (weight > this.best.weight) this.best = { weight, medal };
    return medal;
  }
}
