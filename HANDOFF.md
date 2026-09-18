# HANDOFF — Session 015 wrap (2026-09-18)

**Status: Phase 18 (Scenario System) is now live-verified END TO END.**
The three open probe items from Session 014 were root-caused (all three
were real Phase 18 bugs, not probe flukes or tuning), fixed, unit-tested
(+4 → **448** / 33 files), and verified in-page: **all five scenarios
start, play, and complete on seed 24680 with zero page errors**
(`probe-p18-chain2.mjs` + a human-timing fire check). The Phase 18
harness section is **written** (8 checks, two pages) but its first run is
deferred per the VM-load policy. Committed as `[0.16.1]`.

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).**

**⚠ The headless harness needs Playwright inside `.verify/`** (own
`package.json` + gitignored `node_modules`). It is installed; never
`npm install` at the repo root.

**⚠ Before any probe/harness/bench run: check `uptime` AND
`ps aux --sort=-%cpu` for stale node/vite processes. During a run:
touch nothing (absolute rule).** (Session 015 left a dev server RUNNING
in the background: `npm run dev`, log `/tmp/mw-dev.log`, PID in the
session — kill it before harness/bench work, or reuse it for probes.)

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
   utilities numbers carry loaded-VM caveats (scenario bench ≈0.11
   µs/tick is also load-~2 but tiny; no new bench files this session).
5. Manual GUI pass (user) — pending since Phase 7.

## What landed this session

