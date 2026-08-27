import * as THREE from 'three/webgpu';
import { positionLocal, vec3, vec4, float, mix, smoothstep, abs, uniform } from 'three/tsl';

const CAP = 64;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** Glowing weight tokens. One instanced mesh, tinted per denomination. */
export class PickupRenderer {
  constructor(scene) {
    const geo = new THREE.OctahedronGeometry(0.62, 0);
    this.geo = geo;
    this.material = new THREE.MeshStandardNodeMaterial({
      roughness: 0.25,
      metalness: 0.4,
      emissiveIntensity: 1,
    });
    // Bright core, darker facets — reads as "glowing" without a texture.
    const rim = smoothstep(float(0.15), float(0.62), abs(positionLocal.y));
    this.material.emissiveNode = mix(vec3(1.4, 1.25, 0.5), vec3(0.5, 0.9, 1.3), rim);

    this.mesh = new THREE.InstancedMesh(geo, this.material, CAP);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < CAP; i++) this.mesh.setMatrixAt(i, _zero);
    scene.add(this.mesh);
    this.scene = scene;

    this.free = new Int32Array(CAP);
    for (let i = 0; i < CAP; i++) this.free[i] = CAP - 1 - i;
    this.freeCount = CAP;
    this.highWater = 0;
  }

  alloc() {
    if (this.freeCount === 0) return -1;
    const i = this.free[--this.freeCount];
    if (i + 1 > this.highWater) this.highWater = i + 1;
    return i;
  }

  release(handle) {
    if (handle < 0) return;
    this.mesh.setMatrixAt(handle, _zero);
    this.free[this.freeCount++] = handle;
  }

  set(handle, x, y, z, scale, spin, color) {
    if (handle < 0) return;
    _p.set(x, y, z);
    _e.set(spin * 0.6, spin, spin * 0.35);
    _q.setFromEuler(_e);
    _s.set(scale, scale, scale);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(handle, _m);
    _c.set(color);
    this.mesh.instanceColor.setXYZ(handle, _c.r, _c.g, _c.b);
  }

  flush() {
    this.mesh.count = this.highWater;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  reset() {
    for (let i = 0; i < CAP; i++) {
      this.free[i] = CAP - 1 - i;
      this.mesh.setMatrixAt(i, _zero);
    }
    this.freeCount = CAP;
    this.highWater = 0;
    this.flush();
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.material.dispose();
  }
}
