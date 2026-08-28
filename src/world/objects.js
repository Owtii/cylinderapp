import { TUNING } from '../tuning.js';

/**
 * The object catalogue.
 *
 * Every entry is both an obstacle and a pickup: smashing it adds its weight to the
 * player. `weight` is printed above the object in the world, so these numbers are
 * read by the player, not just by the code.
 *
 * COLOUR MONOPOLY (§6.1). Saturated green, amber and red belong to the outline
 * system and to nothing else. Every material here is a muted grey, sand or dusty
 * blue — no red car paint, no green foliage. This one rule does more for
 * readability at speed than any amount of UI work.
 *
 * Blockers are striped white-on-charcoal rather than the usual hazard yellow, for
 * the same reason: yellow belongs to amber. A high-contrast stripe is also the
 * marking that survives best once the screen is desaturated, which is the test the
 * whole readability system has to pass.
 */

export const MATERIALS = {
  glass:    { color: 0x9fb4bd, roughness: 0.10, metalness: 0.00, emissive: 0x141c20, particle: 0xc2d4db },
  wood:     { color: 0xa9987e, roughness: 0.82, metalness: 0.00, particle: 0xbdae94 },
  metal:    { color: 0x8b939b, roughness: 0.42, metalness: 0.55, particle: 0xa9b1b8 },
  paint:    { color: 0x9aa3ab, roughness: 0.35, metalness: 0.15, particle: 0xb2bac1 },
  sand:     { color: 0xb3a988, roughness: 0.78, metalness: 0.00, particle: 0xc4b79c },
  rubber:   { color: 0x3a3d42, roughness: 0.92, metalness: 0.00, particle: 0x53575c },
  concrete: { color: 0x9a9a95, roughness: 0.94, metalness: 0.00, particle: 0xb0b0aa },
  steel:    { color: 0x6e767e, roughness: 0.38, metalness: 0.70, particle: 0x939aa1 },
  slate:    { color: 0x5b636b, roughness: 0.60, metalness: 0.25, particle: 0x7d858d },
  hazard:   { color: 0x2b2e33, roughness: 0.70, metalness: 0.10, particle: 0x8f939a },
  water:    { color: 0x8fa6b2, roughness: 0.20, metalness: 0.00, particle: 0xaec3ce },
};

/** Ordered heaviest-last. Zone N draws from TIERS[N] and leads in with TIERS[N-1]. */
export const TIER_ORDER = ['glass', 'wood', 'kiosk', 'car', 'truck', 'structure'];

/* Geometry helpers — `box` and `cyl` are unit primitives; `cyl` is Y-axis, so a
   wheel needs a quarter turn about Z. Local origin sits on the ground (y = 0). */
const box = (pos, scale, material, rot) => ({ geo: 'box', pos, scale, material, rot });
const cyl = (pos, scale, material, rot) => ({ geo: 'cyl', pos, scale, material, rot });
const QZ = [0, 0, Math.PI / 2];

/** Slice a box volume into a grid of fragments. Keeps fracture authoring honest. */
function shards(w, h, d, nx, ny, nz, material, y0 = 0) {
  const out = [];
  const sx = w / nx, sy = h / ny, sz = d / nz;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        out.push({
          pos: [-w / 2 + sx * (i + 0.5), y0 + sy * (j + 0.5), -d / 2 + sz * (k + 0.5)],
          scale: [sx * 0.92, sy * 0.92, sz * 0.92],
          material,
        });
      }
    }
  }
  return out;
}

