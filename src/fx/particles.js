/**
 * TONNAGE — particle system.
 *
 * Two `InstancedMesh` billboards over one shared `PlaneGeometry(1,1)`:
 *   • additive  — sparks, glints, impact flashes (AdditiveBlending, fade premultiplied
 *                 into `instanceColor`)
 *   • alpha     — dust, smoke, grit (NormalBlending, fade in an `aAlpha`
 *                 `InstancedBufferAttribute` feeding `material.opacityNode`)
 *
 * Data is struct-of-arrays over `Float32Array`s; slots come from `RingPool`, so a
 * burst that overflows the budget steals the oldest particles instead of being
 * dropped. `update()` is a single backwards pass of pure arithmetic per layer that
 * writes straight into `instanceMatrix.array` / `instanceColor.array` / the alpha
 * attribute and flips one `needsUpdate` flag each at the end. Nothing allocates
 * after construction.
 *
 * Billboarding is CPU-side. The quad basis (right/up/normal) is derived ONCE per
 * update from the camera position and a focus point (the centroid of the live
 * particles, seeded by the most recent emit), then reused for every instance.
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  PlaneGeometry,
} from 'three/webgpu';
import { attribute, float, uv } from 'three/tsl';

import { TUNING } from '../tuning.js';
import { clamp, clamp01, TAU } from '../core/math.js';
import { fxRng } from '../core/rng.js';
import { RingPool } from '../core/pool.js';

/* ───────────────────────────────────────────── module scratch (never allocated
   inside update/emit — these are the only mutable globals this module owns) */

const _col = new Color();

/** Uniform random unit vector, written into these three scalars. */
let _ux = 0;
let _uy = 1;
let _uz = 0;
function randomUnit() {
  const z = fxRng.next() * 2 - 1;
  const a = fxRng.next() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  _ux = r * Math.cos(a);
  _uy = r * Math.sin(a);
  _uz = z;
}

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

/** Pool factory — the pool only hands out indices; payload lives in typed arrays. */
const ZERO_SLOT = () => 0;

/**
 * One budgeted billboard layer. Pure data + a mesh; all behaviour lives in
 * ParticleSystem so the hot loop stays in one place.
 */
class Layer {
  constructor(capacity) {
    this.cap = capacity;
    this.pool = new RingPool(capacity, ZERO_SLOT);

    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.lifeMax = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gscale = new Float32Array(capacity);
    this.fadePow = new Float32Array(capacity);
    this.stretch = new Float32Array(capacity);
    this.refSpeed = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.rotVel = new Float32Array(capacity);
    this.cr = new Float32Array(capacity);
    this.cg = new Float32Array(capacity);
    this.cb = new Float32Array(capacity);
    this.bright = new Float32Array(capacity);

    /** Filled in by ParticleSystem once the mesh exists. */
    this.mesh = null;
    this.matArr = null;
    this.colArr = null;
    this.alphaArr = null;
    /** Last frame's instance count, so an idle layer stops re-uploading. */
    this.prevCount = 0;
  }
}

