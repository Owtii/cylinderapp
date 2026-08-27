/**
 * TONNAGE — procedural sample synthesis.
 *
 * There are no audio asset files. Every sound in the game is rendered here at
 * init with OfflineAudioContext and cached as AudioBuffers.
 *
 * Layout trick: instead of one OfflineAudioContext per sample (hundreds of
 * contexts), each *bank* renders all of its variants into a single offline
 * timeline at fixed slot offsets and the result is sliced apart. That keeps the
 * whole init to ~32 offline renders.
 *
 * Design brief per material — each must be identifiable by ear alone:
 *   glass    bright, long shimmering tail, high-Q inharmonic partials
 *   wood     dry, short, band-passed crack, mid-range, no tail
 *   metal    ringing modal partials with a twang (downward pitch bend)
 *   car      broadband crunch + a glass sub-layer + a low thud
 *   heavy    groaning low metal, beating partials, long low boom
 *   concrete dead, damped, almost no tail — deliberately unsatisfying
 *   water    noise burst with a rapid lowpass sweep + bubbles
 *   dirt     soft, muffled, gone in a moment
 */

import { TUNING } from '../tuning.js';
import { Rng } from '../core/rng.js';

/** Material keys, shared vocabulary. Order is stable — used for seeding. */
export const IMPACT_MATERIALS = ['glass', 'wood', 'metal', 'car', 'heavy', 'concrete', 'water', 'dirt'];
export const IMPACT_LAYERS = ['transient', 'body', 'debris'];

/** Frequency the sub bank settles on. Playback rate shifts it within subFreqRange. */
export const SUB_BASE_HZ = 55;

/** Pitch reference for the combo ding bank (buffers are rendered at this pitch). */
export const COMBO_BASE_HZ = TUNING.audio.comboRootHz;

// ── inharmonic partial sets (structural, not balance — kept local) ────────────
const GLASS_RATIOS = [1, 2.13, 3.44, 4.72, 6.05, 7.87];
const METAL_RATIOS = [1, 2.76, 5.40, 8.93, 11.34, 13.7];
const HEAVY_RATIOS = [1, 1.51, 2.34, 3.02, 4.19];
const BELL_RATIOS = [1, 2.0, 3.01, 4.17, 5.43];

const RENDER_CONCURRENCY = 4;
const SLOT_PAD = 0.06;      // silence between variants inside a bank render
const TAIL_FADE = 0.004;    // forced fade at each slice end — guarantees no click

// ─────────────────────────────────────────────────────────────── noise buffers

/**
 * White/pink noise buffer. Deterministic, so a build always sounds the same.
 * `pink` uses the Paul Kellet approximation — far more natural for rumble/wind.
 */
export function makeNoiseBuffer(ctx, seconds, channels, seed, pink) {
  const sr = ctx.sampleRate;
  const n = Math.max(64, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(channels, n, sr);
  const rng = new Rng(seed >>> 0);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    if (!pink) {
      for (let i = 0; i < n; i++) d[i] = rng.next() * 2 - 1;
    } else {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = rng.next() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        d[i] = out * 0.16;
      }
    }
  }
  return buf;
}

/**
 * Seamlessly loopable noise. The head is equal-power crossfaded with material
 * that follows the loop point, so there is no periodic click when it repeats
 * (a plain noise loop clicks once a filter is applied downstream).
 */
