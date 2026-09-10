# HANDOFF — Session 007 wrap (2026-09-10)

**Status: Phase 11 (Structural Simulation) is COMPLETE — implemented,
verified, documented, and committed. 278 unit tests green;
typecheck/lint/build clean; the headless browser suite's Phase 11
structural section is all green (zero page errors). Canonical long-term
state lives in `MICRO_WORLD_PROGRESS.md` (Session 007 log + Current
Status); this file is the short pickup map.**

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

## What landed this session (Phase 11 — Structural Simulation)

1. **`src/voxel/structure.ts`** (pure) replaces the Phase 8 edit-time
   `checkSupport` (deleted): `analyzeStructure(world, region)` models a
   graph over solid cells — vertical connections always transmit
   support, horizontal ones only within `MAX_CANTILEVER = 6` groundless
   hops (0/1-cost BFS from bedrock + region-edge anchors). Consequences:
   floors hold from walls, plank bridges stand within ~6 of a shore,
   overhangs past the limit drop only their far half, and a roof whose
   last pillar is gone falls entirely.
2. **Simplified stress + thresholds**: vertical stack load (1 + all
   solid above in the column) vs the new derived `MATERIAL_STRENGTH`
   table (wood 22, stone 26, dirt 16, sand 10, grass 14 — world is 32
   tall, so stone effectively never fails). Only **journaled** cells can
   fracture (`World.isEdited`) → natural terrain never avalanches; load
   counts all overlying mass, so wood posts propping terrain still fail.
3. **`StructuralSim`** (ticked like fluid/fire): chains onto
   `World.onVoxelChanged` — which now also carries the **previous**
   material — and queues a merged region scan **only when solid matter
   vanished** (removals, explosions, collapses, fire burn-outs;
   placements and water never trigger — building stays free). One
   analysis per fixed step; regions span the **full world height** ±12
   horizontally; > 150k-cell regions skip; single collapses cap at
   `MAX_COLLAPSE_CELLS = 4096` with the cascade finishing the rest.
4. **Progressive collapse**: the sim proposes cells via `onCollapse`;
   main applies them as before — one grouped undoable `collapse`
   command with debris/dust/sound — and the applied edits re-queue the
   region, so multi-stage failures cascade across ticks.
5. **Fire → collapse coupling** (the Phase 10 deferred item): burn-out
   is a real `setVoxel(AIR)` write, so a burned pillar drops its roof
   with zero special-case code.
6. **Viz + HUD**: `src/render/structureViz.ts` (G toggle) flashes failed
   cells ~1.6 s (red = lost support, orange = stress fracture); HUD
   `· struct qN` while regions are pending; `structure`/`structureViz`
   on the `__mw` debug hook; `structure.reset()` on load.
7. **Performance**: hot passes read a precomputed `solid` byte buffer
   (imported material constants through helper calls cost 4× under
   vitest's module transform — 9.6 ms → 2.2 ms on the gate).
   **Benchmark gate: 2.19 ms** house-scale analysis on real terrain
   (plan budget < 5 ms); fully-solid worst case 3.18 ms; full collapse
   cascade ≈ 6.9 ms spread over ~16 ticks (`docs/performance.md`).
8. **Gates + verification**: 24 structure tests (278 total); headless
   browser Phase 11 section (cantilever gate, tower stress cascade,
   fire coupling, G overlay) — all green, zero page errors. The
   existing Phase 7–10 sections still pass, including the Phase 8
   collapse gate which now flows through the ticked sim.
9. **Docs**: architecture "Structural simulation (Phase 11)",
   performance baselines (+ VM caveat), known-issues Structures section,
   README, CHANGELOG `[0.9.0]`, progress file (Session 007 + Phase 11
   checklist + Milestone 9).

## Harness lessons recorded this session

- **The dev server must stay idle while `.verify/run.mjs` runs.** A
  `npm run format` mid-run triggers a Vite full page reload; the script
  then crashes on the next `window.__mw` access, and the polluted run's
  flaky key-drops are the same reload — not real input races. Re-run
  before diagnosing anything.
- `node --check .verify/run.mjs` before any run catches top-level
  identifier collisions between phase sections instantly (this session:
  `roofY`, `lit` were already taken by Phases 8/10).
- Only top-level declarations collide; identifiers inside
  `page.evaluate` callbacks are function-scoped.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install`; `npm test`
   → expect **278** green; `npm run dev`, `?seed=1234` → creator mode
   **C**, build two pillars + a roof slab, delete one pillar → the far
   roof half drops, the near half cantilevers; build a ~24-tall wood
   tower, dig the block beside its base → the base fractures and the
   tower cascades flat; burn a pillar with the **ignite** tool → its
   roof drops; **G** shows red/orange failure markers; undo restores a
   collapse step by step.
2. **Phase 12 (NPCs)** per the plan: NPC entity + needs + wander/
   schedule behavior, then navigation (walkable cells → graph → A*)
   with local invalidation. The event bus already carries
   `explosion`/`structureCollapsed`/`fireIgnited` for reactions
   (Phase 13 consumes them).
3. If structural *feel* needs work before NPCs: lateral load
   distribution (slab weight onto pillars) is the known gap — see
   known-issues "Structures" for the model and the tradeoffs.

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
  tables (`MATERIAL_HARDNESS`, `MATERIAL_FIRE`, `MATERIAL_STRENGTH`)
  stay out of the serialized schema.
- Save formats version up through a migration chain (now at v2);
  prefab format v1 validates structurally.
- Mesher changes must keep the greedy↔naive equivalence tests green
  (waterDrop is additive).
- Every destructive/creative gesture is one grouped `applyEdits`
  command. Fluid, fire, and structural-collapse writes go through
  `World.setVoxel` directly — sim writes are journaled + remeshed but
  NOT user edits; collapses are applied by the game layer through
  `applyEdits` (via `structure.onCollapse`) precisely so they stay
  undoable.
- Sims observe world mutations by chaining onto `world.onVoxelChanged`
  (fluid, then fire, then structure by convention; the chain makes
  order harmless). The hook's signature is now
  `(x, y, z, material, previous)`.
- Benchmarks and harness runs need an otherwise-idle machine (2-core
  VM): never run formatters/edits during a verification run.
