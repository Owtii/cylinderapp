/**
 * TONNAGE — HUD.
 *
 * Corners only, and only three things in them:
 *
 *   top-centre   the WEIGHT counter, with `TARGET 100,000 KG` welded under it
 *   top-left     three strike pips, and the chain counter under them
 *   right edge   a vertical progress rail, banded by zone, ending at the house
 *
 * Nothing else. The middle of the screen belongs to the ramp, because the ramp
 * is where every decision is made.
 *
 * The weight counter is the star. It rolls mechanically toward its new value
 * (`TUNING.ui.weightTickTime`) instead of snapping, the `+1,500 KG` popup flies
 * out of the object it came from and lands *in* the counter, and the counter
 * punches when it lands. That loop — object, number, counter — is the whole
 * reward structure of the game, so it is the only motion the HUD is allowed.
 *
 * COLOUR MONOPOLY: saturated green / amber / red belong to the outline system.
 * The HUD's own accent is a cold bone-white; the strike pips read as spent by
 * SHAPE (a stencilled ✕) and not by hue, so the whole HUD survives greyscale.
 *
 * Allocation: the per-frame path allocates nothing. Every class name, every
 * `scaleX()` and every small integer the HUD can write is pre-built at module
 * load. The one unavoidable exception is the popup's `translate` string, which
 * the DOM only accepts as text — and that is written only when the rounded
 * pixel position actually changed, so a still frame allocates nothing at all.
 *
 * v3 adds three transient beats and one hook, and nothing permanent:
 *
 *   zoneRecap()   the §16.4 boundary banner — ZONE 3 CLEARED · +6,200 KG · ON PACE
 *   stampTier()   the on-screen half of §17's first taste: the tier name, ~0.5 s
 *   flashEdge()   a frame-edge pulse — the paper tier's reward, which must cost
 *                 the player nothing (no hitstop, no speed, no layout read)
 *   setDim()      fades the chrome for the scale reveal, which is a camera move
 *
 * The stamp and the edge flash deliberately sit OUTSIDE the dimmable chrome
 * wrapper: they are beats, not furniture, and a beat that fires during a scale
 * reveal still has to land.
 */

import { TUNING } from '../tuning.js';
import { clamp, clamp01, moveTowards, smoothstep, hash11 } from '../core/math.js';

/* ─────────────────────────────────────────── module constants (built once) ── */

const DIGIT_CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Small integers as strings, for CSS custom properties. 0..200 = 0..100 %. */
const PROG_STEPS = 200;
const NUM_STR = new Array(PROG_STEPS + 1);
for (let i = 0; i <= PROG_STEPS; i++) NUM_STR[i] = '' + i;

/** Pre-built chain counts, so a two-digit chain does not build a string. */
const CHAIN_STR = new Array(200);
for (let i = 0; i < 200; i++) CHAIN_STR[i] = '' + i;

/** Scratch for the rail's band edges — the layout pass must not allocate. */
const EDGES = new Float64Array(64);

/** Pre-built `scaleX()` strings for the target bar. */
const BAR_STEPS = 100;
const SCALE_X = new Array(BAR_STEPS + 1);
for (let i = 0; i <= BAR_STEPS; i++) SCALE_X[i] = 'scaleX(' + (i / BAR_STEPS) + ')';

/** Pre-built 0.00 .. 1.00 fractions, for the chrome-fade custom property. */
const FRAC_STEPS = 100;
const FRAC_STR = new Array(FRAC_STEPS + 1);
for (let i = 0; i <= FRAC_STEPS; i++) FRAC_STR[i] = (i / FRAC_STEPS).toFixed(2);

/** Pre-built recap headlines. A zone boundary must not build a string. */
const ZONE_CLEARED = new Array(17);
for (let i = 0; i < ZONE_CLEARED.length; i++) ZONE_CLEARED[i] = 'ZONE ' + i + ' CLEARED';

/* Used only when the integrator has not added `ui.dimTime`; see `update()`. */
const DIM_TIME_FALLBACK = 0.22;

const TXT_ON_PACE = 'ON PACE';
const TXT_BEHIND_PACE = 'BEHIND PACE';

/** Where a popup goes when it is off-screen or dead. */
const PARKED = '-9999px -9999px';

const CLS_HUD = 'hud';
const CLS_HUD_ON = 'hud on';

const CLS_POP = 'pop';
const CLS_POP_A = 'pop fly-a';
const CLS_POP_B = 'pop fly-b';

const CLS_WEIGH = 'weigh';
const CLS_WEIGH_UP_A = 'weigh gain-a';
const CLS_WEIGH_UP_B = 'weigh gain-b';
const CLS_WEIGH_DOWN_A = 'weigh loss-a';
const CLS_WEIGH_DOWN_B = 'weigh loss-b';

const CLS_DIGIT = 'reel-d';
const CLS_DIGIT_DIM = 'reel-d z';
const CLS_SEP = 'reel-sep';
const CLS_SEP_DIM = 'reel-sep z';

const CLS_TARGET = 'tgt';
const CLS_TARGET_MET = 'tgt met';

const CLS_CHAIN = 'chain';
const CLS_CHAIN_ON = 'chain on';
const CLS_CHAIN_LIT = 'chain on lit';
const CLS_CHAIN_BODY = 'chain-body';
const CLS_CHAIN_BODY_A = 'chain-body pa';
const CLS_CHAIN_BODY_B = 'chain-body pb';

const CLS_PIP = 'pip';
const CLS_PIP_SPENT = 'pip spent';
const CLS_PIP_SPENT_A = 'pip spent hit-a';
const CLS_PIP_SPENT_B = 'pip spent hit-b';