export function makeLoopBuffer(ctx, seconds, channels, seed, pink) {
  const sr = ctx.sampleRate;
  const n = Math.max(1024, Math.floor(sr * seconds));
  const fade = Math.min(Math.floor(sr * 0.08), Math.floor(n / 3));
  const src = makeNoiseBuffer(ctx, (n + fade) / sr, channels, seed, pink);
  const out = ctx.createBuffer(channels, n, sr);
  for (let c = 0; c < channels; c++) {
    const a = src.getChannelData(c);
    const d = out.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = a[i];
    for (let i = 0; i < fade; i++) {
      const w = (i / fade) * Math.PI * 0.5;
      d[i] = a[i] * Math.sin(w) + a[n + i] * Math.cos(w);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────── synthesis helpers

/** Filtered noise burst with an exponential percussive envelope. */
function nz(octx, out, nb, t0, o) {
  const dur = o.dur;
  const src = octx.createBufferSource();
  src.buffer = nb;
  src.loop = true;
  if (o.rate) src.playbackRate.value = o.rate;

  let node = src;
  if (o.type) {
    const f = octx.createBiquadFilter();
    f.type = o.type;
    f.Q.value = o.q === undefined ? 1 : o.q;
    const f0 = Math.max(20, o.f0);
    f.frequency.setValueAtTime(f0, t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      const sw = o.sweep === undefined ? dur : o.sweep;
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + sw);
    }
    node.connect(f);
    node = f;
  }
  if (o.type2) {
    const f2 = octx.createBiquadFilter();
    f2.type = o.type2;
    f2.Q.value = o.q2 === undefined ? 0.7 : o.q2;
    f2.frequency.value = Math.max(20, o.f2);
    node.connect(f2);
    node = f2;
  }

  const g = octx.createGain();
  const atk = o.attack === undefined ? 0.0012 : o.attack;
  const peak = Math.max(0.0004, o.gain);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
  if (o.hold) g.gain.setValueAtTime(peak, t0 + atk + o.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(dur, atk + 0.01));
  node.connect(g);
  g.connect(out);

  const off = o.offset ? (o.offset % Math.max(0.01, nb.duration - 0.05)) : 0;
  src.start(t0, off);
  src.stop(t0 + dur + 0.03);
}

/** Oscillator partial with optional pitch bend (the "twang") and decay. */
function tone(octx, out, t0, o) {
  const osc = octx.createOscillator();
  osc.type = o.type || 'sine';
  const f0 = Math.max(8, o.f0);
  osc.frequency.setValueAtTime(f0, t0);
  if (o.f1 !== undefined && o.f1 !== o.f0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.f1), t0 + (o.bend === undefined ? o.dur : o.bend));
  }
  if (o.detune) osc.detune.value = o.detune;

  const g = octx.createGain();
  const atk = o.attack === undefined ? 0.002 : o.attack;
  const peak = Math.max(0.0004, o.gain);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
  if (o.hold) g.gain.setValueAtTime(peak, t0 + atk + o.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(o.dur, atk + 0.01));

  osc.connect(g);
  let node = g;
  if (o.lp) {
    const f = octx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = o.lpq === undefined ? 0.7 : o.lpq;
    f.frequency.setValueAtTime(o.lp, t0);
    if (o.lp1) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.lp1), t0 + o.dur);
    node.connect(f);
    node = f;
  }
  node.connect(out);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.03);
}

/** High-Q resonator excited by a click — the classic "ping". */
function ping(octx, out, nb, t0, freq, q, dur, gain) {
  nz(octx, out, nb, t0, {
    dur: dur, gain: gain, type: 'bandpass', f0: freq, q: q, attack: 0.0006, offset: freq * 0.0007,
  });
}

// ──────────────────────────────────────────────────────── material definitions

