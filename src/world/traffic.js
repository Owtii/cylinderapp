import { TUNING } from '../tuning.js';
import { clamp, moveTowards } from '../core/math.js';
import { Rng } from '../core/rng.js';
import { PROPS, outlineScale } from './objects.js';
import { speedAtWeight } from './trackplan.js';
import { laneX, ROAD_HALF } from './track.js';

/**
 * TONNAGE — living traffic (§17).
 *
 * Everything else on the ramp is furniture waiting to be hit. Traffic is the part
 * of the world that knows you are coming.
 *
 * Vehicles travel DOWNHILL, ahead of the player, at roughly 60 % of whatever speed
 * the player is currently doing. That single number changes how the game is played
 * more than its size suggests:
 *
 *   • the closing speed is only 40 % of the player's, so a moving car reads as a
 *     gentler, more deliberate target than a parked one at the same weight — you
 *     have time to decide, and the decision is a lead, not a dodge;
 *   • you have to aim at where a thing is GOING rather than where it is, which is
 *     the first steering skill in the game that is not "avoid";
 *   • and because they are still on the ramp when you arrive, a hit throws them
 *     into each other. See `shove`.
 *
 * THE SCATTER. Three seconds out, the traffic notices. Horns, brake flares, and a
 * hard swerve for the shoulder — most of it clears the centre lanes and piles into
 * the outer ones, which is exactly where the risk lanes already put the valuable
 * objects, so the panic hands the player a greed decision rather than an empty road.
 * The bold ones leave the ramp entirely and get away with their weight. The slow
 * ones do not make it. Nothing else in the game says "unstoppable" as cheaply as a
 * world that visibly tries to get out of the way and mostly fails.
 *
 * WHAT THIS MODULE IS NOT. It does not play audio, draw brake lights, spawn
 * particles or touch the score. It publishes an event queue (`events`) that the
 * audio layer drains, and it exposes records in exactly the shape `WorldStream`
 * uses so game.js's collision loop reads traffic and parked props through the same
 * code path with no branch. The only field that distinguishes them is `moving`.
 *
 * COLOUR. §6.1 gives saturated red to the outline system alone, so panicking
 * traffic gets NO red brake light. The panic signal is the swerve itself — the yaw
 * into the lane change is large, early and unmistakable at speed — plus a `flare`
 * scalar on the record that a renderer may show as a WHITE reversing-light pulse.
 * A white flare on a desaturated car is more legible at 40 m/s than a red one and
 * cannot be confused with an outline.
 *
 * Nothing here allocates after `reset`, and `reset` allocates nothing after the
 * constructor: the schedule is a set of preallocated flat arrays that are refilled
 * per run, and the live vehicles are a fixed pool.
 */

/** Event kinds published on `events`, for the audio layer to hook. */
export const TRAFFIC_EVENT = { HORN: 0, BRAKE: 1, CRASH: 2, ESCAPE: 3 };

/* Traffic only ever wears a vehicle silhouette, so it draws from these keys rather
   than the whole catalogue — `pickVisual` would happily hand a 170 kg target a
   wooden crate, and a crate doing 20 m/s down the fast lane is not traffic.
   §17's furniture, set-piece parts and the fuel tanker are excluded by flag as well
   as by tier: the tanker in particular is authored OUT of the truck tier precisely
   so this nearest-weight pick cannot turn every heavy vehicle into one. */
const VEHICLE_KEYS = Object.keys(PROPS).filter((k) => {
  const p = PROPS[k];
  if (p.blocker || p.furniture || p.tanker || p.setPiece) return false;
  return p.tier === 'car' || p.tier === 'truck';
});

const EVENT_CAP = 32;

/* Which of the three panic responses a vehicle picked. See `_panic`. */
const EVADE_NONE = 0;
const EVADE_FREEZE = 1;
const EVADE_SWERVE = 2;
const EVADE_BOLT = 3;

export class TrafficSystem {
  constructor(propRenderer, profile) {
    this.props = propRenderer;
    this.profile = profile;

    const T = TUNING.traffic;
    const pool = T.poolSize;
    const cap = T.scheduleCapacity;

    this._rng = new Rng(1);
    this._live = new Array(pool);
    for (let i = 0; i < pool; i++) this._live[i] = makeVehicle();
    this._liveCount = 0;

    // The authored schedule: one entry per vehicle, laid out over the whole track
    // up front so the run's traffic weight is a known number rather than whatever
    // a per-frame dice roll happened to produce.
    this._sd = new Float32Array(cap);        // spawn distance along the ramp
    this._sw = new Float32Array(cap);        // kg
    this._ss = new Float32Array(cap);        // visual scale
    this._sn = new Float32Array(cap);        // nerve, 0..1-ish: who gets away
    this._sf = new Float32Array(cap);        // speed as a fraction of the player's
    this._sk = new Uint8Array(cap);          // index into VEHICLE_KEYS
    this._sl = new Uint8Array(cap);          // lane
    this._sz = new Uint8Array(cap);          // zone
    this._sc = new Uint16Array(cap);         // cluster id — a clump reads as one thing
    this._scount = 0;
    this._clusterSeq = 0;
    this._cursor = 0;

    // Scratch for the per-zone weight solve. Sized to the largest zone count the
    // tuning table can ask for so the solve never allocates.
    this._zw = new Float64Array(cap);
    this._seen = new Uint16Array(pool);      // distinct clump ids inside the near band

    this._ev = {
      count: 0,
      type: new Uint8Array(EVENT_CAP),
      x: new Float32Array(EVENT_CAP),
      y: new Float32Array(EVENT_CAP),
      z: new Float32Array(EVENT_CAP),
      level: new Float32Array(EVENT_CAP),
      weight: new Float32Array(EVENT_CAP),
    };

    this.plannedWeight = 0;      // kg the schedule put on the ramp
    this.absorbedWeight = 0;     // kg the player actually ate
    this.missedWeight = 0;       // kg that escaped or fell behind unbroken
    this.missedCount = 0;
    this.escapedCount = 0;
    this.smashed = 0;
    this.pileups = 0;            // cascade links resolved this run
    this.reservedVisible = 0;    // see `reserve`
    this.reservedNear = 0;
  }

