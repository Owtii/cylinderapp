/**
 * TONNAGE — pre-fractured destruction plans (§10).
 *
 * Every prop in `world/objects.js` is a handful of boxes and cylinders with a
 * material key each. This module turns that into FRACTURE_VARIANTS distinct
 * break-ups per prop, baked once at module load into flat typed arrays, so the
 * per-impact path is a `Float32Array.set` and nothing else.
 *
 * The point is not piece count, it is that a crate must not break like a window.
 * A material picks a failure MODE, and the mode is what the eye reads at 40 m/s:
 *
 *   glass                 slivers radiating from a shatter origin, thin and many
 *   wood                  long splinters along the grain, never cubes
 *   metal/paint/steel     the skin tears off in large panels that stay bent
 *   concrete/sand/hazard  chunky irregular blocks plus a fine dust of chips
 *   rubber/plastic/water  a few large curved shells
 *
 * Two details matter more than any of that:
 *
 * 1. Pieces NEAR the impact are SMALL and pieces FAR from it are LARGE. The impact
 *    point is only known at runtime, so pieces are baked at a nominal size and
 *    `gradeSizes()` regrades them against the real contact point. The regrade is
 *    volume-conserving: it redistributes size, it does not add or remove matter.
 *
 * 2. Every piece is a convex hull, not a box — but building a hull per fragment is
 *    the one thing Rapier is genuinely slow at. So the hulls are a small set of
 *    reusable ARCHETYPES (sliver, wedge, blocky, plate, shell, splinter, chip, bent
 *    panel) baked in unit-box space; a piece references one by index and scales it.
 *    Hull behaviour at box cost, and the consumer builds nine colliders, not 250.
 *
 * Piece order is a quality order: the three largest pieces first, then the
 * detachable parts, then everything else in a deterministic shuffle. That means any
 * PREFIX of a plan is a usable break-up, which is what lets a caller honour
 * `destruction.fragmentMaxPerSpawn` by simply stopping early.
 *
 * Nothing here allocates after module load. `fracturePlan` and `gradeSizes` are on
 * the per-impact path and are allocation-free.
 */

import { TUNING } from '../tuning.js';
import { Rng } from '../core/rng.js';
import { smoothstep } from '../core/math.js';
import { PROPS, PROP_KEYS } from '../world/objects.js';

/** Distinct break-ups baked per prop type. Picked at random per impact. */
export const FRACTURE_VARIANTS = 4;

/* ────────────────────────────────────────────────────────── material physics ─ */

/**
 * Per-material fragment behaviour. `restitution` and `friction` are §10's table
 * verbatim; the rest is what the fracture generator and the consumers need:
 *
 *   family        which failure mode this material uses
 *   density       kg/m³, so a consumer can size an impulse by mass rather than volume
 *   dust          0..1, how much fine particulate this material throws off
 *   pieceDensity  how many pieces this material wants per unit of volume, relative
 *                 to the others. Glass wants dozens of shards out of a thin pane;
 *                 rubber wants three shells out of a whole tyre.
 *
 * `plastic` has no entry in MATERIALS yet — §17's highway furniture is what needs
 * it — but the physics row is here because the table is the contract, and a
 * material with no props simply bakes into nothing.
 */
export const MATERIAL_PHYSICS = {
  glass:    { family: 'SHARD',    restitution: 0.15, friction: 0.30, density: 2500, dust: 0.16, pieceDensity: 1.75 },
  wood:     { family: 'SPLINTER', restitution: 0.25, friction: 0.70, density: 620,  dust: 0.22, pieceDensity: 1.05 },
  metal:    { family: 'PANEL',    restitution: 0.35, friction: 0.50, density: 2700, dust: 0.05, pieceDensity: 0.70 },
  paint:    { family: 'PANEL',    restitution: 0.35, friction: 0.50, density: 3000, dust: 0.08, pieceDensity: 0.70 },
  steel:    { family: 'PANEL',    restitution: 0.35, friction: 0.50, density: 7800, dust: 0.05, pieceDensity: 0.60 },
  slate:    { family: 'PANEL',    restitution: 0.30, friction: 0.60, density: 2700, dust: 0.26, pieceDensity: 0.80 },
  concrete: { family: 'CHUNK',    restitution: 0.20, friction: 0.90, density: 2400, dust: 0.55, pieceDensity: 1.00 },
  sand:     { family: 'CHUNK',    restitution: 0.20, friction: 0.90, density: 1500, dust: 0.70, pieceDensity: 1.00 },
  hazard:   { family: 'CHUNK',    restitution: 0.20, friction: 0.90, density: 2400, dust: 0.50, pieceDensity: 1.00 },
  rubber:   { family: 'SHELL',    restitution: 0.75, friction: 0.80, density: 1100, dust: 0.00, pieceDensity: 0.35 },
  plastic:  { family: 'SHELL',    restitution: 0.50, friction: 0.40, density: 1050, dust: 0.06, pieceDensity: 0.45 },
  water:    { family: 'SHELL',    restitution: 0.50, friction: 0.40, density: 1000, dust: 0.10, pieceDensity: 0.45 },
  // §17's three catalogue materials. Every one of them is a real prop material, so
  // a missing row here is not a gap in a table, it is sixteen props — the whole
  // furniture family, the hedges and the fuel tanker — baking `mat = -1` and
  // fragmenting as fallback grey concrete.
  chalk:    { family: 'PANEL',    restitution: 0.35, friction: 0.50, density: 1400, dust: 0.14, pieceDensity: 0.70 },
  // A hedge is twigs, so it splinters like wood — but it neither bounces nor
  // weighs anything, which is the entire difference between a hedge and a fence.
  foliage:  { family: 'SPLINTER', restitution: 0.12, friction: 0.85, density: 300,  dust: 0.30, pieceDensity: 1.30 },
  // The tanker's hazard bands are paint on steel and tear with the steel (§17).
  orange:   { family: 'PANEL',    restitution: 0.35, friction: 0.50, density: 3000, dust: 0.08, pieceDensity: 0.70 },
};

/** Stable order, so `mat[]` indices survive as long as the table above does. */
export const MATERIAL_KEYS = Object.keys(MATERIAL_PHYSICS);

/** key → index. Null-prototype so a material called 'constructor' cannot collide. */
const MAT_INDEX = Object.create(null);
for (let i = 0; i < MATERIAL_KEYS.length; i++) MAT_INDEX[MATERIAL_KEYS[i]] = i;

