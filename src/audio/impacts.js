/**
 * TONNAGE — layered impact playback.
 *
 * A SMASH is four layers:
 *   1. transient  (0 ms)          the contact
 *   2. body       (~15 ms)        the material's voice
 *   3. sub        (0 ms)          40–60 Hz sine, scaled by PLAYER weight.
 *                                 This is the layer that makes a hit feel heavy.
 *   4. debris     (scattered)     one-shots over TUNING.audio.debrisTailWindow
 *
 * A BLOCK is one layer, and that is the whole point. `impact.blocked` fires
 * alone: no material transient, no material body, NO SUB, NO DEBRIS TAIL. It is
 * the only event in the game with no low end and no scatter, and its bank is the
 * shortest (56 ms) and — apart from the pure-sine sub layer it is denied —
 * the spectrally darkest (146 Hz centroid) in the game. Everything else here is
 * built to reward; this one is built to give nothing back. See audio/README.md
 * for the measured table.
 *
 * Crowd control is what makes a 30-object smash read as ONE huge event instead
 * of mud. Impacts inside `TUNING.audio.impactWindow` share a window: the
 * transient/body layers are capped per window and per-voice gain falls off as
 * the count rises. Across windows a decaying density estimate thins the debris
 * tails. And there is only ever ONE live sub voice — later hits swell its gain
 * rather than stacking. So thirty crates land as a single enormous thump with a
 * wide debris tail, and a fast stream of hits keeps one solid low end.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, lerp, dbToGain } from '../core/math.js';
import { fxRng } from '../core/rng.js';
import { makeParams, resetParams, weightTerm01 } from './engine.js';
import { IMPACT_MATERIALS, SUB_BASE_HZ } from './synth.js';

/** Reused parameter block — playImpact must not allocate. */
const P = makeParams();

const VALID = Object.create(null);
for (let i = 0; i < IMPACT_MATERIALS.length; i++) VALID[IMPACT_MATERIALS[i]] = true;

/**
 * Every vocabulary the rest of the game might hand us, folded onto the nine
 * banks. `PROPS[key].sound` only ever uses the first six, but the same call site
 * also sees tier names (`kiosk`, `truck`, `blocker`) and the visual material
 * names from `MATERIALS` (`paint`, `steel`, `slate`, `rubber`, `sand`,
 * `hazard`), so all of them resolve rather than silently falling back.
 */
const ALIAS = Object.create(null);
// tier names, in case a caller passes the tier instead of the sound
ALIAS.kiosk = 'metal';
ALIAS.truck = 'heavy';
ALIAS.blocker = 'concrete';
// visual material names from world/objects.js MATERIALS
ALIAS.paint = 'car';
ALIAS.steel = 'metal';
ALIAS.slate = 'concrete';
ALIAS.rubber = 'dirt';
ALIAS.sand = 'dirt';
ALIAS.hazard = 'concrete';

const FALLBACK_MATERIAL = 'concrete';

/**
 * Resolve a `sound` value (plus the object's weight) to one of the nine banks.
 *
 * The weight term exists because the catalogue tags a 3.5 t flatbed and a 20 t
 * water tower with the same `sound: 'heavy'`, and a building coming down is not
 * a vehicle being crushed. Above `TUNING.audio.structureWeightMin` a `heavy`
 * object is promoted to the `structure` collapse signature — weight is the only
 * thing that separates them at the call site, and it is the right thing.
 *
 * @param {string} sound  a PROPS[].sound value, tier name or material name
 * @param {number} weight kg (Infinity is fine — blockers are)
 * @returns {string} one of IMPACT_MATERIALS
 */
export function resolveMaterial(sound, weight) {
  let m = VALID[sound] ? sound : (ALIAS[sound] || FALLBACK_MATERIAL);
  if (m === 'heavy' && weight >= TUNING.audio.structureWeightMin) m = 'structure';
  return m;
}

