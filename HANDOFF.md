# HANDOFF — Session 001 wrap-up (2026-09-08)

**Status: clean handoff. Phase 0 and Phase 1 are complete; Milestone 1 is met.**
Canonical state lives in `MICRO_WORLD_PROGRESS.md` (see Session 001 log) — this
file only covers how to start the next session.

## Where things stand

- The exFAT blocker from the previous handoff is **resolved**: the project now
  lives on ext4 at `~/Coding Project/OpenCoder/AI_VOXELS/AI Voxel Game`.
- `npm install` works, `git init` done (branch `main`), CI workflow written.
- Full Phase 1 demo is playable: `npm run dev`, click to capture the mouse,
  WASD + Space + mouse look in a 16³ voxel world.
- Verification at end of session: 38/38 tests, typecheck clean, lint clean,
  production build OK, browser smoke test with trusted input (60 fps, pointer
  lock, movement, mouse deltas, zero console errors).

## How to pick up (next session)

1. Read `MICRO_WORLD_PROGRESS.md` — Session 001 log has the full entry state.
2. `npm install` (if node_modules is missing), then `npm run dev` and confirm
   the demo runs.
3. Start **Phase 2 (Chunks)**: chunk data structure + chunk map in
   `src/voxel/` (the coordinate conversions and `VoxelVolume` are already
   chunk-shaped for this), meshing across chunk boundaries, dirty-flag
   remeshing, then streaming. Recommended order is in the Session 001 log
   under "Recommended next steps".
4. One deliberate gap to carry: the Phase 1 "interaction raycast" checkbox is
   intentionally deferred to Phase 5 (see `docs/known-issues.md`). Don't
   re-implement it casually — it lands with editing.

## Agreed approach (unchanged)

- Single npm package at the repo root (no monorepo).
- Stack: TypeScript strict, Vite, three.js `WebGLRenderer` behind
  `src/render/bootstrap.ts` (WebGPU later), Vitest node environment, ESLint
  flat + Prettier.
- Keep world/sim code (`src/voxel/`, `src/player/controller.ts`) free of
  three.js and DOM imports (ADR-002) so it stays testable in node.
- Layout is as planned and now real: `src/voxel/`, `src/player/`,
  `src/render/`, `src/main.ts`, `tests/`, `benchmarks/`, `docs/`.