const MAT = {
  glass: {
    dur: [0.22, 1.45, 0.55],
    norm: [0.90, 0.85, 0.60],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, { dur: 0.10, gain: 0.80, type: 'highpass', f0: 2400, q: 0.7, attack: 0.0006, offset: rng.next() });
      nz(octx, out, nb, t0, { dur: 0.05, gain: 0.65, type: 'bandpass', f0: 5000 + rng.spread(1200), q: 5, attack: 0.0005, offset: rng.next() });
      for (let i = 0; i < 3; i++) {
        ping(octx, out, nb, t0 + rng.range(0, 0.012), 2800 + rng.range(0, 4200), 22, 0.12 + rng.range(0, 0.08), 0.24);
      }
    },
    body(octx, out, nb, t0, rng) {
      const base = 1450 + rng.range(0, 650);
      for (let i = 0; i < GLASS_RATIOS.length; i++) {
        const f = base * GLASS_RATIOS[i] * (1 + rng.spread(0.025));
        tone(octx, out, t0 + rng.range(0, 0.02), {
          type: 'sine', f0: f, dur: (1.25 - i * 0.14) * rng.range(0.7, 1.0),
          gain: 0.30 / (1 + i * 0.55), attack: 0.003,
        });
      }
      // shimmer: high noise wash that outlives the partial attack
      nz(octx, out, nb, t0 + 0.005, { dur: 0.55, gain: 0.20, type: 'highpass', f0: 3400, q: 0.7, attack: 0.006, offset: rng.next() });
      nz(octx, out, nb, t0, { dur: 0.18, gain: 0.28, type: 'bandpass', f0: 1800 + rng.spread(400), q: 1.6, offset: rng.next() });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 3 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.32);
        ping(octx, out, nb, t, 2400 + rng.range(0, 5000), 26, 0.10 + rng.range(0, 0.10), 0.30);
        if (rng.bool(0.5)) {
          tone(octx, out, t + 0.004, { type: 'sine', f0: 3200 + rng.range(0, 3600), dur: 0.14, gain: 0.10 });
        }
      }
    },
  },

  wood: {
    dur: [0.14, 0.30, 0.28],
    norm: [0.90, 0.72, 0.55],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      // dry crack: mid band, gone in 30 ms, with a fast downward filter snap
      nz(octx, out, nb, t0, {
        dur: 0.045, gain: 0.95, type: 'bandpass', f0: 1500 + rng.spread(350), f1: 520,
        sweep: 0.03, q: 1.4, attack: 0.0007, offset: rng.next(),
      });
      nz(octx, out, nb, t0, { dur: 0.02, gain: 0.55, type: 'highpass', f0: 2600, q: 0.7, offset: rng.next() });
      tone(octx, out, t0, { type: 'triangle', f0: 320 + rng.spread(60), f1: 190, bend: 0.03, dur: 0.07, gain: 0.35 });
    },
    body(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, { dur: 0.16, gain: 0.55, type: 'bandpass', f0: 640 + rng.spread(160), q: 1.1, attack: 0.002, offset: rng.next() });
      tone(octx, out, t0, { type: 'sine', f0: 240 + rng.spread(40), f1: 165, bend: 0.05, dur: 0.16, gain: 0.40 });
      tone(octx, out, t0 + 0.004, { type: 'triangle', f0: 430 + rng.spread(70), dur: 0.11, gain: 0.20 });
      nz(octx, out, nb, t0 + 0.01, { dur: 0.09, gain: 0.16, type: 'lowpass', f0: 1200, q: 0.6, offset: rng.next() });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 3 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.18);
        nz(octx, out, nb, t, { dur: 0.05, gain: 0.42, type: 'bandpass', f0: 500 + rng.range(0, 900), q: 2.2, offset: rng.next() });
        tone(octx, out, t, { type: 'triangle', f0: 200 + rng.range(0, 260), dur: 0.05, gain: 0.14 });
      }
    },
  },

  metal: {
    dur: [0.16, 1.85, 0.70],
    norm: [0.92, 0.85, 0.60],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, { dur: 0.035, gain: 0.9, type: 'highpass', f0: 2200, q: 0.7, attack: 0.0005, offset: rng.next() });
      nz(octx, out, nb, t0, { dur: 0.06, gain: 0.6, type: 'bandpass', f0: 3600 + rng.spread(900), q: 3.5, offset: rng.next() });
      tone(octx, out, t0, { type: 'square', f0: 900 + rng.spread(200), f1: 420, bend: 0.02, dur: 0.05, gain: 0.22, lp: 5000 });
    },
    body(octx, out, nb, t0, rng) {
      const base = 300 + rng.range(0, 260);
      for (let i = 0; i < METAL_RATIOS.length; i++) {
        const f = base * METAL_RATIOS[i] * (1 + rng.spread(0.02));
        // the twang: every partial starts sharp and settles
        tone(octx, out, t0 + i * 0.0015, {
          type: 'sine', f0: f * 1.06, f1: f, bend: 0.05 + i * 0.01,
          dur: (1.7 - i * 0.2) * rng.range(0.75, 1.05),
          gain: 0.26 / (1 + i * 0.42), attack: 0.002,
        });
        // slight detune partner → slow beating, reads as "big sheet"
        if (i < 3) {
          tone(octx, out, t0, {
            type: 'sine', f0: f * 1.004, dur: (1.4 - i * 0.25), gain: 0.10 / (1 + i), attack: 0.006,
          });
        }
      }
      nz(octx, out, nb, t0, { dur: 0.30, gain: 0.26, type: 'bandpass', f0: 2600, q: 1.2, attack: 0.002, offset: rng.next() });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 2 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.4);
        const f = 420 + rng.range(0, 1500);
        tone(octx, out, t, { type: 'sine', f0: f * 1.05, f1: f, bend: 0.03, dur: 0.22, gain: 0.24 });
        tone(octx, out, t, { type: 'sine', f0: f * 2.76, dur: 0.16, gain: 0.11 });
        nz(octx, out, nb, t, { dur: 0.03, gain: 0.3, type: 'highpass', f0: 3000, offset: rng.next() });
      }
    },
  },

  car: {
    dur: [0.20, 0.85, 0.60],
    norm: [0.92, 0.88, 0.55],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      // broadband crunch — sheet metal folding
      nz(octx, out, nb, t0, { dur: 0.09, gain: 0.95, type: 'bandpass', f0: 900 + rng.spread(200), q: 0.5, attack: 0.0008, offset: rng.next() });
      nz(octx, out, nb, t0, { dur: 0.05, gain: 0.6, type: 'highpass', f0: 3200, q: 0.7, offset: rng.next() });
      tone(octx, out, t0, { type: 'sine', f0: 150, f1: 62, bend: 0.06, dur: 0.16, gain: 0.6 });
    },
    body(octx, out, nb, t0, rng) {
      // low thud
      tone(octx, out, t0, { type: 'sine', f0: 96, f1: 52, bend: 0.10, dur: 0.42, gain: 0.55 });
      // crunching mid
      nz(octx, out, nb, t0 + 0.005, { dur: 0.34, gain: 0.42, type: 'bandpass', f0: 620, f1: 300, sweep: 0.25, q: 0.8, attack: 0.003, offset: rng.next() });
      // the glass sub-layer inside the car
      for (let i = 0; i < 4; i++) {
        ping(octx, out, nb, t0 + rng.range(0.01, 0.22), 2600 + rng.range(0, 3800), 24, 0.16, 0.16);
      }
      // panel resonance
      const base = 220 + rng.range(0, 90);
      for (let i = 0; i < 3; i++) {
        tone(octx, out, t0, { type: 'sine', f0: base * METAL_RATIOS[i] * 1.02, f1: base * METAL_RATIOS[i], bend: 0.05, dur: 0.5 - i * 0.12, gain: 0.13 / (1 + i) });
      }
    },
    debris(octx, out, nb, t0, rng) {
      const n = 3 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.34);
        if (rng.bool(0.45)) {
          ping(octx, out, nb, t, 2600 + rng.range(0, 3400), 26, 0.12, 0.26);
        } else {
          nz(octx, out, nb, t, { dur: 0.07, gain: 0.34, type: 'bandpass', f0: 400 + rng.range(0, 900), q: 1.8, offset: rng.next() });
          tone(octx, out, t, { type: 'sine', f0: 180 + rng.range(0, 240), dur: 0.09, gain: 0.14 });
        }
      }
    },
  },

  heavy: {
    dur: [0.30, 2.55, 0.90],
    norm: [0.95, 0.92, 0.65],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, { dur: 0.14, gain: 1.0, type: 'lowpass', f0: 900, f1: 260, sweep: 0.10, q: 0.9, attack: 0.001, offset: rng.next() });
      nz(octx, out, nb, t0, { dur: 0.06, gain: 0.45, type: 'bandpass', f0: 1800, q: 1.4, offset: rng.next() });
      tone(octx, out, t0, { type: 'sine', f0: 120, f1: 44, bend: 0.14, dur: 0.34, gain: 0.75 });
    },
    body(octx, out, nb, t0, rng) {
      const base = 62 + rng.range(0, 26);
      for (let i = 0; i < HEAVY_RATIOS.length; i++) {
        const f = base * HEAVY_RATIOS[i];
        // groan: slow downward drift over the whole tail
        tone(octx, out, t0 + i * 0.01, {
          type: 'sine', f0: f * 1.03, f1: f * 0.93, bend: 1.6,
          dur: (2.3 - i * 0.28) * rng.range(0.8, 1.05),
          gain: 0.34 / (1 + i * 0.5), attack: 0.01,
        });
        // beating partner
        tone(octx, out, t0, { type: 'sine', f0: f * 1.008, dur: 1.9 - i * 0.3, gain: 0.14 / (1 + i * 0.6), attack: 0.03 });
      }
      // the long low boom
      tone(octx, out, t0, { type: 'sine', f0: 58, f1: 38, bend: 0.5, dur: 1.9, gain: 0.6, attack: 0.006 });
      // metal groan noise bed
      nz(octx, out, nb, t0 + 0.02, { dur: 1.1, gain: 0.20, type: 'bandpass', f0: 380, f1: 180, sweep: 0.9, q: 2.2, attack: 0.02, offset: rng.next() });
      nz(octx, out, nb, t0, { dur: 0.4, gain: 0.24, type: 'lowpass', f0: 500, q: 0.8, attack: 0.004, offset: rng.next() });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 3 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.55);
        const f = 120 + rng.range(0, 420);
        tone(octx, out, t, { type: 'sine', f0: f * 1.06, f1: f, bend: 0.05, dur: 0.34, gain: 0.30 });
        tone(octx, out, t, { type: 'sine', f0: f * 2.76, dur: 0.2, gain: 0.10 });
        nz(octx, out, nb, t, { dur: 0.09, gain: 0.30, type: 'lowpass', f0: 700, q: 0.8, offset: rng.next() });
      }
    },
  },

  concrete: {
    // deliberately the least satisfying sound in the game
    dur: [0.14, 0.22, 0.30],
    norm: [0.80, 0.68, 0.40],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, { dur: 0.055, gain: 0.85, type: 'lowpass', f0: 520, q: 0.6, attack: 0.001, offset: rng.next() });
      // NOTE: a bandpass/highpass barely attenuates noise while a low lowpass
      // costs ~18 dB, so these top layers need tiny nominal gains or concrete
      // ends up the brightest material in the game instead of the deadest.
      nz(octx, out, nb, t0, { dur: 0.02, gain: 0.05, type: 'bandpass', f0: 1000, q: 1.2, offset: rng.next() });
    },
    body(octx, out, nb, t0, rng) {
      tone(octx, out, t0, { type: 'sine', f0: 130, f1: 74, bend: 0.05, dur: 0.14, gain: 0.55 });
      nz(octx, out, nb, t0, { dur: 0.11, gain: 0.34, type: 'lowpass', f0: 340, q: 0.7, attack: 0.002, offset: rng.next() });
      tone(octx, out, t0, { type: 'triangle', f0: 196, f1: 150, bend: 0.04, dur: 0.09, gain: 0.16 });
      // a whisper of dust, then nothing
      nz(octx, out, nb, t0 + 0.01, { dur: 0.06, gain: 0.012, type: 'bandpass', f0: 1100, q: 0.9, offset: rng.next() });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 4 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.2);
        nz(octx, out, nb, t, { dur: 0.035, gain: 0.10, type: 'bandpass', f0: 500 + rng.range(0, 700), q: 3, offset: rng.next() });
        nz(octx, out, nb, t, { dur: 0.04, gain: 0.55, type: 'lowpass', f0: 420, q: 0.8, offset: rng.next() });
      }
    },
  },

  water: {
    dur: [0.34, 0.70, 0.45],
    norm: [0.85, 0.78, 0.50],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      // the whole character: a bright burst collapsing to a low woosh
      nz(octx, out, nb, t0, {
        dur: 0.26, gain: 0.9, type: 'lowpass', f0: 9000, f1: 300, sweep: 0.20, q: 1.1,
        attack: 0.001, offset: rng.next(),
      });
      nz(octx, out, nb, t0, { dur: 0.08, gain: 0.4, type: 'highpass', f0: 4000, q: 0.7, offset: rng.next() });
    },
    body(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, {
        dur: 0.55, gain: 0.5, type: 'bandpass', f0: 2200, f1: 420, sweep: 0.42, q: 0.9,
        attack: 0.004, offset: rng.next(),
      });
      nz(octx, out, nb, t0 + 0.02, { dur: 0.30, gain: 0.3, type: 'lowpass', f0: 1600, f1: 260, sweep: 0.28, q: 0.8, offset: rng.next() });
      // bubbles: little upward blips
      for (let i = 0; i < 5; i++) {
        const f = 300 + rng.range(0, 900);
        tone(octx, out, t0 + rng.range(0.02, 0.45), { type: 'sine', f0: f, f1: f * 2.1, bend: 0.05, dur: 0.07, gain: 0.14 });
      }
      tone(octx, out, t0, { type: 'sine', f0: 90, f1: 55, bend: 0.1, dur: 0.24, gain: 0.3 });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 4 + Math.floor(rng.next() * 4);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.3);
        const f = 500 + rng.range(0, 1600);
        tone(octx, out, t, { type: 'sine', f0: f, f1: f * 2.4, bend: 0.03, dur: 0.05, gain: 0.16 });
        nz(octx, out, nb, t, { dur: 0.03, gain: 0.16, type: 'bandpass', f0: f * 1.5, q: 2, offset: rng.next() });
      }
    },
  },

  dirt: {
    dur: [0.14, 0.28, 0.30],
    norm: [0.78, 0.62, 0.40],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, { dur: 0.07, gain: 0.8, type: 'lowpass', f0: 620, f1: 300, sweep: 0.05, q: 0.6, attack: 0.0015, offset: rng.next() });
      tone(octx, out, t0, { type: 'sine', f0: 110, f1: 60, bend: 0.05, dur: 0.10, gain: 0.35 });
    },
    body(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, { dur: 0.20, gain: 0.40, type: 'lowpass', f0: 420, q: 0.7, attack: 0.004, offset: rng.next() });
      nz(octx, out, nb, t0 + 0.01, { dur: 0.12, gain: 0.14, type: 'bandpass', f0: 1100, q: 1.4, offset: rng.next() });
      tone(octx, out, t0, { type: 'sine', f0: 84, f1: 50, bend: 0.08, dur: 0.20, gain: 0.34 });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 4 + Math.floor(rng.next() * 4);
      for (let i = 0; i < n; i++) {
        nz(octx, out, nb, t0 + rng.range(0, 0.22), {
          dur: 0.04, gain: 0.22, type: 'lowpass', f0: 600 + rng.range(0, 900), q: 0.9, offset: rng.next(),
        });
      }
    },
  },
};