const CLS_BAND = 'zband';
const CLS_BAND_PAST = 'zband past';
const CLS_BAND_NOW = 'zband now';
const CLS_BAND_FINALE = 'zband finale';
const CLS_BAND_FINALE_NOW = 'zband finale now';

const CLS_BANNER = 'banner';
const CLS_BANNER_GOOD = 'banner on good';
const CLS_BANNER_WARN = 'banner on warn';
const CLS_BANNER_INFO = 'banner on info';
const CLS_BANNER_ROW = 'banner-row';
const CLS_BANNER_ROW_OFF = 'banner-row off';

const CLS_STAMP = 'stamp';
const CLS_STAMP_A = 'stamp on a';
const CLS_STAMP_B = 'stamp on b';

const CLS_EDGE = 'edge';
const CLS_EDGE_A = 'edge on a';
const CLS_EDGE_B = 'edge on b';

const TXT_TARGET = 'TARGET';
const TXT_TARGET_MET = 'TARGET MET';

const DEFAULT_POP_COLOUR = '#e9e2d0';

/* ───────────────────────────────────────────────── projection scratch state ── */
/* Plain numbers, not an object: projecting a popup allocates nothing. */
let _projX = 0;
let _projY = 0;
let _projOk = false;

/**
 * Project a world point to CSS pixels straight from the camera's matrices.
 * Assumes an unscaled (rigid) camera world matrix, which a chase camera always is.
 */
function project(camera, wx, wy, wz, width, height) {
  _projOk = false;
  const mw = camera.matrixWorld.elements;
  const pm = camera.projectionMatrix.elements;

  const dx = wx - mw[12];
  const dy = wy - mw[13];
  const dz = wz - mw[14];

  // View-space = transpose(rotation) * (world - eye).
  const vx = dx * mw[0] + dy * mw[1] + dz * mw[2];
  const vy = dx * mw[4] + dy * mw[5] + dz * mw[6];
  const vz = dx * mw[8] + dy * mw[9] + dz * mw[10];

  const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15];
  if (cw <= 1e-5) return;                       // behind the eye

  const cx = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12];
  const cy = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13];

  _projX = (cx / cw * 0.5 + 0.5) * width;
  _projY = (0.5 - cy / cw * 0.5) * height;
  _projOk = true;
}

/** Thousands-grouped integer without `toLocaleString` (slow, and it allocates). */
function groupInt(v) {
  let n = v < 0 ? 0 : v;
  if (n < 10) return DIGIT_CHARS[n];
  if (n < 1000) return '' + n;
  let out = '';
  while (n >= 1000) {
    const r = n % 1000;
    n = (n - r) / 1000;
    out = ',' + (r < 10 ? '00' : r < 100 ? '0' : '') + r + out;
  }
  return n + out;
}

/* A tiny cache so `addPopup` can take 0x35d07f as happily as '#35d07f' without
   building a string on every impact. */
const HEX_N = 8;
const hexKeys = new Int32Array(HEX_N).fill(-1);
const hexVals = new Array(HEX_N);
for (let i = 0; i < HEX_N; i++) hexVals[i] = DEFAULT_POP_COLOUR;
let hexCursor = 0;

function colourString(c) {
  if (typeof c === 'string') return c;
  if (typeof c !== 'number' || !isFinite(c)) return DEFAULT_POP_COLOUR;
  const key = c | 0;
  for (let i = 0; i < HEX_N; i++) if (hexKeys[i] === key) return hexVals[i];
  let s = (key >>> 0).toString(16);
  while (s.length < 6) s = '0' + s;
  const out = '#' + s;
  hexKeys[hexCursor] = key;
  hexVals[hexCursor] = out;
  hexCursor = hexCursor + 1 >= HEX_N ? 0 : hexCursor + 1;
  return out;
}

function mk(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/* ─────────────────────────────────────────────────────── haptics (§16.12) ── */
/*
 * `navigator.vibrate` is absent on every iOS browser and throws inside some
 * embedded webviews, so it is probed once, lazily, and switched off for good the
 * first time it misbehaves. Nothing here allocates and nothing here reads the
 * DOM: a smash must never cost the player a millisecond.
 */

let _hapticsOn = true;
let _hapticsProbe = -1;                 // -1 unprobed, 0 unavailable, 1 live
let _hapticLastMs = -1e9;

function hapticsProbe() {
  if (_hapticsProbe >= 0) return _hapticsProbe;
  _hapticsProbe = 0;
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') _hapticsProbe = 1;
  } catch (err) { /* accessing navigator throws in some sandboxes */ }
  return _hapticsProbe;
}

/** True when this device can actually buzz — the settings row hides otherwise. */
export function hapticsSupported() {
  return hapticsProbe() === 1;
}

/** The settings toggle. Off is remembered here, not in the device. */
export function setHapticsEnabled(v) {
  _hapticsOn = !!v;
}

export function hapticsEnabled() {
  return _hapticsOn;
}

/**
 * `kind` is a key in `TUNING.ui.haptics` — 'smash' is a light tap, 'block' a
 * heavy buzz, 'house' a long rumble. Returns true only if the device was
 * actually asked to vibrate.
 *
 * Taps (a plain number of milliseconds) are rate-limited: above ~6 smashes per
 * second the paper tier would otherwise hold the motor open continuously, which
 * reads as a fault rather than as feedback. Patterns (arrays) are the rare,
 * loud events and always fire.
 */
export function haptic(kind) {
  if (!_hapticsOn || hapticsProbe() !== 1) return false;
  const table = TUNING.ui.haptics;
  const pat = table ? table[kind] : undefined;
  if (pat === undefined || pat === null) return false;

  const now = Date.now();
  if (typeof pat === 'number') {
    if (pat <= 0) return false;
    if (now - _hapticLastMs < TUNING.ui.hapticMinGap * 1000) return false;
  }
  _hapticLastMs = now;

  try {
    navigator.vibrate(pat);
  } catch (err) {
    _hapticsProbe = 0;                  // a throwing vibrator is never asked twice
    return false;
  }
  return true;
}

