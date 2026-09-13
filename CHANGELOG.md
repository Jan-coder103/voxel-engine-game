# Changelog

All notable changes to MICRO//WORLD are documented here.
Format loosely follows Keep a Changelog; versioning is informal until
the first external release.

## [0.15.0] — 2026-09-13 — Phase 17 (Light: the voxel light field)

### Added

- **Voxel light field** (`src/voxel/light.ts`, pure): two per-voxel
  channels, Minecraft-shaped. **Sky light** 0–15 — full column above ⇒
  15, free straight-down propagation through air, −1 lateral steps,
  water −2 / glass −1 (leaves block: tree shade; roofs: dark rooms).
  **Block light** 0–15 from point sources — lit lamps follow the power
  sim's lit set and burning cells the fire sim's (main diffs both into
  idempotent `setSource` calls, gated on power revision / burning
  count); self-luminous machines via a derived `MATERIAL_EMISSION`
  table (generators glow). Storage is two lazily-allocated `Uint8Array`s
  per chunk (unloading frees it); uninitialized chunks read as full sky
  so streaming never renders dark.
- **Incremental two-queue BFS** on the World hooks, budgeted 1200
  pops/tick (fluid-sim pattern): voxel changes remove stale light
  (free-fall cascade down sky columns, brighter borders re-seeded),
  re-walk the edited column, re-add from seeds; chunk generation fills
  columns directly, seeds borders, column breaks, and the lit-boundary
  pass (any lit cell bordering a dimmer transparent cell) so
  streaming-order-independence holds. Light changes mark chunks mesh
  dirty — remeshing rides the existing frame budget. Property-tested:
  incremental ≡ from-scratch field after 60 random edits on both
  channels.
- **Mesher light + AO**: `meshVolumeGreedy` samples the packed light at
  each face's air cell (part of the merge signature — quads never smear
  bright into dark) and emits classic 3-sample per-corner vertex AO for
  opaque passes, as `aLight` (vec2) / `aAO` (float) vertex attributes.
  Face set unchanged — greedy↔naive equivalence tests untouched.
- **Shader**: sky access modulates the outdoor terms
  (`(ambient + sun) × sky × ao`, 0.05 floor keeps caves readable) and a
  warm `uBlockColor` term carries lamp/fire light. Lamps finally
  illuminate the streets at night; fire lights its surroundings; the
  Phase 15 glow shells get a real light source behind them.
- **Tests**: 19 new (420 total, 32 files) — sky columns/shafts,
  overhang shading, water/glass attenuation, source
  add/remove/occlude/combine, static emission (placed + generated),
  cross-chunk flow, uninitialized default, incremental ≡ recompute
  gold test, determinism, budget, mesher light/AO attributes +
  signature splits.
- **Benchmarks** (`benchmarks/light.bench.ts`): town-chunk arrival
  ≈ 13 ms (generate + init + settle), settled incremental street edit
  ≈ 178 ms of BFS total (budgeted < 1 ms/tick in game), 100-lamp fill
  ≈ 443 ms progressive, mesher light+AO delta +7% (3.42 → 3.67 ms).
  Baselines in `docs/performance.md`.
- **Harness** (`.verify/run.mjs`): Phase 17 section (5 checks: sky
  columns, night lamp light, roofed-room dark + relight, fire light,
  clock restore) — written and `node --check`ed this session; **runs
  deferred** under the VM-load policy (see HANDOFF).
- **Debug hook**: `__mw.light` (the field: `skyAt`/`blockLightAt`/
  `packedAt`/`setSource`/`pendingCount`), `__mw.skyAt`/`blockLightAt`
  shorthands, and `__mw.scene` (render-side probes).

### Fixed

- **Stale removal entries could permanently dim re-lit columns** (found
  by the gold property test): a removal entry queued before a column
  walk re-set the cell's sky 15 cascaded later and killed the fresh
  value (refilled laterally at −1 per step). Removal pops now re-check
  the cell's current level and re-seed instead of cascading when the
  removal went stale.
- **Cross-chunk column blockers leaked phantom sky light at streaming
  order boundaries** (gold test): a chunk generating above/beside
  initialized chunks demotes the topmost orphaned 15 below new blockers
  (the cascade eats the column downward) and the lit-boundary pass
  feeds shadows beside its open columns.

### Changed

- Save format untouched (v2): light is derived state — loads
  `reset()` + `rescan()` and re-sync lamp/fire sources.
- `Chunk` carries optional `lightSky`/`lightBlock` arrays; `MeshData`
  gained optional `light`/`ao` arrays; the voxel shader grew the
  `aLight`/`aAO` attributes and the `uBlockColor` uniform.

