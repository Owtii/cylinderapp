import * as THREE from 'three/webgpu';
import {
  positionLocal, vec2, vec3, vec4, float, mix, smoothstep, abs, fract, floor,
  uniform, length, atan, clamp,
} from 'three/tsl';
import { TUNING } from '../tuning.js';
import { clamp01, moveTowards } from '../core/math.js';

/**
 * The roller: a drum whose axis is world-X, so it rolls like a road roller rather
 * than tipping over like a barrel.
 *
 * The geometry is pre-rotated onto the X axis at build time, which means the roll
 * animation is a single rotation about X and the radial scale stays uniform — no
 * shear, no quaternion bookkeeping per frame.
 *
 * ── the six surfaces ───────────────────────────────────────────────────────────
 * Growth has to feel EARNED, and the only honest way to sell that is to change what
 * the player is driving. The silhouette never changes; the surface escalates once
 * per zone:
 *
 *   0 rusty tin drum · 1 wooden roller · 2 riveted steel · 3 industrial road roller
 *   4 armoured concrete · 5 molten glowing megaton drum
 *
 * All six are authored as separate TSL shading functions and evaluated inside ONE
 * material, blended by a single continuous `uZone` uniform on a hat-function basis:
 * weight_i = clamp01(1 - |uZone - i|). At uZone = 2.4 the drum is 60 % riveted
 * steel and 40 % road roller and nothing else; the weights of two adjacent zones
 * always sum to exactly 1, so no normalisation is needed.
 *
 * `uZone` crawls toward the live zone index at TUNING.roller.zoneBlendRate, so a
 * zone change MORPHS the drum over about a second instead of swapping it in one
 * frame. An instant swap reads as a glitch; a visible morph reads as an upgrade.
 * One material also means one pipeline: six materials would mean six shader builds
 * and a hitch on the first crest, exactly where the game wants the player looking.
 *
 * ── strikes ────────────────────────────────────────────────────────────────────
 * Strikes are the player's health, and the HUD pips live in a screen corner nobody
 * looks at while doing 40 m/s. So the cracks on the drum are the real readout: one
 * fracture network revealed in three widening stages, dark inside the fissure with
 * a bright chipped rim. The rim is what makes it read from behind — a dark line on
 * a dark drum disappears, a dark line with a spalled highlight does not, in any
 * lighting and in greyscale. One uniform crawls toward the strike count so damage
 * visibly SPREADS across the surface rather than popping into place.
 *
 * ── the colour monopoly ────────────────────────────────────────────────────────
 * Saturated green, amber and red belong to the outline system. The "molten" drum is
 * therefore incandescent WHITE-hot with a cold blue-white outer bleed, which is what
 * steel actually looks like at 1500 °C, is more menacing than orange, and separates
 * from everything else on luminance alone so it survives greyscale. The chain-
 * ignition glow is cold white for the same reason. The rust on zone 0 is held to a
 * muted oxide in the same family as the catalogue's `sand` and `wood`.
 */

const TAU = Math.PI * 2;

/* ── TSL helpers ─────────────────────────────────────────────────────────────── */

const fl = (v) => float(v);

/** 0 below `lo`, 1 above `hi`. */
function ramp(x, lo, hi) {
  return smoothstep(fl(lo), fl(hi), x);
}

/** 1 below `lo`, 0 above `hi`. Never relies on a reversed-edge smoothstep. */
function fade(x, lo, hi) {
  return fl(1).sub(smoothstep(fl(lo), fl(hi), x));
}

/** 1 inside [lo,hi], falling off over `soft` on both sides. */
function inRange(x, lo, hi, soft) {
  return ramp(x, lo - soft, lo).mul(fade(x, hi, hi + soft));
}

/** Turns a 0..1 field into ridge lines that peak where the field crosses 0.5. */
function ridge(n) {
  return fl(1).sub(n.mul(2).sub(1).abs());
}

/**
 * Value noise on the drum's unwrapped surface, seamless around the circumference.
 *
 * The x lattice index is taken modulo `period`, so the cell at u = 1 hashes to the
 * same value as the cell at u = 0 and the pattern closes on itself. Without that,
 * every noise-driven feature carries a vertical seam that rotates around the drum
 * as it rolls, which is exactly the artefact the eye locks onto.
 */