/**
 * Stable integer index for a material key, for packing into a plan's `mat[]`.
 * @returns {number} index into MATERIAL_KEYS, or -1 for a material with no physics
 *   row. Baked plans never contain -1; the guard is for callers passing arbitrary
 *   keys, and mirrors the unknown-material fallback in `fx/fragments.js`.
 */
export function materialIndex(matKey) {
  const i = MAT_INDEX[matKey];
  return i === undefined ? -1 : i;
}

/** Inverse of `materialIndex`. Empty string when the index is out of range. */
export function materialKey(index) {
  return index >= 0 && index < MATERIAL_KEYS.length ? MATERIAL_KEYS[index] : '';
}

/** Physics row for a material key, falling back to concrete so nothing is undefined. */
export function materialPhysics(matKey) {
  return MATERIAL_PHYSICS[matKey] || MATERIAL_PHYSICS.concrete;
}

/* ─────────────────────────────────────────────────────────── hull archetypes ─ */

/**
 * Every archetype is a LOFT: a convex 2D polygon extruded along Z between two
 * scaled, sheared copies of itself. That buys three things for eight lines of
 * maths — the solid is guaranteed convex (so Rapier's hull builder has nothing to
 * do but copy the points), its volume is exact rather than sampled (a linear loft
 * makes the cross-sectional area a quadratic in t, which Simpson integrates
 * exactly), and taper is free, which is most of what makes a shard look like a
 * shard rather than a small box.
 *
 * Points come out normalised into the unit box, so a consumer scales them by the
 * piece's FULL extents (2·sx, 2·sy, 2·sz) and has the collider.
 *
 * Index 0 is a plain box and no generator ever emits it, so `plan.hull[i] === 0`
 * carries its contract meaning — "this one is just a box" — for a consumer that
 * only has a box mesh to draw with.
 */
const ARCH_BOX = 0;
const ARCH_SLIVER = 1;
const ARCH_WEDGE = 2;
const ARCH_BLOCKY = 3;
const ARCH_PLATE = 4;
const ARCH_SHELL = 5;
const ARCH_SPLINTER = 6;
const ARCH_CHIP = 7;
const ARCH_BENT = 8;

/** Signed-area shoelace. */
function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return Math.abs(a) * 0.5;
}

/**
 * Build one archetype from its cross-section.
 * @param {number[]} poly  convex polygon, flat [x0,y0,x1,y1,...]
 * @param {number} s0 cross-section scale at z = -0.5
 * @param {number} s1 scale at z = +0.5
 * @param {number} ox lateral shear of the far ring
 * @param {number} oy
 */
function loft(name, poly, s0, s1, ox, oy) {
  const n = poly.length / 2;
  const pts = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = poly[i * 2] * s0;
    pts[i * 3 + 1] = poly[i * 2 + 1] * s0;
    pts[i * 3 + 2] = -0.5;
    const j = (n + i) * 3;
    pts[j] = poly[i * 2] * s1 + ox;
    pts[j + 1] = poly[i * 2 + 1] * s1 + oy;
    pts[j + 2] = 0.5;
  }

  // Normalise into the unit box. The map is affine and axis-aligned, so the loft
  // structure survives it and the volume just picks up the same factor.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n * 2; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const kx = maxX > minX ? 1 / (maxX - minX) : 1;
  const ky = maxY > minY ? 1 / (maxY - minY) : 1;
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
  for (let i = 0; i < n * 2; i++) {
    pts[i * 3] = (pts[i * 3] - cx) * kx;
    pts[i * 3 + 1] = (pts[i * 3 + 1] - cy) * ky;
  }

  const volumeRatio = polyArea(poly) * ((s0 * s0 + s0 * s1 + s1 * s1) / 3) * kx * ky;
  return { name, points: pts, vertexCount: n * 2, volumeRatio };
}

const SQUARE = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
const TRI = [-0.5, -0.42, 0.5, -0.5, 0.02, 0.5];
const OCTA = [-0.5, -0.34, -0.32, -0.5, 0.32, -0.5, 0.5, -0.34, 0.5, 0.34, 0.32, 0.5, -0.32, 0.5, -0.5, 0.34];
const HEX = [-0.5, -0.16, -0.18, -0.5, 0.26, -0.44, 0.5, 0.1, 0.16, 0.5, -0.3, 0.42];
const STICK = [-0.5, -0.28, 0.1, -0.5, 0.5, -0.06, 0.28, 0.5, -0.24, 0.44];
const CHIPTRI = [-0.5, -0.4, 0.5, -0.18, -0.06, 0.5];
/** A bowed plate: convex on both faces, so it reads as bent without a concave dent. */
const BOW = [-0.5, 0.0, 0.0, -0.13, 0.5, 0.0, 0.5, 0.10, 0.0, 0.26, -0.5, 0.10];
/** A circular segment — the convex half of a curved shell. */
const SEGMENT = (() => {
  const out = [];
  const half = 1.02;                                   // ±58°, a wide, shallow arc
  for (let i = 0; i <= 6; i++) {
    const a = -half + (2 * half * i) / 6;
    out.push(Math.sin(a) * 0.5, Math.cos(a) * 0.5);
  }
  return out;
})();

export const HULL_ARCHETYPES = [
  loft('box', SQUARE, 1.0, 1.0, 0, 0),
  loft('sliver', TRI, 1.0, 0.18, 0.06, -0.04),
  loft('wedge', SQUARE, 1.0, 0.10, 0.05, 0),
  loft('blocky', HEX, 1.0, 0.82, 0.07, 0.05),
  loft('plate', OCTA, 1.0, 0.98, 0.02, 0),
  loft('shell', SEGMENT, 1.0, 0.90, 0.03, 0.02),
  loft('splinter', STICK, 0.95, 0.34, 0.08, -0.05),
  loft('chip', CHIPTRI, 1.0, 0.30, 0.12, -0.08),
  loft('bent', BOW, 1.0, 0.94, 0.04, 0),
];

/* ─────────────────────────────────────────────────────────── quaternion maths ─ */

/* Bake-time scratch. Nothing in here runs per frame, but the codebase does not
   allocate in helpers and neither does this. */
const _q = new Float64Array(4);
const _qa = new Float64Array(4);
const _qb = new Float64Array(4);
let _rvx = 0, _rvy = 0, _rvz = 0;

/** Rotate (vx,vy,vz) by the unit quaternion q. Result in _rv*. */
function rotVec(q, vx, vy, vz) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  _rvx = vx + qw * tx + (qy * tz - qz * ty);
  _rvy = vy + qw * ty + (qz * tx - qx * tz);
  _rvz = vz + qw * tz + (qx * ty - qy * tx);
}

