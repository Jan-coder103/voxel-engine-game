# HANDOFF — Session 013 wrap (2026-09-13)

**Status: Phases 16 AND 17 are complete and committed.** This session
committed Session 012's uncommitted Phase 16 (atmosphere, `[0.14.0]`)
and implemented Phase 17's core — the **voxel light field**
(`[0.15.0]`): sunlight columns + block light (lamps, fire, generators)
with budgeted incremental BFS, mesher light + vertex-AO attributes,
shader sky-access/block terms. **420 unit tests / 32 files green,
typecheck/lint/prettier/build clean, light benchmarks recorded, in-page
probes + day/night screenshots verify the render end to end (zero page
errors).** The one standing deferral: **headless harness runs** (see
"Pending heavy work" — the user asked to skip long/heavy runs on this
VM until further notice). Next session: run those when the machine is
idle, then the cheap light-field consumers or Phase 18.

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).**

**⚠ The headless harness needs Playwright inside `.verify/`** (own
`package.json` + gitignored `node_modules`):
`cd .verify && npm install playwright@latest` restores it. Never
`npm install` at the repo root.

**⚠ Before any harness/bench run: check `uptime` AND
`ps aux --sort=-%cpu` for stale node/vite processes** (Sessions 012/013
both lost time to orphaned probe processes). During a run: touch
nothing (absolute rule).

## Pending heavy work (skip-for-now list — do these when idle)

1. **Phase 16 harness confirmation** — `.verify/run.mjs` full run ×2
   consecutive, all sections: Phase 16 section must be **8/8** (it ran
   once pre-fix at 7/8; the three failures were fixed and
   probe-verified), Phase 15 still 8/8, zero page errors. The Phase
   12/13 night checks were repointed to `atmosphere.setTime` — they
   should pass now.
2. **Phase 17 harness first run** — the new Phase 17 section (5 checks:
   sky columns, night lamp light, roofed-room dark + relight, fire
   light, clock restore) was written and `node --check`ed this session
   but **has never run**. Expect small calibrations (poll lengths are
   SwiftShader-guessed; the lamp check needs the power revision to bump
   at boot — verified in probes).
3. **Benchmark re-runs on an idle machine** — atmosphere (0.025 ms tick,
   recorded under load) and light (chunk arrival 13 ms, street edit 178
   ms BFS total, lamp fill 4.4 ms/source, mesher +7%) both carry the
   loaded-VM caveat in `docs/performance.md`.
4. Manual GUI pass (user) — still pending since Phase 7.

## What landed this session (Phase 17 — light field, plan §117)

1. **`src/voxel/light.ts`** (NEW, pure): two per-voxel channels —
   **sky** (15 iff open column above; free downward propagation through
   air; −1 lateral; water −2, glass −1; opaque blocks, leaves included →
   tree shade) and **block** (sources at −1/step: lit lamps via power
   `litPositions()` revision-gated diff, burning cells via fire
   `burningList()` count-gated diff — main owns the sync; static
   `MATERIAL_EMISSION` for generators). Storage = two lazy
   `Uint8Array`s per Chunk (freed on unload; uninitialized chunks read
   full-sky). Two-queue incremental BFS, budgeted 1200 pops/tick.
   **Correctness pins**: removal pops re-check the cell's current level
   (stale-entry bug), chunk init demotes orphaned 15s below
   newly-generated blockers + runs a lit-boundary pass (both
   streaming-order gaps), and the unit gold test proves incremental ≡
   from-scratch recompute over 60 random edits on both channels.
2. **Mesher**: `meshVolumeGreedy(volume, query, waterLevel?, light?)` —
   per-face light sampled at the air cell, **part of the merge
   signature**; per-quad-corner 3-sample vertex AO (opaque only);
   emits `aLight` (vec2, /15) + `aAO` (float, /3). Face set unchanged —
   greedy↔naive equivalence untouched. `buildVoxelGeometry` binds both.
3. **Shader** (`voxelMaterial.ts`): `(ambient + sun·NdotL) × sky × ao`
   with a 0.05 floor + `albedo · uBlockColor · block · ao`. Lamps light
   night streets, fire lights rooms, caves are dark, water dims with
   depth.