export class ParticleSystem {
  /** @param {import('three/webgpu').Scene} scene */
  constructor(scene) {
    const P = TUNING.particles;

    this.scene = scene;
    this._disposed = false;

    const capAdd = Math.max(1, P.maxAdditive | 0);
    const capAlpha = Math.max(1, P.maxAlpha | 0);

    this._add = new Layer(capAdd);
    this._alpha = new Layer(capAlpha);

    // ── geometry: one unit quad shared by both meshes. The alpha attribute lives
    // on it too; the additive material never references `aAlpha`, so the node
    // builder leaves it out of that program and it is simply never bound.
    this.geometry = new PlaneGeometry(1, 1);
    const alphaAttr = new InstancedBufferAttribute(
      new Float32Array(Math.max(capAdd, capAlpha)),
      1,
    );
    alphaAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aAlpha', alphaAttr);
    this._alphaAttr = alphaAttr;

    // ── soft round mask so the quads never read as squares.
    // m = clamp(1 - 2*|uv - 0.5|, 0, 1)
    const m = float(1).sub(uv().sub(0.5).length().mul(2)).clamp(0, 1);
    // additive core: m^2 (hot centre, quick falloff)
    const coreMask = m.mul(m);
    // soft puff: smoothstep(m) written out longhand to avoid arg-order ambiguity
    const softMask = m.mul(m).mul(float(3).sub(m.mul(2)));

    this.additiveMaterial = new MeshBasicNodeMaterial();
    this.additiveMaterial.transparent = true;
    this.additiveMaterial.depthWrite = false;
    this.additiveMaterial.depthTest = true;
    this.additiveMaterial.blending = AdditiveBlending;
    this.additiveMaterial.side = DoubleSide;
    this.additiveMaterial.fog = false;
    this.additiveMaterial.opacityNode = coreMask;

    this.alphaMaterial = new MeshBasicNodeMaterial();
    this.alphaMaterial.transparent = true;
    this.alphaMaterial.depthWrite = false;
    this.alphaMaterial.depthTest = true;
    this.alphaMaterial.blending = NormalBlending;
    this.alphaMaterial.side = DoubleSide;
    this.alphaMaterial.fog = true;
    this.alphaMaterial.opacityNode = attribute('aAlpha').mul(softMask);

    this._add.mesh = this._makeMesh(this.additiveMaterial, capAdd, P.renderOrder + 1);
    this._alpha.mesh = this._makeMesh(this.alphaMaterial, capAlpha, P.renderOrder);

    this._add.matArr = this._add.mesh.instanceMatrix.array;
    this._add.colArr = this._add.mesh.instanceColor.array;
    this._add.alphaArr = null;

    this._alpha.matArr = this._alpha.mesh.instanceMatrix.array;
    this._alpha.colArr = this._alpha.mesh.instanceColor.array;
    this._alpha.alphaArr = alphaAttr.array;

    if (scene) {
      scene.add(this._alpha.mesh);
      scene.add(this._add.mesh);
    }

    // ── per-frame billboard basis (recomputed once per update)
    this._rx = 1; this._ry = 0; this._rz = 0;
    this._upx = 0; this._upy = 1; this._upz = 0;
    this._nx = 0; this._ny = 0; this._nz = 1;

    // ── focus point the basis aims at

    // centroid accumulator, refilled every update

    /** Fractional-particle carry for emitDust. */
    this._dustAccum = 0;
  }

