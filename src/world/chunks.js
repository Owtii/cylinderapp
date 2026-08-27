/**
 * TONNAGE — chunk generation.
 *
 * ── THE RHYTHM RULE ────────────────────────────────────────────────────────────
 *
 * A run is not a difficulty curve, it is a heartbeat: TENSION → RELEASE → TENSION.
 * Every chunk carries a tension value (see `CHUNK_TENSION`):
 *
 *   0 — release : warmup, buffet.  Nothing can hurt you. Go fast, break everything.
 *   1 — medium  : traffic, jump.   Reading and steering, with a real reward.
 *   2 — tension : gauntlet, chasm. One mistake costs mass or the run.
 *
 * The rule the generator enforces:
 *
 *   1. Never two high-tension chunks back to back. After a 2 you get a 0 or a 1.
 *      Two chasms in a row is not "harder", it is just exhausting, and the player
 *      stops feeling the danger because they never get to leave it.
 *   2. A BUFFET IMMEDIATELY AFTER A CHASM. This is the single most satisfying
 *      transition in the game and it is not negotiable. You spend eight seconds
 *      threading a one-lane bridge over nothing, jaw clenched, and then the road
 *      opens up and there are forty destructible things in front of you and you
 *      are travelling at 45 m/s. The relief has to be *physical*. That is the
 *      whole design in one seam — the chasm exists to make the buffet feel good.
 *   3. Release chunks are never two in a row either, or the hill goes slack.
 *
 * The generator (`src/world/generator.js`) owns the sequencing; this file owns the
 * weights it draws from (`chunkWeights`) and the contents of each chunk
 * (`buildChunk`). Both halves have to agree or the rhythm falls apart.
 *
 * ── GUARANTEES ────────────────────────────────────────────────────────────────
 *
 * Every returned chunk is *solvable* and is verified before it is handed back:
 *   • a lane path exists from the chunk's near edge to its far edge, walking
 *     forward one grid row at a time with a bounded lateral step (`cellPathExists`);
 *   • a lane path exists through every wall of blockers, with the lateral budget
 *     derived from the run-up distance (`wallPathFail`);
 *   • if either check fails the layout is REPAIRED — road is carved, blockers are
 *     removed — and re-checked, rather than shipped and hoped for.
 * No prop ever overlaps a hole cell, a ramp, or another prop. Row 0 is always
 * solid road so the player gets reaction distance across the chunk seam.
 *
 * Grid: `cells` is row-major, `index = row * lanes + lane`, row 0 = near edge
 * (d = 0), 8 rows of 10 m × 6 lanes of 4 m. 1 = road, 0 = hole.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, lerp } from '../core/math.js';
import { Rng } from '../core/rng.js';
import { ROAD_HALF, LANE_WIDTH, laneX } from './track.js';
import { PROPS, PROP_SETS } from './objects.js';

/* ─────────────────────────────────────────────────────────────── structure ── */

const GRID_Z = TUNING.world.chunkGridZ;
const LANES = TUNING.world.laneCount;
const CHUNK_LEN = TUNING.world.chunkLength;
const CELL_D = CHUNK_LEN / GRID_Z;
const CELL_COUNT = GRID_Z * LANES;

const MAX_PROPS = 96;
const MAX_PICKUPS = 32;
const MAX_RAMPS = 4;
const MAX_WALLS = 12;
/** Blockers within this many metres of each other read as one wall. */
const WALL_CLUSTER = 6;
const EPS = 1e-6;

export const CHUNK_TYPES = ['warmup', 'traffic', 'gauntlet', 'buffet', 'chasm', 'jump'];

/** 0 = release, 1 = medium, 2 = high tension. Used by the rhythm rule. */
export const CHUNK_TENSION = {
  warmup: 0, traffic: 1, gauntlet: 2, buffet: 0, chasm: 2, jump: 1,
};

/* ──────────────────────────────────────────────────────────────── scratch ── */

const _reachA = new Uint8Array(LANES);
const _reachB = new Uint8Array(LANES);
const _reachT = new Uint8Array(LANES);
const _reachPre = new Uint8Array(LANES);
const _wallD = new Float64Array(MAX_WALLS);
const _wallMask = new Uint8Array(MAX_WALLS * LANES);
const _wallRow = new Uint8Array(LANES);
let _wallCount = 0;
const _bridgeLane = new Float64Array(GRID_Z);
const _w3 = new Float64Array(3);
const _w2 = new Float64Array(2);
const _laneOrder = new Int32Array(LANES);

/** Shared return object for `chunkWeights` — read it immediately, never retain it. */
const _weights = {
  warmup: 0, traffic: 0, gauntlet: 0, buffet: 0, chasm: 0, jump: 0,
};

/* ────────────────────────────────────────────────────────────── spec pool ── */

function makeSpec() {
  const propStore = new Array(MAX_PROPS);
  for (let i = 0; i < MAX_PROPS; i++) {
    propStore[i] = { key: '', d: 0, x: 0, rotY: 0, scale: 1, ex: 0, ed: 0, blocker: false };
  }
  const pickupStore = new Array(MAX_PICKUPS);
  for (let i = 0; i < MAX_PICKUPS; i++) pickupStore[i] = { value: 0, d: 0, x: 0 };
  const rampStore = new Array(MAX_RAMPS);
  for (let i = 0; i < MAX_RAMPS; i++) {
    rampStore[i] = { d: 0, x: 0, width: 0, length: 0, height: 0 };
  }
  return {
    type: '',
    slopeDeg: TUNING.world.baseSlopeDeg,
    cells: new Uint8Array(CELL_COUNT),
    props: [],
    pickups: [],
    ramps: [],
    _propStore: propStore,
    _propCursor: 0,
    _pickupStore: pickupStore,
    _pickupCursor: 0,
    _rampStore: rampStore,
    _rampCursor: 0,
  };
}

/**
 * A ring of pre-built specs. The generator keeps at most
 * `chunksAhead + chunksBehind + 3` chunks alive, so a ring of 16 can never
 * recycle a spec that is still on screen — and steady-state generation stays
 * allocation-free even though it runs every 80 metres.
 */
const _specRing = [];
for (let i = 0; i < 16; i++) _specRing.push(makeSpec());
let _specCursor = 0;

