import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING, massRatio } from '../tuning.js';
import { clamp, clamp01, moveTowards } from '../core/math.js';
import { GROUPS_PLAYER } from './world.js';
import { ROAD_HALF } from '../world/track.js';

const _n0 = { x: 0, y: 1, z: 0 };
const _n1 = { x: 0, y: 1, z: 0 };
const _n2 = { x: 0, y: 1, z: 0 };

/**
 * The roller.
 *
 * Motion is integrated by hand and Rapier is used as the collision-query engine
 * (three downward rays against the road/ramp colliders). That is a deliberate
 * choice: the spec demands direct, non-negotiable steering and *authored* impact
 * responses, and a constraint solver will fight both. What Rapier gives us here
 * is what it is genuinely best at — robust, cheap queries against arbitrary
 * generated geometry — while the feel stays exactly as tuned.
 *
 * The cylinder's axis is world-X, so it rolls like a road roller. The visual roll
 * angle is derived from distance travelled, which is exact and never jitters.
 */
export class Player {
  constructor(physics) {
    this.physics = physics;

    this.mass = TUNING.player.startMass;
    this.radius = TUNING.player.baseRadius;
    this.halfWidth = TUNING.player.width * 0.5;

    this.x = 0; this.y = 0; this.z = 0;
    this.prevX = 0; this.prevY = 0; this.prevZ = 0;
    this.vy = 0;
    this.speed = 0;          // downhill speed, +ve is forward (-Z)
    this.lateralVel = 0;
    this.d = 0;              // travel distance
    this.rollAngle = 0;
    this.prevRoll = 0;

    this.grounded = true;
    this.wasGrounded = true;
    this.airTime = 0;
    this.groundY = 0;
    this.groundRate = 0;
    this.landImpact = 0;     // set on the frame we land, consumed by the game
    this.justLaunched = false;

    this.inputLateral = 0;
    this.inputTuck = false;
    this.tuckTimer = 0;
    this.tuckCooldown = 0;
    this.steerLockout = 0;

    this.dead = false;
    this.fallTimer = 0;
    this.slopeNormalY = 1;
    this.slopeNormalZ = 0;

    // A kinematic proxy body so the roller exists in the physics world (useful for
    // debug rendering and future queries); it never drives motion.
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0);
    this.body = physics.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cylinder(this.halfWidth, this.radius)
      .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }) // axis Y -> X
      .setCollisionGroups(GROUPS_PLAYER)
      .setSensor(true);
    this.collider = physics.world.createCollider(colDesc, this.body);

    this.reset();
  }

  reset() {
    this.mass = TUNING.player.startMass;
    this._recomputeDerived();
    this.x = 0;
    this.d = 0;
    this.z = 0;
    this.y = this.radius;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.vy = 0;
    this.speed = 0;
    this.lateralVel = 0;
    this.rollAngle = 0;
    this.prevRoll = 0;
    this.grounded = true;
    this.wasGrounded = true;
    this.airTime = 0;
    this.groundY = 0;
    this.groundRate = 0;
    this.landImpact = 0;
    this.justLaunched = false;
    this.inputLateral = 0;
    this.inputTuck = false;
    this.tuckTimer = 0;
    this.tuckCooldown = 0;
    this.steerLockout = 0;
    this.dead = false;
    this.fallTimer = 0;
    this.slopeNormalY = 1;
    this.slopeNormalZ = 0;
    this._syncBody();
  }

  // ── derived stats ────────────────────────────────────────────────────────────
  _recomputeDerived() {
    const P = TUNING.player;
    const r = massRatio(this.mass);
    this.radius = Math.min(P.maxRadius, P.baseRadius * Math.pow(r, P.radiusExp));
    const baseHalf = Math.min(P.maxWidth, P.width * Math.pow(r, P.widthExp)) * 0.5;
    this.fullHalfWidth = baseHalf;
    this.halfWidth = this.tuckTimer > 0 ? baseHalf * P.tuckWidthScale : baseHalf;
    this.topSpeed = Math.min(
      P.topSpeedCap,
      P.baseTopSpeed * Math.pow(r, P.topSpeedExp),
    ) * (this.tuckTimer > 0 ? P.tuckSpeedBonus : 1);
    this.lateralSpeed = P.baseLateralSpeed * Math.pow(1 / r, P.lateralSpeedExp);
    this.lateralAccel = (P.baseLateralSpeed / P.lateralAccelTime) / Math.pow(r, P.lateralAccelExp);
    this.lateralDecel = (P.baseLateralSpeed / P.lateralDecelTime) / Math.pow(r, P.lateralAccelExp);
  }

  get speed01() {
    return clamp01(this.speed / Math.max(1, this.topSpeed));
  }

  addMass(kg) {
    this.mass = clamp(this.mass + kg, TUNING.player.minMass, TUNING.player.maxMass);
    this._recomputeDerived();
  }

  loseMassFraction(f) {
    const lost = this.mass * f;
    this.mass = Math.max(TUNING.player.minMass, this.mass - lost);
    this._recomputeDerived();
    return lost;
  }

  /** PULVERIZE / PLOW speed cost. */
  applySpeedLoss(fraction) {
    this.speed *= (1 - fraction);
  }

  /** BLOCKED: rebound up the hill, near-total speed loss, brief steer lockout. */
  blockedResponse() {
    const C = TUNING.collision;
    this.speed = -C.blockedRebound;
    this.lateralVel *= -0.35;
    this.steerLockout = C.blockedLockout;
  }

  setInput(lateral, tuck) {
    this.inputLateral = clamp(lateral, -1, 1);
    this.inputTuck = !!tuck;
  }

  tryTuck() {
    if (this.tuckCooldown > 0 || this.tuckTimer > 0) return false;
    this.tuckTimer = TUNING.player.tuckDuration;
    this.tuckCooldown = TUNING.player.tuckCooldown;
    this._recomputeDerived();
    return true;
  }

  get tucking() {
    return this.tuckTimer > 0;
  }

  // ── simulation ───────────────────────────────────────────────────────────────
  /**
   * One fixed step.
   *
   * Order matters: integrate the horizontal motion first, *then* probe the ground
   * at the new position. Probing before moving makes the roller sit at the height
   * of where it used to be, which at 32 m/s on a 12° hill is a permanent 12 cm
   * float above the road.
   */
  step(dt) {
    const P = TUNING.player;
    const W = TUNING.world;

    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevRoll = this.rollAngle;
    this.wasGrounded = this.grounded;
    this.landImpact = 0;
    this.justLaunched = false;

    if (this.tuckTimer > 0) {
      this.tuckTimer -= dt;
      if (this.tuckTimer <= 0) {
        this.tuckTimer = 0;
        this._recomputeDerived();
      }
    }
    if (this.tuckCooldown > 0) this.tuckCooldown -= dt;
    if (this.steerLockout > 0) this.steerLockout -= dt;

    // ── downhill speed, using the slope under us as of the last probe
    const g = -W.gravity;
    const slope = this.grounded
      ? Math.atan2(-this.slopeNormalZ, Math.max(1e-4, this.slopeNormalY))
      : 0;
    const V = Math.max(1, this.topSpeed);
    const baseSin = Math.sin(W.baseSlopeDeg * Math.PI / 180);
    const kDrag = (g * baseSin * P.dragCoef) / (V * V);

    let a;
    if (this.grounded) {
      a = g * Math.sin(slope)
        + P.accelAssist * (1 - this.speed / V)
        - kDrag * this.speed * Math.abs(this.speed);
      if (this.tuckTimer > 0) a += P.tuckAccel;
    } else {
      a = -kDrag * 0.35 * this.speed * Math.abs(this.speed);
    }
    this.speed = clamp(this.speed + a * dt, -P.topSpeedCap, P.topSpeedCap);

    // ── lateral: direct, responsive, never force-based
    const authority = this.grounded ? 1 : P.airControlScale;
    const wanted = this.steerLockout > 0 ? 0 : this.inputLateral * this.lateralSpeed;
    const closing = Math.abs(wanted) > Math.abs(this.lateralVel)
      && (this.lateralVel === 0 || Math.sign(wanted) === Math.sign(this.lateralVel));
    const rate = closing ? this.lateralAccel : this.lateralDecel;
    this.lateralVel = moveTowards(this.lateralVel, wanted, rate * authority * dt);

    this.x += this.lateralVel * dt;

    // Soft shoulder: the run is about what is in front of you, not about the verge.
    const limit = ROAD_HALF - this.radius * 0.55;
    if (this.x > limit) {
      const over = this.x - limit;
      this.x = limit + over * Math.exp(-over / P.edgeSoftness) * 0.35;
      if (this.lateralVel > 0) this.lateralVel *= 0.55;
    } else if (this.x < -limit) {
      const over = -limit - this.x;
      this.x = -limit - over * Math.exp(-over / P.edgeSoftness) * 0.35;
      if (this.lateralVel < 0) this.lateralVel *= 0.55;
    }

    this.z -= this.speed * dt;
    this.d = -this.z;

    // ── ground probe at the position we just moved to: three rays, so being
    //    half over a hole still finds support on the solid half.
    const probeTop = this.y + this.radius * 0.6;
    const maxToi = this.radius * 3 + Math.abs(this.speed) * dt + 2;
    const off = this.halfWidth * 0.8;
    const t0 = this.physics.rayDown(this.x, probeTop, this.z, maxToi, _n0, this.collider);
    const t1 = this.physics.rayDown(this.x - off, probeTop, this.z, maxToi, _n1, this.collider);
    const t2 = this.physics.rayDown(this.x + off, probeTop, this.z, maxToi, _n2, this.collider);

    // A near-vertical face is a wall (a slab end cap, a ramp side), not ground.
    let bestToi = Infinity;
    let n = _n0;
    if (t0 >= 0 && t0 < bestToi && _n0.y > 0.45) { bestToi = t0; n = _n0; }
    if (t1 >= 0 && t1 < bestToi && _n1.y > 0.45) { bestToi = t1; n = _n1; }
    if (t2 >= 0 && t2 < bestToi && _n2.y > 0.45) { bestToi = t2; n = _n2; }

    const hasGround = bestToi !== Infinity;
    const surfaceY = hasGround ? probeTop - bestToi : -Infinity;
    const skin = 0.12 + Math.abs(this.speed) * dt * Math.tan(Math.abs(slope) + 0.02);

    if (hasGround && this.vy <= 0.001 && surfaceY + this.radius >= this.y - skin) {
      if (!this.wasGrounded) {
        this.landImpact = clamp01(-this.vy / 26);
        this.airTime = 0;
        this.groundRate = 0;
      } else {
        // Vertical rate of the surface we are riding. This is what a ramp lip
        // hands to the roller as launch velocity the instant support ends.
        this.groundRate = (surfaceY - this.groundY) / dt;
      }
      this.grounded = true;
      this.groundY = surfaceY;
      this.y = surfaceY + this.radius;
      this.vy = 0;
      this.slopeNormalY = n.y;
      this.slopeNormalZ = n.z;
    } else {
      if (this.wasGrounded) {
        // Leaving the ground: inherit the surface's vertical rate, so a ramp
        // launches the roller instead of dropping it off an invisible ledge.
        this.vy = clamp(this.groundRate, -6, 26);
        this.groundRate = 0;
        if (this.vy > 1.5) this.justLaunched = true;
      }
      this.grounded = false;
      this.airTime += dt;
      this.vy += W.gravity * dt;
      this.y += this.vy * dt;
      if (hasGround && this.y - this.radius <= surfaceY) {
        this.landImpact = clamp01(-this.vy / 26);
        this.y = surfaceY + this.radius;
        this.vy = 0;
        this.grounded = true;
        this.groundY = surfaceY;
        this.airTime = 0;
        this.slopeNormalY = n.y;
        this.slopeNormalZ = n.z;
      }
    }

    // ── roll visual: exact, derived from arc length
    this.rollAngle += (this.speed * dt) / Math.max(0.2, this.radius);

    this._syncBody();
  }

  /** Called by the game with the road-profile height, to detect falling into a hole. */
  checkFall(profileY) {
    if (this.grounded) {
      this.fallTimer = 0;
      return false;
    }
    if (this.y < profileY - 4) {
      this.fallTimer += TUNING.world.fixedStep;
      if (this.y < profileY - 12 || this.fallTimer > 0.8) {
        this.dead = true;
        return true;
      }
    }
    return false;
  }

  _syncBody() {
    this.body.setNextKinematicTranslation({ x: this.x, y: this.y, z: this.z });
    if (this.collider.halfHeight() !== this.halfWidth) this.collider.setHalfHeight(this.halfWidth);
    if (this.collider.radius() !== this.radius) this.collider.setRadius(this.radius);
  }
}
