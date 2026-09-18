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

## Procedural town (Phase 14)

Phase 14 gives the world its content: a seeded town laid over the
terrain generator (`src/worldgen/town.ts`, pure like `terrain.ts` —
ADR-002/005 apply unchanged). Every structure is a pure function of
(seed, coordinates): chunks generate in any order, regenerate
identically after unload/prune, and the save format is untouched — town
buildings are _generation_, and the edit journal on top of them is
already how player changes persist.

- **Layout**: roads on a 24-cell grid (3 wide) inside a 96-cell square
  around the origin, with per-seed offsets; the space between roads is
  tiled with 10×10 lots (2×2 per block); beyond the square the land is
  wild. `planAt(x, z)` classifies any column (road / lot / wild) in
  O(1) arithmetic — no town state exists anywhere.
- **Bridges**: a road column standing in water becomes a wooden deck
  one block above the waterline (flush with the shore at sea level) on
  posts to the lakebed every other cell. The posts are structural: burn
  one and the support graph drops its span of deck into the lake.
- **Lots**: each lot hash-picks house (~60%) / shop (~18%) /
  industrial (~22%) or stays a yard, some with a tree. A building is
  viable only when its whole pad (footprint ± 1) is dry land, the
  structure clears the world ceiling, and it fits inside the town
  square — water margins stay unbuilt.
- **Buildings** are parameterized (`BuildingSpec` derived from the lot
  origin hash, plan §60's `generateBuilding` shape): 6–8 cell
  footprint, concrete pad with cut/fill leveling, walls (wood / brick /
  concrete) with a 2-tall door and rhythmic glass windows, and a roof —
  gable (ridge along the long axis, closed gable ends) for houses, flat
  - parapet for shops, slab for industry. Furniture is a handful of
    hash-placed blocks (bed + table, counter, crates). Spans are sized to
    stay inside the structural sim's cantilever budget: every roof row
    anchors to both gable ends, slabs hang ≤ 3 hops from walls.
- **Two-story houses** have a real interior: a slab floor with two
  stair openings and a four-step staircase against the wall opposite
  the door — one-block steps the nav grid already pathes, so NPCs (and
  the player) can walk upstairs.
- **Vegetation**: wild trees gate on a 5-cell lattice + hash + dry
  grass (canopy paints only into air, so slopes and buildings are never
  engulfed); park lots get a yard tree.
- **NPC integration**: `townAnchors` enumerates every building's
  door-front cell; main injects them into `NpcSim` as home (houses) and
  work (shops/industry) candidates. A spawned figure hash-picks among
  the six closest candidates within 48 cells and snaps to a walkable
  cell, falling back to the terrain ring when the town is far or
  unloaded. A `groundY` predicate (the terrain height function) keeps
  spawn candidates off roofs, canopies, and bridge decks, and
  `findTownSpawn` nudges the deterministic spawn off building pads onto
  open ground.
- **Materials**: five appended ids (7 asphalt, 8 concrete, 9 brick,
  10 glass, 11 leaves) with derived hardness/fire/strength entries.
  Leaves are the one flammable addition (fast flash-over fuel). The
  registry stays append-only: old saves' 7-material snapshots still
  validate, so no save-format or material-format bump was needed.
- **Cost**: the town overlay is ~0.6–0.9 ms per chunk on top of ~0.6 ms
  terrain (`benchmarks/town.bench.ts`); the one-time boot census is a
  couple of milliseconds.

## Utilities (Phase 15)

Phase 15 wires the town: a power grid and a water main, both simulated
by small component-rebuilding sims that follow the structural pattern —
world writes touching their materials queue a cell, each tick rebuilds
at most one connected component (BFS with a hard cell cap), and chunk
generation scans queue silently (discovering existing state is not a
state change, so only edit-triggered rebuilds emit events). All state
is transient and derived from voxels; the save format is untouched.

- **Power grid** (`src/voxel/power.ts`): the network is the connected
  component of copper / lamp / generator cells. A component with ≥ 1
  intact generator is powered; when its lamps exceed the supply
  (`capacityPerGenerator`, tests override the 1024 default), lamps are
  lit in BFS order from the generators so an overloaded grid browns out
  the farthest first. No voltage, current, or resistance — believable
  over accurate (plan §47 simplified). Every lamp flip emits
  `powerLost` / `powerRestored` (the Phase 13 NPC wiring consumes the
  former: nearby figures glance over).
- **Plumbing** (`src/voxel/plumbing.ts`): the network is the connected
  component of pipe / pump / tap cells. A pump is self-powered (diesel,
  no generator coupling yet) and pressurizes its component when water
  touches any face. While pressurized: a **leak** (any pipe cell
  destroyed by tool, explosion, collapse, or dig) re-fills its hole
  with flowing water through `FluidSim.pour` every `POUR_PERIOD` ticks
  until the network runs dry — real Phase 9 water that spreads, puts
  out fires, and sweeps NPCs; a pressurized **tap** pours into the
  first air cell beside it. Destroy the pump and leaks stop, taps dry.
- **Generated utilities** (`src/worldgen/utilities.ts`, pure like the
  town): a copper **cable** is buried one block under every road-line
  center column (with stair-step fills where the terrain rises — the
  higher column extends down to its neighbor's level, keeping the grid
  connected and every cell grounded); metal **lampposts** rise from the
  cable every 8th center column (seeded offset); one **generator** on a
  copper vault at the central intersection feeds the whole grid (on
  watery seeds the plant stands on the bridge deck). The **water main**
  runs down the road's edge lane at h−2 (h−3 under cable crossings so
  the cable keeps its support, deck−1 under water on posts) from a
  submerged **pump** at the nearest lake to a **tap** on a standpipe by
  the town center. All hashes — no sequential RNG.
