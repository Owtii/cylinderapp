import * as THREE from 'three/webgpu';
import { TUNING, weightRatio, classify, CLEAN, PLOW, BLOCKED } from '../tuning.js';
import { clamp, clamp01, lerp, DEG } from '../core/math.js';
import { GameLoop } from '../core/loop.js';
import { fxRng } from '../core/rng.js';

import { Renderer } from '../render/renderer.js';
import { ChaseCamera } from '../render/camera.js';
import { RoadBuilder } from '../render/road.js';
import { PropRenderer } from '../render/props.js';
import { Roller } from '../render/roller.js';
import { Trail } from '../render/trail.js';
import { PostFX } from '../render/post.js';
import { OutlineSystem } from '../render/outlines.js';
import { House } from '../render/house.js';
import { Decor } from '../render/decor.js';

import { initPhysics, PhysicsWorld } from '../physics/world.js';
import { Player } from '../physics/player.js';
import {
  overlaps, computeImpactPoint, impactPoint, lateralClearance, hitstopFor, BLOCKER,
} from '../physics/collisions.js';

import { TrackProfile } from '../world/track.js';
import { buildTrackPlan, speedAtWeight } from '../world/trackplan.js';
import { WorldStream } from '../world/generator.js';
import { DebugOverlay } from './debug.js';
import { MATERIALS, PROPS } from '../world/objects.js';

import { ParticleSystem } from '../fx/particles.js';
import { FragmentSystem } from '../fx/fragments.js';

import { Score } from './score.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { LabelSystem } from './labels.js';
import { Screens } from '../ui/screens.js';
import { audio } from '../audio/index.js';

const BOOT = 'boot';
const MENU = 'menu';
const PLAYING = 'playing';
const PAUSED = 'paused';
const OVER = 'over';

/** Reused audio state — allocating this per frame would be 60 objects a second. */
/** Reused debug counters — same reason as AS below. */
const DBG = {
  visible: 0, near: 0, labels: 0, fragments: 0,
  gradeDeg: 0, weight: 0, speed: 0, zone: 0,
};

const AS = {
  speed: 0, speed01: 0, weight: 0, grounded: true,
  airborne: false, timeScale: 1, playing: false, chain: 0, zone: 0,
  blockerDistance: Infinity,
};

export class Game {
  constructor(container, hudRoot, screensRoot) {
    this.container = container;
    this.state = BOOT;

    this.renderer = new Renderer(container);
    this.profile = new TrackProfile();
    this.score = new Score();
    this.input = new Input(container);
    this.hud = new Hud(hudRoot);
    this.labels = new LabelSystem(hudRoot);
    this.debug = new DebugOverlay(hudRoot);
    this.screens = new Screens(screensRoot, {
      onStart: () => this.startRun(),
      onRestart: () => this.restart(),
      onResume: () => this.resume(),
      onQuit: () => this.toMenu(),
      onVolume: (kind, v) => this._applyVolume(kind, v),
      onQuality: (q) => this._applyQuality(q),
    });

    this.chase = new ChaseCamera(this.renderer.camera, (d) => this.profile.heightAt(d));
    this.loop = new GameLoop(
      (dt) => this.step(dt),
      (alpha, rawDt, scaledDt) => this.render(alpha, rawDt, scaledDt),
    );

    this.chromatic = 0;
    this.flash = 0;
    this.damage = 0;
    this.slowmoCooldown = 0;
    this.nearMissCooldown = 0;
    this.frameImpacts = 0;
    this.zoneShown = -1;
    this.houseResolved = false;
    this.holdTimer = 0;
    this.runTime = 0;
    this.booted = false;
    this.audio = audio;
  }

