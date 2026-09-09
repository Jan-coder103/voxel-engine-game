# Architecture

Scope: what exists now (Phases 0–6) plus the boundaries already fixed for
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

- `VoxelData` is the storage-agnostic surface (`size`, `get`/`getOrAir`/
  `set`, flat-index access, `fill`). Two implementations: `VoxelVolume`
  (dense `Uint16Array`, the correctness baseline) and `PackedVolume`
  (palette compression + occupancy bitset, production chunk storage —
  see `docs/voxel-storage.md`). 0 is air; fresh volumes are all air.
  Bounds policy: `get` throws (programmer error), `getOrAir` treats
  outside as air (world-facing: meshing, collision), `set` returns
  `false` on out-of-bounds.
- Coordinates (`CHUNK_SIZE = 16`, `WORLD_HEIGHT = 32` = 2 vertical chunk
  layers): `worldToChunk` uses floor division so negative world
  coordinates land in negative chunks; `worldToLocal` always returns
  `[0, 16)`. Round-trip property is unit-tested.
- `Chunk` wraps one 16³ `PackedVolume` with `coord`, `origin`, and a
  `dirty` flag (data changed since last mesh).
- `World` is the chunk map: `ensureChunk` generates once, replays any
  journaled edits, and marks existing neighbors dirty (their boundary
  faces were built against air); `setVoxel` marks the owning chunk plus
  any boundary neighbors dirty and journals the edit; `pruneBeyond`
  drops data by XZ distance. Reads in unloaded chunks are air; writes
  to unloaded chunks fail.
- **Edit journal**: `setVoxel` records (local voxel index → material)
  per chunk. On regeneration the journal replays over the generator, so
  player edits survive chunk unload/prune deterministically. The
  journal is the persistence unit (`exportEdits`/`loadEdits`).

## Editing and persistence (Phase 5)

- `raycastVoxels` (pure DDA, Amanatides & Woo): walks the grid from a
  ray, reports the hit voxel, entry-face normal, and distance. The
  starting-cell hit has a zero normal (no entered face); editing skips
  placement there. Water is not targetable.
- `applyEdits` groups cell changes into one `EditCommand` (target
  values + captured previous values, no-ops and failed cells skipped);
  `EditHistory` is the standard undo/redo stack pair capped at 128
  commands — pushing clears the redo branch. All world mutation goes
  through these, so remeshing, journaling, and autosave stay consistent.
- `src/voxel/persistence.ts`: the save unit is (schema version, seed,
  terrain params, material-table snapshot, edit journal). Saves are
  small because terrain regenerates from the seed. `migrateWorld` walks
  payloads forward through a per-version migrator chain and rejects
  unknown/newer versions; the embedded material table is validated
  against the live registry on load. `SaveStore` abstracts storage
  (memory + localStorage backends); `AutosavePolicy` is a pure
  dirty-gated interval timer.
- Boot: an autosave restores unless `?seed=` names a different world;
  the tab hides → immediate save (crash-recovery window).

## Chunk meshing and streaming

- Production meshing is `meshVolumeGreedy`: the 0fps per-axis sweep —
  a face mask per slice boundary (same emission rules as the naive
  baseline: opaque emits against non-opaque, water only against air,
  and only in-volume cells may emit), greedily merged into maximal
  same-material rectangles. Unit-tested equivalent to `meshVolume`
  (naive, kept as baseline) by comparing the full unit-face multiset on
  random volumes, terrain chunks, and cross-chunk worlds; winding is
  checked per quad.
- LOD: `downsampleVolume` builds a half-resolution volume per chunk
  (majority material per 2³ block, **air wins ties** so LOD1 never
  inflates surfaces); the mesh is built with the same greedy mesher and
  scaled 2× at geometry level. `desiredLod` picks the level from XZ
  chunk distance with a hysteresis band (switch away past 4.5, back
  inside 3.5) so boundary chunks cannot flicker.
- `ChunkMeshManager` (render side) owns one mesh per chunk pass:
  desired set from pure streaming math (`desiredChunkCoords`, circular
  XZ radius, all Y layers), nearest-first queue with a camera-direction
  tie-break, a per-frame mesh budget (dirty remeshes → LOD switches →
  new chunks), and geometry disposal one ring outside the render radius
  (data is pruned two rings out).

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

`meshVolumeGreedy(volume) → ChunkMesh` (positions/normals/materialIds/
indices as typed arrays) → `buildVoxelGeometry()` in `src/render/` → one
`THREE.Mesh` per volume (or per pass). The naive `meshVolume` is
intentionally kept as the correctness baseline; the greedy mesher must
match it on the unit-face multiset, and equivalence tests pin that for
random volumes, terrain chunks, and cross-chunk worlds.

Winding: quads are CCW from outside (three.js front faces), verified by
a unit test comparing each quad's cross-product normal to its stored
normal — for the greedy mesher on random mixed volumes, both facings.

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
registered material), per-voxel brightness variation is derived in the
fragment shader from the world position (`floor(worldPos − normal/2)`
recovers the voxel cell — correct on greedy quads where a per-vertex
origin attribute would smear), and fog blends to the sky color at the
render edge. Water adds transparency, double-sided rendering, and no
depth write so lake beds stay visible.

## Testing & benchmarks

- Vitest, node environment: coordinates (round trips, negatives,
  boundaries), volumes (dense + packed, index layout, bounds policy,
  palette growth, randomized dense-vs-packed equivalence), raycast
  (traversal, negatives, predicates), edits (command invariants, undo/
  redo, journal round-trips), persistence (save round-trips, migration
  and validation errors, autosave timing), mesher (face counts, culling,
  winding, materials, greedy↔naive equivalence), LOD (hysteresis,
  conservative downsample), controller (gravity, landing, ledges, jump,
  walls, sliding, step climbing).
- Benchmarks: `benchmarks/mesher.bench.ts` (naive vs greedy, solid/
  checker/layered/terrain), `benchmarks/storage.bench.ts` (dense vs
  packed), `benchmarks/terrain.bench.ts`. Baselines in
  `docs/performance.md`.

## Deliberate non-goals (for now)

- No worker-based meshing or transferable buffers yet (Phase 6 deferred
  item) — meshing is 2.5 ms/chunk and the frame budget absorbs it.
- No brush/selection tooling yet (Phase 7 creator mode); editing is
  single-voxel place/remove/paint/pick.
- World state persists via the edit journal + seed; there is no bulk
  chunk snapshot format yet (not needed while saves journal deltas).
- No persisted state beyond localStorage autosave; `?seed=` URL
  parameter starts a fresh world.