/** out = a ⊗ b (apply b first, then a). */
function quatMul(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** Euler XYZ → quaternion, matching three.js so a part's `rot` means the same here. */
function quatFromEulerXYZ(x, y, z, out) {
  const c1 = Math.cos(x * 0.5), s1 = Math.sin(x * 0.5);
  const c2 = Math.cos(y * 0.5), s2 = Math.sin(y * 0.5);
  const c3 = Math.cos(z * 0.5), s3 = Math.sin(z * 0.5);
  out[0] = s1 * c2 * c3 + c1 * s2 * s3;
  out[1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[3] = c1 * c2 * c3 - s1 * s2 * s3;
  return out;
}

/**
 * Quaternion from the piece's own axes, given where its LOCAL Z and LOCAL Y point.
 * Local X is whatever makes the frame right-handed, which is the only sane way to
 * write a generator: a splinter says "my long axis is the grain and my thin axis is
 * across it" and never touches a permutation table.
 */
function basisQuat(zx, zy, zz, yx, yy, yz, out) {
  const xx = yy * zz - yz * zy;
  const xy = yz * zx - yx * zz;
  const xz = yx * zy - yy * zx;
  const m00 = xx, m10 = xy, m20 = xz;
  const m01 = yx, m11 = yy, m21 = yz;
  const m02 = zx, m12 = zy, m22 = zz;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    out[3] = 0.25 / s;
    out[0] = (m21 - m12) * s;
    out[1] = (m02 - m20) * s;
    out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
  return out;
}

/** Small random tilt, in place: `q = jitter ⊗ q`. A piece with no tilt reads as a tile. */
function tilt(q, radians, rng) {
  if (radians <= 0) return q;
  let ax = rng.next() * 2 - 1, ay = rng.next() * 2 - 1, az = rng.next() * 2 - 1;
  const l = Math.sqrt(ax * ax + ay * ay + az * az);
  if (l < 1e-6) return q;
  ax /= l; ay /= l; az /= l;
  const a = rng.spread(radians) * 0.5;
  const s = Math.sin(a);
  _qa[0] = ax * s; _qa[1] = ay * s; _qa[2] = az * s; _qa[3] = Math.cos(a);
  quatMul(_qa, q, _qb);
  q[0] = _qb[0]; q[1] = _qb[1]; q[2] = _qb[2]; q[3] = _qb[3];
  return q;
}

/* ────────────────────────────────────────────────────────────── plan objects ─ */

/**
 * Preallocate a plan. `maxPieces` is a capacity, not a promise: `fracturePlan`
 * copies as much of a baked plan as fits, and because the bake is written in
 * quality order a truncated copy is still a good-looking break-up.
 *
 * Use `FRACTURE_MAX_PIECES` for a plan that can hold anything in the catalogue.
 */
export function makeFracturePlan(maxPieces) {
  const n = Math.max(1, maxPieces | 0);
  return {
    capacity: n,
    count: 0,
    key: '',
    variant: -1,
    /** Piece centre in UNSCALED prop-local space (same space as PROPS[].parts). */
    px: new Float32Array(n),
    py: new Float32Array(n),
    pz: new Float32Array(n),
    /** Half-extents along the piece's own axes, i.e. after its rotation. */
    sx: new Float32Array(n),
    sy: new Float32Array(n),
    sz: new Float32Array(n),
    qx: new Float32Array(n),
    qy: new Float32Array(n),
    qz: new Float32Array(n),
    qw: new Float32Array(n),
    mat: new Int32Array(n),
    hull: new Int32Array(n),
    detach: new Uint8Array(n),
    big: new Uint8Array(n),
    /** Filled by `gradeSizes`: 0 at the impact point, 1 at the far side. */
    grade: new Float32Array(n),
    /** Filled by `gradeSizes`: half-extents regraded against the impact point. */
    gsx: new Float32Array(n),
    gsy: new Float32Array(n),
    gsz: new Float32Array(n),
    /** The uniform correction `gradeSizes` applied to conserve total volume. */
    gradeScale: 1,
  };
}

/* ──────────────────────────────────────────────────────────── the bake itself ─ */

/** Growable staging, reused across every bake. Load-time only. */
const S = {
  n: 0, cap: 0, partCap: 0,
  px: [], py: [], pz: [], sx: [], sy: [], sz: [],
  qx: [], qy: [], qz: [], qw: [], mat: [], hull: [], detach: [], vol: [],
};

/* The part currently being fractured: its world-in-prop rotation and origin. */
const _qPart = new Float64Array(4);
let _partX = 0, _partY = 0, _partZ = 0;
let _minHalf = 0.025;
let _maxAspect = 22;

function resetStage(cap) {
  S.n = 0;
  S.cap = cap;
  S.partCap = cap;
}

/**
 * Emit one piece. `cx,cy,cz` and `q` are in PART space (before the part's own
 * rotation and offset); extents are along the piece's own axes.
 * @returns {boolean} false once the plan is full, so a generator can stop early.
 */
function emit(cx, cy, cz, q, hx, hy, hz, hull, matIdx, detach) {
  if (S.n >= S.cap || S.n >= S.partCap) return false;

  // A shard below the fragment floor is a particle, not a body (§10 lifecycle):
  // clamp rather than drop, so the volume stays where the eye expects it.
  let ex = hx > _minHalf ? hx : _minHalf;
  let ey = hy > _minHalf ? hy : _minHalf;
  let ez = hz > _minHalf ? hz : _minHalf;

  // Real sheet metal is 3 mm on a 4 m silo, but a fragment that thin is edge-on
  // invisible, z-fights the road it lands on, and reads as paper rather than steel.
  // Every piece keeps a minimum thickness relative to its own longest side.
  const longest = ex > ey ? (ex > ez ? ex : ez) : (ey > ez ? ey : ez);
  const floorA = longest / _maxAspect;
  if (ex < floorA) ex = floorA;
  if (ey < floorA) ey = floorA;
  if (ez < floorA) ez = floorA;

  rotVec(_qPart, cx, cy, cz);
  quatMul(_qPart, q, _qb);

  const i = S.n++;
  S.px[i] = _partX + _rvx;
  S.py[i] = _partY + _rvy;
  S.pz[i] = _partZ + _rvz;
  S.sx[i] = ex; S.sy[i] = ey; S.sz[i] = ez;
  S.qx[i] = _qb[0]; S.qy[i] = _qb[1]; S.qz[i] = _qb[2]; S.qw[i] = _qb[3];
  S.mat[i] = matIdx;
  S.hull[i] = hull;
  S.detach[i] = detach ? 1 : 0;
  S.vol[i] = 8 * ex * ey * ez * HULL_ARCHETYPES[hull].volumeRatio;
  return true;
}

/* ── failure modes ─────────────────────────────────────────────────────────── */

/**
 * Read a TUNING number with the value this module was measured against.
 *
 * Every other module in the codebase trusts TUNING, and so does this one — but the
 * bake runs at module load, and a missing `fracture*` key would not throw, it would
 * quietly produce NaN quaternions and invisible fragments. The fallbacks are the
 * shipped values, so this changes nothing when the keys are present.
 */
function num(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/** Unit axis vectors, indexed 0=x 1=y 2=z. Read-only. */
const AXIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Index of the smallest / largest of three. */
function argMin3(a, b, c) { return a <= b ? (a <= c ? 0 : 2) : (b <= c ? 1 : 2); }
function argMax3(a, b, c) { return a >= b ? (a >= c ? 0 : 2) : (b >= c ? 1 : 2); }

/**
 * GLASS. Sectors and rings around a shatter origin on the pane, thin through the
 * glass, long along the radius: slivers, not tiles. The origin is baked per variant
 * because the real contact point is a runtime fact — `gradeSizes` is what ties the
 * break-up to where the drum actually hit.
 */
function genShards(half, matIdx, budget, detach, rng) {
  const thin = argMin3(half[0], half[1], half[2]);
  const u = (thin + 1) % 3;
  const v = (thin + 2) % 3;
  const hu = half[u], hv = half[v], ht = half[thin];

  const rings = budget >= 18 ? 3 : 2;
  const sectors = Math.max(6, Math.min(16, Math.round(budget / rings)));
  const dTheta = (Math.PI * 2) / sectors;

  // Origin somewhere off centre, so the radial fan is asymmetric and the four
  // variants do not read as the same starburst rotated.
  const ou = rng.spread(0.55) * hu;
  const ov = rng.spread(0.55) * hv;
  const maxR = Math.sqrt((hu + Math.abs(ou)) * (hu + Math.abs(ou)) + (hv + Math.abs(ov)) * (hv + Math.abs(ov)));

  const spin = rng.next() * dTheta;
  for (let r = 0; r < rings; r++) {
    // Radii grow faster than linearly, so the innermost ring is fine and the
    // outer ring is coarse even before the runtime regrade.
    const r0 = maxR * Math.pow(r / rings, 1.45);
    const r1 = maxR * Math.pow((r + 1) / rings, 1.45);
    const rm = (r0 + r1) * 0.5;
    for (let s = 0; s < sectors; s++) {
      const th = spin + (s + rng.spread(0.18)) * dTheta;
      const cu = ou + Math.cos(th) * rm;
      const cv = ov + Math.sin(th) * rm;
      // Keep the piece inside the pane it came from.
      const ku = cu < -hu ? -hu : cu > hu ? hu : cu;
      const kv = cv < -hv ? -hv : cv > hv ? hv : cv;

      const c = [0, 0, 0];
      c[u] = ku; c[v] = kv; c[thin] = 0;

      const zx = AXIS[u][0] * Math.cos(th) + AXIS[v][0] * Math.sin(th);
      const zy = AXIS[u][1] * Math.cos(th) + AXIS[v][1] * Math.sin(th);
      const zz = AXIS[u][2] * Math.cos(th) + AXIS[v][2] * Math.sin(th);
      basisQuat(zx, zy, zz, AXIS[thin][0], AXIS[thin][1], AXIS[thin][2], _q);
      tilt(_q, 0.25, rng);

      const radial = (r1 - r0) * 0.5 * (1 + rng.spread(0.3));
      const tangent = rm * Math.sin(dTheta * 0.5) * (1 + rng.spread(0.25));
      if (!emit(c[0], c[1], c[2], _q, tangent, ht * 0.92, radial, ARCH_SLIVER, matIdx, detach)) return;
    }
  }
}

/**
 * WOOD. One cut along the grain at most, many across it. The aspect floor is the
 * whole rule: a wood fragment that is as wide as it is long reads as a brick, and
 * nothing about a smashed crate reads as bricks.
 */
function genSplinters(half, matIdx, budget, detach, rng) {
  const D = TUNING.destruction;
  const g = argMax3(half[0], half[1], half[2]);
  const a = (g + 1) % 3;
  const b = (g + 2) % 3;
  const aspect = num(D.fractureSplinterAspect, 2.6);

  let along = budget >= 12 && half[g] / Math.max(half[a], half[b]) > aspect * 2 ? 2 : 1;
  let across = Math.max(2, Math.round(Math.sqrt(budget / along)));
  let na = across, nb = across;
  // Split the wider cross-section axis more finely.
  if (half[a] > half[b] * 1.6) nb = Math.max(1, (across / 2) | 0);
  else if (half[b] > half[a] * 1.6) na = Math.max(1, (across / 2) | 0);

  // Hold the aspect ratio: back off the cross-section cuts until the splinter is
  // properly long, then back off the grain cut if it still is not.
  const lenOf = () => (2 * half[g] / along) / Math.max(2 * half[a] / na, 2 * half[b] / nb);
  while (lenOf() < aspect && (na > 1 || nb > 1)) {
    if (half[a] / na >= half[b] / nb) na = Math.max(1, na - 1);
    else nb = Math.max(1, nb - 1);
  }
  if (lenOf() < aspect) along = 1;

  const ca = (2 * half[a]) / na;
  const cb = (2 * half[b]) / nb;
  const cg = (2 * half[g]) / along;

  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      for (let k = 0; k < along; k++) {
        const c = [0, 0, 0];
        c[a] = -half[a] + ca * (i + 0.5) + rng.spread(0.12) * ca;
        c[b] = -half[b] + cb * (j + 0.5) + rng.spread(0.12) * cb;
        // Ragged ends: each splinter keeps its own length and slides along the grain.
        const shrink = 1 - rng.next() * 0.3;
        c[g] = -half[g] + cg * (k + 0.5) + rng.spread(0.5) * cg * (1 - shrink);

        basisQuat(AXIS[g][0], AXIS[g][1], AXIS[g][2], AXIS[b][0], AXIS[b][1], AXIS[b][2], _q);
        tilt(_q, 0.16, rng);

        const ha = ca * 0.5 * (1 + rng.spread(0.22));
        const hb = cb * 0.5 * (1 + rng.spread(0.22));
        if (!emit(c[0], c[1], c[2], _q, ha, hb, cg * 0.5 * shrink, ARCH_SPLINTER, matIdx, detach)) return;
      }
    }
  }
}

/**
 * SHEET METAL. A vending machine is a skin over air, so a solid box tears into
 * FACE panels and leaves a hole where the body was; something already flat just
 * tears at its seams. Either way panels keep a bend — a flat panel that lands
 * perfectly flat is the tell that this was a box all along.
 */
function genPanels(half, matIdx, budget, detach, rng) {
  const D = TUNING.destruction;
  const thin = argMin3(half[0], half[1], half[2]);
  const fat = argMax3(half[0], half[1], half[2]);
  const bend = num(D.fractureBendDeg, 16) * Math.PI / 180;
  const skin = Math.max(_minHalf, Math.min(num(D.fracturePanelThickness, 0.09) * 0.5, half[thin] * 0.6));
  const boxy = half[thin] > half[fat] * 0.3;

  const faceAxes = boxy ? [0, 1, 2] : [thin];
  let left = budget;

  for (let f = 0; f < faceAxes.length && left > 0; f++) {
    const n = faceAxes[f];
    const u = (n + 1) % 3;
    const v = (n + 2) % 3;
    const sides = boxy ? 2 : 1;
    // Panels per face, weighted by how much of the object this face is.
    const share = Math.max(1, Math.round(left / ((faceAxes.length - f) * sides)));
    let nu = Math.max(1, Math.round(Math.sqrt(share * (half[u] / (half[u] + half[v])) * 2)));
    let nv = Math.max(1, Math.round(share / nu));

    for (let s = 0; s < sides; s++) {
      const sgn = sides === 1 ? 0 : (s === 0 ? -1 : 1);
      const cu2 = (2 * half[u]) / nu;
      const cv2 = (2 * half[v]) / nv;
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
          const c = [0, 0, 0];
          c[u] = -half[u] + cu2 * (i + 0.5);
          c[v] = -half[v] + cv2 * (j + 0.5);
          c[n] = sgn * (half[n] - skin);

          // Local Z runs along the panel's long side — that is where the crease is.
          const long = cu2 >= cv2 ? u : v;
          const short = long === u ? v : u;
          basisQuat(AXIS[long][0], AXIS[long][1], AXIS[long][2], AXIS[n][0], AXIS[n][1], AXIS[n][2], _q);
          tilt(_q, bend, rng);

          const hl = (long === u ? cu2 : cv2) * 0.5 * (1 + rng.spread(0.12));
          const hs = (short === u ? cu2 : cv2) * 0.5 * (1 + rng.spread(0.12));
          const arch = rng.next() < 0.6 ? ARCH_BENT : ARCH_PLATE;
          if (!emit(c[0], c[1], c[2], _q, hs, boxy ? skin : half[thin], hl, arch, matIdx, detach)) return;
          left--;
        }
      }
    }
  }
}

