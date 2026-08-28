import { TUNING } from '../tuning.js';
import { clamp } from '../core/math.js';
import { PROPS } from './objects.js';
import { speedAtWeight } from './trackplan.js';

const LANES = TUNING.world.laneCount;
const SEG_LEN = TUNING.world.segmentLength;
const GRID_Z = 8;
const CELL_D = SEG_LEN / GRID_Z;
const MAX_LIVE = 96;                 // pooled live-object records

/**
 * Streams the authored track plan.
 *
 * The plan is finite and built up front, so this only moves a window over it:
 * road segments in and out of the physics world, and object records in and out of
 * the live list.
 *
 * The object budget from §6.1 is enforced HERE, every frame, not left to the
 * generator's taste: never more than `maxVisibleObjects` shown at once and never
 * more than `maxNearObjects` inside the near band. If the window would exceed
 * either, the least valuable object is dropped rather than the newest — a cheap
 * feeder disappearing is far less confusing than a centrepiece popping out.
 */
export class WorldStream {
  constructor(profile, roadBuilder, propRenderer) {
    this.profile = profile;
    this.road = roadBuilder;
    this.props = propRenderer;

    this.plan = null;
    this.segments = new Map();       // segment index -> road slot
    this.live = new Array(MAX_LIVE);
    for (let i = 0; i < MAX_LIVE; i++) this.live[i] = makeRecord();
    this.liveCount = 0;

    this.cursor = 0;                 // next plan object not yet spawned
    this.zoneIndex = 0;
    this.smashed = 0;
    this.missedWeight = 0;
    this.missedCount = 0;
    this._cells = new Uint8Array(GRID_Z * LANES);
    this._ramps = [];
  }

  reset(plan) {
    for (const [, slot] of this.segments) this.road.release(slot);
    this.segments.clear();
    for (let i = 0; i < this.liveCount; i++) {
      const e = this.live[i];
      if (e.handle >= 0) this.props.free(e.key, e.handle);
      e.handle = -1;
      e.alive = false;
    }
    this.liveCount = 0;
    this.cursor = 0;
    this.zoneIndex = 0;
    this.smashed = 0;
    this.missedWeight = 0;
    this.missedCount = 0;
    this.plan = plan;
    this.props.reset();

    this.profile.reset();
    for (let i = 0; i < plan.segments.length; i++) {
      this.profile.push(plan.segments[i].length, plan.segments[i].slopeDeg);
    }
  }

  /**
   * Zone containing a travel distance.
   *
   * Crests sit BETWEEN zones, so a plain containment test finds nothing there and
   * a naive fallback reports the final zone — which made the run look like it had
   * jumped to the industrial zone during the first crest. On a crest the player has
   * finished the zone behind them, so that is the zone to report.
   */
  zoneAt(d) {
    const z = this.plan.zones;
    let idx = 0;
    for (let i = 0; i < z.length; i++) {
      if (d >= z[i].dStart) idx = i;
      if (d < z[i].dEnd) break;
    }
    return idx;
  }

  update(playerD, playerWeight) {
    this._streamRoad(playerD);
    this._streamObjects(playerD, playerWeight);
    this.zoneIndex = this.zoneAt(playerD);
  }

  // ── road ─────────────────────────────────────────────────────────────────────
  _streamRoad(playerD) {
    const first = Math.max(0, Math.floor(playerD / SEG_LEN) - TUNING.world.segmentsBehind);
    const last = Math.floor(playerD / SEG_LEN) + TUNING.world.segmentsAhead;
    const maxSeg = Math.ceil(this.plan.totalLength / SEG_LEN);

    for (let i = first; i <= last && i < maxSeg; i++) {
      if (this.segments.has(i)) continue;
      this.segments.set(i, this.road.build(i, this._segmentSpec(i)));
    }
    for (const [i, slot] of this.segments) {
      if (i < first || i > last) { this.road.release(slot); this.segments.delete(i); }
    }
  }

  /** Road occupancy + ramps for one segment, derived from the plan's hazards. */
  _segmentSpec(index) {
    const d0 = index * SEG_LEN;
    this._cells.fill(1);
    for (let h = 0; h < this.plan.holes.length; h++) {
      const hole = this.plan.holes[h];
      if (hole.dEnd < d0 || hole.dStart > d0 + SEG_LEN) continue;
      for (let row = 0; row < GRID_Z; row++) {
        const a = d0 + row * CELL_D;
        const b = a + CELL_D;
        if (b <= hole.dStart || a >= hole.dEnd) continue;
        for (let lane = hole.laneFrom; lane <= hole.laneTo && lane < LANES; lane++) {
          if (lane >= 0) this._cells[row * LANES + lane] = 0;
        }
      }
    }
    this._ramps.length = 0;
    for (let j = 0; j < this.plan.jumps.length; j++) {
      const r = this.plan.jumps[j];
      if (r.d >= d0 && r.d < d0 + SEG_LEN) {
        this._ramps.push({ d: r.d - d0, x: r.x, width: r.width, length: r.length, height: r.height });
      }
    }
    SPEC.cells = this._cells;
    SPEC.ramps = this._ramps;
    return SPEC;
  }