function nextSpec(type) {
  const spec = _specRing[_specCursor];
  _specCursor = (_specCursor + 1) % _specRing.length;
  spec.type = type;
  spec.slopeDeg = TUNING.world.baseSlopeDeg;
  spec.cells.fill(1);
  spec.props.length = 0;
  spec.pickups.length = 0;
  spec.ramps.length = 0;
  spec._propCursor = 0;
  spec._pickupCursor = 0;
  spec._rampCursor = 0;
  return spec;
}

/* ───────────────────────────────────────────────────────────────── helpers ── */

/** Lerp an `[easy, hard]` tuning pair by difficulty. */
function pair(p, t) {
  return lerp(p[0], p[1], clamp01(t));
}

/** Roll an inclusive `[min, max]` tuning range. */
function irange(rng, p) {
  return rng.int(p[0] | 0, p[1] | 0);
}

function laneOf(x) {
  return clamp(Math.floor((x + ROAD_HALF) / LANE_WIDTH), 0, LANES - 1);
}

function rowOf(d) {
  return clamp(Math.floor(d / CELL_D), 0, GRID_Z - 1);
}

/** Every cell touched by the world-space rectangle must be road. */
function areaSolid(cells, x0, x1, d0, d1) {
  if (d1 < 0 || d0 > CHUNK_LEN) return true;   // outside the chunk: the seam is solid
  const laneA = clamp(Math.floor((x0 + EPS + ROAD_HALF) / LANE_WIDTH), 0, LANES - 1);
  const laneB = clamp(Math.floor((x1 - EPS + ROAD_HALF) / LANE_WIDTH), 0, LANES - 1);
  const rowA = clamp(Math.floor((d0 + EPS) / CELL_D), 0, GRID_Z - 1);
  const rowB = clamp(Math.floor((d1 - EPS) / CELL_D), 0, GRID_Z - 1);
  for (let row = rowA; row <= rowB; row++) {
    for (let lane = laneA; lane <= laneB; lane++) {
      if (cells[row * LANES + lane] !== 1) return false;
    }
  }
  return true;
}

/** Ramps are driving surfaces — nothing may stand on or immediately before one. */
function hitsRamp(spec, x0, x1, d0, d1) {
  const m = TUNING.gen.rampMargin;
  for (let i = 0; i < spec.ramps.length; i++) {
    const r = spec.ramps[i];
    const rx0 = r.x - r.width * 0.5 - m;
    const rx1 = r.x + r.width * 0.5 + m;
    const rd0 = r.d - m;
    const rd1 = r.d + r.length + m;
    if (x1 > rx0 && x0 < rx1 && d1 > rd0 && d0 < rd1) return true;
  }
  return false;
}

/**
 * Place one prop if it fits: on the road, on solid cells, clear of every ramp and
 * of every prop already placed. Returns the entry, or null when it does not fit.
 */
function place(spec, key, d, x, rotY, scale, gap) {
  const def = PROPS[key];
  if (!def || spec.props.length >= MAX_PROPS) return null;
  const s = scale || 1;
  const hw = def.size[0] * 0.5 * s;
  const hd = def.size[2] * 0.5 * s;
  const c = Math.abs(Math.cos(rotY));
  const sn = Math.abs(Math.sin(rotY));
  const ex = c * hw + sn * hd;
  const ed = sn * hw + c * hd;

  // Slide onto the road rather than failing: a barrier whose lane centre sits
  // 1.9 m from the shoulder still has to seal that lane, or every gauntlet wall
  // would have a permanent hole in its outermost lane.
  const margin = TUNING.gen.propEdgeMargin;
  const lo = -ROAD_HALF + margin + ex;
  const hi = ROAD_HALF - margin - ex;
  if (lo > hi) return null;                 // wider than the road itself
  const cx = clamp(x, lo, hi);
  if (d - ed < 0 || d + ed > CHUNK_LEN) return null;
  if (!areaSolid(spec.cells, cx - ex, cx + ex, d - ed, d + ed)) return null;
  if (hitsRamp(spec, cx - ex, cx + ex, d - ed, d + ed)) return null;

  const g = gap === undefined ? TUNING.gen.propGap : gap;
  for (let i = 0; i < spec.props.length; i++) {
    const p = spec.props[i];
    const need = p.blocker && def.blocker ? Math.min(g, TUNING.gen.blockerGap) : g;
    if (Math.abs(cx - p.x) < ex + p.ex + need && Math.abs(d - p.d) < ed + p.ed + need) {
      return null;
    }
  }

  const e = spec._propStore[spec._propCursor++];
  e.key = key;
  e.d = d;
  e.x = cx;
  e.rotY = rotY;
  e.scale = s;
  e.ex = ex;
  e.ed = ed;
  e.blocker = !!def.blocker;
  spec.props[spec.props.length] = e;
  return e;
}

/** Rejection-sample a placement around (d, x). The first try is the exact spot. */
function tryPlace(spec, rng, key, d, x, dJit, xJit, rotY, scale, gap) {
  const tries = TUNING.gen.placeAttempts | 0;
  for (let i = 0; i < tries; i++) {
    const dd = i === 0 ? d : d + rng.spread(dJit);
    const xx = i === 0 ? x : x + rng.spread(xJit);
    const e = place(spec, key, dd, xx, rotY, scale, gap);
    if (e) return e;
  }
  return null;
}

/** Swap-remove a prop. Order is irrelevant to every consumer. */
function removeProp(spec, i) {
  const n = spec.props.length;
  spec.props[i] = spec.props[n - 1];
  spec.props.length = n - 1;
}

function addPickup(spec, value, d, x) {
  if (spec.pickups.length >= MAX_PICKUPS) return null;
  if (d < 1 || d > CHUNK_LEN - 1) return null;
  if (x < -ROAD_HALF + 1 || x > ROAD_HALF - 1) return null;
  if (spec.cells[rowOf(d) * LANES + laneOf(x)] !== 1) return null;
  if (hitsRamp(spec, x - 0.5, x + 0.5, d - 0.5, d + 0.5)) return null;
  for (let i = 0; i < spec.props.length; i++) {
    const p = spec.props[i];
    if (Math.abs(x - p.x) < p.ex + 0.6 && Math.abs(d - p.d) < p.ed + 0.6) return null;
  }
  for (let i = 0; i < spec.pickups.length; i++) {
    const q = spec.pickups[i];
    if (Math.abs(x - q.x) < 1.6 && Math.abs(d - q.d) < 1.6) return null;
  }
  const e = spec._pickupStore[spec._pickupCursor++];
  e.value = value;
  e.d = d;
  e.x = x;
  spec.pickups[spec.pickups.length] = e;
  return e;
}