  async boot() {
    await initPhysics();
    this.physics = new PhysicsWorld();
    this.backend = await this.renderer.init();

    const scene = this.renderer.scene;
    this.road = new RoadBuilder(scene, this.physics, this.profile);
    this.props = new PropRenderer(scene);
    this.stream = new WorldStream(this.profile, this.road, this.props);
    this.player = new Player(this.physics);
    this.roller = new Roller(scene);
    this.trail = new Trail(scene);
    this.particles = new ParticleSystem(scene);
    this.fragments = new FragmentSystem(scene, (x, z) => this.stream.groundYAt(x, z));
    this.outlines = new OutlineSystem(scene);
    this.house = new House(scene);
    this.decor = new Decor(scene);

    try {
      this.post = new PostFX(this.renderer.renderer, scene, this.renderer.camera);
      this.post.setSize(this.renderer.width, this.renderer.height);
    } catch (err) {
      console.warn('Post-processing unavailable, rendering direct:', err);
      this.post = null;
    }
    this.renderer.onResize = (w, h) => { if (this.post) this.post.setSize(w, h); };

    this._applyQuality(this.screens.getSettings().quality);
    this.booted = true;
    this.state = MENU;
    this.screens.showStart();
    this.hud.setVisible(false);
    this.labels.setVisible(false);
    this._prepare((Math.random() * 0xffffffff) >>> 0);
    this.loop.start();
  }

  // ── run lifecycle ────────────────────────────────────────────────────────────
  _prepare(seed) {
    this.plan = buildTrackPlan(seed);
    this.stream.reset(this.plan);
    this.player.reset();
    this.stream.update(0, this.player.weight);
    this.physics.step();
    this.physics.step();
    this.player.y = this.profile.heightAt(0) + this.player.radius;
    this.player.prevY = this.player.y;

    this.chase.reset(this.player.x, this.player.y, this.player.z);
    this.roller.reset();
    this.trail.reset();
    this.particles.reset();
    this.fragments.reset();
    this.outlines.reset();
    this.labels.reset();
    this.debug.reset();
    this.score.reset();
    this.hud.reset();
    this.hud.setWeight(this.player.weight);
    this.hud.setTarget(TUNING.finale.houseWeight);
    this.hud.setStrikes(0, TUNING.collision.maxStrikes);
    this.decor.build(this.plan);
    this.house.reset();
    const hd = this.plan.house.d;
    this.house.place(0, this.profile.heightAt(hd), -hd, this.plan.house.weight);

    this.chromatic = 0; this.flash = 0; this.damage = 0;
    this.slowmoCooldown = 0; this.nearMissCooldown = 0;
    this.zoneShown = -1; this.houseResolved = false; this.holdTimer = 0; this.runTime = 0;
    this.loop.reset();
  }

  async startRun() {
    if (!this.booted) return;
    this.screens.showLoading();
    if (!audio.ready) {
      try {
        await audio.init((t) => this.screens.setLoadProgress(t, 'BUILDING SOUND'));
      } catch (err) { console.warn('Audio unavailable:', err); }
      const s = this.screens.getSettings();
      audio.setVolumes(s.master, s.sfx, s.music);
    }
    await audio.resume();
    audio.reset();
    this.screens.markLoaded();
    this._prepare((Math.random() * 0xffffffff) >>> 0);
    this.screens.hideAll();
    this.hud.setVisible(true);
    this.labels.setVisible(true);
    this.state = PLAYING;
    audio.playUi('start');
  }

  /** Instant restart: everything is pooled, so this is a reset, not a rebuild. */
  restart() {
    if (!this.booted) return;
    audio.reset();
    this._prepare((Math.random() * 0xffffffff) >>> 0);
    this.screens.hideAll();
    this.hud.setVisible(true);
    this.labels.setVisible(true);
    this.state = PLAYING;
  }

  pause() {
    if (this.state !== PLAYING) return;
    this.state = PAUSED;
    this.screens.showPause();
    audio.suspend();
  }

  resume() {
    if (this.state !== PAUSED) return;
    this.state = PLAYING;
    this.screens.hideAll();
    this.loop.lastTime = performance.now();
    audio.resume();
  }

  toMenu() {
    this.state = MENU;
    this.hud.setVisible(false);
    this.labels.setVisible(false);
    this.screens.showStart();
  }