  _makeMesh(material, capacity, renderOrder) {
    const mesh = new InstancedMesh(this.geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  get activeCount() {
    return this._add.pool.activeCount + this._alpha.pool.activeCount;
  }

  /* ─────────────────────────────────────────────────────────────── emission */

  /**
   * Spawn one particle into `L`. Everything is a scalar so nothing allocates.
   * @private
   */
  _spawn(L, x, y, z, vx, vy, vz, life, size, grow, drag, gscale, fadePow,
    stretch, refSpeed, rotVel, bright) {
    const i = L.pool.acquire();
    if (i < 0) return;
    L.px[i] = x; L.py[i] = y; L.pz[i] = z;
    L.vx[i] = vx; L.vy[i] = vy; L.vz[i] = vz;
    L.life[i] = life; L.lifeMax[i] = life > 1e-5 ? life : 1e-5;
    L.size0[i] = size;
    L.grow[i] = grow;
    L.drag[i] = drag;
    L.gscale[i] = gscale;
    L.fadePow[i] = fadePow;
    L.stretch[i] = stretch;
    L.refSpeed[i] = refSpeed > 1e-4 ? refSpeed : 1e-4;
    L.rot[i] = fxRng.next() * TAU;
    L.rotVel[i] = rotVel;
    L.cr[i] = _cr; L.cg[i] = _cg; L.cb[i] = _cb;
    L.bright[i] = bright;
  }

  /**
   * Radial burst.
   * @param {number} count particles to emit
   * @param {number} color 0xRRGGBB
   * @param {boolean} additive route to the additive layer
   * @param {number} spread 0 = tight along (dirX,dirY,dirZ), 1 = full sphere
   */
  emitBurst(x, y, z, count, color, speed, life, size, additive, spread,
    dirX, dirY, dirZ) {
    if (this._disposed || count <= 0) return;
    const P = TUNING.particles;
    const L = additive ? this._add : this._alpha;


    // normalise the bias direction once
    let bx = dirX || 0, by = dirY || 0, bz = dirZ || 0;
    const bl = Math.sqrt(bx * bx + by * by + bz * bz);
    let sp = clamp01(spread === undefined ? 1 : spread);
    if (bl < 1e-5) {
      sp = 1;
    } else {
      const inv = 1 / bl;
      bx *= inv; by *= inv; bz *= inv;
    }

    unpackColor(color);

    const drag = additive ? P.dragAdditive : P.dragAlpha;
    const grow = additive ? P.burstGrowAdditive : P.burstGrowAlpha;
    const fadePow = additive ? P.fadePowAdditive : P.fadePowAlpha;
    const sizeJ = P.burstSizeJitter;
    const speedJ = P.burstSpeedJitter;
    const lifeJ = P.burstLifeJitter;
    const spin = P.burstSpin;
    const maxSize = P.maxSizeWorld;

    const n = count | 0;
    for (let k = 0; k < n; k++) {
      randomUnit();
      let dx = bx + (_ux - bx) * sp;
      let dy = by + (_uy - by) * sp;
      let dz = bz + (_uz - bz) * sp;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl < 1e-5) { dx = _ux; dy = _uy; dz = _uz; } else {
        const inv = 1 / dl;
        dx *= inv; dy *= inv; dz *= inv;
      }
      const sv = speed * (1 + fxRng.spread(speedJ));
      const li = life * (1 + fxRng.spread(lifeJ));
      const sz = clamp(size * (1 + fxRng.spread(sizeJ)), 0.01, maxSize);
      this._spawn(
        L,
        x, y, z,
        dx * sv, dy * sv, dz * sv,
        li > 0.02 ? li : 0.02,
        sz, grow, drag, 1, fadePow,
        0, 1, fxRng.spread(spin), 1,
      );
    }
  }

  /**
   * Rate-based continuous emission. Call every frame; fractional particles are
   * carried across frames so even a rate of 2/s emits reliably.
   */
  emitDust(x, y, z, rate, dt, speed, color, size) {
    if (this._disposed) return;
    const P = TUNING.particles;
    if (!(rate > 0) || !(dt > 0)) return;

    this._dustAccum += rate * dt;
    let n = Math.floor(this._dustAccum);
    if (n <= 0) return;
    this._dustAccum -= n;
    if (n > 24) n = 24; // one frame can never blow the whole budget on dust


    unpackColor(color);

    const L = this._alpha;
    const lifeLo = P.dustLife[0];
    const lifeHi = P.dustLife[1];
    const sizeLo = P.dustSize[0];
    const sizeHi = P.dustSize[1];
    const jit = P.dustSpeedJitter;
    const maxSize = P.maxSizeWorld;
    // dust barely falls: express dustGravity as a scale of the shared gravity
    const gscale = P.gravity !== 0 ? P.dustGravity / P.gravity : 0;

    for (let k = 0; k < n; k++) {
      randomUnit();
      // hemisphere-ish: dust never shoots downward through the road
      const dy = _uy < 0 ? -_uy : _uy;
      const sv = speed * (1 + fxRng.spread(jit));
      const sz = size > 0
        ? clamp(size * (1 + fxRng.spread(0.35)), 0.01, maxSize)
        : clamp(fxRng.range(sizeLo, sizeHi), 0.01, maxSize);
      this._spawn(
        L,
        x + _ux * 0.25, y + dy * 0.15, z + _uz * 0.25,
        _ux * sv, dy * sv * 0.5 + P.dustRise, _uz * sv,
        fxRng.range(lifeLo, lifeHi),
        sz, P.dustGrow, P.dustDrag, gscale,
        P.fadePowAlpha, 0, 1, fxRng.spread(P.burstSpin * 0.4), 1,
      );
    }
  }

  /** Hot, velocity-stretched streaks. Always additive. */
  emitSparks(x, y, z, count, dirX, dirY, dirZ) {
    if (this._disposed || count <= 0) return;
    const P = TUNING.particles;
    const L = this._add;


    let bx = dirX || 0, by = dirY || 0, bz = dirZ || 0;
    const bl = Math.sqrt(bx * bx + by * by + bz * bz);
    let sp = P.sparkSpread;
    if (bl < 1e-5) { sp = 1; } else {
      const inv = 1 / bl;
      bx *= inv; by *= inv; bz *= inv;
    }

    const gscale = P.sparkGravityScale;
    const drag = P.sparkDrag;
    const lifeLo = P.sparkLife[0];
    const lifeHi = P.sparkLife[1];
    const baseSpeed = P.sparkSpeed;
    const jit = P.sparkSpeedJitter;
    const size = P.sparkSize;
    const stretch = P.sparkStretch;
    const fadePow = P.fadePowAdditive;

    const n = count | 0;
    for (let k = 0; k < n; k++) {
      // hot core / cooler edge mix, so a shower has colour variation
      unpackColor(fxRng.bool(0.45) ? P.sparkColorHot : P.sparkColorCool);
      randomUnit();
      let dx = bx + (_ux - bx) * sp;
      let dy = by + (_uy - by) * sp;
      let dz = bz + (_uz - bz) * sp;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl < 1e-5) { dx = _ux; dy = _uy; dz = _uz; } else {
        const inv = 1 / dl;
        dx *= inv; dy *= inv; dz *= inv;
      }
      const sv = baseSpeed * (1 + fxRng.spread(jit));
      this._spawn(
        L,
        x, y, z,
        dx * sv, dy * sv, dz * sv,
        fxRng.range(lifeLo, lifeHi),
        size * (1 + fxRng.spread(0.3)),
        -0.5, drag, gscale, fadePow,
        stretch, baseSpeed, 0, 1,
      );
    }
  }