/* ────────────────────────────────────────────────────────────────────── HUD ── */

export class Hud {
  /** @param {HTMLElement} root the `#hud` element */
  constructor(root) {
    const U = TUNING.ui;

    this.root = root;
    root.className = CLS_HUD;
    root.setAttribute('aria-hidden', 'true');
    while (root.firstChild) root.removeChild(root.firstChild);

    // Feel numbers CSS needs are handed over as custom properties once, so
    // TUNING stays the single source of truth with no per-frame style work.
    const st = root.style;
    st.setProperty('--hud-fade', U.hudFadeTime + 's');
    st.setProperty('--weigh-punch', '' + U.weightPunchScale);
    st.setProperty('--weigh-punch-time', U.weightPunchTime + 's');
    st.setProperty('--chain-punch', '' + U.chainPunchScale);
    st.setProperty('--chain-punch-time', U.chainPunchTime + 's');
    st.setProperty('--strike-punch-time', U.strikePunchTime + 's');
    st.setProperty('--target-pulse', U.targetPulseTime + 's');
    st.setProperty('--pop-life', U.popupLife + 's');
    st.setProperty('--banner-fade', U.bannerFade + 's');
    st.setProperty('--stamp-life', U.stampTime + 's');
    st.setProperty('--edge-life', U.edgeFlashTime + 's');
    st.setProperty('--chrome', FRAC_STR[FRAC_STEPS]);

    /* ── the dimmable chrome ───────────────────────────────────────────────
       Everything that is furniture hangs off this one wrapper, so §17's scale
       reveal can fade the whole HUD by writing a single custom property. It has
       to be `position:absolute; inset:0` because every child inside positions
       itself against the nearest positioned ancestor. */
    const chrome = mk('div', 'hud-chrome', root);
    this.elChrome = chrome;

    /* ── label layer ───────────────────────────────────────────────────────
       Owned by MODULE A's LabelSystem; it lives underneath the HUD furniture so
       a label can never sit on top of the weight counter. Handed over by
       `hud.labelRoot`. */
    this.labelLayer = mk('div', 'hud-labels', chrome);

    /* ── top-left: strikes, then chain ─────────────────────────────────────── */
    const tl = mk('div', 'hud-zone hud-tl', chrome);

    const strikeBox = mk('div', 'strikes', tl);
    this.elPips = mk('div', 'pips', strikeBox);
    mk('div', 'strikes-tag', strikeBox, 'STRIKES');
    this.pipEls = [];
    this.pipState = null;                 // Uint8Array, sized on first setStrikes
    this.pipFlip = null;
    this.strikeMax = 0;
    this.strikeUsed = 0;
    this._buildPips(TUNING.collision.maxStrikes);

    this.elChain = mk('div', CLS_CHAIN, tl);
    this.elChainBody = mk('div', CLS_CHAIN_BODY, this.elChain);
    mk('span', 'chain-x', this.elChainBody, '×');
    this.elChainN = mk('span', 'chain-n', this.elChainBody, '0');
    mk('span', 'chain-tag', this.elChainBody, 'CHAIN');

    /* ── top-centre: the weight counter (the star) ─────────────────────────── */
    const tc = mk('div', 'hud-zone hud-tc', chrome);
    this.elWeigh = mk('div', CLS_WEIGH, tc);

    const win = mk('div', 'weigh-window', this.elWeigh);
    const reel = mk('div', 'reel', win);

    const nd = Math.max(3, U.weightDigits | 0);
    this.weightDigits = new Array(nd);
    this.weightDigitVals = new Int8Array(nd).fill(-1);
    this.weightSeps = [];
    this.weightSepPower = [];
    for (let i = nd - 1; i >= 0; i--) {
      if (i < nd - 1 && ((i + 1) % 3) === 0) {
        this.weightSeps.push(mk('span', CLS_SEP, reel, ','));
        this.weightSepPower.push(i + 1);
      }
      this.weightDigits[i] = mk('span', CLS_DIGIT, reel, '0');
    }
    this.weightMax = Math.pow(10, nd) - 1;
    mk('span', 'weigh-unit', win, 'KG');

    // The target lives welded to the underside of the counter — the player must
    // never have to remember what they are building toward.
    this.elTarget = mk('div', CLS_TARGET, this.elWeigh);
    // Endless mode's lap and the daily's number ride on the target line rather
    // than taking a corner of their own — the HUD gains no new furniture in v3.
    this.elRunTag = mk('span', 'tgt-tag', this.elTarget, '');
    this.elRunTag.hidden = true;
    this.runTag = '';
    this.elTargetLabel = mk('span', 'tgt-k', this.elTarget, TXT_TARGET);
    this.elTargetValue = mk('span', 'tgt-v', this.elTarget, '0');
    mk('span', 'tgt-u', this.elTarget, 'KG');

    const tgTrack = mk('div', 'tgt-track', this.elWeigh);
    this.elTargetFill = mk('i', 'tgt-fill', tgTrack);

    /* ── right edge: the progress rail ─────────────────────────────────────── */
    const rail = mk('div', 'hud-prog', chrome);
    this.elRail = mk('div', 'prog-rail', rail);
    this.elBands = mk('div', 'prog-bands', this.elRail);
    this.elProgFill = mk('i', 'prog-fill', this.elRail);
    this.elProgHead = mk('i', 'prog-head', this.elRail);
    mk('i', 'prog-house', this.elRail);
    this.bandEls = [];
    this.bandCount = 0;
    this.bandFinale = false;
    this.bandSig = -1;
    this.bandSrc = null;
    this.zoneIndex = -1;
    this.progStep = -1;
    this.elRail.style.setProperty('--p', NUM_STR[0]);

    /* ── zone recap banner (transient, centre-top) ─────────────────────────── */
    this.elBanner = mk('div', CLS_BANNER, chrome);
    this.elBannerText = mk('div', 'banner-text', this.elBanner, '');
    // §16.4's second line: what the zone paid, and the pace verdict. The verdict
    // is a WORD first — its colour is a muted amber-grey that could not be read
    // as an outline amber at the edge of vision, and it is legible with the
    // saturation at zero.
    this.elBannerRow = mk('div', CLS_BANNER_ROW_OFF, this.elBanner);
    this.elBannerDelta = mk('span', 'banner-delta', this.elBannerRow, '');
    this.elBannerVerdict = mk('span', 'banner-verdict', this.elBannerRow, '');
    this.bannerTimer = 0;
    this.bannerOn = false;

    /* ── popup pool ────────────────────────────────────────────────────────── */
    this.elPopups = mk('div', 'hud-popups', chrome);
    const pc = Math.max(1, U.popupCount | 0);
    this.popCount = pc;
    this.popEls = new Array(pc);
    this.popAlive = new Uint8Array(pc);
    this.popGain = new Uint8Array(pc);
    this.popFlip = new Uint8Array(pc);
    this.popLife = new Float32Array(pc);
    this.popX = new Float32Array(pc);
    this.popY = new Float32Array(pc);
    this.popZ = new Float32Array(pc);
    this.popVX = new Float32Array(pc);
    this.popVY = new Float32Array(pc);
    this.popLastX = new Float32Array(pc).fill(-9999);
    this.popLastY = new Float32Array(pc).fill(-9999);
    for (let i = 0; i < pc; i++) {
      const el = mk('div', CLS_POP, this.elPopups, '');
      el.style.animationDuration = U.popupLife + 's';
      el.style.translate = PARKED;
      this.popEls[i] = el;
    }
    this.popCursor = 0;
    this.popSeed = 1;

    /* ── beats, outside the chrome so a scale reveal cannot dim them ───────── */
    this.elStamp = mk('div', CLS_STAMP, root);
    this.elStampText = mk('div', 'stamp-text', this.elStamp, '');
    this.elStampSub = mk('div', 'stamp-sub', this.elStamp, '');
    this.stampFlip = 0;
    this.stampTimer = 0;

    this.elEdge = mk('div', CLS_EDGE, root);
    this.edgeFlip = 0;

    // Where popups fly to: the middle of the weight window, in CSS pixels.
    this.anchorX = 0;
    this.anchorY = 0;
    this.anchorW = -1;
    this.anchorH = -1;

    /* ── state ─────────────────────────────────────────────────────────────── */
    this.weightTarget = TUNING.player.startWeight;
    this.weightShown = this.weightTarget;
    this.weightRate = 0;
    this.weightInt = -1;
    this.weightSig = -1;
    this.targetKg = TUNING.finale.houseWeight;
    this.targetMet = false;
    this.targetBarStep = -1;
    this.weighFlip = 0;

    this.chain = 0;
    this.chainShown = -1;
    this.chainLit = false;
    this.chainOn = false;
    this.chainFlip = 0;

    this.dimNow = 0;
    this.dimHold = 0;
    this.dimStep = FRAC_STEPS;

    this.visible = false;

    this.setTarget(this.targetKg);
    this._writeWeight();
    this.setStrikes(0, TUNING.collision.maxStrikes);
  }

