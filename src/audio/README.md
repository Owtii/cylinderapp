# TONNAGE audio

Everything you hear is synthesised at runtime. There are **no audio asset files** —
`init()` renders 41 sample banks (165 variants, ~115 s of audio) with
`OfflineAudioContext` behind the loading bar, and the game sounds finished with an
empty `/audio` directory. `registerSamples()` exists so real recordings can replace
any of those banks later without touching a line of game code.

```js
import { audio } from './audio/index.js';

await audio.init(t01 => screens.setLoadProgress(t01));   // from a user gesture
audio.update(dt, state);                                  // every frame, UNSCALED dt
audio.playImpact('glass', 'CLEAN', 40, playerWeight, pan, 1);
audio.playAbsorb(40, playerWeight, chain);
```

## The one rule: weight drives everything

The v2 game is about getting heavier, so weight is the parameter every layer
listens to. Pitch falls as `(startWeight / weight) ^ TUNING.audio.weightPitchExp`
everywhere — impacts, landings, the roll. `weightTerm01(weight)` (in `engine.js`)
is the shared 0..1 term, logarithmic between `player.startWeight` (500 kg) and
`player.maxWeight` (140,500 kg — everything on the track, absorbed). Logarithmic
because a linear scale would leave the first three zones inside the bottom 2 % of
the range and inaudible.

Four things move together as you grow: the rumble's grain rate drops, its resonant
body peak drops, its gain rises, and the drone tracks the drum's *real* rotation
rate — a bigger cylinder at the same speed turns slower. You can hear that you got
heavier with your eyes shut.

## THE BLOCKED SOUND

The brief: *the blocked sound must be deliberately the worst sound in the game —
dead, dull, short, no sub, no tail. It is the sound of failure and the player must
want to never hear it again.*

It gets there by **subtraction**. `ImpactPlayer.play()` short-circuits on
`'BLOCKED'` before any of the normal machinery runs: no material transient, no
material body, **no sub layer**, **no debris tail**, no window bookkeeping. One
buffer plays — `impact.blocked` — and the mix ducks hard. It is the only event in
the game with no low end and no scatter.

The bank itself is built to measure badly. Two cascaded lowpasses at ~165 Hz and
~155 Hz (24 dB/oct — one pole pair still left a 400 Hz shoulder), attacks slowed to
4–5 ms so the envelope's own click is not broadband, a lowpass placed *after* every
gain node to catch what the envelope adds, two sine partials at 79 Hz and 112 Hz
with barely any bend so nothing rings, and the lowest normalisation target of any
bank (0.66 — a block is not a payoff, so it does not get to be as loud as one).

### Measured, at 48 kHz, mean across variants

`decay s` is the time to the last sample above −40 dB of peak; `centroid Hz` is the
magnitude-weighted mean frequency of the Hann-windowed spectrum. Sorted darkest
first.

