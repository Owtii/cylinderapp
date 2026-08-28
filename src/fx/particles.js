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
 *
 * `emitImpact` is the entry point for a smash (§10). One puff never reads as
 * destruction, so every impact fires FOUR layers with distinct jobs — a fast
 * material-coloured burst, a slow dust cloud that gives the impact its size, a
 * material-specific shower that says what broke, and a lingering trace that is
 * still there three seconds later and gets shoved apart by `disturb()` when the
 * roller drives through it. The granular emitters below it stay for their own
 * callers (rolling dust, the finale burst, the blocked ring).
 *
 * §6.1 governs all of it: debris must never obscure what is coming. Every impact
 * particle is thrown with its lateral component amplified and its +Z component
 * clamped to `maxTowardCamera`, so nothing in this system can travel back toward
 * the viewer or sit in the middle of the screen. `fx/fragments.js` enforces the
 * same two rules; the shape of the code here is deliberately the same.
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
import { MATERIALS } from '../world/objects.js';

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

/* ────────────────────────────────────────────── impact material signatures (§10)

   The third layer of every impact is the one that says WHAT broke, so it is a
   table rather than a parameter: glass twinkles, wood throws splinters and
   sawdust, sheet metal sparks and sheds paint chips, concrete makes grit and
   dust, plastic and rubber shed dull shells, and a vehicle gets all of it plus
   fluid. Everything here is desaturated (§6.1) — the sparks are incandescent
   white with a cold blue-white bleed rather than the amber a spark "should" be,
   because amber belongs to the outline system. */

const FAM_SHARD = 0;
const FAM_SPLINTER = 1;
const FAM_PANEL = 2;
const FAM_GRIT = 3;
const FAM_SHELL = 4;
const FAM_VEHICLE = 5;

/** Material key → shower family. Null-prototype so 'constructor' cannot collide. */
const FAMILY_OF = Object.create(null);
FAMILY_OF.glass = FAM_SHARD;
FAMILY_OF.water = FAM_SHARD;
FAMILY_OF.wood = FAM_SPLINTER;
FAMILY_OF.metal = FAM_PANEL;
FAMILY_OF.steel = FAM_PANEL;
FAMILY_OF.paint = FAM_PANEL;
FAMILY_OF.slate = FAM_PANEL;
FAMILY_OF.concrete = FAM_GRIT;
FAMILY_OF.sand = FAM_GRIT;
FAMILY_OF.hazard = FAM_GRIT;
FAMILY_OF.rubber = FAM_SHELL;
FAMILY_OF.plastic = FAM_SHELL;
FAMILY_OF.car = FAM_VEHICLE;
FAMILY_OF.truck = FAM_VEHICLE;
FAMILY_OF.vehicle = FAM_VEHICLE;
FAMILY_OF.tanker = FAM_VEHICLE;

