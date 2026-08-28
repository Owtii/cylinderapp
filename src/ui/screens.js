/**
 * TONNAGE — full-screen states: title, loader, pause, run end.
 *
 * The look is an industrial weigh station: steel plate, stencilled condensed
 * type, hairline rules, hard shadows, no rounded corners and no glass. One
 * accent, a cold bone-white — green, amber and red are the outline system's
 * and appear here only in the READ legend on the title screen, which is the
 * outline system explaining itself.
 *
 * The run-end screen has one job: make the next attempt obvious.
 *   • lost at the house — the gap (`84,300 / 100,000 KG`) is the biggest thing
 *     on the screen, because it is the reason to press R;
 *   • won — the medal, and immediately under it the next medal's threshold and
 *     how much more weight it costs, so there is always a next goal;
 *   • always — the weight left on the ramp, and an unmissable [R] RESTART.
 *
 * Settings live in a module-level object, in memory only, by design.
 */

import { TUNING } from '../tuning.js';
import { clamp01 } from '../core/math.js';

/* Pre-built transforms for the bars: the loader ticks often during init. */
const BAR_STEPS = 200;
const BAR_X = new Array(BAR_STEPS + 1);
for (let i = 0; i <= BAR_STEPS; i++) BAR_X[i] = 'scaleX(' + (i / BAR_STEPS) + ')';

const VOL_KINDS = ['master', 'sfx', 'music'];
const VOL_LABELS = ['MASTER', 'EFFECTS', 'MUSIC'];