| bank | var | dur s | decay s | peak | RMS dBFS | centroid Hz |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `impact.sub` | 3 | 0.801 | 0.393 | 0.95 | -13.2 | 64 |
| **`impact.blocked`** | **3** | **0.056** | **0.026** | **0.66** | **-15.0** | **146** |
| `impact.structure.transient` | 5 | 0.401 | 0.193 | 0.96 | -16.6 | 191 |
| `impact.heavy.body` | 5 | 2.551 | 1.114 | 0.92 | -19.2 | 235 |
| `absorb.till` | 2 | 0.401 | 0.162 | 0.85 | -18.5 | 247 |
| `impact.structure.body` | 5 | 3.201 | 1.967 | 0.95 | -18.0 | 297 |
| `impact.heavy.transient` | 5 | 0.301 | 0.165 | 0.95 | -17.9 | 323 |
| `impact.concrete.body` | 5 | 0.221 | 0.076 | 0.68 | -22.0 | 350 |
| `combo.ding` | 3 | 1.001 | 0.421 | 0.85 | -21.6 | 381 |
| `impact.structure.debris` | 5 | 1.301 | 0.852 | 0.70 | -19.8 | 419 |
| `impact.dirt.transient` | 5 | 0.141 | 0.058 | 0.78 | -19.3 | 449 |
| `ui.gameover` | 1 | 1.801 | 1.327 | 0.82 | -19.8 | 585 |
| `house.hold` | 1 | 1.901 | 0.736 | 0.93 | -18.4 | 654 |
| `impact.heavy.debris` | 5 | 0.901 | 0.605 | 0.65 | -20.4 | 669 |
| `house.win` | 1 | 3.401 | 2.845 | 0.97 | -19.5 | 903 |
| `impact.concrete.transient` | 5 | 0.141 | 0.031 | 0.80 | -23.5 | 1014 |
| `ui.start` | 1 | 1.801 | 1.046 | 0.88 | -23.5 | 1261 |
| `impact.concrete.debris` | 5 | 0.301 | 0.209 | 0.40 | -29.5 | 1302 |
| `impact.dirt.body` | 5 | 0.281 | 0.116 | 0.62 | -20.0 | 1360 |
| `absorb.coin` | 3 | 0.301 | 0.121 | 0.80 | -20.5 | 1437 |
| `strike.alarm` | 2 | 0.261 | 0.114 | 0.88 | -13.6 | 1604 |
| `impact.dirt.debris` | 5 | 0.301 | 0.203 | 0.40 | -29.0 | 1663 |
| `ui.click` | 2 | 0.101 | 0.036 | 0.55 | -22.0 | 2016 |
| `impact.water.body` | 5 | 0.701 | 0.428 | 0.78 | -22.4 | 2132 |
| `impact.wood.body` | 5 | 0.301 | 0.094 | 0.72 | -21.7 | 2154 |
| `impact.wood.debris` | 5 | 0.281 | 0.159 | 0.55 | -24.9 | 2376 |
| `impact.water.debris` | 5 | 0.451 | 0.309 | 0.50 | -24.8 | 2411 |
| `impact.metal.body` | 5 | 1.851 | 0.794 | 0.85 | -23.9 | 2453 |
| `land.thud` | 3 | 0.801 | 0.270 | 0.92 | -18.8 | 2513 |
| `impact.car.debris` | 5 | 0.601 | 0.355 | 0.55 | -26.4 | 2585 |
| `ui.hover` | 2 | 0.071 | 0.030 | 0.38 | -26.8 | 2891 |
| `jump.whoosh` | 3 | 0.501 | 0.167 | 0.72 | -21.4 | 3152 |
| `impact.car.body` | 5 | 0.851 | 0.262 | 0.88 | -20.3 | 3323 |
| `impact.car.transient` | 5 | 0.201 | 0.078 | 0.92 | -21.1 | 4581 |
| `impact.water.transient` | 5 | 0.341 | 0.114 | 0.85 | -23.9 | 4765 |
| `impact.glass.debris` | 5 | 0.551 | 0.336 | 0.60 | -24.3 | 5666 |
| `impact.wood.transient` | 5 | 0.141 | 0.039 | 0.90 | -23.3 | 6057 |
| `impact.metal.debris` | 5 | 0.701 | 0.386 | 0.60 | -25.8 | 7136 |
| `impact.metal.transient` | 5 | 0.161 | 0.030 | 0.92 | -24.4 | 8114 |
| `impact.glass.body` | 5 | 1.451 | 0.562 | 0.85 | -23.8 | 9830 |
| `impact.glass.transient` | 5 | 0.221 | 0.062 | 0.90 | -24.3 | 9942 |

**What that table proves.**

- **Shortest.** `impact.blocked` is 0.056 s. **No other bank is that short** — the
  next shortest is `ui.hover` at 0.071 s, and the shortest *material* layer is
  0.141 s, **2.5× longer**. By decay it is 0.026 s and again **nothing else is
  shorter**; the nearest are `impact.metal.transient` and `ui.hover` at 0.030 s.
- **Dullest.** 146 Hz. The only bank below it is `impact.sub` (64 Hz), which is a
  pure 55 Hz sine *layer* — and a block is explicitly denied it, so a blocked hit
  can never contain anything darker than itself. The darkest material layer is
  `impact.structure.transient` at 191 Hz; the material that used to be the game's
  "dead" sound, `impact.concrete.transient`, is 1014 Hz — **6.9× brighter**. Glass
  is 9942 Hz, **68× brighter**.
- **Quietest in peak.** 0.66, the lowest normalisation target of any bank. Its RMS
  looks high (−15.0 dBFS) only because the buffer is 56 ms of nothing but the
  event; there is no tail to average against.

Two banks were adjusted specifically so the ordering could not be argued with:
`house.hold` gained the masonry cracks it should always have had (the house cracks
and *holds* — see `render/house.js`), and `absorb.till` gained its brass drawer
edge. A payoff sound must never measure as dead as a block.

Reproduce the table by rendering `renderBanks()` through any `OfflineAudioContext`
and measuring duration, decay, peak, RMS and spectral centroid per variant.

## Materials

Nine banks × three layers, plus the blocked signature:

| bank material | character | reached by |
| --- | --- | --- |
| `glass` | bright, long shimmering tail, high-Q inharmonic partials | `sound: 'glass'` |
| `wood` | dry, short, band-passed crack, mid-range, no tail | `sound: 'wood'` |
| `metal` | ringing modal partials with a downward twang | `sound: 'metal'`, tier `kiosk`, material `steel` |
| `car` | broadband crunch + a glass sub-layer + a low thud | `sound: 'car'`, material `paint` |
| `heavy` | groaning low metal, beating partials, long low boom | `sound: 'heavy'` under 9 t, tier `truck` |
| `structure` | **new** — a building coming down: masonry thud, then 2.5 s of rubble | `sound: 'heavy'` at/over `structureWeightMin` |
| `concrete` | dead, damped, almost no tail | `sound: 'concrete'`, tier `blocker`, materials `slate`/`hazard` |
| `water` | noise burst with a rapid lowpass sweep + bubbles | `sound: 'water'` |
| `dirt` | soft, muffled, gone in a moment | `sound: 'dirt'`, materials `rubber`/`sand` |
| `blocked` | the failure signature above | outcome `'BLOCKED'`, whatever the object is |

`structure` exists because the catalogue tags a 3.5 t flatbed and a 20 t water tower
with the same `sound: 'heavy'`, and a building coming down is not a vehicle being
crushed. `resolveMaterial(sound, weight)` (exported from `impacts.js`) promotes
`heavy` to `structure` above `TUNING.audio.structureWeightMin` — weight is the only
thing that separates them at the call site, and it is the right thing. It also folds
tier names and `MATERIALS` names onto banks, so **every `PROPS[key].sound` in the
catalogue resolves** and nothing falls back silently:

```
glass  → glass      wood → wood       metal → metal      car → car
heavy  → heavy      (3.5 t / 5 t / 6.5 t vehicles)
heavy  → structure  (10 t shed, 15 t silo, 20 t water tower)
concrete → concrete (the Infinity-weight blockers)
```

## Public API

Nothing plays before `init()` or after `dispose()`; every method no-ops safely
outside that window, so none of these need guarding at the call site.

| method | what it does |
| --- | --- |
| `init(onProgress)` | build the context, render every bank. From a user gesture. Idempotent. |
| `update(dt, s)` | per frame, **unscaled** dt. Allocation-free. See the state object below. |
| `playImpact(sound, outcome, objectWeight, playerWeight, pan, intensity01)` | `outcome` is `'CLEAN'` \| `'PULVERIZE'` \| `'PLOW'` \| `'BLOCKED'` |
| `playAbsorb(objectWeight, playerWeight, [chain])` | the weight-gain chime. Omit `chain` and the last value from `update` is used. |
| `playStrike(n)` | 1-based, escalating. `n >= collision.maxStrikes` inverts into the dread tone. |
| `playHouseHit(win)` | the finale. Two completely different sounds. |
| `setZone(i)` | 0..5. Adds a music layer and lifts the tempo. Idempotent. |
| `setBlockerDistance(m)` | metres to the nearest permanent blocker, or `Infinity`. |
| `playJump()` / `playLand(i01, weight)` / `playUi(kind)` | `kind`: `click`, `hover`, `start`, `gameover` |
| `setMusicIntensity(t01)` / `setMusicBlocked(b)` / `setFilterSweep(t01)` / `duck(db, hold)` | |
| `setVolumes(m, s, mu)` / `getVolumes()` / `setMuted(b)` | |
| `registerSamples(manifest)` / `reset()` / `dispose()` / `resume()` / `suspend()` | |
| `playCombo(chain, weight)` / `playPickup(value, weight)` | v1 names, forwarded to `playAbsorb` |

The per-frame state object (reuse ONE — `update` never retains it):

```js
{ speed, speed01, weight, grounded, airborne, timeScale, playing, chain, zone,
  blockerDistance }
```

`blockerDistance` is optional; without it the blocker hum never rises. `mass` and
`combo` are accepted as v1 aliases for `weight` and `chain`.

### playAbsorb — money landing

Absorbing is three things at once, so it is three layers:

- `combo.ding` — a pitched note climbing the pentatonic ladder with the **chain**.
  This is the reward players chase, and the only layer that knows about the chain.
- `absorb.coin` — one to three bright metallic taps. More taps for a bigger object:
  money landing on a steel counter.
- `absorb.till` — a low drawer clunk, but only when the object was at least
  `absorbTillShare` of what you currently weigh.

