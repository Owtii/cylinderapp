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
 *
 * §17 adds three families on top of the six tiers, and none of them joins those
 * tiers, because the six-tier ladder is what the zone budgets and the weight curve
 * are solved against and a stray coin in it moves numbers nobody asked to move:
 *
 *   HIGHWAY FURNITURE  20-80 kg. Cones, bollards, mailboxes, hedges. Collidable and
 *                      absorbable — not scenery — but `furniture: true` so the
 *                      renderer drops their outline intensity and the label system
 *                      never prints one. They are texture you can eat, and the whole
 *                      point is that they cost the player no attention at all.
 *   SET-PIECE PROPS    The parts the six authored set pieces are built from: booths,
 *                      arms, gantries, a tunnel portal, an overpass, a crane. Placed
 *                      by name, never by the weight solver.
 *   THE FUEL TANKER    The one prop in the game allowed hazard orange, and the only
 *                      one that detonates. Deliberately NOT in the `truck` tier:
 *                      `traffic.js` picks its bodies by nearest weight, and a tanker
 *                      in that set would make every heavy vehicle past ~7 t a tanker.
 *                      Rare is the whole value of it.
 *
 * Every §17 prop carries `visual: false`, which keeps it out of `pickVisual` — an
 * authored 60 kg feeder must still read as a bottle crate, not as a mailbox.
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

  // ── §17 additions ────────────────────────────────────────────────────────────
  // `plastic` is the one material `fx/fracture.js` already had a physics row for
  // and no prop to spend it on; the highway furniture is what it was waiting for.
  plastic:  { color: 0xb0aca4, roughness: 0.55, metalness: 0.00, particle: 0xc4c0b8 },
  // Warnings are white on charcoal, never yellow (§6.1). `chalk` is that white:
  // it survives the desaturation test, and it is the only bright value a prop is
  // allowed to carry, so a striped arm still reads at 40 m/s without borrowing amber.
  chalk:    { color: 0xd8d9d6, roughness: 0.72, metalness: 0.00, particle: 0xe6e7e4 },
  // Grey-olive, the same value `render/decor.js` gives its distant trees, so a hedge
  // on the shoulder and a hedge in the lane are the same plant. Saturation 0.10.
  foliage:  { color: 0x6f7a63, roughness: 0.88, metalness: 0.00, particle: 0x8a9480 },
  // THE ONE EXCEPTION (§17). Hazard orange, on the fuel tanker and nothing else.
  // #b5652a as briefed measures 0.62 saturation, which is inside amber's territory;
  // pulled to 0xad6c38 it measures 0.511 — under the 0.55 ceiling, still unmistakably
  // orange next to the desaturated steel it is painted on. Nothing else may use it.
  orange:   { color: 0xad6c38, roughness: 0.62, metalness: 0.05, particle: 0xc08a5c },
};

/** Ordered heaviest-last. Zone N draws from TIERS[N] and leads in with TIERS[N-1]. */
export const TIER_ORDER = ['glass', 'wood', 'kiosk', 'car', 'truck', 'structure'];

/**
 * §17's families. Kept OUT of TIER_ORDER on purpose: the zone budgets are solved
 * against the six tiers, so anything added to them changes tracks that are already
 * measured. These are placed by name — see `furnitureForZone`, `SETPIECE_PROPS`.
 */
export const HIGHWAY_TIERS = ['furniture', 'setpiece', 'tanker'];

/* Geometry helpers — `box` and `cyl` are unit primitives; `cyl` is Y-axis, so a
   wheel needs a quarter turn about Z. Local origin sits on the ground (y = 0). */
