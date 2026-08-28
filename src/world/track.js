import { TUNING } from '../tuning.js';
import { DEG } from '../core/math.js';

/**
 * The ramp's centreline profile.
 *
 * Coordinates: the player travels toward -Z. `d` is travel distance in metres and
 * increases forward, so `z = -d`. The ramp descends, so `heightAt(d)` returns
 * values that get more negative as d grows.
 *
 * Piecewise-linear over arbitrary-length segments (v1 assumed fixed 80 m chunks;
 * zones here are whatever length their pacing target works out to, and the finale
 * steepens on its own schedule).
 */
export class TrackProfile {
  constructor() {
    this.starts = [0];       // d at the start of segment i
    this.slopes = [];        // radians
    this.startY = [0];       // world Y at the start of segment i
    this.length = 0;
  }

  reset() {
    this.starts.length = 1; this.starts[0] = 0;
    this.slopes.length = 0;
    this.startY.length = 1; this.startY[0] = 0;
    this.length = 0;
  }

  /** Append a segment. Returns its index. */
  push(lengthM, slopeDeg) {
    const i = this.slopes.length;
    const rad = slopeDeg * DEG;
    this.slopes.push(rad);
    this.starts[i] = this.length;
    this.length += lengthM;
    this.starts[i + 1] = this.length;
    this.startY[i + 1] = this.startY[i] - Math.tan(rad) * lengthM;
    return i;
  }

  /** Index of the segment containing d (clamped to the ends). */
  indexAt(d) {
    const n = this.slopes.length;
    if (n === 0) return 0;
    // Segments are few (tens), and lookups are coherent, so a guarded linear scan
    // from a remembered cursor beats a binary search here.
    let i = this._cursor || 0;
    if (i >= n) i = n - 1;
    while (i > 0 && d < this.starts[i]) i--;
    while (i < n - 1 && d >= this.starts[i + 1]) i++;
    this._cursor = i;
    return i;
  }

  slopeAt(d) {
    if (this.slopes.length === 0) return TUNING.world.baseSlopeDeg * DEG;
    return this.slopes[this.indexAt(d)];
  }

  heightAt(d) {
    if (this.slopes.length === 0) return -Math.tan(TUNING.world.baseSlopeDeg * DEG) * d;
    const i = this.indexAt(d);
    return this.startY[i] - Math.tan(this.slopes[i]) * (d - this.starts[i]);
  }

  static dFromZ(z) { return -z; }
  static zFromD(d) { return -d; }
}

export const ROAD_HALF = TUNING.world.roadWidth / 2;
export const LANE_WIDTH = TUNING.world.laneWidth;
export const LANE_COUNT = TUNING.world.laneCount;

export function laneX(lane) {
  const n = TUNING.world.laneCount;
  return (lane - (n - 1) / 2) * TUNING.world.laneWidth;
}

/** Lane index containing x, clamped into range. */
export function laneAt(x) {
  const n = TUNING.world.laneCount;
  const i = Math.floor((x + ROAD_HALF) / TUNING.world.laneWidth);
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** Left edge x of a lane. */
export function laneLeft(lane) { return laneX(lane) - TUNING.world.laneWidth * 0.5; }
/** Right edge x of a lane. */
export function laneRight(lane) { return laneX(lane) + TUNING.world.laneWidth * 0.5; }

/**
 * Is x inside the inclusive lane span [from, to]?
 *
 * Holes and §8's narrows are both authored as lane spans and both have to answer
 * "is there road under this point", so the arithmetic lives here once rather than
 * being rewritten in the streamer, the winnability proof and the road builder.
 */
export function inLaneSpan(x, from, to) {
  return x > laneLeft(from) && x < laneRight(to);
}

/**
 * The grade bound from §6.1: the highway never levels out and never climbs, so
 * every segment the generator emits is clamped into [minSlopeDeg, maxSlopeDeg]
 * before it reaches the profile. Clamping rather than asserting because the only
 * thing worse than an out-of-range grade is a track that fails to build.
 */
export function clampSlopeDeg(deg) {
  const W = TUNING.world;
  return deg < W.minSlopeDeg ? W.minSlopeDeg : deg > W.maxSlopeDeg ? W.maxSlopeDeg : deg;
}
