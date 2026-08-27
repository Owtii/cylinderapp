/** Allocation-free math helpers. Nothing in here may create an object. */

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, v) {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v, inA, inB, outA, outB) {
  return lerp(outA, outB, clamp01(invLerp(inA, inB, v)));
}

export function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Framerate-independent exponential approach. `smoothing` is the fraction of the
 * remaining distance left after 1 second (smaller = snappier).
 */
export function damp(current, target, smoothing, dt) {
  return lerp(target, current, Math.pow(smoothing, dt));
}

/**
 * Critically damped spring. Returns the new position; write the new velocity back
 * into `state[velIndex]`. Used by the chase camera so it never feels rigid.
 */
export function smoothDamp(current, target, state, velIndex, smoothTime, dt, maxSpeed) {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  if (maxSpeed !== undefined) {
    const maxChange = maxSpeed * st;
    change = clamp(change, -maxChange, maxChange);
  }
  const temp = (state[velIndex] + omega * change) * dt;
  state[velIndex] = (state[velIndex] - omega * temp) * exp;
  return target + (change + temp) * exp;
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** dB → linear gain. */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/** Linear gain → dB. */
export function gainToDb(gain) {
  return 20 * Math.log10(Math.max(1e-6, gain));
}

/** Semitones → playback-rate multiplier. */
export function semitones(n) {
  return Math.pow(2, n / 12);
}

export function sign(v) {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Cheap 1D hash → [0,1). Deterministic, no allocation. */
export function hash11(n) {
  let x = Math.sin(n * 127.1) * 43758.5453123;
  return x - Math.floor(x);
}
