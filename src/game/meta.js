/**
 * TONNAGE — the meta layer (§16, §17).
 *
 * Everything in here is state ABOUT a run rather than state inside one: the medal
 * ladder, the ghost of your best line, the daily seed, endless mode's escalating
 * house, and the two once-per-run cinematic beats §17 asks for. It owns no scene
 * objects and touches no DOM beyond localStorage, so every number below was measured
 * in a Node harness with a five-line storage stub. `game.js` wires it; nothing here
 * knows what a camera is.
 *
 * THE GHOST (§16.3) is the only part whose shape is worth explaining.
 *
 * Samples live on a fixed 20 Hz grid, so a sample's INDEX is its timestamp and the
 * serialised form carries no clock at all. `recordFrame` is called from the render
 * loop at whatever rate the machine manages and fills every grid slot the frame
 * crossed by interpolating between the last call and this one — a 12 ms frame writes
 * nothing, a 90 ms frame writes two, and the playback is identical either way. That
 * decoupling is the whole reason for the grid: a ghost recorded on a 144 Hz monitor
 * has to replay correctly on a phone dropping to 30.
 *
 * A sample is six bytes: `d` as a uint16 at 0.2 m, `x` as an int16 at 2 mm, and the
 * CUBE ROOT of the weight as a uint16 at 0.002. The cube root is not cleverness for
 * its own sake — the only thing the ghost's weight drives is the drum's radius, and
 * radius is w^(1/3). Storing the root makes the quantisation error proportional
 * (±6 kg at 100 t, ±60 kg at 1000 t) and lets one uint16 span endless mode's whole
 * range instead of saturating around 262 t. A 190 s run is 3,800 samples: 22 KB
 * packed, 31 KB of base64 in localStorage.
 *
 * localStorage is treated as a nicety that may not be there. Private windows throw
 * on WRITE rather than on read, quota is not knowable in advance, and someone else's
 * junk may be sitting under our keys. Every access is wrapped and every failure is
 * silent; the in-memory ghost is filled from the recording buffer on `finishRun`
 * whether or not the write succeeded, so even a browser that persists nothing still
 * replays the run you just did.
 *
 * Nothing on the per-frame path (`recordFrame`, `ghostAt`, `shouldScaleReveal`,
 * `firstTaste`) allocates. The run-start and run-end paths do, freely — they happen
 * twice a run and they are where the JSON and the base64 live.
 */

import { TUNING } from '../tuning.js';
import { clamp } from '../core/math.js';

export const MODE_NORMAL = 'normal';
export const MODE_DAILY = 'daily';
export const MODE_ENDLESS = 'endless';

const MEDAL_NAMES = ['bronze', 'silver', 'gold'];

/* Packed-ghost container: 'TG', version, rate, count, seed, weight, run time. */
const GHOST_MAGIC_A = 0x54;      // 'T'
const GHOST_MAGIC_B = 0x47;      // 'G'
const GHOST_VERSION = 1;
const GHOST_HEADER = 16;
const GHOST_STRIDE = 6;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INV[B64.charCodeAt(i)] = i;

/** Grouped integer, for the share line. Not a per-frame path. */
function fmt(v) {
  let n = Math.round(Number(v) || 0);
  if (n < 0) n = 0;
  if (n < 1000) return '' + n;
  let out = '';
  while (n >= 1000) {
    const r = n % 1000;
    n = (n - r) / 1000;
    out = ',' + (r < 10 ? '00' : r < 100 ? '0' : '') + r + out;
  }
  return n + out;
}

/**
 * 'YYYY-MM-DD' from anything date-shaped, or '' if it is not a date at all.
 *
 * The daily seed is derived from these ten characters and nothing else, which is
 * what makes it the same track for everyone on the same calendar day regardless of
 * timezone, locale or clock skew.
 */
function isoDay(dateISO) {
  if (typeof dateISO !== 'string' || dateISO.length < 10) return '';
  const s = dateISO.slice(0, 10);
  for (let i = 0; i < 10; i++) {
    const c = s.charCodeAt(i);
    const wantDash = i === 4 || i === 7;
    if (wantDash ? c !== 45 : c < 48 || c > 57) return '';
  }
  return s;
}