const MEDAL_ORDER = ['bronze', 'silver', 'gold'];
const MEDAL_NAMES = { bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD' };

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

/** Grouped integer. Screens are never on a per-frame path. */
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

function fmtTime(sec) {
  let s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  s -= m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/** Steel rule with a machined stripe — the divider used across every sheet. */
function rule(parent) {
  return mk('div', 'rule', parent);
}

export class Screens {
  /**
   * @param {HTMLElement} root the `#screens` element
   * @param {object} cb {onStart,onRestart,onResume,onQuit,onVolume,onQuality}
   */
  constructor(root, cb) {
    this.loaded = false;
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

    const brand = mk('div', 'brand', sheet);
    const mark = mk('div', 'mark', brand);
    mk('span', 'mark-n', mark, '500');
    mk('span', 'mark-t', mark, 'KG');
    const bt = mk('div', 'brand-text', brand);
    mk('h1', 'wordmark', bt, 'TONNAGE');
    mk('p', 'tagline', bt, 'ROLL DOWNHILL · EAT EVERYTHING · BREAK THE HOUSE');

    rule(sheet);

    /* The read, which is the whole game. This is the one place in the UI where
       the outline hues are allowed, because this IS the outline legend — and
       every row still carries its shape badge so it reads without colour. */
    const legend = mk('div', 'legend', sheet);
    this._legend(legend, 'clean', '●', 'LIGHTER THAN YOU', 'SMASH IT · ABSORB ITS WEIGHT');
    this._legend(legend, 'plow', '▲', 'CLOSE TO YOUR WEIGHT', 'PLOW THROUGH · LOSE SPEED');
    this._legend(legend, 'blocked', '✕', 'HEAVIER THAN YOU', 'BOUNCE · −10 % · ONE STRIKE');
    this._legend(legend, 'blocker', '▮', 'CONCRETE BLOCKER', 'NEVER BREAKS · GO AROUND IT');

    const goal = mk('div', 'goalstrip', sheet);
    const g1 = mk('div', 'goal', goal);
    mk('span', 'goal-k', g1, 'THE HOUSE');
    mk('span', 'goal-v', g1, fmt(TUNING.finale.houseWeight));
    mk('span', 'goal-u', g1, 'KG');
    const g2 = mk('div', 'goal', goal);
    mk('span', 'goal-k', g2, 'ON THE TRACK');
    mk('span', 'goal-v', g2, fmt(TUNING.weights.trackTotal));
    mk('span', 'goal-u', g2, 'KG');
    const g3 = mk('div', 'goal', goal);
    mk('span', 'goal-k', g3, 'STRIKES');
    mk('span', 'goal-v', g3, '' + TUNING.collision.maxStrikes);
    mk('span', 'goal-u', g3, 'MAX');

    // Touch devices are told to tap, not to click. The keyboard legend below is
    // hidden for them by the same media query.
    const coarse = window.matchMedia('(any-pointer: coarse)').matches
      && !window.matchMedia('(any-pointer: fine)').matches;
    const btn = mkButton('plate-btn start-btn', sheet);
    this.btnStart = btn;
    mk('span', 'btn-main', btn, coarse ? 'TAP TO START' : 'CLICK TO START');
    mk('span', 'btn-sub', btn, 'AUDIO ARMS ON LAUNCH');

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

    this._onStartClick = this._onStartClick.bind(this);
    s.addEventListener('click', this._onStartClick);
  }

  _legend(parent, kind, badge, title, sub) {
    const row = mk('div', 'legend-row ' + kind, parent);
    mk('span', 'legend-badge', row, badge);
    const t = mk('div', 'legend-text', row);
    mk('span', 'legend-title', t, title);
    mk('span', 'legend-sub', t, sub);
    return row;
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
    mk('div', 'load-title', sheet, 'PREPARING LOAD');
    this.elLoadLabel = mk('div', 'load-label', sheet, 'BUILDING SOUND');
    const track = mk('div', 'bar bar-big', sheet);
    this.elLoadBar = mk('i', 'bar-fill', track);
    this.elLoadPct = mk('div', 'load-pct', sheet, '0%');
  }

  _buildPause() {
    const s = this._screen('pause');
    this.elPause = s;
    const sheet = mk('div', 'sheet sheet-narrow', s);
    mk('h2', 'screen-title', sheet, 'PAUSED');
    rule(sheet);

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
  }

  _buildEnd() {
    const s = this._screen('end');
    this.elEnd = s;
    const sheet = mk('div', 'sheet sheet-end', s);

    const head = mk('div', 'end-head', sheet);
    this.elVerdict = mk('h2', 'verdict', head, 'THE HOUSE HELD');
    this.elVerdictSub = mk('div', 'verdict-sub', head, '');
    this.elBest = mk('span', 'best-badge', head, 'NEW BEST');
    this.elBest.hidden = true;

    /* ── the hook: the gap, or the medal ───────────────────────────────────── */
    const hero = mk('div', 'hero', sheet);

    this.elGap = mk('div', 'gap', hero);
    const gapNum = mk('div', 'gap-num', this.elGap);
    this.elGapA = mk('span', 'gap-a', gapNum, '0');
    mk('span', 'gap-slash', gapNum, '/');
    this.elGapB = mk('span', 'gap-b', gapNum, '0');
    mk('span', 'gap-u', gapNum, 'KG');
    const gapBar = mk('div', 'gap-bar', this.elGap);
    this.elGapFill = mk('i', 'gap-fill', gapBar);
    this.elGapNote = mk('div', 'gap-note', this.elGap, '');

    this.elWin = mk('div', 'win', hero);
    this.elWin.hidden = true;
    const medalBox = mk('div', 'medal-box', this.elWin);
    this.elMedal = mk('div', 'medal', medalBox);
    this.elMedalMark = mk('span', 'medal-mark', this.elMedal, 'B');
    const medalText = mk('div', 'medal-text', medalBox);
    this.elMedalName = mk('div', 'medal-name', medalText, 'BRONZE');
    this.elMedalWeight = mk('div', 'medal-weight', medalText, '0 KG');
    this.elNext = mk('div', 'next', this.elWin, '');

    /* ── the second number: what was left behind ───────────────────────────── */
    this.elMissed = mk('div', 'missed', sheet);
    mk('span', 'missed-k', this.elMissed, 'LEFT ON THE RAMP');
    this.elMissedV = mk('span', 'missed-v', this.elMissed, '0');
    mk('span', 'missed-u', this.elMissed, 'KG');
    this.elMissedN = mk('span', 'missed-n', this.elMissed, '');

    const table = mk('div', 'ticket', sheet);
    this.statEls = {};
    this.statEls.smashed = this._stat(table, 'OBJECTS SMASHED', '');
    this.statEls.bestChain = this._stat(table, 'BEST CHAIN', '×');
    this.statEls.zones = this._stat(table, 'ZONES CLEARED', '');
    this.statEls.time = this._stat(table, 'RUN TIME', '');
    this.statEls.best = this._stat(table, 'BEST RUN', 'KG');

    const actions = mk('div', 'actions', sheet);
    this.btnRestart = mkButton('plate-btn restart-btn', actions);
    mk('span', 'btn-key', this.btnRestart, 'R');
    mk('span', 'btn-main', this.btnRestart, 'RESTART');
    mk('span', 'btn-sub', this.btnRestart, 'PRESS [R] — INSTANT');
    this.btnEndQuit = mkButton('ghost-btn', actions, 'QUIT TO TITLE');
    this.btnRestart.addEventListener('click', () => { this._blur(); this._fire('onRestart'); });
    this.btnEndQuit.addEventListener('click', () => { this._blur(); this._fire('onQuit'); });
  }

  _stat(parent, label, unit) {
    const row = mk('div', 'ticket-row', parent);
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

  /* Only the title screen takes keys here. [R] belongs to `input.js`, which
     already owns it for both the run and the run-end screen; binding it twice
     would restart twice on one press. */
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
    // Coming back from a run everything is already built — rewinding the strip
    // to 0 % / STANDBY would make a loaded game look like it lost its assets.
    if (this.loaded) this.setLoadProgress(1, 'READY');
    else this.setLoadProgress(0, 'STANDBY');
    this._show('start');
    this._focus(this.btnStart);
  }

  /** Called once the game has finished building everything it loads up front. */
  markLoaded() {
    this.loaded = true;
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

  /**
   * @param {object} stats {outcome:'win'|'house'|'strikes'|'fell', weight, target,
   *   medal, smashed, missedWeight, missedCount, bestChain, zonesCleared, time,
   *   best:{weight,medal}}
   */
  showRunEnd(stats) {
    const s = stats || {};
    const target = Number(s.target) > 0 ? Number(s.target) : TUNING.finale.houseWeight;
    const weight = Math.max(0, Number(s.weight) || 0);
    const outcome = s.outcome === 'win' || s.outcome === 'strikes' || s.outcome === 'fell'
      ? s.outcome : 'house';
    const medal = MEDAL_NAMES[s.medal] ? s.medal : null;
    const won = outcome === 'win';

    if (won) {
      this.elVerdict.textContent = 'HOUSE DEMOLISHED';
      this.elVerdictSub.textContent = fmt(weight) + ' KG THROUGH THE FRONT WALL';
    } else if (outcome === 'strikes') {
      this.elVerdict.textContent = 'THREE STRIKES';
      this.elVerdictSub.textContent = 'BLOCKED ONCE TOO OFTEN — THE RUN ENDED EARLY';
    } else if (outcome === 'fell') {
      this.elVerdict.textContent = 'OFF THE RAMP';
      this.elVerdictSub.textContent = 'YOU LEFT THE ROAD BEFORE THE HOUSE';
    } else {
      this.elVerdict.textContent = 'THE HOUSE HELD';
      this.elVerdictSub.textContent = 'YOU ARRIVED TOO LIGHT';
    }

    /* ── hero ──────────────────────────────────────────────────────────────── */
    this.elGap.hidden = won;
    this.elWin.hidden = !won;

    if (won) {
      const key = medal || 'bronze';
      this.elMedal.className = 'medal ' + key;
      this.elMedalMark.textContent = MEDAL_NAMES[key].charAt(0);
      this.elMedalName.textContent = MEDAL_NAMES[key];
      this.elMedalWeight.textContent = fmt(weight) + ' KG · HOUSE ' + fmt(target) + ' KG';

      // There is always a next goal: the next medal, or the whole track.
      const idx = MEDAL_ORDER.indexOf(key);
      let nextName = '';
      let nextAt = 0;
      if (idx >= 0 && idx < MEDAL_ORDER.length - 1) {
        nextName = MEDAL_NAMES[MEDAL_ORDER[idx + 1]];
        nextAt = Math.round(target * TUNING.medals[MEDAL_ORDER[idx + 1]]);
      } else {
        nextName = 'PERFECT RUN';
        nextAt = Math.round(TUNING.player.startWeight + TUNING.weights.trackTotal);
      }
      const more = Math.max(0, nextAt - weight);
      this.elNext.textContent = more > 0
        ? 'NEXT — ' + nextName + ' AT ' + fmt(nextAt) + ' KG · ' + fmt(more) + ' KG MORE'
        : 'NEXT — ' + nextName + ' AT ' + fmt(nextAt) + ' KG · CLEARED';
    } else {
      this.elGapA.textContent = fmt(weight);
      this.elGapB.textContent = fmt(target);
      const short = Math.max(0, Math.round(target - weight));
      this.elGapNote.textContent = short > 0
        ? fmt(short) + ' KG SHORT'
        : 'HEAVY ENOUGH — YOU NEVER REACHED THE HOUSE';
      const t = target > 0 ? clamp01(weight / target) : 0;
      let step = (t * BAR_STEPS + 0.5) | 0;
      if (step < 0) step = 0;
      else if (step > BAR_STEPS) step = BAR_STEPS;
      this.elGapFill.style.transform = BAR_X[step];
    }

    /* ── what was left behind ──────────────────────────────────────────────── */
    const missedW = Math.max(0, Math.round(Number(s.missedWeight) || 0));
    const missedN = Math.max(0, Math.round(Number(s.missedCount) || 0));
    this.elMissedV.textContent = fmt(missedW);
    this.elMissedN.textContent = missedN > 0
      ? '· ' + fmt(missedN) + (missedN === 1 ? ' OBJECT' : ' OBJECTS')
      : '';

    /* ── ticket ────────────────────────────────────────────────────────────── */
    const zonesTotal = TUNING.weights.zones.length;
    this.statEls.smashed.textContent = fmt(s.smashed);
    this.statEls.bestChain.textContent = fmt(s.bestChain);
    this.statEls.zones.textContent = fmt(s.zonesCleared) + ' / ' + zonesTotal;
    this.statEls.time.textContent = fmtTime(s.time);

    const best = s.best || null;
    const bestW = best ? Math.max(0, Number(best.weight) || 0) : 0;
    const bestMedal = best && MEDAL_NAMES[best.medal] ? MEDAL_NAMES[best.medal] : '';
    this.statEls.best.textContent = bestMedal
      ? fmt(Math.max(bestW, weight)) + ' · ' + bestMedal
      : fmt(Math.max(bestW, weight));
    this.elBest.hidden = !(weight > 0 && weight >= bestW);

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
