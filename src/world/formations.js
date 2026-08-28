import { TUNING } from '../tuning.js';
import { PROPS, BLOCKER_KEYS } from './objects.js';

/**
 * The formation vocabulary (§6.1).
 *
 * The whole track is assembled from six named shapes, never freehand placement.
 * Six recognisable silhouettes can be read at speed; infinite unique arrangements
 * cannot. Everything snaps to the five lane centres for the same reason — scatter
 * reads as noise, alignment reads as a pattern the eye parses instantly.
 *
 * Risk lanes (§16.5): the outer lanes carry the heavy, valuable objects and most
 * of the blockers; the centre lane is safe but poor. That is what turns steering
 * from dodging into a standing greed decision.
 */

export const FORMATIONS = ['WALL', 'PAIR', 'STAGGER', 'FUNNEL', 'SIDE_FEED', 'GAUNTLET'];

export function laneCount() { return TUNING.world.laneCount; }

/** Centre x of lane index 0..laneCount-1. */
export function laneX(lane) {
  const n = TUNING.world.laneCount;
  const w = TUNING.world.laneWidth;
  return (lane - (n - 1) / 2) * w;
}

/** How risky a lane is, 0 (centre) to 1 (outer edge). Drives placement. */
export function laneRisk(lane) {
  const n = TUNING.world.laneCount;
  const mid = (n - 1) / 2;
  return Math.abs(lane - mid) / mid;
}

/* Reused scratch so building a formation allocates nothing per call. */
const _lanes = [0, 1, 2, 3, 4, 5, 6, 7];
const _laneScore = new Float64Array(8);

/**
 * Lane indices ordered riskiest-first, ties broken by the rng.
 *
 * The score is computed once per lane and then sorted, rather than calling the rng
 * inside a comparator — a comparator that returns different answers for the same
 * pair is undefined behaviour and would make the track non-reproducible from a seed.
 */
function riskyLanesFirst(rng) {
  const n = TUNING.world.laneCount;
  for (let i = 0; i < n; i++) {
    _lanes[i] = i;
    _laneScore[i] = laneRisk(i) + rng.next() * 0.01;
  }
  for (let i = 1; i < n; i++) {
    const v = _lanes[i];
    const s = _laneScore[v];
    let j = i - 1;
    while (j >= 0 && _laneScore[_lanes[j]] < s) { _lanes[j + 1] = _lanes[j]; j--; }
    _lanes[j + 1] = v;
  }
  return _lanes;
}

/**
 * Build one formation.
 *
 * Objects are taken from `pool` (heaviest first) and removed as they are placed;
 * whatever is left over stays for the next formation. `out` is appended with
 * `{ key, lane, d, blocker }` entries whose `d` is relative to the formation start.
 *
 * `sweep` carries the speed and lateral speed the player will realistically have
 * here, so the two SWEEP shapes can space their objects far enough apart in d for
 * the line between them to actually be drivable. Omit it and they fall back to a
 * conservative worst case.
 *
 * @returns {number} the formation's span in metres
 */
