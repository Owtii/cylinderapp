# TONNAGE audio

Everything you hear is synthesised at runtime. There are **no audio asset files** —
`init()` renders ~33 sample banks with `OfflineAudioContext` (about 90 s of audio,
roughly 1–2 s of loading behind the progress bar) and the game sounds finished with
an empty `/audio` directory. `registerSamples()` exists so real recordings can
replace any of those banks later without touching a line of game code.

```js
import { audio } from './audio/index.js';

await audio.init(t01 => screens.setLoadProgress(t01));  // from a user gesture
audio.update(dt, state);                                 // every frame, unscaled dt
audio.playImpact('glass', 'PULVERIZE', 200, mass, pan, 1);
```

## Swapping in real samples

Call `registerSamples(manifest)` at any time — before or after `init()`. Keys that
appear in the manifest switch to the file backend; every other key keeps its
procedural bank, so a partial manifest is normal and expected.

```js
audio.registerSamples({
  'impact.glass.transient': ['/audio/glass_t1.webm', '/audio/glass_t2.webm'],
  'impact.glass.body':      ['/audio/glass_b1.webm'],
  'combo.ding':             '/audio/ding.webm',   // a bare string is fine
  'loop.rolling':           '/audio/rumble_loop.webm',
});
```

Each URL in the array is one **variant**. Playback picks a variant at random and
never picks the same one twice in a row, so give it 3–5 of anything that fires
often. Files load through Howler (`pool: TUNING.audio.howlPoolSize`) and Howler is
`import()`ed lazily — it is never loaded at all if you never call this.

## Manifest keys

| Key | What it is |
| --- | --- |
| `impact.<material>.transient` | the contact, 0 ms, very short |
| `impact.<material>.body` | the material's voice, plays 15 ms later |
| `impact.<material>.debris` | one grain cluster; several are scattered over `debrisTailWindow`. Each procedural variant already holds 3–6 grains, so one impact can fire twenty-plus individual hits — keep replacement files short and sparse or the tail smears |
| `impact.sub` | 40–60 Hz sine layer under every hit |
| `combo.ding` | the pentatonic reward |
| `pickup.chime` | mass pickup |
| `jump.whoosh` | ramp launch |
| `land.thud` | landing |
| `ui.click`, `ui.hover`, `ui.start`, `ui.gameover` | interface |
| `loop.rolling`, `loop.wind` | continuous layers (see below) |

`<material>` is one of the shared material keys:
`glass`, `wood`, `metal`, `car`, `heavy`, `concrete`, `water`, `dirt` —
so `impact.heavy.body`, `impact.concrete.transient`, and so on. That is
8 materials × 3 layers + 9 singles = **33 keys**. `audio.sampleKeys` returns the
full list at runtime.

### Reference pitches

Playback rate is used for pitch, so a replacement must be recorded at the pitch the
engine assumes, or everything will be transposed:

- `impact.sub` — fundamental at **55 Hz**. It is played back between 40 and 60 Hz
  depending on player mass (heavier = lower).
- `combo.ding` — root at **C5, 523.25 Hz** (`TUNING.audio.comboRootHz`). The ladder
  transposes up the pentatonic scale from there.
- `impact.*` and `land.thud` — record at the pitch of a "5-tonne hit". They are
  pitched down as the player grows, by `(startMass/mass)^massPitchExp`.

Keep replacements roughly peak-normalised to the same level as each other. The
procedural banks are normalised to a designed peak per layer (transient ≈ 0.9,
body ≈ 0.85, debris ≈ 0.55, quieter for `concrete` and `dirt`, louder for `heavy`),
and the mix gains in `TUNING.audio` assume that.

### Loops are different

`loop.rolling` and `loop.wind` do **not** go through Howler. They need to be
sample-accurate seamless loops, so they are fetched and `decodeAudioData`'d
directly, and the rolling layer is rebuilt around the new buffer. Supply a file
that loops cleanly with no fade at either end — anything else will tick once per
loop. `loop.rolling` should be mono broadband noise-like material; `loop.wind`
should be stereo.

## What you give up with the Howler backend

Howler owns its own `AudioContext`, so file-backed sounds do not pass through this
module's bus graph:

- They bypass the master limiter and the SFX bus, so they are not glued into big
  hits with everything else. Bus and master volume are mirrored onto each
  instance's volume instead.
- They are not part of the voice pool, so they do not participate in
  quietest-voice stealing and do not count toward `TUNING.audio.maxVoices`.
- Scheduling is approximate. Procedural debris tails are scheduled on the audio
  clock (`start(when)`); Howler-backed ones fall back to `setTimeout`.

None of that matters for a handful of hero sounds. If you end up replacing most of
the banks, decode the files into `AudioBuffer`s and hand them to
`bank.setBuffers(key, buffers)` instead — that keeps everything inside the graph.

## Tuning

Every balance number lives in `TUNING.audio` (`src/tuning.js`). The ones worth
knowing:

- `maxVoices` — voice cap. At the cap the **quietest** live voice is stolen, and a
  new sound quieter than everything already playing is dropped rather than
  stealing.
- `impactWindow` / `impactCrowdExp` / `maxLayerVoices` — how simultaneous impacts
  collapse into a single event.
- `subRetrigger` / `subSwellExp` / `subSwellMax` — there is only ever one live sub
  voice; hits inside `subRetrigger` swell its gain instead of stacking. This is
  what makes a 30-object pulverize land as one enormous thump.
- `densityTau` / `densityDebrisCut` — thins debris tails when a lot is happening.
- `rollingMassGain`, `rollingRateExp`, `droneHarmonic` — how loudly mass reads in
  the continuous layers.
- `musicLayerThresholds` — the combo intensity at which bass / arp / pad gate in.