  /** The DOM element MODULE A's LabelSystem should be constructed with. */
  get labelRoot() {
    return this.labelLayer;
  }

  /* ── public API ─────────────────────────────────────────────────────────── */

  /** Set the weight. The reel rolls toward it like a weighbridge, never snaps. */
  setWeight(kg) {
    const v = kg > 0 ? kg : 0;
    if (v === this.weightTarget) return;
    const up = v > this.weightTarget;
    this.weightTarget = v;
    const delta = Math.abs(v - this.weightShown);
    this.weightRate = delta / Math.max(1e-4, TUNING.ui.weightTickTime);

    // A loss is the only thing that shakes the plate; a gain punches it. The
    // shake is a shape, not a colour, so it survives greyscale.
    this.weighFlip ^= 1;
    if (up) this.elWeigh.className = this.weighFlip ? CLS_WEIGH_UP_A : CLS_WEIGH_UP_B;
    else this.elWeigh.className = this.weighFlip ? CLS_WEIGH_DOWN_A : CLS_WEIGH_DOWN_B;
  }

  /** The house weight. Printed under the counter and never hidden. */
  setTarget(kg) {
    const v = kg > 0 ? Math.round(kg) : 0;
    if (v === this.targetKg && this.elTargetValue.textContent !== '0') return;
    this.targetKg = v;
    this.elTargetValue.textContent = groupInt(v);
    this.targetBarStep = -1;
    this._writeTargetBar();
  }

  /** Three pips, top-left. A spent pip is stencilled with a ✕, not coloured. */
  setStrikes(used, max) {
    const m = Math.max(1, (max || TUNING.collision.maxStrikes) | 0);
    if (m !== this.strikeMax) this._buildPips(m);
    const u = clamp(used | 0, 0, m);
    if (u === this.strikeUsed) return;
    const grew = u > this.strikeUsed;
    this.strikeUsed = u;
    for (let i = 0; i < m; i++) {
      const spent = i < u ? 1 : 0;
      if (this.pipState[i] === spent && !(grew && i === u - 1)) continue;
      this.pipState[i] = spent;
      if (!spent) {
        this.pipEls[i].className = CLS_PIP;
      } else if (grew && i === u - 1) {
        this.pipFlip[i] ^= 1;
        this.pipEls[i].className = this.pipFlip[i] ? CLS_PIP_SPENT_A : CLS_PIP_SPENT_B;
      } else {
        this.pipEls[i].className = CLS_PIP_SPENT;
      }
    }
  }

