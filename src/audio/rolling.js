/**
 * TONNAGE — continuous layers: the rolling rumble and the wind.
 *
 * Both must be dead silent when the run is not playing, must never click, and
 * must audibly change with BOTH speed and mass. Mass is the important one: a
 * player should be able to tell they got heavier with their eyes shut.
 *
 * Mass changes four things at once:
 *   - rumble playback rate drops   (deeper grain)
 *   - the resonant body peak drops (bigger drum)
 *   - rumble gain rises            (more of it)
 *   - the drone pitch drops        (it tracks real rotation rate: a bigger
 *                                   cylinder at the same speed turns slower)
 *
 * All parameter motion is smoothed in JS with `damp()` and written straight to
 * AudioParam.value, so there are no automation events piling up in the timeline
 * and no zipper noise. Loop sources are started once and never stopped —
 * silence is gain 0, which is the only click-free way to do it.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, damp, lerp, TAU } from '../core/math.js';
import { massTerm01 } from './engine.js';

const S_RUMBLE_GAIN = 0;
const S_RUMBLE_CUT = 1;
const S_RUMBLE_RATE = 2;
const S_PEAK_HZ = 3;
const S_DRONE_HZ = 4;
const S_DRONE_GAIN = 5;
const S_WIND_GAIN = 6;
const S_WIND_CUT = 7;
const S_COUNT = 8;

/** Seconds the reset fade takes. */
const FADE_TIME = 0.06;

export class RollingLayer {
  /**
   * @param {import('./engine.js').AudioEngine} engine
   * @param {AudioBuffer} monoLoop   seamless pink-noise loop
   * @param {AudioBuffer} stereoLoop seamless stereo noise loop (wind)
   */
  constructor(engine, monoLoop, stereoLoop) {
    this.engine = engine;
    this.monoLoop = monoLoop;
    this.stereoLoop = stereoLoop;
    this.ready = false;

    this.rumbleSrc = null;
    this.rumbleLP = null;
    this.rumblePeak = null;
    this.rumbleGain = null;
    this.droneOsc = null;
    this.droneLP = null;
    this.droneGain = null;
    this.windSrc = null;
    this.windBP = null;
    this.windGain = null;

    /** Smoothed parameter state. Written every frame, never reallocated. */
    this.s = new Float64Array(S_COUNT);
    /** Last value actually pushed to an AudioParam. */
    this.w = new Float64Array(S_COUNT);
    /**
     * While `now < _muteUntil` the gains are being taken to zero by a scheduled
     * ramp (from `reset()`), so per-frame `.value` writes are suppressed —
     * writing a param mid-ramp is a setValueAtTime and would cut it to a step.
     */
    this._muteUntil = -1e9;
  }

  start() {
    const eng = this.engine;
    if (this.ready || !eng.ready) return;
    const ctx = eng.ctx;
    const A = TUNING.audio;

    // ── rumble
    const rs = ctx.createBufferSource();
    rs.buffer = this.monoLoop;
    rs.loop = true;
    rs.playbackRate.value = 1;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = A.rollingCutoffMin;
    lp.Q.value = 0.9;

    const pk = ctx.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.value = A.rollingToneHz;
    pk.Q.value = 2.2;
    pk.gain.value = 9;

    const rg = ctx.createGain();
    rg.gain.value = 0;

    rs.connect(lp);
    lp.connect(pk);
    pk.connect(rg);
    rg.connect(eng.sfxIn);

    // ── drone (tracks rotation rate — this is the "I am huge" layer)
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = A.droneHzMin;

    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 320;
    dlp.Q.value = 3.5;

    const dg = ctx.createGain();
    dg.gain.value = 0;

    osc.connect(dlp);
    dlp.connect(dg);
    dg.connect(eng.sfxIn);

    // ── wind
    const ws = ctx.createBufferSource();
    ws.buffer = this.stereoLoop;
    ws.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = A.windCutoffMin;
    bp.Q.value = 0.55;

    const wg = ctx.createGain();
    wg.gain.value = 0;

    ws.connect(bp);
    bp.connect(wg);
    wg.connect(eng.sfxIn);

    const t = ctx.currentTime + 0.02;
    try { rs.start(t); } catch (e) { /* noop */ }
    try { osc.start(t); } catch (e) { /* noop */ }
    try { ws.start(t); } catch (e) { /* noop */ }

    this.rumbleSrc = rs;
    this.rumbleLP = lp;
    this.rumblePeak = pk;
    this.rumbleGain = rg;
    this.droneOsc = osc;
    this.droneLP = dlp;
    this.droneGain = dg;
    this.windSrc = ws;
    this.windBP = bp;
    this.windGain = wg;

    this.s[S_RUMBLE_CUT] = A.rollingCutoffMin;
    this.s[S_RUMBLE_RATE] = 1;
    this.s[S_PEAK_HZ] = A.rollingToneHz;
    this.s[S_DRONE_HZ] = A.droneHzMin;
    this.s[S_WIND_CUT] = A.windCutoffMin;
    for (let i = 0; i < S_COUNT; i++) this.w[i] = -1;

    this.ready = true;
  }

