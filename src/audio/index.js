/**
 * TONNAGE — audio system (public API).
 *
 * Half the satisfaction of this game lives in here. Everything is synthesised
 * procedurally at init — the game ships with zero audio files and still sounds
 * finished. Real samples can be dropped in later through `registerSamples()`
 * without any other code changing (see README.md).
 *
 * Nothing plays before `init()` and nothing plays after `dispose()`: every
 * public method no-ops safely outside that window.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, semitones } from '../core/math.js';
import { fxRng } from '../core/rng.js';
import { AudioEngine, makeParams, resetParams, massTerm01 } from './engine.js';
import { SourceBank, loadHowler, makeHowlSource } from './sources.js';
import { renderBanks, makeNoiseBuffer, makeLoopBuffer, bankKeys, COMBO_BASE_HZ } from './synth.js';
import { ImpactPlayer } from './impacts.js';
import { MusicSystem } from './music.js';
import { RollingLayer } from './rolling.js';

/** Reused parameter block — the one-shot entry points must not allocate. */
const P = makeParams();

const UI_KEYS = {
  click: 'ui.click',
  start: 'ui.start',
  gameover: 'ui.gameover',
  hover: 'ui.hover',
};

export class AudioSystem {
  constructor() {
    this.engine = new AudioEngine();
    this.bank = new SourceBank();
    this.impacts = null;
    this.music = null;
    this.rolling = null;

    this._ready = false;
    this._disposed = false;
    this._initPromise = null;
    this._warned = false;

    this._volMaster = 1;
    this._volSfx = 1;
    this._volMusic = 1;
    this._muted = false;

    this._musicIntensity = 0;
    this._musicBlocked = false;
    this._filterSweep = 0;

    this._noiseBuf = null;
    this._rumbleLoop = null;
    this._windLoop = null;

    this._manifest = null;
    this._howler = null;
  }

  get ready() {
    return this._ready && !this._disposed;
  }

  /** The keys `registerSamples` understands. Handy for tooling/tests. */
  get sampleKeys() {
    const k = bankKeys();
    k.push('loop.rolling', 'loop.wind');
    return k;
  }

  // ────────────────────────────────────────────────────────────────── boot

  /**
   * Build the context and render every bank. Must be called from a user
   * gesture. Idempotent — repeat calls return the same promise.
   * @param {(t01:number)=>void} [onProgress]
   */
  async init(onProgress) {
    if (this._disposed) return;
    if (this._ready) {
      if (onProgress) onProgress(1);
      return;
    }
    if (!this._initPromise) this._initPromise = this._boot(onProgress);
    return this._initPromise;
  }

  async _boot(onProgress) {
    const eng = this.engine;
    if (!eng.init()) {
      this._warn('Web Audio unavailable — running silent.');
      if (onProgress) onProgress(1);
      return;
    }
    try {
      await eng.resume();

      const ctx = eng.ctx;
      this._noiseBuf = makeNoiseBuffer(ctx, 2.0, 1, 0xa17d51, false);
      this._rumbleLoop = makeLoopBuffer(ctx, 2.4, 1, 0x51d3c0, true);
      this._windLoop = makeLoopBuffer(ctx, 3.1, 2, 0x77a2be, true);
      if (onProgress) onProgress(0.06);

      const banks = await renderBanks(ctx, this._noiseBuf, function (t) {
        if (onProgress) onProgress(0.06 + 0.88 * t);
      });
      if (this._disposed) return;

      for (const key in banks) this.bank.setBuffers(key, banks[key]);

      this.impacts = new ImpactPlayer(eng, this.bank);
      this.music = new MusicSystem(eng, this._noiseBuf);
      this.music.build();
      this.rolling = new RollingLayer(eng, this._rumbleLoop, this._windLoop);
      this.rolling.start();

      eng.setVolumes(this._volMaster, this._volSfx, this._volMusic);
      eng.setMuted(this._muted);

      this._ready = true;
      if (this._manifest) this._applyManifest(this._manifest);
      if (onProgress) onProgress(1);
    } catch (e) {
      this._warn('audio init failed: ' + (e && e.message ? e.message : e));
      if (onProgress) onProgress(1);
    }
  }

  _warn(msg) {
    if (this._warned) return;
    this._warned = true;
    if (typeof console !== 'undefined' && console.warn) console.warn('[audio] ' + msg);
  }

  async resume() {
    if (!this.ready) return;
    await this.engine.resume();
  }

  suspend() {
    if (!this.ready) return;
    this.engine.suspend();
  }

  // ─────────────────────────────────────────────────────────────── volumes

  setVolumes(master, sfx, music) {
    if (typeof master === 'number' && isFinite(master)) this._volMaster = clamp01(master);
    if (typeof sfx === 'number' && isFinite(sfx)) this._volSfx = clamp01(sfx);
    if (typeof music === 'number' && isFinite(music)) this._volMusic = clamp01(music);
    if (this._disposed || !this.engine.ready) return;
    this.engine.setVolumes(this._volMaster, this._volSfx, this._volMusic);
  }