  /**
   * The vertical rail down the right edge.
   *
   * `t01` is the run's completion, 0 at the start line and 1 at the house.
   * `zones` may be the plan's zone array (objects carrying `dStart`/`dEnd`, or a
   * `t` fraction), an array of plain 0..1 fractions, or simply a zone count —
   * all four are laid out identically. `zoneIndex` is the zone the player is in;
   * pass the zone count (or anything past the last index) once the finale
   * run-up has started and the finale band lights instead.
   */
  setProgress(t01, zones, zoneIndex) {
    this._syncBands(zones);

    const zi = zoneIndex === undefined || zoneIndex === null ? -1 : zoneIndex | 0;
    if (zi !== this.zoneIndex) {
      this.zoneIndex = zi;
      const n = this.bandCount;
      for (let i = 0; i < n; i++) {
        const finale = i === n - 1 && this.bandFinale;
        const cls = i === zi
          ? (finale ? CLS_BAND_FINALE_NOW : CLS_BAND_NOW)
          : i < zi
            ? (finale ? CLS_BAND_FINALE : CLS_BAND_PAST)
            : (finale ? CLS_BAND_FINALE : CLS_BAND);
        this.bandEls[i].className = cls;
      }
    }

    let step = (clamp01(t01) * PROG_STEPS + 0.5) | 0;
    if (step < 0) step = 0;
    else if (step > PROG_STEPS) step = PROG_STEPS;
    if (step === this.progStep) return;
    this.progStep = step;
    this.elRail.style.setProperty('--p', NUM_STR[step]);
  }

  /** Consecutive smashes. Ignites at `TUNING.score.chainIgniteAt`. */
  setChain(n) {
    const c = n > 0 ? n | 0 : 0;
    if (c === this.chain) return;
    const grew = c > this.chain;
    this.chain = c;

    const on = c >= TUNING.ui.chainShowAt;
    const lit = c >= TUNING.score.chainIgniteAt;
    if (on && c !== this.chainShown) {
      this.chainShown = c;
      this.elChainN.textContent = c < 200 ? CHAIN_STR[c] : '' + c;
    }
    if (on !== this.chainOn || lit !== this.chainLit) {
      this.chainOn = on;
      this.chainLit = lit;
      this.elChain.className = !on ? CLS_CHAIN : lit ? CLS_CHAIN_LIT : CLS_CHAIN_ON;
    }
    if (on && grew) {
      this.chainFlip ^= 1;
      this.elChainBody.className = this.chainFlip ? CLS_CHAIN_BODY_A : CLS_CHAIN_BODY_B;
    }
  }

  /**
   * A weight-gain number that flies out of the object and into the counter.
   * `colour` may be a CSS string or a 0xRRGGBB number (the outline palette).
   * Pooled — this never creates a node.
   */
  addPopup(text, wx, wy, wz, colour) {
    const U = TUNING.ui;
    const n = this.popCount;

    let idx = -1;
    for (let k = 0; k < n; k++) {
      let j = this.popCursor + k;
      if (j >= n) j -= n;
      if (this.popAlive[j] === 0) { idx = j; break; }
    }
    // All busy: steal the slot at the cursor, which is the oldest in the ring.
    if (idx === -1) idx = this.popCursor;
    this.popCursor = idx + 1 >= n ? 0 : idx + 1;

    if (this.popSeed > 1e6) this.popSeed = 1;
    const h1 = hash11(this.popSeed++);
    const h2 = hash11(this.popSeed++);

    this.popAlive[idx] = 1;
    this.popLife[idx] = 0;
    this.popGain[idx] = (typeof text === 'string' && text.charCodeAt(0) === 43) ? 1 : 0;
    this.popX[idx] = wx;
    this.popY[idx] = wy;
    this.popZ[idx] = wz;
    this.popVX[idx] = (h1 * 2 - 1) * 1.4;
    this.popVY[idx] = U.popupRise * (0.85 + h2 * 0.3);
    this.popLastX[idx] = -9999;
    this.popLastY[idx] = -9999;

    const el = this.popEls[idx];
    el.textContent = text;
    el.style.color = colourString(colour);
    el.style.translate = PARKED;
    // Swapping between two identical animations restarts it without a reflow.
    this.popFlip[idx] ^= 1;
    el.className = this.popFlip[idx] ? CLS_POP_A : CLS_POP_B;
  }

