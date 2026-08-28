import * as THREE from 'three/webgpu';
import {
  attribute, positionWorld, vec3, vec4, float, mix, smoothstep, abs, fract, step, max,
} from 'three/tsl';
import { TUNING } from '../tuning.js';
import { ROAD_HALF, LANE_WIDTH } from '../world/track.js';

const LANES = TUNING.world.laneCount;
const SEG_LEN = TUNING.world.segmentLength;
const GRID_Z = 8;                                   // rows of road cells per segment
const CELL_D = SEG_LEN / GRID_Z;

// Vertex budget per chunk. Worst case is every cell isolated: 48 tops, 96 walls,
// 96 hazard strips. 260 quads is comfortable headroom and costs ~30 KB per chunk.
const MAX_QUADS = 260;
const MAX_VERTS = MAX_QUADS * 4;
const MAX_INDICES = MAX_QUADS * 6;

const TYPE_TOP = 0;
const TYPE_WALL = 1;
const TYPE_HAZARD = 2;
const TYPE_RAMP = 3;

/**
 * Builds one mesh + collider set per chunk from its occupancy grid.
 *
 * Geometry buffers are pooled and rewritten in place: a chunk spawns roughly every
 * two seconds at speed, and allocating a megabyte of typed arrays on that cadence
 * is exactly the kind of thing that shows up as a stutter.
 */
export class RoadBuilder {
  constructor(scene, physics, profile) {
    this.scene = scene;
    this.physics = physics;
    this.profile = profile;
    this.material = createRoadMaterial();
    this.freeSlots = [];
    this.slots = [];
  }

