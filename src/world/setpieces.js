import { TUNING } from '../tuning.js';
import { PROPS } from './objects.js';
import { ROAD_HALF } from './track.js';
import { speedAtWeight } from './trackplan.js';

/**
 * The six set pieces (§17). One per zone, and always its last beat.
 *
 * "Each zone ends with something that isn't just another formation." A formation is
 * a shape read in one glance and answered with one steering decision. A set piece is
 * a SEQUENCE of those — a plaza, a jam, a tunnel, a collapse — and its job is to be
 * the thing a player describes afterwards rather than the thing they solved.
 *
 * Everything here is still bound by §6.1, and that is the whole engineering problem.
 * Twelve interactive objects visible, five in the near band, lane centres only, and
 * a line a roller with the lateral speed of that zone can actually hold. A set piece
 * is allowed to be LONGER than a formation, and that is the only slack it gets: it
 * buys its size in metres of ramp, never in simultaneous objects. So a piece is
 * authored as RANKS and `layout` spaces them until the caps provably hold at the
 * speed the player will really be doing. Both of layout's rules are derived rather
 * than authored, because both were got wrong by hand in v2 and the README documents
 * what that cost.
 *
 * THE WEIGHT BUDGET, AND WHAT IT COSTS. §17 gives all six pieces 7,000 kg between
 * them (`weights.highwaySetPieceBudget`) — 4 % of the 175,500 kg track. That number
 * is not negotiable; it is a third of what makes gold reachable. It is also far less
 * than the catalogue weights of the props these pieces are built from: a toll booth
 * is 2,600 kg in `objects.js`, and eight of them are three times the entire
 * set-piece budget. So a set piece authors its SILHOUETTE from the catalogue and its
 * WEIGHT from the budget, and reconciles the two exactly as `pickVisual` already
 * does — a cube-root scale with a floor. Two consequences are visible in play and
 * are worth stating rather than discovering:
 *
 *   • every set-piece object is PAPER at the weight its zone opens at, by
 *     construction (`paperCap`). Nothing here can cost a strike, which is right: the
 *     player is funnelled into a set piece, and a funnel that can end the run is a
 *     trap rather than a spectacle;
 *   • §17's "cement mixer as a plow-tier prize" does not fit in 7,000 kg. Plow tier
 *     in the freight yard is ~20,000 kg for one object. Where the caller can afford
 *     it, pass `ctx.pool` and objects marked `prize` draw from the ZONE's own budget
 *     instead — already sized against arrival weight by `landmarkMaxRatio`, 0.78,
 *     which IS the plow boundary. That is the only way to get the intended beat
 *     without moving a number in §7.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not touch audio, lighting, the road or the
 * HUD. It emits three streams and lets the owners of those systems read them:
 * descriptors into `out` (the shape `trackplan` already pushes into `plan.objects`),
 * architecture into `ctx.decor`, and spans into `ctx.regions` — the tunnel's reverb
 * and darkness, §8's two-lane narrow, and the overpass collapse are all regions.
 */

/**
 * The streamer counts an object as on screen from `playerD - 20` (`_enforceBudget`
 * in `world/generator.js`), so the band a cap is actually measured over is twenty
 * metres LONGER than the forward window a piece would naively be spaced against. It
 * matters here and almost nowhere else: a formation is one rank, and one rank leaves
 * the band as a unit, but a set piece is four or five ranks and the player misses
 * most of what they drive past. Spaced against the forward window alone the toll
 * plaza put EIGHT objects into a five-object band, and the streamer answered by
 * freeing the render handles of three of them mid-plaza — which is worse than it
 * sounds, because `game.js` gates collision on `alive` and not on `visible`, so the
 * player then smashes a booth that is not drawn.
 */
const TRAIL_METRES = 20;

/** Zone order. §17 gives every zone exactly one. */
const ORDER = ['tollPlaza', 'trafficJam', 'tunnel', 'overpass', 'construction', 'finalDescent'];

/** @returns {string} the set piece that closes a zone. */
export function setPieceForZone(zoneIndex) {
  const i = zoneIndex < 0 ? 0 : zoneIndex >= ORDER.length ? ORDER.length - 1 : zoneIndex | 0;
  return ORDER[i];
}

/* ────────────────────────────────────────────────────────────── the authoring ── */

/**
 * A piece under construction. Authoring is declarative — ranks of items, plus decor
 * and regions anchored to a rank — and every distance is resolved afterwards by
 * `layout`, because a rank's `d` depends on how many objects the ranks before it
 * hold and on how fast the player is going, and an author should not be doing that
 * arithmetic by hand. That is precisely the arithmetic v2 got wrong.
 */
