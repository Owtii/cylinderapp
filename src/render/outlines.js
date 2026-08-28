import * as THREE from 'three/webgpu';
import { uv, vec3, float, smoothstep } from 'three/tsl';
import { TUNING, classify } from '../tuning.js';
// One definition, in the module that owns the speed model. This was duplicated
// here, which meant a change to the player's speed curve would silently only
// take effect on half the game.
export { speedAtWeight } from '../world/trackplan.js';
import { speedAtWeight } from '../world/trackplan.js';
import { clamp01, clamp, DEG, smoothstep as sstep } from '../core/math.js';

/**
 * TONNAGE — the dynamic outline system (§6, MODULE A).
 *
 * This is the game's whole feedback loop. Every object in front of the player is
 * re-judged against the player's CURRENT weight every single frame and wears the
 * answer as a glow: green you smash clean, amber you plow through, red stops you.
 * As the player absorbs weight the ramp ahead visibly turns red -> amber -> green,
 * and that sweep is the reward.
 *
 * Three rules shape everything in here.
 *
 * 1. THE TRANSITION IS THE POINT. Colours never snap. Each record carries a single
 *    animated scalar `colourT` on a 1-D safety axis — 0 = BLOCKED, 0.5 = PLOW,
 *    1 = CLEAN — damped toward its target at `TUNING.read.outlineLerpRate`. Because
 *    the palette is sampled as a *ramp* along that axis, an object that jumps from
 *    red to green always sweeps through amber on the way, which is exactly the arc
 *    the player is meant to feel.
 *
 * 2. PERMANENT BLOCKERS GET NOTHING. No ring, no halo, not even a dim one. Their
 *    white-on-charcoal striping is their whole signal, and the absence of a glow is
 *    what makes them read as a different CATEGORY of thing rather than "a very red
 *    object". Nobody should die feeling cheated.
 *
 * 3. IT HAS TO WORK IN GREYSCALE. The three colours are chosen so their WCAG
 *    relative luminances separate by far more than the required 12 %:
 *
 *      CLEAN   #4ce882  L = 0.6086   greyscale 205/255
 *      PLOW    #e8901e  L = 0.3720   greyscale 164/255
 *      BLOCKED #d2352c  L = 0.1643   greyscale 113/255
 *
 *      CLEAN vs PLOW    dL 0.2367   38.9 % relative   contrast 1.56:1
 *      PLOW  vs BLOCKED dL 0.2077   55.8 % relative   contrast 1.97:1
 *      CLEAN vs BLOCKED dL 0.4443   73.0 % relative   contrast 3.07:1
 *
 *    Brightness rises monotonically with safety, so with the hue stripped out the
 *    ring still says the same thing: the brighter it burns, the freer the weight.
 *    The shape badges on the labels carry the categorical meaning on their own.
 *
 * Rendering is two InstancedMeshes — one ground ring, one billboarded halo — with
 * per-instance colour, additive, fog-free and depth-write-free. Additive blending
 * is deliberate: it lets the per-instance colour carry the fade as well as the hue
 * (a dimmer colour IS a lower alpha under additive), so a vec3 per instance is all
 * the data the GPU needs and nothing per-frame allocates.
 */

/* ───────────────────────────────────────────────────────────── the palette ── */

/**
 * The canonical outline palette. `src/game/labels.js` imports this so a label and
 * its ring can never disagree. Saturated green/amber/red appear NOWHERE else in
 * the game (§6.1, the colour monopoly).
 *
 * These are NOT the sample hexes written in the contract: those measured 7.6 %
 * apart in luminance between CLEAN and PLOW, which fails the >= 12 % greyscale
 * rule the same paragraph sets. The hues are unchanged; the values are re-picked
 * so green sits high, amber mid and red low on the luminance axis.
 */
export const OUTLINE_COLOURS = {
  CLEAN: 0x4ce882,
  PLOW: 0xe8901e,
  BLOCKED: 0xd2352c,
};

