/**
 * TONNAGE — the things you hit.
 *
 * Pure data. No three.js, no side effects: the renderer turns `parts` into
 * instanced primitives, the fragment system turns `fracture` into debris, the
 * audio system reads `sound`, and the collision code reads `threshold` + `size`.
 *
 * Two rules govern everything in this file.
 *
 * 1. SILHOUETTE. You see a prop for maybe half a second, from behind, at 40 m/s,
 *    with the camera shaking. It has to be legible as a shape, not as detail.
 *    So every prop is 2–5 primitives chosen for outline: a sedan is a low slab
 *    with a smaller glasshouse and four wheels; a bus is one long slab with a
 *    window stripe running its whole length; a water tower is a fat cylinder
 *    floating on four thin legs. If you squint at the silhouette and can't name
 *    it, the prop is wrong.
 *
 * 2. MATERIAL TRUTH IN THE BREAK. The fracture pattern is what sells the hit.
 *    Glass goes to many small thin shards. Wood goes to a dozen chunky splinters.
 *    A fence goes to a handful of big bent pieces — you can still tell it was a
 *    fence while it tumbles. A bus goes to a few enormous buckled slabs, because
 *    a bus is mostly empty steel box and that's exactly how it should fall apart.
 *
 * Local space for `parts` and `fracture`: y = 0 is the ground the prop stands on,
 * +x is lateral (road width), +z is along travel. `geo:'cyl'` is a unit cylinder
 * (radius 0.5, height 1, axis +Y), so a wheel/axle needs `rot: [0, 0, Math.PI/2]`.
 */

/* ────────────────────────────────────────────────────────────── materials ── */

/**
 * Visual palette, keyed by the shared material keys. `particle` is the dust/debris
 * tint the FX layer uses — it is deliberately a lighter, dustier version of the
 * body colour so a burst reads against the dark asphalt.
 */
export const MATERIALS = {
  glass: {
    color: 0x9fd8e8, roughness: 0.08, metalness: 0.0, emissive: 0x0a2a33,
    emissiveIntensity: 0.6, opacity: 1, particle: 0xbfe9f5,
  },
  wood: {
    color: 0xa9793f, roughness: 0.86, metalness: 0.0, opacity: 1, particle: 0xd8a765,
  },
  metal: {
    color: 0x9aa3ad, roughness: 0.34, metalness: 0.82, opacity: 1, particle: 0xd7dee6,
  },
  car: {
    // painted body steel — the sedan red that reads instantly at distance
    color: 0xbe3a2b, roughness: 0.3, metalness: 0.5, opacity: 1, particle: 0xe8b9a2,
  },
  heavy: {
    // transit yellow: buses and tanks are the big-ticket targets, so they pop
    color: 0xd8a71f, roughness: 0.46, metalness: 0.45, opacity: 1, particle: 0xf3dc9a,
  },
  concrete: {
    color: 0x8d8b86, roughness: 0.96, metalness: 0.0, opacity: 1, particle: 0xb8b4ad,
  },
  water: {
    color: 0x4fa8c8, roughness: 0.14, metalness: 0.08, emissive: 0x06222e,
    emissiveIntensity: 0.5, opacity: 0.85, particle: 0x9fe4ff,
  },
  dirt: {
    // also does duty as tyre rubber — dark, matte, and never the star of a frame
    color: 0x4a4137, roughness: 0.98, metalness: 0.0, opacity: 1, particle: 0x8a7a63,
  },
};

/** Every material key, in a stable order. */
export const MATERIAL_KEYS = Object.keys(MATERIALS);

/* ─────────────────────────────────────────────────────────────── builders ── */

/**
 * @typedef {{geo:'box'|'cyl', pos:[number,number,number],
 *            scale:[number,number,number], material:string,
 *            rot?:[number,number,number]}} PropPart
 * @typedef {{pos:[number,number,number], scale:[number,number,number],
 *            material:string}} PropFragment
 */

/** A box part. */
function box(x, y, z, sx, sy, sz, material) {
  return { geo: 'box', pos: [x, y, z], scale: [sx, sy, sz], material };
}

/**
 * A cylinder part lying on its side along x (a wheel pair / axle).
 * `len` is the span along x, `dia` the wheel diameter.
 */
function axle(x, y, z, dia, len, material) {
  return {
    geo: 'cyl', pos: [x, y, z], scale: [dia, len, dia],
    rot: [0, 0, Math.PI / 2], material,
  };
}