class Piece {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.rows = [];
    this.decor = [];
    this.regions = [];
    this.corridor = null;        // set by a piece that narrows the ramp
    this.span = 0;
  }

  /**
   * One rank across the ramp. `items` are `{ lane, key, w, ... }`, where `w` is a
   * RELATIVE weight normalised against the piece's share in `spendBudget` — an
   * author writes ratios and never has to know what a sixth of 7,000 kg is.
   */
  row(items) {
    this.rows.push({ items, d: 0 });
    return this.rows.length - 1;
  }

  /** A rank of identical props, one per lane in `lanes`. */
  line(lanes, key, w, opts) {
    const items = [];
    for (let i = 0; i < lanes.length; i++) items.push(item(lanes[i], key, w, opts));
    return this.row(items);
  }

  /**
   * Architecture. Never collidable, never labelled, never counted against §6.1's
   * object budget — a gantry the player drives under is not a decision, and the
   * moment it is treated as one the near-band cap eats the entire set piece.
   */
  prop(atRow, dOffset, key, x, scale, extra) {
    const e = { kind: 'prop', key, atRow, dOffset, x, y: 0, rotY: 0, scale: scale || 1 };
    if (extra) for (const k in extra) e[k] = extra[k];
    this.decor.push(e);
    return e;
  }

  /** A span the audio, lighting or road layers read. See the module header. */
  region(kind, atRow, dOffset, length, extra) {
    const e = { kind, atRow, dOffset, length };
    if (extra) for (const k in extra) e[k] = extra[k];
    this.regions.push(e);
    return e;
  }
}

function item(lane, key, w, opts) {
  const it = { lane, key, w, role: 'SETPIECE', rotY: 0, weight: 0 };
  if (opts) for (const k in opts) it[k] = opts[k];
  return it;
}

/* ───────────────────────────────────────────────────────────────── the pieces ── */

/**
 * 1 · TOLL PLAZA — zone 1. Pure demolition.
 *
 * Eight booths and a rank of barrier arms, and not one of them is a question. This
 * is the first set piece anybody sees, at the end of the teaching zone, so it
 * teaches exactly one thing: the game will let you delete a built structure without
 * slowing down. Every booth is a fraction of the paper threshold at the weight the
 * player has by then, and §5 promises paper costs literally zero speed, so the plaza
 * is 150 m of uninterrupted annihilation and nothing else.
 *
 * The booths arrive in ranks of two and three rather than a row of eight because
 * eight simultaneous objects is nearly double the near-band budget. Spread over four
 * ranks it is still one plaza to the eye and the read never carries more than five.
 */
function buildTollPlaza(b) {
  const BOOTH = 'tollBooth';
  const r0 = b.line([1, 3], BOOTH, 1.0);
  const r1 = b.line([0, 2, 4], BOOTH, 1.0);
  const r2 = b.line([1, 2, 3], BOOTH, 1.0);
  const r3 = b.line([0, 1, 2, 3, 4], 'barrierArm', 0.62);

  // The canopy. Two gantries, one over the approach and one over the arms, so the
  // plaza has a roofline long before a single booth is close enough to read.
  b.prop(r0, -6, 'signGantry', 0, 1.0);
  b.prop(r3, -4, 'signGantry', 0, 1.0);
  // Islands: the booths a real plaza puts outside the outermost lane, off the play
  // surface where they cost nothing and sell the width of the thing.
  b.prop(r1, 0, BOOTH, -(ROAD_HALF + 2.6), 1.0);
  b.prop(r1, 0, BOOTH, ROAD_HALF + 2.6, 1.0);
  b.prop(r2, 0, 'crashCushion', -(ROAD_HALF + 2.2), 1.0);
  b.prop(r2, 0, 'crashCushion', ROAD_HALF + 2.2, 1.0);
}

/**
 * 2 · TRAFFIC JAM — zone 2. Plow it or thread it.
 *
 * A stopped queue four ranks deep, with the hole through it walking one lane
 * sideways per rank. Drive the hole and you take nothing; drive the metal and you
 * take all of it — which is the standing greed decision the risk lanes already ask,
 * except that here it is asked four times in a row with no gap to change your mind.
 *
 * §17 wants this sized right at the plow boundary, "the first zone where a player is
 * heavy enough to just go straight through". With `ctx.pool` supplied that is what
 * the tanker at the back does — the zone's ladder is capped at `landmarkMaxRatio`,
 * which is the plow boundary to a rounding error. The wall itself is funded from the
 * 7,000 kg share and at this point in the track that buys cars an order of magnitude
 * under the boundary: still a wall, but one that answers its own question. See the
 * module header; it is a budget ceiling, not an oversight.
 *
 * The hole is `ctx.gapLanes` wide rather than one lane, because by the second zone
 * the drum is already wider than a lane and a one-lane hole is not hard, it is shut.
 */