// ───────────────────────────────────────────────────────── non-material banks

function renderSub(octx, out, nb, t0, rng) {
  // Settles on SUB_BASE_HZ. Playback rate maps it into TUNING.audio.subFreqRange.
  const f = SUB_BASE_HZ;
  // held, then a long exponential fall — the weight is in the sustain, not the click
  tone(octx, out, t0, {
    type: 'sine', f0: f * 1.55, f1: f, bend: 0.10, dur: 0.72, gain: 0.95,
    attack: 0.004, hold: 0.06,
  });
  // harmonics so laptop speakers still convey the weight
  tone(octx, out, t0, { type: 'sine', f0: f * 2, dur: 0.26, gain: 0.11, attack: 0.004 });
  tone(octx, out, t0, { type: 'sine', f0: f * 3, dur: 0.14, gain: 0.06, attack: 0.004 });
  // a touch of definition at the top of the hit
  nz(octx, out, nb, t0, { dur: 0.03, gain: 0.10, type: 'lowpass', f0: 380, q: 0.7, offset: rng.next() });
}

function renderCombo(octx, out, nb, t0, rng) {
  const f = COMBO_BASE_HZ;
  for (let i = 0; i < BELL_RATIOS.length; i++) {
    tone(octx, out, t0, {
      type: 'sine', f0: f * BELL_RATIOS[i] * (1 + rng.spread(0.001)),
      dur: 0.85 / (1 + i * 0.75), gain: 0.34 / (1 + i * 0.9), attack: 0.003,
    });
  }
  // mallet click gives it presence through a dense mix
  nz(octx, out, nb, t0, { dur: 0.012, gain: 0.22, type: 'bandpass', f0: f * 4, q: 2, offset: rng.next() });
  tone(octx, out, t0 + 0.012, { type: 'sine', f0: f * 1.5, dur: 0.5, gain: 0.10, attack: 0.006 });
}

