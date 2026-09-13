# HANDOFF — Session 014 wrap (2026-09-13, evening)

**Status: Phase 18 (Scenario System) is implemented, unit-tested, wired,
benchmarked, documented, and committed as `[0.16.0]`.** 444 unit tests /
33 files green, typecheck/lint/prettier/build clean, scenario
micro-benchmarks recorded (≈0.11 µs/tick), docs updated. An in-page
probe ran **once**: **flood and collapse are verified end to end in the
live page** (start → play → complete, zero page errors, screenshots in
`.verify/artifacts/p18-*.png`). **Three open items** came out of that
run — rescue, fire-tuning, demolition-readiness — they are probe-side
diagnostics, not unit failures, and they are the first task for
Session 015. The Phase 18 harness section is deliberately **not written
yet** (encode it after the three items are resolved).

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).**

**⚠ The headless harness needs Playwright inside `.verify/`** (own
`package.json` + gitignored `node_modules`). It is installed; never
`npm install` at the repo root.

**⚠ Before any probe/harness/bench run: check `uptime` AND
`ps aux --sort=-%cpu` for stale node/vite processes. During a run:
touch nothing (absolute rule).** (Session 014 left NO dev server
running — it was killed at wrap-up. Probe used `.verify/probe-p18.mjs`
against `npm run dev` on :5173.)

## Pending heavy work (skip-for-now list — do these when idle)

1. **Session 015 diagnostics (in-page probes, ~15–30 min each)** — the
   three open Phase 18 items; see "First tasks tomorrow" below.
2. **Phase 18 harness section** — write AFTER the diagnostics land
   (expected shape: on `?seed=24680`, for each scenario: `__mw.scenario.start(id)`
   → assert HUD `SCEN` line → perform the resolution page-side
   (setVoxel water/dig/pump-removal/carve) → poll `engine.current` →
   complete; ~6–8 checks). Then it joins the deferred-run list.
3. **Phase 16 harness confirmation** — `.verify/run.mjs` full run ×2
   consecutive: Phase 16 section must be 8/8, Phase 15 still 8/8, zero
   page errors (carried since Session 012).
4. **Phase 17 harness first run** — the 5-check Phase 17 section has
   never run (carried since Session 013).
5. **Benchmark re-runs on an idle machine** — atmosphere, light, and
   utilities numbers carry loaded-VM caveats (scenario bench numbers
   from this session are also load-~2 but tiny).
6. Manual GUI pass (user) — pending since Phase 7.

## What landed this session (Phase 18 — plan §118)

1. **`src/scenario/engine.ts`** (NEW, pure): tick-driven evaluator.
   `ScenarioDef` = setup + objectives + one-shot triggers + optional
   scenario-level `failed`/`timeLimit`. Objectives: `done`/`failed`
   conditions, `deadline` (ticks only while unlocked), `after` unlock
   gate. Fixed per-tick order: triggers → scenario fail → objectives.
   Completion needs ≥1 positive objective AND all done; guard-only
   objectives (failed-without-done) never block and flip to done at the
   end. `ScenarioContext` = ticks + bus-event log queries (events,
   eventsNear, eventsInBox, lastEventTick, eventsQuiet; log capped 512,
   recorded only while running) + scratch counters + box material
   census (≤50k cells) + npcById. All world access via injected
   `ScenarioIo` (journaled `edit`, `ignite`, `forceWeather`,
   `ensureAround` chunk force-load, `spawnAt` → npc id, `setCounter`,
   `announce`, sensors: leakCount/litCount/burningCount). Statuses
   idle/running/complete/failed; `active` = running only; `title`
   getter for the HUD's final line. Transient state — save format
   untouched.
2. **`src/scenario/definitions.ts`** (NEW, pure): `resolveSites(terrain)`
   — all viable town buildings via `planAt`/`lotSpec` (nearest-first
   from spawn), water main (pump/tap/burst from `pipelineRoute`; burst
   = dry non-cable-crossing lane cell, y=h−2), generator block.
   `scenarioReady` validates on the loaded world; `scenarioTarget`
   prefers houses for fire/rescue. Five scenarios: flood (burst →
   stop-the-leak + water-off-the-plant guard + hint), fire
   (`findFlammable` skips water-adjacent AND fully-sealed cells;
   douse-before-half-consumed via `buildingBody` baselines;
   neighbor-box ignition guards), collapse (carve ground courses →
   Phase 11 cascade; get-clear deadline; after-gated quiet-window;
   witness-survives guard), demolition (collapse-at-site or ¾ removed;
   neighbor-box explosion/fire guards; casualty guard), rescue (figure
   spawned inside, doorway boarded with brick; distance-from-door done;
   survives guard; dig hint).
