/**
 * TONNAGE — audio engine.
 *
 * Owns the AudioContext, the bus graph, the master limiter and the voice pool.
 * Everything that makes noise goes through `play()`, which hands back an integer
 * handle (never an object — the hot paths must not allocate).
 *
 * Graph:
 *
 *   voices ─┬─► sfxGain  ─┐
 *           ├─► uiGain   ─┼─► masterGain ─► limiter ─► destination
 *   music ──► musicDuck ─► musicGain ─┘
 *
 * The limiter is a DynamicsCompressorNode with a 20:1 ratio and a hard knee, so
 * a 30-object pulverize glues into one big event instead of clipping.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, dbToGain } from '../core/math.js';
import { Pool } from '../core/pool.js';

/** Shape of the reusable play-parameter block handed to `AudioEngine.play`. */
export function makeParams() {
  return {
    bus: 'sfx',      // 'sfx' | 'music' | 'ui'
    gain: 1,         // linear
    rate: 1,         // playback rate
    pan: 0,          // -1..1
    when: 0,         // absolute ctx time; <= 0 means "now"
    offset: 0,       // buffer start offset (s)
    duration: 0,     // forced length (s); <= 0 means "whole buffer"
    protect: false,  // exempt from voice stealing where possible
  };
}

/** Reset a params block to defaults. Allocation-free. */
export function resetParams(p) {
  p.bus = 'sfx';
  p.gain = 1;
  p.rate = 1;
  p.pan = 0;
  p.when = 0;
  p.offset = 0;
  p.duration = 0;
  p.protect = false;
  return p;
}

/**
 * 0..1 "how heavy are we" term, logarithmic between startWeight and maxWeight.
 * Used by every layer that has to make growth audible.
 *
 * Logarithmic because the run spans 500 kg to 140 t: linear would leave the whole
 * first three zones inside the bottom 2 % of the scale and inaudible.
 */
export function weightTerm01(weight) {
  const start = TUNING.player.startWeight;
  const max = TUNING.player.maxWeight;
  const wr = (weight > 0 ? weight : start) / start;
  if (wr <= 1) return 0;
  const span = Math.log2(max / start);
  return clamp01(Math.log2(wr) / (span > 0 ? span : 1));
}

/** Shared `ended` handler — a module-level function so no closure is allocated. */
function onVoiceEnded(ev) {
  const src = ev.target;
  if (!src) return;
  const eng = src._aeng;
  src.onended = null;
  try { src.disconnect(); } catch (e) { /* already gone */ }
  if (src._agn) { try { src._agn.disconnect(); } catch (e) { /* already gone */ } }
  if (src._apn) { try { src._apn.disconnect(); } catch (e) { /* already gone */ } }
  if (eng) eng._freeVoice(src._arec, src._agen);
  src._aeng = null;
  src._agn = null;
  src._apn = null;
}

function makeVoiceRecord() {
  return {
    active: false,
    gen: 1,
    src: null,
    gainNode: null,
    panNode: null,
    peak: 0,
    startTime: 0,
    endTime: 0,
    protect: false,
  };
}