1. **Root cause 1 — scenario target selection** (`src/scenario/
   definitions.ts`): `pickNearest` compared stringified
   `"distance,x,z"` keys, so `"100,-75,-30"` sorted before `"8,-3,5"`.
   Fire/rescue staged on a house ~100 cells from spawn — **outside the
   NPCs' 80-cell despawn radius** — where `maintain()` silently
   distance-despawned the rescue victim on tick 1 (the "vanished
   figure", insta-fail at `t=1`, no `npcDied`), while HUD/probe code
   read `buildings[0]` (a different building) — which also explains the
   boards "not landing" and session 014's douse-the-wrong-house.
   `scenarioTarget` is **positional** now (first suitable entry of the
   rotated, nearest-first array; houses preferred for fire/rescue). This
   also fixes a latent design flaw: with a correct comparator, a
   proximity re-scan would ignore the rotation and restage the same
   global-nearest building for every candidate — the rotation contract
   ("`activeSites().buildings[0]` is the staged target") is real now.
2. **Root cause 2 — fire staged on the lawn**: `findFlammable` scanned
   the outer box, whose y-courses reach the grass apron below/around the
   walls, so the "house fire" ignited GRASS — spreading ≈1 cell/tick,
   neighbor-box hits within ~10 ticks (unwinnable by construction; the
   unattended blaze then burned the town block, which is why demolition
   later found "no ready candidate"). Setup and `scenarioReady('fire')`
   now scan the **building body** (footprint, floor up).
3. **Root cause 3 — neighbor guards gated on lawn-level boxes**: fire
   and demolition now count `fireIgnited` inside neighbor **bodies**
   (structures). The old boxes reach lawn level; a scorched-lawn
   crossing tripped them in under a second. Verified winnable with a
   4 s human-ish reaction delay (douse at t≈55, 82 cells burning →
   complete, neighbors held). Explosions still guard on full boxes.
4. **`__mw.scenario.target()`** (main.ts): the staged site — fire/rescue
   prefer houses, so it is NOT necessarily `buildings[0]`. Probes and
   HUD-adjacent code must use this.
5. **Tests** (+4 → 28 in `tests/scenario.test.ts`, **448 total**, 33
   files): rotation contract over resolved sites; positional selection
   (far-first array wins); body-only fire ignition (wood-apron
   fixture); lawn-tolerant neighbor guard.
6. **In-page verification** (`.verify/probe-p18-chain2.mjs` +
   `probe-p18-fire-human.mjs`, zero page errors): rescue complete
   (boards BRICK at the house door → dig 2 → figure walks free, no
   deaths), fire complete (interior blaze, doused, zero neighbor hits),
   collapse complete (carve → cascade → quiet window → witness safe),
   demolition complete (raze by hand); flood re-verified from session
   014. Screenshots `p18-*-fixed.png` in `.verify/artifacts/`.
7. **Phase 18 harness section** (`.verify/run.mjs`): hook/sites census;
   rescue stage+HUD+complete; flood burst→pump; fire douse (fresh page);
   collapse clear+quiet; demolition raze. Written + `node --check`ed;
   **never run** — join the deferred list above.
8. **Docs**: known-issues "Scenarios (Phase 18)" rewritten (findings
   closed, lawn-rate note → Phase 10 tuning question), architecture
   scenario section (positional targeting, body staging/guards,
   `target()`), CHANGELOG `[0.16.1]`, MICRO_WORLD_PROGRESS (Session 015
   + status), HANDOFF (this file).

## First tasks tomorrow (Session 016)

**Phase 19 — Scripting (plan §119)**: events, triggers, conditions,
actions, variables, timers. The scenario engine (Phase 18) was
deliberately shaped like this layer — recommended slice:

1. **Pure scripting core** (`src/script/`, ADR-002): `ScriptDef` =
   event subscriptions (bus types + position/box filters) → conditions
   (reuse the `ScenarioContext` query shape: counters, censuses, event
   queries) → actions (a subset of `ScenarioIo`: edits, ignite, weather,
   spawn, announce) + named variables + timers (tick-delayed one-shot or
   repeating). Same engine discipline as scenarios: pure, deterministic,
   bus-fed, injected I/O, budgeted censuses.
2. **Console/surface** (main.ts + DEV hook): a minimal `__mw.scripts`
   API and (cheap) a creator-mode text console later; do NOT build the
   plan §65 node UI.
3. **Tests**: timer semantics, one-shot vs repeating triggers, variable
   scoping, action budgeting, a couple of end-to-end vignettes on
   fixture rigs (e.g. "on fireStarted near the warehouse → announce +
   spawn figure").
4. Cheap Phase 17 consumers can ride along if time remains: NPC night
   sight sampling local light (`lightLevel` option exists), inspector
   sky/block readout, day/night lamp switching in the power sim.

## Session 015 lessons (new ones only)

- **A string-keyed "tuple" comparator is a real bug class**: `${d},${x},
  ${z}` sorts lexicographically — `"100,…"` < `"8,…"`. Any
  nearest-first code building sort keys must compare numerically
  (tuple-by-tuple), not as strings. The probes had "verified" around
  this for a full session because flood/collapse completed anyway.
- **Insta-fails masquerade as mid-run failures**: the session-014 probe
  never polled `engine.current` before its dig, so a t=1 failure read
  as "vanished mid-run". Poll status immediately after any staged
  start; instrument with same-turn reads (start + state dump in ONE
  `evaluate`) before round-trip sampling.
- **Silent removals need patched sims**: `maintain()`'s distance despawn
  emits no event; when an NPC vanishes without `npcDied`, monkey-patch
  `maintain`/`tick` (prototype-level, runtime) to log removals and
  centers.
- **Scenario boxes reach the terrain**: a building's outer box includes
  lawn-level courses; guards on "the building" must use the body box
  (footprint, floor up). Grass burns at ≈1 cell/tick — any fire guard
  measured in ticks that a lawn can trip is unwinnable.
- **`activeSites().buildings[0]` was never the contract** — the staged
  target is `scenarioTarget`'s pick; use `__mw.scenario.target()`.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; check `uptime` +
   top-CPU stragglers; kill or reuse the session-015 dev server
   (`/tmp/mw-dev.log`, :5173).
2. Start Phase 19 per the slice above (pure `src/script/` core first,
   tests, then main wiring; no node-UI).
3. Keep the VM-load policy: no full harness runs; probes and single
   micro-bench files are the approved load class. The harness Phase 18
   section + Phase 16/17 runs stay on the deferred list.
4. If a harness window opens instead: run `.verify/run.mjs` on an idle
   box (Phase 18 first run + Phase 16 ×2 + Phase 17 first run), then
   update the harness notes in PROGRESS.

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
- **Rotation contract**: `startScenario` rotates the nearest-first
  sorted buildings array per candidate; `scenarioTarget` picks
  positionally (first suitable entry), so the staged target is always
  `activeSites().buildings[0]` — except house-preferring ids, where it
  is the first house; read `__mw.scenario.target()` when in doubt.
- **Body vs box**: `buildingBody(spec)` = footprint, floor up (no pad,
  no apron) — destruction baselines AND fire staging AND neighbor fire
  guards use bodies; full boxes are for explosions/water/collapse
  geometry.
- **Event log**: recorded only while running, capped 512 (shift on
  overflow), cleared on start. `eventsQuiet(type, x, y, z, r, span)` =
  no matching event within `span` ticks (last match ≤ ticks − span).
- Determinism (ADR-005): no RNG anywhere in the scenario layer; all
  loops fixed-order; same tick sequence ⇒ same run.
- Scenario state is transient like fire/NPC state — `L` (load) stops
  the run; staged damage persists via the edit journal as normal.
- NPC facts that matter here: `DESPAWN_RADIUS` = 80 (silent, no event);
  deaths are only `explosion`/`drowned` (both emit `npcDied`);
  population fills ≤1 spawn/tick toward 16.

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
