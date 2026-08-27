/**
 * TONNAGE — debris fragments.
 *
 * A pooled ballistic integrator. No Rapier: fragments are points with a box
 * scale, integrated with gravity + drag + spin, bounced off the road surface via
 * the injected `groundY(x, z)` probe (which returns `-Infinity` over a hole, so
 * debris there falls forever and despawns far below).
 *
 * Rendering is one `InstancedMesh` per material key from `MATERIALS`, all sharing
 * a single unit `BoxGeometry`; the per-fragment non-uniform scale is baked into
 * the instance matrix. After `TUNING.destruction.fragmentLifePhysics` seconds a
 * fragment freezes and shrinks to nothing over `fragmentLifeFade` while sinking
 * slightly — deliberately a shrink rather than an alpha fade, so the whole pass
 * stays opaque and needs no sorting.
 *
 * The pool is a `RingPool` capped at `TUNING.destruction.maxFragments`; a spawn
 * that overflows steals the oldest fragments. Nothing allocates after
 * construction, and `update()` sets exactly one `needsUpdate` per material mesh.
 */

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';

import { TUNING } from '../tuning.js';
import { fxRng } from '../core/rng.js';
import { RingPool } from '../core/pool.js';
import { MATERIALS } from '../world/objects.js';

/* ─────────────────────────────────────────────────────── material resolution */

/** Key of the neutral grey mesh used when a fragment names an unknown material. */
const FALLBACK_KEY = '__fallback';

/**
 * Purely internal appearance table for the fallback. Not a balance number, so it
 * lives here rather than in TUNING (see contract rule 1).
 */
const FALLBACK_MATERIAL = {
  color: 0x8b9096,
  roughness: 0.85,
  metalness: 0.0,
  emissive: 0x000000,
};

/** Keys discovered from MATERIALS at module load — never a hardcoded list. */
const MAT_KEYS = (() => {
  const out = [];
  const src = MATERIALS;
  if (src && typeof src === 'object') {
    for (const k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out.push(k);
    }
  }
  return out;
})();

/**
 * Material keys this system builds InstancedMeshes for. Covers every key present
 * in `MATERIALS` at load time. (An extra hidden neutral-grey mesh backs unknown
 * keys at runtime; it is not listed here because it is not a world material.)
 * @returns {string[]}
 */
export function fragmentMaterialKeys() {
  return MAT_KEYS.slice();
}

/* ──────────────────────────────────────────────── module scratch (no allocs) */

const _color = new Color();

/** Result of `quatRotate`. */
let _rvx = 0;
let _rvy = 0;
let _rvz = 0;

/** Rotate (vx,vy,vz) by the unit quaternion (qx,qy,qz,qw). */
function quatRotate(qx, qy, qz, qw, vx, vy, vz) {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  _rvx = vx + qw * tx + (qy * tz - qz * ty);
  _rvy = vy + qw * ty + (qz * tx - qx * tz);
  _rvz = vz + qw * tz + (qx * ty - qy * tx);
}

/** Default ground probe: nothing to land on. */
function noGround() {
  return -Infinity;
}

/** Pool factory — the pool only hands out indices. */
const ZERO_SLOT = () => 0;

/** Phase flags. */
const PHASE_PHYSICS = 0;
const PHASE_FADE = 1;

