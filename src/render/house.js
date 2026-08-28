import * as THREE from 'three/webgpu';
import {
  positionWorld, vec3, vec4, float, mix, smoothstep, fract, floor, uniform, texture,
} from 'three/tsl';
import { TUNING } from '../tuning.js';
import { clamp01, hash11 } from '../core/math.js';

/**
 * The house at the bottom of the ramp — the thing the whole run is aimed at.
 *
 * Two jobs, in this order:
 *
 *  1. BE A NUMBER. `100,000 KG` is painted across the facade, big enough to read
 *     from the top of the 430 m run-up, because the finale is a single arithmetic
 *     question the player has been answering for two minutes and the answer has to
 *     be legible before there is any time left to do anything about it. The number
 *     is drawn to a canvas rather than built from segment boxes: one texture, one
 *     quad, perfectly crisp, and it prints whatever weight it is handed.
 *  2. BREAK CONVINCINGLY, ONCE. On a win the facade is punched out from the middle
 *     and the roof lets go a beat later; on a loss it cracks and holds. It is on
 *     screen for about fifteen seconds, so it is thirty-odd boxes and a ballistic
 *     integrator, not a fracture solver.
 *
 * Colours are the environment palette — plaster grey, slate, charcoal, dusty blue
 * glass, bone lettering on charcoal. Nothing here may be green, amber or red.
 */

/* ── scratch ─────────────────────────────────────────────────────────────────── */

const IDLE = 0;
const WIN = 1;
const HOLD = 2;

// piece roles
const P_GROUND = 0;   // plinth and steps: never move
const P_FACADE = 1;   // the front wall: punched out on a win, shudders on a loss
const P_SHELL = 2;    // side and back walls
const P_ROOF = 3;     // roof, ridge, chimney: let go a beat after the hole opens
const P_TRIM = 4;     // door, glazing, sign

/* ── procedural cracking, shared by the wall and roof materials ──────────────── */

const fl = (v) => float(v);
const ramp = (x, lo, hi) => smoothstep(fl(lo), fl(hi), x);
const ridge = (n) => fl(1).sub(n.mul(2).sub(1).abs());

function hash2(ix, iy) {
  return fract(ix.mul(127.1).add(iy.mul(311.7)).sin().mul(43758.5453));
}

function noise2(x, y) {
  const ix = floor(x);
  const iy = floor(y);
  const fx = fract(x);
  const fy = fract(y);
  const ux = fx.mul(fx).mul(fx.mul(-2).add(3));
  const uy = fy.mul(fy).mul(fy.mul(-2).add(3));
  return mix(
    mix(hash2(ix, iy), hash2(ix.add(1), iy), ux),
    mix(hash2(ix, iy.add(1)), hash2(ix.add(1), iy.add(1)), ux),
    uy,
  );
}

/**
 * A masonry material that fractures on cue.
 *
 * The crack field is built from WORLD position, not local, so the fracture runs
 * continuously across the block joints instead of restarting inside every box.
 * That single detail is the difference between "a cracked house" and "thirty
 * separately cracked crates".
 */
function crackedMaterial(baseHex, roughness, uCrack) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0.02 });
  const base = new THREE.Color();
  base.setHex(baseHex, THREE.SRGBColorSpace);

  const cx = positionWorld.x.mul(0.34).add(positionWorld.z.mul(0.09));
  const cy = positionWorld.y.mul(0.34);
  const nLow = noise2(cx.mul(0.42), cy.mul(0.42));
  const nHi = noise2(cx.mul(1.7), cy.mul(1.7));
  const fis = ridge(nHi.mul(0.62).add(nLow.mul(0.38)));

  // Coverage grows outward from wherever the low-frequency field is smallest, so
  // the damage spreads from a couple of origins rather than appearing everywhere.
  const m = ramp(uCrack.mul(1.2).sub(nLow), 0.0, 0.26);
  const crack = ramp(fis, 0.952, 1.0).mul(m);
  const rim = ramp(fis, 0.882, 0.950).sub(crack).max(fl(0)).mul(m).mul(0.75);

  // A little grime so a 34 m wall is not one flat value.
  const grime = ramp(noise2(cx.mul(0.2), cy.mul(0.2)), 0.3, 0.9).mul(0.12);
  let col = vec3(base.r, base.g, base.b).mul(fl(1).sub(grime));
  col = mix(col, vec3(0.018, 0.018, 0.021), crack);
  col = mix(col, col.mul(1.5).add(vec3(0.03, 0.03, 0.03)), rim);

  mat.colorNode = vec4(col, 1.0);
  mat.roughnessNode = mix(fl(roughness), fl(0.98), crack.max(rim));
  return mat;
}

