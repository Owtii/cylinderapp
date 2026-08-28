/**
 * TONNAGE — debris fragments (§10, §17).
 *
 * A pooled ballistic integrator, not a rigid-body solver. Fragments get gravity,
 * drag, spin and a per-material bounce off the road surface (via the injected
 * `groundY(x, z)` probe, which returns -Infinity over a hole so debris there falls
 * forever), and nothing else — with one deliberate exception: the three largest
 * pieces of a PLOW-tier object collide with each other, because those are the only
 * fragments big enough and slow enough for the eye to catch them interpenetrating.
 * Everything else passes through everything else, which nobody can see at these
 * speeds and which is the entire cost.
 *
 * Shape comes from `fx/fracture.js`: one of `FRACTURE_VARIANTS` pre-baked plans per
 * prop, picked at random per spawn, giving material-correct pieces — glass slivers,
 * wood splinters along the grain, torn metal panels, chunky concrete. Two things
 * that module provides are worth calling out because they are what the eye reads:
 *
 *   • `gradeSizes()` regrades the plan against the point actually hit, so pieces
 *     near the contact are small and pieces off the far end are large. It cannot be
 *     baked, so it is called here, once per spawn, before anything is emitted.
 *   • `HULL_ARCHETYPES` are nine convex solids — sliver, wedge, blocky, plate,
 *     shell, splinter, chip, bent panel and a plain box. Each is one InstancedMesh,
 *     so the whole debris field is at most nine draw calls no matter how many
 *     materials are in it: colour, roughness and metalness ride along as
 *     per-instance attributes rather than splitting the batch.
 *
 * Pieces flagged `detach` (wheels, doors, mirrors) get their own harder throw and
 * more spin, so they read as parts coming off rather than as more debris.
 *
 * The impulse model is §10's, in this order, all of it varied by ±25 %:
 *   radial from the impact point, falling off with distance
 * + the PLAYER's velocity at 1.1–1.4×      ← this is what clears debris out of frame
 * + upward bias worth 15–25 % of the horizontal magnitude
 * + angular velocity of 3–12 rad/s on a random axis, NEVER zero.
 * The 1.1–1.4× inheritance is not a flourish: debris that travels slower than the
 * roller ends up in front of the camera, on top of the next formation, which §6.1
 * forbids. It is enforced as a floor on the component along the player's heading,
 * because a radial throw pointed back up the hill can otherwise cancel most of it,
 * and the +Z clamp is the backstop on top of that.
 *
 * Each mesh also carries an `instanceVelocity` `InstancedBufferAttribute`, written
 * in the same pass as the matrices, for the motion-blur pass; fragments are the
 * only things in the game that smear, so the world stays sharp.
 *
 * Lifecycle: full physics for `fragmentLifePhysics`, sleep near rest, then a
 * shrink-and-sink fade over `fragmentLifeFade` (a shrink rather than an alpha fade,
 * so the whole pass stays opaque and needs no sorting). The pool is a `RingPool`
 * capped at `maxFragments`; a spawn that overflows steals the oldest fragments.
 * Fragments spawned beyond `fragmentPhysicsRange` of both the camera and the roller
 * are VISUAL-ONLY: a short ballistic arc, no ground query, no contact, no kills.
 *
 * Nothing allocates after construction.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import { attribute } from 'three/tsl';

import { TUNING } from '../tuning.js';
import { fxRng } from '../core/rng.js';
import { RingPool } from '../core/pool.js';
import { MATERIALS } from '../world/objects.js';
import {
  FRACTURE_MAX_PIECES,
  FRACTURE_VARIANTS,
  HULL_ARCHETYPES,
  MATERIAL_KEYS,
  MATERIAL_PHYSICS,
  fracturePlan,
  gradeSizes,
  makeFracturePlan,
  materialIndex,
} from './fracture.js';

/* ─────────────────────────────────────────────────────── material resolution */

/**
 * Purely internal appearance for a material with no row in `MATERIALS`. Not a
 * balance number, so it lives here rather than in TUNING.
 */
const FALLBACK_MATERIAL = {
  color: 0x8b9096,
  roughness: 0.85,
  metalness: 0.0,
  density: 2000,
};

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

/** Result of `quatMul` — the composed rotation, already normalised. */
let _mqx = 0;
let _mqy = 0;
let _mqz = 0;
let _mqw = 1;

/** a ⊗ b, normalised. Degenerate inputs collapse to identity rather than to zero. */
function quatMul(ax, ay, az, aw, bx, by, bz, bw) {
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  const l = Math.sqrt(x * x + y * y + z * z + w * w);
  if (l < 1e-6) { _mqx = 0; _mqy = 0; _mqz = 0; _mqw = 1; return; }
  const inv = 1 / l;
  _mqx = x * inv; _mqy = y * inv; _mqz = z * inv; _mqw = w * inv;
}

/** Uniform random unit vector, written into these three scalars. */
let _ax = 0;
let _ay = 1;
let _az = 0;
function randomAxis() {
  const z = fxRng.next() * 2 - 1;
  const a = fxRng.next() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  _ax = r * Math.cos(a);
  _ay = r * Math.sin(a);
  _az = z;
}

/** `v` with ±`amount` of proportional variation. §10 asks for ±25 % on everything. */
function vary(v, amount) {
  return v * (1 + fxRng.spread(amount));
}

/** Default ground probe: nothing to land on. */
function noGround() {
  return -Infinity;
}

/** Pool factory — the pool only hands out indices; payload lives in typed arrays. */
const ZERO_SLOT = () => 0;

/** Phase flags. */
const PHASE_PHYSICS = 0;
const PHASE_FADE = 1;

/* ─────────────────────────────────────────────────────────── hull geometries */