  getVolumes() {
    return { master: this._volMaster, sfx: this._volSfx, music: this._volMusic };
  }

  setMuted(m) {
    this._muted = !!m;
    if (this._disposed || !this.engine.ready) return;
    this.engine.setMuted(this._muted);
  }

  // ───────────────────────────────────────────────────────────── per-frame

  /**
   * @param {number} dt UNSCALED seconds
   * @param {object} s  { speed, speed01, mass, grounded, airborne, timeScale,
   *                      playing, combo } — reused by the caller, never retained.
   */
  update(dt, s) {
    if (!this._ready || this._disposed) return;
    if (!(dt > 0)) dt = 0;

    const speed = s && typeof s.speed === 'number' ? s.speed : 0;
    const speed01 = s && typeof s.speed01 === 'number' ? s.speed01 : 0;
    const mass = s && typeof s.mass === 'number' && s.mass > 0 ? s.mass : TUNING.player.startMass;
    const airborne = s ? (s.airborne === true || s.grounded === false) : false;
    const playing = s ? s.playing !== false : false;
    const combo = s && typeof s.combo === 'number' ? s.combo : 0;
    const timeScale = s && typeof s.timeScale === 'number' ? s.timeScale : 1;

    this.rolling.update(dt, speed, speed01, mass, !airborne, playing);

    // Music intensity: combo-driven, with any explicit setMusicIntensity as a floor.
    const full = TUNING.audio.musicComboFull > 0 ? TUNING.audio.musicComboFull : 12;
    const comboI = clamp01(combo / full);
    this.music.setIntensity(comboI > this._musicIntensity ? comboI : this._musicIntensity);
    this.music.setPlaying(playing);

    // Slow-motion automatically closes the music filter; setFilterSweep is a floor.
    const slow = TUNING.time.slowmoScale;
    const denom = 1 - (slow < 1 ? slow : 0.999);
    const autoSweep = timeScale < 1 ? clamp01((1 - timeScale) / denom) : 0;
    this.music.setFilter(autoSweep > this._filterSweep ? autoSweep : this._filterSweep);

    this.engine.update(dt);
  }

  // ────────────────────────────────────────────────────────────── one-shots

  playImpact(materialKey, outcome, objectMass, playerMass, pan, intensity01) {
    if (!this._ready || this._disposed) return;
    this.impacts.play(materialKey, outcome, objectMass, playerMass, pan, intensity01);
  }

  playPickup(value, playerMass) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const vals = TUNING.mass.pickupValues;
    let tier = 0;
    for (let i = 0; i < vals.length; i++) if (value >= vals[i]) tier = i;

    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.pickupGain * (0.85 + 0.15 * tier);
    P.rate = semitones(tier * 4) * (1 + fxRng.spread(0.02));
    P.pan = 0;
    this.bank.play(this.engine, 'pickup.chime', P);

