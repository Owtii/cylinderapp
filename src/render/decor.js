import * as THREE from 'three/webgpu';
import { TUNING } from '../tuning.js';
import { Rng } from '../core/rng.js';
import { DEG } from '../core/math.js';
import { ROAD_HALF } from '../world/track.js';

/**
 * Scenery — and the strictest rule in the redesign.
 *
 * There are exactly two visual languages in this game. Everything on the road is
 * interactive: it carries a printed weight, a live green/amber/red outline and a
 * shape badge, and the player judges it in under half a second. Everything off the
 * road is scenery, and its entire job is to be seen WITHOUT being looked at. If a
 * stranger looking at a frozen frame cannot instantly tell the two apart, the
 * readability system has already failed, whatever the outlines are doing.
 *
 * So decor is held apart on five axes at once, and every one of them is enforced
 * here rather than left to taste:
 *
 *   POSITION   Nothing stands closer to the centreline than TUNING.decor.standoff,
 *              which is comfortably past `read.decorClearance` from the road edge.
 *              `_part()` re-checks the true rotated X extent of every single box
 *              and shoves it outward if it would ever intrude, so no future emitter
 *              can quietly break the rule.
 *   HEIGHT     The road runs along a low causeway. Scenery stands on ground about
 *              two metres BELOW the lane, so the play surface reads as a raised
 *              ribbon and "you cannot drive there" needs no explaining.
 *   COLOUR     Every tint is pushed through `gfx.decorSaturation` (0.4) and
 *              `gfx.decorBrightness` (0.62). The source palette is already muted
 *              greys, sand and dusty blue, so what lands on screen is nearly
 *              monochrome and always darker than anything on the road.
 *   LIGHT      Decor receives shadow but never casts it. A tree throwing a shadow
 *              bar across the lane would be indistinguishable, at speed, from an
 *              object — and it would compete with the ground rings the outline
 *              system draws there.
 *   ABSENCE    It is not in the object list, so it can never be outlined, labelled,
 *              collided with, or absorbed. There is no physics body anywhere in
 *              this file.
 *
 * Everything is instanced into two meshes (box and cylinder) and streamed with a
 * pair of forward-only cursors, so the per-frame cost is proportional to what just
 * entered or left the window, not to the size of the track.
 */

const GEO_BOX = 0;
const GEO_CYL = 1;

/* Themes, in track order, plus the finale run-up. */
const T_RESIDENTIAL = 0;
const T_MARKET = 1;
const T_HIGHSTREET = 2;
const T_TRAFFIC = 3;
const T_FREIGHT = 4;
const T_INDUSTRIAL = 5;
const T_FINALE = 6;

/**
 * The scenery palette. Muted greys, sand and dusty blue only — and then
 * desaturated and darkened again on top. `foliage` is a grey-olive that lands on
 * screen as plain grey: saturated green belongs to the outline system.
 */
const PAL = {
  brick: 0x8d7a6c,
  plaster: 0xa39c92,
  slate: 0x5f666d,
  timber: 0x8a7a63,
  steel: 0x767d84,
  dark: 0x3b3f44,
  cloth: 0x9aa2a8,
  foliage: 0x6f7a63,
  glass: 0x7f95a4,
  concrete: 0x8f8d87,
  oxide: 0x7a6a5c,
  ground: 0x565049,
  bank: 0x4a453f,
};

/* ── module scratch: the per-frame path allocates nothing ────────────────────── */
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _pv = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _cv = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/* build-time scratch */
const _col = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };
const _bq = new THREE.Quaternion();
const _be = new THREE.Euler();
const _bv = new THREE.Vector3();
const _bm = new THREE.Matrix4();

/**
 * Desaturate and darken a palette colour into the scenery language.
 * Returns a shared THREE.Color in WORKING (linear) space — copy it immediately.
 */
function tinted(hex, shade) {
  _col.setHex(hex, THREE.SRGBColorSpace);
  _col.getHSL(_hsl, THREE.SRGBColorSpace);
  _col.setHSL(
    _hsl.h,
    _hsl.s * TUNING.gfx.decorSaturation,
    Math.min(0.96, _hsl.l * TUNING.gfx.decorBrightness * (shade === undefined ? 1 : shade)),
    THREE.SRGBColorSpace,
  );
  return _col;
}

export class Decor {
  constructor(scene) {
    this.scene = scene;
    const D = TUNING.decor;

    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, false);

