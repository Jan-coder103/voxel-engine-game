# HANDOFF — Session 004 wrap-up (2026-09-09)

**Status: clean handoff. Phases 7 and 8 are complete; Milestone 5 met and
the Phase 8 gate criteria verified by tests.** Canonical state lives in
`MICRO_WORLD_PROGRESS.md` (see Session 004 log) — this file only covers
how to start the next session.

## Where things stand

- **Creator mode (Phase 7).** `src/creator/` is a pure editor core:
  brushes (sphere/box/cylinder/noise × place/delete/paint/replace) that
  produce edit lists — one stroke is one grouped undoable command through
  `applyEdits`; box selection (32³ budget) with clipboard
  copy/cut/paste/rotate/mirror/remap; versioned prefab JSON (RLE,
  validated) in a `PrefabLibrary` over `SaveStore`; voxel inspector.
  Render-side: shape-true brush ghost, selection + paste wireframes.
  Keys: **C** toggle, **Q/E** tools, **V** shapes, **[ ]** size, **B**
  select, **Ctrl+C/X/V**, **R/M**, **O/P**, **I**.
- **Destruction (Phase 8).** `explode` (pure, in `src/voxel/damage.ts`)
  fractures a hardness-weighted sphere; `checkSupport`
  (`src/voxel/support.ts`) finds solid components disconnected from
  bedrock after destructive edits and the game collapses them as one
  undoable command. Effects are pooled (512 debris + 1024 dust in two
  InstancedMeshes, ring-buffer recycled) and routed through a typed
  event bus (`src/sim/events.ts`) to procedural WebAudio
  (`src/audio/sfx.ts`, **N** mutes). The gate criteria are met:
  pillar-roof collapse within the click's frame (unit-tested + seen in
  the headless browser), explosion = hole → debris → dust → sound, and
  a 100-event stress test that never exceeds the pool.
- Playable at `npm run dev` — click, WASD, Space; **C** for creator
  mode; brush strokes, cut/paste, prefabs, explosions, collapses all
  undoable and journaled (they survive reloads).

## How to pick up (next session)

1. Read `MICRO_WORLD_PROGRESS.md` — Session 004 log has the full state,
   the deferred list (gizmos/sculpt brushes, debris re-materialization,
   heat/NPC coupling), and the fixed-during-verification notes
   (support-check 18.5→10 ms optimization, EventBus typing).
2. `npm install`, `npm run dev`, confirm the world renders; a leftover
   localStorage autosave restores — `?seed=1234` for a fresh world.
3. Start **Phase 9 (Water)**:
   - Pure cellular fluid in `src/voxel/fluid.ts`: per-cell volume 0–255,
     gravity + horizontal equalization first, mass-conservation and
     boundary tests (plan §130's exact task shape), chunk-boundary flow
     via a neighbor query like the mesher's.
   - Tick scheduler with an activity budget (only N active cells per
     frame); dirty flags reuse the existing chunk remesh path.
   - Water is currently a non-solid, non-targetable placeholder —
     decide its targetability/interaction with brushes and explosions
     while wiring Phase 9 (known-issues carries both).
   - Then flow-height rendering in the voxel shader and player
     buoyancy in the controller.
4. The local `.verify/run.mjs` (gitignored) is a headless Playwright
   E2E that drives the game through the dev-only `__mw` hook — useful
   for regression checks; needs `npm i --no-save playwright` and a
   Chromium with WebGL. The in-app browser pane had no WebGL this
   session; **the manual GUI pass for Phases 7–8 is still open** —
   brushes/clipboard/prefabs/explosion/collapse are the things to play
   with.
5. Known gaps carried forward (all in `docs/known-issues.md`): no AO
   (Phase 16), no worker meshing (deferred), LOD1 erosion by design,
   support-check region approximation (Phase 11 replaces it), water
   placeholder (Phase 9).

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`,
  `src/player/controller.ts`) stays free of three.js and DOM (ADR-002);
  all three.js lives in `src/render/`; DOM adapters in `src/player/`,
  `src/persistence/`, `src/audio/`.
- Terrain generation stays a pure function of (seed, coordinates);
  `hash2` in terrain.ts is frozen — existing saves depend on it
  (`hash3` is the extensible variant).
- Material IDs are a serialization contract: don't renumber.
  Derived tables (hardness) stay out of the serialized schema.
- Save formats version up through a migration chain; prefab format v1
  validates structurally and rejects drift.
- Mesher changes must keep the greedy↔naive equivalence tests green.
- Every destructive/creative gesture is one grouped `applyEdits`
  command — keep it that way; undo/journaling/autosave depend on it.
