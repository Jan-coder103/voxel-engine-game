# HANDOFF — Session 011 wrap (2026-09-11)

**Status: Phase 15 (Utilities) is COMPLETE — implemented, verified,
documented, and committed. 379 unit tests green (30 files);
typecheck/lint/prettier/build clean. The headless browser suite's new
Phase 15 section is 8/8 green in two consecutive runs, zero page
errors; residual failures are the documented Phase 7–13
synthetic-input races (box was at load 5–7 during runs). Canonical
long-term state lives in `MICRO_WORLD_PROGRESS.md` (Session 011 log +
Current Status); this file is the short pickup map.**

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

**⚠ The headless harness needs Playwright inside `.verify/`** (own
`package.json` + gitignored `node_modules`):
`cd .verify && npm install playwright@latest` restores it. Never
`npm install` at the repo root (walks up and pollutes).

## What landed this session (Phase 15 — Utilities, plan §113)

1. **`src/voxel/power.ts`** (pure): the grid is the connected component
   of copper / lamp / generator cells, rebuilt locally on the World
   change hook (structure.ts pattern: one rebuild per tick, hard cell
   cap, queue-merge via consumeQueue). ≥1 generator powers a component;
   overload browns lamps farthest-first in BFS order
   (`capacityPerGenerator`, 1024 default). Chunk-ready scans queue ONE
   seed per chunk and are silent (discovery ≠ change); only
   edit-triggered rebuilds emit `powerLost`/`powerRestored` per lamp
   flip. A cut wire rebuilds **both sides independently** — the
   severed far side genuinely goes dark.
2. **`src/voxel/plumbing.ts`** (pure): components of pipe / pump / tap.
   A water-fed (self-powered diesel) pump pressurizes its network.
   Pressurized: a destroyed pipe re-fills with real Phase 9 water
   (`FluidSim.pour`, new public method) every `POUR_PERIOD` ticks and
   taps pour beside themselves. Pump destroyed → leaks stop, taps dry.
   Same per-side rebuild fix as power (a break seeds both sides).
3. **`src/worldgen/utilities.ts`** (pure, hooked into `applyTown`):
   buried copper cable under every road-line center column (terrain
   stair fills, higher column extends down), lampposts every 8th center
   column (seeded offset), generator on a copper vault at the central
   intersection (deck-mounted if that crossing is water), water main
   down the road's edge lane (h−2; h−3 under cable crossings; deck−1 on
   parity posts under water) from a submerged pump to a standpipe tap.
   Materials 12–17 appended (copper, lamp, generator, pipe, pump, tap)
   — save format untouched.
4. **Wiring**: `cachedReader` (`src/voxel/cachedReader.ts`) — per-
   rebuild chunk cache, the World's one-slot memo thrashes under flood
   locality; `powerViz` glow shells (revision-gated); HUD `· lamps N` /
   `· leaks N`; `powerLost` → `npc.notify` (Phase 13 anticipated case:
   nearby figures investigate); L-key load resets + rescans both sims;
   `__mw.power/plumbing/powerViz/utilities` (site + route) hooks.
5. **Tests**: 32 new — power (12), plumbing (8), townUtilities (8),
   NPC outage reaction (3), fluid memo regression (1). Strongest
   invariant: _every generated lamp is lit_ on seeds 1337 + 13579 (the
   latter has a deck-mounted plant), plus a continuous pressurized
   main and burst/rip end-to-end on the generated town.
6. **Benchmarks**: full town-grid rebuild (~5.4k cells) ≈ 12 ms on the
   dev VM; main rebuild 0.17 ms; pour pass 0.002 ms; route scan
   0.08 ms; applyTown-with-utilities 1.3 ms/chunk. In
   `docs/performance.md` with the VM caveat.

## The bugs this session caught (probe-first lessons)

