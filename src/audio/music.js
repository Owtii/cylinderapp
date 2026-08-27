/**
 * TONNAGE — procedural adaptive music.
 *
 * No asset files: a driving 4-bar loop in A minor generated from oscillators
 * and noise every time it plays. Scheduling uses the standard lookahead pattern
 * — a coarse timer (25 ms) that schedules notes ~120 ms ahead on the audio
 * clock. It is NEVER driven from the animation frame, so frame hitches, hitstop
 * and slow-motion cannot make the music stutter.
 *
 * Layers gate on combo intensity:
 *   0 drums (always)  1 bass  2 mid arp  3 lead pad
 * `setBlocked(true)` strips everything but the drums in 100 ms — the music
 * falling away is half of what makes hitting a barrier feel like a mistake.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01 } from '../core/math.js';

// ── pattern data (structural — the "score", not balance values) ──────────────
const STEPS_PER_BAR = 16;
const BARS = 4;
const TOTAL_STEPS = STEPS_PER_BAR * BARS;

const KICK  = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0];
const SNARE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
const HAT   = [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1];
const BASS  = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0];
const ARP   = [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

/** i - VI - III - VII in A minor. */
const ROOTS = [0, -4, 3, -2];
const IS_MINOR = [1, 0, 0, 0];
const MINOR_TONES = [0, 3, 7, 12, 15];
const MAJOR_TONES = [0, 4, 7, 12, 16];
const ARP_SEQ = [0, 1, 2, 3, 4, 3, 2, 1];

const BASS_HZ = 55;    // A1
const PAD_HZ = 110;    // A2
const ARP_HZ = 440;    // A4

const L_DRUMS = 0, L_BASS = 1, L_ARP = 2, L_PAD = 3;

function semiToHz(base, semi) {
  return base * Math.pow(2, semi / 12);
}

/** Shared `ended` handler: disconnects a note's little chain. No closures. */
function freeNote(ev) {
  const n = ev.target;
  if (!n) return;
  n.onended = null;
  try { n.disconnect(); } catch (e) { /* noop */ }
  if (n._m1) { try { n._m1.disconnect(); } catch (e) { /* noop */ } n._m1 = null; }
  if (n._m2) { try { n._m2.disconnect(); } catch (e) { /* noop */ } n._m2 = null; }
}

export class MusicSystem {
  constructor(engine, noiseBuf) {
    this.engine = engine;
    this.noise = noiseBuf;
    this.ready = false;
    this.running = false;

    this.mix = null;
    this.filter = null;
    this.layers = null;      // GainNode[4]

    this.intensity = 0;
    this.blocked = false;
    this.filterAmount = 0;

    this._step = 0;
    this._next = 0;
    this._timer = 0;
    this._target = new Float64Array(4);
    this._lastOn = new Float64Array(4);
    this._tickBound = this._tick.bind(this);
  }