export const PROPS = {
  // ── tier 1 · glass ──────────────────────────────────────────── ~50 kg
  bottleCrate: {
    key: 'bottleCrate', tier: 'glass', weight: 40, label: 'Bottle crate', sound: 'glass',
    size: [1.5, 1.2, 1.0],
    parts: [
      box([0, 0.18, 0], [1.5, 0.36, 1.0], 'wood'),
      cyl([-0.4, 0.75, 0], [0.3, 0.8, 0.3], 'glass'),
      cyl([0.0, 0.75, 0.2], [0.3, 0.8, 0.3], 'glass'),
      cyl([0.42, 0.75, -0.18], [0.3, 0.8, 0.3], 'glass'),
    ],
    fracture: shards(1.5, 1.2, 1.0, 3, 3, 2, 'glass'),
  },
  glassPanel: {
    key: 'glassPanel', tier: 'glass', weight: 50, label: 'Glass panel', sound: 'glass',
    size: [3.0, 2.6, 0.3],
    parts: [
      box([0, 1.3, 0], [2.7, 2.3, 0.10], 'glass'),
      box([-1.42, 1.3, 0], [0.16, 2.6, 0.26], 'metal'),
      box([1.42, 1.3, 0], [0.16, 2.6, 0.26], 'metal'),
      box([0, 0.08, 0], [3.0, 0.16, 0.3], 'metal'),
    ],
    fracture: shards(2.8, 2.5, 0.16, 4, 4, 1, 'glass', 0.1),
  },
  greenhouse: {
    key: 'greenhouse', tier: 'glass', weight: 70, label: 'Greenhouse', sound: 'glass',
    size: [3.4, 2.8, 2.6],
    parts: [
      box([0, 1.15, 0], [3.2, 2.2, 2.4], 'glass'),
      box([0, 2.45, 0], [3.4, 0.5, 2.6], 'glass'),
      box([-1.6, 1.2, -1.25], [0.16, 2.4, 0.16], 'metal'),
      box([1.6, 1.2, 1.25], [0.16, 2.4, 0.16], 'metal'),
    ],
    fracture: shards(3.2, 2.7, 2.4, 3, 3, 2, 'glass'),
  },

  // ── tier 2 · wood ───────────────────────────────────────────── ~200 kg
  woodCrate: {
    key: 'woodCrate', tier: 'wood', weight: 150, label: 'Crate', sound: 'wood',
    size: [1.9, 1.9, 1.9],
    parts: [
      box([0, 0.95, 0], [1.9, 1.9, 1.9], 'wood'),
      box([0, 0.95, 0.98], [1.95, 0.22, 0.06], 'sand'),
      box([0, 1.62, 0], [1.95, 0.18, 1.95], 'sand'),
    ],
    fracture: shards(1.9, 1.9, 1.9, 3, 2, 2, 'wood'),
  },
  fence: {
    key: 'fence', tier: 'wood', weight: 200, label: 'Fence', sound: 'wood',
    size: [4.4, 2.0, 0.35],
    parts: [
      box([-2.0, 1.0, 0], [0.28, 2.0, 0.28], 'wood'),
      box([2.0, 1.0, 0], [0.28, 2.0, 0.28], 'wood'),
      box([0, 1.55, 0], [4.4, 0.3, 0.14], 'wood'),
      box([0, 0.95, 0], [4.4, 0.3, 0.14], 'wood'),
      box([0, 0.4, 0], [4.4, 0.3, 0.14], 'wood'),
    ],
    fracture: shards(4.4, 1.9, 0.3, 4, 2, 1, 'wood', 0.1),
  },
  marketStall: {
    key: 'marketStall', tier: 'wood', weight: 280, label: 'Market stall', sound: 'wood',
    size: [4.0, 2.9, 2.4],
    parts: [
      box([0, 0.9, 0], [3.8, 0.2, 2.2], 'wood'),
      box([-1.8, 0.45, -1.0], [0.2, 0.9, 0.2], 'wood'),
      box([1.8, 0.45, 1.0], [0.2, 0.9, 0.2], 'wood'),
      box([0, 2.6, 0], [4.0, 0.28, 2.4], 'sand'),
      box([0, 1.75, -1.05], [3.6, 1.5, 0.12], 'wood'),
    ],
    fracture: shards(3.9, 2.8, 2.3, 4, 3, 1, 'wood'),
  },

  // ── tier 3 · kiosks and furniture ───────────────────────────── ~500 kg
  phoneBooth: {
    key: 'phoneBooth', tier: 'kiosk', weight: 400, label: 'Phone booth', sound: 'metal',
    size: [1.3, 3.0, 1.3],
    parts: [
      box([0, 0.12, 0], [1.3, 0.24, 1.3], 'metal'),
      box([0, 1.6, 0], [1.1, 2.6, 1.1], 'glass'),
      box([0, 2.92, 0], [1.34, 0.22, 1.34], 'metal'),
      box([-0.62, 1.6, 0], [0.1, 2.7, 1.24], 'metal'),
    ],
    fracture: shards(1.3, 3.0, 1.3, 2, 4, 2, 'glass'),
  },
  vendingMachine: {
    key: 'vendingMachine', tier: 'kiosk', weight: 500, label: 'Vending machine', sound: 'metal',
    size: [1.6, 2.4, 1.0],
    parts: [
      box([0, 1.2, 0], [1.6, 2.4, 1.0], 'paint'),
      box([-0.28, 1.35, 0.52], [0.9, 1.7, 0.06], 'glass'),
      box([0.55, 1.35, 0.53], [0.35, 1.5, 0.05], 'slate'),
      box([0, 0.1, 0], [1.66, 0.2, 1.06], 'metal'),
    ],
    fracture: shards(1.6, 2.4, 1.0, 2, 4, 2, 'metal'),
  },
  kioskStand: {
    key: 'kioskStand', tier: 'kiosk', weight: 630, label: 'Kiosk', sound: 'metal',
    size: [3.0, 2.9, 2.2],
    parts: [
      box([0, 1.25, 0], [2.8, 2.5, 2.0], 'paint'),
      box([0, 2.75, 0], [3.0, 0.3, 2.2], 'metal'),
      box([0, 1.55, 1.02], [2.2, 1.3, 0.08], 'glass'),
      box([0, 0.12, 0], [2.9, 0.24, 2.1], 'concrete'),
    ],
    fracture: shards(2.9, 2.8, 2.1, 3, 3, 2, 'metal'),
  },

  // ── tier 4 · cars ───────────────────────────────────────────── ~1,500 kg
  sedan: {
    key: 'sedan', tier: 'car', weight: 1200, label: 'Sedan', sound: 'car',
    size: [2.0, 1.55, 4.5],
    parts: [
      box([0, 0.62, 0], [1.95, 0.76, 4.5], 'paint'),
      box([0, 1.24, 0.15], [1.7, 0.6, 2.2], 'paint'),
      box([0, 1.22, 0.15], [1.76, 0.42, 2.28], 'glass'),
      cyl([0, 0.33, -1.5], [0.66, 2.0, 0.66], 'rubber', QZ),
      cyl([0, 0.33, 1.48], [0.66, 2.0, 0.66], 'rubber', QZ),
    ],
    fracture: shards(1.95, 1.5, 4.4, 3, 2, 3, 'paint', 0.05),
  },
  taxi: {
    key: 'taxi', tier: 'car', weight: 1500, label: 'Taxi', sound: 'car',
    size: [2.05, 1.75, 4.7],
    parts: [
      box([0, 0.64, 0], [2.0, 0.8, 4.7], 'paint'),
      box([0, 1.3, 0.1], [1.76, 0.68, 2.5], 'paint'),
      box([0, 1.28, 0.1], [1.82, 0.46, 2.56], 'glass'),
      box([0, 1.72, 0.1], [0.7, 0.2, 0.5], 'slate'),
      cyl([0, 0.35, -1.56], [0.7, 2.06, 0.7], 'rubber', QZ),
      cyl([0, 0.35, 1.54], [0.7, 2.06, 0.7], 'rubber', QZ),
    ].slice(0, 5),
    fracture: shards(2.0, 1.7, 4.6, 3, 2, 3, 'paint', 0.05),
  },
  van: {
    key: 'van', tier: 'car', weight: 1900, label: 'Van', sound: 'car',
    size: [2.2, 2.3, 5.2],
    parts: [
      box([0, 1.15, 0], [2.2, 2.0, 5.2], 'paint'),
      box([0, 1.55, 2.1], [2.06, 0.9, 1.0], 'glass'),
      box([0, 2.24, 0], [2.0, 0.16, 4.6], 'metal'),
      cyl([0, 0.38, -1.8], [0.76, 2.24, 0.76], 'rubber', QZ),
      cyl([0, 0.38, 1.76], [0.76, 2.24, 0.76], 'rubber', QZ),
    ],
    fracture: shards(2.2, 2.25, 5.1, 3, 3, 2, 'paint', 0.05),
  },

  // ── tier 5 · heavy vehicles ─────────────────────────────────── ~5,000 kg
  pickupTruck: {
    key: 'pickupTruck', tier: 'truck', weight: 3500, label: 'Flatbed', sound: 'heavy',
    size: [2.5, 2.6, 6.4],
    parts: [
      box([0, 0.95, 0], [2.5, 0.9, 6.4], 'steel'),
      box([0, 1.9, 1.9], [2.3, 1.2, 2.2], 'paint'),
      box([0, 1.9, 2.9], [2.1, 0.8, 0.14], 'glass'),
      box([0, 1.6, -1.6], [2.4, 0.5, 3.0], 'steel'),
      cyl([0, 0.5, -2.2], [1.0, 2.55, 1.0], 'rubber', QZ),
    ],
    fracture: shards(2.5, 2.5, 6.3, 3, 3, 3, 'steel', 0.05),
  },
  boxTruck: {
    key: 'boxTruck', tier: 'truck', weight: 5000, label: 'Box truck', sound: 'heavy',
    size: [2.7, 3.5, 8.0],
    parts: [
      box([0, 2.05, -1.2], [2.7, 2.7, 5.4], 'paint'),
      box([0, 1.5, 3.0], [2.5, 1.6, 2.0], 'steel'),
      box([0, 1.9, 3.95], [2.3, 0.9, 0.14], 'glass'),
      box([0, 0.55, 0], [2.6, 0.5, 7.8], 'slate'),
      cyl([0, 0.55, -2.6], [1.1, 2.75, 1.1], 'rubber', QZ),
    ],
    fracture: shards(2.7, 3.4, 7.9, 3, 3, 3, 'paint', 0.05),
  },
  bus: {
    key: 'bus', tier: 'truck', weight: 6500, label: 'Bus', sound: 'heavy',
    size: [2.9, 3.5, 11.2],
    parts: [
      box([0, 1.85, 0], [2.85, 2.9, 11.2], 'paint'),
      box([0, 2.5, -0.2], [2.9, 1.0, 9.6], 'glass'),
      box([0, 3.42, 0], [2.65, 0.2, 10.6], 'metal'),
      cyl([0, 0.5, -4.0], [1.0, 2.95, 1.0], 'rubber', QZ),
      cyl([0, 0.5, 3.5], [1.0, 2.95, 1.0], 'rubber', QZ),
    ],
    fracture: shards(2.85, 3.4, 11.0, 3, 3, 3, 'paint', 0.05),
  },

  // ── tier 6 · structures ─────────────────────────────────────── ~15,000 kg
  shed: {
    key: 'shed', tier: 'structure', weight: 10000, label: 'Shed', sound: 'heavy',
    size: [5.4, 4.2, 4.6],
    parts: [
      box([0, 1.7, 0], [5.4, 3.4, 4.6], 'wood'),
      box([0, 3.75, 0], [5.8, 0.4, 5.0], 'slate'),
      box([0, 1.4, 2.32], [1.6, 2.8, 0.14], 'metal'),
      box([-1.9, 2.3, 2.32], [1.0, 0.9, 0.1], 'glass'),
    ],
    fracture: shards(5.4, 4.1, 4.6, 3, 3, 2, 'wood'),
  },
  silo: {
    key: 'silo', tier: 'structure', weight: 15000, label: 'Silo', sound: 'heavy',
    size: [4.4, 9.5, 4.4],
    parts: [
      cyl([0, 4.3, 0], [4.4, 8.6, 4.4], 'metal'),
      cyl([0, 9.1, 0], [3.6, 1.2, 3.6], 'steel'),
      box([0, 0.3, 0], [4.8, 0.6, 4.8], 'concrete'),
      box([2.1, 4.3, 0], [0.2, 8.0, 0.5], 'steel'),
    ],
    fracture: shards(4.2, 9.3, 4.2, 2, 5, 2, 'metal'),
  },
  waterTower: {
    key: 'waterTower', tier: 'structure', weight: 20000, label: 'Water tower', sound: 'heavy',
    size: [5.2, 11.5, 5.2],
    parts: [
      cyl([0, 9.0, 0], [5.2, 4.4, 5.2], 'water'),
      cyl([0, 11.4, 0], [3.4, 0.9, 3.4], 'steel'),
      box([-1.8, 3.4, -1.8], [0.35, 6.8, 0.35], 'steel'),
      box([1.8, 3.4, 1.8], [0.35, 6.8, 0.35], 'steel'),
      box([0, 6.6, 0], [4.6, 0.25, 4.6], 'steel'),
    ],
    fracture: shards(5.0, 11.3, 5.0, 2, 5, 2, 'steel'),
  },

  // ── permanent blockers · never beatable at any weight ────────────────────
  pillar: {
    key: 'pillar', tier: 'blocker', weight: Infinity, label: 'BLOCKER', sound: 'concrete',
    size: [1.8, 5.6, 1.8], blocker: true,
    parts: [
      box([0, 2.7, 0], [1.5, 5.4, 1.5], 'concrete'),
      box([0, 0.35, 0], [1.8, 0.7, 1.8], 'hazard'),
      box([0, 5.5, 0], [1.8, 0.35, 1.8], 'hazard'),
    ],
    fracture: [],
  },
  barrier: {
    key: 'barrier', tier: 'blocker', weight: Infinity, label: 'BLOCKER', sound: 'concrete',
    size: [4.6, 1.5, 1.1], blocker: true,
    parts: [
      box([0, 0.7, 0], [4.6, 1.1, 0.9], 'concrete'),
      box([0, 0.16, 0], [4.6, 0.32, 1.1], 'hazard'),
      box([0, 1.36, 0], [4.6, 0.24, 0.95], 'hazard'),
    ],
    fracture: [],
  },
  bedrock: {
    key: 'bedrock', tier: 'blocker', weight: Infinity, label: 'BLOCKER', sound: 'concrete',
    size: [3.6, 4.4, 3.2], blocker: true,
    parts: [
      box([0, 2.0, 0], [3.4, 4.0, 3.0], 'concrete'),
      box([0, 0.3, 0], [3.6, 0.6, 3.2], 'hazard'),
      box([-0.7, 3.9, 0.3], [1.6, 0.5, 1.4], 'concrete'),
    ],
    fracture: [],
  },
};