function addRamp(spec, d, x, width, length, height) {
  if (spec.ramps.length >= MAX_RAMPS) return null;
  const e = spec._rampStore[spec._rampCursor++];
  e.d = d;
  e.x = x;
  e.width = width;
  e.length = length;
  e.height = height;
  spec.ramps[spec.ramps.length] = e;
  return e;
}

/** Value roll: the big pickups get more common as the hill gets meaner. */
function pickupValue(rng, diff) {
  const v = TUNING.mass.pickupValues;
  const big = pair(TUNING.gen.pickupBigChance, diff);
  const mid = pair(TUNING.gen.pickupMidChance, diff);
  const r = rng.next();
  if (r < big) return v[v.length - 1];
  if (r < big + mid) return v[Math.min(1, v.length - 1)];
  return v[0];
}

/** Scatter pickups anywhere legal in a band of the chunk. */
function scatterPickups(spec, rng, count, dLo, dHi, diff) {
  for (let i = 0; i < count; i++) {
    for (let t = 0; t < 8; t++) {
      const d = rng.range(dLo, dHi);
      const x = laneX(rng.int(0, LANES - 1)) + rng.spread(1.1);
      if (addPickup(spec, pickupValue(rng, diff), d, x)) break;
    }
  }
}

/* ─────────────────────────────────────────────────────────────── prop mix ── */

/** Light destructibles: glass early, more steel later. */
function pickLight(rng, diff) {
  const a = TUNING.gen.lightMixEasy;
  const b = TUNING.gen.lightMixHard;
  _w3[0] = lerp(a[0], b[0], diff);
  _w3[1] = lerp(a[1], b[1], diff);
  _w3[2] = lerp(a[2], b[2], diff);
  return rng.pickWeighted(PROP_SETS.light, _w3);
}

/** Vehicles: sedans give way to SUVs, then buses, as the run gets long. */
function pickVehicle(rng, diff) {
  const a = TUNING.gen.vehicleMixEasy;
  const b = TUNING.gen.vehicleMixHard;
  _w3[0] = lerp(a[0], b[0], diff);
  _w3[1] = lerp(a[1], b[1], diff);
  _w3[2] = lerp(a[2], b[2], diff);
  if (diff < TUNING.gen.heavyPropDifficulty) _w3[2] = 0;   // no buses before you can move one
  return rng.pickWeighted(PROP_SETS.traffic, _w3);
}

/** The trophies. Only ever offered past `heavyPropDifficulty`. */
function pickHeavy(rng) {
  const m = TUNING.gen.heavyMix;
  _w2[0] = m[0];
  _w2[1] = m[1];
  return rng.pickWeighted(PROP_SETS.heavy, _w2);
}

/* ────────────────────────────────────────────────────────── solvability ── */

/** One step of lateral flood-fill through solid cells of `row`. */
function expandLateral(cells, row, reach, steps) {
  for (let s = 0; s < steps; s++) {
    let changed = false;
    for (let lane = 0; lane < LANES; lane++) _reachT[lane] = reach[lane];
    for (let lane = 0; lane < LANES; lane++) {
      if (!_reachT[lane]) continue;
      if (lane > 0 && !reach[lane - 1] && cells[row * LANES + lane - 1] === 1) {
        reach[lane - 1] = 1; changed = true;
      }
      if (lane < LANES - 1 && !reach[lane + 1] && cells[row * LANES + lane + 1] === 1) {
        reach[lane + 1] = 1; changed = true;
      }
    }
    if (!changed) break;
  }
}

/**
 * Walk the lanes from the chunk's near edge to its far edge.
 *
 * A node is (row, lane). You may always advance one row in the lane you are in,
 * and you may slide at most `maxShift` lanes sideways within a row — that budget
 * is what a 10 m row buys you at speed, so a path this finds is a path a player
 * can actually drive. Entering row 0 is free (you arrive from the previous chunk
 * in whatever lane you like).
 */
export function cellPathExists(cells, maxShift) {
  const shift = maxShift === undefined ? TUNING.gen.maxLaneShiftPerRow : maxShift;
  let any = false;
  for (let lane = 0; lane < LANES; lane++) {
    const v = cells[lane] === 1 ? 1 : 0;
    _reachA[lane] = v;
    if (v) any = true;
  }
  if (!any) return false;
  expandLateral(cells, 0, _reachA, LANES);
  for (let row = 1; row < GRID_Z; row++) {
    any = false;
    for (let lane = 0; lane < LANES; lane++) {
      const v = (_reachA[lane] === 1 && cells[row * LANES + lane] === 1) ? 1 : 0;
      _reachB[lane] = v;
      if (v) any = true;
    }
    if (!any) return false;
    expandLateral(cells, row, _reachB, shift);
    for (let lane = 0; lane < LANES; lane++) _reachA[lane] = _reachB[lane];
  }
  return true;
}

/**
 * Repair: carve a continuous bridge from near edge to far edge. Steps at most one
 * lane per row and fills the whole lateral run at every step, so the result is
 * always drivable no matter how mean the layout was.
 */
function carveBridge(cells, rng) {
  let lane = -1;
  for (let t = 0; t < LANES; t++) {
    const c = rng.int(0, LANES - 1);
    if (cells[c] === 1) { lane = c; break; }
  }
  if (lane < 0) lane = rng.int(0, LANES - 1);
  cells[lane] = 1;
  let prev = lane;
  for (let row = 1; row < GRID_Z; row++) {
    let next = prev;
    if (rng.bool(0.5)) next = clamp(prev + (rng.bool() ? 1 : -1), 0, LANES - 1);
    const lo = Math.min(prev, next);
    const hi = Math.max(prev, next);
    for (let l = lo; l <= hi; l++) cells[row * LANES + l] = 1;
    prev = next;
  }
}

