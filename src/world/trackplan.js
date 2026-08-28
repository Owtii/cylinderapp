import { TUNING } from '../tuning.js';
import { Rng } from '../core/rng.js';
import { clamp } from '../core/math.js';
import { PROPS, pickVisual } from './objects.js';
import { buildFormation, formationAppetite, laneX } from './formations.js';

/**
 * Assembles the whole ramp up front: zones, formations, hazards, crests, the
 * finale run-up and the house. The track is finite and authored, so this runs once
 * per run and the streamer just moves a window over the result.
 *
 * Two rules from §6.1 are enforced here rather than left to taste, because they
 * are what makes the ramp readable at speed:
 *   • at least `minFormationGapSeconds` of EMPTY ramp between formations, measured
 *     in time at the speed the player will actually be doing;
 *   • formations only — never freehand placement — so every arrangement is one of
 *     six shapes the eye already knows.
 */

const snapWeight = (w) => {
  const step = w < 1000 ? 10 : w < 10000 ? 50 : w < 50000 ? 100 : 500;
  return Math.max(step, Math.round(w / step) * step);
};

/** Top speed the player will be doing at a given weight (mirrors player.js). */
export function speedAtWeight(weight) {
  const P = TUNING.player;
  return Math.min(P.topSpeedCap, P.baseTopSpeed * Math.pow(weight / P.startWeight, P.topSpeedExp));
}

/**
 * The weight curve for one zone: a stream of feeders plus exactly one centrepiece
 * sized at the player's ideal arrival weight, summing to the zone budget exactly.
 */
function zoneWeights(zone, arriveWeight, rng) {
  const WT = TUNING.weights;   // `W` is TUNING.world elsewhere in this file
  const scale = zone._centreScale || 1;

  // ── the landmarks: a ladder, not a single centrepiece
  //
  // Every rung is capped against the weight the player would have arriving on
  // pace, so the top rung opens amber and the bottom rungs stay edible even for a
  // player who is well behind. Whatever a cap sheds falls through to the feeders,
  // so the zone's budget is spent exactly either way.
  const cap = snapWeight(arriveWeight * WT.landmarkMaxRatio * scale);
  const ladder = WT.landmarkLadder;
  let ladderSum = 0;
  for (let i = 0; i < ladder.length; i++) ladderSum += ladder[i];
  const landmarkPot = zone.budget * WT.landmarkShare;

  const marks = [];
  for (let i = 0; i < ladder.length; i++) {
    const w = snapWeight(Math.min(cap, landmarkPot * ladder[i] / ladderSum));
    if (w >= 10) marks.push(w);
  }
  let placed = 0;
  for (let i = 0; i < marks.length; i++) placed += marks[i];

  const feederTotal = zone.budget - placed;
  if (feederTotal <= 0 || marks.length === 0) return null;

  const n = Math.max(3, zone.feeders);
  const share = feederTotal / n;
  const [lo, hi] = WT.feederSpread;
  const feeders = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    const w = snapWeight(share * (lo + (hi - lo) * rng.next()));
    feeders.push(w);
    acc += w;
  }
  // The last feeder closes the budget exactly, whatever the rounding did.
  const last = feederTotal - acc;
  if (last > 0) feeders.push(last);
  else feeders[feeders.length - 1] += last;          // absorb an overshoot

  // ── the running order
  //
  // Feeders first so the player arrives at each landmark heavier than they were,
  // with the top rung at `centreAt` through the zone — far enough in that "have I
  // eaten enough yet?" is a live question, early enough that the answer still
  // leaves ramp to act on.
  const cut = clamp(Math.round(feeders.length * zone.centreAt), 1, feeders.length - 1);
  const seq = [];
  for (let i = 0; i < cut; i++) seq.push({ w: feeders[i], role: 'FEEDER' });
  seq.push({ w: marks[0], role: zone.gamble ? 'GAMBLE' : 'CENTRE' });
  // Lower rungs are spread through the back half, interleaved with the feeders,
  // so a player who missed the top rung meets the rope on the way out rather than
  // finding the zone already over.
  const rest = feeders.length - cut;
  const every = marks.length > 1 ? Math.max(1, Math.floor(rest / (marks.length - 1))) : rest + 1;
  let mi = 1;
  for (let i = 0; i < rest; i++) {
    seq.push({ w: feeders[cut + i], role: 'FEEDER' });
    if (mi < marks.length && (i + 1) % every === 0) seq.push({ w: marks[mi++], role: 'LANDMARK' });
  }
  while (mi < marks.length) seq.push({ w: marks[mi++], role: 'LANDMARK' });
  return seq;
}


