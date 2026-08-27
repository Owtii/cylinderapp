# TONNAGE

You are a five-tonne steel cylinder rolling down an endless hill. Everything in front
of you either explodes into debris or stops you dead, depending on whether you outweigh
it. Pick up weight and things that used to stop you start to disintegrate.

The whole game is one feeling: **the crunch of hitting something at speed.** Every
decision in this codebase is in service of that.

```
npm install
npm run dev        # http://localhost:5173
npm run build && npm run preview
```

## Controls

| | Desktop | Mobile |
|---|---|---|
| Steer | `A` / `D` or `←` / `→` | drag anywhere |
| Tuck | `Space` | tap |
| Restart | `R` | button on the run-end screen |
| Pause | `Esc` or `P` | button |

**Tuck** narrows the roller and adds downhill push for a moment — it is how you thread a
gap that is otherwise too tight. Two-second cooldown.

## The three outcomes

Every destructible carries a `mass_threshold`. On contact it is compared with your mass:

| | Condition | What happens |
|---|---|---|
| **PULVERIZE** | `mass > threshold × 1.5` | Shatters instantly. You lose 3 % speed. Maximum everything. |
| **PLOW** | `threshold < mass ≤ threshold × 1.5` | Breaks, but resists. You lose 20 % speed. |
| **BLOCKED** | `mass ≤ threshold` | You rebound, lose 15 % of your mass, and rebuild. |

A block is a setback, never a game over. **Holes are the only hard fail.**

| Object | Threshold | Comes apart as |
|---|---|---|
| Glass panel | 200 kg | many small shards |
| Fruit stall / crates | 800 kg | splinters and pulp |
| Fence / signpost | 1 200 kg | a few bent pieces |
| Parked sedan | 4 000 kg | crumpled body, windows separately |
| SUV / van | 9 000 kg | heavier, flips |
| Bus | 25 000 kg | buckles in the middle |
| Water tower | 40 000 kg | collapses, water burst |
| Concrete barrier | ∞ | never |
| Bedrock pillar | ∞ | never |

You start at 5 000 kg, which pulverizes glass, crates and fences, *plows* a sedan, and is
stopped cold by an SUV. Growth is what changes that.

## Architecture

```
src/
  tuning.js          every balance and feel number in the game, in one object
  core/              math, seeded RNG, pools, fixed-timestep loop
  physics/           Rapier world, roller controller, outcome classification
  render/            WebGPU renderer, chase camera, road, props, roller, trail, post FX
  world/             track profile, object table, chunk templates, streaming generator
  fx/                pooled fragments and particles
  audio/             procedural synthesis, layered impacts, adaptive music
  game/              orchestration, score, input, HUD
  ui/                start / pause / run-end screens
```

**Rendering** uses `three/webgpu` with TSL node materials. `WebGPURenderer` falls back to
a WebGL2 backend automatically, so the game runs on browsers without WebGPU without a
separate code path. Every material is procedural — there is not a single texture or audio
file in the repository.

**The loop** runs physics at a fixed 1/60 s with an accumulator and interpolates rendering
between steps. Hitstop and slow-motion are a single time-scale channel that the accumulator
reads, so "the simulation freezes" is literally true rather than approximated.

**Allocation** is the performance story. Fragments, particles, score popups, audio voices,
chunk records, prop instances and road geometry buffers are all pooled and reused; the
per-frame path allocates nothing. A chunk spawns roughly every two seconds at speed, and
rebuilding a megabyte of typed arrays on that cadence is exactly the kind of thing that
shows up as a stutter, so it doesn't happen.

### Two deliberate deviations from a literal reading of the brief

1. **The roller integrates its own motion; Rapier is the query engine.** The brief asks for
   direct, non-negotiable steering and for *authored* impact responses — a PULVERIZE that
   costs exactly 3 % of your speed. A constraint solver will fight both of those, and
   "fighting the simulation" is the specific failure the brief warns against. So the roller
   moves under hand-integrated rules and uses Rapier for what it is genuinely best at:
   robust, cheap raycasts against arbitrary generated geometry (road, ramps, hole edges).
   Destructibles and blockers are resolved on the CPU against the active prop list.

