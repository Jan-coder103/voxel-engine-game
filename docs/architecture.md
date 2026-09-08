# Architecture

Scope: what exists now (Phase 0–1) plus the boundaries already fixed for
later phases. The full decision log lives in
`MICRO_WORLD_PROGRESS.md` (ADR-001…005); this document explains the
practical consequences for code layout.

## Layering

```text
┌──────────────────────────────────────────────┐
│ index.html / main.ts        DOM + game wiring │
├──────────────────────────────────────────────┤
│ src/render/                 three.js ONLY     │  bootstrap, geometry
├──────────────────────────────────────────────┤
│ src/player/                 pure simulation   │  controller (+ DOM input shim)
├──────────────────────────────────────────────┤
│ src/voxel/                  pure world state  │  coordinates, volume, mesher
└──────────────────────────────────────────────┘
```

Dependency rule (ADR-002): arrows point downward only. `src/voxel/` and the
`controller.ts` half of `src/player/` must stay importable in a node
process with no DOM and no three.js. `input.ts` is a DOM adapter that
produces plain data (`FrameInput`) for the pure controller.

## World model (current)

- `VoxelVolume` — dense `Uint16Array`, cubic, y-major index layout
  (`x + z·size + y·size²`). 0 is air; fresh volumes are all air.
  Bounds policy: `get` throws (programmer error), `getOrAir` treats
  outside as air (world-facing: meshing, collision), `set` returns
  `false` on out-of-bounds.
- Coordinates (`CHUNK_SIZE = 16`): `worldToChunk` uses floor division so
  negative world coordinates land in negative chunks; `worldToLocal`
  always returns `[0, 16)`. Round-trip property is unit-tested.
- Phase 1 world = a single `VoxelVolume` (16³). Phase 2 will introduce
  the chunk map around these same primitives; conversions are already
  chunk-shaped so nothing needs to be renamed.

## Meshing pipeline

`meshVolume(volume) → MeshData` (positions/normals/materialIds/indices as
typed arrays) → `buildVoxelGeometry()` in `src/render/` → one
`THREE.Mesh` per volume. Culling rule: a face is emitted iff the
neighboring cell (via `getOrAir`) is air, which also handles the volume
boundary. The naive mesher is intentionally kept as the correctness
baseline; greedy meshing arrives with Phase 6 and must match it on
visual output.

Winding: quads are CCW from outside (three.js front faces), verified by a
unit test comparing each quad's cross-product normal to its stored normal.

## Player physics

Fixed-timestep (60 Hz) integration in `main.ts` with up to 5 substeps per
frame; `stepPlayer()` is pure per step. Per-axis move-and-resolve in
Y→X→Z order against the voxel grid, player AABB 0.6×1.8, eye at 1.62.
Jump velocity is tuned to clear exactly one voxel (~1.08 m apex). Mouse
deltas become radians in `input.ts` (0.0022 rad/px); pitch clamps to
±90°; yaw is unbounded.

Falling off the world respawns at the demo spawn point — deliberate
Phase 1 behavior until Bedrock-style infinite ground or void rules exist.

## Rendering

`createEngine()` owns the `WebGLRenderer`, scene, camera (YXZ Euler
order), hemisphere + directional lights, resize handling, and the rAF
loop. `WebGPURenderer` is expected to slot in behind this bootstrap
(see roadmap); nothing outside `src/render/` may import three.js.

Materials are currently vertex colors baked from material IDs
(`MeshLambertMaterial`). The `materialId` vertex attribute is emitted
already, so the Phase 4 material shader can replace the color bake
without touching the mesher.

## Testing & benchmarks

- Vitest, node environment: coordinates (round trips, negatives,
  boundaries), volume (index layout, bounds policy), mesher (face
  counts, culling, winding, materials), controller (gravity, landing,
  ledges, jump, walls, sliding, step climbing).
- Benchmarks cover the mesher in solid and worst-case checkerboard
  volumes at 16³ and 32³ — baseline numbers in `docs/performance.md`.

## Deliberate non-goals (for now)

- No chunk system, streaming, or dirty remeshing yet (Phase 2).
- No greedy meshing, palette compression, or workers yet (Phase 6).
- No editor/raycast interaction yet (Phase 5); the interaction raycast
  stub from the Phase 1 checklist lands with editing.
- No persisted state; the demo world is generated deterministically in
  code each launch.
