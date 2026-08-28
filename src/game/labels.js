import * as THREE from 'three/webgpu';
import { TUNING } from '../tuning.js';
import { clamp01, lerp, damp, smoothstep as sstep } from '../core/math.js';
import {
  OUTLINE_COLOURS,
  OUTLINE_BADGES,
  BLOCKER_NEUTRAL,
  BLOCKER_INK,
  outcomeFor,
  speedAtWeight,
} from '../render/outlines.js';

/**
 * TONNAGE — the printed weight labels (§6, MODULE A).
 *
 * Every object in the world has its weight written above it. The label is the
 * literal half of the read; the outline ring is the instinctive half. Together
 * they have to be judged in under half a second at 40 m/s, which is why this file
 * is as much about what it REFUSES to draw as what it draws.
 *
 *   • Only the nearest `TUNING.read.maxLabels` objects get one. Everything else is
 *     carried by the ring alone.
 *   • Labels NEVER overlap. Two numbers on top of each other are worse than no
 *     numbers at all, so a label that would collide with one already placed is
 *     pushed straight up by `TUNING.read.labelOverlapPush` px until it is clear.
 *   • Permanent blockers are capped at `TUNING.read.maxBlockerLabels`. They are
 *     already unmistakable (striped, un-glowing) and a gauntlet of eight of them
 *     would otherwise eat every label slot and hide the weights that matter.
 *
 * Colour comes from `OUTLINE_COLOURS` so a chip and its ring can never disagree,
 * and the shape badge (● ▲ ✕ ▮) carries the same meaning with no hue at all — the
 * labels stay readable desaturated, which is the test the whole system has to pass.
 *
 * Nodes are pooled and every style write is cached, so the steady state is one
 * `translate` write per visible label per frame and nothing else. Positions are
 * projected by hand through the camera's own matrices with a single reused
 * scratch vector.
 */

const LABEL_CAP = 16;                 // DOM pool size; the live cap comes from TUNING

/* Metrics of the chip, in CSS px at scale 1. The font is a monospace stack with
   tabular numerals precisely so the width can be predicted from the character
   count — measuring `offsetWidth` would force a synchronous layout every frame. */
const LABEL_CHAR_W = 8.45;            // advance width of one glyph at 14 px
const LABEL_CHROME_W = 34;            // padding + border + badge + gap
const LABEL_H = 24;
const LABEL_GAP_X = 4;                // px of clear air demanded between two chips
const LABEL_GAP_Y = 3;
const LABEL_RESOLVE_PASSES = 24;      // enough to clear a full stack at 26 px a push

const CLASS_FOR = {
  CLEAN: 'tnl tnl-clean',
  PLOW: 'tnl tnl-plow',
  BLOCKED: 'tnl tnl-blocked',
  BLOCKER: 'tnl tnl-blocker',
};

/* ─────────────────────────────────────────────────── module-level scratch ── */

/* Selection is a bounded nearest-first insertion, so these never grow and the
   per-frame path allocates nothing. */
const _selIdx = new Int32Array(LABEL_CAP);
const _selScore = new Float64Array(LABEL_CAP);
const _selDist = new Float64Array(LABEL_CAP);
const _selX = new Float64Array(LABEL_CAP);
const _selY = new Float64Array(LABEL_CAP);

/* Where each label actually landed, for the pairwise overlap test. */
const _placedX = new Float64Array(LABEL_CAP);
const _placedY = new Float64Array(LABEL_CAP);
const _placedW = new Float64Array(LABEL_CAP);
const _placedH = new Float64Array(LABEL_CAP);

/* The ONE scratch vector the projection is allowed to use, held as three scalars
   so nothing is boxed, plus the one matrix the view transform is built into. */
let _vx = 0;
let _vy = 0;
let _vz = 0;
const _view = new THREE.Matrix4();

let _styleEl = null;
let _styleRefs = 0;

/* ───────────────────────────────────────────────────────────── the system ── */

