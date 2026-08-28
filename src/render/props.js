import * as THREE from 'three/webgpu';
import { TUNING } from '../tuning.js';
import { PROPS, MATERIALS } from '../world/objects.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pitchAxis = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);

// No prop in the catalogue has more than six parts; the scratch buffer that holds
// their projections onto the impact axis is sized well past that and clamped, so a
// future twelve-part prop degrades to "the first sixteen parts crush" rather than
// allocating in the middle of an impact.
const MAX_PARTS = 16;
const _proj = new Float32Array(MAX_PARTS);

/**
 * Every prop in the world is an instance. One InstancedMesh per (prop type, part),
 * so a hundred parked cars are two draw calls, not two hundred.
 *
 * Props are static once placed, so an instance matrix is written exactly once at
 * spawn and zeroed once at despawn — nothing touches these buffers per frame. The
 * two exceptions both write only the handful of instances that are actually moving:
 * traffic, which re-`place`s itself, and the squash (§10), which spends four to six
 * frames crushing one object before it is swapped for fragments.
 */
export class PropRenderer {
  constructor(scene) {
    this.scene = scene;
    this.materials = createMaterials();
    this.groups = new Map();

    const box = new THREE.BoxGeometry(1, 1, 1);
    const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
    this.geometries = { box, cyl };

    for (const key of Object.keys(PROPS)) {
      const def = PROPS[key];
      const cap = TUNING.gfx.instanceCapPerProp;
      const meshes = [];
      for (let p = 0; p < def.parts.length; p++) {
        const part = def.parts[p];
        const geo = this.geometries[part.geo] || box;
        const mat = this.materials[part.material] || this.materials.__fallback;
        const im = new THREE.InstancedMesh(geo, mat, cap);
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.count = 0;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        for (let i = 0; i < cap; i++) im.setMatrixAt(i, _zero);
        scene.add(im);
        meshes.push(im);
      }
      // Lowest-index-first free list keeps the live range compact.
      const free = new Int32Array(cap);
      for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;
      this.groups.set(key, {
        def, meshes, free, freeCount: cap, used: new Uint8Array(cap),
        highWater: 0, dirty: false,
      });
    }
  }

  /** @returns {number} instance handle, or -1 if this prop type is saturated. */
  alloc(key) {
    const g = this.groups.get(key);
    if (!g || g.freeCount === 0) return -1;
    const idx = g.free[--g.freeCount];
    g.used[idx] = 1;
    if (idx + 1 > g.highWater) g.highWater = idx + 1;
    g.dirty = true;
    return idx;
  }

  /** Write the world transform for every part of one prop instance. */
  place(key, handle, x, y, z, rotY, scale) {
    const g = this.groups.get(key);
    if (!g || handle < 0) return;
    const def = g.def;
    _qp.setFromAxisAngle(_yAxis, rotY);
    for (let p = 0; p < def.parts.length; p++) {
      const part = def.parts[p];
      // local part offset, rotated by the prop's yaw
      _p.set(part.pos[0] * scale, part.pos[1] * scale, part.pos[2] * scale);
      _p.applyQuaternion(_qp);
      _p.x += x; _p.y += y; _p.z += z;
      if (part.rot) {
        _e.set(part.rot[0], part.rot[1], part.rot[2]);
        _q.setFromEuler(_e);
        _q.premultiply(_qp);
      } else {
        _q.copy(_qp);
      }
      _s.set(part.scale[0] * scale, part.scale[1] * scale, part.scale[2] * scale);
      _m.compose(_p, _q, _s);
      g.meshes[p].setMatrixAt(handle, _m);
    }
    g.dirty = true;
  }