/** Cluster the placed blockers into walls (a wall = blockers at the same d). */
function buildWalls(spec) {
  _wallCount = 0;
  _wallMask.fill(0);
  for (let i = 0; i < spec.props.length; i++) {
    const p = spec.props[i];
    if (!p.blocker) continue;
    let w = -1;
    for (let k = 0; k < _wallCount; k++) {
      if (Math.abs(_wallD[k] - p.d) <= WALL_CLUSTER) { w = k; break; }
    }
    if (w < 0) {
      if (_wallCount >= MAX_WALLS) continue;
      w = _wallCount++;
      _wallD[w] = p.d;
    }
    const laneA = laneOf(p.x - p.ex + EPS);
    const laneB = laneOf(p.x + p.ex - EPS);
    for (let l = laneA; l <= laneB; l++) _wallMask[w * LANES + l] = 1;
  }
  // insertion sort by d — never more than a handful of walls
  for (let i = 1; i < _wallCount; i++) {
    const d = _wallD[i];
    for (let l = 0; l < LANES; l++) _wallRow[l] = _wallMask[i * LANES + l];
    let j = i - 1;
    while (j >= 0 && _wallD[j] > d) {
      _wallD[j + 1] = _wallD[j];
      for (let l = 0; l < LANES; l++) _wallMask[(j + 1) * LANES + l] = _wallMask[j * LANES + l];
      j--;
    }
    _wallD[j + 1] = d;
    for (let l = 0; l < LANES; l++) _wallMask[(j + 1) * LANES + l] = _wallRow[l];
  }
}

/** Lateral spread over open road (no holes where blockers live, by construction). */
function spreadOpen(reach, steps) {
  if (steps >= LANES) {
    let any = false;
    for (let l = 0; l < LANES; l++) if (reach[l]) { any = true; break; }
    if (any) for (let l = 0; l < LANES; l++) reach[l] = 1;
    return;
  }
  for (let s = 0; s < steps; s++) {
    for (let l = 0; l < LANES; l++) _reachT[l] = reach[l];
    for (let l = 0; l < LANES; l++) {
      if (!_reachT[l]) continue;
      if (l > 0) reach[l - 1] = 1;
      if (l < LANES - 1) reach[l + 1] = 1;
    }
  }
}

/**
 * Walk the lanes through the walls of blockers. Returns the index of the first
 * impassable wall, or -1 when the gauntlet is solvable. The lateral budget between
 * walls comes from the run-up distance: `laneShiftPerMetre` metres of straight
 * road buy you one lane of sidestep, so a wall you cannot reach is reported even
 * when it technically has a hole in it.
 *
 * Leaves the reach mask from *before* the failing wall in `_reachPre` so the
 * repair knows which lane is worth opening.
 */
function wallPathFail(spec) {
  buildWalls(spec);
  for (let l = 0; l < LANES; l++) _reachA[l] = 1;
  let prevD = 0;
  for (let w = 0; w < _wallCount; w++) {
    const gap = Math.max(0, _wallD[w] - prevD);
    const steps = Math.max(1, Math.floor(gap * TUNING.gen.laneShiftPerMetre));
    spreadOpen(_reachA, steps);
    for (let l = 0; l < LANES; l++) _reachPre[l] = _reachA[l];
    let any = false;
    for (let l = 0; l < LANES; l++) {
      const v = (_reachA[l] === 1 && _wallMask[w * LANES + l] === 0) ? 1 : 0;
      _reachA[l] = v;
      if (v) any = true;
    }
    if (!any) return w;
    prevD = _wallD[w];
  }
  return -1;
}

/** Drop every blocker covering `lane` at the wall sitting at `wd`. */
function openWallLane(spec, wd, lane) {
  let removed = 0;
  for (let i = spec.props.length - 1; i >= 0; i--) {
    const p = spec.props[i];
    if (!p.blocker) continue;
    if (Math.abs(p.d - wd) > WALL_CLUSTER) continue;
    const laneA = laneOf(p.x - p.ex + EPS);
    const laneB = laneOf(p.x + p.ex - EPS);
    if (lane < laneA || lane > laneB) continue;
    removeProp(spec, i);
    removed++;
  }
  return removed;
}

/**
 * Validate and, if necessary, repair the chunk. Called on every chunk of every
 * type — a layout is never returned until both walks succeed.
 */
function finalise(spec, rng) {
  // 1. the road itself
  if (!cellPathExists(spec.cells)) {
    carveBridge(spec.cells, rng);
    if (!cellPathExists(spec.cells)) spec.cells.fill(1);  // last resort: no holes
  }
  // row 0 is always solid: the player needs reaction distance across the seam
  for (let lane = 0; lane < LANES; lane++) spec.cells[lane] = 1;

  // 2. the walls
  const guard = MAX_WALLS * LANES + 8;
  for (let i = 0; i < guard; i++) {
    const w = wallPathFail(spec);
    if (w < 0) break;
    // Prefer opening a lane the player can actually reach at that wall.
    let count = 0;
    for (let l = 0; l < LANES; l++) if (_reachPre[l]) _laneOrder[count++] = l;
    const lane = count > 0 ? _laneOrder[rng.int(0, count - 1)] : rng.int(0, LANES - 1);
    if (openWallLane(spec, _wallD[w], lane) === 0) {
      // nothing to remove there (shouldn't happen) — clear the whole wall
      const wd = _wallD[w];
      for (let l = 0; l < LANES; l++) openWallLane(spec, wd, l);
    }
  }
}

/* ─────────────────────────────────────────────────────────────── builders ── */

/** Wide, bright, and free. Nothing here can hurt you — this is where you learn. */
function buildWarmup(spec, rng, diff, generosity) {
  const n = irange(rng, TUNING.gen.warmupProps);
  for (let i = 0; i < n; i++) {
    const key = pickLight(rng, diff * 0.5);
    const d = rng.range(8, CHUNK_LEN - 8);
    const x = laneX(rng.int(0, LANES - 1)) + rng.spread(1.2);
    tryPlace(spec, rng, key, d, x, 6, 2.5, rng.spread(0.25), rng.range(0.92, 1.1));
  }
  const pk = Math.round(irange(rng, TUNING.gen.warmupPickups) * generosity);
  scatterPickups(spec, rng, pk, 6, CHUNK_LEN - 6, diff);
}