export function buildFormation(type, pool, rng, out, gapLanes, sweep) {
  const n = TUNING.world.laneCount;
  const risky = riskyLanesFirst(rng);
  // How many adjacent lanes the gap must span. A late-game roller is wider than a
  // single 5 m lane, so a one-lane gap there is not "hard", it is impassable.
  const gapW = Math.max(1, Math.min(n - 1, gapLanes || 1));

  // Heaviest object goes in the riskiest lane. Sorting here rather than at the
  // call site keeps every formation honouring the risk-lane rule for free.
  pool.sort((a, b) => b.weight - a.weight);

  // Only consume when there is room to place: taking an object and then dropping
  // it in push() would delete its weight from the track entirely.
  const take = () => (out.length < TUNING.read.maxNearObjects && pool.length > 0 ? pool.shift() : null);
  const blockerDesc = () => ({
    key: BLOCKER_KEYS[Math.floor(rng.next() * BLOCKER_KEYS.length) % BLOCKER_KEYS.length],
    weight: Infinity, scale: 1, blocker: true,
  });
  // Hard cap per formation. At 30 m/s the 2-second "near band" covers 60 m, so
  // every object in a formation shorter than that is being judged at once — which
  // means the near-band budget IS the formation size budget.
  const cap = TUNING.read.maxNearObjects;
  // Metres of ramp needed to move `dx` metres sideways at a comfortable fraction
  // of the roller's lateral speed. This is what makes a sweep sweepable: the gap
  // between two objects a lane apart is not a constant, it is however far the
  // ramp runs while you slide across.
  const fwd = sweep && sweep.speed > 4 ? sweep.speed : TUNING.player.baseTopSpeed;
  const lat = Math.max(1, (sweep && sweep.lateral > 0 ? sweep.lateral : TUNING.player.baseLateralSpeed)
    * TUNING.read.sweepComfort);
  const stepFor = (dx) => Math.max(TUNING.read.sweepStepMin, Math.abs(dx) / lat * fwd);

  const push = (desc, lane, d) => {
    if (!desc || out.length >= cap) return;
    out.push({
      key: desc.key, weight: desc.weight, scale: desc.scale || 1,
      role: desc.role || 'FEEDER', lane, d, blocker: !!PROPS[desc.key].blocker,
    });
  };

  switch (type) {
    // Every lane occupied but one. The gap is the whole read.
    case 'WALL': {
      const gap = Math.floor(rng.next() * (n - gapW + 1)) % (n - gapW + 1);
      for (let i = 0; i < n; i++) {
        const lane = risky[i];
        if (lane >= gap && lane < gap + gapW) continue;
        push(take(), lane, rng.next() * 2.0);
      }
      return 8;
    }

    // Two adjacent lanes blocked, three open. The gentlest shape.
    case 'PAIR': {
      const start = Math.floor(rng.next() * (n - 1)) % (n - 1);
      push(take(), start, 0);
      push(take(), start + 1, rng.next() * 1.6);
      return 7;
    }

    // A weave. SWEEP: every object is meant to be collected, so each step is one
    // lane and the gap to the next is however long that lane change takes.
    //
    // It used to alternate between the two OUTER lanes — a 20 m jump — which is
    // not a weave, it is two separate formations that happen to share a name.
    case 'STAGGER': {
      const steps = 3 + Math.floor(rng.next() * 2);   // push() enforces the cap
      const w = TUNING.world.laneWidth;
      let lane = 1 + Math.floor(rng.next() * (n - 2));
      let dir = rng.next() < 0.5 ? -1 : 1;
      let d = 0;
      for (let i = 0; i < steps; i++) {
        push(take(), lane, d);
        // Bounce off the shoulders rather than walking into them.
        if (lane + dir < 0 || lane + dir > n - 1) dir = -dir;
        lane += dir;
        d += stepFor(w);
      }
      return Math.min(TUNING.read.sweepSpanMax, d + 4);
    }

    // Wide at the top, one lane at the bottom. Commit early or get squeezed.
    // Each row keeps a corridor of half-width `reach` around `keep` and blocks
    // everything outside it, so the opening closes row by row: 5 lanes, then 3,
    // then 1.
    case 'FUNNEL': {
      const keep = Math.floor(rng.next() * n) % n;
      let d = 0;
      const minReach = gapW >> 1;                     // never narrower than the gap
      for (let reach = 2; reach >= minReach; reach--) {
        for (let lane = 0; lane < n; lane++) {
          if (Math.abs(lane - keep) <= reach) continue;   // inside the corridor
          push(take(), lane, d + rng.next() * 1.2);
        }
        d += 7;
      }
      return d + 3;
    }

    // A cluster of free weight hugging one edge. Pure reward for committing wide,
    // and the single most collectable shape in the vocabulary: everything sits in
    // ONE lane, so once you are there you hold the stick still and hoover.
    //
    // It used to step to the inner lane on every third object with the same 4.6 m
    // gap as the in-lane ones, which quietly made a third of its weight
    // uncollectable — a 5 m sidestep in 4.6 m of ramp is 28 m/s of lateral speed.
    // The step inward is still there, because a straight line of five identical
    // objects is boring, but it is now paid for in ramp length.
    case 'SIDE_FEED': {
      const edge = rng.next() < 0.5 ? 0 : n - 1;
      const inner = edge === 0 ? 1 : n - 2;
      const w = TUNING.world.laneWidth;
      const inStep = 2 + Math.floor(rng.next() * 3);   // which one steps inward
      let d = 0;
      let lane = edge;
      const count = 3 + Math.floor(rng.next() * 3);
      for (let i = 0; i < count; i++) {
        push(take(), lane, d);
        const next = i + 1 === inStep ? inner : (lane === inner ? edge : lane);
        d += stepFor(next === lane ? 0 : w);
        lane = next;
      }
      return Math.min(TUNING.read.sweepSpanMax, d + 3);
    }

    // Blockers only. No weight here — this one is pure navigation.
    case 'GAUNTLET':
    default: {
      const gapStart = Math.max(0, Math.min(n - gapW, risky[n - 1] - (gapW >> 1)));
      const maxB = TUNING.read.gauntletMaxBlockers;
      let d = 0;
      let placed = 0;
      for (let row = 0; row < 2 && placed < maxB; row++) {
        for (let lane = 0; lane < n; lane++) {
          if (lane >= gapStart && lane < gapStart + gapW) continue;
          if (placed >= maxB) break;                  // punctuation, not a maze
          // Leave the wall porous — but a gauntlet with nothing in it is not a
          // gauntlet, so the last available lane is not allowed to roll out.
          const lastChance = row === 1 && lane >= n - 1 && placed === 0;
          if (!lastChance && rng.next() < 0.35) continue;
          push(blockerDesc(), lane, d);
          placed++;
        }
        d += 16;
      }
      // Nothing landed (every lane rolled out and the gap ate the rest): put one
      // blocker in the riskiest lane outside the gap rather than returning an
      // empty formation the zone will read as a long silence.
      if (placed === 0) {
        for (let i = n - 1; i >= 0; i--) {
          const lane = risky[i];
          if (lane >= gapStart && lane < gapStart + gapW) continue;
          push(blockerDesc(), lane, 0);
          break;
        }
      }
      return d + 4;
    }
  }
}

/**
 * How many objects a formation type wants. The track builder uses this to slice
 * the zone's object list into formations without running one dry.
 */
export function formationAppetite(type) {
  const cap = TUNING.read.maxNearObjects;
  switch (type) {
    case 'WALL': return Math.min(cap, TUNING.world.laneCount - 1);
    case 'PAIR': return 2;
    case 'STAGGER': return cap;
    case 'FUNNEL': return cap;
    case 'SIDE_FEED': return cap;
    case 'GAUNTLET': return 0;
    default: return 3;
  }
}
