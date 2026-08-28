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
import { AudioEngine, makeParams, resetParams, weightTerm01 } from './engine.js';
import { SourceBank, loadHowler, makeHowlSource } from './sources.js';
import {
  renderBanks, makeNoiseBuffer, makeLoopBuffer, makeShredLoopBuffer, makeReverbIr, bankKeys,
} from './synth.js';
import { ImpactPlayer, resolveMaterial, TIER_MATERIALS } from './impacts.js';
import { MusicSystem } from './music.js';
import { RollingLayer, ShredLayer } from './rolling.js';

/** Reused parameter block — the one-shot entry points must not allocate. */
const P = makeParams();

const UI_KEYS = {
  click: 'ui.click',
  start: 'ui.start',
  gameover: 'ui.gameover',
  hover: 'ui.hover',
};

/**
 * §17 scatter sounds. `swerve` shares the brake bank deliberately — it is the
 * same tyres, briefly, and a third bank for a sound that lasts 120 ms would be
 * two more seconds on the loading bar for nothing.
 */
const SCATTER_KEYS = ['traffic.horn', 'traffic.brake', 'traffic.brake'];
const SCATTER_KIND = { horn: 0, brake: 1, swerve: 2 };

export class AudioSystem {
  constructor() {
    this.engine = new AudioEngine();
    this.bank = new SourceBank();
    this.impacts = null;
    this.music = null;
    this.rolling = null;
    this.shred = null;

    this._ready = false;
    this._disposed = false;
    this._initPromise = null;
    this._warned = false;

    this._volMaster = 1;
    this._volSfx = 1;
    this._volMusic = 1;
    this._muted = false;

    this._musicIntensity = 0;
    this._zone = -1;
    this._zoneFloor = 0;
    /** Audio-clock time until which a recent block keeps the music stripped. */
    this._blockedUntil = -1e9;
    this._filterSweep = 0;

    /** Absorb crowd control — a 30-object frame must not fire 30 chimes. */
    this._absorbWindow = -1e9;
    this._absorbCount = 0;
    /** Last chain length seen on the per-frame state, so `playAbsorb` can
     *  climb the ladder even when the caller does not pass one. */
    this._chain = 0;

    /** §17 scatter crowd control: one window cap plus a per-kind cooldown. */
    this._scatterWindow = -1e9;
    this._scatterCount = 0;
    this._scatterLast = new Float64Array(SCATTER_KEYS.length);
    /** Bitmask of tiers whose first-taste stinger has already fired this run. */
    this._tasted = 0;

    this._noiseBuf = null;
    this._rumbleLoop = null;
    this._windLoop = null;
    this._shredLoop = null;
    this._tunnelIr = null;

    this._manifest = null;
    this._howler = null;
  }

