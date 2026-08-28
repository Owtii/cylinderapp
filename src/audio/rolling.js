/**
 * TONNAGE — continuous layers: the rolling rumble and the wind.
 *
 * Both must be dead silent when the run is not playing, must never click, and
 * must audibly change with BOTH speed and weight. Weight is the important one: a
 * player should be able to tell they got heavier with their eyes shut.
 *
 * Weight changes four things at once:
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
 *
 * A third layer lives here: the BLOCKER HUM. A permanent blocker is the one
 * object that can end a run outright, so inside `TUNING.read.blockerHumRadius`
 * a beating sub-bass drone fades in under everything else. It is driven by
 * `setBlockerDistance()` (or `s.blockerDistance` on the per-frame state) and
 * stays silent if nothing ever sets it.
 *
 * And a fourth, new in v3: the SHREDDING ROAR (§5). Above roughly six smashes a
 * second the discrete one-shots stop being individual events and start being
 * mud, so the impact layers duck out and this takes over — see `ShredLayer`.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, damp, lerp, TAU } from '../core/math.js';
import { weightTerm01 } from './engine.js';
import { IMPACT_MATERIALS } from './synth.js';

const S_RUMBLE_GAIN = 0;
const S_RUMBLE_CUT = 1;
const S_RUMBLE_RATE = 2;
const S_PEAK_HZ = 3;
const S_DRONE_HZ = 4;
const S_DRONE_GAIN = 5;
const S_WIND_GAIN = 6;
const S_WIND_CUT = 7;
const S_HUM_GAIN = 8;
const S_HUM_CUT = 9;
const S_COUNT = 10;

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
    this.humOscA = null;
    this.humOscB = null;
    this.humLP = null;
    this.humGain = null;

    /**
     * Metres to the nearest permanent blocker, or Infinity. Optional: the game
     * pushes it through `update`'s state object or `setBlockerDistance`, and if
     * nobody ever does, the hum simply never rises above silence.
     */
    this._blockerDist = Infinity;

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

    // ── blocker hum: the only warning a permanent blocker gives you that is
    //    not visual. Two oscillators a whisker apart so they BEAT — a steady
    //    tone reads as ambience, a beating one reads as a threat.
    const hA = ctx.createOscillator();
    hA.type = 'sawtooth';
    hA.frequency.value = A.blockerHumHz;

    const hB = ctx.createOscillator();
    hB.type = 'sine';
    hB.frequency.value = A.blockerHumHz;
    hB.detune.value = 9;

    const hlp = ctx.createBiquadFilter();
    hlp.type = 'lowpass';
    hlp.frequency.value = 140;
    hlp.Q.value = 2.4;

    const hg = ctx.createGain();
    hg.gain.value = 0;

    hA.connect(hlp);
    hB.connect(hlp);
    hlp.connect(hg);
    hg.connect(eng.sfxIn);

    const t = ctx.currentTime + 0.02;
    try { rs.start(t); } catch (e) { /* noop */ }
    try { osc.start(t); } catch (e) { /* noop */ }
    try { ws.start(t); } catch (e) { /* noop */ }
    try { hA.start(t); } catch (e) { /* noop */ }
    try { hB.start(t); } catch (e) { /* noop */ }

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
    this.humOscA = hA;
    this.humOscB = hB;
    this.humLP = hlp;
    this.humGain = hg;

    this.s[S_HUM_CUT] = 140;
    this.s[S_RUMBLE_CUT] = A.rollingCutoffMin;
    this.s[S_RUMBLE_RATE] = 1;
    this.s[S_PEAK_HZ] = A.rollingToneHz;
    this.s[S_DRONE_HZ] = A.droneHzMin;
    this.s[S_WIND_CUT] = A.windCutoffMin;
    for (let i = 0; i < S_COUNT; i++) this.w[i] = -1;

    this.ready = true;
  }

  /**
   * Metres to the nearest permanent blocker ahead. Anything at or beyond
   * `TUNING.read.blockerHumRadius` is silence; it fades in from there.
   * Pass Infinity (or nothing) when no blocker is in range.
   */
  setBlockerDistance(metres) {
    this._blockerDist = (typeof metres === 'number' && metres >= 0) ? metres : Infinity;
  }

  /**
   * @param {number} dt        unscaled seconds
   * @param {number} speed     m/s
   * @param {number} speed01   0..1 normalised speed
   * @param {number} weight    kg
   * @param {boolean} grounded
   * @param {boolean} playing
   */
  update(dt, speed, speed01, weight, grounded, playing) {
    if (!this.ready || !this.engine.ready) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const A = TUNING.audio;
    const P = TUNING.player;
    const s = this.s;

    const muting = this.engine.now < this._muteUntil;
    const sp01 = clamp01(speed01);
    const w = weight > 0 ? weight : P.startWeight;
    const mr = w / P.startWeight;
    const mt = weightTerm01(w);

    // ── targets
    const speedCurve = Math.pow(sp01, 0.6);
    let tGain;
    if (!playing) {
      tGain = 0;
    } else if (grounded) {
      tGain = A.rollingBaseGain * (0.22 + 0.78 * speedCurve) * (1 + mt * A.rollingWeightGain);
    } else {
      tGain = A.rollingBaseGain * A.airborneRumbleScale * sp01;
    }

    const weightDark = Math.pow(1 / (mr > 0.01 ? mr : 0.01), 0.12);
    // Weight darkens the rumble, but never below the tuned floor: at 140 t the
    // darkening factor is 0.53, which would drag a 180 Hz idle down to ~96 Hz
    // and turn the roll into mud.
    const tCut = clamp(
      lerp(A.rollingCutoffMin, A.rollingCutoffMax, Math.pow(sp01, 0.7)) * weightDark,
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

    // blocker hum — squared so it is genuinely inaudible until the blocker is
    // close enough to matter, then arrives fast
    const humRadius = TUNING.read.blockerHumRadius > 1 ? TUNING.read.blockerHumRadius : 46;
    const prox = this._blockerDist < humRadius ? clamp01(1 - this._blockerDist / humRadius) : 0;
    let tHumGain = playing ? A.blockerHumGain * prox * prox : 0;
    const tHumCut = lerp(110, 430, prox);

    if (muting) { tGain = 0; tDroneGain = 0; tWindGain = 0; tHumGain = 0; }

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
    s[S_HUM_GAIN] = damp(s[S_HUM_GAIN], tHumGain, kr, dt);
    s[S_HUM_CUT] = damp(s[S_HUM_CUT], tHumCut, kr, dt);

    // ── push
    this._set(S_RUMBLE_CUT, this.rumbleLP.frequency, 0.5);
    this._set(S_RUMBLE_RATE, this.rumbleSrc.playbackRate, 0.001);
    this._set(S_PEAK_HZ, this.rumblePeak.frequency, 0.25);
    this._set(S_DRONE_HZ, this.droneOsc.frequency, 0.05);
    this._set(S_WIND_CUT, this.windBP.frequency, 0.5);
    this._set(S_HUM_CUT, this.humLP.frequency, 0.5);
    if (!muting) {
      this._set(S_RUMBLE_GAIN, this.rumbleGain.gain, 0.0004);
      this._set(S_DRONE_GAIN, this.droneGain.gain, 0.0004);
      this._set(S_WIND_GAIN, this.windGain.gain, 0.0004);
      this._set(S_HUM_GAIN, this.humGain.gain, 0.0002);
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
    this._blockerDist = Infinity;
    if (!this.ready) {
      this.s[S_RUMBLE_GAIN] = 0;
      this.s[S_DRONE_GAIN] = 0;
      this.s[S_WIND_GAIN] = 0;
      this.s[S_HUM_GAIN] = 0;
      return;
    }
    const A = TUNING.audio;
    const s = this.s;
    // Zeroed here and held there by the muting branch in update(), so the JS
    // state and the scheduled ramp agree at the moment writes resume.
    s[S_RUMBLE_GAIN] = 0;
    s[S_DRONE_GAIN] = 0;
    s[S_WIND_GAIN] = 0;
    s[S_HUM_GAIN] = 0;
    s[S_HUM_CUT] = 140;
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
    this._rampTo(this.humGain.gain, 0, t);
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
    stop(this.humOscA);
    stop(this.humOscB);
    dis(this.rumbleLP);
    dis(this.rumblePeak);
    dis(this.rumbleGain);
    dis(this.droneLP);
    dis(this.droneGain);
    dis(this.windBP);
    dis(this.windGain);
    dis(this.humLP);
    dis(this.humGain);
    this.rumbleSrc = null;
    this.droneOsc = null;
    this.windSrc = null;
    this.humOscA = null;
    this.humOscB = null;
  }
}

// ─────────────────────────────────────────────────────────── the shredding roar

/**
 * Per-material shred character. Six numbers per material, in
 * `IMPACT_MATERIALS` order, packed flat so a lookup is an index and not an
 * object property chain.
 *
 *   band  Hz   where the grain texture sits
 *   q          how narrow that band is — glass is wide and airy, metal is focused
 *   tear  Hz   a resonant peak on top: the sound of something being pulled apart
 *   lp    Hz   the ceiling, fully open
 *   sub        relative weight of the sub layer
 *   rate       grain-density multiplier on the loop's playback rate
 *
 * This is the table that makes the roar CHANGE with what is being destroyed
 * rather than just get louder: shredding a hundred bottle crates is a bright
 * dense hiss, shredding a hundred silos is a slow low grinding.
 */
const SHRED_STRIDE = 6;
const SHRED_CHAR = new Float64Array([
  // band     q   tear      lp   sub  rate
  4200, 0.85, 6400, 13000, 0.30, 1.45,   // glass
  1150, 1.05, 2000,  5200, 0.45, 1.20,   // wood
  900, 1.10, 1500,  3600, 0.55, 1.00,    // metal — hollow, matching the tier
  820, 0.80, 1400,  5200, 0.80, 0.95,    // car
  430, 0.85,  700,  2600, 1.00, 0.80,    // heavy
  520, 0.70,  800,  2400, 0.75, 0.90,    // concrete
  1700, 0.70, 2600,  7000, 0.50, 1.15,   // water
  620, 0.60,  950,  2200, 0.60, 0.85,    // dirt
  300, 0.80,  480,  1900, 1.15, 0.70,    // structure
]);

/**
 * Tuning reads in this layer go through a fallback, which the rest of the module
 * does not bother with. The reason is `damp()`: one undefined key returns NaN,
 * NaN lands in the smoothed state, and every parameter this layer owns is dead
 * for the rest of the run — and the failure is a thrown AudioParam write three
 * frames later rather than a missing sound. The values here are the designed
 * ones; TUNING is still the place to change them.
 */
function num(v, d) { return isFinite(v) ? v : d; }

const SHRED_SUB_HZ = [30, 58];

function shredSubHz(i) {
  const r = TUNING.audio.shredSubHz;
  return r && r.length === 2 ? r[i] : SHRED_SUB_HZ[i];
}

const MAT_INDEX = Object.create(null);
for (let i = 0; i < IMPACT_MATERIALS.length; i++) MAT_INDEX[IMPACT_MATERIALS[i]] = i;

const H_MIX = 0;
const H_BAND = 1;
const H_Q = 2;
const H_TEAR = 3;
const H_LP = 4;
const H_RATE = 5;
const H_GAIN = 6;
const H_SUB_HZ = 7;
const H_SUB_GAIN = 8;
const H_COUNT = 9;

/**
 * THE SHREDDING ROAR (§5).
 *
 * Above `shredEnterRate` smashes a second, a wall of individual crunches stops
 * being a wall and becomes mud: twenty transients inside 200 ms mask each other
 * and the voice pool spends itself on sounds nobody can pick out. So past that
 * rate the discrete one-shots fade down (see `ImpactPlayer.setShredMix`) and
 * this continuous layer fades up in their place — one escalating roar, which
 * sounds enormous where twenty crunches sound cheap.
 *
 * Two things stop it chattering at the boundary:
 *   - HYSTERESIS: it engages at `shredEnterRate` (6/s) and only releases at
 *     `shredExitRate` (3/s), so a stream hovering around 6 stays engaged.
 *   - a MINIMUM DWELL (`shredMinHold`): a single frame's spike cannot flip it,
 *     and it cannot flip twice inside that window in either direction.
 *
 * The character is driven by three inputs and each moves something different:
 *   smashes/second → grain density, the ceiling, and level
 *   mass/second    → the sub layer, and it drags the whole band DOWNWARD
 *   material       → the band, the tear resonance and the ceiling (SHRED_CHAR)
 *
 * Nothing here allocates and nothing is scheduled: like the rest of this module
 * it damps in JS and writes AudioParam.value directly.
 */
export class ShredLayer {
  /**
   * @param {import('./engine.js').AudioEngine} engine
   * @param {AudioBuffer} loop seamless grain texture from `makeShredLoopBuffer`
   */
  constructor(engine, loop) {
    this.engine = engine;
    this.loop = loop;
    this.ready = false;

    this.src = null;
    this.band = null;
    this.tear = null;
    this.lp = null;
    this.gain = null;
    this.subOsc = null;
    this.subLP = null;
    this.subGain = null;

    /** Smoothed state, and the last value pushed to each param. */
    this.s = new Float64Array(H_COUNT);
    this.w = new Float64Array(H_COUNT);

    this._engaged = false;
    this._flipTime = -1e9;
    this._rate = 0;          // smashes/second, as last reported
    this._mass = 0;          // kg/second, as last reported
    this._mat = 0;           // index into SHRED_CHAR
    this._rateTime = -1e9;   // when setRate was last called
    this._muteUntil = -1e9;
  }

  /** 0..1 — how much of the mix the roar currently owns. */
  get mix() { return this.s[H_MIX]; }

  /** Is the roar currently the thing carrying the destruction? */
  get engaged() { return this._engaged; }

  start() {
    const eng = this.engine;
    if (this.ready || !eng.ready) return;
    const ctx = eng.ctx;
    const A = TUNING.audio;

    const src = ctx.createBufferSource();
    src.buffer = this.loop;
    src.loop = true;
    src.playbackRate.value = 1;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = SHRED_CHAR[H_BAND];
    band.Q.value = 0.9;

    // The tear: a resonant peak riding on top of the band. Without it the roar
    // is just filtered noise; with it there is something being pulled apart.
    const tear = ctx.createBiquadFilter();
    tear.type = 'peaking';
    tear.frequency.value = 1500;
    tear.Q.value = 1.6;
    tear.gain.value = num(A.shredTearDb, 6);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    lp.Q.value = 0.7;

    const g = ctx.createGain();
    g.gain.value = 0;

    src.connect(band);
    band.connect(tear);
    tear.connect(lp);
    lp.connect(g);
    g.connect(eng.sfxIn);

    // The mass layer. `impact.sub` swells for a handful of hits; past that rate
    // there is no gap between hits to swell in, so the low end goes continuous
    // and tracks total mass destroyed per second instead.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = shredSubHz(1);

    const slp = ctx.createBiquadFilter();
    slp.type = 'lowpass';
    slp.frequency.value = 150;
    slp.Q.value = 1.8;

    const sg = ctx.createGain();
    sg.gain.value = 0;

    osc.connect(slp);
    slp.connect(sg);
    sg.connect(eng.sfxIn);

    const t = ctx.currentTime + 0.02;
    try { src.start(t); } catch (e) { /* noop */ }
    try { osc.start(t); } catch (e) { /* noop */ }

    this.src = src;
    this.band = band;
    this.tear = tear;
    this.lp = lp;
    this.gain = g;
    this.subOsc = osc;
    this.subLP = slp;
    this.subGain = sg;

    const s = this.s;
    s[H_BAND] = SHRED_CHAR[H_BAND];
    s[H_Q] = 0.9;
    s[H_TEAR] = 1500;
    s[H_LP] = 4000;
    s[H_RATE] = 1;
    s[H_SUB_HZ] = shredSubHz(1);
    for (let i = 0; i < H_COUNT; i++) this.w[i] = -1;

    this.ready = true;
  }

  /**
   * Report the current destruction rate. Safe to call every frame, and safe
   * never to call at all — the rate decays to zero on its own if the game stops
   * reporting, so the roar can never be left running under a quiet ramp.
   *
   * @param {number} smashesPerSecond
   * @param {number} massPerSecond    kg/s being absorbed
   * @param {string} material         a resolved IMPACT_MATERIALS key
   */
  setRate(smashesPerSecond, massPerSecond, material) {
    this._rate = smashesPerSecond > 0 && isFinite(smashesPerSecond) ? smashesPerSecond : 0;
    this._mass = massPerSecond > 0 && isFinite(massPerSecond) ? massPerSecond : 0;
    const idx = MAT_INDEX[material];
    if (idx !== undefined) this._mat = idx;
    this._rateTime = this.engine.now;
  }

  /**
   * @param {number} dt      unscaled seconds
   * @param {boolean} playing
   */
  update(dt, playing) {
    if (!this.ready || !this.engine.ready) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const A = TUNING.audio;
    const s = this.s;
    const now = this.engine.now;

    // Staleness. A caller that stops reporting is a caller whose objects stopped
    // arriving, so the rate falls away rather than freezing at its last value.
    const stale = num(A.shredStale, 0.25);
    if (now - this._rateTime > stale) {
      const k = Math.exp(-dt / (stale > 0.01 ? stale : 0.25));
      this._rate *= k;
      this._mass *= k;
    }

    // ── engagement, with hysteresis and a minimum dwell
    const enter = num(A.shredEnterRate, 6);
    const exit = num(A.shredExitRate, 3);
    const canFlip = (now - this._flipTime) > num(A.shredMinHold, 0.35);
    if (!this._engaged) {
      if (playing && this._rate >= enter && canFlip) {
        this._engaged = true;
        this._flipTime = now;
      }
    } else if (!playing || (this._rate < exit && canFlip)) {
      this._engaged = false;
      this._flipTime = now;
    }

    const muting = now < this._muteUntil;
    const mixTarget = (this._engaged && playing && !muting) ? 1 : 0;
    // Asymmetric: it arrives fast because the mud it replaces is already
    // happening, and it leaves slowly so the last few hits do not fall off a
    // cliff into silence.
    // Defaulted, like the boot-path reads above: `damp` with an undefined
    // smoothing returns NaN, and one NaN frame would poison every parameter
    // this layer owns for the rest of the run.
    const kIn = num(A.shredFadeIn, 0.00001);
    const kOut = num(A.shredFadeOut, 0.12);
    s[H_MIX] = damp(s[H_MIX], mixTarget, mixTarget > s[H_MIX] ? kIn : kOut, dt);
    const mix = s[H_MIX];

    // ── the three drivers
    const full = num(A.shredRateFull, 18);
    const span = full > exit ? full - exit : 12;
    const rate01 = clamp01((this._rate - exit) / span);
    // Logarithmic, for the same reason weightTerm01 is: a run spans a few
    // hundred kg/s of bollards to tens of tonnes a second of freight.
    const ref = A.shredMassRef > 1 ? A.shredMassRef : 1500;
    const mass01 = clamp01(Math.log2(1 + this._mass / ref) / (A.shredMassSpan > 0.5 ? A.shredMassSpan : 4.5));
    const gainMax = num(A.shredGain, 0.55);
    const subMax = num(A.shredSubGain, 0.42);

    const o = this._mat * SHRED_STRIDE;
    const cBand = SHRED_CHAR[o];
    const cQ = SHRED_CHAR[o + 1];
    const cTear = SHRED_CHAR[o + 2];
    const cLp = SHRED_CHAR[o + 3];
    const cSub = SHRED_CHAR[o + 4];
    const cRate = SHRED_CHAR[o + 5];

    // Mass drags the whole texture downward — the roar of a hundred silos is not
    // the roar of a hundred crates played louder.
    const heavy = 1 - num(A.shredMassDarken, 0.38) * mass01;
    const tBand = clamp(cBand * heavy, 60, 16000);
    const tTear = clamp(cTear * heavy, 90, 18000);
    const tLp = clamp(lerp(cLp * 0.5, cLp, 0.35 + 0.65 * rate01) * heavy, 200, 18000);
    const tRate = clamp(cRate * (0.72 + 0.55 * rate01), 0.35, 2.4);
    const tGain = mix * gainMax * (0.55 + 0.45 * rate01) * (0.72 + 0.5 * mass01);
    const tSubGain = mix * subMax * cSub * (0.25 + 0.75 * mass01);
    const tSubHz = lerp(shredSubHz(1), shredSubHz(0), mass01);

    const k = num(A.shredSmoothing, 0.03);
    s[H_BAND] = damp(s[H_BAND], tBand, k, dt);
    s[H_Q] = damp(s[H_Q], cQ, k, dt);
    s[H_TEAR] = damp(s[H_TEAR], tTear, k, dt);
    s[H_LP] = damp(s[H_LP], tLp, k, dt);
    s[H_RATE] = damp(s[H_RATE], tRate, k, dt);
    s[H_GAIN] = damp(s[H_GAIN], tGain, k, dt);
    s[H_SUB_HZ] = damp(s[H_SUB_HZ], tSubHz, k, dt);
    s[H_SUB_GAIN] = damp(s[H_SUB_GAIN], tSubGain, k, dt);

    // Everything below the audible floor writes nothing at all, so an ordinary
    // run — which never reaches six smashes a second — costs eight compares.
    if (s[H_GAIN] < 0.0002 && s[H_SUB_GAIN] < 0.0002 && this.w[H_GAIN] <= 0.0002) return;

    this._set(H_BAND, this.band.frequency, 1.0);
    this._set(H_Q, this.band.Q, 0.01);
    this._set(H_TEAR, this.tear.frequency, 1.0);
    this._set(H_LP, this.lp.frequency, 1.0);
    this._set(H_RATE, this.src.playbackRate, 0.002);
    this._set(H_SUB_HZ, this.subOsc.frequency, 0.05);
    if (!muting) {
      this._set(H_GAIN, this.gain.gain, 0.0002);
      this._set(H_SUB_GAIN, this.subGain.gain, 0.0002);
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

  reset() {
    this._engaged = false;
    this._flipTime = -1e9;
    this._rate = 0;
    this._mass = 0;
    this._rateTime = -1e9;
    const s = this.s;
    s[H_MIX] = 0;
    s[H_GAIN] = 0;
    s[H_SUB_GAIN] = 0;
    if (!this.ready) return;
    for (let i = 0; i < H_COUNT; i++) this.w[i] = -1;
    const t = this.engine.now;
    this._muteUntil = t + FADE_TIME + 0.02;
    this._rampTo(this.gain.gain, t);
    this._rampTo(this.subGain.gain, t);
  }

  _rampTo(param, t) {
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(0, t + FADE_TIME);
    } catch (e) {
      try { param.value = 0; } catch (e2) { /* noop */ }
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
    stop(this.src);
    stop(this.subOsc);
    dis(this.band);
    dis(this.tear);
    dis(this.lp);
    dis(this.gain);
    dis(this.subLP);
    dis(this.subGain);
    this.src = null;
    this.subOsc = null;
  }
}