/**
 * Formation types allowed in a zone.
 *
 * Weight lives in the formations a single pass can actually SWEEP — SIDE_FEED puts
 * its objects in a line, STAGGER weaves but stays collectable. WALL and FUNNEL
 * spread objects across lanes, so a roller can only ever take one of them: they are
 * navigation shapes, and leaning on them for weight makes the track's kilos
 * unreachable no matter how well the player drives.
 */
function formationMenu(zoneIndex, rng) {
  if (zoneIndex === 0) return rng.next() < 0.65 ? 'SIDE_FEED' : 'PAIR';   // teaching
  const roll = rng.next();
  if (zoneIndex === 1) return roll < 0.55 ? 'SIDE_FEED' : roll < 0.85 ? 'STAGGER' : 'PAIR';
  if (roll < 0.44) return 'SIDE_FEED';
  if (roll < 0.74) return 'STAGGER';
  if (roll < 0.86) return 'PAIR';
  if (roll < 0.94) return 'WALL';
  return 'FUNNEL';
}

function assemble(seed, centreScale) {
  const rng = new Rng(seed >>> 0);
  const R = TUNING.read;
  const W = TUNING.world;

  const plan = {
    seed: seed >>> 0,
    segments: [],        // {length, slopeDeg} feeding TrackProfile
    zones: [],
    objects: [],         // sorted by d
    holes: [],
    jumps: [],
    crests: [],
    house: null,
    totalLength: 0,
    totalAbsorbable: 0,
  };

  const visual = { key: '', scale: 1 };
  let d = 0;
  let arriveWeight = TUNING.player.startWeight;
  let nextId = 0;
  let nextFormationId = 0;

  const pushSegment = (length, slopeDeg) => {
    if (length <= 0) return;
    plan.segments.push({ length, slopeDeg });
    plan.totalLength += length;
  };

  let seenGauntlet = false;
  for (let zi = 0; zi < TUNING.weights.zones.length; zi++) {
    const zone = TUNING.weights.zones[zi];
    const speed = speedAtWeight(arriveWeight);
    const minGap = Math.max(R.minFormationGapMetres, R.minFormationGapSeconds * speed);
    const wantGap = Math.max(minGap, R.formationGapSeconds * speed);

    // The roller the player will realistically be driving here decides how wide
    // every gap in this zone has to be.
    const drumWidth = Math.min(TUNING.player.maxRadius,
      TUNING.player.baseRadius * Math.pow(arriveWeight / TUNING.player.startWeight, TUNING.player.radiusExp))
      * TUNING.player.widthRatio;
    const gapLanes = Math.max(1, Math.ceil((drumWidth + R.gapClearance) / W.laneWidth));

    // What the roller can actually do here, handed to the sweep formations so the
    // line they draw is one a player can hold. Lateral speed FALLS as weight
    // rises, while forward speed rises, so a late-zone sweep needs several times
    // the ramp length of an early one to cover the same lane change.
    const sweep = {
      speed,
      lateral: TUNING.player.baseLateralSpeed *
        Math.pow(TUNING.player.startWeight / arriveWeight, TUNING.player.lateralSpeedExp),
    };

    zone._centreScale = centreScale;
    const seq = zoneWeights(zone, arriveWeight, rng);
    if (!seq) continue;

    // ── build every formation first, then distribute them across the zone
    //
    // Two passes, not one. Laying formations down as they are built packs them all
    // into the first third of the zone and leaves the rest empty, and it buries the
    // centrepiece in the opening formation instead of ~60 % in where the decision
    // "have I eaten enough yet?" is actually interesting.
    const pending = [];
    for (let i = 0; i < seq.length; i++) {
      const entry = seq[i];
      pickVisual(entry.w, zone.tier, rng, visual);
      pending.push({ key: visual.key, weight: entry.w, scale: visual.scale, role: entry.role });
    }

    // The centrepiece is placed by hand, so pull it out of the formation stream.
    let centre = null;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].role !== 'FEEDER') { centre = pending.splice(i, 1)[0]; break; }
    }

    const events = [];        // {span, items:[...], type}
    let guard = 0;
    while (pending.length > 0 && guard++ < 200) {
      const before = pending.length;
      const items = [];
      const type = formationMenu(zi, rng);
      const span = buildFormation(type, pending, rng, items, gapLanes, sweep);
      if (pending.length === before) {          // consumed nothing; force progress
        const forced = [];
        const fspan = buildFormation('PAIR', pending, rng, forced, gapLanes, sweep);
        if (pending.length === before) pending.shift();
        else events.push({ span: fspan, items: forced, type: 'PAIR' });
        continue;
      }
      events.push({ span, items, type });
    }

    // Gauntlets between formations — every third gap, so every zone past the
    // teaching one actually has blockers rather than leaving it to a dice roll.
    if (!zone.teaching && events.length > 0) {
      // At least one per zone, then roughly one per three formations. Leaving this
      // to a per-gap dice roll produced whole zones with no blockers at all.
      // Every blocker is an instant loss, so they are punctuation, not texture.
      const want = Math.max(1, Math.round(events.length / R.gauntletEveryFormations));
      for (let g = 0; g < want; g++) {
        const at = clamp(Math.round(((g + 1) / (want + 1)) * events.length), 1, events.length);
        const items = [];
        // The first blocker anywhere on the track is the one that teaches what a
        // blocker is, and the lesson costs the whole run. Widen it and give it room.
        const first = !seenGauntlet;
        const lanes = gapLanes + (first ? R.firstGauntletExtraLanes : 0);
        const span = buildFormation('GAUNTLET', [], rng, items, lanes, sweep);
        events.splice(at, 0, {
          span, items, type: 'GAUNTLET',
          lead: first ? R.firstGauntletLeadSeconds * speed : 0,
        });
        seenGauntlet = true;
      }
    }

    // The centrepiece goes ~centreAt through the zone, in the riskiest lane, and
    // the gamble gets a gauntlet in front of it.
    if (centre) {
      const at = clamp(Math.round(events.length * zone.centreAt), 1, events.length);
      const lane = rng.next() < 0.5 ? 0 : W.laneCount - 1;
      const items = [{
        key: centre.key, weight: centre.weight, scale: centre.scale, role: centre.role,
        lane, d: 0, blocker: false,
      }];
      const cSpan = PROPS[centre.key].size[2] * centre.scale + 4;
      if (centre.role === 'GAMBLE') {
        const gItems = [];
        const gSpan = buildFormation('GAUNTLET', [], rng, gItems, gapLanes, sweep);
        events.splice(at, 0, { span: gSpan, items: gItems, type: 'GAUNTLET' });
        events.splice(at + 1, 0, { span: cSpan, items, type: 'CENTRE' });
      } else {
        events.splice(at, 0, { span: cSpan, items, type: 'CENTRE' });
      }
    }

    // ── distribute: even spacing, never tighter than the breathing-room rule
    const zoneStart = d;
    let spanTotal = 0;
    for (let i = 0; i < events.length; i++) spanTotal += events[i].span;
    const naturalLength = zone.seconds * speed;
    const needed = spanTotal + wantGap * (events.length + 1);
    const zoneLength = Math.max(naturalLength, needed);
    let zoneLengthExtra = 0;
    const slack = zoneLength - spanTotal - minGap * (events.length + 1);
    const extra = events.length > 0 ? Math.max(0, slack) / (events.length + 1) : 0;

    let cur = zoneStart + minGap + extra;
    for (let e = 0; e < events.length; e++) {
      const ev = events[e];
      if (ev.lead > 0) { cur += ev.lead; zoneLengthExtra += ev.lead; }
      const formationSeq = nextFormationId++;
      for (let i = 0; i < ev.items.length; i++) {
        const it = ev.items[i];
        plan.objects.push({
          id: nextId++,
          key: it.key,
          weight: it.weight,
          scale: it.scale || 1,
          role: it.role || 'FEEDER',
          blocker: !!it.blocker,
          d: cur + it.d,
          x: laneX(it.lane),
          lane: it.lane,
          rotY: (rng.next() - 0.5) * 0.18,
          zone: zi,
          formation: ev.type,
          formationId: formationSeq,
        });
        if (!it.blocker && isFinite(it.weight)) plan.totalAbsorbable += it.weight;
      }
      const gapAfter = minGap + extra;
      // Hazards live in the empty stretch between formations, never beside one.
      if (!zone.teaching && e < events.length - 1 && gapAfter > 34) {
        const mid = cur + ev.span + gapAfter * 0.5;
        const roll = rng.next();
        if (roll < 0.18) {
          const laneFrom = Math.floor(rng.next() * (W.laneCount - 1));
          plan.holes.push({ dStart: mid - 7, dEnd: mid + 7, laneFrom, laneTo: laneFrom + 1 });
        } else if (roll < 0.30) {
          plan.jumps.push({
            d: mid - 5, x: laneX(Math.floor(rng.next() * W.laneCount)),
            width: W.laneWidth * 1.3, length: 9, height: 2.6,
          });
        }
      }
      cur += ev.span + gapAfter;
    }
    // The first gauntlet's extra lead-in lengthens its zone rather than eating
    // into the pacing of everything after it.
    const zoneEnd = zoneStart + zoneLength + zoneLengthExtra;

    // Zone body, with an occasional steep stretch for a speed burst.
    const steep = !zone.teaching && rng.next() < 0.45;
    if (steep) {
      const a = (zoneEnd - zoneStart) * 0.55;
      pushSegment(a, W.baseSlopeDeg);
      pushSegment((zoneEnd - zoneStart) - a, W.steepSlopeDeg);
    } else {
      pushSegment(zoneEnd - zoneStart, W.baseSlopeDeg);
    }

    plan.zones.push({
      index: zi,
      name: zone.name,
      tier: zone.tier,
      dStart: zoneStart,
      dEnd: zoneEnd,
      budget: zone.budget,
      arriveWeight,
      teaching: !!zone.teaching,
    });

    d = zoneEnd;
    arriveWeight += zone.budget;

    // A flat crest between zones: the camera lifts and the next zone lays itself
    // out below, so the player plans before they commit.
    if (zi < TUNING.weights.zones.length - 1) {
      const crestLen = TUNING.time.crestHoldSeconds * speed;
      plan.crests.push({ d, length: crestLen, zoneAhead: zi + 1 });
      pushSegment(crestLen, 0);
      d += crestLen;
    }
  }

  // ── the finale: empty, steepening, with the house in view the whole way
  const finaleSpeed = speedAtWeight(arriveWeight);
  const runUp = TUNING.finale.runUpLength;
  pushSegment(runUp * 0.45, W.steepSlopeDeg);
  pushSegment(runUp * 0.55, W.finaleSlopeDeg);
  plan.house = { d: d + runUp, weight: TUNING.finale.houseWeight };
  plan.finaleStart = d;
  plan.finaleSpeed = finaleSpeed;
  d += runUp;
  pushSegment(120, W.finaleSlopeDeg);          // run-out past the house

  plan.objects.sort((a, b) => a.d - b.d);
  plan.totalLength = d + 120;
  return plan;
}