## [0.14.0] — 2026-09-13 — Phase 16 (Atmosphere)

### Added

- **World clock + sky** (`src/sim/atmosphere.ts`, pure): 100 ticks/hour
  (day ≈ 40 s real), 8-day seasons over a 32-day year with blended
  transitions (day 0 is pure spring — the day-0-inherits-winter bug is
  pinned by the dawn→noon harness check), sun and moon arcs with exact
  elevation math, per-season max elevation / daylight / temperature
  proxies. Same (seed, tick) → same sky, always; stepping ≡ `syncTo`
  (a full-year fast-forward costs ~0.01 ms). Clock constants moved here
  (`src/npc/npc.ts` re-exports — old imports keep working); fresh
  worlds start day 0, 08:00. Transient by design: not in the save
  format; the L-key load does not reset the clock.
- **Weather machine**: seeded Markov segment chain (clear → cloudy →
  overcast → rain → storm, back-edges included) with hash-derived
  holds/fades and smooth profile blending (cloudiness, precip, wind,
  fog, darkness); sub-freezing precip renders as snow. `forceWeather`
  is an instant debug/scenario override.
- **Lightning**: per-tick hash gate while storming fires `onStrike(x, z)`
  near a caller-set center — main flashes the sky, booms, and
  force-ignites the top solid cell. Pure core stays voxel-free.
- **Sky palette** (`skyPalette`, pure hex math): zenith/horizon/fog/sun
  colors + intensities, ambient, star/moon/sun-disc levels; clear noon
  reproduces the pre-atmosphere look.
- **Render** (`src/render/atmosphereViz.ts`, `src/render/rainfx.ts`):
  camera-following sky-dome shader (gradient, sun disc + halo, moon,
  hash stars, 3-octave fbm clouds scrolling with the wind, lightning
  flash; fbm skipped when coverage ≤ 0.2 — SwiftShader CPU-rasterizes
  every pixel) plus palette application to the voxel shader uniforms
  (sun/ambient/fog; night re-aims the sun term at the moon with a faint
  blue tint); pooled instanced rain-streak / snow-flake system.
- **Couplings**: NPC schedules follow the world clock (injected
  `clock` option; `reset()` re-reads it so time survives a load) and
  night shrinks sight range to ~⅓ via the injected `lightLevel`
  (`canSee` gained an optional range). Fire reads rain: sky-exposed
  burning cells soak wet (~60 ticks of full rain) then extinguish with
  cause `'rain'`, roofed cells survive, exposed heat decays 2×, and
  `ignite()` refuses exposed cells in any rain unless forced
  (lightning forces; storm fires still struggle against the wetting).
  `fireExtinguished.cause` gained `'rain'` (additive union growth).
- **Tests**: 22 new (401 total, 31 files) — clock/seasons, determinism
  (stepping ≡ syncTo at a deep mid-chain point, seed divergence),
  weather reachability/smoothness/force, deterministic lightning,
  sun/noon/midnight, seasonal discriminators, snow-vs-rain, palette
  day/night/dawn/storm shapes, fire×rain (douse cause, roofed survival,
  refused vs forced ignition), NPC clock injection + night sight.
- **Benchmarks** (`benchmarks/atmosphere.bench.ts`): atmosphere tick
  0.025 ms mean (runs every fixed step), full-year syncTo 0.010 ms,
  fire 256-cell tick 2.67 ms clear vs 4.45 ms storm (sky-exposure
  scans; VM numbers). Baselines in `docs/performance.md`.
- **Harness** (`.verify/run.mjs`): Phase 16 section (8 checks) — clock
  HUD, dawn→noon sun climb, midnight dark + stars, NPC clock parity,
  winter snow, dry re-ignition after rain, storm dousing + precip +
  rain drops, lightning flash + ignition.

### Fixed

- **`syncTo` infinite loop**: the fast-forward advanced the weather
  chain keyed on the target tick while `advance()` walks against
  `timeTicks` — which syncTo set only after the loop. Found by a
  vite-node probe after vitest workers spun at 99% CPU with zero tests
  completing; regression-covered by the stepping ≡ syncTo test.
- **Day 0 inherited the previous season's sun**: the season blend
  samples "previous season" at 0 on a season's first day, so the
  world's first noon read winter elevation 0.62 rad. `day === 0` now
  blends to 1 (pure spring); found by the first full harness run.

### Changed