  // ── authoring ───────────────────────────────────────────────────────────────

  /**
   * Lay out a run's worth of traffic over the plan.
   *
   * Two constraints decide every weight in here and they pull against each other.
   * The whole schedule has to sum to `weights.highwayTrafficBudget`, because §17's
   * content is what makes gold reachable and a subsystem quietly over- or
   * under-spending its share moves the medal ladder. And every single vehicle has
   * to stay PAPER against the weight the player will realistically be carrying when
   * they meet it — traffic swerves into your line, and something that swerves into
   * you must never be able to cost a strike.
   *
   * So the per-zone share is fixed by the tuning table, the vehicle count is fixed,
   * and the individual weights are jittered for variety and then NORMALISED back
   * onto the share. The budget is met exactly; the variety is free.
   */
  reset(plan) {
    for (let i = 0; i < this._liveCount; i++) this._retire(this._live[i], false);
    this._liveCount = 0;
    this._cursor = 0;
    this._scount = 0;
    this._clusterSeq = 0;
    this._ev.count = 0;
    this.plannedWeight = 0;
    this.absorbedWeight = 0;
    this.missedWeight = 0;
    this.missedCount = 0;
    this.escapedCount = 0;
    this.smashed = 0;
    this.pileups = 0;
    this.plan = plan;
    if (!plan || !plan.zones || plan.zones.length === 0) return;

    const T = TUNING.traffic;
    const rng = this._rng.reseed(((plan.seed >>> 0) ^ 0x7a4f1c3b) >>> 0);
    const budget = TUNING.weights.highwayTrafficBudget;
    const cap = this._sd.length;

    // Shares are normalised rather than trusted to add to one, so editing a single
    // entry in the tuning table cannot silently change the total.
    let shareSum = 0;
    for (let z = 0; z < plan.zones.length; z++) shareSum += zoneShare(z);

    let carry = 0;               // kg a zone's paper ceiling refused, pushed forward
    for (let z = 0; z < plan.zones.length && this._scount < cap; z++) {
      const zone = plan.zones[z];
      const count = Math.min(zoneCount(z), cap - this._scount);
      if (count <= 0) continue;

      const share = budget * (zoneShare(z) / shareSum) + carry;
      carry = 0;

      // Raw draws first: mostly ordinary cars, with the occasional heavy so the
      // late zones are not a procession of identical hatchbacks. Zones 0 and 1 are
      // excluded from heavies because there the player is light enough that 2.6x
      // the zone's nominal could cross the paper line.
      let raw = 0;
      for (let i = 0; i < count; i++) {
        let w = rng.range(1 - T.weightJitter, 1 + T.weightJitter);
        if (z >= T.heavyFromZone && rng.next() < T.heavyChance) w *= T.heavyMultiplier;
        this._zw[i] = w;
        raw += w;
      }

      // Normalise onto the share, then hold every vehicle under the paper ceiling.
      // The ceiling has never bitten at the shipped numbers; it is here so that
      // retuning a zone's share can never turn traffic into a strike.
      const paperCap = Math.max(T.minWeight, zone.arriveWeight * T.paperCeiling);
      let placed = 0;
      for (let i = 0; i < count; i++) {
        let w = snapWeight(this._zw[i] * (share / raw), T.weightStep);
        if (w < T.minWeight) w = T.minWeight;
        if (w > paperCap) w = paperCap;
        this._zw[i] = w;
        placed += w;
      }

      // Close the zone's share exactly on the heaviest vehicle, which is the one
      // with room to absorb the rounding without changing its tier.
      let big = 0;
      for (let i = 1; i < count; i++) if (this._zw[i] > this._zw[big]) big = i;
      const residual = share - placed;
      const adjusted = clamp(this._zw[big] + residual, T.minWeight, paperCap);
      carry = share - (placed - this._zw[big] + adjusted);
      this._zw[big] = adjusted;

      // Distribution along the zone: evenly spaced with jitter, starting a little
      // way in. A vehicle spawned on a zone's first metre appears in the middle of
      // the previous zone's read, which is the one place the player is planning.
      //
      // Some of it CLUMPS. Evenly spaced traffic is a metronome, and worse, it can
      // never pile up: a shove has nothing within reach to pass itself on to. A
      // clump of three or four abreast is one decision to read (pick a lane, they
      // are all paper) and the only arrangement from which one hit produces a
      // six-car wreck, which is the thing players screenshot.
      const span = Math.max(40, zone.dEnd - zone.dStart);
      const head = span * T.zoneHeadFraction;
      const usable = span - head - span * T.zoneTailFraction;
      let ci = 0, clusterSize = 0, baseD = 0, laneMask = 0, convoy = T.speedFactor;
      for (let i = 0; i < count; i++) {
        if (ci >= clusterSize) {
          clusterSize = 1;
          if (rng.next() < T.clusterChance) clusterSize = 2 + Math.floor(rng.next() * (T.clusterMax - 1));
          if (clusterSize > count - i) clusterSize = count - i;
          const t = (i + clusterSize * 0.5 + rng.spread(T.spacingJitter)) / count;
          baseD = zone.dStart + head + clamp(t, 0, 1) * usable;
          laneMask = 0;
          ci = 0;
          // One cruising speed per clump. Per-vehicle jitter looks harmless and is
          // not: a 0.08 spread on the speed factor is 4 m/s at zone speed, which
          // pulls a clump 40 m apart over the ten seconds it spends in front of
          // the player. The clump would still be authored and would never once be
          // seen — and nothing could ever pile up.
          convoy = T.speedFactor + rng.spread(T.speedFactorJitter);
          this._clusterSeq++;
        }
        const w = this._zw[i];
        const k = pickVehicleKey(w);
        const s = clamp(Math.cbrt(w / PROPS[VEHICLE_KEYS[k]].weight), T.scaleMin, T.scaleMax);
        const lane = pickFreeLane(rng, laneMask);
        laneMask |= 1 << lane;
        const n = this._scount++;
        this._sd[n] = baseD + (ci - (clusterSize - 1) * 0.5) * T.clusterGap;
        this._sw[n] = w;
        this._ss[n] = s;
        this._sk[n] = k;
        this._sl[n] = lane;
        this._sn[n] = rng.range(T.nerveMin, T.nerveMax);
        this._sf[n] = convoy;
        this._sz[n] = z;
        this._sc[n] = this._clusterSeq & 0xffff;
        this.plannedWeight += w;
        ci++;
      }
    }

    // The schedule is authored zone by zone, but admission walks it in ramp order.
    insertionSortSchedule(this);
  }

