# HANDOFF — Session 015 wrap (2026-09-18, full session)

**Status: two releases. `[0.16.1]` — Phase 18 is live-verified END TO
END**: the three open probe items from Session 014 were root-caused
(all three were real Phase 18 bugs), fixed, unit-tested, and verified
in-page — **all five scenarios start, play, and complete on seed 24680
with zero page errors**. `[0.17.0]` — **Phase 19 (Scripting) is
implemented and verified**: pure script engine (event/condition
triggers, gates, actions through the scenario io, shared variables,
tick timers), main wiring, `__mw.scripts` hook, 10 tests, micro-bench
numbers, live probe. **458 unit tests / 34 files green**,
typecheck/lint/prettier/build clean. The Phase 18 harness section is
written but its first run is deferred (VM-load policy).

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).**

**⚠ The headless harness needs Playwright inside `.verify/`** (own
`package.json` + gitignored `node_modules`). It is installed; never
`npm install` at the repo root.

**⚠ Before any probe/harness/bench run: check `uptime` AND
`ps aux --sort=-%cpu` for stale node/vite processes. During a run:
touch nothing (absolute rule).** (Session 015 left a dev server RUNNING
in the background: `npm run dev`, log `/tmp/mw-dev.log` — kill it
before harness/bench work, or reuse it for probes on :5173.)

## Pending heavy work (skip-for-now list — do these when idle)

1. **Phase 18 harness first run** — `.verify/run.mjs` full run; the new
   Phase 18 section (8 checks, two pages on `?seed=24680`) has never
   executed; the probes verified each piece but not the section itself.
2. **Phase 16 harness confirmation** — full run ×2 consecutive: Phase 16
   section 8/8, Phase 15 still 8/8, zero page errors (carried since
   Session 012).
3. **Phase 17 harness first run** — the 5-check Phase 17 section has
   never run (carried since Session 013).
4. **Benchmark re-runs on an idle machine** — atmosphere, light,
   utilities numbers carry loaded-VM caveats (scenario/script benches
   are also load-~2 but tiny).
5. Manual GUI pass (user) — pending since Phase 7.

## What landed this session

### `[0.16.1]` — Phase 18 probe fixes (all five scenarios verified live)

1. **Root cause 1 — target selection** (`src/scenario/definitions.ts`):
   `pickNearest` compared stringified `"distance,x,z"` keys, so
   `"100,-75,-30"` sorted before `"8,-3,5"`. Fire/rescue staged on a
   house ~100 cells from spawn — **outside the NPCs' 80-cell despawn
   radius** — where `maintain()` silently distance-despawned the rescue
   victim on tick 1 (the "vanished figure": insta-fail at `t=1`, no
   `npcDied`), while HUD/probe code read `buildings[0]` (a different
   building). `scenarioTarget` is **positional** now (first suitable
   entry of the rotated, nearest-first array; houses preferred for
   fire/rescue) — which also makes the rotation contract real: with a
   correct comparator, a proximity re-scan would have restaged every
   rotation on the same global-nearest building.
2. **Root cause 2 — fire staged on the lawn**: `findFlammable` scanned
   the outer box, whose y-courses reach the grass apron, so the "house
   fire" ignited GRASS — ≈1 cell/tick, neighbor-box hits within ~10
   ticks (unwinnable by construction; the unattended blaze then burned
   the town block — demolition's "no ready candidate"). Setup and
   `scenarioReady('fire')` now scan the **building body** (footprint,
   floor up).
3. **Root cause 3 — neighbor guards gated on lawn-level boxes**: fire
   and demolition count `fireIgnited` inside neighbor **bodies**
   (structures); scorched lawns are tolerated. Verified winnable with a
   4 s human-ish reaction delay (douse at t≈55, 82 cells burning →
   complete, neighbors held). Explosions still guard on full boxes.
4. **`__mw.scenario.target()`** — the staged site (fire/rescue prefer
   houses; NOT necessarily `buildings[0]`). Probes must use this.
5. Tests +4 (28 in file): rotation contract, positional selection,
   body-only ignition (wood-apron fixture), lawn-tolerant guard.
6. In-page chain probe + human-timing fire check: rescue/fire/collapse/
   demolition complete live; flood re-verified from session 014.
   Screenshots `p18-*-fixed.png`.
7. **Phase 18 harness section** (`.verify/run.mjs`, 8 checks, two
   pages): hook census; rescue stage+HUD+complete; flood burst→pump;
   fire douse; collapse clear+quiet; demolition raze. Written +
   `node --check`ed; never run (deferred list above).

### `[0.17.0]` — Phase 19 Scripting (plan §119)

1. **`src/script/engine.ts`** (pure, ADR-002/005): continuous rules
   over the live world — the scenario engine's shape generalized.
   Triggers fire on bus **events** (`on`: type + radius/box filter,
   synchronously inside `onGameEvent` in emission order — one fire per
   event per trigger) or on a **condition's rising edge** (`when`,
   evaluated per tick in script-load then declaration order). Gates:
   `if` (fire-time; false swallows an event trigger's event — rules
   that must re-check belong on `when`), `cooldown` (ticks between
   fires), `maxFires` (lifetime cap). **Actions** are plain calls on
   the same `ScenarioIo` the scenarios use. Engine-level: shared
   numeric **variables**, **timers** (`after` one-shot / `every`
   repeating, cancellable handles), capped event log (512, recorded
   only while scripts are loaded) backing the scenario-style queries +
   budgeted `countInBox`. Per-tick order: due timers (creation order)
   → condition triggers. Deterministic (no RNG, fixed iteration
   order). Not saved (creator logic — `L` does not stop them).
   `attach(io)` stores the io event triggers need between ticks (bus
   emissions carry none); `clear()` resets scripts+timers+vars+log but
   not the clock.
