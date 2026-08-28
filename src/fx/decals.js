/**
 * TONNAGE — ground decals (§10).
 *
 * The marks that stay. Fragments clear frame in about a second and the particle
 * field is gone in three, so without this layer a smashed formation leaves the
 * road looking untouched half a second later — which reads as nothing having
 * happened. Decals are the memory of the run: a scatter of debris under every
 * destruction, glass glitter that catches the light, and the crushed, scorched
 * strip the roller drags behind it.
 *
 * ONE pooled `InstancedMesh` of ground-hugging quads over a shared
 * `PlaneGeometry(1,1)`, and every quad is SLOPE-MATCHED. That is not a detail:
 * the ramp is 8-22 degrees for its whole length (§6.1 — it never levels out and
 * never climbs), and a decal composed flat buries half of itself in the road at
 * 14 degrees and floats the other half. So each quad is built on the ramp's own
 * basis — right (1,0,0), downhill (0,-sin s,-cos s), normal (0,cos s,-sin s) —
 * yawed about that normal and lifted along it.
 *
 * Decals persist for the run, so the store is a plain ring rather than one of
 * `core/pool.js`'s pools: nothing here ever dies of old age, which means the
 * oldest slot is always exactly `_next`, and the 701st mark overwrites it with no
 * search at all. (`RingPool` would work, but its steal path is a linear scan of
 * the live set, and with the ring permanently full every single decal placed
 * after the first 700 would pay it.) By then that decal is several hundred metres
 * up the hill behind the camera, so nothing here fades out either.
 *
 * The cost model is the point of the storage layout: a decal is STATIC once
 * placed, so its matrix, colour and kind are written once at `add` time straight
 * into the instance buffers at its own slot index, and no compaction pass exists.
 * `update` only touches decals that are still animating — the 0.14 s fade-in, and
 * glitter's few seconds of twinkle — and when none are, it uploads nothing.
 *
 * Nothing allocates after construction.
 */

import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  PlaneGeometry,
} from 'three/webgpu';
import { attribute, float, mix, uv } from 'three/tsl';

import { TUNING } from '../tuning.js';
import { clamp, TAU } from '../core/math.js';
import { fxRng } from '../core/rng.js';
import { materialIndex } from './fracture.js';

/* ───────────────────────────────────────────── module scratch (never allocated
   inside add/update — these are the only mutable globals this module owns) */

const _col = new Color();

/** Linear-space RGB of a 0xRRGGBB int, written into these three scalars. */
let _cr = 1;
let _cg = 1;
let _cb = 1;
function unpackColor(hex) {
  _col.setHex(hex);
  _cr = _col.r;
  _cg = _col.g;
  _cb = _col.b;
}

/**
 * Glass is the one material that gets a second decal pass, so its index is
 * resolved once here rather than hardcoded — `MATERIAL_KEYS` order is fracture.js's
 * business, not ours.
 */
const GLASS_INDEX = materialIndex('glass');

/** Soft blotch (debris, dust). */
const KIND_SOFT = 0;
/** Hard-edged streak (the crush trail, glass glitter). */
const KIND_HARD = 1;

