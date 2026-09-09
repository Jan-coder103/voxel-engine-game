# MICRO//WORLD

Browser-based voxel simulation engine and sandbox: a microvoxel world with
destructible, editable terrain, flowing water, fire, collapsing structures,
and NPCs that react to all of it. Long-term roadmap lives in
`MICRO_WORLD_DEVELOPMENT_PLAN.md`; session-by-session state lives in
`MICRO_WORLD_PROGRESS.md`.

**Current state:** Phases 0–6 complete — an infinite streamed world of
deterministic seeded terrain that is **editable and saveable**: crosshair
editing (place/remove/paint/pick) with undo/redo, an edit journal that
survives reloads, localStorage autosave, greedy meshing with LOD, and
palette-compressed chunk storage (Milestones 1–4 met).

## Quickstart

Requires Node 22+.

```sh
npm install
npm run dev        # dev server, print the URL it gives you
```

Append `?seed=1234` to the URL for a different (still deterministic) world.

Controls: click to capture the mouse, **WASD** move, **Space** jump,
**Esc** release the mouse; **LMB** remove, **RMB** place, **MMB** pick
material, **F** paint, **1–7**/wheel select material, **Ctrl+Z/Y**
undo/redo, **K** save, **L** load. Fall into the void and you respawn.
The world autosaves (20 s cadence + when the tab hides) and restores on
reload; `?seed=1234` starts a different fresh world.

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
index.html                 Page shell: overlay, HUD, crosshair
src/main.ts                Game wiring: world → streaming → scene → loop
src/voxel/                 World state (no three.js — see ADR-002)
  coordinates.ts           World/chunk/local conversions, negative-safe
  materials.ts             Material registry: metadata, classification, serialization
  voxelVolume.ts           VoxelData interface + dense Uint16Array volume
  packedVolume.ts          Palette-compressed volume + occupancy bitset (chunks)
  occupancy.ts             Bit-per-voxel occupancy grid
  chunk.ts, world.ts       Chunk wrapper + chunk map (get/set, dirty propagation)
  edits.ts                 EditCommand grouping, undo/redo history, player guard
  raycast.ts               Voxel DDA selection raycast (pure)
  persistence.ts           Versioned save schema, migration, autosave policy
  mesher.ts                Naive culled mesher (correctness baseline)
  greedyMesher.ts          Greedy mesher (production) → typed arrays
  lod.ts                   LOD downsample + hysteresis level selection
  terrain.ts               Seeded RNG, value-noise fBm, height, chunk generator
  streaming.ts             Pure streaming math: desired set, priority, unload rings
src/player/
  controller.ts            Pure physics: look, gravity, AABB per-axis collision
  input.ts                 DOM keyboard + pointer-lock mouse
src/render/                The only three.js code (see ADR-002)
  bootstrap.ts             Renderer, scene, camera, resize, frame loop
  voxelGeometry.ts         Mesher output → BufferGeometry
  voxelMaterial.ts         Voxel shader: palette texture, variation, light, fog
  chunkMeshes.ts           Mesh cache, streaming queue, LOD switches, dirty remesh
  selectionViz.ts          Target wireframe + placement ghost
tests/                     Vitest unit tests (node environment)
benchmarks/                Vitest benchmarks (`npm run bench`)
docs/                      Architecture, performance, known issues
```

## Conventions

- **World/sim code never imports three.js.** `src/render/` consumes world
  state; nothing in `src/voxel/` or `src/player/` knows a renderer exists.
  This keeps the simulation unit-testable in node and open to a future
  WebGPU renderer.
- **Generation is deterministic.** Terrain is a pure function of
  (seed, coordinates) — no sequential RNG state — so chunk generation
  order never matters and unloaded chunks regenerate identically.
- Mesher output is plain typed arrays (`positions`, `normals`,
  `materialIds`, `indices`), not scene objects. Chunks store voxels as a
  palette + bit-packed indices (see `docs/voxel-storage.md`).
- Strict TypeScript, ESLint + Prettier, and tests are enforced in CI
  (`.github/workflows/ci.yml`: lint → typecheck → test → build on Node 22).