- **Mesh redundancy**: the town grid is a 9×9 mesh, so a single cable
  cut is _tolerated_ (nothing disconnects — realistic); blackouts
  require orphaning the plant or cutting a full line. Severing a pipe
  or a wire splits the network into independent components, each
  rebuilt separately — the severed far side genuinely goes dark/dry.
- **Rendering** (`src/render/powerViz.ts`): one pooled InstancedMesh of
  warm glow shells over lit lamps, rebuilt only when the sim's `revision`
  changes. Since Phase 17 the lit set also feeds the light field, so
  lamps cast real block light; the shells remain the "this lamp is on"
  indicator.
- **Performance**: `makeCachedReader` (`src/voxel/cachedReader.ts`) gives
  rebuild BFS a real chunk cache — the World's one-slot memo thrashes
  under the flood's access pattern (~0.9 µs/read on the dev VM). A
  full town-grid rebuild (~5.4k cells) costs ~12 ms there; rebuilds run
  only when utility cells actually change, budgeted one per tick.
  `FluidSim.pour` reuses the Phase 9 write path (journaled, remeshed).

## Atmosphere (Phase 16)

Phase 16 gives the world a clock and a sky. The core is pure
(`src/sim/atmosphere.ts`), ticked once per fixed step; everything
render-side consumes an immutable snapshot. Same (seed, tick) → same
sky, always; fresh worlds start day 0 at 08:00 (transient — not in the
save format; the L-key load does not reset the clock, consequences of
weather like burn-outs still persist via the journal).

- **Clock**: 100 ticks/hour, day = 2400 ticks ≈ 40 s real time; 8
  real days per season, 32-day year (spring → summer → autumn →
  winter, blending over each season's first day — day 0 is pure
  spring). `bodyDir()` sweeps the sun (and the moon, half a day off)
  along an azimuth arc with `y = sin(elevation)` exact; per-season max
  elevation (spring .95 / summer 1.15 / autumn .9 / winter .62 rad),
  daylight fraction, and a °C-proxy temperature blend.
- **Weather** is a seeded Markov segment chain (clear → cloudy →
  overcast → rain → storm with back-edges); segment state, hold
  (600–2000 ticks), and fade (120–280 ticks) all hash-derive from
  (seed, segmentIndex), so `syncTo(t)` equals stepping — a full year
  fast-forwards in ~0.01 ms. Profiles blend cloudiness / precip /
  wind / fog / darkness smoothly; below-freezing rain renders as snow.
  `forceWeather(w)` is an instant debug/scenario segment (deliberately
  breaks (seed, tick) purity until reset).
