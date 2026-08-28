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
 *   • always — the medal ladder (§16.2), the weight left on the ramp, and an
 *     unmissable [R] RESTART.
 *
 * The ladder is the v3 change that turns "did I win" into "how well did I win":
 * all three thresholds, always, whether the run won or not, with the one you are
 * reaching for lit and the ones behind you receding. State is carried by a badge
 * — ✓ earned, » next, · locked — and by a luminance ladder, so the whole sheet
 * reads with the saturation at zero (§14).
 *
 * Settings live in a module-level object, in memory only, by design. The one
 * exception is where a setting drives hardware: the haptics toggle is pushed
 * into `game/hud.js`, which owns the vibrator, so the integrator cannot forget
 * to wire it.
 */

import { TUNING } from '../tuning.js';
import { clamp01 } from '../core/math.js';
import { setHapticsEnabled, hapticsSupported } from '../game/hud.js';

/* Pre-built transforms for the bars: the loader ticks often during init. */
const BAR_STEPS = 200;
const BAR_X = new Array(BAR_STEPS + 1);
for (let i = 0; i <= BAR_STEPS; i++) BAR_X[i] = 'scaleX(' + (i / BAR_STEPS) + ')';

const VOL_KINDS = ['master', 'sfx', 'music'];
const VOL_LABELS = ['MASTER', 'EFFECTS', 'MUSIC'];

const MEDAL_ORDER = ['bronze', 'silver', 'gold'];
const MEDAL_NAMES = { bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD' };

/* Ladder state badges. Shape, not hue: this is the greyscale read. */
const RUNG_EARNED = '✓';
const RUNG_NEXT = '»';
const RUNG_LOCKED = '·';

const CLS_RUNG_GOT = 'rung got';
const CLS_RUNG_NEXT = 'rung next';
const CLS_RUNG_LOCKED = 'rung locked';

const MODE_NORMAL = 'normal';
const MODE_DAILY = 'daily';
const MODE_ENDLESS = 'endless';
const MODES = [MODE_NORMAL, MODE_DAILY, MODE_ENDLESS];
const MODE_LABELS = ['RUN', 'DAILY', 'ENDLESS'];

const TXT_SHARE = 'COPY RESULT';
const TXT_SHARED = 'COPIED';
const TXT_SHARE_FAIL = 'SELECT THE LINE TO COPY';

/** In-memory settings. Deliberately not persisted. */
const SETTINGS = { master: 0.9, sfx: 1, music: 0.85, quality: 'high', haptics: true };
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
  SETTINGS.haptics = U.hapticsDefault !== false;
  setHapticsEnabled(SETTINGS.haptics);

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

/**
 * Copy one short line, three ways, and report which one worked.
 *
 * The async clipboard is missing outside a secure context, rejects when the
 * document is not focused, and throws outright inside some embedded webviews;
 * `execCommand('copy')` is deprecated but still the only thing that works in
 * several of those cases. If both fail the caller prints the line and lets the
 * player select it, which is why this never throws and never blocks.
 */
function copyText(text, done) {
  let nav = null;
  try { nav = typeof navigator !== 'undefined' ? navigator : null; } catch (err) { nav = null; }

  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    let p = null;
    try { p = nav.clipboard.writeText(text); } catch (err) { p = null; }
    if (p && typeof p.then === 'function') {
      p.then(() => done(true), () => done(copyFallback(text)));
      return;
    }
    if (p !== null) { done(true); return; }     // a shim that returns nothing but did not throw
  }
  done(copyFallback(text));
}

