# Changelog

All notable changes to MICRO//WORLD are documented here.
Format loosely follows Keep a Changelog; versioning is informal until
the first external release.

## [0.9.0] — 2026-09-10 — Phase 11 (Structural Simulation)

### Added

- Structural simulation (`src/voxel/structure.ts`), replacing the
  Phase 8 edit-time support approximation with a ticked, budgeted
  `StructuralSim` over a graph of solid cells:
  - **Support graph**: 6-neighbor adjacency where vertical connections
    always transmit support and horizontal ones only within
    `MAX_CANTILEVER` (6) groundless hops — a 0/1-cost BFS from bedrock
    and region-edge anchors. Floors hold from walls, plank bridges
    stand within ~6 of a shore, overhangs past the limit drop only
    their far half, and a roof whose last pillar is gone falls entirely
    (the Phase 11 gate: destroy ground floor → upper floors detach and
    collapse).
  - **Simplified stress + failure thresholds**: vertical stack load
    (one mass unit per solid cell above) vs a derived
    `MATERIAL_STRENGTH` table (wood 22, stone 26, dirt 16, sand 10,
    grass 14). Only journaled (built/edited) cells can fracture, so
    natural terrain never avalanches, while load counts all overlying
    mass — a wood post propping up a stone overhang still fails.
  - **Progressive collapse**: failing cells become air as one grouped
    undoable `collapse` command (debris/dust/sound/`structureCollapsed`
    as before); the edits re-queue the region, so staged failures
    cascade across ticks, bounded by `MAX_COLLAPSE_CELLS` (4096) and
    the 150k-cell scan budget.
- **Fire → collapse coupling** (the deferred Phase 10 item): the
  structural sim chains onto the World change hook, and burn-out is a
  real `setVoxel(AIR)` write — a burned-through pillar drops its roof
  with no special-case code. The hook now also carries the cell's
  previous material so only support-losing transitions queue analyses
  (placements and water flow never trigger; building stays free).
- **Structural debug overlay** (`src/render/structureViz.ts`, toggled
  with **G**): flashes failed cells for ~1.6 s — red for lost support,
  orange for stress fractures. HUD shows `· struct qN` while regions
  are pending.
- `benchmarks/structure.bench.ts`: house-scale gate analysis **2.2 ms**
  mean on real terrain (plan budget < 5 ms), worst-case fully-solid
  region 3.2 ms, 54k-cell brush region 4.8 ms, full collapse cascade
  ≈ 7 ms spread over 16 ticks. Baselines in `docs/performance.md`.

### Changed

- `World.onVoxelChanged` gains a `previous` material argument (fluid and
  fire wrappers forward it; behavior unchanged for them).
- `World` exposes `isEdited(x, y, z)` / `journalFor(key)` — the edit
  journal doubles as the "player-built vs natural terrain" signal for
  the stress model.
- `src/voxel/support.ts` is gone (`checkSupport`/`supportRegionFor`
  replaced by `analyzeStructure`/`structureRegionFor` in
  `src/voxel/structure.ts`); regions always scan the full world height
  (cut-off tops previously undercounted loads).

### Tests

- `tests/structure.test.ts` (24 tests): support/cantilever fixtures
  (incl. the 13×5 pavilion and partial roof collapse), plank-bridge
  limit boundary, stress thresholds + terrain exemption, propped-overhang
  failure, two-stage cascade, sim queueing rules (placements/water never
  queue), region merging, cap truncation + cascade completion,
  determinism across worlds, reset; fire→structure coupling
  (burned pillar drops roof); `World.isEdited` contract. Suite total
  278 tests, all green; typecheck/lint/build clean; headless browser
  suite extended with a Phase 11 section (gate, cantilever hold, tower
  stress cascade, fire coupling, G overlay) — all green, zero page
  errors.

## [0.8.0] — 2026-09-10 — Phase 10 (Fire and Smoke)

### Added

- Cellular fire simulation (`src/voxel/fire.ts`), mirroring the fluid
  pattern: a burning cell is a fuel counter; heat is an integer
  accumulator that only builds in flammable cells. Ignition at
  `ignitionHeat(flammability)` (derived `MATERIAL_FIRE` balance table
  next to `MATERIAL_HARDNESS`: wood 0.9/480 ticks, grass 0.55/64 ticks;
  all else fireproof), so tinder needs a sustained blaze and multiple
  burning neighbors accelerate the catch. Burning cells deposit heat
  into flammable neighbors; heat decays when ticked.
- Fire death rules: adjacent **water extinguishes** (cause `water`,
  milestone 8 — the water survives); a cell **fully enclosed** by
  opaque material is smothered (cause `smothered`, fuel survives);
  spent fuel **burns the voxel to air** through `World.setVoxel` —
  journaled, remeshed, visible to the fluid sim, persistent across
  save/load (fires themselves are transient; format stays at v2).
