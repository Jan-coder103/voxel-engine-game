# Architecture

Scope: what exists now (Phases 0–11) plus the boundaries already fixed for
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
│                                               │  damage, structure
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
  (place/delete/paint/replace; `explode` routes to the damage module;
  `ignite` routes to the fire sim — Phase 10). Shape tests use cell
  centers; bedrock (y ≤ 0) is never touched; a caller-supplied
  `excludes` predicate enforces the player-overlap guard for placement.
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

The pipeline: tool click → pure damage computation → one grouped
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
- **Event bus** (`src/sim/events.ts`): typed `GameEvent` union
  (`explosion`, `structureCollapsed`, `fireIgnited`, `fireExtinguished`),
  synchronous dispatch, one handler throwing doesn't block the rest
  (ADR-003 — the backbone future physics/AI/audio/scripting subscribe
  through).
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

## Water (Phase 9)

A pure cellular fluid (`src/voxel/fluid.ts`) layered over the voxel
grid, deliberately not part of the edit journal (flow is simulation,
not user intent — otherwise undo history would flood).

- **Cells, not materials.** Every water-material cell has an implicit
  level: **255 = source** (an inexhaustible spring — the plain default;
  terrain lakes and player-placed water are sources with zero setup),
  **1–254 = flowing** water kept in a sparse
  `Map<chunkKey, Map<voxelIndex, level>>`. Air reads as 0; unloaded
  chunks refuse writes (water waits at the streaming frontier until
  `onChunkReady` wakes it). Rules per active cell: gravity down to the
  254 cap, then horizontal equalization in fixed neighbor order
  (`diff >> 1` when `diff ≥ 2` — integer-only, never oscillates).
  Sources keep their 255; flow can never create a source. No pressure
  or up-flow yet (Phase 9 deferred item).
- **Sleep/wake + budget.** Only cells in an `active` set simulate; a
  change re-wakes the ±1 neighborhood, a no-change tick lets the cell
  sleep. `tick(budget)` (game: 384 cells per fixed step) bounds cost
  regardless of flood size; settled water costs nothing. Writes go
  through `World.setVoxel` (journaled + remeshed), and a failed write
  (unloaded chunk) must not re-activate the cell — the frontier sleeps
  instead of churning the budget dry.
- **World hooks.** `world.onVoxelChanged(x, y, z, material, previous)`
  fires after every successful `setVoxel` (edits, undo/redo, sim writes;
  the Phase 11 `previous` argument tells the structural sim whether solid
  matter vanished):
  FluidSim drops the level when a cell stops being water
  (displacement/vaporization) and wakes the neighborhood.
  `world.onChunkReady(chunk)` fires at the end of `ensureChunk` and
  wakes water in the chunk plus its 6 face-adjacent planes so a source
  parked at the streaming frontier resumes. Boot-time journal replay
  deliberately fires neither hook (quiet restore).
- **Flow-height rendering.** `meshVolumeGreedy` takes an optional
  `waterLevel(x, y, z)` query. Surfaced partial cells (air above,
  level < 255) merge with a distinct signature carrying the level; the
  mesher writes a per-vertex `waterDrop` ((255 − level)/255) on
  top-edge vertices, and the water material's vertex stage sinks
  `p.y -= waterDrop`. Full and submerged cells merge as before, so
  lakes stay cheap and the greedy↔naive equivalence tests hold. LOD1
  water renders full cubes (no level query at distance, by design).
- **Swimming.** `stepPlayer` takes an optional `waterAt` query; probes
  at feet +0.2 and eye vs the surface (`cellY + level/255`). In water:
  low gravity, drag, capped sink, swim-up on jump, and a wall-assist
  climb boost (`WATER_CLIMB_SPEED`) that survives the swim cap for one
  step — without it a 1-voxel bank above the waterline is unreachable.
  Without the query the controller ignores water exactly as before.