  // ── the frame ───────────────────────────────────────────────────────────────

  /**
   * @param {number} dt seconds
   * @param {number} playerD travel distance along the ramp
   * @param {number} playerX lateral position — the traffic flees AWAY from this
   * @param {number} playerSpeed m/s; vehicles cruise at a fraction of it
   * @param {number} playerWeight kg; sets the streaming window, as in WorldStream
   * @returns {number} live vehicle count
   */
  update(dt, playerD, playerX, playerSpeed, playerWeight) {
    this._ev.count = 0;
    if (!this.plan) return 0;

    const R = TUNING.read;
    const window = Math.max(10, speedAtWeight(playerWeight));
    const far = playerD + R.fadeInSeconds * window;

    this._admit(playerD, far, playerSpeed);
    this._drive(dt, playerD, playerX, playerSpeed);
    this._cascade();
    this._retirePass(playerD);
    this._enforceBudget(playerD, Math.max(10, playerSpeed));
    this._writeTransforms();
    return this._liveCount;
  }

  get live() { return this._live; }
  get liveCount() { return this._liveCount; }
  /** Flat pooled queue, valid until the next `update`. Read it, do not retain it. */
  get events() { return this._ev; }

  /** Weight still ahead of the player that has neither been eaten nor escaped. */
  remainingWeight(playerD) {
    let t = 0;
    for (let i = this._cursor; i < this._scount; i++) t += this._sw[i];
    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      if (v.alive && !v.escaped && v.d >= playerD) t += v.weight;
    }
    return t;
  }

  /** The player absorbed this vehicle. Mirrors `WorldStream.consume`. */
  consume(rec) {
    if (!rec || !rec.alive) return;
    rec.alive = false;
    this.smashed++;
    this.absorbedWeight += rec.weight;
    if (rec.handle >= 0) { this.props.free(rec.key, rec.handle); rec.handle = -1; }
  }

  /**
   * Knock a vehicle sideways — and let it take its neighbours with it (§17).
   *
   * The impulse is handed straight to the vehicle rather than integrated through a
   * solver: a shoved car is a prop with a velocity and a spin, not a rigid body,
   * because the only thing the player reads from a pileup is the shape of it.
   *
   * `depth` is the whole safety story. A shove originating from the player is depth
   * 0; each car it strikes takes depth + 1 and loses `cascadeLoss` of the energy;
   * at `cascadeMaxDepth` a car still tumbles but can no longer pass the shove on.
   * Combined with the `shoved` flag (a car is only ever recruited into a cascade
   * once) the recursion is bounded at first contact — there is no chain to run away
   * with, and the six-car pileup is the ceiling as well as the goal.
   *
   * @param {object} rec the vehicle to shove
   * @param {number} vx world-space lateral impulse, m/s
   * @param {number} vz world-space longitudinal impulse, m/s (+z is BACK up the ramp)
   * @returns {boolean} true if this vehicle was recruited
   */
  shove(rec, vx, vz, depth) {
    if (!rec || !rec.alive || rec.shoved) return false;
    const T = TUNING.traffic;
    rec.shoved = true;
    rec.depth = depth === undefined ? 0 : depth;
    rec.panicked = true;
    rec.panic = 1;
    rec.flare = T.flareTime;
    rec.vx = clamp(rec.vx + vx, -T.shoveMaxSpeed, T.shoveMaxSpeed);
    // d runs against z, so a shove down the ramp arrives as negative vz.
    rec.speed = clamp(rec.speed - vz, 0, T.shoveMaxSpeed);
    const spin = this._rng.range(T.shoveSpinMin, T.shoveSpinMax);
    rec.spin = this._rng.bool() ? spin : -spin;
    this._emit(TRAFFIC_EVENT.CRASH, rec, Math.min(1, (Math.abs(vx) + Math.abs(vz)) / T.shoveMaxSpeed));
    return true;
  }

  /**
   * Shove everything inside a radius — the player's own impact wash, and the hook
   * §17's fuel tankers need for their detonation. Strength falls off linearly so a
   * car on the far edge is nudged rather than launched.
   */
  shockwave(x, z, radius, strength) {
    let n = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      if (!v.alive || v.shoved) continue;
      const dx = v.cx - x;
      const dz = v.cz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const dist = Math.sqrt(d2) || 0.001;
      const fall = 1 - dist / radius;
      const k = strength * fall * fall;
      if (this.shove(v, (dx / dist) * k, (dz / dist) * k, 0)) n++;
    }
    return n;
  }

  /**
   * Reserve part of §6.1's global object budget for the parked world.
   *
   * Traffic and `WorldStream` each hold their own list, so neither can see the
   * other's count. Left alone, traffic keeps to its own share (`traffic.maxVisible`
   * / `maxNear`), and the two shares are sized to add up. Calling this in front of
   * `update` each frame with the streamer's live counts makes the joint cap exact
   * rather than merely sound.
   */
  reserve(visibleUsed, nearUsed) {
    this.reservedVisible = visibleUsed | 0;
    this.reservedNear = nearUsed | 0;
  }

  dispose() {
    for (let i = 0; i < this._liveCount; i++) this._retire(this._live[i], false);
    this._liveCount = 0;
    this.plan = null;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  _admit(playerD, far, playerSpeed) {
    const T = TUNING.traffic;
    while (this._cursor < this._scount && this._sd[this._cursor] <= far) {
      const i = this._cursor;
      // A vehicle whose slot went by while the pool was full is gone: spawning it
      // level with the player would be a car materialising inside the roller.
      if (this._sd[i] < playerD + T.minSpawnAhead) {
        this.missedWeight += this._sw[i];
        this.missedCount++;
        this._cursor++;
        continue;
      }
      if (this._liveCount >= this._live.length) break;
      // No instance, no vehicle. A traffic record without a drawn body would be a
      // car you crash into that was never on screen, which is the one failure this
      // system is not allowed to have.
      const handle = this.props.alloc(VEHICLE_KEYS[this._sk[i]]);
      if (handle < 0) {
        this.missedWeight += this._sw[i];
        this.missedCount++;
        this._cursor++;
        continue;
      }
      this._spawn(i, playerSpeed, handle);
      this._cursor++;
    }
  }

  _spawn(i, playerSpeed, handle) {
    const T = TUNING.traffic;
    const key = VEHICLE_KEYS[this._sk[i]];
    const def = PROPS[key];
    const v = this._live[this._liveCount++];
    const sc = this._ss[i];
    const d = this._sd[i];
    const y = this.profile.heightAt(d);
    const x = laneX(this._sl[i]);

    v.id = TRAFFIC_ID_BASE + i;
    v.key = key; v.def = def; v.weight = this._sw[i]; v.scale = sc;
    v.role = 'TRAFFIC'; v.blocker = false; v.zone = this._sz[i]; v.moving = true;
    v.outline = outlineScale(key);
    v.d = d; v.x = x; v.y = y; v.z = -d; v.lane = this._sl[i];
    v.baseRotY = 0; v.yaw = 0; v.rotY = 0;
    v.halfWidth = def.size[0] * 0.5 * sc;
    v.halfHeight = def.size[1] * 0.5 * sc;
    v.halfLen = def.size[2] * 0.5 * sc;
    v.ex = v.halfWidth; v.ey = v.halfHeight; v.ez = v.halfLen;
    v.cx = x; v.cy = y + v.halfHeight; v.cz = -d;
    v.alive = true; v.cooldown = 0; v.visible = true; v.labelled = false;
    v.outcome = 'CLEAN'; v.colourT = 0; v.fade = 0;
    // Already at cruising speed: these cars have been driving down this hill for
    // an hour. Spawning them from rest would put a third of every vehicle's life
    // into an acceleration ramp and drag the measured convoy speed well under the
    // 60 % the whole design rests on.
    v.speedFactor = this._sf[i];
    v.speed = Math.max(T.minSpeed, playerSpeed) * v.speedFactor;
    v.vx = 0; v.targetX = x;
    v.nerve = this._sn[i];
    v.cluster = this._sc[i];
    v.panic = 0; v.panicked = false; v.flare = 0; v.horned = false;
    v.shoved = false; v.depth = 0; v.spin = 0; v.escaped = false; v.evade = EVADE_NONE;
    v.driftTimer = this._rng.range(T.driftPeriodMin, T.driftPeriodMax);
    v.handle = handle;
  }

  /** Integrate every live vehicle: cruise, drift, panic, tumble. */
  _drive(dt, playerD, playerX, playerSpeed) {
    const T = TUNING.traffic;
    const cruiseRef = Math.max(T.minSpeed, playerSpeed);

    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      if (!v.alive) continue;
      if (v.cooldown > 0) v.cooldown -= dt;
      if (v.flare > 0) v.flare -= dt;

      if (v.shoved) {
        // A wreck coasts. It keeps whatever the impact gave it, bleeds off through
        // drag, and spins flat on the road — the only rotation `PropRenderer.place`
        // exposes, and the only one a car sliding on its wheels would show anyway.
        //
        // Exponential drag never actually reaches zero, so it is snapped: a wreck
        // that has stopped has to STOP, or it creeps down the ramp forever at a
        // millimetre a second and the pileup slowly walks away from where it
        // happened.
        const decay = Math.exp(-T.shoveDrag * dt);
        v.vx *= decay;
        v.speed *= decay;
        v.yaw += v.spin * dt;
        v.spin *= decay;
        if (Math.abs(v.vx) < T.settleEpsilon) v.vx = 0;
        if (v.speed < T.settleEpsilon) v.speed = 0;
        if (Math.abs(v.spin) < T.settleEpsilon) v.spin = 0;
      } else {
        // ── the scatter: do they see you yet?
        const closing = playerSpeed - v.speed;
        const gap = v.d - playerD;
        const ttc = closing > 0.5 ? gap / closing : Infinity;
        if (!v.panicked && ttc < T.scatterSeconds) this._panic(v, playerX);

        if (v.panicked) {
          v.panic = v.panic < 1 ? Math.min(1, v.panic + dt / T.panicRamp) : 1;
        } else {
          // ── idle lane drift, so the traffic is never a static queue
          v.driftTimer -= dt;
          if (v.driftTimer <= 0) {
            v.driftTimer = this._rng.range(T.driftPeriodMin, T.driftPeriodMax);
            if (this._rng.next() < T.driftChance) {
              const dir = this._rng.bool() ? 1 : -1;
              const lane = clamp(v.lane + dir, 0, TUNING.world.laneCount - 1);
              v.lane = lane;
              v.targetX = laneX(lane);
            }
          }
        }

        // Longitudinal: bolters accelerate away, swervers lift off, freezers stand
        // on the brakes. Braking is what decides who dies — it cuts the time they
        // have left to cross the road, so the panic response and the escape chance
        // are the same number.
        const factor = v.panicked
          ? v.speedFactor * (v.evade === EVADE_BOLT ? T.boltFactor
            : v.evade === EVADE_SWERVE ? T.brakeFactorSwerve : T.brakeFactorFreeze)
          : v.speedFactor;
        const want = Math.max(T.minSpeed * 0.4, cruiseRef * factor);
        const rate = want < v.speed ? T.brakeAccel : T.accel;
        v.speed = moveTowards(v.speed, want, rate * dt);

        // Lateral: proportional approach, so a vehicle settles into its target lane
        // instead of oscillating across it.
        const capLat = v.panicked ? T.evadeLateralSpeed * v.nerve * v.panic : T.driftLateralSpeed;
        const wantVx = clamp((v.targetX - v.x) * T.lateralGain, -capLat, capLat);
        v.vx = moveTowards(v.vx, wantVx, T.lateralAccel * dt);
      }

      v.d += v.speed * dt;
      v.x += v.vx * dt;
      v.z = -v.d;
      v.y = this.profile.heightAt(v.d);

      // The yaw IS the panic signal (§6.1 keeps red for the outline system, so there
      // is no brake light to read). Steering angle from lateral velocity, plus the
      // tumble a shoved wreck carries.
      v.rotY = v.baseRotY + v.yaw
        + clamp(-v.vx * T.yawPerLateral, -T.yawMax, T.yawMax);

      const c = Math.abs(Math.cos(v.rotY));
      const s = Math.abs(Math.sin(v.rotY));
      v.ex = c * v.halfWidth + s * v.halfLen;
      v.ez = s * v.halfWidth + c * v.halfLen;
      v.ey = v.halfHeight;
      v.cx = v.x; v.cy = v.y + v.halfHeight; v.cz = v.z;

      // Clear of the ramp and out of the roller's reach: it got away, with its
      // weight. This is the only way a vehicle leaves the run intact, and it is
      // supposed to sting a little.
      if (!v.escaped && Math.abs(v.x) - v.halfWidth > ROAD_HALF + T.escapeClearance) {
        v.escaped = true;
        this.escapedCount++;
        this._emit(TRAFFIC_EVENT.ESCAPE, v, 1);
      }
    }
  }

  /**
   * Begin evasive action.
   *
   * Everyone runs from the player's side of the road, not from their own nearest
   * edge — a car that swerves into your line because the maths said the left shoulder
   * was closer reads as the game cheating, however defensible the arithmetic.
   *
   * Three responses, decided by nerve, and the spread between them is the whole
   * point of the scatter:
   *
   *   BOLT   — off the ramp entirely. Gets away with its weight.
   *   SWERVE — for the outer lane, still on the road. This is what makes the scatter
   *            a gift rather than a loss: it empties the centre and stacks the weight
   *            into the risk lanes, so collecting it becomes the standing greed
   *            decision §16.5 already built the outer lanes for.
   *   FREEZE — stands on the brakes in its own lane and dies there. Roughly a quarter
   *            of the traffic, so a player who drives straight down the middle still
   *            eats some of it, and "slow ones do not make it" is literal.
   */
  _panic(v, playerX) {
    const T = TUNING.traffic;
    const n = TUNING.world.laneCount;
    let side = v.x - playerX;
    if (Math.abs(side) < 0.5) side = v.x >= 0 ? 1 : -1;
    side = side >= 0 ? 1 : -1;

    v.panicked = true;
    v.panic = 0;
    if (v.nerve >= T.boltNerve) {
      v.evade = EVADE_BOLT;
      v.targetX = side * (ROAD_HALF + v.halfWidth + T.escapeClearance + T.exitOvershoot);
    } else if (v.nerve >= T.swerveNerve) {
      // Two lanes over, not all the way to the verge. Sending every swerver to the
      // outermost lane pins the whole scatter against both kerbs, and a player who
      // follows the panic then finds a wall on one side and an empty road on the
      // other. A two-lane shift spreads the survivors across the outer HALF of the
      // road, which is what makes chasing the scatter a line rather than a choice
      // between two extremes.
      v.evade = EVADE_SWERVE;
      v.lane = clamp(v.lane + side * T.swerveLanes, 0, n - 1);
      v.targetX = laneX(v.lane);
      v.flare = T.flareTime;                   // the white light: they are braking
      this._emit(TRAFFIC_EVENT.BRAKE, v, 1 - v.nerve);
    } else {
      v.evade = EVADE_FREEZE;
      v.targetX = v.x;
      v.flare = T.flareTime;
      this._emit(TRAFFIC_EVENT.BRAKE, v, 1);
    }
    if (!v.horned && this._rng.next() < T.hornChance) {
      v.horned = true;
      this._emit(TRAFFIC_EVENT.HORN, v, clamp(v.nerve, 0.3, 1));
    }
  }

  /**
   * The pileup.
   *
   * The player's own wash starts some of these (see `shockwave`), but most pileups
   * start with the traffic itself. The scatter sends a braking car and a bolting car
   * through the same piece of road three seconds apart in intent and half a second
   * apart in fact, and they hit each other. That is the version worth having: it
   * happens IN FRONT of the player, in clear view, caused by them but not by their
   * bumper, and it leaves a field of stationary wrecks to drive through.
   *
   * One O(n^2) sweep over at most `poolSize` vehicles, which at 24 is a few hundred
   * compares and cheaper than any structure that would avoid them.
   *
   * Termination is structural rather than checked. A vehicle can only be recruited
   * into a wreck once (`shove` refuses a car that is already shoved), so the pass can
   * never revisit its own work; `depth` rises by one along every chain and a car at
   * `cascadeMaxDepth` still tumbles but can no longer pass the shove on; and nothing
   * here recurses. The six-car pileup is the ceiling as well as the goal.
   */
  _cascade() {
    const T = TUNING.traffic;
    const n = this._liveCount;
    for (let i = 0; i < n; i++) {
      const a = this._live[i];
      if (!a.alive) continue;
      // A car cannot rear-end four cars in the same sixtieth of a second. Capping
      // the fan-out per pass is what keeps a dense clump reading as a chain of
      // impacts you can follow rather than one frame in which everything explodes.
      let fanout = 0;
      for (let j = i + 1; j < n && fanout < T.cascadeFanout; j++) {
        const b = this._live[j];
        if (!b.alive) continue;
        // Calm traffic does not crash into itself. Without this gate a lane drift
        // that put two cars in the same lane would read as a random explosion.
        if (a.shoved && b.shoved) continue;
        if (!a.shoved && !b.shoved && !a.panicked && !b.panicked) continue;
        if (Math.abs(a.cx - b.cx) > a.ex + b.ex) continue;
        if (Math.abs(a.cz - b.cz) > a.ez + b.ez) continue;
        if (Math.abs(a.cy - b.cy) > a.ey + b.ey) continue;

        // A wreck always does the hitting; between two upright cars it is whoever
        // is going faster.
        let hit = a, got = b;
        if (b.shoved && !a.shoved) { hit = b; got = a; }
        else if (!a.shoved && !b.shoved && b.speed > a.speed) { hit = b; got = a; }
        if (hit.shoved && hit.depth >= T.cascadeMaxDepth) continue;

        const rel = Math.abs(hit.speed - got.speed) + Math.abs(hit.vx - got.vx);
        if (rel < T.cascadeMinSpeed) continue;

        // Momentum goes one way and is lossy, which is what stops a pileup from
        // ringing: each link is quieter than the one before it.
        const push = hit.cx >= got.cx ? -1 : 1;
        const vx = (Math.abs(hit.vx) * T.cascadeLoss + T.cascadeSpread) * push;
        const depth = hit.shoved ? hit.depth + 1 : 0;
        if (this.shove(got, vx, -rel * T.cascadeLoss, depth)) { this.pileups++; fanout++; }
        if (hit.shoved) {
          hit.vx *= T.cascadeLoss;
          hit.speed *= T.cascadeLoss;
        } else {
          this.shove(hit, -vx * 0.5, rel * T.cascadeLoss * 0.4, depth);
        }
      }
    }
  }

  /** Anything behind the player is finished with, one way or the other. */
  _retirePass(playerD) {
    const behind = playerD - TUNING.traffic.retireBehind;
    let w = 0;
    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      if (v.alive && v.d >= behind) {
        if (i !== w) swap(this._live, i, w);
        w++;
        continue;
      }
      if (v.alive) this._retire(v, true);
      else this._retire(v, false);
    }
    this._liveCount = w;
  }

  _retire(v, counted) {
    if (counted && v.alive) {
      this.missedWeight += v.weight;
      this.missedCount++;
    }
    v.alive = false;
    if (v.handle >= 0) { this.props.free(v.key, v.handle); v.handle = -1; }
  }

  /**
   * §6.1's caps, applied to traffic's own share of them.
   *
   * The policy is `WorldStream._enforceBudget`'s: drop the least valuable, never
   * something the player is about to have to deal with. Two deliberate differences.
   *
   * Traffic has no blockers, so the protected class is instead anything mid-event —
   * a car in the middle of its swerve or tumbling through a pileup. Culling the
   * thing that just got hit is the one drop a player would definitely notice.
   *
   * And a culled vehicle is RETIRED rather than hidden. WorldStream leaves a dropped
   * object alive and collidable with its instance freed, which is survivable for a
   * parked crate at the edge of the window; for traffic it would mean driving into
   * a car that is not drawn. So the cull only ever takes the vehicle FARTHEST ahead
   * — out past the near band, where removing it is invisible — and its weight is
   * booked as missed like any other object that got away.
   */
  _enforceBudget(playerD, speed) {
    const R = TUNING.read;
    const T = TUNING.traffic;
    const nearEnd = playerD + R.nearBandSeconds * speed;
    const maxVisible = Math.min(T.maxVisible, Math.max(0, R.maxVisibleObjects - this.reservedVisible));
    const maxNear = Math.min(T.maxNear, Math.max(0, R.maxNearObjects - this.reservedNear));

    let visible = 0;
    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      v.visible = v.alive && v.d >= playerD - 20;
      if (v.visible) visible++;
    }
    let near = this._nearClusters(playerD, nearEnd);

    let guard = 0;
    while ((visible > maxVisible || near > maxNear) && guard++ < this._live.length) {
      let victim = -1;
      let worst = -Infinity;
      for (let i = 0; i < this._liveCount; i++) {
        const v = this._live[i];
        if (!v.visible || v.shoved || v.panicked) continue;
        if (near > maxNear && v.d > nearEnd) continue;
        // Farthest first, cheapest to break a tie: distance is what makes the drop
        // invisible, weight is what makes it cheap.
        const score = (v.d - playerD) * 1000 - v.weight;
        if (score > worst) { worst = score; victim = i; }
      }
      if (victim < 0) break;
      // Take the whole clump, not one car out of the middle of it. A clump is a
      // single read; half a clump is a hole in one.
      const cluster = this._live[victim].cluster;
      for (let i = 0; i < this._liveCount; i++) {
        const v = this._live[i];
        if (!v.visible || v.cluster !== cluster) continue;
        visible--;
        this._retire(v, true);
        v.visible = false;
      }
      near = this._nearClusters(playerD, nearEnd);
    }

    // Compact out anything the cull killed, so `live[0..liveCount)` stays dense.
    let w = 0;
    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      if (!v.alive) continue;
      if (i !== w) swap(this._live, i, w);
      w++;
    }
    this._liveCount = w;
  }

  /**
   * Distinct clumps inside the near band.
   *
   * §6.1's near-band cap counts DECISIONS, and a clump of four cars abreast is one:
   * they are all paper, and the only choice is which lane to take them in. Counting
   * each car separately would have the cull delete the clump the moment it became
   * interesting, which is the opposite of what the cap is for. Vehicles still count
   * one for one against the VISIBLE cap, where the cost really is per silhouette.
   */
  _nearClusters(playerD, nearEnd) {
    const seen = this._seen;
    let n = 0;
    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      if (!v.visible || v.d > nearEnd) continue;
      let dup = false;
      for (let j = 0; j < n; j++) if (seen[j] === v.cluster) { dup = true; break; }
      if (!dup && n < seen.length) seen[n++] = v.cluster;
    }
    return n;
  }

  /**
   * Traffic is the one thing in the world that rewrites its instance matrices every
   * frame, which is why `PropRenderer.place` is cheap and why only live vehicles get
   * one — a hundred parked props still cost nothing.
   */
  _writeTransforms() {
    for (let i = 0; i < this._liveCount; i++) {
      const v = this._live[i];
      if (!v.alive || v.handle < 0) continue;
      this.props.place(v.key, v.handle, v.x, v.y, v.z, v.rotY, v.scale);
    }
  }

  _emit(type, v, level) {
    const ev = this._ev;
    if (ev.count >= EVENT_CAP) return;
    const n = ev.count++;
    ev.type[n] = type;
    ev.x[n] = v.x; ev.y[n] = v.cy; ev.z[n] = v.z;
    ev.level[n] = level;
    ev.weight[n] = v.weight;
  }
}