/** The outcome string used for objects that can never be broken. */
export const BLOCKER = 'BLOCKER';

/**
 * Colourblind-safe shape badges (§6.1). These carry the meaning with no hue at
 * all, which is why the game survives being desaturated.
 */
export const OUTLINE_BADGES = {
  CLEAN: '●',      // ● clean smash
  PLOW: '▲',       // ▲ heavy plow
  BLOCKED: '✕',    // ✕ blocked
  BLOCKER: '▮',    // ▮ permanent blocker
};

/**
 * The neutral bone used for permanent blockers. It is outside the monopoly on
 * purpose — near-white at L = 0.8757 (greyscale 241/255), brighter than all
 * three outline colours by at least 30 %, so a blocker chip is unmistakable even
 * in greyscale. Blockers are also the only chip printed dark-on-light: inverted
 * and striped, so it reads as a different KIND of thing, not a fourth outcome.
 */
export const BLOCKER_NEUTRAL = 0xedf1f6;
export const BLOCKER_INK = 0x14171c;

/** Where each outcome sits on the animated 0..1 safety axis. */
export const OUTLINE_T = { BLOCKED: 0, PLOW: 0.5, CLEAN: 1, BLOCKER: 0 };

/**
 * The one place outcomes are decided, so the ring, the halo and the label can
 * never disagree about an object. Mirrors `classify` and adds the permanent case.
 */
export function outcomeFor(obj, playerWeight) {
  if (obj.blocker === true) return BLOCKER;
  return classify(playerWeight, obj.weight);
}

/* Palette in plain sRGB components, so the ramp is interpolated perceptually and
   converted to the renderer's working space exactly once, on write. */
const _rampSrgb = new Float32Array(9);
function loadRamp() {
  const order = [OUTLINE_COLOURS.BLOCKED, OUTLINE_COLOURS.PLOW, OUTLINE_COLOURS.CLEAN];
  for (let i = 0; i < 3; i++) {
    const hex = order[i];
    _rampSrgb[i * 3 + 0] = ((hex >> 16) & 0xff) / 255;
    _rampSrgb[i * 3 + 1] = ((hex >> 8) & 0xff) / 255;
    _rampSrgb[i * 3 + 2] = (hex & 0xff) / 255;
  }
}
loadRamp();

/**
 * Sample the red -> amber -> green ramp at `t` and write it into `out`
 * (a `THREE.Color`, left in the renderer's working colour space).
 *
 * Allocation-free; `intensity` is folded in here because under additive blending
 * brightness and opacity are the same knob.
 */
export function sampleRamp(t, intensity, out) {
  const u = clamp01(t);
  let a = 0;
  let k = u * 2;
  if (u >= 0.5) { a = 3; k = (u - 0.5) * 2; }
  const b = a + 3;
  const r = _rampSrgb[a] + (_rampSrgb[b] - _rampSrgb[a]) * k;
  const g = _rampSrgb[a + 1] + (_rampSrgb[b + 1] - _rampSrgb[a + 1]) * k;
  const bl = _rampSrgb[a + 2] + (_rampSrgb[b + 2] - _rampSrgb[a + 2]) * k;
  out.setRGB(r, g, bl, THREE.SRGBColorSpace);
  if (intensity !== 1) out.multiplyScalar(intensity);
  return out;
}


/* ─────────────────────────────────────────────────── module-level scratch ── */

const GLOW_CAP = 48;                 // hard buffer size; the live cap comes from TUNING

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

/* Bounded top-N selection buffers. Never resized, never reallocated. */
const _selIdx = new Int32Array(GLOW_CAP);
const _selDist = new Float64Array(GLOW_CAP);
const _selSlope = new Float64Array(GLOW_CAP);

/* ──────────────────────────────────────────────────────────── the system ── */

export class OutlineSystem {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this._count = 0;
    this._frame = 1;