function copyFallback(text) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  let ta = null;
  try {
    ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Off-screen rather than display:none — a hidden node cannot be selected.
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    return !!ok;
  } catch (err) {
    return false;
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
  }
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
    this._settingsOut = { master: 0, sfx: 0, music: 0, quality: 'high', haptics: true };
    this._barStep = -1;
    this._loadPct = -1;

    this.mode = MODE_NORMAL;
    this.endlessUnlocked = false;
    this.dailyNumber = 0;
    this.shareText = '';
    this._shareTimer = 0;

    root.className = 'screens';
    while (root.firstChild) root.removeChild(root.firstChild);
    root.style.setProperty('--start-pulse', TUNING.ui.startPulseTime + 's');
    root.style.setProperty('--restart-pulse', TUNING.ui.restartPulseTime + 's');

    this.volInputs = new Array(3);
    this.volReadouts = new Array(3);
    this.modeBtns = new Array(MODES.length);

    this._buildStart();
    this._buildLoading();
    this._buildPause();
    this._buildEnd();

    this._syncControls();
    this._syncModes();
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

    /* Mode (§16.10, §16.11). Three chips, not three screens — the run starts the
       same way whichever one is lit, and ENDLESS stays visibly locked until the
       house has been broken once, so it reads as a reward rather than a gap. */
    const modes = mk('div', 'modestrip', sheet);
    mk('span', 'modestrip-k', modes, 'MODE');
    const seg = mk('div', 'seg mode-seg', modes);
    for (let i = 0; i < MODES.length; i++) {
      const b = mkButton('seg-btn', seg, MODE_LABELS[i]);
      b.setAttribute('data-mode', MODES[i]);
      b.addEventListener('click', this._makeModeHandler(MODES[i]));
      this.modeBtns[i] = b;
    }
    this.elModeNote = mk('div', 'modestrip-note', sheet, '');

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
    const qseg = mk('div', 'seg', qrow);
    this.btnLow = mkButton('seg-btn', qseg, 'LOW');
    this.btnHigh = mkButton('seg-btn', qseg, 'HIGH');
    this.btnLow.addEventListener('click', () => this._setQuality('low', true));
    this.btnHigh.addEventListener('click', () => this._setQuality('high', true));

    /* Haptics (§16.12). The row is built either way so the layout does not move
       between devices, and hidden where there is no vibrator to talk to. */
    this.elHapticHead = mk('div', 'settings-head', box, 'FEEL');
    this.elHapticRow = mk('div', 'row', box);
    mk('label', 'row-label', this.elHapticRow, 'HAPTICS');
    const hseg = mk('div', 'seg', this.elHapticRow);
    this.btnHapticOff = mkButton('seg-btn', hseg, 'OFF');
    this.btnHapticOn = mkButton('seg-btn', hseg, 'ON');
    this.btnHapticOff.addEventListener('click', () => this._setHaptics(false, true));
    this.btnHapticOn.addEventListener('click', () => this._setHaptics(true, true));
    const canBuzz = hapticsSupported();
    this.elHapticRow.hidden = !canBuzz;
    this.elHapticHead.hidden = !canBuzz;

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

    /* ── the ladder: all three thresholds, win or lose (§16.2) ─────────────── */
    const ladder = mk('div', 'ladder', sheet);
    const lhead = mk('div', 'ladder-head', ladder);
    mk('span', 'ladder-k', lhead, 'MEDALS');
    this.elLadderHouse = mk('span', 'ladder-house', lhead, '');
    this.rungEls = new Array(MEDAL_ORDER.length);
    for (let i = 0; i < MEDAL_ORDER.length; i++) {
      const row = mk('div', CLS_RUNG_LOCKED, ladder);
      const badge = mk('span', 'rung-badge', row, RUNG_LOCKED);
      const name = mk('span', 'rung-name', row, MEDAL_NAMES[MEDAL_ORDER[i]]);
      const mult = mk('span', 'rung-mult', row, '');
      const at = mk('span', 'rung-at', row, '0');
      mk('span', 'rung-u', row, 'KG');
      const need = mk('span', 'rung-need', row, '');
      this.rungEls[i] = { row, badge, name, mult, at, need, cls: CLS_RUNG_LOCKED };
    }

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

    /* ── the share line (§16.10) ───────────────────────────────────────────
       Printed as well as copied. The clipboard is unavailable in more places
       than it is available — insecure contexts, embedded webviews, an unfocused
       document — so the line is always on screen and always selectable, and the
       button is a convenience over the top of that rather than the only way in. */
    const share = mk('div', 'share', sheet);
    this.elShareLine = mk('div', 'share-line', share, '');
    this.btnShare = mkButton('ghost-btn share-btn', share, TXT_SHARE);
    this.btnShare.addEventListener('click', () => this._onShare());

    const actions = mk('div', 'actions', sheet);
    this.btnRestart = mkButton('plate-btn restart-btn', actions);
    mk('span', 'btn-key', this.btnRestart, 'R');
    mk('span', 'btn-main', this.btnRestart, 'RESTART');
    mk('span', 'btn-sub', this.btnRestart, 'PRESS [R] — INSTANT');

    /* Both other modes are one press away from the end of a run, which is the
       moment a player is deciding what to do next (§16.10, §16.11). */
    const modeRow = mk('div', 'endmodes', actions);
    this.btnDaily = mkButton('ghost-btn mode-btn', modeRow, 'DAILY RUN');
    this.btnEndless = mkButton('ghost-btn mode-btn', modeRow, 'ENDLESS');
    this.btnDaily.addEventListener('click', () => {
      this._blur();
      this._fire('onStartMode', MODE_DAILY);
    });
    this.btnEndless.addEventListener('click', () => {
      if (!this.endlessUnlocked) return;
      this._blur();
      this._fire('onStartMode', MODE_ENDLESS);
    });

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

  _makeModeHandler(mode) {
    return (e) => {
      // The whole title screen is a start button; a chip must not also launch.
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (mode === MODE_ENDLESS && !this.endlessUnlocked) return;
      this.setMode(mode);
    };
  }

  _setHaptics(v, fire) {
    const on = !!v;
    SETTINGS.haptics = on;
    setHapticsEnabled(on);
    this.btnHapticOn.className = on ? 'seg-btn on' : 'seg-btn';
    this.btnHapticOff.className = on ? 'seg-btn' : 'seg-btn on';
    this.btnHapticOn.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.btnHapticOff.setAttribute('aria-pressed', on ? 'false' : 'true');
    if (fire) { this._blur(); this._fire('onHaptics', on); }
  }

  /**
   * Copy the share line, and say what happened. On failure the button becomes
   * the instruction rather than an error: the line is already on screen.
   */
  _onShare() {
    const text = this.shareText;
    if (!text) return;
    this._clearShareTimer();
    copyText(text, (ok) => {
      this.btnShare.textContent = ok ? TXT_SHARED : TXT_SHARE_FAIL;
      this.btnShare.className = ok ? 'ghost-btn share-btn done' : 'ghost-btn share-btn';
      this._clearShareTimer();
      if (typeof setTimeout === 'function') {
        this._shareTimer = setTimeout(() => {
          this._shareTimer = 0;
          this.btnShare.textContent = TXT_SHARE;
          this.btnShare.className = 'ghost-btn share-btn';
        }, Math.max(200, TUNING.ui.shareNoticeTime * 1000));
      }
    });
  }

  _clearShareTimer() {
    if (this._shareTimer && typeof clearTimeout === 'function') clearTimeout(this._shareTimer);
    this._shareTimer = 0;
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
    this._setHaptics(SETTINGS.haptics, false);
  }

  /** Paint the three mode chips: which one is armed, and what is still locked. */
  _syncModes() {
    for (let i = 0; i < MODES.length; i++) {
      const m = MODES[i];
      const locked = m === MODE_ENDLESS && !this.endlessUnlocked;
      const on = m === this.mode;
      const b = this.modeBtns[i];
      b.className = locked ? 'seg-btn locked' : on ? 'seg-btn on' : 'seg-btn';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-disabled', locked ? 'true' : 'false');
    }
    this.elModeNote.textContent = this.mode === MODE_DAILY
      ? (this.dailyNumber > 0
        ? 'DAILY #' + this.dailyNumber + ' — ONE TRACK, EVERYONE, TODAY'
        : 'ONE TRACK, EVERYONE, TODAY')
      : this.mode === MODE_ENDLESS
        ? 'THE HOUSE GETS HEAVIER EVERY LAP'
        : this.endlessUnlocked ? '' : 'ENDLESS UNLOCKS WHEN THE HOUSE FALLS';
    this.btnEndless.className = this.endlessUnlocked
      ? 'ghost-btn mode-btn' : 'ghost-btn mode-btn locked';
    this.btnEndless.setAttribute('aria-disabled', this.endlessUnlocked ? 'false' : 'true');
  }

  /**
   * The medal ladder. Bronze / silver / gold at 1.0 / 1.25 / 1.5 x the house
   * (§16.2), the thresholds compared UNROUNDED so a run landing exactly on one
   * earns it — the same `>=` against the same product that `meta.medalFor` uses,
   * because two answers to "did I get silver" is a bug the player would see.
   */
  _paintLadder(weight, target, medal) {
    this.elLadderHouse.textContent = 'HOUSE ' + fmt(target) + ' KG';

    // The next rung is the first one not yet earned; everything past it is
    // locked. `medal` (from meta) wins where it is supplied, so the sheet and the
    // hero can never disagree.
    let held = -1;
    if (medal && MEDAL_ORDER.indexOf(medal) >= 0) {
      held = MEDAL_ORDER.indexOf(medal);
    } else {
      for (let i = 0; i < MEDAL_ORDER.length; i++) {
        if (weight >= target * TUNING.medals[MEDAL_ORDER[i]]) held = i;
      }
    }

    for (let i = 0; i < MEDAL_ORDER.length; i++) {
      const key = MEDAL_ORDER[i];
      const mult = TUNING.medals[key];
      const at = target * mult;
      const r = this.rungEls[i];
      const got = i <= held;
      const isNext = i === held + 1;

      const cls = got ? CLS_RUNG_GOT : isNext ? CLS_RUNG_NEXT : CLS_RUNG_LOCKED;
      if (cls !== r.cls) { r.cls = cls; r.row.className = cls; }
      r.badge.textContent = got ? RUNG_EARNED : isNext ? RUNG_NEXT : RUNG_LOCKED;
      r.mult.textContent = mult.toFixed(2) + '×';
      r.at.textContent = fmt(at);
      r.need.textContent = got ? 'EARNED' : '+' + fmt(Math.max(0, at - weight));
    }
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
    this._fire('onStart', this.mode);
  }

  _isModeChip(el) {
    if (!el) return false;
    for (let i = 0; i < this.modeBtns.length; i++) if (this.modeBtns[i] === el) return true;
    return false;
  }

  /* Only the title screen takes keys here. [R] belongs to `input.js`, which
     already owns it for both the run and the run-end screen; binding it twice
     would restart twice on one press. */
  _onKeyDown(e) {
    if (this.current !== 'start' || this.starting) return;
    // A focused mode chip gets its own Enter — otherwise picking DAILY with the
    // keyboard would arm the mode and launch the run in the same keystroke.
    if (this._isModeChip(document.activeElement)) return;
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

  /**
   * Which mode the next run is (§16.10, §16.11). Endless is refused until it has
   * been unlocked, so a caller cannot arm a mode the player has not earned.
   */
  setMode(mode) {
    const m = mode === MODE_DAILY || mode === MODE_ENDLESS ? mode : MODE_NORMAL;
    this.mode = m === MODE_ENDLESS && !this.endlessUnlocked ? MODE_NORMAL : m;
    this._syncModes();
    return this.mode;
  }

  /** Endless opens once the house has fallen once — meta remembers that. */
  setEndlessUnlocked(v) {
    this.endlessUnlocked = !!v;
    if (!this.endlessUnlocked && this.mode === MODE_ENDLESS) this.mode = MODE_NORMAL;
    this._syncModes();
  }

  /** The daily's number, for the chip note, the verdict tag and the share line. */
  setDaily(number) {
    this.dailyNumber = Math.max(0, Math.round(Number(number) || 0));
    this._syncModes();
  }

  showStart() {
    this.starting = false;
    this._syncModes();
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
   *   best:{weight,medal}, mode, round, day, share, unlockedEndless}
   *
   * Everything after `best` is v3 and every field of it is optional: a v2 stats
   * object still renders, with the ladder computed from `target` and the share
   * line composed here.
   */
  showRunEnd(stats) {
    const s = stats || {};
    const target = Number(s.target) > 0 ? Number(s.target)
      : Number(s.houseWeight) > 0 ? Number(s.houseWeight) : TUNING.finale.houseWeight;
    const weight = Math.max(0, Number(s.weight) || 0);
    const outcome = s.outcome === 'win' || s.outcome === 'strikes' || s.outcome === 'fell'
      ? s.outcome : 'house';
    const medal = MEDAL_NAMES[s.medal] ? s.medal : null;
    const won = outcome === 'win';
    const mode = s.mode === MODE_DAILY || s.mode === MODE_ENDLESS ? s.mode : MODE_NORMAL;
    const round = Math.max(1, Math.round(Number(s.round) || 1));

    if (s.unlockedEndless !== undefined) this.endlessUnlocked = !!s.unlockedEndless;
    else if (won) this.endlessUnlocked = true;
    if (Number(s.day) > 0) this.dailyNumber = Math.round(Number(s.day));

    // The run's own headline stays the headline; which mode it was is a prefix on
    // the line under it, where it explains the numbers without competing.
    const tag = mode === MODE_DAILY
      ? 'DAILY' + (this.dailyNumber > 0 ? ' #' + this.dailyNumber : '') + ' · '
      : mode === MODE_ENDLESS ? 'ENDLESS · LAP ' + round + ' · ' : '';

    if (won) {
      this.elVerdict.textContent = 'HOUSE DEMOLISHED';
      this.elVerdictSub.textContent = tag + fmt(weight) + ' KG THROUGH THE FRONT WALL';
    } else if (outcome === 'strikes') {
      this.elVerdict.textContent = 'THREE STRIKES';
      this.elVerdictSub.textContent = tag + 'BLOCKED ONCE TOO OFTEN — THE RUN ENDED EARLY';
    } else if (outcome === 'fell') {
      this.elVerdict.textContent = 'OFF THE RAMP';
      this.elVerdictSub.textContent = tag + 'YOU LEFT THE ROAD BEFORE THE HOUSE';
    } else {
      this.elVerdict.textContent = 'THE HOUSE HELD';
      this.elVerdictSub.textContent = tag + 'YOU ARRIVED TOO LIGHT';
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

      // The ladder below carries every threshold, so the hero only speaks when
      // the ladder has nothing left to say: past gold, the goal is the track.
      const idx = MEDAL_ORDER.indexOf(key);
      const beyond = idx === MEDAL_ORDER.length - 1;
      this.elNext.hidden = !beyond;
      if (beyond) {
        const nextAt = Math.round(TUNING.player.startWeight
          + TUNING.weights.trackTotal + TUNING.weights.highwayBudget);
        const more = Math.max(0, nextAt - weight);
        this.elNext.textContent = more > 0
          ? 'NEXT — THE WHOLE RAMP AT ' + fmt(nextAt) + ' KG · ' + fmt(more) + ' KG MORE'
          : 'NEXT — THE WHOLE RAMP AT ' + fmt(nextAt) + ' KG · CLEARED';
      }
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

    /* ── the ladder, the share line, the other two modes ───────────────────── */
    this._paintLadder(weight, target, medal);

    this._clearShareTimer();
    this.shareText = typeof s.share === 'string' && s.share
      ? s.share : this._shareLine(weight, medal, mode, round);
    this.elShareLine.textContent = this.shareText;
    this.btnShare.textContent = TXT_SHARE;
    this.btnShare.className = 'ghost-btn share-btn';
    this._syncModes();

    this._show('end');
    this._focus(this.btnRestart);
  }

  /**
   * `TONNAGE #142 - 118,400 kg silver` — §16.10's line. `meta.shareLine` is the
   * real source; this is the fallback for a caller that has not got one, and it
   * is deliberately byte-identical in shape so a run shared from either path
   * looks the same in a feed.
   */
  _shareLine(weight, medal, mode, round) {
    const head = mode === MODE_ENDLESS
      ? 'TONNAGE ENDLESS #' + (this.dailyNumber || 1) + ' - lap ' + round
      : 'TONNAGE #' + (this.dailyNumber || 1);
    return head + ' - ' + fmt(weight) + ' kg' + (medal ? ' ' + medal : '');
  }

  hideAll() {
    this.starting = false;
    this._clearShareTimer();
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
    out.haptics = SETTINGS.haptics;
    return out;
  }

  dispose() {
    this._clearShareTimer();
    window.removeEventListener('keydown', this._onKeyDown);
    this.elStart.removeEventListener('click', this._onStartClick);
  }

  _focus(el) {
    if (!el || !el.focus) return;
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
  }
}