/** Ranks of parked vehicles with a weaving gap. Read the gap, take the gap. */
function buildTraffic(spec, rng, diff, generosity) {
  const rows = irange(rng, TUNING.gen.trafficRows);
  const spacing = CHUNK_LEN / (rows + 1);
  const gapW = clamp(Math.round(pair(TUNING.gen.trafficGapLanes, diff)), 1, LANES - 1);
  let gapLane = rng.int(0, LANES - gapW);

  for (let r = 0; r < rows; r++) {
    const dRow = spacing * (r + 1) + rng.spread(1.5);
    if (r > 0) gapLane = clamp(gapLane + rng.int(-1, 1), 0, LANES - gapW);
    for (let lane = 0; lane < LANES; lane++) {
      if (lane >= gapLane && lane < gapLane + gapW) continue;
      let key = pickVehicle(rng, diff);
      let rotY = rng.spread(0.09);
      if (key !== 'bus' && rng.bool(TUNING.gen.trafficSidewaysChance)) rotY = Math.PI * 0.5;
      if (!tryPlace(spec, rng, key, dRow, laneX(lane), 1.6, 0.6, rotY, 1)) {
        // a bus that will not fit becomes a sedan rather than a hole in the wall
        tryPlace(spec, rng, 'sedan', dRow, laneX(lane), 1.6, 0.6, rng.spread(0.09), 1);
      }
    }
    // the reward for threading the needle sits in the needle
    addPickup(spec, pickupValue(rng, diff), dRow, laneX(gapLane) + (gapW - 1) * LANE_WIDTH * 0.5);
  }

  // a few soft targets between the ranks so the chunk still crunches
  const extra = rng.int(1, 3);
  for (let i = 0; i < extra; i++) {
    tryPlace(spec, rng, pickLight(rng, diff), rng.range(6, CHUNK_LEN - 6),
      laneX(rng.int(0, LANES - 1)), 6, 2.5, rng.spread(0.3), 1);
  }
  const pk = Math.round(irange(rng, TUNING.gen.trafficPickups) * generosity);
  scatterPickups(spec, rng, pk, 6, CHUNK_LEN - 6, diff);
}

/** Walls of concrete with one threadable seam. The only chunk that punishes greed. */
function buildGauntlet(spec, rng, diff, generosity) {
  const rows = irange(rng, TUNING.gen.gauntletRows);
  const spacing = CHUNK_LEN / (rows + 1);
  const open = clamp(Math.round(pair(TUNING.gen.gauntletOpenLanes, diff)),
    TUNING.gen.minGapLanes, LANES - 1);
  const maxStep = Math.max(1, Math.floor(spacing * TUNING.gen.laneShiftPerMetre));
  const gap = TUNING.gen.blockerGap;
  let openLane = rng.int(0, LANES - open);

  for (let r = 0; r < rows; r++) {
    const dRow = spacing * (r + 1);
    if (r > 0) openLane = clamp(openLane + rng.int(-maxStep, maxStep), 0, LANES - open);
    for (let lane = 0; lane < LANES; lane++) {
      if (lane >= openLane && lane < openLane + open) continue;
      const cx = laneX(lane);
      if (rng.bool(TUNING.gen.gauntletPillarChance)) {
        place(spec, 'pillar', dRow, cx - 1.15, 0, 1, gap);
        place(spec, 'pillar', dRow, cx + 1.15, 0, 1, gap);
      } else {
        place(spec, 'barrier', dRow, cx, 0, 1, gap);
      }
    }
    // something breakable in the seam, so threading it still pays
    if (rng.bool(0.5)) {
      const sx = laneX(openLane) + (open - 1) * LANE_WIDTH * 0.5;
      tryPlace(spec, rng, pickLight(rng, diff), dRow - spacing * 0.45, sx, 2.5, 1.2, 0, 1);
    }
  }

  const n = irange(rng, TUNING.gen.gauntletProps);
  for (let i = 0; i < n; i++) {
    tryPlace(spec, rng, pickLight(rng, diff), rng.range(6, CHUNK_LEN - 6),
      laneX(rng.int(0, LANES - 1)), 5, 2.0, rng.spread(0.3), 1);
  }
  const pk = Math.round(irange(rng, TUNING.gen.gauntletPickups) * generosity);
  scatterPickups(spec, rng, pk, 5, CHUNK_LEN - 5, diff);
}

/**
 * The payoff. Dense, destructible, no blockers, no holes — a wall of things that
 * exist purely to stop existing. Put this after a chasm and the release is
 * physical.
 */
function buildBuffet(spec, rng, diff, generosity) {
  const waves = irange(rng, TUNING.gen.buffetWaves);
  const spacing = CHUNK_LEN / (waves + 1);
  const carChance = pair(TUNING.gen.buffetCarChance, diff);

  for (let w = 0; w < waves; w++) {
    const dRow = spacing * (w + 1) + rng.spread(2);
    const per = irange(rng, TUNING.gen.buffetPerWave);
    const startLane = rng.int(0, Math.max(0, LANES - per));
    for (let k = 0; k < per; k++) {
      const lane = clamp(startLane + k, 0, LANES - 1);
      const key = rng.bool(carChance) ? pickVehicle(rng, diff * 0.6) : pickLight(rng, diff);
      tryPlace(spec, rng, key, dRow, laneX(lane) + rng.spread(0.7), 2.2, 1.0,
        rng.spread(0.35), rng.range(0.94, 1.12));
    }
  }

  // one trophy near the end once the player is big enough to enjoy it
  if (diff >= TUNING.gen.heavyPropDifficulty && rng.bool(0.5)) {
    tryPlace(spec, rng, pickHeavy(rng), rng.range(CHUNK_LEN * 0.55, CHUNK_LEN - 12),
      laneX(rng.int(1, LANES - 2)), 8, 3.0, 0, 1);
  }

  const pk = Math.round(irange(rng, TUNING.gen.buffetPickups) * generosity);
  scatterPickups(spec, rng, pk, 5, CHUNK_LEN - 5, diff);
}

/**
 * Nothing under you but the fall. Rows 0..chasmFirstRow-1 stay solid so the hole
 * is always visible before it is lethal, and the bridge steps at most one lane per
 * row with a widened junction at every step.
 */