    // One shared material. The instance colour carries the whole tint, so a white
    // base means `instanceColor * 1` and nothing has to be re-tinted at runtime.
    this.material = new THREE.MeshStandardNodeMaterial({
      color: 0xffffff, roughness: 0.94, metalness: 0.02,
    });

    this.boxMesh = this._makeInstanced(this.boxGeo, D.maxBoxInstances);
    this.cylMesh = this._makeInstanced(this.cylGeo, D.maxCylInstances);

    this.boxFree = new Int32Array(D.maxBoxInstances);
    this.cylFree = new Int32Array(D.maxCylInstances);
    this.boxFreeCount = 0;
    this.cylFreeCount = 0;
    this.boxHigh = 0;
    this.cylHigh = 0;
    this.boxDirty = false;
    this.cylDirty = false;

    // part arrays, sized at build()
    this.count = 0;
    this.dA = null;
    this.geoA = null;
    this.px = null; this.py = null; this.pz = null;
    this.sx = null; this.sy = null; this.sz = null;
    this.rx = null; this.ry = null; this.rz = null;
    this.cr = null; this.cg = null; this.cb = null;
    this.slot = null;

    this.lo = 0;
    this.hi = 0;
    this.rng = new Rng(0x5CE7E1);

    this._resetSlots();
  }

  _makeInstanced(geo, cap) {
    const im = new THREE.InstancedMesh(geo, this.material, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = false;      // scenery must never throw a bar across the lane
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.count = 0;
    for (let i = 0; i < cap; i++) im.setMatrixAt(i, _zero);
    _cv.setRGB(1, 1, 1);
    im.setColorAt(0, _cv);      // materialises the instanceColor buffer
    if (im.instanceColor) im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(im);
    return im;
  }

  _resetSlots() {
    const D = TUNING.decor;
    for (let i = 0; i < D.maxBoxInstances; i++) this.boxFree[i] = D.maxBoxInstances - 1 - i;
    for (let i = 0; i < D.maxCylInstances; i++) this.cylFree[i] = D.maxCylInstances - 1 - i;
    this.boxFreeCount = D.maxBoxInstances;
    this.cylFreeCount = D.maxCylInstances;
    for (let i = 0; i < this.boxHigh; i++) this.boxMesh.setMatrixAt(i, _zero);
    for (let i = 0; i < this.cylHigh; i++) this.cylMesh.setMatrixAt(i, _zero);
    this.boxHigh = 0;
    this.cylHigh = 0;
    this.boxMesh.count = 0;
    this.cylMesh.count = 0;
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.cylMesh.instanceMatrix.needsUpdate = true;
    this.boxDirty = false;
    this.cylDirty = false;
    this.lo = 0;
    this.hi = 0;
  }

  /* ── the track's own height curve, rebuilt from the plan ──────────────────── */

  _buildProfile(plan) {
    const segs = plan.segments;
    const n = segs.length;
    this.segStart = new Float64Array(n + 1);
    this.segY = new Float64Array(n + 1);
    this.segTan = new Float64Array(n === 0 ? 1 : n);
    let d = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.tan(segs[i].slopeDeg * DEG);
      this.segStart[i] = d;
      this.segY[i] = y;
      this.segTan[i] = t;
      d += segs[i].length;
      y -= t * segs[i].length;
    }
    this.segStart[n] = d;
    this.segY[n] = y;
    this.segCount = n;
    this.trackLength = d;
  }

  _segAt(d) {
    const n = this.segCount;
    if (n <= 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segStart[mid] <= d) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  _heightAt(d) {
    if (this.segCount <= 0) return 0;
    const i = this._segAt(d);
    return this.segY[i] - this.segTan[i] * (d - this.segStart[i]);
  }

  _slopeRadAt(d) {
    if (this.segCount <= 0) return 0;
    return Math.atan(this.segTan[this._segAt(d)]);
  }

  /* ── build ────────────────────────────────────────────────────────────────── */

  /** @param {object} plan the track plan; `plan.zones` supplies the theming */
  build(plan) {
    this._resetSlots();
    this.count = 0;
    if (!plan || !plan.segments || plan.segments.length === 0) return;

    this._buildProfile(plan);
    this.rng.reseed((plan.seed ^ 0x5CE7E1) >>> 0);
    this.plan = plan;

    const D = TUNING.decor;
    this.bankRad = D.bankAngleDeg * DEG;
    // How far the flat verge sits below the lane, and where it starts.
    this.groundDrop = D.bankWidth * Math.sin(this.bankRad);
    this.plainInner = ROAD_HALF + D.bankWidth * Math.cos(this.bankRad);

    const parts = [];
    this._out = parts;

    // ground first: the causeway the whole ramp runs along
    const step = D.vergeSlabLength;
    for (let d = 0; d < this.trackLength + step; d += step) {
      this._emitGround(d + step * 0.5, -1);
      this._emitGround(d + step * 0.5, 1);
    }

    // then the scenery itself, both sides, themed by zone
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      let d = 8 + this.rng.next() * 10;
      while (d < this.trackLength) {
        this._emitItem(this._themeAt(d), d, side);
        d += D.spacingMin + this.rng.next() * (D.spacingMax - D.spacingMin);
      }
    }

    parts.sort(sortByD);
    this._freeze(parts);
    this._out = null;
  }

  _themeAt(d) {
    const zones = this.plan.zones;
    if (!zones || zones.length === 0) return T_RESIDENTIAL;
    for (let i = 0; i < zones.length; i++) {
      if (d < zones[i].dEnd) return i;
    }
    return T_FINALE;
  }

  _freeze(parts) {
    const n = parts.length;
    this.count = n;
    this.dA = new Float32Array(n);
    this.geoA = new Uint8Array(n);
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.sz = new Float32Array(n);
    this.rx = new Float32Array(n); this.ry = new Float32Array(n); this.rz = new Float32Array(n);
    this.cr = new Float32Array(n); this.cg = new Float32Array(n); this.cb = new Float32Array(n);
    this.slot = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      this.dA[i] = p.d; this.geoA[i] = p.geo;
      this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z;
      this.sx[i] = p.sx; this.sy[i] = p.sy; this.sz[i] = p.sz;
      this.rx[i] = p.rx; this.ry[i] = p.ry; this.rz[i] = p.rz;
      this.cr[i] = p.r; this.cg[i] = p.g; this.cb[i] = p.b;
    }
  }

  /* ── emitters ─────────────────────────────────────────────────────────────── */

  _push(d, geo, x, y, z, sx, sy, sz, rx, ry, rz, hex, shade) {
    const c = tinted(hex, shade);
    this._out.push({
      d, geo, x, y, z, sx, sy, sz, rx, ry, rz, r: c.r, g: c.g, b: c.b,
    });
  }

  /**
   * A scenery part, with the lane-clearance rule enforced on the way in.
   *
   * The X half-extent is computed from the part's ACTUAL rotated footprint, so a
   * 12 m container lying along the road is not shoved 6 m outward for a width it
   * does not have, and a yawed building still cannot poke a corner into the
   * clearance band. This is the backstop that makes the rule structural rather
   * than a convention every future emitter has to remember.
   */
  _part(d, geo, x, y, z, sx, sy, sz, rx, ry, rz, hex, shade) {
    const limit = ROAD_HALF + TUNING.read.decorClearance;
    // Exact X half-extent of the rotated box: the first ROW of the rotation
    // matrix dotted with the half-sizes. Covers yaw, pitch and roll together,
    // rather than assuming a part is only ever turned about Y.
    _be.set(rx || 0, ry || 0, rz || 0);
    _bq.setFromEuler(_be);
    _bm.makeRotationFromQuaternion(_bq);
    const e = _bm.elements;
    const halfX = 0.5 * (Math.abs(e[0]) * sx + Math.abs(e[4]) * sy + Math.abs(e[8]) * sz);
    let px = x;
    if (px >= 0) {
      if (px - halfX < limit) px = limit + halfX;
    } else if (px + halfX > -limit) {
      px = -limit - halfX;
    }
    this._push(d, geo, px, y, z, sx, sy, sz, rx || 0, ry || 0, rz || 0, hex, shade);
  }

  /**
   * The causeway: a sloped embankment glued to the road edge, and the flat ground
   * beyond it that every scenery item stands on.
   *
   * The embankment's inner-top corner is pinned exactly to the road edge at road
   * height, computed through the same rotation the slab gets, so there is no gap
   * and no overlap however steep the ramp is at that point. Ground is exempt from
   * the clearance clamp — it is terrain, it sits below the lane, and it is what
   * makes the drop off the shoulder legible in the first place.
   */
  _emitGround(dMid, side) {
    const D = TUNING.decor;
    if (dMid > this.trackLength + D.vergeSlabLength) return;
    const len = D.vergeSlabLength * 1.02;
    const roadY = this._heightAt(dMid);
    const pitch = -this._slopeRadAt(dMid);   // +Z must descend with the ramp
    const bank = -side * this.bankRad;

    // embankment
    const bt = 2.6;
    _be.set(pitch, 0, bank);
    _bq.setFromEuler(_be);
    _bv.set(-side * D.bankWidth * 0.5, bt * 0.5, 0).applyQuaternion(_bq);
    this._push(dMid, GEO_BOX,
      side * ROAD_HALF - _bv.x, roadY - _bv.y, -dMid - _bv.z,
      D.bankWidth, bt, len, pitch, 0, bank, PAL.bank, 0.9);

    // the flat verge beyond it
    const pt = 3.2;
    _be.set(pitch, 0, 0);
    _bq.setFromEuler(_be);
    _bv.set(0, pt * 0.5, 0).applyQuaternion(_bq);
    this._push(dMid, GEO_BOX,
      side * (this.plainInner + D.vergeWidth * 0.5) - _bv.x,
      roadY - this.groundDrop - _bv.y,
      -dMid - _bv.z,
      D.vergeWidth, pt, len, pitch, 0, 0, PAL.ground, 1.0);
  }

  /** Place one themed scenery item on the verge. */
  _emitItem(theme, d, side) {
    const rng = this.rng;
    const kind = Math.floor(rng.next() * 4) % 4;
    const baseY = this._heightAt(d) - this.groundDrop;
    const z = -d;
    const yaw = (rng.next() - 0.5) * 0.5;
    switch (theme) {
      case T_RESIDENTIAL: this._residential(kind, d, side, baseY, z, yaw); break;
      case T_MARKET: this._market(kind, d, side, baseY, z, yaw); break;
      case T_HIGHSTREET: this._highStreet(kind, d, side, baseY, z, yaw); break;
      case T_TRAFFIC: this._traffic(kind, d, side, baseY, z, yaw); break;
      case T_FREIGHT: this._freight(kind, d, side, baseY, z, yaw); break;
      case T_INDUSTRIAL: this._industrial(kind, d, side, baseY, z, yaw); break;
      default: this._finale(kind, d, side, baseY, z, yaw); break;
    }
  }

  /** Outward X of an item whose footprint is `halfW` wide. */
  _ox(side, halfW) {
    return side * (TUNING.decor.standoff + halfW + this.rng.next() * TUNING.decor.sideJitter);
  }

  _residential(kind, d, side, y, z, yaw) {
    const rng = this.rng;
    if (kind === 0) {
      const w = 9 + rng.next() * 4;
      const h = 5 + rng.next() * 3;
      const dp = 8 + rng.next() * 3;
      const x = this._ox(side, w * 0.5 + 0.8);
      const sh = 0.85 + rng.next() * 0.3;
      this._part(d, GEO_BOX, x, y + h * 0.5, z, w, h, dp, 0, yaw, 0, PAL.plaster, sh);
      this._part(d, GEO_BOX, x, y + h + 0.7, z, w + 1.2, 1.4, dp + 1.2, 0, yaw, 0, PAL.slate, sh);
      this._part(d, GEO_CYL, x + w * 0.28, y + h + 2.1, z - dp * 0.2, 0.9, 2.4, 0.9, 0, 0, 0, PAL.brick, sh);
    } else if (kind === 1) {
      const x = this._ox(side, 2.4);
      const t = 3.0 + rng.next() * 1.6;
      this._part(d, GEO_CYL, x, y + t * 0.5, z, 0.55, t, 0.55, 0, 0, 0, PAL.timber, 0.9);
      this._part(d, GEO_BOX, x, y + t + 1.5, z, 4.2, 3.4, 4.2, 0, 0.6, 0, PAL.foliage, 1.0);
      this._part(d, GEO_BOX, x + 0.5, y + t + 3.1, z - 0.3, 2.8, 2.4, 2.8, 0, 1.2, 0, PAL.foliage, 0.85);
    } else if (kind === 2) {
      const x = this._ox(side, 3.6);
      this._part(d, GEO_BOX, x, y + 0.75, z, 7.0, 1.5, 1.6, 0, yaw, 0, PAL.foliage, 0.9);
      for (let i = 0; i < 3; i++) {
        this._part(d, GEO_BOX, x - 2.6 + i * 2.6, y + 0.6, z + 1.6, 0.16, 1.2, 0.16, 0, 0, 0, PAL.timber, 1);
      }
    } else {
      const x = this._ox(side, 1.2);
      this._part(d, GEO_CYL, x, y + 3.6, z, 0.28, 7.2, 0.28, 0, 0, 0, PAL.steel, 0.9);
      this._part(d, GEO_BOX, x - side * 0.6, y + 7.25, z, 1.5, 0.34, 0.5, 0, 0, 0, PAL.dark, 1);
    }
  }

  _market(kind, d, side, y, z, yaw) {
    const rng = this.rng;
    if (kind === 0) {
      const x = this._ox(side, 3.0);
      this._part(d, GEO_BOX, x, y + 0.55, z, 5.0, 1.1, 2.4, 0, yaw, 0, PAL.timber, 1);
      this._part(d, GEO_BOX, x, y + 2.6, z + 0.2, 5.6, 0.24, 3.0, -0.22, yaw, 0, PAL.cloth, 1);
      this._part(d, GEO_CYL, x - 2.3, y + 1.25, z - 1.0, 0.18, 2.5, 0.18, 0, 0, 0, PAL.steel, 1);
      this._part(d, GEO_CYL, x + 2.3, y + 1.25, z - 1.0, 0.18, 2.5, 0.18, 0, 0, 0, PAL.steel, 1);
    } else if (kind === 1) {
      const x = this._ox(side, 1.8);
      for (let i = 0; i < 3; i++) {
        const s = 1.5 - i * 0.18;
        this._part(d, GEO_BOX, x + (rng.next() - 0.5) * 0.5, y + 0.45 + i * 0.95, z + (rng.next() - 0.5) * 0.5,
          s, 0.9, s, 0, rng.next(), 0, PAL.timber, 0.9 + i * 0.08);
      }
    } else if (kind === 2) {
      const x = this._ox(side, 1.3);
      this._part(d, GEO_CYL, x, y + 4.0, z, 0.3, 8.0, 0.3, 0, 0, 0, PAL.steel, 0.9);
      this._part(d, GEO_BOX, x + side * 0.5, y + 5.6, z, 0.18, 3.8, 1.7, 0, 0, 0, PAL.cloth, 1);
    } else {
      const w = 7 + rng.next() * 3;
      const h = 4.5 + rng.next() * 2;
      const x = this._ox(side, w * 0.5 + 0.5);
      this._part(d, GEO_BOX, x, y + h * 0.5, z, w, h, 7.0, 0, yaw, 0, PAL.plaster, 0.9);
      this._part(d, GEO_BOX, x, y + h + 0.5, z, w + 0.6, 1.0, 7.4, 0, yaw, 0, PAL.dark, 1);
    }
  }

  _highStreet(kind, d, side, y, z, yaw) {
    const rng = this.rng;
    if (kind === 0) {
      const w = 10 + rng.next() * 4;
      const h = 9 + rng.next() * 5;
      const dp = 9 + rng.next() * 3;
      const x = this._ox(side, w * 0.5 + 0.6);
      const sh = 0.8 + rng.next() * 0.35;
      this._part(d, GEO_BOX, x, y + h * 0.5, z, w, h, dp, 0, yaw, 0, PAL.plaster, sh);
      this._part(d, GEO_BOX, x, y + h + 0.55, z, w + 0.8, 1.1, dp + 0.8, 0, yaw, 0, PAL.dark, 1);
      this._part(d, GEO_BOX, x - side * (dp * 0.02), y + 2.6, z + dp * 0.5, w * 0.8, 2.0, 0.3,
        0, yaw, 0, PAL.glass, 1);
    } else if (kind === 1) {
      const x = this._ox(side, 2.4);
      this._part(d, GEO_CYL, x, y + 4.5, z, 0.3, 9.0, 0.3, 0, 0, 0, PAL.steel, 0.9);
      this._part(d, GEO_BOX, x - side * 1.1, y + 8.95, z, 2.6, 0.28, 0.4, 0, 0, 0, PAL.steel, 0.9);
      this._part(d, GEO_BOX, x - side * 2.1, y + 8.75, z, 1.0, 0.42, 0.6, 0, 0, 0, PAL.dark, 1);
    } else if (kind === 2) {
      const x = this._ox(side, 2.8);
      this._part(d, GEO_BOX, x, y + 2.9, z, 5.0, 0.3, 2.4, 0, yaw, 0, PAL.dark, 1);
      this._part(d, GEO_BOX, x, y + 1.6, z - 1.0, 5.0, 2.2, 0.18, 0, yaw, 0, PAL.glass, 1);
      this._part(d, GEO_CYL, x - 2.2, y + 1.45, z + 1.0, 0.16, 2.9, 0.16, 0, 0, 0, PAL.steel, 1);
      this._part(d, GEO_CYL, x + 2.2, y + 1.45, z + 1.0, 0.16, 2.9, 0.16, 0, 0, 0, PAL.steel, 1);
    } else {
      const x = this._ox(side, 2.6);
      this._part(d, GEO_CYL, x, y + 0.75, z, 1.1, 1.5, 1.1, 0, 0, 0, PAL.dark, 1);
      for (let i = 0; i < 3; i++) {
        this._part(d, GEO_CYL, x - 2.0 + i * 2.0, y + 0.5, z + 2.2, 0.3, 1.0, 0.3, 0, 0, 0, PAL.steel, 0.9);
      }
    }
  }

  _traffic(kind, d, side, y, z, yaw) {
    const rng = this.rng;
    const QZ = Math.PI / 2;
    if (kind === 0) {
      const x = this._ox(side, 2.5);
      const sh = 0.8 + rng.next() * 0.4;
      this._part(d, GEO_BOX, x, y + 0.85, z, 2.0, 1.0, 4.6, 0, yaw, 0, PAL.plaster, sh);
      this._part(d, GEO_BOX, x, y + 1.7, z + 0.2, 1.8, 0.8, 2.2, 0, yaw, 0, PAL.glass, sh);
      this._part(d, GEO_CYL, x, y + 0.35, z - 1.5, 0.7, 2.0, 0.7, 0, 0, QZ, PAL.dark, 1);
      this._part(d, GEO_CYL, x, y + 0.35, z + 1.5, 0.7, 2.0, 0.7, 0, 0, QZ, PAL.dark, 1);
    } else if (kind === 1) {
      const x = this._ox(side, 1.1);
      this._part(d, GEO_CYL, x, y + 3.25, z, 0.3, 6.5, 0.3, 0, 0, 0, PAL.steel, 0.85);
      this._part(d, GEO_BOX, x - side * 0.25, y + 6.6, z, 0.7, 2.0, 0.6, 0, 0, 0, PAL.dark, 1);
    } else if (kind === 2) {
      const x = this._ox(side, 3.9);
      this._part(d, GEO_CYL, x - 2.6, y + 3.5, z, 0.4, 7.0, 0.4, 0, 0, 0, PAL.steel, 0.85);
      this._part(d, GEO_CYL, x + 2.6, y + 3.5, z, 0.4, 7.0, 0.4, 0, 0, 0, PAL.steel, 0.85);
      this._part(d, GEO_BOX, x, y + 7.6, z, 7.4, 2.6, 0.3, 0, 0, 0, PAL.plaster, 1);
    } else {
      const x = this._ox(side, 6.4);
      this._part(d, GEO_BOX, x, y + 0.95, z, 0.28, 0.5, 12.0, 0, 0, 0, PAL.steel, 1);
      for (let i = 0; i < 4; i++) {
        this._part(d, GEO_CYL, x, y + 0.5, z - 4.5 + i * 3.0, 0.22, 1.0, 0.22, 0, 0, 0, PAL.steel, 0.85);
      }
    }
  }

  _freight(kind, d, side, y, z, yaw) {
    const rng = this.rng;
    if (kind === 0) {
      const x = this._ox(side, 1.8);
      const len = 10 + rng.next() * 4;
      this._part(d, GEO_BOX, x, y + 1.4, z, 2.6, 2.8, len, 0, 0, 0, PAL.oxide, 0.85 + rng.next() * 0.3);
      if (rng.next() < 0.7) {
        this._part(d, GEO_BOX, x + side * 0.35, y + 4.25, z + (rng.next() - 0.5) * 2.0,
          2.6, 2.8, len * 0.9, 0, 0, 0, PAL.steel, 0.85 + rng.next() * 0.3);
      }
    } else if (kind === 1) {
      const x = this._ox(side, 1.5);
      for (let i = 0; i < 4; i++) {
        this._part(d, GEO_BOX, x, y + 0.2 + i * 0.4, z, 2.4, 0.34, 2.4, 0, i * 0.12, 0, PAL.timber, 0.95);
      }
    } else if (kind === 2) {
      const x = this._ox(side, 4.8);
      this._part(d, GEO_CYL, x - 4.0, y + 5.5, z, 0.6, 11.0, 0.6, 0, 0, 0, PAL.steel, 0.85);
      this._part(d, GEO_CYL, x + 4.0, y + 5.5, z, 0.6, 11.0, 0.6, 0, 0, 0, PAL.steel, 0.85);
      this._part(d, GEO_BOX, x, y + 11.4, z, 10.0, 0.9, 1.3, 0, 0, 0, PAL.steel, 0.9);
    } else {
      const x = this._ox(side, 1.8);
      this._part(d, GEO_CYL, x, y + 8.0, z, 0.5, 16.0, 0.5, 0, 0, 0, PAL.steel, 0.8);
      this._part(d, GEO_BOX, x - side * 0.6, y + 16.2, z, 3.2, 0.8, 0.9, 0, 0, 0, PAL.dark, 1);
    }
  }

  _industrial(kind, d, side, y, z, yaw) {
    const rng = this.rng;
    if (kind === 0) {
      const r = 3.0 + rng.next() * 1.6;
      const h = 13 + rng.next() * 6;
      const x = this._ox(side, r + 0.6);
      this._part(d, GEO_CYL, x, y + h * 0.5, z, r * 2, h, r * 2, 0, 0, 0, PAL.concrete, 0.9);
      this._part(d, GEO_CYL, x, y + h + 0.7, z, r * 1.75, 1.4, r * 1.75, 0, 0, 0, PAL.steel, 0.9);
    } else if (kind === 1) {
      const h = 20 + rng.next() * 9;
      const x = this._ox(side, 2.0);
      this._part(d, GEO_CYL, x, y + h * 0.5, z, 3.2, h, 3.2, 0, 0, 0, PAL.brick, 0.85);
      this._part(d, GEO_CYL, x, y + h * 0.86, z, 3.7, 0.9, 3.7, 0, 0, 0, PAL.dark, 1);
    } else if (kind === 2) {
      const w = 15 + rng.next() * 8;
      const h = 8 + rng.next() * 4;
      const x = this._ox(side, w * 0.5 + 0.8);
      this._part(d, GEO_BOX, x, y + h * 0.5, z, w, h, 14.0, 0, yaw * 0.4, 0, PAL.plaster, 0.85);
      this._part(d, GEO_BOX, x, y + h + 0.55, z, w + 1.2, 1.1, 15.0, 0, yaw * 0.4, 0, PAL.slate, 0.9);
    } else {
      const x = this._ox(side, 3.8);
      this._part(d, GEO_CYL, x - 3.0, y + 2.6, z, 0.5, 5.2, 0.5, 0, 0, 0, PAL.steel, 0.85);
      this._part(d, GEO_CYL, x + 3.0, y + 2.6, z, 0.5, 5.2, 0.5, 0, 0, 0, PAL.steel, 0.85);
      for (let i = 0; i < 3; i++) {
        this._part(d, GEO_CYL, x, y + 4.1 + i * 0.75, z, 0.6, 14.0, 0.6,
          Math.PI / 2, 0, 0, PAL.oxide, 0.9);
      }
    }
  }

  /**
   * The finale run-up. No buildings: floodlights, stands and crowd barriers, so
   * the last 430 m read as an arena closing in around the house.
   */
  _finale(kind, d, side, y, z, yaw) {
    const rng = this.rng;
    if (kind === 0 || kind === 3) {
      const x = this._ox(side, 5.4);
      this._part(d, GEO_BOX, x, y + 0.95, z, 0.14, 0.14, 10.0, 0, 0, 0, PAL.steel, 1.05);
      this._part(d, GEO_BOX, x, y + 1.25, z, 0.14, 0.14, 10.0, 0, 0, 0, PAL.steel, 1.05);
      for (let i = 0; i < 4; i++) {
        this._part(d, GEO_CYL, x, y + 0.65, z - 3.6 + i * 2.4, 0.16, 1.3, 0.16, 0, 0, 0, PAL.dark, 1);
      }
    } else if (kind === 1) {
      const x = this._ox(side, 2.2);
      this._part(d, GEO_CYL, x, y + 10.0, z, 0.55, 20.0, 0.55, 0, 0, 0, PAL.steel, 0.8);
      this._part(d, GEO_BOX, x - side * 1.0, y + 20.3, z, 4.0, 1.0, 1.0, 0, 0, 0, PAL.dark, 1);
    } else {
      const x = this._ox(side, 7.4);
      for (let i = 0; i < 3; i++) {
        this._part(d, GEO_BOX, x + side * i * 1.6, y + 0.6 + i * 1.2, z, 14.0, 1.2, 3.0,
          0, 0, 0, PAL.concrete, 0.85 + i * 0.06);
      }
      if (rng.next() < 0.5) {
        this._part(d, GEO_BOX, x, y + 4.6, z, 3.0, 2.6, 3.0, 0, yaw, 0, PAL.plaster, 0.9);
      }
    }
  }

  /* ── streaming ────────────────────────────────────────────────────────────── */

  /**
   * Move the window. Two forward-only cursors, so the work each frame is exactly
   * the parts that just entered or left — never a scan of the whole track.
   */
  update(playerD) {
    if (this.count === 0) return;
    const D = TUNING.decor;
    const ahead = playerD + D.aheadMetres;
    const behind = playerD - D.behindMetres;

    while (this.hi < this.count && this.dA[this.hi] <= ahead) {
      this._show(this.hi);
      this.hi++;
    }
    while (this.lo < this.hi && this.dA[this.lo] < behind) {
      this._hide(this.lo);
      this.lo++;
    }

    if (this.boxDirty) {
      this.boxMesh.count = this.boxHigh;
      this.boxMesh.instanceMatrix.needsUpdate = true;
      if (this.boxMesh.instanceColor) this.boxMesh.instanceColor.needsUpdate = true;
      this.boxDirty = false;
    }
    if (this.cylDirty) {
      this.cylMesh.count = this.cylHigh;
      this.cylMesh.instanceMatrix.needsUpdate = true;
      if (this.cylMesh.instanceColor) this.cylMesh.instanceColor.needsUpdate = true;
      this.cylDirty = false;
    }
  }

  _show(i) {
    const isBox = this.geoA[i] === GEO_BOX;
    let s;
    if (isBox) {
      if (this.boxFreeCount === 0) { this.slot[i] = -1; return; }
      s = this.boxFree[--this.boxFreeCount];
      if (s + 1 > this.boxHigh) this.boxHigh = s + 1;
      this.boxDirty = true;
    } else {
      if (this.cylFreeCount === 0) { this.slot[i] = -1; return; }
      s = this.cylFree[--this.cylFreeCount];
      if (s + 1 > this.cylHigh) this.cylHigh = s + 1;
      this.cylDirty = true;
    }
    this.slot[i] = s;
    const mesh = isBox ? this.boxMesh : this.cylMesh;
    _pv.set(this.px[i], this.py[i], this.pz[i]);
    _e.set(this.rx[i], this.ry[i], this.rz[i]);
    _q.setFromEuler(_e);
    _sv.set(this.sx[i], this.sy[i], this.sz[i]);
    _m.compose(_pv, _q, _sv);
    mesh.setMatrixAt(s, _m);
    // Written straight through: these are already working-space values, and
    // setColorAt does no conversion of its own.
    _cv.r = this.cr[i]; _cv.g = this.cg[i]; _cv.b = this.cb[i];
    mesh.setColorAt(s, _cv);
  }

  _hide(i) {
    const s = this.slot[i];
    if (s < 0) return;
    this.slot[i] = -1;
    if (this.geoA[i] === GEO_BOX) {
      this.boxMesh.setMatrixAt(s, _zero);
      this.boxFree[this.boxFreeCount++] = s;
      this.boxDirty = true;
    } else {
      this.cylMesh.setMatrixAt(s, _zero);
      this.cylFree[this.cylFreeCount++] = s;
      this.cylDirty = true;
    }
  }

  /* ── lifecycle ────────────────────────────────────────────────────────────── */

  reset() {
    if (this.slot) this.slot.fill(-1);
    this._resetSlots();
  }

  dispose() {
    this.scene.remove(this.boxMesh);
    this.scene.remove(this.cylMesh);
    this.boxMesh.dispose();
    this.cylMesh.dispose();
    this.boxGeo.dispose();
    this.cylGeo.dispose();
    this.material.dispose();
    this.count = 0;
  }
}

function sortByD(a, b) {
  return a.d - b.d;
}