  /** 0..1 — how much of the mix the shredding roar owns right now (§5). */
  get shredMix() {
    return this.shred ? this.shred.mix : 0;
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
    if (!this._initPromise) {
      const self = this;
      // Clear the cached promise unless boot actually succeeded, so a transient
      // failure (a blocked context, a render that threw) can be retried instead
      // of resolving instantly with ready === false forever.
      this._initPromise = this._boot(onProgress).then(function (v) {
        if (!self._ready) self._initPromise = null;
        return v;
      }, function (err) {
        self._initPromise = null;
        throw err;
      });
    }
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
      // Both of these are plain JS buffer fills, not offline renders: together
      // they are a few milliseconds and they never touch the loading bar.
      this._shredLoop = makeShredLoopBuffer(ctx, 1.9, 0x5c1e77, TUNING.audio.shredGrainDensity);
      const irLen = TUNING.audio.tunnelIrSeconds > 0.05 ? TUNING.audio.tunnelIrSeconds : 1.6;
      this._tunnelIr = makeReverbIr(ctx, irLen, TUNING.audio.tunnelDecay, 0x7c14);
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
      this.shred = new ShredLayer(eng, this._shredLoop);
      this.shred.start();
      eng.buildTunnel(this._tunnelIr);

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
   * Allocation-free: reads scalars off a state object the caller reuses and
   * never retains it. No literals, closures or array methods in here.
   *
   * @param {number} dt UNSCALED seconds
   * @param {object} s  { speed, speed01, weight, grounded, airborne, timeScale,
   *                      playing, chain, zone, blockerDistance, tunnel } —
   *                      reused by the caller, never retained.
   *                      `blockerDistance` and `tunnel` are optional; without
   *                      them the blocker hum never rises and the tunnel send
   *                      never opens. `mass` and `combo` are accepted as v1
   *                      aliases for weight and chain.
   */
  update(dt, s) {
    if (!this._ready || this._disposed) return;
    if (!(dt > 0)) dt = 0;

    // isFinite, not typeof: NaN is a number, and a single NaN frame flows through
    // damp() into the rolling/wind state and silences them for the rest of the run.
    const speed = s && isFinite(s.speed) ? s.speed : 0;
    const speed01 = s && isFinite(s.speed01) ? clamp01(s.speed01) : 0;
    let weight = TUNING.player.startWeight;
    if (s && isFinite(s.weight) && s.weight > 0) weight = s.weight;
    else if (s && isFinite(s.mass) && s.mass > 0) weight = s.mass;
    const airborne = s ? (s.airborne === true || s.grounded === false) : false;
    const playing = s ? s.playing !== false : false;
    let chain = 0;
    if (s && isFinite(s.chain)) chain = s.chain;
    else if (s && isFinite(s.combo)) chain = s.combo;
    this._chain = chain;
    const timeScale = s && isFinite(s.timeScale) ? s.timeScale : 1;
    if (s && isFinite(s.zone)) this.setZone(s.zone);

    this.rolling.setBlockerDistance(s && isFinite(s.blockerDistance) ? s.blockerDistance : Infinity);
    this.rolling.update(dt, speed, speed01, weight, !airborne, playing);

    // §5. The roar decides how much of the destruction it is carrying, and the
    // discrete impact layers get out of its way by exactly that much.
    this.shred.update(dt, playing);
    this.impacts.setShredMix(this.shred.mix);
    // §17. Optional, like blockerDistance: without it the send never opens.
    if (s && isFinite(s.tunnel)) this.engine.setTunnel(s.tunnel);

    // Music intensity: chain-driven, with any explicit setMusicIntensity as a floor.
    const full = TUNING.audio.musicChainFull > 0 ? TUNING.audio.musicChainFull : 12;
    const chainI = clamp01(chain / full);
    this.music.setIntensity(chainI > this._musicIntensity ? chainI : this._musicIntensity);

    // Strip the arrangement back to drums while the player has just been blocked
    // OR has stopped moving. Both say the same thing — you are not rolling, and
    // that is your fault — and the band dropping out says it louder than the HUD.
    const stopped = playing && speed < TUNING.audio.musicStoppedSpeed;
    this.music.setStripped(stopped || this.engine.now < this._blockedUntil);
    this.music.setPlaying(playing);

    // Slow-motion automatically closes the music filter; setFilterSweep is a floor.
    const slow = TUNING.time.slowmoScale;
    const denom = 1 - (slow < 1 ? slow : 0.999);
    const autoSweep = timeScale < 1 ? clamp01((1 - timeScale) / denom) : 0;
    this.music.setFilter(autoSweep > this._filterSweep ? autoSweep : this._filterSweep);

    this.engine.update(dt);
  }

  // ────────────────────────────────────────────────────────────── one-shots

  playImpact(materialKey, outcome, objectWeight, playerWeight, pan, intensity01) {
    if (!this._ready || this._disposed) return;
    this.impacts.play(materialKey, outcome, objectWeight, playerWeight, pan, intensity01);
  }

  /**
   * The weight of a smashed object arriving on the counter.
   *
   * Three things happen at once, because absorbing IS three things at once:
   *
   *   combo.ding   a pitched note that climbs with the chain — the reward you
   *                chase, and the only layer that knows about the chain at all.
   *   absorb.coin  one to three bright metallic taps, more taps for a bigger
   *                object: money landing on a steel counter.
   *   absorb.till  a low till clunk, but ONLY when the object was a large share
   *                of what you currently weigh. This is the layer that separates
   *                "another bottle crate" from "that was a silo".
   *
   * The share, not the absolute weight, drives the bottom end: a 5 t truck at
   * 500 kg should sound enormous, and the same truck at 90 t should not.
   *
   * @param {number} objectWeight  kg absorbed
   * @param {number} playerWeight  kg the roller weighs AFTER absorbing
   * @param {number} [chain]       current chain length, 1-based. Omit it and the
   *                               last value seen on the per-frame state is used,
   *                               so the ladder still climbs for callers that
   *                               only pass the two weights.
   */
  playAbsorb(objectWeight, playerWeight, chain) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const now = this.engine.now;

    // Crowd control. A pile-up resolves a dozen absorbs inside one frame and the
    // impact layers already carry that; past `absorbCrowdMax` in a window the
    // chime drops out entirely rather than eating the 24-voice pool, and the
    // ones that do play scale down so the window reads as one arrival.
    if (now - this._absorbWindow > A.impactWindow) {
      this._absorbWindow = now;
      this._absorbCount = 0;
    }
    this._absorbCount++;
    if (this._absorbCount > A.absorbCrowdMax) return;
    const crowd = 1 / Math.sqrt(this._absorbCount);

    const ow = objectWeight > 0 && isFinite(objectWeight) ? objectWeight : 100;
    const pw = playerWeight > 0 ? playerWeight : TUNING.player.startWeight;
    const share = clamp01(ow / pw);

    // ── the chain note
    const scale = A.comboScale;
    const n = scale.length > 0 ? scale.length : 1;
    const c = Math.max(1, Math.floor(chain || this._chain || 1)) - 1;
    // The ding has to keep rising — it is the sound players chase. Capping the
    // octave made chain 11 bit-identical to chain 6.
    const oct = Math.min(A.comboMaxOctaves, Math.floor(c / n));
    const rate = semitones(scale[c % n] + 12 * oct);

    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.comboGain * crowd * (0.85 + 0.15 * clamp01(c / 8));
    P.rate = rate;
    P.pan = 0;
    P.protect = true;
    this.bank.play(this.engine, 'combo.ding', P);

    if (c + 1 >= A.comboSparkleAt) {
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.comboGain * 0.4 * crowd;
      P.rate = rate * 2;
      P.pan = 0.25;
      P.when = now + 0.035;
      this.bank.play(this.engine, 'combo.ding', P);
    }

    // ── the coins
    const taps = 1 + Math.round(clamp01(share / A.absorbTillShare) * (A.absorbMaxTaps - 1));
    const drop = A.absorbShareSemitones * share;
    for (let i = 0; i < taps; i++) {
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.absorbCoinGain * crowd * (1 - i * 0.18) * (0.6 + 0.4 * share);
      P.rate = semitones(A.absorbTapSemitones[i % A.absorbTapSemitones.length] + drop) *
        (1 + fxRng.spread(0.02));
      P.pan = fxRng.spread(0.18);
      P.when = now + i * A.absorbSpacing;
      this.bank.play(this.engine, 'absorb.coin', P);
    }

    // ── the till, and the weight under it
    if (share >= A.absorbTillShare) {
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.absorbGain * crowd * (0.7 + 0.3 * share);
      P.rate = clamp(1 - 0.25 * share, A.rateMin, A.rateMax);
      P.pan = 0;
      P.when = now + A.absorbSpacing * 1.5;
      P.protect = true;
      this.bank.play(this.engine, 'absorb.till', P);
      this.impacts.sub(pw, 0.35 + 0.5 * share, 0);
    }
  }

