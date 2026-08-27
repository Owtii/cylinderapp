/**
 * TONNAGE — all tuning values live here and nowhere else.
 *
 * Every magic number that affects balance, feel, or performance is in this file.
 * Modules import TUNING and read from it at call time (never destructure numbers
 * into module scope at import time) so live-tweaking works.
 */

export const TUNING = {
  // ─────────────────────────────────────────────────────────── world / physics
  world: {
    gravity: -30,                 // m/s^2. Heavier-than-real: hits land fast, jumps stay snappy.
    fixedStep: 1 / 60,            // physics timestep (s)
    maxStepsPerFrame: 5,          // spiral-of-death guard
    baseSlopeDeg: 12,             // default hill angle
    steepSlopeDeg: 20,            // speed-burst sections
    roadWidth: 24,                // total drivable width (x from -12..+12)
    laneCount: 6,                 // road is diced into this many lanes for authoring
    chunkLength: 80,              // units of travel per chunk
    chunkGridZ: 8,                // road cells along travel per chunk (80/8 = 10u)
    chunksAhead: 5,
    chunksBehind: 2,
    fallY: -60,                   // relative-to-road death plane depth for holes
  },

  // ─────────────────────────────────────────────────────────────────── player
  player: {
    startMass: 5000,              // kg
    minMass: 1500,                // decay floor. Must stay above crate threshold * 1.5
                                  // (1200) so a punished player can always still break
                                  // *something* and rebuild — otherwise a bad run spirals
                                  // into an unwinnable state that never ends.
    maxMass: 400000,
    baseRadius: 1.2,              // at startMass
    radiusExp: 0.33,              // radius = baseRadius * (mass/startMass)^radiusExp
    width: 2.6,                   // cylinder length along its (lateral) axis at startMass
    widthExp: 0.28,
    // Growth has to stop somewhere: the narrowest gap the generator will ever
    // author is minGapLanes * 4 m, and the roller must still fit through it with
    // room to aim. Radius is capped for the same reason on the Z axis.
    maxWidth: 6.0,
    maxRadius: 3.6,

    // downhill motion
    baseTopSpeed: 32,             // m/s at startMass
    topSpeedExp: 0.10,            // topSpeed = base * (mass/start)^exp
    topSpeedCap: 62,
    dragCoef: 1.18,              // tuned so cruise on the base slope sits just under topSpeed
    accelAssist: 14,              // extra downhill push so the roller regains speed after a block
    airControlScale: 0.35,        // lateral authority while airborne

    // lateral steering (direct, not force-based)
    baseLateralSpeed: 15.5,       // m/s at startMass
    lateralSpeedExp: 0.15,        // lateralSpeed = base * (start/mass)^exp
    lateralAccelTime: 0.12,       // s to reach full lateral speed at startMass
    lateralDecelTime: 0.17,       // s to stop (slightly slower — feels weighty)
    lateralAccelExp: 0.25,        // accel /= (mass/start)^exp
    edgeSoftness: 1.4,            // units of soft push-back at the road edge

    // tuck
    tuckDuration: 0.45,
    tuckCooldown: 2.0,
    tuckWidthScale: 0.55,
    tuckAccel: 12,               // extra downhill accel while tucking
    tuckSpeedBonus: 1.12,        // top speed multiplier while tucking
  },

  // ───────────────────────────────────────────────────────────── mass economy
  mass: {
    pickupValues: [250, 1000, 5000],
    pickupMagnetRadius: 3.0,
    pickupMagnetForce: 26,
    pickupBobAmp: 0.25,
    pickupBobSpeed: 2.2,
    pickupSpin: 1.6,
    blockedMassLoss: 0.15,        // fraction of mass lost on a BLOCKED hit
    hudTickTime: 0.35,            // s for the HUD mass counter to catch up
  },

  // ──────────────────────────────────────────────────── collision resolution
  collision: {
    pulverizeRatio: 1.5,          // player_mass > threshold * ratio  → PULVERIZE
    pulverizeSpeedLoss: 0.03,
    plowSpeedLoss: 0.20,
    blockedSpeedRetain: 0.06,     // speed kept after a blocker
    blockedRebound: 9.0,          // m/s bounce back up the hill
    blockedLockout: 0.28,         // s of no-steer after a block
    blockedGrace: 1.2,            // s after a block during which further blocks still
                                  // stop you but cost no mass. Without this, rebounding
                                  // into the same wall bills you 15 % again and again.
    // NEGATIVE on purpose. Props are drawn from a few boxes and their AABB
    // over-covers the real silhouette, so an exact test punishes near-misses that
    // visually cleared. This game is generous about near-misses everywhere else
    // (see the pickup magnet); it should be generous here too.
    contactPadding: -0.15,
    recentHitMemory: 0.25,        // s an object stays in the "already hit" set
  },

  // ────────────────────────────────────────────────────────────────── camera
  camera: {
    baseDistance: 14,
    maxDistance: 20,
    baseHeight: 5.2,
    maxHeight: 7.4,
    lookAhead: 7.0,               // how far down the hill the camera aims
    lookHeight: 1.0,
    smoothTime: 0.15,             // critically-damped follow (s)
    fovMin: 60,
    fovMax: 78,
    fovKickAmount: 4,
    fovKickTime: 0.12,
    distanceMassExp: 0.22,        // camera pulls back as you grow
    near: 0.3,
    far: 900,
  },

  // ──────────────────────────────────────────────────────────── screen shake
  shake: {
    decay: 1.5,                   // trauma units per second
    maxTrauma: 1.0,
    posMagnitude: 0.85,
    rotMagnitude: 0.055,          // radians
    frequency: 22,
    traumaPulverize: 0.30,
    traumaPlow: 0.42,
    traumaBlocked: 0.75,
    traumaLanding: 0.22,
    traumaMassExp: 0.18,          // shake scales with player mass
  },

  // ────────────────────────────────────────────────────────────── time / juice
  time: {
    hitstopMin: 0.040,            // s
    hitstopMax: 0.090,
    hitstopMassRef: 25000,        // object mass that earns max hitstop
    hitstopBlocked: 0.11,
    slowmoKills: 5,               // kills within slowmoWindow to trigger
    slowmoWindow: 1.0,
    slowmoScale: 0.4,
    slowmoDuration: 0.5,
    slowmoEaseOut: 0.35,
    slowmoCooldown: 3.5,
  },

  // ─────────────────────────────────────────────────────────────── destruction
  destruction: {
    maxFragments: 250,
    fragmentLifePhysics: 1.5,     // s of simulation
    fragmentLifeFade: 1.0,        // s of shrink-out after freezing
    fragmentGravity: -26,
    fragmentDrag: 0.55,
    fragmentRestitution: 0.32,
    fragmentFriction: 0.72,
    fragmentSpin: 9.0,
    impulseBase: 9.0,             // radial impulse from impact point
    impulsePlayerVelShare: 0.55,  // how much of player velocity fragments inherit
    plowImpulseScale: 0.45,       // PLOW throws debris much softer
    upBias: 4.5,

    // ── fragment integrator (src/fx/fragments.js)
    impulseFalloff: 1.7,          // m — radial impulse falls to 1/2 at this distance
    impulseJitter: 2.4,           // m/s of random scatter per axis
    fragmentAngularDrag: 0.5,     // per-second damping on spin
    fragmentSleepSpeed: 1.1,      // m/s below which a grounded fragment freezes
    fragmentScaleJitter: 0.08,    // ±fraction on each fracture piece's scale
    fragmentMinScale: 0.05,       // m — floor on any fragment axis
    fragmentSink: 0.55,           // m the frozen fragment sinks while shrinking out
    fragmentMaxPerSpawn: 20,      // hard cap on pieces taken from one PropDef
    fragmentCastShadow: true,     // debris casts shadows (turn off for low quality)
  },

  // ──────────────────────────────────────────────────────────────── particles
  particles: {
    maxAlpha: 420,                // soft/alpha-blended budget (dust, smoke)
    maxAdditive: 420,             // additive budget (sparks, glints, flash)
    dustRateBase: 26,             // particles/s at rest contact
    dustRateSpeed: 3.2,           // extra particles/s per m/s
    dustLife: [0.55, 1.1],
    dustSize: [0.55, 1.6],
    burstPulverize: 26,
    burstPlow: 14,
    burstBlocked: 10,
    sparkCount: 18,
    flashLife: 0.08,
    flashSize: 7.0,

    // ── integrator + look (src/fx/particles.js)
    gravity: -13,                 // m/s^2 applied to a particle with gravityScale 1
    dragAdditive: 1.7,            // per-second velocity damping for the additive layer
    dragAlpha: 2.3,               // …and for the soft/alpha layer
    popInTime: 0.045,             // s of fade-in so nothing appears at full brightness
    fadePowAdditive: 1.7,         // alpha = (life/lifeMax)^pow — higher = snappier out
    fadePowAlpha: 1.15,
    burstSpeedJitter: 0.55,       // ± fraction on emitBurst speed
    burstSizeJitter: 0.45,        // ± fraction on emitBurst size
    burstLifeJitter: 0.3,         // ± fraction on emitBurst life
    burstGrowAdditive: -0.35,     // size multiplier delta over the particle's life
    burstGrowAlpha: 0.85,
    burstSpin: 4.0,               // ± rad/s of billboard roll
    dustGravity: -1.5,            // dust barely falls — it hangs and drifts
    dustDrag: 2.7,
    dustRise: 1.15,               // m/s of upward drift baked into every dust particle
    dustGrow: 1.4,                // dust puffs expand as they fade
    dustSpeedJitter: 0.6,
    sparkSpeed: 27,               // m/s
    sparkSpeedJitter: 0.7,
    sparkSpread: 0.5,             // 0 = along the given direction, 1 = full sphere
    sparkLife: [0.16, 0.44],
    sparkSize: 0.2,
    sparkStretch: 6.0,            // length multiplier along the velocity at full speed
    sparkGravityScale: 1.7,
    sparkDrag: 0.9,
    sparkColorHot: 0xfff2d2,
    sparkColorCool: 0xff7a1e,
    flashGrow: 1.9,               // the flash disc expands hard as it dies
    flashHaloScale: 2.1,          // second, dimmer disc behind the core
    flashHaloGain: 0.45,
    maxSizeWorld: 14,             // clamp so a bad call can't fill the screen
    renderOrder: 12,              // above the world, below the HUD
  },

  // ───────────────────────────────────────────────────────────────── scoring
  score: {
    comboWindow: 2.0,             // s before combo decays
    comboMax: 99,
    massToScore: 0.05,            // base points = threshold * this
    minPoints: 10,
    pulverizeBonus: 1.0,
    plowBonus: 0.6,
    distancePoints: 1.0,          // points per metre travelled
  },

  // ──────────────────────────────────────────────────────────────── generation
  gen: {
    warmupChunks: 3,              // pure Warmup at the start of a run
    tensionCooldown: 1,           // high-tension chunks must be separated by >= this
    difficultyRampDistance: 2600, // metres to reach full difficulty
    holeMinReactionTime: 1.5,     // s of visibility at current speed (validated at spawn)
    pickupGenerosityBase: 0.75,
    pickupGenerosityRamp: 0.5,    // added at full difficulty

    // ── chunk layout (src/world/chunks.js)
    // Two conventions below: [easy, hard] pairs are lerped by difficulty01;
    // [min, max] pairs are inclusive integer ranges rolled per chunk.
    chunkTypeWeights: {           // [easy, hard] picker weight per chunk type
      warmup:   [1.40, 0.12],
      traffic:  [1.00, 1.55],
      gauntlet: [0.15, 1.25],
      buffet:   [1.10, 1.00],
      chasm:    [0.08, 1.15],
      jump:     [0.45, 0.95],
    },
    maxLaneShiftPerRow: 2,        // lanes crossable inside one 10 m grid row
    laneShiftPerMetre: 0.10,      // lanes crossable per metre of straight running
    propEdgeMargin: 0.15,         // m of road edge every prop must stay clear of
    propGap: 0.9,                 // m of clearance required between two props
    blockerGap: 0.04,             // …except blockers, which butt up into a wall
    rampMargin: 2.0,              // m of clearance around a ramp
    placeAttempts: 14,            // rejection-sampling tries per prop
    heavyPropDifficulty: 0.45,    // difficulty at which bus/tower start appearing
    lightMixEasy: [0.55, 0.30, 0.15],   // glass, crate, fence — early hill
    lightMixHard: [0.35, 0.35, 0.30],   // …and late hill
    vehicleMixEasy: [0.80, 0.18, 0.02], // sedan, suv, bus — early hill
    vehicleMixHard: [0.34, 0.42, 0.24], // …and late hill
    heavyMix: [0.62, 0.38],             // bus, water tower
    pickupBigChance: [0.02, 0.10],  // [easy, hard] chance of the 5000 kg pickup
    pickupMidChance: [0.15, 0.30],  // [easy, hard] chance of the 1000 kg pickup
    warmupProps: [4, 8],          // [min, max] props per warmup chunk
    warmupPickups: [2, 4],        // [min, max] before generosity scaling
    trafficRows: [3, 4],          // [min, max] rows of parked vehicles
    trafficGapLanes: [2, 1],      // [easy, hard] free lanes per row
    trafficSidewaysChance: 0.14,  // chance a vehicle is parked across the road
    trafficPickups: [2, 4],
    gauntletRows: [3, 4],         // [min, max] walls of blockers
    // Gap widths are in LANES (4 m each) and must never fall below minGapLanes:
    // a one-lane gap is 4 m, and by the time the hill is at full difficulty the
    // roller is 5-6 m wide, so a one-lane gap is not "hard", it is impassable.
    minGapLanes: 2,
    gauntletOpenLanes: [3, 2],    // [easy, hard] open lanes per wall
    gauntletPillarChance: 0.35,   // a blocked lane sealed by a pillar pair instead
    gauntletProps: [2, 5],        // destructibles sprinkled between the walls
    gauntletPickups: [1, 3],
    buffetWaves: [4, 6],          // [min, max] ranks of destructibles
    buffetPerWave: [3, 5],
    buffetCarChance: [0.05, 0.55], // [easy, hard] chance a buffet slot is a vehicle
    buffetPickups: [2, 4],
    chasmFirstRow: 2,             // holes never start before this grid row
    chasmRows: [3, 5],            // [min, max] holed rows
    chasmBridgeLanes: [3, 2],     // [easy, hard] bridge width in lanes
    chasmDriftChance: 0.55,       // chance the bridge steps a lane each row
    chasmProps: [1, 3],
    chasmPickups: [2, 4],
    jumpRampD: [16, 34],          // [min, max] metres into the chunk
    jumpRampWidth: 6.5,
    jumpRampLength: 9,
    jumpRampHeight: 2.6,          // world-space rise from the ramp entry to its lip
    jumpBlockerChance: [0.35, 0.85], // [easy, hard] sail-over blocker present
    jumpBlockerOffset: [6, 11],   // [min, max] m past the ramp end (under the arc)
    jumpSideProps: [2, 5],
    jumpPickups: [2, 4],
  },

  // ────────────────────────────────────────────────────────────────── audio
  audio: {
    masterGain: 0.85,
    sfxGain: 0.9,
    musicGain: 0.42,
    uiGain: 0.6,
    maxVoices: 24,
    duckAmountDb: -4,
    duckAttack: 0.02,
    duckHold: 0.2,
    duckRelease: 0.5,
    pitchJitter: 0.12,            // ±12%
    gainJitterDb: 2,              // ±2 dB
    massPitchExp: 0.15,           // pitch *= (startMass/mass)^exp
    subFreqRange: [40, 60],
    debrisTailWindow: 0.4,        // s over which tail one-shots scatter
    variantsPerLayer: 5,          // generated samples per material per layer
    rollingBaseGain: 0.24,
    rollingCutoffMin: 180,        // Hz at rest
    rollingCutoffMax: 2400,       // Hz at top speed
    windGainMax: 0.3,
    comboScale: [0, 2, 4, 7, 9],  // pentatonic steps (semitones)
    comboRootHz: 523.25,          // C5
    limiterThresholdDb: -3,

    // ── impact layering
    bodyDelay: 0.015,             // s, body layer lags the transient
    transientGain: 0.90,
    bodyGain: 0.75,
    subGain: 1.00,
    debrisGain: 0.42,
    debrisDelay: 0.045,           // s before the tail starts scattering
    debrisCountMin: 2,
    debrisCountMax: 5,
    debrisWindowMax: 10,          // hard cap on tail one-shots per impact window
    subMassExp: 0.30,             // sub gain *= (1 + massTerm*this)
    subRetrigger: 0.14,           // s — hits closer than this swell the live sub
    densityTau: 0.35,             // s — decay of the "how busy is it" estimate
    densityDebrisCut: 0.65,       // fraction of the debris tail dropped when busy
    subSwellExp: 0.45,            // sub gain *= count^this within one window
    subSwellMax: 2.4,
    objectPitchExp: 0.09,         // rate *= (objectPitchRef/objectMass)^this
    objectPitchRef: 4000,
    rateMin: 0.45,
    rateMax: 2.20,
    impactWindow: 0.05,           // s — impacts inside this read as ONE event
    impactCrowdExp: 0.55,         // per-voice gain /= (count)^this
    maxLayerVoices: 3,            // identical layers allowed per window
    duckMassThreshold: 9000,      // object mass that auto-ducks the music
    voiceStealFade: 0.008,        // s de-click ramp when stealing a voice
    plowGainScale: 0.82,
    plowRateScale: 0.92,
    blockedSubBoost: 1.25,

    // ── combo / pickup / misc one-shots
    comboMaxOctaves: 3,           // octave ceiling. At 1 the ding stopped rising at
                                  // combo 6 and combo 11 was bit-identical to it —
                                  // the sound players chase has to keep climbing.
    comboGain: 0.60,
    comboSparkleAt: 8,            // combo at which an octave sparkle is layered in
    pickupGain: 0.55,
    jumpGain: 0.55,
    landGain: 0.85,

    // ── continuous layers (rolling.js)
    rollingMassGain: 0.55,        // rumble gain *= (1 + massTerm*this)
    rollingRateExp: 0.16,         // rumble playback rate *= (1/massRatio)^this
    rollingToneHz: 90,            // resonant body peak at start mass
    rollingSmoothing: 0.0004,     // damp() smoothing/s for rumble params
    windSmoothing: 0.0015,
    droneHarmonic: 16,            // rotation rate × this = audible drone pitch
    droneGainMax: 0.30,
    droneHzMin: 20,
    droneHzMax: 120,
    windCutoffMin: 500,
    windCutoffMax: 3200,
    airborneRumbleScale: 0.06,

    // ── procedural music (music.js)
    musicBpm: 148,
    musicLookahead: 0.12,         // s scheduled ahead of the clock
    musicSchedulerMs: 25,         // scheduler timer period
    musicLayerThresholds: [0, 0.30, 0.55, 0.80],  // drums, bass, arp, pad
    musicLayerMix: [1.0, 0.85, 0.55, 0.45],       // relative level of each layer
    musicLayerWidth: 0.15,        // intensity span over which a layer fades in
    musicLayerFade: 0.80,         // s crossfade when a layer gates in
    musicBlockedFade: 0.10,       // s to strip back to drums
    musicComboFull: 12,           // combo at which intensity reads 1.0
    musicFilterMinHz: 320,        // fully-swept (slow-mo) cutoff
    musicFilterMaxHz: 20000,      // open
    musicStartDelay: 0.06,

    // ── sample replacement
    howlPoolSize: 6,
  },

  // ──────────────────────────────────────────────────────────────── post fx
  post: {
    enabled: true,
    bloomStrength: 0.55,
    bloomRadius: 0.7,
    bloomThreshold: 0.82,
    vignetteStrength: 0.5,
    chromaticMaxPixels: 2.0,
    chromaticDecay: 5.5,
    // Cruise on the base slope already sits at ~0.96 of top speed, so a 0.7
    // threshold left the streaks on permanently. They should mark a genuine burst
    // — a steep section or a tuck — not ordinary rolling.
    speedLinesThreshold: 0.88,    // fraction of top speed
    speedLinesStrength: 0.20,
    blockedVignetteTime: 0.45,
    flashDecay: 7.0,

    // ── composite look (src/render/post.js)
    bloomResolutionScale: 0.5,    // internal bloom RT scale (0.5 = half res)
    vignettePower: 2.2,           // vignette falloff exponent (1 = linear, higher = tighter to the corners)
    speedLinesCount: 46,          // radial streaks around the full circle (rounded to an even number)
    speedLinesInner: 0.60,        // normalised radius (0 centre, 1 corner) where streaks fade
                                  // in. It is a vignette: the centre stays clear.
    speedLinesWidth: 0.24,        // max streak half-width in cell units (< 0.5 or streaks merge)
    speedLinesRepeat: 3.2,        // dash cycles along the radius
    speedLinesScroll: 2.6,        // outward dash scroll (cycles/s) at full speed
    // The player still has to steer through this flash, so the centre of the
    // frame has to stay readable. Strong at the edges, light in the middle.
    damageStrength: 0.72,         // how far the BLOCKED vignette pushes toward red at t=1
    damageInner: 0.04,            // red still tints the screen centre by this fraction
    flashLevel: 3.0,              // linear-space white the flash blends toward (pre tone-mapping)
  },

  // ──────────────────────────────────────────────────────────────── graphics
  gfx: {
    fogNear: 90,
    fogFar: 460,
    shadowsDefault: true,
    shadowMapSize: 2048,
    pixelRatioCap: 2,
    lowQualityPixelRatio: 1,
    instanceCapPerProp: 220,
  },

  // ────────────────────────────────────────────────────────── hud / screens
  ui: {
    // ── mass readout (the "truck scale"). Catch-up rate is mass.hudTickTime.
    massDigits: 6,                // fixed-width reel; leading zeros stay dim
    massPunchScale: 1.10,         // scale punch when the target mass jumps up
    massPunchTime: 0.22,          // s

    // ── combo
    comboMin: 2,                  // multiplier is hidden below this
    comboPunchScale: 1.32,
    comboPunchTime: 0.20,         // s

    hudFadeTime: 0.20,            // s fade when the HUD shows/hides

    // ── pooled world-space score popups
    popupCount: 24,               // pooled DOM nodes, never more
    popupLife: 1.10,              // s
    popupRise: 4.6,               // m/s initial upward world velocity
    popupGravity: -3.4,           // m/s^2 — the arc turns over
    popupDrift: 0.9,              // ± m/s lateral scatter
    popupCullMargin: 96,          // px off-screen before a popup is parked

    // ── screens
    startPulseTime: 1.7,          // s breathing period on the start plate
    restartPulseTime: 0.85,       // s pulse period on [R] RESTART
    volumeDefaults: [0.9, 1.0, 0.85],  // master, sfx, music sliders on boot
    defaultQuality: 'high',
    lowQualityOnCoarsePointer: true,   // phones/tablets boot in low quality
  },

  // ─────────────────────────────────────────────────────────────── input
  input: {
    touchDragUnitsPerPixel: 0.055,
    touchDeadzonePx: 4,
    keyboardSmoothing: 0.0,       // raw; smoothing lives in the steering model
  },
};

/** Convenience: mass ratio versus the starting mass. */
export function massRatio(mass) {
  return mass / TUNING.player.startMass;
}