  endRun(outcome) {
    if (this.state === OVER) return;
    this.state = OVER;
    const w = this.player.weight;
    const medal = outcome === 'win' ? this.score.finish(w) : null;
    if (outcome !== 'win') this.score.best.weight = Math.max(this.score.best.weight, w);
    audio.playUi('gameover');
    audio.setMusicBlocked(true);
    this.hud.setVisible(false);
    this.labels.setVisible(false);
    this.screens.showRunEnd({
      outcome,
      weight: Math.round(w),
      target: TUNING.finale.houseWeight,
      medal,
      smashed: this.score.smashed,
      missedWeight: Math.round(this.stream.missedWeight + this.stream.remainingWeight(this.player.d)),
      missedCount: this.stream.missedCount,
      bestChain: this.score.bestChain,
      zonesCleared: this.stream.zoneIndex + (outcome === 'win' ? 1 : 0),
      time: this.runTime,
      best: this.score.best,
    });
  }

  /**
   * Distance to the next blocker the player would actually hit if they held this
   * line. Feeds the low warning hum in the rolling layer.
   *
   * Lateral gating is the whole point: a blocker three lanes over is scenery, and
   * humming for it would train the player to ignore the hum. The band widens with
   * the drum, because a 5 m drum has far less room to be wrong about which lane it
   * is in than a 1.7 m one.
   */
  _nearestBlockerAhead(p) {
    const band = p.halfWidth + TUNING.read.blockerSafeMargin;
    let best = Infinity;
    for (let i = 0; i < this.stream.liveCount; i++) {
      const e = this.stream.live[i];
      if (!e.alive || !e.blocker) continue;
      const ahead = e.d - p.d;
      if (ahead <= 0 || ahead >= best) continue;
      if (Math.abs(p.x - e.cx) > e.ex + band) continue;
      best = ahead;
    }
    return best;
  }

  /**
   * Interactive objects inside the near band — the §6.1 budget that actually bites.
   * Measured in TIME, not metres, so it means the same thing at 12 m/s and at 46.
   */
  _nearBandCount(p) {
    const reach = Math.max(20, p.speed * TUNING.read.nearBandSeconds);
    let n = 0;
    for (let i = 0; i < this.stream.liveCount; i++) {
      const e = this.stream.live[i];
      if (!e.alive) continue;
      const ahead = e.d - p.d;
      if (ahead >= 0 && ahead <= reach) n++;
    }
    return n;
  }

  _applyVolume(kind, v) {
    const s = this.screens.getSettings();
    audio.setVolumes(kind === 'master' ? v : s.master, kind === 'sfx' ? v : s.sfx, kind === 'music' ? v : s.music);
  }

  _applyQuality(q) {
    this.renderer.setQuality(q);
    if (this.post) this.post.setEnabled(q === 'high' && TUNING.post.enabled);
  }

  // ── simulation ───────────────────────────────────────────────────────────────
  step(dt) {
    if (this.state !== PLAYING) return;
    const p = this.player;
    this.runTime += dt;

    // Rapier refreshes its query structures inside step(), so the world must be
    // stepped before the roller probes it.
    this.physics.step();
    p.setInput(this.input.poll());
    p.step(dt);
    this.stream.update(p.d, p.weight);

    if (p.landImpact > 0.02) {
      this.chase.addTrauma(TUNING.shake.traumaLanding * p.landImpact, p.weight);
      audio.playLand(p.landImpact, p.weight);
    }
    if (p.justLaunched) audio.playJump();

    this._resolveCollisions(dt);
    this.score.update ? this.score.update(dt) : 0;

    if (this.nearMissCooldown > 0) this.nearMissCooldown -= dt;
    if (this.slowmoCooldown > 0) this.slowmoCooldown -= dt;

    this._zoneWatch();
    this._finaleWatch(dt);

    if (p.strikedOut) { this.endRun('strikes'); return; }
    if (p.checkFall(this.profile.heightAt(p.d))) { this.endRun('fell'); return; }
  }

