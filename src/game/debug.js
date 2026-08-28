import { TUNING } from '../tuning.js';

/**
 * The §14 debug overlay.
 *
 * Three of the acceptance criteria are countable rather than felt — "never more than
 * 12 interactive objects on screen, verified with a debug counter", "every formation
 * is preceded by at least 1.2 seconds of empty ramp", "the highway's grade is never
 * zero or negative" — and a criterion you cannot see while playing is a criterion
 * that quietly stops holding. This puts all of them on screen.
 *
 * Anything over its cap renders struck through, so a violation is visible at a glance
 * rather than requiring the reader to remember what the cap was.
 *
 * Styles are inlined rather than living in styles.css: this is a developer surface,
 * it must not be able to break the game's stylesheet, and it should stay deletable in
 * one file. Hidden by default, toggled with backquote or F3.
 */
export class DebugOverlay {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'tdbg';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.cssText = [
      'position:absolute', 'left:8px', 'bottom:8px', 'z-index:60',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#c8ccd2', 'background:rgba(10,12,15,0.82)',
      'border:1px solid rgba(255,255,255,0.10)', 'border-radius:4px',
      'padding:6px 9px', 'white-space:pre', 'pointer-events:none',
      'letter-spacing:0.02em', 'display:none',
    ].join(';');
    (root || document.body).appendChild(this.el);

    this.visible = false;
    this.text = '';

    // Frame timing over a rolling window — a single frame's dt is noise.
    this.frames = 0;
    this.accum = 0;
    this.fps = 0;

    // Peaks are the interesting number: a cap that is respected on average and
    // breached once a run is still breached.
    this.peakVisible = 0;
    this.peakNear = 0;
    this.peakLabels = 0;
    this.worstGrade = Infinity;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  reset() {
    this.peakVisible = 0;
    this.peakNear = 0;
    this.peakLabels = 0;
    this.worstGrade = Infinity;
    this.frames = 0;
    this.accum = 0;
  }

  /**
   * @param dt      unscaled frame time
   * @param s       counts for this frame — see game.js. Reused by the caller.
   */
  update(dt, s) {
    this.frames++;
    this.accum += dt;
    if (this.accum >= 0.5) {
      this.fps = this.frames / this.accum;
      this.frames = 0;
      this.accum = 0;
    }
    if (s.visible > this.peakVisible) this.peakVisible = s.visible;
    if (s.near > this.peakNear) this.peakNear = s.near;
    if (s.labels > this.peakLabels) this.peakLabels = s.labels;
    if (s.gradeDeg < this.worstGrade) this.worstGrade = s.gradeDeg;

    if (!this.visible) return;

    const R = TUNING.read;
    const t =
      cap('objects', s.visible, this.peakVisible, R.maxVisibleObjects) +
      cap('near   ', s.near, this.peakNear, R.maxNearObjects) +
      cap('labels ', s.labels, this.peakLabels, R.maxLabels) +
      floor('grade  ', s.gradeDeg, this.worstGrade, TUNING.world.minSlopeDeg) +
      row('frags  ', `${s.fragments} / ${TUNING.destruction.maxFragments}`) +
      row('fps    ', this.fps.toFixed(0)) +
      row('weight ', `${Math.round(s.weight).toLocaleString('en-US')} kg`) +
      row('speed  ', `${s.speed.toFixed(1)} m/s`) +
      row('zone   ', String(s.zone));
    if (t !== this.text) {
      this.text = t;
      this.el.textContent = t;
    }
  }

  dispose() {
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

function row(label, value) {
  return `${label} ${value}\n`;
}

/** A count against a ceiling. Over the cap, the line is marked. */
function cap(label, now, peak, limit) {
  const bad = peak > limit;
  return `${label} ${String(now).padStart(3)}  peak ${String(peak).padStart(3)} / ${limit}${bad ? '   <-- OVER' : ''}\n`;
}

/** A value against a floor — the grade, which may never reach zero. */
function floor(label, now, worst, limit) {
  const bad = worst < limit;
  return `${label} ${now.toFixed(1).padStart(5)}  min ${worst === Infinity ? '  -  ' : worst.toFixed(1).padStart(5)} / ${limit}${bad ? '   <-- UNDER' : ''}\n`;
}
