# TONNAGE audio

Everything you hear is synthesised at runtime. There are **no audio asset files** —
`init()` renders 45 sample banks (159 variants, ~108 s of audio) with
`OfflineAudioContext` behind the loading bar, and the game sounds finished with an
empty `/audio` directory. `registerSamples()` exists so real recordings can replace
any of those banks later without touching a line of game code.

```js
import { audio } from './audio/index.js';

await audio.init(t01 => screens.setLoadProgress(t01));   // from a user gesture
audio.update(dt, state);                                  // every frame, UNSCALED dt
audio.playImpact('glass', 'CLEAN', 40, playerWeight, pan, 1);
audio.playAbsorb(40, playerWeight, chain);

// v3 (§5, §17)
audio.setShredRate(smashesPerSecond, massPerSecond, 'car');   // the roar
audio.playSecondary('metal', 60, playerWeight, pan);          // a fragment's kill
audio.playDetonation(pan, playerWeight, 1);                   // a fuel tanker
audio.playScatter('horn', pan, distance01);                   // traffic reacting
audio.setTunnel(inside01);                                    // or s.tunnel
audio.playFirstTaste(zoneIndex);                              // once per tier
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
with barely any bend so nothing rings, and a normalisation target below every
impact transient (0.66 — a block is not a payoff, so it does not get to arrive as
loud as one).

### Measured, at 48 kHz, mean across variants

Rendered through a real filter graph and measured per variant. `dur s` is the
buffer; `decay s` is the time from the peak to the last sample above −40 dB of
it; `centroid Hz` is the magnitude-weighted mean frequency and `rolloff Hz` the
frequency below which 85 % of the magnitude sits, both over the whole event from
the peak (v2's table used a 4096-point window AT the peak, so v3's numbers are
lower across the board — compare within this table, not against v2's). Sorted
darkest first.

| bank | var | dur s | decay s | peak | RMS dBFS | centroid Hz | rolloff Hz |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`impact.blocked`** | **3** | **0.056** | **0.016** | **0.66** | **-16.4** | **93** | **128** |
| `impact.sub` | 3 | 0.801 | 0.325 | 0.95 | -18.0 | 106 | 65 |
| `absorb.till` | 2 | 0.401 | 0.148 | 0.85 | -18.9 | 210 | 113 |
| `impact.structure.transient` | 5 | 0.401 | 0.176 | 0.96 | -17.6 | 213 | 86 |
| `impact.heavy.transient` | 5 | 0.301 | 0.164 | 0.95 | -16.5 | 258 | 101 |
| `impact.heavy.body` | 4 | 2.551 | 1.048 | 0.92 | -19.4 | 292 | 224 |
| `ui.start` | 1 | 1.801 | 0.528 | 0.88 | -23.3 | 329 | 498 |
| `impact.structure.debris` | 4 | 1.301 | 0.383 | 0.70 | -20.6 | 357 | 312 |
| `combo.ding` | 3 | 1.001 | 0.411 | 0.85 | -21.3 | 387 | 467 |
| `impact.structure.body` | 3 | 3.201 | 1.964 | 0.95 | -21.1 | 390 | 207 |
| `tanker.blast` | 2 | 2.801 | 2.218 | 0.96 | -20.1 | 476 | 571 |
| `ui.gameover` | 1 | 1.801 | 1.277 | 0.82 | -19.4 | 491 | 904 |
| `impact.dirt.transient` | 5 | 0.141 | 0.046 | 0.78 | -20.9 | 512 | 418 |
| `impact.metal.body` | 4 | 1.851 | 0.785 | 0.94 | -24.6 | 518 | 768 |
| `impact.concrete.body` | 5 | 0.221 | 0.065 | 0.68 | -23.6 | 641 | 224 |
| `taste.stinger` | 1 | 1.101 | 0.446 | 0.92 | -18.1 | 693 | 1386 |
| `impact.heavy.debris` | 4 | 0.901 | 0.314 | 0.65 | -19.8 | 745 | 859 |
| `house.win` | 1 | 3.401 | 2.720 | 0.97 | -22.1 | 861 | 620 |
| `house.hold` | 1 | 1.901 | 0.725 | 0.93 | -19.2 | 900 | 529 |
| `impact.wood.debris` | 5 | 0.281 | 0.047 | 0.55 | -24.5 | 1105 | 1528 |
| `impact.concrete.transient` | 5 | 0.141 | 0.026 | 0.80 | -23.6 | 1249 | 1819 |
| `impact.metal.transient` | 5 | 0.161 | 0.030 | 0.92 | -19.5 | 1321 | 1986 |
| `impact.metal.debris` | 5 | 0.701 | 0.379 | 0.60 | -22.6 | 1359 | 1940 |
| `impact.dirt.body` | 5 | 0.281 | 0.105 | 0.62 | -21.2 | 1361 | 2424 |
| `absorb.coin` | 3 | 0.301 | 0.114 | 0.80 | -20.2 | 1432 | 1573 |
| `strike.alarm` | 2 | 0.261 | 0.106 | 0.88 | -12.7 | 1507 | 2462 |
| `traffic.horn` | 2 | 0.851 | 0.219 | 0.78 | -14.9 | 1547 | 2629 |
| `impact.wood.transient` | 5 | 0.141 | 0.034 | 0.90 | -22.4 | 1760 | 3242 |
| `ui.click` | 2 | 0.101 | 0.028 | 0.55 | -21.9 | 1866 | 3311 |
| `impact.car.transient` | 5 | 0.201 | 0.074 | 0.92 | -19.1 | 2052 | 4780 |
| `impact.wood.body` | 5 | 0.301 | 0.082 | 0.72 | -21.8 | 2279 | 4900 |
| `impact.dirt.debris` | 5 | 0.301 | 0.097 | 0.40 | -29.9 | 2327 | 3715 |
| `impact.car.body` | 5 | 0.851 | 0.249 | 0.88 | -20.5 | 2378 | 4242 |
| `ui.hover` | 2 | 0.071 | 0.024 | 0.38 | -25.6 | 2590 | 2435 |
| `impact.concrete.debris` | 5 | 0.301 | 0.072 | 0.40 | -30.1 | 2913 | 6114 |
| `land.thud` | 3 | 0.801 | 0.265 | 0.92 | -19.2 | 2981 | 6186 |
| `traffic.brake` | 2 | 0.721 | 0.317 | 0.70 | -22.0 | 3148 | 5170 |
| `jump.whoosh` | 3 | 0.501 | 0.153 | 0.72 | -23.2 | 3247 | 6902 |
| `impact.water.transient` | 3 | 0.341 | 0.108 | 0.85 | -24.0 | 4300 | 7471 |
| `impact.water.debris` | 3 | 0.451 | 0.147 | 0.50 | -34.0 | 4503 | 9629 |
| `impact.water.body` | 3 | 0.701 | 0.264 | 0.78 | -28.5 | 4714 | 9691 |
| `impact.car.debris` | 5 | 0.601 | 0.198 | 0.55 | -35.7 | 5179 | 10367 |
| `impact.glass.debris` | 5 | 0.551 | 0.192 | 0.60 | -35.7 | 6400 | 11852 |
| `impact.glass.transient` | 5 | 0.221 | 0.057 | 0.90 | -24.1 | 10294 | 17428 |
| `impact.glass.body` | 4 | 1.451 | 0.486 | 0.85 | -28.3 | 10528 | 18968 |

**What that table proves.**

- **Shortest.** `impact.blocked` is 0.056 s. **No other bank is that short** — the
  next shortest is `ui.hover` at 0.071 s, and the shortest *material* layer is
  0.141 s, **2.5× longer**. By decay it is 0.016 s and again **nothing else is
  shorter**; the nearest is `ui.hover` at 0.024 s.
- **Dullest.** 93 Hz. The only bank below it is `impact.sub` (106 Hz), which is a
  pure 55 Hz sine *layer* — and a block is explicitly denied it, so a blocked hit
  can never contain anything darker than itself. The next darkest bank of any
  kind is `absorb.till` at 210 Hz, **2.3× brighter**; the darkest material layer
  is `impact.structure.transient` at 213 Hz, and glass is 10,294 Hz — **111×**.
- **Quiet in peak.** 0.66, below every impact transient (the lowest of those is
  `impact.dirt.transient` at 0.78), so a block never arrives as loud as a hit.
  The quiet debris layers (0.40–0.65) and the UI banks normalise lower still, but
  those only ever play as the tail of a hit that already landed. Its RMS looks
  high (−16.4 dBFS) only because the buffer is 56 ms of nothing but the event;
  there is no tail to average against.

Two banks were adjusted in v2 specifically so the ordering could not be argued
with: `house.hold` gained the masonry cracks it should always have had (the house
cracks and *holds* — see `render/house.js`), and `absorb.till` gained its brass
drawer edge. A payoff sound must never measure as dead as a block. v3 adds four
banks and retunes five materials, and the same three claims hold with more room
than before.

Reproduce the table by rendering `renderBanks()` through any `OfflineAudioContext`
and measuring duration, decay, peak, RMS, centroid and rolloff per variant.

## The six tier signatures (§11)

*"Glass must sound nothing like a bus."* A tier's sound is not one bank, it is the
composite event `ImpactPlayer` actually fires — transient at 0, body at
`bodyDelay`, and four debris grains scattered across `debrisTailWindow`, at the
tuned layer gains — so that is what is measured here. Six seeds per tier, averaged.

| tier | bank | decay s | centroid Hz | rolloff Hz | <250 Hz | >5 kHz |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| glass | `glass` | 0.633 | 7108 | 14642 | 1.3 % | 21.8 % |
| wood | `wood` | 0.475 | 1627 | 2445 | 17.9 % | 0.1 % |
| furniture | `metal` | 0.828 | 1170 | 1679 | 17.3 % | 0.0 % |
| cars | `car` | 0.640 | 5271 | 12851 | 48.6 % | 3.3 % |
| trucks | `heavy` | 1.087 | 524 | 627 | 78.2 % | 0.0 % |
| structures | `structure` | 1.961 | 311 | 264 | 99.2 % | 0.0 % |

**v2 measured the same way, for comparison:**

| tier | decay s | centroid Hz | rolloff Hz | <250 Hz | >5 kHz |
| --- | ---: | ---: | ---: | ---: | ---: |
| glass | 0.624 | 6602 | 12081 | 0.8 % | 35.6 % |
| wood | 0.466 | 5880 | 13585 | 12.8 % | 7.8 % |
| furniture | 0.706 | 5997 | 13633 | 1.2 % | 4.8 % |
| cars | 0.654 | 4626 | 8702 | 44.1 % | 5.6 % |
| trucks | 1.075 | 3473 | 8830 | 93.5 % | 0.1 % |
| structures | 1.931 | 3162 | 7734 | 98.3 % | 0.1 % |

Glass, wood and furniture were within **0.17 octaves of each other on centroid and
0.18 on rolloff** — three of the six tiers were, in timbre, the same sound. The
banks themselves measured far apart (glass's transient at 10 kHz, wood's body at
2.3 kHz), which is exactly why the v2 table hid this: the layer that lasts longest
in the composite is the **debris**, and every material's debris was broadband
bright, because a Q≈2 bandpass barely attenuates noise. Adding a second lowpass
pole pair after those bandpasses is most of the fix.

What moved, and why:

- **furniture** (`metal`) was a bright ping. §11 asks for a *hollow clang*, so the
  two highest modal partials are gone, the transient's 2.2 kHz highpass is now a
  1.15 kHz bandpass with a 2.6 kHz ceiling, and a **pipe resonance** (odd
  harmonics of an air column) carries the ring. Its body is normalised higher
  than any other material's, because the ring is the identity of the tier and it
  has to still be above −40 dB a second later.
- **wood** kept its dry crack but lost its open highpass and its bright splinters:
  a splinter is band-limited, and an unfiltered one put wood on top of glass.
- **cars** kept the glass sub-layer §11 asks for, but an octave lower and three
  pings instead of four. It is a windscreen inside a crushing shell, not a
  greenhouse — and it is the 48.6 % of energy below 250 Hz that separates the two.
- **trucks** and **structures** got second lowpass poles on their debris, which is
  what makes them measure as low as they always sounded.

Pairwise separation in log₂ space over (decay, centroid, rolloff, low-band,
high-band), band ratios floored at 1 %: **every one of the 15 pairs is now ≥ 1.08**
(v2's worst was 0.29 on the three spectral axes alone, 0.88 with the band ratios).
The closest pair is wood/furniture, which differ by 1.7× in decay and 1.4× in
centroid — a dry crack against a dull ring, which is the distinction §11 asks for.

## The shredding roar (§5)

Above roughly six smashes a second, a wall of individual crunches stops being a
wall and becomes mud: twenty transients inside 200 ms mask each other, and the
24-voice pool spends itself on sounds nobody can pick out. So past that rate the
discrete one-shots fade down and **one continuous roar** fades up in their place.
A wall of crunches sounds cheap; a single escalating roar sounds enormous.

```js
audio.setShredRate(smashesPerSecond, massPerSecond, materialKey);
```

Safe to call every frame, and safe never to call at all — the reported rate decays
away on its own (`shredStale`), so the roar can never be left running under a
quiet ramp, and a v2 caller that never calls it gets v2 behaviour exactly.

It is **not a bank**. `ShredLayer` (in `rolling.js`) is a continuous layer built
like the rumble: a seamless grain-texture loop through a bandpass, a resonant
"tear" peak and a ceiling, plus a sawtooth sub, all damped in JS and written
straight to `AudioParam.value`. It costs nothing at init (the loop buffer is a
32 ms JS fill, not an offline render) and nothing per frame when it is silent.

**Three inputs, three different things:**

| input | what it moves |
| --- | --- |
| smashes/second | grain density (`playbackRate`), the ceiling, the level |
| mass/second | the sub layer, and it drags the **whole texture downward** (`shredMassDarken`) |
| material | the band, the tear resonance and the ceiling (`SHRED_CHAR`) |

So a hundred bottle crates is a bright dense hiss and a hundred silos is a slow
low grinding — the roar *changes*, it does not just get louder. Mass is read
logarithmically for the same reason `weightTerm01` is: a run spans a few hundred
kg/s of bollards to tens of tonnes a second of freight.

**The crossfade does not chatter.** Two mechanisms, and both are needed:

- **hysteresis** — it engages at `shredEnterRate` (6/s) and only releases at
  `shredExitRate` (3/s), so a stream hovering around 6 stays engaged;
- **a minimum dwell** (`shredMinHold`, 0.35 s) — one frame's spike cannot flip it.

Measured: a synthetic 4→8/s sweep (15 s, never below the exit rate) flips
**exactly once**; sitting on the 6/s threshold with ±0.5/s of wobble for 10 s
flips **zero times**; dropping to 2/s releases within 0.35 s. The mix reaches 90 %
in 0.18 s and falls back under 10 % in 1.08 s — it arrives fast because the mud it
replaces is already happening, and it leaves slowly so the last few hits do not
fall off a cliff.

**What the roar swallows, and what still punches through.** `ImpactPlayer.setShredMix`
gets the mix every frame, and above `shredSuppressAt` (0.7) an ordinary paper hit
fires **nothing at all**; below it the layers scale by `1 - mix`, and the debris
tail — the first thing to turn to gravel soup — goes at `mix > 0.45`. Never ducked:

- a **PLOW** (it cost you 25 % of your speed; you have to hear it),
- a **BLOCK** (the only feedback for the only mistake that costs a strike),
- anything at or above `shredPunchShare` (0.5) of your current weight.

The per-hit sub is ducked with everything else, because the roar has its own
continuous low end driven by mass/second and two low ends beating against each
other is worse than either.

## §17 — the highway

| | |
| --- | --- |
| **the tanker** | `playDetonation(pan, weight, i01)`. A real explosion's shape: an ignition crack, ~200 ms of nothing much, then the pressure wave arriving underneath. It is the biggest sound in the game that is not the house and is measured to stay there — 2.80 s and 2.22 s of decay against `house.win`'s 3.40 s / 2.72 s, and gain 0.95 against the house's 1.0. Ducks the music by 9 dB for 0.9 s. |
| **secondary destruction** | `playSecondary(material, weight, playerWeight, pan)`. It must read as a *consequence*, never as a second hit, which is three things: quieter (0.34×), **tighter** (the transient is clipped to 55 ms — a contact with no body behind it), and delayed by 45–80 ms. No body layer, no sub, no duck: the low end belongs to the parent impact, and a chain of these must never pump the mix. Capped at four per impact window, and dropped entirely under the roar. |
| **the scatter** | `playScatter(kind, pan, distance01)` — `'horn'`, `'brake'`, `'swerve'`. A horn is two reeds a minor third apart with a detuned partner beating against each one; a brake is six high-Q bands drifting apart over a rubber scrub. `'swerve'` is the brake bank clipped to 220 ms and pitched up — the same tyres, briefly. This is **texture, not feedback**: two per impact window, a 0.14 s per-kind cooldown, and level falls 75 % across `distance01` with a small drop in playback rate for the air. |
| **the tunnel** | `setTunnel(inside01)`, or `s.tunnel` on the per-frame state. The whole sfx bus runs through one lowpass (`sfxTone`, wide open at 20 kHz all run) with a convolution send hanging off it. Inside, the send opens and the ceiling drops to 5.2 kHz — concrete absorbs the top end. The IR is generated in JS: five discrete early reflections off the walls and roof, then a diffuse tail that darkens as it decays (35 ms to build, stereo, decayed 50 dB by its last fifth). The roll goes through it too, which is most of the effect. Smoothed over ~0.5 s so a portal is a transition, not a switch. |
| **first taste** | `playFirstTaste(tierIndex)`, 0–5 in zone order. One rise, one stab, and the tier's own body layer stamped underneath it at half speed: the tier name, said in its own voice. Transposed per tier (`tasteSemitones`, glass +7 semitones down to structures −7). Fires **at most once per tier per run** — the caller's `meta.firstTaste()` gates it and this gates it again, because two stingers over one 0.5 s freeze would be worse than none. `reset()` gives them back. |

## Materials

Nine banks × three layers, plus the blocked signature:

| bank material | character | reached by |
| --- | --- | --- |
| `glass` | bright, long shimmering tail, high-Q inharmonic partials | `sound: 'glass'` |
| `wood` | dry, short, band-passed crack, mid-range, no tail | `sound: 'wood'` |
| `metal` | **v3** — a hollow clang: three modal partials over a pipe resonance, dull and ringing | `sound: 'metal'`, tier `kiosk`, material `steel` |
| `car` | broadband crunch + a (v3: quieter, lower) glass sub-layer + a low thud | `sound: 'car'`, material `paint` |
| `heavy` | groaning low metal, beating partials, long low boom | `sound: 'heavy'` under 9 t, tier `truck` |
| `structure` | **new** — a building coming down: masonry thud, then 2.5 s of rubble | `sound: 'heavy'` at/over `structureWeightMin` |
| `concrete` | dead, damped, almost no tail | `sound: 'concrete'`, tier `blocker`, materials `slate`/`hazard` |
| `water` | noise burst with a rapid lowpass sweep + bubbles | `sound: 'water'` |
| `dirt` | soft, muffled, gone in a moment | `sound: 'dirt'`, materials `rubber`/`sand` |
| `blocked` | the failure signature above | outcome `'BLOCKED'`, whatever the object is |

Plus four §17 singles that are not materials: `tanker.blast`, `traffic.horn`,
`traffic.brake` and `taste.stinger`.

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
| **`setShredRate(smashesPerSecond, massPerSecond, material)`** | §5. Drives the crossfade into the continuous roar. Cheap every frame; optional entirely. |
| **`playSecondary(sound, objectWeight, playerWeight, pan)`** | §17. A fragment killing something on its way out — a consequence, not a hit. |
| **`playDetonation(pan, playerWeight, [i01])`** | §17. A fuel tanker. The biggest non-house sound in the game. |
| **`playScatter(kind, pan, distance01)`** | §17. `kind`: `horn`, `brake`, `swerve`. Traffic reacting to you. |
| **`setTunnel(inside01)`** | §17. 0 = open road, 1 = inside. Also readable off `s.tunnel`. |
| **`playFirstTaste(tierIndex)`** | §17. 0..5 in zone order. Once per tier per run; `reset()` gives them back. |
| **`shredMix`** (getter) | 0..1, how much of the mix the roar currently owns. |

The per-frame state object (reuse ONE — `update` never retains it):

```js
{ speed, speed01, weight, grounded, airborne, timeScale, playing, chain, zone,
  blockerDistance, tunnel }
