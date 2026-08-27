import * as THREE from 'three/webgpu';
import { TUNING, massRatio } from '../tuning.js';
import { clamp, clamp01, lerp } from '../core/math.js';
import { GameLoop } from '../core/loop.js';
import { fxRng } from '../core/rng.js';

import { Renderer } from '../render/renderer.js';
import { ChaseCamera } from '../render/camera.js';
import { RoadBuilder } from '../render/road.js';
import { PropRenderer } from '../render/props.js';
import { PickupRenderer } from '../render/pickups.js';
import { Roller } from '../render/roller.js';
import { Trail } from '../render/trail.js';
import { PostFX } from '../render/post.js';

import { initPhysics, PhysicsWorld } from '../physics/world.js';
import { Player } from '../physics/player.js';
import {
  classify, overlaps, computeImpactPoint, impactPoint, hitstopFor, PULVERIZE, BLOCKED,
} from '../physics/collisions.js';

import { TrackProfile } from '../world/track.js';
import { WorldGenerator, pickupColor } from '../world/generator.js';
import { MATERIALS } from '../world/objects.js';

import { ParticleSystem } from '../fx/particles.js';
import { FragmentSystem } from '../fx/fragments.js';

import { Score } from './score.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Screens } from '../ui/screens.js';
import { audio } from '../audio/index.js';

const STATE_BOOT = 'boot';
const STATE_MENU = 'menu';
const STATE_PLAYING = 'playing';
const STATE_PAUSED = 'paused';
const STATE_DEAD = 'dead';

const _camPos = new THREE.Vector3();

export class Game {
  constructor(container, hudRoot, screensRoot) {
    this.container = container;
    this.state = STATE_BOOT;

    this.renderer = new Renderer(container);
    this.audio = audio;
    this.profile = new TrackProfile();
    this.score = new Score();
    // Input listens on the container rather than the canvas: the canvas element is
    // replaced if the renderer has to fall back to WebGL2.
    this.input = new Input(container);
    this.hud = new Hud(hudRoot);
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

    // Effect state consumed by post-processing.
    this.chromatic = 0;
    this.flash = 0;
    this.damage = 0;
    this.slowmoCooldown = 0;
    this.blockedMusicTimer = 0;
    this.blockGrace = 0;
    this.frameImpacts = 0;
    this.runSeed = 1;
    this.pendingRestart = false;
    this.booted = false;
  }

  async boot() {
    await initPhysics();
    this.physics = new PhysicsWorld();

    const backend = await this.renderer.init();
    this.backend = backend;

    const scene = this.renderer.scene;
    this.road = new RoadBuilder(scene, this.physics, this.profile);
    this.props = new PropRenderer(scene);
    this.pickupsRender = new PickupRenderer(scene);
    this.generator = new WorldGenerator(this.profile, this.road, this.props, this.pickupsRender);
    this.player = new Player(this.physics);
    this.roller = new Roller(scene);
    this.trail = new Trail(scene);
    this.particles = new ParticleSystem(scene);
    this.fragments = new FragmentSystem(scene, (x, z) => this.groundYAt(x, z));

    try {
      this.post = new PostFX(this.renderer.renderer, scene, this.renderer.camera);
      this.post.setSize(this.renderer.width, this.renderer.height);
    } catch (err) {
      console.warn('Post-processing unavailable, rendering direct:', err);
      this.post = null;
    }
    this.renderer.onResize = (w, h) => {
      if (this.post) this.post.setSize(w, h);
    };

    const settings = this.screens.getSettings();
    this._applyQuality(settings.quality);

    this.booted = true;
    this.state = STATE_MENU;
    this.screens.showStart();
    this.hud.setVisible(false);
    // Render one frame so the menu has the world behind it rather than a void.
    this._prepareWorld(1);
    this.loop.start();
  }

  // ── run lifecycle ────────────────────────────────────────────────────────────
  _prepareWorld(seed) {
    this.runSeed = seed;
    this.profile.reset();
    this.generator.reset(seed);
    this.player.reset();
    this.generator.update(0);
    // Two steps: the first registers the freshly created chunk colliders with the
    // broad phase, the second makes them queryable.
    this.physics.step();
    this.physics.step();
    this.player.y = this.profile.heightAt(0) + this.player.radius;
    this.player.prevY = this.player.y;
    this.chase.reset(this.player.x, this.player.y, this.player.z);
    this.trail.reset();
    this.particles.reset();
    this.fragments.reset();
    this.score.reset();
    this.hud.reset();
    this.hud.setMass(this.player.mass);
    this.chromatic = 0;
    this.flash = 0;
    this.damage = 0;
    this.slowmoCooldown = 0;
    this.blockedMusicTimer = 0;
    this.blockGrace = 0;
    this.loop.reset();
  }

