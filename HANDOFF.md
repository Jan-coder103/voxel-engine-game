# HANDOFF — Session 003 wrap-up (2026-09-09)

**Status: clean handoff. Phases 5 and 6 are complete; Milestones 3 and 4 met.**
Canonical state lives in `MICRO_WORLD_PROGRESS.md` (see Session 003 log) —
this file only covers how to start the next session.

## Where things stand

- **Editable, saveable sandbox (Phase 5).** Crosshair DDA raycast drives
  place (RMB) / remove (LMB) / paint (F) / pick (MMB), all grouped into
  undoable `EditCommand`s (Ctrl+Z/Y, 128-deep). A per-chunk edit journal
  replays over the generator, so edits survive unload/prune and page
  reloads. Saves are (seed + terrain params + material table + journal),
  versioned with a migration chain, autosaved to localStorage every 20 s
  and on tab-hide; boot restores unless `?seed=` names another world.
- **Microvoxel infrastructure (Phase 6).** Chunks store a
  `PackedVolume` (palette + bit-packed indices + occupancy bitset,
  ~5.3× smaller than dense on terrain) behind the shared `VoxelData`
  interface. Production meshing is `meshVolumeGreedy`, proven
  unit-face-equivalent to the kept naive baseline by tests. Distant
  chunks render LOD1 (half-resolution downsample + 2× scale) with
  hysteresis; the downsample is conservative (air wins ties) so LOD
  never inflates terrain — that was a playtest bug, now regression-tested.
  Whole view: ~82.5k quads → ~9k, 60 fps.
- Playable at `npm run dev` — click, WASD, Space; 1–7/wheel pick
  materials; K save, L load; `?seed=N` starts a fresh world.

## How to pick up (next session)

1. Read `MICRO_WORLD_PROGRESS.md` — Session 003 log has the full entry
   state and the fixed-during-verification list (unbound-method loop
   crash, LOD inflation, greedy OOB faces).
2. `npm install` if needed, `npm run dev`, confirm the world renders and
   edits work (the localStorage autosave carries your playtest builds).
3. Start **Phase 7 (Creator Mode)**:
   - Pure brush core in `src/creator/` (sphere/box/cylinder shapes ×
     place/delete/paint tools) producing edit lists — flow them through
     `applyEdits` so one stroke is one undoable command and journaling
     comes free.
   - Box selection + clipboard (copy/cut/paste/rotate/mirror) as pure
     volume transforms; paste = one grouped command.
   - Prefab save/load (versioned JSON like the world save) + voxel
     inspector + render-side selection wireframe / brush ghost.
   - Deterministic scatter (noise brush) should reuse the integer hash
     in `terrain.ts` — no sequential RNG.
4. Known gaps carried forward (all in `docs/known-issues.md`): water is
   a non-solid, non-targetable placeholder (Phase 9); no AO (Phase 16);
   worker meshing/transferable buffers deferred from Phase 6; LOD1
   erodes ≤1 voxel by design.

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- World/sim code (`src/voxel/`, `src/player/controller.ts`, and now the
  future `src/creator/` cores) stays free of three.js and DOM (ADR-002);
  all three.js lives in `src/render/`, DOM adapters in `src/player/` +
  `src/persistence/`.
- Terrain generation stays a pure function of (seed, coordinates).
- Material IDs are a serialization contract: don't renumber.
- Save formats version up through `migrateWorld`; never load silently
  against a drifted schema.
- Mesher changes must keep the greedy↔naive equivalence tests green.