  /**
   * Integrate the live popups and re-project them. For the first
   * `TUNING.ui.popupHang` of their life they hang above the object they came
   * from; after that they accelerate into the weight counter and shrink, and
   * the counter punches when they land. That is the money shot.
   */
  updatePopups(dt, camera, width, height) {
    const n = this.popCount;
    if (!camera || !camera.matrixWorld || !camera.projectionMatrix) return;
    if (!(width > 0) || !(height > 0)) return;

    const U = TUNING.ui;
    const life = U.popupLife;
    const hang = clamp01(U.popupHang);
    const margin = U.popupCullMargin;

    if (width !== this.anchorW || height !== this.anchorH) this._measureAnchor(width, height);
    const ax = this.anchorX;
    const ay = this.anchorY;

    // Keep the popups locked to the frame that is about to be drawn.
    if (camera.updateMatrixWorld) camera.updateMatrixWorld();

    for (let i = 0; i < n; i++) {
      if (this.popAlive[i] === 0) continue;

      const t = this.popLife[i] + dt;
      const el = this.popEls[i];
      if (t >= life) {
        this.popAlive[i] = 0;
        el.className = CLS_POP;
        el.style.translate = PARKED;
        this.popLastX[i] = -9999;
        this.popLastY[i] = -9999;
        if (this.popGain[i] === 1) this._punch();
        continue;
      }
      this.popLife[i] = t;

      const u = t / life;
      // World drift, damped: the number lifts off the wreck, then stops rising.
      const damp = u < hang ? 1 : 0.25;
      this.popX[i] += this.popVX[i] * dt * damp;
      this.popY[i] += this.popVY[i] * dt * damp;

      project(camera, this.popX[i], this.popY[i], this.popZ[i], width, height);

      let px;
      let py;
      const k = hang >= 1 ? 0 : smoothstep((u - hang) / (1 - hang));
      if (_projOk) {
        px = _projX + (ax - _projX) * k;
        py = _projY + (ay - _projY) * k;
      } else if (k > 0.02) {
        // Behind the camera but already homing: fly in from the bottom edge.
        px = ax;
        py = height + (ay - height) * k;
      } else {
        if (this.popLastX[i] !== -9999) {
          el.style.translate = PARKED;
          this.popLastX[i] = -9999;
          this.popLastY[i] = -9999;
        }
        continue;
      }

      if (px < -margin || px > width + margin || py < -margin || py > height + margin) {
        if (this.popLastX[i] !== -9999) {
          el.style.translate = PARKED;
          this.popLastX[i] = -9999;
          this.popLastY[i] = -9999;
        }
        continue;
      }

      const rx = Math.round(px);
      const ry = Math.round(py);
      if (rx !== this.popLastX[i] || ry !== this.popLastY[i]) {
        this.popLastX[i] = rx;
        this.popLastY[i] = ry;
        el.style.translate = rx + 'px ' + ry + 'px';
      }
    }
  }

  /**
   * The zone-boundary recap. `tone` is 'good' (ON PACE), 'warn' (BEHIND PACE)
   * or anything else for neutral. Tone is carried by weight and by the rule
   * under the text, never by hue — the colour monopoly owns green and amber.
   */
  zoneBanner(text, tone) {
    this.elBannerText.textContent = text === undefined || text === null ? '' : text;
    if (this.elBannerRow.className !== CLS_BANNER_ROW_OFF) {
      this.elBannerRow.className = CLS_BANNER_ROW_OFF;
    }
    this.elBanner.className = tone === 'good' ? CLS_BANNER_GOOD
      : tone === 'warn' ? CLS_BANNER_WARN
        : CLS_BANNER_INFO;
    this.bannerOn = true;
    this.bannerTimer = TUNING.ui.bannerTime;
  }

  /**
   * §16.4's recap beat, composed rather than handed a sentence:
   *
   *     ZONE 3 CLEARED
   *     +6,200 KG            ON PACE
   *
   * The headline is what happened, the delta is what it paid, and the verdict is
   * the only thing the player has to act on — so it sits alone on the right and
   * is stated in words. Called five times in a run, at a boundary the game has
   * already slowed down for.
   */
  zoneRecap(zoneIndex, gainedKg, onPace) {
    const z = zoneIndex | 0;
    this.elBannerText.textContent = z >= 0 && z < ZONE_CLEARED.length
      ? ZONE_CLEARED[z] : 'ZONE ' + z + ' CLEARED';

    const kg = Math.round(gainedKg) || 0;
    this.elBannerDelta.textContent = (kg < 0 ? '−' : '+') + groupInt(kg < 0 ? -kg : kg) + ' KG';
    this.elBannerVerdict.textContent = onPace ? TXT_ON_PACE : TXT_BEHIND_PACE;
    this.elBannerRow.className = CLS_BANNER_ROW;

    this.elBanner.className = onPace ? CLS_BANNER_GOOD : CLS_BANNER_WARN;
    this.bannerOn = true;
    this.bannerTimer = TUNING.ui.bannerTime;
  }

  /**
   * §17's first taste: the tier's name stamped over the middle of the screen for
   * `TUNING.ui.stampTime` while the game is in its 0.5 s close-up. `sub` is an
   * optional line under it ('FIRST BLOOD', the object's weight, …).
   *
   * The stamp is not chrome, so it does not dim with the rest of the HUD, and it
   * restarts by alternating between two identical animations — the same
   * reflow-free idiom the popups and the strike pips use.
   */
  stampTier(name, sub) {
    this.elStampText.textContent = name === undefined || name === null ? '' : name;
    this.elStampSub.textContent = sub === undefined || sub === null ? '' : sub;
    this.stampFlip ^= 1;
    this.elStamp.className = this.stampFlip ? CLS_STAMP_A : CLS_STAMP_B;
    this.stampTimer = TUNING.ui.stampTime;
  }

  /**
   * The paper tier's reward (§5): a pulse around the edge of the frame, which is
   * free. It costs no hitstop, no speed and — because the flash is a class swap
   * on a fixed element — no layout, no allocation and no style read.
   */
  flashEdge() {
    this.edgeFlip ^= 1;
    this.elEdge.className = this.edgeFlip ? CLS_EDGE_A : CLS_EDGE_B;
  }

  /**
   * Fade the chrome. 0 is normal, 1 is gone. §17's scale reveal is a camera move
   * and this is its on-screen half: the HUD gets out of the way of the shot.
   */
  setDim(k) {
    this.dimHold = 0;
    this.dimNow = clamp01(k);
    this._writeDim();
  }

  /** Hold the chrome faded for `seconds`, ramping either side. */
  dimFor(seconds) {
    const s = Number(seconds) || 0;
    if (s > this.dimHold) this.dimHold = s;
  }

