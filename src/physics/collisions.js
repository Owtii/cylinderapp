import { TUNING, CLEAN, PLOW, BLOCKED } from '../tuning.js';

export { CLEAN, PLOW, BLOCKED };
export const BLOCKER = 'BLOCKER';

/**
 * Roller-vs-box overlap.
 *
 * The roller is treated as a box: ±halfWidth on x (its axis), ±radius on y and z.
 * The padding is NEGATIVE on purpose — props are drawn from a few primitives and
 * their AABB over-covers the real silhouette, so an exact test punishes near-misses
 * that visually cleared. This game rewards precision (see the near-miss boost), so
 * the contact test has to agree with what the player saw.
 */
export function overlaps(px, py, pz, phw, pr, ox, oy, oz, oex, oey, oez) {
  const pad = TUNING.collision.contactPadding;
  if (Math.abs(px - ox) > phw + oex + pad) return false;
  if (Math.abs(pz - oz) > pr + oez + pad) return false;
  if (Math.abs(py - oy) > pr + oey + pad) return false;
  return true;
}

/** Closest point on the object's box to the roller centre — where the hit happened. */
export const impactPoint = { x: 0, y: 0, z: 0 };
export function computeImpactPoint(px, py, pz, ox, oy, oz, oex, oey, oez) {
  impactPoint.x = px < ox - oex ? ox - oex : px > ox + oex ? ox + oex : px;
  impactPoint.y = py < oy - oey ? oy - oey : py > oy + oey ? oy + oey : py;
  impactPoint.z = pz < oz - oez ? oz - oez : pz > oz + oez ? oz + oez : pz;
  return impactPoint;
}

/** Lateral clearance to an object the roller did NOT hit — drives the near-miss reward. */
export function lateralClearance(px, phw, ox, oex) {
  return Math.abs(px - ox) - (phw + oex);
}

/** Hitstop duration, scaled by what you just hit. The best-value effect in the game. */
export function hitstopFor(weight, outcome) {
  const T = TUNING.time;
  if (outcome === BLOCKED || outcome === BLOCKER) return T.hitstopBlocked;
  const t = Math.min(1, (isFinite(weight) ? weight : T.hitstopWeightRef) / T.hitstopWeightRef);
  const span = T.hitstopMax - T.hitstopMin;
  return outcome === PLOW ? T.hitstopMin + span * 0.6 : T.hitstopMin + span * t;
}