function isoToUtcDays(s) {
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Chunked base64. One call per run end; the chunking keeps the concat off O(n²). */
function b64encode(bytes, len) {
  let out = '';
  let chunk = '';
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : 0;
    const c = i + 2 < len ? bytes[i + 2] : 0;
    chunk += B64[a >> 2];
    chunk += B64[((a & 3) << 4) | (b >> 4)];
    chunk += i + 1 < len ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    chunk += i + 2 < len ? B64[c & 63] : '=';
    if (chunk.length >= 4096) { out += chunk; chunk = ''; }
  }
  return out + chunk;
}

/** Decodes into a fresh Uint8Array, or null if the string is not our base64. */
function b64decode(str) {
  if (typeof str !== 'string') return null;
  let n = str.length;
  while (n > 0 && str.charCodeAt(n - 1) === 61) n--;   // '='
  const out = new Uint8Array((n * 3) >> 2);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < n; i++) {
    const code = str.charCodeAt(i);
    const v = code < 128 ? B64_INV[code] : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) >>> 0;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >>> bits) & 255; }
  }
  return o === out.length ? out : out.subarray(0, o);
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function wu16(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; }
function wu32(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }

export class Meta {
  /**
   * `storage` exists for the Node harness only. In the browser it is undefined and
   * every access goes through `globalThis.localStorage` behind a try/catch.
   */
  constructor(storage) {
    const M = TUNING.meta;
    this._storage = storage;

    this.hz = M.ghostHz;
    this.capacity = Math.max(2, Math.round(M.ghostHz * M.ghostMaxSeconds));

    // Recording (this run) and playback (your best) are separate buffers, because
    // you are recording a new ghost while the old one is still rolling beside you.
    this.recD = new Uint16Array(this.capacity);
    this.recX = new Int16Array(this.capacity);
    this.recR = new Uint16Array(this.capacity);   // cube root of weight
    this.recCount = 0;

    this.gD = new Uint16Array(this.capacity);
    this.gX = new Int16Array(this.capacity);
    this.gR = new Uint16Array(this.capacity);
    this.ghostCount = 0;
    this.ghostSeed = 0;
    this.ghostWeight = 0;
    this.ghostTime = 0;

    this.taste = new Array(Math.max(1, M.firstTasteSlots)).fill('');
    this.tasteCount = 0;
    this.revealed = new Uint8Array(Math.max(1, M.scaleRevealAt.length));

    // Reused so the run-end path can be called without churning objects; documented
    // on the getters that hand them out.
    this._next = { name: 'bronze', at: 0, need: 0 };
    this._result = {
      medal: null, isBest: false, best: 0, ghostSaved: false,
      unlockedEndless: false, share: '', day: 0,
    };

    // The shape is checked, not just the parse: a value that is valid JSON but not a
    // best run (an array, someone else's object, a half-migrated v2 record) would
    // otherwise leave `best.weight` undefined, and every `weight > undefined` after
    // that is false — the best run would silently never update again.
    const best = this._readJson('best', null);
    this.best = best && typeof best.weight === 'number' && isFinite(best.weight) ? best : null;
    const flags = this._readJson('flags', null);
    this.flags = flags && !Array.isArray(flags) ? flags : { won: 0, daily: null };

    this.seed = 0;
    this.mode = MODE_NORMAL;
    this.round = 1;
    this.reset();
  }

  /* ── run lifecycle ────────────────────────────────────────────────────────── */

  /** Clears per-run state. Persisted state (best run, unlocks) is untouched. */
  reset() {
    this.recCount = 0;
    this._prevT = 0;
    this._prevD = 0;
    this._prevX = 0;
    this._prevW = TUNING.player.startWeight;
    this.tasteCount = 0;
    for (let i = 0; i < this.taste.length; i++) this.taste[i] = '';
    this.revealed.fill(0);
  }