  _acquireSlot() {
    if (this.freeSlots.length > 0) return this.freeSlots.pop();
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_VERTS * 3);
    const nrm = new Float32Array(MAX_VERTS * 3);
    const typ = new Float32Array(MAX_VERTS);
    const idx = new Uint16Array(MAX_INDICES);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aType', new THREE.BufferAttribute(typ, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    const slot = { geo, pos, nrm, typ, idx, mesh, colliders: [] };
    this.slots.push(slot);
    return slot;
  }

  /**
   * @param {number} chunkIndex
   * @param {{cells:Uint8Array, ramps:Array}} spec
   * @returns {object} built chunk render data
   */
  build(chunkIndex, spec) {
    const slot = this._acquireSlot();
    const { pos, nrm, typ, idx } = slot;
    const prof = this.profile;
    const d0 = chunkIndex * SEG_LEN;
    const slope = prof.slopeAt(d0 + 0.5);
    const tanS = Math.tan(slope);
    const cosS = Math.cos(slope);
    const sinS = -Math.sin(slope);  // descent normal is (0, cos, -sin)
    const cells = spec.cells;

    let v = 0; // vertex cursor
    let i = 0; // index cursor

    const yAt = (d) => prof.heightAt(d);

    const quad = (
      x0, d0a, x1, d1a, yOff, type, nx, ny, nz, flip,
    ) => {
      if (v + 4 > MAX_VERTS) return;
      const ya = yAt(d0a) + yOff;
      const yb = yAt(d1a) + yOff;
      const base = v;
      // corners: (x0,d0) (x1,d0) (x1,d1) (x0,d1)
      pos[v * 3] = x0; pos[v * 3 + 1] = ya; pos[v * 3 + 2] = -d0a;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; typ[v] = type; v++;
      pos[v * 3] = x1; pos[v * 3 + 1] = ya; pos[v * 3 + 2] = -d0a;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; typ[v] = type; v++;
      pos[v * 3] = x1; pos[v * 3 + 1] = yb; pos[v * 3 + 2] = -d1a;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; typ[v] = type; v++;
      pos[v * 3] = x0; pos[v * 3 + 1] = yb; pos[v * 3 + 2] = -d1a;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; typ[v] = type; v++;
      if (flip) {
        idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 1;
        idx[i++] = base; idx[i++] = base + 3; idx[i++] = base + 2;
      } else {
        idx[i++] = base; idx[i++] = base + 1; idx[i++] = base + 2;
        idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 3;
      }
    };

    // Vertical quad spanning a lane's width at a fixed d (a hole's near/far wall).
    const wallD = (x0, x1, d, depth) => {
      if (v + 4 > MAX_VERTS) return;
      const y = yAt(d);
      const base = v;
      pos[v * 3] = x0; pos[v * 3 + 1] = y; pos[v * 3 + 2] = -d;
      nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 1; typ[v] = TYPE_WALL; v++;
      pos[v * 3] = x1; pos[v * 3 + 1] = y; pos[v * 3 + 2] = -d;
      nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 1; typ[v] = TYPE_WALL; v++;
      pos[v * 3] = x1; pos[v * 3 + 1] = y - depth; pos[v * 3 + 2] = -d;
      nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 1; typ[v] = TYPE_WALL; v++;
      pos[v * 3] = x0; pos[v * 3 + 1] = y - depth; pos[v * 3 + 2] = -d;
      nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 1; typ[v] = TYPE_WALL; v++;
      idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 1;
      idx[i++] = base; idx[i++] = base + 3; idx[i++] = base + 2;
    };

    // Vertical quad along travel at a fixed x (a hole's left/right wall).
    const wallX = (x, da, db, depth) => {
      if (v + 4 > MAX_VERTS) return;
      const ya = yAt(da);
      const yb = yAt(db);
      const base = v;
      pos[v * 3] = x; pos[v * 3 + 1] = ya; pos[v * 3 + 2] = -da;
      nrm[v * 3] = 1; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_WALL; v++;
      pos[v * 3] = x; pos[v * 3 + 1] = yb; pos[v * 3 + 2] = -db;
      nrm[v * 3] = 1; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_WALL; v++;
      pos[v * 3] = x; pos[v * 3 + 1] = yb - depth; pos[v * 3 + 2] = -db;
      nrm[v * 3] = 1; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_WALL; v++;
      pos[v * 3] = x; pos[v * 3 + 1] = ya - depth; pos[v * 3 + 2] = -da;
      nrm[v * 3] = 1; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_WALL; v++;
      idx[i++] = base; idx[i++] = base + 1; idx[i++] = base + 2;
      idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 3;
    };

    // Triangular side of a ramp wedge: road level at the entry, lip height at the end.
    const rampCheek = (x, da, ya, db, yb, nx) => {
      if (v + 4 > MAX_VERTS) return;
      const base = v;
      const yRoadB = prof.heightAt(db);
      pos[v * 3] = x; pos[v * 3 + 1] = ya; pos[v * 3 + 2] = -da;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_RAMP; v++;
      pos[v * 3] = x; pos[v * 3 + 1] = yb; pos[v * 3 + 2] = -db;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_RAMP; v++;
      pos[v * 3] = x; pos[v * 3 + 1] = yRoadB; pos[v * 3 + 2] = -db;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_RAMP; v++;
      pos[v * 3] = x; pos[v * 3 + 1] = ya; pos[v * 3 + 2] = -da;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = 0; typ[v] = TYPE_RAMP; v++;
      if (nx > 0) {
        idx[i++] = base; idx[i++] = base + 1; idx[i++] = base + 2;
        idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 3;
      } else {
        idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 1;
        idx[i++] = base; idx[i++] = base + 3; idx[i++] = base + 2;
      }
    };

    const solid = (row, lane) => (
      row < 0 || row >= GRID_Z || lane < 0 || lane >= LANES ? 1 : cells[row * LANES + lane]
    );

    const colliders = [];
    const HOLE_DEPTH = 26;

    // Colliders overlap by SEAM at every join between two solid cells. Slab end
    // caps are tilted with the hill, so a vertical probe ray *can* strike one at a
    // seam and read it as a cliff; overlapping buries every interior cap while
    // leaving the caps at real hole edges exposed, which is exactly what we want
    // the roller to treat as a wall.
    const SEAM = 0.5;

    // Chunk 0 gets an apron running back behind the start line, so the roller
    // begins on solid road rather than balanced on the very first edge, and the
    // camera has something under it on frame one.
    if (chunkIndex === 0) {
      const APRON = 26;
      quad(-ROAD_HALF, -APRON, ROAD_HALF, 0, 0, TYPE_TOP, 0, cosS, sinS, false);
      const aLen = APRON + SEAM;
      const aMid = (-APRON + SEAM) * 0.5;
      colliders.push(this.physics.addSlab(
        0, prof.heightAt(aMid), -aMid,
        ROAD_HALF, (aLen * 0.5) / cosS, slope, 3,
      ));
    }
    const MARK = 0.9;      // hazard strip width, metres
    const LIFT = 0.012;    // z-fight guard for markings

    // ── top surface: merge runs along travel per lane, one quad + one collider each
    //
    // A run may only merge rows that share a SLOPE. Zone boundaries and crests do
    // not line up with the 40 m road segments, so a segment can straddle a slope
    // change; building one collider across it with a single slope leaves a step the
    // roller drops straight through — which reads to the player as falling off a
    // flat crest for no reason.
    const rowSlope = (row) => prof.slopeAt(d0 + (row + 0.5) * CELL_D);

    for (let lane = 0; lane < LANES; lane++) {
      const x0 = -ROAD_HALF + lane * LANE_WIDTH;
      const x1 = x0 + LANE_WIDTH;
      let run = -1;
      let runSlope = 0;
      for (let row = 0; row <= GRID_Z; row++) {
        const isSolid = row < GRID_Z && cells[row * LANES + lane] === 1;
        const sl = row < GRID_Z ? rowSlope(row) : NaN;
        const breaks = run >= 0 && (!isSolid || row === GRID_Z || Math.abs(sl - runSlope) > 1e-6);

        if (breaks) {
          const da = d0 + run * CELL_D;
          const db = d0 + row * CELL_D;
          const cs = Math.cos(runSlope);
          const sn = -Math.sin(runSlope);
          quad(x0, da, x1, db, 0, TYPE_TOP, 0, cs, sn, false);

          // Extend into a solid neighbour of the SAME slope so no cap is exposed.
          const upSame = solid(run - 1, lane) === 1
            && (run === 0 || Math.abs(rowSlope(run - 1) - runSlope) <= 1e-6);
          const downSame = solid(row, lane) === 1
            && row < GRID_Z && Math.abs(sl - runSlope) <= 1e-6;
          const ca = da - (upSame ? SEAM : 0);
          const cb = db + (downSame ? SEAM : 0);
          const len = cb - ca;
          const midD = (ca + cb) * 0.5;
          colliders.push(this.physics.addSlab(
            (x0 + x1) * 0.5, prof.heightAt(midD), -midD,
            LANE_WIDTH * 0.5, (len * 0.5) / cs, runSlope, 3,
          ));
          run = -1;
        }
        if (isSolid && run < 0) { run = row; runSlope = sl; }
      }
    }

    // ── hole walls + hazard markings on every edge that borders a hole
    for (let row = 0; row < GRID_Z; row++) {
      for (let lane = 0; lane < LANES; lane++) {
        if (cells[row * LANES + lane] !== 1) continue;
        const x0 = -ROAD_HALF + lane * LANE_WIDTH;
        const x1 = x0 + LANE_WIDTH;
        const da = d0 + row * CELL_D;
        const db = da + CELL_D;

        // far edge (down-hill side of this cell)
        if (!solid(row + 1, lane)) {
          wallD(x0, x1, db, HOLE_DEPTH);
          quad(x0, db - MARK, x1, db, LIFT, TYPE_HAZARD, 0, cosS, sinS, false);
        }
        // near edge
        if (!solid(row - 1, lane)) {
          wallD(x0, x1, da, HOLE_DEPTH);
          quad(x0, da, x1, da + MARK, LIFT, TYPE_HAZARD, 0, cosS, sinS, false);
        }
        if (!solid(row, lane - 1)) {
          wallX(x0, da, db, HOLE_DEPTH);
          quad(x0, da, x0 + MARK, db, LIFT, TYPE_HAZARD, 0, cosS, sinS, false);
        }
        if (!solid(row, lane + 1)) {
          wallX(x1, da, db, HOLE_DEPTH);
          quad(x1 - MARK, da, x1, db, LIFT, TYPE_HAZARD, 0, cosS, sinS, false);
        }
      }
    }

    // ── ramps: a wedge the roller drives up, plus its collider
    //
    // `height` is the world-space rise from the ramp's entry point to its lip.
    // It deliberately is NOT "height above the road at the far end": the hill is
    // already dropping ~0.21 m per metre, so a lip measured against the road there
    // can easily end up *below* where the roller got on, and the ramp launches
    // nothing at all.
    if (spec.ramps) {
      for (let r = 0; r < spec.ramps.length; r++) {
        const ramp = spec.ramps[r];
        const rd0 = d0 + ramp.d;
        const rd1 = rd0 + ramp.length;
        const hx0 = ramp.x - ramp.width * 0.5;
        const hx1 = ramp.x + ramp.width * 0.5;
        const yBase = prof.heightAt(rd0);
        const yTop = yBase + ramp.height;
        const rn = normalise(0, ramp.length, ramp.height);

        // sloped top face
        if (v + 4 <= MAX_VERTS) {
          const base = v;
          pos[v * 3] = hx0; pos[v * 3 + 1] = yBase; pos[v * 3 + 2] = -rd0;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = rn.y; nrm[v * 3 + 2] = rn.z; typ[v] = TYPE_HAZARD; v++;
          pos[v * 3] = hx1; pos[v * 3 + 1] = yBase; pos[v * 3 + 2] = -rd0;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = rn.y; nrm[v * 3 + 2] = rn.z; typ[v] = TYPE_HAZARD; v++;
          pos[v * 3] = hx1; pos[v * 3 + 1] = yTop; pos[v * 3 + 2] = -rd1;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = rn.y; nrm[v * 3 + 2] = rn.z; typ[v] = TYPE_HAZARD; v++;
          pos[v * 3] = hx0; pos[v * 3 + 1] = yTop; pos[v * 3 + 2] = -rd1;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = rn.y; nrm[v * 3 + 2] = rn.z; typ[v] = TYPE_HAZARD; v++;
          idx[i++] = base; idx[i++] = base + 1; idx[i++] = base + 2;
          idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 3;
        }

        // solid triangular cheeks, so the wedge reads as a ramp and not as paint
        rampCheek(hx0, rd0, yBase, rd1, yTop, -1);
        rampCheek(hx1, rd0, yBase, rd1, yTop, 1);

        // the drop-off at the lip
        if (v + 4 <= MAX_VERTS) {
          const base = v;
          const yRoad = prof.heightAt(rd1);
          pos[v * 3] = hx0; pos[v * 3 + 1] = yTop; pos[v * 3 + 2] = -rd1;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = -1; typ[v] = TYPE_RAMP; v++;
          pos[v * 3] = hx1; pos[v * 3 + 1] = yTop; pos[v * 3 + 2] = -rd1;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = -1; typ[v] = TYPE_RAMP; v++;
          pos[v * 3] = hx1; pos[v * 3 + 1] = yRoad; pos[v * 3 + 2] = -rd1;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = -1; typ[v] = TYPE_RAMP; v++;
          pos[v * 3] = hx0; pos[v * 3 + 1] = yRoad; pos[v * 3 + 2] = -rd1;
          nrm[v * 3] = 0; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = -1; typ[v] = TYPE_RAMP; v++;
          idx[i++] = base; idx[i++] = base + 1; idx[i++] = base + 2;
          idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 3;
        }

        const rampSlope = -Math.atan2(ramp.height, ramp.length); // negative = rising
        colliders.push(this.physics.addSlab(
          ramp.x,
          (yBase + yTop) * 0.5,
          -(rd0 + rd1) * 0.5,
          ramp.width * 0.5,
          Math.hypot(ramp.length, ramp.height) * 0.5,
          rampSlope,
          2.5,
        ));
      }
    }

    slot.geo.attributes.position.needsUpdate = true;
    slot.geo.attributes.normal.needsUpdate = true;
    slot.geo.attributes.aType.needsUpdate = true;
    slot.geo.index.needsUpdate = true;
    slot.geo.setDrawRange(0, i);
    slot.geo.boundingSphere.center.set(0, prof.heightAt(d0 + SEG_LEN * 0.5), -(d0 + SEG_LEN * 0.5));
    slot.geo.boundingSphere.radius = SEG_LEN * 1.6;
    slot.colliders = colliders;

    this.scene.add(slot.mesh);
    return slot;
  }

  release(slot) {
    if (!slot) return;
    this.scene.remove(slot.mesh);
    for (let k = 0; k < slot.colliders.length; k++) {
      this.physics.removeCollider(slot.colliders[k]);
    }
    slot.colliders.length = 0;
    this.freeSlots.push(slot);
  }

  dispose() {
    for (const s of this.slots) {
      this.scene.remove(s.mesh);
      s.geo.dispose();
    }
    this.slots.length = 0;
    this.freeSlots.length = 0;
    this.material.dispose();
  }
}