/* ─────────────────────────────────────────────────────────────────── helpers ── */

/** Traffic ids must not collide with plan object ids; labels key off them. */
const TRAFFIC_ID_BASE = 1000000;

function zoneShare(z) {
  const t = TUNING.traffic.zoneShare;
  return z < t.length ? t[z] : t[t.length - 1];
}

function zoneCount(z) {
  const t = TUNING.traffic.zoneCount;
  return z < t.length ? t[z] : t[t.length - 1];
}

function snapWeight(w, step) {
  return Math.max(step, Math.round(w / step) * step);
}

function swap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

/**
 * Lanes are drawn toward the middle of the road on purpose. The outer lanes already
 * carry the authored centrepieces and most of the blockers (§16.5), and parking
 * moving traffic on top of them would make both harder to read; it also leaves the
 * scatter somewhere to go.
 */
function pickLane(rng) {
  const n = TUNING.world.laneCount;
  const mid = (n - 1) / 2;
  let total = 0;
  for (let i = 0; i < n; i++) total += 1.3 - 0.5 * (Math.abs(i - mid) / mid);
  let r = rng.next() * total;
  for (let i = 0; i < n; i++) {
    r -= 1.3 - 0.5 * (Math.abs(i - mid) / mid);
    if (r <= 0) return i;
  }
  return n >> 1;
}

