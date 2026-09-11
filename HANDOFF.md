# HANDOFF — Session 008 wrap (2026-09-11)

**Status: Phase 12 (NPCs) is COMPLETE — implemented, verified, documented,
and committed. 309 unit tests green; typecheck/lint/prettier clean; the
headless browser suite's Phase 12 NPC section is 10/10 green across two
runs (zero page errors). Canonical long-term state lives in
`MICRO_WORLD_PROGRESS.md` (Session 008 log + Current Status); this file
is the short pickup map.**

**⚠ First command of every shell: `export PATH="$HOME/.local/bin:$PATH"`**
(npm/node live in `~/.local/opt`, linked from `~/.local/bin`).

## What landed this session (Phase 12 — NPCs)

1. **`src/npc/navigation.ts`** (pure): walkable-cell queries + A\* over
   the implicit grid graph — there is no nav structure to rebuild after
   edits (plan §40). A cell is walkable when it and the cell above are
   open (not solid, **not water**) and the cell below is solid; moves
   are flat, +1, or drops ≤ `MAX_DROP = 3` with a lip-clearance rule so
   deep drops must fall clear past the ledge. Manhattan heuristic +
   insertion-order tie-breaks = deterministic optimal paths;
   `maxExpansions` budget bounds hopeless searches. `nearestWalkable`
   (±4 y window) anchors spawns/goals; `pathTouches` is the
   invalidation helper (checks path cells AND their floors).
2. **`src/npc/npc.ts`** (pure): `NpcSim` over `NpcState` — schedule
   state machine (idle/wander/goto/sleep + intent home/work/wander) on
   a tick-count clock (100 ticks/hour, day = 2400 ticks ≈ 40 s, starts
   08:00): night (22–06) or exhaustion → path home → sleep until dawn +
   rested; work hours → ~60% commute; else hash-scattered wander.
   Needs are deterministic (sleep +100/day awake, −4× asleep, gates
   bedtime; hunger rises with no consumer — no food exists). Movement
   is grid-following (2.2 cells/s, vertical easing); the one physical
   rule: support vanished under a figure → gravity fall → landing
   re-path; landing in water despawns ("swept away"). Population
   maintenance: ≤ 1 spawn/tick (ring 14–60), despawn past 80, cap 16.
   **NPCs are transient — not in the save format**; reloads
   repopulate deterministically.
3. **Determinism**: no sequential RNG — every choice is
   `hash3(id, salt, timeTicks, seed)`. Identical tick sequences are
   bit-identical (unit-tested).
4. **Local invalidation**: the sim chains onto `World.onVoxelChanged`
   (read-only; NPCs never write voxels) and re-paths only paths the
   edit severed, budgeted `DECIDES_PER_TICK = 3` A\* searches per fixed
   step, each ≤ 512 expansions (~5 ms worst).
5. **Render + wiring**: `src/render/npcViz.ts` — one pooled
   InstancedMesh of activity-tinted capsules (sleepers lie down;
   unlit MeshBasicMaterial — the scene has no lights). main.ts: sim
   ticks after structure in the fixed step, population centers on the
   player, HUD `· npc N`, `npc`/`npcViz` on `__mw`, `npc.reset()` on
   load.
6. **Tests**: 31 new (309 total, 25 files) — navigation fixtures via
   heightmap queries + a bespoke sealed fixture; schedule transitions
   (night sleep at home → dawn wake, noon exhaustion bedtime),
   wall-rise re-path, collapse fall, water sweep, population
   fill/despawn, cross-sim determinism, 5000-tick fuzz with mid-run
   edits.
7. **Benchmarks** (`benchmarks/npc.bench.ts`): **GATE re-path ~1 ms**
   (24 cells, real terrain); sealed-goal worst case ≈ 5 ms at the
   512-expansion budget; **GATE 16-NPC population tick 0.03 ms mean**.
   Baselines in `docs/performance.md`.
8. **Docs**: architecture "NPCs (Phase 12)", performance NPC baselines,
   known-issues "NPCs (Phase 12)" section, README, CHANGELOG `[0.10.0]`,
   progress file (Session 008 + Phase 12 checklist + Documentation/QA
   backlog updates).

## Harness lessons recorded this session

- **Load drives the input-race mix.** Back-to-back harness runs + a
  crashed process pushed the 15-min load average to ~5.9 and the
  documented Phase 7/8/10 races (dropped keys/clicks at ~10 fps
  software rendering) got much worse — including cascades that felled
  the Phase 8 gate _via its own dropped delete-click_. After the load
  settled, the world-state gates (conservation, cantilever, prefab,
  save/reload where the input landed) passed again. Check `uptime`
  before diagnosing; re-run before fixing.
- **Continuous-state checks must read the sim's own rule.** The NPC
  "standing" check re-derived geometry in the harness and flaked on
  the vertical easing band (mid-climb reads solid; mid-drop reads
  unsupported). Fixed by reading the sim's invariant (`falling` flag +
  the sim's `ceil(y)-1` support rule). Same class as Session 007's
  fixture-geometry lesson, one level deeper.
- A bench that early-outs is worse than no bench: the first "sealed
  goal" worst case wasn't walkable (unanchored in unloaded terrain) and
  measured 0.9 µs of nothing. Probe what a bench measures before
  recording it.

## How to pick up (next session)

1. `export PATH="$HOME/.local/bin:$PATH"`; `npm install`; `npm test`
   → expect **309** green; `npm run dev`, open `?seed=24680` → up to 16
   capsule figures wander the terrain (HUD `· npc 16`); wait for
   ~22:00 on the game clock (or set `__mw.npc.timeTicks = 2200` in the
   console) → they path home, sleep (lie down, dark blue), and wake at
   dawn; dig under a figure → it falls and re-paths; build a wall in
   front of a walker → it re-routes.
2. **Phase 13 (NPC Reactions)** per the plan §111: perception (vision
   distance/FOV/LOS — `raycast.ts` is reusable; hearing with simple
   attenuation), fear, and event reactions. The bus already carries
   `explosion`/`structureCollapsed`/`fireIgnited`; `NpcSim` already
   demonstrates the re-path-on-world-change pattern; health is wired
   with no damage source yet. See the Session 008 log's "Recommended
   next steps" for the concrete breakdown.
3. If NPC _feel_ needs work first: figures cannot jump, wade, or climb
   more than one block per step, and there is no figure-figure
   collision — all documented in known-issues "NPCs (Phase 12)".

## Agreed approach (unchanged)

- Single npm package at the repo root; TypeScript strict, Vite, Vitest
  node environment, ESLint flat + Prettier, CI on Node 22.
- Pure code (`src/voxel/`, `src/creator/`, `src/sim/`, `src/npc/`,
  `src/player/controller.ts`) stays free of three.js and DOM (ADR-002);
  all three.js lives in `src/render/`; DOM adapters in `src/player/`,
  `src/persistence/`, `src/audio/`.
- Terrain generation stays a pure function of (seed, coordinates);
  `hash2` frozen; `hash3` is the extensible variant (and now also the
  NPC randomness source).
- Material IDs are a serialization contract: don't renumber. Derived
  tables (`MATERIAL_HARDNESS`, `MATERIAL_FIRE`, `MATERIAL_STRENGTH`)
  stay out of the serialized schema.
- Save formats version up through a migration chain (now at v2);
  prefab format v1 validates structurally. NPC state is deliberately
  not in the save (transient, deterministic respawn).
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
- Benchmarks and harness runs need an otherwise-idle machine (2-core
  VM): never run formatters/edits during a verification run, and check
  `uptime` if a run looks unusually flaky.