/**
 * Bank keys, built once. A smash can resolve thirty impacts in a frame and each
 * needs three keys, so composing them with `'impact.' + mat + '.body'` was
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

const BLOCKED_KEY = 'impact.blocked';
const SUB_KEY = 'impact.sub';

/**
 * The six zone tiers of §7, in zone order, as bank materials. `playFirstTaste`
 * indexes this; it is the only place in the audio system that knows a zone
 * number, and it is here rather than in the caller so the six tier signatures
 * §11 asks for have one definition.
 */
export const TIER_MATERIALS = ['glass', 'wood', 'metal', 'car', 'heavy', 'structure'];

export class ImpactPlayer {
  constructor(engine, bank) {
    this.engine = engine;
    this.bank = bank;

    this._windowStart = -1e9;
    this._winCount = 0;
    this._winTransient = 0;
    this._winBody = 0;
    this._winDebris = 0;
    this._winMaxWeight = 0;

    this._subHandle = -1;
    this._subBase = 0;
    this._subTime = -1e9;
    this._subCount = 0;

    /** Decaying estimate of how many impacts are landing per ~densityTau. */
    this._density = 0;
    this._densityTime = -1e9;

    /** 0..1 — how much of the mix the shredding roar currently owns (§5). */
    this._shredMix = 0;
    this._winSecondary = 0;
  }

  /**
   * How far the continuous roar has taken over (0 = discrete hits, 1 = fully
   * shredding). Above `shredSuppressAt` an ordinary paper hit stops firing its
   * own layers entirely: the roar is already carrying it, and twenty transients
   * a second under a roar is exactly the mud §5 exists to remove.
   *
   * A PLOW, a BLOCK, and anything at or above `shredPunchShare` of the player's
   * weight are never ducked — the roar is the texture, and the things that
   * actually cost or nearly cost you something still have to punch through it.
   */
  setShredMix(mix01) {
    this._shredMix = mix01 > 0 ? (mix01 < 1 ? mix01 : 1) : 0;
  }

  reset() {
    this._shredMix = 0;
    this._winSecondary = 0;
    this._windowStart = -1e9;
    this._winCount = 0;
    this._winTransient = 0;
    this._winBody = 0;
    this._winDebris = 0;
    this._winMaxWeight = 0;
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
    this._winMaxWeight = 0;
    this._winSecondary = 0;
  }

