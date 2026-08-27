/**
 * TONNAGE — post-processing.
 *
 * One TSL node graph, built once, driven entirely by uniforms:
 *
 *   scene pass → chromatic aberration (radial) → + bloom → speed lines →
 *   vignette → damage red vignette → white flash → output
 *
 * Every effect is an exact mathematical no-op when its uniform is 0, so a quiet
 * frame is bit-identical to the raw scene pass (plus bloom). Per-frame work is
 * nothing but `uniform.value = x` assignments — the graph is never rebuilt.
 *
 * Backend safety: no compute, no storage buffers, no WGSL-only nodes. `atan(y,x)`
 * is emitted as `atan2` on WebGPU and `atan(y,x)` on the WebGL2 fallback by three
 * itself, so the whole chain compiles on both backends.
 */

import { RenderPipeline, PostProcessing } from 'three/webgpu';
import {
  Fn,
  abs,
  atan,
  clamp,
  float,
  floor,
  fract,
  length,
  mix,
  pass,
  pow,
  screenSize,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

import { TUNING } from '../tuning.js';
import { clamp01, TAU } from '../core/math.js';

// ─────────────────────────────────────────────────────────────── palette
// Pure look constants (not balance numbers) — kept local on purpose.

/** Linear-space red the BLOCKED vignette blends toward. */
const DAMAGE_R = 0.72;
const DAMAGE_G = 0.035;
const DAMAGE_B = 0.02;

/** Slightly warm white for the speed streaks. */
const LINE_R = 1.0;
const LINE_G = 0.965;
const LINE_B = 0.9;

/** Falloff exponent of the damage mask (fixed shape; strength is tunable). */
const DAMAGE_POW = 1.8;

/** 1/sqrt(2): keeps the corner chromatic shift at exactly `chromaticMaxPixels`. */
const CORNER_NORM = 0.7071067811865476;

/** Wrap the internal clock so a long session never loses float precision. */
const TIME_WRAP = 3600;

/**
 * Cheap deterministic hash of a streak index → [0,1). Static per streak, so the
 * speed lines never re-roll between frames (that is what would make them shimmer).
 */
const hashLine = /*@__PURE__*/ Fn( ( [ n ] ) => {
  return fract( sin( n.mul( 12.9898 ) ).mul( 43758.5453 ) );
} );

/** Guard against a hot-reloaded TUNING that is momentarily missing a field. */
function num( v, fallback ) {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback;
}

export class PostFX {
  /**
   * Builds the whole chain up front. Throws if it genuinely cannot be built —
   * the caller is expected to catch and fall back to a direct render.
   *
   * @param {object} renderer A three WebGPURenderer (WebGL2 fallback included).
   * @param {object} scene
   * @param {object} camera
   */
  constructor( renderer, scene, camera ) {
    if ( renderer === undefined || renderer === null || typeof renderer.render !== 'function' ) {
      throw new Error( 'PostFX: a three Renderer is required.' );
    }
    if ( scene === undefined || scene === null ) throw new Error( 'PostFX: a scene is required.' );
    if ( camera === undefined || camera === null ) throw new Error( 'PostFX: a camera is required.' );

    const P = TUNING.post;

    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;

    this._enabled = P.enabled !== false;
    this._disposed = false;
    this._width = 1;
    this._height = 1;

    // Cached so the steady-state render path allocates nothing.
    this._resolved = Promise.resolve();
    this._clockStart = -1;

    this._scenePass = null;
    this._bloom = null;
    this._pipeline = null;

    // ── driven uniforms (the game writes these every frame)
    this.uChromatic = uniform( 0 );
    this.uDamage = uniform( 0 );
    this.uSpeed = uniform( 0 );
    this.uFlash = uniform( 0 );
    this.uTime = uniform( 0 );

    // ── tuning uniforms (re-synced from TUNING each frame so live tweaks land)
    this.uVignette = uniform( num( P.vignetteStrength, 0.5 ) );
    this.uVignettePow = uniform( num( P.vignettePower, 2.2 ) );
    this.uChromaticPx = uniform( num( P.chromaticMaxPixels, 2 ) );
    this.uSpeedThreshold = uniform( num( P.speedLinesThreshold, 0.7 ) );
    this.uSpeedStrength = uniform( num( P.speedLinesStrength, 0.55 ) );
    this.uSpeedInner = uniform( num( P.speedLinesInner, 0.34 ) );
    this.uSpeedWidth = uniform( num( P.speedLinesWidth, 0.3 ) );
    this.uSpeedRepeat = uniform( num( P.speedLinesRepeat, 3.2 ) );
    this.uSpeedScroll = uniform( num( P.speedLinesScroll, 2.6 ) );
    this.uLineCount = uniform( num( P.speedLinesCount, 46 ) );
    this.uDamageStrength = uniform( num( P.damageStrength, 0.9 ) );
    this.uDamageInner = uniform( num( P.damageInner, 0.12 ) );
    this.uFlashLevel = uniform( num( P.flashLevel, 3 ) );

    try {
      this._build();
    } catch ( err ) {
      this._disposeParts();
      throw err;
    }
  }

  /** @private Builds the node graph + pipeline. Runs exactly once. */
  _build() {
    const P = TUNING.post;

    const scenePass = pass( this._scene, this._camera );
    this._scenePass = scenePass;

    const sceneColor = scenePass.getTextureNode( 'output' );

    const bloomNode = bloom(
      sceneColor,
      num( P.bloomStrength, 0.55 ),
      num( P.bloomRadius, 0.7 ),
      num( P.bloomThreshold, 0.82 ),
    );
    this._bloom = bloomNode;

    if ( typeof bloomNode.setResolutionScale === 'function' ) {
      const s = num( P.bloomResolutionScale, 0.5 );
      bloomNode.setResolutionScale( s < 0.125 ? 0.125 : s > 1 ? 1 : s );
    }

    const uChromatic = this.uChromatic;
    const uDamage = this.uDamage;
    const uSpeed = this.uSpeed;
    const uFlash = this.uFlash;
    const uTime = this.uTime;
    const uVignette = this.uVignette;
    const uVignettePow = this.uVignettePow;
    const uChromaticPx = this.uChromaticPx;
    const uSpeedThreshold = this.uSpeedThreshold;
    const uSpeedStrength = this.uSpeedStrength;
    const uSpeedInner = this.uSpeedInner;
    const uSpeedWidth = this.uSpeedWidth;
    const uSpeedRepeat = this.uSpeedRepeat;
    const uSpeedScroll = this.uSpeedScroll;
    const uLineCount = this.uLineCount;
    const uDamageStrength = this.uDamageStrength;
    const uDamageInner = this.uDamageInner;
    const uFlashLevel = this.uFlashLevel;

    const composite = Fn( () => {
      const suv = screenUV;

      // Size of one physical pixel in UV units, and an aspect-corrected radius
      // normalised so 0 = screen centre and 1 = screen corner on any aspect.
      const texel = vec2( 1.0, 1.0 ).div( screenSize );
      const centred = suv.sub( 0.5 ).toVar();
      const aspect = screenSize.x.div( screenSize.y ).toVar();
      const p = vec2( centred.x.mul( aspect ), centred.y ).toVar();
      const rCorner = sqrt( aspect.mul( aspect ).add( 1.0 ) ).mul( 0.5 );
      const r = length( p ).div( rCorner ).toVar();

      // ── chromatic aberration ────────────────────────────────────────────
      // Radial: zero at the centre, `chromaticMaxPixels` at the corner. The R
      // and B taps collapse onto the G tap when uChromatic is 0.
      const caPixels = uChromatic.mul( uChromaticPx ).mul( CORNER_NORM );
      const caOffset = centred.mul( 2.0 ).mul( caPixels ).mul( texel ).toVar();

      const sceneRgb = vec3(
        sceneColor.sample( suv.add( caOffset ) ).r,
        sceneColor.sample( suv ).g,
        sceneColor.sample( suv.sub( caOffset ) ).b,
      );

      // ── bloom ───────────────────────────────────────────────────────────
      const lit = sceneRgb.add( bloomNode.rgb ).toVar();

      // ── speed lines ─────────────────────────────────────────────────────
      // Streaks are static in angle (a hash of the quantised radial angle), so
      // they cannot shimmer; only their brightness and the outward dash scroll
      // respond to speed, and both collapse to zero below the threshold.
      const speedT = smoothstep( uSpeedThreshold, 1.0, uSpeed ).toVar();

      // atan(0,0) is undefined in GLSL ES and WGSL alike, and on a buffer with odd
      // width and height exactly one fragment lands on (0,0). A NaN there would
      // poison the streak term for that pixel.
      const cell = atan( p.y, p.x.add( 1e-6 ) ).mul( uLineCount ).div( TAU ).toVar();
      const rnd = hashLine( floor( cell ) ).toVar();

      const halfWidth = rnd.mul( uSpeedWidth ).add( 0.06 ).toVar();
      const offCentre = abs( fract( cell ).sub( 0.5 ) );
      // Soft-edged band: 1 in the core, 0 outside `halfWidth`. Wide in screen
      // space wherever it is visible, so it never aliases.
      const core = float( 1.0 ).sub( smoothstep( halfWidth.mul( 0.25 ), halfWidth, offCentre ) );

      const radialMask = smoothstep( uSpeedInner, 1.0, r );
      const flow = r.mul( uSpeedRepeat )
        .add( rnd.mul( TAU ) )
        .sub( uTime );   // uTime is the integrated dash phase, not a wall clock
      const dash = sin( flow.mul( TAU ) ).mul( 0.32 ).add( 0.68 );

      const lines = core
        .mul( radialMask )
        .mul( dash )
        .mul( rnd.mul( 0.45 ).add( 0.55 ) )
        .mul( speedT )
        .mul( uSpeedStrength );

      const streaked = lit.add( vec3( LINE_R, LINE_G, LINE_B ).mul( lines ) ).toVar();

      // ── vignette ────────────────────────────────────────────────────────
      const vignette = clamp( float( 1.0 ).sub( uVignette.mul( pow( r, uVignettePow ) ) ), 0.0, 1.0 );
      const shaded = streaked.mul( vignette ).toVar();

      // ── damage (BLOCKED) red vignette ───────────────────────────────────
      const damageMask = uDamageInner.add(
        float( 1.0 ).sub( uDamageInner ).mul( pow( r, DAMAGE_POW ) ),
      );
      const damageT = uDamage.mul( uDamageStrength ).mul( damageMask );
      const hurt = mix( shaded, vec3( DAMAGE_R, DAMAGE_G, DAMAGE_B ), damageT ).toVar();

      // ── white flash ─────────────────────────────────────────────────────
      const flashed = mix( hurt, vec3( uFlashLevel ), uFlash );

      return vec4( flashed, 1.0 );
    } )();

    const Pipeline = typeof RenderPipeline === 'function' ? RenderPipeline : PostProcessing;
    this._pipeline = new Pipeline( this._renderer, composite );
  }

  // ─────────────────────────────────────────────────────────────── sizing

  /**
   * Keeps the scene pass in step with the canvas. three re-derives the pass size
   * from the drawing buffer every frame too, so this mainly covers the frame
   * right after a resize.
   *
   * The bloom node is deliberately NOT resized here: its internal blur materials
   * only exist once the graph has been built on the GPU, and it already resizes
   * itself from the drawing buffer inside `updateBefore` every frame.
   */
  setSize( w, h ) {
    this._width = w > 1 ? w : 1;
    this._height = h > 1 ? h : 1;
    // Deliberately does NOT push the size into the node graph.
    //
    // PassNode.updateBefore() already calls its own setSize() with the renderer's
    // drawing-buffer size every frame, and BloomNode.setSize() dereferences blur
    // materials that only exist once the graph has been built on the GPU. Sizing
    // the graph by hand before the first render therefore throws — and on a
    // browser that falls back to WebGL2 the first render happens later than you
    // would expect, which is exactly when this used to take post-processing out.
  }

  // ────────────────────────────────────────────────────────────── driving

  /** 0..1 chromatic pulse. Caller owns the decay. */
  setChromatic( t ) {
    this.uChromatic.value = clamp01( t );
  }

  /** 0..1 red vignette for BLOCKED hits. */
  setDamage( t ) {
    this.uDamage.value = clamp01( t );
  }

  /** 0..1 normalised speed; streaks appear above TUNING.post.speedLinesThreshold. */
  setSpeed( t ) {
    this.uSpeed.value = clamp01( t );
  }

  /** 0..1 white full-screen flash. */
  setFlash( t ) {
    this.uFlash.value = clamp01( t );
  }

  /** Disabled falls back to a plain `renderer.render(scene, camera)`. */
  setEnabled( b ) {
    this._enabled = !! b;
  }

  get enabled() {
    return this._enabled;
  }

  // ─────────────────────────────────────────────────────────────── render

  /**
   * Draws the frame. Returns a promise so the caller can await the very first
   * frames while the backend is still initialising; once the renderer is up,
   * the fast path is synchronous and returns a pre-allocated resolved promise.
   */
  render() {
    if ( this._disposed === true ) return this._resolved;

    if ( this._renderer.initialized === true ) {
      this._draw();
      return this._resolved;
    }

    return this._initAndDraw();
  }

  /** @private */
  async _initAndDraw() {
    await this._renderer.init();
    if ( this._disposed === true ) return;
    this._draw();
  }

  /** @private Zero-allocation frame body. */
  _draw() {
    if ( this._enabled === true && this._pipeline !== null ) {
      this._syncTuning();
      this._advanceClock();
      this._pipeline.render();
    } else {
      this._renderer.render( this._scene, this._camera );
    }
  }

  /**
   * @private Pushes TUNING.post into the graph's uniforms. Assignments only —
   * the node graph itself is never touched after construction.
   */
  _syncTuning() {
    const P = TUNING.post;

    this._bloom.strength.value = num( P.bloomStrength, 0.55 );
    this._bloom.radius.value = num( P.bloomRadius, 0.7 );
    this._bloom.threshold.value = num( P.bloomThreshold, 0.82 );

    this.uVignette.value = num( P.vignetteStrength, 0.5 );
    this.uVignettePow.value = num( P.vignettePower, 2.2 );
    this.uChromaticPx.value = num( P.chromaticMaxPixels, 2 );

    // Keep the smoothstep edges strictly ordered — a threshold of 1 would be a
    // divide-by-zero inside the shader.
    const threshold = num( P.speedLinesThreshold, 0.7 );
    this.uSpeedThreshold.value = threshold > 0.99 ? 0.99 : threshold < 0 ? 0 : threshold;
    this.uSpeedStrength.value = num( P.speedLinesStrength, 0.55 );

    const inner = num( P.speedLinesInner, 0.34 );
    this.uSpeedInner.value = inner > 0.99 ? 0.99 : inner < 0 ? 0 : inner;

    // < 0.5 or neighbouring streaks merge into a solid ring.
    const width = num( P.speedLinesWidth, 0.3 );
    this.uSpeedWidth.value = width > 0.42 ? 0.42 : width < 0 ? 0 : width;

    this.uSpeedRepeat.value = num( P.speedLinesRepeat, 3.2 );
    this.uSpeedScroll.value = num( P.speedLinesScroll, 2.6 );

    // Even counts only: the angular seam at ±PI then lands on a cell boundary
    // instead of splitting a streak.
    let count = Math.round( num( P.speedLinesCount, 46 ) * 0.5 ) * 2;
    if ( count < 4 ) count = 4;
    this.uLineCount.value = count;

    this.uDamageStrength.value = num( P.damageStrength, 0.9 );
    const dInner = num( P.damageInner, 0.12 );
    this.uDamageInner.value = dInner > 1 ? 1 : dInner < 0 ? 0 : dInner;

    this.uFlashLevel.value = num( P.flashLevel, 3 );
  }

  /**
   * @private
   * Integrates the speed-line dash phase.
   *
   * The phase must be accumulated, not derived as `elapsed * scroll * speedGate`.
   * With an absolute clock the phase carries a `t * d(speedGate)` term, so every
   * change in speed jumps the dashes by an amount proportional to how long the
   * session has been running — after a few minutes the streaks strobe on any
   * acceleration. Integrating keeps the phase continuous no matter how the gate
   * moves.
   */
  _advanceClock() {
    const now = ( typeof performance !== 'undefined' ? performance.now() : Date.now() ) * 0.001;
    if ( this._clockStart < 0 ) this._clockStart = now;
    let dt = now - this._clockStart;
    this._clockStart = now;
    if ( !( dt > 0 ) || dt > 0.25 ) dt = 0;   // first frame, or a tab that slept

    const P = TUNING.post;
    const thr = num( P.speedLinesThreshold, 0.88 );
    const sp = this.uSpeed.value;
    let gate = ( sp - thr ) / ( 1 - thr > 1e-4 ? 1 - thr : 1e-4 );
    gate = gate < 0 ? 0 : gate > 1 ? 1 : gate;
    gate = gate * gate * ( 3 - 2 * gate );    // matches the shader's smoothstep

    let phase = this.uTime.value + this.uSpeedScroll.value * gate * dt;
    if ( phase > TIME_WRAP || phase < 0 ) phase = phase % 1;   // dashes repeat at 1
    this.uTime.value = phase;
  }

  // ────────────────────────────────────────────────────────────── teardown

  /** @private Releases whatever was built. Safe to call on a partial build. */
  _disposeParts() {
    if ( this._pipeline !== null && typeof this._pipeline.dispose === 'function' ) {
      this._pipeline.dispose();
    }
    if ( this._bloom !== null && typeof this._bloom.dispose === 'function' ) {
      this._bloom.dispose();
    }
    if ( this._scenePass !== null && typeof this._scenePass.dispose === 'function' ) {
      this._scenePass.dispose();
    }
    this._pipeline = null;
    this._bloom = null;
    this._scenePass = null;
  }

  dispose() {
    if ( this._disposed === true ) return;
    this._disposed = true;
    this._enabled = false;
    this._disposeParts();
  }
}
