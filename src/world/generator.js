import { TUNING } from '../tuning.js';
import { clamp01 } from '../core/math.js';
import { Rng } from '../core/rng.js';
import { PROPS } from './objects.js';
import { buildChunk, CHUNK_TENSION, chunkWeights } from './chunks.js';

const MAX_CHUNKS = TUNING.world.chunksAhead + TUNING.world.chunksBehind + 3;
const PROPS_PER_CHUNK = 128;
const PICKUPS_PER_CHUNK = 32;

/**
 * Streams the hill.
 *
 * Keeps a rolling window of chunks around the player, assembling each from a
 * hand-authored template and snapping it to the end of the previous one. Chunk
 * records, prop entries and pickup entries are all pooled — steady-state
 * generation allocates nothing, so the 80-metre cadence never shows up as a hitch.
 *
 * Pacing is the point: `_pickType` enforces tension → release → tension, and
 * guarantees a Buffet immediately after every Chasm.
 */
export class WorldGenerator {
  constructor(profile, roadBuilder, propRenderer, pickupRenderer) {
    this.profile = profile;
    this.road = roadBuilder;
    this.props = propRenderer;
    this.pickups = pickupRenderer;
    this.rng = new Rng(1);
    this.buildRng = new Rng(1);

    this.chunkPool = [];
    for (let i = 0; i < MAX_CHUNKS; i++) this.chunkPool.push(makeChunkRecord());
    this.active = [];
    this.nextIndex = 0;
    this.lastType = 'warmup';
    this.lastTension = 0;
    this.chunksSinceSteep = 0;
    this.destroyedCount = 0;
  }

  reset(seed) {
    for (let i = this.active.length - 1; i >= 0; i--) this._despawn(this.active[i]);
    this.active.length = 0;
    this.profile.reset();
    this.rng.reseed(seed >>> 0);
    this.buildRng.reseed((seed * 2654435761) >>> 0);
    this.nextIndex = 0;
    this.lastType = 'warmup';
    this.lastTension = 0;
    this.chunksSinceSteep = 0;
    this.destroyedCount = 0;
    this.props.reset();
    this.pickups.reset();
  }