- Ignition paths: the **ignite tool** (sixth brush tool; lights every
  flammable cell in the brush shape, refuses water-adjacent cells) and
  **explosion heat coupling** — `explode()` now returns `heated`
  (flammable crater-rim survivors) and the game deposits `BLAST_HEAT`
  on them, so blasts start visible spreading fires (the Phase 8
  deferred "calculate heat").
- Event bus additions: `fireIgnited` and `fireExtinguished` (with
  cause); ignition plays a crack burst, water extinguishing pops a
  steam-stand-in dust puff.
- Fire rendering (`src/render/firefx.ts`): pooled InstancedMesh **embers**
  (256, ballistic arc, sub-second life) and **smoke** (512, buoyant
  rise, growth, long life); emission scales with the burning-cell count
  under hard per-frame caps, so large blazes recycle the pools.
- HUD `· fire N` counter; inspector shows `burning <fuel>`; fire joins
  the fixed step with a 256-cell budget; `fire.takeDirty()` arms the
  autosave for burn-out edits; `fire.reset()` on save load.
- `benchmarks/fire.bench.ts` — budget tick 1.68 ms mean, fire front
  1.59 ms mean, 20×20 platform burn-out ≈1.0 s total (baselines in
  `docs/performance.md`).
- 22 new tests (262 total, 23 files): ignition rules, spread, exact
  burn durations, water coupling, smothering, blast heat, budget,
  sleep/wake, determinism (state + world), journal interplay
  (burned voxels survive chunk regeneration).

### Changed

- `FluidSim` (and `FireSim`) chain onto the World's single
  `onVoxelChanged` hook instead of overwriting it — sims can be
  constructed in any order and both observe every world mutation.

## [0.7.0] — 2026-09-10 — Phase 9 (Water)

### Added

- Cellular fluid simulation (`src/voxel/fluid.ts`): per-cell water
  levels 0–255 with **255 = source** semantics (plain WATER material —
  terrain lakes and player-placed water are sources with zero setup),
  1–254 flowing water in a sparse chunk-keyed map. Gravity with a 254
  cap, integer horizontal equalization (`diff >> 1` when `diff ≥ 2` —
  never oscillates), exact mass conservation, sleep/wake with a ±1
  neighborhood re-wake, and a budgeted `tick` (384 cells per fixed
  step; settled water costs nothing).
- World hooks: `onVoxelChanged` (fires after every successful
  `setVoxel` — displacement/vaporization + neighborhood wake) and
  `onChunkReady` (wakes water at the streaming frontier).
- Flow-height water rendering: greedy mesher accepts a `waterLevel`
  query and emits a per-vertex `waterDrop`; the water material sinks
  top faces by (255 − level)/255. Full/submerged cells merge unchanged
  (greedy↔naive equivalence tests still green). LOD1 water = full cubes.
- Swimming: buoyancy, drag, sink cap, swim-up, and a wall-assist climb
  boost that clears a 1-voxel bank from the waterline (controller
  stays query-injected; legacy behavior unchanged without `waterAt`).
- Water interactions: WATER is a placeable brush/hotbar material
  (hotbar 6); brush place fills into water (displacement); explosions
  vaporize water so surrounding sources re-flood the crater.
- Save format **v2**: sparse `waterLevels` section (flowing cells
  only), v1→v2 migration chain entry, structural validation of level
  entries, boot restore of fluid state; flowed water marks the autosave
  dirty.
- Fluid HUD: `water N` active-cell counter, `swimming` state line,
  inspector shows `water N/255`.
- `benchmarks/fluid.bench.ts` — budgeted tick 2.6 ms mean, steady-state
  0.42 ms/tick, 22×22 basin flood settles in ≈2.7 s (baselines in
  `docs/performance.md`).
- 35 new tests (240 total, 22 files): mass conservation, boundaries,
  cross-chunk flow, frontier sleep/wake, displacement, v2 round-trips,
  swim/climb physics, flow-height meshing.

### Fixed

- **Frontier churn (found by headless browser verification):** a fluid
  write that failed on an unloaded chunk still re-activated its cell's
  neighborhood, so lake edges at the streaming frontier churned ~10³
  cells forever and starved the activity budget. Failed writes now
  propagate nothing; frontier water sleeps and resumes on
  `onChunkReady` (regression-tested).

### Changed

- Prettier reflow across the repo (the previous commit predated an
  `npm run format` pass).

## [0.6.0] — 2026-09-09 — Phase 8 (Destruction)

### Added

- Destruction pipeline: tool click → pure damage/support computation →
  one grouped undoable command → pooled debris/dust → typed events →
  procedural sound. Believable, not engineering-accurate.