function buildTrafficJam(b, ctx) {
  const lanes = ctx.laneCount || TUNING.world.laneCount;
  const gap = Math.max(1, Math.min(lanes - 1, ctx.gapLanes || 2));
  // Which shoulder the hole starts against is the only thing the rng decides. A set
  // piece that is different every seed stops being a landmark players talk about.
  const rtl = ctx.rng.next() < 0.5;
  const steps = lanes - gap + 1;
  let first = 0;
  for (let s = 0; s < steps; s++) {
    const holeAt = rtl ? lanes - gap - s : s;
    const occupied = [];
    for (let l = 0; l < lanes; l++) {
      if (l >= holeAt && l < holeAt + gap) continue;
      occupied.push(l);
    }
    // A parked queue is never square to the road, and a car sitting six degrees off
    // is the cheapest way to say "this stopped in a hurry" at 30 m/s.
    const r = b.line(occupied, s % 2 === 0 ? 'sedan' : 'taxi', 1.0,
      { rotY: (ctx.rng.next() - 0.5) * 0.22, wall: true });
    if (s === 0) first = r;
  }
  // The prize at the back of the queue. A tanker in a stopped jam is the one place
  // in the game where being heavy is rewarded with an explosion that eats the
  // objects you did NOT line up (§17), so it sits in the centre lane where both
  // threading lines can still reach it.
  const rt = b.row([item(2, 'fuelTanker', 2.6, { tanker: true, role: 'PRIZE', prize: true })]);
  b.prop(rt, -3, 'chevronBoard', -(ROAD_HALF + 2.0), 1.0);
  b.prop(rt, -3, 'chevronBoard', ROAD_HALF + 2.0, 1.0);
  b.prop(first, -8, 'signGantry', 0, 1.0);
  b.region('jam', first, -10, 0, { horns: 1 });
}

/**
 * 3 · TUNNEL — zone 3. The claustrophobic beat.
 *
 * Three zones of open sky come first, so the tunnel does not have to be long to
 * land; it has to be a hard cut. Rings overhead, no shoulders, headlights, and the
 * ramp squeezed (§8's narrows) — the same instruction every other hazard gives, "be
 * somewhere else", arriving as architecture instead of as an object with a weight
 * printed on it. The bore is `gapLanes + 1` wide, three of the five lanes today, so
 * it is a squeeze the roller genuinely fits through rather than a coin toss.
 *
 * The narrowing is published as a REGION rather than built out of props. A wall of
 * blockers would be an instant loss two lanes wide and the winnability proof would
 * rightly refuse the track; a wall of paper objects is not a wall. So the road is
 * told its own width, the rings are SIZED to that width in `finishTunnel`, and every
 * object inside the bore is authored into the corridor — three statements of the
 * same number, none of them able to drift from the others.
 *
 * Sound goes reverberant and enormous. That is a flag, not a call: `SETPIECES.tunnel`
 * carries `reverb` and `dark`, and the region repeats them with a span attached.
 */
function buildTunnel(b, ctx) {
  const lanes = ctx.laneCount || TUNING.world.laneCount;
  // The bore is one lane wider than the gap the roller needs, so it is a squeeze
  // rather than a coin toss, and centred, so neither shoulder is the safe one.
  const wide = Math.max(2, Math.min(lanes - 1, (ctx.gapLanes || 2) + 1));
  const from = Math.max(0, Math.round((lanes - wide) / 2));
  const to = from + wide - 1;
  const mid = (from + to) >> 1;
  b.corridor = { from, to, lanes: wide };

  const outer = [];
  for (let l = 0; l < lanes; l++) if (l < from || l > to) outer.push(l);
  const r0 = b.line(outer, 'chevronBoard', 0.66);           // the shoulders close
  const r1 = b.line([from, to], 'crashCushion', 1.0);       // the portal
  b.line([mid], 'crashCushion', 1.0);
  b.line([from, to], 'chevronBoard', 0.66);
  const r4 = b.line([mid], 'chevronBoard', 0.66);           // the far mouth

  // The rings, the lights and the narrow all need the piece's resolved length, which
  // does not exist until the ranks have been spaced, so they are drawn in `finish`.
  b.region('tunnel', r1, -14, 0, { reverb: 1, dark: 1, spanToRow: r4, spanPad: 12 });
  b.region('narrow', r1, -14, 0, { laneFrom: from, laneTo: to, spanToRow: r4, spanPad: 12 });
  b.prop(r0, -10, 'signGantry', 0, 1.0);
}