- HUD line 2 leads with `HH:MM day N · weather`; `__mw.atmosphere`
  exposes `state`, `clock()`, `setTime` (syncTo), `force`, `strike`,
  and the viz. Phase 12/13 harness night-checks repointed from
  `npc.timeTicks` pokes to `atmosphere.setTime` (the injected world
  clock correctly overwrites the raw poke now).

## [0.13.0] — 2026-09-11 — Phase 15 (Utilities)

### Added

- **Power grid** (`src/voxel/power.ts`, pure): connected components of
  copper / lamp / generator cells, rebuilt locally on the World change
  hook (structure.ts pattern — budgeted, one rebuild per tick, hard
  cell cap). A component with a generator is powered; overload browns
  lamps out farthest-first in deterministic BFS order. `powerLost` /
  `powerRestored` events fire per lamp flip on edit-triggered rebuilds
  (chunk-ready discovery scans apply state silently).
- **Plumbing** (`src/voxel/plumbing.ts`, pure): connected components of
  pipe / pump / tap cells. A water-fed pump pressurizes its network;
  while pressurized, a destroyed pipe cell re-fills with real Phase 9
  water (`FluidSim.pour`) every `POUR_PERIOD` ticks and pressurized
  taps pour beside themselves. Severed sides rebuild as independent
  components — the far side of a cut genuinely goes dry/dark. Pump
  destroyed → leaks stop, taps dry.
- **Generated utilities** (`src/worldgen/utilities.ts`, pure): buried
  copper cable under every road-line center column (with terrain
  stair-step fills), metal lampposts every 8th center column, one
  generator on a copper vault at the town's central intersection (on
  the bridge deck when that crossing is water), and a water main from
  a submerged pump at the nearest lake to a standpipe tap by the town
  center (edge lane, diving under cable crossings, posts under water).
  Six appended materials (12–17: copper, lamp, generator, pipe, pump,
  tap) with derived-table entries — save format untouched.
- **NPC outage reaction** (the Phase 13 anticipated case): a lamp
  dying within 10 cells draws a small fear spike and an investigate.
- **Lit-lamp glow** (`src/render/powerViz.ts`): pooled InstancedMesh
  shells over lit lamps, revision-gated (no dynamic lights yet).
- **Tests**: 32 new (379 total, 30 files) — grid light/cut/mend,
  brownout order, independent networks, silent discovery, rescan,
  oversize-component skip, determinism; pressurized mains, taps,
  burst/rip end-to-end, severed-side isolation, pour rules, plus the
  fluid-memo regression; generated-town invariants on two seeds
  (every generated lamp lit incl. a deck-mounted plant, pole/plant
  anatomy, continuous pressurized main, burst floods / pump stops it).
- **Benchmarks** (`benchmarks/utilities.bench.ts`): full town-grid
  rebuild ≈ 12 ms (this VM; cut+mend pair per iteration), main rebuild
  ≈ 0.17 ms, pour pass ≈ 0.002 ms, route scan 0.08 ms. Baselines in
  `docs/performance.md`.

### Fixed

- **Fluid level memo could dangle (Phase 9 latent bug)**: a
  `deleteLevel` miss on a chunk with no level map left a stale
  (key, undefined) memo, so the first later write into that chunk
  skipped the memo refresh and every read saw a phantom source (255).
  Found by the plumbing pour path; regression-tested.

### Changed

- Sims now read through `makeCachedReader` (`src/voxel/cachedReader.ts`)
  during component floods — the World's one-slot chunk memo thrashes
  under BFS locality (~0.9 µs/read); the cached reader cut a full
  town-grid rebuild from ~30 ms to ~12 ms on the dev VM.
- NPC `notify` accepts `powerLost`; HUD gains `· lamps N` and
  `· leaks N` lines; `__mw` exposes `power`, `plumbing`, `powerViz`,
  and `utilities` (generator site + pipeline route).

## [0.12.0] — 2026-09-11 — Phase 14 (Procedural Town)

### Added

- **Procedural town generation** (`src/worldgen/town.ts`, pure): a
  seeded 96-cell town square over the terrain generator — roads on a
  24-cell grid (3 wide, per-seed offsets), 10×10 lots between them,
  wild land outside. Everything is a pure function of (seed,
  coordinates): no town state, chunks regenerate identically, and the
  save format is untouched (buildings are generation; the edit journal
  persists player changes on top, as always).
- **Bridges**: road columns in water become wooden decks one block
  above the waterline on posts to the lakebed every other cell —
  structurally real, so a burned post drops its span of deck into the
  lake through the existing support graph.