export const PROP_KEYS = Object.keys(PROPS);
export const BLOCKER_KEYS = PROP_KEYS.filter((k) => PROPS[k].blocker);

/** Object keys belonging to a tier, cheapest first. */
export const TIER_KEYS = {};
for (const t of TIER_ORDER) {
  TIER_KEYS[t] = PROP_KEYS
    .filter((k) => PROPS[k].tier === t)
    .sort((a, b) => PROPS[a].weight - PROPS[b].weight);
}

export function propWeight(key) {
  const p = PROPS[key];
  return p ? p.weight : Infinity;
}

/* ──────────────────────────────────────────── picking a visual for a weight ── */

/**
 * Weights are assigned by the track's weight curve, not fixed per catalogue entry,
 * so a placed object needs a body that *looks* like what it weighs. Pick the prop
 * whose nominal weight is nearest in log space, preferring the zone's own tier
 * when it is a plausible match, and scale it a little so a 26 t bus reads bigger
 * than a 5 t one.
 */
const VISUAL_KEYS = PROP_KEYS.filter((k) => !PROPS[k].blocker);

export function pickVisual(weight, tierHint, rng, out) {
  const target = Math.log(Math.max(1, weight));
  let bestKey = VISUAL_KEYS[0];
  let bestScore = Infinity;
  for (let i = 0; i < VISUAL_KEYS.length; i++) {
    const k = VISUAL_KEYS[i];
    const p = PROPS[k];
    let score = Math.abs(Math.log(p.weight) - target);
    if (p.tier === tierHint) score -= 0.35;           // keep the zone's own look
    score += rng.next() * 0.12;                       // break ties without drifting
    if (score < bestScore) { bestScore = score; bestKey = k; }
  }
  const nominal = PROPS[bestKey].weight;
  let scale = Math.pow(weight / nominal, 1 / 3);
  if (scale < 0.72) scale = 0.72;
  if (scale > 1.75) scale = 1.75;
  out.key = bestKey;
  out.scale = scale;
  return out;
}

