import { TUNING } from '../tuning.js';

export const PULVERIZE = 'PULVERIZE';
export const PLOW = 'PLOW';
export const BLOCKED = 'BLOCKED';

/**
 * The three outcomes. This one comparison is the whole game:
 *   mass >  threshold * 1.5  → PULVERIZE  (reward)
 *   mass >  threshold        → PLOW       (effort)
 *   mass <= threshold        → BLOCKED    (setback, never a game over)
 */
export function classify(playerMass, threshold) {
  if (!isFinite(threshold)) return BLOCKED;
  if (playerMass > threshold * TUNING.collision.pulverizeRatio) return PULVERIZE;
  if (playerMass > threshold) return PLOW;
  return BLOCKED;
}

/**
 * Roller-vs-box overlap.
 *
 * The roller is treated as a box: ±halfWidth on x (its axis), ±radius on y and z.
 * At these speeds and sizes the difference from a true cylinder is well under the
 * contact padding, and the test is four comparisons.
 */
export function overlaps(px, py, pz, phw, pr, ox, oy, oz, oex, oey, oez) {
  const pad = TUNING.collision.contactPadding;
  if (Math.abs(px - ox) > phw + oex + pad) return false;
  if (Math.abs(pz - oz) > pr + oez + pad) return false;
  if (Math.abs(py - oy) > pr + oey + pad) return false;
  return true;
}

/** Closest point on the object's box to the roller centre — where the hit "happened". */
export const impactPoint = { x: 0, y: 0, z: 0 };
export function computeImpactPoint(px, py, pz, ox, oy, oz, oex, oey, oez) {
  impactPoint.x = px < ox - oex ? ox - oex : px > ox + oex ? ox + oex : px;
  impactPoint.y = py < oy - oey ? oy - oey : py > oy + oey ? oy + oey : py;
  impactPoint.z = pz < oz - oez ? oz - oez : pz > oz + oez ? oz + oez : pz;
  return impactPoint;
}

/** Hitstop duration for an object, scaled by its mass. */
export function hitstopFor(threshold, outcome) {
  const T = TUNING.time;
  if (outcome === BLOCKED) return T.hitstopBlocked;
  if (outcome === PLOW) return T.hitstopMin + (T.hitstopMax - T.hitstopMin) * 0.5;
  const t = Math.min(1, (isFinite(threshold) ? threshold : T.hitstopMassRef) / T.hitstopMassRef);
  return T.hitstopMin + (T.hitstopMax - T.hitstopMin) * t;
}