2. **main wiring**: `scripts.attach(scenarioIo)` + `bus.onAny →
onGameEvent` right after the scenario wiring; `scripts.tick(
scenarioIo)` just BEFORE `scenario.tick` in the fixed step (a
   script reacting to this step's events stages the world; the
   scenario tick, last as ever, sees the result); `__mw.scripts` =
   { engine, load, unload, clear, after, every, variable, setVariable }
   (the hook's `load`/timers bind the io — page-side callers pass a
   def only).
3. **Tests** (`tests/script.test.ts`, NEW — 10): dispatch + filters,
   gates, rising-edge re-arm, shared variables + setup, timer
   semantics + ordering (timers before condition triggers in the same
   tick), reload/unload/clear state, event-log queries, end-to-end
   vignette over the real fire sim (ignite → script wets the ground →
   fire snuffs).
4. **Benchmarks** (`benchmarks/script.bench.ts`, run directly via
   `npx vite-node`): tick with a loaded script ≈ 0.39 µs/tick; event
   fire under a 512-entry log ≈ 0.49 µs/event; timers-only early exit
   ≈ 0.05 µs/tick — `docs/performance.md`.
5. **Live probe** (`.verify/probe-p19.mjs`, zero page errors): fire
   watcher (event trigger + `if` gate + counter), rising-edge reactor
   (both announcements landed), `after`/`every` timers (heartbeat
   counted at tick 60 of 100 elapsed) — all verified in the real page.
   Note: a 345-cell fire drags the page to ~10 fixed steps/s — douse
   before measuring timer wall-clock behavior.
6. **Docs**: architecture "Scripting (Phase 19)" + scenario-section
   updates (positional targeting, body staging/guards, `target()`),
   known-issues "Scenarios (Phase 18)" rewritten (findings closed;
   lawn-rate → Phase 10 tuning) + new "Scripting (Phase 19)" (6
   entries), performance script baselines, README (state 0–19,
   scripting paragraph, layout), CHANGELOG `[0.16.1]` + `[0.17.0]`,
   MICRO_WORLD_PROGRESS (Session 015 + status), HANDOFF (this file).

## First tasks tomorrow (Session 016)