/** Rings, portals and headlights, once the tunnel's real length is known. */
function finishTunnel(b, ctx) {
  const S = TUNING.setpieces;
  const bore = b.regions[0];                                 // the 'tunnel' region

  // Size the rings to the corridor rather than to the road. A ring at its authored
  // 27.2 m clears the full ramp, which would leave the narrow announced in the
  // region and invisible in the world — and a squeeze the player cannot SEE is the
  // one kind of hazard this game is not allowed to have.
  const laneWidth = ctx.laneWidth > 0 ? ctx.laneWidth : TUNING.world.laneWidth;
  const need = (b.corridor.lanes / 2) * laneWidth + S.tunnelWallClearance;
  const def = PROPS.tunnelSegment;
  const ringScale = Math.min(1.2, Math.max(0.6, (2 * need) / (def.size[0] * S.tunnelBoreFrac)));
  for (let d = 0; d <= bore.length + 0.001; d += S.tunnelRingSpacing) {
    b.decor.push({ kind: 'prop', key: 'tunnelSegment', d: bore.d + d, x: 0, y: 0, rotY: 0, scale: ringScale });
  }
  // Headlights. WHITE — §6.1 gives amber to the outline system, and a tunnel lit
  // amber reads as a corridor of plow-tier objects. Staggered left and right so the
  // eye gets a rhythm instead of a runway.
  let i = 0;
  for (let d = S.tunnelRingSpacing; d < bore.length; d += S.tunnelLightSpacing, i++) {
    b.decor.push({
      kind: 'light', key: '', d: bore.d + d, x: (i & 1 ? 1 : -1) * need,
      y: S.tunnelLightHeight, rotY: 0, scale: 1, colour: 0xdfe8ee,
    });
  }
}

/**
 * 4 · OVERPASS COLLAPSE — zone 4. The one set piece that happens behind you.
 *
 * The player clips a support column; the deck comes down in the mirror. Both halves
 * are deliberate. The column is an ordinary interactive object — paper, absorbed,
 * zero speed cost — because the collapse has to be something the player CAUSED, and
 * a scripted trigger volume driven through would not feel caused. The deck is decor
 * flagged `collapse` and never an object at all: eighteen tonnes of bridge on the
 * ramp would be red for the entire game, and a set piece nobody can survive is not a
 * set piece.
 *
 * Two columns, in lanes 1 and 3, because one column in one lane is a four-in-five
 * chance that the best moment in the zone never fires.
 */
function buildOverpass(b) {
  const S = TUNING.setpieces;
  const r0 = b.line([0, 4], 'constructionBarrier', 0.85);
  b.line([1, 3], 'gravelPile', 0.92);
  const r2 = b.line([1, 3], 'overpassColumn', 4.2, { role: 'TRIGGER', trigger: 'overpassDeck' });
  b.line([2], 'constructionBarrier', 0.85);

  // The deck: three sections across the ramp at the columns' station, plus the two
  // columns standing OFF the road that hold the far ends up.
  for (let i = -1; i <= 1; i++) {
    b.prop(r2, i * S.overpassDeckSpacing, 'overpassDeck', 0, 1.0,
      { y: S.overpassDeckHeight, collapse: 1, trigger: 'overpassDeck' });
  }
  b.prop(r2, 0, 'overpassColumn', -(ROAD_HALF + 3.0), 1.0);
  b.prop(r2, 0, 'overpassColumn', ROAD_HALF + 3.0, 1.0);
  b.prop(r0, -6, 'signGantry', 0, 1.0);
  b.region('collapse', r2, 0, S.overpassCollapseLength,
    { trigger: 'overpassDeck', behind: 1, delay: S.overpassCollapseDelay });
}

/**
 * 5 · CONSTRUCTION ZONE — zone 5. Scaffolding, cranes, and a prize.
 *
 * The freight yard is the widest, heaviest zone, so its set piece sells scale rather
 * than density: two cranes standing off the shoulders at seventeen metres, scaffold
 * towers on both edges, and a cement mixer alone in the centre lane at the back.
 *
 * The mixer is §17's "plow-tier prize" and it is the one promise in this module the
 * budget does not keep on its own. Plow tier here is ~20,000 kg against an arrival
 * weight of 25,500 — three times everything the six pieces have to spend. It is
 * authored as the heaviest single set-piece object in the game and takes the
 * majority of this piece's share; hand `buildSetPiece` a `ctx.pool` and it takes the
 * zone's top rung instead and is genuinely plow.
 */