export class DecalSystem {
  /** @param {import('three/webgpu').Scene} scene */
  constructor(scene) {
    const D = TUNING.decals;

    this.scene = scene;
    this._disposed = false;

    const cap = Math.max(1, D.max | 0);
    this.cap = cap;

    // ── per-decal state. Position/orientation live only in the instance matrix:
    // a decal never moves, so there is nothing to re-derive them from.
    this.alpha0 = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.animT = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.twinkle = new Float32Array(cap);

    this.geometry = new PlaneGeometry(1, 1);
    const fadeAttr = new InstancedBufferAttribute(new Float32Array(cap), 1);
    const kindAttr = new InstancedBufferAttribute(new Float32Array(cap), 1);
    fadeAttr.setUsage(DynamicDrawUsage);
    kindAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aFade', fadeAttr);
    this.geometry.setAttribute('aKind', kindAttr);
    this._fadeAttr = fadeAttr;
    this._kindAttr = kindAttr;

    this.material = createDecalMaterial();
    this.mesh = new InstancedMesh(this.geometry, this.material, cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = D.renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.matArr = this.mesh.instanceMatrix.array;
    this.colArr = this.mesh.instanceColor.array;
    this.fadeArr = fadeAttr.array;
    this.kindArr = kindAttr.array;

    if (scene) scene.add(this.mesh);

    /** Ring cursor: the next slot to write, and so also the oldest live one. */
    this._next = 0;
    /** Slots ever written, capped at `cap`. Slots fill 0,1,2,… so this is also
        the draw count. */
    this._live = 0;
    /** Decals still animating. Zero means `update` does no work at all. */
    this._animCount = 0;
    this._dirty = false;

    /** Last stamp of the crush trail, for the min-step gate. */
    this._lastX = 1e9;
    this._lastZ = 1e9;
    /** Last slope anyone told us about, so `addDebris` can omit it. */
    this._lastSlope = TUNING.world.baseSlopeDeg * (Math.PI / 180);
  }

  get activeCount() {
    return this._live;
  }

  /* ─────────────────────────────────────────────────────────────── placement */

  /**
   * Scatter debris marks under a destruction. One call is a patch of ground, not
   * a single quad: `decals.debrisScatter` blotches spread over `radius`, plus a
   * handful of glints when the material is glass.
   *
   * @param {number} radius rough footprint of the thing that broke, in metres
   * @param {number} colour 0xRRGGBB, normally the material's particle tint
   * @param {number} materialIdx index into MATERIAL_PHYSICS (see fracture.js)
   * @param {number} [slopeRad] ramp grade here; defaults to the last one seen,
   *   which the roller refreshes every time it stamps the crush trail
   */
  addDebris(x, y, z, radius, colour, materialIdx, slopeRad) {
    if (this._disposed) return;
    const D = TUNING.decals;
    const slope = slopeRad === undefined ? this._lastSlope : slopeRad;
    const r = radius > 0.05 ? radius : 0.05;

    const n = fxRng.int(D.debrisScatter[0], D.debrisScatter[1]);
    unpackColor(colour === undefined ? D.debrisFallbackColor : colour);
    // Stains on tarmac are darker than the dust that made them.
    const dr = _cr * D.debrisDarken;
    const dg = _cg * D.debrisDarken;
    const db = _cb * D.debrisDarken;
    for (let k = 0; k < n; k++) {
      // spread in the SURFACE plane, so a scatter on a 20-degree pitch stays on it
      const a = fxRng.next() * TAU;
      const rr = r * Math.sqrt(fxRng.next()) * D.debrisSpread;
      const size = r * fxRng.range(D.debrisRadiusScale[0], D.debrisRadiusScale[1]);
      this._place(
        x, y, z, slope, Math.cos(a) * rr, Math.sin(a) * rr,
        size, size * fxRng.range(0.7, 1.35), fxRng.next() * TAU,
        dr, dg, db, D.debrisAlpha * fxRng.range(0.7, 1.15), KIND_SOFT, 0,
      );
    }

    if (materialIdx === GLASS_INDEX) this._addGlitter(x, y, z, slope, r);
  }

  /**
   * The crush trail. Safe to call every frame: a min-step gate means the roller
   * stamps one mark per `decals.trailStep` metres however fast the game is
   * running, so the trail has the same density at 12 m/s and at 45 m/s.
   *
   * @param {number} halfWidth the roller's half-width — the strip is its footprint
   * @param {number} slopeRad ramp grade here, in radians
   */
  addTrail(x, y, z, halfWidth, slopeRad) {
    if (this._disposed) return;
    const D = TUNING.decals;
    if (slopeRad !== undefined) this._lastSlope = slopeRad;
    const slope = this._lastSlope;

    const dx = x - this._lastX;
    const dz = z - this._lastZ;
    const step = D.trailStep;
    if (dx * dx + dz * dz < step * step) return;
    this._lastX = x;
    this._lastZ = z;

    const w = (halfWidth > 0.05 ? halfWidth : 0.05) * 2 * D.trailWidthScale;
    this._place(
      x, y, z, slope, 0, 0,
      w, step * D.trailLengthScale, 0,
      _scorchR, _scorchG, _scorchB,
      D.trailAlpha * fxRng.range(0.85, 1.1), KIND_HARD, 0,
    );
  }

  /** Glass only: a few tiny bright quads that twinkle for a while. @private */
  _addGlitter(x, y, z, slope, r) {
    const D = TUNING.decals;
    const n = fxRng.int(D.glitterCount[0], D.glitterCount[1]);
    unpackColor(D.glitterColor);
    const gr = _cr, gg = _cg, gb = _cb;
    for (let k = 0; k < n; k++) {
      const a = fxRng.next() * TAU;
      const rr = r * Math.sqrt(fxRng.next()) * D.glitterSpread;
      const s = fxRng.range(D.glitterSize[0], D.glitterSize[1]);
      this._place(
        x, y, z, slope, Math.cos(a) * rr, Math.sin(a) * rr,
        s, s * fxRng.range(1.4, 3.2), fxRng.next() * TAU,
        gr, gg, gb, D.glitterAlpha, KIND_HARD, 1,
      );
    }
  }

  /**
   * Acquire a slot and write its instance data once. `across` and `along` are
   * offsets in the ramp's own surface plane, so nothing ever sinks into the road
   * or floats above it.
   * @private
   */
  _place(x, y, z, slope, across, along, w, h, yaw, cr, cg, cb, alpha, kind, twinkle) {
    const D = TUNING.decals;
    const i = this._next;
    this._next = i + 1 === this.cap ? 0 : i + 1;
    if (this._live < this.cap) this._live++;
    // Overwriting a slot that was still animating: drop its claim on the counter
    // first, or `_animCount` drifts up and `update` never goes quiet again.
    if (this.animT[i] > 0) this._animCount--;

    // The ramp descends toward -Z, so its surface basis is:
    //   downhill (0, -sin s, -cos s)   normal (0, cos s, -sin s)   right (1, 0, 0)
    const cs = Math.cos(slope);
    const ss = Math.sin(slope);
    const ny = cs, nz = -ss;                 // normal   (x is 0 for both, so it drops out)
    const fy = -ss, fz = -cs;                // downhill

    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    // right and downhill, rotated by `yaw` about the surface normal
    const rxw = cy;
    const ryw = fy * sy;
    const rzw = fz * sy;
    const uxw = -sy;
    const uyw = fy * cy;
    const uzw = fz * cy;

    const maxS = D.maxSize;
    const sw = clamp(w, 0.02, maxS);
    const sh = clamp(h, 0.02, maxS);
    const lift = D.lift + (kind === KIND_HARD ? D.hardLift : 0);

    const o = i * 16;
    const mat = this.matArr;
    mat[o] = rxw * sw;
    mat[o + 1] = ryw * sw;
    mat[o + 2] = rzw * sw;
    mat[o + 3] = 0;
    mat[o + 4] = uxw * sh;
    mat[o + 5] = uyw * sh;
    mat[o + 6] = uzw * sh;
    mat[o + 7] = 0;
    mat[o + 8] = 0;
    mat[o + 9] = ny;
    mat[o + 10] = nz;
    mat[o + 11] = 0;
    mat[o + 12] = x + across * cy - along * sy;
    mat[o + 13] = y + (across * fy * sy + along * fy * cy) + ny * lift;
    mat[o + 14] = z + (across * fz * sy + along * fz * cy) + nz * lift;
    mat[o + 15] = 1;

    const c = i * 3;
    this.colArr[c] = cr;
    this.colArr[c + 1] = cg;
    this.colArr[c + 2] = cb;

    this.alpha0[i] = alpha;
    this.age[i] = 0;
    this.phase[i] = fxRng.next() * TAU;
    this.twinkle[i] = twinkle;
    this.animT[i] = twinkle !== 0 ? D.glitterTwinkle : D.popIn;
    this._animCount++;

    this.fadeArr[i] = 0;              // popIn: nothing is ever stamped at full strength
    this.kindArr[i] = kind;
    this._kindAttr.needsUpdate = true;
    this._dirty = true;
  }

  /* ─────────────────────────────────────────────────────────────── per-frame */

  /**
   * Advance the fade-ins and the glitter twinkle. A decal that has settled costs
   * nothing at all — the loop is skipped outright once `_animCount` reaches zero.
   */
  update(dt) {
    if (this._disposed) return;
    const count = this._live;
    this.mesh.count = count;
    this.mesh.visible = count > 0;

    if (this._animCount > 0 && dt > 0) {
      const D = TUNING.decals;
      const popIn = D.popIn > 1e-4 ? D.popIn : 1e-4;
      const w = D.glitterTwinkleHz * TAU;
      const settle = D.glitterSettle;
      const fade = this.fadeArr;

      for (let i = 0; i < count; i++) {
        let t = this.animT[i];
        if (t <= 0) continue;
        const age = this.age[i] + dt;
        this.age[i] = age;
        t -= dt;

        let a = this.alpha0[i];
        if (age < popIn) a *= age / popIn;
        const tw = this.twinkle[i] !== 0;
        if (t <= 0) {
          this.animT[i] = 0;
          this._animCount--;
          // Freeze at a fixed level rather than wherever the sine happened to be,
          // so no glint settles invisible.
          fade[i] = tw ? a * settle : a;
        } else {
          this.animT[i] = t;
          if (tw) a *= 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.phase[i] + age * w));
          fade[i] = a;
        }
      }
      this._dirty = true;
    }