function buildChasm(spec, rng, diff, generosity) {
  spec.slopeDeg = TUNING.world.baseSlopeDeg;   // never steepen into a drop
  for (let r = 0; r < GRID_Z; r++) _bridgeLane[r] = -1;

  const rows = irange(rng, TUNING.gen.chasmRows);
  const first = clamp(TUNING.gen.chasmFirstRow | 0, 1, GRID_Z - 1);
  const latest = Math.max(first, GRID_Z - rows);
  const startRow = clamp(rng.int(first, latest), first, GRID_Z - 1);
  const endRow = Math.min(GRID_Z, startRow + rows);
  const width = clamp(Math.round(pair(TUNING.gen.chasmBridgeLanes, diff)),
    TUNING.gen.minGapLanes, LANES);

  let lo = rng.int(0, LANES - width);
  let hi = lo + width - 1;
  for (let row = startRow; row < endRow; row++) {
    for (let l = 0; l < LANES; l++) spec.cells[row * LANES + l] = 0;
    let nlo = lo;
    if (row > startRow && rng.bool(TUNING.gen.chasmDriftChance)) {
      nlo = clamp(lo + (rng.bool() ? 1 : -1), 0, LANES - width);
    }
    const nhi = nlo + width - 1;
    // Union of the old and new bridge lanes: the junction row is one lane wider
    // than the bridge, which is what makes a one-lane bridge drivable at all.
    let fLo = Math.min(lo, nlo);
    let fHi = Math.max(hi, nhi);
    // The mouth is a funnel — you should be able to commit late and still make it.
    if (row === startRow) { fLo = Math.max(0, fLo - 1); fHi = Math.min(LANES - 1, fHi + 1); }
    for (let l = fLo; l <= fHi; l++) spec.cells[row * LANES + l] = 1;
    _bridgeLane[row] = (nlo + nhi) * 0.5;
    lo = nlo;
    hi = nhi;
  }

  // Solid ground before and after the drop gets the props and the reward line.
  const n = irange(rng, TUNING.gen.chasmProps);
  for (let i = 0; i < n; i++) {
    tryPlace(spec, rng, pickLight(rng, diff), rng.range(4, CHUNK_LEN - 4),
      laneX(rng.int(0, LANES - 1)), 8, 3.0, rng.spread(0.3), 1);
  }

  // Pickups strung along the bridge: the safest line is also the richest one.
  for (let row = startRow; row < endRow; row++) {
    const lane = _bridgeLane[row];
    if (lane < 0) continue;
    addPickup(spec, pickupValue(rng, diff), (row + 0.5) * CELL_D, laneX(0) + lane * LANE_WIDTH);
  }
  const pk = Math.round(irange(rng, TUNING.gen.chasmPickups) * generosity);
  scatterPickups(spec, rng, pk, 3, CHUNK_LEN - 3, diff);
}

/** Ramp, air, and something to sail over. The only chunk where up is a direction. */
function buildJump(spec, rng, diff, generosity) {
  const G = TUNING.gen;
  const width = G.jumpRampWidth;
  const length = G.jumpRampLength;
  const height = G.jumpRampHeight;
  const rampD = clamp(rng.range(G.jumpRampD[0], G.jumpRampD[1]), 6, CHUNK_LEN - length - 24);
  const lane = rng.int(0, LANES - 2);
  const limit = ROAD_HALF - width * 0.5 - 0.4;
  const rampX = clamp(laneX(lane) + LANE_WIDTH * 0.5, -limit, limit);
  addRamp(spec, rampD, rampX, width, length, height);

  const rampEnd = rampD + length;

  // The thing you fly over. It sits close enough to the lip that even a slow
  // launch clears it, and it is a blocker so a mistake costs mass, never the run.
  if (rng.bool(pair(G.jumpBlockerChance, diff))) {
    const bd = rampEnd + rng.range(G.jumpBlockerOffset[0], G.jumpBlockerOffset[1]);
    if (bd < CHUNK_LEN - 4) {
      const key = rng.bool(0.5) ? 'barrier' : 'pillar';
      if (key === 'pillar') {
        place(spec, 'pillar', bd, rampX - 1.4, 0, 1, TUNING.gen.blockerGap);
        place(spec, 'pillar', bd, rampX + 1.4, 0, 1, TUNING.gen.blockerGap);
      } else {
        place(spec, 'barrier', bd, rampX, 0, 1, TUNING.gen.blockerGap);
      }
    }
  }

  // Side dressing, well clear of the run-up (the ramp margin enforces it).
  const n = irange(rng, G.jumpSideProps);
  for (let i = 0; i < n; i++) {
    const key = rng.bool(0.35) ? pickVehicle(rng, diff) : pickLight(rng, diff);
    tryPlace(spec, rng, key, rng.range(4, CHUNK_LEN - 4),
      laneX(rng.int(0, LANES - 1)), 8, 3.0, rng.spread(0.25), 1);
  }

  // Landing-zone reward: you get paid for committing to the ramp.
  const landing = Math.min(CHUNK_LEN - 4, rampEnd + 18);
  for (let i = 0; i < 3; i++) {
    addPickup(spec, pickupValue(rng, diff), landing + i * 3.2, rampX + rng.spread(1.6));
  }
  const pk = Math.round(irange(rng, G.jumpPickups) * generosity);
  scatterPickups(spec, rng, pk, 4, CHUNK_LEN - 4, diff);
}

/* ──────────────────────────────────────────────────────────────── public ── */

/**
 * Build one chunk.
 *
 * @param {string} type One of `CHUNK_TYPES`.
 * @param {{rng:Rng, chunkIndex:number, difficulty01:number, generosity:number}} ctx
 * @returns {{type:string, slopeDeg:number, cells:Uint8Array,
 *            props:Array, pickups:Array, ramps:Array}} a pooled ChunkSpec —
 *   read it now, do not hold it past the chunk's lifetime.
 */

// ─────────────────────────────────────────────────────────────── passability
//
// A safety net over every builder, present and future.
//
// Props at or below the player's mass floor (glass, crates, fences) are always
// destructible, so they can wall the road freely — driving through them IS the
// game. Anything heavier can stop the player outright, so at no point along the
// chunk may heavy props plus holes leave less than one roller-width of clear
// road. Without this a single row of buses across all six lanes pins the player
// forever: they cannot break through and the run never ends, which is strictly
// worse than dying.
const ROAD_W = ROAD_HALF * 2;
const PASS_COLS = 48;                     // 0.5 m resolution across the road
const PASS_DSTEP = 1.0;                   // metres between samples
const _passCol = new Int32Array(PASS_COLS);
const _passTmp = new Int32Array(PASS_COLS);
const _passCandidates = new Int32Array(64);