- **Lightning**: while storming, a per-tick hash gate fires
  `onStrike(x, z)` near a caller-provided center (main keeps it at the
  player). The pure core never touches voxels — main flashes the sky,
  booms, and force-ignites the top solid cell.
- **Palette** (`skyPalette(state)`, pure hex math): zenith / horizon /
  fog / sun tint + intensities, ambient sky/ground, star / moon /
  sun-disc levels. Clear noon reproduces the pre-atmosphere look.
- **Couplings**: NPC schedules read the world clock via an injected
  `clock` option and night halves sight range via `lightLevel`
  (`perception.canSee` takes an optional range); fire reads rain —
  sky-exposed burning cells soak wetness (~60 ticks of full rain) then
  extinguish with cause `'rain'`, roofed cells stay dry, exposed heat
  decays 2×, and `ignite()` refuses exposed cells while any rain falls
  unless forced (lightning forces).
- **Rendering** (`src/render/atmosphereViz.ts`, `src/render/rainfx.ts`):
  one sky-dome ShaderMaterial (BackSide, follows the camera) — gradient,
  sun disc + halo, moon, hash stars, 3-octave fbm clouds scrolling with
  the wind, lightning flash (fbm is capped at 3 octaves and skipped
  entirely when coverage ≤ 0.2 — every pixel runs on the CPU under
  SwiftShader). The palette is also applied to the voxel shader
  uniforms (sun/ambient/fog; at night the sun term re-aims at the moon
  with a faint blue tint) and `PrecipSystem` pools instanced rain
  streaks / snow flakes around the camera.

## Light field (Phase 17)

Phase 17 gives every voxel two light channels, Minecraft-shaped because
that is the believable-at-16³ version of "voxel AO / dynamic lighting":

- **Sky light** 0–15: a cell is 15 iff every cell above it is
  light-transparent; 15 propagates straight down for free through air,
  spreads sideways at −1 per step, and attenuates through water (−2) and
  glass (−1). Opaque voxels block — leaves make tree shade, roofs make
  dark rooms. **Block light** 0–15: point sources (lit lamps follow the
  power sim's lit set, burning cells the fire sim's — main diffs both
  into idempotent `setSource` calls gated on the power revision and
  burning count; self-luminous machines come from the derived
  `MATERIAL_EMISSION` table) spread at −1 per step.
- **Storage** is two `Uint8Array`s on each `Chunk` (lazily allocated at
  init; unloading frees the light with the chunk). Chunks the field has
  never initialized read as "full sky" through the mesher query, so
  streaming never renders darker than the pre-light look.
- **Updates** are the standard two-queue incremental BFS (budgeted
  1200 pops/tick like the fluid sim): a voxel change removes the cell's
  stale light (cascading downward with the sky free-fall rule,
  re-seeding brighter borders), re-walks the edited sky column, then
  re-adds from the border seeds. Removal entries re-check the cell's
  current value when popped — a column walk can legitimately re-light a
  cell between enqueue and pop, and the stale entry must not cascade.
  Chunk generation initializes columns directly, seeds both border
  directions, the six neighbors of every column break, and (the
  lit-boundary pass) every lit cell bordering a dimmer transparent cell —
  streaming order is arbitrary, so a chunk that arrives above/beside
  existing ones must both demote orphaned 15s below new blockers and
  feed shadows beside its open columns.
- **Every changed value marks the chunk (and boundary neighbors) mesh
  dirty**, so remeshing picks light up through the normal frame budget.
