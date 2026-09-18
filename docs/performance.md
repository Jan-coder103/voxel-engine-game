# Performance

Targets and budgets are defined in `MICRO_WORLD_DEVELOPMENT_PLAN.md`
§2 (mid-range desktop, 2024+). This file tracks how we measure and the
current baselines. Measure, don't guess: `npm run bench`.

> **Machine caveat:** current baselines are measured on a 2-core /
> 4 GB Lubuntu VM (with dev-server + browser sharing those cores during
> verification runs) — treat them as upper bounds; real desktop
> hardware lands comfortably faster. Cross-machine comparisons stay
> noise until the Phase 23 benchmark serialization exists.

## How to benchmark

```sh
npm run bench                 # vitest microbenchmarks (benchmarks/*.bench.ts)
```

In-app: the HUD (`#hud`, top-left) shows fps, quad count, and player
position; visible in every dev session.

## Baselines — meshing (`benchmarks/mesher.bench.ts`)

Measured 2026-09-09, Node 22 (Linux, CI-shaped machine), vitest bench
default settings. Numbers are per-call means; the naive culled mesher is
kept as the correctness baseline, the greedy mesher is production.

| Scene                    | Naive    | Greedy   | Greedy win |
| ------------------------ | -------- | -------- | ---------- |
| solid 16³ (hull only)    | 2.96 ms  | 2.14 ms  | 1.4×       |
| checker 16³ (worst case) | 10.56 ms | 7.06 ms  | 1.5×       |
| layered 16³              | —        | 2.33 ms  | —          |
| solid 32³                | 22.07 ms | 17.29 ms | 1.3×       |
| checker 32³ (worst case) | 99.57 ms | 68.91 ms | 1.4×       |
| terrain chunk 16³        | 3.15 ms  | 2.46 ms  | 1.3×       |

(Phase 2–4 baseline for the naive mesher on the earlier machine: solid
16³ ≈ 1.8 ms, checker 16³ ≈ 10 ms — same magnitude; treat cross-machine
deltas as noise until Phase 23 benchmark serialization exists.)

**Quad counts per terrain chunk (16³, seed 1337)** — the real greedy
payoff is emitted geometry, not build time:

| Meshing path  | Quads |
| ------------- | ----- |
| naive         | 1506  |
| greedy        | 185   |
| greedy + LOD1 | 70    |

In-game the whole radius-6 view dropped from ~82.5k quads (naive) to
~8.8–9.1k quads (greedy + LOD1) at 60 fps.

## Baselines — voxel storage (`benchmarks/storage.bench.ts`)

Same machine/date; 16³ terrain-like volumes. Full discussion in
`docs/voxel-storage.md`.

| Scene                         | Dense    | Packed   |
| ----------------------------- | -------- | -------- |
| fill, terrain-like content    | 0.078 ms | 0.275 ms |
| sequential read ×4096         | 0.061 ms | 0.252 ms |
| random mixed ops ×4096        | 0.061 ms | 0.252 ms |
| memory, typical terrain chunk | 8192 B   | 1536 B   |

Reading: packed reads are ~4× dense (bit extract + palette lookup), but
meshing stays mesh-bound — a greedy mesh through `PackedVolume`
(2.46 ms) beats the naive baseline through dense (3.15 ms).

## Baselines — terrain generation (`benchmarks/terrain.bench.ts`)

2026-09-09, same machine:

| Scene                                | Ops/s   | ≈ time/op |
| ------------------------------------ | ------- | --------- |
| generateChunk (16×16 columns)        | ~1,713  | ~0.58 ms  |
| heightAt × 256 (one chunk footprint) | ~14,329 | ~0.07 ms  |

Generation remains an order of magnitude cheaper than meshing.

## Baselines — town (`benchmarks/town.bench.ts`)

2026-09-11, same machine (load ~2.8):