export class LabelSystem {
  /** @param {HTMLElement} root a DOM element inside #hud */
  constructor(root) {
    ensureStyles();
    this.root = root;
    this.layer = document.createElement('div');
    this.layer.className = 'tnl-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    root.appendChild(this.layer);

    /** @type {Array<object>} pooled DOM labels */
    this.slots = new Array(LABEL_CAP);
    for (let i = 0; i < LABEL_CAP; i++) this.slots[i] = makeSlot(this.layer);

    this._visible = true;
    this._active = 0;
  }

  /** How many labels were drawn on the last frame. */
  get activeCount() {
    return this._active;
  }

  /**
   * @param {number} dt seconds
   * @param {Array<object>} objects pooled record array
   * @param {number} count live entries in `objects`
   * @param {number} playerWeight kg
   * @param {THREE.PerspectiveCamera} camera
   * @param {number} width  viewport px
   * @param {number} height viewport px
   */
  update(dt, objects, count, playerWeight, camera, width, height) {
    const R = TUNING.read;

    if (!this._visible || !camera || !(width > 0) || !(height > 0)) {
      for (let i = 0; i < count; i++) if (objects[i]) objects[i].labelled = false;
      this._hideFrom(0);
      return;
    }

    // The renderer refreshes `matrixWorldInverse` during render, which may not
    // have happened yet this frame, so derive the view matrix ourselves into the
    // module-level scratch. Both calls are in-place and allocation-free.
    camera.updateMatrixWorld();
    _view.copy(camera.matrixWorld).invert();
    const proj = camera.projectionMatrix;

    let maxLabels = R.maxLabels < LABEL_CAP ? R.maxLabels : LABEL_CAP;
    if (maxLabels < 0) maxLabels = 0;
    const maxBlockers = R.maxBlockerLabels < maxLabels ? R.maxBlockerLabels : maxLabels;
    if (maxLabels === 0) {
      for (let i = 0; i < count; i++) if (objects[i]) objects[i].labelled = false;
      this._hideFrom(0);
      return;
    }

    // Fade in at `labelSeconds` of TRAVEL TIME ahead, not at a fixed distance, so
    // the read-ahead stays constant as the player gets heavier and faster.
    const speed = speedAtWeight(playerWeight);
    const far = R.labelSeconds * speed;
    const fadeFrom = far * (1 - R.labelFadeFraction);
    const fadeSpan = far - fadeFrom;

    let n = 0;

    for (let i = 0; i < count; i++) {
      const obj = objects[i];
      if (!obj) continue;
      obj.labelled = false;
      if (obj.alive === false || obj.visible === false) continue;

      const ey = obj.ey > 0 ? obj.ey : 1.0;
      const ax = typeof obj.cx === 'number' ? obj.cx : obj.x;
      const ay = (typeof obj.cy === 'number' ? obj.cy : obj.y + ey) + ey + 0.55;
      const az = typeof obj.cz === 'number' ? obj.cz : obj.z;

      // ── project by hand: world -> view -> clip -> screen ──────────────────
      applyView(_view, ax, ay, az);
      if (_vz > -0.25) continue;                    // behind the camera
      const dist = -_vz;
      if (dist > far) continue;

      applyProjection(proj);
      if (_vx < -1.3 || _vx > 1.3 || _vy < -1.5 || _vy > 1.5) continue;

      const sx = (_vx * 0.5 + 0.5) * width;
      const sy = (-_vy * 0.5 + 0.5) * height;

      // Blockers sort behind every breakable object, whatever the distance: a
      // wall of concrete must never cost a slot that a weight could have used.
      const score = obj.blocker === true ? dist + 1e6 : dist;

      if (n === maxLabels && score >= _selScore[maxLabels - 1]) continue;
      let pos = n < maxLabels ? n++ : maxLabels - 1;
      while (pos > 0 && _selScore[pos - 1] > score) {
        _selScore[pos] = _selScore[pos - 1];
        _selIdx[pos] = _selIdx[pos - 1];
        _selDist[pos] = _selDist[pos - 1];
        _selX[pos] = _selX[pos - 1];
        _selY[pos] = _selY[pos - 1];
        pos--;
      }
      _selScore[pos] = score;
      _selIdx[pos] = i;
      _selDist[pos] = dist;
      _selX[pos] = sx;
      _selY[pos] = sy;
    }

    // Trim the blocker tail down to its own budget. They are contiguous at the
    // end of the list because of the score penalty, so one compaction pass does it.
    if (n > 0) {
      let blockers = 0;
      let m = 0;
      for (let a = 0; a < n; a++) {
        if (objects[_selIdx[a]].blocker === true) {
          if (blockers >= maxBlockers) continue;
          blockers++;
        }
        if (m !== a) {
          _selIdx[m] = _selIdx[a];
          _selDist[m] = _selDist[a];
          _selX[m] = _selX[a];
          _selY[m] = _selY[a];
        }
        m++;
      }
      n = m;
    }

    // ── place, nearest first, and never let two chips touch ─────────────────
    const push = R.labelOverlapPush;
    const margin = R.labelMarginPx;
    let placed = 0;

    for (let a = 0; a < n; a++) {
      const obj = objects[_selIdx[a]];
      const slot = this.slots[placed];

      const outcome = outcomeFor(obj, playerWeight);
      const text = outcome === 'BLOCKER' ? 'BLOCKER' : formatKg(obj.weight);

      const dist = _selDist[a];
      const near01 = far > 0.001 ? clamp01(dist / far) : 0;
      const scale = lerp(R.labelScaleNear, R.labelScaleFar, near01);
      let alpha = 1;
      if (fadeSpan > 0.001 && dist > fadeFrom) alpha = 1 - sstep((dist - fadeFrom) / fadeSpan);

      const w = (LABEL_CHROME_W + LABEL_CHAR_W * text.length) * scale;
      const h = LABEL_H * scale;

      // The chip is anchored by its BOTTOM CENTRE, so its box spans [y - h, y].
      let x = _selX[a];
      const baseY = _selY[a];

      const halfW = w * 0.5;
      const loX = halfW + margin;
      const hiX = width - halfW - margin;
      if (hiX > loX) x = x < loX ? loX : x > hiX ? hiX : x;
      else x = width * 0.5;

      // Start from the offset this chip already carries, then RELAX it back
      // toward zero only as far as it can go without touching anything. Pushing
      // apart is instant — an overlapping number is worse than no number — while
      // settling back down is eased, so nothing pops 26 px when a neighbour clears.
      let offset = slot.id === obj.id ? slot.offset : 0;
      if (offset < -0.5) {
        const relaxed = damp(offset, 0, 0.0005, dt);
        if (!collides(x, baseY + relaxed, w, h, placed)) offset = relaxed;
      }
      let y = baseY + offset;

      for (let pass = 0; pass < LABEL_RESOLVE_PASSES; pass++) {
        let moved = false;
        for (let b = 0; b < placed; b++) {
          if (!hits(x, y, w, h, b)) continue;
          y -= push;                       // this one is further away: it moves up
          moved = true;
        }
        if (!moved) break;
      }

      slot.offset = y - baseY;
      slot.id = obj.id;

      const loY = h + margin;
      const hiY = height - margin;
      if (hiY > loY) y = y < loY ? loY : y > hiY ? hiY : y;

      // Clamping against the top of the viewport can shove a chip back into one
      // it had just cleared. Rather than print two numbers on top of each other,
      // print one: this object keeps its ring and loses its label.
      if (collides(x, y, w, h, placed)) {
        obj.labelled = false;
        continue;
      }
      obj.labelled = true;

      _placedX[placed] = x;
      _placedY[placed] = y;
      _placedW[placed] = w;
      _placedH[placed] = h;

      // ── DOM writes, every one of them cached ─────────────────────────────
      if (!slot.on) {
        slot.el.style.display = 'flex';
        slot.on = true;
      }
      if (slot.state !== outcome) {
        slot.el.className = CLASS_FOR[outcome] || CLASS_FOR.BLOCKED;
        slot.badge.textContent = OUTLINE_BADGES[outcome] || OUTLINE_BADGES.BLOCKED;
        slot.state = outcome;
      }
      if (slot.text !== text) {
        slot.kg.textContent = text;
        slot.text = text;
      }
      if (slot.scale < scale - 0.01 || slot.scale > scale + 0.01) {
        slot.el.style.setProperty('--s', scale.toFixed(3));
        slot.scale = scale;
      }
      if (slot.alpha < alpha - 0.02 || slot.alpha > alpha + 0.02) {
        slot.el.style.opacity = alpha.toFixed(2);
        slot.alpha = alpha;
      }
      const rx = Math.round(x);
      const ry = Math.round(y);
      if (rx !== slot.x || ry !== slot.y) {
        slot.el.style.translate = rx + 'px ' + ry + 'px';
        slot.x = rx;
        slot.y = ry;
      }
      placed++;
    }

    this._hideFrom(placed);
    this._active = placed;
  }