  /** Recompute every visible object's outcome against the current weight. */
  _refreshOutcomes() {
    const w = this.player.weight;
    const live = this.stream.live;
    for (let i = 0; i < this.stream.liveCount; i++) {
      const e = live[i];
      if (!e.alive) continue;
      e.outcome = e.blocker ? BLOCKER : classify(w, e.weight);
    }
  }

  _resolveCollisions(dt) {
    const p = this.player;
    const live = this.stream.live;
    const n = this.stream.liveCount;
    this.frameImpacts = 0;

    for (let i = 0; i < n; i++) {
      const e = live[i];
      if (!e.alive) continue;
      if (e.cooldown > 0) { e.cooldown -= dt; continue; }
      const dz = p.z - e.cz;
      if (dz > 24 || dz < -24) continue;

      // A blocker contact must be exact — see collisions.js. Everything else breaks
      // 0.15 m early so it disintegrates rather than interpenetrating for a frame.
      if (overlaps(p.x, p.y, p.z, p.halfWidth, p.radius, e.cx, e.cy, e.cz, e.ex, e.ey, e.ez,
        e.blocker ? 0 : undefined)) {
        this._impact(e);
        continue;
      }
      // Near miss: threading a blocker without touching it pays a speed boost.
      if (e.blocker && this.nearMissCooldown <= 0 && Math.abs(dz) < 2.0) {
        const clear = lateralClearance(p.x, p.halfWidth, e.cx, e.ex);
        if (clear > 0 && clear < TUNING.score.nearMissDistance) {
          this.nearMissCooldown = TUNING.score.nearMissCooldown;
          this.score.registerNearMiss();
          p.speed += TUNING.score.nearMissBoost;
          audio.playUi('hover');
          this.chase.kickFov(1.4);
        }
      }
    }
  }