- **Mesher**: `meshVolumeGreedy` takes an optional packed-light query;
  each face samples the cell it looks into, and light is part of the
  merge signature (quads never smear bright into dark). Each quad corner
  gets a classic 3-sample vertex AO (two edge neighbors + diagonal in
  the face plane, around that corner's air cell), sampled per quad
  corner so merging stays maximal. Both emit as `aLight` (vec2,
  normalized by 15) and `aAO` (float, 0–3 → 0–1) vertex attributes; the
  naive baseline mesher is untouched and the greedy↔naive equivalence
  tests still compare the face multiset.
- **Shader**: the voxel fragment shader modulates the outdoor terms by
  sky access and folds AO into them (`(ambient + sun) × sky × ao`), then
  adds the warm block-light term (`uBlockColor × block × ao`) — lamps
  and fire carry the night, caves read as dark, interiors get window
  light. A 0.05 ambient floor keeps fully-enclosed geometry readable.
  The property test pins incremental ≡ from-scratch after 60 random
  edits across both channels.

## Scenario system (Phase 18)

- **The engine** (`src/scenario/engine.ts`, pure) is a tick-driven
  evaluator over declarative definitions: a `setup` stages the world,
  _objectives_ carry `done`/`failed`/`deadline` conditions (plus
  `after` gates that hide an objective — and stop its deadline clock —
  until an event happens), and one-shot _triggers_ stage timed beats
  (hints, escalations). Conditions are pure functions of a context
  (tick counter, bus-event log with box/radius/quiet queries, scratch
  counters, box censuses, NPC lookups); all world-touching goes through
  an injected `ScenarioIo` (journaled edits, ignite, weather,
  force-loading chunks, NPC spawn, announce) that main implements over
  the live game and tests over fixtures. Evaluation order per tick is
  fixed: triggers → scenario-level fail/timeLimit → objectives in
  declaration order. Completion requires at least one positive
  (`done`) objective and all of them done; guard-only objectives
  (fail-conditions without `done`) never block completion and are
  marked done at the end. Scenario state is transient (not saved);
  setup writes go through the normal journal and persist.
- **The event log** is fed from the bus via a new `EventBus.onAny`
  (while running only, capped at 512 records), so conditions can ask
  "how many collapses near the site", "any explosions inside a
  neighbor's box", "quiet for 240 ticks?".
- **The five launch scenarios** (`src/scenario/definitions.ts`) are
  staged from pure site resolution (`resolveSites`: enumerate town
  buildings via `planAt`/`lotSpec`, the water main via `pipelineRoute`,
  the generator via `generatorSite` — no hardcoded coordinates):
  - **Flood** — the generated main bursts (Phase 15 leak pouring Phase 9
    water); stop the leak (cut the pipe or take out the pump) before the
    deadline; guard: no water in the generator vault box.
  - **Fire** — the nearest house ignites inside (a `findFlammable` scan
    over the building **body** — footprint, floor up — that skips
    water-adjacent and fully-sealed cells; the outer box would reach the
    grass apron and stage an unwinnable lawn fire); douse it (placed
    water) before half the structure is consumed; guard: no ignitions in
    the neighbors' **bodies** (their structures — lawn fires in the box
    margin are tolerated, grass burns far too fast to gate on).
  - **Collapse** — the ground-floor wall courses are carved out; the
    Phase 11 support graph stages the real cascade; get clear, wait for
    the quiet window, keep the witness (a real spawned figure) alive.
  - **Demolition** — player-driven: level the nearest building
    (collapse at the site or ¾ removed) with no blasts in neighbor
    boxes, no fires in neighbor bodies, and no casualties.
  - **Rescue** — a figure is spawned inside and the doorway boarded;
    dig it out by hand; the figure walks free on its own schedule
    (work/wander), and survives.