    const ringGeo = new THREE.CircleGeometry(1, 48);
    ringGeo.rotateX(-Math.PI / 2);               // lie flat, normal +Y
    const haloGeo = new THREE.PlaneGeometry(1, 1);

    this.ringGeometry = ringGeo;
    this.haloGeometry = haloGeo;
    this.ringMaterial = createRingMaterial();
    this.haloMaterial = createHaloMaterial();

    this.ring = makeGlowMesh(ringGeo, this.ringMaterial, GLOW_CAP);
    this.halo = makeGlowMesh(haloGeo, this.haloMaterial, GLOW_CAP);
    this.ring.renderOrder = 5;
    this.halo.renderOrder = 4;                   // behind the ring in the sorted pass
    scene.add(this.halo);
    scene.add(this.ring);
  }

  /** Number of glow instances written on the last frame. */
  get activeCount() {
    return this._count;
  }

  /**
   * Re-judge every live object against the player's current weight, animate its
   * colour, and write the glow instances for the nearest handful.
   *
   * @param {number} dt seconds
   * @param {Array<object>} objects pooled record array
   * @param {number} count live entries in `objects`
   * @param {number} playerWeight kg
   * @param {THREE.Vector3} cameraPos world position of the camera
   */
  update(dt, objects, count, playerWeight, cameraPos) {
    const R = TUNING.read;
    const frame = this._frame;
    const prevFrame = frame - 1;

    // A tab-switch hands us a huge dt; clamping keeps the lerp a lerp.
    const step = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt;
    const k = 1 - Math.exp(-R.outlineLerpRate * step);

    let cap = R.maxVisibleObjects < GLOW_CAP ? R.maxVisibleObjects : GLOW_CAP;
    if (cap < 0) cap = 0;
    const selecting = this.enabled && cap > 0;
    const speed = speedAtWeight(playerWeight);
    // Seconds of travel turned into metres. Measured from the CAMERA, which trails
    // the player by a fixed dozen-odd metres, so the window is that much more
    // generous than the nominal `fadeInSeconds` — monotonic, stable, and it errs
    // toward showing an object early rather than late.
    const far = R.fadeInSeconds * speed;
    const fadeStart = far * 0.72;
    const fadeSpan = far - fadeStart;
    const camX = cameraPos ? cameraPos.x : 0;
    const camY = cameraPos ? cameraPos.y : 0;
    const camZ = cameraPos ? cameraPos.z : 0;

    let n = 0;

    for (let i = 0; i < count; i++) {
      const obj = objects[i];
      if (!obj || obj.alive === false) continue;

      // ── the judgement, every object, every frame ──────────────────────────
      const outcome = outcomeFor(obj, playerWeight);
      obj.outcome = outcome;
      const target = OUTLINE_T[outcome];

      // An object we did not touch last frame is newly streamed in, so it starts
      // AT its colour rather than sweeping in from red and lying for half a second.
      const t = obj.colourT;
      if (obj._outlineFrame !== prevFrame || typeof t !== 'number') {
        obj.colourT = target;
      } else {
        obj.colourT = t + (target - t) * k;
      }
      obj._outlineFrame = frame;

      if (!selecting) continue;
      if (obj.blocker === true) continue;        // rule 2: no glow, ever
      if (obj.visible === false) continue;

      // Only ahead of the camera: a glow behind you is pure clutter.
      if (obj.z > camZ + 2) continue;

      const dx = obj.x - camX;
      const dy = obj.y - camY;
      const dz = obj.z - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > far * far) continue;

      // Bounded insertion into a nearest-first list. No sort, no allocation.
      if (n === cap && d2 >= _selDist[cap - 1]) continue;
      let pos = n < cap ? n++ : cap - 1;
      while (pos > 0 && _selDist[pos - 1] > d2) {
        _selDist[pos] = _selDist[pos - 1];
        _selIdx[pos] = _selIdx[pos - 1];
        pos--;
      }
      _selDist[pos] = d2;
      _selIdx[pos] = i;
    }

    this._frame = frame + 1;

    if (!selecting || n === 0) {
      this._writeCount(0);
      return;
    }

    // ── local road slope, so a flat ring does not sink into a sloped ramp ────
    //
    // The ramp is piecewise linear and every record carries (d, y) of the ground
    // beneath it, so the nearest neighbour in `d` gives the exact slope of the
    // segment they share. With fewer than two candidates, fall back to the base
    // slope from TUNING — the error over a 3 m ring is centimetres.
    const fallback = TUNING.world.baseSlopeDeg * DEG;
    const slopeMax = TUNING.world.finaleSlopeDeg * DEG * 1.25;
    for (let a = 0; a < n; a++) {
      const oa = objects[_selIdx[a]];
      let best = Infinity;
      let slope = fallback;
      for (let b = 0; b < n; b++) {
        if (b === a) continue;
        const ob = objects[_selIdx[b]];
        let dd = ob.d - oa.d;
        let dyy = ob.y - oa.y;
        if (dd < 0) { dd = -dd; dyy = -dyy; }
        if (dd < 2 || dd >= best) continue;
        best = dd;
        slope = Math.atan2(-dyy, dd);
      }
      _selSlope[a] = clamp(slope, 0, slopeMax);
    }

    // ── write the instances ─────────────────────────────────────────────────
    const ringMat = this.ring.instanceMatrix;
    const haloMat = this.halo.instanceMatrix;
    const ringCol = this.ring.instanceColor;
    const haloCol = this.halo.instanceColor;

    for (let a = 0; a < n; a++) {
      const obj = objects[_selIdx[a]];
      const dist = Math.sqrt(_selDist[a]);

      // Fade in with the object: full strength inside 72 % of the window, gone at
      // the edge of it. Expressed in metres derived from seconds of travel, so the
      // read-ahead stays constant as the player gets faster.
      let fade = 1;
      if (fadeSpan > 0.001 && dist > fadeStart) fade = 1 - sstep((dist - fadeStart) / fadeSpan);
      if (fade <= 0.002) {
        // Collapse the slot rather than skipping it: `count` covers 0..n-1, so a
        // slot left unwritten would still be drawn, carrying last frame's object.
        this.ring.setMatrixAt(a, _zeroMatrix);
        this.halo.setMatrixAt(a, _zeroMatrix);
        continue;
      }

      const ex = obj.ex > 0 ? obj.ex : 0.8;
      const ey = obj.ey > 0 ? obj.ey : 1.0;
      const ez = obj.ez > 0 ? obj.ez : 0.8;
      const foot = ex > ez ? ex : ez;
      const near01 = far > 0.001 ? clamp01(dist / far) : 0;

      // Scale with proximity: a distant ring is grown so it keeps a readable
      // angular size instead of collapsing to a couple of pixels at 200 m.
      let radius = foot * R.outlineRingFootprint + 0.35;
      if (radius < R.outlineRingMinRadius) radius = R.outlineRingMinRadius;
      radius *= 1 + R.outlineDistanceGain * near01;
      if (radius > R.outlineRingMaxRadius) radius = R.outlineRingMaxRadius;

      const slope = _selSlope[a];
      const lift = R.outlineRingLift / Math.cos(slope);

      _e.set(-slope, 0, 0);
      _q.setFromEuler(_e);
      _s.set(radius, 1, radius);
      _p.set(obj.x, obj.y + lift, obj.z);
      _m.compose(_p, _q, _s);
      this.ring.setMatrixAt(a, _m);

      const ringGlow = R.outlineRingIntensity * fade * (1 + R.outlineDistanceBoost * near01);
      sampleRamp(obj.colourT, ringGlow, _col);
      this.ring.setColorAt(a, _col);

      // ── the halo: soft, billboarded, additive, deliberately faint ──────────
      const cx = typeof obj.cx === 'number' ? obj.cx : obj.x;
      const cy = typeof obj.cy === 'number' ? obj.cy : obj.y + ey;
      const cz = typeof obj.cz === 'number' ? obj.cz : obj.z;

      _fwd.set(cx - camX, cy - camY, cz - camZ);
      const len = _fwd.length();
      if (len < 0.0001) _fwd.set(0, 0, 1); else _fwd.multiplyScalar(-1 / len);
      _right.crossVectors(_worldUp, _fwd);
      const rl = _right.length();
      if (rl < 0.0001) _right.set(1, 0, 0); else _right.multiplyScalar(1 / rl);
      _up.crossVectors(_fwd, _right);

      let halo = (foot + ey) * R.outlineHaloScale;
      halo *= 1 + R.outlineDistanceGain * near01 * 0.6;
      _right.multiplyScalar(halo);
      _up.multiplyScalar(halo);
      _fwd.multiplyScalar(halo);
      _m.makeBasis(_right, _up, _fwd);
      _m.setPosition(cx, cy + ey * 0.15, cz);
      this.halo.setMatrixAt(a, _m);

      // Close up the halo would smear across the whole screen, so it bows out.
      const nearCut = sstep(dist / R.outlineNearFadeMetres);
      sampleRamp(obj.colourT, R.outlineHaloIntensity * fade * nearCut, _col);
      this.halo.setColorAt(a, _col);
    }

    this._writeCount(n);
    ringMat.needsUpdate = true;
    haloMat.needsUpdate = true;
    if (ringCol) ringCol.needsUpdate = true;
    if (haloCol) haloCol.needsUpdate = true;
  }

  _writeCount(n) {
    this._count = n;
    this.ring.count = n;
    this.halo.count = n;
  }

  /** Drop every glow. The next `update` rebuilds from scratch. */
  reset() {
    for (let i = 0; i < GLOW_CAP; i++) {
      this.ring.setMatrixAt(i, _zeroMatrix);
      this.halo.setMatrixAt(i, _zeroMatrix);
    }
    this.ring.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
    this._writeCount(0);
    // Bump the frame counter past any stale `_outlineFrame` stamps so every object
    // snaps to its colour on the first frame of the new run instead of sweeping.
    this._frame += 2;
  }

  dispose() {
    if (this.ring.parent) this.ring.parent.remove(this.ring);
    if (this.halo.parent) this.halo.parent.remove(this.halo);
    this.ringGeometry.dispose();
    this.haloGeometry.dispose();
    this.ringMaterial.dispose();
    this.haloMaterial.dispose();
    this.ring.dispose();
    this.halo.dispose();
    this._count = 0;
  }
}