```

`blockerDistance` and `tunnel` are optional; without them the blocker hum never
rises and the tunnel send never opens. `mass` and `combo` are accepted as v1
aliases for `weight` and `chain`.

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

`rolling.js` owns the loops that are started once and never stopped (silence is
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
- **the shredding roar** (`ShredLayer`, v3) — a grain-texture loop plus a sub,
  driven by smashes/second, mass/second and material. Silent until six smashes a
  second; see §5 above. When it is silent its whole `update` is eight compares
  and no `AudioParam` traffic at all.

## Crowd control

What makes a 30-object smash read as ONE huge event instead of mud:

- impacts inside `impactWindow` share a window; transient and body layers are
  capped at `maxLayerVoices` and per-voice gain falls as `count ^ -impactCrowdExp`.
  An object that dwarfs everything so far bypasses the cap and gets its own hit.
- a decaying density estimate (`densityTau`) thins the debris tails by up to
  `densityDebrisCut` when a lot is happening.
- there is only ever **one live sub voice**; hits inside `subRetrigger` swell its
  gain instead of stacking. Thirty crates become one enormous thump.
- the absorb chime has its own window cap (`absorbCrowdMax`), the §17 scatter has
  `scatterWindowMax` plus a per-kind cooldown, and secondary destruction has
  `secondaryWindowMax`.
- past `shredEnterRate` smashes a second none of this is enough, and the discrete
  hits hand over to one continuous roar entirely (§5).
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

`audio.sampleKeys` returns the live list. It is 9 materials × 3 layers + 18
singles + 2 loops = **47 keys**.

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
| `tanker.blast` | §17. The fuel tanker. Replace it with something that has a gap between the crack and the boom or it stops reading as an explosion |
| `traffic.horn`, `traffic.brake` | §17. The scatter. `'swerve'` plays the brake clipped and pitched up, so a replacement brake must survive being cut at 220 ms |
| `taste.stinger` | §17. The first-taste stab. The stab lands at `tasteStabDelay` (200 ms) into the buffer and the tier stamp is aligned to it |
| `loop.rolling`, `loop.wind` | continuous layers (below) |

The shredding roar has **no manifest key**: it is a live layer, not a bank (see
§5 above). Its source texture is generated in JS by `makeShredLoopBuffer`.

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
- `taste.stinger` — root **116 Hz** (A#2), transposed per tier by `tasteSemitones`.
- `traffic.horn` — the lower reed at **372 Hz**, the upper a minor third above it.
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
- `shredEnterRate` / `shredExitRate` / `shredMinHold` — the §5 crossfade and the
  two mechanisms that stop it chattering. The gap between the first two IS the
  hysteresis; closing it will make the roar flap.
- `shredGain` / `shredSubGain` / `shredMassRef` / `shredMassDarken` — how loudly
  and how darkly mass/second reads in the roar.
- `shredPunchShare` / `shredSuppressAt` — what the roar swallows and what still
  gets its own hit through it.
- `secondaryGain` / `secondaryDelay` / `secondaryClip` — the three things that
  make a fragment's kill read as a consequence rather than a second hit.
- `detonationGain` — must stay under `houseHitGain`, or a tanker upstages the
  house.
- `scatterGain` / `scatterWindowMax` / `scatterCooldown` — traffic is texture.
- `tunnelSendGain` / `tunnelToneHz` / `tunnelSmoothing` — the §17 tunnel.

## What init actually costs

v2 rendered 41 banks / 165 variants / 115.2 s of audio. v3 adds four §17 banks and
puts second filter poles on five materials, which is not free, so the four longest
and rarest banks were trimmed instead of adding variants across the board
(`VARIANT_CAP` in `synth.js`): the structure body drops to 3, the heavy/metal/glass
bodies and the structure/heavy debris to 4, and `water` — one prop in a 51-prop
catalogue — to 3 across all three layers.

Net: **45 banks / 159 variants / 107.6 s**, and the render measured through the
same offline DSP path is **flat** — 11.9 s mean over four runs against v2's 12.0 s.
The loading bar is no longer than it was, with four more banks behind it.

The two hand-built buffers new in v3 — the shred loop and the tunnel IR — are plain
JS fills at **32 ms and 35 ms**, and never touch the bar.
