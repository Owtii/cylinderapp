/**
 * TONNAGE — procedural sample synthesis.
 *
 * There are no audio asset files. Every sound in the game is rendered here at
 * init with OfflineAudioContext and cached as AudioBuffers.
 *
 * Layout trick: instead of one OfflineAudioContext per sample (hundreds of
 * contexts), each *bank* renders all of its variants into a single offline
 * timeline at fixed slot offsets and the result is sliced apart. That keeps the
 * whole init to ~40 offline renders.
 *
 * Design brief per material — each must be identifiable by ear alone:
 *   glass     bright, long shimmering tail, high-Q inharmonic partials
 *   wood      dry, short, band-passed crack, mid-range, no tail
 *   metal     ringing modal partials with a twang (downward pitch bend)
 *   car       broadband crunch + a glass sub-layer + a low thud
 *   heavy     groaning low metal, beating partials, long low boom
 *   structure a BUILDING coming down: the longest, lowest bank in the game —
 *             a masonry thud, then two and a half seconds of rubble rumble
 *   concrete  dead, damped, almost no tail — deliberately unsatisfying
 *   water     noise burst with a rapid lowpass sweep + bubbles
 *   dirt      soft, muffled, gone in a moment
 *
 * And one bank that is designed to be actively unpleasant:
 *   blocked   the sound of failure. Nothing above ~250 Hz survives, the whole
 *             event is gone in ~60 ms, and it does not ring, tail or sub. It is
 *             measurably the shortest and dullest bank here, on purpose — see
 *             README.md for the measured table.
 */

import { TUNING } from '../tuning.js';
import { Rng } from '../core/rng.js';

/**
 * Material keys, shared vocabulary. Order is stable — used for seeding, so new
 * materials are APPENDED rather than inserted.
 */
export const IMPACT_MATERIALS = [
  'glass', 'wood', 'metal', 'car', 'heavy', 'concrete', 'water', 'dirt', 'structure',
];
export const IMPACT_LAYERS = ['transient', 'body', 'debris'];

/** Frequency the sub bank settles on. Playback rate shifts it within subFreqRange. */
export const SUB_BASE_HZ = 55;

/** Pitch the absorb coin bank is rendered at (C6). */
export const ABSORB_BASE_HZ = 1046.5;

/** Pitch the strike alarm is rendered at. */
export const STRIKE_BASE_HZ = 330;

/**
 * Pitch reference for the absorb/chain ding bank. The bank key is still
 * `combo.ding`, kept from v1 so an existing sample manifest resolves unchanged.
 * A function rather than a const: TUNING must not be read into module scope at
 * import time, or a tweak made before `init()` would be ignored.
 */
export function comboBaseHz() {
  const hz = TUNING.audio.comboRootHz;
  return hz > 20 ? hz : 233.08;
}

// ── inharmonic partial sets (structural, not balance — kept local) ────────────
const GLASS_RATIOS = [1, 2.13, 3.44, 4.72, 6.05, 7.87];
const METAL_RATIOS = [1, 2.76, 5.40, 8.93, 11.34, 13.7];
const HEAVY_RATIOS = [1, 1.51, 2.34, 3.02, 4.19];
const STRUCT_RATIOS = [1, 1.37, 1.94, 2.61, 3.33];
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

/**
 * The shredding roar's source material (§5). A seamless loop of dense, irregular
 * crunch grains over a quiet bed — a hundred objects a second going through the
 * drum, with none of them individually identifiable.
 *
 * It is built in plain JS rather than rendered offline for two reasons: it costs
 * nothing at init (the loading bar is already long enough), and the grain rate
 * has to survive `playbackRate` being pushed around at runtime, which a bank of
 * one-shots cannot do. Grains WRAP past the end of the buffer, so the loop point
 * is inaudible even though nothing is crossfaded over it.
 *
 * @param {number} density grains per second at playbackRate 1
 */
