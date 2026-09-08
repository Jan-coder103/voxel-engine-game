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

## Baselines — naive face mesher (`benchmarks/mesher.bench.ts`)

Measured 2026-09-08, Node 22 (Linux, CI-shaped machine), vitest bench
default settings. Numbers are per-`meshVolume` call:

| Scene                    | Ops/s | ≈ time/op |
| ------------------------ | ----- | --------- |
| solid 16³ (hull only)    | ~553  | ~1.8 ms   |
| checker 16³ (worst case) | ~100  | ~10 ms    |
| solid 32³                | ~80   | ~12.5 ms  |
| checker 32³ (worst case) | ~10.5 | ~95 ms    |

Reading: cost scales with emitted faces, not volume size — a fully
buried voxel is nearly free. The checkerboard worst case emits a quad
for nearly every solid voxel face and is the number to beat when the
greedy mesher lands (Phase 6). The Phase 1 demo world (16³, 828 quads)
meshes in well under 5 ms, so interactive remeshing is not yet a
concern.

## Baselines — terrain generation (`benchmarks/terrain.bench.ts`)

Same machine/date as the mesher numbers:

| Scene                                | Ops/s   | ≈ time/op |
| ------------------------------------ | ------- | --------- |
| generateChunk (16×16 columns)        | ~2,333  | ~0.43 ms  |
| heightAt × 256 (one chunk footprint) | ~14,542 | ~0.07 ms  |

Generation is an order of magnitude cheaper than meshing — the
streaming budget (3 chunk meshes per frame) is mesh-bound, which is
where Phase 6 optimization effort should go.

## Runtime (dev session, Phases 2–4 demo)

- 60 fps (vsync-capped) in the in-app browser at 1280×720 with render
  radius 6: 226 chunk meshes, ~80–83k quads, empty stream queue.
- Streaming keeps up with walking; the mesh queue drains to 0 within a
  couple of seconds of fast movement.

## Known gaps in measurement

- No GPU timing yet; fps readouts only.
- No memory profiling; first meaningful when chunks stream (Phase 2).
- Benchmarks run on whatever machine invokes them; treat cross-machine
  comparisons as noise until the planned benchmark serialization
  (Phase 23) exists.