**Decision first**: Phase 20 (plan §120) is LLM Integration — "only
after the deterministic simulation is mature" — and it needs a model
endpoint reachable from this VM. If none is available, skip (per the
plan's slippage order, LLM integration is cuttable) and go to:

1. **Phase 21 — Performance** (plan §121): profile CPU/GPU/memory on
   the traces we have; but SwiftShader + 2–3 cores make absolute
   numbers shaky — favor CPU-side wins (chunk memo, mesher budgets,
   light BFS pops).
2. **Phase 17 cheap leftovers** (they ride along well with anything):
   NPC night sight sampling local light (the `lightLevel` option
   exists — feed it `light.blockAt` blended with sky), inspector
   sky/block readout, day/night lamp switching in the power sim.
3. **Script console** (Phase 19 follow-up, small): a dev-only text
   console (Tilde) that loads ScriptDefs — pairs with the plan §67
   world console later.

If a harness window opens instead: run `.verify/run.mjs` on an idle
box (Phase 18 first run + Phase 16 ×2 + Phase 17 first run), then
update the harness notes in PROGRESS.

## Session 015 lessons (new ones only)

- **A string-keyed "tuple" comparator is a real bug class**: `${d},
${x},${z}` sorts lexicographically — `"100,…"` < `"8,…"`. Nearest-
  first code must compare numerically, tuple-by-tuple. The probes had
  "verified" around this for a full session because flood/collapse
  completed anyway (their mechanics are target-agnostic).
- **Insta-fails masquerade as mid-run failures**: the session-014 probe
  never polled `engine.current` before its dig, so a t=1 failure read
  as "vanished mid-run". Poll status immediately after any staged
  start; instrument with same-turn reads (start + state dump in ONE
  `evaluate`) before round-trip sampling.
- **Silent removals need patched sims**: `maintain()`'s distance
  despawn emits no event; when an NPC vanishes without `npcDied`,
  monkey-patch `maintain`/`tick` (prototype-level, runtime) to log
  removals and centers.
- **Scenario boxes reach the terrain**: a building's outer box includes
  lawn-level courses; guards on "the building" must use the body box
  (footprint, floor up). Grass burns at ≈1 cell/tick — a fire guard in
  ticks that a lawn can trip is unwinnable.
- **`activeSites().buildings[0]` was never the contract** — the staged
  target is `scenarioTarget`'s pick; use `__mw.scenario.target()`.
- Prettier re-wraps long single-line TS signatures onto multiple lines,
  where `readonly` on a method signature becomes a compile error
  (TS1024) — keep interface method members `readonly`-free.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; check `uptime` +
   top-CPU stragglers; kill or reuse the session-015 dev server
   (`/tmp/mw-dev.log`, :5173).
2. Make the Phase 20 skip/attempt call (endpoint availability), then
   work the First-tasks list above.
3. Keep the VM-load policy: no full harness runs; probes and single
   micro-bench files are the approved load class. Harness sections
   stay on the deferred list.
4. Commit per release, keep docs (architecture/known-issues/
   performance/README/CHANGELOG/PROGRESS/HANDOFF) current per phase.

## Key design facts (for working on scenarios + scripts)

- Both engines are **pure and bus-agnostic** (ADR-002): main injects
  everything via `ScenarioIo` (journaled edits, ignite, weather,
  force-load, spawnAt, announce, sensors); conditions read a per-tick
  context (ticks, event-log queries, counters/variables, box censuses,
  npcById). No RNG anywhere (ADR-005) — same tick sequence ⇒ same run.
- **Scenario evaluation order per tick**: triggers → scenario `failed`
  → `timeLimit` → objectives in declaration order; completion needs
  ≥1 positive objective. **Script per-tick order**: due timers
  (creation order) → condition triggers (load then declaration order);
  event triggers fire synchronously in `onGameEvent` (emission order).
- **Rotation contract**: `startScenario` rotates the nearest-first
  buildings array per candidate; `scenarioTarget` picks positionally
  (first suitable entry), so the staged target is always
  `activeSites().buildings[0]` — except house-preferring ids; read
  `__mw.scenario.target()` when in doubt.
- **Body vs box**: `buildingBody(spec)` = footprint, floor up — fire
  staging AND fire/demolition neighbor guards AND destruction baselines
  use bodies; full boxes are for explosions/water/collapse geometry.
- **Event logs**: scenario log records only while a scenario runs;
  script log only while any script is loaded; both capped 512,
  `eventsQuiet(type,x,y,z,r,span)` = no match within `span` ticks.
- Scenario state is transient (`L` stops the run); scripts are creator
  logic (not stopped on `L`, not saved); staged damage persists via
  the edit journal either way.
- NPC facts that matter here: `DESPAWN_RADIUS` = 80 (silent, no
  event); deaths are only `explosion`/`drowned` (both emit `npcDied`);
  population fills ≤1 spawn/tick toward 16.

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`, `src/npc/`,
  `src/worldgen/`, `src/scenario/`, `src/script/`,
  `src/player/controller.ts`) stays free of three.js and DOM
  (ADR-002); all three.js lives in `src/render/`.
- Terrain/town/utilities are pure functions of (seed, coordinates);
  material IDs append-only; sims observe via chained World hooks and
  budget their ticks; NPC sims never write voxels; benchmarks and
  harness runs need an otherwise-idle machine.
