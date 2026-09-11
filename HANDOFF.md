# HANDOFF — Session 010 wrap (2026-09-11)

**Status: Phase 14 (Procedural Town) is COMPLETE — implemented, verified,
documented, and committed. 347 unit tests green; typecheck/lint/prettier
clean; build succeeds. The headless browser suite's Phase 14 town section
is 8/8 green (final runs), zero page errors. Canonical long-term state
lives in `MICRO_WORLD_PROGRESS.md` (Session 010 log + Current Status);
this file is the short pickup map.**

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

**⚠ The headless harness needs Playwright inside `.verify/`** (it has its
own `package.json` + `node_modules` now, gitignored):
`cd .verify && npm install playwright@latest` restores it. Do **not**
install it at the repo root — `npm install` there walks up and pollutes
the repo's package.json (this happened once this session; reverted).

## What landed this session (Phase 14 — Procedural Town, plan §112)

1. **`src/worldgen/town.ts`** (pure): a seeded town over the terrain
   generator, no state anywhere — `planAt(x, z)` classifies road / lot /
   wild in O(1); roads on a 24-cell grid (3 wide, per-seed offsets) in a
   96-cell square; 10×10 lots; **bridges** (wood deck at sea level, posts
   every other cell — structurally real: burn a post, the deck drops);
   parameterized buildings (`lotSpec` → `BuildingSpec`: house/shop/
   industrial, 6–8 footprint, door side/pos, 1–2 floors, viability =
   all-dry pad + ceiling + inside square); painters for pads (cut/fill),
   walls with door openings + rhythmic glass windows, gable/flat/slab
   roofs, furniture; two-story houses have a slab + four-step interior
   staircase (walkable by NPCs); wild trees on a 5-cell lattice (canopy
   fills air only); `townAnchors`, `townStats`, `findTownSpawn`.
2. **Materials** appended (ids 7–11: asphalt, concrete, brick, glass,
   leaves) with hardness/fire/strength entries. Leaves are fast-burning.
   Append-only: old saves' 7-material snapshots still validate — no
   format bump (unit-tested).
3. **NPC integration** (`src/npc/npc.ts`): `NpcSimOptions` gains
   `anchors` (homes = house doors, works = shop/industry doors; figure
   hash-picks among the six nearest within 48 cells, `nearestWalkable`
   snap, terrain-ring fallback) and `groundY` (rejects spawn candidates
   above natural terrain — no figures on roofs/canopies/decks). main
   spawns via `findTownSpawn` (off pads/doorsteps/trees) and injects both.
4. **Wiring**: chunk generator = `generateChunk` + `applyTown`;
   `__mw.town` debug hook (anchors, census, `planAt`) for the harness.
   Hotbar grows to 11 placeables (digits 1–9 + wheel).
5. **Tests**: `tests/town.test.ts` — 17 new (347 total), including the
   "every anchor is a real doorstep" invariant that pins this session's
   one real bug (below).
6. **Benchmarks** (`benchmarks/town.bench.ts`): towned-chunk overlay
   **0.92 ms mean** on top of ~0.6 ms terrain; planAt ~0.02 ms/256 cols;
   census ~2.5 ms one-time. Baselines in `docs/performance.md`.
7. **Docs**: architecture "Procedural town (Phase 14)", performance
   town baselines, known-issues "Town (Phase 14)" (generated buildings
   are stress-EXEMPT — lost-support collapse still applies; glass is an
   opaque pane; roads are cosmetic; stairwell fall-through), README
   (state 0–14), CHANGELOG `[0.12.0]`, progress file (Session 010 +
   checklist realigned: Utilities → Phase 15, Weather → Phase 16).

## The one real bug (harness-found) and the harness lessons

- **`allLots` enumerated phantom lots**: the road-lattice walk for
  anchors/census used a broken mod formula, yielding lot origins off the
  canonical `planAt` grid — door anchors pointed at buildings that are
  never painted. Fix: enumerate `off + k·SPACING` lines directly
  (`Math.ceil` for the first line ≥ −RADIUS). The unit suite now pins
  "every anchor is a real doorstep" over a generated world.
- **Sampling a periodic lattice aliases**: a step-2 grid on even
  (x+z) landed only on bridge-post columns (wood at y=9, never water),
  so "decks under water" read zero forever. Sample complementary
  parities for feature vs support. Same lesson cost the door/fire
  probes: at a doorstep the facing neighbor is the open door — wall
  material is diagonal (use 8-rings).
- **Round world coords at harness helpers' doors**: a figure's float
  position fed into page-side voxel reads — in-bounds fractions silently
  read the wrong cell, one landed past the chunk and threw (RangeError).
- **Idle-machine rule broke once**: I ran unit tests + probes during a
  full harness run; the failure mix jumped 15 → 20 with load 5+ and
  recovered on the idle re-run. One job at a time, truly.
- Night commutes are longer with door homes (30+ cells vs 3–7): the
  night-sleep window is now 45 s. The town-fire check spawns its own
  witness via `npc.spawn` instead of waiting for migration.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install`; `npm test`
   → expect **347** green. `npm run dev`, open `http://localhost:5173/`
   → you spawn at a town edge: walk the streets, enter houses (two-story
   ones have walkable stairs), find a bridge over water and ignite a
   post (deck collapses into the lake), light a house and watch the
   figures panic; `__mw.town.stats` in the console gives the census.
2. **Phase 15 (Utilities)** per the plan (§113): power graph
   (generator/wire/lamp/consumer) in a pure module following the
   structure.ts pattern (world-hook-driven local rebuilds, budgeted),
   `POWER_LOST`/`POWER_RESTORED` bus events — the NPC `notify` switch
   already consumes them (add the case); then plumbing ("pipe breaks →
   water leaks" through the Phase 9 fluid; the §22 flooding integration
   test is the pay-off). Lamps along town streets become the first
   consumers; town buildings want interior hooks eventually.
3. Believability debt in known-issues "Town (Phase 14)": generated
   buildings are stress-exempt (no fracture until edited), glass is
   opaque, doors are openings, roads carry no traffic graph.

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`, `src/npc/`,
  `src/worldgen/`, `src/player/controller.ts`) stays free of three.js
  and DOM (ADR-002); all three.js lives in `src/render/`; DOM adapters
  in `src/player/`, `src/persistence/`, `src/audio/`.
- Terrain and town generation are pure functions of (seed, coordinates);
  `hash2` frozen; `hash3` is the extensible variant (drives NPC
  randomness and every town "random" choice).
- Material IDs are a serialization contract: append only, never
  renumber. Derived tables (`MATERIAL_HARDNESS/FIRE/STRENGTH`) stay out
  of the serialized schema. Save format remains v2 (town is generation;
  the journal persists player edits on top).
- Mesher changes must keep the greedy↔naive equivalence tests green.
- Every destructive/creative gesture is one grouped `applyEdits`
  command. Fluid, fire, and structural-collapse writes go through
  `World.setVoxel`/`applyEdits`; sims observe via `onVoxelChanged`
  (fluid → fire → structure → npc by chaining). NPC sims never write
  voxels.
- Inbound events for sims go through an explicit method
  (`NpcSim.notify`) wired in main; outbound sim events use an
  `onEvent` callback — the pure core stays bus-agnostic.
- Benchmarks and harness runs need an otherwise-idle machine (2-core
  VM): never run formatters/edits/tests during a verification run, and
  check `uptime` if a run looks unusually flaky.
