# HANDOFF — Session 005 mid-stream (2026-09-10)

**Status: Phase 9 (Water) is ~90% implemented and GREEN — 239 unit tests
pass (was 205), but NOTHING IS COMMITTED YET (YES IT WAS, committed by user and pushed - to work from other laptop) and three verification steps
remain (benchmark run, typecheck/lint/build re-run, browser pass + docs).**
All work is in the working tree. Canonical long-term state lives in
`MICRO_WORLD_PROGRESS.md`; this file is the pickup map.

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

## What is done (all tested, 239/239 green via `npm test`)

- **Pure fluid sim — `src/voxel/fluid.ts` (new).** `FluidSim`: per-cell
  water level 0–255. **255 = source** = plain WATER material with NO
  sparse-map entry (the default read), so terrain lakes and player-placed
  water are sources with zero fluid-side setup; **1–254 = flowing** water
  in a sparse `Map<chunkKey, Map<voxelIndex, level>>` with a one-slot
  memo. Rules per active cell: gravity (dump down to 254 cap) then
  horizontal equalization in fixed neighbor order (transfer
  `diff>>1` when diff ≥ 2 — never oscillates). Sources keep 255 and push
  mass outward; flow can never create a source. Sleep/wake: only cells in
  the `active` set (packed-int keys) simulate; any change re-wakes the
  ±1 neighborhood; `tick(budget)` caps cells/step (game uses 384/step);
  `settle()` for tests. Mass conservation is exactly tested.
- **World hooks — `src/voxel/world.ts`.** New optional
  `world.onVoxelChanged(x,y,z,material)` (fires after every successful
  `setVoxel` — edits, undo/redo, sim writes; FluidSim deletes the level
  when a cell stops being water = displacement/vaporization, and wakes
  the neighborhood) and `world.onChunkReady(chunk)` (fires at the end of
  `ensureChunk` after journal replay; FluidSim wakes water inside the new
  chunk + the 6 face-adjacent boundary planes so a source parked at the
  streaming frontier resumes flowing). NOTE: `loadEdits` uses
  `setByIndex` directly → deliberately fires NO hooks (boot restore is
  quiet); `EditHistory.undo/redo` uses `setVoxel` → hooks fire ✓.
- **Flow-height rendering.** `greedyMesher.ts` takes an optional third
  arg `waterLevel(x,y,z)` (volume-LOCAL coords). Surfaced partial cells
  (air above, level < 255) get a merge signature
  `AUX_SURFACED|(level<<5)|cellY`; full cells and submerged cells merge
  at signature 0 (lakes stay cheap, face set unchanged — equivalence
  tests still pass). `emitQuad` writes a per-vertex `waterDrop`
  ((255−level)/255) on top-edge vertices (not on −Y faces) → new optional
  `MeshData.waterDrop` → bound in `voxelGeometry.ts` → the water
  material's new `WATER_VERT` sinks `p.y -= waterDrop`. LOD1 water
  renders full cubes (no level query passed — by design).
  **Fixed during test: `aux >> 5` leaked the surfaced bit → now
  `(aux >> 5) & 0xff`; and no-query/level≥255 must return aux 0 or lake
  quads fragment.**
- **Swimming — `src/player/controller.ts`.** `PlayerState.inWater` +
  `climbBoost`; `stepPlayer` gained optional 5th arg
  `waterAt(x,y,z)→level`. Probes: feet+0.2 and eye vs surface
  `cy + level/255`. In water: gravity 5, drag 3.2/s, sink cap 2.2, swim
  up 3.4 (accel 18), horizontal ×0.55. Wall assist: in water + moving
  into a wall + jump → `vy = WATER_CLIMB_SPEED (9)` + `climbBoost` flag
  that survives the swim cap for one step (without it the boost was
  capped to 3.4 and a 1-voxel shore above the waterline was
  unreachable — test-tuned; ballistic rise v²/2g ≈ 1.7 m). Without
  `waterAt` the player ignores water exactly as before (legacy tests
  untouched and green).
