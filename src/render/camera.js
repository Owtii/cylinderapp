import * as THREE from 'three/webgpu';
import { TUNING } from '../tuning.js';
import { clamp01, lerp, smoothDamp, damp } from '../core/math.js';

const _look = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Third-person chase camera.
 *
 * Sits behind and above the roller, looking down the slope. Follows with a
 * critically-damped spring so it is never rigid; pulls back and widens its FOV
 * with speed, because speed you can see is speed you can feel.
 *
 * Shake is trauma-based: callers add trauma, the camera shakes by trauma^2 and
 * bleeds trauma off at a constant rate. Rotational as well as positional —
 * positional-only shake reads as a glitch, rotational reads as impact.
 */
export class ChaseCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {(d:number)=>number} groundAt  road surface height at travel distance d
   */
  constructor(camera, groundAt) {
    this.camera = camera;
    this.groundAt = groundAt;

    // Spring state: [posX, posY, posZ] velocities.
    this.vel = new Float32Array(3);
    this.px = 0; this.py = 6; this.pz = 14;

    this.trauma = 0;
    this.shakeSeed = Math.random() * 1000;
    this.shakeTime = 0;

    this.fov = TUNING.camera.fovMin;
    this.fovKick = 0;
    this.fovKickTimer = 0;

    this.roll = 0;
  }

  reset(x, y, z) {
    const T = TUNING.camera;
    this.px = x;
    this.py = y + T.minHeight;
    this.pz = z + T.minDistance;
    this.vel[0] = this.vel[1] = this.vel[2] = 0;
    this.trauma = 0;
    this.fovKick = 0;
    this.fovKickTimer = 0;
    this.roll = 0;
    this.camera.position.set(this.px, this.py, this.pz);
    this.camera.fov = TUNING.camera.fovMin;
    this.camera.updateProjectionMatrix();
  }

  /** trauma is 0..1 and accumulates; the shake is trauma squared. */
  addTrauma(amount, weight) {
    const scale = weight
      ? Math.pow(weight / TUNING.player.startWeight, TUNING.shake.traumaWeightExp)
      : 1;
    this.trauma = Math.min(TUNING.shake.maxTrauma, this.trauma + amount * scale);
  }

  kickFov(amount) {
    this.fovKick = Math.max(this.fovKick, amount ?? TUNING.camera.fovKickAmount);
    this.fovKickTimer = TUNING.camera.fovKickTime;
  }

  /**
   * @param {number} dt        unscaled frame time (camera keeps moving during hitstop
   *                           at zero scale? no — pass scaled dt for the follow, and
   *                           unscaled for the shake decay; see game.js)
   * @param {number} px,py,pz  player world position
   * @param {number} d         player travel distance
   * @param {number} speed01   0..1 speed fraction
   * @param {number} mass      player mass
   */
  /**
   * @param dt        unscaled frame time
   * @param px,py,pz  interpolated roller position
   * @param d         travel distance
   * @param speed01   0..1 speed fraction
   * @param weight    current weight (only used for shake scaling)
   */
  update(dt, px, py, pz, d, speed01, weight, lateralVel, radius, speed) {
    const T = TUNING.camera;

    // Distance and height come from the roller's RADIUS, so it always fills a
    // similar slice of screen however big it gets; speed adds a little extra
    // pull-back on top so fast reads as fast.
    const r = radius || 1;
    const dist = Math.max(T.minDistance, r * T.distancePerRadius) * (1 + T.speedPullback * speed01);
    const height = Math.max(T.minHeight, r * T.heightPerRadius) * (1 + T.speedPullback * 0.5 * speed01);

    const anchorD = d - dist;
    const targetX = px * 0.86;
    const targetY = this.groundAt(anchorD) + height;
    const targetZ = pz + dist;

    this.px = smoothDamp(this.px, targetX, this.vel, 0, T.smoothTime, dt);
    this.py = smoothDamp(this.py, targetY, this.vel, 1, T.smoothTime * 1.1, dt);
    this.pz = smoothDamp(this.pz, targetZ, this.vel, 2, T.smoothTime, dt);

    let sx = 0, sy = 0, sz = 0, sroll = 0;
    if (this.trauma > 0) {
      this.shakeTime += dt * TUNING.shake.frequency;
      const t2 = this.trauma * this.trauma;
      const s = this.shakeSeed;
      sx = Math.sin(this.shakeTime * 1.00 + s) * TUNING.shake.posMagnitude * t2;
      sy = Math.sin(this.shakeTime * 1.37 + s * 2.1) * TUNING.shake.posMagnitude * t2;
      sz = Math.sin(this.shakeTime * 0.83 + s * 3.7) * TUNING.shake.posMagnitude * 0.6 * t2;
      sroll = Math.sin(this.shakeTime * 1.19 + s * 5.3) * TUNING.shake.rotMagnitude * t2;
      this.trauma = Math.max(0, this.trauma - TUNING.shake.decay * dt);
    }
    this.camera.position.set(this.px + sx, this.py + sy, this.pz + sz);

    // Aim measured in TIME, not metres, and lifted so roughly four seconds of ramp
    // stays on screen. Forward visibility beats a cinematic low angle: if the two
    // ever conflict, visibility wins.
    const aheadD = d + T.lookAheadSeconds * Math.max(8, speed || 0);
    _look.set(
      px * 0.86,
      this.groundAt(aheadD) + T.lookHeight + height * T.pitchLift,
      -aheadD,
    );
    this.camera.up.copy(_up);
    this.camera.lookAt(_look);

    const targetRoll = -clamp01(Math.abs(lateralVel) / 16) * Math.sign(lateralVel) * 0.05;
    this.roll = damp(this.roll, targetRoll, 0.002, dt);
    this.camera.rotateZ(this.roll + sroll);

    if (this.fovKickTimer > 0) {
      this.fovKickTimer -= dt;
      if (this.fovKickTimer <= 0) this.fovKick = 0;
    } else {
      this.fovKick = damp(this.fovKick, 0, 0.0001, dt);
    }
    const targetFov = lerp(T.fovMin, T.fovMax, speed01) + this.fovKick;
    this.fov = damp(this.fov, targetFov, 0.0025, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