  build() {
    const eng = this.engine;
    if (this.ready || !eng.ready) return;
    const ctx = eng.ctx;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = TUNING.audio.musicFilterMaxHz;
    filter.Q.value = 0.7;
    filter.connect(eng.musicIn);
    this.filter = filter;

    const mix = ctx.createGain();
    mix.gain.value = 0;
    mix.connect(filter);
    this.mix = mix;

    this.layers = new Array(4);
    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain();
      g.gain.value = i === L_DRUMS ? TUNING.audio.musicLayerMix[0] : 0;
      g.connect(mix);
      this.layers[i] = g;
    }
    this._target[L_DRUMS] = 1;
    this.ready = true;
    this._applyLayers();
    this._applyFilter();
  }

  // ───────────────────────────────────────────────────────────── transport

  setPlaying(b) {
    if (!this.ready) return;
    if (b && !this.running) this._start();
    else if (!b && this.running) this._stop();
  }

  _start() {
    const ctx = this.engine.ctx;
    this.running = true;
    this._step = 0;
    this._next = ctx.currentTime + TUNING.audio.musicStartDelay;
    const t = ctx.currentTime;
    try {
      this.mix.gain.cancelScheduledValues(t);
      this.mix.gain.setValueAtTime(this.mix.gain.value, t);
      this.mix.gain.linearRampToValueAtTime(1, t + 0.5);
    } catch (e) { /* noop */ }
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(this._tickBound, TUNING.audio.musicSchedulerMs);
    this._tick();
  }

  _stop() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = 0; }
    if (!this.ready) return;
    const t = this.engine.now;
    try {
      this.mix.gain.cancelScheduledValues(t);
      this.mix.gain.setValueAtTime(this.mix.gain.value, t);
      this.mix.gain.linearRampToValueAtTime(0, t + 0.45);
    } catch (e) { /* noop */ }
  }

  // ───────────────────────────────────────────────────────────── parameters

  setIntensity(t01) {
    const v = clamp01(t01);
    if (Math.abs(v - this.intensity) < 0.005) return;
    this.intensity = v;
    this._applyLayers();
  }

  setBlocked(b) {
    const v = !!b;
    if (v === this.blocked) return;
    this.blocked = v;
    this._applyLayers();
  }

  /** 0 = open, 1 = heavily filtered (slow-motion). */
  setFilter(t01) {
    const v = clamp01(t01);
    if (Math.abs(v - this.filterAmount) < 0.004) return;
    this.filterAmount = v;
    this._applyFilter();
  }

  _applyFilter() {
    if (!this.ready) return;
    const A = TUNING.audio;
    const t = this.engine.now;
    const hi = A.musicFilterMaxHz;
    const lo = A.musicFilterMinHz;
    const f = hi * Math.pow(lo / hi, this.filterAmount);
    try {
      this.filter.frequency.setTargetAtTime(clamp(f, 60, 22000), t, 0.05);
      this.filter.Q.setTargetAtTime(0.7 + 5 * this.filterAmount, t, 0.05);
    } catch (e) { /* noop */ }
  }

  _applyLayers() {
    if (!this.ready) return;
    const A = TUNING.audio;
    const th = A.musicLayerThresholds;
    const mixv = A.musicLayerMix;
    const width = A.musicLayerWidth > 0.001 ? A.musicLayerWidth : 0.15;
    const t = this.engine.now;
    const tc = (this.blocked ? A.musicBlockedFade : A.musicLayerFade) / 3;
    for (let i = 0; i < 4; i++) {
      let v;
      if (i === L_DRUMS) v = 1;
      else if (this.blocked) v = 0;
      else v = clamp01((this.intensity - th[i]) / width);
      this._target[i] = v;
      if (v > 0.001) this._lastOn[i] = this.engine.now;
      try {
        this.layers[i].gain.setTargetAtTime(v * mixv[i], t, tc);
      } catch (e) { /* noop */ }
    }
  }

  /** Should layer `i` still be scheduled? (keeps scheduling through its fade) */
  _live(i) {
    if (this._target[i] > 0.001) return true;
    return (this.engine.now - this._lastOn[i]) < 1.5;
  }

  // ───────────────────────────────────────────────────────── the scheduler

  _tick() {
    if (!this.running || !this.ready || !this.engine.ready) return;
    const ctx = this.engine.ctx;
    if (ctx.state !== 'running') return;   // never run ahead of a paused clock

    const A = TUNING.audio;
    const stepDur = 15 / (A.musicBpm > 20 ? A.musicBpm : 20);  // 60/bpm/4
    const now = ctx.currentTime;
    const horizon = now + A.musicLookahead;

    // Recover from a throttled timer (background tab) without a burst.
    if (this._next < now - 0.25) this._next = now + 0.02;

    let guard = 0;
    while (this._next < horizon && guard++ < 96) {
      this._scheduleStep(this._step, this._next, stepDur);
      this._next += stepDur;
      this._step++;
      if (this._step >= TOTAL_STEPS) this._step = 0;
    }
  }

  _scheduleStep(step, t, stepDur) {
    const bar = (step / STEPS_PER_BAR) | 0;
    const s = step % STEPS_PER_BAR;

    // ── drums (always)
    if (KICK[s]) this._kick(t, s === 0 ? 1 : 0.85);
    if (SNARE[s]) this._snare(t, 0.6);
    if (HAT[s]) this._hat(t, (s % 4 === 0) ? 0.30 : 0.18, s === 14 && bar === BARS - 1);

    // ── bass
    if (this._live(L_BASS) && BASS[s]) {
      const semi = ROOTS[bar] + (s === 13 ? 12 : 0);
      this._bass(t, semiToHz(BASS_HZ, semi), stepDur * 1.7);
    }

    // ── arp
    if (this._live(L_ARP) && ARP[s]) {
      const tones = IS_MINOR[bar] ? MINOR_TONES : MAJOR_TONES;
      const ai = ARP_SEQ[s % ARP_SEQ.length];
      const oct = (bar & 1) && s >= 8 ? 12 : 0;
      this._arp(t, semiToHz(ARP_HZ, ROOTS[bar] + tones[ai] + oct));
    }

    // ── pad (one chord per bar)
    if (this._live(L_PAD) && s === 0) {
      this._pad(t, stepDur * STEPS_PER_BAR, bar);
    }
  }

  // ─────────────────────────────────────────────────────────────── voices

  _kick(t, gain) {
    const ctx = this.engine.ctx;
    const out = this.layers[L_DRUMS];
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    o.connect(g);
    g.connect(out);
    o._m1 = g;
    o.onended = freeNote;
    o.start(t);
    o.stop(t + 0.32);
    this._noise(t, 0.016, 0.20 * gain, 'highpass', 2600, 1, out);
  }

  _snare(t, gain) {
    const ctx = this.engine.ctx;
    const out = this.layers[L_DRUMS];
    this._noise(t, 0.13, 0.30 * gain, 'highpass', 1400, 0.8, out);
    this._noise(t, 0.06, 0.22 * gain, 'bandpass', 2400, 1.4, out);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g);
    g.connect(out);
    o._m1 = g;
    o.onended = freeNote;
    o.start(t);
    o.stop(t + 0.11);
  }

  _hat(t, gain, open) {
    this._noise(t, open ? 0.20 : 0.035, gain, 'highpass', 7200, 0.9, this.layers[L_DRUMS]);
  }

  _bass(t, freq, dur) {
    const ctx = this.engine.ctx;
    const out = this.layers[L_BASS];
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 7;
    f.frequency.setValueAtTime(Math.min(2600, freq * 22), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(90, freq * 3), t + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f);
    f.connect(g);
    g.connect(out);
    o._m1 = f;
    o._m2 = g;
    o.onended = freeNote;
    o.start(t);
    o.stop(t + dur + 0.02);

    // sub reinforcement an octave down — keeps the low end solid on phones
    const s = ctx.createOscillator();
    s.type = 'sine';
    s.frequency.value = freq * 0.5;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
    s.connect(sg);
    sg.connect(out);
    s._m1 = sg;
    s.onended = freeNote;
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  _arp(t, freq) {
    const ctx = this.engine.ctx;
    const out = this.layers[L_ARP];
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(Math.min(6000, freq * 8), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 1.6), t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.24, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o.connect(f);
    f.connect(g);
    g.connect(out);
    o._m1 = f;
    o._m2 = g;
    o.onended = freeNote;
    o.start(t);
    o.stop(t + 0.17);
  }

  _pad(t, dur, bar) {
    const ctx = this.engine.ctx;
    const out = this.layers[L_PAD];
    const tones = IS_MINOR[bar] ? MINOR_TONES : MAJOR_TONES;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1500, t + dur * 0.5);
    f.frequency.linearRampToValueAtTime(700, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.20, t + dur * 0.35);
    g.gain.setValueAtTime(0.20, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.25);
    f.connect(g);
    g.connect(out);

    for (let i = 0; i < 3; i++) {
      const semi = ROOTS[bar] + tones[i];
      for (let d = 0; d < 2; d++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = semiToHz(PAD_HZ, semi);
        o.detune.value = d === 0 ? -7 : 7;
        o.connect(f);
        // only the last oscillator tears down the shared chain
        if (i === 2 && d === 1) {
          o._m1 = f;
          o._m2 = g;
          o.onended = freeNote;
        } else {
          o.onended = freeNote;
        }
        o.start(t);
        o.stop(t + dur + 0.3);
      }
    }
  }

  _noise(t, dur, gain, type, freq, q, out) {
    const ctx = this.engine.ctx;
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src._m1 = f;
    src._m2 = g;
    src.onended = freeNote;
    const off = (t * 7.13) % Math.max(0.05, this.noise.duration - 0.3);
    src.start(t, off < 0 ? 0 : off);
    src.stop(t + dur + 0.02);
  }

  reset() {
    this._stop();
    this.intensity = 0;
    this.blocked = false;
    this.filterAmount = 0;
    this._step = 0;
    if (!this.ready) return;
    this._applyLayers();
    this._applyFilter();
  }

  dispose() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = 0; }
    if (!this.ready) return;
    this.ready = false;
    for (let i = 0; i < 4; i++) {
      try { this.layers[i].disconnect(); } catch (e) { /* noop */ }
    }
    try { this.mix.disconnect(); } catch (e) { /* noop */ }
    try { this.filter.disconnect(); } catch (e) { /* noop */ }
    this.layers = null;
    this.mix = null;
    this.filter = null;
  }
}
