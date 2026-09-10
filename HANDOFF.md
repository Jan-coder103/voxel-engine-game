# HANDOFF — Session 005 wrap (2026-09-10)

**Status: Phase 9 (Water) is COMPLETE — implemented, verified, documented,
and committed. 240 unit tests green; typecheck/lint/build clean; the
headless browser suite (including a 14-check water scenario) is green.**
Canonical long-term state lives in `MICRO_WORLD_PROGRESS.md` (Session 005
log + Current Status); this file is the short pickup map.

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

## What landed this session (on top of the Phase 9 implementation)

1. **Fluid frontier bug — found and fixed.** Headless verification showed
   lakes churning ~10³ active cells forever on every watery seed (the
   384-cell budget was saturated; worlds never went quiet). Root cause,
   pinned with in-page instrumentation: `FluidSim.updateCell` performed
   its paired write + `activateAround` even when `setLevel` early-returned
   on a failed unloaded-chunk write — every frontier source re-woke
   itself + 13 neighbors each tick, forever. Fix: `setLevel` returns
   write success; failed writes propagate nothing (frontier sleeps,
   `onChunkReady` resumes it). Regression test in `tests/fluid.test.ts`.
   Settled worlds now measure `active = 0`.
2. **Fluid benchmark run** — 384-cell budget tick 2.60 ms mean (p75 2.51),
   steady churn 0.42 ms/tick, 22×22 basin flood ≈2.7 s one-time, lake wake
   ≈3.4 ms incl. chunk gen. Baselines in `docs/performance.md`; budget
   stays 384.
3. **Gates re-run green**: typecheck (one unused-var in a mesher test
   fixed), lint, build (584.56 kB minified / 153.16 kB gzip), Prettier
   reflow (`npm run format` — the prior commit predated a format pass),
   full suite 240 tests.
4. **Headless browser verification** (`.verify/run.mjs`, Playwright +
   SwiftShader): new Phase 9 water section on a fresh `?seed=1234` world —
   14 checks, all green: source placement, spread to the far corner as
   flowing cells, material/level semantics, HUD churn counter,
   quiescence (active=0), exact containment + mass conservation, swim
   HUD, climb-out onto the bank, save-v2 `waterLevels` field, boot
   restore of flowing levels. Screenshots in `.verify/artifacts/`.
   Remaining Phase 7/8 check failures are the documented synthetic-input
   races at ~10 fps (different mix per run; the collapse GATE and prefab
   checks hold) — the manual GUI pass is still the user's.
5. **Docs**: architecture "Water (Phase 9)" section, performance fluid
   baselines, known-issues rewrite (water sharp edges replace the
   placeholder bullet; explosions now "vaporize water"), README
   (Phases 0–9, water/swim controls), CHANGELOG `[0.7.0]`,
   MICRO_WORLD_PROGRESS.md (Session 005 log + Phase 9 checklist +
   Current Status).
6. **Committed** (one Phase 9 completion commit, matching per-phase
   history).

## Verification lessons (recorded in the progress file)

- A fluid source placed **above** a basin rim floods the whole shore —
  that is the source rule working (it fills every reachable cell at or
  below its level), not a leak. The verify fixture now places its source
  inside the basin, at the wall-top layer.
- Playwright localStorage does not survive `browser.close()` — forensic
  probes must rebuild state in the same page.
- Phase 7/8 check flakes in `run.mjs` are harness-side (dropped synthetic
  keys / pointer-lock drops under software GL); the user's manual GUI
  pass is still open for those phases' polish.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install`; `npm test`
   → expect **240** green; `npm run dev`, `?seed=1234` → lakes render,
   swim with Space, climb shores holding Space against the bank; place
   water with hotbar **6**; a source above a basin rim floods the shore
   (by design); exploding a lake edge vaporizes water, then it refills.
2. **Phase 10 (Fire and Smoke)** per the plan: pure fire core in
   `src/voxel/fire.ts` following the fluid pattern (budgeted ticks,
   sleep/wake, derived `MATERIAL_FLAMMABILITY` next to
   `MATERIAL_HARDNESS`); event-bus events; extinguish coupled to water
   first (it exists); explosion heat hooks exist from Phase 8.
3. Phase 11 later replaces the support-check approximation with a real
   structural graph.

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
  tables (hardness, future flammability) stay out of the serialized
  schema.
- Save formats version up through a migration chain (now at v2);
  prefab format v1 validates structurally.
- Mesher changes must keep the greedy↔naive equivalence tests green
  (waterDrop is additive).
- Every destructive/creative gesture is one grouped `applyEdits`
  command. Fluid (and future fire) writes go through `World.setVoxel`
  directly — journaled + remeshed, but deliberately NOT through
  applyEdits: simulation is not user edits (would flood undo history).