function renderPickup(octx, out, nb, t0, rng) {
  const f = 880;
  tone(octx, out, t0, { type: 'sine', f0: f, dur: 0.30, gain: 0.34, attack: 0.002 });
  tone(octx, out, t0 + 0.055, { type: 'sine', f0: f * 1.5, dur: 0.40, gain: 0.30, attack: 0.002 });
  tone(octx, out, t0 + 0.10, { type: 'sine', f0: f * 2, dur: 0.45, gain: 0.24, attack: 0.002 });
  tone(octx, out, t0, { type: 'sine', f0: f * 3.01, dur: 0.12, gain: 0.08 });
  nz(octx, out, nb, t0, { dur: 0.02, gain: 0.13, type: 'highpass', f0: 4000, offset: rng.next() });
}

function renderJump(octx, out, nb, t0, rng) {
  nz(octx, out, nb, t0, {
    dur: 0.34, gain: 0.5, type: 'bandpass', f0: 380, f1: 2600, sweep: 0.26, q: 1.1,
    attack: 0.02, offset: rng.next(),
  });
  tone(octx, out, t0, { type: 'sine', f0: 90, f1: 220, bend: 0.16, dur: 0.22, gain: 0.42 });
  nz(octx, out, nb, t0, { dur: 0.05, gain: 0.3, type: 'lowpass', f0: 900, q: 0.7, offset: rng.next() });
}