  /**
   * @param {string} materialKey  a PROPS[].sound value (see `resolveMaterial`)
   * @param {string} outcome      'CLEAN' | 'PULVERIZE' | 'PLOW' | 'BLOCKED'
   * @param {number} objectWeight the object's printed weight in kg
   * @param {number} playerWeight drives pitch and sub weight
   * @param {number} pan          -1..1
   * @param {number} intensity01
   */
  play(materialKey, outcome, objectWeight, playerWeight, pan, intensity01) {
    const eng = this.engine;
    if (!eng.ready) return;
    const A = TUNING.audio;
    const now = eng.now;

    // A blocker's weight is Infinity by design, so it falls through to the
    // heaviest sane value rather than poisoning every downstream pow().
    const objW = objectWeight > 0 && isFinite(objectWeight) ? objectWeight : 25000;
    const pW = playerWeight > 0 ? playerWeight : TUNING.player.startWeight;
    const inten = 0.35 + 0.65 * clamp01(intensity01);
    const panC = clamp(pan, -1, 1);

    // ── BLOCKED short-circuits everything. One dead thud, nothing else. ──────
    // It deliberately skips the window bookkeeping too: a block is never one of
    // a crowd, so it must never be thinned by a crowd it did not cause.
    if (outcome === 'BLOCKED') {
      resetParams(P);
      P.bus = 'sfx';
      // Pitch still tracks the player's weight (a 60 t drum bounces lower than a
      // 500 kg one) but nothing else about this sound scales up. It does not get
      // louder, longer or deeper for a bigger failure.
      P.gain = A.blockedGain * inten;
      P.rate = clamp(Math.pow(TUNING.player.startWeight / pW, A.weightPitchExp) * 0.9,
        A.rateMin, A.rateMax);
      P.pan = panC * 0.5;
      P.protect = true;
      this.bank.play(eng, BLOCKED_KEY, P);
      // The mix flinching is the other half of the failure read.
      eng.duck(A.blockedDuckDb, A.blockedDuckHold);
      return;
    }

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

    const mat = resolveMaterial(materialKey, objW);
    const plow = outcome === 'PLOW';

    // A late arrival that dwarfs everything so far earns its own transient.
    const dominant = objW > this._winMaxWeight * 2;
    if (objW > this._winMaxWeight) this._winMaxWeight = objW;

    // ── §5: hand this hit to the roar if the roar has taken over.
    let shredScale = 1;
    if (!plow && this._shredMix > 0 && objW < pW * A.shredPunchShare) {
      if (this._shredMix >= A.shredSuppressAt) return;
      shredScale = 1 - this._shredMix;
    }

    // ── pitch: down with player weight, down with object weight
    const weightRate = Math.pow(TUNING.player.startWeight / pW, A.weightPitchExp);
    const objRate = Math.pow(A.objectPitchRef / Math.max(30, objW), A.objectPitchExp);
    let rate = clamp(weightRate * objRate, A.rateMin, A.rateMax);
    if (plow) rate *= A.plowRateScale;

    // ── crowd scaling
    const crowd = 1 / Math.pow(count, A.impactCrowdExp);
    const outGain = (plow ? A.plowGainScale : 1) * shredScale;

    // ── 1. transient
    if (dominant || this._winTransient < A.maxLayerVoices) {
      this._winTransient++;
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.transientGain * inten * crowd * outGain * dbToGain(fxRng.spread(A.gainJitterDb));
      P.rate = rate * (1 + fxRng.spread(A.pitchJitter));
      P.pan = panC;
      this.bank.play(eng, KEYS[mat].transient, P);
    }

    // ── 2. body
    if (dominant || this._winBody < A.maxLayerVoices) {
      this._winBody++;
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.bodyGain * inten * crowd * outGain * dbToGain(fxRng.spread(A.gainJitterDb));
      P.rate = rate * (1 + fxRng.spread(A.pitchJitter));
      P.pan = panC * 0.8;
      P.when = now + A.bodyDelay;
      this.bank.play(eng, KEYS[mat].body, P);
    }

    // ── 3. sub (one live voice, swelling)
    // The roar has its own continuous low end driven by mass/second, so the
    // per-hit sub gets out of its way rather than beating against it.
    this._playSub(now, pW, inten, panC, (plow ? 0.9 : 1) * shredScale);

    // ── 4. debris tail
    const budget = A.debrisWindowMax - this._winDebris;
    if (budget > 0) {
      const want = Math.round(lerp(A.debrisCountMin, A.debrisCountMax, clamp01(intensity01)));
      let n = want < budget ? want : budget;
      if (plow) n = Math.max(1, Math.round(n * 0.6));
      // Debris is the first thing to turn to gravel soup, so it is the first
      // thing the roar takes over completely.
      if (shredScale < 0.55) n = 0;
      if (busy > 0) n = Math.max(1, Math.round(n * (1 - A.densityDebrisCut * busy)));
      const dGain = A.debrisGain * inten * crowd * (plow ? 0.55 : 1) * shredScale;
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
    if (objW >= A.duckWeightThreshold) eng.duck(A.duckAmountDb, A.duckHold);
  }

  /**
   * The heavy layer. Only ever one live sub: anything landing within
   * `TUNING.audio.subRetrigger` swells it instead of stacking a second one.
   */
  _playSub(now, playerWeight, inten, panC, outcomeScale) {
    const eng = this.engine;
    const A = TUNING.audio;
    const wt = weightTerm01(playerWeight);
    const base = A.subGain * inten * outcomeScale * (1 + wt * A.subWeightExp);

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
    const hz = lerp(hi, lo, wt);

    resetParams(P);
    P.bus = 'sfx';
    P.gain = base;
    P.rate = hz / SUB_BASE_HZ;
    P.pan = panC * 0.3;
    P.protect = true;
    const h = this.bank.play(eng, SUB_KEY, P);
    this._subHandle = h;
    this._subBase = base;
    this._subTime = now;
    this._subCount = 1;
  }

  /**
   * §17 secondary destruction — a fragment of the thing you just hit killing
   * something else on its way out.
   *
   * It must read as a CONSEQUENCE of the first hit and never as a second hit,
   * which is three things: it is quieter, it is TIGHTER (the transient is
   * clipped to `secondaryClip`, so there is a contact and no body behind it),
   * and it arrives `secondaryDelay` after the event that caused it. It gets no
   * body layer, no sub and no duck — the low end belongs to the parent impact,
   * and a chain of these must never pump the mix.
   *
   * @param {string} materialKey the SECONDARY object's sound
   * @param {number} objectWeight kg of the secondary object
   * @param {number} playerWeight kg
   * @param {number} pan -1..1
   */
  playSecondary(materialKey, objectWeight, playerWeight, pan) {
    const eng = this.engine;
    if (!eng.ready) return;
    const A = TUNING.audio;
    const now = eng.now;

    // Under a shredding roar these are by definition inaudible, and they are
    // the cheapest thing to drop.
    if (this._shredMix >= A.shredSuppressAt) return;

    if (now - this._windowStart > A.impactWindow) this._openWindow(now);
    if (this._winSecondary >= A.secondaryWindowMax) return;
    this._winSecondary++;

    const objW = objectWeight > 0 && isFinite(objectWeight) ? objectWeight : 60;
    const pW = playerWeight > 0 ? playerWeight : TUNING.player.startWeight;
    const mat = resolveMaterial(materialKey, objW);
    const panC = clamp(pan, -1, 1);
    const shred = 1 - this._shredMix;

    const weightRate = Math.pow(TUNING.player.startWeight / pW, A.weightPitchExp);
    const objRate = Math.pow(A.objectPitchRef / Math.max(30, objW), A.objectPitchExp);
    const rate = clamp(weightRate * objRate * A.secondaryRateScale, A.rateMin, A.rateMax);
    const when = now + A.secondaryDelay + fxRng.next() * A.secondaryJitter;

    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.transientGain * A.secondaryGain * shred * (0.7 + 0.3 * fxRng.next());
    P.rate = rate * (1 + fxRng.spread(A.pitchJitter));
    P.pan = panC;
    P.when = when;
    P.duration = A.secondaryClip;   // the tightening — a contact with no body
    this.bank.play(eng, KEYS[mat].transient, P);

    const budget = A.debrisWindowMax - this._winDebris;
    if (budget > 0) {
      this._winDebris++;
      resetParams(P);
      P.bus = 'sfx';
      P.gain = A.debrisGain * A.secondaryGain * shred * (0.5 + fxRng.next() * 0.5);
      P.rate = rate * (1 + fxRng.spread(A.pitchJitter * 1.5));
      P.pan = clamp(panC + fxRng.spread(0.5), -1, 1);
      P.when = when + A.debrisDelay * 0.5 + fxRng.next() * A.debrisTailWindow * 0.4;
      this.bank.play(eng, KEYS[mat].debris, P);
    }
  }

  /** Standalone sub hit (landings, the house, a big absorb). */
  sub(playerWeight, gainScale, pan) {
    const eng = this.engine;
    if (!eng.ready) return -1;
    const A = TUNING.audio;
    const wt = weightTerm01(playerWeight);
    const hz = lerp(A.subFreqRange[1], A.subFreqRange[0], wt);
    resetParams(P);
    P.bus = 'sfx';
    P.gain = A.subGain * gainScale * (1 + wt * A.subWeightExp);
    P.rate = hz / SUB_BASE_HZ;
    P.pan = clamp(pan, -1, 1) * 0.3;
    P.protect = true;
    return this.bank.play(eng, SUB_KEY, P);
  }
}