The **share** (`objectWeight / playerWeight`), not the absolute weight, drives the
bottom end: a 5 t truck at 500 kg should sound enormous and the same truck at 90 t
should not. Past `TUNING.audio.absorbCrowdMax` absorbs inside one `impactWindow`
the chime drops out entirely — a pile-up is already carried by the impact layers,
and the chime must not eat the 24-voice pool.

### playStrike — escalating

Layered on top of the blocked thud, and it is the loud half: `impact.blocked` is
deliberately dead, so this is what makes you flinch. Strike 2 starts higher than
strike 1 (`strikeStrikeSemitones`) and each fires one more rising blip, so you can
hear how many you have left without looking at the pips. The final strike inverts —
it falls `strikeFinalSemitones` into a detuned pair that beats against itself, the
only downward move in the game's whole sound set — and drops a sub under it.

## Music: one instrument layer per zone

Six layers, six zones. Each zone boundary hands you the next one:

| zone | | layer |
| --- | --- | --- |
| 0 | RESIDENTIAL | drums |
| 1 | MARKET | + bass |
| 2 | HIGH STREET | + arp |
| 3 | TRAFFIC | + pad |
| 4 | FREIGHT YARD | + stab (off-beat organ) |
| 5 | INDUSTRIAL | + lead (a detuned siren) |

Tempo climbs `musicBpmPerZone` per zone on top, so the ramp genuinely accelerates.
A hot chain lends exactly **one** layer early (`musicChainBonusAt`), and
`musicLayerThresholds` lets raw intensity crossfade a layer in ahead of its zone —
playing well is audible inside a zone as well as between zones, but a chain can
never skip the arrangement.

`setStripped(true)` takes everything but the drums away in `musicBlockedFade`
seconds. Two things trigger it, and they are the same message — *you are not
rolling, and that is your fault*:

- **a block** — `setMusicBlocked(true)`, which **releases itself** after
  `musicBlockedHold` seconds. "Has just been blocked" is a moment, not a state; a
  player who never smashes again should still hear the band come back rather than
  roll to the house over a bare drum loop. A successful smash clears it at once.
- **the player stopped** — `speed < musicStoppedSpeed`, evaluated every frame.

Scheduling is the standard lookahead pattern: a 25 ms timer that schedules notes
~120 ms ahead on the audio clock. It is never driven from the animation frame, so
hitstop and slow-motion cannot make the music stutter.

## Continuous layers

`rolling.js` owns three loops that are started once and never stopped (silence is
gain 0 — the only click-free way to do it), with all parameter motion smoothed in
JS by `damp()` and written straight to `AudioParam.value`, so nothing piles up in
the automation timeline and there is no zipper noise.

- **rumble** — pink-noise loop through a lowpass and a resonant body peak. Speed
  opens the lowpass; weight darkens it, drops the playback rate, drops the peak and
  raises the gain.
- **drone** — a sawtooth tracking the drum's real rotation rate × `droneHarmonic`.
- **wind** — a stereo band-passed loop, `speed01 ^ 1.8`.
- **blocker hum** — two oscillators nine cents apart so they **beat**, fading in
  (squared, so it is genuinely inaudible until it matters) inside
  `TUNING.read.blockerHumRadius`. Driven by `setBlockerDistance()` or
  `s.blockerDistance`; if nobody sets it, it stays silent forever.

## Crowd control

What makes a 30-object smash read as ONE huge event instead of mud:

- impacts inside `impactWindow` share a window; transient and body layers are
  capped at `maxLayerVoices` and per-voice gain falls as `count ^ -impactCrowdExp`.
  An object that dwarfs everything so far bypasses the cap and gets its own hit.
- a decaying density estimate (`densityTau`) thins the debris tails by up to
  `densityDebrisCut` when a lot is happening.
- there is only ever **one live sub voice**; hits inside `subRetrigger` swell its
  gain instead of stacking. Thirty crates become one enormous thump.
- the absorb chime has its own window cap (`absorbCrowdMax`).
- the 24-voice pool steals the **quietest** live voice, and drops a new sound
  quieter than everything already playing rather than cutting a bigger one short.
  `protect: true` (the sub, the blocked thud, the strike alarm, the house) exempts
  a voice from stealing.

## Swapping in real samples

Call `registerSamples(manifest)` at any time — before or after `init()`. Keys that
appear switch to the file backend; every other key keeps its procedural bank, so a
partial manifest is normal.

```js
audio.registerSamples({
  'impact.glass.transient': ['/audio/glass_t1.webm', '/audio/glass_t2.webm'],
  'impact.blocked':         '/audio/dead_thud.webm',   // a bare string is fine
  'loop.rolling':           '/audio/rumble_loop.webm',
});
```