  _impact(e) {
    const p = this.player;
    const outcome = e.blocker ? BLOCKER : classify(p.weight, e.weight);
    const def = e.def || PROPS[e.key];
    const matKey = def.parts && def.parts[0] ? def.parts[0].material : 'metal';
    const mat = MATERIALS[matKey] || MATERIALS.metal;
    const colour = (mat && mat.particle) || 0xb0b6bd;
    const pan = clamp(e.cx / (TUNING.world.roadWidth * 0.5), -1, 1);

    computeImpactPoint(p.x, p.y, p.z, e.cx, e.cy, e.cz, e.ex, e.ey, e.ez);
    const ix = impactPoint.x, iy = impactPoint.y, iz = impactPoint.z;
    this.frameImpacts++;
    const crowd = 1 / (1 + this.frameImpacts * 0.35);

    // ── a permanent blocker ends the run outright. It is never a strike, and it
    //    must never feel arbitrary — hence the striping, the silhouette and the hum.
    if (outcome === BLOCKER) {
      e.cooldown = 9;
      p.speed = 0;
      this.chase.addTrauma(TUNING.shake.traumaBlocked, p.weight);
      this.loop.requestHitstop(TUNING.time.hitstopBlocked * 1.6);
      this.damage = 1;
      this.particles.emitBurst(ix, iy, iz, 14, colour, 8, 0.8, 0.9, false, 1.5, 0, 0.5, 1);
      audio.playImpact('concrete', 'BLOCKED', Infinity, p.weight, pan, 1);
      this.endRun('blocker');
      return;
    }

    if (outcome === BLOCKED) {
      e.cooldown = TUNING.collision.hitCooldown;
      // Separate the roller so one approach costs exactly one strike.
      const clearZ = e.cz + e.ez + p.radius + 0.3;
      if (p.z < clearZ) { p.z = clearZ; p.d = -p.z; }
      const lost = p.blockedResponse();
      this.score.registerBlock();
      this.chase.addTrauma(TUNING.shake.traumaBlocked, p.weight);
      this.loop.requestHitstop(hitstopFor(e.weight, BLOCKED));
      this.damage = 1;
      this.chromatic = Math.max(this.chromatic, 0.5);
      this.particles.emitBurst(ix, iy, iz, TUNING.particles.burstBlocked, colour, 7, 0.7, 0.8, false, 1.4, 0, 0.5, 1);
      audio.playImpact(def.sound || 'concrete', 'BLOCKED', e.weight, p.weight, pan, 1);
      if (audio.playStrike) audio.playStrike(p.strikes);
      audio.duck(TUNING.audio.duckAmountDb, TUNING.audio.duckHold);
      audio.setMusicBlocked(true);
      this.hud.setWeight(p.weight);
      this.hud.setStrikes(p.strikes, TUNING.collision.maxStrikes);
      this.hud.setChain(0);
      this.hud.addPopup(`-${Math.round(lost).toLocaleString('en-US')} KG`, ix, iy + 1.4, iz, '#e0483d');
      return;
    }

    // ── smashed: absorb it
    this.stream.consume(e);
    const isClean = outcome === CLEAN;
    if (!isClean) p.applySpeedLoss(TUNING.collision.plowSpeedLoss);
    p.absorb(e.weight);

    this.fragments.spawn(
      def, e.x, e.y, e.z, 0, Math.sin(e.rotY * 0.5), 0, Math.cos(e.rotY * 0.5),
      ix, iy, iz, 0, 0, -p.speed, isClean ? 'PULVERIZE' : 'PLOW',
    );

    const burst = isClean ? TUNING.particles.burstClean : TUNING.particles.burstPlow;
    this.particles.emitBurst(ix, iy, iz, Math.round(burst * crowd + 3), colour,
      isClean ? 13 : 7, 0.85, 1.05, false, 1.7, 0, 0.55, -0.6);
    if (this.frameImpacts <= TUNING.particles.maxFlashesPerFrame) {
      this.particles.emitFlash(ix, iy, iz, TUNING.particles.flashSize * (isClean ? 1 : 0.6) * (0.55 + 0.45 * crowd), 0xfff4d8);
    }
    if (matKey === 'metal' || matKey === 'steel' || matKey === 'paint') {
      this.particles.emitSparks(ix, iy, iz, Math.round(TUNING.particles.sparkCount * crowd), 0, 0.5, -1);
    }

    this.chase.addTrauma(isClean ? TUNING.shake.traumaClean : TUNING.shake.traumaPlow, p.weight);

    // §5, and this is the whole feel of the paper tier: hitstop is reserved for PLOW
    // and BLOCKED. Freezing the frame twenty times in two seconds turns a power
    // fantasy into a stutter, and at 80 % paper by design that is what would happen.
    // Paper gets a camera PUNCH instead — a brief FOV nudge that decays instantly and
    // an edge flash. Reads as force, costs no momentum and no frames.
    if (isClean) {
      this.chase.kickFov(TUNING.camera.fovPunchAmount, TUNING.camera.fovPunchTime);
    } else {
      this.chase.kickFov(TUNING.camera.fovKickAmount * 0.6);
      this.loop.requestHitstop(hitstopFor(e.weight, outcome));
    }
    this.chromatic = Math.max(this.chromatic, isClean ? 0.85 : 0.5);
    this.flash = Math.max(this.flash, (isClean ? 0.28 : 0.14) * (0.5 + 0.5 * crowd));

    const chain = this.score.registerSmash(e.weight, outcome, this.loop.simTime);
    this.hud.setWeight(p.weight);
    this.hud.setChain(chain);
    this.hud.addPopup(`+${e.weight.toLocaleString('en-US')} KG`, ix, iy + 1.6, iz,
      isClean ? '#e8f4ff' : '#f0a022');

    audio.playImpact(def.sound || 'metal', isClean ? 'PULVERIZE' : 'PLOW', e.weight, p.weight, pan, crowd);
    if (audio.playAbsorb) audio.playAbsorb(e.weight, p.weight, this.score.chain);
    audio.setMusicIntensity(this.score.chainIntensity);
    audio.setMusicBlocked(false);
    if (e.weight >= 4000) audio.duck(TUNING.audio.duckAmountDb, TUNING.audio.duckHold);

    if (this.slowmoCooldown <= 0
      && this.score.smashesWithin(TUNING.time.slowmoSmashes, TUNING.time.slowmoWindow, this.loop.simTime)) {
      this.loop.requestSlowmo(TUNING.time.slowmoScale, TUNING.time.slowmoDuration, TUNING.time.slowmoEaseOut);
      this.slowmoCooldown = TUNING.time.slowmoCooldown;
      audio.setFilterSweep(1);
    }
  }

