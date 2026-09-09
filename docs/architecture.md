# Architecture

Scope: what exists now (Phases 0–8) plus the boundaries already fixed for
later phases. The full decision log lives in
`MICRO_WORLD_PROGRESS.md` (ADR-001…005); this document explains the
practical consequences for code layout.

## Layering

```text
┌──────────────────────────────────────────────┐
│ index.html / main.ts        DOM + game wiring │
├──────────────────────────────────────────────┤
│ src/render/                 three.js ONLY     │  bootstrap, geometry
│ src/audio/                  DOM adapter       │  WebAudio sfx
├──────────────────────────────────────────────┤
│ src/player/                 pure simulation   │  controller (+ DOM input shim)
│ src/persistence/            DOM adapter       │  localStorage store
├──────────────────────────────────────────────┤
│ src/creator/                pure editor core  │  brush, selection, clipboard,
│                                               │  prefab, inspector
│ src/sim/                    pure event bus    │  typed GameEvent routing
│ src/voxel/                  pure world state  │  coordinates, volume, mesher,
│                                               │  damage, support
└──────────────────────────────────────────────┘
```

Dependency rule (ADR-002): arrows point downward only. `src/voxel/`,
`src/creator/`, `src/sim/`, and the `controller.ts` half of `src/player/`
must stay importable in a node process with no DOM and no three.js.
`input.ts`, `src/audio/sfx.ts`, and `src/persistence/` are DOM adapters
that produce/consume plain data.

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

## Creator mode (Phase 7)

Everything in `src/creator/` is pure and produces edit lists; nothing
mutates the world directly. One gesture = one `applyEdits` command, so
undo/redo, journaling, and autosave come free.

- **Brush core** (`brush.ts`): shapes (sphere/box/cylinder/noise — the
  noise variant masks a sphere with `hash3`, the terrain integer hash,
  so scatter is deterministic with no RNG state) × tools
  (place/delete/paint/replace; `explode` routes to the damage module).
  Shape tests use cell centers; bedrock (y ≤ 0) is never touched; a
  caller-supplied `excludes` predicate enforces the player-overlap guard
  for placement.
- **Selection** (`selection.ts`): two clicked corners normalize into an
  inclusive min/max box; `copyRegion` snapshots it into a dense
  `Uint16Array` (same flat layout as `VoxelVolume`). Selections above
  32³ are refused.
- **Clipboard** (`clipboard.ts`): `rotateClipboardY` (90° steps around
  Y, size axes swap on odd quarters), `mirrorClipboardX`, and material
  remapping are pure volume transforms; `pasteEdits` flattens a snapshot
  into an edit list (air skipped by default so pasting never gouges).
- **Prefabs** (`prefab.ts`): versioned v1 JSON with RLE-encoded voxels,
  validated on load (version, size, run integrity, solid count);
  `PrefabLibrary` stores them under `prefab:` keys in any `SaveStore`
  (the store interface gained `keys()` for enumeration).
- **Inspector** (`inspector.ts`): pure lookups for the HUD panel
  (material, coords, hardness from the derived strength table).
- Render side: `CreatorViz` draws the brush ghost (wireframe
  sphere/box/cylinder), the yellow selection wireframe, and the blue
  paste preview box. All state lives in `main.ts`'s creator object.

## Destruction (Phase 8)

The pipeline: tool click → pure damage/support computation → one grouped
`applyEdits` command → pooled render-side debris/dust → typed events →
procedural audio. Believability over accuracy (plan §26/§105).

- **Damage model** (`src/voxel/damage.ts`): `explode` walks the blast
  bounding box; a cell fractures when its distance to the blast center
  is within `radius · (0.35 + 0.65 · (1 − hardness))` — hard stone only
  near the core, soft materials stripped to the edge (`hardnessOf` is a
  derived balance table in `materials.ts`, not a serialized registry
  field). Bedrock is immune; water is untouched (Phase 9's). Debris
  specs are deterministic hash-sampled subsamples with radial impulses
  and a hard cap; `debrisFromCells` does the same for collapses
  (downward tumble). Nothing here mutates the world — callers flow the
  edit list through `applyEdits`.
- **Support check** (`src/voxel/support.ts`): after destructive edits,
  `checkSupport` flood-fills 6-connected solid components over the
  affected region (edit bounds ±`SUPPORT_MARGIN`, from bedrock up) and
  reports cells in components that anchor to neither the bedrock layer
  nor the region's horizontal edge. Two passes for speed: one world
  query per cell into a flat snapshot (the `World` chunk memo makes
  these reads cheap), then a flat-index BFS that allocates nothing per
  cell. Above 150k region cells the check is skipped (`checked: false`).
  The main loop collapses unsupported cells as one undoable `collapse`
  command (debris specs captured before the edit, since they need the
  cells' materials).
- **Event bus** (`src/sim/events.ts`): typed `GameEvent` union
  (`explosion`, `structureCollapsed`), synchronous dispatch, one handler
  throwing doesn't block the rest (ADR-003 — the backbone future
  physics/AI/audio/scripting subscribe through).
- **Debris/dust** (`src/render/debris.ts`, `src/render/dust.ts`): each
  is ONE `THREE.InstancedMesh` with a fixed pool (512 debris, 1024 dust)
  and ring-buffer recycling — destruction can never accumulate objects.
  Debris runs a tiny believable physics step (gravity, world-collision
  bounce, friction, shrink-out); dust is buoyant voxel puffs.
- **Audio** (`src/audio/sfx.ts`): procedural WebAudio (filtered noise
  bursts + a sub thump) — no assets; the context resumes on the first
  pointer-lock gesture, `N` mutes. Every method degrades to a no-op
  without WebAudio.
- Creation/destruction interplay: an explosion or collapse is undoable
  like any edit, and the journal persists it — Ctrl+Z can "un-explode" a
  crater across a reload.

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
  wade on lake beds). The Phase 8 `MATERIAL_HARDNESS` table is a
  derived balance map next to the registry — deliberately not part of
  the serialized schema.

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
  walls, sliding, step climbing), creator (brush shapes/tools/bedrock/
  guards, selection budget, clipboard transform round-trips, prefab
  validation, corrupt-prefab handling), destruction (damage falloff by
  hardness, bedrock/water immunity, determinism, debris caps, support
  fixtures: pillar-roof collapse, boundary anchoring, budget skip,
  event-bus delivery, and the 100-event debris-pool stress test).
- Benchmarks: `benchmarks/mesher.bench.ts` (naive vs greedy, solid/
  checker/layered/terrain), `benchmarks/storage.bench.ts` (dense vs
  packed), `benchmarks/terrain.bench.ts`, `benchmarks/destruction.bench.ts`
  (blast fields, support checks). Baselines in `docs/performance.md`.
- Headless GUI verification: `.verify/run.mjs` (local, gitignored)
  drives the real game in Playwright Chromium through the dev-only
  `__mw` hook — pointer lock, brush strokes, selection/clipboard/
  prefabs, explosion + collapse gate, stress, save/reload.

## Deliberate non-goals (for now)

- No worker-based meshing or transferable buffers yet (Phase 6 deferred
  item) — meshing is 2.5 ms/chunk and the frame budget absorbs it.
- No gizmos/transform tools, terrain sculpt brushes (smooth/flatten/
  raise/lower), or erosion/damage brushes — deferred from the Phase 7
  checklist; first-person clipboard transforms cover the common cases.
- Debris does not re-materialize as voxels (visual only; undo restores).
- No bulk chunk snapshot format — saves stay (seed + edit journal).
- No persisted state beyond localStorage autosave + prefabs; `?seed=`
  starts a fresh world.