function renderLand(octx, out, nb, t0, rng) {
  tone(octx, out, t0, { type: 'sine', f0: 150, f1: 45, bend: 0.09, dur: 0.5, gain: 0.85 });
  nz(octx, out, nb, t0, { dur: 0.20, gain: 0.6, type: 'lowpass', f0: 1200, f1: 220, sweep: 0.14, q: 0.9, attack: 0.001, offset: rng.next() });
  nz(octx, out, nb, t0 + 0.01, { dur: 0.45, gain: 0.20, type: 'bandpass', f0: 520, f1: 240, sweep: 0.35, q: 1.2, attack: 0.006, offset: rng.next() });
  // gravel scatter
  for (let i = 0; i < 4; i++) {
    nz(octx, out, nb, t0 + rng.range(0.02, 0.3), { dur: 0.04, gain: 0.16, type: 'bandpass', f0: 700 + rng.range(0, 1600), q: 3, offset: rng.next() });
  }
}

function renderUiClick(octx, out, nb, t0, rng) {
  nz(octx, out, nb, t0, { dur: 0.035, gain: 0.55, type: 'bandpass', f0: 1100 + rng.spread(120), q: 2.4, attack: 0.0006, offset: rng.next() });
  tone(octx, out, t0, { type: 'square', f0: 620, f1: 380, bend: 0.02, dur: 0.05, gain: 0.16, lp: 3200 });
}

function renderUiHover(octx, out, nb, t0, rng) {
  nz(octx, out, nb, t0, { dur: 0.02, gain: 0.24, type: 'bandpass', f0: 2200 + rng.spread(200), q: 3, attack: 0.0005, offset: rng.next() });
  tone(octx, out, t0, { type: 'sine', f0: 1800, dur: 0.04, gain: 0.09 });
}