    if (this._dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      this._fadeAttr.needsUpdate = true;
      this._dirty = false;
    }
  }

  /* ────────────────────────────────────────────────────────────── lifecycle */

  reset() {
    if (this._disposed) return;
    this.animT.fill(0);
    this._next = 0;
    this._live = 0;
    this._animCount = 0;
    this._dirty = false;
    this._lastX = 1e9;
    this._lastZ = 1e9;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.scene) this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.scene = null;
  }
}

/* ──────────────────────────────────────────────────────────────── internals */

/** Scorch colour, unpacked once — every trail stamp shares it. */
let _scorchR = 0;
let _scorchG = 0;
let _scorchB = 0;
{
  const c = new Color(TUNING.decals.trailColor);
  _scorchR = c.r; _scorchG = c.g; _scorchB = c.b;
}

/**
 * Colour rides in on `instanceColor`; this material only shapes the alpha. Two
 * masks over the same quad — a soft blotch for scattered debris and a harder
 * streak for the crush trail and for glass glints — mixed by the per-instance
 * `aKind`, which is what lets the whole layer stay one draw call.
 */
function createDecalMaterial() {
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    blending: NormalBlending,
    fog: true,
  });
  const m = float(1).sub(uv().sub(0.5).length().mul(2)).clamp(0, 1);
  const soft = m.mul(m).mul(float(3).sub(m.mul(2)));
  const hard = m.mul(2.4).clamp(0, 1);
  mat.opacityNode = attribute('aFade').mul(mix(soft, hard, attribute('aKind')));
  return mat;
}

export default DecalSystem;
