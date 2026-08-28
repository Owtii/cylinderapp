import { TUNING } from '../tuning.js';
import { Rng } from '../core/rng.js';
import { clamp } from '../core/math.js';
import { PROPS, pickVisual, fillFurniture } from './objects.js';
import { buildFormation, buildFurnitureRun, laneX } from './formations.js';
import { buildSetPiece, setPieceForZone, setPieceBudget } from './setpieces.js';
import { clampSlopeDeg, inLaneSpan, ROAD_HALF } from './track.js';

/**
 * Assembles the whole ramp up front: zones, formations, hazards, pitch-overs, the
 * §17 highway layer, the finale run-up and the house. The track is finite and
 * authored, so this runs once per run and the streamer just moves a window over it.
 *
 * Two rules from §6.1 are enforced here rather than left to taste, because they
 * are what makes the ramp readable at speed:
 *   • at least `minFormationGapSeconds` of EMPTY ramp between formations, measured
 *     in time at the speed the player will actually be doing;
 *   • formations only — never freehand placement — so every arrangement is one of
 *     six shapes the eye already knows.
 *
 * ── what v3 changed here ─────────────────────────────────────────────────────
 *
 * THE GRADE NEVER REACHES ZERO. v2 put a FLAT crest between every pair of zones
 * for the preview beat: 302 m of a 6,238 m track sat at grade 0, and §6.1 forbids
 * it outright ("the highway never levels out and never climbs"). Each crest is now
 * a PITCH-OVER — a short segment where the grade briefly increases instead. It buys
 * the same beat by the opposite means: tipping the nose down reveals the next zone
 * laid out below exactly the way cresting a rise did, and it pays a speed surge
 * rather than costing one. Every segment this file emits is clamped into
 * [world.minSlopeDeg, world.maxSlopeDeg] on the way out.
 *
 * THE OBJECT COUNTS ARE §7's. 20/15/12/10/8/5 objects of the zone's own tier. That
 * is the count of the zone's own-tier objects, and the landmark ladder sets their
 * weights: the top rungs are the zone's five landmarks and the remainder are its
 * feeders, so §7's table and the ladder are the same list read two ways. The ladder
 * itself is untouched, because it is what makes the outcome distribution continuous
 * (see the README: six centrepieces made the run six pass/fail checks).
 *
 * THE HIGHWAY LAYER CARRIES REAL WEIGHT. §17's furniture and set pieces are placed
 * here and `weights.highwayTrafficBudget` is reserved for `world/traffic.js`, which
 * schedules itself off `plan.zones`. Together they are `weights.highwayBudget` of
 * absorbable kilos ON TOP of §7's untouched 140,000, which is the only reason §16's
 * medals at 1.0/1.25/1.5x the house are reachable at all.
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
 * §17's weight, zone by zone.
 *
 * Furniture and traffic get separate share tables rather than one, because they
 * answer different questions: furniture is texture and grows with how industrial the
 * ramp looks, traffic grows with how fast the road is. Both are normalised here, so
 * editing one entry cannot silently change the total. The set-piece share is not
 * this file's to divide — `world/setpieces.js` owns it.
 *
 * Traffic's share is only ever used for PACING here: `world/traffic.js` schedules
 * itself off `plan.zones` against its own table, and the two only have to agree on
 * roughly how heavy the player is when they reach the next zone.
 */
function highwayShare(table, zi) {
  let sum = 0;
  for (let i = 0; i < table.length; i++) sum += table[i];
  const v = zi < table.length ? table[zi] : table[table.length - 1];
  return sum > 0 ? v / sum : 0;
}

function highwayZoneWeight(zi, out) {
  const WT = TUNING.weights;
  out.furniture = Math.round(WT.highwayFurnitureBudget * highwayShare(WT.highwayFurnitureShares, zi));
  // The set-piece share is `world/setpieces.js`'s to divide, not this file's: it is
  // the module that knows a tunnel needs eight rings and a toll plaza needs four
  // booths. Asked here only so the pacing weight below can count it.
  out.setPiece = Math.round(setPieceBudget(setPieceForZone(zi)));
  out.traffic = Math.round(WT.highwayTrafficBudget * highwayShare(WT.highwayTrafficShares, zi));
  return out;
}

/**
 * The weight curve for one zone: §7's object count, spent as a landmark ladder
 * plus whatever feeders are left over, summing to the zone budget exactly.
 *
 * §7's count and the ladder are reconciled the only way that keeps both honest:
 * the count is the zone's own-tier OBJECT count, the top `landmarkLadder.length`
 * of them are the landmarks, and the rest are feeders. The late zones ask for five
 * objects, which is exactly the ladder and no feeders at all — so the ladder has to
 * be able to close the budget on its own, and it does.
 */