function hashCell(ix, iy, period) {
  const x = ix.sub(floor(ix.div(fl(period))).mul(fl(period)));
  return fract(x.mul(127.1).add(iy.mul(311.7)).sin().mul(43758.5453));
}

function noiseWrapped(x, y, period) {
  const ix = floor(x);
  const iy = floor(y);
  const fx = fract(x);
  const fy = fract(y);
  const ux = fx.mul(fx).mul(fx.mul(-2).add(3));
  const uy = fy.mul(fy).mul(fy.mul(-2).add(3));
  const a = hashCell(ix, iy, period);
  const b = hashCell(ix.add(1), iy, period);
  const c = hashCell(ix, iy.add(1), period);
  const d = hashCell(ix.add(1), iy.add(1), period);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

/* ── the drum's shared surface parameterisation ──────────────────────────────── */

/**
 * Every zone shader reads the same handful of fields, computed once.
 *
 * `pv` is a continuous coordinate over the WHOLE surface: it runs 0 → 0.5 from the
 * middle of the barrel out to a rim, then 0.5 → 1.0 from the rim inward to the
 * centre of an end cap. That keeps noise-driven detail — the cracks especially —
 * unbroken where the barrel meets the caps, instead of smearing into radial
 * streaks there. Both ends share the mapping, so detail is mirrored between them;
 * only one cap is ever visible at a time, so that costs nothing and halves the work.
 */
function surfaceFields() {
  const R = TUNING.roller;
  const ax = positionLocal.x;
  const axA = abs(ax);
  const rad = length(positionLocal.yz);
  const u = atan(positionLocal.z, positionLocal.y).mul(1 / TAU).add(0.5);
  const cap = ramp(axA, 0.468, 0.494);
  const barrel = fl(1).sub(cap);
  const pv = axA.add(fl(0.5).sub(rad).max(fl(0)));

  // Circumferential grooves down the barrel — the drum's one constant signature,
  // carried through all six surfaces so the silhouette never stops being "a roller".
  const gsaw = abs(fract(ax.mul(R.grooveCount)).sub(0.5));
  const groove = fade(gsaw, 0.012, 0.055).mul(barrel);

  // Three octaves of wrapped noise, shared by every zone and by the crack field.
  const nA = noiseWrapped(u.mul(6), pv.mul(5), 6);
  const nB = noiseWrapped(u.mul(14), pv.mul(11), 14);
  const nC = noiseWrapped(u.mul(30), pv.mul(24), 30);

  return { ax, axA, rad, u, pv, cap, barrel, groove, nA, nB, nC };
}

/* ── the six surfaces ────────────────────────────────────────────────────────── */
/* All colours are LINEAR — colorNode feeds diffuseColor directly — so they read
   roughly one gamma step darker than the equivalent sRGB hex would suggest. */

/* Each surface returns the four channels the blender needs. This runs once, at
   material build time, so a small object per surface costs nothing at runtime. */
function shade(col, rough, metal, emis) {
  return { col, rough, metal, emis };
}

/** 0 — rusty tin drum. Thin corrugated sheet and oxide blooms. Nothing to fear. */
function zoneTin(F) {
  const corr = F.ax.mul(34 * TAU).sin().mul(0.5).add(0.5);
  const tin = vec3(0.230, 0.246, 0.258).mul(corr.mul(0.20).add(0.82));
  const oxide = mix(vec3(0.196, 0.152, 0.121), vec3(0.318, 0.258, 0.204),
    ramp(F.nC, 0.35, 0.85));
  const rust = ramp(F.nA, 0.42, 0.76);
  const dents = fade(F.nB, 0.55, 0.95).mul(0.14).add(0.86);
  const col = mix(tin, oxide, rust).mul(dents).mul(F.groove.mul(-0.22).add(1.0));
  return shade(col, mix(fl(0.60), fl(0.96), rust), mix(fl(0.52), fl(0.05), rust),
    vec3(0, 0, 0));
}

/** 1 — wooden roller. Staves and iron hoops: a garden roller that got serious. */
function zoneWood(F) {
  const sv = fract(F.u.mul(20));
  const stave = sv.min(fl(1).sub(sv));
  const seam = fade(stave, 0.010, 0.048);
  const grain = noiseWrapped(F.u.mul(40), F.pv.mul(3), 40);
  const wood = mix(vec3(0.396, 0.313, 0.209), vec3(0.238, 0.184, 0.118),
    ramp(grain, 0.30, 0.82).mul(0.75));
  const hoop = inRange(F.axA, 0.300, 0.368, 0.012).max(inRange(F.axA, 0.440, 0.474, 0.010));
  const iron = vec3(0.118, 0.126, 0.138);
  let col = mix(wood, vec3(0.088, 0.066, 0.042), seam.mul(0.9));
  col = mix(col, iron, hoop.mul(F.barrel));
  col = mix(col, iron.mul(1.4), F.cap);
  const hard = hoop.max(F.cap);
  return shade(col, mix(fl(0.90), fl(0.52), hard), mix(fl(0.02), fl(0.62), hard),
    vec3(0, 0, 0));
}

/** 2 — riveted steel. Plate seams and rivet rows: the first properly heavy drum. */
function zoneRiveted(F) {
  const pu = fract(F.u.mul(4));
  const pw = fract(F.pv.mul(4));
  const edge = pu.min(fl(1).sub(pu)).min(pw.min(fl(1).sub(pw)));
  const seam = fade(edge, 0.010, 0.030);
  const nearSeam = fade(edge, 0.030, 0.075);

  const rx = fract(F.u.mul(48)).sub(0.5);
  const ry = fract(F.pv.mul(20)).sub(0.5);
  const rivet = fade(length(vec2(rx, ry)), 0.15, 0.26).mul(nearSeam);

  const steel = vec3(0.254, 0.290, 0.328).mul(ramp(F.nB, 0.2, 0.9).mul(0.16).add(0.88));
  let col = mix(steel, vec3(0.062, 0.070, 0.084), seam.mul(0.85));
  col = mix(col, vec3(0.420, 0.455, 0.500), rivet.mul(0.85));
  col = mix(col, col.mul(0.55), F.groove.mul(0.7));
  return shade(col, mix(fl(0.46), fl(0.28), rivet).add(seam.mul(0.20)),
    mix(fl(0.74), fl(0.35), seam), vec3(0, 0, 0));
}

/** 3 — industrial road roller. Polished compactor shell, machined rings, scuffed. */
function zoneRoadRoller(F) {
  const scuff = noiseWrapped(F.u.mul(20), F.pv.mul(2), 20);
  const polished = vec3(0.402, 0.424, 0.452).mul(ramp(scuff, 0.15, 0.95).mul(0.20).add(0.86));
  const rings = inRange(F.axA, 0.392, 0.424, 0.008).max(inRange(F.axA, 0.448, 0.466, 0.006));
  let col = mix(polished, vec3(0.128, 0.136, 0.150), rings.mul(F.barrel).mul(0.9));
  col = mix(col, col.mul(0.42), F.groove.mul(0.55));
  col = mix(col, vec3(0.176, 0.186, 0.200), F.cap.mul(fade(F.rad, 0.14, 0.30)));
  return shade(col, mix(fl(0.18), fl(0.55), rings.max(F.groove)), fl(0.94), vec3(0, 0, 0));
}

/** 4 — armoured concrete. Bevelled cast plates, deep joints, aggregate speckle. */
function zoneArmour(F) {
  const pu = fract(F.u.mul(8));
  const pw = fract(F.pv.mul(4));
  const edge = pu.min(fl(1).sub(pu)).min(pw.min(fl(1).sub(pw)));
  const joint = fade(edge, 0.018, 0.042);
  const bevel = inRange(edge, 0.045, 0.098, 0.028);
  const aggregate = ramp(F.nC, 0.52, 0.92).mul(0.16);
  const dirt = ramp(F.nA, 0.35, 0.90).mul(0.13);

  const concrete = vec3(0.323, 0.323, 0.301)
    .add(vec3(aggregate, aggregate, aggregate))
    .sub(vec3(dirt, dirt, dirt.mul(0.8)));
  let col = mix(concrete, vec3(0.072, 0.075, 0.072), joint.mul(0.92));
  col = mix(col, concrete.mul(1.28), bevel.mul(0.55));
  col = mix(col, vec3(0.150, 0.158, 0.170), F.cap.mul(0.55));
  return shade(col, mix(fl(0.96), fl(0.62), F.cap), mix(fl(0.03), fl(0.45), F.cap),
    vec3(0, 0, 0));
}

/** 5 — molten megaton drum. Black slag over a white-hot fissure network. */
function zoneMolten(F) {
  const fis = ridge(F.nB.mul(0.6).add(F.nC.mul(0.4)));
  const heat = clamp(
    ramp(fis, 0.80, 1.0).add(F.groove.mul(0.5)).add(ramp(F.nA, 0.86, 1.0).mul(0.3)),
    fl(0), fl(1),
  );
  const hot = mix(vec3(0.38, 0.46, 0.62), vec3(1.00, 0.94, 0.86), ramp(heat, 0.22, 0.95));
  const slag = mix(vec3(0.021, 0.023, 0.027), vec3(0.062, 0.066, 0.074), ramp(F.nA, 0.30, 0.85));
  const col = mix(slag, hot, ramp(heat, 0.28, 0.86).mul(0.92));
  const emis = hot.mul(heat.mul(heat)).mul(TUNING.roller.moltenEmissive);
  return shade(col, mix(fl(0.72), fl(0.36), heat), fl(0.30), emis);
}

const ZONE_SHADERS = [zoneTin, zoneWood, zoneRiveted, zoneRoadRoller, zoneArmour, zoneMolten];

/* ── material ────────────────────────────────────────────────────────────────── */

function createRollerMaterial(uZone, uCrack, uIgnite) {
  const R = TUNING.roller;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.5 });
  const F = surfaceFields();

  let col = vec3(0, 0, 0);
  let emis = vec3(0, 0, 0);
  let rough = fl(0);
  let metal = fl(0);
  for (let i = 0; i < ZONE_SHADERS.length; i++) {
    const w = clamp(fl(1).sub(uZone.sub(fl(i)).abs()), fl(0), fl(1));
    const s = ZONE_SHADERS[i](F);
    col = col.add(s.col.mul(w));
    emis = emis.add(s.emis.mul(w));
    rough = rough.add(s.rough.mul(w));
    metal = metal.add(s.metal.mul(w));
  }
  const moltenWeight = clamp(fl(1).sub(uZone.sub(fl(5)).abs()), fl(0), fl(1));

  // ── strike cracks ──────────────────────────────────────────────────────────
  // ONE fracture network, revealed in three widening stages. `region` is the
  // low-frequency field that decides WHERE damage starts, so each new strike
  // spreads the same cracks further outward and widens what is already there,
  // instead of drawing an unrelated new set on top. Damage that grows reads as
  // the same drum getting worse; three separate patterns read as three decals.
  const region = F.nA;
  const fine = ridge(F.nB.mul(0.62).add(F.nC.mul(0.38)));
  const coarse = ridge(F.nA);
  const grow = (cov, span) => ramp(cov.mul(fl(span)).sub(region), 0.0, 0.22);

  const c1 = clamp(uCrack, fl(0), fl(1));
  const c2 = clamp(uCrack.sub(1), fl(0), fl(1));
  const c3 = clamp(uCrack.sub(2), fl(0), fl(1));
  const m1 = grow(c1, 0.55);
  const m2 = grow(c2, 0.82);
  const m3 = grow(c3, 1.08);
  const mAny = m1.max(m2).max(m3);

  const crack = clamp(
    ramp(fine, 0.968, 1.0).mul(m1)
      .max(ramp(fine, 0.944, 0.998).mul(m2))
      .max(ramp(fine, 0.912, 0.992).mul(m3))
      .max(ramp(coarse, 0.905, 1.0).mul(m3)),
    fl(0), fl(1),
  );
  // The chipped, spalled lip either side of a fissure. This is what makes damage
  // readable from behind at speed — far more than the dark line itself.
  const rim = ramp(fine, 0.870, 0.950).sub(crack).max(fl(0)).mul(mAny).mul(0.9);

  col = mix(col, vec3(R.crackDepthTint, R.crackDepthTint, R.crackDepthTint * 1.06), crack);
  col = mix(col, col.mul(R.crackRimLift).add(vec3(0.05, 0.05, 0.055)), rim.mul(0.85));
  rough = mix(rough, fl(0.95), crack.max(rim));
  metal = metal.mul(fl(1).sub(crack.mul(0.9)));
  emis = emis.add(vec3(0.80, 0.84, 0.92).mul(rim).mul(R.crackEmissive));
  // A fractured molten drum bleeds light out of its own fissures.
  emis = emis.add(vec3(1.00, 0.94, 0.86).mul(crack).mul(moltenWeight).mul(0.9));

  // ── chain ignition ─────────────────────────────────────────────────────────
  // White-hot arc energy in the grooves. Deliberately NOT fire-coloured: orange
  // would collide with the amber the outline system owns.
  emis = emis.add(vec3(0.88, 0.93, 1.00).mul(F.groove).mul(uIgnite).mul(R.igniteEmissive));
  col = col.add(vec3(0.05, 0.055, 0.07).mul(uIgnite).mul(F.groove));

  mat.colorNode = vec4(col, 1.0);
  mat.roughnessNode = clamp(rough, fl(0.04), fl(1));
  mat.metalnessNode = clamp(metal, fl(0), fl(1));
  mat.emissiveNode = emis;
  return mat;
}