function plainMaterial(hex, roughness, metalness) {
  const c = new THREE.Color();
  c.setHex(hex, THREE.SRGBColorSpace);
  return new THREE.MeshStandardNodeMaterial({ color: c, roughness, metalness });
}

/* ── the house ───────────────────────────────────────────────────────────────── */

export class House {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.uCrack = uniform(0);
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.planeGeo = new THREE.PlaneGeometry(1, 1);

    this.materials = {
      wall: crackedMaterial(0xa39a8e, 0.92, this.uCrack),
      roof: crackedMaterial(0x5c636a, 0.86, this.uCrack),
      plinth: plainMaterial(0x82817b, 0.95, 0.0),
      trim: plainMaterial(0x33363b, 0.72, 0.18),
      glass: plainMaterial(0x7f95a4, 0.24, 0.05),
    };

    this._buildSign();

    // ── piece state, all pre-allocated: update() never allocates ───────────────
    this.meshes = [];
    this.role = [];
    const cap = 64;
    this.hx = new Float32Array(cap); this.hy = new Float32Array(cap); this.hz = new Float32Array(cap);
    this.hrx = new Float32Array(cap); this.hry = new Float32Array(cap); this.hrz = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.wx = new Float32Array(cap); this.wy = new Float32Array(cap); this.wz = new Float32Array(cap);
    this.delay = new Float32Array(cap);
    this.restY = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.moving = new Uint8Array(cap);
    this.slump = new Uint8Array(cap);
    this.count = 0;