export function makeShredLoopBuffer(ctx, seconds, seed, density) {
  const sr = ctx.sampleRate;
  const n = Math.max(2048, Math.floor(sr * seconds));
  const bed = makeLoopBuffer(ctx, n / sr, 1, seed ^ 0x5c1a, true);
  const out = ctx.createBuffer(1, n, sr);
  const d = out.getChannelData(0);
  const b = bed.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = b[i] * 0.28;

  const rng = new Rng((seed >>> 0) ^ 0x9e3779b9);
  const grains = Math.max(1, Math.floor((density > 0 ? density : 60) * seconds));
  for (let g = 0; g < grains; g++) {
    const start = Math.floor(rng.next() * n);
    const tau = 0.0025 + rng.next() * rng.next() * 0.016;   // mostly short, a few long
    const len = Math.min(n, Math.floor(tau * 7 * sr));
    const amp = 0.35 + rng.next() * rng.next() * 1.2;
    // Each grain gets its own one-pole band: the colour spread across grains is
    // what stops the sum reading as flat noise.
    const lpK = Math.exp(-2 * Math.PI * (900 + rng.next() * 5200) / sr);
    const hpK = Math.exp(-2 * Math.PI * (60 + rng.next() * 320) / sr);
    let lp = 0;
    let hpPrev = 0;
    let hpOut = 0;
    const decay = Math.exp(-1 / (tau * sr));
    let env = amp;
    for (let i = 0; i < len; i++) {
      const w = rng.next() * 2 - 1;
      lp = lp * lpK + w * (1 - lpK);
      hpOut = hpK * (hpOut + lp - hpPrev);
      hpPrev = lp;
      d[(start + i) % n] += hpOut * env;
      env *= decay;
    }
  }

  let peak = 0;
  for (let i = 0; i < n; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
  if (peak > 1e-4) { const k = 0.85 / peak; for (let i = 0; i < n; i++) d[i] *= k; }
  return out;
}

/**
 * Impulse response for the tunnel send (§17). Early reflections off close
 * concrete walls, then a diffuse tail that darkens as it decays — a road tunnel
 * is a hard box with a lot of absorption above 4 kHz, not a cathedral.
 */
export function makeReverbIr(ctx, seconds, decay, seed) {
  const sr = ctx.sampleRate;
  const n = Math.max(256, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, n, sr);
  const rng = new Rng(seed >>> 0);
  const k = decay > 0.05 ? decay : 0.45;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    // The tail's lowpass coefficient sweeps down over the decay, so the last
    // reflections are duller than the first.
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t / k) * (1 - i / n);
      const a = 1 - Math.exp(-2 * Math.PI * (5200 * Math.exp(-t / (k * 1.5)) + 260) / sr);
      lp += a * ((rng.next() * 2 - 1) - lp);
      d[i] = lp * env;
    }
    // discrete early reflections: the two walls and the roof
    const taps = [0.011, 0.019, 0.027, 0.041, 0.058];
    for (let i = 0; i < taps.length; i++) {
      const at = Math.floor((taps[i] + (c === 0 ? 0 : 0.0035)) * sr);
      if (at < n) d[at] += (0.55 - i * 0.09) * (rng.bool() ? 1 : -1);
    }
    let peak = 0;
    for (let i = 0; i < n; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
    if (peak > 1e-4) { const g = 0.55 / peak; for (let i = 0; i < n; i++) d[i] *= g; }
  }
  return buf;
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
        // The glitter. This is the layer that has to keep the glass tier above
        // the car tier's windscreen pings, so it reaches higher than they do.
        ping(octx, out, nb, t, 3400 + rng.range(0, 5600), 26, 0.10 + rng.range(0, 0.10), 0.30);
        if (rng.bool(0.6)) {
          tone(octx, out, t + 0.004, { type: 'sine', f0: 4200 + rng.range(0, 4200), dur: 0.14, gain: 0.11 });
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
      // The split of the grain. Dry means BAND-limited: an open highpass here
      // put the wood tier's composite spectrum on top of glass, which is the
      // one confusion §11 will not have.
      nz(octx, out, nb, t0, {
        dur: 0.02, gain: 0.42, type: 'bandpass', f0: 1900, q: 0.9,
        type2: 'lowpass', f2: 2800, q2: 0.7, offset: rng.next(),
      });
      tone(octx, out, t0, { type: 'triangle', f0: 320 + rng.spread(60), f1: 190, bend: 0.03, dur: 0.07, gain: 0.35, lp: 2600 });
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
        // Splinters, not shards: the second lowpass is what keeps them dry. A
        // Q 2.2 bandpass leaks most of the noise floor straight through, which
        // is why the wood TIER measured as bright as glass before this stage.
        nz(octx, out, nb, t, {
          dur: 0.05, gain: 0.42, type: 'bandpass', f0: 460 + rng.range(0, 620), q: 2.2,
          type2: 'lowpass', f2: 1250, q2: 0.7, offset: rng.next(),
        });
        tone(octx, out, t, { type: 'triangle', f0: 200 + rng.range(0, 260), dur: 0.05, gain: 0.14, lp: 2000 });
      }
    },
  },

  // Zone 3's furniture tier. The brief is a HOLLOW CLANG — a phone booth, a
  // vending machine, a kiosk: a big empty box that rings dull. It used to be a
  // bright ping whose composite centroid landed within 10 % of glass, which is
  // the one thing §11 says must never happen, so the top two modal partials are
  // gone, the transient's sparkle is lowpassed off, and a pipe resonance
  // (odd harmonics of an air column) carries the ring instead.
  metal: {
    dur: [0.16, 1.85, 0.70],
    // The body is normalised higher than any other material's: the RING is the
    // whole identity of this tier, and it has to still be above -40 dB of the
    // composite a full second after the contact or furniture measures as dry
    // as wood.
    norm: [0.92, 0.94, 0.60],
    transient(octx, out, nb, t0, rng) {
      nz(octx, out, nb, t0, {
        dur: 0.040, gain: 0.95, type: 'bandpass', f0: 1150 + rng.spread(220), q: 1.1,
        type2: 'lowpass', f2: 2600, q2: 0.7, attack: 0.0006, offset: rng.next(),
      });
      // the box wall going in — a bonk, not a click
      tone(octx, out, t0, { type: 'square', f0: 520 + rng.spread(90), f1: 250, bend: 0.025, dur: 0.06, gain: 0.34, lp: 1800 });
      // a whisper of edge, so it still reads as sheet steel rather than a drum
      nz(octx, out, nb, t0, { dur: 0.016, gain: 0.05, type: 'highpass', f0: 3400, q: 0.7, attack: 0.0005, offset: rng.next() });
    },
    body(octx, out, nb, t0, rng) {
      const base = 186 + rng.range(0, 90);
      // Only the first three modal partials survive: 8.93 and 13.7 are what made
      // this bank measure like broken glass.
      for (let i = 0; i < 3; i++) {
        const f = base * METAL_RATIOS[i] * (1 + rng.spread(0.02));
        // the twang: every partial starts sharp and settles
        tone(octx, out, t0 + i * 0.0015, {
          type: 'sine', f0: f * 1.06, f1: f, bend: 0.05 + i * 0.01,
          dur: (1.80 - i * 0.22) * rng.range(0.80, 1.05),
          gain: 0.30 / (1 + i * 0.42), attack: 0.002, lp: 2400,
        });
        // slight detune partner → slow beating, reads as "big sheet"
        tone(octx, out, t0, {
          type: 'sine', f0: f * 1.004, dur: (1.4 - i * 0.25), gain: 0.11 / (1 + i), attack: 0.006,
        });
      }
      // the hollow: odd harmonics of the air column inside the box, which is
      // the difference between a struck plate and a struck cabinet
      const pipe = 132 + rng.range(0, 44);
      for (let i = 0; i < 3; i++) {
        tone(octx, out, t0 + 0.004, {
          type: 'sine', f0: pipe * (1 + i * 2), dur: 1.72 - i * 0.30,
          gain: 0.26 / (1 + i * 1.3), attack: 0.008, lp: 1500,
        });
      }
      nz(octx, out, nb, t0, {
        dur: 0.30, gain: 0.30, type: 'bandpass', f0: 900, q: 1.0,
        type2: 'lowpass', f2: 1700, q2: 0.7, attack: 0.002, offset: rng.next(),
      });
    },
    debris(octx, out, nb, t0, rng) {
      const n = 2 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.4);
        const f = 260 + rng.range(0, 620);
        tone(octx, out, t, { type: 'sine', f0: f * 1.05, f1: f, bend: 0.03, dur: 0.24, gain: 0.26, lp: 1600 });
        tone(octx, out, t, { type: 'sine', f0: f * 2.76, dur: 0.14, gain: 0.07, lp: 2200 });
        nz(octx, out, nb, t, {
          dur: 0.035, gain: 0.30, type: 'bandpass', f0: 700 + rng.range(0, 500), q: 1.4,
          type2: 'lowpass', f2: 1500, q2: 0.7, offset: rng.next(),
        });
      }
    },
  },

  car: {
    dur: [0.20, 0.85, 0.60],
    norm: [0.92, 0.88, 0.55],   // peak each variant is normalised to
    transient(octx, out, nb, t0, rng) {
      // broadband crunch — sheet metal folding
      nz(octx, out, nb, t0, { dur: 0.09, gain: 0.95, type: 'bandpass', f0: 780 + rng.spread(180), q: 0.5, attack: 0.0008, offset: rng.next() });
      // a rim of glass at the top of the crunch, capped: unfiltered air up here
      // is what used to make a sedan measure as bright as a greenhouse
      nz(octx, out, nb, t0, {
        dur: 0.05, gain: 0.30, type: 'bandpass', f0: 3000, q: 0.8,
        type2: 'lowpass', f2: 4800, q2: 0.7, offset: rng.next(),
      });
      tone(octx, out, t0, { type: 'sine', f0: 150, f1: 62, bend: 0.06, dur: 0.16, gain: 0.6 });
    },
    body(octx, out, nb, t0, rng) {
      // low thud
      tone(octx, out, t0, { type: 'sine', f0: 96, f1: 52, bend: 0.10, dur: 0.42, gain: 0.55 });
      // crunching mid
      nz(octx, out, nb, t0 + 0.005, { dur: 0.34, gain: 0.42, type: 'bandpass', f0: 620, f1: 300, sweep: 0.25, q: 0.8, attack: 0.003, offset: rng.next() });
      // The glass sub-layer inside the car. §11 asks for it explicitly, but it
      // is a windscreen inside a crushing shell, not a greenhouse: three pings,
      // an octave below the glass tier's, or the two tiers converge.
      for (let i = 0; i < 3; i++) {
        ping(octx, out, nb, t0 + rng.range(0.01, 0.22), 2100 + rng.range(0, 2300), 24, 0.16, 0.15);
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
        if (rng.bool(0.2)) {
          ping(octx, out, nb, t, 1800 + rng.range(0, 1800), 26, 0.12, 0.22);
        } else {
          // the crunch: folding panel, not shattering pane
          nz(octx, out, nb, t, {
            dur: 0.07, gain: 0.36, type: 'bandpass', f0: 400 + rng.range(0, 800), q: 1.8,
            type2: 'lowpass', f2: 2400, q2: 0.7, offset: rng.next(),
          });
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
        tone(octx, out, t, { type: 'sine', f0: f * 1.06, f1: f, bend: 0.05, dur: 0.34, gain: 0.30, lp: 1200 });
        tone(octx, out, t, { type: 'sine', f0: f * 2.76, dur: 0.2, gain: 0.07, lp: 1600 });
        // second pole pair: one lowpass leaves enough shoulder for the truck
        // tier to measure brighter than the car tier, which is backwards
        nz(octx, out, nb, t, {
          dur: 0.09, gain: 0.30, type: 'lowpass', f0: 700, q: 0.8,
          type2: 'lowpass', f2: 820, q2: 0.7, offset: rng.next(),
        });
      }
    },
  },

  // Zone 6. A shed, a silo, a water tower — 10 t and up. `heavy` is a vehicle
  // being crushed; this is a BUILDING coming down, so the event is twice as
  // long, an octave lower, and most of its energy is in the rubble rather than
  // the contact. It is the counterweight to `blocked`: the longest and (with
  // `dirt`) among the darkest banks, but enormous rather than dead.
  structure: {
    dur: [0.40, 3.20, 1.30],
    norm: [0.96, 0.95, 0.70],
    transient(octx, out, nb, t0, rng) {
      // masonry, not metal: a wide dull slab of noise falling to almost nothing
      nz(octx, out, nb, t0, { dur: 0.22, gain: 1.0, type: 'lowpass', f0: 560, f1: 130, sweep: 0.16, q: 0.8, attack: 0.0028, offset: rng.next() });
      nz(octx, out, nb, t0, { dur: 0.09, gain: 0.05, type: 'bandpass', f0: 1150 + rng.spread(250), q: 1.0, offset: rng.next() });
      // the floor moving
      tone(octx, out, t0, { type: 'sine', f0: 92, f1: 31, bend: 0.22, dur: 0.38, gain: 0.9, attack: 0.003 });
      tone(octx, out, t0, { type: 'triangle', f0: 152, f1: 68, bend: 0.10, dur: 0.16, gain: 0.22, lp: 520 });
    },
    body(octx, out, nb, t0, rng) {
      const base = 41 + rng.range(0, 14);
      for (let i = 0; i < STRUCT_RATIOS.length; i++) {
        const f = base * STRUCT_RATIOS[i];
        // the frame failing: a very slow downward drift across the whole tail
        tone(octx, out, t0 + i * 0.02, {
          type: 'sine', f0: f * 1.04, f1: f * 0.86, bend: 2.6,
          dur: (2.9 - i * 0.30) * rng.range(0.85, 1.05),
          gain: 0.36 / (1 + i * 0.55), attack: 0.02,
        });
        tone(octx, out, t0, { type: 'sine', f0: f * 1.011, dur: 2.4 - i * 0.32, gain: 0.15 / (1 + i * 0.6), attack: 0.05 });
      }
      // the sustained sub-bass of a mass hitting the ground
      tone(octx, out, t0, { type: 'sine', f0: 44, f1: 29, bend: 0.9, dur: 2.6, gain: 0.85, attack: 0.008 });
      // the rubble bed: overlapping low noise swells that keep collapsing
      for (let i = 0; i < 6; i++) {
        const t = t0 + 0.04 + i * 0.34 + rng.range(0, 0.14);
        nz(octx, out, nb, t, {
          dur: 0.75 + rng.range(0, 0.5), gain: 0.42 * (1 - i * 0.11),
          type: 'lowpass', f0: 400 - i * 40, f1: 135, sweep: 0.5, q: 0.7,
          type2: 'lowpass', f2: 420, q2: 0.6,
          attack: 0.03 + rng.range(0, 0.05), offset: rng.next(),
        });
      }
      // grit: quiet, because a lowpass costs ~20 dB and a bandpass costs almost
      // nothing — matched by ear, not by nominal gain (see the concrete note)
      for (let i = 0; i < 5; i++) {
        nz(octx, out, nb, t0 + rng.range(0.05, 2.3), {
          dur: 0.09, gain: 0.008, type: 'bandpass', f0: 520 + rng.range(0, 900), q: 1.6, offset: rng.next(),
        });
      }
    },
    debris(octx, out, nb, t0, rng) {
      const n = 3 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(0, 0.85);
        const f = 70 + rng.range(0, 190);
        tone(octx, out, t, { type: 'sine', f0: f * 1.08, f1: f, bend: 0.07, dur: 0.42, gain: 0.34, lp: 900 });
        nz(octx, out, nb, t, {
          dur: 0.16, gain: 0.34, type: 'lowpass', f0: 480, q: 0.8,
          type2: 'lowpass', f2: 560, q2: 0.7, offset: rng.next(),
        });
        nz(octx, out, nb, t + 0.02, {
          dur: 0.05, gain: 0.006, type: 'bandpass', f0: 700 + rng.range(0, 900), q: 2.0,
          type2: 'lowpass', f2: 1400, q2: 0.7, offset: rng.next(),
        });
      }
    },
  },

  concrete: {
    // the least satisfying MATERIAL in the game (`blocked` below is worse still)
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

/**
 * THE BLOCKED SIGNATURE — deliberately the worst sound in the game.
 *
 * Every other bank is designed to reward: something rings, something tails,
 * something lands in the sub. This one is engineered to give nothing back.
 *   • a 210 Hz lowpass, swept down to 95 Hz inside 25 ms — no upper spectrum;
 *   • total decay under 60 ms — no body, no tail;
 *   • two short sine partials with no bend to speak of — it does not ring;
 *   • normalised to a lower peak than any impact transient — it is not a payoff.
 * `ImpactPlayer` also refuses it the sub layer and the debris tail, so a block
 * is the only event in the game with no low end and no scatter.
 */
function renderBlocked(octx, out, nb, t0, rng) {
  // Two cascaded lowpasses (24 dB/oct) rather than one, because a single pole
  // pair leaves enough 400 Hz shoulder to measure brighter than `concrete`.
  nz(octx, out, nb, t0, {
    dur: 0.026, gain: 0.90, type: 'lowpass', f0: 140, f1: 66, sweep: 0.020, q: 0.5,
    type2: 'lowpass', f2: 155, q2: 0.6, attack: 0.005, offset: rng.next(),
  });
  // The `lp` on both partials is not for the sine — it is for the ENVELOPE. A
  // 4 ms exponential attack is itself a broadband click, and filtering after the
  // gain node is the only way to keep that click out of the spectrum.
  tone(octx, out, t0, { type: 'sine', f0: 74, f1: 56, bend: 0.024, dur: 0.034, gain: 0.62, attack: 0.0055, lp: 150 });
  tone(octx, out, t0, { type: 'sine', f0: 104, f1: 86, bend: 0.016, dur: 0.020, gain: 0.08, attack: 0.0045, lp: 130 });
  // the barest scrape of contact, so it is not literally a sine blip. Tiny and
  // heavily lowpassed, because a bandpass barely attenuates noise while the
  // lowpasses above cost ~20 dB — nominal gains are not comparable across types.
  nz(octx, out, nb, t0, {
    dur: 0.007, gain: 0.05, type: 'lowpass', f0: 215, q: 0.6,
    type2: 'lowpass', f2: 180, q2: 0.6, attack: 0.0035, offset: rng.next(),
  });
}

/**
 * The strike alarm. One harsh industrial buzzer blip; `playStrike` fires N of
 * them in a rising burst. This is the ONLY sound in the game allowed to be
 * unpleasant in a bright way — the blocked thud says "nothing happened", this
 * says "something is wrong with you".
 */
function renderStrike(octx, out, nb, t0, rng) {
  const f = STRIKE_BASE_HZ;
  tone(octx, out, t0, { type: 'square', f0: f, dur: 0.15, gain: 0.30, lp: 2600, attack: 0.002, hold: 0.055 });
  tone(octx, out, t0, { type: 'square', f0: f * 1.5, dur: 0.13, gain: 0.15, lp: 3200, attack: 0.002, hold: 0.045 });
  tone(octx, out, t0, { type: 'sawtooth', f0: f * 0.5, dur: 0.17, gain: 0.20, lp: 1500, attack: 0.003, hold: 0.05 });
  nz(octx, out, nb, t0, { dur: 0.045, gain: 0.26, type: 'bandpass', f0: 2600 + rng.spread(200), q: 2.0, attack: 0.0008, offset: rng.next() });
  nz(octx, out, nb, t0, { dur: 0.10, gain: 0.08, type: 'highpass', f0: 3600, attack: 0.002, offset: rng.next() });
}

/**
 * The absorb coin: money landing on a steel counter. Rendered at
 * ABSORB_BASE_HZ; `playAbsorb` transposes it and fires one to three taps.
 */
function renderAbsorb(octx, out, nb, t0, rng) {
  const f = ABSORB_BASE_HZ;
  nz(octx, out, nb, t0, { dur: 0.009, gain: 0.30, type: 'bandpass', f0: f * 3, q: 2.6, attack: 0.0005, offset: rng.next() });
  tone(octx, out, t0, { type: 'sine', f0: f, dur: 0.22, gain: 0.42, attack: 0.0016 });
  tone(octx, out, t0 + 0.004, { type: 'sine', f0: f * 1.5, dur: 0.16, gain: 0.16, attack: 0.002 });
  tone(octx, out, t0, { type: 'sine', f0: f * 2.76, dur: 0.10, gain: 0.13, attack: 0.0014 });
  tone(octx, out, t0, { type: 'sine', f0: f * 5.4, dur: 0.045, gain: 0.06, attack: 0.001 });
}

/** The till drawer under a big absorb — a fat low thunk with a wooden edge. */
function renderTill(octx, out, nb, t0, rng) {
  tone(octx, out, t0, { type: 'sine', f0: 152, f1: 68, bend: 0.07, dur: 0.30, gain: 0.60 });
  nz(octx, out, nb, t0, { dur: 0.10, gain: 0.40, type: 'lowpass', f0: 900, f1: 260, sweep: 0.07, q: 0.8, attack: 0.0012, offset: rng.next() });
  // the brass edge of the drawer. Deliberately bright enough that this bank
  // never measures as dull as `impact.blocked` — a payoff must not sound dead.
  nz(octx, out, nb, t0, { dur: 0.035, gain: 0.34, type: 'bandpass', f0: 1500, q: 2.2, offset: rng.next() });
  nz(octx, out, nb, t0, { dur: 0.020, gain: 0.22, type: 'bandpass', f0: 2600, q: 2.6, attack: 0.0006, offset: rng.next() });
  nz(octx, out, nb, t0, { dur: 0.012, gain: 0.10, type: 'highpass', f0: 4200, q: 0.7, attack: 0.0005, offset: rng.next() });
  tone(octx, out, t0 + 0.006, { type: 'triangle', f0: 470, f1: 300, bend: 0.05, dur: 0.09, gain: 0.16, lp: 2600 });
}

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
  const f = comboBaseHz();
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

/** The house breaking open. The biggest, longest event in the game. */
function renderHouseWin(octx, out, nb, t0, rng) {
  // the facade going in
  nz(octx, out, nb, t0, { dur: 0.35, gain: 1.0, type: 'lowpass', f0: 1100, f1: 170, sweep: 0.24, q: 0.8, attack: 0.002, offset: rng.next() });
  tone(octx, out, t0, { type: 'sine', f0: 105, f1: 27, bend: 0.5, dur: 1.5, gain: 0.95, attack: 0.004 });
  tone(octx, out, t0, { type: 'sine', f0: 38, f1: 24, bend: 1.6, dur: 3.0, gain: 0.7, attack: 0.02 });
  // the frame letting go
  for (let i = 0; i < STRUCT_RATIOS.length; i++) {
    const f = 46 * STRUCT_RATIOS[i];
    tone(octx, out, t0 + 0.05 + i * 0.03, {
      type: 'sine', f0: f * 1.05, f1: f * 0.82, bend: 2.8, dur: 3.0 - i * 0.35,
      gain: 0.32 / (1 + i * 0.55), attack: 0.03,
    });
  }
  // rolling rubble across the whole tail
  for (let i = 0; i < 9; i++) {
    const t = t0 + 0.12 + i * 0.31 + rng.range(0, 0.12);
    nz(octx, out, nb, t, {
      dur: 0.8 + rng.range(0, 0.6), gain: 0.36 * (1 - i * 0.075),
      type: 'lowpass', f0: 700 - i * 50, f1: 170, sweep: 0.6, q: 0.7,
      attack: 0.04 + rng.range(0, 0.06), offset: rng.next(),
    });
  }
  // splintering timber and glass, kept quiet so the low end stays the story
  for (let i = 0; i < 10; i++) {
    const t = t0 + rng.range(0.03, 2.4);
    nz(octx, out, nb, t, { dur: 0.06, gain: 0.03, type: 'bandpass', f0: 800 + rng.range(0, 2600), q: 2.0, offset: rng.next() });
  }
}

/**
 * The house HOLDS. A wall of nothing: enormous, and completely unrewarding.
 * The facade CRACKS without breaking (render/house.js draws exactly that), so
 * there is a spray of dry masonry fracture over the slam — which is also why
 * this measures brighter than `impact.blocked` despite being the other failure
 * sound. Nothing in the game is allowed to be duller than a block.
 */
function renderHouseHold(octx, out, nb, t0, rng) {
  nz(octx, out, nb, t0, { dur: 0.20, gain: 1.0, type: 'lowpass', f0: 520, f1: 120, sweep: 0.14, q: 0.7, attack: 0.0018, offset: rng.next() });
  tone(octx, out, t0, { type: 'sine', f0: 96, f1: 34, bend: 0.20, dur: 0.60, gain: 0.9, attack: 0.003 });
  // one dying groan, no collapse behind it
  tone(octx, out, t0 + 0.02, { type: 'sine', f0: 52, f1: 40, bend: 1.2, dur: 1.5, gain: 0.42, attack: 0.03 });
  tone(octx, out, t0 + 0.02, { type: 'sine', f0: 52 * 1.012, dur: 1.3, gain: 0.20, attack: 0.06 });
  nz(octx, out, nb, t0 + 0.05, { dur: 0.9, gain: 0.16, type: 'lowpass', f0: 400, f1: 160, sweep: 0.7, q: 0.8, attack: 0.05, offset: rng.next() });
  // the cracks racing across the facade
  for (let i = 0; i < 6; i++) {
    const t = t0 + 0.02 + rng.range(0, 0.75);
    nz(octx, out, nb, t, {
      dur: 0.05 + rng.range(0, 0.05), gain: 0.010, type: 'bandpass',
      f0: 800 + rng.range(0, 1600), q: 2.4, attack: 0.0008, offset: rng.next(),
    });
  }
  nz(octx, out, nb, t0 + 0.01, { dur: 0.30, gain: 0.004, type: 'highpass', f0: 2000, q: 0.7, attack: 0.004, offset: rng.next() });
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

/**
 * §17 — the fuel tanker going up. The biggest sound in the game that is not the
 * house, and the only one built around a genuine explosion envelope: an
 * ignition crack with almost no body, then 200 ms of nothing much, then the
 * pressure wave arriving underneath it. The delay between the crack and the
 * boom is most of what makes it read as an explosion rather than a big impact.
 */
function renderTanker(octx, out, nb, t0, rng) {
  // the vapour catching — incandescent, and gone before you register it
  nz(octx, out, nb, t0, { dur: 0.030, gain: 0.55, type: 'highpass', f0: 4600, q: 0.7, attack: 0.0004, offset: rng.next() });
  nz(octx, out, nb, t0, { dur: 0.09, gain: 0.85, type: 'bandpass', f0: 2200 + rng.spread(400), q: 0.6, attack: 0.0006, offset: rng.next() });

  // the pressure wave: a wall of noise collapsing three octaves in 400 ms
  const boom = t0 + 0.016;
  nz(octx, out, nb, boom, {
    dur: 1.05, gain: 1.0, type: 'lowpass', f0: 3800, f1: 95, sweep: 0.40, q: 0.9,
    attack: 0.004, offset: rng.next(),
  });
  tone(octx, out, boom, { type: 'sine', f0: 62, f1: 23, bend: 0.55, dur: 2.10, gain: 1.0, attack: 0.005 });
  tone(octx, out, boom, { type: 'sine', f0: 39, f1: 19, bend: 1.30, dur: 2.45, gain: 0.72, attack: 0.02 });

  // the shell letting go — the tank is still a 6 t steel cylinder
  const base = 112 + rng.range(0, 34);
  for (let i = 0; i < 4; i++) {
    const f = base * HEAVY_RATIOS[i];
    tone(octx, out, boom + i * 0.012, {
      type: 'sine', f0: f * 1.07, f1: f * 0.88, bend: 1.1, dur: 1.35 - i * 0.24,
      gain: 0.24 / (1 + i * 0.6), attack: 0.008, lp: 1400,
    });
  }

  // the fireball: swells AFTER the crack, which is the whole read
  nz(octx, out, nb, boom + 0.05, {
    dur: 1.60, gain: 0.46, type: 'lowpass', f0: 620, f1: 130, sweep: 1.1, q: 0.7,
    type2: 'lowpass', f2: 760, q2: 0.6, attack: 0.10, offset: rng.next(),
  });

  // everything that was bolted to it, coming back down
  for (let i = 0; i < 12; i++) {
    const t = t0 + rng.range(0.18, 2.30);
    nz(octx, out, nb, t, {
      dur: 0.06 + rng.range(0, 0.06), gain: 0.05, type: 'bandpass',
      f0: 380 + rng.range(0, 1700), q: 1.8, type2: 'lowpass', f2: 2600, q2: 0.7, offset: rng.next(),
    });
    if (rng.bool(0.4)) {
      tone(octx, out, t, { type: 'sine', f0: 150 + rng.range(0, 420), dur: 0.16, gain: 0.05, lp: 1200 });
    }
  }
}

/**
 * §17 — a car horn, for the scatter. Two reeds a minor third apart, which is
 * what an actual horn is, and the beat between the detuned pair is what makes
 * it read as panic rather than as a note. Deliberately mid-band and thin: this
 * is traffic texture and it must never compete with a smash.
 */
function renderHorn(octx, out, nb, t0, rng) {
  const f = 372 + rng.spread(26);
  const pair = [1, 1.19];   // ~minor third
  for (let i = 0; i < pair.length; i++) {
    const hz = f * pair[i];
    tone(octx, out, t0, {
      type: 'sawtooth', f0: hz, dur: 0.62, gain: 0.30 / (1 + i * 0.4),
      lp: 2200, lpq: 0.8, attack: 0.008, hold: 0.34,
    });
    // the second reed, a few cents off, so the pair beats
    tone(octx, out, t0, {
      type: 'square', f0: hz * 1.006, dur: 0.58, gain: 0.13 / (1 + i * 0.5),
      lp: 1700, attack: 0.012, hold: 0.30,
    });
  }
  // the air behind the diaphragm
  nz(octx, out, nb, t0, {
    dur: 0.05, gain: 0.10, type: 'bandpass', f0: 1400, q: 1.2,
    type2: 'lowpass', f2: 2600, q2: 0.7, attack: 0.004, offset: rng.next(),
  });
}

/**
 * §17 — locked tyres. A squeal is a stack of near-identical high-Q bands that
 * drift apart, not one tone: six of them here, each with its own drift, over a
 * low scrub bed. Short, because it is a reaction to you arriving, not an event.
 */
function renderBrake(octx, out, nb, t0, rng) {
  for (let i = 0; i < 6; i++) {
    const f0 = 1450 + rng.range(0, 900);
    nz(octx, out, nb, t0 + rng.range(0, 0.09), {
      dur: 0.34 + rng.range(0, 0.22), gain: 0.30 - i * 0.03,
      type: 'bandpass', f0: f0, f1: f0 * rng.range(1.04, 1.22), sweep: 0.30, q: 14,
      attack: 0.012 + rng.range(0, 0.03), offset: rng.next(),
    });
  }
  // rubber on tarmac under the squeal
  nz(octx, out, nb, t0, {
    dur: 0.46, gain: 0.34, type: 'lowpass', f0: 420, f1: 240, sweep: 0.36, q: 0.7,
    attack: 0.02, offset: rng.next(),
  });
  nz(octx, out, nb, t0 + 0.02, { dur: 0.14, gain: 0.10, type: 'bandpass', f0: 780, q: 1.4, offset: rng.next() });
}

/**
 * §17 — the first-taste stinger: the audio half of the one-time slow-motion
 * close-up the first time the player meets a tier. A short rise, then a stab
 * that lands with the freeze. It is rendered once and TRANSPOSED per tier, with
 * that tier's own body bank stamped underneath it at the call site — a stinger
 * per tier would be six more banks for one event each per run.
 */
function renderStinger(octx, out, nb, t0, rng) {
  // the rise: 180 ms of air being pulled in
  nz(octx, out, nb, t0, {
    dur: 0.20, gain: 0.34, type: 'bandpass', f0: 420, f1: 2600, sweep: 0.19, q: 1.1,
    attack: 0.16, offset: rng.next(),
  });

  const hit = t0 + 0.20;
  // the stab: a low cluster with the filter snapping shut on it
  const root = 116;
  const voices = [1, 1.5, 2, 3];
  for (let i = 0; i < voices.length; i++) {
    tone(octx, out, hit, {
      type: 'sawtooth', f0: root * voices[i] * (1 + rng.spread(0.004)),
      dur: 0.80 - i * 0.11, gain: 0.30 / (1 + i * 0.7),
      lp: 3000, lp1: 380, attack: 0.004, hold: 0.05,
    });
  }
  tone(octx, out, hit, { type: 'sine', f0: 58, f1: 41, bend: 0.30, dur: 0.85, gain: 0.85, attack: 0.004 });
  // the edge on the stab — bright, but capped, so it stamps rather than hisses
  nz(octx, out, nb, hit, {
    dur: 0.07, gain: 0.30, type: 'bandpass', f0: 2600, q: 1.6,
    type2: 'lowpass', f2: 5200, q2: 0.7, attack: 0.0008, offset: rng.next(),
  });
  // the room it happens in
  nz(octx, out, nb, hit + 0.03, {
    dur: 0.62, gain: 0.14, type: 'lowpass', f0: 900, f1: 220, sweep: 0.5, q: 0.8,
    attack: 0.05, offset: rng.next(),
  });
}

// ─────────────────────────────────────────────────────────────── bank plumbing

/** Single-buffer (non-material) bank keys, in render order. */
export const SINGLE_KEYS = [
  'impact.sub', 'impact.blocked', 'combo.ding', 'absorb.coin', 'absorb.till',
  'strike.alarm', 'house.win', 'house.hold', 'jump.whoosh', 'land.thud',
  'ui.click', 'ui.hover', 'ui.start', 'ui.gameover',
  'tanker.blast', 'traffic.horn', 'traffic.brake', 'taste.stinger',
];

/**
 * Variant count overrides, per bank key.
 *
 * `variantsPerLayer` is 5 and that is right for the layers that fire twenty
 * times a zone. It is not right for the two longest banks in the game: the
 * structure and heavy bodies are 3.2 s and 2.55 s each, they only ever play for
 * the top rungs of the last two zones' landmark ladders, and at five variants
 * apiece they were 16 s and 12.75 s of the init render on their own. Trimming
 * them paid for every §17 bank below with time to spare — see README.md for the
 * before/after numbers. The no-repeat rule still applies, so three variants is
 * still never the same sound twice running.
 */
const VARIANT_CAP = Object.create(null);
VARIANT_CAP['impact.structure.body'] = 3;
VARIANT_CAP['impact.structure.debris'] = 4;
VARIANT_CAP['impact.heavy.body'] = 4;
VARIANT_CAP['impact.heavy.debris'] = 4;
VARIANT_CAP['impact.metal.body'] = 4;
VARIANT_CAP['impact.glass.body'] = 4;
// One prop in a 51-prop catalogue is tagged `water`. Five variants of a bank
// that fires a handful of times in a run was 7.5 s of the loading bar.
VARIANT_CAP['impact.water.transient'] = 3;
VARIANT_CAP['impact.water.body'] = 3;
VARIANT_CAP['impact.water.debris'] = 3;

/** The full key list. Also the manifest key space for `registerSamples`. */
export function bankKeys() {
  const keys = [];
  for (let m = 0; m < IMPACT_MATERIALS.length; m++) {
    for (let l = 0; l < IMPACT_LAYERS.length; l++) {
      keys.push('impact.' + IMPACT_MATERIALS[m] + '.' + IMPACT_LAYERS[l]);
    }
  }
  for (let i = 0; i < SINGLE_KEYS.length; i++) keys.push(SINGLE_KEYS[i]);
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
      const bankKey = 'impact.' + key + '.' + layer;
      const cap = VARIANT_CAP[bankKey];
      jobs.push({
        key: bankKey,
        count: cap !== undefined && cap < variants ? cap : variants,
        dur: def.dur[l],
        norm: def.norm[l],
        seed: 0x5eed0000 + m * 977 + l * 31,
        fn: def[layer],
      });
    }
  }
  jobs.push({ key: 'impact.sub', count: Math.min(3, variants), dur: 0.80, norm: 0.95, seed: 0x51b0, fn: renderSub });
  // Normalised below every impact transient: a block is not a payoff, so it does
  // not get to arrive as loud as one. (The quiet debris layers sit lower still,
  // but they only ever play as the tail of a hit that already landed.)
  jobs.push({ key: 'impact.blocked', count: 3, dur: 0.055, norm: 0.66, seed: 0xb10c, fn: renderBlocked });
  jobs.push({ key: 'combo.ding', count: 3, dur: 1.00, norm: 0.85, seed: 0xcb01, fn: renderCombo });
  jobs.push({ key: 'absorb.coin', count: 3, dur: 0.30, norm: 0.80, seed: 0x9cc4, fn: renderAbsorb });
  jobs.push({ key: 'absorb.till', count: 2, dur: 0.40, norm: 0.85, seed: 0x7111, fn: renderTill });
  jobs.push({ key: 'strike.alarm', count: 2, dur: 0.26, norm: 0.88, seed: 0x5721, fn: renderStrike });
  jobs.push({ key: 'house.win', count: 1, dur: 3.40, norm: 0.97, seed: 0x40b5, fn: renderHouseWin });
  jobs.push({ key: 'house.hold', count: 1, dur: 1.90, norm: 0.93, seed: 0x40b6, fn: renderHouseHold });
  jobs.push({ key: 'jump.whoosh', count: 3, dur: 0.50, norm: 0.72, seed: 0x1a3f, fn: renderJump });
  jobs.push({ key: 'land.thud', count: 3, dur: 0.80, norm: 0.92, seed: 0x2b7c, fn: renderLand });
  jobs.push({ key: 'ui.click', count: 2, dur: 0.10, norm: 0.55, seed: 0x3d19, fn: renderUiClick });
  jobs.push({ key: 'ui.hover', count: 2, dur: 0.07, norm: 0.38, seed: 0x4e2a, fn: renderUiHover });
  jobs.push({ key: 'ui.start', count: 1, dur: 1.80, norm: 0.88, seed: 0x5f3b, fn: renderUiStart });
  jobs.push({ key: 'ui.gameover', count: 1, dur: 1.80, norm: 0.82, seed: 0x60c4, fn: renderUiGameover });
  // ── §17. The blast is normalised above every impact layer and just under the
  // house: it is the biggest thing on the highway and nothing else may be.
  jobs.push({ key: 'tanker.blast', count: 2, dur: 2.80, norm: 0.96, seed: 0x7a11, fn: renderTanker });
  jobs.push({ key: 'traffic.horn', count: 2, dur: 0.85, norm: 0.78, seed: 0x8c02, fn: renderHorn });
  jobs.push({ key: 'traffic.brake', count: 2, dur: 0.72, norm: 0.70, seed: 0x8c03, fn: renderBrake });
  jobs.push({ key: 'taste.stinger', count: 1, dur: 1.10, norm: 0.92, seed: 0x9f05, fn: renderStinger });
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
