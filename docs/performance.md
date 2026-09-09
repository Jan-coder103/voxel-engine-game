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

| Scene                    | Naive      | Greedy     | Greedy win |
| ------------------------ | ---------- | ---------- | ---------- |
| solid 16³ (hull only)    | 2.96 ms    | 2.14 ms    | 1.4×       |
| checker 16³ (worst case) | 10.56 ms   | 7.06 ms    | 1.5×       |
| layered 16³              | —          | 2.33 ms    | —          |
| solid 32³                | 22.07 ms   | 17.29 ms   | 1.3×       |
| checker 32³ (worst case) | 99.57 ms   | 68.91 ms   | 1.4×       |
| terrain chunk 16³        | 3.15 ms    | 2.46 ms    | 1.3×       |

(Phase 2–4 baseline for the naive mesher on the earlier machine: solid
16³ ≈ 1.8 ms, checker 16³ ≈ 10 ms — same magnitude; treat cross-machine
deltas as noise until Phase 23 benchmark serialization exists.)

**Quad counts per terrain chunk (16³, seed 1337)** — the real greedy
payoff is emitted geometry, not build time:

| Meshing path     | Quads |
| ---------------- | ----- |
| naive            | 1506  |
| greedy           | 185   |
| greedy + LOD1    | 70    |

In-game the whole radius-6 view dropped from ~82.5k quads (naive) to
~8.8–9.1k quads (greedy + LOD1) at 60 fps.

## Baselines — voxel storage (`benchmarks/storage.bench.ts`)

Same machine/date; 16³ terrain-like volumes. Full discussion in
`docs/voxel-storage.md`.

| Scene                          | Dense   | Packed  |
| ------------------------------ | ------- | ------- |
| fill, terrain-like content     | 0.078 ms| 0.275 ms|
| sequential read ×4096          | 0.061 ms| 0.252 ms|
| random mixed ops ×4096         | 0.061 ms| 0.252 ms|
| memory, typical terrain chunk  | 8192 B  | 1536 B  |

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

## Runtime (dev session, Phase 5–6 demo)

- 60 fps (vsync-capped) in the in-app browser at 1280×720 with render
  radius 6: 226 chunk meshes (88 at LOD1), ~8.8–9.1k quads, empty
  stream queue; FPS dips only transiently while the queue drains.
- Edits remesh instantly (dirty chunk within the 3-chunk frame budget;
  a single edit remeshes 1–2 chunks).
- LOD1 switches remesh within the same budget; transitions are not
  perceptible as hitches.

## Known gaps in measurement

- No GPU timing yet; fps readouts only.
- No memory profiling; first meaningful when chunks stream (Phase 2).
- Benchmarks run on whatever machine invokes them; treat cross-machine
  comparisons as noise until the planned benchmark serialization
  (Phase 23) exists.