/** As `pickLane`, but never returns a lane already taken by this clump. */
function pickFreeLane(rng, mask) {
  const n = TUNING.world.laneCount;
  for (let tries = 0; tries < 8; tries++) {
    const lane = pickLane(rng);
    if (!(mask & (1 << lane))) return lane;
  }
  for (let lane = 0; lane < n; lane++) if (!(mask & (1 << lane))) return lane;
  return n >> 1;
}

/** Nearest vehicle silhouette in log-weight space, so a heavy draw looks heavy. */
function pickVehicleKey(weight) {
  const target = Math.log(Math.max(1, weight));
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < VEHICLE_KEYS.length; i++) {
    const score = Math.abs(Math.log(PROPS[VEHICLE_KEYS[i]].weight) - target);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/**
 * Sort the schedule by ramp distance.
 *
 * Zones are authored in order and each zone's entries are already ordered, so this
 * is a nearly-sorted array and insertion sort is one pass over it. It also sorts the
 * eight parallel arrays in place, which `Array.prototype.sort` cannot do without
 * building an index array — and this runs once per run, not per frame, but the rule
 * is the rule.
 */
function insertionSortSchedule(sys) {
  const n = sys._scount;
  for (let i = 1; i < n; i++) {
    const d = sys._sd[i], w = sys._sw[i], s = sys._ss[i], nv = sys._sn[i];
    const f = sys._sf[i], k = sys._sk[i], l = sys._sl[i], z = sys._sz[i], c = sys._sc[i];
    let j = i - 1;
    while (j >= 0 && sys._sd[j] > d) {
      sys._sd[j + 1] = sys._sd[j]; sys._sw[j + 1] = sys._sw[j];
      sys._ss[j + 1] = sys._ss[j]; sys._sn[j + 1] = sys._sn[j];
      sys._sf[j + 1] = sys._sf[j]; sys._sk[j + 1] = sys._sk[j];
      sys._sl[j + 1] = sys._sl[j]; sys._sz[j + 1] = sys._sz[j];
      sys._sc[j + 1] = sys._sc[j];
      j--;
    }
    sys._sd[j + 1] = d; sys._sw[j + 1] = w; sys._ss[j + 1] = s; sys._sn[j + 1] = nv;
    sys._sf[j + 1] = f; sys._sk[j + 1] = k; sys._sl[j + 1] = l; sys._sz[j + 1] = z;
    sys._sc[j + 1] = c;
  }
}

/**
 * The record shape.
 *
 * Everything above the divider is `WorldStream`'s record, field for field, because
 * game.js's collision loop, the outline system and the label system all walk both
 * lists with the same code. Everything below it is traffic's own state; nothing
 * outside this module reads it except `moving`, which is how a caller knows which
 * `consume` to call.
 */
function makeVehicle() {
  return {
    id: -1, key: '', weight: 0, scale: 1, role: 'TRAFFIC', blocker: false, zone: 0,
    d: 0, x: 0, y: 0, z: 0, lane: 0, rotY: 0,
    cx: 0, cy: 0, cz: 0, ex: 0, ey: 0, ez: 0,
    alive: false, cooldown: 0, visible: false, labelled: false,
    outcome: 'CLEAN', colourT: 0, fade: 0, handle: -1,
    // §17's three catalogue flags, carried so a consumer can walk this list and
    // WorldStream's through one code path — `outline` is a numeric multiplier and
    // an undefined here would reach the outline system as NaN. Traffic is never
    // furniture, a tanker or set-piece geometry (see VEHICLE_KEYS), so those three
    // are constant; `outline` comes from the catalogue in `_spawn`.
    furniture: false, tanker: false, setPiece: false, outline: 1,
    // ── traffic only ──────────────────────────────────────────────────────────
    def: null, moving: true,
    speed: 0, vx: 0, targetX: 0, nerve: 1, speedFactor: 0.6, driftTimer: 0,
    panic: 0, panicked: false, horned: false, flare: 0,
    shoved: false, depth: 0, spin: 0, yaw: 0, baseRotY: 0, escaped: false, evade: 0,
    cluster: 0,
    halfWidth: 0, halfHeight: 0, halfLen: 0,
  };
}
