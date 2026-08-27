import { TUNING } from '../tuning.js';
import { clamp01 } from './math.js';

/**
 * Fixed-timestep game loop with an accumulator, render interpolation, and a
 * time-scale channel that hitstop and slow-motion both write into.
 *
 * Physics always advances in exact 1/60 s steps of *scaled* time, so hitstop is
 * literally "the simulation stops" rather than "everything moves slowly".
 */
export class GameLoop {
  /**
   * @param {(dt:number)=>void} step      Fixed-rate simulation step.
   * @param {(alpha:number, rawDt:number, scaledDt:number)=>void} render
   */
  constructor(step, render) {
    this.step = step;
    this.render = render;

    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this.rafId = 0;

    /** Absolute simulated time (scaled), in seconds. */
    this.simTime = 0;
    /** Wall-clock time since the loop started, unscaled. */
    this.wallTime = 0;

    this.hitstopRemaining = 0;
    this.slowmoRemaining = 0;
    this.slowmoEaseRemaining = 0;
    this.slowmoTarget = 1;
    this.timeScale = 1;

    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  reset() {
    this.accumulator = 0;
    this.simTime = 0;
    this.hitstopRemaining = 0;
    this.slowmoRemaining = 0;
    this.slowmoEaseRemaining = 0;
    this.timeScale = 1;
    this.lastTime = performance.now();
  }

  /** Freeze the simulation entirely for `seconds`. The single best-value effect. */
  requestHitstop(seconds) {
    if (seconds > this.hitstopRemaining) this.hitstopRemaining = seconds;
  }

  /** Drop to `scale` for `duration`, then ease back over `ease`. */
  requestSlowmo(scale, duration, ease) {
    this.slowmoTarget = scale;
    this.slowmoRemaining = Math.max(this.slowmoRemaining, duration);
    this.slowmoEaseRemaining = ease;
  }

  get inSlowmo() {
    return this.slowmoRemaining > 0 || this.slowmoEaseRemaining > 0;
  }

  _tick(now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this._tick);

    let rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Tab-switch / breakpoint guard: never let one frame dump 10 s into the sim.
    if (rawDt > 0.25) rawDt = 0.25;
    this.wallTime += rawDt;

    // ── resolve time scale for this frame
    let scale;
    if (this.hitstopRemaining > 0) {
      this.hitstopRemaining -= rawDt;
      scale = 0;
    } else if (this.slowmoRemaining > 0) {
      this.slowmoRemaining -= rawDt;
      scale = this.slowmoTarget;
    } else if (this.slowmoEaseRemaining > 0) {
      this.slowmoEaseRemaining -= rawDt;
      const t = clamp01(1 - this.slowmoEaseRemaining / Math.max(1e-4, TUNING.time.slowmoEaseOut));
      scale = this.slowmoTarget + (1 - this.slowmoTarget) * (t * t * (3 - 2 * t));
    } else {
      scale = 1;
    }
    this.timeScale = scale;

    const scaledDt = rawDt * scale;
    this.accumulator += scaledDt;

    const fixed = TUNING.world.fixedStep;
    let steps = 0;
    const maxSteps = TUNING.world.maxStepsPerFrame;
    while (this.accumulator >= fixed && steps < maxSteps) {
      this.step(fixed);
      this.simTime += fixed;
      this.accumulator -= fixed;
      steps++;
    }
    if (steps === maxSteps) this.accumulator = 0; // shed the backlog, stay responsive

    this.render(this.accumulator / fixed, rawDt, scaledDt);
  }
}
