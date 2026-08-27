/**
 * TONNAGE — layered impact playback.
 *
 * One hit is four layers:
 *   1. transient  (0 ms)          the contact
 *   2. body       (~15 ms)        the material's voice
 *   3. sub        (0 ms)          40–60 Hz sine, scaled by PLAYER mass.
 *                                 This is the layer that makes a hit feel heavy.
 *   4. debris     (scattered)     one-shots over TUNING.audio.debrisTailWindow
 *
 * Crowd control is what makes a 30-object pulverize read as ONE huge event
 * instead of mud. Impacts inside `TUNING.audio.impactWindow` share a window: the
 * transient/body layers are capped per window and per-voice gain falls off as
 * the count rises. Across windows a decaying density estimate thins the debris
 * tails. And there is only ever ONE live sub voice — later hits swell its gain
 * rather than stacking. So thirty crates land as a single enormous thump with a
 * wide debris tail, and a fast stream of hits keeps one solid low end.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, lerp, dbToGain } from '../core/math.js';
import { fxRng } from '../core/rng.js';
import { makeParams, resetParams, massTerm01 } from './engine.js';
import { IMPACT_MATERIALS, SUB_BASE_HZ } from './synth.js';

/** Reused parameter block — playImpact must not allocate. */
const P = makeParams();

const VALID = Object.create(null);
for (let i = 0; i < IMPACT_MATERIALS.length; i++) VALID[IMPACT_MATERIALS[i]] = true;

/**
 * Bank keys, built once. A pulverize can resolve thirty impacts in a frame and
 * each needs three keys, so composing them with `'impact.' + mat + '.body'` was
 * ninety short-lived strings per frame in the hottest path in the game.
 */
const KEYS = Object.create(null);
for (let i = 0; i < IMPACT_MATERIALS.length; i++) {
  const m = IMPACT_MATERIALS[i];
  KEYS[m] = {
    transient: 'impact.' + m + '.transient',
    body: 'impact.' + m + '.body',
    debris: 'impact.' + m + '.debris',
  };
}
const FALLBACK_MATERIAL = 'concrete';

export class ImpactPlayer {
  constructor(engine, bank) {
    this.engine = engine;
    this.bank = bank;

    this._windowStart = -1e9;
    this._winCount = 0;
    this._winTransient = 0;
    this._winBody = 0;
    this._winDebris = 0;
    this._winMaxMass = 0;

    this._subHandle = -1;
    this._subBase = 0;
    this._subTime = -1e9;
    this._subCount = 0;

    /** Decaying estimate of how many impacts are landing per ~densityTau. */
    this._density = 0;
    this._densityTime = -1e9;
  }

  reset() {
    this._windowStart = -1e9;
    this._winCount = 0;
    this._winTransient = 0;
    this._winBody = 0;
    this._winDebris = 0;
    this._winMaxMass = 0;
    this._subHandle = -1;
    this._subBase = 0;
    this._subTime = -1e9;
    this._subCount = 0;
    this._density = 0;
    this._densityTime = -1e9;
  }

  _openWindow(now) {
    this._windowStart = now;
    this._winCount = 0;
    this._winTransient = 0;
    this._winBody = 0;
    this._winDebris = 0;
    this._winMaxMass = 0;
  }

