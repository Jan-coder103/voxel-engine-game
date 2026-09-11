# HANDOFF — Session 009 wrap (2026-09-11)

**Status: Phase 13 (NPC Reactions) is COMPLETE — implemented, verified,
documented, and committed. 330 unit tests green; typecheck/lint/prettier
clean; build succeeds. The headless browser suite's Phase 13 NPC-reaction
section is 9/9 green in two consecutive runs (zero page errors
throughout). Canonical long-term state lives in
`MICRO_WORLD_PROGRESS.md` (Session 009 log + Current Status); this file
is the short pickup map.**

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

## What landed this session (Phase 13 — NPC Reactions, plan §111)

1. **`src/npc/perception.ts`** (pure): vision = `canSee` — range
   (`SIGHT_DISTANCE` 24) × horizontal FOV (130°, movement-yaw
   convention) × voxel line of sight (the Phase 5 DDA reused with a
   solids-block-sight predicate; water never blocks; the ray stops
   ~0.75 short of the target so a burning block doesn't occlude
   itself). Hearing = per-event attenuation radii (explosion
   `radius·4 + 20`, collapse `min(60, 20 + 2·√cells)`) — no propagation
   field. `ThreatBoard` = capped (12), deduped per kind within 4 cells
   (one blaze = one threat), tick-expiring memory of event sites.
2. **`src/npc/npc.ts`**: `fear` (0–100) + `flee`/`investigate`
   activities on `NpcState`. Fear ≥ `PANIC_THRESHOLD` (50) overrides
   the schedule: **flee** paths away from the nearest remembered threat
   (14–20 cells, hash-jitter, 1.6× speed, sleep interrupted, home
   fallback, cower-and-retry); **investigate** paths to a stop-short
   anchor ≤ 4 cells from a heard site and looks. Staggered perception
   scans (every 10 ticks, offset by id): flood water at the feet →
   flight (no bus event needed), sleepers wake for threats within 5,
   and _seen_ threats add fear only within `ALARM_RADIUS` = 12 — so
   investigators reach the site, get a good look, then spook (the plan
   §42 chain, unit-tested as an arc). Fear decays ~0.1/tick.
3. **Explosion damage**: `NpcSim.notify(event)` (wired to the bus's
   `explosion`/`structureCollapsed`/`fireIgnited` in main.ts) applies
   distance falloff inside `radius + 3`, lethal within the crater's
   inner half, **quarter damage behind LOS-blocking walls**. Death
   despawns and emits the new **`npcDied`** bus event (`explosion |
drowned` — the water-sweep reports too). `notify` rejects non-finite
   events: NaN is sticky through `Math.min`/`Math.max` and would
   permanently poison fear (found by my own malformed harness event;
   regression-tested).
4. **Wiring/viz/HUD**: `npc.onEvent` flows back out to the bus;
   fleeing figures render red, investigating teal; HUD `· panic N`;
   `bus` exposed on `__mw`. NPCs remain transient — save format
   untouched.
5. **Tests**: `tests/npcReactions.test.ts` — 21 new (330 total):
   LOS/FOV/threat-board primitives, epicenter kill + `npcDied`, wall
   shield, flee-distance + calm-down, sleeper wakes (blast + blaze),
   collapse panic vs. investigate (with the approach-then-spook arc),
   fire seen/unseen, flood flight, NaN immunity, event-sequence
   determinism, 3000-tick disaster fuzz.
6. **Benchmarks** (`benchmarks/npc.bench.ts`): GATE population tick
   with active threats **0.12 ms mean** (p75 0.02); explosion notify
   ≈ 2 ms once per blast. Baselines in `docs/performance.md`.
7. **Docs**: architecture "NPC reactions (Phase 13)", known-issues NPC
   section rewritten for Phases 12–13, performance baselines, README,
   CHANGELOG `[0.11.0]`, progress file (Session 009 + Phase 12
   checklist Perception/Reactions ticked + Milestone 10 met + the town
   checklist header realigned to plan numbering as Phase 14).

## Harness lessons recorded this session (all three cost re-runs)