3. **`src/sim/events.ts`**: `EventBus.onAny` (runs before typed
   handlers; listenerCount includes them). Additive; all old tests pass.
4. **`src/main.ts` wiring**: `resolveSites` at boot; `ScenarioEngine` +
   `ScenarioIo` over the live game (io.edit = the player's undoable
   edit path); `bus.onAny → engine.onGameEvent`; **`startScenario(id)`**
   tries candidate buildings nearest-first and **rotates past stages
   that can no longer host the scenario** (readiness re-check per
   candidate); **J** cycles the registry; scenario tick LAST in the
   fixed step; HUD `SCEN … [x]/[!]/[ ]/[?] … J next` + announcement
   line (600-tick freshness); `L` load stops the run;
   `__mw.scenario` = { engine, sites, activeSites(), ids, start, stop,
   notes }.
5. **Tests** (`tests/scenario.test.ts`, NEW — 24 → **444 total**, 33
   files): engine semantics + all five scenarios end to end on fixture
   rigs wired like the game (bus ↔ engine, real collapse edits, sims in
   main's order; lake/flat worlds, wood house + two-story fixtures,
   pressurized water main) + real-generator site resolution on seed
   24680 (determinism, ordering, readiness, all-five-buildable).
6. **Benchmarks** (`benchmarks/scenario.bench.ts`, NEW): ≈0.11 µs/tick
   idle and under a 512-event log — `docs/performance.md`.
7. **Docs**: architecture "Scenario system (Phase 18)", known-issues
   "Scenarios (Phase 18)" (7 entries incl. the open probe findings),
   performance scenario baselines, README (state 0–18, quickstart
   scenarios paragraph + J, layout), CHANGELOG `[0.16.0]`,
   MICRO_WORLD_PROGRESS (Session 014 + status + checklist), HANDOFF
   (this file).

## First tasks tomorrow (Session 015) — the three open probe items

All three were found by `.verify/probe-p18.mjs` (run once; kept in
`.verify/` for reuse). Unit tests are green throughout — these are
live-world behaviors.

1. **Rescue failed `The figure survives`** (victim vanished mid-run).
   Facts: start ✓, HUD `SCEN` line ✓, victim spawn count read 16,
   probe dug 11 BRICK cells around the door ✓, then within ~30 s the
   `alive` guard fired (`npcById(counter('victim')) === undefined`).
   Population `maintain()` only despawns past 80 cells (checked), and
   house A sits near spawn — so the figure was removed another way OR
   the spawn/counter path misfired. **Instrument**: after start, every
   ~2 s dump `activeSites().buildings[0].spec.door`,
   `__mw.scenario.engine` objective views, the victim's id via the
   counter (engine.counters are private — read via a probe trigger or
   track `__mw.npc.list()` ids vs. the post-start delta), each figure's
   distance from the door, and any `npcDied` bus emissions. Suspects:
   (a) npcDied via water sweep after the figure exited and wandered;
   (b) the dig (11 cells!) triggered a structural collapse that
   dropped/removed the interior stand → figure fell → ??? (NPC fall
   lands or sweeps); (c) `spawnAt` failed silently (counter 0 →
   insta-fail — would show immediately, which the timeline allows).
2. **Fire failed `Keep it off the neighbors`** — grass lawns carry fire
   between houses fast; the probe doused late (after a 2.5 s screenshot
   wait) and only the target's body. Likely correct-but-hard. Retune the
   probe: douse immediately, or `forceWeather('rain')` after ignition to
   contain, or widen the douse to the block. Decide whether lawn-spread
   difficulty is wanted (plan §57 likes it; the HUD hint could warn).