    this._layout();
    this.mode = IDLE;
    this.t = 0;
    this._settled = 0;
    this.weight = TUNING.finale.houseWeight;
    this._signWeight = -1;
  }

  /* ── construction ─────────────────────────────────────────────────────────── */

  _addBox(material, x, y, z, sx, sy, sz, role, rx, ry, rz) {
    const i = this.count;
    if (i >= this.hx.length) return -1;
    const m = new THREE.Mesh(this.boxGeo, material);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.rotation.set(rx || 0, ry || 0, rz || 0);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
    this.meshes.push(m);
    this.role.push(role);
    this.hx[i] = x; this.hy[i] = y; this.hz[i] = z;
    this.hrx[i] = rx || 0; this.hry[i] = ry || 0; this.hrz[i] = rz || 0;
    // Where a tumbling piece comes to rest. Its smallest dimension, because a
    // broken slab ends up lying on its flattest face.
    this.restY[i] = 0.5 * Math.min(sx, Math.min(sy, sz)) + 0.08;
    this.phase[i] = hash11(i * 7.31 + 1.7) * Math.PI * 2;
    this.count++;
    return i;
  }

  _buildSign() {
    const H = TUNING.house;
    this.signW = H.width * H.signWidthFraction;
    this.signH = H.signHeight;
    if (typeof document === 'undefined') {
      // Headless (tooling, tests). Fall back to a plain charcoal panel.
      this.signCanvas = null;
      this.signTex = null;
      this.materials.sign = plainMaterial(0x22252a, 0.8, 0.0);
      return;
    }
    const c = document.createElement('canvas');
    c.width = Math.max(64, Math.round(this.signW * H.signPixelsPerMetre));
    c.height = Math.max(32, Math.round(this.signH * H.signPixelsPerMetre));
    this.signCanvas = c;
    this.signCtx = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.signTex = tex;

    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
    const t = texture(tex);
    mat.colorNode = t;
    // A touch of self-illumination so the number stays legible when the facade is
    // in its own shadow. The panel behind it is charcoal, so this costs nothing.
    mat.emissiveNode = t.rgb.mul(0.30);
    this.materials.sign = mat;
  }

  /** Paint the weight onto the sign. Called from place(); never per frame. */
  _drawSign(weight) {
    const ctx = this.signCtx;
    if (!ctx || !this.signCanvas) return;
    const w = this.signCanvas.width;
    const h = this.signCanvas.height;
    const text = `${Math.round(weight).toLocaleString('en-US')} KG`;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#20232a';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#5d646e';
    ctx.lineWidth = Math.max(2, h * 0.030);
    ctx.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12);

    ctx.fillStyle = '#ece7db';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = h * 0.60;
    const maxW = w * 0.86;
    for (let i = 0; i < 24; i++) {
      ctx.font = `900 ${size.toFixed(1)}px "Arial Black", "Helvetica Neue", Impact, sans-serif`;
      if (ctx.measureText(text).width <= maxW || size < 10) break;
      size *= 0.93;
    }
    ctx.fillText(text, w * 0.5, h * 0.53);
    if (this.signTex) this.signTex.needsUpdate = true;
  }

  /**
   * Thirty-one boxes and a sign.
   *
   * Local space: the origin sits on the ground at the plan's house distance, the
   * facade faces +Z (toward the oncoming player) with its outer face at z = 0, and
   * the building extends into -Z. Everything above y = 0 is the house.
   */
  _layout() {
    const H = TUNING.house;
    const M = this.materials;
    const W = H.width;
    const D = H.depth;
    const plinthH = 0.9;
    const wallH = H.height * 0.60;
    const eaveY = plinthH + wallH;
    const pitch = 0.30;
    const tanP = Math.tan(pitch);
    const overhang = 1.4;
    const halfW = W * 0.5 + overhang;
    const ridgeY = eaveY + (W * 0.5) * tanP;

    // Plinth + steps: the only things that stay put no matter what.
    //
    // The plinth runs a long way BELOW the road, because the house is wider than
    // the 25 m carriageway and its outer thirds overhang the verge, which sits
    // about two metres lower. A shallow plinth leaves the building visibly
    // floating at exactly the moment the player is staring straight at it.
    const plinthDrop = 4.6;
    this._addBox(M.plinth, 0, plinthH - plinthDrop * 0.5, -D * 0.5 + 0.6,
      W + 2.6, plinthDrop, D + 2.6, P_GROUND);
    this._addBox(M.plinth, 0, 0.28, 1.4, W * 0.32, 0.56, 2.6, P_GROUND);

    // front facade grid — the win punches its middle out
    const cols = H.frontCols;
    const rows = H.frontRows;
    const bw = W / cols;
    const bh = wallH / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -W * 0.5 + bw * (c + 0.5);
        const y = plinthH + bh * (r + 0.5);
        const i = this._addBox(M.wall, x, y, -0.5, bw, bh, 1.0, P_FACADE);
        // the top outer corners are the ones that slump when the house holds
        if (i >= 0 && r === rows - 1 && (c === 0 || c === cols - 1)) this.slump[i] = 1;
      }
    }

    // gable above the front wall, stepped in two courses
    const gableH = ridgeY - eaveY;
    this._addBox(M.wall, 0, eaveY + gableH * 0.24, -0.5, W * 0.74, gableH * 0.48, 1.0, P_FACADE);
    const gTop = this._addBox(M.wall, 0, eaveY + gableH * 0.72, -0.5, W * 0.38, gableH * 0.48, 1.0, P_FACADE);
    if (gTop >= 0) this.slump[gTop] = 1;

    // Openings, proud of the facade so they read as recesses at a glance. They sit
    // low enough to leave the sign band completely clear.
    this._addBox(M.trim, 0, plinthH + 1.6, 0.06, W * 0.10, 3.2, 0.26, P_TRIM);
    this._addBox(M.glass, -W * 0.30, plinthH + 1.6, 0.06, 3.2, 2.2, 0.22, P_TRIM);
    this._addBox(M.glass, W * 0.30, plinthH + 1.6, 0.06, 3.2, 2.2, 0.22, P_TRIM);

    // shell
    this._addBox(M.wall, -(W * 0.5 - 0.5), plinthH + wallH * 0.5, -D * 0.5, 1.0, wallH, D, P_SHELL);
    this._addBox(M.wall, W * 0.5 - 0.5, plinthH + wallH * 0.5, -D * 0.5, 1.0, wallH, D, P_SHELL);
    this._addBox(M.wall, 0, plinthH + wallH * 0.5, -D + 0.5, W, wallH, 1.0, P_SHELL);
    this._addBox(M.trim, 0, eaveY + 0.25, -0.5, W + 1.0, 0.5, 1.4, P_SHELL);

    // roof: two slabs meeting at a ridge that runs front to back
    const slabLen = halfW / Math.cos(pitch);
    const slabZ = -D * 0.5 + 0.3;
    const slabD = D + 1.8;
    const slabY = ridgeY - halfW * tanP * 0.5;
    this._addBox(M.roof, -halfW * 0.5, slabY, slabZ, slabLen, 0.55, slabD, P_ROOF, 0, 0, pitch);
    this._addBox(M.roof, halfW * 0.5, slabY, slabZ, slabLen, 0.55, slabD, P_ROOF, 0, 0, -pitch);
    this._addBox(M.trim, 0, ridgeY + 0.18, slabZ, 1.3, 0.7, slabD, P_ROOF);

    // chimney, standing on the roof slope
    const chX = W * 0.26;
    const chBase = ridgeY - chX * tanP;
    this._addBox(M.wall, chX, chBase + 2.0, -D * 0.42, 2.2, 4.0, 2.2, P_ROOF);
    this._addBox(M.trim, chX, chBase + 4.25, -D * 0.42, 2.7, 0.5, 2.7, P_ROOF);

    // the painted weight
    const sign = new THREE.Mesh(this.planeGeo, this.materials.sign);
    sign.scale.set(this.signW, this.signH, 1);
    sign.position.set(0, H.signCentreY * H.height, 0.12);
    sign.castShadow = false;
    sign.receiveShadow = false;
    this.group.add(sign);
    this.meshes.push(sign);
    this.role.push(P_TRIM);
    const si = this.count;
    this.hx[si] = 0; this.hy[si] = H.signCentreY * H.height; this.hz[si] = 0.12;
    this.hrx[si] = 0; this.hry[si] = 0; this.hrz[si] = 0;
    this.restY[si] = 0.3;
    this.phase[si] = 1.1;
    this.count++;

    this.eaveY = eaveY;
    this.ridgeY = ridgeY;
    this._restoreTransforms();
  }

  /* ── placement ────────────────────────────────────────────────────────────── */

  /** @param {number} groundY world Y of the road surface at the house's distance */
  place(x, groundY, z, weight) {
    this.group.position.set(x, groundY, z);
    this.group.visible = true;
    const w = weight > 0 ? weight : TUNING.finale.houseWeight;
    this.weight = w;
    if (w !== this._signWeight) {
      this._drawSign(w);
      this._signWeight = w;
    }
  }

  /* ── state ────────────────────────────────────────────────────────────────── */

  /**
   * @param {number} dt seconds
   * @param {'idle'|'win'|'hold'} state
   *
   * `win` latches: the caller signals it once, on the frame of the hit, and then
   * keeps sending `hold` every frame afterwards. A latched win therefore ignores
   * every later `hold`, and `hold` on its own means the house survived.
   */
  update(dt, state) {
    if (state === 'win') {
      if (this.mode !== WIN) this._startWin();
    } else if (state === 'hold') {
      if (this.mode === IDLE) this._startHold();
    }
    const h = dt > 0 ? (dt > 0.1 ? 0.1 : dt) : 0;
    if (this.mode === WIN) this._stepWin(h);
    else if (this.mode === HOLD) this._stepHold(h);
  }

  _startWin() {
    const H = TUNING.house;
    this.mode = WIN;
    this.t = 0;
    // The hole opens where the roller actually arrived: low and central.
    const hitY = 3.0;
    const reach = TUNING.house.width * 0.5;
    for (let i = 0; i < this.count; i++) {
      const role = this.role[i];
      if (role === P_GROUND) { this.moving[i] = 0; continue; }
      const dx = this.hx[i];
      const dy = this.hy[i] - hitY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const near = clamp01(1 - dist / reach);
      const inv = dist > 0.001 ? 1 / dist : 0;
      const r1 = hash11(i * 3.77 + 0.3) - 0.5;
      const r2 = hash11(i * 5.13 + 0.9) - 0.5;

      if (role === P_FACADE || role === P_TRIM) {
        const drive = 0.30 + near;
        this.vx[i] = dx * inv * H.punchSpread * (0.4 + near) + r1 * H.punchSpread * 0.6;
        this.vy[i] = dy * inv * H.punchSpread * (0.3 + near) + 3.6 + near * 4.0;
        this.vz[i] = -H.punchSpeed * drive;
        this.delay[i] = 0;
      } else if (role === P_SHELL) {
        this.vx[i] = (dx >= 0 ? 1 : -1) * (2.2 + r2 * 2.0);
        this.vy[i] = 1.2 + r1;
        this.vz[i] = -3.5 - near * 4.0;
        this.delay[i] = H.roofFallTime * 0.5;
      } else {
        // roof and chimney: they let go a beat after the hole opens, which is
        // what makes the collapse read as a consequence rather than an event.
        this.vx[i] = r1 * 3.0;
        this.vy[i] = -1.0;
        this.vz[i] = -2.0 + r2 * 3.0;
        this.delay[i] = H.roofFallTime;
      }
      this.wx[i] = r1 * H.collapseSpin * 2;
      this.wy[i] = r2 * H.collapseSpin;
      this.wz[i] = (r1 + r2) * H.collapseSpin;
      this.moving[i] = 1;
    }
  }

  _stepWin(dt) {
    const H = TUNING.house;
    this.t += dt;
    this.uCrack.value = clamp01(this.t / 0.18);
    if (this.t > H.settleSeconds) return;
    const g = H.collapseGravity;
    for (let i = 0; i < this.count; i++) {
      if (this.moving[i] === 0) continue;
      if (this.t < this.delay[i]) continue;
      const m = this.meshes[i];
      this.vy[i] += g * dt;
      m.position.x += this.vx[i] * dt;
      m.position.y += this.vy[i] * dt;
      m.position.z += this.vz[i] * dt;
      m.rotation.x += this.wx[i] * dt;
      m.rotation.y += this.wy[i] * dt;
      m.rotation.z += this.wz[i] * dt;
      const floorY = this.restY[i];
      if (m.position.y <= floorY) {
        m.position.y = floorY;
        this.vy[i] = -this.vy[i] * 0.18;
        this.vx[i] *= 0.42;
        this.vz[i] *= 0.42;
        this.wx[i] *= 0.25;
        this.wy[i] *= 0.25;
        this.wz[i] *= 0.25;
        const sp = Math.abs(this.vx[i]) + Math.abs(this.vy[i]) + Math.abs(this.vz[i]);
        if (sp < 0.6) {
          this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
          this.wx[i] = 0; this.wy[i] = 0; this.wz[i] = 0;
          this.moving[i] = 0;
        }
      }
    }
  }

  _startHold() {
    this.mode = HOLD;
    this.t = 0;
    this._settled = 0;
    for (let i = 0; i < this.count; i++) {
      this.moving[i] = this.slump[i];
      if (this.slump[i] === 1) {
        const r1 = hash11(i * 4.21 + 2.6) - 0.5;
        this.vx[i] = r1 * 2.4;
        this.vy[i] = 0.4;
        this.vz[i] = 2.2 + hash11(i * 2.9) * 2.0;
        this.wx[i] = r1 * 2.0;
        this.wy[i] = r1;
        this.wz[i] = -r1 * 1.6;
        this.delay[i] = 0.12;
      }
    }
  }

  _stepHold(dt) {
    const H = TUNING.house;
    this.t += dt;
    this.uCrack.value = clamp01(this.t / H.crackTime);

    // The whole facade shudders and settles. Nothing opens: that IS the message.
    const k = clamp01(this.t / H.holdShakeTime);
    const amp = H.holdShake * (1 - k) * (1 - k);
    const g = H.collapseGravity;
    for (let i = 0; i < this.count; i++) {
      const m = this.meshes[i];
      // A handful of blocks actually come off. `slump` marks them for good: once
      // one has landed it stays where it landed, and the tidy-up pass below must
      // never put it back on the wall.
      if (this.slump[i] === 1) {
        if (this.moving[i] === 0) continue;
        if (this.t < this.delay[i]) continue;
        this.vy[i] += g * dt;
        m.position.x += this.vx[i] * dt;
        m.position.y += this.vy[i] * dt;
        m.position.z += this.vz[i] * dt;
        m.rotation.x += this.wx[i] * dt;
        m.rotation.y += this.wy[i] * dt;
        m.rotation.z += this.wz[i] * dt;
        if (m.position.y <= this.restY[i]) {
          m.position.y = this.restY[i];
          this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
          this.wx[i] = 0; this.wy[i] = 0; this.wz[i] = 0;
          this.moving[i] = 0;
        }
        continue;
      }
      if (amp <= 0.0005 || this.role[i] === P_GROUND) continue;
      const s = Math.sin(this.t * 41 + this.phase[i]) * amp;
      m.position.x = this.hx[i] + s * 0.7;
      m.position.y = this.hy[i] + s * 0.28;
      m.position.z = this.hz[i] + s * 0.35;
    }
    // One tidy-up pass once the shudder has died, then leave the meshes alone.
    if (amp <= 0.0005 && this._settled === 0) {
      this._settled = 1;
      for (let i = 0; i < this.count; i++) {
        if (this.slump[i] === 1) continue;
        this.meshes[i].position.set(this.hx[i], this.hy[i], this.hz[i]);
      }
    }
  }

  /* ── lifecycle ────────────────────────────────────────────────────────────── */

  _restoreTransforms() {
    for (let i = 0; i < this.count; i++) {
      const m = this.meshes[i];
      m.position.set(this.hx[i], this.hy[i], this.hz[i]);
      m.rotation.set(this.hrx[i], this.hry[i], this.hrz[i]);
      m.visible = true;
      this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
      this.wx[i] = 0; this.wy[i] = 0; this.wz[i] = 0;
      this.delay[i] = 0;
      this.moving[i] = 0;
    }
  }

  reset() {
    this.mode = IDLE;
    this.t = 0;
    this._settled = 0;
    this.uCrack.value = 0;
    this._restoreTransforms();
  }

  dispose() {
    this.scene.remove(this.group);
    for (let i = 0; i < this.meshes.length; i++) this.group.remove(this.meshes[i]);
    this.meshes.length = 0;
    this.boxGeo.dispose();
    this.planeGeo.dispose();
    for (const k of Object.keys(this.materials)) this.materials[k].dispose();
    if (this.signTex) this.signTex.dispose();
  }
}