function renderUiStart(octx, out, nb, t0, rng) {
  // rising steel sweep into a stamped-plate clank
  nz(octx, out, nb, t0, { dur: 0.5, gain: 0.30, type: 'bandpass', f0: 260, f1: 2800, sweep: 0.46, q: 1.3, attack: 0.06, offset: rng.next() });
  const hit = t0 + 0.5;
  nz(octx, out, nb, hit, { dur: 0.12, gain: 0.85, type: 'lowpass', f0: 2600, f1: 500, sweep: 0.09, q: 0.9, attack: 0.001, offset: rng.next() });
  const base = 180;
  for (let i = 0; i < 4; i++) {
    const f = base * METAL_RATIOS[i];
    tone(octx, out, hit, { type: 'sine', f0: f * 1.05, f1: f, bend: 0.06, dur: 1.2 - i * 0.22, gain: 0.26 / (1 + i * 0.6) });
  }
  tone(octx, out, hit, { type: 'sine', f0: 96, f1: 42, bend: 0.12, dur: 0.7, gain: 0.75 });
  tone(octx, out, hit + 0.02, { type: 'sine', f0: 55, dur: 0.9, gain: 0.4, attack: 0.02 });
}

function renderUiGameover(octx, out, nb, t0, rng) {
  // machinery winding down
  for (let i = 0; i < 3; i++) {
    const f = 196 * (i + 1) * 0.5;
    tone(octx, out, t0 + i * 0.01, {
      type: 'sawtooth', f0: f, f1: f * 0.32, bend: 1.15, dur: 1.35,
      gain: 0.18 / (1 + i), lp: 1800, lp1: 260, attack: 0.01,
    });
  }
  tone(octx, out, t0, { type: 'sine', f0: 84, f1: 34, bend: 1.2, dur: 1.5, gain: 0.55, attack: 0.01 });
  nz(octx, out, nb, t0, { dur: 0.9, gain: 0.16, type: 'lowpass', f0: 1400, f1: 200, sweep: 0.8, q: 0.8, attack: 0.02, offset: rng.next() });
  nz(octx, out, nb, t0 + 1.2, { dur: 0.35, gain: 0.4, type: 'lowpass', f0: 420, q: 0.8, attack: 0.002, offset: rng.next() });
}

// ─────────────────────────────────────────────────────────────── bank plumbing

/** The full key list. Also the manifest key space for `registerSamples`. */
export function bankKeys() {
  const keys = [];
  for (let m = 0; m < IMPACT_MATERIALS.length; m++) {
    for (let l = 0; l < IMPACT_LAYERS.length; l++) {
      keys.push('impact.' + IMPACT_MATERIALS[m] + '.' + IMPACT_LAYERS[l]);
    }
  }
  keys.push('impact.sub', 'combo.ding', 'pickup.chime', 'jump.whoosh', 'land.thud',
    'ui.click', 'ui.hover', 'ui.start', 'ui.gameover');
  return keys;
}

function buildJobs() {
  const jobs = [];
  const variants = Math.max(1, TUNING.audio.variantsPerLayer | 0);
  for (let m = 0; m < IMPACT_MATERIALS.length; m++) {
    const key = IMPACT_MATERIALS[m];
    const def = MAT[key];
    for (let l = 0; l < IMPACT_LAYERS.length; l++) {
      const layer = IMPACT_LAYERS[l];
      jobs.push({
        key: 'impact.' + key + '.' + layer,
        count: variants,
        dur: def.dur[l],
        norm: def.norm[l],
        seed: 0x5eed0000 + m * 977 + l * 31,
        fn: def[layer],
      });
    }
  }
  jobs.push({ key: 'impact.sub', count: Math.min(3, variants), dur: 0.80, norm: 0.95, seed: 0x51b0, fn: renderSub });
  jobs.push({ key: 'combo.ding', count: 3, dur: 1.00, norm: 0.85, seed: 0xcb01, fn: renderCombo });
  jobs.push({ key: 'pickup.chime', count: 3, dur: 0.70, norm: 0.85, seed: 0x9cc4, fn: renderPickup });
  jobs.push({ key: 'jump.whoosh', count: 3, dur: 0.50, norm: 0.72, seed: 0x1a3f, fn: renderJump });
  jobs.push({ key: 'land.thud', count: 3, dur: 0.80, norm: 0.92, seed: 0x2b7c, fn: renderLand });
  jobs.push({ key: 'ui.click', count: 2, dur: 0.10, norm: 0.55, seed: 0x3d19, fn: renderUiClick });
  jobs.push({ key: 'ui.hover', count: 2, dur: 0.07, norm: 0.38, seed: 0x4e2a, fn: renderUiHover });
  jobs.push({ key: 'ui.start', count: 1, dur: 1.80, norm: 0.88, seed: 0x5f3b, fn: renderUiStart });
  jobs.push({ key: 'ui.gameover', count: 1, dur: 1.80, norm: 0.82, seed: 0x60c4, fn: renderUiGameover });
  return jobs;
}