  /** Zone changes: a one-second recap beat at a natural pause, not HUD clutter. */
  _zoneWatch() {
    const zi = this.stream.zoneIndex;
    if (zi === this.zoneShown) return;
    this.zoneShown = zi;
    audio.setZone && audio.setZone(zi);
    if (zi === 0) return;

    const zone = this.plan.zones[zi];
    const ideal = zone.arriveWeight;
    const onPace = this.player.weight >= ideal * 0.82;
    const gained = Math.round(this.player.weight - (this.lastZoneWeight || TUNING.player.startWeight));
    this.lastZoneWeight = this.player.weight;
    this.score.zonesCleared = zi;
    this.hud.zoneBanner(
      `ZONE ${zi} CLEARED · +${gained.toLocaleString('en-US')} KG · ${onPace ? 'ON PACE' : 'BEHIND PACE'}`,
      onPace ? 'good' : 'warn',
    );
    this.loop.requestSlowmo(TUNING.time.zoneRecapScale, TUNING.time.zoneRecapSeconds, 0.3);
  }

  /** The finale: slow-motion into the house, then win or lose. */
  _finaleWatch(dt) {
    const p = this.player;
    const house = this.plan.house;
    if (this.houseResolved) {
      this.holdTimer += dt;
      return;
    }
    const toHouse = house.d - p.d;
    const secs = toHouse / Math.max(6, p.speed);
    if (secs <= TUNING.finale.slowMoLastSeconds && secs > 0) {
      this.loop.requestSlowmo(TUNING.finale.slowMoScale, 0.2, 0.3);
      if (audio.setFilterSweep) audio.setFilterSweep(0.7);
    }
    if (toHouse <= p.radius) {
      this.houseResolved = true;
      const win = p.weight >= house.weight;
      this.house.update(0, win ? 'win' : 'idle');
      this.chase.addTrauma(1.0, p.weight);
      this.loop.requestHitstop(0.12);
      if (audio.playHouseHit) audio.playHouseHit(win);
      if (win) {
        p.absorb(house.weight * 0);
        this.loop.requestSlowmo(0.25, TUNING.finale.holdWinShot, 0.6);
        this.particles.emitBurst(p.x, p.y, p.z - 4, 60, 0xd8d2c4, 22, 1.6, 2.2, false, 2.4, 0, 0.7, -1);
      } else {
        p.speed = 0;
      }
      this.endRun(win ? 'win' : 'house');
    }
  }