  /**
   * @param {number} dt        unscaled seconds
   * @param {number} speed     m/s
   * @param {number} speed01   0..1 normalised speed
   * @param {number} mass      kg
   * @param {boolean} grounded
   * @param {boolean} playing
   */
  update(dt, speed, speed01, mass, grounded, playing) {
    if (!this.ready || !this.engine.ready) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const A = TUNING.audio;
    const P = TUNING.player;
    const s = this.s;

    const muting = this.engine.now < this._muteUntil;
    const sp01 = clamp01(speed01);
    const m = mass > 0 ? mass : P.startMass;
    const mr = m / P.startMass;
    const mt = massTerm01(m);

    // ── targets
    const speedCurve = Math.pow(sp01, 0.6);
    let tGain;
    if (!playing) {
      tGain = 0;
    } else if (grounded) {
      tGain = A.rollingBaseGain * (0.22 + 0.78 * speedCurve) * (1 + mt * A.rollingMassGain);
    } else {
      tGain = A.rollingBaseGain * A.airborneRumbleScale * sp01;
    }

    const massDark = Math.pow(1 / (mr > 0.01 ? mr : 0.01), 0.12);
    // Mass darkens the rumble, but never below the tuned floor: at 400 t the
    // darkening factor is 0.59, which would drag a 180 Hz idle down to ~106 Hz
    // and turn the roll into mud.
    const tCut = clamp(
      lerp(A.rollingCutoffMin, A.rollingCutoffMax, Math.pow(sp01, 0.7)) * massDark,
      A.rollingCutoffMin, A.rollingCutoffMax,
    );
    const tRate = clamp(Math.pow(1 / (mr > 0.01 ? mr : 0.01), A.rollingRateExp) * (0.85 + 0.4 * sp01), 0.35, 2.2);
    const tPeak = clamp(A.rollingToneHz / Math.pow(mr > 0.01 ? mr : 0.01, 0.25), 34, 320);

    // rotation rate of the actual cylinder → an audible pitch one harmonic up
    const radius = P.baseRadius * Math.pow(mr > 0.01 ? mr : 0.01, P.radiusExp);
    const rotHz = (speed > 0 ? speed : 0) / (TAU * (radius > 0.05 ? radius : 0.05));
    const tDroneHz = clamp(rotHz * A.droneHarmonic, A.droneHzMin, A.droneHzMax);
    let tDroneGain = (playing && grounded)
      ? A.droneGainMax * (0.12 + 0.88 * speedCurve) * (0.45 + 0.55 * mt)
      : 0;

    let tWindGain = playing ? A.windGainMax * Math.pow(sp01, 1.8) * (grounded ? 1 : 1.35) : 0;
    const tWindCut = lerp(A.windCutoffMin, A.windCutoffMax, sp01);

    if (muting) { tGain = 0; tDroneGain = 0; tWindGain = 0; }

    // ── smooth (framerate independent, click-free)
    const kr = A.rollingSmoothing;
    const kw = A.windSmoothing;
    s[S_RUMBLE_GAIN] = damp(s[S_RUMBLE_GAIN], tGain, kr, dt);
    s[S_RUMBLE_CUT] = damp(s[S_RUMBLE_CUT], tCut, kr, dt);
    s[S_RUMBLE_RATE] = damp(s[S_RUMBLE_RATE], tRate, kr, dt);
    s[S_PEAK_HZ] = damp(s[S_PEAK_HZ], tPeak, kr, dt);
    s[S_DRONE_HZ] = damp(s[S_DRONE_HZ], tDroneHz, kr, dt);
    s[S_DRONE_GAIN] = damp(s[S_DRONE_GAIN], tDroneGain, kr, dt);
    s[S_WIND_GAIN] = damp(s[S_WIND_GAIN], tWindGain, kw, dt);
    s[S_WIND_CUT] = damp(s[S_WIND_CUT], tWindCut, kw, dt);

    // ── push
    this._set(S_RUMBLE_CUT, this.rumbleLP.frequency, 0.5);
    this._set(S_RUMBLE_RATE, this.rumbleSrc.playbackRate, 0.001);
    this._set(S_PEAK_HZ, this.rumblePeak.frequency, 0.25);
    this._set(S_DRONE_HZ, this.droneOsc.frequency, 0.05);
    this._set(S_WIND_CUT, this.windBP.frequency, 0.5);
    if (!muting) {
      this._set(S_RUMBLE_GAIN, this.rumbleGain.gain, 0.0004);
      this._set(S_DRONE_GAIN, this.droneGain.gain, 0.0004);
      this._set(S_WIND_GAIN, this.windGain.gain, 0.0004);
    }
  }