function buildConstruction(b) {
  const r0 = b.line([0, 2, 4], 'constructionBarrier', 0.55);
  const r1 = b.line([1, 3], 'gravelPile', 0.58);
  const r2 = b.line([0, 4], 'scaffold', 1.05);
  const r3 = b.row([item(2, 'cementMixer', 5.4, { role: 'PRIZE', prize: true })]);

  b.prop(r1, 0, 'crane', -(ROAD_HALF + 7.5), 1.0);
  b.prop(r2, 6, 'crane', ROAD_HALF + 7.5, 1.0, { rotY: Math.PI });
  b.prop(r0, -6, 'signGantry', 0, 1.0);
  b.prop(r2, 0, 'scaffold', -(ROAD_HALF + 2.4), 1.0);
  b.prop(r2, 0, 'scaffold', ROAD_HALF + 2.4, 1.0);
  b.prop(r3, -5, 'gravelPile', -(ROAD_HALF + 2.8), 1.0);
  b.prop(r3, -5, 'gravelPile', ROAD_HALF + 2.8, 1.0);
  b.region('works', r0, -8, 0, { spanToRow: r3, spanPad: 10 });
}

/**
 * 6 · THE FINAL DESCENT — zone 6. Everything gets out of the way.
 *
 * The last set piece before the run-up to the house, and the only one whose content
 * is mostly MOVING. §17 asks for traffic scattering in every direction here, so
 * those descriptors carry `moving: true` and the caller can hand them to
 * `TrafficSystem` and let the scatter behave like the rest of the traffic instead of
 * like props arranged untidily. If nothing adopts them they place as stationary
 * vehicles, which is a duller version of the same beat rather than a bug.
 *
 * The chevrons and the crash barrels run the outer lanes. The house is dead ahead
 * and visible the whole way down, and this piece's real job is to keep the centre of
 * the frame clear of anything that competes with it.
 */
function buildFinalDescent(b) {
  const r0 = b.line([0, 2, 4], 'chevronBoard', 0.62);
  b.line([1, 3], 'van', 0.95, { moving: true, role: 'SCATTER' });
  const r2 = b.row([
    item(0, 'crashCushion', 0.80),
    item(2, 'taxi', 0.95, { moving: true, role: 'SCATTER' }),
    item(4, 'crashCushion', 0.80),
  ]);
  const r3 = b.row([
    item(1, 'fuelTanker', 3.5, { tanker: true, role: 'PRIZE', prize: true }),
    item(3, 'crashCushion', 0.80),
  ]);
  const r4 = b.row([item(3, 'donutSign', 3.5, { role: 'PRIZE' })]);

  b.prop(r0, -8, 'signGantry', 0, 1.0);
  b.prop(r2, 0, 'roadsideMascot', -(ROAD_HALF + 3.4), 1.0);
  b.prop(r4, 4, 'chevronBoard', -(ROAD_HALF + 1.8), 1.0);
  b.prop(r4, 4, 'chevronBoard', ROAD_HALF + 1.8, 1.0);
  b.region('scatter', r0, -6, 0, { spanToRow: r3, spanPad: 8 });
}

/* ─────────────────────────────────────────────────────────────── the registry ── */

export const SETPIECES = {
  tollPlaza: {
    name: 'tollPlaza', banner: 'TOLL PLAZA', zone: 0,
    reverb: 0, dark: 0, build: buildTollPlaza, finish: null,
  },
  trafficJam: {
    name: 'trafficJam', banner: 'TRAFFIC JAM', zone: 1,
    reverb: 0, dark: 0, build: buildTrafficJam, finish: null,
  },
  tunnel: {
    name: 'tunnel', banner: 'TUNNEL', zone: 2,
    reverb: 1, dark: 1, build: buildTunnel, finish: finishTunnel,
  },
  overpass: {
    name: 'overpass', banner: 'OVERPASS', zone: 3,
    reverb: 0, dark: 0, build: buildOverpass, finish: null,
  },
  construction: {
    name: 'construction', banner: 'CONSTRUCTION', zone: 4,
    reverb: 0, dark: 0, build: buildConstruction, finish: null,
  },
  finalDescent: {
    name: 'finalDescent', banner: 'FINAL DESCENT', zone: 5,
    reverb: 0, dark: 0, build: buildFinalDescent, finish: null,
  },
};

/** Kilos §17's set-piece share gives one piece. Sums to `highwaySetPieceBudget`. */
export function setPieceBudget(name) {
  const share = TUNING.setpieces.shares[name] || 0;
  return TUNING.weights.highwaySetPieceBudget * share;
}

/* ───────────────────────────────────────────────────────────────────── layout ── */