  /** Short bright radial flash at a contact point: a hot core plus a dim halo. */
  emitFlash(x, y, z, size, color) {
    if (this._disposed) return;
    const P = TUNING.particles;
    const L = this._add;


    const life = P.flashLife > 0.01 ? P.flashLife : 0.01;
    const s = clamp(size > 0 ? size : P.flashSize, 0.01, P.maxSizeWorld);

    unpackColor(color);
    // core
    this._spawn(L, x, y, z, 0, 0, 0, life, s, P.flashGrow, 0, 0, 1, 0, 1, 0, 1);
    // halo — bigger, dimmer, lives slightly longer so the pop has a tail
    this._spawn(
      L, x, y, z, 0, 0, 0, life * 1.7,
      clamp(s * P.flashHaloScale, 0.01, P.maxSizeWorld),
      P.flashGrow * 0.6, 0, 0, P.fadePowAdditive, 0, 1, 0, P.flashHaloGain,
    );
  }

  /* ─────────────────────────────────────────────────────────────── per-frame */

  /**
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}} cam camera world position
   */
  update(dt, cam) {
    if (this._disposed) return;
    if (!(dt > 0)) dt = 0;

    this._buildBasis(cam);
    this._updateLayer(this._add, dt, true);
    this._updateLayer(this._alpha, dt, false);
  }

