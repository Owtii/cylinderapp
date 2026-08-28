/**
 * TONNAGE — fragment motion blur (§10).
 *
 * Debris is the only thing in the game that smears. The world stays sharp: the road,
 * the props and the roller are all rendered exactly as they were before this file
 * existed, and nothing here touches the post chain's pixels.
 *
 * The smear is a per-instance VERTEX STRETCH, not a screen-space pass. Every fragment
 * mesh already carries `instanceVelocity` (world m/s, written by `fx/fragments.js` in
 * the same loop as the matrices), so the vertex stage can push each piece's trailing
 * half backwards along its own velocity and let the silhouette do the work:
 *
 *     reach  = |vertex - centre|                                            [metres]
 *     tail   = saturate( -dot( ( vertex - centre ) / reach, velocityDir ) )
 *     smear  = min( speed * exposure, maxStretch, reach * maxGrowth )
 *              * gate( speed ) * strength                                   [metres]
 *     vertex = vertex - velocityDir * smear * tail
 *
 * At 45 m/s and an 11 ms exposure that is half a metre of streak on a 0.3 m shard —
 * a two-to-three times elongation, which is what reads as speed. A screen-space
 * velocity-buffer pass would produce the same picture for a handful of instanced
 * meshes at the cost of an extra render target, an extra full-screen pass and a
 * hole in the sharpness of everything the debris flies over.
 *
 * THE CLAMP IS RELATIVE AS WELL AS ABSOLUTE, and the relative one is the one that
 * matters. Half a metre of streak is two thirds of a car door and eight times a
 * bottle shard: measured over every prop's fracture plan, the absolute clamp alone
 * left the small glass and the edge-on plates at 6–9x elongation — needles, not
 * blur — while the median piece sat at a perfectly good 1.3x. Because `reach` is
 * the piece's own support radius along the smear axis, clamping the offset to
 * `reach * (maxRatio - 1)` bounds every fragment at `maxRatio` no matter how small
 * it is, and a plate travelling edge-on (reach ≈ 0) correctly gets nothing at all.
 *
 * Two details are the whole implementation:
 *
 *   • THE TAPER IS A FUNCTION OF POSITION, NEVER OF THE NORMAL. The classic
 *     backface-extrusion form (`dot( normal, dir )`) tears these hulls open: the
 *     archetype geometries are non-indexed with per-face normals, so two triangles
 *     meeting at an edge get different weights and the seam between them opens a gap
 *     exactly as long as the streak. Weighting by the vertex's own position instead
 *     makes duplicated vertices agree bit-for-bit, so the stretched hull stays
 *     watertight no matter how hard it is smeared.
 *
 *   • THE CENTRE COMES FROM THE INSTANCE MATRIX. A `positionNode` is evaluated
 *     AFTER three has applied the instance matrix, so `positionLocal` is already the
 *     transformed vertex and the piece's middle is the one thing missing. It is read
 *     back the same way three's own instancing reads it — a `mat4` uniform buffer
 *     indexed by `instanceIndex`, with the same uniform-buffer-limit test three
 *     itself applies — which is exact. It is not free: it binds a SECOND copy of the
 *     bucket's matrices (16 KB at the shipped cap of 250), re-uploaded each frame
 *     for each bucket that actually draws. Buckets with no live fragments are hidden
 *     and cost nothing, so in practice this is two or three extra uploads a frame,
 *     which is the same order as what three already spends instancing these meshes.
 *     If the matrices are too many to fit a uniform buffer (three switches to an
 *     interleaved attribute up there, which this node cannot address) the code falls
 *     back to the face-normal form, keeps the absolute clamp only, and accepts the
 *     seams. At a 250-fragment cap that branch is unreachable; it exists so a raised
 *     cap degrades instead of failing to compile.
 *
 * The stretch is clamped both ways so a fragment thrown by a tanker cannot become an
 * infinite streak, and it is gated by speed so a piece that has gone to sleep is a
 * bit-exact no-op — `fragments.js` writes a zero velocity for a sleeping or fading
 * shard, and a zero velocity multiplies the offset out on its own as well.
 *
 * Exposure is authored, not derived from the frame time: a dropped frame should not
 * double the length of every streak in the world.
 *
 * Nothing here allocates per frame. The graph is built once when the material is
 * decorated; the frame path is uniform assignments.
 */

import {
  Fn,
  attribute,
  buffer,
  instanceIndex,
  length,
  max,
  min,
  modelWorldMatrixInverse,
  normalLocal,
  positionLocal,
  saturate,
  smoothstep,
  uniform,
  vec4,
} from 'three/tsl';

import { TUNING } from '../tuning.js';

