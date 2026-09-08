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

**Current phase:** Phase 1 complete — next: Phase 2 (Chunks)

**Current milestone:** Milestone 1 (walk around a small voxel world) — met, verified in browser

**Overall completion:** ~10% (Phase 0 done, Phase 1 done, raycast stub deferred to Phase 5)

**Last completed task:** Session 001 — repository unblocked (moved to ext4), npm install, git + CI, docs, baseline app, full Phase 1 (world, storage, mesher, player), 38 tests green, browser smoke test passed

**Current task:** None — clean handoff point

**Blocked by:** Nothing (the exFAT blocker is resolved; project now lives on ext4 at `~/Coding Project/OpenCoder/AI_VOXELS/AI Voxel Game`)

**Next recommended action:** Start Phase 2 (Chunks): chunk data structure around the existing `VoxelVolume`/coordinate primitives, chunk-boundary meshing with neighbor lookups, dirty-flag remeshing. See session log below for exact entry state.

---

# Session Log

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
- [x] Establish package/app structure if using a monorepo *(N/A — single npm package, per agreed approach)*
- [x] Configure strict TypeScript
- [x] Configure ESLint
- [x] Configure formatter
- [x] Configure unit testing
- [ ] Configure integration testing *(browser smoke test is manual; automated browser tests deferred)*
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
- [ ] Add basic interaction raycast *(deferred to Phase 5 — its first consumer is editing; see `docs/known-issues.md`)*

### Milestone

- [x] **Milestone 1 complete: Walk around a small voxel world** *(met — verified in browser with real input: spawn, walk, jump, mouse look, collision, respawn)*

---

# Phase 2 — Chunks

## Chunk

- [ ] Define chunk size
- [ ] Create chunk data structure
- [ ] Implement chunk-local indexing
- [ ] Implement neighbor lookup
- [ ] Implement dirty flags
- [ ] Implement chunk lifecycle
- [ ] Add chunk tests

## Chunk Meshing

- [ ] Mesh one chunk
- [ ] Hide internal faces
- [ ] Handle neighboring chunks
- [ ] Remesh dirty chunks
- [ ] Dispose old geometry
- [ ] Add mesh cache

## Streaming

- [ ] Define render distance
- [ ] Load chunks around player
- [ ] Unload distant chunks
- [ ] Implement chunk request queue
- [ ] Prioritize chunks near player
- [ ] Prioritize chunks in camera direction
- [ ] Add loading statistics

### Milestone

- [ ] **Milestone 2 complete: Walkable chunked world**

---

# Phase 3 — Terrain

- [ ] Implement seeded RNG
- [ ] Implement deterministic noise
- [ ] Implement base terrain height
- [ ] Add hills
- [ ] Add mountains
- [ ] Add plains
- [ ] Add sea level
- [ ] Add terrain material layers
- [ ] Add terrain generation tests
- [ ] Verify deterministic chunk generation

---

# Phase 4 — Materials

- [ ] Create material registry
- [ ] Add air
- [ ] Add grass
- [ ] Add dirt
- [ ] Add stone
- [ ] Add sand
- [ ] Add wood
- [ ] Add water placeholder
- [ ] Add material metadata
- [ ] Add material lookup
- [ ] Add material serialization
- [ ] Add basic material shader
- [ ] Add material variation

---

# Phase 5 — Editing

## Basic Editing

- [ ] Add voxel placement
- [ ] Add voxel deletion
- [ ] Add material painting
- [ ] Add selection raycast
- [ ] Add edit preview
- [ ] Add edit confirmation
- [ ] Add dirty chunk updates

## Undo / Redo

- [ ] Define `EditCommand`
- [ ] Implement voxel edit command
- [ ] Implement undo stack
- [ ] Implement redo stack
- [ ] Add grouped commands
- [ ] Test undo/redo invariants

## Save / Load

- [ ] Define world serialization schema
- [ ] Serialize chunks
- [ ] Deserialize chunks
- [ ] Save world
- [ ] Load world
- [ ] Add world version
- [ ] Add migration mechanism
- [ ] Add autosave
- [ ] Add crash-recovery strategy

### Milestone

- [ ] **Milestone 3 complete: Editable, saveable voxel sandbox**

---

# Phase 6 — Microvoxels

## Storage

- [ ] Benchmark dense storage
- [ ] Implement palette compression
- [ ] Benchmark palette compression
- [ ] Investigate sparse chunks
- [ ] Implement occupancy bitsets
- [ ] Investigate SVO representation
- [ ] Document representation tradeoffs

## Meshing

- [ ] Implement greedy mesher
- [ ] Benchmark greedy vs naive
- [ ] Add mesh cache
- [ ] Reduce allocations
- [ ] Add transferable mesh buffers
- [ ] Add mesh generation benchmark

## LOD

- [ ] Define LOD levels
- [ ] Implement chunk LOD
- [ ] Implement LOD selection
- [ ] Implement transition handling
- [ ] Benchmark visual/performance tradeoffs

### Milestone

- [ ] **Milestone 4 complete: High-resolution microvoxel world**

---

# Phase 7 — Creator Mode

## Tools