  // ── frame ────────────────────────────────────────────────────────────────────
  render(alpha, rawDt, scaledDt) {
    if (!this.booted) return;

    if (this.input.pauseEdge) {
      if (this.state === PLAYING) this.pause();
      else if (this.state === PAUSED) this.resume();
    }
    if (this.input.restartEdge && (this.state === OVER || this.state === PLAYING)) this.restart();

    const p = this.player;
    const playing = this.state === PLAYING;

    const ix = lerp(p.prevX, p.x, alpha);
    const iy = lerp(p.prevY, p.y, alpha);
    const iz = lerp(p.prevZ, p.z, alpha);
    const iroll = lerp(p.prevRoll, p.rollAngle, alpha);
    const speed01 = p.speed01;

    this._refreshOutcomes();

    this.roller.update(ix, iy, iz, p.radius, p.halfWidth * 2, iroll,
      this.stream.zoneIndex, p.strikes, this.score.ignited, rawDt);
    this.trail.update(ix, p.grounded ? p.groundY : p.y - p.radius, iz, p.halfWidth, p.grounded);

    if (playing && p.grounded && p.speed > 1) {
      const PT = TUNING.particles;
      const rate = (PT.dustRateBase + PT.dustRateSpeed * p.speed) *
        (1 + PT.dustRatePerRadius * (p.radius - TUNING.player.baseRadius));
      this.particles.emitDust(
        ix + fxRng.spread(p.halfWidth), p.groundY + 0.15, iz + p.radius * PT.dustBehind,
        rate, rawDt, p.speed * 0.22, 0x9c8f7c,
        p.radius * PT.dustSizePerRadius * (0.75 + speed01 * 0.6));
    }

    this.chase.update(rawDt, ix, iy, iz, p.d, speed01, p.weight, p.lateralVel, p.radius, p.speed);
    this.renderer.followLights(ix, iy, iz);

    const cam = this.renderer.camera;
    this.particles.update(scaledDt, cam);
    this.fragments.update(scaledDt);
    this.outlines.update(rawDt, this.stream.live, this.stream.liveCount, p.weight, cam.position);
    this.decor.update(p.d);
    this.house.update(scaledDt, this.houseResolved ? 'hold' : 'idle');
    this.props.flush();

    AS.speed = p.speed; AS.speed01 = speed01; AS.weight = p.weight;
    AS.grounded = p.grounded; AS.airborne = !p.grounded;
    AS.timeScale = this.loop.timeScale; AS.playing = playing;
    AS.chain = this.score.chain; AS.zone = this.stream.zoneIndex;
    AS.blockerDistance = playing ? this._nearestBlockerAhead(p) : Infinity;
    audio.update(rawDt, AS);
    if (!this.loop.inSlowmo && audio.setFilterSweep) audio.setFilterSweep(0);

    const total = this.plan ? this.plan.house.d : 1;
    this.hud.setProgress(clamp01(p.d / total), this.plan ? this.plan.zones : null, this.stream.zoneIndex);
    if (this.input.debugEdge) this.debug.toggle();
    DBG.visible = this.stream.liveCount;
    DBG.near = this._nearBandCount(p);
    DBG.labels = this.labels.activeCount ?? 0;
    DBG.fragments = this.fragments.activeCount ?? 0;
    DBG.gradeDeg = this.profile.slopeAt(p.d) / DEG;
    DBG.weight = p.weight; DBG.speed = p.speed; DBG.zone = this.stream.zoneIndex;
    this.debug.update(rawDt, DBG);

    this.hud.update(rawDt);
    this.hud.updatePopups(rawDt, cam, this.renderer.width, this.renderer.height);
    this.labels.update(rawDt, this.stream.live, this.stream.liveCount, p.weight,
      cam, this.renderer.width, this.renderer.height);

    this.chromatic = Math.max(0, this.chromatic - TUNING.post.chromaticDecay * rawDt);
    this.flash = Math.max(0, this.flash - TUNING.post.flashDecay * rawDt);
    this.damage = Math.max(0, this.damage - rawDt / TUNING.post.blockedVignetteTime);

    if (this.post && this.post.enabled) {
      this.post.setChromatic(this.chromatic);
      this.post.setFlash(this.flash);
      this.post.setDamage(this.damage);
      this.post.setSpeed(speed01);
      this.post.render();
    } else {
      this.renderer.renderer.render(this.renderer.scene, cam);
    }
    this.input.endFrame();
  }

  dispose() {
    this.loop.stop();
    this.input.dispose();
    this.trail.dispose();
    this.roller.dispose();
    this.particles.dispose();
    this.fragments.dispose();
    this.outlines.dispose();
    this.labels.dispose();
    this.debug.dispose();
    this.house.dispose();
    this.decor.dispose();
    this.props.dispose();
    this.road.dispose();
    if (this.post) this.post.dispose();
    this.renderer.dispose();
    audio.dispose();
  }
}