- **Buildings**: parameterized generators (plan §60 shape) — wood
  houses (~60% of built lots, some two-story with a slab floor,
  stairwell openings, and a four-step walkable interior staircase),
  brick shops with flat parapet roofs and counters, concrete industrial
  buildings with slab roofs and crates. Doors (2-cell openings), glass
  windows on a rhythm, concrete cut/fill pads, hash-placed furniture.
  Footprints and roof spans stay inside the structural cantilever
  budget, so fires and blasts collapse them believably instead of
  instantly.
- **Vegetation**: lattice-gated wild trees (trunk + canopy, leaves
  fill only air) and yard trees on park lots. New `leaves` material is
  fast-burning fuel (fire ecology to come).
- **Materials** (append-only, ids 7–11): asphalt, concrete, brick,
  glass (solid pane), leaves — with derived hardness/fire/strength
  entries. Old saves' 7-material snapshots still validate; no format
  bump.
- **NPC town life**: `townAnchors` feeds every building's door-front
  cell to the sim as home/work candidates — figures hash-pick among
  the six closest doors within 48 cells (ring fallback for wilderness),
  spawn candidates above natural terrain (roofs, canopies, decks) are
  rejected, and the spawn point moves off building pads
  (`findTownSpawn`).
- **Benchmarks** (`benchmarks/town.bench.ts`): towned chunk overlay
  0.92 ms mean (p75 1.07) on top of ~0.6 ms terrain; plan query
  ~0.02 ms/256 columns; one-time census ~2.5 ms. Baselines in
  `docs/performance.md`.
- **17 tests** (`tests/town.test.ts`, 347 total): plan round-trip,
  determinism (same-seed checksums, different-seed towns), regeneration
  survival, footprint/door/window/roof invariants, water-exclusion,
  staircase walkability, bridge decks + posts, vegetation rules,
  spawn safety, NPC anchor assignment + determinism, `groundY` spawn
  rejection, edit-on-town persistence, material id stability +
  backward-compatible snapshots.

### Changed

- Chunk generation composes terrain + town (`generateChunk` +
  `applyTown`); main spawns via `findTownSpawn`; hotbar grows to 11
  placeable materials (digits 1–9 + wheel).
- HUD/debug: `__mw.town` exposes anchors, census, and `planAt` to the
  verification harness.

## [0.11.0] — 2026-09-11 — Phase 13 (NPC Reactions)

### Added

- **Perception** (`src/npc/perception.ts`, pure): `canSee` — range
  (24 cells) × horizontal FOV (130°) × voxel line of sight (the Phase 5
  DDA reused with a solids-block-sight predicate; water never blocks,
  and the ray stops short of the target so a burning block doesn't
  occlude itself); hear-radius formulas per event kind (explosion
  `radius·4 + 20`, collapse `min(60, 20 + 2·√cells)`); and a capped,
  deduplicated, expiring `ThreatBoard` — the sim's short memory of
  where bad things happened (one spreading blaze is one threat).
- **Reactions** (`src/npc/npc.ts`): fear (0–100) per figure with a
  panic threshold — above it the schedule is overridden by **`flee`**
  (run away from the nearest remembered threat at 1.6× speed, with
  per-figure deterministic jitter, sleep interrupted, cower-and-retry
  when cornered) or **`investigate`** (walk toward a heard noise, stand
  and look, resume). Figures _see_ remembered threat sites on staggered
  scans and only panic at what they see up close (alarm radius 12), so
  an investigator walks to the site, gets a good look, and then spooks —
  the plan §42 chain: investigate → see destruction → fear → flee.
  Fear decays ~0.1/tick; figures calm down and resume their lives.
- **Explosion damage to NPCs**: distance falloff inside `radius + 3`,
  lethal within the crater's inner half, quarter damage when a wall
  blocks line of sight. Death despawns the figure and emits a new
  **`npcDied`** bus event (`cause: 'explosion' | 'drowned'` — the
  Phase 12 water-sweep now reports too) for Phase 17+ audio/scripts.
  Malformed (non-finite) events are dropped at the door — NaN survives
  `Math.min`/`Math.max` and would permanently poison figure state.
- **Flood response**: no bus event needed — the staggered perception
  scans check the feet cell + 4 neighbors for water; water at the feet
  is a +60 fear spike and flight. The same scans wake sleepers for any
  threat within 5 cells.
- **Game wiring**: `npc.notify` subscribes to the bus's
  `explosion`/`structureCollapsed`/`fireIgnited`; `npc.onEvent` flows
  back out to the bus; fleeing figures render red and investigating
  figures teal in the pooled InstancedMesh; a `· panic N` HUD line
  appears while anyone is fleeing; the `bus` joined the `__mw` debug
  hook.