- [ ] Sphere delete brush
- [ ] Box delete brush
- [ ] Cylinder brush
- [ ] Place brush
- [ ] Paint brush
- [ ] Smooth brush
- [ ] Flatten brush
- [ ] Raise terrain
- [ ] Lower terrain
- [ ] Noise brush
- [ ] Erosion brush
- [ ] Damage brush
- [ ] Material replacement tool

## Selection

- [ ] Single voxel selection
- [ ] Box selection
- [ ] Region selection
- [ ] Multi-selection
- [ ] Selection visualization

## Transform

- [ ] Translate gizmo
- [ ] Rotate gizmo
- [ ] Snap system
- [ ] Precision modifier
- [ ] Mirror
- [ ] Rotate voxel selection

## Clipboard

- [ ] Copy selection
- [ ] Paste selection
- [ ] Rotate clipboard
- [ ] Mirror clipboard
- [ ] Material remapping

## Inspector

- [ ] Voxel inspector
- [ ] Material inspector
- [ ] Object inspector
- [ ] NPC inspector
- [ ] Debug state display

## Prefabs / Blueprints

- [ ] Save voxel selection as prefab
- [ ] Place prefab
- [ ] Rotate prefab
- [ ] Mirror prefab
- [ ] Save blueprint metadata

### Milestone

- [ ] **Milestone 5 complete: Functional voxel creator/editor**

---

# Phase 8 — Destruction

- [ ] Define damage model
- [ ] Implement impact raycast
- [ ] Implement spherical damage field
- [ ] Implement material resistance
- [ ] Implement voxel damage
- [ ] Implement fracture threshold
- [ ] Implement detached regions
- [ ] Implement debris generation
- [ ] Add rigid-body debris
- [ ] Add dust
- [ ] Add impact sound events
- [ ] Add destruction event
- [ ] Add destruction benchmarks

## Explosion

- [ ] Define explosion center/radius
- [ ] Calculate damage falloff
- [ ] Calculate impulse
- [ ] Calculate heat
- [ ] Affect voxels
- [ ] Affect rigid bodies
- [ ] Affect NPCs
- [ ] Trigger particles
- [ ] Trigger sound
- [ ] Add creator-mode explosion tool

### Milestone

- [ ] **Milestone 6 complete: Destructible voxel structures**

---

# Phase 9 — Water

- [ ] Define fluid cell
- [ ] Implement water placement
- [ ] Implement gravity
- [ ] Implement horizontal flow
- [ ] Implement boundaries
- [ ] Implement mass conservation
- [ ] Implement chunk boundaries
- [ ] Implement pressure
- [ ] Implement water rendering
- [ ] Add fluid debug visualization
- [ ] Add fluid benchmark
- [ ] Move fluid simulation to worker
- [ ] Investigate GPU fluid simulation

### Milestone

- [ ] **Milestone 7 complete: Water can flow through the world**

---

# Phase 10 — Fire and Smoke

## Fire

- [ ] Implement temperature
- [ ] Implement fuel
- [ ] Implement oxygen
- [ ] Implement ignition
- [ ] Implement spread
- [ ] Implement material burn rates
- [ ] Implement extinguishing
- [ ] Couple fire to water
- [ ] Couple fire to wind
- [ ] Couple fire to rain

## Smoke

- [ ] Implement smoke source
- [ ] Implement particle smoke
- [ ] Implement buoyancy
- [ ] Implement smoke density
- [ ] Add smoke rendering
- [ ] Add smoke debug visualization
- [ ] Investigate volumetric smoke

### Milestone

- [ ] **Milestone 8 complete: Fire and water interact**

---

# Phase 11 — Structural Simulation

- [ ] Define structural node
- [ ] Define structural connection
- [ ] Build support graph
- [ ] Detect unsupported components
- [ ] Calculate simplified stress
- [ ] Add failure thresholds
- [ ] Detach unstable components
- [ ] Convert detached pieces to rigid bodies
- [ ] Add structural debug visualization
- [ ] Add collapse benchmark
- [ ] Test large building collapse

### Milestone

- [ ] **Milestone 9 complete: Buildings can collapse**

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

- [ ] Coordinate conversion round-trip
- [ ] Chunk generation determinism
- [ ] Serialization round-trip
- [ ] Undo/redo round-trip
- [ ] Place/remove round-trip
- [ ] Editing air is safe
- [ ] Chunk boundary edits are correct
- [ ] Negative coordinates are correct

## Simulation invariants

- [ ] Fluid approximately conserves mass
- [ ] Fluid boundary conditions are stable
- [ ] Fire cannot ignite nonflammable materials
- [ ] Fire extinguishes correctly
- [ ] Unsupported structures become unstable
- [ ] Detached structures are not simulated as intact
- [ ] Simulation remains stable under extreme edits

## Stress tests

- [ ] 1M voxels
- [ ] 10M voxels
- [ ] 100M logical voxels
- [ ] 1000 simultaneous edits
- [ ] Large deletion
- [ ] Large paste
- [ ] Large explosion
- [ ] Large flood
- [ ] Large fire
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
- [ ] Physics
- [ ] Fluids
- [ ] Fire
- [ ] Structures
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