/**
 * The speed the caps have to be sized against.
 *
 * Not the speed the player arrives at the zone with — the speed they have at the END
 * of it, which is where a set piece sits and which is up to 15 % higher. The streamer
 * enforces the near-band cap against the player's ACTUAL weight every frame, so a
 * piece spaced for arrival speed would have objects quietly dropped out from under it
 * at exactly its climax. Sizing against the on-pace exit weight costs ~50 m of ramp
 * per piece and removes the failure entirely.
 */
function bandSpeed(ctx) {
  const zone = TUNING.weights.zones[ctx.zoneIndex] || TUNING.weights.zones[0];
  const s = speedAtWeight(ctx.arriveWeight + zone.budget);
  return ctx.speed > s ? ctx.speed : s;
}

/** Lateral speed at a weight. Mirrors `player.js` and trackplan's sweep block. */
function lateralAt(weight) {
  const P = TUNING.player;
  return P.baseLateralSpeed * Math.pow(P.startWeight / Math.max(1, weight), P.lateralSpeedExp);
}

/** Cheapest lane change between two ranks, in lanes. Zero if they share a lane. */
function crossing(a, b) {
  let best = Infinity;
  for (let i = 0; i < a.items.length; i++) {
    for (let j = 0; j < b.items.length; j++) {
      const dl = Math.abs(a.items[i].lane - b.items[j].lane);
      if (dl < best) best = dl;
    }
  }
  return best === Infinity ? 0 : best;
}

/**
 * Space the ranks. Two rules, both derived.
 *
 *  1. THE CAPS. A window `nearBandSeconds` long may hold five objects and one
 *     `fadeInSeconds` long may hold twelve. A rank is pushed forward until the
 *     earliest rank still inside the offending window has fallen out of it. That is
 *     exact — it counts what is genuinely inside each window rather than assuming a
 *     spacing — and it terminates because `d` only ever increases.
 *  2. THE LINE. The gap must also be long enough to CROSS. v2's SIDE_FEED asked for
 *     28 m/s of lateral speed against the 15 m/s the roller has, and a bot driving
 *     it perfectly collected 5 % of the track. So the gap between two ranks is never
 *     shorter than the ramp it takes to change lanes at `sweepComfort` of the
 *     roller's lateral speed — the same `stepFor` the formations use, measured
 *     against the heavy, sluggish roller the player has at the zone's exit rather
 *     than the nimble one they arrived with.
 *
 * The piece also opens and closes with `leadInSeconds` of empty ramp, so neither the
 * formation before it nor the one after it can push its own ranks over the cap.
 */
function layout(b, ctx) {
  const R = TUNING.read;
  const S = TUNING.setpieces;
  const zone = TUNING.weights.zones[ctx.zoneIndex] || TUNING.weights.zones[0];
  const speed = bandSpeed(ctx);
  const nearSpan = R.nearBandSeconds * speed * S.bandSafety + TRAIL_METRES;
  const visSpan = R.fadeInSeconds * speed * S.bandSafety + TRAIL_METRES;
  // A set piece's ranks get MORE breathing room than the 1.2 s floor between two
  // formations, not less. The floor is what makes a rank's dodge easier than its
  // sweep: at exactly 1.2 s the clean line through the last two pieces measured
  // 0.55 of the roller's lateral speed, which is `sweepComfort` exactly — no slack
  // at all for a hand-driven line. At 1.5 s it measures 0.44.
  const minGap = S.rankGapSeconds * speed;
  const lat = Math.max(1, lateralAt(ctx.arriveWeight + zone.budget) * R.sweepComfort);
  const laneWidth = ctx.laneWidth > 0 ? ctx.laneWidth : TUNING.world.laneWidth;
  const rows = b.rows;

  rows[0].d = S.leadInSeconds * speed;
  for (let i = 1; i < rows.length; i++) {
    const cross = crossing(rows[i - 1], rows[i]) * laneWidth;
    const step = Math.max(R.sweepStepMin, (cross / lat) * speed);
    let d = rows[i - 1].d + Math.max(minGap, step);
    const own = rows[i].items.length;
    for (let guard = 0; guard < 64; guard++) {
      let nearC = own, visC = own, jNear = -1, jVis = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (d - rows[j].d <= nearSpan) { nearC += rows[j].items.length; jNear = j; }
        if (d - rows[j].d <= visSpan) { visC += rows[j].items.length; jVis = j; }
      }
      if (nearC > R.maxNearObjects && jNear >= 0) { d = rows[jNear].d + nearSpan + S.rowGapMargin; continue; }
      if (visC > R.maxVisibleObjects && jVis >= 0) { d = rows[jVis].d + visSpan + S.rowGapMargin; continue; }
      break;
    }
    rows[i].d = d;
  }
  b.span = rows[rows.length - 1].d + S.leadOutSeconds * speed;
}