// ─────────────────────────────────────────────────────────────────── constants

/** Divisor floor. Well under a fragment's smallest half-extent, so it only ever
 *  fires on a genuinely zero vector. */
const EPS = 1e-5;

/** Bytes one instance matrix occupies in a uniform buffer. */
const MAT4_BYTES = 64;

/** Conservative uniform-buffer size when the backend will not name one. */
const DEFAULT_UNIFORM_LIMIT = 65536;

/** The instance centre: the translation column, read as `M * (0,0,0,1)`. */
const ORIGIN = /*@__PURE__*/ vec4( 0, 0, 0, 1 );

/** Guard against a hot-reloaded TUNING that is momentarily missing a field. */
function num( v, fallback ) {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback;
}

function post() {
  return ( TUNING && TUNING.post ) || {};
}

/** Elongation ratio → the growth multiplier the shader wants. 1 disables the smear. */
function growthFrom( ratio ) {
  const r = num( ratio, 3 );
  return r > 1 ? r - 1 : 0;
}

// ──────────────────────────────────────────────────────────────────── uniforms
//
// Module scope on purpose: there is exactly one fragment material in the game, and
// the graph is shared by every hull archetype that draws from it.

const uExposure = /*@__PURE__*/ uniform( num( post().fragmentBlurExposure, 0.011 ) );
const uMaxStretch = /*@__PURE__*/ uniform( num( post().fragmentBlurMax, 1.6 ) );
/** Growth, not ratio: `maxRatio - 1`, so it multiplies `reach` directly. */
const uMaxGrowth = /*@__PURE__*/ uniform( growthFrom( post().fragmentBlurMaxRatio ) );
const uMinSpeed = /*@__PURE__*/ uniform( num( post().fragmentBlurMinSpeed, 5 ) );
const uFullSpeed = /*@__PURE__*/ uniform( num( post().fragmentBlurFullSpeed, 12 ) );
const uStrength = /*@__PURE__*/ uniform(
  post().fragmentBlurEnabled === false ? 0 : num( post().fragmentBlurStrength, 1 ) );

/** Whether the last build could read instance matrices. Diagnostics only. */
let _exact = false;

/**
 * Whether the graph built the exact, watertight taper (true) or fell back to the
 * face-normal form (false). Only meaningful once the material has been built.
 * @returns {boolean}
 */
export function fragmentBlurIsExact() {
  return _exact;
}

// ────────────────────────────────────────────────────────────────── node graph

/**
 * The instance centre in the mesh's own object space, or null when this build
 * cannot address the instance matrices.
 *
 * @private
 * @param {object} builder The node builder for the mesh being compiled.
 * @returns {?object} A vec3 node, or null.
 */
function instanceCentre( builder ) {
  const object = builder !== undefined && builder !== null ? builder.object : null;
  if ( object === null || object === undefined || object.isInstancedMesh !== true ) return null;

  const matrices = object.instanceMatrix;
  if ( ! matrices || matrices.isInstancedBufferAttribute !== true ) return null;
  if ( ! ( matrices.array instanceof Float32Array ) ) return null;

  const count = matrices.count > 0 ? matrices.count : 1;

  // Above the uniform-buffer limit three stops binding the matrices as a buffer and
  // starts feeding them in as an interleaved attribute; asking for a buffer that big
  // would simply fail to compile, so the fallback taper takes over instead.
  let limit = DEFAULT_UNIFORM_LIMIT;
  if ( typeof builder.getUniformBufferLimit === 'function' ) {
    const reported = builder.getUniformBufferLimit();
    if ( typeof reported === 'number' && reported > 0 ) limit = reported;
  }
  if ( count * MAT4_BYTES > limit ) return null;

  return buffer( matrices.array, 'mat4', count ).element( instanceIndex ).mul( ORIGIN ).xyz;
}

/**
 * Builds the stretched vertex position. Assign the result to a material's
 * `positionNode`; it reads `positionLocal`, so instancing, and anything else three
 * has already folded into the vertex, is preserved.
 *
 * @returns {object} A vec3 node.
 */