const _n = { y: 0, z: 0 };
function normalise(x, dz, dy) {
  // Upward normal of a surface whose height changes by `dy` over `dz` metres of
  // travel: (0, dz, dy) normalised. A descent has dy < 0, giving a -Z-leaning normal.
  const len = Math.hypot(dz, dy) || 1;
  _n.y = dz / len;
  _n.z = dy / len;
  return _n;
}

/**
 * Road material: asphalt with lane dashes, solid shoulder lines, dark hole walls,
 * and white-on-charcoal chevrons on any edge that borders a drop. All derived from world
 * position — no textures to load, and it stays crisp at any distance.
 */
function createRoadMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.0 });
  const type = attribute('aType', 'float');
  const wp = positionWorld;

  const asphalt = vec3(0.105, 0.112, 0.125);
  const grit = fract(wp.x.mul(3.7).add(wp.z.mul(2.3)).sin().mul(43758.5453)).mul(0.05);
  const base = asphalt.add(vec3(grit, grit, grit));

  // dashed lane separators every LANE_WIDTH
  const lx = abs(fract(wp.x.div(LANE_WIDTH).add(0.5)).sub(0.5));
  const laneLine = smoothstep(float(0.030), float(0.012), lx);
  const dash = step(float(0.45), fract(wp.z.div(9.0)));
  const interior = step(abs(wp.x), float(ROAD_HALF - LANE_WIDTH * 0.5));

  // solid shoulder lines
  const shoulder = smoothstep(float(ROAD_HALF - 0.75), float(ROAD_HALF - 0.35), abs(wp.x));

  const paint = vec3(0.76, 0.74, 0.66);
  // Shoulder lines were saturated yellow, running the full length of the road on
  // both sides — permanently on screen, and close enough to the PLOW outline's
  // amber to poison it (§6.1, colour monopoly). Saturated green, amber and red
  // belong to the outline system and to nothing else, so the shoulder is now the
  // same off-white as the lane paint, just brighter and solid.
  const shoulderPaint = vec3(0.90, 0.89, 0.84);

  let top = mix(base, paint, laneLine.mul(dash).mul(interior).mul(0.85));
  top = mix(top, shoulderPaint, shoulder.mul(0.9));

  const wall = vec3(0.028, 0.030, 0.036);

  // Hazard chevrons at the lip of a hole: WHITE on charcoal, the same language the
  // blockers use, so "this ends your run" looks the same wherever it appears — and
  // so the only saturated colours on screen are still the three outline states.
  const stripe = step(float(0.5), fract(wp.x.add(wp.z).mul(0.62)));
  const hazard = mix(vec3(0.045, 0.045, 0.050), vec3(0.93, 0.93, 0.92), stripe);

  const isWall = step(float(0.5), type).mul(step(type, float(1.5)));
  const isHazard = step(float(1.5), type).mul(step(type, float(2.5)));
  const isRamp = step(float(2.5), type);
  const rampSteel = vec3(0.30, 0.30, 0.32);
  let color = mix(top, wall, isWall);
  color = mix(color, hazard, isHazard);
  color = mix(color, rampSteel, isRamp);

  mat.colorNode = vec4(color, 1.0);
  mat.emissiveNode = hazard.mul(isHazard).mul(0.12);
  return mat;
}