- Damage model (`src/voxel/damage.ts`): spherical blast with material
  resistance (`hardnessOf` — hard stone only fractures near the core,
  soft materials to the edge), bedrock immune, water untouched.
  Deterministic hash-sampled debris specs with a hard cap;
  `debrisFromCells` for structural collapses. One blast = one command.
- Support check (`src/voxel/support.ts`): budgeted region flood fill
  anchored at bedrock + region edge; unsupported components collapse as
  one undoable `collapse` command — **the Phase 8 gate: destroying a
  pavilion's pillar drops its roof within a frame, and Ctrl+Z rebuilds
  it.** Snapshot + flat-index BFS (18.5 → ~10 ms worst case at house
  scale); regions above 150k cells skip the check.
- Event bus (`src/sim/events.ts`): typed `explosion` /
  `structureCollapsed` events (ADR-003 backbone) with
  throw-isolation and unsubscribe.
- Pooled debris (`src/render/debris.ts`): one InstancedMesh, 512 pieces,
  ring-buffer recycling, gravity/bounce/friction/settle/shrink physics
  against the voxel grid. Dust (`src/render/dust.ts`): 1024 pooled
  voxel puffs. **100-event stress test stays inside the pool cap.**
- Procedural sound (`src/audio/sfx.ts`): WebAudio thud/crack/boom
  (filtered noise + sub sweep, no assets), resumes on first gesture,
  **N** mutes.
- Explosion creator tool (fifth tool, radius from brush size); support
  check runs after every destructive edit (remove, brush delete, cut,
  explosion); HUD debris counter; destruction benchmarks; 23 new tests
  (205 total).

### Changed

- `World.getVoxel` gained a one-slot chunk memo — region scans (support
  checks) and raycasts skip most chunk-map lookups.

## [0.5.0] — 2026-09-09 — Phase 7 (Creator Mode)

### Added

- Brush core (`src/creator/brush.ts`): sphere/box/cylinder/noise shapes
  × place/delete/paint/replace tools producing edit lists — one stroke
  is one grouped undoable command through `applyEdits`. Deterministic
  noise-brush scatter via the new exported `hash3` (terrain's integer
  hash stays byte-identical for existing seeds). Bedrock floor
  protected; player-overlap guard for placement.
- Box selection (`src/creator/selection.ts`): two corner clicks,
  normalized bounds, 32³ budget, pure region copy.
- Clipboard (`src/creator/clipboard.ts`): rotate 90° steps around Y,
  mirror X, material remapping as pure volume transforms; paste
  flattens to one command (air skipped by default so pasting never
  gouges holes).
- Prefabs (`src/creator/prefab.ts`): versioned v1 JSON with RLE voxels,
  full structural validation; `PrefabLibrary` over any `SaveStore`
  (store interface gained `keys()`); **O** saves, **P** cycles loads.
- Voxel inspector (`src/creator/inspector.ts`) + derived material
  hardness table: **I** toggles the HUD panel (coords, material,
  hardness).
- Creator visualizations (`src/render/creatorViz.ts`): wireframe brush
  ghost (shape-true, tool-tinted), yellow selection box, blue paste
  preview.
- Controls: **C** toggles creator mode, **Q/E** cycle tools, **V**
  cycles shapes, **[ ]** brush size 1–8, **B** box-select mode (two
  clicks), **Ctrl+C/X/V** copy/cut/paste, **R/Shift+R** rotate
  clipboard, **M** mirror, **O/P** prefab save/load, **I** inspector.
- 35 new tests (182 total): shape masks, tool preconditions, bedrock/
  player guards, transform round-trips (rotate ×4 = identity),
  prefab validation incl. corrupt JSON, grouped-command invariants.

### Fixed

- `SaveStore` implementations could not enumerate keys; `keys()` added
  to the interface, the localStorage adapter (prefix-stripping), and
  the in-memory test store.

## [0.4.0] — 2026-09-09 — Phase 6 (Microvoxels)

### Added

- Palette-compressed chunk storage (`PackedVolume`): per-volume material
  palette + bit-packed indices (1/2/4/8 bits, auto-widening) with an
  occupancy bitset for O(1) air/empty checks. ~5.3× smaller than dense
  on terrain (1536 B vs 8192 B per chunk); both satisfy the new shared
  `VoxelData` interface. Tradeoff study in `docs/voxel-storage.md`.
- Greedy mesher (`meshVolumeGreedy`): coplanar same-material faces
  merge into maximal rectangles — proven face-set-equivalent to the
  naive baseline by randomized + terrain + cross-chunk equivalence
  tests, with per-quad winding checks. Terrain chunk: 1506 → 185 quads;
  whole view ~82.5k → ~9k quads.