- **Interactions.** Brush place fills into water (displacement); WATER
  is a placeable brush/hotbar material (creates sources); paint/replace
  skip water; explosions **vaporize** water (edited to air, no debris,
  not counted as destroyed) so surrounding sources re-flood the crater.
  Water is not edit-raycast-targetable — you edit through lakes.
- **Persistence v2.** `WORLD_FORMAT_VERSION = 2` adds a sparse
  `waterLevels` section (only flowing 1–254 cells; sources and terrain
  lakes are derivable), with v1→v2 migration and structural validation.
  `exportLevels`/`loadLevels` are the fluid-side (de)serializers;
  flowed water marks the autosave dirty via `fluid.takeDirty()`.

## Fire (Phase 10)

A pure cellular fire sim (`src/voxel/fire.ts`) mirroring the fluid
pattern: budgeted ticks, sleep/wake, integer rules, no RNG. Believability
over accuracy — there is no temperature field or oxygen meter.

- **Cells, not fields.** A burning cell is a fuel counter (ticks
  remaining) in a sparse `Map`; heat is an integer accumulator that only
  ever builds in flammable cells (`fireProfileOf` — a derived
  `MATERIAL_FIRE` balance table next to `MATERIAL_HARDNESS`: wood
  flammability 0.9 / 480 ticks, grass 0.55 / 64 ticks; everything else is
  fireproof). A cell ignites when its heat reaches
  `ignitionHeat(flammability)` (= `IGNITION_BASE · (1 − flammability)`,
  min 1), so tinder needs a sustained blaze and several burning neighbors
  accelerate the catch. Burning cells deposit `HEAT_PER_TICK` into each
  flammable non-burning neighbor; ticked cells shed `HEAT_DECAY`.
- **Death rules.** A burning cell dies (event `fireExtinguished`) next to
  **water** — any adjacent WATER-material cell, source or flowing — or
  when **fully enclosed** by opaque material (no air access; the fuel
  survives). When fuel runs out the cell **burns out**: the voxel becomes
  air through `World.setVoxel`, so the destruction is journaled,
  remeshed, visible to the fluid sim, and persists across save/load —
  fires themselves are transient state and do not survive a load
  (deliberate; the save format stays at v2).
- **Ignition paths.** The creator **ignite tool** lights every flammable
  cell in the brush shape (refuses water-adjacent cells); explosions
  return `heated` — flammable survivors at the crater rim — and the game
  dumps `BLAST_HEAT` on them, so a blast leaves a spreading fire instead
  of popping one in. Heat-coupled ignition goes through the same
  threshold path as any other fire.