/** Widest run of free columns in `cols` (entries < 0 are free), in metres. */
function widestRun(cols) {
  const colW = ROAD_W / PASS_COLS;
  let best = 0;
  let run = 0;
  for (let i = 0; i < PASS_COLS; i++) {
    if (cols[i] < 0) { run++; if (run > best) best = run; } else run = 0;
  }
  return best * colW;
}

function ensurePassable(spec) {
  const minGap = TUNING.gen.minGapLanes * LANE_WIDTH - 0.5;
  const floor = TUNING.player.minMass;
  const colW = ROAD_W / PASS_COLS;

  for (let d = 0; d <= CHUNK_LEN; d += PASS_DSTEP) {
    const row = clamp(Math.floor(d / CELL_D), 0, GRID_Z - 1);
    for (let guard = 0; guard < 12; guard++) {
      // occupancy: -1 free, -2 hole, >= 0 index of the heavy prop that blocks it
      for (let i = 0; i < PASS_COLS; i++) {
        const x = -ROAD_HALF + (i + 0.5) * colW;
        const lane = clamp(Math.floor((x + ROAD_HALF) / LANE_WIDTH), 0, LANES - 1);
        _passCol[i] = spec.cells[row * LANES + lane] === 1 ? -1 : -2;
      }
      let nCand = 0;
      for (let pi = 0; pi < spec.props.length; pi++) {
        const p = spec.props[pi];
        const def = PROPS[p.key];
        if (!def || def.threshold <= floor) continue;   // always breakable
        const c = Math.abs(Math.cos(p.rotY || 0));
        const sn = Math.abs(Math.sin(p.rotY || 0));
        const ex = c * def.size[0] * 0.5 + sn * def.size[2] * 0.5;
        const ez = sn * def.size[0] * 0.5 + c * def.size[2] * 0.5;
        if (d < p.d - ez || d > p.d + ez) continue;
        let touched = false;
        for (let i = 0; i < PASS_COLS; i++) {
          if (_passCol[i] !== -1) continue;
          const x = -ROAD_HALF + (i + 0.5) * colW;
          if (Math.abs(x - p.x) < ex) { _passCol[i] = pi; touched = true; }
        }
        if (touched && nCand < _passCandidates.length) _passCandidates[nCand++] = pi;
      }

      if (widestRun(_passCol) >= minGap) break;
      if (nCand === 0) break;                            // holes only — builders own that

      // Remove whichever heavy prop opens the widest gap.
      let bestProp = -1;
      let bestWidth = -1;
      for (let k = 0; k < nCand; k++) {
        const pi = _passCandidates[k];
        for (let i = 0; i < PASS_COLS; i++) _passTmp[i] = _passCol[i] === pi ? -1 : _passCol[i];
        const w = widestRun(_passTmp);
        if (w > bestWidth) { bestWidth = w; bestProp = pi; }
      }
      if (bestProp < 0) break;
      spec.props.splice(bestProp, 1);
    }
  }
}

export function buildChunk(type, ctx) {
  const rng = ctx.rng;
  const diff = clamp01(ctx.difficulty01 || 0);
  const generosity = ctx.generosity > 0 ? ctx.generosity : 1;
  const t = CHUNK_TENSION[type] === undefined ? 'warmup' : type;
  const spec = nextSpec(t);

  switch (t) {
    case 'traffic': buildTraffic(spec, rng, diff, generosity); break;
    case 'gauntlet': buildGauntlet(spec, rng, diff, generosity); break;
    case 'buffet': buildBuffet(spec, rng, diff, generosity); break;
    case 'chasm': buildChasm(spec, rng, diff, generosity); break;
    case 'jump': buildJump(spec, rng, diff, generosity); break;
    default: buildWarmup(spec, rng, diff, generosity); break;
  }

  ensurePassable(spec);
  finalise(spec, rng);
  return spec;
}

/**
 * Picker weights per chunk type at a given difficulty. Returns a shared object —
 * copy what you need out of it before calling again.
 */
export function chunkWeights(difficulty01) {
  const t = clamp01(difficulty01);
  const W = TUNING.gen.chunkTypeWeights;
  _weights.warmup = pair(W.warmup, t);
  _weights.traffic = pair(W.traffic, t);
  _weights.gauntlet = pair(W.gauntlet, t);
  _weights.buffet = pair(W.buffet, t);
  _weights.chasm = pair(W.chasm, t);
  _weights.jump = pair(W.jump, t);
  return _weights;
}

/* ───────────────────────────────────────────────────────────────── selftest ── */

function fail(out, msg) {
  if (out.length < 40) out.push(msg);
  return 0;
}