- Tests: `tests/npcReactions.test.ts` — 21 tests (330 total): LOS
  (walls block, water doesn't), FOV, threat board
  (dedupe/expiry/cap), epicenter kill + `npcDied`, wall-shielded
  damage, flee-distance + calm-down, sleeper wakes (blast + fire),
  collapse panic vs. investigate, fire seen/unseen, flood flight,
  malformed-event immunity, cross-sim determinism with events, and a
  3000-tick disaster fuzz with invariants.
- Benchmarks: population tick with active threats 0.12 ms mean
  (p75 0.02); explosion notify ≈ 2 ms once per blast —
  `docs/performance.md`.
- Headless browser verification: new Phase 13 section on the Phase 12
  page — explosion kill through the real bus wiring, survivor panic +
  HUD `· panic`, flee distance gained, wall shield, sleeper wake,
  collapse investigation, flood flight, fear decay.
- Docs: architecture "NPC reactions (Phase 13)", known-issues NPC
  section rewritten for Phases 12–13, NPC baselines, README state and
  layout, this file.

### Fixed

- Harness-only run exposed a real robustness hole: a malformed event
  with NaN coordinates wrote NaN into every figure's fear (NaN is
  sticky through `Math.min`/`Math.max`), permanently disabling
  reactions. `NpcSim.notify` now rejects non-finite event positions
  (regression-tested).

## [0.10.0] — 2026-09-11 — Phase 12 (NPCs)

### Added

- **NPC simulation** (`src/npc/npc.ts`, pure): a deterministic
  population of up to 16 wandering figures around the player —
  schedule-driven days on a tick-count clock (100 ticks/hour, 40 s per
  game day): nights and exhaustion send figures home to sleep until
  dawn or rested, work hours send most decisions to a work anchor, the
  rest is hash-scattered wandering. Needs accumulate deterministically
  (sleep gates behavior; hunger rises with no consumer yet — no food
  exists). One physical rule: a figure whose support vanishes (collapse,
  dig) falls with gravity and re-paths on landing; landing in water
  despawns it. No sequential RNG — every choice hashes
  (id, salt, tick, seed), so identical tick sequences are bit-identical.
- **Navigation** (`src/npc/navigation.ts`, pure): walkable-cell queries
  (open headroom ×2 + solid floor, water not walkable) and A\* over the
  implicit grid graph — moves are flat, +1, or drops up to `MAX_DROP`
  (3) with a lip-clearance rule; Manhattan heuristic, insertion-order
  tie-breaks, `maxExpansions` budget (the sim decides with 512, so a
  hopeless search costs ~5 ms). Local invalidation (plan §40): the sim
  observes `World.onVoxelChanged` and re-paths only paths severed by an
  edit (cell or floor touched), budgeted at `DECIDES_PER_TICK = 3`
  searches per fixed step.
- **NPC figures** (`src/render/npcViz.ts`): one pooled InstancedMesh of
  capsules tinted by activity (wander green, goto yellow, idle slate,
  sleep dark blue; sleepers lie down), driven per frame from the sim.
- **Game wiring**: the sim joins the fixed step (after the structural
  sim), population centers on the player, `· npc N` joins the HUD, and
  `npc`/`npcViz` are exposed on the `__mw` debug hook. NPCs are
  transient by design — not in the save format; a reloaded world
  repopulates deterministically.
- Tests: `tests/navigation.test.ts` + `tests/npc.test.ts` — 31 tests
  (309 total): walkability/anchoring, routing (walls, ledges, cliffs,
  water, lip clearance, budgets, determinism), path-invalidation
  helper, real-terrain paths; spawn/clock, needs, schedule transitions
  (night sleep at home → dawn wake, exhaustion bedtime, wandering),
  wall-rise re-pathing, collapse fall, water sweep, population
  fill/despawn, cross-sim determinism, and a 5000-tick invariant fuzz.
- Benchmarks (`benchmarks/npc.bench.ts`): mid-distance re-path ~1 ms;
  sealed-goal worst case ≈ 5 ms at the 512-expansion budget; full
  population tick 0.03 ms mean. Baselines in `docs/performance.md`.
- Headless browser verification: new Phase 12 section on `?seed=24680`
  — 10 checks, all green, zero page errors: population fills, HUD
  counter, upright invariants, live wandering, instanced rendering,
  night → sleep at home, dawn wake, collapse fall.
- Docs: architecture "NPCs (Phase 12)", NPC baselines, known-issues
  "NPCs (Phase 12)" section, README state/layout, this file.

### Fixed

- `nearestWalkable` y-window widened ±2 → ±4 so slope anchoring finds
  stands on modest terrain steps (found by the fixture tests).

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
