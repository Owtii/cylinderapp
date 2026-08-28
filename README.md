# TONNAGE

You start as a **500 kg** steel drum at the top of a finite ramp. Everything on that ramp
has a weight printed on it, and everything you smash gets added to yours. At the bottom is
a **100,000 kg house**. Break it and you win.

The ramp holds 140,000 kg across six zones. You need roughly **71 %** of it. Nothing on the
track is a pickup and nothing is decoration: **the objects _are_ the pickups**, and every
one of them is a decision about whether you are heavy enough yet.

```
npm install
npm run dev              # http://localhost:5173
npm run build && npm run preview

npm run build:single     # dist-single/ — one JS file, nothing fetched at runtime
```

`build:single` exists because the game has to be publishable as a single self-contained
page: no code splitting, CSS and every asset inlined. There is nothing to fetch anyway —
Rapier's WASM is base64-inlined by the `-compat` build, and every material and sound is
generated in code.

## Controls

| | Desktop | Mobile |
|---|---|---|
| Steer | `A` / `D` or `←` / `→` | drag anywhere |
| Restart | `R` | button on the run-end screen |
| Pause | `Esc` or `P` | button |

There is no jump and no brake. You are five tonnes of steel on a hill; the only thing you
control is *where across the ramp you are*, and everything the game asks of you is a
consequence of that one input.

## The one decision

Every object shows its weight, an outline, and a shape badge. All three say the same thing,
so the read survives colourblindness, glare and a phone screen:

| Badge | Outline | Condition | What happens |
|---|---|---|---|
| ● | green | `weight < 0.8 × yours` | Pulverised. You absorb all of it. Chain continues. |
| ▲ | amber | `0.8 × yours ≤ weight < yours` | You plow through. You absorb it, but lose 25 % of your speed. |
| ✕ | red | `weight ≥ yours` | You bounce. **−10 % of your weight and one strike.** |
| ▮ | red, striped | concrete | Never breaks. Touching one **ends the run**. |

Outlines are recomputed **every frame against your current weight**, so the world changes
colour underneath you as you eat. A red silo turns amber and then green while you are still
looking at it — that transition is the whole game, and it is why saturated green, amber and
red appear nowhere else on screen (see *Colour monopoly* below).

Three strikes ends the run. So does a blocker, and so does a hole.

## The ramp

Six zones, each with a weight budget and a material identity:

| Zone | Budget | Material | Objects |
|---|---|---|---|
| RESIDENTIAL | 1,000 kg | glass | bottle crates, panels, greenhouses |
| MARKET | 3,000 kg | wood | crates, fences, market stalls |
| HIGH STREET | 6,000 kg | painted steel | phone booths, vending machines, kiosks |
| TRAFFIC | 15,000 kg | car | sedans, taxis, vans |
| FREIGHT YARD | 40,000 kg | heavy | flatbeds, box trucks, buses |
| INDUSTRIAL | 75,000 kg | structure | sheds, silos, water towers |

A zone's budget is split between **feeders** (small, laid out in lines you sweep) and a
**landmark ladder** — five objects of descending weight, the top one being the thing you
plan the zone around. Between zones the ramp flattens into a crest, the camera lifts, and
the next zone lays itself out below you before you commit to it.

Then 430 m of empty steepening ramp, and the house.

## Reading the track at 40 m/s (§6.1)

The single hardest constraint in this game is not physics, it is **legibility**. Every rule
below is enforced in code, and a validator (`ALL PLAN CONSTRAINTS PASS`) checks all of them
over 40 generated tracks on every change.

- **Colour monopoly.** Saturated green, amber and red belong to the outline system and to
  nothing else. Every prop material is desaturated. Scenery is pushed further down
  (`gfx.decorSaturation` 0.4, `decorBrightness` 0.62). Blockers are striped **white on
  charcoal**, never hazard yellow — yellow reads as amber. The road's shoulder lines and
  its hole chevrons were yellow in v1 and are now white for the same reason.
- **Two visual languages.** Smashables are discrete objects with labels and outlines.
  Scenery is long silhouettes and repeats, never labelled, never outlined, never collidable,
  and never closer than `read.decorClearance` to the lane. The road runs along a low
  embankment so "you cannot drive there" is legible without a single object.
- **A budget, not a scene.** At most 12 objects visible and 5 in the near band at once,
  enforced every frame — the streamer drops the *least valuable* object rather than the
  nearest, and never drops a blocker.
- **Formations, not scatter.** Six named shapes (WALL, PAIR, STAGGER, FUNNEL, SIDE\_FEED,
  GAUNTLET), everything snapped to lane centres, at least 1.2 s of empty ramp between them.
- **Label discipline.** At most 8 weight labels on screen, fading in over 4 s of approach
  and pushed apart vertically when they collide.
- **Four seconds of ramp.** The camera's distance and height come from the roller's radius
  so it fills a constant slice of screen at any size, and its aim is measured in *seconds*
  ahead, not metres.

## Architecture