Each URL in the array is one **variant**. Playback picks a variant at random and
never picks the same one twice in a row, so give it 3–5 of anything that fires
often. Files load through Howler (`pool: TUNING.audio.howlPoolSize`), which is
`import()`ed lazily — never loaded at all if you never call this.

### Manifest keys

`audio.sampleKeys` returns the live list. It is 9 materials × 3 layers + 14
singles + 2 loops = **43 keys**.

| key | what it is |
| --- | --- |
| `impact.<material>.transient` | the contact, 0 ms, very short |
| `impact.<material>.body` | the material's voice, plays `bodyDelay` later |
| `impact.<material>.debris` | one grain cluster; several are scattered over `debrisTailWindow`. Each procedural variant already holds 3–6 grains, so one impact can fire twenty-plus individual hits — keep replacements short and sparse or the tail smears |
| `impact.sub` | 40–60 Hz sine layer under every smash (never under a block) |
| `impact.blocked` | the failure thud. Replace it with something DEAD or you undo the whole design |
| `combo.ding` | the pitched chain reward inside `playAbsorb` |
| `absorb.coin`, `absorb.till` | the money and the drawer |
| `strike.alarm` | one blip of the strike burst |
| `house.win`, `house.hold` | the finale, both outcomes |
| `jump.whoosh`, `land.thud` | ramp launch / landing |
| `ui.click`, `ui.hover`, `ui.start`, `ui.gameover` | interface |
| `loop.rolling`, `loop.wind` | continuous layers (below) |

`<material>` is one of `glass`, `wood`, `metal`, `car`, `heavy`, `structure`,
`concrete`, `water`, `dirt`.

### Reference pitches

Playback rate is used for pitch, so a replacement must be recorded at the pitch the
engine assumes or everything will be transposed:

- `impact.sub` — fundamental at **55 Hz**, played back between 40 and 60 Hz
  depending on player weight (heavier = lower).
- `combo.ding` — root at `TUNING.audio.comboRootHz` (**233.08 Hz**, Bb3). The
  ladder transposes up the pentatonic scale from there.
- `absorb.coin` — **1046.5 Hz** (C6). `strike.alarm` — **330 Hz** (E4).
- `impact.*` and `land.thud` — record at the pitch of a "1.5 t hit"
  (`objectPitchRef`). They are pitched down as the player grows, by
  `(startWeight / weight) ^ weightPitchExp`, and by object weight on top.

Keep replacements roughly peak-normalised to each other; the procedural banks are
normalised to a designed peak per layer (see the `peak` column above) and the mix
gains in `TUNING.audio` assume that.

### Loops are different

`loop.rolling` and `loop.wind` do **not** go through Howler. They need
sample-accurate seamless loops, so they are fetched and `decodeAudioData`'d
directly and the rolling layer is rebuilt around the new buffer. Supply a file that
loops cleanly with no fade at either end — anything else ticks once per loop.
`loop.rolling` should be mono broadband noise-like material; `loop.wind` stereo.

### What you give up with the Howler backend

Howler owns its own `AudioContext`, so file-backed sounds do not pass through this
module's bus graph: they bypass the master limiter and the SFX bus, they are not in
the voice pool, and their scheduling falls back to `setTimeout`. None of that
matters for a handful of hero sounds. If you replace most of the banks, decode the
files into `AudioBuffer`s and hand them to `bank.setBuffers(key, buffers)` instead —
that keeps everything inside the graph.

## Tuning

Every number lives in `TUNING.audio`. The ones worth knowing:

- `weightPitchExp` — how hard growth pitches the whole game down.
- `structureWeightMin` — where `heavy` becomes `structure`.
- `blockedGain` / `blockedDuckDb` / `blockedDuckHold` — the failure signature.
  (`blockedSubBoost` is retained for compatibility only; a block never gets a sub.)
- `impactWindow` / `impactCrowdExp` / `maxLayerVoices` — how simultaneous impacts
  collapse into a single event.
- `subRetrigger` / `subSwellExp` / `subSwellMax` — the one-sub-voice swell.
- `musicLayerMix` / `musicBpmPerZone` / `musicBlockedHold` / `musicStoppedSpeed` —
  the zone arrangement.
- `rollingWeightGain` / `rollingRateExp` / `droneHarmonic` — how loudly weight
  reads in the continuous layers.
- `maxVoices` — the voice cap, with quietest-voice stealing.