/** Triangle scratch for `archetypeGeometry`, sized from the widest archetype. */
const _tri = (() => {
  let widest = 4;
  for (let i = 0; i < HULL_ARCHETYPES.length; i++) {
    const n = HULL_ARCHETYPES[i].vertexCount / 2;
    if (n > widest) widest = n;
  }
  // 2n side triangles + 2(n-2) cap triangles, 3 vertices of 3 floats each
  return new Float32Array((4 * widest - 4) * 9);
})();

/**
 * Turn one of fracture's lofted convex archetypes into renderable geometry.
 *
 * An archetype is two convex rings of `n` points — one at z = -0.5, one at z = +0.5,
 * the second scaled and sheared — so the solid is exactly `2n` side triangles plus a
 * fan across each cap. Building it that way rather than running a hull algorithm
 * keeps the render shape and the collision shape the same solid by construction.
 *
 * Non-indexed, with per-face normals, so the facets stay hard without asking the
 * shader for derivatives (which the WebGL2 fallback would rather not do).
 */
function archetypeGeometry(arch) {
  const src = arch.points;
  const n = arch.vertexCount / 2;

  // Ring winding is not guaranteed by the archetype table, and a reversed ring
  // turns the solid inside out under backface culling.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += src[i * 3] * src[j * 3 + 1] - src[j * 3] * src[i * 3 + 1];
  }
  const flip = area2 < 0;
  const idx = (ring, i) => (ring * n + (flip ? (n - i) % n : i)) * 3;

  let w = 0;
  const push = (o) => { _tri[w++] = src[o]; _tri[w++] = src[o + 1]; _tri[w++] = src[o + 2]; };

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = idx(0, i), b = idx(0, j), c = idx(1, j), d = idx(1, i);
    push(a); push(b); push(c);
    push(a); push(c); push(d);
  }
  for (let i = 1; i < n - 1; i++) {
    push(idx(1, 0)); push(idx(1, i)); push(idx(1, i + 1));
    push(idx(0, 0)); push(idx(0, i + 1)); push(idx(0, i));
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(_tri.slice(0, w), 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Material keys this system can render — every key `MATERIAL_PHYSICS` declares,
 * since a fracture plan can only name those.
 * @returns {string[]}
 */
export function fragmentMaterialKeys() {
  return MATERIAL_KEYS.slice();
}

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
    /** Bounding radius, used for big-piece contact and the secondary-kill probe. */
    this.radius = new Float32Array(cap);
    this.mass = new Float32Array(cap);
    this.age = new Float32Array(cap);
    /** Seconds of physics this fragment gets before it starts fading. */
    this.lifeP = new Float32Array(cap);
    this.deathY = new Float32Array(cap);
    this.restitution = new Float32Array(cap);
    this.friction = new Float32Array(cap);
    /** Which hull archetype — and therefore which InstancedMesh — draws it. */
    this.bucket = new Int32Array(cap);
    /** Which material's colour/roughness/metalness it carries. */
    this.matSlot = new Int32Array(cap);
    this.phase = new Uint8Array(cap);
    this.asleep = new Uint8Array(cap);
    /** 1 while there is no surface under the fragment (it is over a hole). */
    this.hole = new Uint8Array(cap);
    /** 1 = no ground query, no contact, no kills: a pure arc, far from the eye. */
    this.visual = new Uint8Array(cap);
    /** 0 = thrown by the player, 1 = thrown by a fragment. Never goes past 1 (§17). */
    this.gen = new Uint8Array(cap);
    /** 1 = one of the three largest pieces of a PLOW object; collides with its peers. */
    this.big = new Uint8Array(cap);
    /** Monotonic spawn id, so a recycled slot cannot be mistaken for its predecessor. */
    this.spawnId = new Float64Array(cap);
    /** Seconds until this fragment may next ask the world what it is touching. */
    this.probeT = new Float32Array(cap);

    this._spawnCounter = 1;

    // ── the fracture plan, filled and drained once per spawn
    this.plan = makeFracturePlan(
      Math.max(8, FRACTURE_MAX_PIECES | 0, D.fracturePlanCapacity | 0));

    // ── per-material appearance and response, resolved once
    const slots = MATERIAL_KEYS.length + 1;
    this.fallbackSlot = slots - 1;
    this.colR = new Float32Array(slots);
    this.colG = new Float32Array(slots);
    this.colB = new Float32Array(slots);
    this.rough = new Float32Array(slots);
    this.metal = new Float32Array(slots);
    this.restOfSlot = new Float32Array(slots);
    this.fricOfSlot = new Float32Array(slots);
    this.densOfSlot = new Float32Array(slots);

    let maxIdx = 0;
    for (let i = 0; i < MATERIAL_KEYS.length; i++) {
      const mi = materialIndex(MATERIAL_KEYS[i]);
      if (mi > maxIdx) maxIdx = mi;
    }
    /** Physics-material index (from `materialIndex`) → slot. */
    this.slotOfIndex = new Int32Array(maxIdx + 2).fill(this.fallbackSlot);

    for (let s = 0; s < slots; s++) {
      const key = s === this.fallbackSlot ? null : MATERIAL_KEYS[s];
      const look = (key && MATERIALS && MATERIALS[key]) || FALLBACK_MATERIAL;
      const phys = (key && MATERIAL_PHYSICS && MATERIAL_PHYSICS[key]) || null;

      // setHex converts to working (linear) space, which is what a colour attribute
      // feeding colorNode has to carry.
      _color.setHex(look.color !== undefined ? look.color : FALLBACK_MATERIAL.color);
      this.colR[s] = _color.r; this.colG[s] = _color.g; this.colB[s] = _color.b;
      this.rough[s] = look.roughness !== undefined ? look.roughness : 0.85;
      this.metal[s] = look.metalness !== undefined ? look.metalness : 0.0;
      this.restOfSlot[s] = phys && phys.restitution !== undefined
        ? phys.restitution : D.fragmentRestitution;
      this.fricOfSlot[s] = phys && phys.friction !== undefined
        ? phys.friction : D.fragmentFriction;
      this.densOfSlot[s] = phys && phys.density > 0 ? phys.density : FALLBACK_MATERIAL.density;

      if (key !== null) {
        const mi = materialIndex(key);
        if (mi >= 0 && mi < this.slotOfIndex.length) this.slotOfIndex[mi] = s;
      }
    }

    // ── one InstancedMesh per hull archetype
    //
    // Material identity travels as per-instance attributes rather than as separate
    // batches: a mixed-material break-up (a car is paint + glass + rubber in one
    // spawn) would otherwise fragment the debris field into a dozen draw calls.
    const mat = new MeshStandardNodeMaterial();
    mat.colorNode = attribute('fragColour', 'vec3');
    mat.roughnessNode = attribute('fragRough', 'float');
    mat.metalnessNode = attribute('fragMetal', 'float');
    // Debris stays opaque on purpose: the shrink-out keeps the pass sort-free, so a
    // translucent source material is rendered solid here.
    mat.transparent = false;
    mat.opacity = 1;
    this.material = mat;

    this.volumeRatio = new Float32Array(HULL_ARCHETYPES.length);
    this.meshes = new Array(HULL_ARCHETYPES.length);
    this.geometries = new Array(HULL_ARCHETYPES.length);
    this._matArrays = new Array(HULL_ARCHETYPES.length);
    this._velArrays = new Array(HULL_ARCHETYPES.length);
    this._colArrays = new Array(HULL_ARCHETYPES.length);
    this._rghArrays = new Array(HULL_ARCHETYPES.length);
    this._mtlArrays = new Array(HULL_ARCHETYPES.length);
    this._attrs = new Array(HULL_ARCHETYPES.length);
    this._counts = new Int32Array(HULL_ARCHETYPES.length);
    /** Last frame's counts, so an idle bucket does not re-upload its whole buffer. */
    this._prevCounts = new Int32Array(HULL_ARCHETYPES.length);

    const castShadow = D.fragmentCastShadow !== false;

    for (let b = 0; b < HULL_ARCHETYPES.length; b++) {
      const arch = HULL_ARCHETYPES[b];
      this.volumeRatio[b] = arch.volumeRatio > 0 ? arch.volumeRatio : 1;

      const geo = archetypeGeometry(arch);
      const vel = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      const col = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      const rgh = new InstancedBufferAttribute(new Float32Array(cap), 1);
      const mtl = new InstancedBufferAttribute(new Float32Array(cap), 1);
      vel.setUsage(DynamicDrawUsage);
      col.setUsage(DynamicDrawUsage);
      rgh.setUsage(DynamicDrawUsage);
      mtl.setUsage(DynamicDrawUsage);
      geo.setAttribute('instanceVelocity', vel);
      geo.setAttribute('fragColour', col);
      geo.setAttribute('fragRough', rgh);
      geo.setAttribute('fragMetal', mtl);

      const mesh = new InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `fragments:${arch.name}`;
      // The motion-blur pass reads world-space per-instance velocity from here.
      // Fragments are the only things in the game that smear; the world is sharp.
      mesh.instanceVelocity = vel;
      mesh.userData.instanceVelocity = vel;

      this.geometries[b] = geo;
      this.meshes[b] = mesh;
      this._matArrays[b] = mesh.instanceMatrix.array;
      this._velArrays[b] = vel.array;
      this._colArrays[b] = col.array;
      this._rghArrays[b] = rgh.array;
      this._mtlArrays[b] = mtl.array;
      this._attrs[b] = [vel, col, rgh, mtl];
      if (scene) scene.add(mesh);
    }

    // ── the only fragments allowed to touch each other (§10)
    const bigCap = Math.max(2, D.bigCollisionMax | 0);
    this.bigList = new Int32Array(bigCap);
    this.bigIds = new Float64Array(bigCap);
    this.bigCount = 0;

    // ── §17 secondary destruction, driven entirely from outside
    /** @type {null|((x:number,y:number,z:number,r:number)=>object|null)} */
    this.secondaryProbe = null;
    /** @type {null|((record:object)=>void)} */
    this.onSecondaryKill = null;

    // A kill is QUEUED during integration and acted on afterwards. Both halves of
    // acting on one — the handler and the generation-1 debris — go through the ring
    // pool, and a steal reorders `pool.active` underneath the walk that found the
    // kill, which double-integrates whichever fragment the steal relocated.
    const killCap = Math.max(4, (D.secondaryMaxKillsPerFrame | 0) * 2);
    this._killRec = new Array(killCap).fill(null);
    this._killX = new Float32Array(killCap);
    this._killY = new Float32Array(killCap);
    this._killZ = new Float32Array(killCap);
    this._killVX = new Float32Array(killCap);
    this._killVY = new Float32Array(killCap);
    this._killVZ = new Float32Array(killCap);
    this._killCount = 0;

    // ── viewer, for the visual-only range test
    this._hasViewer = false;
    this._camX = 0; this._camY = 0; this._camZ = 0;
    this._eyeX = 0; this._eyeY = 0; this._eyeZ = 0;
  }

  get activeCount() {
    return this.pool.activeCount;
  }

  /* ───────────────────────────────────────────────────────────── wiring (§17) */

  /**
   * @param {(x:number,y:number,z:number,radius:number)=>object|null} fn returns a
   *   live world record a fragment is overlapping, or null. The system never
   *   reaches into the world stream itself; this is the whole seam.
   */
  setSecondaryProbe(fn) {
    this.secondaryProbe = typeof fn === 'function' ? fn : null;
  }

  /**
   * @param {(record:object)=>void} fn called once per record a fragment destroys,
   *   for the game to consume it and credit the weight. The handler must mark the
   *   record dead; this system only throws the debris.
   */
  setSecondaryKillHandler(fn) {
    this.onSecondaryKill = typeof fn === 'function' ? fn : null;
  }

  /**
   * Camera and roller positions, for the visual-only range test. Call once a frame
   * before `update`; until it is called, every fragment gets full physics.
   */
  setViewer(cx, cy, cz, ex, ey, ez) {
    this._camX = cx; this._camY = cy; this._camZ = cz;
    this._eyeX = ex === undefined ? cx : ex;
    this._eyeY = ey === undefined ? cy : ey;
    this._eyeZ = ez === undefined ? cz : ez;
    this._hasViewer = true;
  }

  /* ──────────────────────────────────────────────────────────────── spawning */

  /**
   * Spawn one object's worth of debris.
   *
   * @param {{key?:string, size?:number[], parts?:Array}} def PropDef from world/objects.js
   * @param {number} px object origin X
   * @param {number} py object origin Y (y = 0 of the local fracture space)
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
   * @param {number} [scale=1] the object's authored scale multiplier
   */
  spawn(def, px, py, pz, qx, qy, qz, qw, ix, iy, iz, vx, vy, vz, outcome, scale) {
    if (this._disposed || !def) return;
    this._emit(def, px, py, pz, qx, qy, qz, qw, ix, iy, iz, vx, vy, vz, outcome,
      scale === undefined ? 1 : scale, 0, false);
  }

  /**
   * Debris with no consequences: no ground query, no contact, no kills, a short
   * arc. For anything far from the eye, and for §17's second generation.
   */
  spawnVisual(def, px, py, pz, qx, qy, qz, qw, ix, iy, iz, vx, vy, vz, outcome, scale) {
    if (this._disposed || !def) return;
    this._emit(def, px, py, pz, qx, qy, qz, qw, ix, iy, iz, vx, vy, vz, outcome,
      scale === undefined ? 1 : scale, 1, true);
  }

  /**
   * @param {number} gen 0 = thrown by the player, 1 = thrown by a fragment.
   * @param {boolean} forceVisual skip the range test and go visual-only regardless.
   */
  _emit(def, ox, oy, oz, qx, qy, qz, qw, ix, iy, iz, pvx, pvy, pvz, outcome, scale, gen, forceVisual) {
    const D = TUNING.destruction;

    // normalise the incoming quaternion defensively (a zero quat would collapse
    // every fragment onto the origin)
    let bx = qx || 0, by = qy || 0, bz = qz || 0, bw = qw === undefined ? 1 : qw;
    const ql = Math.sqrt(bx * bx + by * by + bz * bz + bw * bw);
    if (ql < 1e-6) { bx = 0; by = 0; bz = 0; bw = 1; } else {
      const inv = 1 / ql;
      bx *= inv; by *= inv; bz *= inv; bw *= inv;
    }

    const plan = this.plan;
    const variant = FRACTURE_VARIANTS > 1 ? fxRng.int(0, FRACTURE_VARIANTS - 1) : 0;
    let count = 0;
    try {
      count = fracturePlan(def.key, variant, plan) | 0;
    } catch (err) {
      count = 0;
    }
    if (count > plan.count) count = plan.count | 0;
    if (count <= 0) count = this._synthesisePlan(def, plan);
    if (count <= 0) return;

    const objScale = scale > 0 ? scale : 1;

    // §10's size grade: small near the contact, large off the far end. It wants the
    // impact in UNSCALED prop-local space, so un-rotate and un-scale it here.
    quatRotate(-bx, -by, -bz, bw, ix - ox, iy - oy, iz - oz);
    const invS = 1 / objScale;
    gradeSizes(plan, _rvx * invS, _rvy * invS, _rvz * invS);
    const hsx = plan.gsx, hsy = plan.gsy, hsz = plan.gsz;

    const visual = forceVisual || this._isFar(ix, iy, iz);
    const plow = outcome === 'PLOW';
    const soft = outcome === 'PULVERIZE' ? 1 : D.plowImpulseScale;

    const impulse = D.impulseBase * soft;
    const jitter = D.impulseJitter * soft;
    const falloff = D.impulseFalloff > 1e-3 ? D.impulseFalloff : 1e-3;
    const varAmt = D.impulseVariance;
    const inheritLo = D.inheritVelMin;
    const inheritSpan = D.inheritVelMax - D.inheritVelMin;
    const upLo = D.upBiasFracMin;
    const upSpan = D.upBiasFracMax - D.upBiasFracMin;
    const spinLo = D.spinMin;
    const spinSpan = D.spinMax - D.spinMin;
    const scaleJit = D.fragmentScaleJitter;
    const minScale = D.fragmentMinScale;
    const lateral = D.lateralBias;
    const away = D.cameraAwayBias;
    const maxToward = D.maxTowardCamera;
    const fallDepth = TUNING.world.fallY;
    const lifeP = visual ? D.fragmentVisualLifePhysics : D.fragmentLifePhysics;

    // The player's heading, so the inheritance floor below is a projection rather
    // than a -Z special case (the roller carries real lateral velocity).
    const speed = Math.sqrt(pvx * pvx + pvz * pvz);
    const ux = speed > 1e-3 ? pvx / speed : 0;
    const uz = speed > 1e-3 ? pvz / speed : -1;

    const budget = Math.min(count, D.fragmentMaxPerSpawn | 0 || count);
    let emitted = 0;

    // Two passes, so the pieces that carry the read — detachable parts and the three
    // big ones — survive the per-spawn budget however coarse the plan is.
    for (let pass = 0; pass < 2 && emitted < budget; pass++) {
      for (let k = 0; k < count && emitted < budget; k++) {
        const important = plan.detach[k] !== 0 || plan.big[k] !== 0;
        if (pass === 0 ? !important : important) continue;
        emitted++;

        quatRotate(bx, by, bz, bw,
          plan.px[k] * objScale, plan.py[k] * objScale, plan.pz[k] * objScale);
        const wx = ox + _rvx;
        const wy = oy + _rvy;
        const wz = oz + _rvz;

        const i = this.pool.acquire();
        if (i < 0) return;

        // full extents, with a touch of jitter so a tiled fracture is not a grid
        const fsx = Math.max(minScale, 2 * hsx[k] * objScale * (1 + fxRng.spread(scaleJit)));
        const fsy = Math.max(minScale, 2 * hsy[k] * objScale * (1 + fxRng.spread(scaleJit)));
        const fsz = Math.max(minScale, 2 * hsz[k] * objScale * (1 + fxRng.spread(scaleJit)));

        this.px[i] = wx; this.py[i] = wy; this.pz[i] = wz;
        this.sx[i] = fsx; this.sy[i] = fsy; this.sz[i] = fsz;
        this.radius[i] = 0.5 * Math.max(fsx, Math.max(fsy, fsz));

        // ── radial impulse away from the impact point, strongest close in
        let dx = wx - ix;
        let dy = wy - iy;
        let dz = wz - iz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-4) {
          // degenerate: shove it somewhere sensible
          randomAxis();
          dx = _ax; dy = Math.abs(_ay); dz = _az;
        } else {
          const inv = 1 / dist;
          dx *= inv; dy *= inv; dz *= inv;
        }
        const detach = plan.detach[k] !== 0;
        const push = vary(impulse * (0.45 + falloff / (falloff + dist)), varAmt)
          * (detach ? D.detachImpulseScale : 1);
        const inherit = vary(inheritLo + inheritSpan * fxRng.next(), varAmt);

        // Debris must never obscure what is coming (§6.1). Inheriting MORE than the
        // player's velocity is what does the work — anything slower ends up under
        // the camera. A radial throw pointed back up the hill can cancel most of
        // that inheritance (measured: 0.88× the player's speed at worst), so the
        // guarantee is enforced rather than merely intended: the component along
        // the player's heading is floored at `inheritVelMin` of their speed.
        let fvx = dx * push * (1 + lateral) + pvx * inherit + fxRng.spread(jitter);
        let fvz = dz * push + pvz * inherit - away + fxRng.spread(jitter);
        if (speed > 1e-3) {
          const along = fvx * ux + fvz * uz;
          const floorAlong = speed * inheritLo;
          if (along < floorAlong) {
            const add = floorAlong - along;
            fvx += ux * add;
            fvz += uz * add;
          }
        }
        if (fvz > maxToward) fvz = maxToward;
        const horiz = Math.sqrt(fvx * fvx + fvz * fvz);
        const fvy = dy * push + pvy * inherit
          + horiz * vary(upLo + upSpan * fxRng.next(), varAmt)
          + fxRng.spread(jitter * 0.5);

        this.vx[i] = fvx; this.vy[i] = fvy; this.vz[i] = fvz;

        // world orientation = object rotation ⊗ the piece's authored rotation, so a
        // splinter keeps the grain direction the fracture plan gave it
        quatMul(bx, by, bz, bw, plan.qx[k], plan.qy[k], plan.qz[k], plan.qw[k]);
        this.qx[i] = _mqx; this.qy[i] = _mqy; this.qz[i] = _mqz; this.qw[i] = _mqw;

        // §10: angular velocity is never zero. Nothing below ever writes a zero back
        // into it either — a fragment that comes to rest stops integrating rather
        // than having its spin cleared.
        randomAxis();
        const spin = vary(spinLo + spinSpan * fxRng.next(), varAmt)
          * (detach ? D.detachSpinScale : 1);
        this.wx[i] = _ax * spin;
        this.wy[i] = _ay * spin;
        this.wz[i] = _az * spin;

        const slot = this._slotFor(plan.mat[k]);
        const arch = this._archFor(plan.hull[k]);
        this.matSlot[i] = slot;
        this.bucket[i] = arch;
        this.restitution[i] = this.restOfSlot[slot];
        this.friction[i] = this.fricOfSlot[slot];
        this.mass[i] = fsx * fsy * fsz * this.volumeRatio[arch] * this.densOfSlot[slot];

        this.age[i] = 0;
        this.lifeP[i] = lifeP;
        this.phase[i] = PHASE_PHYSICS;
        this.asleep[i] = 0;
        this.hole[i] = 0;
        this.visual[i] = visual ? 1 : 0;
        this.gen[i] = gen;
        this.probeT[i] = fxRng.next() * D.secondaryProbePeriod;
        this.deathY[i] = wy + fallDepth;
        this.spawnId[i] = this._spawnCounter++;

        // Only a PLOW survivor's three biggest pieces are worth colliding: they are
        // the only debris slow enough and large enough to be caught at it.
        const isBig = plow && !visual && plan.big[k] !== 0;
        this.big[i] = isBig ? 1 : 0;
        if (isBig) this._trackBig(i);
      }
    }
  }

  /** Physics-material index → slot, fallback for anything unrecognised. */
  _slotFor(matIdx) {
    const m = matIdx | 0;
    if (m < 0 || m >= this.slotOfIndex.length) return this.fallbackSlot;
    return this.slotOfIndex[m];
  }

  /** Hull archetype id → bucket, clamped so an unknown id draws as a plain box. */
  _archFor(hullId) {
    const h = hullId | 0;
    return h > 0 && h < this.meshes.length ? h : 0;
  }

  /** True when a spawn is far enough from both the camera and the roller to fake. */
  _isFar(x, y, z) {
    if (!this._hasViewer) return false;
    const r = TUNING.destruction.fragmentPhysicsRange;
    const r2 = r * r;
    let dx = x - this._camX, dy = y - this._camY, dz = z - this._camZ;
    if (dx * dx + dy * dy + dz * dz <= r2) return false;
    dx = x - this._eyeX; dy = y - this._eyeY; dz = z - this._eyeZ;
    return dx * dx + dy * dy + dz * dz > r2;
  }

  /** Remember a big piece for the contact pass, evicting the oldest when full. */
  _trackBig(i) {
    const capB = this.bigList.length;
    if (this.bigCount >= capB) {
      for (let n = 1; n < capB; n++) {
        this.bigList[n - 1] = this.bigList[n];
        this.bigIds[n - 1] = this.bigIds[n];
      }
      this.bigCount = capB - 1;
    }
    this.bigList[this.bigCount] = i;
    this.bigIds[this.bigCount] = this.spawnId[i];
    this.bigCount++;
  }

  /**
   * Last resort when a prop has no baked plan: an eighth-of-the-box split, so a
   * missing plan degrades to plain debris rather than to nothing at all.
   * @returns {number} piece count written into `plan`
   */
  _synthesisePlan(def, plan) {
    const size = def.size;
    const w = size && size[0] > 0 ? size[0] : 1.4;
    const h = size && size[1] > 0 ? size[1] : 1.4;
    const d = size && size[2] > 0 ? size[2] : 1.4;
    const key = def.parts && def.parts[0] ? def.parts[0].material : undefined;
    let mi = 0;
    if (key !== undefined) {
      try { mi = materialIndex(key) | 0; } catch (err) { mi = 0; }
    }
    const n = Math.min(8, plan.capacity);
    let k = 0;
    for (let a = 0; a < 2 && k < n; a++) {
      for (let b = 0; b < 2 && k < n; b++) {
        for (let c = 0; c < 2 && k < n; c++) {
          plan.px[k] = (a - 0.5) * w * 0.5;
          plan.py[k] = h * (0.25 + b * 0.5);
          plan.pz[k] = (c - 0.5) * d * 0.5;
          plan.sx[k] = w * 0.22;
          plan.sy[k] = h * 0.22;
          plan.sz[k] = d * 0.22;
          plan.gsx[k] = plan.sx[k]; plan.gsy[k] = plan.sy[k]; plan.gsz[k] = plan.sz[k];
          plan.qx[k] = 0; plan.qy[k] = 0; plan.qz[k] = 0; plan.qw[k] = 1;
          plan.mat[k] = mi < 0 ? 0 : mi;
          plan.hull[k] = 3;                       // 'blocky' — never a tidy cube
          plan.detach[k] = 0;
          plan.big[k] = 0;
          k++;
        }
      }
    }
    plan.count = k;
    return k;
  }

  /* ─────────────────────────────────────────────────────────────── per-frame */

  /** @param {number} dt seconds */
  update(dt) {
    if (this._disposed) return;
    if (!(dt > 0)) dt = 0;
    this._integrate(dt);
    this._flushKills();
    this._resolveBigContacts();
    this._writeInstances();
  }

  _integrate(dt) {
    const D = TUNING.destruction;
    const pool = this.pool;
    const act = pool.active;
    const probe = this.groundY;

    const grav = D.fragmentGravity;
    const drag = D.fragmentDrag;
    const angDrag = D.fragmentAngularDrag;
    const sleepSpeed = D.fragmentSleepSpeed;
    const tFade = D.fragmentLifeFade > 1e-4 ? D.fragmentLifeFade : 1e-4;

    const linDamp = 1 / (1 + drag * dt);
    const angDamp = 1 / (1 + angDrag * dt);

    const secProbe = this.secondaryProbe;
    const secWindow = D.secondaryWindow;
    const secRadius = D.secondaryRadiusScale;
    const secPeriod = D.secondaryProbePeriod;
    const secMinSpeed2 = D.secondaryMinSpeed * D.secondaryMinSpeed;
    const killCap = this._killRec.length;
    let killsLeft = secProbe ? Math.min(D.secondaryMaxKillsPerFrame | 0, killCap) : 0;

    for (let a = pool.activeCount - 1; a >= 0; a--) {
      const i = act[a];

      const age = this.age[i] + dt;
      this.age[i] = age;

      // A fragment still falling through a hole keeps simulating past the physics
      // window — freezing it in mid-air over a chasm would read as a bug — and
      // simply despawns once it is far enough below the road.
      if (age >= this.lifeP[i] && this.hole[i] === 0) {
        if (age - this.lifeP[i] >= tFade) {
          pool.release(i);
          continue;
        }
        this.phase[i] = PHASE_FADE;
        continue;
      }
      if (this.asleep[i] !== 0) continue;

      let x = this.px[i];
      let y = this.py[i];
      let z = this.pz[i];
      let vxi = this.vx[i];
      let vyi = this.vy[i];
      let vzi = this.vz[i];

      vyi += grav * dt;
      vxi *= linDamp; vyi *= linDamp; vzi *= linDamp;

      x += vxi * dt;
      y += vyi * dt;
      z += vzi * dt;

      if (this.visual[i] === 0) {
        // Half-extent of the piece along world Y for its current orientation, from
        // the second row of the rotation matrix. Using an orientation-independent
        // inscribed radius instead lets a flat shard settle with most of its volume
        // sunk into the road, which is very visible once debris comes to rest and
        // never moves again.
        const oqx = this.qx[i];
        const oqy = this.qy[i];
        const oqz = this.qz[i];
        const oqw = this.qw[i];
        const m10 = 2 * (oqx * oqy + oqw * oqz);
        const m11 = 1 - 2 * (oqx * oqx + oqz * oqz);
        const m12 = 2 * (oqy * oqz - oqw * oqx);
        const r = 0.5 * (
          (m10 < 0 ? -m10 : m10) * this.sx[i]
          + (m11 < 0 ? -m11 : m11) * this.sy[i]
          + (m12 < 0 ? -m12 : m12) * this.sz[i]
        );
        const gy = probe(x, z);

        if (gy > -1e30) {
          this.hole[i] = 0;
          const floor = gy + r;
          if (y < floor) {
            y = floor;
            if (vyi < 0) vyi = -vyi * this.restitution[i];
            // Ground friction bleeds the tangential velocity, and drags the spin
            // down with it — but never clears it. See the spawn comment.
            const keep = 1 - this.friction[i] * 0.55;
            vxi *= keep;
            vzi *= keep;
            this.wx[i] *= keep;
            this.wy[i] *= keep;
            this.wz[i] *= keep;
            if (vxi * vxi + vyi * vyi + vzi * vzi < sleepSpeed * sleepSpeed) {
              vxi = 0; vyi = 0; vzi = 0;
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
      }

      this.vx[i] = vxi; this.vy[i] = vyi; this.vz[i] = vzi;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;

      // ── spin: q += 0.5 * dt * (omega ⊗ q), renormalised
      const owx = this.wx[i] * angDamp;
      const owy = this.wy[i] * angDamp;
      const owz = this.wz[i] * angDamp;
      this.wx[i] = owx; this.wy[i] = owy; this.wz[i] = owz;

      const cqx = this.qx[i];
      const cqy = this.qy[i];
      const cqz = this.qz[i];
      const cqw = this.qw[i];
      const h = 0.5 * dt;
      const nqx = cqx + h * (owx * cqw + owy * cqz - owz * cqy);
      const nqy = cqy + h * (owy * cqw + owz * cqx - owx * cqz);
      const nqz = cqz + h * (owz * cqw + owx * cqy - owy * cqx);
      const nqw = cqw - h * (owx * cqx + owy * cqy + owz * cqz);
      const nl = Math.sqrt(nqx * nqx + nqy * nqy + nqz * nqz + nqw * nqw);
      if (nl > 1e-6) {
        const inv = 1 / nl;
        this.qx[i] = nqx * inv; this.qy[i] = nqy * inv;
        this.qz[i] = nqz * inv; this.qw[i] = nqw * inv;
      }

      // ── §17 secondary destruction: for its first 0.6 s a fragment thrown by the
      //    player can shatter paper-tier objects it flies through, and the player is
      //    credited the weight. ONE generation only — the debris that comes off a
      //    secondary kill is visual and cannot kill anything.
      if (killsLeft > 0 && this.gen[i] === 0 && this.visual[i] === 0 && age <= secWindow) {
        const t = this.probeT[i] - dt;
        if (t <= 0) {
          this.probeT[i] = secPeriod;
          if (vxi * vxi + vyi * vyi + vzi * vzi >= secMinSpeed2) {
            const rec = secProbe(x, y, z, this.radius[i] * secRadius);
            if (rec && rec.alive !== false && this._queueKill(rec, x, y, z, vxi, vyi, vzi)) {
              killsLeft--;
            }
          }
        } else {
          this.probeT[i] = t;
        }
      }
    }
  }

  /**
   * Remember a secondary kill until the integration walk is over. Returns false if
   * another fragment already claimed this record THIS frame — without that check the
   * deferral would let two shards be credited for the same object, which the old
   * kill-in-place order prevented by marking it dead on the spot.
   */
  _queueKill(rec, x, y, z, vx, vy, vz) {
    const n = this._killCount;
    if (n >= this._killRec.length) return false;
    for (let k = 0; k < n; k++) if (this._killRec[k] === rec) return false;
    this._killRec[n] = rec;
    this._killX[n] = x; this._killY[n] = y; this._killZ[n] = z;
    this._killVX[n] = vx; this._killVY[n] = vy; this._killVZ[n] = vz;
    this._killCount = n + 1;
    return true;
  }

  /** Act on this frame's secondary kills, now that nothing is walking the pool. */
  _flushKills() {
    const n = this._killCount;
    if (n === 0) return;
    this._killCount = 0;
    for (let k = 0; k < n; k++) {
      const rec = this._killRec[k];
      this._killRec[k] = null;
      if (!rec || rec.alive === false) continue;
      if (this.onSecondaryKill) this.onSecondaryKill(rec);
      this._emitFromRecord(rec, this._killX[k], this._killY[k], this._killZ[k],
        this._killVX[k], this._killVY[k], this._killVZ[k]);
    }
  }

  /** Debris for an object a fragment destroyed. Always visual, always generation 1. */
  _emitFromRecord(rec, ix, iy, iz, vx, vy, vz) {
    const def = rec.def;
    if (!def) return;
    const half = rec.rotY === undefined ? 0 : rec.rotY * 0.5;
    this._emit(def,
      rec.x === undefined ? rec.cx : rec.x,
      rec.y === undefined ? rec.cy : rec.y,
      rec.z === undefined ? rec.cz : rec.z,
      0, Math.sin(half), 0, Math.cos(half),
      ix, iy, iz, vx * 0.5, vy * 0.5, vz * 0.5,
      'PULVERIZE', rec.scale === undefined ? 1 : rec.scale, 1, true);
  }

  /**
   * The one place fragments touch each other: the three largest pieces of a PLOW
   * object, against each other only. Bounded by `bigCollisionMax`, so this is a few
   * hundred distance checks at worst and never scales with the pool.
   */
  _resolveBigContacts() {
    let n = this.bigCount;
    if (n < 2) return;

    // compact away anything retired or recycled since last frame
    let w = 0;
    for (let a = 0; a < n; a++) {
      const i = this.bigList[a];
      if (this.big[i] === 1 && this.spawnId[i] === this.bigIds[a] && this.phase[i] === PHASE_PHYSICS) {
        this.bigList[w] = i;
        this.bigIds[w] = this.bigIds[a];
        w++;
      }
    }
    this.bigCount = w;
    n = w;
    if (n < 2) return;

    const e = TUNING.destruction.bigCollisionRestitution;
    // §6.1 holds for a fragment's whole life, not just its first frame: a contact
    // that flings a big piece back up the hill would send it at the camera.
    const maxToward = TUNING.destruction.maxTowardCamera;
    for (let a = 0; a < n - 1; a++) {
      const i = this.bigList[a];
      for (let b = a + 1; b < n; b++) {
        const j = this.bigList[b];
        let nx = this.px[j] - this.px[i];
        let ny = this.py[j] - this.py[i];
        let nz = this.pz[j] - this.pz[i];
        const d2 = nx * nx + ny * ny + nz * nz;
        const sum = this.radius[i] + this.radius[j];
        if (d2 >= sum * sum || d2 < 1e-8) continue;

        const d = Math.sqrt(d2);
        const inv = 1 / d;
        nx *= inv; ny *= inv; nz *= inv;

        const invI = 1 / (this.mass[i] > 1e-6 ? this.mass[i] : 1e-6);
        const invJ = 1 / (this.mass[j] > 1e-6 ? this.mass[j] : 1e-6);
        const invSum = invI + invJ;

        // positional correction, split by inverse mass
        const pen = sum - d;
        const ki = pen * (invI / invSum);
        const kj = pen * (invJ / invSum);
        this.px[i] -= nx * ki; this.px[j] += nx * kj;
        this.py[i] -= ny * ki; this.py[j] += ny * kj;
        this.pz[i] -= nz * ki; this.pz[j] += nz * kj;

        const rel = (this.vx[j] - this.vx[i]) * nx
          + (this.vy[j] - this.vy[i]) * ny
          + (this.vz[j] - this.vz[i]) * nz;
        if (rel >= 0) continue;

        const imp = -(1 + e) * rel / invSum;
        this.vx[i] -= nx * imp * invI; this.vx[j] += nx * imp * invJ;
        this.vy[i] -= ny * imp * invI; this.vy[j] += ny * imp * invJ;
        this.vz[i] -= nz * imp * invI; this.vz[j] += nz * imp * invJ;

        // a knock always sets something tumbling again
        this.asleep[i] = 0;
        this.asleep[j] = 0;
        this.wx[i] += ny * imp * invI; this.wz[i] -= nx * imp * invI;
        this.wx[j] -= ny * imp * invJ; this.wz[j] += nx * imp * invJ;

        if (this.vz[i] > maxToward) this.vz[i] = maxToward;
        if (this.vz[j] > maxToward) this.vz[j] = maxToward;
      }
    }
  }

  /** Matrices, colour and per-instance velocity: one pass, one flag per attribute. */
  _writeInstances() {
    const D = TUNING.destruction;
    const pool = this.pool;
    const act = pool.active;
    const counts = this._counts;
    const mats = this._matArrays;
    const vels = this._velArrays;
    const cols = this._colArrays;
    const rghs = this._rghArrays;
    const mtls = this._mtlArrays;
    const tFade = D.fragmentLifeFade > 1e-4 ? D.fragmentLifeFade : 1e-4;
    const sink = D.fragmentSink;

    counts.fill(0);

    for (let a = pool.activeCount - 1; a >= 0; a--) {
      const i = act[a];

      let sxi = this.sx[i];
      let syi = this.sy[i];
      let szi = this.sz[i];
      let y = this.py[i];
      let frozen = this.asleep[i] !== 0;

      if (this.phase[i] === PHASE_FADE) {
        const ft = (this.age[i] - this.lifeP[i]) / tFade;
        const k = ft >= 1 ? 0 : 1 - ft;
        // frozen: `py` is never written again, so the sink is a pure function of ft
        y -= sink * ft;
        sxi *= k; syi *= k; szi *= k;
        frozen = true;
      }

      const b = this.bucket[i];
      const slot = counts[b]++;
      const te = mats[b];
      const o = slot * 16;

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
      te[o + 12] = this.px[i];
      te[o + 13] = y;
      te[o + 14] = this.pz[i];
      te[o + 15] = 1;

      const ms = this.matSlot[i];
      const ce = cols[b];
      const co = slot * 3;
      ce[co] = this.colR[ms]; ce[co + 1] = this.colG[ms]; ce[co + 2] = this.colB[ms];
      rghs[b][slot] = this.rough[ms];
      mtls[b][slot] = this.metal[ms];

      // Motion blur reads this. A frozen or sleeping fragment reports zero so it
      // does not smear while sitting still on the road.
      const ve = vels[b];
      const vo = slot * 3;
      if (frozen) {
        ve[vo] = 0; ve[vo + 1] = 0; ve[vo + 2] = 0;
      } else {
        ve[vo] = this.vx[i]; ve[vo + 1] = this.vy[i]; ve[vo + 2] = this.vz[i];
      }
    }

    const prev = this._prevCounts;
    for (let m = 0; m < this.meshes.length; m++) {
      const mesh = this.meshes[m];
      const c = counts[m];
      mesh.count = c;
      mesh.visible = c > 0;
      // one flag per bucket, and only when it actually has (or just had) instances —
      // an idle bucket must not re-upload 16 KB every frame
      if (c > 0 || prev[m] > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        const attrs = this._attrs[m];
        for (let k = 0; k < attrs.length; k++) attrs[k].needsUpdate = true;
      }
      prev[m] = c;
    }
  }

  /* ────────────────────────────────────────────────────────────── lifecycle */

  reset() {
    if (this._disposed) return;
    this.pool.releaseAll();
    this.bigCount = 0;
    for (let k = 0; k < this._killCount; k++) this._killRec[k] = null;
    this._killCount = 0;
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
      this.geometries[m].dispose();
    }
    this.material.dispose();
    this.scene = null;
    this.groundY = noGround;
    this.secondaryProbe = null;
    this.onSecondaryKill = null;
  }
}

export default FragmentSystem;
