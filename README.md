# MICRO//WORLD

Browser-based voxel simulation engine and sandbox: a microvoxel world with
destructible, editable terrain, flowing water, fire, collapsing structures,
and NPCs that react to all of it. Long-term roadmap lives in
`MICRO_WORLD_DEVELOPMENT_PLAN.md`; session-by-session state lives in
`MICRO_WORLD_PROGRESS.md`.

**Current state:** Phases 0–8 complete — an infinite streamed world of
deterministic seeded terrain that is **editable, saveable, and
destructible**: brush tools, box selection, clipboard, prefabs, and a
voxel inspector (creator mode), plus explosions with material
resistance, support-aware structural collapse, pooled debris and dust,
and procedural sound (Milestones 1–5 met; the Phase 8 gate criteria are
verified by tests).

## Quickstart

Requires Node 22+.

```sh
npm install
npm run dev        # dev server, print the URL it gives you
```

Append `?seed=1234` to the URL for a different (still deterministic) world.

Controls: click to capture the mouse, **WASD** move, **Space** jump,
**Esc** release the mouse; **LMB** remove, **RMB** place, **MMB** pick
material, **F** paint, **1–6**/wheel select material, **Ctrl+Z/Y**
undo/redo, **K** save, **L** load, **N** mute sound. Fall into the void
and you respawn. The world autosaves (20 s cadence + when the tab hides)
and restores on reload; `?seed=1234` starts a different fresh world.

Creator mode (**C**): **LMB** applies the brush, **Q/E** cycle tools
(place/delete/paint/replace/explode), **V** cycles shapes
(sphere/box/cylinder/noise), **[ ]** brush size, **B** box-select (two
clicks) then **Ctrl+C/X/V** copy/cut/paste, **R**/**M** rotate/mirror the
clipboard, **O/P** save/load prefabs, **I** voxel inspector.

## Scripts

| Command              | What it does                    |
| -------------------- | ------------------------------- |
| `npm run dev`        | Vite dev server with hot reload |
| `npm run build`      | Production build into `dist/`   |
| `npm run preview`    | Serve the production build      |
| `npm run typecheck`  | `tsc --noEmit` (strict)         |
| `npm run lint`       | ESLint (flat config)            |
| `npm run format`     | Prettier over the repo          |
| `npm test`           | Vitest, single run              |
| `npm run test:watch` | Vitest in watch mode            |
| `npm run bench`      | Vitest microbenchmarks          |

## Repository layout

```text
index.html                 Page shell: overlay, HUD, crosshair, hotbar
src/main.ts                Game wiring: world → streaming → scene → loop
src/voxel/                 World state (no three.js — see ADR-002)
  coordinates.ts           World/chunk/local conversions, negative-safe
  materials.ts             Material registry: metadata, classification, serialization, hardness
  voxelVolume.ts           VoxelData interface + dense Uint16Array volume
  packedVolume.ts          Palette-compressed volume + occupancy bitset (chunks)
  occupancy.ts             Bit-per-voxel occupancy grid
  chunk.ts, world.ts       Chunk wrapper + chunk map (get/set, dirty propagation)
  edits.ts                 EditCommand grouping, undo/redo history, player guard
  raycast.ts               Voxel DDA selection raycast (pure)
  damage.ts                Explosion damage fields, debris specs (pure)
  support.ts               Detached-region (collapse) detection (pure)
  persistence.ts           Versioned save schema, migration, autosave policy
  mesher.ts                Naive culled mesher (correctness baseline)
  greedyMesher.ts          Greedy mesher (production) → typed arrays
  lod.ts                   LOD downsample + hysteresis level selection
  terrain.ts               Seeded RNG, value-noise fBm, height, chunk generator
  streaming.ts             Pure streaming math: desired set, priority, unload rings
src/creator/               Editor core (pure — produces edit lists)
  brush.ts                 Shapes × tools → edit lists (one stroke = one command)
  selection.ts             Box selection, region copy, 32³ budget
  clipboard.ts             Rotate/mirror/remap transforms, paste flattening
  prefab.ts                Versioned v1 JSON (RLE), prefab library
  inspector.ts             Voxel/material lookups for the HUD panel
src/sim/
  events.ts                Typed game event bus (ADR-003)
src/player/
  controller.ts            Pure physics: look, gravity, AABB per-axis collision
  input.ts                 DOM keyboard + pointer-lock mouse
src/render/                The only three.js code (see ADR-002)
  bootstrap.ts             Renderer, scene, camera, resize, frame loop
  voxelGeometry.ts         Mesher output → BufferGeometry
  voxelMaterial.ts         Voxel shader: palette texture, variation, light, fog
  chunkMeshes.ts           Mesh cache, streaming queue, LOD switches, dirty remesh
  selectionViz.ts          Target wireframe + placement ghost
  creatorViz.ts            Brush ghost, selection + paste wireframes
  debris.ts                Pooled InstancedMesh debris with mini physics
  dust.ts                  Pooled voxel dust puffs
src/audio/
  sfx.ts                   Procedural WebAudio destruction sounds (DOM adapter)
tests/                     Vitest unit tests (node environment)
benchmarks/                Vitest benchmarks (`npm run bench`)
docs/                      Architecture, performance, voxel-storage, known issues
```

## Conventions

- **World/sim/editor code never imports three.js or the DOM.**
  `src/render/` consumes world state; `src/audio/` and
  `src/persistence/` are the only other DOM-adjacent adapters. Nothing
  in `src/voxel/`, `src/creator/`, `src/sim/`, or `src/player/`
  (except `input.ts`) knows a renderer or window exists. This keeps the
  simulation unit-testable in node and open to a future WebGPU renderer.
- **Generation is deterministic.** Terrain is a pure function of
  (seed, coordinates) — no sequential RNG state — so chunk generation
  order never matters and unloaded chunks regenerate identically.
- Mesher output is plain typed arrays (`positions`, `normals`,
  `materialIds`, `indices`), not scene objects. Chunks store voxels as a
  palette + bit-packed indices (see `docs/voxel-storage.md`).
- Strict TypeScript, ESLint + Prettier, and tests are enforced in CI
  (`.github/workflows/ci.yml`: lint → typecheck → test → build on Node 22).
