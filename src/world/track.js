import { TUNING } from '../tuning.js';
import { DEG } from '../core/math.js';

/**
 * The hill's centreline profile.
 *
 * Coordinates: the player travels toward -Z. `d` ("distance") is travel distance
 * in metres and increases forward, so `z = -d`. The surface descends, so
 * `y = heightAt(d)` returns negative values that get more negative as d grows.
 *
 * Chunks are piecewise-linear: each has a constant slope, and each starts where
 * the previous one ended, so the road is C0-continuous with no seams.
 */
export class TrackProfile {
  constructor() {
    this.chunkLength = TUNING.world.chunkLength;
    /** Slope (radians) per chunk index. */
    this.slopes = [];
    /** World Y at the *start* of each chunk index. */
    this.startY = [0];
  }

  reset() {
    this.slopes.length = 0;
    this.startY.length = 1;
    this.startY[0] = 0;
  }

  /** Append a chunk with the given slope, in degrees. Returns its index. */
  pushChunk(slopeDeg) {
    const idx = this.slopes.length;
    const rad = slopeDeg * DEG;
    this.slopes.push(rad);
    this.startY[idx + 1] = this.startY[idx] - Math.tan(rad) * this.chunkLength;
    return idx;
  }

  get chunkCount() {
    return this.slopes.length;
  }

  chunkIndexAt(d) {
    const i = Math.floor(d / this.chunkLength);
    if (i < 0) return 0;
    if (i >= this.slopes.length) return Math.max(0, this.slopes.length - 1);
    return i;
  }

  slopeAt(d) {
    if (this.slopes.length === 0) return TUNING.world.baseSlopeDeg * DEG;
    return this.slopes[this.chunkIndexAt(d)];
  }

  /** Road surface height at travel distance `d`. */
  heightAt(d) {
    if (this.slopes.length === 0) return -Math.tan(TUNING.world.baseSlopeDeg * DEG) * d;
    const i = this.chunkIndexAt(d);
    const local = d - i * this.chunkLength;
    return this.startY[i] - Math.tan(this.slopes[i]) * local;
  }

  /** Height at the start of chunk `i`. */
  chunkStartY(i) {
    return this.startY[Math.min(i, this.startY.length - 1)];
  }

  /** Convert a world position to travel distance. */
  static dFromZ(z) { return -z; }
  static zFromD(d) { return -d; }
}

/** Half-width of the drivable road. */
export const ROAD_HALF = TUNING.world.roadWidth / 2;

/** Lane centre x for lane index 0..laneCount-1. */
export function laneX(lane) {
  const n = TUNING.world.laneCount;
  const w = TUNING.world.roadWidth / n;
  return -ROAD_HALF + w * (lane + 0.5);
}

export const LANE_WIDTH = TUNING.world.roadWidth / TUNING.world.laneCount;
