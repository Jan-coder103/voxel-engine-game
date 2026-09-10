# HANDOFF — Session 006 wrap (2026-09-10)

**Status: Phase 10 (Fire and Smoke) is COMPLETE — implemented, verified,
documented, and committed. 262 unit tests green; typecheck/lint/build
clean; the headless browser suite's 13-check fire scenario is all green
(zero page errors). Canonical long-term state lives in
`MICRO_WORLD_PROGRESS.md` (Session 006 log + Current Status); this file
is the short pickup map.**

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

## What landed this session (Phase 10 — Fire and Smoke)

1. **Pure fire core** (`src/voxel/fire.ts`), mirroring the fluid sim:
   burning cells are fuel counters (sparse map); heat is an integer
   accumulator that only builds in flammable cells. Derived
   `MATERIAL_FIRE` + `fireProfileOf` next to `MATERIAL_HARDNESS`
   (wood 0.9 flammability / 480 ticks, grass 0.55 / 64, rest fireproof).
   Ignition at `ignitionHeat(flammability)`; burning cells deposit
   `HEAT_PER_TICK` into flammable neighbors; ticked cells decay.
   Insertion-ordered active set, `tick(256)` budget in the fixed step,
   sleep/wake via the World hook, zero RNG — deterministic (tested).
2. **Death rules**: adjacent water extinguishes (cause `water`);
   full 6-neighbor opaque enclosure smothers (cause `smothered`);
   spent fuel burns the voxel to AIR through `World.setVoxel` — so
   burn-out is journaled, remeshed, fluid-visible, and persists across
   save/load. Fires themselves are transient (format stays v2).
3. **Ignition paths**: ignite tool (6th brush tool; brush-shaped, refuses
   water-adjacent cells) + explosion heat: `explode()` returns `heated`
   (flammable crater-rim survivors) and main dumps `BLAST_HEAT` — the
   Phase 8 deferred "calculate heat" hook.
4. **Events + FX**: `fireIgnited` / `fireExtinguished` on the bus (crack
   burst on ignition; steam-stand-in dust puff on water extinguish);
   pooled embers (256) + smoke (512) in `src/render/firefx.ts` with
   emission ∝ burning cells under per-frame caps; HUD `· fire N`;
   inspector `burning <fuel>`; `fire.takeDirty()` arms autosave;
   `fire.reset()` on load.
5. **Hook hardening**: `FluidSim` and `FireSim` both CHAIN onto the
   World's single `onVoxelChanged` (wrap, don't overwrite) — sim
   construction order no longer matters.
6. **Gates + verification**: 262 tests (+22 fire: ignition rules, spread
   barriers, exact burn durations, water coupling both ways, smothering,
   blast heat, budget, sleep/wake, determinism, journal interplay);
   fire benchmark (budget tick **1.68 ms** mean, fire front 1.59 ms,
   20×20 burn-out ≈1.0 s total — `docs/performance.md`); headless
   browser suite extended with a 13-check fire scenario on `?seed=5678`
   (tool ignition, containment, spread, burn-out, quiescence, water
   dousing) — **all green, zero page errors**. Remaining Phase 7/8
   failures are the documented synthetic-input races (mix varies per
   run; collapse GATE, prefab, and conservation checks hold).
7. **Docs**: architecture "Fire (Phase 10)", performance fire baselines,
   known-issues Fire section (8 entries), README, CHANGELOG `[0.8.0]`,
   progress file (Session 006 + Phase 10 checklist + Milestone 8).

## FireFx bug caught by the harness (lesson recorded)

The first full run flooded pageerrors: `FireFx.spawn` indexed particle
state arrays that were never filled — a per-frame crash invisible to unit
tests (render-side code has no unit tests by design). Diagnosed in one
minute with a probe script (boot → poke `__mw` → pageerror with stack);
fixed by pre-filling pools in the constructor. **Render-side systems are
only tested by the headless harness — read its ERRORS tail first, and
probe before running the full 5-minute suite.** (Probe kept at
`.verify/probe.mjs`, gitignored.)

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install`; `npm test`
   → expect **262** green; `npm run dev`, `?seed=1234` → place water
   (hotbar 6), build wood (place), creator mode **C**, **Q/E** to the
   **ignite** tool, click wood → embers + smoke, fire spreads, burns to
   air; dump water next to a fire to douse it; explode near wood → the
   crater rim catches. Reload → fires are out but burned holes persist.
2. **Phase 11 (Structural Simulation)** per the plan: support graph +
   stress + collapse with detached rigid bodies, replacing the Phase 8
   `checkSupport` region approximation. Gate: destroy a building's
   ground floor → upper floors detach and collapse; incremental analysis
   (< 5 ms at house scale); believable over correct.
3. Wire the Phase 10 deferred coupling into it: fire burn-outs should
   trigger structural updates (a burned pillar drops its roof).

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
  tables (`MATERIAL_HARDNESS`, `MATERIAL_FIRE`) stay out of the
  serialized schema.
- Save formats version up through a migration chain (now at v2);
  prefab format v1 validates structurally.
- Mesher changes must keep the greedy↔naive equivalence tests green
  (waterDrop is additive).
- Every destructive/creative gesture is one grouped `applyEdits`
  command. Fluid and fire writes go through `World.setVoxel` directly —
  journaled + remeshed, but deliberately NOT through `applyEdits`:
  simulation is not user edits (would flood undo history).
- Sims observe world mutations by chaining onto `world.onVoxelChanged`
  (fire after fluid by convention; the chain makes order harmless).
