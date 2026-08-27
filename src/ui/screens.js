/**
 * TONNAGE — full-screen states: title gate, loader, pause, run end.
 *
 * Everything here is weigh-station signage: hazard tape, stencil plates, steel
 * panels, one hot accent. Numbers are the hero.
 *
 * Settings live in a module-level object — in memory only, no localStorage, by
 * design. `getSettings()` is what the game reads on boot.
 */

import { TUNING } from '../tuning.js';
import { clamp01 } from '../core/math.js';

/* Pre-built transforms for the load bar: it ticks often during init. */
const BAR_STEPS = 200;
const BAR_X = new Array(BAR_STEPS + 1);
for (let i = 0; i <= BAR_STEPS; i++) BAR_X[i] = 'scaleX(' + (i / BAR_STEPS) + ')';

const VOL_KINDS = ['master', 'sfx', 'music'];
const VOL_LABELS = ['MASTER', 'EFFECTS', 'MUSIC'];

/** In-memory settings. Deliberately not persisted. */
const SETTINGS = { master: 0.9, sfx: 1, music: 0.85, quality: 'high' };
let _settingsReady = false;

function initSettings() {
  if (_settingsReady) return;
  _settingsReady = true;
  const U = TUNING.ui;
  const d = U.volumeDefaults;
  SETTINGS.master = clamp01(d[0]);
  SETTINGS.sfx = clamp01(d[1]);
  SETTINGS.music = clamp01(d[2]);
  SETTINGS.quality = U.defaultQuality === 'low' ? 'low' : 'high';

  // A phone should not boot into 2x pixel ratio and shadow maps.
  if (U.lowQualityOnCoarsePointer && typeof window !== 'undefined' && window.matchMedia) {
    try {
      const coarse = window.matchMedia('(any-pointer: coarse)').matches;
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8;
      if (coarse && cores <= 8) SETTINGS.quality = 'low';
    } catch (err) { /* matchMedia is optional */ }
  }
}