  /**
   * Crush one instance along a world-space impact axis (§10 — the squash).
   *
   * The brief asks for morph targets. Morph targets do not exist per-instance on an
   * InstancedMesh, and giving them up would cost the whole reason props are
   * instanced. What replaces them reads the same and is free: every part is already
   * its own instance, so composing each part's matrix with a non-uniform scale along
   * the impact axis plus a sink toward the face that was hit gives a genuine
   * multi-part crumple — the roof drops, the panels shear and splay — at zero extra
   * draw calls and zero extra geometry.
   *
   * Four things happen to each part, in this order:
   *   1. it slides toward the impact face by `u * k`, where u is its distance from
   *      that face — so the object folds up rather than translating;
   *   2. it splays outward, exactly orthogonal to the axis, because the volume the
   *      crush removes has to go somewhere;
   *   3. it settles: height above the base is scaled down, so the roof drops
   *      furthest and the chassis barely moves;
   *   4. its geometry is squashed along the axis in place, by scaling the axial
   *      component of the three basis columns of its composed matrix.
   *
   * `k` is per part, not global: `squashNearBias` makes parts near the contact crush
   * harder, and `squashStagger` makes them start earlier, so the crumple propagates
   * through the object instead of the whole thing deflating at once.
   *
   * Two deliberate constraints keep the measured compression honest. The splay is
   * projected back onto the plane orthogonal to the axis, and the rotational
   * component is mostly a ROLL about the impact axis — neither can change the
   * object's extent along that axis. The measured compression is therefore bounded
   * by `k`'s own range, `squashCompression` to `squashCompression * (1 +
   * squashNearBias)`, which is what keeps every prop in §10's 30–45 % band without
   * a per-prop table.
   *
   * @param {number} t     eased crush progress, 0..1 (the caller owns the easing)
   * @param {number} kMax  peak compression fraction along the axis
   * @param {number} seed  per-object integer, so one wreck always crumples the same way
   */
  crush(key, handle, x, y, z, rotY, scale, ax, ay, az, t, kMax, seed) {
    const g = this.groups.get(key);
    if (!g || handle < 0) return;
    const D = TUNING.destruction;
    const parts = g.def.parts;
    const n = parts.length < MAX_PARTS ? parts.length : MAX_PARTS;

    // A zero-length axis would collapse the object to a plane. Fall back to the
    // direction of travel, which is what the axis is nine times in ten anyway.
    let len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-5) { ax = 0; ay = 0; az = -1; len = 1; }
    const ix = ax / len, iy = ay / len, iz = az / len;
    _axis.set(ix, iy, iz);

    // Pitch axis: horizontal and perpendicular to the impact axis. Degenerate only
    // for a perfectly vertical impact, which nothing in the game produces.
    const px = -iz, pz = ix;
    const plen = Math.sqrt(px * px + pz * pz);
    if (plen > 1e-4) _pitchAxis.set(px / plen, 0, pz / plen);
    else _pitchAxis.set(1, 0, 0);

    _qp.setFromAxisAngle(_yAxis, rotY);

    // Project every part onto the axis first: u = 0 is the face the roller touched,
    // u = span the far end. "Near the impact" has no meaning until this is known.
    let lo = Infinity, hi = -Infinity;
    for (let p = 0; p < n; p++) {
      const part = parts[p];
      _p.set(part.pos[0] * scale, part.pos[1] * scale, part.pos[2] * scale);
      _p.applyQuaternion(_qp);
      const u = _p.x * ix + _p.y * iy + _p.z * iz;
      _proj[p] = u;
      if (u < lo) lo = u;
      if (u > hi) hi = u;
    }
    const span = hi - lo > 1e-4 ? hi - lo : 1e-4;