  async startRun() {
    if (!this.booted) return;
    this.screens.showLoading();
    if (!audio.ready) {
      try {
        await audio.init((t) => this.screens.setLoadProgress(t, 'BUILDING SOUND'));
      } catch (err) {
        console.warn('Audio unavailable:', err);
      }
      const s = this.screens.getSettings();
      audio.setVolumes(s.master, s.sfx, s.music);
    }
    await audio.resume();
    audio.reset();
    this._prepareWorld((Math.random() * 0xffffffff) >>> 0);
    this.screens.hideAll();
    this.hud.setVisible(true);
    this.state = STATE_PLAYING;
    audio.playUi('start');
  }

  /** Instant restart: everything is pooled, so this is a reset, not a rebuild. */
  restart() {
    if (!this.booted) return;
    audio.reset();
    this._prepareWorld((Math.random() * 0xffffffff) >>> 0);
    this.screens.hideAll();
    this.hud.setVisible(true);
    this.state = STATE_PLAYING;
  }

  pause() {
    if (this.state !== STATE_PLAYING) return;
    this.state = STATE_PAUSED;
    this.screens.showPause();
    audio.suspend();
  }

  resume() {
    if (this.state !== STATE_PAUSED) return;
    this.state = STATE_PLAYING;
    this.screens.hideAll();
    this.loop.lastTime = performance.now();
    audio.resume();
  }

  toMenu() {
    this.state = STATE_MENU;
    this.hud.setVisible(false);
    this.screens.showStart();
  }

  endRun(reason) {
    if (this.state === STATE_DEAD) return;
    this.state = STATE_DEAD;
    const best = this.score.finish();
    audio.playUi('gameover');
    audio.setMusicBlocked(true);
    this.hud.setVisible(false);
    this.screens.showRunEnd({
      distance: Math.max(0, Math.round(this.player.d)),
      peakMass: Math.round(this.score.peakMass),
      destroyed: this.score.destroyed,
      bestCombo: this.score.bestCombo,
      score: this.score.points,
      best,
      reason,
    });
  }

  _applyVolume(kind, v) {
    const s = this.screens.getSettings();
    audio.setVolumes(
      kind === 'master' ? v : s.master,
      kind === 'sfx' ? v : s.sfx,
      kind === 'music' ? v : s.music,
    );
  }

  _applyQuality(q) {
    this.renderer.setQuality(q);
    if (this.post) this.post.setEnabled(q === 'high' && TUNING.post.enabled);
  }

  /** Surface height at a world position, or -Infinity over a hole. */
  groundYAt(x, z) {
    const d = -z;
    if (d < 0) return this.profile.heightAt(0);
    const L = TUNING.world.chunkLength;
    const ci = Math.floor(d / L);
    const rec = this.generator.chunkAt(ci);
    if (!rec || !rec.spec) return this.profile.heightAt(d);
    const lanes = TUNING.world.laneCount;
    const gridZ = TUNING.world.chunkGridZ;
    const local = d - ci * L;
    const row = clamp(Math.floor((local / L) * gridZ), 0, gridZ - 1);
    const lane = Math.floor(((x + TUNING.world.roadWidth * 0.5) / TUNING.world.roadWidth) * lanes);
    if (lane < 0 || lane >= lanes) return this.profile.heightAt(d);
    return rec.spec.cells[row * lanes + lane] === 1 ? this.profile.heightAt(d) : -Infinity;
  }

