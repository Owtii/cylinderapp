import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning.js';

/**
 * Rapier world wrapper.
 *
 * Deliberately small: Rapier owns the road surface and the roller body only.
 * Destructibles, blockers and pickups are resolved on the CPU against the active
 * prop list (see physics/collisions.js) because the game needs *authored*
 * responses — a PULVERIZE that costs 3 % speed is not something a solver will
 * ever produce, and fighting the solver to get it is how a game stops feeling good.
 */

export const GROUP_GROUND = 0x0001;
export const GROUP_PLAYER = 0x0002;

/** Rapier interaction groups pack membership in the high 16 bits, filter in the low. */
export function groups(membership, filter) {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export const GROUPS_GROUND = groups(GROUP_GROUND, GROUP_PLAYER);
export const GROUPS_PLAYER = groups(GROUP_PLAYER, GROUP_GROUND);

let initialised = false;

export async function initPhysics() {
  if (!initialised) {
    await RAPIER.init();
    initialised = true;
  }
  return RAPIER;
}

export class PhysicsWorld {
  constructor() {
    this.rapier = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: TUNING.world.gravity, z: 0 });
    this.world.timestep = TUNING.world.fixedStep;
    this.world.numSolverIterations = 4;
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  step() {
    this.world.step();
  }

  /**
   * A slab of road: a box rotated about X so its top face lies on the slope.
   * @param cx,cy,cz  centre of the *top surface*
   * @param halfW     half extent across the road (x)
   * @param halfL     half extent along travel, measured along the slope
   * @param slopeRad  positive = descending toward -Z
   * @param thickness box thickness below the surface
   */
  addSlab(cx, cy, cz, halfW, halfL, slopeRad, thickness = 2) {
    const half = thickness * 0.5;
    // Travel is toward -Z and the hill descends, so a positive slope must tip the
    // box's -Z end *down*: that is a rotation of -slope about X. (Getting this sign
    // backwards builds a hill that climbs away from the player.)
    const s = Math.sin(-slopeRad * 0.5);
    const c = Math.cos(-slopeRad * 0.5);
    // Surface normal of a descent is (0, cos, -sin); push the centre along -normal.
    const ny = Math.cos(slopeRad);
    const nz = -Math.sin(slopeRad);
    const desc = RAPIER.ColliderDesc.cuboid(halfW, half, halfL)
      .setTranslation(cx, cy - ny * half, cz - nz * half)
      .setRotation({ x: s, y: 0, z: 0, w: c })
      .setFriction(0.9)
      .setRestitution(0)
      .setCollisionGroups(GROUPS_GROUND);
    return this.world.createCollider(desc);
  }

  removeCollider(collider) {
    if (collider) this.world.removeCollider(collider, false);
  }

  /**
   * Downward ray. Returns time-of-impact or -1, writing the surface normal into
   * `outNormal` (a reused {x,y,z}).
   */
  rayDown(ox, oy, oz, maxToi, outNormal, filterCollider) {
    this._ray.origin.x = ox;
    this._ray.origin.y = oy;
    this._ray.origin.z = oz;
    this._ray.dir.x = 0;
    this._ray.dir.y = -1;
    this._ray.dir.z = 0;
    const hit = this.world.castRayAndGetNormal(
      this._ray, maxToi, true, undefined, GROUPS_PLAYER, filterCollider,
    );
    if (!hit) return -1;
    outNormal.x = hit.normal.x;
    outNormal.y = hit.normal.y;
    outNormal.z = hit.normal.z;
    return hit.timeOfImpact;
  }

  dispose() {
    this.world.free();
  }
}