- **Interactions.** `damage.ts` `explode` now **vaporizes** water (edits
  to AIR, no debris, not counted in `destroyed`) — surrounding sources
  then flood the crater back. `brush.ts`: place tool fills into water
  (displacement) and WATER is a placeable brush material (creates
  sources); paint/replace still skip water cells; delete removes water.
  `main.ts`: RMB placement into WATER allowed + ghost shows there.
- **Persistence v2 — `persistence.ts`.** `WORLD_FORMAT_VERSION = 2`;
  `SerializedWorldV2.waterLevels: Record<chunkKey, [voxelIndex, level][]>`
  (sparse — only flowing 1–254; sources/terrain lakes need no entries);
  migration v1→v2 injects `waterLevels: {}`; `validateV2` rejects
  malformed entries (non-integers, <1, >254). `serializeWorld` gained an
  optional 4th param (defaults `{}` — old callers unchanged).
  `FluidSim.exportLevels()/loadLevels()` are its (de)serializer.
  `main.ts` save/load/boot-restore all carry levels; flowed water marks
  the autosave dirty via `fluid.takeDirty()`.
- **Inspector/HUD.** `inspectVoxel` optional `waterLevel` param → HUD
  shows `water N/255`; HUD line shows `swimming` and `water <active>`
  when the sim is churning. Dev `__mw` hook now exposes `fluid`.
- **Tests (22 files, 239 pass).** NEW `tests/fluid.test.ts` (24: key
  packing, source vs flowing, gravity/equalization/254-cap/shaft,
  exact mass conservation in closed basins, solid containment,
  cross-chunk flow with conservation, streaming-frontier wake, source
  flood + exact −255 on source removal, sleep/wake, budget, displacement,
  export/load round-trip incl. later-generated chunks, determinism,
  dirty flag). `greedyMesher.test.ts` +3 (drop values, top-edge-only,
  levels never change the face set). `controller.test.ts` +4 (inWater
  flag + sink cap, rise/release cycle, climb-out onto a deck, no-query
  legacy). `damage`/`creatorBrush`/`persistence` tests updated to the
  new water semantics (+ v2 migration/validation/round-trip cases).
- **`benchmarks/fluid.bench.ts` (new, written but NOT yet run** — the
  run was interrupted: 384-cell budget tick, mid-spread churn ×10,
  source-flood settle, terrain-lake chunk wake).

## What is NOT done (pick up here)

1. **Run the benchmark:** `npx vitest bench benchmarks/fluid.bench.ts
   --run` → record numbers in `docs/performance.md`. Watch: if a
   384-cell tick is >2–3 ms, lower `FLUID_CELLS_PER_TICK` in main.ts
   (currently 384) or optimize `levelAt` (string chunk keys are the hot
   cost). Two fluid tests are slowish (~2.3 s settle each) — fine.
2. **Re-run gates:** `npm run typecheck`, `npm run lint`, `npm run
   build`. Typecheck was clean mid-session but the last edits (climb
   boost, mesher bit-mask fix) came after; lint/build untouched this
   session. Prettier may want to reflow the edited files (`npm run
   format`).
3. **Browser verification.** `.verify/run.mjs` (local, gitignored)
   exists from Session 004; needs `npm i --no-save playwright` if the
   package is gone. Add a water scenario: place a source via
   `__mw.world.setVoxel(x,y,z,6)` (WATER id 6) on a pillar/rim, drive
   `__mw` frame steps, assert spread + mass via `__mw.fluid.levelAt`;
   screenshot a lake with the flow-height shader (partial cells from a
   bucket dump). Existing scenarios must stay green (explosion now
   vaporizes water — the pavilion gate is on land, unaffected).
   The manual GUI pass for Phases 7–8 is still open too.
4. **Docs:** `docs/architecture.md` (new "Water" section: sim, hooks,
   mesher drop attribute, swim constants, save v2),
   `docs/performance.md` (fluid baselines), `docs/known-issues.md`
   (REWRITE the "Water is a placeholder" bullet; new sharp edges below),
   README (Phase 9 controls unchanged — water via hotbar 6 + brushes),
   CHANGELOG entry.