export class FragmentSystem {
  /**
   * @param {import('three/webgpu').Scene} scene
   * @param {(x:number, z:number)=>number} groundY surface Y, or -Infinity in a hole.
   *   Called as a bare function in the hot loop, so pass a closure or a bound
   *   method — never an unbound `obj.method` reference.
   */
  constructor(scene, groundY) {
    const D = TUNING.destruction;
    const cap = Math.max(1, D.maxFragments | 0);

    this.scene = scene;
    this.groundY = typeof groundY === 'function' ? groundY : noGround;
    this.capacity = cap;
    this._disposed = false;

    this.pool = new RingPool(cap, ZERO_SLOT);

    // ── struct-of-arrays fragment state
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.qx = new Float32Array(cap);
    this.qy = new Float32Array(cap);
    this.qz = new Float32Array(cap);
    this.qw = new Float32Array(cap);
    this.wx = new Float32Array(cap);
    this.wy = new Float32Array(cap);
    this.wz = new Float32Array(cap);
    this.sx = new Float32Array(cap);
    this.sy = new Float32Array(cap);
    this.sz = new Float32Array(cap);
    this.radius = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.deathY = new Float32Array(cap);
    this.matIdx = new Int32Array(cap);
    this.phase = new Uint8Array(cap);
    this.asleep = new Uint8Array(cap);
    /** 1 while there is no surface under the fragment (it is over a hole). */
    this.hole = new Uint8Array(cap);

    // ── one InstancedMesh per material key (+ the fallback)
    this.geometry = new BoxGeometry(1, 1, 1);

    /** @type {string[]} render order matches `meshes` / `_counts`. */
    this.keys = MAT_KEYS.slice();
    this.keys.push(FALLBACK_KEY);
    this.fallbackIndex = this.keys.length - 1;

    /** key → index. Null-prototype so odd keys ('constructor') cannot collide. */
    this.index = Object.create(null);
    for (let i = 0; i < this.keys.length; i++) this.index[this.keys[i]] = i;

    this.materials = new Array(this.keys.length);
    this.meshes = new Array(this.keys.length);
    this._matArrays = new Array(this.keys.length);
    this._counts = new Int32Array(this.keys.length);
    /** Last frame's counts, so an idle mesh does not re-upload its whole buffer. */
    this._prevCounts = new Int32Array(this.keys.length);

    const castShadow = D.fragmentCastShadow !== false;

    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i];
      const def = (i === this.fallbackIndex || !MATERIALS || !MATERIALS[key])
        ? FALLBACK_MATERIAL
        : MATERIALS[key];

      const mat = new MeshStandardNodeMaterial();
      _color.setHex(def.color !== undefined ? def.color : FALLBACK_MATERIAL.color);
      mat.color.copy(_color);
      mat.roughness = def.roughness !== undefined ? def.roughness : 0.85;
      mat.metalness = def.metalness !== undefined ? def.metalness : 0.0;
      if (def.emissive !== undefined) {
        _color.setHex(def.emissive);
        mat.emissive.copy(_color);
      }
      // Debris stays opaque on purpose: the shrink-out keeps the pass sort-free,
      // so a translucent source material is rendered solid here.
      mat.transparent = false;
      mat.opacity = 1;
      mat.flatShading = true;

      const mesh = new InstancedMesh(this.geometry, mat, cap);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();