| Scene                                            | Ops/s    | ≈ time/op           |
| ------------------------------------------------ | -------- | ------------------- |
| applyTown: town-center chunk (roads + buildings) | ~935     | ~0.92 ms (p75 1.07) |
| applyTown: outskirts chunk (roads + wild trees)  | ~1,423   | ~0.64 ms            |
| applyTown: wild chunk (outside the town square)  | ~1,485   | ~0.62 ms            |
| planAt × 256 (one chunk footprint)               | ~44,400  | ~0.02 ms            |
| town census (all lots + viability, one-time)     | ~378     | ~2.5 ms             |
| spawn search from origin                         | ~167,000 | ~0.006 ms           |

The town overlay composes with terrain generation: a fully towned chunk
costs ~1.5 ms end to end (~0.6 ms terrain + ~0.9 ms overlay) against a
16 ms frame, and streaming generates a handful of chunks per second in
steady state. The census runs once at boot for the HUD/debug hook.

## Baselines — structure (`benchmarks/structure.bench.ts`)

2026-09-10, same VM (idle). The gate: one analysis after a house-scale
edit must stay under 5 ms (plan §109) on real terrain, including the
full-height column scan. Note the first implementation measured 9.6 ms
and the fully-solid case 19 ms — the fix was mechanical: the hot passes
now read a precomputed `solid` byte buffer instead of calling through
material helpers (which under vitest's module transform turn imported
constants into namespace lookups), and the snapshot consults each
chunk's edit journal once instead of per cell.

| Scene                                                    | ≈ time/op                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| **GATE** — house-scale analysis, real terrain (25×32×25) | **2.19 ms** mean, p75 1.96 ms                                           |
| worst case — fully solid stone region (every cell BFS)   | 3.02 ms mean, p75 3.00 ms                                               |
| large brush-delete region, real terrain (41×32×41, 54k)  | 4.77 ms mean, p75 4.60 ms                                               |
| overstress analysis — 24-tall wood tower on terrain      | 1.94 ms mean, p75 1.86 ms                                               |
| scenario — knock out a pillar → full cascade to rest     | ≈ 7.5 ms **total** over ~16 ticks (one analysis ≤ ~3 ms per fixed step) |

Reading: the sim runs at most one analysis per fixed step, so even a
multi-stage collapse costs one budgeted slice per tick; the 5 ms gate
holds with headroom on this VM alone. Regions above 150k cells skip
analysis entirely, and single collapses cap at 4096 cells (the cascade
finishes the rest across subsequent ticks).

## Baselines — destruction (`benchmarks/destruction.bench.ts`)

2026-09-09, same machine (worst case: fully-solid stone world, i.e.
every scanned cell is real work):

| Scene                                               | ≈ time/op |
| --------------------------------------------------- | --------- |
| explode r=6 in solid stone                          | ~5.0 ms   |
| explode r=10 in solid stone (creator max)           | ~6.8 ms   |
| support analysis — house-scale region (fully solid) | ~7.5 ms   |
| support analysis — supported region (fully solid)   | ~8.7 ms   |

The last two rows now run the Phase 11 `analyzeStructure` over the
same regions (old checkSupport: ~10/14 ms). They are the pessimistic
variant of the structure baselines above — the fully-solid synthetic
world maximizes BFS work, and the blast-created walls journal their
chunks, so the snapshot pays a journal probe per solid cell. In-game
regions (real terrain, few edited chunks) measure 2–5 ms — see
`benchmarks/structure.bench.ts`. Blast-field costs are unchanged.

Debris/dust stepping is pool-bounded by construction: 512 debris +
1024 dust instances in two InstancedMeshes, updated in ~0.1 ms per
frame regardless of how many explosions fired (ring-buffer recycling;
verified by the 100-event stress test in `tests/debrisPool.test.ts`).

## Baselines — fluid (`benchmarks/fluid.bench.ts`)

The budget question: does one `tick` at the game's activity budget
(384 cells, 60 Hz fixed steps) stay inside a 16 ms frame, including the
worst case — a puddle cascading across a floor?