- **Activity + determinism.** Identical shape to the fluid sim:
  insertion-ordered `active` set, `tick(budget)` (game: 256 cells per
  fixed step, joining the fluid's budget in the same fixed step), a
  sleeping cell costs nothing, and any write near a cell (edit, undo,
  fluid, collapse) re-wakes it via the World's `onVoxelChanged` hook.
  Both sims chain onto that single hook (whoever is constructed later
  wraps the earlier hook — construction order is fire _after_ fluid by
  convention, but the chain makes it harmless either way). Same edit/
  tick sequence → same fire, unit-tested.
- **Rendering** (`src/render/firefx.ts`): two pooled InstancedMeshes —
  embers (small bright boxes, ballistic arc, sub-second life) and smoke
  (dark boxes, buoyant rise, growth, long life). Emission scales with
  the burning-cell count under hard per-frame caps (12 embers / 8 smoke)
  so a huge blaze recycles the same pools. Burning voxels keep their
  material; particles are the fire's visual. Water extinguishing pops a
  small dust puff (steam stand-in) via the event bus.
- **Interactions.** Fire ↔ water is milestone 8: adjacent water
  extinguishes and survives; fluid flow into a burning cell (or a
  player's water dump) kills it through the same hook. Burn-out holes
  are journaled edits and — since Phase 11 — undermine structures like
  any removal: a burned pillar drops its roof through the structural
  sim.
- **HUD/inspector.** A `· fire N` counter appears while anything burns;
  the voxel inspector shows `burning <fuel>` for a burning cell.

## Structural simulation (Phase 11)

`src/voxel/structure.ts` replaces the Phase 8 edit-time support
approximation with a ticked, budgeted sim over a graph of solid cells
(believability over correctness, plan §26/§109).

- **Nodes and connections.** Nodes are solid cells in the scan region;
  connections are 6-neighbor adjacencies. Vertical connections always
  transmit support; horizontal ones transmit it only within
  `MAX_CANTILEVER` (6) consecutive groundless hops.
- **Support analysis** is a 0/1-cost BFS from anchors — the bedrock
  layer plus the region's horizontal boundary, which is assumed to
  continue into grounded terrain. Stepping onto a cell with solid
  ground below is free; stepping onto one hanging in the air costs 1.
  Cells no path reaches (cost 255) are unsupported. This makes floors
  hold from their walls, plank bridges stand within ~6 of a shore, and
  a roof whose last pillar is gone fall entirely; overhangs past the
  limit drop only their far half (partial cantilever collapse).
- **Stress** is vertical stack load: a cell carries one mass unit for
  itself plus everything solid above it in its column. `strengthOf` (a
  derived `MATERIAL_STRENGTH` balance table) is the fracture threshold.
  Only cells with journaled edits are stress-eligible — natural terrain
  is assumed at rest, so cliffs and mountains never avalanche — while
  load itself counts all overlying mass, so a wood post propping up a
  stone overhang still fails. Disturbing the ground next to a
  23+-tall wood tower fractures its base, and the upper tower then
  cascades down on the next tick.
- **`StructuralSim`** (ticked like fluid/fire): chains onto the World's
  `onVoxelChanged` hook — which now also carries the cell's previous
  material — and queues a region scan only when **solid matter
  vanished** (tool removal, brush delete, cut, explosion, collapse,
  fire burn-out). Placements and water flow never trigger an analysis:
  building stays Minecraft-style free, and re-placed structures are
  trusted until disturbed. Pending regions merge; one analysis runs per
  fixed step (game budget: `STRUCTURE_ANALYSES_PER_TICK = 1`); regions
  above `STRUCTURE_SCAN_BUDGET` (150k cells) are skipped, and single
  collapses cap at `MAX_COLLAPSE_CELLS` (4096) with the rest left to
  the cascade.
- **Regions scan the full world height** (32 rows) but only ±12
  horizontally: loads are column stacks, so a cut-off top would
  undercount them. The snapshot iterates chunk-by-chunk (missing chunks
  read as air; each chunk's edit journal is consulted once, not per
  cell) into flat `solid`/`meta` byte buffers, so every later pass runs
  allocation-free over typed arrays.
- **Collapse flow.** The sim _proposes_ failing cells through
  `onCollapse`; the game layer applies them as one grouped undoable
  `collapse` command with debris/dust/sound (`structureCollapsed` on
  the bus), exactly like a tool edit. Applying the edits re-queues the
  region, so multi-stage failures cascade across ticks — staged,
  bounded, and undoable.
- **Fire coupling** (the deferred Phase 10 item) falls out of the hook:
  burn-out is a real `setVoxel(AIR)` write, so a burned-through pillar
  drops its roof with no special-case code.
- **Debug overlay** (`src/render/structureViz.ts`, toggled with G):
  flashes the failed cells of each collapse — red for lost support,
  orange for stress fractures — for ~1.6 s so the _reason_ a structure
  fell stays readable after the fact. One pooled InstancedMesh, same
  discipline as debris/dust.

## NPCs (Phase 12)

`src/npc/` adds a small population of wandering figures: a pure
simulation (`npc.ts`) over the navigation queries and A\* in
`navigation.ts`, with the perception geometry of Phase 13 in
`perception.ts`, mirrored into one pooled InstancedMesh by
`src/render/npcViz.ts`. Believability over accuracy, plan §37/§110/§111:
there are no rigid bodies and no animation.

- **Navigation** treats every standable cell as a graph node — the
  graph is implicit in the voxel grid, so edits never require a nav
  rebuild (plan §40). A cell is walkable when it and the cell above are
  open (not solid, not water) and the cell below is solid; moves are
  flat, one up, or a drop of up to `MAX_DROP` (3), with a lip-clearance
  rule so deep drops must fall clear past the ledge. `findPath` is A\*
  with a Manhattan heuristic (admissible: every move costs 1 and
  changes XZ distance by exactly 1), a binary heap with insertion-order
  tie-breaks, fixed neighbor order, and a hard `maxExpansions` budget
  (the sim decides with 512) — hopeless searches cost ~5 ms, not ∞.
  `terrainNavQuery` implements the standard rules over the World read;
  tests build bespoke queries from heightmaps.
- **Local invalidation**: `NpcSim` chains onto `World.onVoxelChanged`
  (read-only — NPCs never write voxels) and marks any path that crosses
  the changed cell — or its floor — for a re-path. Path lists are short
  cell arrays, so "which paths does this edit touch" is a few dozen
  comparisons per edit; a collapse invalidates only the paths it
  actually severed, and `DECIDES_PER_TICK` (3) bounds the A\* work per
  fixed step, so burst re-paths spread over ticks.
- **Behavior** is a tiny schedule state machine per figure —
  `idle → wander → goto → sleep`, each with an `intent`
  (home / work / wander). The clock is a tick counter (100 ticks per
  game hour, 2400 per day ≈ 40 s real time) starting at 08:00; nights
  and exhaustion (`needs.sleep > 80`) send figures home to sleep until
  dawn or rested, work hours (09:00–17:00) send ~60% of decisions to
  the work anchor, and the rest is wandering: a hash-scattered target
  within 10 cells, pathed, then an idle wait. Needs accumulate
  deterministically (sleep 0→100 per day awake, 4× faster recovery
  asleep; hunger rises with no consumer yet — no food exists).
- **Movement** is grid-following at `NPC_SPEED` (2.2 cells/s) with
  vertical easing between path cells (no teleporting up steps). The one
  physical rule: when the support under a figure vanishes — a collapse,
  a dig — it falls with gravity until it lands, then re-paths; landing
  in water despawns the figure ("swept away"). `stepFall` checks both
  the current support and, while following a path, the target cell's
  floor, so pathed drops down ledges never read as "ground vanished".
- **Population** is transient and never saved: `maintain` despawns
  figures beyond `DESPAWN_RADIUS` (80) from the player and spawns
  toward `MAX_POPULATION` (16) at ≤ 1 per fixed step, ring-scattered by
  hash at 14–60 cells with 3 cells of personal space. A reloaded world
  repopulates deterministically — no NPC state in the save format.
- **Determinism** (ADR-005): no sequential RNG anywhere — every
  "random" choice hashes (npc id, salt, tick, world seed) through the
  terrain `hash3`. Identical worlds + tick sequences produce
  bit-identical populations, paths, and schedules (unit-tested).
- **Rendering** (`src/render/npcViz.ts`): one InstancedMesh of
  capsules, tinted by activity (green wandering, yellow commuting,
  slate idle, dark blue asleep, red fleeing, teal investigating;
  sleepers lie down), updated per frame from `sim.list()`. Same pool
  discipline as debris/dust (ADR-004).

## NPC reactions (Phase 13)

Phase 13 closes the loop opened in Phase 12: the world's destruction
events now _matter_ to the figures living in it (plan §111). New pure
perception geometry lives in `src/npc/perception.ts`; behavior stays in
`npc.ts`.

- **Perception — vision**: `canSee` = range (`SIGHT_DISTANCE`, 24
  cells) × horizontal field of view (130°, the movement yaw convention)
  × voxel line of sight (the Phase 5 DDA reused with a
  solids-block-sight predicate; the ray stops ~0.75 cells short of the
  target so a burning block doesn't occlude itself — water never blocks).
- **Perception — hearing**: no propagation field — each event kind has a
  hear-radius formula (explosion `radius·4 + 20`, collapse
  `min(60, 20 + 2·√cells)`), and a figure hears it iff it is inside.
  Believably lossy, O(figures) per event.
- **Threat memory**: a capped `ThreatBoard` (12) of event sites with
  tick expiries (blast/collapse 400, fire 600, water 150), deduplicated
  by kind within 4 cells — one spreading blaze is one threat, not one
  per ignited cell. It feeds both vision scans and flee targeting.
- **Reactions enter through `NpcSim.notify(event)`** — main wires the
  bus's `explosion` / `structureCollapsed` / `fireIgnited` to it.
  `explosion` also applies damage: distance falloff inside
  `radius + 3`, lethal within half that (the crater), **quarter damage
  when line of sight is blocked** (walls really do shield). Death
  despawns the figure and emits a new `npcDied` bus event (cause
  `explosion` | `drowned` — the Phase 12 water-sweep now reports too)
  for Phase 17+ audio/scripts. Malformed (non-finite) events are
  dropped at the door: NaN survives `Math.min`/`Math.max` and would
  permanently poison fear.
- **Fear** (0–100 per figure) rises with proximity and what the figure
  perceived (heard-only events count less; seen threats add more, but
  only within `ALARM_RADIUS` = 12 cells — a distant blaze is scenery
  until you are near it, which is what lets an investigator actually
  reach the site). It decays ~0.1/tick, so panic subsides in seconds of
  real time. At `PANIC_THRESHOLD` (50) the schedule is overridden:
  - **`flee`** — path away from the nearest remembered threat (14–20
    cells, per-figure hash jitter ±~31° so crowds don't funnel), at
    `FLEE_SPEED_MULT` 1.6×; arrivals catch breath briefly and re-decide
    while fear stays high; sleepers wake. Nowhere to run → cower in
    place and retry; hemmed in → run for home.
  - **`investigate`** — heard but not frightening: path to a stop-short
    anchor ≤ 4 cells from the site, stand and look (100–220 ticks).
    Approaching inside the alarm radius converts the arc into the
    plan §42 chain — investigate → _see_ destruction → fear spike →
    flee.
- **Flood response** has no bus event: the staggered perception scans
  (`SCAN_PERIOD` = 10 ticks, offset by id) check the feet cell and its
  four neighbors for water — water at the feet is +60 fear and flight.
  The same scans wake sleepers for any threat within 5 cells (noise and
  heat ignore closed eyes), and sight gains keep a figure panicking
  while the threat stays visible.
- **Determinism**: all choice (jitter, flee distance, arrival waits)
  hashes (id, salt, tick, seed) as everywhere else; identical event
  sequences tick identically (unit-tested), and a NaN-event guard keeps
  that true even from hostile input.

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
  hardness, bedrock/water immunity, determinism, debris caps,
  event-bus delivery, and the 100-event debris-pool stress test),
  structure (support/cantilever fixtures incl. pillar-roof collapse,
  boundary anchoring, budget skip, stress thresholds + terrain
  exemption, progressive cascade, region merging + truncation,
  determinism, fire→collapse coupling, edit-journal contract), fire
  (ignition rules, spread, exact burn durations, water coupling,
  smothering, blast heat, budget, sleep/wake, determinism, journal
  interplay).
- Benchmarks: `benchmarks/mesher.bench.ts` (naive vs greedy, solid/
  checker/layered/terrain), `benchmarks/storage.bench.ts` (dense vs
  packed), `benchmarks/terrain.bench.ts`, `benchmarks/destruction.bench.ts`
  (blast fields, support checks), `benchmarks/fluid.bench.ts` (budget
  tick, flood scenarios), `benchmarks/fire.bench.ts` (budget tick, fire
  front, full burn-out scenario), `benchmarks/structure.bench.ts`
  (house-scale gate, worst-case solid region, overstress tower, full
  collapse cascade). Baselines in `docs/performance.md`.
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
