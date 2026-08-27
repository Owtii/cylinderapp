import { TUNING } from '../tuning.js';
import { clamp } from '../core/math.js';

/**
 * Input.
 *
 * Desktop: A/D or ←/→ steer, Space tucks, R restarts, Esc/P pauses.
 * Mobile: drag anywhere to steer, tap to tuck.
 *
 * Steering is reported as a -1..1 axis; all smoothing lives in the player's
 * steering model, not here, so touch and keyboard feel identical.
 */
export class Input {
  constructor(target) {
    this.target = target;
    this.lateral = 0;
    this.left = false;
    this.right = false;

    this.tuckEdge = false;
    this.restartEdge = false;
    this.pauseEdge = false;
    this.anyEdge = false;

    this.pointerId = -1;
    this.anchorX = 0;
    this.pointerX = 0;
    this.pointerDownTime = 0;
    this.pointerMoved = 0;
    this.touchLateral = 0;
    this.usingTouch = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onBlur = this._onBlur.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    target.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    window.addEventListener('pointermove', this._onPointerMove, { passive: false });
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
  }

  /** Call once per frame AFTER reading edges. */
  endFrame() {
    this.tuckEdge = false;
    this.restartEdge = false;
    this.pauseEdge = false;
    this.anyEdge = false;
  }

  poll() {
    if (this.usingTouch && this.pointerId !== -1) {
      this.lateral = this.touchLateral;
    } else {
      this.lateral = (this.right ? 1 : 0) - (this.left ? 1 : 0);
    }
    return this.lateral;
  }

  _onKeyDown(e) {
    if (e.repeat) {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'KeyA': case 'ArrowLeft': this.left = true; this.usingTouch = false; e.preventDefault(); break;
      case 'KeyD': case 'ArrowRight': this.right = true; this.usingTouch = false; e.preventDefault(); break;
      case 'Space': this.tuckEdge = true; e.preventDefault(); break;
      case 'KeyR': this.restartEdge = true; break;
      case 'Escape': case 'KeyP': this.pauseEdge = true; break;
      default: break;
    }
    this.anyEdge = true;
  }

  _onKeyUp(e) {
    switch (e.code) {
      case 'KeyA': case 'ArrowLeft': this.left = false; break;
      case 'KeyD': case 'ArrowRight': this.right = false; break;
      default: break;
    }
  }

  _onBlur() {
    this.left = false;
    this.right = false;
    this.pointerId = -1;
    this.touchLateral = 0;
  }

  _onPointerDown(e) {
    if (this.pointerId !== -1) return;
    // Buttons and sliders own their own pointer; steering must not steal it.
    if (e.target && e.target.closest && e.target.closest('button, input, select, a, [data-ui]')) return;
    this.pointerId = e.pointerId;
    this.anchorX = e.clientX;
    this.pointerX = e.clientX;
    this.pointerDownTime = performance.now();
    this.pointerMoved = 0;
    this.touchLateral = 0;
    this.usingTouch = true;
    this.anyEdge = true;
  }

  _onPointerMove(e) {
    if (e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.pointerX;
    this.pointerX = e.clientX;
    this.pointerMoved += Math.abs(dx);
    // Anchor-relative steering with a drifting anchor, so a long drag never
    // saturates and you can always re-centre without lifting your thumb.
    const span = Math.max(90, window.innerWidth * 0.20);
    let v = (this.pointerX - this.anchorX) / span;
    if (v > 1) { this.anchorX = this.pointerX - span; v = 1; }
    else if (v < -1) { this.anchorX = this.pointerX + span; v = -1; }
    if (Math.abs(this.pointerX - this.anchorX) < TUNING.input.touchDeadzonePx) v = 0;
    this.touchLateral = clamp(v, -1, 1);
  }

  _onPointerUp(e) {
    if (e.pointerId !== this.pointerId) return;
    const held = performance.now() - this.pointerDownTime;
    if (held < 220 && this.pointerMoved < 12) this.tuckEdge = true;
    this.pointerId = -1;
    this.touchLateral = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.target.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
  }
}