- **Budgeted tick, 384 active cells**: mean **2.60 ms**, p75 2.51 ms
  (min 1.89 ms; tail samples are GC noise). Inside the frame with room —
  the budget stays at 384.
- **Steady-state churn** (10 ticks of a mid-spread puddle): 4.2 ms per
  10 ticks ≈ **0.42 ms/tick** — real active sets are usually smaller.
- **Full scenario, a source floods a 22×22 basin**: settles completely
  in **≈ 2.7 s** of simulation (one-time; equalization is ±1 per cell
  pair per tick).
- **Terrain lake wake** (3 chunk generations + `onChunkReady` wake +
  one tick): ≈ 3.4 ms — streaming amortizes this.
- **Settled water costs zero**: cells sleep once every neighbor pair is
  within `diff < 2`, so resting lakes and puddles leave the loop idle.
  (An earlier build churned ~10³ cells forever at the streaming
  frontier — a failed unloaded-chunk write still re-activated its
  neighborhood; fixed and regression-tested in `tests/fluid.test.ts`.)

## Baselines — fire (`benchmarks/fire.bench.ts`)

2026-09-10, same machine. The budget question mirrors the fluid sim: one
`tick` at the game's fire budget (256 cells, 60 Hz fixed steps) inside a
16 ms frame, including the expensive case — a fire front spreading into
fresh fuel (heat deposits + ignitions on top of steady burning).

| Scene                                               | ≈ time/op                                        |
| --------------------------------------------------- | ------------------------------------------------ |
| tick — 256 burning slab cells (game budget)         | 1.68 ms mean, p75 1.51 ms                        |
| tick — fire front: slab burning into a grass field  | 1.59 ms mean, p75 1.63 ms                        |
| scenario — 20×20 wood platform burns out completely | ≈ 1.0 s total (~500 ticks ≈ 2 ms/tick amortized) |

Reading: the fire budget stays at 256 — a full-budget tick costs about
as much as the fluid's (fire touches 6 neighbors per burning cell but
heat is only deposited into flammable cells). The burn-out scenario is a
one-time ~1 s of total sim work spread across the fire's whole life; the
5 s of embers/smoke afterward cost a pool-bounded particle step (same
class as debris/dust: 256 embers + 512 smoke instances, capped emission).

## Baselines — NPCs (`benchmarks/npc.bench.ts`)

2026-09-11, same machine. The gates: a typical re-path must be well
under a millisecond (main allows 3 A\* decisions per fixed step), and a
full population tick must be far below the 16 ms frame. Terrain worlds
are 7×7 chunk columns around spawn.

| Scene                                                   | ≈ time/op              |
| ------------------------------------------------------- | ---------------------- |
| GATE — mid-distance re-path on real terrain (~24 cells) | 0.7–1.1 ms mean        |
| worst case — sealed goal (full 512-expansion flood)     | ≈ 5 ms                 |
| nearestWalkable anchor scan (r=6)                       | ≈ 6 µs                 |
| GATE — full population tick (16 wandering NPCs)         | 0.03 ms mean (p99 0.4) |
| sparse population tick (4 NPCs, mostly idle)            | 0.007 ms mean          |

Phase 13 additions (same run):

| Scene                                                      | ≈ time/op               |
| ---------------------------------------------------------- | ----------------------- |
| GATE — population tick with active threats (vision + flee) | 0.12 ms mean (p75 0.02) |
| explosion `notify` (16 NPCs: damage + LOS checks)          | ≈ 2 ms once per blast   |

Reading: the decide budget (3 × 512 expansions) bounds a collapse-burst
tick at ≈ 15 ms worst case, but hopeless searches are rare by
construction — an unreachable target ends in a long idle wait, not a
retry storm — and the common re-path is ~1 ms. The population tick is
noise-level; NPC costs are dominated by A\*, which the budget already
caps. With threats on the board the tick stays two orders under the
frame: vision scans are staggered (one per figure per 10 ticks) and
usually short-circuit on an empty board; the p99 is flee-decision A\*,
same budget as any other decide. The ~2 ms explosion notify is a
per-event one-off (16 LOS raycasts + damage), paid inside the frame
that already carries the blast's own ~5–15 ms of edits/debris. The
sealed-goal bench calls `findPath` at its default 2048-expansion budget
(≈ 20 ms); the sim's decide budget of 512 caps at ≈ 5 ms. Note the VM
caveat below: numbers are comparable between idle runs only.