5. **`MICRO_WORLD_PROGRESS.md`:** Session 005 log + tick the Phase 9
   checklist (see mapping below) + Current Status block.
6. **Commit** — suggest one commit for the whole phase
   (matches previous per-phase history).

## Phase 9 checklist mapping (for MICRO_WORLD_PROGRESS.md)

Done: fluid cell ✓, water placement ✓ (WATER material = source; brush +
RMB + hotbar 6), gravity ✓, horizontal flow ✓, boundaries ✓, mass
conservation ✓, chunk boundaries ✓, water rendering ✓ (flow-height;
LOD1 = full cubes), fluid benchmark ✓ (file exists — mark done after
running + recording).
Deferred (write these down as deferred): **pressure** (no up-flow/
pressure propagation — water only stacks when cells below are full;
Phase 10+ or a later pass), **worker fluid** (budget keeps it on-thread),
**GPU fluid** (research task), fluid debug visualization (HUD counters +
inspector level exist; no dedicated overlay).

## Known sharp edges to document (known-issues.md)

- Water is **not raycast-targetable** (you edit through lakes —
  intended); placing into water cells works via the ghost adjacency.
- **No pressure/up-flow**: water cannot rise above its source level
  (u-tubes don't equalize). Sources flood until every reachable cell at
  or below them is full.
- Flowing water equalizes to ±1 level per cell pair (integer `diff>>1`)
  → puddle surfaces rest slightly uneven (cellular look, by design).
- LOD1 water = full-height cubes (levels ignored at distance).
- Unloaded-chunk writes fail silently → water waits at the streaming
  frontier until `onChunkReady` wakes it (tested).
- Terrain lake chunks wake their water once on generation (one-time
  churn, no persistent cost — sources against sources sleep in 1 tick).
- Undo/redo restores water materials via journal + levels via
  `previous` values… **NOTE: undo restores the WATER material but the
  fluid's sparse level for that cell is deleted by the hook on the
  forward edit; on undo the cell reads as a SOURCE (255)**. Undoing a
  "bucket dump" therefore leaves sources, not the original partial
  levels. Acceptable-for-now (believable; undo is not a fluid-state
  time machine) but worth a line in known-issues. If unwanted: capture
  levels in EditCommand later.
- `main.ts` still has `editTargetable` excluding WATER ✓ intended.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install` (should be
   no-op); `npm test` → expect 239 green; `npm run dev`, `?seed=1234`
   fresh world → lakes render, swim with Space, sink slowly, climb
   shores holding Space against the bank; place water with hotbar **6**;
   dump a bucket (place water in air) and watch it fall/spread; explode
   a crater at a lake edge → refills.
2. Do the NOT-done list top to bottom (benchmark → gates → browser →
   docs → progress file → commit).
3. Then **Phase 10 (Fire)** per the plan: temperature/fuel/spread with
   `hardnessOf`-style derived tables; the event bus and water coupling
   (extinguish) are the integration points. Phase 11 replaces the
   support-check approximation.

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`,
  `src/player/controller.ts`) stays free of three.js and DOM (ADR-002);
  all three.js lives in `src/render/`; DOM adapters in `src/player/`,
  `src/persistence/`, `src/audio/`.
- Terrain generation stays a pure function of (seed, coordinates);
  `hash2` frozen; `hash3` is the extensible variant.
- Material IDs are a serialization contract: don't renumber. Derived
  tables (hardness) stay out of the serialized schema.
- Save formats version up through a migration chain (now at v2);
  prefab format v1 validates structurally.
- Mesher changes must keep the greedy↔naive equivalence tests green
  (still true with the waterDrop attribute — it is additive).
- Every destructive/creative gesture is one grouped `applyEdits`
  command. Fluid writes go through `World.setVoxel` directly (journaled
  + remeshed) but deliberately NOT through applyEdits — water flow is
  simulation, not user edits (would flood undo history).