- Chunk LOD: `downsampleVolume` (majority material, air-wins-ties) +
  distance-based level selection with hysteresis; LOD1 meshes rebuild
  from the downsampled volume and scale 2×. 88 of 226 chunks render at
  LOD1 at radius 6.
- Per-voxel shader variation now derives the voxel cell from the
  fragment's world position, staying per-voxel on merged greedy quads
  (replaces the removed `voxelOrigins` attribute).
- Material painting: **F** recolors the targeted voxel in place.
- Benchmarks: naive vs greedy meshing (all scenes), dense vs packed
  storage, terrain chunk quad counts; baselines in
  `docs/performance.md`.
- 30 new tests (147 total).

### Fixed

- LOD1 surfaces sat 1–2 voxels above the full-resolution mesh (found in
  browser playtesting): the downsample's majority rule now counts air
  and air wins ties, so LOD can only erode, never inflate terrain.

## [0.3.0] — 2026-09-09 — Phase 5 (Editing)

### Added

- Voxel DDA selection raycast (`src/voxel/raycast.ts`, pure + tested):
  cell-by-cell traversal with entry-face normals; water is not
  targetable.
- Editing core (`src/voxel/edits.ts`): `applyEdits` groups cell changes
  into one `EditCommand` (previous values captured, no-ops and failed
  cells skipped), `EditHistory` undo/redo stacks (capped at 128), and
  the player-overlap guard for placements.
- Persistence (`src/voxel/persistence.ts`): versioned save schema
  (seed + terrain params + material table snapshot + edit journal),
  migration chain (`migrateWorld`), structural validation, `SaveStore`
  interface with in-memory and localStorage backends, and an
  `AutosavePolicy` (20 s interval, dirty-gated).
- World edit journal: every `setVoxel` is journaled per chunk and
  replays on regeneration — edits survive chunk unload/prune and page
  reloads. Saves restore on boot unless `?seed=` overrides.
- Editing controls: LMB remove (bedrock floor protected), RMB place
  (never into the player), MMB eyedropper, 1–7 / wheel material select,
  Ctrl+Z / Ctrl+Y undo/redo, K save, L load.
- HUD edit line (material, target, undo depth, save state), material
  hotbar, wireframe target highlight, translucent placement ghost
  tinted with the selected material, updated overlay help.
- 35 new tests (117 total): raycast traversal/negatives/predicates,
  edit command invariants, journal round-trips, save round-trips,
  migration/validation errors, autosave timing.

## [0.2.0] — 2026-09-08 — Phases 2–4 (Chunks, Terrain, Materials)

### Added

- Chunk system: `Chunk` (16³ + dirty flag), `World` chunk map with
  world-space get/set, boundary-edit dirty propagation to neighbor
  chunks, radius-based data pruning, lifecycle (ensure/unload).
- Streaming: pure desired-set/priority/unload math plus the render-side
  `ChunkMeshManager` — nearest-first mesh queue with per-frame budget,
  camera-direction tie-break, dirty remeshing, geometry disposal.
- Mesher v2: cross-chunk neighbor queries, opaque/water pass split
  (underwater terrain visible through water), per-vertex voxel origins.
- Deterministic terrain: mulberry32 RNG, integer-hash value noise + fBm,
  hill/mountain height function, sea level, layered materials (bedrock,
  stone, dirt, grass, sand beaches, water), dry-land spawn scan.
- Material registry: 7 materials with metadata (color, opaque, solid),
  id/name lookup, versioned JSON serialization with validation.
- Voxel shader: palette texture indexed by materialId, per-voxel
  brightness variation, in-shader lighting + fog, transparent water.
- 44 new tests (82 total) and terrain benchmarks.

### Fixed

- Chunk meshes were never positioned in world space (all chunks stacked
  at the origin — masked by Phase 2's flat world, exposed by terrain).

## [0.1.0] — 2026-09-08 — Phase 0 + Phase 1 (First Pixel)

### Added

- Tooling: TypeScript (strict), Vite, Vitest (node env), ESLint flat
  config, Prettier, CI workflow (lint → typecheck → test → build,
  Node 22).
- World state: `VoxelVolume` dense cubic storage (`Uint16Array`,
  bounds-checked), negative-safe world/chunk/local coordinate
  conversions, material IDs (air = 0), demo world generator.
- Meshing: naive culled face mesher producing plain typed arrays;
  BufferGeometry builder with per-vertex colors + `materialId`
  attribute; renderer bootstrap (scene, camera, lights, resize, loop).
- Player: pointer-lock mouse look, WASD + jump, gravity, per-axis AABB
  voxel collision at fixed 60 Hz timestep, void respawn.
- Tests: 38 unit tests across coordinates, storage, mesher (incl.
  winding verification), controller. Mesher benchmarks with recorded
  baselines in `docs/performance.md`.
- Docs: README, architecture, performance, known issues, progress
  tracker.