  /**
   * `round` is endless mode's lap counter and is 1 everywhere else. Loading the
   * ghost here rather than in the constructor is deliberate: a ghost belongs to a
   * SEED, so the daily's ghost is the daily's, and a fresh seed simply has none.
   */
  startRun(seed, mode, round) {
    this.reset();
    this.seed = seed >>> 0;
    this.mode = mode === MODE_DAILY || mode === MODE_ENDLESS ? mode : MODE_NORMAL;
    this.round = Math.max(1, Math.round(round || 1));
    this._loadGhost(this.seed);
    return this.seed;
  }

  /* ── the ghost (§16.3) ────────────────────────────────────────────────────── */

  /**
   * Allocation-free. `t` is seconds since the run started and must not go backwards;
   * `d` is travel distance, `x` lateral position, `weight` the drum's current mass.
   *
   * Every grid slot between the previous call and this one is filled by interpolating,
   * so the recording is frame-rate independent. Once the buffer is full the run has
   * outlived `ghostMaxSeconds` and recording simply stops — a run that long is not
   * going to be anybody's best line.
   */
  recordFrame(t, d, x, weight) {
    if (!(t >= 0) || this.recCount >= this.capacity) return;
    const step = 1 / this.hz;

    if (this.recCount === 0) {
      this._write(0, d, x, weight);
      this.recCount = 1;
      // The run's clock starts at zero even if the first frame arrives later, so
      // sample 0 is always t=0 and playback needs no offset.
      this._prevT = 0;
      this._prevD = d; this._prevX = x; this._prevW = weight;
      return;
    }
    if (t <= this._prevT) return;

    const span = t - this._prevT;
    while (this.recCount < this.capacity) {
      const tk = this.recCount * step;
      // The epsilon is not slop: `24 * (1/20)` is 1.2000000000000002, so a grid tick
      // that lands exactly on a frame time would otherwise be skipped and every
      // sample after it would sit one slot early for the rest of the run.
      if (tk > t + 1e-9) break;
      const u = clamp((tk - this._prevT) / span, 0, 1);
      this._write(
        this.recCount,
        this._prevD + (d - this._prevD) * u,
        this._prevX + (x - this._prevX) * u,
        this._prevW + (weight - this._prevW) * u,
      );
      this.recCount++;
    }
    this._prevT = t; this._prevD = d; this._prevX = x; this._prevW = weight;
  }

  _write(i, d, x, w) {
    const M = TUNING.meta;
    const qd = Math.round(d / M.ghostDQuantum);
    const qx = Math.round(x / M.ghostXQuantum);
    const qr = Math.round(Math.cbrt(w > 0 ? w : 0) / M.ghostWeightRootQuantum);
    this.recD[i] = qd < 0 ? 0 : qd > 65535 ? 65535 : qd;
    this.recX[i] = qx < -32768 ? -32768 : qx > 32767 ? 32767 : qx;
    this.recR[i] = qr < 0 ? 0 : qr > 65535 ? 65535 : qr;
  }

  get hasGhost() { return this.ghostCount > 1; }
  /** Seconds of recorded ghost. */
  get ghostDuration() { return this.ghostCount > 0 ? (this.ghostCount - 1) / this.hz : 0; }
  /** Seconds of THIS run captured so far — the HUD has no use for it, tests do. */
  get recordedDuration() { return this.recCount > 0 ? (this.recCount - 1) / this.hz : 0; }