/* ──────────────────────────────────────────────────────────────────── weights ── */

const snap = (w, step) => Math.max(step, Math.round(w / step) * step);

/**
 * Turn the authored weight RATIOS into kilos.
 *
 * Two caps bound every object. `paperCap` keeps it under §5's paper threshold at the
 * weight its zone opens at, so nothing in a set piece can cost a strike or a quarter
 * of the player's speed — a piece the player is funnelled into must not be able to
 * end the run. `prizeCap` is the looser one, `landmarkMaxRatio` of arrival weight,
 * which is the top of the plow band: an object marked `prize` is allowed to be the
 * one thing here that asks a question, if the budget ever reaches that far.
 *
 * The share is then spent EXACTLY, the discipline `fillZone` holds itself to and for
 * the same reason: §17's 35,000 kg is what makes gold reachable, and a subsystem
 * quietly under-spending its third of it moves the medal ladder.
 *
 * @returns {number} kilos actually placed.
 */
function spendBudget(b, ctx) {
  const S = TUNING.setpieces;
  const budget = Math.round(ctx.budget > 0 ? ctx.budget : setPieceBudget(b.name));
  const paperCap = ctx.arriveWeight * TUNING.collision.cleanRatio * S.paperMargin;
  const prizeCap = ctx.arriveWeight * S.prizeMaxRatio;
  const step = S.weightStep;
  const capOf = (it) => snap(it.prize ? prizeCap : paperCap, step);

  const all = [];
  let ratio = 0;
  for (let i = 0; i < b.rows.length; i++) {
    for (let j = 0; j < b.rows[i].items.length; j++) {
      const it = b.rows[i].items[j];
      it.weight = 0;
      if (it.pooled) continue;                 // funded by the zone, not by the share
      all.push(it);
      ratio += it.w;
    }
  }
  if (ratio <= 0 || all.length === 0) return 0;

  let placed = 0;
  for (let i = 0; i < all.length; i++) {
    const it = all[i];
    it.weight = Math.min(snap((budget * it.w) / ratio, step), capOf(it));
    placed += it.weight;
  }

  // Close the share on whatever still has headroom, heaviest first. Rounding a dozen
  // items to a 5 kg step leaves tens of kilos on the table, and letting the last
  // object silently absorb all of it would distort the one object the player is most
  // likely to be reading.
  const order = all.slice().sort((x, y) => y.weight - x.weight);
  let residual = budget - placed;
  for (let pass = 0; pass < 16 && residual !== 0; pass++) {
    let moved = false;
    for (let i = 0; i < order.length && residual !== 0; i++) {
      const it = order[i];
      if (residual > 0) {
        if (it.weight + step > capOf(it)) continue;
        it.weight += step; residual -= step; placed += step; moved = true;
      } else {
        if (it.weight - step < step) continue;
        it.weight -= step; residual += step; placed -= step; moved = true;
      }
    }
    if (!moved) break;
  }
  return placed;
}

/**
 * Visual size for an authored weight.
 *
 * The cube-root `pickVisual` uses, with a lower floor. A set piece spends its kilos
 * on the budget and its metres on the silhouette, and the floor is where those two
 * stop agreeing: 55 kg is 0.29 of a catalogue toll booth by mass, which would stand
 * 0.9 m tall — not a booth, a bollard. Clamped to the floor it is a narrow glass
 * kiosk: light for its size, and honest about it, because the weight is printed on
 * the front of it either way.
 */
function scaleFor(key, weight) {
  const S = TUNING.setpieces;
  const def = PROPS[key];
  if (!def) return 1;
  const s = Math.pow(Math.max(1, weight) / Math.max(1, def.weight), 1 / 3);
  return s < S.scaleFloor ? S.scaleFloor : s > S.scaleCeiling ? S.scaleCeiling : s;
}

/* ──────────────────────────────────────────────────────────────────── the API ── */

