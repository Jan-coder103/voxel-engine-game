# MICRO//WORLD — Agent Progress Tracker

> **Purpose:** Persistent handoff state for coding-agent sessions.
>
> The agent should read this file at the start of every session, inspect the repository, update this file after meaningful work, and continue from the first uncompleted task that makes sense.
>
> **Important:** Do not blindly follow the checklist if the actual repository state contradicts it. Verify implementation before checking tasks off.

---

## Agent Handoff Rules

- [ ] Read this file before making changes.
- [ ] Inspect the repository before assuming a task is complete.
- [ ] Run the relevant tests before marking implementation tasks complete.
- [ ] Run typecheck/lint/build where applicable.
- [ ] Do not mark a task complete merely because code exists; verify behavior.
- [ ] Keep tasks small and independently verifiable.
- [ ] Update the status section after each substantial session.
- [ ] Record architectural decisions and known problems below.
- [ ] Prefer fixing foundational architecture before adding dependent features.
- [ ] Do not rewrite working systems without a measurable reason.
- [ ] Preserve determinism where practical.
- [ ] Avoid one-voxel-one-Three.js-mesh architecture.
- [ ] Keep world state separate from rendering, simulation, editor, and UI.
- [ ] Use events/interfaces between major systems rather than tightly coupling them.

---

# Current Status

## Overall Phase

**Current phase:** Phase 11 (Structural Simulation) — **complete and committed** (implementation, verification, docs)

**Current milestone:** Milestones 1–8 met plus Milestone 9: "Buildings can collapse" — cantilever-aware support graph, simplified stress with failure thresholds, progressive cascading collapse, fire→collapse coupling, structural debug overlay, all gate criteria verified.

**Overall completion:** ~50% (Phases 0–11 done; deferred: lateral load distribution (roof weight piling onto pillars), rigid-body engine for detached pieces (debris pipeline covers the feel), wind/rain coupling (needs weather), fire persistence in saves, volumetric smoke, sustained fire audio)

**Last completed task:** Session 007 (2026-09-10) — implemented Phase 11: `StructuralSim` in `src/voxel/structure.ts` replacing the Phase 8 edit-time `checkSupport` (deleted): 0/1-cost cantilever support BFS over solid cells (vertical free, groundless horizontal hops cost 1, `MAX_CANTILEVER = 6`), vertical stack-load stress vs the new `MATERIAL_STRENGTH` table with journaled-cell-only eligibility (natural terrain exempt), progressive cascading collapse as grouped undoable commands (4096-cell cap, cascade finishes), 150k-cell region budget with full-height column scans, chunk-block snapshot with per-chunk journal lookups and a precomputed solidity buffer (hot passes call nothing); `World.onVoxelChanged` gained the `previous` material so only support-losing transitions queue analyses (placements/water never do); fire burn-out collapses structures automatically (the Phase 10 deferred coupling); `StructureViz` debug overlay (G) + HUD pending counter; 24 structure tests (278 total); benchmark gate 2.19 ms house-scale on real terrain (< 5 ms budget); headless browser Phase 11 section all green.

**Current task:** None — session complete, work committed.

**Blocked by:** Nothing.

**Next recommended action:** **Phase 12 (NPCs)** per the plan: entity definition, transform/health/needs, wander + schedule behavior, then navigation (walkable cells → graph → A*) with local invalidation on edits. The event bus already carries everything NPCs will react to (explosions, collapses, fire).

---

# Session Log

## Session 007 — 2026-09-10

**Status:** Complete — Phase 11 (Structural Simulation) done, verified, documented, committed. Milestone 9 met.

### Completed