function mk(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function mkButton(cls, parent, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.setAttribute('data-ui', '1');
  if (label !== undefined) b.textContent = label;
  if (parent) parent.appendChild(b);
  return b;
}

/** Hazard-tape rule used as a divider across the sheets. */
function tape(parent) {
  return mk('div', 'tape', parent);
}

export class Screens {
  /**
   * @param {HTMLElement} root the `#screens` element
   * @param {object} cb {onStart,onRestart,onResume,onQuit,onVolume,onQuality}
   */
  constructor(root, cb) {
    initSettings();

    this.root = root;
    this.cb = cb || {};
    this.current = null;
    this.starting = false;
    this._settingsOut = { master: 0, sfx: 0, music: 0, quality: 'high' };
    this._barStep = -1;
    this._loadPct = -1;

    root.className = 'screens';
    while (root.firstChild) root.removeChild(root.firstChild);
    root.style.setProperty('--start-pulse', TUNING.ui.startPulseTime + 's');
    root.style.setProperty('--restart-pulse', TUNING.ui.restartPulseTime + 's');

    this.volInputs = new Array(3);
    this.volReadouts = new Array(3);

    this._buildStart();
    this._buildLoading();
    this._buildPause();
    this._buildEnd();

    this._syncControls();
    this.hideAll();

    this._onKeyDown = this._onKeyDown.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
  }

  /* ── construction ───────────────────────────────────────────────────────── */

  _screen(name) {
    const s = mk('div', 'screen screen-' + name, this.root);
    s.setAttribute('data-ui', '1');
    s.hidden = true;
    return s;
  }

  _buildStart() {
    const s = this._screen('start');
    this.elStart = s;

    const sheet = mk('div', 'sheet', s);
    tape(sheet);

    const brand = mk('div', 'brand', sheet);
    const mark = mk('div', 'mark', brand);
    mk('span', 'mark-n', mark, '5');
    mk('span', 'mark-t', mark, 'T');
    const bt = mk('div', 'brand-text', brand);
    mk('h1', 'wordmark', bt, 'TONNAGE');
    mk('p', 'tagline', bt, 'FIVE TONS OF STEEL · ONE HILL · EVERYTHING IN THE WAY');

    const btn = mkButton('plate-btn start-btn', sheet);
    this.btnStart = btn;
    mk('span', 'btn-main', btn, 'CLICK TO START');
    mk('span', 'btn-sub', btn, 'CLICK ANYWHERE — AUDIO ARMS ON LAUNCH');

    const strip = mk('div', 'loadstrip', sheet);
    this.elStartBarTrack = mk('div', 'bar', strip);
    this.elStartBar = mk('i', 'bar-fill', this.elStartBarTrack);
    this.elStartBarLabel = mk('span', 'bar-label', strip, 'STANDBY');

    const grid = mk('div', 'controls', sheet);
    this._ctrl(grid, 'STEER', 'A', 'D');
    this._ctrl(grid, 'TUCK', 'SPACE');
    this._ctrl(grid, 'RESTART', 'R');
    this._ctrl(grid, 'PAUSE', 'ESC');
    mk('div', 'touch-hint', sheet, 'TOUCH — DRAG TO STEER · TAP TO TUCK');

    tape(sheet);

    this._onStartClick = this._onStartClick.bind(this);
    s.addEventListener('click', this._onStartClick);
  }

  _ctrl(parent, label, k1, k2) {
    const c = mk('div', 'ctrl', parent);
    const keys = mk('div', 'keys', c);
    mk('span', k1.length > 2 ? 'keycap wide' : 'keycap', keys, k1);
    if (k2 !== undefined) mk('span', k2.length > 2 ? 'keycap wide' : 'keycap', keys, k2);
    mk('span', 'ctrl-label', c, label);
    return c;
  }

  _buildLoading() {
    const s = this._screen('loading');
    this.elLoading = s;
    const sheet = mk('div', 'sheet sheet-narrow', s);
    tape(sheet);
    mk('div', 'load-title', sheet, 'PREPARING LOAD');
    this.elLoadLabel = mk('div', 'load-label', sheet, 'BUILDING SOUND');
    const track = mk('div', 'bar bar-big', sheet);
    this.elLoadBar = mk('i', 'bar-fill', track);
    this.elLoadPct = mk('div', 'load-pct', sheet, '0%');
    tape(sheet);
  }

  _buildPause() {
    const s = this._screen('pause');
    this.elPause = s;
    const sheet = mk('div', 'sheet sheet-narrow', s);
    tape(sheet);
    mk('h2', 'screen-title', sheet, 'PAUSED');

    const box = mk('div', 'settings', sheet);
    mk('div', 'settings-head', box, 'AUDIO LEVELS');
    for (let i = 0; i < VOL_KINDS.length; i++) {
      const row = mk('div', 'row', box);
      mk('label', 'row-label', row, VOL_LABELS[i]);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.className = 'slider';
      input.setAttribute('data-ui', '1');
      input.setAttribute('aria-label', VOL_LABELS[i] + ' volume');
      row.appendChild(input);
      const out = mk('span', 'row-value', row, '100%');
      this.volInputs[i] = input;
      this.volReadouts[i] = out;
      input.addEventListener('input', this._makeVolumeHandler(i));
    }

    mk('div', 'settings-head', box, 'GRAPHICS');
    const qrow = mk('div', 'row', box);
    mk('label', 'row-label', qrow, 'QUALITY');
    const seg = mk('div', 'seg', qrow);
    this.btnLow = mkButton('seg-btn', seg, 'LOW');
    this.btnHigh = mkButton('seg-btn', seg, 'HIGH');
    this.btnLow.addEventListener('click', () => this._setQuality('low', true));
    this.btnHigh.addEventListener('click', () => this._setQuality('high', true));

    const actions = mk('div', 'actions', sheet);
    this.btnResume = mkButton('plate-btn', actions);
    mk('span', 'btn-main', this.btnResume, 'RESUME');
    mk('span', 'btn-sub', this.btnResume, '[ESC]');
    this.btnQuit = mkButton('ghost-btn', actions, 'QUIT TO TITLE');
    this.btnResume.addEventListener('click', () => { this._blur(); this._fire('onResume'); });
    this.btnQuit.addEventListener('click', () => { this._blur(); this._fire('onQuit'); });
    tape(sheet);
  }

  _buildEnd() {
    const s = this._screen('end');
    this.elEnd = s;
    const sheet = mk('div', 'sheet', s);
    tape(sheet);

    const head = mk('div', 'end-head', sheet);
    this.elVerdict = mk('h2', 'verdict', head, 'OFF THE EDGE');
    this.elBest = mk('span', 'best-badge', head, 'NEW BEST');
    this.elBest.hidden = true;

    const table = mk('div', 'ticket', sheet);
    this.statEls = {};
    this.statEls.distance = this._stat(table, 'DISTANCE', 'M');
    this.statEls.peakMass = this._stat(table, 'PEAK MASS', 'KG');
    this.statEls.destroyed = this._stat(table, 'DESTROYED', 'ITEMS');
    this.statEls.bestCombo = this._stat(table, 'BEST CHAIN', '×');
    this.statEls.score = this._stat(table, 'SCORE', 'PTS', true);
    this.statEls.best = this._stat(table, 'PERSONAL BEST', 'PTS');

    const actions = mk('div', 'actions', sheet);
    this.btnRestart = mkButton('plate-btn restart-btn', actions);
    mk('span', 'btn-key', this.btnRestart, 'R');
    mk('span', 'btn-main', this.btnRestart, 'RESTART');
    mk('span', 'btn-sub', this.btnRestart, 'PRESS [R] — INSTANT');
    this.btnEndQuit = mkButton('ghost-btn', actions, 'QUIT TO TITLE');
    this.btnRestart.addEventListener('click', () => { this._blur(); this._fire('onRestart'); });
    this.btnEndQuit.addEventListener('click', () => { this._blur(); this._fire('onQuit'); });

    tape(sheet);
  }

  _stat(parent, label, unit, hero) {
    const row = mk('div', hero ? 'ticket-row hero' : 'ticket-row', parent);
    mk('span', 'ticket-label', row, label);
    const v = mk('span', 'ticket-value', row, '0');
    mk('span', 'ticket-unit', row, unit);
    return v;
  }

  /* ── behaviour ──────────────────────────────────────────────────────────── */

  _makeVolumeHandler(i) {
    const kind = VOL_KINDS[i];
    const input = this.volInputs[i];
    const out = this.volReadouts[i];
    return () => {
      const raw = Number(input.value);
      const v = clamp01((isFinite(raw) ? raw : 0) / 100);
      SETTINGS[kind] = v;
      out.textContent = Math.round(v * 100) + '%';
      this._fire('onVolume', kind, v);
    };
  }

  _setQuality(q, fire) {
    const v = q === 'low' ? 'low' : 'high';
    SETTINGS.quality = v;
    this.btnLow.className = v === 'low' ? 'seg-btn on' : 'seg-btn';
    this.btnHigh.className = v === 'high' ? 'seg-btn on' : 'seg-btn';
    this.btnLow.setAttribute('aria-pressed', v === 'low' ? 'true' : 'false');
    this.btnHigh.setAttribute('aria-pressed', v === 'high' ? 'true' : 'false');
    if (fire) { this._blur(); this._fire('onQuality', v); }
  }

  _syncControls() {
    for (let i = 0; i < VOL_KINDS.length; i++) {
      const v = clamp01(SETTINGS[VOL_KINDS[i]]);
      const pct = Math.round(v * 100);
      this.volInputs[i].value = '' + pct;
      this.volReadouts[i].textContent = pct + '%';
    }
    this._setQuality(SETTINGS.quality, false);
  }

  _fire(name, a, b) {
    const fn = this.cb[name];
    if (typeof fn === 'function') fn(a, b);
  }

  _blur() {
    const a = document.activeElement;
    if (a && a.blur && this.root.contains(a)) a.blur();
  }

  _onStartClick() {
    if (this.current !== 'start' || this.starting) return;
    this.starting = true;
    this._blur();
    this._fire('onStart');
  }

  _onKeyDown(e) {
    if (this.current !== 'start' || this.starting) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      // The start button may also be focused; `starting` keeps it to one call.
      this._onStartClick();
    }
  }

  _show(name) {
    this.current = name;
    this.elStart.hidden = name !== 'start';
    this.elLoading.hidden = name !== 'loading';
    this.elPause.hidden = name !== 'pause';
    this.elEnd.hidden = name !== 'end';
    this.root.className = name ? 'screens open' : 'screens';
  }

  /* ── public API ─────────────────────────────────────────────────────────── */

  showStart() {
    this.starting = false;
    this.setLoadProgress(0, 'STANDBY');
    this._show('start');
    this._focus(this.btnStart);
  }

  showLoading() {
    this.setLoadProgress(0, 'BUILDING SOUND');
    this._show('loading');
    this._blur();
  }

  /** 0..1 with an optional status label. Cheap enough to spam from init. */
  setLoadProgress(t01, label) {
    const t = clamp01(t01);
    let step = (t * BAR_STEPS + 0.5) | 0;
    if (step < 0) step = 0;
    else if (step > BAR_STEPS) step = BAR_STEPS;
    if (step !== this._barStep) {
      this._barStep = step;
      const tr = BAR_X[step];
      this.elLoadBar.style.transform = tr;
      this.elStartBar.style.transform = tr;
    }
    const pct = Math.round(t * 100);
    if (pct !== this._loadPct) {
      this._loadPct = pct;
      this.elLoadPct.textContent = pct + '%';
    }
    if (label !== undefined && label !== null) {
      this.elLoadLabel.textContent = label;
      this.elStartBarLabel.textContent = label;
    }
  }

  showPause() {
    this._syncControls();
    this._show('pause');
    this._focus(this.btnResume);
  }

  showRunEnd(stats) {
    const s = stats || {};
    this.elVerdict.textContent = s.reason === 'quit' ? 'RUN ENDED' : 'OFF THE EDGE';
    this.statEls.distance.textContent = fmt(s.distance);
    this.statEls.peakMass.textContent = fmt(s.peakMass);
    this.statEls.destroyed.textContent = fmt(s.destroyed);
    this.statEls.bestCombo.textContent = fmt(s.bestCombo);
    this.statEls.score.textContent = fmt(s.score);
    this.statEls.best.textContent = fmt(s.best);
    const isBest = (s.score || 0) > 0 && (s.score || 0) >= (s.best || 0);
    this.elBest.hidden = !isBest;
    this._show('end');
    this._focus(this.btnRestart);
  }

  hideAll() {
    this.starting = false;
    this._blur();
    this._show(null);
  }

  get visible() {
    return this.current !== null;
  }

  /** Settings the game applies on boot and after every change. */
  getSettings() {
    const out = this._settingsOut;
    out.master = SETTINGS.master;
    out.sfx = SETTINGS.sfx;
    out.music = SETTINGS.music;
    out.quality = SETTINGS.quality;
    return out;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this.elStart.removeEventListener('click', this._onStartClick);
  }

  _focus(el) {
    if (!el || !el.focus) return;
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
  }
}

/** Grouped integer for the run-end ticket. Never called per frame. */
function fmt(v) {
  let n = Math.round(Number(v) || 0);
  if (n < 0) n = 0;
  if (n < 1000) return '' + n;
  let out = '';
  while (n >= 1000) {
    const r = n % 1000;
    n = (n - r) / 1000;
    out = ',' + (r < 10 ? '00' : r < 100 ? '0' : '') + r + out;
  }
  return n + out;
}