  // ── simulation ───────────────────────────────────────────────────────────────
  step(dt) {
    if (this.state !== STATE_PLAYING) return;
    const p = this.player;

    // Rapier refreshes its query structures inside step(), so the world must be
    // stepped before the roller probes it — otherwise the very first frame finds
    // no ground and the roller falls through the hill.
    this.physics.step();

    if (this.input.tuckEdge) {
      if (p.tryTuck()) audio.playJump();
    }
    p.setInput(this.input.poll(), false);
    p.step(dt);

    this.generator.update(p.d);

    if (p.landImpact > 0.02) {
      this.chase.addTrauma(TUNING.shake.traumaLanding * p.landImpact, p.mass);
      audio.playLand(p.landImpact, p.mass);
      this.particles.emitBurst(
        p.x, p.y - p.radius, p.z, 10, MATERIALS.dirt ? MATERIALS.dirt.particle : 0x8a7a63,
        6 * p.landImpact + 2, 0.6, 0.9, false, 1.1, 0, 1, 0,
      );
    }
    if (p.justLaunched) audio.playJump();

    this._resolveCollisions(dt);
    this._resolvePickups(dt);

    this.score.update(dt);
    this.score.addDistancePoints(p.d);
    if (p.mass > this.score.peakMass) this.score.peakMass = p.mass;

    if (this.blockedMusicTimer > 0) {
      this.blockedMusicTimer -= dt;
      if (this.blockedMusicTimer <= 0) audio.setMusicBlocked(false);
    }
    if (this.slowmoCooldown > 0) this.slowmoCooldown -= dt;
    if (this.blockGrace > 0) this.blockGrace -= dt;

    // Falling into a hole is the only hard fail in the game.
    if (p.checkFall(this.profile.heightAt(p.d))) {
      this.endRun('fell');
    }
  }

  _resolveCollisions(dt) {
    const p = this.player;
    const L = TUNING.world.chunkLength;
    const cur = Math.floor(p.d / L);
    const chunks = this.generator.active;
    this.frameImpacts = 0;

    for (let c = 0; c < chunks.length; c++) {
      const rec = chunks[c];
      if (rec.index < cur - 1 || rec.index > cur + 1) continue;
      for (let i = 0; i < rec.propCount; i++) {
        const e = rec.props[i];
        if (!e.alive) continue;
        if (e.cooldown > 0) { e.cooldown -= dt; continue; }
        const dz = p.z - e.cz;
        if (dz > 14 || dz < -14) continue;
        if (!overlaps(p.x, p.y, p.z, p.halfWidth, p.radius, e.cx, e.cy, e.cz, e.ex, e.ey, e.ez)) continue;
        this._impact(e, rec);
      }
    }
  }