export function fragmentBlurPositionNode() {
  return Fn( ( builder ) => {
    const centre = instanceCentre( builder );
    _exact = centre !== null;

    // Object space, not world: `positionLocal` lives there, and for the rigid mesh
    // matrices the fragment meshes carry the two are the same length anyway.
    const velocity = modelWorldMatrixInverse
      .mul( vec4( attribute( 'instanceVelocity', 'vec3' ), 0.0 ) ).xyz.toVar();

    const speed = length( velocity ).toVar();
    const dir = velocity.div( max( speed, EPS ) ).toVar();

    // `tail` is 1 at the trailing pole and falls to 0 across the whole leading
    // hemisphere; `reach` is how far this vertex sits from the piece's middle, which
    // at the pole is the piece's own radius along the smear axis.
    let tail;
    let reach = null;
    if ( centre !== null ) {
      const rel = positionLocal.sub( centre ).toVar();
      reach = length( rel ).toVar();
      tail = saturate( rel.div( max( reach, EPS ) ).dot( dir ).negate() ).toVar();
    } else {
      tail = saturate( normalLocal.dot( dir ).negate() ).toVar();
    }

    // Below `fragmentBlurMinSpeed` nothing smears at all, so a shard settling on the
    // road cannot shimmer as it comes to rest.
    const gate = smoothstep( uMinSpeed, uFullSpeed, speed );
    let smear = min( speed.mul( uExposure ), uMaxStretch );
    // Bounds the elongation at `fragmentBlurMaxRatio` for a shard of any size. Still
    // a pure function of the vertex position, so duplicated vertices on this
    // non-indexed geometry agree bit-for-bit and the hull stays watertight.
    if ( reach !== null ) smear = min( smear, reach.mul( uMaxGrowth ) );
    smear = smear.mul( gate ).mul( uStrength ).toVar();

    return positionLocal.sub( dir.mul( smear.mul( tail ) ) );
  } )();
}

/**
 * Decorates a fragment material with the stretch. Idempotent, and a no-op on
 * anything that is not a node material.
 *
 * @param {object} material A three NodeMaterial (the fragment InstancedMeshes' one).
 * @returns {object} The same material, for chaining.
 */
export function applyFragmentMotionBlur( material ) {
  if ( material === undefined || material === null ) return material;
  if ( material.isNodeMaterial !== true ) return material;
  if ( material.positionNode !== null && material.positionNode !== undefined ) return material;

  material.positionNode = fragmentBlurPositionNode();
  material.needsUpdate = true;
  return material;
}

// ───────────────────────────────────────────────────────────────────── driving

/**
 * Pushes TUNING into the graph's uniforms. Assignments only — the node graph is
 * never touched after it is built. `PostFX` calls this every frame so live tweaks
 * land; call it yourself if post-processing is switched off entirely.
 */
export function syncFragmentMotionBlur() {
  const P = post();

  const exposure = num( P.fragmentBlurExposure, 0.011 );
  uExposure.value = exposure > 0 ? exposure : 0;

  const maxStretch = num( P.fragmentBlurMax, 1.6 );
  uMaxStretch.value = maxStretch > 0 ? maxStretch : 0;

  uMaxGrowth.value = growthFrom( P.fragmentBlurMaxRatio );

  // Strictly ordered, or the shader's smoothstep is a divide by zero.
  const minSpeed = Math.max( 0, num( P.fragmentBlurMinSpeed, 5 ) );
  const fullSpeed = num( P.fragmentBlurFullSpeed, 12 );
  uMinSpeed.value = minSpeed;
  uFullSpeed.value = fullSpeed > minSpeed + 1e-3 ? fullSpeed : minSpeed + 1e-3;

  // Zero is an exact no-op: the offset is multiplied out and the vertex is returned
  // bit-identical to `positionLocal`.
  const strength = num( P.fragmentBlurStrength, 1 );
  uStrength.value = P.fragmentBlurEnabled === false || ! ( strength > 0 ) ? 0 : strength;
}

/**
 * The smear a fragment at `speed` would get, in metres, under the current tuning.
 * An exact CPU mirror of the shader's arithmetic — it exists so the numbers in this
 * file can be measured without a GPU, and so a tuning sweep can be checked against
 * real fracture plans in Node.
 *
 * @param {number} speed m/s.
 * @param {number} [reach] the piece's radius along the smear axis, in metres. Omit
 *   for the absolute clamp alone (which is what the fallback taper applies).
 * @returns {number} metres of stretch beyond the trailing pole.
 */
export function fragmentBlurStretchFor( speed, reach ) {
  if ( ! ( speed > 0 ) ) return 0;
  const lo = uMinSpeed.value;
  const hi = uFullSpeed.value;
  let g = ( speed - lo ) / ( hi - lo > 1e-4 ? hi - lo : 1e-4 );
  g = g < 0 ? 0 : g > 1 ? 1 : g;
  g = g * g * ( 3 - 2 * g );   // matches the shader's smoothstep
  let s = Math.min( speed * uExposure.value, uMaxStretch.value );
  if ( reach >= 0 ) s = Math.min( s, reach * uMaxGrowth.value );
  return s * g * uStrength.value;
}