## Baselines — utilities (`benchmarks/utilities.bench.ts`)

2026-09-11, same machine. The world is the seeded 1337 town
(±96 columns materialized). Each GATE iteration is a cut + mend pair —
two identical component rebuilds — so per-rebuild cost is half the
iteration mean. Rebuilds run only when a utility cell actually changes,
budgeted one per tick (like the structural sim).

| Scene                                                          | ≈ time/op                             |
| -------------------------------------------------------------- | ------------------------------------- |
| GATE — full town-grid rebuild after a cable flip (~5.4k cells) | ≈ 12 ms per rebuild (mean 25 ms/pair) |
| main rebuild after a pipe flip (~100 cells)                    | ≈ 0.17 ms per rebuild                 |
| pour pass (leaks + pressurized tap → `FluidSim.pour`)          | ≈ 0.002 ms per pass                   |
| chunk scan + settle on a fresh town chunk                      | 0.85 ms (generation-dominated)        |
| `pipelineRoute` scan (pure, per lane chunk, early exit)        | 0.08 ms                               |
| `applyTown` with utilities: town-center chunk                  | 1.3 ms (town 0.92 + utilities ~0.4)   |

Reading: the grid rebuild is the one number worth watching. It is
dominated by ~33k component-BFS reads; `makeCachedReader` (a real chunk
cache — the World's one-slot memo thrashes under the flood pattern)
and skipping the supply walk when the component is under capacity took
it from ~30 ms to ~12 ms on this VM. It fires only on utility-cell
edits (user-paced) and once per chunk arrival during boot streaming
(one seed queued per chunk scan; the rebuild consumes the batch), so
steady-state idle cost is zero — the tick early-exits on an empty
queue. The plumbing side is noise: the town main is ~100 cells, and a
pour pass is a handful of `pour` calls. VM caveat applies — treat the
absolute ms as machine-relative; the ratios and budget behavior are
the durable facts.

## Baselines — atmosphere (`benchmarks/atmosphere.bench.ts`)

2026-09-13, dev VM (2–3 cores, loaded; treat absolutes as machine-relative).

| Scene                                            | ≈ time/op     |
| ------------------------------------------------ | ------------- |
| GATE — atmosphere tick (weather + sky + seasons) | 0.025 ms mean |
| `syncTo` fast-forward, full 76.8k-tick year      | 0.010 ms      |
| fire tick, 256 burning cells, clear weather      | 2.67 ms       |
| fire tick, 256 burning cells, storm (rain on)    | 4.45 ms       |

Reading: the atmosphere tick is noise-level and runs every fixed step
(it replaces the old "no-op" in the same slot). The storm fire delta is
the per-cell sky-exposure scans for wetting (~+67%); it stays inside
the frame at the 256-cell budget and only matters while cells are
actively burning in rain. `syncTo`'s segment walk makes clock
fast-forwards (harness, debug) free.

## Baselines — light field (`benchmarks/light.bench.ts`)

2026-09-13, dev VM (2–3 cores, loaded; treat absolutes as
machine-relative). All "settle" numbers are full BFS drains — in game
they run under the 1200-pops/tick budget (~0.5–1 ms per tick) and spread
progressively, exactly like the fluid sim's floods.

| Scene                                                        | ≈ time/op                     |
| ------------------------------------------------------------ | ----------------------------- |
| chunk arrival — town chunk (generate + light init + settle)  | ≈ 13 ms one-time              |
| incremental street edit — place/remove a wall block, settled | ≈ 178 ms per edit (BFS total) |
| lamp fill — 100 open-air sources, settled                    | ≈ 443 ms (≈ 4.4 ms/source)    |
| terrain chunk mesh — no light query (Phase 6 baseline)       | 3.42 ms mean                  |
| terrain chunk mesh — light query + vertex AO                 | 3.67 ms mean (+7%)            |

Reading: the incremental number is the total BFS work of one edit's
removal + re-add cascades (a street-shading wall demotes a whole sky
column plus its lateral boundaries, ~50–100k pops) — budgeted per tick
it costs under a millisecond and the light visibly settles over a second
or two, while the remesh storm rides the existing 3-chunks-per-frame
budget. The lamp fill is the town boot (≈500 street lamps ≈ 2 s
progressive fill-in while chunks stream). The mesher's +7% for light
sampling and AO keeps a 3-chunk remesh frame inside budget.

## Baselines — scenarios (`benchmarks/scenario.bench.ts`)

2026-09-13, dev VM (2–3 cores, load ~2; treat absolutes as
machine-relative). The engine evaluates every fixed step, so its cost
must be noise; these samples run 600 fixed steps each (10 s of game).

| Scene                                                       | ≈ time/600 ticks         |
| ----------------------------------------------------------- | ------------------------ |
| fire scenario, idle objectives + sensors                    | ≈ 39 ms (≈ 0.11 µs/tick) |
| fire scenario, under a 512-event log (event queries active) | ≈ 39 ms (≈ 0.11 µs/tick) |

Reading: the scenario layer itself is free — conditions read cached sim
counters, scratch counters, and (rarely) scan the capped 512-entry
event log. Everything expensive a scenario does (fire spread, flood
pouring, staged collapse) is budgeted inside the sims it stages and is
measured in those sims' own baselines.

## Runtime (dev session, Phase 5–8 demo)

- 60 fps (vsync-capped) in the in-app browser at 1280×720 with render
  radius 6: 226 chunk meshes (88 at LOD1), ~8.8–9.1k quads, empty
  stream queue; FPS dips only transiently while the queue drains.
- Edits remesh instantly (dirty chunk within the 3-chunk frame budget;
  a single edit remeshes 1–2 chunks).
- LOD1 switches remesh within the same budget; transitions are not
  perceptible as hitches.
- Explosions (Phase 8) add a one-frame ~5–7 ms CPU spike for the damage
  field + debris specs; the structural response (Phase 11) is one
  budgeted analysis (~2–3 ms at house scale) per fixed step afterward,
  with staged collapses spread across ticks. Debris/dust/structure-viz
  then cost fixed, pool-bounded steps per frame. Headless verification
  (software WebGL) held ~12–17 fps with 200+ active debris pieces —
  the cap holds the floor; on real hardware the render path is GPU-bound.

## Known gaps in measurement

- No GPU timing yet; fps readouts only.
- No memory profiling; first meaningful when chunks stream (Phase 2).
- Benchmarks run on whatever machine invokes them; treat cross-machine
  comparisons as noise until the planned benchmark serialization
  (Phase 23) exists.

## Baselines — scripting (`benchmarks/script.bench.ts`)

2026-09-18, dev VM (2–3 cores, load ~2; treat absolutes as
machine-relative). The script engine sits next to the scenario tick in
the fixed step and on the bus's `onAny` path, so both costs must be
noise.

| Scene                                             | ≈ time          |
| ------------------------------------------------- | --------------- |
| tick, 1 script / 2 rising-edge condition checks   | ≈ 0.39 µs/tick  |
| event fire, 512-entry log (gate + log + counters) | ≈ 0.49 µs/event |
| tick, timers only, no scripts loaded (early exit) | ≈ 0.05 µs/tick  |

Reading: the scripting layer is free at game scales — a few loaded
scripts cost well under 1 µs per fixed step, and event-trigger dispatch
is sub-µs per bus emission even with the log at its cap. As with
scenarios, the actions themselves (edits, spawns) cost what the systems
they invoke cost.
