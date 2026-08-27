import { TUNING } from '../tuning.js';
import { PULVERIZE, PLOW } from '../physics/collisions.js';

/**
 * Score, combo and run stats.
 *
 * The combo is the thing players actually chase — it drives the music layering
 * and the rising pentatonic ding, so it needs to be trivially cheap to read.
 */
export class Score {
  constructor() {
    this.best = 0;
    /**
     * Ring buffer of kill timestamps for the slow-motion trigger. Allocated once
     * and refilled with -Infinity rather than 0: simTime is 0 during the first
     * fixed step of a run, so a zero sentinel makes those kills invisible to the
     * trigger and silently costs a restart its first chain.
     */
    this.killTimes = new Float64Array(16);
    this.reset();
  }

  reset() {
    this.points = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.destroyed = 0;
    this.bestCombo = 1;
    this.peakMass = TUNING.player.startMass;
    this.killTimes.fill(-Infinity);
    this.killCursor = 0;
    this.lastDistanceScored = 0;
  }

  /** @returns {number} points awarded for this kill (already combo-multiplied). */
  registerKill(threshold, outcome, simTime) {
    const S = TUNING.score;
    const base = Math.max(
      S.minPoints,
      (isFinite(threshold) ? threshold : 0) * S.massToScore,
    );
    const styleBonus = outcome === PULVERIZE ? S.pulverizeBonus
      : outcome === PLOW ? S.plowBonus : 0;
    const gained = Math.round(base * styleBonus * this.combo);
    this.points += gained;
    this.destroyed++;

    this.combo = Math.min(S.comboMax, this.combo + 1);
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.comboTimer = S.comboWindow;

    this.killTimes[this.killCursor] = simTime;
    this.killCursor = (this.killCursor + 1) % this.killTimes.length;
    return gained;
  }

  /** True when `n` kills landed inside `window` seconds — the slow-mo trigger. */
  killsWithin(n, windowSeconds, simTime) {
    if (n > this.killTimes.length) return false;
    let count = 0;
    for (let i = 0; i < this.killTimes.length; i++) {
      // Unused slots hold -Infinity, so the window test alone rejects them.
      if (simTime - this.killTimes[i] <= windowSeconds) count++;
    }
    return count >= n;
  }

  registerBlocked() {
    this.combo = 1;
    this.comboTimer = 0;
  }

  addDistancePoints(distance) {
    const gain = distance - this.lastDistanceScored;
    if (gain > 0) {
      this.points += Math.round(gain * TUNING.score.distancePoints);
      this.lastDistanceScored = distance;
    }
  }

  update(dt) {
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }
  }

  /** 0..1 combo intensity used to drive the music layering. */
  get intensity() {
    return Math.min(1, (this.combo - 1) / 14);
  }

  finish() {
    if (this.points > this.best) this.best = this.points;
    return this.best;
  }
}