/* ─────────────────────────────────────────────────────── the budget solver ── */

function gcd2(a, b) { return b === 0 ? a : gcd2(b, a % b); }

function gcdAll(list) {
  let g = 0;
  for (let i = 0; i < list.length; i++) g = gcd2(g, list[i]);
  return g || 1;
}

/**
 * Build a zone's object list: a short lead-in of the PREVIOUS tier so there is
 * always something safe to eat on arrival, then this zone's own tier, summing to
 * EXACTLY `budget`.
 *
 * Exactness is the point — the house asking for a fixed 71 % of the track only
 * means anything if the track really contains what the table says. Greedy alone
 * gets stuck (with coins {40,50,70} there is no way to make 60), so reachability
 * is precomputed by DP and every draw, lead-in included, is restricted to picks
 * that leave a remainder the tier can still close exactly.
 *
 * @param {string[]} tierKeys   this zone's tier
 * @param {string[]} prevKeys   the previous tier (may be empty for zone 1)
 * @param {number}   budget     kilos to hit exactly
 * @param {number}   leadIn     how many previous-tier objects to open with
 * @param {{next:()=>number}} rng
 * @returns {string[]} object keys; [] if the budget is unreachable
 */
export function fillZone(tierKeys, prevKeys, budget, leadIn, rng) {
  const out = [];
  if (budget <= 0 || tierKeys.length === 0) return out;

  const tierW = tierKeys.map(propWeight);
  const prevW = prevKeys.map(propWeight);
  const step = gcdAll(tierW.concat(prevW));
  if (budget % step !== 0) return out;

  // reach[v] — can the TIER alone make v*step exactly?
  const n = budget / step;
  const reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (let v = 1; v <= n; v++) {
    for (let i = 0; i < tierW.length; i++) {
      const c = tierW[i] / step;
      if (Number.isInteger(c) && c <= v && reach[v - c]) { reach[v] = 1; break; }
    }
  }

  let remaining = n;
  const choices = [];

  // lead-in: previous tier, but only picks that keep the rest solvable
  for (let k = 0; k < leadIn && prevKeys.length > 0; k++) {
    choices.length = 0;
    for (let i = 0; i < prevKeys.length; i++) {
      const c = prevW[i] / step;
      if (Number.isInteger(c) && c <= remaining && reach[remaining - c]) choices.push(prevKeys[i]);
    }
    if (choices.length === 0) break;
    const pick = choices[Math.min(choices.length - 1, Math.floor(rng.next() * choices.length))];
    out.push(pick);
    remaining -= propWeight(pick) / step;
  }

  // the zone's own tier closes the budget
  while (remaining > 0) {
    choices.length = 0;
    for (let i = 0; i < tierKeys.length; i++) {
      const c = tierW[i] / step;
      if (Number.isInteger(c) && c <= remaining && reach[remaining - c]) choices.push(tierKeys[i]);
    }
    if (choices.length === 0) break;
    const pick = choices[Math.min(choices.length - 1, Math.floor(rng.next() * choices.length))];
    out.push(pick);
    remaining -= propWeight(pick) / step;
  }
  return out;
}

/** Total absorbable weight of a list of object keys. */
export function sumWeights(keys) {
  let t = 0;
  for (let i = 0; i < keys.length; i++) {
    const w = propWeight(keys[i]);
    if (isFinite(w)) t += w;
  }
  return t;
}