  /**
   * View-plane billboard basis, taken straight from the camera's world matrix.
   *
   * Aiming every quad at a single focus point instead (the live-particle
   * centroid, say) foreshortens anything away from that point — up to ~18 % squash
   * at the widest FOV — and makes the whole field swim whenever the focus moves.
   * Right and up out of the view matrix are both exact and cheaper.
   */
  _buildBasis(cam) {
    let rx = 1, ry = 0, rz = 0;
    let upx = 0, upy = 1, upz = 0;
    const m = cam && cam.matrixWorld ? cam.matrixWorld.elements : null;
    if (m) {
      rx = m[0]; ry = m[1]; rz = m[2];
      upx = m[4]; upy = m[5]; upz = m[6];
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rl > 1e-6) { const inv = 1 / rl; rx *= inv; ry *= inv; rz *= inv; }
      const ul = Math.sqrt(upx * upx + upy * upy + upz * upz);
      if (ul > 1e-6) { const inv = 1 / ul; upx *= inv; upy *= inv; upz *= inv; }
    }
    this._rx = rx; this._ry = ry; this._rz = rz;
    this._upx = upx; this._upy = upy; this._upz = upz;
    // normal = right x up, i.e. straight back at the camera
    this._nx = ry * upz - rz * upy;
    this._ny = rz * upx - rx * upz;
    this._nz = rx * upy - ry * upx;
  }

  /**
   * Integrate one layer and rewrite its instance buffers, compacted so the live
   * particles occupy slots [0, count). Backwards iteration keeps `pool.release`
   * (swap-with-last) safe.
   * @private
   */
  _updateLayer(L, dt, additive) {
    const P = TUNING.particles;
    const pool = L.pool;
    const act = pool.active;
    const mat = L.matArr;
    const col = L.colArr;
    const alphaArr = L.alphaArr;

    const grav = P.gravity;
    const popIn = P.popInTime;
    const maxSize = P.maxSizeWorld;

    const rx = this._rx, ry = this._ry, rz = this._rz;
    const ux = this._upx, uy = this._upy, uz = this._upz;
    const nx = this._nx, ny = this._ny, nz = this._nz;

    let w = 0;
    for (let i = pool.activeCount - 1; i >= 0; i--) {
      const idx = act[i];

      let life = L.life[idx] - dt;
      if (life <= 0) {
        pool.release(idx);
        continue;
      }
      L.life[idx] = life;

      const lm = L.lifeMax[idx];
      const t = life / lm;              // 1 → 0
      const age = lm - life;

      // ── integrate
      let vx = L.vx[idx];
      let vy = L.vy[idx];
      let vz = L.vz[idx];
      vy += grav * L.gscale[idx] * dt;
      const damp = 1 / (1 + L.drag[idx] * dt);
      vx *= damp; vy *= damp; vz *= damp;
      L.vx[idx] = vx; L.vy[idx] = vy; L.vz[idx] = vz;

      const x = L.px[idx] + vx * dt;
      const y = L.py[idx] + vy * dt;
      const z = L.pz[idx] + vz * dt;
      L.px[idx] = x; L.py[idx] = y; L.pz[idx] = z;


      // ── fade + size curves
      let fade = Math.pow(t, L.fadePow[idx]);
      if (popIn > 0 && age < popIn) fade *= age / popIn;
      fade *= L.bright[idx];

      let s = L.size0[idx] * (1 + L.grow[idx] * (1 - t));
      if (s < 0) s = 0;
      else if (s > maxSize) s = maxSize;

      // ── billboard roll, or velocity alignment for stretched streaks
      let ang;
      let sw = s;
      let sh = s;
      const stretch = L.stretch[idx];
      if (stretch > 1) {
        const dr = vx * rx + vy * ry + vz * rz;
        const du = vx * ux + vy * uy + vz * uz;
        const planar = Math.sqrt(dr * dr + du * du);
        ang = planar > 1e-4 ? Math.atan2(du, dr) : L.rot[idx];
        const spd = Math.sqrt(vx * vx + vy * vy + vz * vz);
        let k = spd / L.refSpeed[idx];
        if (k > 1) k = 1;
        sw = s * (1 + (stretch - 1) * k);
        if (sw > maxSize) sw = maxSize;
      } else {
        ang = L.rot[idx] + L.rotVel[idx] * dt;
        L.rot[idx] = ang;
      }

      const ca = Math.cos(ang);
      const sa = Math.sin(ang);

      // ── compose the instance matrix (column-major)
      const o = w * 16;
      mat[o] = (rx * ca + ux * sa) * sw;
      mat[o + 1] = (ry * ca + uy * sa) * sw;
      mat[o + 2] = (rz * ca + uz * sa) * sw;
      mat[o + 3] = 0;
      mat[o + 4] = (ux * ca - rx * sa) * sh;
      mat[o + 5] = (uy * ca - ry * sa) * sh;
      mat[o + 6] = (uz * ca - rz * sa) * sh;
      mat[o + 7] = 0;
      mat[o + 8] = nx;
      mat[o + 9] = ny;
      mat[o + 10] = nz;
      mat[o + 11] = 0;
      mat[o + 12] = x;
      mat[o + 13] = y;
      mat[o + 14] = z;
      mat[o + 15] = 1;

      const c = w * 3;
      if (additive) {
        // premultiply the fade into the colour: additive blending is
        // src*srcAlpha + dst, and srcAlpha here is the round mask only
        col[c] = L.cr[idx] * fade;
        col[c + 1] = L.cg[idx] * fade;
        col[c + 2] = L.cb[idx] * fade;
      } else {
        col[c] = L.cr[idx];
        col[c + 1] = L.cg[idx];
        col[c + 2] = L.cb[idx];
        alphaArr[w] = fade;
      }

      w++;
    }

    const mesh = L.mesh;
    mesh.count = w;
    mesh.visible = w > 0;
    // one flag per buffer, once, at the end — and only when the layer is (or was
    // just) carrying instances, so an idle layer costs no upload at all
    if (w > 0 || L.prevCount > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      if (!additive) this._alphaAttr.needsUpdate = true;
    }
    L.prevCount = w;
  }

  /* ────────────────────────────────────────────────────────────── lifecycle */

  reset() {
    if (this._disposed) return;
    this._add.pool.releaseAll();
    this._alpha.pool.releaseAll();
    this._dustAccum = 0;
    this._add.mesh.count = 0;
    this._add.mesh.visible = false;
    this._add.prevCount = 0;
    this._alpha.mesh.count = 0;
    this._alpha.mesh.visible = false;
    this._alpha.prevCount = 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.scene) {
      this.scene.remove(this._add.mesh);
      this.scene.remove(this._alpha.mesh);
    }
    this._add.mesh.dispose();
    this._alpha.mesh.dispose();
    this.geometry.dispose();
    this.additiveMaterial.dispose();
    this.alphaMaterial.dispose();
    this.scene = null;
  }
}

export default ParticleSystem;