  /**
   * Samples the ghost at `t` seconds into the run. Fills `out.d`, `out.x` and
   * `out.weight`; returns false when there is no ghost, or once it has been held at
   * its final pose for `ghostHoldSeconds` past the end of the recording.
   *
   * The hold matters: a ghost that reached the house simply vanishing mid-frame reads
   * as a bug, where a ghost sitting still at the finish reads as the thing you are
   * chasing having already arrived.
   */
  ghostAt(t, out) {
    const n = this.ghostCount;
    if (n < 2 || !out) return false;
    const M = TUNING.meta;
    const last = n - 1;
    let f = (t > 0 ? t : 0) * this.hz;
    if (f > last) {
      if (t > this.ghostDuration + M.ghostHoldSeconds) return false;
      f = last;
    }
    let i = f | 0;
    if (i > last) i = last;
    let j = i + 1;
    if (j > last) j = last;
    const u = f - i;
    out.d = (this.gD[i] + (this.gD[j] - this.gD[i]) * u) * M.ghostDQuantum;
    out.x = (this.gX[i] + (this.gX[j] - this.gX[i]) * u) * M.ghostXQuantum;
    const r = (this.gR[i] + (this.gR[j] - this.gR[i]) * u) * M.ghostWeightRootQuantum;
    out.weight = r * r * r;
    return true;
  }

  /* ── medals (§16.2) ───────────────────────────────────────────────────────── */

  /**
   * The ratios are §16's, frozen: 1.0 / 1.25 / 1.5 x the house. `houseWeight` is a
   * parameter rather than a constant read because endless mode raises it every lap.
   * Comparisons are `>=` so a run that lands exactly on a threshold earns it.
   */
  medalFor(weight, houseWeight) {
    const h = houseWeight > 0 ? houseWeight : TUNING.finale.houseWeight;
    const M = TUNING.medals;
    if (weight >= h * M.gold) return 'gold';
    if (weight >= h * M.silver) return 'silver';
    if (weight >= h * M.bronze) return 'bronze';
    return null;
  }

  /**
   * The threshold the player is reaching for next, so the run-end screen always has
   * a next goal. Returns a REUSED object `{ name, at, need }` — read it, do not
   * retain it — or null once gold is held.
   */
  nextMedal(weight, houseWeight) {
    const h = houseWeight > 0 ? houseWeight : TUNING.finale.houseWeight;
    const M = TUNING.medals;
    for (let i = 0; i < MEDAL_NAMES.length; i++) {
      const at = h * M[MEDAL_NAMES[i]];
      if (weight < at) {
        this._next.name = MEDAL_NAMES[i];
        this._next.at = at;
        this._next.need = at - weight;
        return this._next;
      }
    }
    return null;
  }

  /* ── §17's one-time beats ─────────────────────────────────────────────────── */

  /**
   * True exactly once per tier per run — the trigger for the 0.5 s slow-motion
   * close-up with the tier name stamped over it. `tier` is any stable string
   * ('CLEAN', 'PLOW', 'BLOCKED', 'TANKER', …); the caller decides the vocabulary.
   *
   * A linear scan over at most `firstTasteSlots` strings, on a path that fires a
   * handful of times per run and never allocates.
   */
  firstTaste(tier) {
    if (!tier) return false;
    for (let i = 0; i < this.tasteCount; i++) if (this.taste[i] === tier) return false;
    if (this.tasteCount >= this.taste.length) return false;
    this.taste[this.tasteCount++] = tier;
    return true;
  }

  /**
   * The scale reveal: twice per run the camera pulls way out for two seconds, once
   * mid-run and once on the final approach. `progress01` is how far down the track
   * the player is.
   *
   * At most ONE reveal is claimed per call even if a hitch carried progress past both
   * points, because two overlapping pull-outs is a camera bug, not a beat.
   */
  shouldScaleReveal(progress01) {
    const at = TUNING.meta.scaleRevealAt;
    const n = Math.min(at.length, this.revealed.length);
    for (let i = 0; i < n; i++) {
      if (!this.revealed[i] && progress01 >= at[i]) {
        this.revealed[i] = 1;
        return true;
      }
    }
    return false;
  }

  /* ── daily (§16.10) and endless (§16.11) ──────────────────────────────────── */

  /** Local calendar day, so the daily rolls over at the player's midnight. */
  todayISO() {
    const now = new Date();
    const m = now.getMonth() + 1, d = now.getDate();
    return now.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }

  /**
   * A uint32 derived from the ten characters of the ISO date and nothing else, so
   * every machine on the same day builds the same track. FNV-1a plus an avalanche
   * mix, all in Math.imul, because plain `*` on 32-bit hashes goes through doubles
   * and stops being bit-exact.
   */
  dailySeed(dateISO) {
    const s = isoDay(dateISO) || isoDay(this.todayISO());
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h = (h ^ s.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    h = Math.imul(h, 0x846ca68b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h || 1;
  }

  /** The `#142` in the share line: days since `meta.dailyEpoch`, inclusive. */
  dailyNumber(dateISO) {
    const s = isoDay(dateISO) || isoDay(this.todayISO());
    const e = isoDay(TUNING.meta.dailyEpoch);
    if (!s || !e) return 1;
    return Math.max(1, isoToUtcDays(s) - isoToUtcDays(e) + 1);
  }

  /** The stored result for a given day, or null. */
  dailyResult(dateISO) {
    const s = isoDay(dateISO) || isoDay(this.todayISO());
    const d = this.flags && this.flags.daily;
    return d && d.date === s ? d : null;
  }

  get endlessUnlocked() { return !!(this.flags && this.flags.won); }

  /**
   * Endless mode's house for lap `round`, geometric at `meta.endlessGrowth`.
   *
   * 1.5x per lap against a 175,500 kg track: absorbing ~90 % of a lap and carrying it
   * forward gives roughly 158,000 kg per lap, so the houses (100k, 150k, 225k, 338k,
   * 506k, 759k, 1.14M) sit under the cumulative ceiling (158k, 316k, 474k, 632k,
   * 790k, 948k, 1.11M) until lap seven, where it crosses. Six laps deep before the
   * mode is arithmetically over is exactly the "escalates but stays beatable for a
   * few rounds" the brief asks for. Rounded to 500 kg so the HUD reads cleanly.
   */
  endlessHouseWeight(round) {
    const base = TUNING.finale.houseWeight;
    const r = Math.max(1, Math.round(round || 1));
    const w = base * Math.pow(TUNING.meta.endlessGrowth, r - 1);
    return Math.round(w / 500) * 500;
  }

  /**
   * `TONNAGE #142 - 118,400 kg silver` — §16.10's line, verbatim. Endless adds its
   * lap, because a share line without it says nothing about the run.
   */
  shareLine(stats) {
    const s = stats || {};
    const day = s.day || this.dailyNumber(s.date);
    const medal = s.medal || this.medalFor(s.weight || 0, s.houseWeight);
    const head = (s.mode || this.mode) === MODE_ENDLESS
      ? 'TONNAGE ENDLESS #' + day + ' - lap ' + Math.max(1, Math.round(s.round || this.round))
      : 'TONNAGE #' + day;
    return head + ' - ' + fmt(s.weight || 0) + ' kg' + (medal ? ' ' + medal : '');
  }

  /* ── persistence ──────────────────────────────────────────────────────────── */

  /**
   * Called once, at the end of a run. Persists the best run, the ghost for this seed
   * and the endless unlock, and returns a REUSED summary object for the run-end
   * screen. Every write is best-effort; a browser that stores nothing still gets the
   * ghost in memory, so restarting the same seed replays it.
   */
  finishRun(stats) {
    const s = stats || {};
    const weight = s.weight || 0;
    const house = s.houseWeight > 0 ? s.houseWeight : TUNING.finale.houseWeight;
    const medal = s.medal !== undefined ? s.medal : this.medalFor(weight, house);
    // Reaching the house's weight is not the same as reaching the house: a strike only
    // costs 10 %, so a run can pass `house` and still end on the third one. Weight is
    // the fallback for a caller that reports no outcome at all, never an override of a
    // caller that reported a loss.
    const won = s.outcome === 'win' || (s.outcome === undefined && weight >= house);
    const seed = s.seed !== undefined ? s.seed >>> 0 : this.seed;
    const mode = s.mode || this.mode;
    const date = isoDay(s.date) || this.todayISO();

    const isBest = !this.best || weight > this.best.weight;
    if (isBest) {
      this.best = {
        weight: Math.round(weight),
        medal: medal || null,
        smashed: s.smashed | 0,
        bestChain: s.bestChain | 0,
        zonesCleared: s.zonesCleared | 0,
        time: Math.round((s.time || 0) * 100) / 100,
        seed, mode, date,
      };
      this._writeJson('best', this.best);
    }

    let dirtyFlags = false;
    if (won && !this.flags.won) { this.flags.won = 1; dirtyFlags = true; }
    if (mode === MODE_DAILY) {
      const prev = this.flags.daily;
      if (!prev || prev.date !== date || weight > prev.weight) {
        this.flags.daily = { date, weight: Math.round(weight), medal: medal || null };
        dirtyFlags = true;
      }
    }
    if (dirtyFlags) this._writeJson('flags', this.flags);

    const ghostSaved = this._commitGhost(seed, weight, s.time || 0);

    const r = this._result;
    r.medal = medal || null;
    r.isBest = isBest;
    r.best = this.best ? this.best.weight : Math.round(weight);
    r.ghostSaved = ghostSaved;
    r.unlockedEndless = this.endlessUnlocked;
    r.day = this.dailyNumber(date);
    r.share = this.shareLine({
      weight, medal, mode, round: s.round || this.round, day: r.day, houseWeight: house,
    });
    return r;
  }

  /**
   * Promotes this run's recording to the ghost for its seed, if it beat the one
   * already there. In-memory first and storage second, deliberately: the ghost has to
   * work in a private window.
   */
  _commitGhost(seed, weight, time) {
    if (this.recCount < 2) return false;
    const idx = this._readJson('idx', null);
    const prev = this._findSlot(idx, seed);
    // The in-memory ghost counts as a rival even when nothing was persisted, so a
    // session in a private window still keeps the best of its own runs rather than
    // the most recent one.
    let rival = prev ? prev.w : -1;
    if (this.ghostCount > 1 && this.ghostSeed === (seed >>> 0) && this.ghostWeight > rival) rival = this.ghostWeight;
    if (rival >= weight) return false;

    this.gD.set(this.recD.subarray(0, this.recCount));
    this.gX.set(this.recX.subarray(0, this.recCount));
    this.gR.set(this.recR.subarray(0, this.recCount));
    this.ghostCount = this.recCount;
    this.ghostSeed = seed;
    this.ghostWeight = weight;
    this.ghostTime = time;

    return this._saveGhost(seed, weight, time, idx);
  }

  _findSlot(idx, seed) {
    if (!idx || !idx.length) return null;
    for (let i = 0; i < idx.length; i++) if ((idx[i].s >>> 0) === (seed >>> 0)) return idx[i];
    return null;
  }

  _saveGhost(seed, weight, time, idxIn) {
    const store = this._store();
    if (!store) return false;
    const M = TUNING.meta;
    const n = this.ghostCount;
    const bytes = new Uint8Array(GHOST_HEADER + n * GHOST_STRIDE);
    bytes[0] = GHOST_MAGIC_A;
    bytes[1] = GHOST_MAGIC_B;
    bytes[2] = GHOST_VERSION;
    bytes[3] = this.hz & 255;
    wu16(bytes, 4, n);
    wu32(bytes, 6, seed >>> 0);
    wu32(bytes, 10, Math.min(0xffffffff, Math.round(weight)));
    wu16(bytes, 14, Math.min(65535, Math.round(time * 100)));
    let o = GHOST_HEADER;
    for (let i = 0; i < n; i++) {
      wu16(bytes, o, this.gD[i]);
      wu16(bytes, o + 2, this.gX[i] & 0xffff);
      wu16(bytes, o + 4, this.gR[i]);
      o += GHOST_STRIDE;
    }

    if (!this._set('g.' + (seed >>> 0), b64encode(bytes, bytes.length))) return false;

    // The index is what makes eviction possible at all: localStorage has no
    // enumeration we would trust to be ours alone.
    let idx = idxIn || this._readJson('idx', null);
    if (!Array.isArray(idx)) idx = [];
    const slot = this._findSlot(idx, seed);
    if (slot) { slot.w = Math.round(weight); slot.t = Date.now(); }
    else idx.push({ s: seed >>> 0, w: Math.round(weight), t: Date.now() });
    while (idx.length > Math.max(1, M.ghostSlots)) {
      let oldest = 0;
      for (let i = 1; i < idx.length; i++) if (idx[i].t < idx[oldest].t) oldest = i;
      this._remove('g.' + (idx[oldest].s >>> 0));
      idx.splice(oldest, 1);
    }
    this._writeJson('idx', idx);
    return true;
  }

  /**
   * Reads the stored ghost for a seed into the playback buffer.
   *
   * A failed read only clears what is already loaded if it belonged to a DIFFERENT
   * seed. Without that, a browser that persists nothing would throw away the ghost of
   * the run you just did the moment you pressed R on the same track.
   */
  _loadGhost(seed) {
    const raw = this._get('g.' + (seed >>> 0));
    const b = raw ? b64decode(raw) : null;
    const usable = !!b && b.length >= GHOST_HEADER
      && b[0] === GHOST_MAGIC_A && b[1] === GHOST_MAGIC_B && b[2] === GHOST_VERSION
      && b[3] === (this.hz & 255);                   // a retuned sample rate invalidates old ghosts
    if (!usable) return this._keepOrDropGhost(seed);
    const n = Math.min(u16(b, 4), this.capacity);
    if (n < 2 || b.length < GHOST_HEADER + n * GHOST_STRIDE) return this._keepOrDropGhost(seed);
    let o = GHOST_HEADER;
    for (let i = 0; i < n; i++) {
      this.gD[i] = u16(b, o);
      this.gX[i] = (u16(b, o + 2) << 16) >> 16;      // back to signed
      this.gR[i] = u16(b, o + 4);
      o += GHOST_STRIDE;
    }
    this.ghostCount = n;
    this.ghostSeed = u32(b, 6);
    this.ghostWeight = u32(b, 10);
    this.ghostTime = u16(b, 14) / 100;
    return true;
  }

  _keepOrDropGhost(seed) {
    if (this.ghostCount > 1 && this.ghostSeed === (seed >>> 0)) return true;
    this.ghostCount = 0;
    this.ghostSeed = 0;
    this.ghostWeight = 0;
    this.ghostTime = 0;
    return false;
  }

  /** Forgets every stored ghost and the best run. Nothing calls it but the console. */
  clearStorage() {
    const idx = this._readJson('idx', null);
    if (Array.isArray(idx)) for (let i = 0; i < idx.length; i++) this._remove('g.' + (idx[i].s >>> 0));
    this._remove('idx');
    this._remove('best');
    this._remove('flags');
    this.best = null;
    this.flags = { won: 0, daily: null };
    this.ghostCount = 0;
  }

  /* ── storage, all of it best-effort ───────────────────────────────────────── */

  _store() {
    if (this._storage !== undefined) return this._storage;
    try {
      const s = globalThis.localStorage;
      return s && typeof s.getItem === 'function' ? s : null;
    } catch (err) {
      return null;                 // blocked by policy: reading the property itself throws
    }
  }

  _get(key) {
    const s = this._store();
    if (!s) return null;
    try { return s.getItem(TUNING.meta.storagePrefix + key); } catch (err) { return null; }
  }

  _set(key, value) {
    const s = this._store();
    if (!s) return false;
    // Private windows and full quotas both throw here, and neither is recoverable
    // nor worth telling the player about.
    try { s.setItem(TUNING.meta.storagePrefix + key, value); return true; } catch (err) { return false; }
  }

  _remove(key) {
    const s = this._store();
    if (!s) return;
    try { s.removeItem(TUNING.meta.storagePrefix + key); } catch (err) { /* nothing to do */ }
  }

  _readJson(key, fallback) {
    const raw = this._get(key);
    if (!raw) return fallback;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : fallback;
    } catch (err) {
      return fallback;             // someone else's key, or a half-written value
    }
  }

  _writeJson(key, value) {
    try { return this._set(key, JSON.stringify(value)); } catch (err) { return false; }
  }
}
