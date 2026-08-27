import * as THREE from 'three/webgpu';
import {
  positionLocal, vec3, vec4, float, mix, smoothstep, abs, fract, step, uniform, length,
} from 'three/tsl';

/**
 * The roller itself: a steel drum whose axis is world-X, so it rolls like a road
 * roller rather than tipping over like a barrel.
 *
 * The geometry is pre-rotated onto the X axis at build time, which means the roll
 * animation is a single rotation about X and the radial scale stays uniform — no
 * shear, no quaternion bookkeeping per frame.
 */
export class Roller {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 40, 1, false);
    geo.rotateZ(-Math.PI / 2); // axis: +Y -> +X
    this.geometry = geo;

    this.uHeat = uniform(0);
    this.material = createRollerMaterial(this.uHeat);

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.scene = scene;
  }

  /**
   * @param {number} width    full length along the roller's axis
   * @param {number} radius
   * @param {number} roll     accumulated roll angle (radians)
   */
  update(x, y, z, width, radius, roll, heat) {
    this.mesh.position.set(x, y, z);
    this.mesh.scale.set(width, radius * 2, radius * 2);
    this.mesh.rotation.set(roll, 0, 0);
    this.uHeat.value = heat;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

function createRollerMaterial(uHeat) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.34, metalness: 0.92 });

  // Local space: X is the drum axis (|x| <= 0.5), Y/Z the radial plane (r <= 0.5).
  const px = positionLocal.x;
  const radial = length(positionLocal.yz);

  const steel = vec3(0.30, 0.315, 0.345);
  const dark = vec3(0.11, 0.115, 0.13);
  const hazard = vec3(0.92, 0.71, 0.06);

  // Circumferential grooves along the drum.
  const groove = smoothstep(float(0.030), float(0.008), abs(fract(px.mul(16.0)).sub(0.5)));
  let color = mix(steel, dark, groove.mul(0.75));

  // Hazard bands at both ends — reads instantly as heavy industrial plant.
  const endBand = smoothstep(float(0.40), float(0.455), abs(px));
  const bandStripe = step(float(0.5), fract(positionLocal.z.add(positionLocal.y).mul(7.0)));
  color = mix(color, mix(dark, hazard, bandStripe), endBand);

  // Hub plate on the flat end caps.
  const cap = smoothstep(float(0.487), float(0.499), abs(px));
  const hub = smoothstep(float(0.30), float(0.26), radial);
  color = mix(color, dark.mul(1.35), cap.mul(hub));

  mat.colorNode = vec4(color, 1.0);
  // Heat glow bleeds out of the grooves as speed rises.
  mat.emissiveNode = vec3(1.0, 0.34, 0.06).mul(groove).mul(uHeat).mul(0.9);
  return mat;
}