```
src/
  tuning.js          every balance and feel number in the game, in one object
  core/              math, seeded RNG, pools, fixed-timestep loop
  physics/           Rapier world, roller controller, outcome classification
  render/            WebGPU renderer, camera, road, props, roller, outlines, house, decor
  world/             track profile, object catalogue, formations, track plan, streamer
  fx/                pooled fragments and particles
  audio/             procedural synthesis, layered impacts, adaptive music
  game/              orchestration, score, input, HUD, weight labels
  ui/                start / pause / run-end screens
```

**The track is planned, not streamed.** `world/trackplan.js` builds the entire run up front
— zones, formations, hazards, crests, the house — and then *proves it winnable* with a
weight-gated dynamic program over 97 lateral positions that respects the roller's lateral
speed at each weight and keeps real clearance from every blocker. If the proof fails the
plan is rebuilt with lighter landmarks, up to five times. Across 40 seeds: 0 unwinnable,
worst-case ceiling 129,930 kg against a 100,000 kg house.

**Rendering** uses `three/webgpu` with TSL node materials. `WebGPURenderer` falls back to a
WebGL2 backend automatically, so the game runs on browsers without WebGPU without a separate
code path. Every material is procedural — there is not a single texture or audio file in the
repository.

**The loop** runs physics at a fixed 1/60 s with an accumulator and interpolates rendering
between steps. Hitstop and slow-motion are a single time-scale channel that the accumulator
reads, so "the simulation freezes" is literally true rather than approximated.

**Allocation** is the performance story. Fragments, particles, score popups, audio voices,
prop instances, outline rings and road geometry buffers are all pooled and reused; the
per-frame path allocates nothing.

### Two deliberate deviations from a literal reading of the brief

1. **The roller integrates its own motion; Rapier is the query engine.** The brief asks for
   direct, non-negotiable steering and for *authored* impact responses. A constraint solver
   will fight both. So the roller moves under hand-integrated rules and uses Rapier for what
   it is genuinely best at: robust, cheap raycasts against arbitrary generated geometry.
   Destructibles and blockers are resolved on the CPU against the active object list.

2. **Fragments are a pooled ballistic integrator, not rigid bodies.** They get gravity, drag,
   spin, and bouncing off the road surface, and they fall through holes. What they do not get
   is fragment-vs-fragment contact, which nobody can see at these speeds and which is the
   entire cost.

Both are documented at their call sites.

## Three things the brief's own numbers made impossible

All three were found by arithmetic and simulation, not by taste. Each is documented at the
tuning value that fixes it.

**1. Every object would have been green, forever.** Sizing objects from their material tier
alone, the heaviest thing on the track never exceeds 0.76 × the player's weight at the point
they meet it. The amber and red states — the entire point of the outline system — would
never have fired. Fixed by sizing each zone's landmarks against the weight you would have
*arriving on pace*, so the top rung opens amber and turns green as you feed.

**2. The gold medal was unreachable.** 1.5 × 100,000 = 150,000 kg, and the track holds
140,500 kg including your starting weight. Medals are now bronze 1.0 / silver 1.15 / gold
1.32 — 71 % / 82 % / 94 % absorption, with gold genuinely at the edge.

**3. The game was unwinnable, then bimodal.** Two separate failures, in sequence:

- A perfect line collected 58 % of the placed weight, ceiling 80,503 kg against a 100,000 kg
  house, because you cannot eat four lanes of a WALL in one pass. Weight moved into
  sweepable formations; ceiling rose to 97 % collectable.
- The *sweepable* formations were not actually sweepable. `SIDE_FEED` stepped a full lane
  sideways with 4.6 m of ramp between objects, and `STAGGER` alternated between the two
  outer lanes — 20 m — with 6.5 m of ramp. At 26 m/s those demand 28 m/s and 80 m/s of
  lateral speed against the 15 m/s the roller has. A bot driving *straight at every object
  in turn with perfect knowledge* collected 5 %. The gap between two objects in a sweep is
  now **derived** from how long the lane change takes (`read.sweepComfort`). The same bot
  now collects 140 %.
- Six centrepieces held **73 % of the whole track**, each edible only at ~ideal weight. That
  made the run six pass/fail checks: over 24 seeds a competent line either ate all six and
  finished at ~135 % of the house, or fell behind once and finished at ~33 %. Nine wins,
  fifteen collapses, essentially nothing in between — and a collapse was decided in the
  first ninety seconds with three minutes of ramp still to drive. Replaced with the landmark
  ladder, which spreads a zone's weight across five descending rungs so falling behind costs
  margin instead of the run.

## Tuning

Everything is in [`src/tuning.js`](src/tuning.js). The ratios matter more than the values.
The ones that carry the most weight:

- `collision.cleanRatio` (0.8) — where amber starts. This is the width of the "is it worth
  the speed loss" band, and therefore how often the game asks you anything.
- `weights.landmarkShare` / `landmarkLadder` — how concentrated a zone's weight is. This is
  the difference between a continuous accumulation and six coin flips.