  /** Surface height at a world position, or -Infinity over a hole. */
  groundYAt(x, z) {
    const d = -z;
    if (d < 0) return this.profile.heightAt(0);
    for (let h = 0; h < this.plan.holes.length; h++) {
      const hole = this.plan.holes[h];
      if (d < hole.dStart || d > hole.dEnd) continue;
      const halfLane = TUNING.world.laneWidth * 0.5;
      const x0 = (hole.laneFrom - (LANES - 1) / 2) * TUNING.world.laneWidth - halfLane;
      const x1 = (hole.laneTo - (LANES - 1) / 2) * TUNING.world.laneWidth + halfLane;
      if (x > x0 && x < x1) return -Infinity;
    }
    return this.profile.heightAt(d);
  }

  // ── objects ──────────────────────────────────────────────────────────────────
  _streamObjects(playerD, playerWeight) {
    const R = TUNING.read;
    const speed = Math.max(10, speedAtWeight(playerWeight));
    const far = playerD + R.fadeInSeconds * speed;
    const behind = playerD - 60;

    // retire what is behind us, counting anything we never broke as missed
    let w = 0;
    for (let i = 0; i < this.liveCount; i++) {
      const e = this.live[i];
      if (e.d < behind) {
        if (e.alive && !e.blocker) { this.missedWeight += e.weight; this.missedCount++; }
        if (e.handle >= 0) this.props.free(e.key, e.handle);
        e.handle = -1;
        e.alive = false;
        continue;
      }
      if (i !== w) swap(this.live, i, w);
      w++;
    }
    this.liveCount = w;

    // admit what has come into view
    const objs = this.plan.objects;
    while (this.cursor < objs.length && objs[this.cursor].d <= far && this.liveCount < MAX_LIVE) {
      this._spawn(objs[this.cursor]);
      this.cursor++;
    }

    this._enforceBudget(playerD, speed);
  }

  _spawn(o) {
    const def = PROPS[o.key];
    if (!def) return;
    const e = this.live[this.liveCount++];
    const sc = o.scale || 1;
    const c = Math.abs(Math.cos(o.rotY));
    const s = Math.abs(Math.sin(o.rotY));
    const hw = def.size[0] * 0.5 * sc;
    const hh = def.size[1] * 0.5 * sc;
    const hd = def.size[2] * 0.5 * sc;
    const y = this.profile.heightAt(o.d);

    e.id = o.id; e.key = o.key; e.weight = o.weight; e.scale = sc;
    e.role = o.role; e.blocker = !!o.blocker; e.zone = o.zone;
    e.d = o.d; e.x = o.x; e.y = y; e.z = -o.d; e.lane = o.lane; e.rotY = o.rotY;
    e.cx = o.x; e.cy = y + hh; e.cz = -o.d;
    e.ex = c * hw + s * hd; e.ey = hh; e.ez = s * hw + c * hd;
    e.alive = true; e.cooldown = 0; e.visible = true; e.labelled = false;
    e.outcome = e.blocker ? 'BLOCKER' : 'CLEAN';
    e.colourT = 0; e.fade = 0;
    e.handle = this.props.alloc(o.key);
    if (e.handle >= 0) this.props.place(o.key, e.handle, o.x, y, -o.d, o.rotY, sc);
  }

  /**
   * The hard caps, checked every frame. Dropping the LEAST valuable object keeps
   * the expensive, decision-carrying objects on screen; dropping the newest would
   * make centrepieces flicker in and out at exactly the wrong moment.
   */
  _enforceBudget(playerD, speed) {
    const R = TUNING.read;
    const nearEnd = playerD + R.nearBandSeconds * speed;
    let visible = 0, near = 0;

    for (let i = 0; i < this.liveCount; i++) {
      const e = this.live[i];
      e.visible = e.alive && e.d >= playerD - 20;
      if (!e.visible) continue;
      visible++;
      if (e.d <= nearEnd) near++;
    }

    while (visible > R.maxVisibleObjects || near > R.maxNearObjects) {
      let victim = -1;
      let cheapest = Infinity;
      for (let i = 0; i < this.liveCount; i++) {
        const e = this.live[i];
        if (!e.visible || e.blocker) continue;            // never drop a blocker
        if (near > R.maxNearObjects && e.d > nearEnd) continue;
        if (e.weight < cheapest) { cheapest = e.weight; victim = i; }
      }
      if (victim < 0) break;
      const e = this.live[victim];
      e.visible = false;
      if (e.handle >= 0) { this.props.free(e.key, e.handle); e.handle = -1; }
      visible--;
      if (e.d <= nearEnd) near--;
    }
  }

  /** Remove an object the player just destroyed. */
  consume(e) {
    if (!e.alive) return;
    e.alive = false;
    this.smashed++;
    if (e.handle >= 0) { this.props.free(e.key, e.handle); e.handle = -1; }
  }

  /** Weight still ahead of the player that has not been passed or broken. */
  remainingWeight(playerD) {
    let t = 0;
    const objs = this.plan.objects;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (o.blocker || o.d < playerD) continue;
      t += o.weight;
    }
    return t;
  }
}

const SPEC = { cells: null, ramps: null };

function swap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

function makeRecord() {
  return {
    id: -1, key: '', weight: 0, scale: 1, role: 'FEEDER', blocker: false, zone: 0,
    d: 0, x: 0, y: 0, z: 0, lane: 0, rotY: 0,
    cx: 0, cy: 0, cz: 0, ex: 0, ey: 0, ez: 0,
    alive: false, cooldown: 0, visible: false, labelled: false,
    outcome: 'CLEAN', colourT: 0, fade: 0, handle: -1,
  };
}