  /**
   * @param {string} materialKey shared material vocabulary
   * @param {string} outcome     'PULVERIZE' | 'PLOW' | 'BLOCKED'
   * @param {number} objectMass  destroyed object's threshold
   * @param {number} playerMass  drives pitch and sub weight
   * @param {number} pan         -1..1
   * @param {number} intensity01
   */
  play(materialKey, outcome, objectMass, playerMass, pan, intensity01) {
    const eng = this.engine;
    if (!eng.ready) return;
    const A = TUNING.audio;
    const now = eng.now;

    if (now - this._windowStart > A.impactWindow) this._openWindow(now);
    this._winCount++;
    const count = this._winCount;

    // Decaying density estimate — in a dense section the debris tails are
    // thinned so the mix stays readable instead of turning to gravel soup.
    const dtr = now - this._densityTime;
    this._densityTime = now;
    const tau = A.densityTau > 0.01 ? A.densityTau : 0.35;
    this._density = this._density * Math.exp(-(dtr > 0 ? dtr : 0) / tau) + 1;
    const busy = clamp01((this._density - 3) / 8);

    const mat = VALID[materialKey] ? materialKey : FALLBACK_MATERIAL;
    const blocked = outcome === 'BLOCKED';
    const plow = outcome === 'PLOW';

    const objMass = objectMass > 0 && isFinite(objectMass) ? objectMass : 1000;
    const pMass = playerMass > 0 ? playerMass : TUNING.player.startMass;
    const inten = 0.35 + 0.65 * clamp01(intensity01);
    const panC = clamp(pan, -1, 1);

    // A late arrival that dwarfs everything so far earns its own transient.
    const dominant = objMass > this._winMaxMass * 2;
    if (objMass > this._winMaxMass) this._winMaxMass = objMass;

    // ── pitch: down with player mass, down with object mass
    const massRate = Math.pow(TUNING.player.startMass / pMass, A.massPitchExp);
    const objRate = Math.pow(A.objectPitchRef / Math.max(50, objMass), A.objectPitchExp);
    let rate = clamp(massRate * objRate, A.rateMin, A.rateMax);
    if (plow) rate *= A.plowRateScale;

    // ── crowd scaling
    const crowd = 1 / Math.pow(count, A.impactCrowdExp);
    const outGain = plow ? A.plowGainScale : 1;
    const capBypass = blocked || dominant;

    // ── 1. transient
    if (capBypass || this._winTransient < A.maxLayerVoices) {
      this._winTransient++;
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.transientGain * inten * crowd * outGain * dbToGain(fxRng.spread(A.gainJitterDb));
      P.rate = rate * (1 + fxRng.spread(A.pitchJitter));
      P.pan = panC;
      P.protect = blocked;
      this.bank.play(eng, KEYS[mat].transient, P);
    }

    // ── 2. body
    if (capBypass || this._winBody < A.maxLayerVoices) {
      this._winBody++;
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.bodyGain * inten * crowd * outGain * (blocked ? 1.1 : 1) *
        dbToGain(fxRng.spread(A.gainJitterDb));
      P.rate = rate * (1 + fxRng.spread(A.pitchJitter));
      P.pan = panC * 0.8;
      P.when = now + A.bodyDelay;
      P.protect = blocked;
      this.bank.play(eng, KEYS[mat].body, P);

      // A blocker always gets the dead concrete slam on top, whatever it is
      // made of — that thud IS the "you hit a wall" feedback.
      if (blocked && mat !== 'concrete') {
        resetParams(P);
        P.bus = 'sfx';
        P.gain = A.bodyGain * 0.9 * inten;
        P.rate = clamp(massRate * 0.9, A.rateMin, A.rateMax);
        P.pan = panC * 0.5;
        P.when = now + A.bodyDelay * 0.5;
        P.protect = true;
        this.bank.play(eng, 'impact.concrete.body', P);
      }
    }

    // ── 3. sub (one live voice, swelling)
    this._playSub(now, pMass, inten, panC, blocked ? A.blockedSubBoost : (plow ? 0.9 : 1));

    // ── 4. debris tail
    const budget = A.debrisWindowMax - this._winDebris;
    if (budget > 0) {
      const want = Math.round(lerp(A.debrisCountMin, A.debrisCountMax, clamp01(intensity01)));
      let n = want < budget ? want : budget;
      if (blocked) n = Math.min(n, 2);
      if (plow) n = Math.max(1, Math.round(n * 0.6));
      if (busy > 0) n = Math.max(1, Math.round(n * (1 - A.densityDebrisCut * busy)));
      const dGain = A.debrisGain * inten * crowd * (blocked ? 0.25 : (plow ? 0.55 : 1));
      const key = KEYS[mat].debris;
      for (let i = 0; i < n; i++) {
        this._winDebris++;
        resetParams(P);
        P.bus = 'sfx';
        P.gain = dGain * (0.55 + fxRng.next() * 0.6) * dbToGain(fxRng.spread(A.gainJitterDb));
        P.rate = rate * (1 + fxRng.spread(A.pitchJitter * 1.5));
        P.pan = clamp(panC + fxRng.spread(0.55), -1, 1);
        P.when = now + A.debrisDelay + fxRng.next() * A.debrisTailWindow;
        this.bank.play(eng, key, P);
      }
    }

    // ── auto-duck on the big ones
    if (blocked || objMass >= A.duckMassThreshold) {
      eng.duck(A.duckAmountDb, A.duckHold);
    }
  }

  /**
   * The heavy layer. Only ever one live sub: anything landing within
   * `TUNING.audio.subRetrigger` swells it instead of stacking a second one.
   */
  _playSub(now, playerMass, inten, panC, outcomeScale) {
    const eng = this.engine;
    const A = TUNING.audio;
    const mt = massTerm01(playerMass);
    const base = A.subGain * inten * outcomeScale * (1 + mt * A.subMassExp);

    // One sub at a time. Anything landing while it is young swells the live
    // voice instead of stacking a second one — thirty crates become one
    // enormous thump, and a fast stream of hits keeps a single solid low end.
    if (this._subHandle >= 0 && eng.voiceAlive(this._subHandle) &&
        (now - this._subTime) < A.subRetrigger) {
      this._subCount++;
      if (base > this._subBase) this._subBase = base;
      const swell = Math.min(A.subSwellMax, Math.pow(this._subCount, A.subSwellExp));
      eng.rampVoiceGain(this._subHandle, this._subBase * swell, 0.012);
      return;
    }

    // Exactly one sub at a time: cut the previous tail so rapid hits read as a
    // tight pulse train in the low end instead of a smear.
    if (this._subHandle >= 0 && eng.voiceAlive(this._subHandle)) {
      eng.stopVoice(this._subHandle, 0.05);
      this._subHandle = -1;
    }

    // heavier player → lower sub, right at the bottom of subFreqRange
    const lo = A.subFreqRange[0];
    const hi = A.subFreqRange[1];
    const hz = lerp(hi, lo, mt);

    resetParams(P);
    P.bus = 'sfx';
    P.gain = base;
    P.rate = hz / SUB_BASE_HZ;
    P.pan = panC * 0.3;
    P.protect = true;
    const h = this.bank.play(eng, 'impact.sub', P);
    this._subHandle = h;
    this._subBase = base;
    this._subTime = now;
    this._subCount = 1;
  }

  /** Standalone sub hit (landings). */
  sub(playerMass, gainScale, pan) {
    const eng = this.engine;
    if (!eng.ready) return -1;
    const A = TUNING.audio;
    const mt = massTerm01(playerMass);
    const hz = lerp(A.subFreqRange[1], A.subFreqRange[0], mt);
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.subGain * gainScale * (1 + mt * A.subMassExp);
    P.rate = hz / SUB_BASE_HZ;
    P.pan = clamp(pan, -1, 1) * 0.3;
    P.protect = true;
    return this.bank.play(eng, 'impact.sub', P);
  }
}