/** An upright cylinder part (tank, drum). */
function drum(x, y, z, dia, h, material) {
  return { geo: 'cyl', pos: [x, y, z], scale: [dia, h, dia], material };
}

/** One fracture piece. */
function frag(x, y, z, sx, sy, sz, material) {
  return { pos: [x, y, z], scale: [sx, sy, sz], material };
}

/**
 * Tile a slab of volume into cols×rows×layers fracture pieces. Used for the
 * surfaces that should shatter rather than tear: glass panes, crate walls,
 * bus flanks. `inset` shrinks each piece so the debris reads as separate bodies
 * instead of a suspiciously perfect loaf.
 */
function tile(out, cx, cy, cz, w, h, t, cols, rows, material, inset) {
  const pw = w / cols;
  const ph = h / rows;
  const shrink = inset === undefined ? 0.9 : inset;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(frag(
        cx - w * 0.5 + pw * (c + 0.5),
        cy - h * 0.5 + ph * (r + 0.5),
        cz,
        pw * shrink, ph * shrink, t,
        material,
      ));
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────── props ── */

// ── glass panel: a bus-shelter pane in a metal frame. The cheapest, most
//    satisfying thing in the game — it exists to be deleted.
const GLASS_FRACTURE = [];
tile(GLASS_FRACTURE, 0, 1.62, 0, 2.86, 2.66, 0.08, 4, 4, 'glass', 0.9);
GLASS_FRACTURE.push(
  frag(-1.53, 1.5, 0, 0.14, 1.5, 0.3, 'metal'),
  frag(1.53, 1.42, 0, 0.14, 1.5, 0.3, 'metal'),
);

// ── crate: a stack-of-lumber box with a steel band round its middle.
const CRATE_FRACTURE = [];
for (let iy = 0; iy < 2; iy++) {
  for (let iz = 0; iz < 2; iz++) {
    for (let ix = 0; ix < 2; ix++) {
      CRATE_FRACTURE.push(frag(
        -0.4 + ix * 0.8, 0.45 + iy * 0.8, -0.4 + iz * 0.8,
        0.74, 0.74, 0.74, 'wood',
      ));
    }
  }
}
CRATE_FRACTURE.push(
  frag(0, 1.5, 0.7, 1.5, 0.16, 0.12, 'wood'),
  frag(0, 0.2, -0.7, 1.5, 0.18, 0.12, 'wood'),
  frag(0.78, 0.85, 0, 0.1, 0.12, 1.5, 'metal'),
  frag(-0.78, 0.85, 0, 0.1, 0.12, 1.5, 'metal'),
);

// ── bus: the body is split into six enormous slabs, the window strip into three
//    long panes, the roof into two sheets. Big pieces, few of them, all tumbling.
const BUS_FRACTURE = [];
for (let iy = 0; iy < 2; iy++) {
  for (let iz = 0; iz < 3; iz++) {
    BUS_FRACTURE.push(frag(
      0, 1.05 + iy * 1.55, -3.6 + iz * 3.6,
      2.66, 1.45, 3.4, 'heavy',
    ));
  }
}
BUS_FRACTURE.push(
  frag(0, 2.5, -3.2, 2.8, 0.92, 2.9, 'glass'),
  frag(0, 2.5, 0, 2.8, 0.92, 2.9, 'glass'),
  frag(0, 2.5, 3.2, 2.8, 0.92, 2.9, 'glass'),
  frag(0, 3.4, -2.6, 2.45, 0.2, 4.9, 'heavy'),
  frag(0, 3.4, 2.6, 2.45, 0.2, 4.9, 'heavy'),
  frag(-1.1, 0.5, -4.0, 0.4, 0.98, 0.98, 'dirt'),
  frag(1.1, 0.5, 3.5, 0.4, 0.98, 0.98, 'dirt'),
);

// ── water tower: the tank quarters itself, the legs snap off whole, and a few
//    fat blobs of water fall out of the middle.
const TOWER_FRACTURE = [];
for (let iy = 0; iy < 2; iy++) {
  for (let iz = 0; iz < 2; iz++) {
    for (let ix = 0; ix < 2; ix++) {
      TOWER_FRACTURE.push(frag(
        -1.1 + ix * 2.2, 5.4 + iy * 1.8, -1.1 + iz * 2.2,
        1.95, 1.65, 1.95,
        (ix + iy + iz) % 2 === 0 ? 'metal' : 'water',
      ));
    }
  }
}
TOWER_FRACTURE.push(
  frag(-1.55, 2.3, -1.55, 0.34, 4.4, 0.34, 'metal'),
  frag(1.55, 2.3, -1.55, 0.34, 4.4, 0.34, 'metal'),
  frag(-1.55, 2.3, 1.55, 0.34, 4.4, 0.34, 'metal'),
  frag(1.55, 2.3, 1.55, 0.34, 4.4, 0.34, 'metal'),
  frag(0, 4.6, 0, 1.7, 1.7, 1.7, 'water'),
  frag(-0.9, 3.1, 0.4, 1.25, 1.25, 1.25, 'water'),
  frag(0.9, 2.6, -0.5, 1.4, 1.4, 1.4, 'water'),
  frag(0.1, 1.6, 0.2, 1.1, 1.1, 1.1, 'water'),
);

/**
 * Every prop in the game.
 *
 * `threshold` is the mass (kg) you must exceed to move it at all:
 *   mass >  threshold * 1.5 → PULVERIZE, mass > threshold → PLOW, else BLOCKED.
 * The ladder (200 → 800 → 1200 → 4000 → 9000 → 25000 → 40000) is the run's whole
 * progression curve — it is why a bus is a wall at the start and confetti later.
 */
export const PROPS = {
  // ───────────────────────────────────────────────────────────────── light ──
  glass: {
    key: 'glass',
    label: 'Glass panel',
    threshold: 200,
    sound: 'glass',
    material: 'glass',
    size: [3.2, 3.1, 0.4],
    blocker: false,
    scoreMul: 1.0,
    destroyStyle: 'shards',
    parts: [
      box(0, 1.62, 0, 2.86, 2.66, 0.1, 'glass'),   // the pane
      box(-1.53, 1.55, 0, 0.14, 3.1, 0.3, 'metal'), // frame posts
      box(1.53, 1.55, 0, 0.14, 3.1, 0.3, 'metal'),
      box(0, 0.14, 0, 3.2, 0.28, 0.4, 'metal'),    // sill
    ],
    fracture: GLASS_FRACTURE,
  },

  crate: {
    key: 'crate',
    label: 'Shipping crate',
    threshold: 800,
    sound: 'wood',
    material: 'wood',
    size: [1.7, 1.7, 1.7],
    blocker: false,
    scoreMul: 1.0,
    destroyStyle: 'splinters',
    parts: [
      box(0, 0.85, 0, 1.6, 1.6, 1.6, 'wood'),
      box(0, 1.62, 0, 1.7, 0.16, 1.7, 'wood'),   // top rim
      box(0, 0.1, 0, 1.7, 0.2, 1.7, 'wood'),     // bottom rim
      box(0, 0.85, 0, 1.66, 0.12, 1.66, 'metal'), // steel band
    ],
    fracture: CRATE_FRACTURE,
  },

  fence: {
    key: 'fence',
    label: 'Site fence',
    threshold: 1200,
    sound: 'metal',
    material: 'metal',
    size: [4.0, 2.3, 0.3],
    blocker: false,
    scoreMul: 1.1,
    destroyStyle: 'bend',
    parts: [
      box(0, 1.22, 0, 3.7, 1.7, 0.06, 'metal'),   // mesh
      box(-1.9, 1.15, 0, 0.16, 2.3, 0.16, 'metal'), // posts
      box(1.9, 1.15, 0, 0.16, 2.3, 0.16, 'metal'),
      box(0, 2.16, 0, 4.0, 0.14, 0.14, 'metal'),  // top rail
      box(0, 0.3, 0, 4.0, 0.1, 0.1, 'metal'),     // bottom rail
    ],
    // Few, large, and obviously bent — a fence should stay recognisable in the air.
    fracture: [
      frag(-1.05, 1.28, 0.06, 1.65, 1.55, 0.07, 'metal'),
      frag(1.05, 1.18, -0.06, 1.65, 1.5, 0.07, 'metal'),
      frag(-1.9, 1.0, 0, 0.18, 2.0, 0.18, 'metal'),
      frag(1.9, 1.05, 0, 0.18, 2.0, 0.18, 'metal'),
      frag(-0.6, 2.14, 0, 2.3, 0.14, 0.14, 'metal'),
      frag(0.8, 0.3, 0, 2.2, 0.12, 0.12, 'metal'),
    ],
  },

  // ─────────────────────────────────────────────────────────────── traffic ──
  sedan: {
    key: 'sedan',
    label: 'Sedan',
    threshold: 4000,
    sound: 'car',
    material: 'car',
    size: [2.05, 1.6, 4.6],
    blocker: false,
    scoreMul: 1.2,
    destroyStyle: 'crumple',
    parts: [
      box(0, 0.62, 0, 1.98, 0.78, 4.55, 'car'),    // body slab
      box(0, 1.26, 0.15, 1.72, 0.62, 2.25, 'car'), // cabin
      box(0, 1.24, 0.15, 1.78, 0.42, 2.32, 'glass'), // window band, proud of the cabin
      axle(0, 0.33, -1.52, 0.66, 2.02, 'dirt'),
      axle(0, 0.33, 1.5, 0.66, 2.02, 'dirt'),
    ],
    fracture: [
      frag(0, 0.75, -1.6, 1.8, 0.36, 1.3, 'car'),    // bonnet
      frag(0, 1.5, 0.15, 1.6, 0.22, 2.0, 'car'),     // roof
      frag(-0.9, 0.75, -0.3, 0.26, 1.0, 1.4, 'car'), // doors
      frag(0.9, 0.75, -0.3, 0.26, 1.0, 1.4, 'car'),
      frag(-0.9, 0.72, 1.0, 0.26, 0.95, 1.3, 'car'),
      frag(0.9, 0.72, 1.0, 0.26, 0.95, 1.3, 'car'),
      frag(0, 0.8, 1.85, 1.7, 0.5, 0.9, 'car'),      // boot
      frag(0, 0.3, 0.2, 1.7, 0.3, 3.4, 'car'),       // floor pan
      frag(0, 1.3, -0.9, 1.5, 0.5, 0.3, 'glass'),    // windscreen
      frag(0, 1.3, 1.25, 1.5, 0.45, 0.3, 'glass'),
      frag(-0.85, 1.25, 0.2, 0.1, 0.42, 1.6, 'glass'),
      frag(0.85, 1.25, 0.2, 0.1, 0.42, 1.6, 'glass'),
      frag(-0.85, 0.33, -1.5, 0.3, 0.62, 0.62, 'dirt'),   // wheels: thin along the axle
      frag(0.85, 0.33, 1.48, 0.3, 0.62, 0.62, 'dirt'),
    ],
  },

  suv: {
    key: 'suv',
    label: 'SUV',
    threshold: 9000,
    sound: 'car',
    material: 'metal',
    size: [2.3, 2.15, 5.1],
    blocker: false,
    scoreMul: 1.3,
    destroyStyle: 'crumple',
    parts: [
      box(0, 0.9, 0, 2.24, 1.1, 5.0, 'metal'),      // tall boxy body
      box(0, 1.75, 0.2, 2.05, 0.72, 3.1, 'metal'),  // cabin
      box(0, 1.74, 0.2, 2.12, 0.5, 3.16, 'glass'),  // window band
      axle(0, 0.42, -1.65, 0.84, 2.3, 'dirt'),
      axle(0, 0.42, 1.6, 0.84, 2.3, 'dirt'),
    ],
    fracture: [
      frag(0, 1.1, -2.0, 2.1, 0.9, 1.1, 'metal'),
      frag(0, 2.0, 0.2, 1.9, 0.28, 2.8, 'metal'),
      frag(-1.05, 1.15, -0.6, 0.28, 1.4, 1.7, 'metal'),
      frag(1.05, 1.15, -0.6, 0.28, 1.4, 1.7, 'metal'),
      frag(-1.05, 1.1, 1.3, 0.28, 1.3, 1.6, 'metal'),
      frag(1.05, 1.1, 1.3, 0.28, 1.3, 1.6, 'metal'),
      frag(0, 1.15, 2.25, 2.0, 1.2, 0.7, 'metal'),
      frag(0, 0.45, 0.1, 2.0, 0.35, 4.0, 'metal'),
      frag(0, 1.8, -1.2, 1.9, 0.55, 0.3, 'glass'),
      frag(0, 1.8, 1.65, 1.9, 0.5, 0.3, 'glass'),
      frag(-1.05, 1.76, 0.2, 0.1, 0.5, 2.4, 'glass'),
      frag(1.05, 1.76, 0.2, 0.1, 0.5, 2.4, 'glass'),
      frag(-0.95, 0.42, -1.62, 0.36, 0.8, 0.8, 'dirt'),
      frag(0.95, 0.42, 1.6, 0.36, 0.8, 0.8, 'dirt'),
    ],
  },

  bus: {
    key: 'bus',
    label: 'City bus',
    threshold: 25000,
    sound: 'heavy',
    material: 'heavy',
    size: [2.9, 3.55, 11.2],
    blocker: false,
    scoreMul: 1.6,
    destroyStyle: 'buckle',
    parts: [
      box(0, 1.85, 0, 2.8, 3.0, 11.0, 'heavy'),   // one long slab
      box(0, 2.5, -0.2, 2.86, 1.0, 9.6, 'glass'), // window stripe, full length
      box(0, 3.44, 0, 2.6, 0.2, 10.6, 'heavy'),   // roof cap
      axle(0, 0.5, -4.0, 1.0, 2.7, 'dirt'),
      axle(0, 0.5, 3.5, 1.0, 2.7, 'dirt'),
    ],
    fracture: BUS_FRACTURE,
  },

  tower: {
    key: 'tower',
    label: 'Water tower',
    threshold: 40000,
    sound: 'heavy',
    material: 'metal',
    size: [4.8, 8.4, 4.8],
    blocker: false,
    scoreMul: 2.0,
    destroyStyle: 'burst',
    parts: [
      drum(0, 6.5, 0, 4.6, 3.6, 'water'),          // the tank (reads as full)
      box(-1.55, 2.35, -1.55, 0.34, 4.7, 0.34, 'metal'), // legs
      box(1.55, 2.35, -1.55, 0.34, 4.7, 0.34, 'metal'),
      box(-1.55, 2.35, 1.55, 0.34, 4.7, 0.34, 'metal'),
      box(1.55, 2.35, 1.55, 0.34, 4.7, 0.34, 'metal'),
    ],
    fracture: TOWER_FRACTURE,
  },

  // ──────────────────────────────────────────────────────────────── blockers ──
  // Never destructible at any mass. These are the walls of the maze; hitting one
  // is a setback, never a death.
  barrier: {
    key: 'barrier',
    label: 'Concrete barrier',
    threshold: Infinity,
    sound: 'concrete',
    material: 'concrete',
    // 3.8 wide so a row of them fills a 4 m lane with a hairline seam
    size: [3.8, 1.16, 0.95],
    blocker: true,
    scoreMul: 0,
    destroyStyle: 'none',
    parts: [
      box(0, 0.24, 0, 3.8, 0.48, 0.95, 'concrete'),
      box(0, 0.78, 0, 3.8, 0.62, 0.6, 'concrete'),
      box(0, 1.1, 0, 3.8, 0.12, 0.66, 'metal'),
    ],
    fracture: [],
  },

  pillar: {
    key: 'pillar',
    label: 'Bridge pillar',
    threshold: Infinity,
    sound: 'concrete',
    material: 'concrete',
    size: [1.5, 5.2, 1.5],
    blocker: true,
    scoreMul: 0,
    destroyStyle: 'none',
    parts: [
      box(0, 2.55, 0, 1.2, 5.1, 1.2, 'concrete'),
      box(0, 0.18, 0, 1.5, 0.36, 1.5, 'concrete'),
      box(0, 4.95, 0, 1.44, 0.3, 1.44, 'concrete'),
      box(0, 1.1, 0, 1.26, 0.5, 1.26, 'metal'),
    ],
    fracture: [],
  },
};

export const PROP_KEYS = Object.keys(PROPS);

/**
 * Difficulty-weighted menus the chunk builders draw from.
 * `light` is free score, `traffic` is the meat of the run, `heavy` are the
 * trophies you can only take once you have grown, `blockers` build the mazes.
 */
export const PROP_SETS = {
  light: ['glass', 'crate', 'fence'],
  traffic: ['sedan', 'suv', 'bus'],
  heavy: ['bus', 'tower'],
  blockers: ['barrier', 'pillar'],
};

/** Mass (kg) the player must exceed to shift this prop. Unknown keys are walls. */
export function propThreshold(key) {
  const p = PROPS[key];
  return p ? p.threshold : Infinity;
}

/** True when the prop can never be destroyed at any mass. */
export function isBlocker(key) {
  const p = PROPS[key];
  return p ? !!p.blocker : true;
}

/** The prop's AABB `[width, height, depth]`, or null for an unknown key. */
export function propSize(key) {
  const p = PROPS[key];
  return p ? p.size : null;
}