    for (let p = 0; p < n; p++) {
      const part = parts[p];
      const u = _proj[p] - lo;
      const v = u / span;

      const delay = D.squashStagger * v;
      let tp = (t - delay) / (1 - delay);
      if (tp < 0) tp = 0; else if (tp > 1) tp = 1;
      let k = kMax * (1 + D.squashNearBias * (1 - v)) * tp;
      if (k > D.squashMaxPartCrush) k = D.squashMaxPartCrush;

      _p.set(part.pos[0] * scale, part.pos[1] * scale, part.pos[2] * scale);
      _p.applyQuaternion(_qp);

      // 1. fold toward the impact face
      const shift = u * k;
      _p.x -= ix * shift; _p.y -= iy * shift; _p.z -= iz * shift;

      // 2. splay, with the axial component projected back out so displaced volume
      //    can never fight the compression the crush is being measured on
      const d = _p.x * ix + _p.y * iy + _p.z * iz;
      const sx = (_p.x - ix * d) * D.squashSplay * k;
      const sz = (_p.z - iz * d) * D.squashSplay * k;
      const sa = sx * ix + sz * iz;
      _p.x += sx - ix * sa; _p.y -= iy * sa; _p.z += sz - iz * sa;

      // 3. settle onto the road — proportional to height, so the roof goes first
      _p.y -= _p.y * D.squashSink * k;

      _p.x += x; _p.y += y; _p.z += z;

      if (part.rot) {
        _e.set(part.rot[0], part.rot[1], part.rot[2]);
        _q.setFromEuler(_e);
        _q.premultiply(_qp);
      } else {
        _q.copy(_qp);
      }
      // A pure scale reads as a deflating balloon. The roll is what makes it read as
      // metal buckling, and rolling about the impact axis is the one rotation that
      // costs nothing in axial extent.
      _qc.setFromAxisAngle(_axis, D.squashRoll * k * jitter(seed, p));
      _qt.setFromAxisAngle(_pitchAxis, D.squashPitch * k * jitter(seed + 1013, p));
      _qc.premultiply(_qt);
      _q.premultiply(_qc);

      _s.set(part.scale[0] * scale, part.scale[1] * scale, part.scale[2] * scale);
      _m.compose(_p, _q, _s);

      // 4. the crush proper: scale the axial component of the linear part, leaving
      //    the translation alone, so the part squashes about its own new centre.
      const el = _m.elements;
      crushColumn(el, 0, ix, iy, iz, k);
      crushColumn(el, 4, ix, iy, iz, k);
      crushColumn(el, 8, ix, iy, iz, k);

      g.meshes[p].setMatrixAt(handle, _m);
    }
    g.dirty = true;
  }

  /** Hide an instance (destroyed or despawned) without releasing the slot. */
  hide(key, handle) {
    const g = this.groups.get(key);
    if (!g || handle < 0) return;
    for (let p = 0; p < g.meshes.length; p++) g.meshes[p].setMatrixAt(handle, _zero);
    g.dirty = true;
  }

  /**
   * Release a slot.
   *
   * The `used` guard is not defensive clutter: handles now change hands. The
   * streamer hands one to the squash, which hands it to a wreck that outlives the
   * object it came from, and a run reset tears all three down in whatever order the
   * callers happen to run in. Returning the same handle twice would put a duplicate
   * in the free list and hand two owners the same instance, which shows up much
   * later as one prop wearing another prop's transform.
   */
  free(key, handle) {
    const g = this.groups.get(key);
    if (!g || handle < 0 || !g.used[handle]) return;
    g.used[handle] = 0;
    this.hide(key, handle);
    g.free[g.freeCount++] = handle;
  }

  /** Upload any changed instance buffers. Called once per frame. */
  flush() {
    for (const g of this.groups.values()) {
      if (!g.dirty) continue;
      for (let p = 0; p < g.meshes.length; p++) {
        g.meshes[p].count = g.highWater;
        g.meshes[p].instanceMatrix.needsUpdate = true;
      }
      g.dirty = false;
    }
  }

  reset() {
    for (const g of this.groups.values()) {
      const cap = g.free.length;
      for (let i = 0; i < cap; i++) g.free[i] = cap - 1 - i;
      g.freeCount = cap;
      g.used.fill(0);
      g.highWater = 0;
      for (let p = 0; p < g.meshes.length; p++) {
        for (let i = 0; i < cap; i++) g.meshes[p].setMatrixAt(i, _zero);
      }
      g.dirty = true;
    }
    this.flush();
  }

  dispose() {
    for (const g of this.groups.values()) {
      for (const m of g.meshes) {
        this.scene.remove(m);
        m.dispose();
      }
    }
    this.groups.clear();
    this.geometries.box.dispose();
    this.geometries.cyl.dispose();
    for (const k of Object.keys(this.materials)) this.materials[k].dispose();
  }
}

/** Scale the axial component of one basis column of a composed matrix. */
function crushColumn(e, o, ax, ay, az, k) {
  const d = k * (e[o] * ax + e[o + 1] * ay + e[o + 2] * az);
  e[o] -= ax * d; e[o + 1] -= ay * d; e[o + 2] -= az * d;
}

/** Deterministic -1..1 per (object seed, part index) — one wreck, one shape. */
function jitter(seed, p) {
  let h = Math.imul(seed | 0, 374761393) + Math.imul(p + 1, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h >>> 9) & 0xffff) / 32767.5 - 1;
}

export function createMaterials() {
  const out = {};
  for (const key of Object.keys(MATERIALS)) {
    const m = MATERIALS[key];
    const mat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(m.color),
      roughness: m.roughness ?? 0.7,
      metalness: m.metalness ?? 0,
    });
    if (m.emissive !== undefined) {
      mat.emissive = new THREE.Color(m.emissive);
      mat.emissiveIntensity = m.emissiveIntensity ?? 1;
    }
    out[key] = mat;
  }
  out.__fallback = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x8a8f96), roughness: 0.8, metalness: 0.1,
  });
  return out;
}