  /**
   * A short tag on the target line — 'LAP 3' in endless, 'DAILY #142' in the
   * daily. Empty or null removes it. Not on a per-frame path.
   */
  setRunTag(text) {
    const t = text === undefined || text === null ? '' : '' + text;
    if (t === this.runTag) return;
    this.runTag = t;
    this.elRunTag.textContent = t;
    this.elRunTag.hidden = t === '';
  }

  /** Per-frame with unscaled dt. Drives the reel roll and the banner timer. */
  update(dt) {
    if (this.weightShown !== this.weightTarget) {
      this.weightShown = moveTowards(this.weightShown, this.weightTarget, this.weightRate * dt);
      this._writeWeight();
    }
    if (this.bannerOn) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.bannerTimer = 0;
        this.bannerOn = false;
        this.elBanner.className = CLS_BANNER;
      }
    }
    if (this.stampTimer > 0) {
      this.stampTimer -= dt;
      if (this.stampTimer <= 0) {
        this.stampTimer = 0;
        this.elStamp.className = CLS_STAMP;
      }
    }

    // The reveal fades the chrome out for as long as the camera is out there,
    // then brings it back. A written custom property costs nothing while the
    // fade is not moving, which is every frame but ~30 per run.
    const want = this.dimHold > 0 ? 1 : 0;
    if (this.dimHold > 0) {
      this.dimHold -= dt;
      if (this.dimHold < 0) this.dimHold = 0;
    }
    if (this.dimNow !== want) {
      // A missing `dimTime` would make the ramp NaN, and a NaN never converges —
      // the chrome would quantise to 0 and the whole HUD would stay invisible for
      // the rest of the run. The fallback is the same value the key carries.
      const ramp = TUNING.ui.dimTime > 0 ? TUNING.ui.dimTime : DIM_TIME_FALLBACK;
      this.dimNow = moveTowards(this.dimNow, want, dt / ramp);
      this._writeDim();
    }
  }

  /** §16.12's device buzz, routed through the module-level guard. */
  haptic(kind) {
    return haptic(kind);
  }

  setVisible(v) {
    const b = !!v;
    if (b === this.visible) return;
    this.visible = b;
    this.root.className = b ? CLS_HUD_ON : CLS_HUD;
    // The counter may have been laid out while hidden; re-measure on the next
    // popup frame so the flight path lands where the counter actually is.
    this.anchorW = -1;
  }

  /** Back to a fresh run: instant, no rebuild. This must never feel like a load. */
  reset() {
    this.weightTarget = TUNING.player.startWeight;
    this.weightShown = this.weightTarget;
    this.weightRate = 0;
    this.elWeigh.className = CLS_WEIGH;
    this.targetMet = false;
    this.elTarget.className = CLS_TARGET;
    this.elTargetLabel.textContent = TXT_TARGET;
    this.weightInt = -1;
    this.weightSig = -1;
    this._writeWeight();

    this.strikeUsed = -1;
    this.setStrikes(0, this.strikeMax || TUNING.collision.maxStrikes);

    this.chain = -1;
    this.chainShown = -1;
    this.chainOn = false;
    this.chainLit = false;
    this.elChain.className = CLS_CHAIN;
    this.elChainBody.className = CLS_CHAIN_BODY;
    this.elChainN.textContent = '0';
    this.chain = 0;

    this.zoneIndex = -1;
    this.progStep = -1;
    this.elRail.style.setProperty('--p', NUM_STR[0]);
    for (let i = 0; i < this.bandCount; i++) {
      const finale = i === this.bandCount - 1 && this.bandFinale;
      this.bandEls[i].className = finale ? CLS_BAND_FINALE : CLS_BAND;
    }

    this.bannerOn = false;
    this.bannerTimer = 0;
    this.elBanner.className = CLS_BANNER;
    this.elBannerRow.className = CLS_BANNER_ROW_OFF;

    this.stampTimer = 0;
    this.elStamp.className = CLS_STAMP;
    this.elEdge.className = CLS_EDGE;
    this.setRunTag('');

    this.dimHold = 0;
    this.dimNow = 0;
    this._writeDim();

    for (let i = 0; i < this.popCount; i++) {
      if (this.popAlive[i] === 0 && this.popLastX[i] === -9999) continue;
      this.popAlive[i] = 0;
      this.popLastX[i] = -9999;
      this.popLastY[i] = -9999;
      const el = this.popEls[i];
      el.className = CLS_POP;
      el.style.translate = PARKED;
    }
    this.popCursor = 0;
    this.anchorW = -1;
  }

  dispose() {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  _buildPips(max) {
    const m = Math.max(1, max | 0);
    while (this.elPips.firstChild) this.elPips.removeChild(this.elPips.firstChild);
    this.pipEls.length = 0;
    for (let i = 0; i < m; i++) this.pipEls.push(mk('i', CLS_PIP, this.elPips));
    this.pipState = new Uint8Array(m);
    this.pipFlip = new Uint8Array(m);
    this.strikeMax = m;
    this.strikeUsed = 0;
  }

  /**
   * Lay out the rail's zone bands. Only rebuilt when the shape of the run
   * changes, which is once per run at most.
   */
  _syncBands(zones) {
    // The common case is the same plan array every frame: an identity check
    // costs nothing and keeps this whole method off the allocating path.
    if (zones === this.bandSrc) return;

    let n = 0;
    let s0 = 0;
    let s1 = 0;
    if (typeof zones === 'number') {
      n = Math.max(1, zones | 0);
    } else if (zones && zones.length > 0) {
      n = Math.min(EDGES.length, zones.length | 0);
      const first = zones[0];
      const last = zones[n - 1];
      s0 = typeof first === 'number' ? first
        : Number(first.dEnd !== undefined ? first.dEnd : first.t) || 0;
      s1 = typeof last === 'number' ? last
        : Number(last.dEnd !== undefined ? last.dEnd : last.t) || 0;
    } else {
      n = TUNING.weights.zones.length;
    }
    // A numeric signature, so a caller that rebuilds its array every frame
    // still does not rebuild the rail every frame.
    const sig = n * 1e12 + s0 * 1e5 + s1;
    if (sig === this.bandSig) { this.bandSrc = zones; return; }
    this.bandSig = sig;
    this.bandSrc = zones;

    // Boundary fractions of the rail, 0 at the start line and 1 at the house.
    const edges = EDGES;
    if (typeof zones === 'number' || !zones || zones.length === 0) {
      for (let i = 0; i < n; i++) edges[i] = (i + 1) / (n + 1);
    } else if (typeof zones[0] === 'number') {
      let maxV = 0;
      for (let i = 0; i < n; i++) maxV = Math.max(maxV, zones[i]);
      const scale = maxV > 1.0001 ? 1 / maxV : 1;
      for (let i = 0; i < n; i++) edges[i] = clamp01(zones[i] * scale);
    } else if (zones[0] && zones[0].t !== undefined) {
      for (let i = 0; i < n; i++) edges[i] = clamp01(zones[i].t);
    } else {
      // Plan zones: the finale run-up sits between the last zone and the house,
      // so the rail's full length is the last zone end plus that run-up.
      const lastEnd = Number(zones[n - 1].dEnd) || 0;
      const total = Math.max(1, lastEnd + TUNING.finale.runUpLength);
      for (let i = 0; i < n; i++) edges[i] = clamp01((Number(zones[i].dEnd) || 0) / total);
    }

    // One band per zone plus a final band for the run-up to the house.
    const wantFinale = edges[n - 1] < 0.995;
    const count = wantFinale ? n + 1 : n;
    this.bandFinale = wantFinale;

    while (this.elBands.firstChild) this.elBands.removeChild(this.elBands.firstChild);
    this.bandEls.length = 0;
    let prev = 0;
    for (let i = 0; i < count; i++) {
      const end = i < n ? edges[i] : 1;
      const el = mk('i', i === count - 1 && wantFinale ? CLS_BAND_FINALE : CLS_BAND, this.elBands);
      el.style.top = (prev * 100).toFixed(3) + '%';
      el.style.height = Math.max(0, (end - prev) * 100).toFixed(3) + '%';
      this.bandEls.push(el);
      prev = end;
    }
    this.bandCount = count;
    this.zoneIndex = -1;
  }

  /** The flight target: the centre of the weight window, in CSS pixels. */
  _measureAnchor(width, height) {
    this.anchorW = width;
    this.anchorH = height;
    const r = this.elWeigh.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) {
      this.anchorX = r.left + r.width * 0.5;
      this.anchorY = r.top + r.height * 0.42;
    } else {
      this.anchorX = width * 0.5;
      this.anchorY = height * 0.10;
    }
  }

  _writeDim() {
    let step = ((1 - this.dimNow) * FRAC_STEPS + 0.5) | 0;
    if (step < 0) step = 0;
    else if (step > FRAC_STEPS) step = FRAC_STEPS;
    if (step === this.dimStep) return;
    this.dimStep = step;
    this.root.style.setProperty('--chrome', FRAC_STR[step]);
  }

  /** Restart the counter's punch without touching the reel's contents. */
  _punch() {
    this.weighFlip ^= 1;
    this.elWeigh.className = this.weighFlip ? CLS_WEIGH_UP_A : CLS_WEIGH_UP_B;
  }

  _writeTargetBar() {
    const t = this.targetKg > 0 ? this.weightShown / this.targetKg : 0;
    let step = (clamp01(t) * BAR_STEPS + 0.5) | 0;
    if (step < 0) step = 0;
    else if (step > BAR_STEPS) step = BAR_STEPS;
    if (step === this.targetBarStep) return;
    this.targetBarStep = step;
    this.elTargetFill.style.transform = SCALE_X[step];
  }

  /** Writes only the digits that actually changed — a scale moves one wheel. */
  _writeWeight() {
    const iv = clamp(Math.round(this.weightShown), 0, this.weightMax);
    if (iv === this.weightInt) return;
    this.weightInt = iv;

    let rem = iv;
    const n = this.weightDigits.length;
    for (let i = 0; i < n; i++) {
      const d = rem % 10;
      rem = (rem - d) / 10;
      if (this.weightDigitVals[i] !== d) {
        this.weightDigitVals[i] = d;
        this.weightDigits[i].textContent = DIGIT_CHARS[d];
      }
    }

    // Leading zeros stay lit-but-dim, the way an unlit scale segment reads.
    let sig = 1;
    let probe = iv;
    while (probe >= 10) { probe = (probe - probe % 10) / 10; sig++; }
    if (sig !== this.weightSig) {
      this.weightSig = sig;
      for (let i = 0; i < n; i++) {
        this.weightDigits[i].className = i < sig ? CLS_DIGIT : CLS_DIGIT_DIM;
      }
      for (let i = 0; i < this.weightSeps.length; i++) {
        this.weightSeps[i].className = sig > this.weightSepPower[i] ? CLS_SEP : CLS_SEP_DIM;
      }
    }

    this._writeTargetBar();

    const met = this.targetKg > 0 && iv >= this.targetKg;
    if (met !== this.targetMet) {
      this.targetMet = met;
      this.elTarget.className = met ? CLS_TARGET_MET : CLS_TARGET;
      this.elTargetLabel.textContent = met ? TXT_TARGET_MET : TXT_TARGET;
    }
  }
}