3. **Demolition found no ready candidate** (`start('demolition')` →
   false) after ~50 s of unattended neighbor fire during the collapse
   window — plausibly the town block genuinely burned (rotation checked
   all 143). Re-probe with fire containment (rain) right after the fire
   scenario; if it still fails, dump per-candidate
   `scenarioReady`-equivalent info via a small in-page loop (the
   rotation lives in main's `startScenario`).

Then: write the Phase 18 harness section (shape listed in "Pending
heavy work"), add it to the deferred-run list, and proceed to Phase 17
leftovers (NPC night sight sampling local light via the existing
`lightLevel` option, inspector sky/block readout, day/night lamp
switching in the power sim) or Phase 19 — Scripting (plan §119; the
scenario engine's condition/trigger/action shape was deliberately
aligned with it).

## Session 014 lessons (new ones only)

- **Fixture structural honesty**: a test main floating over the lake
  basin was correctly toppled by the Phase 11 support graph once the
  burst hole appeared — pruning the leak and insta-completing the flood
  scenario. The sims were right; the fixture was a building code
  violation. Bisect with throwaway probes instead of trusting either
  side (`probe-flood.ts` → found in two runs).
- **Instant-win hazards in staged content**: any setup that the live
  sims can immediately undo (a fire staged in a sealed pocket is
  smothered on tick 1; baselines inflated by terrain make
  "half-consumed" unreachable; a guard-only objective set completes
  vacuously) needs a validation pass that models the sim's rules
  (`findFlammable` sealed/wet checks; `buildingBody` baselines;
  ≥1-positive-objective completion rule).
- **A failing engine tick order shows up as weird objective outcomes**
  (deadlines expiring while locked, guards completing scenarios) —
  pin evaluation-order semantics in unit tests before debugging
  conditions themselves.
- Probe logistics: `browser.newPage()` per probe stage gives a fresh
  localStorage each time (no save carryover between probe pages);
  screenshots need the pointer-lock click first (the overlay scrim
  eats bright scenes — Session 013 lesson, re-confirmed).

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; check `uptime` +
   top-CPU stragglers; `npm run dev` in background (log to /tmp);
   `cd .verify && node probe-p18.mjs` (or a new instrumented probe) —
   work the three items above.
2. Keep the VM-load policy: no full harness runs; probes and the one
   micro-bench file are the approved load class.
3. After the diagnostics: retune/fix, re-run the probe clean, write
   the harness section, update PROGRESS/known-issues, commit.
4. Then Phase 17 cheap consumers or Phase 19 — Scripting.

## Key design facts (for working on the scenario system)

- The engine is **pure and bus-agnostic**: main injects everything via
  `ScenarioIo`; conditions get a per-tick `ScenarioContext`. Sims are
  never touched directly — reads go through `io.world`/`io.npc`/
  `io.sensors`, writes through `io.edit`/`io.ignite`/`io.forceWeather`
  (edits ride the player's undoable path and autosave gate).
- **Evaluation order per tick**: triggers (once each) → scenario
  `failed` → `timeLimit` → objectives in declaration order (done wins
  ties against failed within the same objective; a later objective's
  failure overrides an earlier one's completion in the same tick).
- **Rotation**: main's `startScenario` rotates the sorted buildings
  array per candidate; each scenario definition closes over its
  rotated `sites`, so `sites.buildings[0]` is always the staged target
  (`__mw.scenario.activeSites().buildings[0]` from probes).
- **Event log**: recorded only while running, capped 512 (shift on
  overflow), cleared on start. `eventsQuiet(type, x, y, z, r, span)` =
  no matching event within `span` ticks (last match ≤ ticks − span).
- Determinism (ADR-005): no RNG anywhere in the scenario layer; all
  loops fixed-order; same tick sequence ⇒ same run.
- Scenario state is transient like fire/NPC state — `L` (load) stops
  the run; staged damage persists via the edit journal as normal.

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`, `src/npc/`,
  `src/worldgen/`, `src/scenario/`, `src/player/controller.ts`) stays
  free of three.js and DOM (ADR-002); all three.js lives in
  `src/render/`.
- Terrain/town/utilities are pure functions of (seed, coordinates);
  material IDs append-only; sims observe via chained World hooks and
  budget their ticks; NPC sims never write voxels; benchmarks and
  harness runs need an otherwise-idle machine.