/**
 * CONCRETE. Irregular blocks from jittered split planes — a regular grid is the
 * one thing that makes fracture read as fake — plus the fines. Rubble without dust
 * looks like a Lego set coming apart.
 */
function genChunks(half, matIdx, budget, detach, rng) {
  const D = TUNING.destruction;
  const dustFrac = num(D.fractureChunkDust, 0.30);
  const jit = num(D.fractureJitter, 0.35);
  const nDust = Math.max(1, Math.round(budget * dustFrac));
  const nBlock = Math.max(1, budget - nDust);

  // Split the long axes more than the short ones, so blocks stay roughly cubic.
  const total = half[0] + half[1] + half[2];
  const n = [1, 1, 1];
  let target = nBlock;
  while (n[0] * n[1] * n[2] < target) {
    let best = 0, bestScore = -Infinity;
    for (let a = 0; a < 3; a++) {
      const score = half[a] / n[a] + rng.next() * 1e-3 * total;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    n[best]++;
    if (n[0] * n[1] * n[2] > target * 1.6) { n[best]--; break; }
  }

  // Jittered cut positions per axis, shared by the whole slab so cuts line up as
  // real cracks rather than every block having its own idea of where the edge is.
  const cuts = [[], [], []];
  for (let a = 0; a < 3; a++) {
    cuts[a].push(-half[a]);
    for (let i = 1; i < n[a]; i++) {
      const t = i / n[a] + rng.spread(jit / n[a]);
      cuts[a].push(-half[a] + 2 * half[a] * Math.min(0.97, Math.max(0.03, t)));
    }
    cuts[a].push(half[a]);
    cuts[a].sort((p, q2) => p - q2);
  }

  for (let i = 0; i < n[0]; i++) {
    for (let j = 0; j < n[1]; j++) {
      for (let k = 0; k < n[2]; k++) {
        const x0 = cuts[0][i], x1 = cuts[0][i + 1];
        const y0 = cuts[1][j], y1 = cuts[1][j + 1];
        const z0 = cuts[2][k], z1 = cuts[2][k + 1];
        basisQuat(0, 0, 1, 0, 1, 0, _q);
        tilt(_q, 0.5, rng);
        const arch = rng.next() < 0.35 ? ARCH_WEDGE : ARCH_BLOCKY;
        if (!emit((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5, _q,
          (x1 - x0) * 0.5, (y1 - y0) * 0.5, (z1 - z0) * 0.5, arch, matIdx, detach)) return;
      }
    }
  }

  const fine = Math.min(half[0], Math.min(half[1], half[2]));
  for (let d = 0; d < nDust; d++) {
    basisQuat(0, 0, 1, 0, 1, 0, _q);
    tilt(_q, Math.PI, rng);
    const r = fine * (0.08 + rng.next() * 0.14);
    if (!emit(rng.spread(half[0] * 0.9), rng.spread(half[1] * 0.9), rng.spread(half[2] * 0.9), _q,
      r, r * (0.6 + rng.next() * 0.6), r * (0.6 + rng.next() * 0.6), ARCH_CHIP, matIdx, detach)) return;
  }
}

/** RUBBER / PLASTIC. Three or four big curved shells, split across the long axis. */
function genShells(half, matIdx, budget, detach, rng) {
  const g = argMax3(half[0], half[1], half[2]);
  const a = (g + 1) % 3;
  const b = (g + 2) % 3;
  const n = Math.max(2, Math.min(5, budget));
  const c2 = (2 * half[g]) / n;

  for (let i = 0; i < n; i++) {
    const c = [0, 0, 0];
    c[g] = -half[g] + c2 * (i + 0.5);
    c[a] = rng.spread(0.1) * half[a];
    basisQuat(AXIS[g][0], AXIS[g][1], AXIS[g][2], AXIS[a][0], AXIS[a][1], AXIS[a][2], _q);
    tilt(_q, 0.3, rng);
    if (!emit(c[0], c[1], c[2], _q,
      half[b] * (0.75 + rng.next() * 0.25), half[a] * (0.7 + rng.next() * 0.3), c2 * 0.5 * 0.92,
      ARCH_SHELL, matIdx, detach)) return;
  }
}

/**
 * CYLINDERS. Sectors around the axis and slices along it. A silo peels into curved
 * panels, a bottle into curved slivers, a concrete plinth into solid wedges — the
 * same loop, with the radial extent and the hull chosen by family. Wheels never get
 * here: they come off whole.
 */
function genCylinder(radius, halfH, family, matIdx, budget, detach, rng) {
  const D = TUNING.destruction;
  const slices = Math.max(1, Math.min(4, Math.round(Math.sqrt(budget / 2.6))));
  const sectors = Math.max(3, Math.min(16, Math.round(budget / slices)));
  const dTheta = (Math.PI * 2) / sectors;
  const solid = family === 'CHUNK';
  // Sheet peels off thin; a shell is a thick curved slab. A water tank given a
  // steel wall thickness pulverises into confetti, which is not what 20 tonnes of
  // water tower should leave behind.
  const wall = solid ? radius
    : family === 'SHELL' ? radius * 0.22
      : Math.max(_minHalf, Math.min(num(D.fracturePanelThickness, 0.09) * 0.5, radius * 0.35));
  const rMid = solid ? radius * 0.5 : radius - wall;
  const arch = family === 'SHARD' ? ARCH_SLIVER
    : family === 'CHUNK' ? ARCH_BLOCKY
      : family === 'SPLINTER' ? ARCH_SPLINTER
        : ARCH_SHELL;
  const sliceH = (2 * halfH) / slices;
  const spin = rng.next() * dTheta;

  for (let s = 0; s < slices; s++) {
    const cy = -halfH + sliceH * (s + 0.5);
    for (let t = 0; t < sectors; t++) {
      const th = spin + (t + rng.spread(0.15)) * dTheta;
      const ct = Math.cos(th), st = Math.sin(th);
      // Y is radial (a shell bulges outward), Z is axial.
      basisQuat(0, 1, 0, ct, 0, st, _q);
      tilt(_q, 0.18, rng);
      const tangent = rMid * Math.sin(dTheta * 0.5) * (1 + rng.spread(0.2));
      if (!emit(ct * rMid, cy, st * rMid, _q,
        tangent, wall * 0.5 * (1 + rng.spread(0.15)), sliceH * 0.5 * (1 + rng.spread(0.15)),
        arch, matIdx, detach)) return;
    }
  }
}

/* ── one prop, one variant ─────────────────────────────────────────────────── */

/** Volume of a part, treating a cylinder as a cylinder rather than its box. */
function partVolume(part) {
  const s = part.scale;
  if (part.geo === 'cyl') {
    const r = (s[0] + s[2]) * 0.25;
    return Math.PI * r * r * s[1];
  }
  return s[0] * s[1] * s[2];
}

/**
 * Is this part something that comes off in one piece rather than breaking up?
 *
 * There is no metadata for it in the catalogue and none should be added there —
 * the shape already says it. A rubber cylinder is a wheel. A thin plate that is a
 * small share of the object and sits out on its edge is a door, a bumper, a mirror
 * or a sign. A pane of glass on the outside of a vehicle is a window, which does
 * shatter, but leaves the body on its own path rather than riding the hull's.
 */
function detachKind(part, propHalf, propVol) {
  const s = part.scale;
  if (part.geo === 'cyl' && part.material === 'rubber') return 2;      // whole wheel
  const mn = Math.min(s[0], Math.min(s[1], s[2]));
  const mx = Math.max(s[0], Math.max(s[1], s[2]));
  const thin = mn < mx * 0.3;
  if (!thin) return 0;
  const vol = partVolume(part);
  const peripheral =
    Math.abs(part.pos[0]) + s[0] * 0.5 >= propHalf[0] * 0.8 ||
    Math.abs(part.pos[2]) + s[2] * 0.5 >= propHalf[2] * 0.8;
  if (!peripheral) return 0;
  // Glass gets a looser share threshold than sheet: a bus windscreen band really is
  // a fifth of the bus, where a bumper is never a fifth of a car.
  const frac = num(TUNING.destruction.fractureDetachVolumeFrac, 0.12) * (part.material === 'glass' ? 2.5 : 1);
  return vol < frac * propVol ? 1 : 0;
}

const _half = [0, 0, 0];

function bakeVariant(def, variant) {
  const D = TUNING.destruction;
  const cap = Math.max(4, num(D.fracturePieceCap, 44) | 0);
  _minHalf = Math.max(1e-3, 0.5 * D.fragmentMinScale);
  _maxAspect = Math.max(2, num(D.fractureMaxAspect, 22));
  resetStage(cap);

  const rng = new Rng(hashKey(def.key, variant));
  const parts = def.parts;
  const propHalf = [def.size[0] * 0.5, def.size[1] * 0.5, def.size[2] * 0.5];

  let propVol = 0;
  for (let i = 0; i < parts.length; i++) propVol += partVolume(parts[i]);

  // Piece budget per part. Volume^(2/3) rather than volume, so a silo does not
  // spend the whole plan on its tank and leave the plinth as a single slab; then
  // the material's own appetite on top, because glass wants shards where rubber
  // wants three shells.
  let wSum = 0;
  const weights = [];
  for (let i = 0; i < parts.length; i++) {
    const phys = materialPhysics(parts[i].material);
    const w = Math.pow(Math.max(1e-4, partVolume(parts[i]) / Math.max(1e-4, propVol)), 2 / 3) * phys.pieceDensity;
    weights.push(w);
    wSum += w;
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const phys = materialPhysics(part.material);
    const matIdx = materialIndex(part.material);
    const kind = detachKind(part, propHalf, propVol);
    let budget = Math.max(1, Math.round((cap * weights[i]) / Math.max(1e-6, wSum)));
    if (kind === 1) budget = Math.min(budget, 4);                       // trim breaks small

    // A generator lands near its budget rather than on it — a shatter fan is
    // sectors x rings, not a piece count — so give it headroom but hold back what
    // the parts after it are owed. Without the reservation a car's body would eat
    // the whole plan and its wheels would never come off.
    let reserved = 0;
    for (let j = i + 1; j < parts.length; j++) {
      reserved += Math.max(1, Math.round((cap * weights[j]) / Math.max(1e-6, wSum)));
    }
    const room = Math.max(1, cap - S.n - reserved);
    S.partCap = S.n + Math.min(Math.max(1, kind === 1 ? budget : budget * 2), room);

    _partX = part.pos[0]; _partY = part.pos[1]; _partZ = part.pos[2];
    if (part.rot) quatFromEulerXYZ(part.rot[0], part.rot[1], part.rot[2], _qPart);
    else { _qPart[0] = 0; _qPart[1] = 0; _qPart[2] = 0; _qPart[3] = 1; }

    const s = part.scale;
    if (kind === 2) {
      // A wheel leaves whole and bounces — rubber's restitution is the highest in
      // the table for exactly this shot.
      const r = (s[0] + s[2]) * 0.25;
      basisQuat(0, 1, 0, 1, 0, 0, _q);
      emit(0, 0, 0, _q, r, s[1] * 0.5, r, ARCH_SHELL, matIdx, 1);
      continue;
    }

    if (part.geo === 'cyl') {
      const r = (s[0] + s[2]) * 0.25;
      genCylinder(r, s[1] * 0.5, phys.family, matIdx, budget, kind === 1, rng);
      continue;
    }

    _half[0] = s[0] * 0.5; _half[1] = s[1] * 0.5; _half[2] = s[2] * 0.5;
    switch (phys.family) {
      case 'SHARD': genShards(_half, matIdx, budget, kind === 1, rng); break;
      case 'SPLINTER': genSplinters(_half, matIdx, budget, kind === 1, rng); break;
      case 'PANEL': genPanels(_half, matIdx, budget, kind === 1, rng); break;
      case 'SHELL': genShells(_half, matIdx, budget, kind === 1, rng); break;
      case 'CHUNK':
      default: genChunks(_half, matIdx, budget, kind === 1, rng); break;
    }
  }

  return freezeStage(rng);
}

/**
 * Copy the staging into typed arrays, in QUALITY ORDER: the three largest pieces,
 * then anything detachable, then the rest shuffled. A consumer that can only afford
 * the first eight pieces of a plan still gets the three that carry the silhouette
 * and a fair sample of the rest, rather than one corner of the object.
 */
function freezeStage(rng) {
  const n = S.n;
  const order = new Int32Array(n);
  const taken = new Uint8Array(n);
  const bigFlag = new Uint8Array(n);
  let w = 0;

  for (let b = 0; b < 3 && b < n; b++) {
    let best = -1, bestVol = -1;
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      if (S.vol[i] > bestVol) { bestVol = S.vol[i]; best = i; }
    }
    if (best < 0) break;
    taken[best] = 1; bigFlag[best] = 1; order[w++] = best;
  }
  // "A part came off" is a read, and a read does not survive fourteen simultaneous
  // copies of itself: a bus flagged every sliver of its windscreen band. Only the
  // largest few pieces of a detachable part keep the flag and the independent throw
  // that goes with it; the rest of that part is ordinary debris.
  const keep = new Uint8Array(n);
  const maxDetach = Math.max(0, num(TUNING.destruction.fractureMaxDetach, 6) | 0);
  let detached = 0;
  for (let i = 0; i < n && detached < maxDetach; i++) {
    if (bigFlag[i] && S.detach[i]) { keep[i] = 1; detached++; }
  }
  while (detached < maxDetach) {
    let best = -1, bestVol = -1;
    for (let i = 0; i < n; i++) {
      if (taken[i] || !S.detach[i]) continue;
      if (S.vol[i] > bestVol) { bestVol = S.vol[i]; best = i; }
    }
    if (best < 0) break;
    taken[best] = 1; keep[best] = 1; order[w++] = best; detached++;
  }
  const restStart = w;
  for (let i = 0; i < n; i++) if (!taken[i]) order[w++] = i;
  for (let i = w - 1; i > restStart; i--) {
    const j = restStart + Math.floor(rng.next() * (i - restStart + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }

  const p = {
    count: n,
    px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n),
    sx: new Float32Array(n), sy: new Float32Array(n), sz: new Float32Array(n),
    qx: new Float32Array(n), qy: new Float32Array(n), qz: new Float32Array(n), qw: new Float32Array(n),
    mat: new Int32Array(n), hull: new Int32Array(n),
    detach: new Uint8Array(n), big: new Uint8Array(n),
    volume: 0,
  };
  for (let k = 0; k < n; k++) {
    const i = order[k];
    p.px[k] = S.px[i]; p.py[k] = S.py[i]; p.pz[k] = S.pz[i];
    p.sx[k] = S.sx[i]; p.sy[k] = S.sy[i]; p.sz[k] = S.sz[i];
    p.qx[k] = S.qx[i]; p.qy[k] = S.qy[i]; p.qz[k] = S.qz[i]; p.qw[k] = S.qw[i];
    p.mat[k] = S.mat[i]; p.hull[k] = S.hull[i];
    p.detach[k] = keep[i]; p.big[k] = bigFlag[i];
    p.volume += S.vol[i];
  }
  return p;
}

/** Deterministic seed from a prop key and a variant. Same input, same fracture. */
function hashKey(key, variant) {
  let h = 0x811c9dc5 ^ (variant * 0x9e3779b1);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

/** propKey → array of FRACTURE_VARIANTS baked plans. */
let BAKED = Object.create(null);
/** The largest baked plan in the catalogue, so a caller can size one plan for all. */
export let FRACTURE_MAX_PIECES = 0;

/**
 * Re-run the bake. Called once at module load; exported so live-tweaking a
 * `TUNING.destruction.fracture*` value has somewhere to land, in the same spirit as
 * the rest of the codebase reading TUNING at call time.
 */
export function rebake() {
  const next = Object.create(null);
  let max = 0;
  for (let i = 0; i < PROP_KEYS.length; i++) {
    const key = PROP_KEYS[i];
    const def = PROPS[key];
    if (!def || !def.parts || def.parts.length === 0) continue;
    const variants = new Array(FRACTURE_VARIANTS);
    for (let v = 0; v < FRACTURE_VARIANTS; v++) {
      variants[v] = bakeVariant(def, v);
      if (variants[v].count > max) max = variants[v].count;
    }
    next[key] = variants;
  }
  BAKED = next;
  FRACTURE_MAX_PIECES = max;
  return max;
}

rebake();

/* ───────────────────────────────────────────────────────── the runtime surface ─ */

/**
 * Fill `out` with one prop's fracture plan.
 *
 * Piece positions are in UNSCALED prop-local space — the same space as
 * `PROPS[key].parts`, origin on the ground under the object — so a consumer
 * multiplies by the placed prop's `scale`, rotates by its yaw and adds its origin.
 * `sx/sy/sz` are HALF-extents; `fx/fragments.js` wants full sizes, so double them.
 *
 * @param {string} propKey
 * @param {number} variant any integer; wrapped into [0, FRACTURE_VARIANTS)
 * @param {ReturnType<makeFracturePlan>} out
 * @returns {number} pieces written, which is min(baked count, out.capacity)
 */
export function fracturePlan(propKey, variant, out) {
  if (!out) return 0;
  const variants = BAKED[propKey];
  out.key = propKey;
  out.gradeScale = 1;
  if (!variants) { out.count = 0; out.variant = -1; return 0; }

  const vi = ((variant | 0) % FRACTURE_VARIANTS + FRACTURE_VARIANTS) % FRACTURE_VARIANTS;
  const src = variants[vi];
  const n = src.count < out.capacity ? src.count : out.capacity;

  if (n === src.count) {
    out.px.set(src.px); out.py.set(src.py); out.pz.set(src.pz);
    out.sx.set(src.sx); out.sy.set(src.sy); out.sz.set(src.sz);
    out.qx.set(src.qx); out.qy.set(src.qy); out.qz.set(src.qz); out.qw.set(src.qw);
    out.mat.set(src.mat); out.hull.set(src.hull);
    out.detach.set(src.detach); out.big.set(src.big);
  } else {
    out.px.set(src.px.subarray(0, n)); out.py.set(src.py.subarray(0, n)); out.pz.set(src.pz.subarray(0, n));
    out.sx.set(src.sx.subarray(0, n)); out.sy.set(src.sy.subarray(0, n)); out.sz.set(src.sz.subarray(0, n));
    out.qx.set(src.qx.subarray(0, n)); out.qy.set(src.qy.subarray(0, n));
    out.qz.set(src.qz.subarray(0, n)); out.qw.set(src.qw.subarray(0, n));
    out.mat.set(src.mat.subarray(0, n)); out.hull.set(src.hull.subarray(0, n));
    out.detach.set(src.detach.subarray(0, n)); out.big.set(src.big.subarray(0, n));
  }

  out.count = n;
  out.variant = vi;
  // Ungraded default, so a consumer that never calls gradeSizes still reads gs*.
  out.gsx.set(out.sx.subarray(0, n));
  out.gsy.set(out.sy.subarray(0, n));
  out.gsz.set(out.sz.subarray(0, n));
  for (let i = 0; i < n; i++) out.grade[i] = 1;
  return n;
}

/** Pieces baked for a prop/variant, before any capacity truncation. */
export function fracturePieceCount(propKey, variant) {
  const variants = BAKED[propKey];
  if (!variants) return 0;
  const vi = ((variant | 0) % FRACTURE_VARIANTS + FRACTURE_VARIANTS) % FRACTURE_VARIANTS;
  return variants[vi].count;
}

/** Total baked fragment volume for a prop/variant, m³ in unscaled prop-local space. */
export function fractureVolume(propKey, variant) {
  const variants = BAKED[propKey];
  if (!variants) return 0;
  const vi = ((variant | 0) % FRACTURE_VARIANTS + FRACTURE_VARIANTS) % FRACTURE_VARIANTS;
  return variants[vi].volume;
}

/**
 * Grade a plan's piece sizes against the point that was actually hit: SMALL near
 * the contact, LARGE away from it. Of everything in §10 this is the detail that
 * does the most for how the break-up reads, and it is the one that cannot be baked,
 * because until the frame of the hit nobody knows where the drum met the object.
 *
 * The regrade is volume-conserving — the factors are renormalised so the total
 * fragment volume is unchanged — so a glancing hit on one corner produces fine
 * debris there and heavy chunks off the far end, rather than simply less object.
 *
 * `lx,ly,lz` is the impact point in the same UNSCALED prop-local space as the plan.
 * From a world contact point: subtract the prop origin, un-rotate by its yaw,
 * divide by its scale.
 *
 * Allocation-free; writes `grade[]` and `gsx/gsy/gsz[]`.
 */
export function gradeSizes(plan, lx, ly, lz) {
  const n = plan ? plan.count : 0;
  if (n === 0) return plan;

  const D = TUNING.destruction;
  const near = num(D.fractureNearScale, 0.55);
  const far = num(D.fractureFarScale, 1.50);

  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const dx = plan.px[i] - lx;
    const dy = plan.py[i] - ly;
    const dz = plan.pz[i] - lz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    plan.grade[i] = d;
    if (d > maxD) maxD = d;
  }
  const inv = maxD > 1e-5 ? 1 / maxD : 0;

  let volBase = 0;
  let volGraded = 0;
  for (let i = 0; i < n; i++) {
    const t = smoothstep(plan.grade[i] * inv);
    plan.grade[i] = t;
    const f = near + (far - near) * t;
    // Weight by the archetype's fill ratio. A plan mixes a 0.19 sliver with a 0.92
    // plate, so normalising on the bounding box conserves boxes rather than matter
    // — and `fx/fragments.js` takes a fragment's MASS from these extents times the
    // same ratio, which made a corner hit on a van throw a third more debris mass
    // than a centre hit on the same van.
    const v = plan.sx[i] * plan.sy[i] * plan.sz[i] * HULL_ARCHETYPES[plan.hull[i]].volumeRatio;
    volBase += v;
    volGraded += v * f * f * f;
  }
  const k = volGraded > 1e-12 ? Math.cbrt(volBase / volGraded) : 1;
  plan.gradeScale = k;

  const floor = Math.max(1e-3, 0.5 * D.fragmentMinScale);
  for (let i = 0; i < n; i++) {
    const f = (near + (far - near) * plan.grade[i]) * k;
    const a = plan.sx[i] * f, b = plan.sy[i] * f, c = plan.sz[i] * f;
    plan.gsx[i] = a > floor ? a : floor;
    plan.gsy[i] = b > floor ? b : floor;
    plan.gsz[i] = c > floor ? c : floor;
  }
  return plan;
}

export default fracturePlan;
