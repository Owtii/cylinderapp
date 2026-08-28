/**
 * TONNAGE — the squash (§10).
 *
 * Nothing in this game is allowed to simply vanish into a cloud of shards. Every
 * object visibly crumples first: 60–90 ms of crush along the impact axis — four to
 * six frames at 60 Hz, which is exactly the window in which the eye reads "that
 * caved in" rather than "that disappeared" — and only then is it handed back to the
 * caller to be swapped for fragments.
 *
 * The crush itself is `PropRenderer.crush`, a per-part affine fold; this module owns
 * the timeline: who is crushing, how far along they are, when they are done, and
 * which ones never fragment at all.
 *
 * Three things about the sequencing matter more than anything in the maths.
 *
 * 1. THE PAPER TIER NEVER WAITS (§5). A paper hit costs the player exactly zero
 *    speed and zero frames, so the crush cannot sit in front of the weight. The
 *    caller absorbs first and calls `begin` afterwards: the object has already been
 *    consumed and its weight is already on the HUD, and what crumples behind the
 *    player is a corpse. At 40 m/s the roller is 3 m past it before it comes apart,
 *    which is precisely the point.
 *
 * 2. A FULL POOL MUST NOT SWALLOW A HIT. `begin` returns false rather than dropping
 *    the object, and the caller goes straight to fragments. Six simultaneous smashes
 *    is a normal frame in this game and the cheapest way to ruin one is to make an
 *    object disappear silently because a pool was busy.
 *
 * 3. THE LAST POSE IS ALWAYS DRAWN. A crush that reached full compression inside
 *    `update` is held for one more frame before it is reported through `completed`,
 *    so the fully crushed silhouette is on screen for at least one frame instead of
 *    being computed and immediately thrown away.
 *
 * PLOW survivors are `strand`ed instead: they keep their instance, sit at a deeper
 * permanent crush, and stay on the road. They cost nothing per frame (their matrices
 * are written once), they hold no crush slot, and they are not in the world's object
 * list at all any more, so they cannot be hit. A tail of ruined vehicles behind the
 * player is free spectacle.
 *
 * Nothing here allocates after construction.
 */

import { TUNING } from '../tuning.js';

export class SquashSystem {
  constructor(propRenderer) {
    this.props = propRenderer;

    const D = TUNING.destruction;
    const cap = D.squashPool;
    const scap = D.squashStrandMax;
    this.capacity = cap;

    this.key = new Array(cap).fill('');
    this.handle = new Int32Array(cap).fill(-1);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.rotY = new Float32Array(cap);
    this.scale = new Float32Array(cap);
    this.ax = new Float32Array(cap);
    this.ay = new Float32Array(cap);
    this.az = new Float32Array(cap);
    this.dur = new Float32Array(cap);
    this.t = new Float32Array(cap);
    this.seed = new Int32Array(cap);
    this.phase = new Uint8Array(cap);        // 1 = at full crush, held one frame
    this.wreck = new Uint8Array(cap);        // 1 = strand it, do not fragment it
    this.count = 0;

    // Handed to the caller each frame. Flat, reused, never reallocated.
    this._completed = {
      count: 0,
      key: new Array(cap).fill(''),
      handle: new Int32Array(cap),
      x: new Float32Array(cap),
      y: new Float32Array(cap),
      z: new Float32Array(cap),
      rotY: new Float32Array(cap),
      scale: new Float32Array(cap),
    };
    // The impact axis is not part of the frozen `completed` shape, but stranding an
    // object the caller has already been handed needs it, so it rides alongside.
    this._cAx = new Float32Array(cap);
    this._cAy = new Float32Array(cap);
    this._cAz = new Float32Array(cap);
    this._cSeed = new Int32Array(cap);

    this.strandKey = new Array(scap).fill('');
    this.strandHandle = new Int32Array(scap).fill(-1);
    this.strandCount = 0;
    this._strandHead = 0;                    // oldest wreck, evicted first

    this._nextSeed = 1;
  }

  get activeCount() { return this.count; }
  get wreckCount() { return this.strandCount; }
  get completed() { return this._completed; }

  /**
   * Begin a crush. The caller keeps ownership of nothing: the prop instance handle
   * belongs to this system until it comes back through `completed`, or forever if it
   * is stranded.
   *
   * @param {number} seconds  crush duration; clamped into §10's 60–90 ms window, and
   *   0 or omitted takes the default. The clamp is not politeness — outside that
   *   window the crush is either invisible or slow enough to look like an animation.
   * @returns {boolean} false if the pool is full; the caller must fragment now.
   */
  begin(key, handle, x, y, z, rotY, scale, ax, ay, az, seconds) {
    if (handle < 0 || this.count >= this.capacity) return false;
    const D = TUNING.destruction;
    let dur = seconds > 0 ? seconds : D.squashSeconds;
    if (dur < D.squashSecondsMin) dur = D.squashSecondsMin;
    else if (dur > D.squashSecondsMax) dur = D.squashSecondsMax;

    const i = this.count++;
    this.key[i] = key;
    this.handle[i] = handle;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.rotY[i] = rotY; this.scale[i] = scale || 1;
    this.ax[i] = ax; this.ay[i] = ay; this.az[i] = az;
    this.dur[i] = dur;
    this.t[i] = 0;
    this.phase[i] = 0;
    this.wreck[i] = 0;
    this.seed[i] = this._nextSeed = (this._nextSeed + 0x9e3779b1) | 0;

    // Write the uncrushed pose immediately. The streamer placed this instance, but a
    // moving vehicle is somewhere else by now, and the first crushed frame has to be
    // measured from where the object actually was when it was hit.
    this.props.crush(key, handle, x, y, z, this.rotY[i], this.scale[i],
      ax, ay, az, 0, D.squashCompression, this.seed[i]);
    return true;
  }