  /**
   * A strike, layered ON TOP of the blocked impact rather than instead of it.
   *
   * This is deliberately the most alarming sound in the game. It is the only
   * feedback for the only mistake that ends runs, and it has to cut through six
   * simultaneous shatters — so it is a rising three-blip alarm, it starts higher
   * on every successive strike, and the LAST strike inverts: it drops seven
   * semitones into a dread tone instead of climbing. You should be able to hear
   * that the run just ended without reading the HUD.
   *
   * @param {number} strikes  strikes used AFTER this hit, 1-based
   */
  playStrike(strikes) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const n = Math.max(1, Math.floor(strikes || 1));
    const last = n >= TUNING.collision.maxStrikes;
    const root = A.strikeStrikeSemitones * (n - 1);
    const blips = last ? 4 : 3;

    for (let i = 0; i < blips; i++) {
      const semi = last
        ? root + A.strikeFinalSemitones * i          // falling: the run is over
        : root + A.strikeStepSemitones * i;          // rising: a warning
      resetParams(P);
      P.bus = 'sfx';
      P.gain = (A.strikeGain + A.strikeGainPerStrike * (n - 1)) * (1 - i * 0.10);
      P.rate = semitones(semi);
      P.pan = i % 2 === 0 ? -0.18 : 0.18;
      P.when = this.engine.now + i * A.strikeSpacing;
      P.protect = true;                              // never stolen by debris
      this.bank.play(this.engine, 'strike.alarm', P);
    }

