# Performance

Targets and budgets are defined in `MICRO_WORLD_DEVELOPMENT_PLAN.md`
§2 (mid-range desktop, 2024+). This file tracks how we measure and the
current baselines. Measure, don't guess: `npm run bench`.

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

## Baselines — destruction (`benchmarks/destruction.bench.ts`)

2026-09-09, same machine (worst case: fully-solid stone world, i.e.
every scanned cell is real work):

| Scene                                         | ≈ time/op |
| --------------------------------------------- | --------- |
| explode r=6 in solid stone                    | ~4.5 ms   |
| explode r=10 in solid stone (creator max)     | ~6.6 ms   |
| support check — house-scale region (25×37×25) | ~10 ms    |
| support check — supported terrain region      | ~14 ms    |

Reading: an explosion click costs ~5 ms of damage-field + debris-spec
computation, and the follow-up support check ~10–14 ms — together a
single-frame spike within the 16.6 ms budget, once per edit (not per
frame). The support check originally measured 18.5 ms; the fix was
structural: snapshot the region's solidity with one world query per
cell (the `World` one-slot chunk memo removes most map lookups on the
x-fastest scan), then BFS over the flat buffer with inline index math
and zero per-cell allocations. Regions above 150k cells skip the check
entirely (budgeted, reported as `checked: false`).

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

## Runtime (dev session, Phase 5–8 demo)

- 60 fps (vsync-capped) in the in-app browser at 1280×720 with render
  radius 6: 226 chunk meshes (88 at LOD1), ~8.8–9.1k quads, empty
  stream queue; FPS dips only transiently while the queue drains.
- Edits remesh instantly (dirty chunk within the 3-chunk frame budget;
  a single edit remeshes 1–2 chunks).
- LOD1 switches remesh within the same budget; transitions are not
  perceptible as hitches.
- Explosions/collapses (Phase 8) add a one-frame ~15 ms CPU spike for
  the damage field + support check at house scale; debris/dust then
  cost a fixed, pool-bounded step per frame. Headless verification
  (software WebGL) held ~12–17 fps with 200+ active debris pieces —
  the cap holds the floor; on real hardware the render path is GPU-bound.

## Known gaps in measurement

- No GPU timing yet; fps readouts only.
- No memory profiling; first meaningful when chunks stream (Phase 2).
- Benchmarks run on whatever machine invokes them; treat cross-machine
  comparisons as noise until the planned benchmark serialization
  (Phase 23) exists.
