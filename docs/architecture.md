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

## World model

- `VoxelVolume` — dense `Uint16Array`, cubic, y-major index layout
  (`x + z·size + y·size²`). 0 is air; fresh volumes are all air.
  Bounds policy: `get` throws (programmer error), `getOrAir` treats
  outside as air (world-facing: meshing, collision), `set` returns
  `false` on out-of-bounds.
- Coordinates (`CHUNK_SIZE = 16`, `WORLD_HEIGHT = 32` = 2 vertical chunk
  layers): `worldToChunk` uses floor division so negative world
  coordinates land in negative chunks; `worldToLocal` always returns
  `[0, 16)`. Round-trip property is unit-tested.
- `Chunk` wraps one 16³ volume with `coord`, `origin`, and a `dirty`
  flag (data changed since last mesh).
- `World` is the chunk map: `ensureChunk` generates once and marks
  existing neighbors dirty (their boundary faces were built against
  air), `setVoxel` marks the owning chunk plus any boundary neighbors
  dirty, `pruneBeyond` drops data by XZ distance. Reads in unloaded
  chunks are air; writes to unloaded chunks fail.

## Chunk meshing and streaming

- `meshVolume(volume, query)` culls against a voxel query that may leave
  `[0, size)`; chunk meshing passes one routed through `World`, so faces
  across chunk borders cull correctly. Emission rules by material class:
  opaque faces emit against non-opaque neighbors (air or water); water
  emits only against air. Output splits into opaque/water `MeshData`
  passes with per-vertex `voxelOrigins` for shader variation.
- `ChunkMeshManager` (render side) owns one mesh per chunk pass:
  desired set from pure streaming math (`desiredChunkCoords`, circular
  XZ radius, all Y layers), nearest-first queue with a camera-direction
  tie-break, a per-frame mesh budget, dirty remeshes before new chunks,
  and geometry disposal one ring outside the render radius (data is
  pruned two rings out).

## Terrain generation

- Determinism contract: generation is a pure function of
  (seed, chunk coordinate). No sequential RNG state — an integer hash
  feeds quintic-fade value noise, fBm combines octaves, and a
  low-frequency mountain mask amplifies hill heights. Unit tests pin
  byte-identical chunk generation and neighbor-order independence.
- Column profile: bedrock stone at y=0, stone core, 3-voxel dirt band,
  grass surface; columns at/below sea level are sand-capped and filled
  with water up to (not including) sea level.
- `findSpawn` scans outward ring-by-ring for the first dry column.

## Materials

- `materials.ts` is the single registry: id (stable serialization
  contract — 0 is always air), name, sRGB color, `opaque` (culling) and
  `solid` (collision) classification, lookup by id/name, and versioned
  JSON serialization that validates against the live table on load.
  Water is non-opaque and non-solid (swimming is a placeholder; players
  wade on lake beds).

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
order), resize handling, and the rAF loop. The voxel shader computes its
own lighting and fog, so the scene has no lights and no scene.fog;
`WebGPURenderer` is expected to slot in behind this bootstrap later.

`createVoxelMaterials()` builds the shader pair (opaque + water):
`materialId` attributes index a palette `DataTexture` (one texel per
registered material, regenerated only if the registry changes shape),
`voxelOrigin` attributes hash into a subtle per-voxel brightness
variation, and fog blends to the sky color at the render edge. Water
adds transparency, double-sided rendering, and no depth write so lake
beds stay visible.

## Testing & benchmarks

- Vitest, node environment: coordinates (round trips, negatives,
  boundaries), volume (index layout, bounds policy), mesher (face
  counts, culling, winding, materials), controller (gravity, landing,
  ledges, jump, walls, sliding, step climbing).
- Benchmarks cover the mesher in solid and worst-case checkerboard
  volumes at 16³ and 32³ — baseline numbers in `docs/performance.md`.

## Deliberate non-goals (for now)

- No greedy meshing, palette compression, or workers yet (Phase 6) —
  the naive mesher is the correctness baseline those must match.
- No editing/raycast interaction yet (Phase 5); the interaction raycast
  stub from the Phase 1 checklist lands with editing.
- No persisted state; the world regenerates from the seed (`?seed=` URL
  parameter overrides the default).