4. **Wiring** (`main.ts`): LightField constructed before chunk
   generation; `light.tick(LIGHT_POPS_PER_TICK)` per fixed step; lamp/
   fire source sync; load path = `light.reset()+rescan()` + source
   re-sync; HUD `· light qN`; `__mw.light`/`skyAt`/`blockLightAt`/
   `scene` (scene exposure was added for render probes — keep, it's
   DEV-only).
5. **Tests**: +19 (`tests/light.test.ts`) → **420 total** (32 files).
6. **Benchmarks** (`benchmarks/light.bench.ts`, NEW): numbers above;
   mesher +7% for light+AO.
7. **Docs**: architecture "Light field (Phase 17)", performance
   baselines, known-issues "Lighting (Phase 17)" (8 entries) + Phase 16
   superseded bullet, README 0–17, CHANGELOG `[0.15.0]`,
   MICRO_WORLD_PROGRESS Session 013 + checklist + Milestone 14.

## Session 013 lessons (new ones only — see PROGRESS Session 012 for the rest)

- **Screenshots without pointer lock shoot through the overlay's 82%
  black scrim** — a working bright scene reads as near-black. Click
  first in every probe that screenshots (the harness always does).
- **Write the recompute-equivalence gold test first** for any
  queue-based incremental algorithm — both real light bugs (stale
  removal cascades; streaming-order phantom/missing light) were
  invisible to targeted fixtures and trivially visible to the property
  test.
- Probe fixtures can lie: a "flat world" generator that fills stone in
  every chunk Y layer built an accidental slab at y=16–20, and a
  reference world missing the lamp source — three false alarms before
  the two real bugs. Dump the actual voxel column before theorizing.
- vite-node may serve stale transformed modules — add a sentinel log
  when probe output contradicts freshly-edited code.

## How to pick up (next session)

1. Idle-window harness runs (the pending list above): `export
PATH="$HOME/.local/bin:$PATH"`; check `uptime` + top-CPU; start
   `npm run dev`; `cd .verify && node run.mjs`. Phase 17 section
   expectations: lamp check needs a few seconds for the power rescan +
   lamp BFS; the roofed-box and fire checks poll up to 20–25 s each.
   Fix calibrations (never the sim) if a check races.
2. After the runs pass: cheap Phase 17 consumers — NPC night sight
   sampling local light (`lightLevel` option already exists in
   `NpcSimOptions`), inspector sky/block readout, day/night lamp
   switching in the power sim. Then **Phase 18 — Scenario System**
   (plan §118): scenario data model, triggers, flood/fire/collapse/
   demolition/rescue — the Phase 16 weather + Phase 17 light make the
   showcase storm scenario directly stageable.
3. Post-FX/GI/reflections/materials polish stay deferred (SwiftShader
   software GL — revisit on real hardware or after Phase 22 WebGPU).

## Key design facts (for working on the light field)

- Channels are 0–15 nibbles; `packedAt = sky<<4 | block` is the mesher
  query contract. Opacity: air 0, glass 1, water 2, else registry
  `opaque` ⇒ blocked; step cost `max(1, opacity)`; sky free-fall only
  when level 15 + straight down + opacity 0.
- Light is transient derived state: **save format untouched (v2)** —
  loads reset+rescan; consequences (burn-outs, water) persist via the
  journal as before.
- Every light write marks the chunk (and boundary neighbors) mesh
  dirty; remeshing rides the existing 3-chunks-per-frame budget.
- `Chunk.lightSky/lightBlock` are the single storage location — do not
  duplicate into World maps.
- Determinism: fixed neighbor order, no RNG; the gold test pins
  incremental ≡ recompute.

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`, `src/npc/`,
  `src/worldgen/`, `src/player/controller.ts`) stays free of three.js
  and DOM (ADR-002); all three.js lives in `src/render/`.
- Terrain/town/utilities are pure functions of (seed, coordinates);
  material IDs append-only; sims observe via chained World hooks and
  budget their ticks; NPC sims never write voxels; benchmarks and
  harness runs need an otherwise-idle machine.
