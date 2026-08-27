/**
 * TONNAGE — HUD.
 *
 * Corners only. Score + combo top-left, the mass scale top-centre, distance
 * top-right. Nothing else: no minimap, no health bar, no clutter in the middle
 * of the screen where the hill is.
 *
 * The whole file is written to make zero allocations per frame:
 *  - every transform string the HUD can ever need is pre-built at module load
 *    (`SCALE_X`) or is a module constant,
 *  - digits are individual pooled <span>s and only the ones that actually
 *    changed are written (a real truck scale only moves the wheel that turned),
 *  - popups are a fixed pool of DOM nodes moved with `transform: translate3d`
 *    and never with `left`/`top`.
 *
 * The one unavoidable exception is `translate3d(...)` for popups and the score /
 * distance strings, which the DOM can only accept as text. Those are built only
 * when the underlying value actually changed, so a still frame allocates nothing.
 */

import { TUNING } from '../tuning.js';
import { clamp, moveTowards, hash11 } from '../core/math.js';

/* ─────────────────────────────────────────── module constants (built once) ── */

const DIGIT_CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Pre-built `scaleX()` strings so the combo bar never allocates. */
const SCALE_STEPS = 100;
const SCALE_X = new Array(SCALE_STEPS + 1);
for (let i = 0; i <= SCALE_STEPS; i++) SCALE_X[i] = 'scaleX(' + (i / SCALE_STEPS) + ')';

/** Where a popup goes when it is off-screen or dead. */
const PARKED = 'translate3d(-9999px,-9999px,0)';

const CLS_HUD = 'hud';
const CLS_HUD_ON = 'hud on';

const CLS_POP = 'pop';
const CLS_POP_A = 'pop pop-a';
const CLS_POP_B = 'pop pop-b';

const CLS_SCALE = 'scale';
const CLS_SCALE_UP_A = 'scale up-a';
const CLS_SCALE_UP_B = 'scale up-b';
const CLS_SCALE_DOWN_A = 'scale down-a';
const CLS_SCALE_DOWN_B = 'scale down-b';

const CLS_COMBO = 'combo';
const CLS_COMBO_ON = 'combo on';
const CLS_COMBO_BODY = 'combo-body';
const CLS_COMBO_BODY_A = 'combo-body pa';
const CLS_COMBO_BODY_B = 'combo-body pb';

const CLS_DIGIT = 'reel-d';
const CLS_DIGIT_DIM = 'reel-d z';
const CLS_SEP = 'reel-sep';
const CLS_SEP_DIM = 'reel-sep z';

/* ───────────────────────────────────────────────── projection scratch state ── */
/* Plain numbers, not an object: projecting a popup allocates nothing. */
let _projX = 0;
let _projY = 0;
let _projOk = false;

/**
 * Project a world point to CSS pixels using the camera's matrices directly.
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
  if (cw <= 1e-5) return; // behind the eye

  const cx = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12];
  const cy = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13];

  _projX = (cx / cw * 0.5 + 0.5) * width;
  _projY = (0.5 - cy / cw * 0.5) * height;
  _projOk = true;
}

/** Thousands-grouped integer, without `toLocaleString` (which is slow and allocates). */
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