/** Assert every guarantee this module makes about one built chunk. */
function validateSpec(spec, type, seed, diff, failures) {
  const tag = type + ' seed=' + seed + ' diff=' + diff.toFixed(2) + ': ';
  let checks = 0;

  // ── grid shape
  checks++;
  if (spec.cells.length !== CELL_COUNT) {
    return fail(failures, tag + 'cells.length ' + spec.cells.length + ' != ' + CELL_COUNT);
  }
  checks++;
  for (let i = 0; i < CELL_COUNT; i++) {
    const v = spec.cells[i];
    if (v !== 0 && v !== 1) return fail(failures, tag + 'cell ' + i + ' = ' + v);
  }
  checks++;
  for (let lane = 0; lane < LANES; lane++) {
    if (spec.cells[lane] !== 1) return fail(failures, tag + 'row 0 lane ' + lane + ' is a hole');
  }
  checks++;
  if (spec.type !== type) fail(failures, tag + 'spec.type = ' + spec.type);
  checks++;
  if (!(spec.slopeDeg > 0 && spec.slopeDeg <= TUNING.world.steepSlopeDeg)) {
    fail(failures, tag + 'slopeDeg = ' + spec.slopeDeg);
  }

  // ── solvability
  checks++;
  if (!cellPathExists(spec.cells)) fail(failures, tag + 'no lane path across the cells');
  checks++;
  const w = wallPathFail(spec);
  if (w >= 0) fail(failures, tag + 'wall ' + w + ' at d=' + _wallD[w].toFixed(1) + ' is sealed');

  // ── holes and blockers must never share a chunk (the two walks are independent)
  let holes = 0;
  let blockers = 0;
  for (let i = 0; i < CELL_COUNT; i++) if (spec.cells[i] === 0) holes++;
  for (let i = 0; i < spec.props.length; i++) if (spec.props[i].blocker) blockers++;
  checks++;
  if (holes > 0 && blockers > 0) fail(failures, tag + 'holes and blockers in one chunk');

  // ── array shapes
  checks++;
  if (spec.props.length > MAX_PROPS) fail(failures, tag + 'too many props');
  checks++;
  if (spec.pickups.length > MAX_PICKUPS) fail(failures, tag + 'too many pickups');
  checks++;
  if (spec.ramps.length > MAX_RAMPS) fail(failures, tag + 'too many ramps');

  // ── props
  for (let i = 0; i < spec.props.length; i++) {
    const p = spec.props[i];
    checks++;
    if (!p || !PROPS[p.key]) { fail(failures, tag + 'prop ' + i + ' has bad key'); continue; }
    if (!(p.d >= 0 && p.d <= CHUNK_LEN)) fail(failures, tag + 'prop ' + p.key + ' d=' + p.d);
    if (p.x - p.ex < -ROAD_HALF || p.x + p.ex > ROAD_HALF) {
      fail(failures, tag + 'prop ' + p.key + ' hangs off the road at x=' + p.x.toFixed(2));
    }
    if (!areaSolid(spec.cells, p.x - p.ex, p.x + p.ex, p.d - p.ed, p.d + p.ed)) {
      fail(failures, tag + 'prop ' + p.key + ' overlaps a hole at d=' + p.d.toFixed(1));
    }
    if (hitsRamp(spec, p.x - p.ex, p.x + p.ex, p.d - p.ed, p.d + p.ed)) {
      fail(failures, tag + 'prop ' + p.key + ' sits on a ramp');
    }
    if (!(p.scale > 0)) fail(failures, tag + 'prop ' + p.key + ' scale=' + p.scale);
    for (let j = i + 1; j < spec.props.length; j++) {
      const q = spec.props[j];
      if (Math.abs(p.x - q.x) < p.ex + q.ex - 1e-4
          && Math.abs(p.d - q.d) < p.ed + q.ed - 1e-4) {
        fail(failures, tag + 'props ' + p.key + '/' + q.key + ' intersect');
        break;
      }
    }
  }

  // ── pickups
  const values = TUNING.mass.pickupValues;
  for (let i = 0; i < spec.pickups.length; i++) {
    const q = spec.pickups[i];
    checks++;
    if (!q) { fail(failures, tag + 'pickup ' + i + ' is empty'); continue; }
    let known = false;
    for (let k = 0; k < values.length; k++) if (values[k] === q.value) known = true;
    if (!known) fail(failures, tag + 'pickup value ' + q.value);
    if (!(q.d >= 0 && q.d <= CHUNK_LEN)) fail(failures, tag + 'pickup d=' + q.d);
    if (q.x < -ROAD_HALF || q.x > ROAD_HALF) fail(failures, tag + 'pickup x=' + q.x);
    if (spec.cells[rowOf(q.d) * LANES + laneOf(q.x)] !== 1) {
      fail(failures, tag + 'pickup floats over a hole at d=' + q.d.toFixed(1));
    }
    if (hitsRamp(spec, q.x - 0.5, q.x + 0.5, q.d - 0.5, q.d + 0.5)) {
      fail(failures, tag + 'pickup sits inside a ramp');
    }
  }

  // ── ramps
  for (let i = 0; i < spec.ramps.length; i++) {
    const r = spec.ramps[i];
    checks++;
    if (!(r.length > 0 && r.height > 0 && r.width > 0)) fail(failures, tag + 'degenerate ramp');
    if (r.d < 0 || r.d + r.length > CHUNK_LEN) fail(failures, tag + 'ramp runs off the chunk');
    if (r.x - r.width * 0.5 < -ROAD_HALF || r.x + r.width * 0.5 > ROAD_HALF) {
      fail(failures, tag + 'ramp runs off the road');
    }
  }

  // ── the chunk types have to actually do their jobs
  checks++;
  if (type === 'chasm' && holes === 0) fail(failures, tag + 'a chasm with no hole');
  if (type === 'gauntlet' && blockers === 0) fail(failures, tag + 'a gauntlet with no blockers');
  if (type === 'jump' && spec.ramps.length !== 1) fail(failures, tag + 'a jump with no ramp');
  if ((type === 'buffet' || type === 'warmup') && (holes > 0 || blockers > 0)) {
    fail(failures, tag + 'a release chunk with hazards');
  }
  if (type === 'buffet' && spec.props.length < 6) {
    fail(failures, tag + 'a buffet with only ' + spec.props.length + ' props');
  }

  return checks;
}

/**
 * Build several hundred chunks of every type, across the whole difficulty range,
 * from many seeds, and assert every guarantee. Cheap enough to run from a test
 * script or a console; returns a report rather than throwing.
 *
 * @param {{perType?:number}} [opts]
 * @returns {{ok:boolean, chunks:number, checks:number, failures:string[]}}
 */
export function selfTest(opts) {
  const perType = (opts && opts.perType) || 60;
  const failures = [];
  let chunks = 0;
  let checks = 0;
  const rng = new Rng(1);
  const ctx = { rng, chunkIndex: 0, difficulty01: 0, generosity: 1 };

  for (let t = 0; t < CHUNK_TYPES.length; t++) {
    const type = CHUNK_TYPES[t];
    for (let i = 0; i < perType; i++) {
      const seed = (t * 7919 + i * 104729 + 1) >>> 0;
      rng.reseed(seed);
      const diff = (i % 11) / 10;
      ctx.chunkIndex = i;
      ctx.difficulty01 = diff;
      ctx.generosity = TUNING.gen.pickupGenerosityBase + TUNING.gen.pickupGenerosityRamp * diff;
      const spec = buildChunk(type, ctx);
      chunks++;
      checks += validateSpec(spec, type, seed, diff, failures);
    }
  }

  return { ok: failures.length === 0, chunks, checks, failures };
}