/**
 * Build one set piece.
 *
 * Appends object descriptors to `out` in exactly the shape `trackplan` already
 * pushes into `plan.objects` — `{ key, weight, scale, role, lane, d, blocker }` plus
 * the optional §17 flags `furniture`, `tanker`, `moving`, and four of this module's
 * own: `setPiece` (the piece's name, for the HUD banner and the audio layer),
 * `rotY` (authored, because a stopped queue is not square to the road), `trigger`
 * (the decor group this object brings down when it breaks) and `pooled` (its kilos
 * came from the zone's budget, not from §17's share — do not count them twice).
 * `d` is relative to the start of the piece, as `buildFormation` returns it.
 *
 * Optional inputs on `ctx`, all ignored when absent:
 *   • `decor`   — array; architecture is appended to it as
 *                 `{ kind, key, d, x, y, rotY, scale, setPiece, ... }`. Never
 *                 collidable, never labelled, never counted against §6.1's caps.
 *   • `regions` — array; spans the audio, lighting and road layers read. Always at
 *                 least one `setpiece` region carrying the banner and the span.
 *   • `pool`    — array of `{ key, weight, scale }` from the zone's own budget, as
 *                 `buildFormation` takes it. Objects marked `prize` draw from it and
 *                 are SHIFTED OUT when it holds something heavier than the share
 *                 could buy, so the prize lands at the weight the zone's ladder was
 *                 sized to and the share is spent on the rest. This is the only way
 *                 §17's plow-tier prize is reachable — see the module header.
 *
 * @returns {number} the piece's span in metres, lead-in and lead-out included.
 */
export function buildSetPiece(name, ctx, out) {
  const spec = SETPIECES[name] || SETPIECES[ORDER[0]];
  const b = new Piece(spec.name, ctx);
  spec.build(b, ctx);
  if (b.rows.length === 0) return 0;

  layout(b, ctx);
  spendBudget(b, ctx);

  // Zone-funded prizes. The pool's heaviest entry is taken for the WEIGHT only —
  // the piece keeps its own silhouette, because a construction zone whose prize is a
  // flatbed instead of a cement mixer has traded away the thing that made it a set
  // piece. Only when the pool beats what the share already bought, and never when it
  // would make the prize BLOCKED: a piece the player is funnelled into must not be
  // able to end the run.
  const pool = Array.isArray(ctx.pool) && ctx.pool.length > 0 ? ctx.pool : null;
  if (pool) {
    pool.sort((x, y) => y.weight - x.weight);
    let promoted = false;
    for (let i = 0; i < b.rows.length; i++) {
      for (let j = 0; j < b.rows[i].items.length; j++) {
        const it = b.rows[i].items[j];
        if (!it.prize || pool.length === 0) continue;
        const cand = pool[0];
        if (cand.weight <= it.weight || cand.weight >= ctx.arriveWeight) continue;
        it.pooled = pool.shift();
        promoted = true;
      }
    }
    if (promoted) spendBudget(b, ctx);          // respend the share on what is left
  }

  for (let i = 0; i < b.rows.length; i++) {
    const row = b.rows[i];
    for (let j = 0; j < row.items.length; j++) {
      const it = row.items[j];
      const key = it.key;
      const def = PROPS[key];
      if (!def) continue;
      const weight = it.pooled ? it.pooled.weight : it.weight;
      const desc = {
        key,
        weight,
        scale: scaleFor(key, weight),
        role: it.role || 'SETPIECE',
        lane: it.lane,
        d: row.d,
        blocker: !!def.blocker,
        setPiece: spec.name,
        rotY: it.rotY || 0,
      };
      // Flags the caller reads back: a pooled prize's kilos came out of the ZONE's
      // budget, so a caller reconciling §17's share must not count them twice.
      if (it.pooled) desc.pooled = true;
      if (it.tanker) desc.tanker = true;
      if (it.moving) desc.moving = true;
      if (it.furniture) desc.furniture = true;
      if (it.trigger) desc.trigger = it.trigger;
      out.push(desc);
    }
  }

  // Resolve the rank-anchored decor and regions now that every rank has a `d`.
  for (let i = 0; i < b.regions.length; i++) {
    const r = b.regions[i];
    r.d = b.rows[r.atRow].d + r.dOffset;
    if (r.spanToRow !== undefined) r.length = b.rows[r.spanToRow].d + (r.spanPad || 0) - r.d;
    r.setPiece = spec.name;
  }
  if (spec.finish) spec.finish(b, ctx);
  for (let i = 0; i < b.decor.length; i++) {
    const e = b.decor[i];
    if (e.atRow !== undefined) { e.d = b.rows[e.atRow].d + e.dOffset; e.atRow = undefined; e.dOffset = undefined; }
    e.setPiece = spec.name;
  }

  if (Array.isArray(ctx.decor)) for (let i = 0; i < b.decor.length; i++) ctx.decor.push(b.decor[i]);
  if (Array.isArray(ctx.regions)) {
    ctx.regions.push({
      kind: 'setpiece', setPiece: spec.name, banner: spec.banner,
      d: 0, length: b.span, reverb: spec.reverb, dark: spec.dark,
    });
    for (let i = 0; i < b.regions.length; i++) ctx.regions.push(b.regions[i]);
  }
  return b.span;
}