function mk(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
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

    // Feel numbers that only CSS needs are handed over as custom properties, so
    // TUNING stays the single source of truth without any per-frame style work.
    const st = root.style;
    st.setProperty('--hud-fade', U.hudFadeTime + 's');
    st.setProperty('--mass-punch', '' + U.massPunchScale);
    st.setProperty('--mass-punch-time', U.massPunchTime + 's');
    st.setProperty('--combo-punch', '' + U.comboPunchScale);
    st.setProperty('--combo-punch-time', U.comboPunchTime + 's');
    st.setProperty('--pop-life', U.popupLife + 's');

    /* ── top-left: score + combo ───────────────────────────────────────────── */
    const tl = mk('div', 'hud-zone hud-tl', root);
    const scorePlate = mk('div', 'plate plate-score', tl);
    mk('div', 'plate-label', scorePlate, 'SCORE');
    this.elScore = mk('div', 'plate-value score-value', scorePlate, '0');

    this.elCombo = mk('div', CLS_COMBO, tl);
    this.elComboBody = mk('div', CLS_COMBO_BODY, this.elCombo);
    mk('span', 'combo-x', this.elComboBody, '×');
    this.elComboN = mk('span', 'combo-n', this.elComboBody, '2');
    mk('span', 'combo-tag', this.elComboBody, 'CHAIN');
    const comboBar = mk('div', 'combo-bar', this.elCombo);
    this.elComboFill = mk('i', 'combo-fill', comboBar);

    /* ── top-centre: the scale ─────────────────────────────────────────────── */
    const tc = mk('div', 'hud-zone hud-tc', root);
    this.elScale = mk('div', CLS_SCALE, tc);
    const head = mk('div', 'scale-head', this.elScale);
    mk('span', 'scale-tape', head);
    mk('span', 'scale-title', head, 'GROSS MASS');
    mk('span', 'scale-tape', head);

    const win = mk('div', 'scale-window', this.elScale);
    const reel = mk('div', 'reel', win);

    const nd = Math.max(3, U.massDigits | 0);
    this.massDigits = new Array(nd);
    this.massDigitVals = new Int8Array(nd).fill(-1);
    this.massSeps = [];
    this.massSepPower = [];
    for (let i = nd - 1; i >= 0; i--) {
      if (i < nd - 1 && ((i + 1) % 3) === 0) {
        this.massSeps.push(mk('span', CLS_SEP, reel, ','));
        this.massSepPower.push(i + 1);
      }
      this.massDigits[i] = mk('span', CLS_DIGIT, reel, '0');
    }
    this.massMax = Math.pow(10, nd) - 1;
    mk('span', 'scale-unit', win, 'KG');

    const foot = mk('div', 'scale-foot', this.elScale);
    this.elTonnes = mk('span', 'scale-tonnes', foot, '5.0 T');
    mk('span', 'scale-cert', foot, 'CLASS III · NO LIMIT');

    /* ── top-right: distance ───────────────────────────────────────────────── */
    const tr = mk('div', 'hud-zone hud-tr', root);
    const distPlate = mk('div', 'plate plate-dist', tr);
    mk('div', 'plate-label', distPlate, 'DISTANCE');
    const distVal = mk('div', 'plate-value', distPlate);
    this.elDist = mk('span', 'dist-num', distVal, '0');
    mk('span', 'plate-unit', distVal, 'M');

    /* ── popup pool ────────────────────────────────────────────────────────── */
    this.elPopups = mk('div', 'hud-popups', root);
    const pc = Math.max(1, U.popupCount | 0);
    this.popCount = pc;
    this.popEls = new Array(pc);
    this.popAlive = new Uint8Array(pc);
    this.popFlip = new Uint8Array(pc);
    this.popLife = new Float32Array(pc);
    this.popX = new Float32Array(pc);
    this.popY = new Float32Array(pc);
    this.popZ = new Float32Array(pc);
    this.popVX = new Float32Array(pc);
    this.popVY = new Float32Array(pc);
    this.popVZ = new Float32Array(pc);
    this.popLastX = new Float32Array(pc).fill(-9999);
    this.popLastY = new Float32Array(pc).fill(-9999);
    for (let i = 0; i < pc; i++) {
      const el = mk('div', CLS_POP, this.elPopups, '');
      el.style.animationDuration = U.popupLife + 's';
      el.style.transform = PARKED;
      this.popEls[i] = el;
    }
    this.popCursor = 0;
    this.popSeed = 1;

    /* ── state ─────────────────────────────────────────────────────────────── */
    this.massTarget = TUNING.player.startMass;
    this.massShown = this.massTarget;
    this.massRate = 0;
    this.massInt = -1;
    this.massSig = -1;
    this.tonnes10 = -1;

    this.scoreVal = -1;
    this.distVal = -1;
    this.combo = 1;
    this.comboOn = false;
    this.comboTimer = 0;
    this.comboBarStep = -1;
    this.comboFlip = 0;
    this.scaleFlip = 0;

    this.visible = false;

    this._writeMass();
    this._writeComboBar(0);
  }

  /* ── public API ─────────────────────────────────────────────────────────── */

  /** Set the target mass. The readout ticks toward it like a weighbridge. */
  setMass(kg) {
    const v = kg > 0 ? kg : 0;
    if (v === this.massTarget) return;
    const up = v > this.massTarget;
    this.massTarget = v;
    const delta = Math.abs(v - this.massShown);
    this.massRate = delta / Math.max(1e-4, TUNING.mass.hudTickTime);

    this.scaleFlip ^= 1;
    if (up) {
      this.elScale.className = this.scaleFlip ? CLS_SCALE_UP_A : CLS_SCALE_UP_B;
    } else {
      this.elScale.className = this.scaleFlip ? CLS_SCALE_DOWN_A : CLS_SCALE_DOWN_B;
    }
  }

  setDistance(m) {
    const v = m > 0 ? Math.round(m) : 0;
    if (v === this.distVal) return;
    this.distVal = v;
    this.elDist.textContent = groupInt(v);
  }

  setScore(points, combo) {
    const p = points > 0 ? Math.round(points) : 0;
    if (p !== this.scoreVal) {
      this.scoreVal = p;
      this.elScore.textContent = groupInt(p);
    }

    const c = combo > 0 ? combo | 0 : 1;
    if (c !== this.combo) {
      this.combo = c;
      const on = c >= TUNING.ui.comboMin;
      if (on) this.elComboN.textContent = c < 10 ? DIGIT_CHARS[c] : '' + c;
      if (on !== this.comboOn) {
        this.comboOn = on;
        this.elCombo.className = on ? CLS_COMBO_ON : CLS_COMBO;
      }
      if (!on) this.comboTimer = 0;
    }
  }

  /** Punch the multiplier and refill its decay bar. Called on every kill. */
  comboPop() {
    this.comboTimer = TUNING.score.comboWindow;
    this.comboFlip ^= 1;
    this.elComboBody.className = this.comboFlip ? CLS_COMBO_BODY_A : CLS_COMBO_BODY_B;
  }

  /** Per-frame, unscaled dt. Drives the mass tick-up and the combo decay bar. */
  update(dt) {
    if (this.massShown !== this.massTarget) {
      this.massShown = moveTowards(this.massShown, this.massTarget, this.massRate * dt);
      this._writeMass();
    }

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer < 0) this.comboTimer = 0;
    }
    const w = TUNING.score.comboWindow;
    this._writeComboBar(w > 0 ? this.comboTimer / w : 0);
  }

  /** Floating world-anchored score number. Pooled — never allocates a node. */
  addPopup(text, wx, wy, wz, color) {
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
    this.popX[idx] = wx;
    this.popY[idx] = wy;
    this.popZ[idx] = wz;
    this.popVX[idx] = (h1 * 2 - 1) * U.popupDrift;
    this.popVY[idx] = U.popupRise * (0.85 + h2 * 0.3);
    this.popVZ[idx] = (h2 * 2 - 1) * U.popupDrift * 0.5;
    this.popLastX[idx] = -9999;
    this.popLastY[idx] = -9999;

    const el = this.popEls[idx];
    el.textContent = text;
    el.style.color = color;
    el.style.transform = PARKED;
    // Swapping between two identical animations restarts it without a reflow.
    this.popFlip[idx] ^= 1;
    el.className = this.popFlip[idx] ? CLS_POP_A : CLS_POP_B;
  }

  /**
   * Integrate and re-project the live popups. `camera` is a THREE camera; the
   * projection is done by hand from its matrices (see `project`).
   */
  updatePopups(dt, camera, width, height) {
    const n = this.popCount;
    if (!camera || !camera.matrixWorld || !camera.projectionMatrix) return;
    if (!(width > 0) || !(height > 0)) return;

    const U = TUNING.ui;
    const life = U.popupLife;
    const g = U.popupGravity;
    const margin = U.popupCullMargin;

    // Keep the popups locked to the frame that is about to be drawn.
    if (camera.updateMatrixWorld) camera.updateMatrixWorld();

    for (let i = 0; i < n; i++) {
      if (this.popAlive[i] === 0) continue;

      const t = this.popLife[i] + dt;
      const el = this.popEls[i];
      if (t >= life) {
        this.popAlive[i] = 0;
        el.className = CLS_POP;
        el.style.transform = PARKED;
        this.popLastX[i] = -9999;
        this.popLastY[i] = -9999;
        continue;
      }
      this.popLife[i] = t;

      this.popVY[i] += g * dt;
      this.popX[i] += this.popVX[i] * dt;
      this.popY[i] += this.popVY[i] * dt;
      this.popZ[i] += this.popVZ[i] * dt;

      project(camera, this.popX[i], this.popY[i], this.popZ[i], width, height);
      if (!_projOk
        || _projX < -margin || _projX > width + margin
        || _projY < -margin || _projY > height + margin) {
        if (this.popLastX[i] !== -9999) {
          el.style.transform = PARKED;
          this.popLastX[i] = -9999;
          this.popLastY[i] = -9999;
        }
        continue;
      }

      const px = Math.round(_projX);
      const py = Math.round(_projY);
      if (px !== this.popLastX[i] || py !== this.popLastY[i]) {
        this.popLastX[i] = px;
        this.popLastY[i] = py;
        el.style.transform = 'translate3d(' + px + 'px,' + py + 'px,0)';
      }
    }
  }

  setVisible(v) {
    const b = !!v;
    if (b === this.visible) return;
    this.visible = b;
    this.root.className = b ? CLS_HUD_ON : CLS_HUD;
  }

  /** Back to a fresh run: instant, no rebuild — this must never feel like a load. */
  reset() {
    this.massTarget = TUNING.player.startMass;
    this.massShown = this.massTarget;
    this.massRate = 0;
    this.elScale.className = CLS_SCALE;
    this._writeMass();

    this.scoreVal = -1;
    this.distVal = -1;
    this.elScore.textContent = '0';
    this.elDist.textContent = '0';
    this.scoreVal = 0;
    this.distVal = 0;

    this.combo = 1;
    this.comboOn = false;
    this.comboTimer = 0;
    this.elCombo.className = CLS_COMBO;
    this.elComboBody.className = CLS_COMBO_BODY;
    this.elComboN.textContent = '2';
    this.comboBarStep = -1;
    this._writeComboBar(0);

    for (let i = 0; i < this.popCount; i++) {
      if (this.popAlive[i] === 0 && this.popLastX[i] === -9999) continue;
      this.popAlive[i] = 0;
      this.popLastX[i] = -9999;
      this.popLastY[i] = -9999;
      const el = this.popEls[i];
      el.className = CLS_POP;
      el.style.transform = PARKED;
    }
    this.popCursor = 0;
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  _writeComboBar(t01) {
    let step = (t01 * SCALE_STEPS + 0.5) | 0;
    if (step < 0) step = 0;
    else if (step > SCALE_STEPS) step = SCALE_STEPS;
    if (step === this.comboBarStep) return;
    this.comboBarStep = step;
    this.elComboFill.style.transform = SCALE_X[step];
  }

  /** Writes only the digits that actually changed. */
  _writeMass() {
    const iv = clamp(Math.round(this.massShown), 0, this.massMax);
    if (iv === this.massInt) return;
    this.massInt = iv;

    let rem = iv;
    const n = this.massDigits.length;
    for (let i = 0; i < n; i++) {
      const d = rem % 10;
      rem = (rem - d) / 10;
      if (this.massDigitVals[i] !== d) {
        this.massDigitVals[i] = d;
        this.massDigits[i].textContent = DIGIT_CHARS[d];
      }
    }

    // Leading zeros stay lit-but-dim, the way an unlit scale segment reads.
    let sig = 1;
    let probe = iv;
    while (probe >= 10) { probe = (probe - probe % 10) / 10; sig++; }
    if (sig !== this.massSig) {
      this.massSig = sig;
      for (let i = 0; i < n; i++) {
        this.massDigits[i].className = i < sig ? CLS_DIGIT : CLS_DIGIT_DIM;
      }
      for (let i = 0; i < this.massSeps.length; i++) {
        this.massSeps[i].className = sig > this.massSepPower[i] ? CLS_SEP : CLS_SEP_DIM;
      }
    }

    const t10 = Math.round(iv / 100);
    if (t10 !== this.tonnes10) {
      this.tonnes10 = t10;
      this.elTonnes.textContent = (t10 / 10).toFixed(1) + ' T';
    }
  }
}