    this.engine.duck(A.blockedDuckDb * (last ? 1.6 : 1), A.blockedDuckHold * (last ? 4 : 2));
    if (last) this.impacts.sub(TUNING.player.maxWeight, 1.2, 0);
  }

  /**
   * The house. One event, two outcomes, and they must not sound alike.
   *
   * WIN is the biggest sound the game makes: a 3.4 s collapse with every layer
   * behind it and no duck at all. HOLD is the opposite — a short dead slam, the
   * music does not come back, and the silence afterwards does the work.
   */
  playHouseHit(win) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.houseHitGain * (win ? 1 : 0.85);
    P.rate = 1;
    P.pan = 0;
    P.protect = true;
    this.bank.play(this.engine, win ? 'house.win' : 'house.hold', P);
    this.impacts.sub(TUNING.player.maxWeight, win ? 1.6 : 1.0, 0);

    if (win) {
      this.setMusicBlocked(false);
    } else {
      this.engine.duck(A.blockedDuckDb * 2, A.blockedDuckHold * 8);
      // The house holding is the end of the run, so this strip does NOT release
      // on the usual timer — the silence afterwards is the point.
      this._blockedUntil = this.engine.now + 1e6;
      this.music.setStripped(true);
    }
  }

  /**
   * Zone changed.
   *
   * The music layers on intensity while the v2 design layers on zone, so the zone
   * sets an intensity FLOOR: descending the ramp opens the arrangement up and it
   * never closes again, while the chain still pushes above the floor. Idempotent,
   * because the per-frame state pushes the current zone every frame.
   */
  setZone(zoneIndex) {
    if (this._disposed) return;
    const z = Math.max(0, Math.floor(zoneIndex || 0));
    if (z === this._zone) return;
    this._zone = z;
    const zones = TUNING.weights.zones.length;
    this._zoneFloor = zones > 1 ? clamp01(z / (zones - 1)) * 0.55 : 0;
    if (this._zoneFloor > this._musicIntensity) this._musicIntensity = this._zoneFloor;
    if (!this._ready) return;
    this.music.setZone(z);
  }

  /**
   * Metres to the nearest permanent blocker ahead, or Infinity. Drives the
   * warning hum that fades in inside `TUNING.read.blockerHumRadius`. Optional —
   * `update()` also reads it off the per-frame state as `s.blockerDistance`.
   */
  setBlockerDistance(metres) {
    if (!this._ready || this._disposed) return;
    this.rolling.setBlockerDistance(metres);
  }

  playJump() {
    if (!this._ready || this._disposed) return;
    resetParams(P);
    P.bus = 'sfx';
    P.gain = TUNING.audio.jumpGain;
    P.rate = 1 + fxRng.spread(0.06);
    this.bank.play(this.engine, 'jump.whoosh', P);
  }

  playLand(intensity01, playerWeight) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const i01 = clamp01(intensity01);
    const w = playerWeight > 0 ? playerWeight : TUNING.player.startWeight;
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.landGain * (0.4 + 0.6 * i01);
    P.rate = clamp(Math.pow(TUNING.player.startWeight / w, A.weightPitchExp) * (1 + fxRng.spread(0.05)),
      A.rateMin, A.rateMax);
    P.pan = 0;
    this.bank.play(this.engine, 'land.thud', P);
    this.impacts.sub(w, 0.55 + 0.5 * i01, 0);
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

  // ──────────────────────────────────────────────── §5/§17 — the highway

  /**
   * How fast the player is destroying things, and what out of.
   *
   * Above `TUNING.audio.shredEnterRate` smashes a second the discrete one-shots
   * stop being events and start being mud, so the impact layers duck out and a
   * single continuous shredding roar takes over; it releases at
   * `shredExitRate`, and that gap plus `shredMinHold` is what stops it
   * chattering at the boundary. See `ShredLayer` in rolling.js.
   *
   * Safe (and cheap) to call every frame. Safe never to call at all: the rate
   * decays on its own, so the roar can never be left on under a quiet ramp.
   *
   * @param {number} smashesPerSecond
   * @param {number} massPerSecond kg/s being absorbed — drives the low end
   * @param {string} materialKey   what is mostly being destroyed right now
   */
  setShredRate(smashesPerSecond, massPerSecond, materialKey) {
    if (!this._ready || this._disposed) return;
    const sps = smashesPerSecond > 0 && isFinite(smashesPerSecond) ? smashesPerSecond : 0;
    const mps = massPerSecond > 0 && isFinite(massPerSecond) ? massPerSecond : 0;
    // The average object going through the drum right now is what decides
    // whether `heavy` means a bus or a silo, and it falls out of the two rates.
    const avg = sps > 0.01 ? mps / sps : 0;
    this.shred.setRate(sps, mps, resolveMaterial(materialKey, avg));
  }

  /**
   * §17 secondary destruction: a fragment killing something on its way out.
   * Quieter, tighter and slightly delayed, so it reads as a consequence of the
   * hit you just made rather than as a hit of its own.
   */
  playSecondary(materialKey, objectWeight, playerWeight, pan) {
    if (!this._ready || this._disposed) return;
    this.impacts.playSecondary(materialKey, objectWeight, playerWeight, pan);
  }

  /**
   * §17 — a fuel tanker going up. The biggest sound in the game that is not the
   * house, and the only one with a real explosion's shape: a crack, a gap, then
   * the pressure wave. The duck is deep enough that the music disappears under
   * it, which is most of why it feels like a room-clearing event.
   *
   * @param {number} pan -1..1
   * @param {number} playerWeight kg, for the sub under it
   * @param {number} [intensity01]
   */
  playDetonation(pan, playerWeight, intensity01) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const pW = playerWeight > 0 ? playerWeight : TUNING.player.startWeight;
    const i01 = intensity01 === undefined ? 1 : clamp01(intensity01);
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.detonationGain * (0.75 + 0.25 * i01);
    P.rate = 1 + fxRng.spread(0.04);
    P.pan = clamp(pan, -1, 1) * 0.5;
    P.protect = true;
    this.bank.play(this.engine, 'tanker.blast', P);
    this.impacts.sub(pW, A.detonationSubGain, pan);
    this.engine.duck(A.detonationDuckDb, A.detonationDuckHold);
  }

  /**
   * §17 the scatter — traffic reacting to you arriving. `kind` is `'horn'`,
   * `'brake'` or `'swerve'`.
   *
   * This is texture, not feedback: it is capped per impact window, each kind
   * has its own cooldown, and it is mixed well under the smash layers. A jam of
   * twenty cars must sound like a jam, not like twenty horns.
   *
   * @param {string} kind
   * @param {number} pan -1..1
   * @param {number} distance01 0 = right beside you, 1 = at the edge of hearing
   */
  playScatter(kind, pan, distance01) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const now = this.engine.now;
    const k = SCATTER_KIND[kind] === undefined ? 0 : SCATTER_KIND[kind];

    if (now - this._scatterWindow > A.impactWindow) {
      this._scatterWindow = now;
      this._scatterCount = 0;
    }
    if (this._scatterCount >= A.scatterWindowMax) return;
    if (now - this._scatterLast[k] < A.scatterCooldown) return;
    this._scatterCount++;
    this._scatterLast[k] = now;

    const d = clamp01(distance01);
    // No per-voice filter in the pool, so distance is carried by level and by a
    // small drop in playback rate — which moves the whole spectrum down and
    // reads as air between you and it.
    const swerve = k === 2;
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.scatterGain * (swerve ? 0.75 : 1) * (1 - A.scatterDistanceFalloff * d) /
      (1 + this._scatterCount * 0.35);
    P.rate = (swerve ? 1.35 : 1) * (1 - 0.12 * d) * (1 + fxRng.spread(0.05));
    P.pan = clamp(pan, -1, 1);
    if (swerve) P.duration = A.scatterSwerveClip;
    this.bank.play(this.engine, SCATTER_KEYS[k], P);
  }

  /**
   * §17 — inside a tunnel. 0 = open road, 1 = fully inside. Swaps the sfx bus
   * onto a reverberant send and closes its top end, so every smash, and the
   * roll itself, arrives off concrete. `update()` also reads this off the
   * per-frame state as `s.tunnel`.
   */
  setTunnel(inside01) {
    if (!this._ready || this._disposed) return;
    this.engine.setTunnel(clamp01(inside01));
  }

  /**
   * §17 first taste — the audio half of the one-time slow-motion close-up the
   * first time the player meets a tier. A stab, transposed for the tier, with
   * that tier's own body layer stamped underneath it at half speed: the tier
   * name, said in its own voice.
   *
   * Fires at most once per tier per run: the caller's `meta.firstTaste(tier)`
   * gates it, and this gates it again, because two stingers over one 0.5 s
   * freeze would be worse than none.
   *
   * @param {number} tierIndex 0..5, zone order (glass → structures)
   */
  playFirstTaste(tierIndex) {
    if (!this._ready || this._disposed) return;
    const A = TUNING.audio;
    const i = clamp(Math.floor(tierIndex || 0), 0, TIER_MATERIALS.length - 1);
    const bit = 1 << i;
    if (this._tasted & bit) return;
    this._tasted |= bit;

    const now = this.engine.now;
    const table = A.tasteSemitones;
    const semi = table && table.length > 0 ? table[i % table.length] : 0;
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.tasteGain;
    P.rate = semitones(semi);
    P.protect = true;
    this.bank.play(this.engine, 'taste.stinger', P);

    // The tier's own voice, dropped an octave and landing with the stab.
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.tasteBodyGain;
    P.rate = A.tasteBodyRate;
    P.pan = 0;
    P.when = now + A.tasteStabDelay;
    P.protect = true;
    this.bank.play(this.engine, 'impact.' + TIER_MATERIALS[i] + '.body', P);

    this.impacts.sub(TUNING.player.maxWeight * 0.25, A.tasteSubGain, 0);
    this.engine.duck(A.tasteDuckDb, A.tasteDuckHold);
  }

  // ── v1 names, kept so anything that still calls them keeps working ───────

  /** @deprecated the chain ding is one layer of `playAbsorb` now. */
  playCombo(chain, playerWeight) {
    this.playAbsorb(TUNING.player.startWeight * 0.4, playerWeight, chain);
  }

  /** @deprecated there are no separate pickups in v2 — objects ARE the pickups. */
  playPickup(value, playerWeight) {
    this.playAbsorb(value, playerWeight, 1);
  }

  // ──────────────────────────────────────────────────────────────── music

  setMusicIntensity(t01) {
    // The zone floor is the ramp's own progress; an explicit intensity may only
    // push the music up from there, never drag it back to the first zone's mix.
    const t = clamp01(t01);
    this._musicIntensity = t > this._zoneFloor ? t : this._zoneFloor;
    if (!this._ready || this._disposed) return;
    this.music.setIntensity(this._musicIntensity);
  }

  /**
   * True strips the arrangement back to drums. It RELEASES ITSELF after
   * `TUNING.audio.musicBlockedHold` seconds, because "has just been blocked" is
   * a moment, not a state: a player who never smashes again should still hear
   * the band come back rather than roll to the house over a bare drum loop.
   * Passing false clears it immediately, which is what a successful smash does.
   */
  setMusicBlocked(b) {
    if (this._disposed) return;
    if (!this._ready) {
      this._blockedUntil = b ? 1e9 : -1e9;
      return;
    }
    const now = this.engine.now;
    this._blockedUntil = b ? now + TUNING.audio.musicBlockedHold : -1e9;
    this.music.setStripped(!!b);
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
      // registerSamples accepts either a URL or an array of URLs, and the README
      // documents the bare-string form. Indexing a string here would hand
      // _loadLoop a single character.
      const entry = manifest[loops[i]];
      const url = typeof entry === 'string' ? entry : (entry && entry[0]);
      this._loadLoop(loops[i], url);
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
    this._blockedUntil = -1e9;
    this._filterSweep = 0;
    this._zone = -1;
    this._zoneFloor = 0;
    this._absorbWindow = -1e9;
    this._absorbCount = 0;
    this._chain = 0;
    this._scatterWindow = -1e9;
    this._scatterCount = 0;
    // A new run gets its first tastes back.
    this._tasted = 0;
    if (!this._ready || this._disposed) return;
    for (let i = 0; i < this._scatterLast.length; i++) this._scatterLast[i] = -1e9;
    this.engine.stopAllVoices(0.05);
    this.engine.setTunnel(0);
    this.impacts.reset();
    this.rolling.reset();
    this.shred.reset();
    this.music.reset();
    this.bank.resetVariants();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;
    if (this.music) this.music.dispose();
    if (this.rolling) this.rolling.dispose();
    if (this.shred) this.shred.dispose();
    this.bank.dispose();
    this.engine.dispose();
    this.impacts = null;
    this.music = null;
    this.rolling = null;
    this.shred = null;
    this._noiseBuf = null;
    this._rumbleLoop = null;
    this._windLoop = null;
    this._shredLoop = null;
    this._tunnelIr = null;
  }
}

/** Singleton — the game imports this. */
export const audio = new AudioSystem();