// Voice handles pack a slot index and a generation counter into one int, so a
// stale handle cannot act on a recycled voice. 16 index bits keeps the packing
// valid for any maxVoices a designer might reasonably set.
const VOICE_IDX_BITS = 16;
const VOICE_IDX_MASK = 0xffff;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.disposed = false;

    this.masterGain = null;
    this.limiter = null;
    this.sfxIn = null;
    this.musicIn = null;   // music sources connect here (pre-duck)
    this.musicDuck = null;
    this.musicGain = null;
    this.uiIn = null;

    this.voicePool = null;
    this._hasPanner = false;

    // 0..1 slider values
    this.volMaster = 1;
    this.volSfx = 1;
    this.volMusic = 1;
    this.muted = false;

    this._sweepAccum = 0;
  }

  /** Build the context and graph. Returns true on success. */
  init() {
    if (this.disposed) return false;
    if (this.ready) return true;
    const Ctor = typeof AudioContext !== 'undefined'
      ? AudioContext
      : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    if (!Ctor) return false;

    let ctx;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      try { ctx = new Ctor(); } catch (e2) { return false; }
    }
    this.ctx = ctx;
    this._hasPanner = typeof ctx.createStereoPanner === 'function';

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = TUNING.audio.limiterThresholdDb;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    limiter.connect(ctx.destination);
    this.limiter = limiter;

    const master = ctx.createGain();
    master.gain.value = TUNING.audio.masterGain;
    master.connect(limiter);
    this.masterGain = master;

    const sfx = ctx.createGain();
    sfx.gain.value = TUNING.audio.sfxGain;
    sfx.connect(master);
    this.sfxIn = sfx;

    const music = ctx.createGain();
    music.gain.value = TUNING.audio.musicGain;
    music.connect(master);
    this.musicGain = music;

    const duck = ctx.createGain();
    duck.gain.value = 1;
    duck.connect(music);
    this.musicDuck = duck;
    this.musicIn = duck;

    const ui = ctx.createGain();
    ui.gain.value = TUNING.audio.uiGain;
    ui.connect(master);
    this.uiIn = ui;

    this.voicePool = new Pool(TUNING.audio.maxVoices, makeVoiceRecord);

    this.ready = true;
    this._applyVolumes();
    return true;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  get liveVoices() {
    return this.voicePool ? this.voicePool.activeCount : 0;
  }

  _busNode(name) {
    if (name === 'music') return this.musicIn;
    if (name === 'ui') return this.uiIn;
    return this.sfxIn;
  }

  /** Effective linear volume of a bus, used to mirror levels onto Howler. */
  busVolume(name) {
    if (this.muted) return 0;
    const m = this.volMaster * TUNING.audio.masterGain;
    if (name === 'music') return m * this.volMusic * TUNING.audio.musicGain;
    if (name === 'ui') return m * this.volSfx * TUNING.audio.uiGain;
    return m * this.volSfx * TUNING.audio.sfxGain;
  }

  setVolumes(master, sfx, music) {
    if (typeof master === 'number' && isFinite(master)) this.volMaster = clamp01(master);
    if (typeof sfx === 'number' && isFinite(sfx)) this.volSfx = clamp01(sfx);
    if (typeof music === 'number' && isFinite(music)) this.volMusic = clamp01(music);
    this._applyVolumes();
  }

  setMuted(m) {
    this.muted = !!m;
    this._applyVolumes();
  }

  _applyVolumes() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const mv = this.muted ? 0 : this.volMaster * TUNING.audio.masterGain;
    this._ramp(this.masterGain.gain, mv, t, 0.02);
    this._ramp(this.sfxIn.gain, this.volSfx * TUNING.audio.sfxGain, t, 0.02);
    this._ramp(this.musicGain.gain, this.volMusic * TUNING.audio.musicGain, t, 0.02);
    // UI rides the SFX slider — it is the only slider a player has for it.
    this._ramp(this.uiIn.gain, this.volSfx * TUNING.audio.uiGain, t, 0.02);
  }

  _ramp(param, value, t, time) {
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + time);
    } catch (e) {
      try { param.value = value; } catch (e2) { /* dead node */ }
    }
  }

  /**
   * Duck the music bus. Negative dB. Overlapping calls restart the envelope from
   * wherever the gain currently is, so rapid hits never step.
   */
  duck(amountDb, holdSeconds) {
    if (!this.ready) return;
    const p = this.musicDuck.gain;
    const t = this.ctx.currentTime;
    const target = dbToGain(amountDb);
    const a = TUNING.audio.duckAttack;
    const hold = holdSeconds !== undefined ? holdSeconds : TUNING.audio.duckHold;
    const r = TUNING.audio.duckRelease;
    try {
      const cur = p.value;
      p.cancelScheduledValues(t);
      p.setValueAtTime(cur, t);
      // Never let a new duck lift the gain: take the deeper of the two.
      p.linearRampToValueAtTime(target < cur ? target : cur * 0.999, t + a);
      p.setValueAtTime(target < cur ? target : cur * 0.999, t + a + hold);
      p.linearRampToValueAtTime(1, t + a + hold + r);
    } catch (e) { /* dead node */ }
  }

  /**
   * Play a buffer. `p` is a reused params block — it is read synchronously and
   * never retained. Returns an integer voice handle, or -1 if nothing played.
   */
  play(buffer, p) {
    if (!this.ready || !buffer) return -1;
    const ctx = this.ctx;
    if (ctx.state === 'closed') return -1;

    const gain = p.gain;
    if (!(gain > 0.0005)) return -1;

    const idx = this._acquireVoice(gain, p.protect === true);
    if (idx < 0) return -1;
    const rec = this.voicePool.items[idx];
    // Mark it live immediately so every bail-out below can go through the same
    // `_retire` path — a slot that is in the pool's active list but not flagged
    // active would be invisible to `_freeVoice` and leak forever.
    rec.active = true;
    rec.src = null;
    rec.gainNode = null;
    rec.panNode = null;

    const now = ctx.currentTime;
    const when = p.when > now ? p.when : now;
    const rate = clamp(p.rate || 1, 0.05, 8);

    let src;
    try {
      src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
    } catch (e) {
      this._retire(idx, rec);
      return -1;
    }

    const g = ctx.createGain();
    g.gain.value = clamp(gain, 0, 8);
    src.connect(g);

    let panNode = null;
    let tail = g;
    const pan = p.pan;
    if (this._hasPanner && pan !== 0) {
      panNode = ctx.createStereoPanner();
      panNode.pan.value = clamp(pan, -1, 1);
      g.connect(panNode);
      tail = panNode;
    }
    tail.connect(this._busNode(p.bus));

    src._aeng = this;
    src._arec = idx;
    src._agen = rec.gen;
    src._agn = g;
    src._apn = panNode;
    src.onended = onVoiceEnded;

    const offset = p.offset > 0 ? p.offset : 0;
    const natural = (buffer.duration - offset) / rate;
    const dur = p.duration > 0 ? p.duration : natural;
    try {
      src.start(when, offset);
      if (p.duration > 0) src.stop(when + p.duration);
    } catch (e) {
      try { src.disconnect(); } catch (e2) { /* noop */ }
      try { g.disconnect(); } catch (e2) { /* noop */ }
      if (panNode) { try { panNode.disconnect(); } catch (e2) { /* noop */ } }
      this._retire(idx, rec);
      return -1;
    }

    rec.src = src;
    rec.gainNode = g;
    rec.panNode = panNode;
    rec.peak = gain;
    rec.startTime = when;
    rec.endTime = when + (dur > 0 ? dur : 0.05);
    rec.protect = p.protect === true;

    return idx | (rec.gen << VOICE_IDX_BITS);
  }

  /** Smoothly move a live voice's gain (used to swell the shared sub layer). */
  rampVoiceGain(handle, target, timeConstant) {
    const rec = this._recFromHandle(handle);
    if (!rec || !rec.gainNode) return false;
    try {
      rec.gainNode.gain.setTargetAtTime(clamp(target, 0, 8), this.ctx.currentTime, timeConstant > 0 ? timeConstant : 0.01);
      rec.peak = target;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Is this handle still pointing at a live voice? */
  voiceAlive(handle) {
    return this._recFromHandle(handle) !== null;
  }

  _recFromHandle(handle) {
    if (!this.ready || handle < 0) return null;
    const idx = handle & VOICE_IDX_MASK;
    const gen = handle >>> VOICE_IDX_BITS;
    if (idx >= this.voicePool.capacity) return null;
    const rec = this.voicePool.items[idx];
    if (!rec.active || rec.gen !== gen) return null;
    return rec;
  }

  stopVoice(handle, fade) {
    const idx = handle & VOICE_IDX_MASK;
    const rec = this._recFromHandle(handle);
    if (!rec) return;
    this._killVoice(idx, fade !== undefined ? fade : TUNING.audio.voiceStealFade);
  }

  /** Fade + stop everything on the sfx/ui buses. Used by `reset()`. */
  stopAllVoices(fade) {
    if (!this.ready) return;
    const f = fade !== undefined ? fade : 0.05;
    const pool = this.voicePool;
    // `_killVoice` releases into the pool, which swaps the tail entry down, so
    // drain from the end instead of indexing a list that moves underneath us.
    let guard = pool.capacity + 1;
    while (pool.activeCount > 0 && guard-- > 0) {
      this._killVoice(pool.active[pool.activeCount - 1], f);
    }
  }

  /**
   * Pick a free voice slot, stealing the QUIETEST live voice when at the cap.
   * Refuses (returns -1) when the incoming sound is quieter than everything
   * already playing — silently dropping it beats cutting a bigger sound short.
   */
  _acquireVoice(gain, protect) {
    const pool = this.voicePool;
    let idx = pool.acquire();
    if (idx >= 0) return idx;

    const now = this.ctx.currentTime;
    let worst = -1;
    let worstEff = Infinity;
    const act = pool.active;
    for (let i = 0; i < pool.activeCount; i++) {
      const k = act[i];
      const rec = pool.items[k];
      if (rec.protect && !protect) continue;
      const span = rec.endTime - rec.startTime;
      let rem = span > 0.001 ? (rec.endTime - now) / span : 0;
      rem = rem < 0 ? 0 : (rem > 1 ? 1 : rem);
      // Effective loudness right now: peak gain faded by how much is left.
      const eff = rec.peak * (0.15 + 0.85 * rem);
      if (eff < worstEff) {
        worstEff = eff;
        worst = k;
      }
    }
    if (worst < 0) return -1;
    if (worstEff >= gain && !protect) return -1;

    this._killVoice(worst, TUNING.audio.voiceStealFade);
    idx = pool.acquire();
    return idx;
  }

  /** Fade a voice out over `fade` and free its slot immediately. */
  _killVoice(idx, fade) {
    const pool = this.voicePool;
    if (idx < 0 || idx >= pool.capacity) return;
    const rec = pool.items[idx];
    if (!rec.active) return;
    const now = this.ctx.currentTime;
    const f = fade > 0 ? fade : 0.005;
    if (rec.gainNode) {
      const p = rec.gainNode.gain;
      try {
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(0.0001, now + f);
      } catch (e) { /* dead node */ }
    }
    if (rec.src) {
      try { rec.src.stop(now + f); } catch (e) { /* already stopped */ }
    }
    // The stale source keeps its own node refs and disconnects them on `ended`;
    // bumping the generation makes that callback a no-op for the pool.
    this._retire(idx, rec);
  }

  _retire(idx, rec) {
    rec.active = false;
    rec.gen = (rec.gen + 1) & 0x7fff;
    rec.src = null;
    rec.gainNode = null;
    rec.panNode = null;
    rec.protect = false;
    rec.peak = 0;
    this.voicePool.release(idx);
  }

  _freeVoice(idx, gen) {
    if (!this.voicePool || idx === undefined || idx < 0 || idx >= this.voicePool.capacity) return;
    const rec = this.voicePool.items[idx];
    if (!rec.active || rec.gen !== gen) return;
    this._retire(idx, rec);
  }

  /**
   * Per-frame safety sweep: reclaims voices whose `ended` never fired (happens
   * if the context was suspended mid-flight). Allocation-free, ~4 Hz.
   */
  update(dt) {
    if (!this.ready) return;
    this._sweepAccum += dt;
    if (this._sweepAccum < 0.25) return;
    this._sweepAccum = 0;
    const pool = this.voicePool;
    const now = this.ctx.currentTime;
    for (let i = pool.activeCount - 1; i >= 0; i--) {
      if (i >= pool.activeCount) continue;   // list shrank under us
      const k = pool.active[i];
      const rec = pool.items[k];
      if (rec.active && now > rec.endTime + 0.5) {
        if (rec.src) { try { rec.src.stop(); } catch (e) { /* already stopped */ } }
        this._retire(k, rec);
      }
    }
  }

  async resume() {
    if (!this.ready) return;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (e) { /* blocked by policy */ }
    }
  }

  suspend() {
    if (!this.ready) return;
    if (this.ctx.state === 'running') {
      try { this.ctx.suspend(); } catch (e) { /* noop */ }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.ready) { this.ready = false; return; }
    this.stopAllVoices(0.01);
    this.ready = false;
    const ctx = this.ctx;
    try { this.masterGain.disconnect(); } catch (e) { /* noop */ }
    try { this.limiter.disconnect(); } catch (e) { /* noop */ }
    try { this.sfxIn.disconnect(); } catch (e) { /* noop */ }
    try { this.musicGain.disconnect(); } catch (e) { /* noop */ }
    try { this.musicDuck.disconnect(); } catch (e) { /* noop */ }
    try { this.uiIn.disconnect(); } catch (e) { /* noop */ }
    if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
      try { ctx.close(); } catch (e) { /* noop */ }
    }
    this.ctx = null;
  }
}