function hasOffline() {
  return typeof OfflineAudioContext !== 'undefined' ||
    (typeof webkitOfflineAudioContext !== 'undefined');
}

function newOffline(channels, frames, sr) {
  const Ctor = typeof OfflineAudioContext !== 'undefined'
    ? OfflineAudioContext
    : webkitOfflineAudioContext;
  return new Ctor(channels, frames, sr);
}

/**
 * Very small fallback used only if OfflineAudioContext is missing: a hand-rolled
 * filtered noise burst so the game is never silent.
 */
function fallbackBuffer(ctx, dur, seed) {
  const sr = ctx.sampleRate;
  const n = Math.max(64, Math.floor(dur * sr));
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const rng = new Rng(seed >>> 0);
  let lp = 0;
  const k = 0.25;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = Math.exp(-6 * t) * (1 - t);
    lp += k * ((rng.next() * 2 - 1) - lp);
    d[i] = lp * env * 0.8;
  }
  return buf;
}

async function renderJob(ctx, nb, job) {
  const sr = ctx.sampleRate;
  const slot = job.dur + SLOT_PAD;
  const slotFrames = Math.floor(slot * sr);
  const frames = slotFrames * job.count + 256;

  let rendered;
  try {
    const octx = newOffline(1, frames, sr);
    const master = octx.createGain();
    master.gain.value = 1;
    master.connect(octx.destination);
    const rng = new Rng(job.seed >>> 0);
    for (let v = 0; v < job.count; v++) {
      job.fn(octx, master, nb, v * slot + 0.004, rng, v);
    }
    rendered = await octx.startRendering();
  } catch (e) {
    const arr = new Array(job.count);
    for (let v = 0; v < job.count; v++) arr[v] = fallbackBuffer(ctx, job.dur, job.seed + v);
    return arr;
  }

  const data = rendered.getChannelData(0);
  const durFrames = Math.min(slotFrames, Math.ceil(job.dur * sr) + 64);
  const fadeFrames = Math.max(8, Math.floor(TAIL_FADE * sr));
  const arr = new Array(job.count);
  for (let v = 0; v < job.count; v++) {
    const start = v * slotFrames;
    const buf = ctx.createBuffer(1, durFrames, sr);
    const out = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < durFrames; i++) {
      const s = data[start + i] || 0;
      out[i] = s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    // Normalise to the bank's designed peak. Filters change absolute level by
    // 20 dB or more depending on their band, so without this the loudness of a
    // material would be an accident of its filter rather than a design choice.
    // Character lives in the spectrum and the envelope; loudness is deliberate.
    const target = job.norm > 0 ? job.norm : 0.9;
    if (peak > 1e-4) {
      const g = target / peak;
      for (let i = 0; i < durFrames; i++) out[i] *= g;
    }
    for (let i = 0; i < fadeFrames; i++) {
      const idx = durFrames - fadeFrames + i;
      if (idx >= 0) out[idx] *= 1 - i / fadeFrames;
    }
    arr[v] = buf;
  }
  return arr;
}

/**
 * Render every bank. Resolves to `{ key: AudioBuffer[] }`.
 * @param {BaseAudioContext} ctx  live context (buffers are created on it)
 * @param {AudioBuffer} noiseBuf  shared white-noise source buffer
 * @param {(t01:number)=>void} [onProgress]
 */
export async function renderBanks(ctx, noiseBuf, onProgress) {
  const jobs = buildJobs();
  const banks = Object.create(null);
  const total = jobs.length;
  let done = 0;

  if (!hasOffline()) {
    for (let i = 0; i < total; i++) {
      const job = jobs[i];
      const arr = new Array(job.count);
      for (let v = 0; v < job.count; v++) arr[v] = fallbackBuffer(ctx, job.dur, job.seed + v);
      banks[job.key] = arr;
    }
    if (onProgress) onProgress(1);
    return banks;
  }

  for (let i = 0; i < total; i += RENDER_CONCURRENCY) {
    const end = Math.min(total, i + RENDER_CONCURRENCY);
    const pending = [];
    for (let j = i; j < end; j++) pending.push(renderJob(ctx, noiseBuf, jobs[j]));
    const results = await Promise.all(pending);
    for (let j = i; j < end; j++) {
      banks[jobs[j].key] = results[j - i];
      done++;
    }
    if (onProgress) onProgress(done / total);
  }
  return banks;
}
