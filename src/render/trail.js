import * as THREE from 'three/webgpu';
import { attribute, vec3, vec4, float, smoothstep, fract, abs, mix, step } from 'three/tsl';

const SAMPLES = 180;
const MIN_STEP = 1.1;   // metres between samples

/**
 * The flattened, scorched strip the roller leaves behind.
 *
 * A ring buffer of path samples rendered as one triangle strip. Players love
 * seeing where they have been, and it costs one 180-quad mesh.
 */
export class Trail {
  constructor(scene) {
    const positions = new Float32Array(SAMPLES * 2 * 3);
    const ages = new Float32Array(SAMPLES * 2);
    const across = new Float32Array(SAMPLES * 2);
    const indices = new Uint16Array((SAMPLES - 1) * 6);
    for (let i = 0; i < SAMPLES - 1; i++) {
      const a = i * 2;
      indices[i * 6 + 0] = a;
      indices[i * 6 + 1] = a + 1;
      indices[i * 6 + 2] = a + 2;
      indices[i * 6 + 3] = a + 1;
      indices[i * 6 + 4] = a + 3;
      indices[i * 6 + 5] = a + 2;
    }
    for (let i = 0; i < SAMPLES; i++) {
      across[i * 2] = -1;
      across[i * 2 + 1] = 1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aAge', new THREE.BufferAttribute(ages, 1));
    geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = geo;
    this.positions = positions;
    this.ages = ages;

    this.material = createTrailMaterial();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    this.scene = scene;

    // Ring buffer of samples: x, y, z, halfWidth
    this.sx = new Float32Array(SAMPLES);
    this.sy = new Float32Array(SAMPLES);
    this.sz = new Float32Array(SAMPLES);
    this.sw = new Float32Array(SAMPLES);
    this.head = 0;
    this.count = 0;
    this.lastX = 0;
    this.lastZ = 0;
    this.reset();
  }

  reset() {
    this.head = 0;
    this.count = 0;
    this.lastX = 1e9;
    this.lastZ = 1e9;
    this.geo.setDrawRange(0, 0);
  }

  /** Call every frame with the roller's contact point. */
  update(x, groundY, z, halfWidth, grounded) {
    if (grounded) {
      const dx = x - this.lastX;
      const dz = z - this.lastZ;
      if (dx * dx + dz * dz >= MIN_STEP * MIN_STEP) {
        this.sx[this.head] = x;
        this.sy[this.head] = groundY + 0.035;
        this.sz[this.head] = z;
        this.sw[this.head] = halfWidth;
        this.head = (this.head + 1) % SAMPLES;
        if (this.count < SAMPLES) this.count++;
        this.lastX = x;
        this.lastZ = z;
        this._rebuild();
      }
    }
  }

  _rebuild() {
    const n = this.count;
    if (n < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const pos = this.positions;
    const ages = this.ages;
    for (let i = 0; i < n; i++) {
      const s = (this.head - n + i + SAMPLES) % SAMPLES;
      const x = this.sx[s];
      const y = this.sy[s];
      const z = this.sz[s];
      const w = this.sw[s];
      const age = 1 - i / (n - 1); // 0 at the newest end, 1 at the oldest
      const o = i * 6;
      pos[o] = x - w; pos[o + 1] = y; pos[o + 2] = z;
      pos[o + 3] = x + w; pos[o + 4] = y; pos[o + 5] = z;
      ages[i * 2] = age;
      ages[i * 2 + 1] = age;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAge.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.material.dispose();
  }
}

function createTrailMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const age = attribute('aAge', 'float');
  const across = attribute('aAcross', 'float');
  // Scorch: dark in the middle, feathered at the edges, fading with age.
  const edge = smoothstep(float(1.0), float(0.55), abs(across));
  const fade = smoothstep(float(1.0), float(0.15), age);
  const scorch = mix(vec3(0.05, 0.045, 0.04), vec3(0.14, 0.12, 0.10), age);
  mat.colorNode = vec4(scorch, edge.mul(fade).mul(0.72));
  return mat;
}