const box = (pos, scale, material, rot) => ({ geo: 'box', pos, scale, material, rot });
const cyl = (pos, scale, material, rot) => ({ geo: 'cyl', pos, scale, material, rot });
const QZ = [0, 0, Math.PI / 2];
/** Quarter turn about X — lays a cylinder along Z, which is how a tank barrel sits. */
const QX = [Math.PI / 2, 0, 0];

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

  /* ═══ §17 · highway furniture ══════════════════════════════ 20-80 kg, paper ══
     Quiet stretches of ramp are the problem these solve. A gap with nothing in it
     reads as a gap in the GAME, not a beat of rest, and the anti-clutter rules
     (§6.1) cap interactive objects at twelve — so the filler cannot be another
     interactive object. Furniture threads that needle: it is real weight and it
     really breaks, but `furniture: true` takes it out of the label budget and
     scales its outline down, so it registers as surface texture streaming past
     rather than as a decision. Every one of these is paper from the first metre —
     80 kg against a 500 kg opening drum is a fifth of the paper threshold — which
     is the point: they cost nothing and they never, ever stop you. */

  trafficCone: {
    key: 'trafficCone', tier: 'furniture', weight: 20, label: 'Cone', sound: 'dirt',
    size: [0.55, 0.75, 0.55], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.05, 0], [0.55, 0.10, 0.55], 'plastic'),
      cyl([0, 0.42, 0], [0.30, 0.66, 0.30], 'plastic'),
      cyl([0, 0.50, 0], [0.33, 0.12, 0.33], 'chalk'),
    ],
    fracture: shards(0.5, 0.72, 0.5, 2, 2, 2, 'plastic'),
  },
  deliverySign: {
    key: 'deliverySign', tier: 'furniture', weight: 30, label: 'Sign', sound: 'wood',
    size: [1.1, 1.2, 0.55], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.62, -0.16], [1.05, 1.15, 0.06], 'wood', [0.16, 0, 0]),
      box([0, 0.62, 0.16], [1.05, 1.15, 0.06], 'wood', [-0.16, 0, 0]),
      box([0, 0.62, 0.20], [0.85, 0.75, 0.02], 'chalk', [-0.16, 0, 0]),
    ],
    fracture: shards(1.05, 1.15, 0.4, 3, 3, 1, 'wood'),
  },
  bollard: {
    key: 'bollard', tier: 'furniture', weight: 35, label: 'Bollard', sound: 'metal',
    size: [0.34, 1.15, 0.34], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.04, 0], [0.34, 0.08, 0.34], 'concrete'),
      cyl([0, 0.57, 0], [0.28, 1.10, 0.28], 'steel'),
      cyl([0, 0.94, 0], [0.31, 0.10, 0.31], 'chalk'),
    ],
    fracture: shards(0.3, 1.1, 0.3, 1, 3, 1, 'steel'),
  },
  mailbox: {
    key: 'mailbox', tier: 'furniture', weight: 45, label: 'Mailbox', sound: 'metal',
    size: [0.62, 1.4, 0.85], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.50, 0], [0.12, 1.00, 0.12], 'wood'),
      box([0, 1.15, 0.05], [0.60, 0.50, 0.82], 'metal'),
      box([0, 1.15, 0.47], [0.34, 0.22, 0.03], 'chalk'),
    ],
    fracture: shards(0.6, 1.4, 0.8, 2, 3, 2, 'metal'),
  },
  workBarrier: {
    key: 'workBarrier', tier: 'furniture', weight: 55, label: 'Barrier', sound: 'wood',
    size: [2.4, 0.95, 0.5], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.75, 0], [2.40, 0.35, 0.10], 'hazard'),
      box([0, 0.75, 0.04], [2.20, 0.22, 0.06], 'chalk'),
      box([-1.0, 0.35, 0], [0.10, 0.70, 0.50], 'plastic'),
      box([1.0, 0.35, 0], [0.10, 0.70, 0.50], 'plastic'),
    ],
    fracture: shards(2.4, 0.9, 0.5, 4, 2, 1, 'hazard'),
  },
  fruitStand: {
    key: 'fruitStand', tier: 'furniture', weight: 60, label: 'Fruit stand', sound: 'wood',
    size: [2.2, 1.9, 1.3], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.75, 0], [2.10, 0.10, 1.20], 'wood'),
      box([-0.95, 0.38, 0], [0.10, 0.75, 0.10], 'wood'),
      box([0.95, 0.38, 0], [0.10, 0.75, 0.10], 'wood'),
      box([0, 0.92, -0.10], [1.60, 0.25, 0.80], 'sand'),
      box([0, 1.78, 0], [2.20, 0.20, 1.30], 'sand'),
    ],
    fracture: shards(2.1, 1.85, 1.2, 3, 2, 2, 'wood'),
  },
  hedge: {
    key: 'hedge', tier: 'furniture', weight: 65, label: 'Hedge', sound: 'dirt',
    size: [2.6, 1.5, 0.9], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.22, 0], [2.60, 0.44, 0.90], 'wood'),
      box([0, 0.95, 0], [2.45, 1.05, 0.80], 'foliage'),
      box([0, 1.42, 0], [2.00, 0.16, 0.60], 'foliage'),
    ],
    fracture: shards(2.5, 1.45, 0.85, 4, 2, 1, 'wood'),
  },
  guardrail: {
    key: 'guardrail', tier: 'furniture', weight: 80, label: 'Guardrail', sound: 'metal',
    size: [4.2, 0.9, 0.18], furniture: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.72, 0], [4.20, 0.30, 0.12], 'steel'),
      box([0, 0.52, 0], [4.20, 0.10, 0.16], 'steel'),
      box([-1.7, 0.35, 0], [0.16, 0.70, 0.16], 'steel'),
      box([1.7, 0.35, 0], [0.16, 0.70, 0.16], 'steel'),
    ],
    fracture: shards(4.2, 0.88, 0.25, 5, 1, 1, 'steel'),
  },

  /* ═══ §17 · the silly ones ═════════════════════════════════════════════════════
     One or two per zone, and they earn their place by being the thing a player
     describes to somebody else afterwards. They obey exactly the same physics as
     everything else — the joke is entirely in the silhouette and in what the
     existing impulse model does to it. A portable toilet is a tall light box, so it
     pinwheels; a mattress is a wide flat one, so it flaps. Nothing special-cases
     them anywhere in the codebase, which is why they were cheap to add. */

  gnomeRow: {
    key: 'gnomeRow', tier: 'furniture', weight: 30, label: 'Gnomes', sound: 'concrete',
    size: [1.6, 0.7, 0.5], furniture: true, silly: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.06, 0], [1.60, 0.12, 0.50], 'sand'),
      cyl([-0.50, 0.35, 0], [0.30, 0.48, 0.30], 'concrete'),
      cyl([0.02, 0.38, 0.06], [0.30, 0.52, 0.30], 'concrete'),
      cyl([0.52, 0.33, -0.05], [0.28, 0.44, 0.28], 'concrete'),
    ],
    fracture: shards(1.6, 0.65, 0.5, 3, 2, 1, 'concrete'),
  },
  mattress: {
    key: 'mattress', tier: 'furniture', weight: 40, label: 'Mattress', sound: 'dirt',
    size: [1.5, 0.45, 2.1], furniture: true, silly: true, visual: false, outline: 0.40,
    parts: [
      box([0, 0.20, 0], [1.50, 0.40, 2.10], 'plastic'),
      box([0, 0.42, 0], [1.40, 0.05, 2.00], 'sand'),
      box([0, 0.20, 1.03], [1.50, 0.36, 0.04], 'chalk'),
    ],
    fracture: shards(1.5, 0.42, 2.1, 2, 1, 3, 'plastic'),
  },
  portaloo: {
    key: 'portaloo', tier: 'furniture', weight: 70, label: 'Portaloo', sound: 'dirt',
    size: [1.15, 2.4, 1.15], furniture: true, silly: true, visual: false, outline: 0.40,
    parts: [
      box([0, 1.15, 0], [1.15, 2.30, 1.15], 'plastic'),
      box([0, 2.33, 0], [1.20, 0.10, 1.20], 'plastic'),
      box([0, 1.30, 0.60], [0.85, 1.80, 0.06], 'plastic'),
      box([0, 2.00, 0.63], [0.40, 0.25, 0.03], 'chalk'),
    ],
    fracture: shards(1.15, 2.35, 1.15, 2, 3, 2, 'plastic'),
  },
  trolleyTrain: {
    key: 'trolleyTrain', tier: 'setpiece', weight: 240, label: 'Trolleys', sound: 'metal',
    size: [1.1, 1.1, 4.2], silly: true, visual: false,
    parts: [
      box([0, 0.65, 0], [1.00, 0.70, 4.00], 'steel'),
      box([0, 0.25, 0], [0.90, 0.10, 3.90], 'steel'),
      cyl([0, 0.09, -1.60], [0.18, 0.95, 0.18], 'rubber', QZ),
      cyl([0, 0.09, 1.60], [0.18, 0.95, 0.18], 'rubber', QZ),
    ],
    fracture: shards(1.0, 1.05, 4.0, 2, 2, 4, 'steel'),
  },
  pianoUpright: {
    key: 'pianoUpright', tier: 'setpiece', weight: 380, label: 'Piano', sound: 'wood',
    size: [1.5, 1.35, 0.82], silly: true, visual: false,
    parts: [
      box([0, 0.15, 0], [1.50, 0.30, 0.70], 'wood'),
      box([0, 0.75, 0], [1.50, 1.15, 0.62], 'wood'),
      box([0, 0.90, -0.30], [1.30, 0.60, 0.05], 'steel'),
      box([0, 0.62, 0.36], [1.35, 0.12, 0.20], 'chalk'),
    ],
    fracture: shards(1.5, 1.3, 0.65, 3, 2, 1, 'wood'),
  },
  iceCreamVan: {
    key: 'iceCreamVan', tier: 'setpiece', weight: 1800, label: 'Ice cream van', sound: 'car',
    size: [2.2, 3.05, 5.4], silly: true, visual: false,
    parts: [
      box([0, 1.25, 0], [2.20, 2.10, 5.40], 'paint'),
      box([0, 1.60, 2.20], [2.05, 0.85, 0.90], 'glass'),
      box([0, 1.50, -1.10], [2.26, 1.00, 2.20], 'chalk'),
      box([0, 2.75, 0.40], [1.20, 0.55, 1.20], 'plastic'),
      cyl([0, 0.38, -1.90], [0.76, 2.24, 0.76], 'rubber', QZ),
      cyl([0, 0.38, 1.80], [0.76, 2.24, 0.76], 'rubber', QZ),
    ],
    fracture: shards(2.2, 2.6, 5.3, 3, 2, 3, 'paint', 0.05),
  },
  roadsideMascot: {
    key: 'roadsideMascot', tier: 'setpiece', weight: 4200, label: 'Giant boot', sound: 'structure',
    size: [3.4, 6.3, 5.3], silly: true, visual: false,
    parts: [
      box([0, 0.40, 0], [3.40, 0.80, 4.40], 'concrete'),
      box([0, 3.00, -0.40], [2.60, 4.60, 2.60], 'plastic'),
      box([0, 0.90, 1.00], [2.60, 1.40, 4.20], 'plastic'),
      box([0, 5.60, -0.40], [2.80, 1.20, 2.80], 'plastic'),
      box([0, 1.70, 1.60], [2.20, 0.20, 2.00], 'chalk'),
    ],
    fracture: shards(3.0, 6.2, 4.4, 2, 4, 2, 'plastic'),
  },
  donutSign: {
    key: 'donutSign', tier: 'setpiece', weight: 12000, label: 'Donut sign', sound: 'structure',
    size: [5.2, 9.2, 2.2], silly: true, visual: false,
    parts: [
      box([0, 0.50, 0], [2.40, 1.00, 2.20], 'concrete'),
      box([0, 3.40, 0], [0.80, 6.80, 0.80], 'steel'),
      cyl([0, 6.60, 0], [5.20, 1.60, 5.20], 'plastic', QX),
      box([0, 2.20, 0.40], [2.60, 1.00, 0.12], 'chalk'),
    ],
    fracture: shards(5.2, 9.2, 2.2, 2, 4, 1, 'plastic'),
  },

  /* ═══ §17 · set-piece parts ════════════════════════════════════════════════════
     The six set pieces are authored in `world/setpieces.js`; these are the parts it
     builds them from, referenced by key. Three are authored to clear the full 25 m
     road — `overhead: true` marks those: their legs stand outside the outer lanes
     and the span passes over the player, so a placer must treat them as architecture
     to drive under rather than as a target to aim at. Their declared `size` is that
     whole span, which used as a collider would wall the ramp off. */

  barrierArm: {
    key: 'barrierArm', tier: 'setpiece', weight: 60, label: 'Barrier arm', sound: 'metal',
    size: [4.4, 1.15, 0.35], visual: false,
    parts: [
      cyl([-1.90, 0.50, 0], [0.34, 1.00, 0.34], 'steel'),
      box([0.20, 1.02, 0], [4.00, 0.16, 0.16], 'hazard'),
      box([0.20, 1.02, 0.06], [3.70, 0.10, 0.10], 'chalk'),
    ],
    fracture: shards(4.2, 1.1, 0.3, 5, 2, 1, 'hazard'),
  },
  chevronBoard: {
    key: 'chevronBoard', tier: 'setpiece', weight: 90, label: 'Chevrons', sound: 'metal',
    size: [2.4, 2.3, 0.16], visual: false,
    parts: [
      box([-0.60, 0.75, 0], [0.14, 1.50, 0.14], 'steel'),
      box([0.60, 0.75, 0], [0.14, 1.50, 0.14], 'steel'),
      box([0, 1.75, 0], [2.40, 1.05, 0.10], 'hazard'),
      box([0, 1.75, 0.07], [2.10, 0.80, 0.03], 'chalk'),
    ],
    fracture: shards(2.4, 2.3, 0.2, 3, 3, 1, 'hazard'),
  },
  constructionBarrier: {
    key: 'constructionBarrier', tier: 'setpiece', weight: 260, label: 'Site fence', sound: 'metal',
    size: [3.4, 2.1, 0.6], visual: false,
    parts: [
      box([0, 1.05, 0], [3.40, 2.00, 0.06], 'steel'),
      box([-1.60, 1.05, 0], [0.12, 2.10, 0.12], 'steel'),
      box([1.60, 1.05, 0], [0.12, 2.10, 0.12], 'steel'),
      box([-1.60, 0.10, 0], [0.50, 0.20, 0.60], 'concrete'),
      box([1.60, 0.10, 0], [0.50, 0.20, 0.60], 'concrete'),
    ],
    fracture: shards(3.4, 2.1, 0.5, 4, 3, 1, 'steel'),
  },
  crashCushion: {
    key: 'crashCushion', tier: 'setpiece', weight: 300, label: 'Crash barrels', sound: 'water',
    size: [2.6, 1.3, 3.2], visual: false,
    parts: [
      box([0, 0.08, 0], [2.60, 0.16, 3.20], 'concrete'),
      cyl([-0.80, 0.66, -1.00], [1.00, 1.20, 1.00], 'plastic'),
      cyl([0.80, 0.66, -1.00], [1.00, 1.20, 1.00], 'plastic'),
      cyl([-0.80, 0.66, 0.90], [1.00, 1.20, 1.00], 'water'),
      cyl([0.80, 0.66, 0.90], [1.00, 1.20, 1.00], 'water'),
    ],
    fracture: shards(2.6, 1.25, 3.1, 2, 2, 2, 'plastic'),
  },
  gravelPile: {
    key: 'gravelPile', tier: 'setpiece', weight: 700, label: 'Gravel', sound: 'dirt',
    size: [3.4, 1.4, 3.4], visual: false,
    parts: [
      box([0, 0.35, 0], [3.40, 0.70, 3.40], 'sand'),
      box([0, 0.90, 0], [2.30, 0.50, 2.30], 'sand'),
      box([0, 1.25, 0], [1.20, 0.30, 1.20], 'sand'),
    ],
    fracture: shards(3.4, 1.4, 3.4, 3, 2, 3, 'sand'),
  },
  scaffold: {
    key: 'scaffold', tier: 'setpiece', weight: 1200, label: 'Scaffold', sound: 'metal',
    size: [3.2, 4.6, 1.6], visual: false,
    parts: [
      box([-1.50, 2.25, -0.70], [0.14, 4.50, 0.14], 'steel'),
      box([1.50, 2.25, -0.70], [0.14, 4.50, 0.14], 'steel'),
      box([-1.50, 2.25, 0.70], [0.14, 4.50, 0.14], 'steel'),
      box([1.50, 2.25, 0.70], [0.14, 4.50, 0.14], 'steel'),
      box([0, 2.30, 0], [3.20, 0.12, 1.50], 'wood'),
      box([0, 4.44, 0], [3.20, 0.12, 1.50], 'wood'),
    ],
    fracture: shards(3.2, 4.5, 1.5, 3, 4, 1, 'steel'),
  },
  tollBooth: {
    key: 'tollBooth', tier: 'setpiece', weight: 2600, label: 'Toll booth', sound: 'metal',
    size: [2.8, 3.2, 2.8], visual: false,
    parts: [
      box([0, 0.15, 0], [2.60, 0.30, 2.60], 'concrete'),
      box([0, 1.60, 0], [2.20, 2.50, 2.20], 'paint'),
      box([0, 1.80, 1.12], [1.80, 1.40, 0.08], 'glass'),
      box([0, 3.05, 0], [2.80, 0.25, 2.80], 'metal'),
    ],
    fracture: shards(2.6, 3.15, 2.6, 3, 3, 2, 'paint'),
  },
  signGantry: {
    key: 'signGantry', tier: 'setpiece', weight: 3000, label: 'Gantry', sound: 'metal',
    size: [27.0, 5.6, 0.62], overhead: true, visual: false,
    parts: [
      box([-13.20, 2.60, 0], [0.60, 5.20, 0.60], 'steel'),
      box([13.20, 2.60, 0], [0.60, 5.20, 0.60], 'steel'),
      box([0, 5.40, 0], [27.00, 0.40, 0.50], 'steel'),
      box([0, 4.60, 0.22], [6.00, 1.40, 0.12], 'hazard'),
      box([0, 4.60, 0.30], [5.40, 1.00, 0.04], 'chalk'),
    ],
    fracture: shards(27.0, 5.6, 0.6, 6, 3, 1, 'steel'),
  },
  overpassColumn: {
    key: 'overpassColumn', tier: 'setpiece', weight: 8000, label: 'Column', sound: 'structure',
    size: [3.0, 7.45, 3.0], visual: false,
    parts: [
      box([0, 0.40, 0], [3.00, 0.80, 3.00], 'concrete'),
      box([0, 3.90, 0], [1.80, 6.20, 1.80], 'concrete'),
      box([0, 7.20, 0], [2.60, 0.50, 2.60], 'concrete'),
    ],
    fracture: shards(2.2, 7.4, 2.2, 2, 5, 2, 'concrete'),
  },
  cementMixer: {
    key: 'cementMixer', tier: 'setpiece', weight: 9000, label: 'Cement mixer', sound: 'heavy',
    size: [2.8, 3.95, 8.2], visual: false,
    parts: [
      box([0, 0.70, 0], [2.70, 0.70, 8.20], 'steel'),
      box([0, 1.90, 3.00], [2.50, 1.70, 2.00], 'paint'),
      box([0, 2.30, 3.95], [2.30, 0.90, 0.12], 'glass'),
      cyl([0, 2.30, -1.40], [2.20, 3.60, 2.20], 'metal', [1.25, 0, 0]),
      cyl([0, 0.55, -2.60], [1.10, 2.75, 1.10], 'rubber', QZ),
      cyl([0, 0.55, 2.20], [1.10, 2.75, 1.10], 'rubber', QZ),
    ],
    fracture: shards(2.8, 3.8, 8.1, 3, 3, 3, 'steel', 0.05),
  },
  tunnelSegment: {
    key: 'tunnelSegment', tier: 'setpiece', weight: 12000, label: 'Tunnel ring', sound: 'structure',
    size: [27.2, 7.0, 1.8], overhead: true, visual: false,
    parts: [
      box([-12.90, 3.00, 0], [1.40, 6.00, 1.80], 'concrete'),
      box([12.90, 3.00, 0], [1.40, 6.00, 1.80], 'concrete'),
      box([0, 6.50, 0], [27.20, 1.00, 1.80], 'concrete'),
      box([-10.60, 5.60, 0], [3.20, 1.00, 1.80], 'concrete', [0, 0, 0.60]),
      box([10.60, 5.60, 0], [3.20, 1.00, 1.80], 'concrete', [0, 0, -0.60]),
    ],
    fracture: shards(27.2, 7.0, 1.8, 6, 3, 1, 'concrete'),
  },
  overpassDeck: {
    key: 'overpassDeck', tier: 'setpiece', weight: 18000, label: 'Deck section', sound: 'structure',
    size: [28.0, 1.9, 5.0], overhead: true, visual: false,
    parts: [
      box([0, 0.25, 0], [26.00, 0.50, 4.00], 'steel'),
      box([0, 0.90, 0], [28.00, 1.00, 5.00], 'concrete'),
      box([0, 1.60, -2.30], [28.00, 0.60, 0.40], 'concrete'),
      box([0, 1.60, 2.30], [28.00, 0.60, 0.40], 'concrete'),
    ],
    fracture: shards(28.0, 1.9, 5.0, 6, 1, 3, 'concrete'),
  },
  crane: {
    key: 'crane', tier: 'setpiece', weight: 22000, label: 'Crane', sound: 'structure',
    size: [5.0, 17.6, 16.0], visual: false,
    parts: [
      box([0, 0.60, 0], [5.00, 1.20, 5.00], 'concrete'),
      box([0, 8.00, 0], [1.60, 15.00, 1.60], 'steel'),
      box([0, 16.60, 0], [1.40, 1.00, 16.00], 'steel'),
      box([0, 16.60, -6.50], [1.80, 1.60, 2.20], 'steel'),
      box([0, 15.00, 4.00], [0.50, 2.00, 0.50], 'steel'),
    ],
    fracture: shards(4.0, 17.5, 16.0, 1, 4, 6, 'steel'),
  },

  /* ═══ §17 · the fuel tanker ════════════════════════════════════════════════════
     The one prop allowed hazard orange, and the one prop that detonates: on
     destruction it takes out every paper-tier object inside `explosionRadius`
     metres and hands the player all of it. That is a big promise to make with a
     silhouette, so the markings are big — two full bands around the barrel and a
     rear placard — and they are the desaturated 0.51-saturation burnt orange, not
     the 0.62 of the briefed swatch, because anything nearer amber would be read as
     an outline and this has to read as a THING.

     `parts[0]` is the steel chassis rather than an orange band deliberately:
     game.js takes its impact tint and its decal material from the first part, and
     an orange dust cloud on every hit would spread the exception across the frame. */

  fuelTanker: {
    key: 'fuelTanker', tier: 'tanker', weight: 8000, label: 'Fuel tanker', sound: 'heavy',
    size: [2.9, 3.5, 12.0], tanker: true, explosionRadius: 6, visual: false,
    parts: [
      box([0, 0.75, 0], [2.70, 0.70, 11.80], 'steel'),
      cyl([0, 2.15, -1.60], [2.60, 8.00, 2.60], 'metal', QX),
      cyl([0, 2.15, -3.60], [2.72, 1.50, 2.72], 'orange', QX),
      cyl([0, 2.15, 0.40], [2.72, 1.50, 2.72], 'orange', QX),
      box([0, 1.90, 3.00], [2.50, 1.90, 2.40], 'paint'),
      box([0, 2.40, 4.10], [2.30, 0.90, 0.12], 'glass'),
      box([0, 1.20, -5.70], [2.40, 0.90, 0.10], 'orange'),
      cyl([0, 0.55, -4.20], [1.10, 2.75, 1.10], 'rubber', QZ),
      cyl([0, 0.55, 3.00], [1.10, 2.75, 1.10], 'rubber', QZ),
    ],
    fracture: shards(2.9, 3.5, 11.8, 3, 3, 4, 'steel', 0.05),
  },
};

