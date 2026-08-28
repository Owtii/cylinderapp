/**
 * TONNAGE — every balance and feel number in the game, in one object.
 *
 * The master difficulty dial is `finale.houseWeight` against `weights.trackTotal`.
 * A perfect run absorbs the whole track; the house asks for ~71 % of it. Raise the
 * house to make the game demanding, lower it to make it forgiving, and playtest —
 * nothing else in here changes the difficulty as much.
 *
 * Modules import TUNING and read from it at call time (never destructure numbers
 * into module scope at import time) so live tweaking works.
 */

export const TUNING = {
  // ─────────────────────────────────────────────────────────── world / physics
  world: {
    gravity: -30,
    fixedStep: 1 / 60,
    maxStepsPerFrame: 5,
    // §6.1: "The highway never levels out and never climbs." v2 put a FLAT crest
    // (grade 0) between every zone for the preview beat — 302 m of the track. v3
    // replaces those with a steepening pitch-over, and the grade is now bounded on
    // BOTH sides: an acceptance criterion checks no segment is ever <= 0.
    minSlopeDeg: 8,
    maxSlopeDeg: 22,
    pitchOverDeg: 20,             // the brief preview surge at a zone boundary
    pitchOverSeconds: 1.6,        // long enough to read the zone below, short enough to feel
    baseSlopeDeg: 11,
    steepSlopeDeg: 17,
    finaleSlopeDeg: 21,           // the run-up steepens into the house
    laneCount: 5,
    laneWidth: 5.0,               // 5 lanes x 5 m = 25 m of play surface
    get roadWidth() { return this.laneCount * this.laneWidth; },
    segmentLength: 40,            // road/collider build granularity
    segmentsAhead: 14,            // ~560 m of built road in front
    segmentsBehind: 3,

    fallY: -60,                   // m below the ramp at which anything is considered lost
  },

  // ───────────────────────────────────────────────────────────────── the roller
  player: {
    startWeight: 500,             // kg
    baseRadius: 0.85,             // at startWeight
    radiusExp: 1 / 3,             // radius = baseRadius * (w/start)^(1/3)
    // Growth has to stop somewhere the level can still be threaded. The widest
    // gap the generator ever authors is 2 lanes, so the drum is capped to fit
    // through that with clearance to aim.
    maxRadius: 5.7,
    widthRatio: 1.55,             // drum length = radius * this

    baseTopSpeed: 26,             // m/s at startWeight
    topSpeedExp: 0.07,
    topSpeedCap: 46,
    dragCoef: 1.16,
    accelAssist: 13,
    airControlScale: 0.35,

    baseLateralSpeed: 15.0,       // m/s at startWeight
    lateralSpeedExp: 0.12,        // lateral = base * (start/w)^exp — heavy is committed
    lateralAccelTime: 0.12,       // s to full lateral speed
    lateralDecelTime: 0.16,
    edgeSoftness: 1.4,
    // The ceiling the audio and FX curves normalise against: everything on the
    // track, absorbed. Nothing clamps to it — it is the far end of the scale.
    get maxWeight() { return this.startWeight + TUNING.weights.trackTotal; },
  },

  // ──────────────────────────────────────────────── the one decision, per object
  collision: {
    // obj <  player * cleanRatio          -> CLEAN  (absorb, no speed cost)
    // obj <  player                       -> PLOW   (absorb, 25 % speed cost)
    // obj >= player                       -> BLOCKED(rebound, -10 % weight, strike)
    cleanRatio: 0.8,
    plowSpeedLoss: 0.25,
    plowRecoverTime: 1.0,
    blockedWeightLoss: 0.10,
    blockedSpeedRetain: 0.05,
    blockedRebound: 8.0,
    blockedLockout: 0.30,         // s of no-steer after a block
    // Per-axis, because §5 wants the early break and the near-miss reward wants the
    // late one, and they are about different axes. See collisions.js.
    contactPadLateral: -0.12,     // negative: near-misses stay near-misses
    contactPadApproach: 0.15,     // positive: it disintegrates before it touches you
    contactPadding: -0.12,        // retained: read by the headless balance harnesses
    hitCooldown: 0.7,             // s before the same object can hit again
    maxStrikes: 3,
  },

  // ───────────────────────────────────────────────────────── the weight budget
  //
  // Zone totals are the absorbable kilos each zone contributes. The track builder
  // fills each zone to its budget from that zone's tier plus a short lead-in of the
  // previous tier, so there is always something safe to eat on arrival.
  weights: {
    // `seconds` is the zone's target play time; the builder turns that into metres
    // using the speed the player will actually be doing there, so pacing stays
    // constant even though later zones are much faster.
    zones: [
      { tier: 'glass',     budget: 1000,  seconds: 22, feeders: 10, centreAt: 0.62, name: 'RESIDENTIAL', teaching: true },
      { tier: 'wood',      budget: 3000,  seconds: 24, feeders: 12, centreAt: 0.60, name: 'MARKET' },
      { tier: 'kiosk',     budget: 6000,  seconds: 26, feeders: 10, centreAt: 0.58, name: 'HIGH STREET' },
      { tier: 'car',       budget: 15000, seconds: 28, feeders: 10, centreAt: 0.58, name: 'TRAFFIC' },
      { tier: 'truck',     budget: 40000, seconds: 30, feeders: 11, centreAt: 0.56, name: 'FREIGHT YARD' },
      { tier: 'structure', budget: 75000, seconds: 32, feeders: 8,  centreAt: 0.55, name: 'INDUSTRIAL', gamble: true },
    ],
    // Each zone carries exactly ONE object heavy enough to be red when the zone
    // opens. That is not a stylistic choice, it is the ceiling the budget allows:
    // an amber object costs at least 0.8x your weight and eating it multiplies you
    // by 1.8, so with zone budgets of 1.15-2.0x the arrival weight there is only
    // ever room for one. It sits ~60 % through the zone, so whether it has turned
    // green by the time you reach it is a live read on how much you have caught.
    // Centrepiece weight as a fraction of the ideal arrival weight. At 1.0 the
    // centrepiece is RED the moment a zone opens and needs essentially every
    // preceding feeder to turn green, so missing two small objects locked a player
    // out of 77 % of the zone and the run never recovered. At 0.95 it opens AMBER,
    // turns green as you feed, and goes red only when you have genuinely fallen
    // behind — which is the read the outline system is for. Measured best curve.
    // ── the landmark ladder ─────────────────────────────────────────────────────
    //
    // Six centrepieces used to hold 73 % of the whole track, each sized at 0.95x the
    // weight you would have arriving on pace. That turned the run into six pass/fail
    // checks rather than an accumulation: measured over 24 seeds, a competent line
    // either ate all six and finished at ~135 % of the house, or fell behind once
    // and finished at ~33 %. Nine wins, fifteen collapses, essentially nothing in
    // between — and a collapse was decided in the first ninety seconds while three
    // minutes of ramp still had to be driven.
    //
    // A zone's weight now goes into a LADDER of landmarks plus its feeders. The top
    // rung is still the object you plan the zone around and still opens amber, but
    // it is no longer the zone: falling behind costs margin, and the rungs below it
    // are the rope you climb back up. This is also what makes the outline system do
    // real work — a zone you arrive at underweight shows red at the top and green at
    // the bottom, and turns greener as you feed.
    landmarkLadder: [0.42, 0.25, 0.16, 0.10, 0.07],
    landmarkShare: 0.62,          // fraction of a zone's budget held by landmarks
    landmarkMaxRatio: 0.78,       // no landmark exceeds this x the ideal arrival weight

    // §17's highway content is not decoration — it is absorbable weight, and it is
  // what makes the §16 medal ladder reachable without touching a single number in
  // §7's zone table. Split three ways so no one subsystem can quietly eat it all.
  highwayBudget: 35000,
  highwayFurnitureBudget: 8000,   // cones, bollards, signs — 20-80 kg each, pure texture
  highwayTrafficBudget: 20000,    // moving vehicles
  highwaySetPieceBudget: 7000,    // the six set pieces
  centreRatio: 0.95,
    // The generator rebuilds a track until a perfect pass could clear the house by
    // this margin. Without it, roughly one seed in twelve was unwinnable.
    winHeadroom: 1.12,
    feederSpread: [0.62, 1.38],   // feeder size jitter around the even share
    get trackTotal() {
      let t = 0;
      for (let i = 0; i < this.zones.length; i++) t += this.zones[i].budget;
      return t;                                            // 140,000 kg
    },
  },

  finale: {
    houseWeight: 100000,          // ~71 % of the track. THE difficulty dial.
    runUpLength: 430,             // m of empty, steepening ramp with the house in view
    slowMoLastSeconds: 3.0,
    slowMoScale: 0.7,
    holdWinShot: 3.0,
  },

  // Multiples of the house weight. The brief asked for 1.0 / 1.25 / 1.5, but a
  // perfect run absorbs 140,500 kg — 1.405x the house — so gold at 1.5 could not
  // be reached by any player. Silver and gold are pulled under that ceiling so
  // both are winnable, with gold demanding ~94 % of the whole track.
  // §16.2. Bronze is beating the house, silver 1.25x, gold 1.5x — the spec's
  // ratios, restored. In v2 these were unreachable: gold needs 150,000 kg and the
  // six zones only hold 140,000. v3's §17 highway content (furniture, traffic,
  // set pieces, tankers) carries `weights.highwayBudget` of real absorbable weight
  // ON TOP of the zone budgets, giving a 175,500 kg track where the three medals
  // land at 57 % / 71 % / 85 % of it — gold just under the measured DP ceiling.
  medals: { bronze: 1.0, silver: 1.25, gold: 1.5 },

  // ────────────────────────────────────────────────────── readability (§6, §6.1)
  read: {
    fadeInSeconds: 4.0,           // objects appear this many SECONDS of travel ahead
    labelSeconds: 2.5,            // labels fade in at this many seconds ahead
    nearBandSeconds: 2.0,
    maxVisibleObjects: 12,        // hard cap, enforced every frame
    maxNearObjects: 5,
    maxLabels: 8,                 // only the nearest N carry a label
    minFormationGapSeconds: 1.2,  // empty ramp between formations
    minFormationGapMetres: 26,    // floor, for the slow opening
    // A gap must fit the roller the player will realistically be driving there,
    // plus room to aim. Zones past this weight get two-lane gaps instead of one.
    twoLaneGapAboveWeight: 9000,
    // Slack beyond the drum's width. This was 1.6 m, which left the optimal line
    // threading 1.3 m corridors — fine for a solver, lethal for a human, because
    // brushing a blocker ends the run outright. A gap has to have room to aim at.
    gapClearance: 4.2,
    // Clearance a survivable line keeps from an instant-loss blocker. The
    // generator proves the track winnable along a line that respects this, so the
    // guarantee means something to a human rather than only to a solver.
    blockerSafeMargin: 1.5,
    // ── sweepable formations ────────────────────────────────────────────────
    // A formation that hands you weight in a line is only a reward if the line
    // can actually be followed. SIDE_FEED and STAGGER used a fixed 4.6 m / 6.5 m
    // step between objects a full lane (or the whole road) apart, which at 26 m/s
    // demands 28 m/s and 80 m/s of lateral speed against the 15 m/s the roller
    // has. A perfect solver could not collect them either — which is why the
    // winnability proof said 96 % and a bot driving straight at every object in
    // turn collected 5 %.
    //
    // So the d-step between two objects in a sweep is DERIVED: the metres of ramp
    // it takes to cross the lateral distance at `sweepComfort` of the roller's
    // lateral speed. Below 1.0 the sweep has slack to be driven imperfectly, and
    // 0.55 is what a hand-driven line actually holds while also aiming.
    // ── blockers ────────────────────────────────────────────────────────────
    // A blocker is an instant loss, so its density is not a texture knob: it is
    // the odds that a run ends before the house. At one gauntlet per four
    // formations with three blockers each a run carried ~17 lethal objects, and a
    // good line died on one in 4 runs out of 24 — more runs ended on a blocker
    // than at the finale, which is the wrong game. See the sweep in the commit
    // message; these values put instant loss at roughly 1 run in 10 for a good
    // line and leave the strike system as the failure currency it is meant to be.
    // The FIRST blocker of a run is a special case. It used to appear mid-way
    // through the second zone at 30 m/s with no prior exposure, and it killed a
    // quarter of otherwise-competent runs: of nine instant losses over 40 seeds,
    // five were within 60 m of the first blocker on the track. So the first
    // gauntlet gets one extra lane of corridor and arrives after an unusually long
    // empty stretch, alone, with nothing else competing for the read.
    firstGauntletExtraLanes: 1,
    firstGauntletLeadSeconds: 2.2,
    gauntletEveryFormations: 7,
    gauntletMaxBlockers: 2,
    sweepComfort: 0.55,
    sweepStepMin: 5.0,            // m of d between two objects in the same lane
    sweepSpanMax: 110,            // m a SWEEP formation may occupy (vs formationSpanMax)
    formationGapSeconds: 2.4,     // the pacing target; never below the 1.2 s minimum
    formationSpanMax: 26,         // m a single formation may occupy
    outlineLerpRate: 5.0,         // per second — the red -> amber -> green transition
    labelOverlapPush: 26,         // px of vertical offset when two labels collide
    decorClearance: 3.0,          // m outside the lane before scenery may exist
    blockerHumRadius: 46,         // m at which a blocker's warning hum fades in

    // ── outline glow shape (MODULE A, src/render/outlines.js) ───────────────
    // The ring is sized from the object's own footprint and then GROWN with
    // distance, because a ring that shrinks with perspective stops being legible
    // at exactly the range where the read matters most.
    outlineRingFootprint: 1.45,   // ring radius = footprint half-extent * this + 0.35
    outlineRingMinRadius: 1.15,   // m, so a bottle crate still gets a readable ring
    outlineRingMaxRadius: 5.0,    // m, so a water tower's ring does not swallow a lane
    outlineDistanceGain: 0.85,    // extra ring radius at the far edge of the window
    outlineDistanceBoost: 0.35,   // extra ring brightness at the far edge
    outlineRingLift: 0.07,        // m above the road surface, to beat z-fighting
    outlineRingIntensity: 1.0,    // additive gain for the ground ring
    outlineHaloIntensity: 0.55,   // additive gain for the billboarded halo — low
    outlineHaloScale: 1.7,        // halo size = (footprint + half height) * this
    outlineNearFadeMetres: 7.0,   // the halo bows out inside this, the ring stays

    // ── weight labels (MODULE A, src/game/labels.js) ────────────────────────
    maxBlockerLabels: 2,          // blockers are already unmistakable; cap their chips
    labelScaleNear: 1.15,         // label scale at zero distance
    labelScaleFar: 0.62,          // label scale at the far edge of the label window
    labelFadeFraction: 0.30,      // outer fraction of the window spent fading in
    labelMarginPx: 6,             // keep labels this far inside the viewport
  },

  // ─────────────────────────────────────────────────────────────── time / juice
  time: {
    hitstopMin: 0.040,
    hitstopMax: 0.090,
    hitstopWeightRef: 15000,      // object weight earning the longest freeze
    hitstopBlocked: 0.12,
    slowmoSmashes: 5,
    slowmoWindow: 1.0,
    slowmoScale: 0.4,
    slowmoDuration: 0.5,
    slowmoEaseOut: 0.35,
    slowmoCooldown: 3.0,
    zoneRecapSeconds: 1.0,
    zoneRecapScale: 0.55,
    crestHoldSeconds: 2.0,
  },

  // ────────────────────────────────────────────────────────────────── camera
  camera: {
    // Distance and height scale with the roller's radius so it always fills a
    // similar slice of screen; speed adds a little extra pull-back on top.
    distancePerRadius: 7.4,
    heightPerRadius: 3.5,
    minDistance: 9.0,
    minHeight: 4.4,
    speedPullback: 0.30,          // fraction of extra distance at top speed
    lookAheadSeconds: 1.4,
    lookHeight: 0.9,
    pitchLift: 0.30,              // raises the aim point so ~4 s of ramp stays visible
    smoothTime: 0.15,
    fovMin: 60,
    fovMax: 76,
    fovKickAmount: 4,
    fovKickTime: 0.12,
    // §5's paper punch. Deliberately small and deliberately brief: it fires on ~80 %
    // of all contacts, so anything bigger reads as a camera that will not sit still.
    fovPunchAmount: 2,
    fovPunchTime: 0.06,
    near: 0.3,
    far: 1200,
  },

  shake: {
    decay: 1.5,
    maxTrauma: 1.0,
    posMagnitude: 0.75,
    rotMagnitude: 0.05,
    frequency: 22,
    traumaClean: 0.28,
    traumaPlow: 0.44,
    traumaBlocked: 0.8,
    traumaLanding: 0.2,
    traumaWeightExp: 0.16,
  },

  // ─────────────────────────────────────────────────────────────── destruction
  destruction: {
    maxFragments: 250,
    fragmentLifePhysics: 1.5,
    fragmentLifeFade: 1.0,
    fragmentGravity: -26,
    fragmentDrag: 0.55,
    fragmentRestitution: 0.32,
    fragmentFriction: 0.72,
    fragmentSpin: 9.0,
    impulseBase: 9.0,
    impulsePlayerVelShare: 0.55,
    plowImpulseScale: 0.45,
    upBias: 4.5,
    // Debris must never obscure what is coming. Impulses are biased outward and
    // AWAY from the camera, and nothing is allowed to drift back toward it.
    lateralBias: 1.5,
    cameraAwayBias: 6.0,
    maxTowardCamera: 0,           // m/s of velocity permitted toward the camera

    // ── fragment bodies (src/fx/fragments.js) ───────────────────────────────
    fragmentMaxPerSpawn: 20,      // hard cap however big the object is
    fragmentMinScale: 0.05,       // m — below this a shard is a particle, not a body
    fragmentScaleJitter: 0.08,
    fragmentAngularDrag: 0.5,
    fragmentSleepSpeed: 1.1,      // m/s below which a shard stops integrating
    fragmentSink: 0.55,           // m/s a settled shard sinks before it is retired
    fragmentCastShadow: true,
    impulseFalloff: 1.7,          // impulse falls with distance^-this from the contact
    impulseJitter: 2.4,           // m/s of random scatter on every shard
  },

  particles: {
    maxAlpha: 420,
    maxAdditive: 420,
    dustRateBase: 24,
    dustRateSpeed: 3.0,
    // Dust is scaled by the DRUM, not by a constant. At the start of a run the
    // roller is 1.7 m across and a fixed 1.0-1.9 m puff buried it completely —
    // the first thirty seconds of the game were a cloud with a HUD over it. Now a
    // small drum kicks up small dust and a 11 m drum throws up a wall of it, which
    // is both what you would expect and what keeps the roller readable.
    dustSizePerRadius: 0.95,      // puff size = drum radius * this
    dustRatePerRadius: 0.55,      // extra emission per metre of radius, as a factor
    dustBehind: 1.15,             // drum radii behind the contact point dust spawns
    dustLife: [0.55, 1.1],
    dustSize: [0.55, 1.6],
    burstClean: 26,
    burstPlow: 14,
    burstBlocked: 10,
    sparkCount: 18,
    flashLife: 0.08,
    flashSize: 7.0,
    maxFlashesPerFrame: 6,

    // ── shared integration (src/fx/particles.js) ────────────────────────────
    gravity: -13,
    popInTime: 0.045,             // s of scale-up so nothing appears at full size
    maxSizeWorld: 14,             // m — a cap so a near-camera puff cannot fill frame
    renderOrder: 12,
    dragAlpha: 2.3,
    dragAdditive: 1.7,
    fadePowAlpha: 1.15,
    fadePowAdditive: 1.7,

    // ── dust ────────────────────────────────────────────────────────────────
    dustGravity: -1.5,
    dustDrag: 2.7,
    dustRise: 1.15,               // m/s of buoyancy so dust hangs behind the drum
    dustGrow: 1.4,
    dustSpeedJitter: 0.6,

    // ── impact burst ────────────────────────────────────────────────────────
    burstSpeedJitter: 0.55,
    burstSizeJitter: 0.45,
    burstLifeJitter: 0.3,
    burstSpin: 4,
    burstGrowAlpha: 0.85,
    burstGrowAdditive: -0.35,     // sparks shrink as they cool

    // ── sparks ──────────────────────────────────────────────────────────────
    sparkSpeed: 27,
    sparkSpeedJitter: 0.7,
    sparkSpread: 0.5,
    sparkLife: [0.16, 0.44],
    sparkSize: 0.20,
    sparkStretch: 6,              // velocity-aligned stretch, so sparks read as streaks
    sparkDrag: 0.9,
    sparkGravityScale: 1.7,
    sparkColorHot: 0xffef52,
    sparkColorCool: 0xff741e,

    // ── impact flash ────────────────────────────────────────────────────────
    flashGrow: 1.9,
    flashHaloScale: 2.1,
    flashHaloGain: 0.45,
  },

  // ─────────────────────────────────────────────────────────────────── scoring
  score: {
    chainIgniteAt: 10,            // consecutive smashes before the roller ignites
    nearMissDistance: 1.1,        // m of clearance that still counts as a near miss
    nearMissBoost: 2.6,           // m/s
    nearMissCooldown: 0.5,
  },

  // ─────────────────────────────────────────────────────────────────── audio
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
    pitchJitter: 0.12,
    gainJitterDb: 2,
    weightPitchExp: 0.10,         // pitch *= (startWeight/weight)^exp
    subFreqRange: [40, 60],
    debrisTailWindow: 0.4,
    variantsPerLayer: 5,
    rollingBaseGain: 0.24,
    rollingCutoffMin: 180,
    rollingCutoffMax: 2400,
    windGainMax: 0.3,
    limiterThresholdDb: -3,
    voiceStealFade: 0.02,         // s of fade when the pool steals a voice
    howlPoolSize: 6,              // only used if registerSamples() supplies files

    // ── the chain ding (bank key 'combo.ding') ──────────────────────────────
    // A rising pentatonic note per absorbed object, climbing with the chain. This
    // is the sound the player is actually chasing, so it must keep rising rather
    // than wrapping: two octaves of headroom before it plateaus.
    comboRootHz: 233.08,          // Bb3 — sits under the engine rumble, not in it
    comboScale: [0, 2, 4, 7, 9],  // major pentatonic
    comboMaxOctaves: 2,
    comboGain: 0.46,
    comboSparkleAt: 8,            // chain at which an octave sparkle is added
    absorbGain: 0.55,             // the bright coin tap ('absorb.coin')
    houseHitGain: 1.0,
    strikeGain: 0.80,             // the alarm layered over a blocked hit
    musicChainFull: 12,           // chain length that reads as full intensity
    subWeightExp: 0.90,           // how much heavier the player makes the sub
    rollingWeightGain: 0.85,      // extra rumble at maximum weight

    // ── bridge keys used by modules the v2 rewrite left in place ────────────
    // music.js layers on INTENSITY, while the v2 design layers on ZONE. The two
    // are bridged in audio/index.js: a zone sets an intensity FLOOR, and chain
    // pushes above it. These thresholds are therefore read as "how far down the
    // ramp", not "how long is your chain".
    musicLayerThresholds: [0.0, 0.28, 0.55, 0.78],
    musicLayerWidth: 0.16,        // crossfade width around each threshold

    // ── outcome shaping ─────────────────────────────────────────────────────
    // BLOCKED has to be the worst sound in the game: it is the only feedback for
    // the only mistake that costs a strike, and it must be unmistakable even when
    // six objects are shattering in the same frame. It gets there by SUBTRACTION,
    // not by weight — a block plays one dead 56 ms thud (`impact.blocked`) and is
    // denied the material layers, the sub and the debris tail entirely, so it is
    // the only event in the game with no low end. See src/audio/README.md.
    // (`blockedSubBoost` is retained only so an older manifest/tuning file still
    // loads; impacts.js never gives a block a sub to boost.)
    blockedSubBoost: 1.45,
    duckWeightThreshold: 3500,    // kg at which an impact ducks the music by itself

    // ── layered impacts (src/audio/impacts.js) ──────────────────────────────
    transientGain: 0.85,
    bodyGain: 0.78,
    bodyDelay: 0.015,             // s the material's voice trails the contact
    debrisGain: 0.40,
    debrisDelay: 0.05,
    debrisCountMin: 2,
    debrisCountMax: 6,
    debrisWindowMax: 14,          // debris one-shots allowed per impact window
    impactWindow: 0.05,           // s of impacts that collapse into one event
    impactCrowdExp: 0.55,         // per-voice gain falls as count^-exp
    maxLayerVoices: 4,            // transients / bodies per window
    densityTau: 0.35,             // s of the decaying impact-density estimate
    densityDebrisCut: 0.65,       // fraction of the tail dropped when it is busy
    rateMin: 0.55,
    rateMax: 1.85,
    objectPitchRef: 1500,         // kg an object plays back at rate 1
    objectPitchExp: 0.13,         // heavier objects pitch down by (ref/w)^exp
    plowRateScale: 0.88,
    plowGainScale: 0.80,
    // 'heavy' promotes to the 'structure' collapse signature above this weight.
    // The catalogue tags sheds, silos and water towers as `heavy` alongside
    // 6.5 t buses; weight is the only thing that separates them at the call site.
    structureWeightMin: 9000,

    // ── the sub layer: one live voice, swelling ─────────────────────────────
    subGain: 0.80,
    subRetrigger: 0.09,           // s inside which a hit swells the live sub
    subSwellExp: 0.42,
    subSwellMax: 2.1,

    // ── BLOCKED: deliberately the worst sound in the game ───────────────────
    // Dead, dull, short. No sub, no debris tail, no material voice — a blocked
    // hit plays exactly one dry thud and takes the music with it.
    blockedGain: 0.95,
    blockedDuckDb: -8,
    blockedDuckHold: 0.5,

    // ── strikes: escalating, alarming, one per strike ───────────────────────
    strikeSpacing: 0.115,         // s between the blips of one alarm
    strikeStepSemitones: 3,       // each blip in the burst climbs this far
    strikeStrikeSemitones: 2,     // each successive strike starts this much higher
    strikeGainPerStrike: 0.12,
    strikeFinalSemitones: -7,     // the last strike drops into a dread tone

    // ── absorb: the weight-gain chime that lands with the HUD counter ───────
    // `absorbGain` (above) is the low thunk under the ding; this is the bright
    // metallic coin tap on top of it — money landing on a steel counter.
    absorbCoinGain: 0.55,
    absorbSpacing: 0.045,         // s between coin taps
    absorbMaxTaps: 3,
    absorbTapSemitones: [0, 4, 7],
    absorbShareSemitones: -6,     // a big share of your weight lands fatter/lower
    absorbTillShare: 0.42,        // share above which the low till clunk lands
    absorbCrowdMax: 3,            // absorbs per impactWindow that get the full chime

    // ── one-shots ──────────────────────────────────────────────────────────
    jumpGain: 0.50,
    landGain: 0.80,

    // ── adaptive music (src/audio/music.js) ────────────────────────────────
    // One instrument layer per ZONE: drums, bass, arp, pad, stab, lead.
    musicBpm: 126,
    musicBpmPerZone: 3,           // the ramp speeds up as the zones escalate
    musicLookahead: 0.12,         // s scheduled ahead on the audio clock
    musicSchedulerMs: 25,
    musicStartDelay: 0.15,
    musicFilterMinHz: 300,        // fully swept (slow-motion)
    musicFilterMaxHz: 15000,      // open
    musicLayerMix: [0.95, 0.85, 0.50, 0.42, 0.46, 0.38],
    musicLayerFade: 0.90,         // s for a zone's new layer to arrive
    musicBlockedFade: 0.12,       // s to strip back to drums — fast, it is a punish
    musicChainBonusAt: 0.80,      // chain intensity that lends one extra layer
    musicBlockedHold: 2.4,        // s the strip-to-drums lasts after a block
    musicStoppedSpeed: 3.5,       // m/s below which the player counts as stopped

    // ── continuous layers (src/audio/rolling.js) ───────────────────────────
    rollingToneHz: 78,            // the drum's resonant body peak at startWeight
    rollingRateExp: 0.10,         // grain rate falls as (start/weight)^exp
    rollingSmoothing: 0.02,       // damp() smoothing per second
    airborneRumbleScale: 0.12,
    droneHzMin: 24,
    droneHzMax: 165,
    droneHarmonic: 3,             // drone = rotation rate * this
    droneGainMax: 0.16,
    windCutoffMin: 520,
    windCutoffMax: 2600,
    windSmoothing: 0.05,
    blockerHumGain: 0.15,         // the warning hum inside read.blockerHumRadius
    blockerHumHz: 46,
  },

  // ────────────────────────────────────────────────────────────────── post fx
  post: {
    enabled: true,
    bloomStrength: 0.55,
    bloomRadius: 0.7,
    bloomThreshold: 0.82,
    vignetteStrength: 0.5,
    chromaticMaxPixels: 2.0,
    chromaticDecay: 5.5,
    speedLinesThreshold: 0.86,
    speedLinesStrength: 0.20,
    speedLinesInner: 0.60,
    blockedVignetteTime: 0.45,
    flashDecay: 7.0,

    bloomResolutionScale: 0.5,
    vignettePower: 2.2,
    speedLinesWidth: 0.24,
    speedLinesRepeat: 3.2,
    speedLinesScroll: 2.6,
    speedLinesCount: 46,
    damageStrength: 0.72,
    damageInner: 0.04,
    flashLevel: 3,                // exposure stops added at full flash
  },

  gfx: {
    fogNear: 120,
    fogFar: 620,
    shadowsDefault: true,
    shadowMapSize: 2048,
    pixelRatioCap: 2,
    lowQualityPixelRatio: 1,
    instanceCapPerProp: 160,
    // Decorative scenery is pushed back visually so it never competes with the
    // lane: desaturated, darkened, and never outlined or labelled.
    decorSaturation: 0.4,
    decorBrightness: 0.62,
  },

  // ──────────────────────────────────────────────────── HUD, screens, run-end
  //
  // The weight counter is the only number the player has to hold in their head,
  // so it is the only thing in the HUD allowed to move. Everything else is
  // static furniture in the corners. `weightTickTime` is the whole feel of the
  // counter: too fast and a gain does not register, too slow and the number is
  // lying about what you weigh when you reach the next object.
  ui: {
    hudFadeTime: 0.18,            // s of HUD fade in / out
    weightDigits: 6,              // reel width — a perfect run reads 140,500 KG
    weightTickTime: 0.40,         // s for the mechanical roll to reach a new weight
    weightPunchScale: 1.055,      // counter punch when weight lands
    weightPunchTime: 0.22,
    targetPulseTime: 0.9,         // s the TARGET line flashes once it is passed
    strikePunchTime: 0.5,         // s a pip flashes as it is spent
    chainShowAt: 3,               // chain length before the counter appears at all
    chainPunchScale: 1.16,
    chainPunchTime: 0.18,
    popupCount: 16,               // pooled +weight nodes
    popupLife: 1.0,               // s of flight from the object into the counter
    popupHang: 0.30,              // fraction of that life spent rising off the object
    popupRise: 2.4,               // m/s of world lift while it hangs
    popupCullMargin: 160,         // px outside the viewport before a popup parks
    bannerTime: 1.7,              // s a zone recap banner holds
    bannerFade: 0.35,             // s of its fade-out
    volumeDefaults: [0.9, 1.0, 0.85],   // master, sfx, music
    defaultQuality: 'high',
    lowQualityOnCoarsePointer: true,
    startPulseTime: 2.2,          // s of the start button's breath
    restartPulseTime: 0.9,
  },

  // ───────────────────────────── the roller's own escalation (src/render/roller.js)
  //
  // Six per-zone surfaces on one silhouette. The blend rate is deliberately slow
  // enough that the player SEES the drum change during the crest between zones —
  // an instant swap reads as a glitch, a 1-second morph reads as an upgrade.
  roller: {
    zoneBlendRate: 1.15,          // per second — how fast one zone's surface morphs into the next
    crackSpreadRate: 1.9,         // per second — a new strike's cracks crawl outward at this rate
    igniteRate: 2.6,              // per second — chain-ignition fade in / out
    grooveCount: 15,              // circumferential grooves along the drum
    crackDepthTint: 0.055,        // how dark the inside of a fissure goes (linear rgb)
    crackRimLift: 1.55,           // how much brighter the chipped rim of a crack is
    crackEmissive: 0.34,          // so cracks survive shadow — the strike read must never vanish
    igniteEmissive: 0.55,         // white-hot energy in the grooves once the chain ignites
    moltenEmissive: 1.9,          // zone 5's incandescent fissure network
    // damp() coefficients — the fraction of the remaining distance still left after
    // one second. Kept alongside the rate form above so either easing style works.
    zoneEase: 0.0015,
    crackEase: 0.0004,
    igniteEase: 0.0009,
  },

  // ────────────────────────────────────── the house at the bottom (render/house.js)
  house: {
    // The run-up is 430 m long and the painted weight has to be recognisable as a
    // number from the top of it. At 430 m, one metre of letter height is roughly
    // two screen pixels at 1080p, so the sign has to be genuinely architectural:
    // an 8 m panel gives ~5 m capitals, ~11 px at the top of the ramp and fully
    // legible by the time the player is halfway down. The house is sized around
    // the sign rather than the other way round.
    width: 40,                    // m — wider than the 25 m road, so it is a wall, not a target
    height: 20,
    depth: 22,
    frontCols: 5,                 // front facade grid — the win punches its middle out
    frontRows: 3,
    signWidthFraction: 0.90,      // painted weight panel, as a fraction of the facade
    signHeight: 8.0,              // m tall — legible from the top of the 430 m run-up
    signCentreY: 0.42,            // fraction of house height — clear of the eaves and the door
    signPixelsPerMetre: 44,       // canvas resolution for the painted number
    collapseGravity: -24,
    collapseSpin: 2.6,            // rad/s of tumble on the punched pieces
    punchSpeed: 17,               // m/s the centre of the facade is driven backward
    punchSpread: 7.0,             // m/s of sideways scatter around the hole
    roofFallTime: 0.55,           // s before the roof lets go after the hole opens
    settleSeconds: 5.0,           // s after which everything has stopped moving
    holdShake: 0.85,              // m of facade shudder when the house holds
    holdShakeTime: 1.2,
    crackTime: 0.45,              // s for the loss cracks to finish spreading
  },

  // ─────────────────────────── scenery, strictly outside the lane (render/decor.js)
  //
  // Decor exists to be seen without being looked at. It is streamed, desaturated
  // (gfx.decorSaturation), darkened (gfx.decorBrightness) and never collidable, and
  // it starts no closer than read.decorClearance to the road edge.
  decor: {
    aheadMetres: 470,             // slightly past gfx.fogFar, so nothing pops in
    behindMetres: 80,
    spacingMin: 8,                // m between scenery items on one side
    spacingMax: 20,
    sideJitter: 15,               // m of extra outward scatter beyond the clearance
    vergeSlabLength: 24,          // m per flanking ground slab
    vergeWidth: 78,               // m of ground either side of the road
    // The road runs along a low causeway. The embankment is what makes "you cannot
    // drive there" obvious at a glance without a single collidable object.
    bankWidth: 7.0,               // m of sloped embankment off each road edge
    bankAngleDeg: 18,             // its pitch; the drop reads as ground, not as lane
    standoff: 20.0,               // m from the centreline before any scenery item stands
    maxBoxInstances: 1500,
    maxCylInstances: 520,
  },

  input: {
    touchDeadzonePx: 4,
  },
};

/** Convenience: how many times the starting weight the player is now. */
export function weightRatio(weight) {
  return weight / TUNING.player.startWeight;
}

/** The three outcomes, as one comparison. This is the whole game. */
export const CLEAN = 'CLEAN';
export const PLOW = 'PLOW';
export const BLOCKED = 'BLOCKED';

export function classify(playerWeight, objectWeight) {
  if (objectWeight >= playerWeight) return BLOCKED;
  if (objectWeight < playerWeight * TUNING.collision.cleanRatio) return CLEAN;
  return PLOW;
}