- **The cable didn't connect — three stacked bugs, each masked the
  next**: (1) no stair fills (terrain steps split the grid into 108
  line-islands); (2) `cableAt`'s offset helper returned the _lane_
  offset for lane-of-one-line × center-of-other columns → 2-cell gaps
  in every horizontal line at crossings; (3) fills ran dry-only, but a
  submerged column can be the _higher_ one at a shoreline. Fix order
  matters: probe at the **component level** (flood-fill + count
  components) — the census said "108 islands of one line each" in one
  shot; eyeballing cells burned three probe rounds first.
- **Mesh-redundant networks defeat single-cut fixtures.** The 9×9 town
  grid tolerates any single cut (correct! realistic!). The harness now
  blacks the town out via the plant (2 blocks). When a fixture fails
  because the world is _better_ than expected, re-aim the fixture, not
  the sim.
- **Structurally-unsound fixtures get eaten by earlier sims.** Cutting
  a lamppost's pole topples it into the structural sim (ticks before
  power), so the power check tested rubble. Cut the cable.
- **Fluid memo dangled (Phase 9 latent):** `deleteLevel` on a map-less
  chunk left a stale `(key, undefined)` memo; the next `mapForWrite`
  skipped the refresh and reads saw phantom sources (255). Fixed in
  `deleteLevel`; regression test in fluid.test.ts.
- **Perf was in the algorithm, not constants**: shift() in the supply
  BFS, per-neighbor object frontiers, unconditional supply walks, and
  the memo thrash together cost ~56 ms/flip; the fixes above brought
  ~12 ms. On this VM (load 5–7 during parts of the session) every
  Map/Set op is ~0.4–0.9 µs — design caches and skip-paths in from the
  start (Session 007's lesson, graph edition).

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install`; `npm test`
   → expect **379** green. `npm run dev`, open the URL: spawn at the
   town edge — lampposts line the streets (glow shells when lit), the
   plant stands at the central crossroads (rip it out → blackout;
   rebuild → relight), a water main runs to a fountain near the center
   (burst it → the lane floods; kill the pump → it dries). Dig through
   a road and you'll find the cable/main one block down.
2. **Phase 16 (Weather/Atmosphere)** per the plan (§114): the
   day/night cycle is the highest-value item — the NPC schedule's tick
   clock becomes the world clock and the lamp glow finally matters at
   night. Sky/fog/stars first, then rain (fire coupling hooks exist
   from Phase 10/13). Alternative: Phase 17 visual polish if the
   lamp-lighting debt bothers the demo first (see known-issues).
3. Believability debt in known-issues "Utilities (Phase 15)": no
   voltage/current model or switches, unfueled generators, self-
   powered pumps, glow-only lamps, refill-not-jet leaks, mesh
   redundancy, transient network states (save/resume verified), poles
   as obstacles.

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`, `src/npc/`,
  `src/worldgen/`, `src/player/controller.ts`) stays free of three.js
  and DOM (ADR-002); all three.js lives in `src/render/`; DOM adapters
  in `src/player/`, `src/persistence/`, `src/audio/`.
- Terrain and town (and their utilities) are pure functions of (seed,
  coordinates); `hash2` frozen; `hash3` is the extensible variant.
- Material IDs are a serialization contract: append only, never
  renumber. Derived tables stay out of the serialized schema. Save
  format remains v2 (utilities are generation + journal; network
  states are transient and rebuild on load).
- Mesher changes must keep the greedy↔naive equivalence tests green.
- Every destructive/creative gesture is one grouped `applyEdits`
  command. Fluid, fire, structural, power, and plumbing writes go
  through `World.setVoxel`/`applyEdits`; sims observe via
  `onVoxelChanged` (construction order harmless — everyone chains), do
  their heavy work in budgeted `tick`s, and NPC sims never write
  voxels.
- Inbound events for sims go through an explicit method
  (`NpcSim.notify`) or an assigned callback (`onEvent`) wired in main;
  the pure core stays bus-agnostic.
- Benchmarks and harness runs need an otherwise-idle machine (2-core
  VM): never run formatters/edits/tests during a verification run, and
  check `uptime` if a run looks unusually flaky. This session's
  harness runs saw load 5–7 and still carried the Phase 14/15 gates;
  the input-race mix worsened accordingly (documented, harness-side).