  _impact(e, rec) {
    const p = this.player;
    const outcome = classify(p.mass, e.threshold);
    const def = e.def;
    const matKey = def.parts && def.parts[0] ? def.parts[0].material : 'metal';
    const mat = MATERIALS[matKey] || MATERIALS.metal;
    const particleColor = (mat && mat.particle) || 0xb0b6bd;
    const pan = clamp(e.cx / 12, -1, 1);

    computeImpactPoint(p.x, p.y, p.z, e.cx, e.cy, e.cz, e.ex, e.ey, e.ez);
    const ix = impactPoint.x;
    const iy = impactPoint.y;
    const iz = impactPoint.z;

    this.frameImpacts++;
    // Many simultaneous hits should read as one huge event, not as mud.
    const crowd = 1 / (1 + this.frameImpacts * 0.35);

    if (outcome === BLOCKED) {
      const graced = this.blockGrace > 0;
      // Separate the roller from what stopped it. Without this the two stay
      // overlapped, the per-object cooldown expires while still in contact, and a
      // single barrier bills the player 15 % of their mass over and over until
      // there is nothing left. One approach must cost exactly one block.
      const clearZ = e.cz + e.ez + p.radius + 0.3;
      if (p.z < clearZ) {
        p.z = clearZ;
        p.d = -p.z;
      }
      e.cooldown = TUNING.collision.blockedLockout + 0.5;
      p.blockedResponse();
      // Grace window: a rebound that carries you straight back into the same wall
      // should not bill you twice. It still stops you — it just does not compound.
      const lost = graced ? 0 : p.loseMassFraction(TUNING.mass.blockedMassLoss);
      this.blockGrace = TUNING.collision.blockedGrace;
      this.score.registerBlocked();
      this.chase.addTrauma(TUNING.shake.traumaBlocked, p.mass);
      this.loop.requestHitstop(hitstopFor(e.threshold, BLOCKED));
      this.damage = 1;
      this.chromatic = Math.max(this.chromatic, 0.5);
      this.particles.emitBurst(
        ix, iy, iz, TUNING.particles.burstBlocked, particleColor,
        7, 0.7, 0.8, false, 1.4, 0, 0.5, 1,
      );
      this.particles.emitSparks(ix, iy, iz, 10, 0, 0.3, 1);
      audio.playImpact(def.sound || 'concrete', BLOCKED, e.threshold, p.mass, pan, 1);
      audio.duck(TUNING.audio.duckAmountDb, TUNING.audio.duckHold);
      audio.setMusicBlocked(true);
      this.blockedMusicTimer = 2.5;
      if (lost > 0) {
        this.hud.setMass(p.mass);
        this.hud.addPopup(`-${Math.round(lost)} KG`, ix, iy + 1.2, iz, '#ff4d3d');
      }
      return;
    }

    // ── destroyed
    e.alive = false;
    this.props.hide(e.key, e.handle);

    const speedLoss = outcome === PULVERIZE
      ? TUNING.collision.pulverizeSpeedLoss
      : TUNING.collision.plowSpeedLoss;
    p.applySpeedLoss(speedLoss);

    this.fragments.spawn(
      def, e.x, e.y, e.z, 0, Math.sin(e.rotY * 0.5), 0, Math.cos(e.rotY * 0.5),
      ix, iy, iz, 0, 0, -p.speed, outcome,
    );

    const isPulv = outcome === PULVERIZE;
    const burst = isPulv ? TUNING.particles.burstPulverize : TUNING.particles.burstPlow;
    this.particles.emitBurst(
      ix, iy, iz, Math.round(burst * crowd + 3), particleColor,
      isPulv ? 13 : 7, 0.85, 1.05, false, 1.7, 0, 0.55, -0.6,
    );
    this.particles.emitFlash(ix, iy, iz, TUNING.particles.flashSize * (isPulv ? 1 : 0.6), 0xfff4d8);
    if (matKey === 'metal' || matKey === 'car' || matKey === 'heavy') {
      this.particles.emitSparks(ix, iy, iz, Math.round(TUNING.particles.sparkCount * crowd), 0, 0.5, -1);
    }
    if (matKey === 'glass') {
      this.particles.emitBurst(
        ix, iy, iz, Math.round(18 * crowd), 0xdff6ff, 15, 1.3, 0.5, true, 2.0, 0, 0.7, -0.5,
      );
    }

    this.chase.addTrauma(
      isPulv ? TUNING.shake.traumaPulverize : TUNING.shake.traumaPlow, p.mass,
    );
    this.chase.kickFov(TUNING.camera.fovKickAmount * (isPulv ? 1 : 0.6));
    this.loop.requestHitstop(hitstopFor(e.threshold, outcome));
    this.chromatic = Math.max(this.chromatic, isPulv ? 0.85 : 0.5);
    this.flash = Math.max(this.flash, isPulv ? 0.28 : 0.14);

    const gained = this.score.registerKill(e.threshold, outcome, this.loop.simTime);
    this.hud.setScore(this.score.points, this.score.combo);
    this.hud.comboPop();
    this.hud.addPopup(
      `+${gained}`, ix, iy + 1.4, iz, isPulv ? '#ffd83d' : '#c9d3dd',
    );

    audio.playImpact(def.sound || 'metal', outcome, e.threshold, p.mass, pan, crowd);
    audio.playCombo(this.score.combo, p.mass);
    audio.setMusicIntensity(this.score.intensity);
    if (isPulv && e.threshold >= 4000) {
      audio.duck(TUNING.audio.duckAmountDb, TUNING.audio.duckHold);
    }

    // Chain reward: five kills in a second buys half a second of slow motion.
    if (this.slowmoCooldown <= 0
        && this.score.killsWithin(TUNING.time.slowmoKills, TUNING.time.slowmoWindow, this.loop.simTime)) {
      this.loop.requestSlowmo(
        TUNING.time.slowmoScale, TUNING.time.slowmoDuration, TUNING.time.slowmoEaseOut,
      );
      this.slowmoCooldown = TUNING.time.slowmoCooldown;
      audio.setFilterSweep(1);
    }
  }