- `read.sweepComfort` (0.55) — what fraction of your lateral speed a sweep may demand.
  Below 1.0 there is slack to drive it imperfectly.
- `read.gauntletEveryFormations` / `gauntletMaxBlockers` — blockers are an instant loss, so
  their density is not a texture knob, it is the odds a run ends before the house.
- `time.hitstopMin/Max` — still the single highest-value effect in the game.
- `player.baseLateralSpeed` / `lateralAccelTime` — steering. 0.12 s to full is the line
  between "responsive" and "twitchy".

## Audio

There are no audio assets. Every sound is rendered offline into `AudioBuffer`s at startup
with `OfflineAudioContext`.

Each impact is 2–4 stacked one-shots — transient, body, a 40–60 Hz sub whose gain scales
with your weight, and a scattered debris tail. Pitch shifts *down* as you get heavier, so
growth is audible before you read the HUD. Absorbing is three simultaneous layers: a pitched
note that climbs with your chain, one to three coin taps sized by the object, and a low till
clunk that only fires when what you ate was a large *share* of what you weigh — so a 5 t
truck sounds enormous at 500 kg and unremarkable at 90 t.

**BLOCKED is deliberately the worst sound in the game.** It has its own bank: nothing above
~250 Hz survives, the whole event is gone in ~60 ms, it does not ring or tail, and it ducks
the music by itself. It is the only feedback for the only mistake that costs a strike, and
it has to cut through six simultaneous shatters.

To swap in real samples, see [`src/audio/README.md`](src/audio/README.md) — the playback
code does not care whether a layer is a procedural buffer or a Howler-backed file.

## Verification

Everything below was measured, not assumed. The simulation is decoupled from rendering, so
most of it runs in Node with no GPU at all.

| Check | Result |
|---|---|
| Winnability proof over 40 seeds | **0 unwinnable**; worst ceiling 124,280 kg vs a 100,000 kg house |
| Placed weight per track | **140,000 kg**, exactly, every seed |
| Visible-object budget | peak **8** against a cap of 12; near band peak **5** against a cap of 5 |
| Minimum formation gap | **2.14 s** against a 1.2 s floor |
| Zones without blockers | **0** (excluding the teaching zone, which has none by design) |
| Competent line, 40 seeds | **27 wins**, mean 99 % of the house, 5 runs lost to a hazard |
| Distribution of runs that reached the house | continuous **84 – 129 %**, no gap, no cluster |
| Skill curve (bot skill 1.0 / 0.85 / 0.7) | **99 % → 85 % → 73 %** of the house |
| Browser smoke test | boots, renders, plays, **zero console errors**, WebGL2 fallback clean |

The bot is a proxy for a competent human, not an optimiser: it looks a few seconds ahead,
commits to a line, and refuses to cross a blocker or a hole. It is deliberately not allowed
to plan the whole track, because a number produced by a solver would not tell us anything
about whether the game is playable. Below skill ~0.6 its results stop being monotone — the
aim noise starts helping it stumble into weight — so only the top of the curve is quoted.

The headless harness runs the real plan, real Rapier road colliders, real player physics and
real collision resolution, with a bot at the wheel. Bugs it found, all fixed:

- Objects sliced into a formation but never consumed were dropped, silently deleting their
  weight from the track.
- The near-band cap of 5 was smaller than the formations being built (8) — at 30 m/s a 2 s
  band covers 60 m, so a short formation is entirely inside it.
- The optimal line threaded 1.33 m corridors past instant-loss blockers. Fine for a solver,
  lethal for a human: gap clearance raised to 4.2 m and the winnability proof now requires
  1.5 m of margin from every blocker.
- The player fell through zone crests, because road colliders used one slope per 40 m
  segment and zone boundaries do not align with segments.
- `zoneAt` reported the *next* zone while you were on a crest, because crests sit between
  zones.
- The roller was invisible for the first thirty seconds: dust puffs were a fixed 1–1.9 m
  against a 1.7 m drum. Dust is now scaled by the drum's radius.
- The **first blocker on the track killed a quarter of competent runs.** Of nine instant
  losses over 40 seeds, five were within 60 m of the first blocker a player had ever seen —
  it appeared mid-way through the second zone at 30 m/s with no prior exposure, and the
  lesson cost the whole run. The first gauntlet now gets an extra lane of corridor and
  arrives after an unusually long empty stretch, alone. Instant losses fell from 10/40 to
  5/40 and the mean run went from 84 % of the house to 99 %.

## Browser support

Chrome/Edge 113+, Firefox 141+ and Safari 26+ get the WebGPU backend. Anything with WebGL2
gets the fallback automatically. Audio starts on the click-to-start screen, which is what
browser autoplay policy requires.

The fallback is checked with a real render, not just adapter detection. A browser that
reports a WebGPU adapter and then throws on its first render pass would otherwise show a
black screen forever. Instead the renderer catches it, swaps the canvas, and continues on
WebGL2.