/* ──────────────────────────────────────────────────────────── internals ── */

function makeGlowMesh(geometry, material, cap) {
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Allocate the colour buffer up front: created here it exists before the node
  // material is compiled, so the per-instance colour path is wired in on the
  // first build instead of forcing a recompile on the first coloured frame.
  const colours = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  colours.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = colours;
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _zeroMatrix);
  return mesh;
}

/**
 * A fat, soft annulus with a faint interior wash.
 *
 * The soft interior is not decoration: at 200 m the annulus itself is sub-pixel,
 * and without a filled centre the ring would simply vanish at exactly the range
 * where the player most needs the read.
 */
function createRingMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const d = uv().sub(0.5).length().mul(2.0).toVar();
  const rise = smoothstep(float(0.46), float(0.74), d);
  const fall = smoothstep(float(0.80), float(1.0), d).oneMinus();
  const band = rise.mul(fall).mul(0.95);
  const wash = d.oneMinus().saturate().pow(2.2).mul(0.20);
  mat.colorNode = vec3(band.add(wash));
  return mat;
}

/** A soft radial bloom sitting behind the object. Low, wide, no hard edge. */
function createHaloMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const d = uv().sub(0.5).length().mul(2.0).toVar();
  const body = d.oneMinus().saturate().pow(2.6);
  const core = d.oneMinus().saturate().pow(9.0).mul(0.45);
  mat.colorNode = vec3(body.add(core));
  return mat;
}