  /** Advance every live crush. Pass the same time-scaled dt the fragments get. */
  update(dt) {
    const D = TUNING.destruction;
    const c = this._completed;
    c.count = 0;
    if (this.count === 0) return;

    let w = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.phase[i] === 1) {
        // Full crush was on screen last frame; retire the slot now.
        if (this.wreck[i]) {
          this._strand(this.key[i], this.handle[i], this.x[i], this.y[i], this.z[i],
            this.rotY[i], this.scale[i], this.ax[i], this.ay[i], this.az[i], this.seed[i]);
        } else {
          const j = c.count++;
          c.key[j] = this.key[i];
          c.handle[j] = this.handle[i];
          c.x[j] = this.x[i]; c.y[j] = this.y[i]; c.z[j] = this.z[i];
          c.rotY[j] = this.rotY[i]; c.scale[j] = this.scale[i];
          this._cAx[j] = this.ax[i]; this._cAy[j] = this.ay[i]; this._cAz[j] = this.az[i];
          this._cSeed[j] = this.seed[i];
        }
        continue;
      }

      // Written as a negated test so a NaN dt lands on "finished" rather than on
      // "still going": an object that never completes is an object that never
      // fragments, and a hole in the road where its weight used to be.
      let t = this.t[i] + dt / this.dur[i];
      if (!(t < 1)) { t = 1; this.phase[i] = 1; }
      else if (!(t > 0)) t = 0;
      this.t[i] = t;

      // Ease out, gently. A hard ease-out spends its last two frames moving by
      // fractions of a centimetre, which fails the only test that matters here:
      // every one of those four to six frames has to look different from the last.
      const te = 1 - Math.pow(1 - t, D.squashEasePower);
      this.props.crush(this.key[i], this.handle[i], this.x[i], this.y[i], this.z[i],
        this.rotY[i], this.scale[i], this.ax[i], this.ay[i], this.az[i],
        te, D.squashCompression, this.seed[i]);

      if (i !== w) this._move(i, w);
      w++;
    }
    this.count = w;
  }

  /**
   * Leave this object on the road as a permanent wreck instead of fragmenting it.
   *
   * Callable while the crush is running, or on an object handed back through
   * `completed` this frame — the PLOW path decides at impact, the caller's drain
   * loop is welcome to decide later. Either way the handle is this system's from
   * here on: do not free it.
   *
   * @returns {boolean} false if that object is neither crushing nor just completed.
   */
  strand(key, handle) {
    for (let i = 0; i < this.count; i++) {
      if (this.handle[i] === handle && this.key[i] === key) { this.wreck[i] = 1; return true; }
    }
    const c = this._completed;
    for (let j = 0; j < c.count; j++) {
      if (c.handle[j] === handle && c.key[j] === key) {
        this._strand(key, handle, c.x[j], c.y[j], c.z[j], c.rotY[j], c.scale[j],
          this._cAx[j], this._cAy[j], this._cAz[j], this._cSeed[j]);
        return true;
      }
    }
    return false;
  }

  reset() {
    for (let i = 0; i < this.count; i++) {
      this.props.free(this.key[i], this.handle[i]);
      this.handle[i] = -1;
    }
    this.count = 0;
    for (let i = 0; i < this.strandCount; i++) {
      this.props.free(this.strandKey[i], this.strandHandle[i]);
      this.strandHandle[i] = -1;
    }
    this.strandCount = 0;
    this._strandHead = 0;
    this._completed.count = 0;
  }

  dispose() {
    this.reset();
    this.props = null;
  }

  /**
   * Park a wreck. It settles deeper than the crush ended — a car that has been
   * driven over stays flatter than one caught mid-crumple — and then never costs
   * another instruction: its matrices are written here, once.
   */
  _strand(key, handle, x, y, z, rotY, scale, ax, ay, az, seed) {
    const D = TUNING.destruction;
    this.props.crush(key, handle, x, y, z, rotY, scale, ax, ay, az,
      1, D.squashStrandCompression, seed);

    let slot;
    if (this.strandCount < this.strandKey.length) {
      slot = this.strandCount++;
    } else {
      // Oldest first, and far enough behind the player that nobody sees it go.
      slot = this._strandHead;
      this.props.free(this.strandKey[slot], this.strandHandle[slot]);
      this._strandHead = (this._strandHead + 1) % this.strandKey.length;
    }
    this.strandKey[slot] = key;
    this.strandHandle[slot] = handle;
  }

  _move(i, w) {
    this.key[w] = this.key[i];
    this.handle[w] = this.handle[i];
    this.x[w] = this.x[i]; this.y[w] = this.y[i]; this.z[w] = this.z[i];
    this.rotY[w] = this.rotY[i]; this.scale[w] = this.scale[i];
    this.ax[w] = this.ax[i]; this.ay[w] = this.ay[i]; this.az[w] = this.az[i];
    this.dur[w] = this.dur[i]; this.t[w] = this.t[i];
    this.seed[w] = this.seed[i];
    this.phase[w] = this.phase[i];
    this.wreck[w] = this.wreck[i];
  }
}