- **Audit the harness helper before suspecting the sim.** The suite's
  `npcState()` helper omitted `id` from its mapped output, so
  "find by id" checks always read "gone" while the sim behaved
  perfectly (a fresh-page probe proved it). When a check contradicts a
  probe, the helper is the suspect.
- **Malformed events are a real attack surface**: a destructuring
  past-the-end (`y: undefined`) reached `notify` as NaN and disabled
  every reaction permanently. The `notify` guard is the fix; if you add
  more inbound events, keep the finite-check at the door.
- **Harness state compounds within a section**: clock fast-forwards
  decide who's asleep; each emitted event stacks fear on everyone in
  earshot (repeated emits turn later subjects into panic-fleers); flee
  paths outlive `fear = 0` pokes (activity keeps running); craters from
  earlier blasts swallow later spawns. Order checks clean → dirty,
  reset what a check doesn't mean to test (per-attempt fear reset, long
  `waitTicks` to pin figures), and put state dumps in the `check`
  detail line — one diagnostic run beats three theory runs.
- **Load remains the dominant flake source**: across this session's
  runs (load 2 → 10) the Phase 7/8/10/12 synthetic-input failure mix
  swung 5 ↔ 17; the Phase 12 fall check joined the racy set (a walking
  figure re-paths away instead of falling). Check `uptime`, re-run idle
  before diagnosing.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install`; `npm test`
   → expect **330** green; `npm run dev`, open `?seed=24680` → wander
   until you see figures, then explode one (`__mw` console:
   `__mw.bus.emit({type:'explosion', x: p.x, y: 12, z: p.z, radius: 5,
destroyed: 10})` with `p = __mw.player.position`) → nearby figures
   flash red and run, HUD shows `· panic N`; light a wood structure
   (ignite tool) → figures within sight flee; collapse a pillar →
   distant figures walk over to look, then bolt. Wounded/killed
   figures report through `bus.on('npcDied', ...)`.
2. **Phase 14 (Procedural Town)** per the plan (§112): road graph on
   the height function, block/lot subdivision, a parameterized house
   generator first (NPC home/work anchors currently pick bare terrain
   cells — pointing them at generated door cells makes the town
   immediately alive), then shops/industrial, interiors, vegetation,
   river integration. See the Session 009 log's "Recommended next
   steps" for the concrete breakdown.
3. If NPC _feel_ needs work first: fear is one scalar with no herding
   or personality, hearing ignores walls, wounded figures don't
   regenerate — all in known-issues "NPCs (Phases 12–13)".

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`, `src/npc/`,
  `src/player/controller.ts`) stays free of three.js and DOM (ADR-002);
  all three.js lives in `src/render/`; DOM adapters in `src/player/`,
  `src/persistence/`, `src/audio/`.
- Terrain generation stays a pure function of (seed, coordinates);
  `hash2` frozen; `hash3` is the extensible variant (and drives all NPC
  randomness, now including reaction choices).
- Material IDs are a serialization contract: don't renumber. Derived
  tables (`MATERIAL_HARDNESS`, `MATERIAL_FIRE`, `MATERIAL_STRENGTH`)
  stay out of the serialized schema.
- Save formats version up through a migration chain (now at v2);
  prefab format v1 validates structurally. NPC state (including fear
  and threat memory) is deliberately not in the save (transient,
  deterministic respawn).
- Mesher changes must keep the greedy↔naive equivalence tests green
  (waterDrop is additive).
- Every destructive/creative gesture is one grouped `applyEdits`
  command. Fluid, fire, and structural-collapse writes go through
  `World.setVoxel` directly; collapses are applied by the game layer
  through `applyEdits` (via `structure.onCollapse`) so they stay
  undoable. NPC sims never write voxels at all.
- Sims observe world mutations by chaining onto `world.onVoxelChanged`
  (fluid → fire → structure → npc by construction order; the chain
  makes order harmless). The hook's signature is
  `(x, y, z, material, previous)`.
- Inbound events for sims go through an explicit method
  (`NpcSim.notify`) wired in main; outbound sim events use an
  `onEvent` callback (`FireSim`, `NpcSim`) — the pure core stays
  bus-agnostic.
- Benchmarks and harness runs need an otherwise-idle machine (2-core
  VM): never run formatters/edits during a verification run, and check
  `uptime` if a run looks unusually flaky.