  _set(idx, param, eps) {
    const v = this.s[idx];
    const w = this.w[idx];
    const d = v - w;
    if (d > eps || d < -eps) {
      this.w[idx] = v;
      try { param.value = v; } catch (e) { /* dead node */ }
    }
  }

  /**
   * Run restart: fade to silence over 60 ms rather than cutting. The scheduled
   * ramp covers the case where `update()` stops being called entirely (menu),
   * while the mute window keeps the per-frame writes out of its way; the JS
   * smoothing rides down to 0 alongside it so the two agree when it lands.
   */
  reset() {
    if (!this.ready) {
      this.s[S_RUMBLE_GAIN] = 0;
      this.s[S_DRONE_GAIN] = 0;
      this.s[S_WIND_GAIN] = 0;
      return;
    }
    const A = TUNING.audio;
    const s = this.s;
    // Zeroed here and held there by the muting branch in update(), so the JS
    // state and the scheduled ramp agree at the moment writes resume.
    s[S_RUMBLE_GAIN] = 0;
    s[S_DRONE_GAIN] = 0;
    s[S_WIND_GAIN] = 0;
    s[S_RUMBLE_CUT] = A.rollingCutoffMin;
    s[S_RUMBLE_RATE] = 1;
    s[S_PEAK_HZ] = A.rollingToneHz;
    s[S_DRONE_HZ] = A.droneHzMin;
    s[S_WIND_CUT] = A.windCutoffMin;
    for (let i = 0; i < S_COUNT; i++) this.w[i] = -1;

    const t = this.engine.now;
    this._muteUntil = t + FADE_TIME + 0.02;
    this._rampTo(this.rumbleGain.gain, 0, t);
    this._rampTo(this.droneGain.gain, 0, t);
    this._rampTo(this.windGain.gain, 0, t);
  }

  _rampTo(param, v, t) {
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(v, t + FADE_TIME);
    } catch (e) {
      try { param.value = v; } catch (e2) { /* noop */ }
    }
  }

  dispose() {
    if (!this.ready) return;
    this.ready = false;
    const stop = function (n) {
      if (!n) return;
      try { n.stop(); } catch (e) { /* noop */ }
      try { n.disconnect(); } catch (e) { /* noop */ }
    };
    const dis = function (n) {
      if (!n) return;
      try { n.disconnect(); } catch (e) { /* noop */ }
    };
    stop(this.rumbleSrc);
    stop(this.droneOsc);
    stop(this.windSrc);
    dis(this.rumbleLP);
    dis(this.rumblePeak);
    dis(this.rumbleGain);
    dis(this.droneLP);
    dis(this.droneGain);
    dis(this.windBP);
    dis(this.windGain);
    this.rumbleSrc = null;
    this.droneOsc = null;
    this.windSrc = null;
  }
}