    if (tier >= vals.length - 1) {
      // the big one lands with weight
      this.impacts.sub(playerMass, 0.45, 0);
    }
  }

  /** Rising pentatonic ding. combo starts at 1. Players will chase this. */
  playCombo(combo, playerMass) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const scale = A.comboScale;
    const n = scale.length > 0 ? scale.length : 1;
    const c = Math.max(1, Math.floor(combo)) - 1;
    const idx = c % n;
    const oct = Math.min(A.comboMaxOctaves, Math.floor(c / n));
    const semi = scale[idx] + 12 * oct;
    const rootScale = A.comboRootHz / COMBO_BASE_HZ;
    const rate = rootScale * semitones(semi);

    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.comboGain * (0.85 + 0.15 * clamp01(c / 8));
    P.rate = rate;
    P.pan = 0;
    P.protect = true;
    this.bank.play(this.engine, 'combo.ding', P);

    if (combo >= A.comboSparkleAt) {
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.comboGain * 0.4;
      P.rate = rate * 2;
      P.pan = 0.25;
      P.when = this.engine.now + 0.035;
      this.bank.play(this.engine, 'combo.ding', P);
    }

    // a little weight under the reward, so a heavy run's dings feel heavier
    const mt = massTerm01(playerMass);
    if (mt > 0.05) this.impacts.sub(playerMass, 0.22 + 0.2 * mt, 0);
  }

  playJump() {
    if (!this._ready || this._disposed) return;
    resetParams(P);
    P.bus = 'sfx';
    P.gain = TUNING.audio.jumpGain;
    P.rate = 1 + fxRng.spread(0.06);
    this.bank.play(this.engine, 'jump.whoosh', P);
  }

  playLand(intensity01, playerMass) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const i01 = clamp01(intensity01);
    const mass = playerMass > 0 ? playerMass : TUNING.player.startMass;
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.landGain * (0.4 + 0.6 * i01);
    P.rate = clamp(Math.pow(TUNING.player.startMass / mass, A.massPitchExp) * (1 + fxRng.spread(0.05)),
      A.rateMin, A.rateMax);
    P.pan = 0;
    this.bank.play(this.engine, 'land.thud', P);
    this.impacts.sub(mass, 0.55 + 0.5 * i01, 0);
    if (i01 > 0.6) this.engine.duck(A.duckAmountDb * 0.6, A.duckHold * 0.5);
  }

  playUi(kind) {
    if (!this._ready || this._disposed) return;
    const key = UI_KEYS[kind] || UI_KEYS.click;
    resetParams(P);
    P.bus = 'ui';
    P.gain = kind === 'hover' ? 0.5 : 0.9;
    P.rate = 1;
    this.bank.play(this.engine, key, P);
  }

  // ──────────────────────────────────────────────────────────────── music

  setMusicIntensity(t01) {
    this._musicIntensity = clamp01(t01);
    if (!this._ready || this._disposed) return;
    this.music.setIntensity(this._musicIntensity);
  }

  setMusicBlocked(b) {
    this._musicBlocked = !!b;
    if (!this._ready || this._disposed) return;
    this.music.setBlocked(this._musicBlocked);
  }

  /** 0 = open, 1 = heavily filtered. Used during slow-motion. */
  setFilterSweep(t01) {
    this._filterSweep = clamp01(t01);
    if (!this._ready || this._disposed) return;
    this.music.setFilter(this._filterSweep);
  }

  duck(amountDb, holdSeconds) {
    if (!this._ready || this._disposed) return;
    const db = typeof amountDb === 'number' ? amountDb : TUNING.audio.duckAmountDb;
    const hold = typeof holdSeconds === 'number' ? holdSeconds : TUNING.audio.duckHold;
    this.engine.duck(db, hold);
  }

  // ────────────────────────────────────────────────────── sample override

  /**
   * Replace procedural banks with real files.
   * Manifest: `{ 'impact.glass.transient': ['/audio/glass_t1.webm', ...] }`.
   * See README.md for the full key list. Safe to call before `init()`.
   */
  registerSamples(manifest) {
    if (this._disposed || !manifest) return;
    if (!this._manifest) this._manifest = Object.create(null);
    for (const k in manifest) {
      const v = manifest[k];
      if (!v) continue;
      this._manifest[k] = Array.isArray(v) ? v.slice() : [v];
    }
    if (this._ready) this._applyManifest(manifest);
  }

  _applyManifest(manifest) {
    const self = this;
    const loops = [];
    const files = [];
    for (const k in manifest) {
      if (k.indexOf('loop.') === 0) loops.push(k);
      else files.push(k);
    }

    if (files.length > 0) {
      loadHowler().then(function (mod) {
        if (!mod || self._disposed || !self._ready) {
          if (!mod) self._warn('howler failed to load; keeping procedural banks.');
          return;
        }
        self._howler = mod;
        for (let i = 0; i < files.length; i++) {
          const key = files[i];
          const src = makeHowlSource(mod, manifest[key]);
          if (src) self.bank.set(key, src);
        }
      });
    }

    for (let i = 0; i < loops.length; i++) {
      this._loadLoop(loops[i], manifest[loops[i]][0]);
    }
  }

  /** Loops need seamless AudioBuffers, so they bypass Howler and decode directly. */
  _loadLoop(key, url) {
    if (typeof fetch !== 'function' || typeof url !== 'string') return;
    const self = this;
    fetch(url).then(function (r) { return r.arrayBuffer(); })
      .then(function (ab) { return self.engine.ctx.decodeAudioData(ab); })
      .then(function (buf) {
        if (self._disposed || !self._ready) return;
        if (key === 'loop.rolling') self._rumbleLoop = buf;
        else if (key === 'loop.wind') self._windLoop = buf;
        else return;
        self.rolling.dispose();
        self.rolling = new RollingLayer(self.engine, self._rumbleLoop, self._windLoop);
        self.rolling.start();
      })
      .catch(function () { self._warn('loop sample ' + key + ' failed to load.'); });
  }

  // ──────────────────────────────────────────────────────────── lifecycle

  /** Run restart: kill tails, drop the music back to base, silence the loops. */
  reset() {
    this._musicIntensity = 0;
    this._musicBlocked = false;
    this._filterSweep = 0;
    if (!this._ready || this._disposed) return;
    this.engine.stopAllVoices(0.05);
    this.impacts.reset();
    this.rolling.reset();
    this.music.reset();
    this.bank.resetVariants();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;
    if (this.music) this.music.dispose();
    if (this.rolling) this.rolling.dispose();
    this.bank.dispose();
    this.engine.dispose();
    this.impacts = null;
    this.music = null;
    this.rolling = null;
    this._noiseBuf = null;
    this._rumbleLoop = null;
    this._windLoop = null;
  }
}

/** Singleton — the game imports this. */
export const audio = new AudioSystem();