      this.materials[i] = mat;
      this.meshes[i] = mesh;
      this._matArrays[i] = mesh.instanceMatrix.array;
      if (scene) scene.add(mesh);
    }
  }

  get activeCount() {
    return this.pool.activeCount;
  }

  /* ──────────────────────────────────────────────────────────────── spawning */

  /**
   * Spawn one object's worth of debris.
   *
   * @param {{fracture?:Array, material?:string}} def PropDef from world/objects.js
   * @param {number} px object origin X
   * @param {number} py object origin Y (y=0 of the local fracture space)
   * @param {number} pz object origin Z
   * @param {number} qx object quaternion
   * @param {number} qy
   * @param {number} qz
   * @param {number} qw
   * @param {number} ix impact point X
   * @param {number} iy impact point Y
   * @param {number} iz impact point Z
   * @param {number} vx player velocity X
   * @param {number} vy player velocity Y
   * @param {number} vz player velocity Z
   * @param {string} outcome 'PULVERIZE' | 'PLOW' | 'BLOCKED'
   */
  spawn(def, px, py, pz, qx, qy, qz, qw, ix, iy, iz, vx, vy, vz, outcome) {
    if (this._disposed || !def) return;
    const parts = def.fracture;
    if (!parts || parts.length === 0) return;

    const D = TUNING.destruction;

    // normalise the incoming quaternion defensively (a zero quat would collapse
    // every fragment onto the origin)
    let ox = qx || 0, oy = qy || 0, oz = qz || 0, ow = qw === undefined ? 1 : qw;
    const ql = Math.sqrt(ox * ox + oy * oy + oz * oz + ow * ow);
    if (ql < 1e-6) { ox = 0; oy = 0; oz = 0; ow = 1; } else {
      const inv = 1 / ql;
      ox *= inv; oy *= inv; oz *= inv; ow *= inv;
    }

    const soft = outcome === 'PULVERIZE' ? 1 : D.plowImpulseScale;
    const velShare = D.impulsePlayerVelShare * soft;
    const impulse = D.impulseBase * soft;
    const up = D.upBias * soft;
    const jitter = D.impulseJitter * soft;
    const spin = D.fragmentSpin;
    const falloff = D.impulseFalloff > 1e-3 ? D.impulseFalloff : 1e-3;
    const scaleJit = D.fragmentScaleJitter;
    const minScale = D.fragmentMinScale;
    const fallDepth = TUNING.world.fallY;

    const fallbackKey = def.material;
    const n = Math.min(parts.length, D.fragmentMaxPerSpawn | 0 || parts.length);

    for (let k = 0; k < n; k++) {
      const part = parts[k];
      if (!part) continue;

      const lp = part.pos;
      const ls = part.scale;
      const lx = lp ? lp[0] : 0;
      const ly = lp ? lp[1] : 0;
      const lz = lp ? lp[2] : 0;

      quatRotate(ox, oy, oz, ow, lx, ly, lz);
      const wx = px + _rvx;
      const wy = py + _rvy;
      const wz = pz + _rvz;

      const i = this.pool.acquire();
      if (i < 0) return;

      // scale (with a touch of jitter so a tiled fracture does not read as a grid)
      const jx = 1 + fxRng.spread(scaleJit);
      const jy = 1 + fxRng.spread(scaleJit);
      const jz = 1 + fxRng.spread(scaleJit);
      const fsx = Math.max(minScale, (ls ? ls[0] : 0.4) * jx);
      const fsy = Math.max(minScale, (ls ? ls[1] : 0.4) * jy);
      const fsz = Math.max(minScale, (ls ? ls[2] : 0.4) * jz);

      this.px[i] = wx; this.py[i] = wy; this.pz[i] = wz;
      this.sx[i] = fsx; this.sy[i] = fsy; this.sz[i] = fsz;
      this.radius[i] = 0.5 * Math.min(fsx, Math.min(fsy, fsz));

      // radial impulse away from the impact point, strongest close in
      let dx = wx - ix;
      let dy = wy - iy;
      let dz = wz - iz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-4) {
        // degenerate: shove it somewhere sensible
        dx = fxRng.spread(1); dy = 1; dz = fxRng.spread(1);
        const l2 = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= l2; dy /= l2; dz /= l2;
      } else {
        const inv = 1 / dist;
        dx *= inv; dy *= inv; dz *= inv;
      }
      const f = falloff / (falloff + dist);
      const push = impulse * (0.45 + f);

      this.vx[i] = dx * push + vx * velShare + fxRng.spread(jitter);
      this.vy[i] = dy * push + vy * velShare + up + fxRng.spread(jitter * 0.5);
      this.vz[i] = dz * push + vz * velShare + fxRng.spread(jitter);

      this.qx[i] = ox; this.qy[i] = oy; this.qz[i] = oz; this.qw[i] = ow;
      this.wx[i] = fxRng.spread(spin);
      this.wy[i] = fxRng.spread(spin);
      this.wz[i] = fxRng.spread(spin);

      this.age[i] = 0;
      this.phase[i] = PHASE_PHYSICS;
      this.asleep[i] = 0;
      this.hole[i] = 0;
      this.deathY[i] = wy + fallDepth;

      const key = part.material || fallbackKey;
      const mi = key === undefined ? undefined : this.index[key];
      this.matIdx[i] = mi === undefined ? this.fallbackIndex : mi;
    }
  }

  /* ─────────────────────────────────────────────────────────────── per-frame */

  /** @param {number} dt seconds */
  update(dt) {
    if (this._disposed) return;
    if (!(dt > 0)) dt = 0;

    const D = TUNING.destruction;
    const pool = this.pool;
    const act = pool.active;
    const counts = this._counts;
    const arrays = this._matArrays;
    const probe = this.groundY;

    counts.fill(0);

    const grav = D.fragmentGravity;
    const drag = D.fragmentDrag;
    const angDrag = D.fragmentAngularDrag;
    const rest = D.fragmentRestitution;
    const fric = D.fragmentFriction;
    const sleepSpeed = D.fragmentSleepSpeed;
    const tPhys = D.fragmentLifePhysics;
    const tFade = D.fragmentLifeFade > 1e-4 ? D.fragmentLifeFade : 1e-4;
    const sink = D.fragmentSink;

    const linDamp = 1 / (1 + drag * dt);
    const angDamp = 1 / (1 + angDrag * dt);

    for (let a = pool.activeCount - 1; a >= 0; a--) {
      const i = act[a];

      const age = this.age[i] + dt;
      this.age[i] = age;

      let x = this.px[i];
      let y = this.py[i];
      let z = this.pz[i];
      let sxi = this.sx[i];
      let syi = this.sy[i];
      let szi = this.sz[i];

      // A fragment still falling through a hole keeps simulating past the physics
      // window — freezing it in mid-air over a chasm would read as a bug — and
      // simply despawns once it is far enough below the road.
      if (age >= tPhys && this.hole[i] === 0) {
        // ── frozen: shrink + sink out, then die
        const ft = (age - tPhys) / tFade;
        if (ft >= 1) {
          pool.release(i);
          continue;
        }
        this.phase[i] = PHASE_FADE;
        const k = 1 - ft;
        // frozen: `py` is never written again, so sink is a pure function of ft
        y = this.py[i] - sink * ft;
        sxi *= k; syi *= k; szi *= k;
      } else if (this.asleep[i] === 0) {
        // ── ballistic integration
        let vxi = this.vx[i];
        let vyi = this.vy[i];
        let vzi = this.vz[i];

        vyi += grav * dt;
        vxi *= linDamp; vyi *= linDamp; vzi *= linDamp;

        x += vxi * dt;
        y += vyi * dt;
        z += vzi * dt;

        const r = this.radius[i];
        const gy = probe(x, z);

        if (gy > -1e30) {
          this.hole[i] = 0;
          const floor = gy + r;
          if (y < floor) {
            y = floor;
            if (vyi < 0) vyi = -vyi * rest;
            vxi *= fric;
            vzi *= fric;
            this.wx[i] *= fric;
            this.wy[i] *= fric;
            this.wz[i] *= fric;
            const sp2 = vxi * vxi + vyi * vyi + vzi * vzi;
            if (sp2 < sleepSpeed * sleepSpeed) {
              vxi = 0; vyi = 0; vzi = 0;
              this.wx[i] = 0; this.wy[i] = 0; this.wz[i] = 0;
              this.asleep[i] = 1;
            }
          }
        } else {
          this.hole[i] = 1;
          if (y < this.deathY[i]) {
            // fell through a hole and is long gone
            pool.release(i);
            continue;
          }
        }

        this.vx[i] = vxi; this.vy[i] = vyi; this.vz[i] = vzi;

        // ── spin: q += 0.5 * dt * (omega ⊗ q), renormalised
        const owx = this.wx[i] * angDamp;
        const owy = this.wy[i] * angDamp;
        const owz = this.wz[i] * angDamp;
        this.wx[i] = owx; this.wy[i] = owy; this.wz[i] = owz;

        if (owx !== 0 || owy !== 0 || owz !== 0) {
          const cqx = this.qx[i];
          const cqy = this.qy[i];
          const cqz = this.qz[i];
          const cqw = this.qw[i];
          const h = 0.5 * dt;
          let nqx = cqx + h * (owx * cqw + owy * cqz - owz * cqy);
          let nqy = cqy + h * (owy * cqw + owz * cqx - owx * cqz);
          let nqz = cqz + h * (owz * cqw + owx * cqy - owy * cqx);
          let nqw = cqw - h * (owx * cqx + owy * cqy + owz * cqz);
          const nl = Math.sqrt(nqx * nqx + nqy * nqy + nqz * nqz + nqw * nqw);
          if (nl > 1e-6) {
            const inv = 1 / nl;
            nqx *= inv; nqy *= inv; nqz *= inv; nqw *= inv;
          } else {
            nqx = 0; nqy = 0; nqz = 0; nqw = 1;
          }
          this.qx[i] = nqx; this.qy[i] = nqy; this.qz[i] = nqz; this.qw[i] = nqw;
        }

        this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      }

      // ── write the instance matrix into this fragment's material bucket
      const mi = this.matIdx[i];
      const te = arrays[mi];
      const o = counts[mi] * 16;
      counts[mi]++;

      const fqx = this.qx[i];
      const fqy = this.qy[i];
      const fqz = this.qz[i];
      const fqw = this.qw[i];

      const x2 = fqx + fqx, y2 = fqy + fqy, z2 = fqz + fqz;
      const xx = fqx * x2, xy = fqx * y2, xz = fqx * z2;
      const yy = fqy * y2, yz = fqy * z2, zz = fqz * z2;
      const wxq = fqw * x2, wyq = fqw * y2, wzq = fqw * z2;

      te[o] = (1 - (yy + zz)) * sxi;
      te[o + 1] = (xy + wzq) * sxi;
      te[o + 2] = (xz - wyq) * sxi;
      te[o + 3] = 0;
      te[o + 4] = (xy - wzq) * syi;
      te[o + 5] = (1 - (xx + zz)) * syi;
      te[o + 6] = (yz + wxq) * syi;
      te[o + 7] = 0;
      te[o + 8] = (xz + wyq) * szi;
      te[o + 9] = (yz - wxq) * szi;
      te[o + 10] = (1 - (xx + yy)) * szi;
      te[o + 11] = 0;
      te[o + 12] = x;
      te[o + 13] = y;
      te[o + 14] = z;
      te[o + 15] = 1;
    }

    const prev = this._prevCounts;
    for (let m = 0; m < this.meshes.length; m++) {
      const mesh = this.meshes[m];
      const c = counts[m];
      mesh.count = c;
      mesh.visible = c > 0;
      // one flag per material bucket, and only when it actually has (or just had)
      // instances — an idle bucket must not re-upload 16 KB every frame
      if (c > 0 || prev[m] > 0) mesh.instanceMatrix.needsUpdate = true;
      prev[m] = c;
    }
  }

  /* ────────────────────────────────────────────────────────────── lifecycle */

  reset() {
    if (this._disposed) return;
    this.pool.releaseAll();
    this._counts.fill(0);
    this._prevCounts.fill(0);
    for (let m = 0; m < this.meshes.length; m++) {
      this.meshes[m].count = 0;
      this.meshes[m].visible = false;
    }
  }

  /** Toggle debris shadow casting (used by the quality setting). */
  setCastShadow(on) {
    if (this._disposed) return;
    const v = !!on;
    for (let m = 0; m < this.meshes.length; m++) this.meshes[m].castShadow = v;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let m = 0; m < this.meshes.length; m++) {
      const mesh = this.meshes[m];
      if (this.scene) this.scene.remove(mesh);
      mesh.dispose();
      this.materials[m].dispose();
    }
    this.geometry.dispose();
    this.scene = null;
    this.groundY = noGround;
  }
}

export default FragmentSystem;