function zoneWeights(zone, zi, arriveWeight, rng) {
  const WT = TUNING.weights;   // `W` is TUNING.world elsewhere in this file
  const scale = zone._centreScale || 1;
  const ladder = WT.landmarkLadder;

  const table = WT.zoneObjectCounts;
  const ownCount = Math.max(1, (table && table[zi]) || (zone.feeders + ladder.length));
  const rungCount = Math.min(ladder.length, ownCount);
  const feederCount = ownCount - rungCount;

  // ── the landmarks: a ladder, not a single centrepiece
  //
  // Every rung is capped against the weight the player would have arriving on
  // pace, so the top rung opens amber and the bottom rungs stay edible even for a
  // player who is well behind. Whatever a cap sheds falls through to the feeders,
  // so the zone's budget is spent exactly either way.
  const cap = snapWeight(arriveWeight * WT.landmarkMaxRatio * scale);
  let ladderSum = 0;
  for (let i = 0; i < rungCount; i++) ladderSum += ladder[i];
  // A zone with no feeders has nothing to hand the remainder to, so its ladder
  // holds the whole budget rather than `landmarkShare` of it.
  const landmarkPot = feederCount > 0 ? zone.budget * WT.landmarkShare : zone.budget;

  const marks = [];
  let placed = 0;
  for (let i = 0; i < rungCount; i++) {
    const w = snapWeight(Math.min(cap, landmarkPot * ladder[i] / ladderSum));
    if (w >= 10) { marks.push(w); placed += w; }
  }
  if (marks.length === 0) return null;

  const feeders = [];
  if (feederCount > 0) {
    const feederTotal = zone.budget - placed;
    if (feederTotal <= 0) return null;
    const share = feederTotal / feederCount;
    const [lo, hi] = WT.feederSpread;
    let acc = 0;
    for (let i = 0; i < feederCount - 1; i++) {
      const w = snapWeight(share * (lo + (hi - lo) * rng.next()));
      feeders.push(w);
      acc += w;
    }
    // The last feeder closes the budget exactly, whatever the rounding did.
    const last = feederTotal - acc;
    if (last > 0) feeders.push(last);
    else feeders[feeders.length - 1] += last;          // absorb an overshoot
  } else {
    // No feeders to catch what rounding and the cap shed. Spread the remainder
    // back over the rungs that still have room under the cap, heaviest first; a
    // zone that quietly spends less than §7's table says is the exact bug the
    // exact-budget machinery in objects.js exists to prevent.
    // Pass one respects the arrival-weight cap; pass two ignores it, because a
    // rung slightly over the cap is a legible amber target and a zone that is
    // 400 kg light is a lie about the track's total.
    let residual = zone.budget - placed;
    for (let pass = 0; pass < 2 && residual !== 0; pass++) {
      for (let i = 0; i < marks.length && residual !== 0; i++) {
        const room = pass === 0 ? Math.max(0, cap - marks[i]) : Infinity;
        const give = residual > 0
          ? Math.min(residual, room)
          : Math.max(residual, 10 - marks[i]);
        if (give === 0) continue;
        marks[i] += give;
        residual -= give;
      }
    }
  }

  // ── the running order
  //
  // Feeders first so the player arrives at each landmark heavier than they were,
  // with the top rung at `centreAt` through the zone — far enough in that "have I
  // eaten enough yet?" is a live question, early enough that the answer still
  // leaves ramp to act on.
  const cut = feeders.length > 1
    ? clamp(Math.round(feeders.length * zone.centreAt), 1, feeders.length - 1)
    : feeders.length;
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

/**
 * Which landmark rung wears a fuel tanker (§17), or -1 for none.
 *
 * The tanker is funded from §7's zone budget as the BODY of a ladder rung rather
 * than from the highway budget, and that is a decision worth stating: §17 calls the
 * tanker plow-tier, but a tanker sized to the plow band in the industrial zone
 * would weigh ~63 t on its own — nearly twice the entire 35,000 kg highway budget.
 * Wearing a rung it is a real target at a real weight, it detonates, and §7's table
 * does not move by a kilogram.
 *
 * Zone 3 only. `SETPIECE_PROPS` already stages a tanker in the traffic jam, the
 * construction zone and the final descent, so this fills the one gap in the second
 * half of the run where the player is heavy enough for the blast to be worth having
 * and no set piece is staging one. Rare is the whole value of it.
 */
function tankerRungForZone(zi) {
  return zi === 3 ? 0 : -1;
}

function assemble(seed, centreScale) {
  const rng = new Rng(seed >>> 0);
  const R = TUNING.read;
  const W = TUNING.world;
  const HZ = TUNING.hazards;
  const WT = TUNING.weights;

  const plan = {
    seed: seed >>> 0,
    segments: [],        // {length, slopeDeg} feeding TrackProfile
    zones: [],
    objects: [],         // sorted by d
    holes: [],
    jumps: [],
    boosts: [],          // §17 speed strips, in the risky outer lanes
    slicks: [],          // §17 oil, the only hazard that does not hurt directly
    narrows: [],         // §8, {dStart,dEnd,laneFrom,laneTo} — the OPEN corridor
    crests: [],          // §6.1 pitch-overs; the array's shape is unchanged from v2
    setPieces: [],       // §17, one per zone, for the HUD banner
    setPieceDecor: [],   // architecture the set pieces asked for; never collidable
    regions: [],         // audio / lighting / road spans the set pieces declared
    house: null,
    totalLength: 0,
    totalAbsorbable: 0,
    placedWeight: 0,     // kilos actually in plan.objects
    zoneWeight: 0,       // §7's 140,000
    furnitureWeight: 0,
    setPieceWeight: 0,
    trafficBudget: WT.highwayTrafficBudget,
  };

  const visual = { key: '', scale: 1 };
  const hw = { furniture: 0, setPiece: 0, traffic: 0 };
  let d = 0;
  let arriveWeight = TUNING.player.startWeight;
  let nextId = 0;
  let nextFormationId = 0;

  const pushSegment = (length, slopeDeg) => {
    if (length <= 0) return;
    // §6.1's acceptance criterion, enforced at the one door every segment goes
    // through rather than trusted to every caller.
    plan.segments.push({ length, slopeDeg: clampSlopeDeg(slopeDeg) });
    plan.totalLength += length;
  };

  const emit = (it, atD, zi, formation, formationId) => {
    const def = PROPS[it.key];
    if (!def) return;
    const blocker = !!it.blocker || !!def.blocker;
    plan.objects.push({
      id: nextId++,
      key: it.key,
      weight: it.weight,
      scale: it.scale || 1,
      role: it.role || 'FEEDER',
      blocker,
      // §17 tags. The streamer copies these onto the live record so the outline,
      // label and audio systems can treat texture, tankers and staged props
      // differently without re-deriving any of it from the catalogue every frame.
      furniture: !!it.furniture || !!def.furniture,
      tanker: !!it.tanker || !!def.tanker,
      setPiece: !!it.setPiece,
      d: atD,
      x: laneX(it.lane),
      lane: it.lane,
      rotY: it.rotY !== undefined ? it.rotY : (rng.next() - 0.5) * 0.18,
      zone: zi,
      formation,
      formationId,
      // Passed through untouched from `setpieces.js`. `trigger` names the decor
      // group this object brings down when it breaks; `moving` is that module
      // saying a stopped queue used to be traffic. WorldStream spawns everything
      // static — `world/traffic.js` owns everything that drives — so the flag is
      // carried, not acted on, and is here for whoever wants it.
      trigger: it.trigger || '',
      moving: !!it.moving,
      pooled: !!it.pooled,
    });
    if (!blocker && isFinite(it.weight)) {
      plan.placedWeight += it.weight;
      // A set piece's own furniture is funded by §17's set-piece share, so the test
      // order matters: it is set-piece weight first and texture second.
      if (it.setPiece && !it.pooled) plan.setPieceWeight += it.weight;
      else if (it.furniture || def.furniture) plan.furnitureWeight += it.weight;
      else plan.zoneWeight += it.weight;
    }
  };

  let seenGauntlet = false;
  for (let zi = 0; zi < WT.zones.length; zi++) {
    const zone = WT.zones[zi];
    const speed = speedAtWeight(arriveWeight);
    const minGap = Math.max(R.minFormationGapMetres, R.minFormationGapSeconds * speed);
    const wantGap = Math.max(minGap, R.formationGapSeconds * speed);
    highwayZoneWeight(zi, hw);

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
    const seq = zoneWeights(zone, zi, arriveWeight, rng);
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

    // §17's tanker wears a landmark rung. Rungs come out of `seq` in weight order
    // after the centre, so count them the same way the sequence built them.
    const tankerRung = tankerRungForZone(zi);
    if (tankerRung >= 0) {
      let rung = 0;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        if (p.role === 'FEEDER') continue;
        if (rung++ !== tankerRung) continue;
        const nominal = PROPS.fuelTanker ? PROPS.fuelTanker.weight : 0;
        const sc = nominal > 0 ? Math.pow(p.weight / nominal, 1 / 3) : 0;
        if (sc >= 0.72 && sc <= 1.75) { p.key = 'fuelTanker'; p.scale = sc; p.tanker = true; }
        break;
      }
    }

    // The centrepiece is placed by hand, so pull it out of the formation stream.
    let centre = null;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].role !== 'FEEDER') { centre = pending.splice(i, 1)[0]; break; }
    }

    // ── §17's set piece, built first
    //
    // It is placed last, at the zone's end, but it is BUILT first, because it may
    // claim one of the zone's own landmarks as its prize (§17's plow-tier moment is
    // only reachable that way — its own share cannot buy an object that heavy). The
    // pool is offered the rungs below the centre; whatever it does not take goes
    // straight back into the formation stream, so §7's budget is spent either way.
    const spName = setPieceForZone(zi);
    const spBudget = setPieceBudget(spName);
    const spDescs = [];
    const spPool = [];
    const spDecorMark = plan.setPieceDecor.length;
    let spSpan = 0;
    let spWeight = 0;
    if (spName && spBudget > 0) {
      for (let i = pending.length - 1; i >= 0 && spPool.length < 2; i--) {
        if (pending[i].role === 'FEEDER') continue;
        spPool.push(pending.splice(i, 1)[0]);
      }
      SP_OFFERED.length = 0;
      for (let i = 0; i < spPool.length; i++) SP_OFFERED.push(spPool[i]);

      SP_CTX.rng = rng;
      SP_CTX.zoneIndex = zi;
      SP_CTX.arriveWeight = arriveWeight;
      SP_CTX.speed = speed;
      SP_CTX.laneCount = W.laneCount;
      SP_CTX.laneWidth = W.laneWidth;
      SP_CTX.gapLanes = gapLanes;
      SP_CTX.budget = spBudget;
      SP_CTX.pool = spPool;
      SP_CTX.decor = plan.setPieceDecor;
      SP_CTX.regions = SP_REGIONS;
      SP_REGIONS.length = 0;
      spSpan = buildSetPiece(spName, SP_CTX, spDescs);

      // Which of the offered landmarks it actually took, by reference — the module
      // shifts the array, so what is missing from it is what was promoted.
      SP_TAKEN.length = 0;
      for (let i = 0; i < SP_OFFERED.length; i++) {
        if (spPool.indexOf(SP_OFFERED[i]) < 0) SP_TAKEN.push(SP_OFFERED[i]);
      }
      for (let i = 0; i < spPool.length; i++) pending.push(spPool[i]);
      if (spSpan <= 0 || spDescs.length === 0) { spSpan = 0; spDescs.length = 0; }
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
      const at = clamp(Math.round(events.length * zone.centreAt), 1, Math.max(1, events.length));
      const lane = rng.next() < 0.5 ? 0 : W.laneCount - 1;
      const items = [{
        key: centre.key, weight: centre.weight, scale: centre.scale, role: centre.role,
        tanker: !!centre.tanker, lane, d: 0, blocker: false,
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

    // ── §8's narrow: a squeeze to two lanes, authored as an EVENT
    //
    // One per zone from `narrowFromZone` on, spliced into the formation stream like
    // a gauntlet rather than dropped into whatever empty stretch happened to be long
    // enough. Two earlier attempts placed it in a gap and both failed for the same
    // reason: a gap is 2.5 s of ramp, and a narrow plus the clearance a player needs
    // to get back across the road afterwards is more than four. As an event it comes
    // with a full breathing gap either side for free, and the zone lengthens to hold
    // it exactly the way it lengthens for anything else.
    //
    // It carries no objects — the hazard IS the missing road — and its corridor is
    // chosen to agree with whatever blockers stand on either side of it, because the
    // corridor is the only road there is and a blocker across it closes the track.
    // The winnability proof caught precisely that on one seed in forty.
    if (zi >= HZ.narrowFromZone && events.length > 1) {
      // Lanes a formation leaves free of blockers, as a bitmask. A narrow beside a
      // gauntlet is only survivable if the corridor and the gauntlet's opening are
      // the same lanes, so the two are chosen together rather than the narrow simply
      // refusing to sit next to blockers — in the late zones almost every slot is
      // next to blockers, and refusing left the industrial zone with no narrow at all.
      const freeMask = (ev) => {
        let m = (1 << W.laneCount) - 1;
        if (!ev) return m;
        for (let i = 0; i < ev.items.length; i++) if (ev.items[i].blocker) m &= ~(1 << ev.items[i].lane);
        return m;
      };
      const lanes = clamp(Math.max(2, gapLanes), 2, W.laneCount - 1);
      const need = ((1 << lanes) - 1);
      let at = -1;
      let from = -1;
      const first = 1 + Math.floor(rng.next() * Math.max(1, events.length - 1));
      for (let k = 0; k < events.length - 1 && at < 0; k++) {
        const i = 1 + ((first - 1 + k) % Math.max(1, events.length - 1));
        const mask = freeMask(events[i - 1]) & freeMask(events[i]);
        const starts = [];
        for (let f = 0; f + lanes <= W.laneCount; f++) if ((mask & (need << f)) === (need << f)) starts.push(f);
        if (starts.length === 0) continue;
        at = i;
        from = starts[Math.floor(rng.next() * starts.length) % starts.length];
      }
      if (at >= 0) {
        events.splice(at, 0, {
          span: Math.max(HZ.narrowMinMetres, HZ.narrowSeconds * speed),
          items: [], type: 'NARROW',
          narrow: { laneFrom: from, laneTo: from + lanes - 1 },
        });
      }
    }

    // ── distribute: even spacing, never tighter than the breathing-room rule
    const zoneStart = d;
    let spanTotal = 0;
    for (let i = 0; i < events.length; i++) spanTotal += events[i].span;
    // The set piece is content the zone pays for out of its own pacing target, not
    // ramp bolted on after it: reserving its span here means a zone only gets longer
    // when it genuinely cannot afford the piece, and §7's seconds still mean seconds.
    const setReserve = spSpan > 0 ? spSpan + wantGap : 0;
    const naturalLength = Math.max(wantGap * 2, zone.seconds * speed - setReserve);
    const needed = spanTotal + wantGap * (events.length + 1);
    const zoneLength = Math.max(naturalLength, needed);
    let zoneLengthExtra = 0;
    const slack = zoneLength - spanTotal - minGap * (events.length + 1);
    const extra = events.length > 0 ? Math.max(0, slack) / (events.length + 1) : 0;

    // Every empty stretch in this zone, collected as it is laid out. Hazards go in
    // one, §17's furniture goes in all of them, and neither is ever allowed beside
    // a formation — the breathing room IS the read.
    const gaps = [];
    let cur = zoneStart + minGap + extra;
    let formationsEnd = cur;
    let firstStart = cur;
    let firstBlocker = false;
    for (let e = 0; e < events.length; e++) {
      const ev = events[e];
      if (ev.lead > 0) { cur += ev.lead; zoneLengthExtra += ev.lead; }
      if (e === 0) {
        firstStart = cur;
        for (let i = 0; i < ev.items.length; i++) if (ev.items[i].blocker) firstBlocker = true;
      }
      if (ev.narrow) {
        plan.narrows.push({
          dStart: cur, dEnd: cur + ev.span,
          laneFrom: ev.narrow.laneFrom, laneTo: ev.narrow.laneTo, zone: zi,
        });
      }
      const formationSeq = nextFormationId++;
      let hasBlocker = false;
      for (let i = 0; i < ev.items.length; i++) {
        const it = ev.items[i];
        emit(it, cur + it.d, zi, ev.type, formationSeq);
        if (it.blocker) hasBlocker = true;
      }
      const gapAfter = minGap + extra;
      if (e < events.length - 1) {
        // Whether either neighbour carries blockers decides what may go in here: a
        // narrow next to a gauntlet is not a hazard, it is a closed road.
        const next = events[e + 1];
        let nextBlocker = false;
        for (let i = 0; i < next.items.length; i++) if (next.items[i].blocker) nextBlocker = true;
        gaps.push({
          a: cur + ev.span, b: cur + ev.span + gapAfter,
          afterBlocker: hasBlocker, nextBlocker,
          narrow: ev.narrow ? plan.narrows[plan.narrows.length - 1] : null,
        });
      }
      cur += ev.span + gapAfter;
      formationsEnd = cur - gapAfter;
    }

    // The run-in to the zone is an empty stretch like any other, and in the late
    // zones it is the LONGEST one: three formations in a kilometre leaves two gaps
    // between them and hundreds of metres before the first. Leaving it out meant
    // every gap a narrow could use was also the one gap beside the zone's gauntlet,
    // and no track ever got one.
    if (events.length > 0 && firstStart - zoneStart > R.furnitureClearance * 3) {
      gaps.unshift({
        a: zoneStart + R.furnitureClearance, b: firstStart - R.furnitureClearance,
        afterBlocker: false, nextBlocker: firstBlocker,
      });
    }

    // ── hazards live in the empty stretches, never beside a formation
    if (!zone.teaching) {
      for (let g = 0; g < gaps.length; g++) {
        const gap = gaps[g];
        if (gap.hazard || gap.b - gap.a < HZ.minGapMetres) continue;
        const mid = (gap.a + gap.b) * 0.5;
        const roll = rng.next();
        let acc = HZ.holeChance;
        if (roll < acc) {
          const laneFrom = Math.floor(rng.next() * (W.laneCount - 1));
          plan.holes.push({ dStart: mid - 7, dEnd: mid + 7, laneFrom, laneTo: laneFrom + 1 });
          gap.hazard = 'HOLE';
          continue;
        }
        acc += HZ.jumpChance;
        if (roll < acc) {
          plan.jumps.push({
            d: mid - 5, x: laneX(Math.floor(rng.next() * W.laneCount)),
            width: W.laneWidth * 1.3, length: 9, height: 2.6,
          });
          gap.hazard = 'JUMP';
          continue;
        }
        acc += HZ.boostChance;
        if (roll < acc) {
          // §17: speed and danger have to correlate, so the strip is always in an
          // outer lane. Taking it is a decision, not a pickup you drive over.
          const lane = rng.next() < 0.5 ? 0 : W.laneCount - 1;
          plan.boosts.push({
            d: mid - HZ.boostLength * 0.5, length: HZ.boostLength,
            x: laneX(lane), width: W.laneWidth * 0.9, lane,
          });
          gap.hazard = 'BOOST';
          continue;
        }
        acc += HZ.slickChance;
        if (roll < acc) {
          const lane = Math.floor(rng.next() * W.laneCount);
          plan.slicks.push({
            d: mid - HZ.slickLength * 0.5, length: HZ.slickLength,
            x: laneX(lane), width: W.laneWidth * 0.95, lane,
          });
          gap.hazard = 'SLICK';
          continue;
        }
      }
    }

    // ── §17's set piece closes the zone
    //
    // After a full breathing gap, at the zone's end, so it reads as the punctuation
    // between two zones rather than as one more formation. `setpieces.js` spends its
    // own share and holds its own caps, so nothing here touches a weight; all this
    // owns is where the piece starts and how much of the zone it lengthens.
    let setPieceEnd = 0;
    if (spSpan > 0) {
      const formationSeq = nextFormationId++;
      // One pacing gap after the last formation, never the zone's own generous
      // spacing: in the late zones `extra` is three hundred metres and the piece
      // would arrive after a silence longer than the zone it belongs to.
      const dStart = formationsEnd + wantGap;
      for (let i = 0; i < spDescs.length; i++) {
        const dsc = spDescs[i];
        dsc.lane = clamp(dsc.lane | 0, 0, W.laneCount - 1);
        // A promoted landmark is still one of §7's objects wearing a set piece's
        // costume, so it is marked and stays in the zone's own count.
        for (let t = 0; t < SP_TAKEN.length; t++) {
          if (SP_TAKEN[t].key !== dsc.key || SP_TAKEN[t].weight !== dsc.weight) continue;
          dsc.pooled = true;
          SP_TAKEN.splice(t, 1);
          break;
        }
        emit(dsc, dStart + (dsc.d || 0), zi, 'SETPIECE', formationSeq);
        if (!dsc.blocker && isFinite(dsc.weight) && !dsc.pooled) spWeight += dsc.weight;
      }
      plan.setPieces.push({
        name: spName, zone: zi, dStart, dEnd: dStart + spSpan,
        weight: spWeight, span: spSpan,
      });
      for (let i = 0; i < SP_REGIONS.length; i++) {
        const r = SP_REGIONS[i];
        r.d += dStart;
        r.zone = zi;
        plan.regions.push(r);
      }
      // The decor was appended straight onto the plan in piece-local d; walk the
      // tail this piece added and lift it into track space.
      for (let i = spDecorMark; i < plan.setPieceDecor.length; i++) {
        plan.setPieceDecor[i].d += dStart;
        plan.setPieceDecor[i].zone = zi;
      }
      setPieceEnd = dStart + spSpan + minGap;
      // The run-in to the piece is another empty stretch, and in the late zones the
      // zone's furniture share needs every metre of ramp it can get.
      if (dStart - formationsEnd > R.furnitureClearance * 3) {
        gaps.push({
          a: formationsEnd + R.furnitureClearance, b: dStart - R.furnitureClearance,
          afterBlocker: false, nextBlocker: false,
        });
      }
    }

    // The first gauntlet's extra lead-in lengthens its zone rather than eating into
    // the pacing of everything after it, and a set piece that overruns the target
    // does the same — but only by however much it actually overran.
    const zoneEnd = Math.max(zoneStart + zoneLength + zoneLengthExtra, setPieceEnd);

    // The zone's tail — past the set piece, up to the boundary — is furniture only.
    // A hazard there would sit on top of the pitch-over that previews the next zone,
    // which is the one place on the ramp the player is reading ahead rather than in
    // front of them.
    const tailStart = Math.max(setPieceEnd, formationsEnd + minGap);
    if (zoneEnd - tailStart > R.furnitureClearance * 3) {
      gaps.push({ a: tailStart, b: zoneEnd - R.furnitureClearance });
    }

    // ── §17's furniture: texture, laid into every empty stretch
    //
    // Exempt from the object cap and from the breathing-room rule by design (it is
    // not a decision), so it gets `formationId: -1` and never joins a cluster. It is
    // still absorbable, still snapped to lane centres, and still kept clear of
    // blockers and of a narrow's void, because a cone floating over a hole teaches
    // the player the wrong thing about where the road is.
    //
    // Runs go round the zone's empty stretches in rotation and each stretch keeps
    // its own cursor. Picking a gap at random instead piled three runs into one and
    // left the next two bare, which is the opposite of texture — and it put 33
    // pieces inside a single four-second window, nine of which the streamer then
    // had to throw away every frame.
    if (hw.furniture > 0 && gaps.length > 0) {
      const mid = (W.laneCount - 1) / 2;
      const keys = [];
      const kg = fillFurniture(hw.furniture, zi, rng, keys);
      if (kg > 0 && keys.length > 0) {
        // A gap next to a gauntlet keeps its distance. A blocker is the only object
        // on the ramp that ends the run on contact, and a row of cones beside one is
        // three more silhouettes inside the read that matters most.
        const padOf = (blocked) => (blocked ? R.furnitureBlockerClearance : R.furnitureClearance);
        for (let g = 0; g < gaps.length; g++) gaps[g].cursor = gaps[g].a + padOf(gaps[g].afterBlocker);
        const run = [];
        let ki = 0;
        let g = Math.floor(rng.next() * gaps.length) % gaps.length;
        let stalled = 0;
        // Two sweeps. The first lays runs with room to breathe; the second goes back
        // round placing whatever is left one piece at a time, tight. Without it the
        // zone's share is under-spent by a third whenever the gaps run short, and an
        // under-spent share is a track that does not hold what §17 says it holds.
        let phase = 0;
        while (ki < keys.length && phase < 2) {
          if (stalled >= gaps.length) { phase++; stalled = 0; continue; }
          const gap = gaps[g];
          g = (g + 1) % gaps.length;
          const room = gap.b - padOf(gap.nextBlocker) - gap.cursor;
          if (room < R.furnitureRunStep) { stalled++; continue; }

          // Furniture hugs the outer lanes: that is where the eye is not looking for
          // a decision, and it is what makes the shoulders read as a highway rather
          // than as an empty strip of tarmac.
          let lane = rng.next() < 0.72
            ? (rng.next() < 0.5 ? 0 : W.laneCount - 1)
            : Math.floor(rng.next() * W.laneCount);
          const drift = rng.next() < 0.35 ? (lane === 0 ? 1 : -1) : 0;
          if (gap.narrow) {
            // Line the mouth of a squeeze instead: the run IS the funnel that tells
            // the player which two lanes survive.
            lane = gap.narrow.laneFrom === 0 ? gap.narrow.laneTo + 1 : gap.narrow.laneFrom - 1;
          }
          lane = clamp(lane, 0, W.laneCount - 1);

          // Shrink the run until it fits rather than skipping it: `fillFurniture`
          // spends the zone's share EXACTLY, so a piece that never gets laid down is
          // 40 kg silently deleted from a budget the medal ladder is measured against.
          let count = phase === 1 ? 1 : Math.min(keys.length - ki,
            R.furnitureRunMin + Math.floor(rng.next() * (R.furnitureRunMax - R.furnitureRunMin + 1)));
          let span = 0;
          while (count > 0) {
            run.length = 0;
            span = buildFurnitureRun(keys, ki, count, lane, drift, rng, run);
            if (span <= room || count === 1) break;
            count--;
          }
          if (run.length === 0) { stalled++; continue; }
          stalled = 0;

          const base = gap.cursor + (phase === 0 ? rng.next() * Math.max(0, room - span) * 0.35 : 0);
          for (let i = 0; i < run.length; i++) {
            const it = run[i];
            const at = base + it.d;
            // Never drop a piece that landed over a void; move it to the nearest
            // lane that has road under it instead.
            //
            // Stepping one lane at a time toward the middle is not enough: a hole
            // spanning lanes 1-2 puts a piece in lane 2 back into lane 1 and then
            // straight into lane 2 again, and the walk oscillates until it runs out
            // of tries with the cone still hanging over the hole. A narrow's corridor
            // can also sit against the shoulder, so "inward" is not even the right
            // direction. Search outward from the piece's lane in both directions,
            // nearest first and inward on a tie, and take the first lane with road.
            if (overHazard(plan, at, laneX(it.lane))) {
              const from = it.lane;
              const inward = from < mid ? 1 : -1;
              for (let step = 1; step < W.laneCount; step++) {
                const a = clamp(from + inward * step, 0, W.laneCount - 1);
                if (!overHazard(plan, at, laneX(a))) { it.lane = a; break; }
                const b = clamp(from - inward * step, 0, W.laneCount - 1);
                if (!overHazard(plan, at, laneX(b))) { it.lane = b; break; }
              }
            }
            emit(it, at, zi, 'FURNITURE', -1);
          }
          gap.cursor = base + span + R.furnitureRunStep * (phase === 0 ? 1.2 : 0.4);
          ki += run.length;
        }
      }
    }


    // ── the grade through the zone
    //
    // Base, an optional steep stretch for a speed burst, then base again. The tail
    // matters: the pitch-over at the zone boundary is only a pitch-over if the
    // grade it steepens FROM is the shallow one.
    const body = zoneEnd - zoneStart;
    if (!zone.teaching && rng.next() < 0.45) {
      pushSegment(body * 0.45, W.baseSlopeDeg);
      pushSegment(body * 0.30, W.steepSlopeDeg);
      pushSegment(body * 0.25, W.baseSlopeDeg);
    } else {
      pushSegment(body, W.baseSlopeDeg);
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
      highwayWeight: hw.furniture + hw.setPiece + hw.traffic,
      trafficBudget: hw.traffic,
    });

    d = zoneEnd;
    // On pace the player leaves a zone carrying its budget plus the share of §17's
    // highway layer a competent line actually picks up — furniture and traffic are
    // opportunistic, so only `highwayPaceFraction` of them counts toward the weight
    // the next zone's landmarks are sized against.
    arriveWeight += zone.budget +
      WT.highwayPaceFraction * (hw.furniture + hw.setPiece + hw.traffic);

    // ── the pitch-over between zones (§6.1)
    //
    // v2 flattened here so the camera could lift and show the next zone. v3 is not
    // allowed to flatten, so it does the opposite: the grade steepens for a second
    // and a half, the nose drops, and the zone below comes into frame the same way
    // — with a speed surge instead of a stall. `plan.crests` keeps its name and its
    // shape because the camera and the HUD read it; it just describes a tip-over now.
    if (zi < WT.zones.length - 1) {
      const pitchLen = W.pitchOverSeconds * speedAtWeight(arriveWeight);
      plan.crests.push({
        d, length: pitchLen, zoneAhead: zi + 1,
        slopeDeg: clampSlopeDeg(W.pitchOverDeg), pitchOver: true,
      });
      pushSegment(pitchLen, W.pitchOverDeg);
      d += pitchLen;
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
  // What the ramp is really carrying: everything placed here, plus the kilos
  // `world/traffic.js` is contracted to put on the road. Traffic schedules itself
  // off `plan.zones`, so its weight is reserved rather than placed, and saying so
  // out loud is what keeps the medal ladder honest.
  plan.totalAbsorbable = plan.placedWeight + plan.trafficBudget;
  return plan;
}

/* Reused so a rebuild does not allocate a fresh context per zone per attempt. */
const SP_CTX = {
  rng: null, zoneIndex: 0, arriveWeight: 0, speed: 0,
  laneCount: 0, laneWidth: 0, gapLanes: 1, budget: 0,
  pool: null, decor: null, regions: null,
};
/* Regions come back in piece-local d and have to be lifted into track space before
   they are kept, so they land here first. */
const SP_REGIONS = [];
/* The landmarks offered to a set piece as a prize, and the ones it took. */
const SP_OFFERED = [];
const SP_TAKEN = [];

/** Is (d, x) over a hole or outside a narrow's corridor? */
function overHazard(plan, d, x) {
  for (let i = 0; i < plan.holes.length; i++) {
    const h = plan.holes[i];
    if (d >= h.dStart - 4 && d <= h.dEnd + 4 && inLaneSpan(x, h.laneFrom, h.laneTo)) return true;
  }
  for (let i = 0; i < plan.narrows.length; i++) {
    const nr = plan.narrows[i];
    if (d >= nr.dStart - 4 && d <= nr.dEnd + 4 && !inLaneSpan(x, nr.laneFrom, nr.laneTo)) return true;
  }
  return false;
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
 *
 * v3 adds the fatal GEOMETRY to the program. v2 proved a line past every blocker
 * and then ignored the holes entirely, which was survivable while holes were 14 m
 * of missing shoulder — §8's narrows close two or three lanes for eighty metres at
 * a time, and a proof that cannot see them is not a proof. Holes and narrows are
 * both lane spans with no road in them, so both are walked the same way.
 *
 * Traffic is deliberately NOT counted: `world/traffic.js` puts a further
 * `weights.highwayTrafficBudget` of paper-tier kilos on the ramp, and leaving them
 * out keeps this a lower bound on what a perfect pass can do — which is the only
 * kind of number a winnability gate may be built on. `plan.ceilingEstimate` adds an
 * estimate of them back for the medal maths, and says so in its name.
 */
export function bestPossibleWeight(plan) {
  const P = TUNING.player;
  const HALF = ROAD_HALF;
  const binX = (i) => -HALF + (i / (DP_BINS - 1)) * 2 * HALF;
  const drumHW = (w) => Math.min(P.maxRadius, P.baseRadius * Math.pow(w / P.startWeight, P.radiusExp))
    * P.widthRatio * 0.5;

  // Objects and void gates, merged into one stream in travel order. A void is
  // sampled at both ends and in the middle: the DP only knows where a path is at
  // an event, so a band it never samples is a band it never proves.
  const events = [];
  for (let i = 0; i < plan.objects.length; i++) {
    const o = plan.objects[i];
    if (PROPS[o.key]) events.push({ d: o.d, o, band: null });
  }
  const addVoid = (dStart, dEnd, from, to, invert) => {
    const mid = (dStart + dEnd) * 0.5;
    for (let s = 0; s < 3; s++) {
      const at = s === 0 ? dStart : s === 1 ? mid : dEnd;
      events.push({ d: at, o: null, band: { from, to, invert } });
    }
  };
  for (let i = 0; i < plan.holes.length; i++) {
    const h = plan.holes[i];
    addVoid(h.dStart, h.dEnd, h.laneFrom, h.laneTo, false);
  }
  for (let i = 0; i < plan.narrows.length; i++) {
    const nr = plan.narrows[i];
    addVoid(nr.dStart, nr.dEnd, nr.laneFrom, nr.laneTo, true);
  }
  events.sort((a, b) => a.d - b.d);

  let w = new Float64Array(DP_BINS).fill(P.startWeight);
  let st = new Uint8Array(DP_BINS);
  let ok = new Uint8Array(DP_BINS).fill(1);
  const nw = new Float64Array(DP_BINS);
  const ns = new Uint8Array(DP_BINS);
  let prevD = 0;

  for (let k = 0; k < events.length; k++) {
    const ev = events[k];
    const o = ev.o;

    nw.fill(-1);
    ns.fill(255);
    for (let i = 0; i < DP_BINS; i++) {
      if (!ok[i]) continue;
      const spd = Math.max(8, speedAtWeight(w[i]));
      const lat = P.baseLateralSpeed * Math.pow(P.startWeight / w[i], P.lateralSpeedExp);
      const bins = Math.max(0, Math.round((lat * ((ev.d - prevD) / spd)) / (2 * HALF / (DP_BINS - 1))));
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
    prevD = ev.d;

    // A void: there is no road here, so a path standing on it is not a path. The
    // margin is the blocker margin for the same reason — brushing the edge of a
    // hole at 40 m/s is not a line a human holds.
    if (ev.band) {
      const b = ev.band;
      for (let i = 0; i < DP_BINS; i++) {
        if (!ok[i]) continue;
        const x = binX(i);
        const inside = inLaneSpan(x, b.from, b.to);
        const solid = b.invert ? inside : !inside;
        if (!solid) { ok[i] = 0; continue; }
        // Enough road under the drum to sit on, not just under its centre.
        const hwd = drumHW(w[i]) * 0.6 + TUNING.read.blockerSafeMargin;
        const lo = b.invert ? inLaneSpan(x - hwd, b.from, b.to) : !inLaneSpan(x - hwd, b.from, b.to);
        const hi = b.invert ? inLaneSpan(x + hwd, b.from, b.to) : !inLaneSpan(x + hwd, b.from, b.to);
        if (!lo || !hi) ok[i] = 0;
      }
      continue;
    }

    const def = PROPS[o.key];
    const sc = o.scale || 1;
    const c = Math.abs(Math.cos(o.rotY || 0));
    const sn = Math.abs(Math.sin(o.rotY || 0));
    const ex = (c * def.size[0] * 0.5 + sn * def.size[2] * 0.5) * sc;

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
  // A track must also leave GOLD on the table. Measured over 40 seeds, the win gate
  // alone let one seed in forty top out below 1.5x the house even on a perfect line,
  // which for a shared daily seed means somebody gets a day where the top medal is
  // arithmetically impossible and no amount of skill reaches it. The rebuild loop
  // already lightens the landmark ladder each attempt, and lighter landmarks turn
  // green sooner and so raise the ceiling, which is exactly the lever this needs.
  const goldNeed = TUNING.finale.houseWeight * TUNING.medals.gold;
  let plan = null;
  let best = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const scale = 1 - Math.min(4, attempt) * 0.10;
    // Later attempts also re-roll the LAYOUT, not just the landmark weights. Seed
    // 3714 was the case that forced this: it settled at scale 1.00 with a ceiling
    // 18,510 kg short of gold, and lightening its landmarks did nothing, because
    // what capped it was geometry — formations that fall where the roller cannot
    // sweep them. Salting the generator's rng explores genuinely different layouts
    // while the track stays a pure function of `seed`, so a daily seed is still the
    // same track for everybody.
    const salt = attempt === 0 ? 0 : Math.imul(attempt, 0x9e3779b9) >>> 0;
    plan = assemble((seed ^ salt) >>> 0, scale);
    plan.seed = seed >>> 0;                      // identity is the ORIGINAL seed
    plan.attempt = attempt;
    plan.bestPossible = bestPossibleWeight(plan);
    // The ceiling including the traffic the plan reserved but did not place. Only
    // for reading the medal ladder against — the win gate uses the proven number.
    plan.ceilingEstimate = plan.bestPossible +
      plan.trafficBudget * TUNING.weights.trafficCollectFraction;
    plan.centreScale = scale;
    // Keep the roomiest attempt seen, so a seed that never satisfies both gates
    // still returns its best candidate rather than whichever one ran last.
    if (!best || plan.ceilingEstimate > best.ceilingEstimate) best = plan;
    if (plan.bestPossible >= need && plan.ceilingEstimate >= goldNeed) return plan;
  }
  return best;
}