2. **Fragments are a pooled ballistic integrator, not rigid bodies.** They get gravity,
   drag, spin, and bouncing off the road surface, and they fall through holes. What they do
   not get is fragment-vs-fragment contact, which nobody can see at these speeds and which
   is the entire cost. This is what makes "30+ objects destroyed simultaneously at 60fps"
   comfortable rather than marginal.

Both are documented at their call sites.

## Tuning

Everything is in [`src/tuning.js`](src/tuning.js). The ratios matter more than the values.
A few that carry the most weight:

- `collision.pulverizeRatio` (1.5) — how much margin you need before an object stops
  resisting. Raising it makes growth feel slower and every threshold more meaningful.
- `time.hitstopMin/Max` (40–90 ms) — the single highest-value effect in the game.
- `player.baseLateralSpeed` / `lateralAccelTime` — steering. 0.12 s to full is the line
  between "responsive" and "twitchy".
- `mass.blockedMassLoss` (0.15) — how much a mistake costs.
- `gen.difficultyRampDistance` — how fast the hill gets mean.

## Audio

There are no audio assets. Every sound is rendered offline into `AudioBuffer`s at startup
with `OfflineAudioContext`: filtered noise bursts with fast decay envelopes, resonant modal
partials for glass and metal, and sine subs.

Each impact is 2–4 stacked one-shots — transient, body, a 40–60 Hz sub whose gain scales
with your mass, and a scattered debris tail — drawn from several variants per layer, with
pitch and gain randomised and never the same variant twice in a row. Pitch shifts *down* as
you get heavier, so growth is audible before you read the HUD.

To swap in real samples, see [`src/audio/README.md`](src/audio/README.md) — the playback
code does not care whether a layer is a procedural buffer or a Howler-backed file.

## Verification

Everything below was measured, not assumed. The simulation is decoupled from rendering,
so most of it can be exercised in Node with no GPU at all.

| Check | Result |
|---|---|
| Fixed-step simulation cost | **0.09–0.17 ms/step** — under 1 % of a 60 fps frame |
| 40 objects destroyed in one frame | 19 ms for the impacts, then **0.6 ms/frame** of debris |
| Fragment budget | capped at exactly **250**, oldest evicted first |
| Restart to playable | **1.7–4.8 ms** (spec asks for under 200 ms) |
| Allocations in per-frame paths | **none** (static audit over every `update`/`step`/`render`) |
| Impact-sound banks | 8 materials × 3 layers × 5 variants, all non-silent, none clipping |
| Chunk passability | **0 %** impassable across 6 types × 3 roller sizes × 3 difficulties |
| Rhythm rule | 0 consecutive high-tension chunks over 3 600 generated chunks |

A headless playthrough (real generator, real Rapier colliders, real collision resolution,
a corridor-planning bot at the wheel) found five bugs worth naming, all fixed:

- The roller fell through the hill on frame one, because Rapier only refreshes its raycast
  structures inside `world.step()` and nothing had stepped yet.
- The hill was built climbing away from the player: the slab rotation and the surface
  normal disagreed about which way "downhill" was.
- Ramps never launched anything. Two reasons — the launch velocity was read from a variable
  that had already been overwritten with itself, so it was structurally always zero; and
  ramp height was measured against the road at the ramp's *end*, which on a 12° hill is
  below where the roller got on.
- A blocker billed the player 15 % of their mass every time the per-object cooldown
  expired while they were still touching it, draining a run to the mass floor and pinning
  it there forever. One approach now costs exactly one block.
- A third of gauntlets and 15 % of chasms narrowed to a single 4 m lane at full difficulty,
  which a 20-tonne roller physically cannot fit through. Gaps now have a floor, the roller
  has a size cap, and a passability pass over every generated chunk guarantees a corridor
  through anything the player cannot break.

## Browser support

Chrome/Edge 113+, Firefox 141+ and Safari 26+ get the WebGPU backend. Anything with WebGL2
gets the fallback automatically. Audio starts on the click-to-start screen, which is what
browser autoplay policy requires.

The fallback is checked with a real render, not just adapter detection. A browser that
reports a WebGPU adapter and then throws on its first render pass — an older Dawn against a
newer three.js, which is exactly what this was developed against — would otherwise show a
black screen forever. Instead the renderer catches it, swaps the canvas, and continues on
WebGL2.
