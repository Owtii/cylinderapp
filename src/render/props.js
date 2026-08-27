import * as THREE from 'three/webgpu';
import { TUNING } from '../tuning.js';
import { PROPS, MATERIALS } from '../world/objects.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * Every prop in the world is an instance. One InstancedMesh per (prop type, part),
 * so a hundred parked cars are two draw calls, not two hundred.
 *
 * Props are static once placed, so an instance matrix is written exactly once at
 * spawn and zeroed once at despawn — nothing touches these buffers per frame.
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
      this.groups.set(key, { def, meshes, free, freeCount: cap, highWater: 0, dirty: false });
    }
  }

  /** @returns {number} instance handle, or -1 if this prop type is saturated. */
  alloc(key) {
    const g = this.groups.get(key);
    if (!g || g.freeCount === 0) return -1;
    const idx = g.free[--g.freeCount];
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

  /** Hide an instance (destroyed or despawned) without releasing the slot. */
  hide(key, handle) {
    const g = this.groups.get(key);
    if (!g || handle < 0) return;
    for (let p = 0; p < g.meshes.length; p++) g.meshes[p].setMatrixAt(handle, _zero);
    g.dirty = true;
  }

  free(key, handle) {
    const g = this.groups.get(key);
    if (!g || handle < 0) return;
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