  /** Show or hide the whole layer without disturbing the pool. */
  setVisible(v) {
    const on = !!v;
    if (on === this._visible) return;
    this._visible = on;
    this.layer.style.display = on ? '' : 'none';
    if (!on) this._hideFrom(0);
  }

  /** Clear every label. The next `update` rebuilds from scratch. */
  reset() {
    this._hideFrom(0);
    for (let i = 0; i < LABEL_CAP; i++) {
      const slot = this.slots[i];
      slot.state = '';
      slot.text = '';
      slot.scale = -1;
      slot.alpha = -1;
      slot.x = -99999;
      slot.y = -99999;
      slot.offset = 0;
      slot.id = -1;
    }
    this._active = 0;
  }

  dispose() {
    this._hideFrom(0);
    if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.slots.length = 0;
    releaseStyles();
  }

  _hideFrom(from) {
    for (let i = from; i < LABEL_CAP; i++) {
      const slot = this.slots[i];
      if (!slot || !slot.on) continue;
      slot.el.style.display = 'none';
      slot.on = false;
      slot.id = -1;
      slot.offset = 0;
    }
    if (from === 0) this._active = 0;
  }
}

/* ──────────────────────────────────────────────────────────── internals ── */

/**
 * `1500` -> `1,500 kg`. Written out rather than using `toLocaleString`, whose
 * separator depends on the player's locale — the printed weight has to look the
 * same in every screenshot, and grouping is what makes 15,000 readable at speed.
 */