  /** Ensure chunks exist around the player and drop the ones behind. */
  update(playerD) {
    const L = TUNING.world.chunkLength;
    const cur = Math.floor(playerD / L);
    const want = cur + TUNING.world.chunksAhead;
    while (this.nextIndex <= want && this.active.length < MAX_CHUNKS) {
      this._spawn(this.nextIndex);
      this.nextIndex++;
    }
    const dropBefore = cur - TUNING.world.chunksBehind;
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].index < dropBefore) {
        this._despawn(this.active[i]);
        this.active.splice(i, 1);
      }
    }
  }

  chunkAt(index) {
    for (let i = 0; i < this.active.length; i++) {
      if (this.active[i].index === index) return this.active[i];
    }
    return null;
  }

  // ── internals ───────────────────────────────────────────────────────────────
  _pickType(index, difficulty01) {
    if (index < TUNING.gen.warmupChunks) return 'warmup';
    // The single most satisfying transition in the game: release right after a drop.
    if (this.lastType === 'chasm') return 'buffet';
    // Never two high-tension chunks back to back.
    if (this.lastTension >= 2) return this.rng.bool(0.7) ? 'buffet' : 'warmup';

    const w = chunkWeights(difficulty01);
    const keys = TYPE_KEYS;
    WEIGHTS[0] = w.warmup; WEIGHTS[1] = w.traffic; WEIGHTS[2] = w.gauntlet;
    WEIGHTS[3] = w.buffet; WEIGHTS[4] = w.chasm; WEIGHTS[5] = w.jump;
    // Suppress another tension spike if we just had one.
    if (this.lastTension >= 1) {
      WEIGHTS[2] *= 0.25;
      WEIGHTS[4] *= 0.25;
    }
    if (this.lastType === 'buffet') { WEIGHTS[3] *= 0.15; }
    return this.rng.pickWeighted(keys, WEIGHTS);
  }

  _spawn(index) {
    const rec = this.chunkPool.pop();
    if (!rec) return;

    const L = TUNING.world.chunkLength;
    const d0 = index * L;
    const difficulty01 = clamp01(d0 / TUNING.gen.difficultyRampDistance);
    const type = this._pickType(index, difficulty01);

    CTX.rng = this.buildRng;
    CTX.chunkIndex = index;
    CTX.difficulty01 = difficulty01;
    CTX.generosity = TUNING.gen.pickupGenerosityBase
      + TUNING.gen.pickupGenerosityRamp * difficulty01;

    const spec = buildChunk(type, CTX);

    // Speed bursts: steepen occasionally, but never into a chasm (the player needs
    // a stable read on hole edges) and never twice in a row.
    let slopeDeg = spec.slopeDeg ?? TUNING.world.baseSlopeDeg;
    this.chunksSinceSteep++;
    if (type === 'chasm' || index < TUNING.gen.warmupChunks) {
      slopeDeg = TUNING.world.baseSlopeDeg;
    } else if (this.chunksSinceSteep >= 4 && this.rng.bool(0.45)) {
      slopeDeg = TUNING.world.steepSlopeDeg;
      this.chunksSinceSteep = 0;
    }
    spec.slopeDeg = slopeDeg;

    // Extend the profile so heightAt() covers this chunk before we build geometry.
    while (this.profile.chunkCount <= index) {
      this.profile.pushChunk(this.profile.chunkCount === index ? slopeDeg : TUNING.world.baseSlopeDeg);
    }

    rec.index = index;
    rec.type = type;
    rec.spec = spec;
    rec.slot = this.road.build(index, spec);

    // ── props
    rec.propCount = 0;
    for (let i = 0; i < spec.props.length && rec.propCount < PROPS_PER_CHUNK; i++) {
      const p = spec.props[i];
      const def = PROPS[p.key];
      if (!def) continue;
      const handle = this.props.alloc(p.key);
      if (handle < 0) continue;

      const d = d0 + p.d;
      const y = this.profile.heightAt(d);
      const rot = p.rotY || 0;
      const scale = p.scale || 1;
      const c = Math.abs(Math.cos(rot));
      const s = Math.abs(Math.sin(rot));
      const hw = def.size[0] * 0.5 * scale;
      const hh = def.size[1] * 0.5 * scale;
      const hd = def.size[2] * 0.5 * scale;

      const e = rec.props[rec.propCount++];
      e.key = p.key;
      e.def = def;
      e.handle = handle;
      e.d = d;
      e.x = p.x;
      e.y = y;
      e.z = -d;
      e.rotY = rot;
      e.scale = scale;
      e.cx = p.x;
      e.cy = y + hh;
      e.cz = -d;
      e.ex = c * hw + s * hd;
      e.ey = hh;
      e.ez = s * hw + c * hd;
      e.threshold = def.threshold;
      e.blocker = !!def.blocker;
      e.alive = true;
      e.cooldown = 0;
      this.props.place(p.key, handle, p.x, y, -d, rot, scale);
    }

    // ── pickups
    rec.pickupCount = 0;
    for (let i = 0; i < spec.pickups.length && rec.pickupCount < PICKUPS_PER_CHUNK; i++) {
      const q = spec.pickups[i];
      const handle = this.pickups.alloc();
      if (handle < 0) continue;
      const d = d0 + q.d;
      const e = rec.pickups[rec.pickupCount++];
      e.value = q.value;
      e.handle = handle;
      e.d = d;
      e.x = q.x;
      e.baseY = this.profile.heightAt(d) + 1.35;
      e.y = e.baseY;
      e.z = -d;
      e.phase = (d * 0.37 + q.x * 0.11) % 6.2831853;
      e.alive = true;
      e.collected = false;
    }

    this.active.push(rec);
    this.lastType = type;
    this.lastTension = CHUNK_TENSION[type] ?? 0;
  }

  _despawn(rec) {
    for (let i = 0; i < rec.propCount; i++) {
      const e = rec.props[i];
      if (e.handle >= 0) this.props.free(e.key, e.handle);
      e.handle = -1;
      e.alive = false;
    }
    rec.propCount = 0;
    for (let i = 0; i < rec.pickupCount; i++) {
      const e = rec.pickups[i];
      if (e.handle >= 0) this.pickups.release(e.handle);
      e.handle = -1;
      e.alive = false;
    }
    rec.pickupCount = 0;
    this.road.release(rec.slot);
    rec.slot = null;
    rec.spec = null;
    this.chunkPool.push(rec);
  }

  /** Animate pickups (bob + spin + magnet pull). Allocation-free. */
  updatePickups(dt, time, px, py, pz, magnetRadius) {
    const M = TUNING.mass;
    const r2 = magnetRadius * magnetRadius;
    for (let c = 0; c < this.active.length; c++) {
      const rec = this.active[c];
      for (let i = 0; i < rec.pickupCount; i++) {
        const e = rec.pickups[i];
        if (!e.alive) continue;
        const dx = px - e.x;
        const dy = py - e.y;
        const dz = pz - e.z;
        const dist2 = dx * dx + dy * dy + dz * dz;
        if (dist2 < r2) {
          // Magnetism: near-misses should feel generous, not punishing.
          const dist = Math.sqrt(dist2) || 1;
          const pull = M.pickupMagnetForce * dt * (1 - dist / magnetRadius);
          e.x += (dx / dist) * pull;
          e.y += (dy / dist) * pull;
          e.z += (dz / dist) * pull;
        } else {
          e.y = e.baseY + Math.sin(time * M.pickupBobSpeed + e.phase) * M.pickupBobAmp;
        }
        const spin = time * M.pickupSpin + e.phase;
        const scale = e.value >= 5000 ? 1.55 : e.value >= 1000 ? 1.15 : 0.85;
        this.pickups.set(e.handle, e.x, e.y, e.z, scale, spin, pickupColor(e.value));
      }
    }
    this.pickups.flush();
  }
}

const TYPE_KEYS = ['warmup', 'traffic', 'gauntlet', 'buffet', 'chasm', 'jump'];
const WEIGHTS = new Float64Array(6);
const CTX = { rng: null, chunkIndex: 0, difficulty01: 0, generosity: 1 };

export function pickupColor(value) {
  if (value >= 5000) return 0xff5f3a;
  if (value >= 1000) return 0x59e0ff;
  return 0xf2c200;
}

function makeChunkRecord() {
  const props = new Array(PROPS_PER_CHUNK);
  for (let i = 0; i < PROPS_PER_CHUNK; i++) {
    props[i] = {
      key: '', def: null, handle: -1, d: 0, x: 0, y: 0, z: 0, rotY: 0, scale: 1,
      cx: 0, cy: 0, cz: 0, ex: 0, ey: 0, ez: 0,
      threshold: 0, blocker: false, alive: false, cooldown: 0,
    };
  }
  const pickups = new Array(PICKUPS_PER_CHUNK);
  for (let i = 0; i < PICKUPS_PER_CHUNK; i++) {
    pickups[i] = {
      value: 0, handle: -1, d: 0, x: 0, y: 0, z: 0, baseY: 0,
      phase: 0, alive: false, collected: false,
    };
  }
  return {
    index: -1, type: '', spec: null, slot: null,
    props, propCount: 0, pickups, pickupCount: 0,
  };
}