/* ───────────────────────────────────────────────── proving the track is winnable ── */

const DP_BINS = 97;

/**
 * The best final weight any single pass could achieve, with the weight gate on.
 *
 * A dynamic program over lateral position: each state carries the weight that path
 * has accumulated, which decides both what it may absorb next and how wide and
 * agile it is. This is the honest question — a track where the first centrepiece
 * cannot be reached leaves the player permanently under the curve, and every later
 * centrepiece stays red. Two seeds in twenty-five were like that before this ran.
 */
export function bestPossibleWeight(plan) {
  const P = TUNING.player;
  const HALF = TUNING.world.roadWidth / 2;
  const objs = plan.objects;
  const binX = (i) => -HALF + (i / (DP_BINS - 1)) * 2 * HALF;
  const drumHW = (w) => Math.min(P.maxRadius, P.baseRadius * Math.pow(w / P.startWeight, P.radiusExp))
    * P.widthRatio * 0.5;

  let w = new Float64Array(DP_BINS).fill(P.startWeight);
  let st = new Uint8Array(DP_BINS);
  let ok = new Uint8Array(DP_BINS).fill(1);
  const nw = new Float64Array(DP_BINS);
  const ns = new Uint8Array(DP_BINS);
  let prevD = 0;

  for (let k = 0; k < objs.length; k++) {
    const o = objs[k];
    const def = PROPS[o.key];
    if (!def) continue;
    const sc = o.scale || 1;
    const c = Math.abs(Math.cos(o.rotY || 0));
    const sn = Math.abs(Math.sin(o.rotY || 0));
    const ex = (c * def.size[0] * 0.5 + sn * def.size[2] * 0.5) * sc;

    nw.fill(-1);
    ns.fill(255);
    for (let i = 0; i < DP_BINS; i++) {
      if (!ok[i]) continue;
      const spd = Math.max(8, speedAtWeight(w[i]));
      const lat = P.baseLateralSpeed * Math.pow(P.startWeight / w[i], P.lateralSpeedExp);
      const bins = Math.max(0, Math.round((lat * ((o.d - prevD) / spd)) / (2 * HALF / (DP_BINS - 1))));
      const lo = Math.max(0, i - bins);
      const hi = Math.min(DP_BINS - 1, i + bins);
      for (let j = lo; j <= hi; j++) {
        if (w[i] > nw[j] || (w[i] === nw[j] && st[i] < ns[j])) { nw[j] = w[i]; ns[j] = st[i]; }
      }
    }
    for (let i = 0; i < DP_BINS; i++) {
      ok[i] = nw[i] >= 0 ? 1 : 0;
      w[i] = nw[i];
      st[i] = ns[i] === 255 ? 0 : ns[i];
    }
    prevD = o.d;

    for (let i = 0; i < DP_BINS; i++) {
      if (!ok[i]) continue;
      // Blockers are an instant loss, so the proof requires a line that keeps real
      // CLEARANCE from them, not one that shaves past. A track only a solver could
      // survive is not a winnable track.
      if (o.blocker) {
        if (Math.abs(binX(i) - o.x) < ex + drumHW(w[i]) + TUNING.read.blockerSafeMargin) ok[i] = 0;
        continue;
      }
      if (Math.abs(binX(i) - o.x) >= ex + drumHW(w[i])) continue;
      if (w[i] > o.weight) {
        w[i] += o.weight;
      } else {
        w[i] *= (1 - TUNING.collision.blockedWeightLoss);
        st[i]++;
        if (st[i] >= TUNING.collision.maxStrikes) ok[i] = 0;
      }
    }
  }
  let top = 0;
  for (let i = 0; i < DP_BINS; i++) if (ok[i] && w[i] > top) top = w[i];
  return top;
}

/**
 * Build a track and PROVE it is winnable before handing it over.
 *
 * If the best possible pass cannot clear the house with headroom, the centrepieces
 * are shrunk a little and the track is rebuilt. Shipping a seed nobody could beat
 * is the worst bug this generator could have, so it is checked rather than assumed.
 */
export function buildTrackPlan(seed) {
  const need = TUNING.finale.houseWeight * TUNING.weights.winHeadroom;
  let plan = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const scale = 1 - attempt * 0.10;
    plan = assemble(seed, scale);
    plan.bestPossible = bestPossibleWeight(plan);
    plan.centreScale = scale;
    if (plan.bestPossible >= need) break;
  }
  return plan;
}