/* ── the roller ──────────────────────────────────────────────────────────────── */

export class Roller {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 1, false);
    geo.rotateZ(-Math.PI / 2); // axis: +Y -> +X
    this.geometry = geo;

    this.uZone = uniform(0);
    this.uCrack = uniform(0);
    this.uIgnite = uniform(0);
    this.material = createRollerMaterial(this.uZone, this.uCrack, this.uIgnite);

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.scene = scene;

    // The caller may or may not have a dt to hand (it passes interpolated render
    // state). When it does not, the blend clock is measured here. Either way it is
    // clamped, so a tab-out cannot jump the drum a whole zone in one frame.
    this._lastT = -1;
  }

  /**
   * @param {number} radius        drum radius, metres
   * @param {number} width         full length along the drum axis, metres
   * @param {number} roll          accumulated roll angle, radians
   * @param {number} zoneIndex     0..5, selects the surface
   * @param {number} strikes       0..3, drives the crack stages
   * @param {boolean} chainIgnited chain has reached TUNING.score.chainIgniteAt
   * @param {number} [dt]          optional real seconds since the last frame
   */
  update(x, y, z, radius, width, roll, zoneIndex, strikes, chainIgnited, dt) {
    const R = TUNING.roller;
    const now = performance.now();
    let h = dt;
    if (!(h >= 0)) {
      h = this._lastT >= 0 ? (now - this._lastT) * 0.001 : 0;
    }
    if (h < 0) h = 0;
    else if (h > 0.1) h = 0.1;
    this._lastT = now;

    const zTarget = zoneIndex > 0 ? (zoneIndex > 5 ? 5 : zoneIndex) : 0;
    this.uZone.value = moveTowards(this.uZone.value, zTarget, R.zoneBlendRate * h);

    const sTarget = strikes > 0 ? (strikes > 3 ? 3 : strikes) : 0;
    this.uCrack.value = moveTowards(this.uCrack.value, sTarget, R.crackSpreadRate * h);

    this.uIgnite.value = moveTowards(this.uIgnite.value, chainIgnited ? 1 : 0, R.igniteRate * h);

    this.mesh.position.set(x, y, z);
    this.mesh.scale.set(width, radius * 2, radius * 2);
    this.mesh.rotation.set(roll, 0, 0);
  }

  reset() {
    this.uZone.value = 0;
    this.uCrack.value = 0;
    this.uIgnite.value = 0;
    this._lastT = -1;
    this.mesh.rotation.set(0, 0, 0);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** The blend weight of surface `i` at a continuous zone position. Exported for tools. */
export function surfaceWeight(i, zoneBlend) {
  return clamp01(1 - Math.abs(zoneBlend - i));
}