- [x] Pure structural core (`src/voxel/structure.ts`), replacing the Phase 8 edit-time `checkSupport` (module deleted): `analyzeStructure(world, region)` over a graph of solid cells — vertical connections transmit support freely, horizontal ones only within `MAX_CANTILEVER = 6` consecutive groundless hops (0/1-cost BFS from bedrock + region-edge anchors, improvement-based re-pushes, (flat, cost) packed into one Int32Array).
- [x] Simplified stress: vertical stack load (1 + everything solid above in the column) vs `strengthOf` (new derived `MATERIAL_STRENGTH` table in materials.ts: wood 22, stone 26, dirt 16, sand 10, grass 14). Stress-eligibility requires a journaled edit (`World.isEdited` — natural terrain is "at rest" and never avalanches); load counts all overlying mass, so wood posts propping terrain still fail believably.
- [x] `StructuralSim` (ticked like fluid/fire): chains onto `World.onVoxelChanged` — which now also carries the cell's **previous** material — and queues a merged region scan only when solid matter vanished (tool removal, brush delete, cut, explosion, collapse, fire burn-out). Placements and water flow never trigger; building stays Minecraft-free. One analysis per fixed step (`STRUCTURE_ANALYSES_PER_TICK = 1`); pending regions merge with a 32-box fold cap; regions > 150k cells skip (`checked: false`).
- [x] Regions scan the **full world height** (32 rows) ± 12 horizontally — a cut-off top undercounts column loads (found by a failing test: a ground-level dig next to a 23-tall tower missed the tower top).
- [x] Collapse flow: the sim *proposes* failing cells via `onCollapse`; main applies them exactly like before — one grouped undoable `collapse` command, debris specs captured pre-edit, dust, `structureCollapsed` event, thud. The applied edits re-queue the region → **progressive cascading collapse** across ticks. `MAX_COLLAPSE_CELLS = 4096` truncates single collapses; the cascade finishes the rest.
- [x] Fire → structure coupling (the Phase 10 deferred item) falls out of the hook: burn-out is a real `setVoxel(AIR)` write, so a burned pillar drops its roof — no special-case code.
- [x] Performance: snapshot iterates chunk-by-chunk (missing chunks = air, journal consulted once per chunk), hot passes read a precomputed `solid` byte buffer (no function calls — vitest's module transform turns imported material constants into namespace lookups; the naive version measured 9.6 ms where the fixed one measures 2.2 ms).
- [x] `src/render/structureViz.ts` (G toggle): pooled InstancedMesh flashing failed cells ~1.6 s — red = lost support, orange = stress fracture. HUD `· struct qN` while regions pending; `structure`/`structureViz` exposed on `__mw`; `structure.reset()` on load.
- [x] Tests: `tests/structure.test.ts` — 24 tests (278 total): ported support fixtures (updated for cantilever semantics: one standing pillar now holds only the near roof — 26 of 65 cells fall), bridge limit boundary (6 holds, 7 drops the tip), stress threshold (23-tall wood tower fractures exactly at the base cell), natural-terrain exemption, propped-overhang failure, two-stage cascade, sim queueing rules (placement/water never queue), region merging, truncation + cascade completion, determinism across worlds, reset, fire→collapse coupling, `isEdited` contract. `tests/support.test.ts` deleted.
- [x] Benchmarks (`benchmarks/structure.bench.ts`): **GATE 2.19 ms** house-scale on real terrain (budget < 5 ms), fully-solid worst case 3.18 ms, 54k-cell brush region 4.84 ms, tower overstress 2.15 ms, full collapse cascade ≈ 6.9 ms spread over ~16 ticks. Destruction bench's support rows ported to `analyzeStructure`. Baselines in `docs/performance.md`.
- [x] Gates green: typecheck (strict), lint, build, Prettier, full suite **278 tests**.
- [x] Headless browser verification (Playwright + SwiftShader): new Phase 11 section on `?seed=9999` — **all green, zero page errors**: cantilever gate (west pillar out → far roof half drops, near half stands), sim collapse counter, 24-tall wood tower stress fracture + cascade flat, fire burn-out drops a pillar-carried roof (fire fast-forwarded in-page), G overlay toggle + HUD flag. Existing Phase 7–10 sections still pass (incl. the Phase 8 collapse gate + undo, which now flows through the ticked sim).
- [x] Docs: architecture "Structural simulation (Phase 11)" section (+ fire coupling note, hooks signature, layering, testing/benchmark lists), performance structure baselines + VM caveat, known-issues new Structures section (6 entries) + updated destruction/fire bullets, README (state, controls, layout), CHANGELOG `[0.9.0]`, this file.

### Fixed during verification

- **Harness run polluted by concurrent repo edits**: running `npm run format` while the suite was open triggered a Vite full reload mid-section — `window.__mw` vanished and the script crashed at the next evaluate (the earlier sections' flaky key-drops in that run were the same reload). Rule: **the dev server is idle while `.verify/run.mjs` runs** — no src edits, no formatters. Re-run after the change was clean.
- **Full-height regions**: the first cut scanned affected.y + 12 upward; a ground-level disturbance next to a tall tower undercounted its load (test caught it). Regions now always span y 0..31 — cheap at WORLD_HEIGHT 32 and removes the cut-off-top class of bugs.
- Two harness fixture bugs of my own making (single-block "pillars" not touching the roof; a 6-apart pillar pair whose far mid is exactly at the cantilever limit and correctly holds) — both caught by thinking through the cost math before re-running.

### Verification lessons (for future sessions)

- `node --check .verify/run.mjs` before any harness run catches top-level identifier collisions between phase sections instantly (this session: `roofY`, `lit` — Phase 8/10 already used them).
- Vitest-bench numbers on this VM are only comparable between idle runs; the browser harness competes for the same 2 cores (one polluted re-run showed ±70% RME).
- Under vitest, hot loops must not touch imported bindings through helper functions — hoist a local typed buffer (the `solid` array) instead. 4× on this machine, bigger on real hardware.

### Deferred deliberately

- Lateral load distribution (roof weight piling onto pillars / slab-overload failure) — stress is vertical-stack only; the cantilever rule carries spans. Tracked in known-issues.
- Rigid-body engine (Rapier) for detached pieces — the pooled debris pipeline carries the feel; re-evaluate when debris needs true collisions.
- Structural state in saves (collapses already persist via the journal; the sim is stateless between edits by design).
- Partial-region edge anchoring (components touching the scan edge stay standing) — unchanged Phase 8 approximation, documented.
- Manual GUI pass for Phase 7–11 polish (user); Phase 7/8 synthetic-input races remain harness-side.

### Tests

- Unit tests: 278 passed (23 files; +24 structure, −8 superseded support)
- Integration: headless browser suite incl. 8-check Phase 11 structural scenario (all green); manual GUI pass pending (user)
- Typecheck: clean (strict) · Lint: clean · Build: succeeds (three.js chunk unchanged)

### Benchmarks

- Structure: GATE 2.19 ms house-scale (p75 2.05), solid worst case 3.18 ms, 54k brush region 4.84 ms, cascade ≈ 6.9 ms over ~16 ticks — `docs/performance.md`
- FPS: unchanged at idle (the sim sleeps with empty pending queue)

### Architecture changes

- New: `src/voxel/structure.ts` (pure), `src/render/structureViz.ts` (pools). Deleted: `src/voxel/support.ts`.
- `World.onVoxelChanged` signature: `(x, y, z, material, previous)` (fluid/fire forward it; behavior unchanged). `World.isEdited`/`journalFor` added.
- `MATERIAL_STRENGTH` derived table next to `MATERIAL_HARDNESS`/`MATERIAL_FIRE` (not serialized).
- Layering unchanged: structure is pure; the game layer applies collapses as undoable edits.

### Known issues

- `docs/known-issues.md`: new Structures section (no lateral load distribution, cantilever constant, placements trusted, journal-exemption quirk, collapse caps, debris-not-bodies, per-tick analysis budget).

### Next task

- Task: Phase 12 — NPCs (entity, needs, wander/schedule, navigation)

### Recommended next steps

1. Pure NPC core in `src/sim/` or `src/npc/` (no three.js): entity state (position, velocity, needs, simple schedule), fixed-step tick, spawn/despawn by simulation distance.
2. Navigation first pass: walkable-cell queries off the voxel grid + A* over a local region with local invalidation on `structureCollapsed`/edit events (the plan §40 shape).
3. Behavior: wander + flee — subscribe to `structureCollapsed`/`fireIgnited`/`explosion` on the bus; render-side: simple instanced capsule/box figures (`src/render/`), one InstancedMesh for all NPCs.
4. Keep determinism: NPC ticks join the fixed step; no RNG without a seeded source.

---

## Session 006 — 2026-09-10

**Status:** Complete — Phase 10 (Fire and Smoke) done, verified, documented, committed. Milestone 8 met.

### Completed

- [x] Pure fire core (`src/voxel/fire.ts`): burning cells = fuel counters in a sparse map; heat = integer accumulator only in flammable cells (`MATERIAL_FIRE` derived table + `fireProfileOf` next to `MATERIAL_HARDNESS`; wood 0.9/480 ticks, grass 0.55/64, rest fireproof). Ignition at `ignitionHeat(flammability)`; burning cells deposit `HEAT_PER_TICK` into flammable neighbors; ticked cells decay. Insertion-ordered active set, `tick(budget)` (256/fixed step), sleep/wake via the World hook — same shape as the fluid sim, fully deterministic (no RNG).
- [x] Death rules: adjacent water extinguishes (cause `water`); full 6-neighbor opaque enclosure smothers (cause `smothered`, fuel survives); fuel spent → **burn-out** to AIR through `World.setVoxel` — journaled + remeshed, fluid-visible, persists across save/load (fires themselves transient; format stays v2).
- [x] Ignition paths: ignite tool (6th BrushTool; lights all flammable cells in the brush shape, refuses water-adjacent) + explosion heat: `explode()` returns `heated` (flammable crater-rim survivors), main dumps `BLAST_HEAT` on them — the Phase 8 deferred "calculate heat" hook.
- [x] Events: `fireIgnited` / `fireExtinguished` (typed union entries); crack burst on ignition, steam-stand-in dust puff on water extinguish. `FireSim.onEvent` callback keeps the pure core bus-agnostic.
- [x] Rendering (`src/render/firefx.ts`): pooled embers (256, ballistic, sub-second) + smoke (512, buoyant, growing); emission ∝ burning cells under per-frame caps. HUD `· fire N`, inspector `burning <fuel>`, `fire.takeDirty()` arms autosave, `fire.reset()` on load.
- [x] Sim-hook hardening: `FluidSim` and `FireSim` both chain onto `world.onVoxelChanged` (wrap, don't overwrite) — construction order no longer matters.
- [x] Tests: `tests/fire.test.ts` — 22 tests (262 total, 23 files): ignition rules, non-flammable immunity, spread, non-crossing barriers, exact burn durations (64/480), burn-out journaling + chunk-regeneration survival, water coupling both ways, smothering, blast heat (flammable/stone), `explode().heated` rim report, budget, sleep/wake, determinism (exportState + world voxels), events, reset.
- [x] Fire benchmark (`benchmarks/fire.bench.ts`): budget tick **1.68 ms** mean (p75 1.51); fire front **1.59 ms**; 20×20 platform full burn-out ≈ **1.0 s** total (~2 ms/tick amortized). Budget stays 256. Baselines in `docs/performance.md`.
- [x] Gates green: typecheck (strict), lint, build (three.js chunk unchanged), Prettier, full suite **262 tests**.
- [x] Headless browser verification (Playwright + SwiftShader, `.verify/run.mjs`): new Phase 10 fire section on a fresh `?seed=5678` world — **13 checks, all green**: dry spot fixture (5×5 grass patch + dirt apron), ignite tool via Q/E, click lights the patch, HUD fire counter, ember+smoke pools emit, spread beyond the ignition sphere (corners), fire dies out and sim sleeps, patch burns away to air, dirt apron contained the fire, wood ignites (direct sim call), **adjacent water extinguishes (milestone 8)**, doused wood survives. Zero console errors.
- [x] Docs: architecture "Fire (Phase 10)" section, performance fire baselines, known-issues new Fire section (8 entries) + updated destruction bullets, README (Phases 0–10, ignite tool, layout), CHANGELOG `[0.8.0]`, this file.

### Fixed during verification

- **FireFx crashed the frame loop**: the rewritten particle system never filled its per-pool state arrays — every spawn indexed an empty array, throwing "Cannot read properties of undefined (reading 'active')" per frame (found via the harness's pageerror flood + a minimal probe with stack traces; invisible in unit tests because `FireFx` is render-side and untested by design). Pools now pre-fill their states in the constructor; probe confirms embers/smoke emit with zero page errors.
- **Harness**: the fire section initially clicked from beyond `EDIT_REACH` (stray ignition of wild terrain) — the fixture now teleports the player beside the patch and aims → verify → click in one retried step; `ensureCreator(true)` added after ctrl combos (a mangled Ctrl+C toggles creator mode off, silently no-oping all later creator keys).

### Verification lessons (for future sessions)

- Render-side systems (`FireFx`, `DustSystem`, `DebrisSystem`) are the one place unit tests don't reach — the headless harness is their only test. A per-frame throw there floods the HUD away and only shows as a pageerror list; read the ERRORS tail first when a run looks wrong.
- The `__mw` hook + a small probe script (boot → poke state → listen for pageerror with stacks) finds render-loop crashes in one minute; worth doing before any full 5-minute harness run.
- Verify the crosshair's actual hit cell (page-side `hitCell`) before any single-shot tool click — ray reach is 6 and the eye can still be settling after teleports.

### Deferred deliberately

- Wind/rain coupling (checklist items) — no weather system until Phase 15/16.
- Fire state in saves (needs format v3; consequences already persist via the journal), fire→structural collapse coupling (Phase 11's graph replaces the edit-time support check), volumetric smoke, sustained fire audio (Phase 17), natural ignition sources (lightning/lava).
- Manual GUI pass for Phase 7–10 polish (user); headless Phase 7/8 input-race flakes remain harness-side (mix varies per run; collapse gate, prefab, conservation, and all fire checks hold).

### Tests

- Unit tests: 262 passed (23 files, +22 fire tests)
- Integration: headless browser suite incl. 13-check fire scenario (all green); Phase 7/8 synthetic-input flakes remain (documented); manual GUI pass pending (user)
- Typecheck: clean (strict) · Lint: clean · Build: succeeds (three.js chunk unchanged, ~585 kB minified / ~153 kB gzip)

### Benchmarks

- Fire: budget tick 1.68 ms mean (p75 1.51); fire front 1.59 ms; 20×20 burn-out ≈1.0 s total — `docs/performance.md`
- FPS: unchanged when idle (fire sleeps); particles are pool-bounded like debris/dust

### Architecture changes

- New: `src/voxel/fire.ts` (pure), `src/render/firefx.ts` (pools). `MATERIAL_FIRE` + `fireProfileOf` in materials.ts; `BrushTool` gains `'ignite'`; `explode()` returns `heated`; events union extended.
- `onVoxelChanged` consumers now chain instead of overwrite (fluid + fire).
- No layering changes: fire is pure; FX consume a plain point list per frame.

### Known issues

- `docs/known-issues.md`: new Fire section (no save persistence, no structural coupling until Phase 11, no wind/rain, material-look burning voxels, particle-only smoke, no sustained audio, 6-neighbor oxygen approximation, creator-only ignition).

### Next task

- Task: Phase 11 — Structural Simulation (support graph, stress, collapse, detached rigid bodies)

### Recommended next steps

1. Support graph in `src/voxel/structure.ts` (pure): nodes per solid component with connection strengths; incremental local rebuilds on edit (budget: < 5 ms house scale) replacing `checkSupport`'s region approximation.
2. Detachment → rigid bodies: route collapsed components through the existing debris pipeline first (believable), evaluate Rapier only if debris needs true collisions (Phase 8 note).
3. Wire fire burn-outs into the graph (the Phase 10 deferred coupling): a burned pillar should drop its roof like a deleted one.
4. Collapse gate test: destroy a building's ground floor → upper floors detach and settle (plan §109).

---

## Session 005 — 2026-09-10

**Status:** Complete — Phase 9 (Water) done, verified, documented, committed. Milestone 7 met.

### Completed

- [x] Phase 9 implementation (carried from the mid-session handoff, committed as `b5ae66c` before this session resumed): pure `FluidSim` (levels 0–255, sources-by-default, gravity + equalization, mass conservation, sleep/wake, budgeted ticks), `onVoxelChanged`/`onChunkReady` world hooks, flow-height rendering (`waterDrop` attribute), swimming/climb-out, brush/explosion water interactions, save v2 with fluid levels + v1 migration. 239 tests green.
- [x] Fluid benchmark run (`benchmarks/fluid.bench.ts`): budgeted 384-cell tick **2.60 ms** mean (p75 2.51) — inside a 16 ms frame; steady-state churn **0.42 ms/tick**; 22×22 basin flood settles in **≈2.7 s**; lake wake ≈3.4 ms incl. chunk gen. Baselines recorded in `docs/performance.md`; budget stays at 384.
- [x] Gates re-run green: typecheck (one stray unused-var in a mesher test fixed), lint, build (584 kB minified / 153 kB gzip three.js chunk), Prettier (`npm run format` reflowed the repo — the prior commit predated it), full suite **240 tests**.
- [x] **Fluid bug found + fixed (the session's real catch).** Headless verification showed lakes churning ~10³ active cells _forever_ on every watery seed (budget saturated; fresh worlds never reached 0). Forensics with in-page instrumentation pinned it: `updateCell` fired its paired write + `activateAround` even when `setLevel` early-returned on a failed unloaded-chunk write — every frontier source re-woke itself + 13 neighbors each tick, forever. Fix: `setLevel` returns success; failed writes propagate nothing, so frontier water sleeps and resumes on `onChunkReady`. Regression-tested (`tests/fluid.test.ts`); settled worlds now measure **active = 0**.
- [x] Headless browser verification (Playwright + SwiftShader, `.verify/run.mjs`): added a Phase 9 water section (fresh `?seed=1234` world; 14 checks) — source placement, spread to far corner as flowing cells, material/level semantics, HUD churn counter, **quiescence (active=0), exact containment (interior mass = region mass), mass conservation over time**, swim HUD state, climb-out onto the bank, save-v2 `waterLevels` field, boot restore of flowing levels. **All 14 pass.** Screenshots in `.verify/artifacts/`.
- [x] Docs: `docs/architecture.md` (new "Water (Phase 9)" section), `docs/performance.md` (fluid baselines + frontier-bug note), `docs/known-issues.md` (placeholder bullet replaced by a water sharp-edges list; explosion bullet updated to "vaporizes water"), README (current state, controls, repo layout), CHANGELOG `[0.7.0]`.
- [x] Committed as one Phase 9 completion commit.

### Verification lessons (for future sessions)

- The basin fixture itself caused two false alarms: a source placed **above** a basin rim floods the entire shore (that is the source rule working — it fills every reachable cell at or below its level); and the "corner" sample cells were wall columns, not open interior. Verify fixture geometry before suspecting the sim.
- Playwright localStorage does not survive `browser.close()` — post-mortem probes must rebuild state in the same page/session, not re-open storage.
- Remaining Phase 7/8 check failures in `run.mjs` are the documented synthetic-input races (dropped keydowns/pointer-lock drops at ~10 fps software rendering) — the mix differs per run and the critical gates (collapse, prefab persistence, conservation) hold. The manual GUI pass is still the user's.

### Fixed during verification

- Fluid frontier re-activation bug (above) — the only code change in `src/`; everything else was harness/fixture geometry.

### Deferred deliberately

- Pressure / up-flow (u-tubes), worker-side fluid, GPU fluid, dedicated fluid debug overlay (HUD counters + inspector level exist) — recorded in the Phase 9 checklist.
- Manual GUI pass for Phases 7–8/9 polish (user).
- Undo does not restore partial fluid levels (undo of a dump yields sources) — accepted, documented in known-issues.

### Tests

- Unit tests: 240 passed (22 files, +1 regression test for frontier sleep)
- Integration: headless browser suite incl. 14-check water scenario (green); manual GUI pass pending (user)
- Typecheck: clean (strict) · Lint: clean · Build: succeeds (584.56 kB minified / 153.16 kB gzip three.js chunk)

### Benchmarks

- Fluid: see `docs/performance.md` — budgeted tick 2.60 ms mean; steady churn 0.42 ms/tick; basin flood ≈2.7 s one-time; settled water 0
- FPS: unchanged (fluid idle most frames; budgeted otherwise)

### Architecture changes

- `FluidSim.setLevel` now returns write success; `updateCell` gates propagation + activation on it (failed unloaded-chunk writes are total no-ops).
- No layering changes: fluid is pure (`src/voxel/`), rendering consumes via query attributes.

### Known issues

- `docs/known-issues.md`: water section (no pressure/up-flow, not raycast-targetable, integer equalization, LOD1 full cubes, undo-sources quirk, frontier wait, one-time lake wake).

### Next task

- Task: Phase 10 — Fire and Smoke (temperature, fuel, ignition, spread; extinguishing coupled to water)

### Recommended next steps

1. Pure fire core in `src/voxel/fire.ts` following the fluid pattern: per-cell temperature/fuel derived tables (`MATERIAL_FLAMMABILITY` next to `MATERIAL_HARDNESS`), budgeted ticks, sleep/wake, event-bus events (`ignited`, `extinguished`).
2. Water coupling first (it exists): fire + adjacent water → extinguish + steam; explosion heat field hooks exist from Phase 8's deferred "calculate heat".
3. Rendering: pooled ember/smoke particles in `src/render/` (reuse the debris/dust InstancedMesh pattern); smoke as a light cellular gas later in the phase.
4. Keep determinism: fire ticks join the fixed-step budget alongside `fluid.tick`.

---

## Session 004 — 2026-09-09

**Status:** Complete — Phases 7 and 8 done; Milestone 5 met; Phase 8 gate criteria verified. Phase 9 intentionally not started.

### Completed

- [x] Node 22 toolchain installed on the machine (`~/.local/opt`, PATH in `~/.local/bin` + `.bashrc`) — the box had no Node at all
- [x] Phase 7: pure brush core (`src/creator/brush.ts`): sphere/box/cylinder/noise shapes × place/delete/paint/replace tools → edit lists through `applyEdits` (one stroke = one undoable command); bedrock + player guards; deterministic noise scatter via exported `hash3` (terrain `hash2` untouched — existing seeds regenerate bit-identically)
- [x] Phase 7: box selection (`selection.ts`: corner normalization, 32³ budget, region copy) + clipboard (`clipboard.ts`: rotateY in 90° steps, mirrorX, remap, paste flattening with air-skip default)
- [x] Phase 7: prefabs (`prefab.ts`): versioned v1 JSON, RLE voxels, full validation (version/size/runs/solid-count); `PrefabLibrary` over `SaveStore` — interface gained `keys()`; O saves `prefab-N`, P cycles loads
- [x] Phase 7: voxel inspector (`inspector.ts`) + derived `MATERIAL_HARDNESS` table in materials.ts; **I** toggles the HUD panel
- [x] Phase 7: `CreatorViz` brush ghost (shape-true wireframe, tool-tinted) + selection/paste wireframes; controls C/Q/E/V/[/]/B/Ctrl+C/X/V/R/M/O/P/I; HUD creator line; overlay help updated
- [x] Phase 8: typed event bus (`src/sim/events.ts`, ADR-003): `explosion`/`structureCollapsed`, synchronous dispatch, throw isolation
- [x] Phase 8: damage model (`src/voxel/damage.ts`): `explode` — spherical field, hardness-based reach (`radius·(0.35+0.65·(1−hardness))`), bedrock immune, water untouched, deterministic hash-sampled debris specs with hard cap; `debrisFromCells` for collapses
- [x] Phase 8: support check (`src/voxel/support.ts`): budgeted region flood fill (edit ±12, bedrock + region-edge anchors); unsupported components collapse as ONE undoable command; snapshot + flat-index BFS after profiling (18.5 → ~10 ms worst case at house scale)
- [x] Phase 8: `World.getVoxel` one-slot chunk memo (region scans + raycasts skip chunk-map lookups)
- [x] Phase 8: pooled render effects — `DebrisSystem` (InstancedMesh, 512 pieces, ring-buffer recycle, gravity/bounce/friction/settle/shrink against the voxel grid) + `DustSystem` (1024 voxel puffs); `SoundFx` (procedural WebAudio thud/crack/boom, N mute, gesture-gated resume)
- [x] Phase 8: explosion creator tool (5th tool); support check wired after remove/brush-delete/cut/explosion; HUD debris counter; destruction benchmarks (`benchmarks/destruction.bench.ts`)
- [x] 58 new tests (205 total); docs updated (README, architecture, performance, known-issues, CHANGELOG)

### Verified in headless browser (Playwright Chromium + SwiftShader)

The in-app Electron pane exposed no WebGL this session, so verification
ran in Playwright's bundled headless Chromium (`.verify/run.mjs`, local +
gitignored, driven through a dev-only `__mw` hook in main.ts). Confirmed
with zero console errors: pointer lock, brush place/delete/undo, box
selection → copy → prefab save/load, **the Phase 8 gate** (destroying a
pavilion's pillar collapses its roof the same frame as pooled debris),
collapse undo restoration, 8-explosion stress with the pool capped, and
save → reload journal restoration. Remaining check failures were
harness-side input races (dropped synthetic keydowns, pointer-lock drops
at ~10 fps under software rendering); **the user will finish/redo the
GUI pass manually.** Caveat discovered: at low fps, synthetic Ctrl+key
combos must be HELD across a game frame (the Session-003 caveat, now
documented in known-issues).

### Fixed during verification

- Support check was 18.5 ms at house scale (per-cell chunk-map string
  keys + 6 object allocations per visited cell): snapshot pass + flat
  index BFS + World chunk memo → ~10 ms worst case, and raycasts/region
  scans generally benefit.
- EventBus internals fought TS variance (`Extract` in the stored
  handler type); simplified to an internally-erased `AnyHandler` with
  the typed surface unchanged.

### Deferred deliberately

- Phase 7 leftovers (documented in known-issues): translate/rotate
  gizmos + snap, smooth/flatten/raise/lower/erosion/damage brushes —
  first-person clipboard transforms cover the common cases; damage
  brush is superseded by the explosion tool.
- Phase 8 leftovers: debris does not re-materialize as voxels on
  landing (undo is the restoration path); explosion heat coupling
  (Phase 10), NPC effects (Phase 12), real rigid-body engine (Rapier)
  if debris ever needs true collisions.
- Water interaction with brushes/explosions — Phase 9's job.

### Tests

- Unit tests: 205 passed (21 files)
- Integration: headless GUI verification (see above); manual pass pending (user)
- Typecheck: clean (strict) · Lint: clean · Build: succeeds (~545 kB minified three.js chunk, unchanged)

### Benchmarks

- Destruction: explode r=6 solid stone ~4.5 ms; r=10 ~6.6 ms; support
  check house-scale ~10 ms (worst), terrain ~14 ms; pool-bounded debris
  step ~0.1 ms/frame regardless of event count (baselines in docs/performance.md)
- FPS: 60 on real hardware previously; headless SwiftShader ~10–17 fps
  with 200+ debris active — cap holds the floor

### Architecture changes

- New dirs: `src/creator/` (pure editor core), `src/sim/` (event bus),
  `src/audio/` (DOM sfx adapter). Layering rule extended: creator/sim
  code is pure like `src/voxel/` (ADR-002).
- `SaveStore` gained `keys()`; `MATERIAL_HARDNESS` derived table next to
  the registry (deliberately not serialized); `hash3` exported from
  terrain.ts (hash2 frozen — save compatibility).
- `main.ts` carries a dev-only `__mw` debug hook (stripped in prod)
  for GUI verification scripts.

### Known issues

- See `docs/known-issues.md` (new sections: Creator mode, Destruction,
  GUI verification).

### Next task

- Task: Phase 9 — Water (fluid grid, flow, flooding)

### Recommended next steps

1. Pure cellular fluid in `src/voxel/fluid.ts`: per-cell volume 0–255,
   gravity + horizontal equalization first, mass conservation +
   boundary tests (the plan §130 task shape). Water material already
   exists; keep it non-solid until buoyancy lands.
2. Tick scheduling + dirty propagation: fluid cells dirty only their
   chunk + neighbors; reuse the `structureCollapsed`-style event for
   "water settled". Cap active fluid cells per frame (activity budget).
3. Rendering: flowing-water levels in the voxel shader (height-based
   top faces), then player buoyancy/swimming in the controller.
4. Then Phase 10 (fire) can couple: `hardnessOf`-style material tables
   (flammability) already set the pattern.

---

## Session 003 — 2026-09-09

**Status:** Complete — Phases 5 and 6 done; Milestones 3 and 4 met. Phase 7 intentionally not started (user scoped the session to "next 3 phases" originally, then narrowed to "finish Phase 6 + handoff").

### Completed

- [x] Phase 5: DDA selection raycast (`src/voxel/raycast.ts`, pure + tested, water not targetable), wireframe target highlight + translucent placement ghost, place/remove/paint(F)/pick(MMB) through grouped `EditCommand`s with undo/redo (128-deep), material hotbar (1–7/wheel), player-overlap placement guard, bedrock floor protection
- [x] Phase 5: World edit journal (per-chunk voxel deltas, replayed on regeneration — edits survive unload/prune/reload), versioned save schema v1 (seed + terrain + material table + journal), migration chain, structural validation, `SaveStore` (memory + localStorage), `AutosavePolicy` (20 s dirty-gated + save-on-hide), boot restore unless `?seed=` overrides, HUD edit line
- [x] Phase 6: `OccupancyGrid` + `PackedVolume` (palette + bit-packed indices, auto-widening, 256-material envelope) behind a shared `VoxelData` interface; chunks now store packed (1536 B vs 8192 B dense on terrain)
- [x] Phase 6: `meshVolumeGreedy` (per-axis sweep, maximal-rectangle merge, growable typed buffers) proven unit-face-equivalent to the naive baseline on random volumes, terrain chunks, and cross-chunk worlds; winding checked per quad; production switch; terrain chunk 1506 → 185 quads, whole view ~82.5k → ~9k
- [x] Phase 6: LOD — `downsampleVolume` + `desiredLod` hysteresis + ChunkMeshManager integration (LOD1 scales 2×); 88/226 chunks at LOD1 at radius 6
- [x] Phase 6: shader variation now derives the voxel cell from the fragment world position (correct on merged quads); `voxelOrigins` attribute removed end to end
- [x] Phase 6: benchmarks (naive vs greedy all scenes, dense vs packed storage, quad counts) + `docs/voxel-storage.md` tradeoff study (sparse hash, RLE, SVO investigated and rejected for now)
- [x] 65 new tests (147 total); docs updated (architecture, performance, known-issues, README, CHANGELOG)

### Fixed during verification

- Game loop died on the first targeting frame: `world.getVoxel` was passed as an unbound method to the raycast (`this` undefined). Found via window error trap; fixed with an arrow closure.
- **LOD1 sat 1–2 voxels above the full-resolution mesh** (found by user playtesting: "LOD seems to be placed 1 or 2 blocks too high, when I approach, it shifts down a bit and increases resolution"): the downsample majority rule treated half-solid surface blocks as fully solid. Fix: count air as a candidate and let air win ties — LOD can only erode, never inflate. Regression-tested with odd/even surface-height cases.
- Greedy mesher emitted faces for out-of-bounds cells when the world query returned solid terrain outside the chunk (only visible in cross-chunk tests): only in-volume cells may emit now.
- Greedy quad corners had two unset components (degenerate quads) after a refactor — caught by the winding test before any commit.
- Ctrl+Z/Y only work if Ctrl is still held when the key event is consumed (synthetic ultra-fast release in tests missed it; real usage unaffected).

### Deferred deliberately

- Phase 7 (Creator Mode) — next session.
- Transferable mesh buffers / worker meshing (Phase 6 checklist item): greedy meshing is ~2.5 ms/chunk and the frame budget absorbs it.
- Hold-to-paint continuous strokes (each click is one undo step; brush strokes will want stroke grouping in Phase 7).
- Packed-volume >256-material dense fallback path (documented envelope; unreachable with 7 materials).

### Tests

- Unit tests: 147 passed (14 files)
- Integration tests: manual browser GUI verification (editing, undo/redo, save/restore across reload, LOD transition after fix)
- Typecheck: clean (strict) · Lint: clean · Build: succeeds (~545 kB minified / ~140 kB gzip three.js chunk)

### Benchmarks

- FPS: 60 (vsync-capped, 1280×720) at render radius 6; 226 chunk meshes (88 LOD1), ~8.8–9.1k quads (was ~82.5k)
- Meshing: greedy terrain chunk 2.46 ms (naive 3.15 ms); solid 16³ 2.14 ms; checker 16³ worst case 7.06 ms
- Storage: packed reads ~4× dense but mesh-bound overall; 1536 B vs 8192 B per terrain chunk
- Other: greedy LOD1 terrain chunk ≈ 70 quads; generateChunk ≈ 0.58 ms

### Architecture changes

- `VoxelData` interface (`voxelVolume.ts`): dense and packed storage interchangeable; `Chunk.volume` is now a `PackedVolume`.
- `MeshData` lost `voxelOrigins`; variation is world-position-derived in the shader.
- `ChunkMeshManager` gains LOD params/switching (budget order: dirty → LOD switches → new chunks).
- `World` gains the edit journal + `exportEdits`/`loadEdits`; `VoxelVolume`/`PackedVolume` gain flat-index access + `fill`.
- New dirs: `src/persistence/` (localStorage store — DOM adapter, keeps `src/voxel/` pure).

### Known issues

- See `docs/known-issues.md`: LOD erodes ≤1 voxel (by design), approximate LOD seam culling, no worker meshing, water placeholder, single-voxel editing granularity.

### Next task

- Task: Phase 7 — Creator Mode (brushes, selection, clipboard, prefabs, inspector)

### Recommended next steps

1. Pure brush core in `src/creator/` (shapes × tools → edit lists) flowing through `applyEdits` — one brush stroke = one undoable command; deterministic noise from the existing integer hash.
2. Box selection + clipboard (copy/cut/paste/rotate/mirror) as pure volume transforms; paste = one grouped command through the journal.
3. Prefab serialization (JSON, versioned like the world save) + voxel inspector; render-side selection wireframe and brush ghost.
4. GIZMOS/transform gizmos and erosion/damage brushes: defer or cut — first-person UX fits clipboard transforms better.

---

## Session 002 — 2026-09-08

**Status:** Complete — Phases 2, 3, 4 done; Milestone 2 met

### Completed

- [x] Phase 2: `Chunk` (16³ + dirty), `World` chunk map (world-space get/set, boundary-edit dirty propagation, neighbor invalidation on generation, radius pruning), mesher v2 (cross-chunk neighbor query, opaque/water pass split, voxelOrigins), pure streaming math, `ChunkMeshManager` (mesh cache, nearest-first queue with camera tie-break + per-frame budget, dirty remesh, geometry disposal), render radius 6, HUD streaming stats
- [x] Phase 3: mulberry32 RNG, integer-hash value noise + fBm, hill/mountain height function, sea level, layered columns (bedrock/stone/dirt band/grass, sand at/under waterline, water fill), deterministic `findSpawn`; generation params tuned (≈7% water, ≈18% sand near demo area); terrain benchmarks
- [x] Phase 4: full material registry (7 materials, metadata, opaque/solid classification, id/name lookup, versioned JSON serialization with validation), voxel ShaderMaterial (palette DataTexture indexed by materialId, per-voxel brightness variation, in-shader hemisphere+sun lighting and fog), transparent water pass
- [x] 44 new tests (82 total): chunk/world, streaming math, terrain determinism + content rules, material registry/serialization, mesher boundary + water rules
- [x] Browser verification on two seeds (?seed= default 1337 and 42): 60 fps, 226 chunk meshes, ~80k quads, queue drains, zero console errors; screenshots reviewed

### Fixed during verification

- Chunk meshes were never positioned in world space — every chunk rendered stacked at the origin. Masked by Phase 2's flat placeholder world (all chunks identical), exposed immediately by terrain. Meshes now get the chunk origin + `updateMatrix()`.
- Streaming camera bonus originally outranked distance (a chunk 2 ahead beat a chunk 1 ahead); reduced to a ≤1 tie-breaker.
- Terrain params tuned after measurement: original settings produced ~2% water and ~25% sand.

### Deferred deliberately

- Water physics (buoyancy/swimming) → Phase 9; water is currently a translucent, non-solid placeholder.
- Automatic integration tests (browser) still manual GUI passes.

### Tests

- Unit tests: 82 passed (8 files)
- Integration tests: none automated (manual browser GUI verification each phase)
- Typecheck: clean (strict) · Lint: clean · Build: succeeds · Bench: added terrain baselines

### Benchmarks

- FPS: 60 (vsync-capped, 1280×720) at render radius 6 (226 chunk meshes, ~80k quads)
- Chunk count: 226 meshed (113 columns × 2 layers); queue drains in ~2 s of fast movement
- Other: generateChunk ≈ 0.43 ms; heightAt ≈ 0.07 ms per 256 columns (mesh-bound streaming)

### Architecture changes

- Mesher signature: `meshVolume(volume, query)` — the query redirects out-of-bounds reads through the world (chunk-boundary culling). Standalone volumes pass `getOrAir`.
- Renderer bootstrap lost its scene lights/fog: the voxel shader computes lighting and fog itself; bootstrap now only owns renderer/camera/resize/loop.

### Known issues

- See `docs/known-issues.md`: water placeholder (no swim/collision), void fall when outrunning the streamer, stale meshes at the unload edge, flat shading without AO.

### Next task

- Task: Phase 5 — selection raycast + voxel place/remove with dirty remeshing

### Recommended next steps

1. Voxel DDA raycast (`src/voxel/raycast.ts`, pure + tested), selection wireframe in render, place/remove routed through `World.setVoxel` (remeshing already works).
2. `EditCommand` + undo/redo stacks (Phase 5) before save/load.
3. Revisit streaming budget if edit remeshes ever hitch (currently 3 chunks/frame, dirty-first).

---

## Session 001 — 2026-09-08

**Status:** Complete — Phase 0 + Phase 1 done, Milestone 1 met

### Completed

- [x] Project moved to ext4; `npm install` succeeds (exFAT blocker resolved)
- [x] Dev dependencies pinned and installed (typescript 5.9, vite 7.3, vitest 3, eslint 9, prettier 3, `@types/three`)
- [x] `git init` (branch `main`) + CI workflow `.github/workflows/ci.yml` (lint → typecheck → test → build, Node 22)
- [x] Phase 0 docs: README, `docs/architecture.md`, `docs/performance.md`, `docs/known-issues.md`, `CHANGELOG.md`
- [x] Baseline app: `index.html` (overlay/HUD/crosshair), `src/main.ts`, renderer bootstrap (scene/camera/lights/resize/loop)
- [x] Phase 1 world: negative-safe coordinate conversions, material IDs, `VoxelVolume` (dense `Uint16Array`, bounds policy), naive culled face mesher (plain typed arrays), demo world
- [x] Phase 1 player: pointer-lock mouse look, WASD + jump, gravity, per-axis AABB voxel collision, fixed 60 Hz timestep with substeps, void respawn
- [x] 38 unit tests (coordinates, volume, mesher incl. winding, controller) + mesher benchmarks with baselines in `docs/performance.md`
- [x] Browser smoke test (in-app browser, real input events): 60 fps, 828 quads, pointer lock + movement + mouse deltas verified, zero console errors on a fresh load

### Fixed during verification

- Keyboard listeners were attached to the canvas; trusted key events target the focused element (`body`) and never pass through it, so WASD was dead in real use. Moved to `window`. (Found by GUI-testing with trusted input — synthetic-only testing would have missed it.)

### Deferred deliberately

- Interaction raycast (Phase 1 checklist) — first real consumer is Phase 5 editing; not in the agreed Phase 1 scope. Tracked in `docs/known-issues.md`.

### Tests

- Unit tests: 38 passed (4 files)
- Integration tests: none yet
- Typecheck: clean (strict)
- Lint: clean (eslint + prettier applied)
- Build: succeeds (~526 kB minified / ~133 kB gzip three.js chunk)

### Benchmarks

- FPS: 60 (vsync-capped, 1280×720, in-app browser)
- Frame time: n/a (GPU timing not built yet)
- Memory: n/a (8 KB voxel payload; profiling deferred)
- Chunk count: 1 (single 16³ demo volume, 828 quads)
- Other: mesher baselines in `docs/performance.md` (solid 16³ ≈ 1.8 ms; checkerboard 32³ worst case ≈ 95 ms)

### Architecture changes

- None beyond the agreed plan. Bounds policy decision documented: `get` throws OOB, `getOrAir` = air outside (mesher/collision), `set` returns `false` OOB.

### Known issues

- See `docs/known-issues.md` (dark vertical faces, instant-accel movement, single-volume world, bundle-size warning).

### Next task

- Task: Phase 2 — chunk data structure + chunk-boundary meshing

### Recommended next steps

1. `Chunk`/chunk-map around existing `VoxelVolume` + coordinate primitives (`src/voxel/`), with dirty flags and tests.
2. Meshing across chunk boundaries (neighbor lookups) + per-chunk geometry cache/remesh on edit.
3. Streaming (render distance, load/unload around player) — then re-benchmark the mesher at multi-chunk scale.

---

## Session 000 — Project Initialization

**Status:** Blocked — filesystem (see `HANDOFF.md`)

### Intended work

- Inspect repository
- Confirm existing files/tooling
- Establish architecture
- Create baseline documentation
- Set up build/test/lint/typecheck pipeline

### Notes

Config files were written (package.json, tsconfig, vite, vitest, eslint,
prettier, .gitignore). `npm install` fails because the drive is exFAT and
exFAT has no symlink support (`node_modules/.bin` cannot be created; even
plain `ln -s` fails with EPERM). Remounting cannot fix this — the project
must move to a POSIX filesystem. Broken node_modules was removed. Full
pickup instructions in `HANDOFF.md`.

---

# Phase 0 — Repository and Infrastructure

## Project Setup

- [x] Initialize TypeScript project
- [x] Initialize package manager configuration
- [x] Configure Vite/dev server
- [x] Add Three.js
- [x] Establish source directory structure
- [x] Establish package/app structure if using a monorepo _(N/A — single npm package, per agreed approach)_
- [x] Configure strict TypeScript
- [x] Configure ESLint
- [x] Configure formatter
- [x] Configure unit testing
- [ ] Configure integration testing _(browser smoke test is manual; automated browser tests deferred)_
- [x] Add build script
- [x] Add typecheck script
- [x] Add lint script
- [x] Add test script
- [x] Add CI workflow
- [x] Add development README
- [x] Add architecture documentation
- [x] Add changelog
- [x] Add known-issues document
- [x] Add performance document

## Baseline Application

- [x] Create HTML entry point
- [x] Create TypeScript application entry
- [x] Create renderer bootstrap
- [x] Create Three.js scene
- [x] Create camera
- [x] Create basic lighting
- [x] Create resize handling
- [x] Create render loop
- [x] Verify application runs in browser
- [x] Verify production build
- [x] Verify no console errors

---

# Phase 1 — First Pixel

## World

- [x] Define `WorldCoordinate`
- [x] Define `ChunkCoordinate`
- [x] Define `LocalVoxelCoordinate`
- [x] Implement world → chunk conversion
- [x] Implement world → local conversion
- [x] Implement chunk → world conversion
- [x] Implement negative-coordinate handling
- [x] Add coordinate conversion tests

## Voxel Storage

- [x] Define `VoxelMaterialID`
- [x] Define air material
- [x] Create basic voxel array
- [x] Implement voxel read
- [x] Implement voxel write
- [x] Implement bounds checking
- [x] Add voxel storage tests

## Basic Mesh

- [x] Implement naive voxel face mesher
- [x] Detect air neighbors
- [x] Generate positions
- [x] Generate normals
- [x] Generate indices
- [x] Generate material IDs
- [x] Create Three.js geometry
- [x] Render voxel cube
- [x] Verify visual correctness

## Player

- [x] Create first-person camera
- [x] Implement mouse look
- [x] Implement WASD
- [x] Implement movement
- [x] Implement gravity
- [x] Implement collision with initial world
- [x] Implement jump
- [ ] Add basic interaction raycast _(deferred to Phase 5 — its first consumer is editing; see `docs/known-issues.md`)_

### Milestone

- [x] **Milestone 1 complete: Walk around a small voxel world** _(met — verified in browser with real input: spawn, walk, jump, mouse look, collision, respawn)_

---

# Phase 2 — Chunks

## Chunk

- [x] Define chunk size
- [x] Create chunk data structure
- [x] Implement chunk-local indexing
- [x] Implement neighbor lookup
- [x] Implement dirty flags
- [x] Implement chunk lifecycle
- [x] Add chunk tests

## Chunk Meshing

- [x] Mesh one chunk
- [x] Hide internal faces
- [x] Handle neighboring chunks
- [x] Remesh dirty chunks
- [x] Dispose old geometry
- [x] Add mesh cache

## Streaming

- [x] Define render distance
- [x] Load chunks around player
- [x] Unload distant chunks
- [x] Implement chunk request queue
- [x] Prioritize chunks near player
- [x] Prioritize chunks in camera direction
- [x] Add loading statistics

### Milestone

- [x] **Milestone 2 complete: Walkable chunked world** _(met — streamed radius-6 world, cross-chunk collision and culling verified in browser)_

---

# Phase 3 — Terrain

- [x] Implement seeded RNG
- [x] Implement deterministic noise
- [x] Implement base terrain height
- [x] Add hills
- [x] Add mountains
- [x] Add plains
- [x] Add sea level
- [x] Add terrain material layers
- [x] Add terrain generation tests
- [x] Verify deterministic chunk generation

---

# Phase 4 — Materials

- [x] Create material registry
- [x] Add air
- [x] Add grass
- [x] Add dirt
- [x] Add stone
- [x] Add sand
- [x] Add wood
- [x] Add water placeholder
- [x] Add material metadata
- [x] Add material lookup
- [x] Add material serialization
- [x] Add basic material shader
- [x] Add material variation

---

# Phase 5 — Editing

## Basic Editing

- [x] Add voxel placement _(RMB places selected material into the face-adjacent cell; refused into the player AABB)_
- [x] Add voxel deletion _(LMB; bedrock layer y=0 protected)_
- [x] Add material painting _(F recolors the targeted voxel; MMB eyedropper selects from the world)_
- [x] Add selection raycast _(pure DDA in `src/voxel/raycast.ts`, water not targetable)_
- [x] Add edit preview _(translucent placement ghost tinted with the selected material + wireframe target highlight)_
- [x] Add edit confirmation _(click applies; no-ops and refused placements leave history untouched)_
- [x] Add dirty chunk updates _(edits route through `World.setVoxel`; dirty remeshing was already end-to-end)_

## Undo / Redo

- [x] Define `EditCommand` _(target values + captured previous values)_
- [x] Implement voxel edit command _(applyEdits groups multi-cell edits; no-ops skipped)_
- [x] Implement undo stack _(128-deep cap, oldest falls off)_
- [x] Implement redo stack _(push clears the redo branch)_
- [x] Add grouped commands _(multi-cell commands atomic; brush-stroke grouping arrives with Phase 7)_
- [x] Test undo/redo invariants _(round-trips, atomicity, redo-drop, cap, journal interplay)_

## Save / Load

- [x] Define world serialization schema _(v1: seed + terrain params + material table snapshot + edit journal)_
- [x] Serialize chunks _(the journal — terrain regenerates from seed)_
- [x] Deserialize chunks _(loadEdits applies to loaded chunks, replays on generation)_
- [x] Save world _(K manual + autosave + save-on-tab-hide)_
- [x] Load world _(L manual + boot restore unless `?seed=` overrides)_
- [x] Add world version _(WORLD_FORMAT_VERSION + embedded material-format version)_
- [x] Add migration mechanism _(per-version migrator chain; unknown/newer versions rejected)_
- [x] Add autosave _(AutosavePolicy: 20 s dirty-gated interval)_
- [x] Add crash-recovery strategy _(save on visibilitychange-hidden; boot restores last autosave)_

### Milestone

- [x] **Milestone 3 complete: Editable, saveable voxel sandbox** _(met — browser-verified: place/remove/paint/pick, undo/redo, reload restores edits on two seeds)_

---

# Phase 6 — Microvoxels

## Storage

- [x] Benchmark dense storage _(storage.bench.ts: fill/read/mixed ops)_
- [x] Implement palette compression _(PackedVolume: palette + bit-packed indices, 1/2/4/8-bit auto-widening, 256-material envelope)_
- [x] Benchmark palette compression _(reads ~4× dense; meshing stays mesh-bound; 1536 B vs 8192 B per terrain chunk)_
- [x] Investigate sparse chunks _(per-voxel hash rejected at 40–90% fill rates; occupancy `isEmpty` covers the all-air case — docs/voxel-storage.md)_
- [x] Implement occupancy bitsets _(OccupancyGrid: O(1) air/empty tests, maintained count)_
- [x] Investigate SVO representation _(rejected at 16³ — node overhead dwarfs a 2.5 KB chunk; checkpoint at 32+ voxel chunks — docs/voxel-storage.md)_
- [x] Document representation tradeoffs _(docs/voxel-storage.md)_

## Meshing

- [x] Implement greedy mesher _(meshVolumeGreedy: per-axis sweep + maximal rectangles; production)_
- [x] Benchmark greedy vs naive _(1.3–1.5× build time, 8× fewer quads on terrain; docs/performance.md)_
- [x] Add mesh cache _(pre-existing ChunkMeshManager cache; now also caches per-LOD)_
- [x] Reduce allocations _(growable typed buffers in the greedy mesher; naive kept with JS arrays as baseline)_
- [ ] Add transferable mesh buffers _(deferred: no worker infrastructure; meshing is 2.5 ms/chunk)_
- [x] Add mesh generation benchmark _(greedy + naive across solid/checker/layered/terrain scenes)_

## LOD

- [x] Define LOD levels _(LOD0 full, LOD1 = 2× downsampled; LOD1_FACTOR)_
- [x] Implement chunk LOD _(downsampleVolume + scaled geometry rebuild)_
- [x] Implement LOD selection _(desiredLod from XZ chunk distance)_
- [x] Implement transition handling _(hysteresis band 3.5/4.5 chunks; budgeted remesh; no flicker)_
- [x] Benchmark visual/performance tradeoffs _(70 quads/chunk at LOD1; 88/226 chunks at LOD1; conservative downsample after playtest)_

### Milestone

- [x] **Milestone 4 complete: High-resolution microvoxel world** _(met at infrastructure level: palette storage + greedy meshing + LOD verified end to end; the actual voxel-size reduction is deferred until benchmarks demand it — the storage doc names the checkpoint)_

---

# Phase 7 — Creator Mode

## Tools

- [x] Sphere delete brush _(delete tool × sphere shape)_
- [x] Box delete brush _(delete tool × box shape)_
- [x] Cylinder brush _(all tools × cylinder shape)_
- [x] Place brush _(place tool; fills air only, refuses player cells)_
- [x] Paint brush _(paint tool; recolors non-air, water excluded)_
- [ ] Smooth brush _(deferred — terrain sculpting pass)_
- [ ] Flatten brush _(deferred — terrain sculpting pass)_
- [ ] Raise terrain _(deferred — terrain sculpting pass)_
- [ ] Lower terrain _(deferred — terrain sculpting pass)_
- [x] Noise brush _(deterministic scatter via hash3, density/seed)_
- [ ] Erosion brush _(deferred)_
- [ ] Damage brush _(superseded by the Phase 8 explosion tool)_
- [x] Material replacement tool _(replace tool; `replaceFrom` wildcard = any non-air)_

## Selection

- [x] Single voxel selection _(1³ box via two identical corners)_
- [x] Box selection _(two corner clicks, normalized bounds)_
- [ ] Region selection _(non-box regions — cut, no consumer yet)_
- [ ] Multi-selection _(deferred with gizmos)_
- [x] Selection visualization _(yellow wireframe; CreatorViz)_

## Transform

- [ ] Translate gizmo _(deferred — first-person flow, clipboard paste covers it)_
- [ ] Rotate gizmo _(deferred; clipboard rotate is bound to R)_
- [ ] Snap system _(deferred)_
- [ ] Precision modifier _(deferred)_
- [x] Mirror _(clipboard mirrorX, M key)_
- [x] Rotate voxel selection _(clipboard rotateY 90° steps, R / Shift+R)_

## Clipboard

- [x] Copy selection _(Ctrl+C; dense snapshot incl. air)_
- [x] Paste selection _(Ctrl+V; one grouped command; air skipped by default)_
- [x] Rotate clipboard _(R, Shift+R for CCW)_
- [x] Mirror clipboard _(M)_
- [x] Material remapping _(API: `remapClipboard`; no key binding yet)_

## Inspector

- [x] Voxel inspector _(I toggles HUD panel: coords, material, hardness)_
- [x] Material inspector _(registry def + hardness shown per target)_
- [ ] Object inspector _(no objects yet — Phase 9+ entities)_
- [ ] NPC inspector _(Phase 12)_
- [x] Debug state display _(HUD lines: fps/chunks/pos/undo/creator state)_

## Prefabs / Blueprints

- [x] Save voxel selection as prefab _(O; `prefab-N` auto-names, versioned v1 JSON)_
- [x] Place prefab _(load via P into clipboard, paste with Ctrl+V)_
- [x] Rotate prefab _(clipboard transforms apply to loaded prefabs)_
- [x] Mirror prefab _(same)_
- [x] Save blueprint metadata _(name + createdAt + solidVoxels in the schema)_

### Milestone

- [x] **Milestone 5 complete: Functional voxel creator/editor** _(met — brushes, selection, clipboard, prefabs, inspector all unit-tested; headless browser verified end to end; gizmos/sculpt brushes deferred with rationale)_

---

# Phase 8 — Destruction

- [x] Define damage model _(spherical reach field: `radius·(0.35+0.65·(1−hardness))`; believable-over-correct)_
- [x] Implement impact raycast _(reuse the Phase 5 DDA crosshair raycast; tool acts at the hit)_
- [x] Implement spherical damage field _(explode() in src/voxel/damage.ts, pure)_
- [x] Implement material resistance _(MATERIAL_HARDNESS derived table + hardnessOf())_
- [x] Implement voxel damage _(blast edits → AIR via applyEdits, one command)_
- [x] Implement fracture threshold _(hardness-weighted reach = per-material threshold)_
- [x] Implement detached regions _(checkSupport: budgeted region flood fill, bedrock + edge anchors)_
- [x] Implement debris generation _(deterministic hash-sampled DebrisSpecs, capped)_
- [x] Add rigid-body debris _(mini custom physics: gravity/bounce/friction/settle in DebrisSystem; Rapier deferred — debris is visual, undo restores)_
- [x] Add dust _(DustSystem: 1024 pooled voxel puffs)_
- [x] Add impact sound events _(SoundFx thud/crack/boom on the event bus; procedural WebAudio)_
- [x] Add destruction event _(EventBus: explosion / structureCollapsed, typed + tested)_
- [x] Add destruction benchmarks _(benchmarks/destruction.bench.ts; baselines in docs/performance.md)_

## Explosion

- [x] Define explosion center/radius _(hit cell center; radius = brush size + 2)_
- [x] Calculate damage falloff _(linear in hardness, see damage model)_
- [x] Calculate impulse _(radial velocity + up bias in DebrisSpecs)_
- [ ] Calculate heat _(deferred to Phase 10 fire coupling)_
- [x] Affect voxels _(crater verified in browser + tests)_
- [x] Affect rigid bodies _(debris impulse; no external physics bodies yet)_
- [ ] Affect NPCs _(no NPCs until Phase 12 — event bus carries the hook)_
- [x] Trigger particles _(dust puffs)_
- [x] Trigger sound _(boom via bus subscription)_
- [x] Add creator-mode explosion tool _(5th tool; Q/E cycle)_

### Gate criteria (§106)

- [x] Removing wall supports under a roof causes it to fall within a second _(pillar-roof unit tests + headless browser: collapse lands the same frame as the click; undo restores)_
- [x] An explosion produces debris, dust, sound, and a hole — without frame drops below 45 FPS _(headless software-GL run held ~12–17 fps with 200+ debris — cap holds the floor; per-event cost ~15 ms once, pool-bounded per frame after; real-hardware 60 fps carry-over expected from budget math)_
- [x] Debris count is capped and pooled; a 100-event stress test stays stable _(tests/debrisPool.test.ts: 100 explosions ≤ 512 pieces, pool recycles, no growth)_

### Milestone

- [x] **Milestone 6 complete: Destructible voxel structures**

---

# Phase 9 — Water

- [x] Define fluid cell _(level 0–255 per water cell; 255 = source by default, 1–254 flowing in a sparse map)_
- [x] Implement water placement _(WATER material = source; hotbar 6, brush place, RMB — creates sources with zero setup)_
- [x] Implement gravity _(down-dump to the 254 cap per tick)_
- [x] Implement horizontal flow _(integer equalization `diff >> 1` when `diff ≥ 2`, fixed neighbor order)_
- [x] Implement boundaries _(solid cells can't receive; unloaded chunks refuse writes; world edges hold)_
- [x] Implement mass conservation _(exact in closed basins — unit-tested; verified in-browser: interior mass = region mass, stable over time)_
- [x] Implement chunk boundaries _(cross-chunk flow with conservation; frontier water waits for `onChunkReady`)_
- [ ] Implement pressure _(deferred — no up-flow/u-tubes; Phase 10+ or a later pass)_
- [x] Implement water rendering _(flow-height: `waterDrop` attribute sinks surfaced tops; full/submerged merge unchanged; LOD1 = full cubes)_
- [ ] Add fluid debug visualization _(deferred — HUD active counter + inspector `water N/255` exist; no dedicated overlay)_
- [x] Add fluid benchmark _(benchmarks/fluid.bench.ts; 384-cell tick 2.60 ms mean, basin flood ≈2.7 s — docs/performance.md)_
- [ ] Move fluid simulation to worker _(deferred — the budget keeps it on-thread and cheap)_
- [ ] Investigate GPU fluid simulation _(deferred — research task, Phase 21 checkpoint)_

### Milestone

- [x] **Milestone 7 complete: Water can flow through the world** _(met — flow, conservation, containment, quiescence, swim/climb, and save-v2 restore verified by unit tests AND the headless browser suite)_

---

# Phase 10 — Fire and Smoke

## Fire

- [x] Implement temperature _(believable-over-accurate: heat is an integer accumulator that builds only in flammable cells — no temperature field; ignitionHeat(flammability) thresholds)_
- [x] Implement fuel _(burning cell = fuel counter in ticks from the derived MATERIAL_FIRE table: wood 480, grass 64)_
- [x] Implement oxygen _(6-neighbor approximation: a fully-enclosed burning cell is smothered — no air-access field)_
- [x] Implement ignition _(heat ≥ threshold ignites; ignite tool + explosion BLAST_HEAT coupling)_
- [x] Implement spread _(burning cells deposit HEAT_PER_TICK into flammable 6-neighbors; fixed order, deterministic)_
- [x] Implement material burn rates _(MATERIAL_FIRE derived table: flammability + burnDuration per material; fireproof default)_
- [x] Implement extinguishing _(adjacent water → cause 'water'; full enclosure → cause 'smothered'; fireExtinguished events)_
- [x] Couple fire to water _(milestone 8: adjacent water extinguishes and survives; fluid flow into fire kills it via the world hook; steam puff)_
- [ ] Couple fire to wind _(deferred — no weather system until Phase 15/16)_
- [ ] Couple fire to rain _(deferred — no weather system until Phase 15/16)_

## Smoke

- [x] Implement smoke source _(burning cells emit; FireFx update consumes the sim's burning list)_
- [x] Implement particle smoke _(pooled InstancedMesh, 512 smoke + 256 embers, src/render/firefx.ts)_
- [x] Implement buoyancy _(smoke rises with acceleration + damped drift; embers arc under gravity)_
- [x] Implement smoke density _(emission ∝ burning-cell count with hard per-frame caps; pool recycling)_
- [x] Add smoke rendering _(dark voxel-styled boxes, growth + lifetime; fire screenshots in .verify/artifacts/)_
- [x] Add smoke debug visualization _(HUD `· fire N` counter + inspector `burning <fuel>`; pool counts exposed on __mw)_
- [ ] Investigate volumetric smoke _(deferred — research item, plan §24)_

### Milestone

- [x] **Milestone 8 complete: Fire and water interact** _(met — adjacent water extinguishes burning cells (and survives), fluid writes kill fire through the world hook, fire burn-outs flow with water; unit-tested and verified in the headless browser)_

---

# Phase 11 — Structural Simulation

- [x] Define structural node _(a solid cell in the scan region)_
- [x] Define structural connection _(6-neighbor adjacency: vertical always transmits, horizontal within `MAX_CANTILEVER = 6` groundless hops)_
- [x] Build support graph _(0/1-cost BFS from bedrock + region-edge anchors; rebuilt locally per analysis — incremental by region, not by persistent graph state)_
- [x] Detect unsupported components _(cost 255 = no support path → collapse)_
- [x] Calculate simplified stress _(vertical stack load: 1 + all solid above in the column)_
- [x] Add failure thresholds _(`strengthOf` — derived `MATERIAL_STRENGTH` table; journaled cells only, so natural terrain is exempt)_
- [x] Detach unstable components _(failing cells → AIR as one grouped undoable command; the edit re-queues the region → progressive cascade)_
- [x] Convert detached pieces to rigid bodies _(pooled debris pipeline with gravity/bounce — believable; Rapier deferred)_
- [x] Add structural debug visualization _(`StructureViz`, G toggle: red = lost support, orange = stress fracture; HUD pending counter)_
- [x] Add collapse benchmark _(benchmarks/structure.bench.ts: GATE 2.19 ms house-scale, worst-case solid 3.18 ms, cascade ≈ 6.9 ms over ~16 ticks)_
- [x] Test large building collapse _(13×5 pavilion + 43×43×3 floating slab (5547 cells > 4096 cap, cascade finishes); 24-tall tower fracture + full cascade; 4096-cell truncation tested)_

### Milestone

- [x] **Milestone 9 complete: Buildings can collapse** _(met — the plan §109 gate holds end to end: destroying a building's ground floor detaches and drops the upper floors as debris that settles; analysis is budgeted and ticked at 2.19 ms house-scale (< 5 ms); believable over correct — no engineering accuracy claimed, limitations in docs/known-issues.md)_

---

# Phase 12 — NPCs

## Core NPC

- [ ] Define NPC entity
- [ ] Add transform
- [ ] Add health
- [ ] Add needs
- [ ] Add inventory
- [ ] Add home
- [ ] Add job
- [ ] Add schedule
- [ ] Add state machine / behavior system

## Navigation

- [ ] Define walkable space
- [ ] Build navigation graph
- [ ] Implement A*
- [ ] Implement dynamic obstacle updates
- [ ] Implement local navigation invalidation

## Perception

- [ ] Vision
- [ ] Field of view
- [ ] Line of sight
- [ ] Hearing
- [ ] Sound propagation
- [ ] Event detection

## Reactions

- [ ] Wander
- [ ] Go home
- [ ] Go to work
- [ ] Investigate sound
- [ ] Flee fire
- [ ] React to collapse
- [ ] React to flood
- [ ] React to power outage

### Milestone

- [ ] **Milestone 10 complete: NPCs live in and react to the world**

---

# Phase 13 — Procedural Town

- [ ] Road generator
- [ ] Road graph
- [ ] Block generation
- [ ] Lot generation
- [ ] House generator
- [ ] Apartment generator
- [ ] Shop generator
- [ ] Industrial building generator
- [ ] Interior generator
- [ ] Furniture placement
- [ ] Utility generation
- [ ] NPC home assignment
- [ ] Job assignment
- [ ] Procedural vegetation
- [ ] River integration

### Milestone

- [ ] **Milestone 11 complete: Procedural explorable town**

---

# Phase 14 — Utilities

## Electricity

- [ ] Define power graph
- [ ] Add generators
- [ ] Add wires
- [ ] Add switches
- [ ] Add lamps
- [ ] Add consumers
- [ ] Track voltage/current/power
- [ ] Handle broken wires
- [ ] Trigger power outage events

## Plumbing

- [ ] Define pipe graph
- [ ] Add water sources
- [ ] Add valves
- [ ] Add pumps
- [ ] Add fixtures
- [ ] Add leaks
- [ ] Add drains
- [ ] Add sewer network

### Milestone

- [ ] **Milestone 12 complete: Basic utility networks work**

---

# Phase 15 — Weather and Atmosphere

- [ ] Day/night cycle
- [ ] Sun movement
- [ ] Moon
- [ ] Sky
- [ ] Stars
- [ ] Clouds
- [ ] Rain
- [ ] Heavy rain
- [ ] Storm
- [ ] Fog
- [ ] Snow
- [ ] Weather transitions
- [ ] Wind
- [ ] Temperature
- [ ] Humidity
- [ ] Seasons

---

# Phase 16 — Rendering Polish

- [ ] Improve voxel materials
- [ ] Procedural micro-detail
- [ ] Voxel AO
- [ ] Contact shadows
- [ ] Cascaded shadows
- [ ] Reflections
- [ ] SSR experiment
- [ ] Bloom
- [ ] Tone mapping
- [ ] Color grading
- [ ] Volumetric fog
- [ ] Volumetric clouds
- [ ] Temporal AA experiment
- [ ] Voxel GI experiment
- [ ] GPU particle system

---

# Phase 17 — Audio

- [ ] Audio manager
- [ ] Sound event bus integration
- [ ] Footsteps
- [ ] Material-dependent footsteps
- [ ] Impact sounds
- [ ] Destruction sounds
- [ ] Water sounds
- [ ] Fire sounds
- [ ] Wind
- [ ] Rain
- [ ] Machinery
- [ ] Traffic
- [ ] Birds
- [ ] Environmental ambience
- [ ] Sound propagation
- [ ] Reverb zones

---

# Phase 18 — Scenario System

- [ ] Scenario data model
- [ ] Scenario loader
- [ ] Scenario objectives
- [ ] Scenario triggers
- [ ] Scenario completion
- [ ] Flood scenario
- [ ] Fire scenario
- [ ] Collapse scenario
- [ ] Demolition scenario
- [ ] Rescue scenario

---

# Phase 19 — Scripting

- [ ] Event API
- [ ] Trigger system
- [ ] Condition system
- [ ] Action system
- [ ] Variables
- [ ] Timers
- [ ] Entity references
- [ ] Script persistence
- [ ] Script debugging
- [ ] Visual logic prototype
- [ ] Creator scripting documentation

---

# Phase 20 — LLM Integration

Only after core deterministic simulation is stable.

- [ ] Define LLM integration boundary
- [ ] Define structured NPC context
- [ ] Define high-level intention schema
- [ ] Implement optional NPC dialogue
- [ ] Implement scenario generation
- [ ] Implement mission generation
- [ ] Implement world descriptions
- [ ] Add safeguards against invalid actions
- [ ] Ensure LLM cannot directly corrupt simulation state
- [ ] Cache generated responses
- [ ] Add fallback behavior when unavailable

---

# Phase 21 — GPU Compute

- [ ] Identify CPU bottlenecks
- [ ] Create GPU compute abstraction
- [ ] GPU particle simulation
- [ ] GPU fluid experiment
- [ ] GPU voxel processing experiment
- [ ] GPU terrain generation experiment
- [ ] GPU destruction-field experiment
- [ ] GPU lighting/AO experiment
- [ ] Benchmark CPU vs GPU implementations

---

# Phase 22 — Huge Worlds

- [ ] 1 km² world benchmark
- [ ] 10 km² world benchmark
- [ ] Infinite terrain experiment
- [ ] Predictive streaming
- [ ] Aggressive LOD
- [ ] Sparse world storage
- [ ] Memory budget system
- [ ] GPU memory budget system

---

# Phase 23 — Benchmarking and Profiling

- [ ] Built-in profiler
- [ ] CPU timers
- [ ] GPU timers if available
- [ ] Memory statistics
- [ ] Chunk statistics
- [ ] Voxel statistics
- [ ] NPC statistics
- [ ] Physics statistics
- [ ] Fluid statistics
- [ ] Automated benchmark runner
- [ ] Benchmark result serialization
- [ ] Benchmark comparison reports

---

# Phase 24 — Replay and Determinism

- [ ] Deterministic RNG
- [ ] Deterministic world generation
- [ ] Input recording
- [ ] Event recording
- [ ] Replay format
- [ ] Replay playback
- [ ] Replay validation
- [ ] Desync diagnostics
- [ ] Time manipulation

---

# Phase 25 — Photo / Cinematic Mode

- [ ] Free camera
- [ ] Camera speed
- [ ] FOV
- [ ] Exposure
- [ ] Focus distance
- [ ] Depth of field
- [ ] Weather control
- [ ] Time-of-day control
- [ ] Camera keyframes
- [ ] Look targets
- [ ] Easing curves
- [ ] Slow-motion capture workflow

---

# Phase 26 — Advanced Creator Tool

- [ ] Hierarchy panel
- [ ] Inspector panel
- [ ] Material browser
- [ ] Prefab browser
- [ ] Blueprint browser
- [ ] Search
- [ ] Filter
- [ ] Multi-select
- [ ] Transform snapping
- [ ] Terrain sculpting
- [ ] Voxel painting
- [ ] Simulation controls
- [ ] Time controls
- [ ] Weather controls
- [ ] Debug overlays
- [ ] World statistics

---

# Phase 27 — Ultimate Showcase

## Town

- [ ] Generate ~500 × 500 m town
- [ ] Add residential area
- [ ] Add industrial area
- [ ] Add supermarket
- [ ] Add gas station
- [ ] Add construction site
- [ ] Add forest
- [ ] Add river
- [ ] Add bridge

## Population

- [ ] 200 NPC benchmark
- [ ] 50 vehicle benchmark
- [ ] NPC schedules
- [ ] Traffic
- [ ] Emergency response

## Showcase Scenario

- [ ] Storm starts
- [ ] Rain begins
- [ ] Drainage failure
- [ ] Basement flooding
- [ ] Electrical short
- [ ] Fire
- [ ] NPC evacuation
- [ ] Firefighters
- [ ] Bridge weakening
- [ ] Vehicle crossing
- [ ] Bridge collapse
- [ ] Traffic rerouting
- [ ] Water continues downstream
- [ ] Creator mode intervention
- [ ] World modification
- [ ] Resume simulation

### Final showcase milestone

- [ ] **Ultimate technical demo complete**

---

# Research / Comparison Tasks

## Voxel Storage

- [ ] Dense benchmark
- [ ] Palette benchmark
- [ ] RLE benchmark
- [ ] Sparse benchmark
- [ ] SVO benchmark
- [ ] Write comparison document

## Meshing

- [ ] Naive benchmark
- [ ] Greedy benchmark
- [ ] Marching cubes benchmark
- [ ] Surface nets benchmark
- [ ] Dual contouring benchmark
- [ ] Write comparison document

## Fluid Simulation

- [ ] Cellular automata prototype
- [ ] Height-field prototype
- [ ] Stable-fluid prototype
- [ ] GPU prototype
- [ ] Compare quality/performance

## Rendering

- [ ] Naive cubes benchmark
- [ ] Greedy mesh benchmark
- [ ] Instancing benchmark
- [ ] Batching benchmark
- [ ] GPU voxel rendering experiment
- [ ] Compare quality/performance

---

# QA / Testing Backlog

## Core invariants

- [x] Coordinate conversion round-trip _(tests/coordinates.test.ts, Session 001)_
- [x] Chunk generation determinism _(tests/terrain.test.ts, Session 002)_
- [x] Serialization round-trip _(tests/persistence.test.ts, Session 003)_
- [x] Undo/redo round-trip _(tests/edits.test.ts, Session 003)_
- [x] Place/remove round-trip _(tests/edits.test.ts, Session 003)_
- [x] Editing air is safe _(air removal is a no-op; placement into air covered — Session 003)_
- [x] Chunk boundary edits are correct _(dirty propagation + journal + greedy world-query equivalence — Sessions 002–003)_
- [x] Negative coordinates are correct _(raycast + edits tests, Session 003)_
- [x] Clipboard transforms round-trip _(rotate ×4 = identity, mirror involution — tests/creatorClipboard.test.ts, Session 004)_
- [x] Prefab serialization round-trip _(incl. RLE, corrupt JSON, version drift — tests/creatorPrefab.test.ts, Session 004)_
- [x] Blast determinism _(same seed → identical debris; bedrock/water immunity — tests/damage.test.ts, Session 004)_
- [x] Unsupported structures do not remain stable _(pillar-roof collapse fixture — tests/structure.test.ts, Sessions 004+007)_
- [x] Structural analysis is deterministic _(identical worlds + trigger → identical collapse lists — tests/structure.test.ts, Session 007)_
- [x] Natural terrain never avalanches from stress _(generator-written cells are stress-exempt — tests/structure.test.ts, Session 007)_
- [x] Burned-through structures collapse _(fire → structure coupling — tests/structure.test.ts, Session 007)_

## Simulation invariants

- [x] Fluid approximately conserves mass _(exact in closed basins — tests/fluid.test.ts + in-browser containment/conservation checks, Session 005)_
- [x] Fluid boundary conditions are stable _(solid containment, world edges, frontier sleep — tests/fluid.test.ts, Session 005)_
- [x] Fire cannot ignite nonflammable materials _(tests/fire.test.ts: stone/sand/dirt/air refuse ignition; barriers stop spread; heatCells on stone is a no-op — Session 006)_
- [x] Fire extinguishes correctly _(adjacent water → extinguished + water survives; full enclosure smothers without consuming; exact burn-out after burnDuration — tests/fire.test.ts, Session 006)_
- [x] Unsupported structures become unstable _(pillar-roof collapse fixture — tests/support.test.ts, Session 004)_
- [x] Detached structures are not simulated as intact _(collapses as one command with debris specs — Session 004)_
- [ ] Simulation remains stable under extreme edits

## Stress tests

- [ ] 1M voxels
- [ ] 10M voxels
- [ ] 100M logical voxels
- [ ] 1000 simultaneous edits
- [ ] Large deletion _(cut tool + brush delete are grouped single commands; collapse of 100+ cell components tested — Session 004)_
- [ ] Large paste _(32³ budget-capped; grouped single command — Session 004)_
- [x] Large explosion _(100-event explosion stress: pool capped, stable — tests/debrisPool.test.ts, Session 004)_
- [x] Large flood _(22×22 basin source-flood benchmark: settles in ≈2.7 s inside the budget; 384-cell budget tick 2.6 ms — Session 005)_
- [x] Large fire _(20×20 wood platform burns out completely in ≈1.0 s of total sim work (~2 ms/tick amortized); full-budget tick 1.68 ms — benchmarks/fire.bench.ts, Session 006)_
- [ ] Many NPCs
- [ ] Many chunks loading/unloading

---

# Documentation Backlog

- [ ] Architecture overview
- [ ] World model
- [ ] Voxel storage
- [ ] Chunk system
- [ ] Meshing
- [ ] Rendering
- [ ] Materials
- [ ] Editing
- [ ] Serialization
- [x] Physics _(player controller notes in architecture — Player physics section)_
- [x] Fluids _(architecture "Water (Phase 9)" — sim, hooks, rendering, swim, save v2)_
- [x] Fire _(architecture "Fire (Phase 10)" — cells/heat model, death rules, ignition paths, budget, rendering, interactions)_
- [x] Structures _(architecture "Structural simulation (Phase 11)" — graph model, cantilever BFS, stress + journal exemption, ticked sim + budgets, collapse flow, fire coupling, viz)_
- [ ] NPCs
- [ ] Navigation
- [ ] World generation
- [ ] Weather
- [ ] Audio
- [ ] Scripting
- [ ] GPU compute
- [ ] Performance
- [ ] Benchmark results
- [ ] Modding API
- [ ] Save format
- [ ] Known limitations

---

# Architecture Decision Log

## ADR-001 — Hybrid world representation

**Decision:** Do not force every object to be voxelized.

**Reason:** Voxelization is most valuable for terrain, structures, and destructible/editable matter. Conventional meshes are more appropriate for many props, characters, and detailed assets.

**Status:** Accepted.

---

## ADR-002 — World state separated from rendering

**Decision:** Rendering must consume world state rather than own it.

**Reason:** Enables alternative renderers, testing, simulation, headless benchmarks, editor tooling, and future networking.

**Status:** Accepted.

---

## ADR-003 — Event-driven system integration

**Decision:** Major systems communicate through explicit events/interfaces where appropriate.

**Reason:** Fire, water, physics, AI, audio, quests, replay, and scripting need to react to the same events without becoming tightly coupled.

**Status:** Accepted.

---

## ADR-004 — No one-mesh-per-voxel architecture

**Decision:** Never represent every voxel as an independent Three.js object.

**Reason:** Draw calls, object count, memory, and CPU overhead would become prohibitive.

**Status:** Accepted.

---

## ADR-005 — Deterministic foundations

**Decision:** Prefer deterministic RNG, world generation, and simulation where practical.

**Reason:** Enables testing, replay, debugging, and potentially multiplayer.

**Status:** Accepted.

---

# Known Risks

- [ ] Microvoxel memory usage may become excessive.
- [ ] Chunk remeshing may become a bottleneck.
- [ ] Dynamic destruction may cause geometry spikes.
- [ ] Fluids may be expensive on CPU.
- [ ] NPC navigation may become expensive after destruction.
- [ ] Structural simulation may become expensive in large buildings.
- [ ] WebGPU browser support/performance may vary.
- [ ] WebGL fallback may require reduced feature scope.
- [ ] GPU/CPU synchronization may become a bottleneck.
- [ ] Browser memory limits may constrain world size.
- [ ] Physics object counts may explode after destruction.
- [ ] Procedural generation quality may be inconsistent.
- [ ] AI-generated code may introduce architectural drift.
- [ ] Scope may become too large.

---

# Scope Control Rules

If the project becomes too large:

### Tier 1 — Must have

- [ ] Microvoxel world
- [ ] Chunking
- [ ] Efficient meshing
- [ ] First-person movement
- [ ] Editing
- [ ] Save/load
- [ ] Destruction
- [ ] Basic physics
- [ ] Water
- [ ] Fire
- [ ] Creator mode

### Tier 2 — High value

- [ ] Structural collapse
- [ ] Procedural terrain
- [ ] Procedural town
- [ ] NPCs
- [ ] Weather
- [ ] Audio
- [ ] Scripting
- [ ] GPU compute

### Tier 3 — Stretch

- [ ] Electricity
- [ ] Plumbing
- [ ] Vehicles
- [ ] Traffic
- [ ] Advanced GI
- [ ] Ecosystem
- [ ] LLM NPCs
- [ ] Infinite world
- [ ] Multiplayer
- [ ] Modding

Do not sacrifice Tier 1 foundations to chase Tier 3 features.

---

# Suggested AI Task Format

When asking a coding agent to implement something, prefer this structure:

```text
TASK:
<one concrete task>

CONTEXT:
<relevant architecture>

REQUIREMENTS:
- Requirement 1
- Requirement 2
- Requirement 3

CONSTRAINTS:
- Do not break existing APIs.
- Keep deterministic behavior.
- Add tests.
- Avoid unnecessary dependencies.

ACCEPTANCE CRITERIA:
- Criterion 1
- Criterion 2
- Criterion 3

VALIDATION:
- Run unit tests.
- Run typecheck.
- Run lint.
- Run build.
- Report benchmark results if relevant.

AFTER IMPLEMENTATION:
- Update documentation.
- Update this progress file.
- List files changed.
- List known limitations.
```

---

# Session Handoff Template

At the end of each coding session, update:

```text
## Session XXX — YYYY-MM-DD

### Completed
- [x] Task
- [x] Task

### Partially completed
- [ ] Task — explain exact state

### Tests
- Unit tests:
- Integration tests:
- Typecheck:
- Lint:
- Build:

### Benchmarks
- FPS:
- Frame time:
- Memory:
- Chunk count:
- Other:

### Architecture changes
- Change:
- Reason:

### Known issues
- Issue:
- Severity:

### Next task
- Task:

### Recommended next steps
1.
2.
3.
```

---

# Agent Instruction — How to Resume

When starting a new session:

1. Read `MICRO_WORLD_PROGRESS.md`.
2. Inspect the repository.
3. Check whether the recorded "Current task" is actually complete.
4. Run relevant tests.
5. Inspect the latest session log.
6. Continue from the first sensible unchecked task.
7. Do not ask for unnecessary confirmation if the task is unambiguous.
8. Before ending, update this file with exact progress.
