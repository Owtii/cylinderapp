/**
 * TONNAGE — sample source abstraction.
 *
 * Playback code never cares whether a sound is a procedurally-rendered
 * AudioBuffer (the default, and the only thing the shipped game uses) or a real
 * audio file streamed through Howler. Both implement `play(engine, params)`.
 *
 * Variant selection guarantees the same variant is never picked twice in a row,
 * which is most of what stops repeated impacts sounding like a machine gun.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01 } from '../core/math.js';
import { fxRng } from '../core/rng.js';

/** Base class — documents the contract. */
export class SampleSource {
  constructor() {
    this.last = -1;
  }

  get count() { return 0; }

  /** Index of the next variant, never the previous one. */
  pickIndex() {
    const n = this.count;
    if (n <= 1) return 0;
    if (this.last < 0 || this.last >= n) {
      const i = fxRng.int(0, n - 1);
      this.last = i;
      return i;
    }
    let i = fxRng.int(0, n - 2);
    if (i >= this.last) i++;
    this.last = i;
    return i;
  }

  /* eslint-disable no-unused-vars */
  play(engine, params) { return -1; }
  dispose() {}
}

/** Procedural AudioBuffers played through the engine's voice pool. */
export class BufferSource extends SampleSource {
  constructor(buffers) {
    super();
    this.buffers = buffers || [];
  }

  get count() { return this.buffers.length; }

  buffer(i) { return this.buffers[i]; }

  /** Duration of a representative variant, for scheduling decisions. */
  get duration() {
    return this.buffers.length > 0 ? this.buffers[0].duration : 0;
  }

  play(engine, params) {
    if (this.buffers.length === 0) return -1;
    return engine.play(this.buffers[this.pickIndex()], params);
  }
}

/**
 * Real audio files via Howler. Howler keeps its own AudioContext and master
 * chain, so bus levels are mirrored onto each instance's volume instead of
 * routing through our graph (see README).
 */
export class HowlSource extends SampleSource {
  /** @param {object[]} howls one Howl per variant */
  constructor(howls, urls) {
    super();
    this.howls = howls || [];
    this.urls = urls || [];
  }

  get count() { return this.howls.length; }

  play(engine, params) {
    if (this.howls.length === 0) return -1;
    const h = this.howls[this.pickIndex()];
    if (!h) return -1;
    const delay = params.when > 0 ? params.when - engine.now : 0;
    const gain = clamp01(params.gain * engine.busVolume(params.bus));
    const rate = clamp(params.rate || 1, 0.5, 4);
    const pan = clamp(params.pan, -1, 1);
    if (delay > 0.005) {
      // Howler cannot schedule on the audio clock; approximate with a timer.
      setTimeout(function () { fireHowl(h, gain, rate, pan); }, delay * 1000);
      return -1;
    }
    fireHowl(h, gain, rate, pan);
    return -1;
  }

  dispose() {
    for (let i = 0; i < this.howls.length; i++) {
      const h = this.howls[i];
      if (h && typeof h.unload === 'function') {
        try { h.unload(); } catch (e) { /* noop */ }
      }
    }
    this.howls.length = 0;
  }
}

function fireHowl(h, gain, rate, pan) {
  try {
    const id = h.play();
    if (id === undefined || id === null) return;
    h.volume(gain, id);
    h.rate(rate, id);
    if (typeof h.stereo === 'function' && pan !== 0) h.stereo(pan, id);
  } catch (e) { /* a sample that failed to load must never break the game */ }
}

/** Key → SampleSource registry. */
export class SourceBank {
  constructor() {
    this.map = Object.create(null);
  }

  has(key) { return this.map[key] !== undefined; }
  get(key) { return this.map[key]; }

  set(key, source) {
    const prev = this.map[key];
    if (prev && prev !== source && typeof prev.dispose === 'function') prev.dispose();
    this.map[key] = source;
  }

  setBuffers(key, buffers) {
    this.set(key, new BufferSource(buffers));
  }

  /** Play a key. Returns a voice handle (buffer backend) or -1. */
  play(engine, key, params) {
    const s = this.map[key];
    if (!s) return -1;
    return s.play(engine, params);
  }

  /** Reset "never repeat" memory — used on run restart. */
  resetVariants() {
    const m = this.map;
    for (const k in m) {
      if (m[k]) m[k].last = -1;
    }
  }

  dispose() {
    const m = this.map;
    for (const k in m) {
      if (m[k] && typeof m[k].dispose === 'function') m[k].dispose();
    }
    this.map = Object.create(null);
  }
}

let howlerPromise = null;

/**
 * Lazily pull in Howler. It is only ever loaded when `registerSamples()` is
 * called with real files — importing it eagerly would spin up a second
 * AudioContext for a game that ships with zero audio assets.
 */
export function loadHowler() {
  if (!howlerPromise) {
    howlerPromise = import('howler').then(function (mod) {
      return (mod && (mod.Howl ? mod : mod.default)) || null;
    }).catch(function () {
      return null;
    });
  }
  return howlerPromise;
}

/**
 * Build a HowlSource from a list of URLs (one Howl per variant so variants can
 * be chosen with the same no-repeat rule as procedural banks).
 */
export function makeHowlSource(howlerMod, urls) {
  if (!howlerMod || !howlerMod.Howl) return null;
  const list = Array.isArray(urls) ? urls : [urls];
  const howls = [];
  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    if (typeof url !== 'string' || url.length === 0) continue;
    try {
      howls.push(new howlerMod.Howl({
        src: [url],
        pool: TUNING.audio.howlPoolSize,
        preload: true,
        html5: false,
      }));
    } catch (e) { /* skip a bad entry rather than failing the whole manifest */ }
  }
  if (howls.length === 0) return null;
  return new HowlSource(howls, list);
}