export const PROP_KEYS = Object.keys(PROPS);
export const BLOCKER_KEYS = PROP_KEYS.filter((k) => PROPS[k].blocker);

/** Object keys belonging to a tier, cheapest first. */
export const TIER_KEYS = {};
for (const t of TIER_ORDER.concat(HIGHWAY_TIERS)) {
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
/* §17's props opt out with `visual: false`. A cone is not a body for an authored
   60 kg feeder, and a tanker must be placed on purpose or not at all. */
const VISUAL_KEYS = PROP_KEYS.filter((k) => !PROPS[k].blocker && PROPS[k].visual !== false);

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

/* ────────────────────────────────────────────────────────── §17 · key lists ── */

/** Cheapest first, so a placer with a small gap can take the head of the list. */
export const FURNITURE_KEYS = TIER_KEYS.furniture;
export const SETPIECE_KEYS = TIER_KEYS.setpiece;
export const TANKER_KEYS = TIER_KEYS.tanker;
/** There is exactly one tanker body, and set pieces reference it by name. */
export const TANKER_KEY = 'fuelTanker';
export const SILLY_KEYS = PROP_KEYS.filter((k) => PROPS[k].silly);

export function isFurniture(key) { const p = PROPS[key]; return !!(p && p.furniture); }
export function isSilly(key) { const p = PROPS[key]; return !!(p && p.silly); }
export function isTanker(key) { const p = PROPS[key]; return !!(p && p.tanker); }
/** Spans the whole road: architecture the player passes under, not a target. */
export function isOverhead(key) { const p = PROPS[key]; return !!(p && p.overhead); }

/**
 * Outline intensity multiplier (§17). Furniture is texture, not a decision, so it
 * is drawn at well under half the intensity of anything the player has to judge —
 * present in the periphery, invisible to the part of the eye picking a lane.
 */
export function outlineScale(key) {
  const p = PROPS[key];
  return p && p.outline !== undefined ? p.outline : 1;
}

/** Blast radius in metres for a placed instance, so a scaled tanker blasts wider. */
export function explosionRadius(key, scale) {
  const p = PROPS[key];
  if (!p || !p.explosionRadius) return 0;
  return p.explosionRadius * (scale > 0 ? scale : 1);
}

/**
 * Furniture flavoured by zone. The mix drifts from domestic to industrial as the
 * ramp leaves the village for the highway, which is the only storytelling the
 * furniture does — and it is enough, because nothing here is ever labelled.
 *
 * Every list is a static array; picking never allocates.
 */
const FURNITURE_BY_ZONE = [
  ['deliverySign', 'mailbox', 'hedge', 'fruitStand', 'gnomeRow'],
  ['mailbox', 'hedge', 'fruitStand', 'deliverySign', 'mattress', 'trafficCone'],
  ['trafficCone', 'bollard', 'hedge', 'mailbox', 'workBarrier', 'portaloo'],
  ['trafficCone', 'bollard', 'workBarrier', 'guardrail', 'portaloo', 'mattress'],
  ['trafficCone', 'bollard', 'workBarrier', 'guardrail', 'portaloo'],
  ['trafficCone', 'workBarrier', 'guardrail', 'bollard'],
];

/** One or two per zone (§17). Zone 0 gets the gnomes; zone 5 gets the donut. */
const SILLY_BY_ZONE = [
  ['gnomeRow', 'mattress'],
  ['portaloo', 'mattress'],
  ['trolleyTrain', 'portaloo'],
  ['pianoUpright', 'trolleyTrain'],
  ['iceCreamVan', 'roadsideMascot'],
  ['donutSign', 'roadsideMascot'],
];

function zoneList(table, zoneIndex) {
  const i = zoneIndex < 0 ? 0 : (zoneIndex >= table.length ? table.length - 1 : zoneIndex | 0);
  return table[i];
}

/** @param {{next:()=>number}} rng @returns {string} a furniture key for this zone. */
export function furnitureForZone(zoneIndex, rng) {
  const list = zoneList(FURNITURE_BY_ZONE, zoneIndex);
  return list[Math.min(list.length - 1, Math.floor(rng.next() * list.length))];
}

/** @param {{next:()=>number}} rng @returns {string} a silly prop key for this zone. */
export function sillyForZone(zoneIndex, rng) {
  const list = zoneList(SILLY_BY_ZONE, zoneIndex);
  return list[Math.min(list.length - 1, Math.floor(rng.next() * list.length))];
}

/**
 * Fill `out` with furniture keys for one zone summing to EXACTLY `budget` kg.
 *
 * Same contract as `fillZone`, and for the same reason: §17's 8,000 kg furniture
 * share is a third of what makes gold reachable, so the ramp has to really be
 * carrying it. Same method too — reachability first, then draw only from picks
 * that leave a remainder the zone's own mix can still close — because a zone's
 * list is a handful of coins, not the whole set: with {30,45,60,65} there is no
 * way to make 40, and greedy walks straight into it. Allocates, like `fillZone`,
 * and for the same reason — this runs once per zone while the track is built.
 *
 * @param {number} budget kilos to hit exactly
 * @param {number} zoneIndex which flavour of furniture
 * @param {{next:()=>number}} rng
 * @param {string[]} out appended to
 * @returns {number} kilos placed, 0 if the budget is unreachable
 */
export function fillFurniture(budget, zoneIndex, rng, out) {
  const list = zoneList(FURNITURE_BY_ZONE, zoneIndex);
  if (budget <= 0 || list.length === 0) return 0;

  const w = [];
  for (let i = 0; i < list.length; i++) w.push(propWeight(list[i]));
  const step = gcdAll(w);
  if (budget % step !== 0) return 0;

  const n = budget / step;
  const reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (let v = 1; v <= n; v++) {
    for (let i = 0; i < w.length; i++) {
      const c = w[i] / step;
      if (c <= v && reach[v - c]) { reach[v] = 1; break; }
    }
  }
  if (!reach[n]) return 0;

  let remaining = n;
  let placed = 0;
  const choices = [];
  while (remaining > 0) {
    choices.length = 0;
    for (let i = 0; i < list.length; i++) {
      const c = w[i] / step;
      if (c <= remaining && reach[remaining - c]) choices.push(list[i]);
    }
    if (choices.length === 0) break;
    const pick = choices[Math.min(choices.length - 1, Math.floor(rng.next() * choices.length))];
    out.push(pick);
    remaining -= propWeight(pick) / step;
    placed += propWeight(pick);
  }
  return placed;
}

/**
 * Which props each set piece is built from (§17). `world/setpieces.js` owns the
 * layout; this is only the parts bin, so a set piece that wants a crane does not
 * have to know that the crane is 22 t of steel.
 */
export const SETPIECE_PROPS = {
  tollPlaza: ['tollBooth', 'barrierArm', 'signGantry', 'crashCushion'],
  trafficJam: ['crashCushion', 'trolleyTrain', 'iceCreamVan', 'chevronBoard', 'fuelTanker'],
  tunnel: ['tunnelSegment', 'signGantry', 'chevronBoard', 'crashCushion'],
  overpass: ['overpassColumn', 'overpassDeck', 'gravelPile', 'constructionBarrier'],
  construction: ['scaffold', 'crane', 'cementMixer', 'constructionBarrier', 'gravelPile', 'fuelTanker'],
  finalDescent: ['chevronBoard', 'crashCushion', 'donutSign', 'roadsideMascot', 'fuelTanker'],
};