/** Fallback tint for a material with no row in `MATERIALS`. */
const FALLBACK_TINT = 0xb0b6bd;

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
    /** 1 = part of an impact's lingering trace, and so eligible for `disturb`. */
    this.trace = new Float32Array(capacity);

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
    /** Impacts since the last `update`, so a crowded frame spends less on each. */
    this._frameImpacts = 0;
    /** Slots one impact may steal from a saturated layer. See `_headroom`. */
    this._stealBudget = 0;
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
   * @returns {number} the slot, or -1 when the layer refused it.
   * @private
   */
  _spawn(L, x, y, z, vx, vy, vz, life, size, grow, drag, gscale, fadePow,
    stretch, refSpeed, rotVel, bright) {
    const i = L.pool.acquire();
    if (i < 0) return -1;
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
    L.trace[i] = 0;
    return i;
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

  /* ────────────────────────────────────────────────────── the impact (§10, §17) */

  /**
   * One impact, four layers. This is the only entry point the game needs for a
   * smash; the granular emitters above stay for everything else.
   *
   *   1 impact burst    40–80 material-coloured specks, 0.3 s, thrown hard along
   *                     the impact axis. Frame one, always.
   *   2 dust cloud      a slow puff that expands over 2 s and gets left behind.
   *                     This is the layer that says how BIG the thing was.
   *   3 material shower the signature: glass twinkles, wood splinters, metal
   *                     sparks and sheds paint, concrete grits, vehicles do all
   *                     of it plus fluid. Nothing else tells you what broke.
   *   4 lingering trace 3 s of haze that stays on the road and is shoved apart by
   *                     `disturb()` as the roller drives through it.
   *
   * Nothing in here touches the simulation. §5's paper tier is 80 % of all hits by
   * design, and a paper hit costs exactly zero speed and zero frames — so this
   * method allocates nothing, blocks nothing and is safe to call twenty times in a
   * second. What protects the frame at that rate is `crowd01` plus the internal
   * per-frame impact count, which shrink each impact's spend rather than dropping
   * layers: four thin layers still read as an impact, three fat ones do not.
   *
   * @param {string} materialKey e.g. 'glass', 'wood', 'metal', 'concrete', 'car'
   * @param {number} nx unit impact axis, world space — the direction debris goes
   * @param {number} energy01 0 = a mailbox, 1 = a water tower
   * @param {number} crowd01 1 = this impact is alone, → 0 under load
   * @param {string} outcome 'PULVERIZE' | 'CLEAN' | 'PLOW' | 'BLOCKED' | 'BLOCKER'
   */
  emitImpact(materialKey, x, y, z, nx, ny, nz, energy01, crowd01, outcome) {
    if (this._disposed) return;
    const P = TUNING.particles;

    const e = clamp01(energy01 === undefined ? 0.5 : energy01);
    const oscale = P.impactOutcomeScale[outcome] || 1;

    // Crowding, twice over: what the caller measured, and what this system has
    // actually been asked to draw since the last frame. The second one is the
    // backstop — a caller that forgets to pass `crowd01` still cannot melt the
    // budget with a twelve-object formation.
    this._stealBudget = P.impactMinPerLayer;
    const asked = crowd01 === undefined ? 1 : clamp01(crowd01);
    const seen = 1 / (1 + this._frameImpacts * P.impactCrowdFalloff);
    this._frameImpacts++;
    const crowd = P.impactCrowdFloor + (1 - P.impactCrowdFloor) * asked * seen;
    const spend = crowd * oscale;

    // normalise the impact axis; a degenerate one becomes "up and downhill", which
    // is where debris goes anyway
    let ax = nx || 0, ay = ny || 0, az = nz || 0;
    const al = Math.sqrt(ax * ax + ay * ay + az * az);
    if (al < 1e-5) { ax = 0; ay = 0.55; az = -0.84; } else {
      const inv = 1 / al;
      ax *= inv; ay *= inv; az *= inv;
    }

    const fam = FAMILY_OF[materialKey];
    const mat = MATERIALS[materialKey];
    const tint = mat && mat.particle ? mat.particle : FALLBACK_TINT;

    this._emitImpactBurst(x, y, z, ax, ay, az, e, spend, tint);
    this._emitImpactDust(x, y, z, e, spend, tint);
    this._emitShower(fam === undefined ? FAM_GRIT : fam, x, y, z, ax, ay, az, e, spend, tint);
    this._emitTrace(x, y, z, e, spend, tint);
  }

  /**
   * How many of `n` a layer can actually take right now.
   *
   * `RingPool.acquire` steals the oldest entry when it is full, and finding it is
   * a linear scan of the live set — fine for the odd overflow, measurably not
   * fine for a 140-particle impact into a full 800-slot layer (measured: 88 us
   * for that one call). A pile-up is exactly where frames are scarcest, so a
   * saturated layer takes whatever expired this frame and then at most
   * `impactMinPerLayer` stolen slots for the WHOLE impact, and the hit reads
   * thinner rather than the frame reading longer. Same trade the crowd term makes
   * one level up.
   * @private
   */
  _headroom(L, n) {
    // A non-finite request must ask for nothing, not for everything: `NaN <= free`
    // is false, so without this the fall-through below hands the caller the whole
    // free capacity and one bad `energy01` fills the layer with NaN particles.
    if (!(n > 0)) return 0;
    const free = L.cap - L.pool.activeCount;
    if (n <= free) return n;
    if (free > 0) return free;
    // Nothing has expired: buy a couple of particles out of this impact's steal
    // budget so the hit still registers, and let the rest of it go.
    const b = this._stealBudget;
    if (b <= 0) return 0;
    const take = n < b ? n : b;
    this._stealBudget = b - take;
    return take;
  }

  /**
   * Spawn one impact particle with §6.1's two guarantees baked in: the lateral
   * component is amplified so debris leaves frame sideways rather than sitting in
   * the middle of it, and `away` plus the hard clamp mean nothing ever carries
   * velocity back toward the camera. `fragments.js` enforces the same two rules
   * the same way; this is deliberately the same shape of code.
   * @private
   */
  _impactSpawn(L, x, y, z, vx, vy, vz, life, size, grow, drag, gscale, fadePow,
    stretch, refSpeed, rotVel, bright, away, lateral) {
    const P = TUNING.particles;
    const ox = vx * (1 + lateral);
    let oz = vz - away;
    if (oz > P.maxTowardCamera) oz = P.maxTowardCamera;
    return this._spawn(
      L, x, y, z, ox, vy, oz, life,
      clamp(size, 0.01, P.maxSizeWorld),
      grow, drag, gscale, fadePow, stretch, refSpeed, rotVel, bright,
    );
  }

  /** Layer 1: the fast radial spray. Reads as the object coming apart. @private */
  _emitImpactBurst(x, y, z, ax, ay, az, e, spend, tint) {
    const P = TUNING.particles;
    const L = this._alpha;
    const n = this._headroom(L, Math.max(1, Math.round(
      (P.impactBurstCount[0] + (P.impactBurstCount[1] - P.impactBurstCount[0]) * e) * spend)));
    const speed = P.impactBurstSpeed[0] + (P.impactBurstSpeed[1] - P.impactBurstSpeed[0]) * e;
    const size = P.impactBurstSize[0] + (P.impactBurstSize[1] - P.impactBurstSize[0]) * e;
    const spread = P.impactBurstSpread;
    const away = P.impactBurstAway;
    const lateral = P.impactLateralBias + P.impactBurstLateral;

    unpackColor(tint);
    for (let k = 0; k < n; k++) {
      randomUnit();
      let dx = ax + (_ux - ax) * spread;
      let dy = ay + (_uy - ay) * spread;
      let dz = az + (_uz - az) * spread;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl < 1e-5) { dx = _ux; dy = _uy; dz = _uz; } else {
        const inv = 1 / dl;
        dx *= inv; dy *= inv; dz *= inv;
      }
      const sv = speed * (1 + fxRng.spread(P.burstSpeedJitter));
      this._impactSpawn(
        L, x, y, z, dx * sv, dy * sv, dz * sv,
        P.impactBurstLife * (1 + fxRng.spread(P.burstLifeJitter)),
        size * (1 + fxRng.spread(P.burstSizeJitter)),
        P.burstGrowAlpha, P.dragAlpha, 1, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin), 1,
        away, lateral,
      );
    }
  }

  /** Layer 2: the slow puff that gives the impact its size. @private */
  _emitImpactDust(x, y, z, e, spend, tint) {
    const P = TUNING.particles;
    const L = this._alpha;
    const n = this._headroom(L, Math.max(1, Math.round(
      (P.impactDustCount[0] + (P.impactDustCount[1] - P.impactDustCount[0]) * e) * spend)));
    const speed = P.impactDustSpeed[0] + (P.impactDustSpeed[1] - P.impactDustSpeed[0]) * e;
    const size = P.impactDustSize[0] + (P.impactDustSize[1] - P.impactDustSize[0]) * e;
    const gscale = P.gravity !== 0 ? P.dustGravity / P.gravity : 0;
    const away = P.impactDustAway;
    const lateral = P.impactLateralBias;

    // The puff barely moves in world space, which is exactly why it reads as
    // drifting BACKWARD: the roller is doing 30-40 m/s and leaves it standing.
    // Giving it real +Z velocity to "drift back" would put it in front of the
    // camera, which §6.1 forbids — hence the clamp in `_impactSpawn`.
    unpackColor(tint);
    for (let k = 0; k < n; k++) {
      randomUnit();
      const dy = _uy < 0 ? -_uy : _uy;
      const sv = speed * (1 + fxRng.spread(P.dustSpeedJitter));
      this._impactSpawn(
        L,
        x + _ux * size * 0.35, y + dy * size * 0.3, z + _uz * size * 0.35,
        _ux * sv, dy * sv * 0.55 + P.impactDustRise, _uz * sv,
        P.impactDustLife * (1 + fxRng.spread(0.22)),
        size * (1 + fxRng.spread(0.4)),
        P.impactDustGrow, P.impactDustDrag, gscale, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin * 0.3), 1,
        away, lateral,
      );
    }
  }

  /** Layer 3: the signature. Dispatches on material family. @private */
  _emitShower(fam, x, y, z, ax, ay, az, e, spend, tint) {
    const P = TUNING.particles;
    const n = Math.max(1, Math.round(
      (P.impactShowerCount[0] + (P.impactShowerCount[1] - P.impactShowerCount[0]) * e) * spend));

    switch (fam) {
      case FAM_SHARD:
        this._showerGlint(x, y, z, ax, ay, az, e, n);
        break;
      case FAM_SPLINTER:
        this._showerSplinters(x, y, z, ax, ay, az, e, n);
        break;
      case FAM_PANEL:
        this._showerSparks(x, y, z, ax, ay, az, e, Math.max(1, Math.round(n * 0.65)));
        this._showerChips(x, y, z, ax, ay, az, e, Math.max(1, Math.round(n * 0.35)));
        break;
      case FAM_SHELL:
        this._showerShells(x, y, z, ax, ay, az, e, n, tint);
        break;
      case FAM_VEHICLE:
        // everything at once, which is why a car reads as louder than a crate
        this._showerGlint(x, y, z, ax, ay, az, e, Math.max(1, Math.round(n * 0.3)));
        this._showerSparks(x, y, z, ax, ay, az, e, Math.max(1, Math.round(n * 0.3)));
        this._showerChips(x, y, z, ax, ay, az, e, Math.max(1, Math.round(n * 0.2)));
        this._showerFluid(x, y, z, ax, ay, az, e, Math.max(1, Math.round(n * 0.2)));
        break;
      default:
        this._showerGrit(x, y, z, ax, ay, az, e, n);
        break;
    }
  }

  /**
   * Direction helper for the shower emitters: a cone about the impact axis,
   * written into `_ux/_uy/_uz`. @private
   */
  _showerDir(ax, ay, az, spread) {
    randomUnit();
    let dx = ax + (_ux - ax) * spread;
    let dy = ay + (_uy - ay) * spread;
    let dz = az + (_uz - az) * spread;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-5) return;
    const inv = 1 / dl;
    _ux = dx * inv; _uy = dy * inv; _uz = dz * inv;
  }

  /** Glass: tiny additive billboards that twinkle as they tumble. @private */
  _showerGlint(x, y, z, ax, ay, az, e, n) {
    const P = TUNING.particles;
    const L = this._add;
    const count = this._headroom(L, n);
    const speed = P.impactShowerSpeed[0] + (P.impactShowerSpeed[1] - P.impactShowerSpeed[0]) * e;
    unpackColor(P.glintColor);
    for (let k = 0; k < count; k++) {
      this._showerDir(ax, ay, az, P.impactShowerSpread);
      const sv = speed * fxRng.range(0.7, 1.6);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv, _uz * sv,
        fxRng.range(P.glintLife[0], P.glintLife[1]),
        P.glintSize * fxRng.range(0.6, 1.5),
        -0.3, P.dragAdditive, 1.25, P.fadePowAdditive,
        // a hard spin on a hot billboard is what makes a shard read as catching
        // the light rather than as a firefly
        0, 1, fxRng.spread(P.glintSpin), fxRng.range(0.55, 1.25),
        P.impactShowerAway, P.impactLateralBias,
      );
    }
  }

  /** Wood: long splinters along the throw, plus a haze of sawdust. @private */
  _showerSplinters(x, y, z, ax, ay, az, e, n) {
    const P = TUNING.particles;
    const L = this._alpha;
    const count = this._headroom(L, n);
    const speed = P.impactShowerSpeed[0] + (P.impactShowerSpeed[1] - P.impactShowerSpeed[0]) * e;
    const splinters = count > 0 ? Math.max(1, Math.round(count * 0.6)) : 0;
    unpackColor(MATERIALS.wood ? MATERIALS.wood.particle : FALLBACK_TINT);
    for (let k = 0; k < splinters; k++) {
      this._showerDir(ax, ay, az, P.impactShowerSpread);
      const sv = speed * fxRng.range(0.8, 1.5);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv, _uz * sv,
        fxRng.range(P.splinterLife[0], P.splinterLife[1]),
        P.splinterSize * fxRng.range(0.7, 1.4),
        -0.2, P.dragAlpha * 0.7, 1.15, P.fadePowAlpha,
        // velocity-aligned: a splinter is a streak, never a dot
        P.splinterStretch, speed, 0, 1,
        P.impactShowerAway, P.impactLateralBias,
      );
    }
    unpackColor(P.sawdustColor);
    for (let k = splinters; k < count; k++) {
      this._showerDir(ax, ay, az, 0.9);
      const sv = speed * fxRng.range(0.15, 0.5);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv + P.impactDustRise * 0.6, _uz * sv,
        fxRng.range(P.sawdustLife[0], P.sawdustLife[1]),
        P.sawdustSize * fxRng.range(0.6, 1.6),
        1.1, P.dustDrag, 0.12, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin * 0.5), 1,
        P.impactShowerAway * 0.4, P.impactLateralBias,
      );
    }
  }

  /**
   * Sheet metal: short bright streaks. White-hot with a cold blue-white bleed —
   * §6.1 keeps amber for the outline system, so a spark here is incandescent
   * rather than orange, which is what a real one looks like anyway.
   * @private
   */
  _showerSparks(x, y, z, ax, ay, az, e, n) {
    const P = TUNING.particles;
    const L = this._add;
    const count = this._headroom(L, n);
    const speed = P.impactShowerSpeed[0] + (P.impactShowerSpeed[1] - P.impactShowerSpeed[0]) * e;
    for (let k = 0; k < count; k++) {
      unpackColor(fxRng.bool(0.6) ? P.showerSparkHot : P.showerSparkCool);
      this._showerDir(ax, ay, az, P.sparkSpread);
      const sv = speed * fxRng.range(1.1, 2.2);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv, _uz * sv,
        fxRng.range(P.sparkLife[0], P.sparkLife[1]),
        P.sparkSize * fxRng.range(0.7, 1.3),
        -0.5, P.sparkDrag, P.sparkGravityScale, P.fadePowAdditive,
        P.sparkStretch, speed, 0, 1,
        P.impactShowerAway, P.impactLateralBias,
      );
    }
  }

  /** Sheet metal: the scatter of paint chips that comes off with the sparks. @private */
  _showerChips(x, y, z, ax, ay, az, e, n) {
    const P = TUNING.particles;
    const L = this._alpha;
    const count = this._headroom(L, n);
    const speed = P.impactShowerSpeed[0] + (P.impactShowerSpeed[1] - P.impactShowerSpeed[0]) * e;
    unpackColor(P.paintChipColor);
    for (let k = 0; k < count; k++) {
      this._showerDir(ax, ay, az, 0.75);
      const sv = speed * fxRng.range(0.5, 1.1);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv, _uz * sv,
        fxRng.range(P.chipLife[0], P.chipLife[1]),
        P.chipSize * fxRng.range(0.6, 1.5),
        -0.1, P.dragAlpha * 0.8, 1.0, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin * 1.6), 1,
        P.impactShowerAway * 0.7, P.impactLateralBias,
      );
    }
  }

  /** Concrete and sand: grey dust and grit, heavy on the dust. @private */
  _showerGrit(x, y, z, ax, ay, az, e, n) {
    const P = TUNING.particles;
    const L = this._alpha;
    const count = this._headroom(L, n);
    const speed = P.impactShowerSpeed[0] + (P.impactShowerSpeed[1] - P.impactShowerSpeed[0]) * e;
    const grit = count > 0 ? Math.max(1, Math.round(count * 0.45)) : 0;
    unpackColor(P.gritColor);
    for (let k = 0; k < grit; k++) {
      this._showerDir(ax, ay, az, P.impactShowerSpread);
      const sv = speed * fxRng.range(0.6, 1.3);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv, _uz * sv,
        fxRng.range(P.gritLife[0], P.gritLife[1]),
        P.gritSize * fxRng.range(0.6, 1.4),
        0, P.dragAlpha, 1.3, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin), 1,
        P.impactShowerAway, P.impactLateralBias,
      );
    }
    unpackColor(P.concreteDustColor);
    for (let k = grit; k < count; k++) {
      this._showerDir(ax, ay, az, 0.95);
      const sv = speed * fxRng.range(0.1, 0.4);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv + P.impactDustRise, _uz * sv,
        fxRng.range(P.concreteDustLife[0], P.concreteDustLife[1]),
        P.concreteDustSize * fxRng.range(0.7, 1.7),
        1.6, P.dustDrag, 0.1, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin * 0.4), 1,
        P.impactShowerAway * 0.35, P.impactLateralBias,
      );
    }
  }

  /** Plastic and rubber: a few large dull shells that tumble hard. @private */
  _showerShells(x, y, z, ax, ay, az, e, n, tint) {
    const P = TUNING.particles;
    const L = this._alpha;
    const speed = P.impactShowerSpeed[0] + (P.impactShowerSpeed[1] - P.impactShowerSpeed[0]) * e;
    const room = this._headroom(L, n);                  // few and large, per §10
    const count = room > 0 ? Math.max(1, Math.round(room * 0.45)) : 0;
    unpackColor(tint);
    for (let k = 0; k < count; k++) {
      this._showerDir(ax, ay, az, 0.7);
      const sv = speed * fxRng.range(0.4, 0.9);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv, _uz * sv,
        fxRng.range(P.shellLife[0], P.shellLife[1]),
        P.shellSize * fxRng.range(0.8, 1.6),
        0.2, P.dragAlpha * 0.6, 1.0, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin * 2.2), 1,
        P.impactShowerAway * 0.8, P.impactLateralBias,
      );
    }
  }

  /** Vehicles only: the fluid spray off a ruptured tank. @private */
  _showerFluid(x, y, z, ax, ay, az, e, n) {
    const P = TUNING.particles;
    const L = this._alpha;
    const count = this._headroom(L, n);
    const speed = P.impactShowerSpeed[0] + (P.impactShowerSpeed[1] - P.impactShowerSpeed[0]) * e;
    unpackColor(P.fluidColor);
    for (let k = 0; k < count; k++) {
      this._showerDir(ax, ay, az, 0.55);
      const sv = speed * fxRng.range(0.5, 1.0);
      this._impactSpawn(
        L, x, y, z, _ux * sv, _uy * sv, _uz * sv,
        fxRng.range(P.fluidLife[0], P.fluidLife[1]),
        P.fluidSize * fxRng.range(0.7, 1.4),
        0.3, P.dragAlpha * 0.5, 1.9, P.fadePowAlpha,
        P.fluidStretch, speed, 0, 1,
        P.impactShowerAway * 0.6, P.impactLateralBias,
      );
    }
  }

  /**
   * Layer 4: what is still hanging there three seconds later. Flagged `trace`, so
   * `disturb()` can find it when the roller comes through.
   * @private
   */
  _emitTrace(x, y, z, e, spend, tint) {
    const P = TUNING.particles;
    const L = this._alpha;
    const n = this._headroom(L, Math.max(1, Math.round(
      (P.impactTraceCount[0] + (P.impactTraceCount[1] - P.impactTraceCount[0]) * e) * spend)));
    const size = P.impactTraceSize[0] + (P.impactTraceSize[1] - P.impactTraceSize[0]) * e;

    unpackColor(tint);
    for (let k = 0; k < n; k++) {
      randomUnit();
      const dy = _uy < 0 ? -_uy : _uy;
      const i = this._impactSpawn(
        L,
        x + _ux * size * 0.4, y + dy * size * 0.25, z + _uz * size * 0.4,
        _ux * P.impactTraceSpeed, dy * P.impactTraceSpeed * 0.4 + P.impactTraceRise,
        _uz * P.impactTraceSpeed,
        P.impactTraceLife * (1 + fxRng.spread(0.18)),
        size * (1 + fxRng.spread(0.35)),
        P.impactTraceGrow, P.impactTraceDrag, 0, P.fadePowAlpha,
        0, 1, fxRng.spread(P.burstSpin * 0.2), P.impactTraceBright,
        P.impactTraceAway, P.impactLateralBias,
      );
      if (i >= 0) L.trace[i] = 1;
    }
  }

  /**
   * Shove the lingering traces apart. The game calls this every frame with the
   * roller's position, so driving through your own smoke opens a hole in it
   * instead of pasting a grey card over the next formation.
   *
   * Nothing here is allowed to push a particle back toward the camera, so the
   * outward impulse is clamped on +Z exactly as emission is.
   *
   * @param {number} strength 0 = no push, 1 = the full `disturbSpeed`
   */
  disturb(x, z, radius, strength) {
    if (this._disposed || !(radius > 0)) return;
    const P = TUNING.particles;
    const push = P.disturbSpeed * (strength > 0 ? strength : 0);
    if (push <= 0) return;

    const L = this._alpha;
    const pool = L.pool;
    const act = pool.active;
    const r2 = radius * radius;
    const invR = 1 / radius;
    const rise = P.disturbRise;
    const maxToward = P.maxTowardCamera;

    for (let i = pool.activeCount - 1; i >= 0; i--) {
      const idx = act[i];
      if (L.trace[idx] === 0) continue;
      const dx = L.px[idx] - x;
      const dz = L.pz[idx] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      const s = push * (1 - d * invR);
      let ox, oz;
      if (d < 1e-4) {
        // dead centre: sideways, because "outward" is undefined and "backward"
        // would mean straight at the camera
        ox = fxRng.bool() ? 1 : -1;
        oz = 0;
      } else {
        const inv = 1 / d;
        ox = dx * inv; oz = dz * inv;
      }
      let vz = L.vz[idx] + oz * s;
      if (vz > maxToward) vz = maxToward;
      L.vx[idx] += ox * s;
      L.vz[idx] = vz;
      L.vy[idx] += rise * s;
    }
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
    this._frameImpacts = 0;
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
    this._frameImpacts = 0;
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