export function formatKg(weight) {
  if (!isFinite(weight)) return 'BLOCKER';
  let v = Math.round(weight);
  if (v < 0) v = 0;
  const digits = String(v);
  const len = digits.length;
  if (len <= 3) return digits + ' kg';
  let out = '';
  for (let i = 0; i < len; i++) {
    if (i > 0 && (len - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return out + ' kg';
}

/**
 * Does a chip anchored at (x, y) with size (w, h) touch the chip already placed
 * in slot `b`? Chips are anchored by their bottom centre, so the box spans
 * [y - h, y] vertically and is centred on x horizontally.
 */
function hits(x, y, w, h, b) {
  const dx = x - _placedX[b];
  if ((dx < 0 ? -dx : dx) >= (w + _placedW[b]) * 0.5 + LABEL_GAP_X) return false;
  const dy = y - _placedY[b];
  return dy > -(_placedH[b] + LABEL_GAP_Y) && dy < h + LABEL_GAP_Y;
}

/** Same test against every chip placed so far. */
function collides(x, y, w, h, upto) {
  for (let b = 0; b < upto; b++) if (hits(x, y, w, h, b)) return true;
  return false;
}

/**
 * World -> view. The view matrix is affine (bottom row 0,0,0,1), so this is nine
 * multiplies and no divide.
 */
function applyView(m, x, y, z) {
  const e = m.elements;
  _vx = e[0] * x + e[4] * y + e[8] * z + e[12];
  _vy = e[1] * x + e[5] * y + e[9] * z + e[13];
  _vz = e[2] * x + e[6] * y + e[10] * z + e[14];
}

/** View -> clip -> NDC, with the perspective divide. */
function applyProjection(m) {
  const e = m.elements;
  const x = _vx;
  const y = _vy;
  const z = _vz;
  const w = e[3] * x + e[7] * y + e[11] * z + e[15];
  const iw = w === 0 ? 0 : 1 / w;
  _vx = (e[0] * x + e[4] * y + e[8] * z + e[12]) * iw;
  _vy = (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw;
}

function makeSlot(layer) {
  const el = document.createElement('div');
  el.className = CLASS_FOR.BLOCKED;
  el.style.display = 'none';
  const badge = document.createElement('span');
  badge.className = 'tnl-badge';
  badge.textContent = OUTLINE_BADGES.BLOCKED;
  const kg = document.createElement('span');
  kg.className = 'tnl-kg';
  kg.textContent = '';
  el.appendChild(badge);
  el.appendChild(kg);
  layer.appendChild(el);
  return {
    el, badge, kg,
    on: false, state: '', text: '',
    scale: -1, alpha: -1, x: -99999, y: -99999,
    offset: 0, id: -1,
  };
}

const cssHex = (hex) => '#' + (hex >>> 0).toString(16).padStart(6, '0');

/**
 * The stylesheet is generated from `OUTLINE_COLOURS` rather than written by hand,
 * so a chip and its ring are guaranteed to be the same colour forever.
 *
 * Positioning lives in the `translate` property and the static centring lives in
 * `transform` with `transform-origin: 0 0`: writing the screen position into
 * `transform` would make the proximity scale multiply the coordinates and send
 * every label flying off toward the corner.
 */
function ensureStyles() {
  _styleRefs++;
  if (_styleEl) return;
  // The chip's colour is animated by the browser rather than by a per-frame style
  // write, at the same rate the ring lerps, so the two read as one system and the
  // steady-state frame costs nothing.
  const fadeMs = Math.round(1000 / Math.max(0.5, TUNING.read.outlineLerpRate));
  const css = `
.tnl-layer{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;
  pointer-events:none;contain:layout style;z-index:2}
.tnl{position:absolute;left:0;top:0;translate:0px 0px;transform-origin:0 0;
  transform:scale(var(--s,1)) translate(-50%,-100%);
  display:none;align-items:center;gap:5px;height:${LABEL_H}px;padding:0 7px;
  box-sizing:border-box;white-space:nowrap;pointer-events:none;
  font:700 14px/1 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  font-variant-numeric:tabular-nums;letter-spacing:0.01em;
  color:${cssHex(BLOCKER_NEUTRAL)};background:rgba(11,13,16,0.86);
  border:1px solid currentColor;border-radius:3px;
  box-shadow:0 2px 10px rgba(0,0,0,0.55);text-shadow:0 1px 2px rgba(0,0,0,0.95);
  will-change:translate,opacity;
  transition:color ${fadeMs}ms linear,border-color ${fadeMs}ms linear}
.tnl *{pointer-events:none}
.tnl-badge{font-size:12px;line-height:1}
.tnl-kg{color:inherit}
.tnl-clean{color:${cssHex(OUTLINE_COLOURS.CLEAN)}}
.tnl-plow{color:${cssHex(OUTLINE_COLOURS.PLOW)}}
.tnl-blocked{color:${cssHex(OUTLINE_COLOURS.BLOCKED)}}
.tnl-blocker{color:${cssHex(BLOCKER_INK)};border-color:${cssHex(BLOCKER_INK)};
  text-shadow:none;box-shadow:0 2px 10px rgba(0,0,0,0.5);
  background:repeating-linear-gradient(135deg,${cssHex(BLOCKER_NEUTRAL)} 0 7px,#ccd3db 7px 14px)}
@media (prefers-reduced-motion:reduce){.tnl{transition:none}}
`;
  const el = document.createElement('style');
  el.id = 'tnl-styles';
  el.textContent = css;
  document.head.appendChild(el);
  _styleEl = el;
}

function releaseStyles() {
  _styleRefs--;
  if (_styleRefs > 0 || !_styleEl) return;
  if (_styleEl.parentNode) _styleEl.parentNode.removeChild(_styleEl);
  _styleEl = null;
  _styleRefs = 0;
}