  _resolvePickups(dt) {
    const p = this.player;
    const chunks = this.generator.active;
    const reach = p.radius + 1.1;
    const reach2 = reach * reach;
    for (let c = 0; c < chunks.length; c++) {
      const rec = chunks[c];
      for (let i = 0; i < rec.pickupCount; i++) {
        const e = rec.pickups[i];
        if (!e.alive) continue;
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const dz = p.z - e.z;
        if (dx * dx + dy * dy + dz * dz > reach2) continue;
        e.alive = false;
        this.pickupsRender.release(e.handle);
        e.handle = -1;
        p.addMass(e.value);
        this.hud.setMass(p.mass);
        this.hud.addPopup(`+${e.value} KG`, e.x, e.y + 0.9, e.z, '#7cff9b');
        this.particles.emitBurst(
          e.x, e.y, e.z, 16, pickupColor(e.value), 9, 0.7, 0.6, true, 2.4, 0, 1, 0,
        );
        audio.playPickup(e.value, p.mass);
        this.chase.kickFov(1.6);
      }
    }
  }

  // ── frame ────────────────────────────────────────────────────────────────────
  render(alpha, rawDt, scaledDt) {
    if (!this.booted) return;

    if (this.input.pauseEdge) {
      if (this.state === STATE_PLAYING) this.pause();
      else if (this.state === STATE_PAUSED) this.resume();
    }
    if (this.input.restartEdge && (this.state === STATE_DEAD || this.state === STATE_PLAYING)) {
      this.restart();
    }

    const p = this.player;
    const playing = this.state === STATE_PLAYING;

    // Interpolate the roller between fixed steps so motion is smooth at any refresh rate.
    const ix = lerp(p.prevX, p.x, alpha);
    const iy = lerp(p.prevY, p.y, alpha);
    const iz = lerp(p.prevZ, p.z, alpha);
    const iroll = lerp(p.prevRoll, p.rollAngle, alpha);
    const speed01 = p.speed01;

    this.roller.update(
      ix, iy, iz, p.halfWidth * 2, p.radius, iroll,
      clamp01((speed01 - 0.55) / 0.45) * 0.55,
    );
    this.trail.update(ix, p.grounded ? p.groundY : p.y - p.radius, iz, p.halfWidth, p.grounded);

    // Dust plume behind the roller, always, scaled to speed.
    if (playing && p.grounded && p.speed > 1) {
      const rate = TUNING.particles.dustRateBase + TUNING.particles.dustRateSpeed * p.speed;
      this.particles.emitDust(
        ix + fxRng.spread(p.halfWidth), p.groundY + 0.15, iz + p.radius * 0.7,
        rate, rawDt, p.speed * 0.22, 0x9c8f7c, 1.0 + speed01 * 0.9,
      );
    }

    this.chase.update(rawDt, ix, iy, iz, p.d, speed01, p.mass, p.lateralVel);
    this.renderer.followLights(ix, iy, iz);

    this.renderer.camera.getWorldPosition(_camPos);
    this.particles.update(scaledDt, _camPos);
    this.fragments.update(scaledDt);
    this.props.flush();
    if (playing) this.generator.updatePickups(scaledDt, this.loop.simTime, ix, iy, iz, TUNING.mass.pickupMagnetRadius);

    // ── audio frame state (reused object, never reallocated)
    AS.speed = p.speed;
    AS.speed01 = speed01;
    AS.mass = p.mass;
    AS.grounded = p.grounded;
    AS.airborne = !p.grounded;
    AS.timeScale = this.loop.timeScale;
    AS.playing = playing;
    AS.combo = this.score.combo;
    audio.update(rawDt, AS);
    if (!this.loop.inSlowmo) audio.setFilterSweep(0);

    // ── HUD
    this.hud.setDistance(p.d);
    this.hud.setScore(this.score.points, this.score.combo);
    this.hud.update(rawDt);
    this.hud.updatePopups(rawDt, this.renderer.camera, this.renderer.width, this.renderer.height);

    // ── post-process channels decay on wall-clock time so they read during hitstop
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
      this.renderer.renderer.render(this.renderer.scene, this.renderer.camera);
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
    this.props.dispose();
    this.pickupsRender.dispose();
    this.road.dispose();
    if (this.post) this.post.dispose();
    this.renderer.dispose();
    audio.dispose();
  }
}

/** Reused audio state object — allocating this per frame would be 60 objects/s. */
const AS = {
  speed: 0, speed01: 0, mass: 0, grounded: true,
  airborne: false, timeScale: 1, playing: false, combo: 1,
};