- **main.ts wiring**: `J` cycles the registry; `__mw.scenario` exposes
  engine/sites/ids/start/stop/notes plus `target()` (the staged site —
  fire/rescue prefer houses, so it is not necessarily
  `buildings[0]`). `startScenario` tries candidate buildings
  **nearest-first and skips stages that cannot host the scenario
  anymore** (a burned or soaked house) by re-validating readiness per
  candidate — scenarios chain through the town instead of re-targeting
  rubble. The scenario tick runs last in the fixed step (it sees this
  step's fires, floods, collapses, and NPC moves); a load (L) stops the
  run.
- **Target selection is positional** (Session 015): `scenarioTarget`
  returns the first suitable entry of the (rotated, nearest-first
  sorted) buildings array — never a re-derived proximity scan, which
  would ignore the rotation and always restage the same global-nearest
  building (the original string-keyed comparator even sorted
  `"100,…"` before `"8,…"`, staging scenarios ~100 cells out).

## Scripting (Phase 19)

- **The engine** (`src/script/engine.ts`, pure) runs continuous rules
  over the live world — the generalization of the scenario engine's
  shape. A `ScriptDef` holds triggers; a trigger fires when a matching
  bus _event_ arrives (`on`: type + optional radius/box filter, fired
  synchronously inside `onGameEvent` in bus emission order) or when a
  _condition_ (`when`) rises from false to true (evaluated per tick in
  script-load then declaration order). Both kinds pass through the same
  gates: `if` (fire-time gate — false swallows an event trigger's
  event), `cooldown` (ticks between fires), `maxFires` (lifetime cap).
  Actions are plain calls on the same `ScenarioIo` the scenarios use
  (journaled edits, ignite, weather, spawns, announcements).
- **Variables and timers are engine-level** (they outlive script
  reloads; `clear()` resets everything): a shared number-valued
  variable store, `after(ticks, run)` one-shot and `every(ticks, run)`
  repeating timers with cancel handles. Per-tick order: due timers
  (creation order) → condition triggers. The event log (capped 512,
  recorded only while any script is loaded) backs the same query family
  the scenario context has (`events/eventsNear/eventsInBox/
lastEventTick/eventsQuiet`) plus the budgeted `countInBox`.
- **main.ts wiring**: the engine attaches the scenario io once (event
  triggers fire between ticks, so they need a stored io — bus emissions
  carry none); `bus.onAny → onGameEvent`; `scripts.tick(scenarioIo)`
  runs just before the scenario tick (a script reacting to this step's
  events stages the world; the scenario tick, last as ever, sees the
  result). Scripts are creator logic, not world state: a load (L) does
  not stop them. The surface is programmatic (`__mw.scripts`:
  load/unload/clear/after/every/variables) — the console UI is future
  work. Deterministic: no RNG, fixed iteration order (ADR-005).

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
- `findSpawn` scans outward ring-by-ring for the first dry column. The
  shipped game spawns through `findTownSpawn` (src/worldgen/town.ts):
  the same deterministic point, nudged to open ground when a building
  pad, doorstep, or tree claims it — and the chunk generator composes
  `generateChunk` + `applyTown` (see "Procedural town").

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
  interplay), town (plan/lot round-trips, determinism, building
  invariants, bridges, trees, anchors, materials), navigation + NPC +
  reactions, utilities (grid light/cut/mend, brownout order,
  independent networks, silent discovery, rescan; pressurized mains,
  leaks, taps, severed-side isolation, pour rules), town utilities
  (every generated lamp lit on two seeds, plant anatomy, pole anatomy,
  continuous pressurized main, burst-and-rip end-to-end), atmosphere
  (clock/seasons, stepping ≡ syncTo determinism, weather reachability +
  smoothness + force, deterministic lightning, sun noon/midnight,
  seasonal sun/daylight, snow-vs-rain, palette shapes, fire×rain
  douse/roof/refuse/force, NPC clock injection + night sight), and light
  (sky columns + free-fall shafts, lateral attenuation, water/glass
  opacity, block sources add/remove/occlude/combine, static emission on
  both paths, cross-chunk flow, uninitialized default, incremental ≡
  full recompute over 60 random edits, determinism, budget, mesher
  light/AO attributes and merge signatures).
- Benchmarks: `benchmarks/mesher.bench.ts` (naive vs greedy, solid/
  checker/layered/terrain), `benchmarks/storage.bench.ts` (dense vs
  packed), `benchmarks/terrain.bench.ts`, `benchmarks/destruction.bench.ts`
  (blast fields, support checks), `benchmarks/fluid.bench.ts` (budget
  tick, flood scenarios), `benchmarks/fire.bench.ts` (budget tick, fire
  front, full burn-out scenario), `benchmarks/structure.bench.ts`
  (house-scale gate, worst-case solid region, overstress tower, full
  collapse cascade), `benchmarks/town.bench.ts` (generation overlay,
  plan, census), `benchmarks/npc.bench.ts` (re-path, population tick),
  `benchmarks/utilities.bench.ts` (grid rebuild gate, main rebuild,
  pour cadence, route scan), `benchmarks/atmosphere.bench.ts` (per-tick
  atmosphere cost, full-year syncTo, fire tick clear vs storm),
  `benchmarks/light.bench.ts` (chunk arrival, incremental street edit,
  100-lamp fill, mesher with/without light+AO). Baselines
  in `docs/performance.md`.
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
