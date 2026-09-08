# MICRO//WORLD

Browser-based voxel simulation engine and sandbox: a microvoxel world with
destructible, editable terrain, flowing water, fire, collapsing structures,
and NPCs that react to all of it. Long-term roadmap lives in
`MICRO_WORLD_DEVELOPMENT_PLAN.md`; session-by-session state lives in
`MICRO_WORLD_PROGRESS.md`.

**Current state:** Phases 2–4 complete — an infinite streamed world of
deterministic seeded terrain (hills, mountains, lakes, beaches) rendered
with the voxel material shader: chunk streaming, material palette with
per-voxel variation, translucent water.

## Quickstart

Requires Node 22+.

```sh
npm install
npm run dev        # dev server, print the URL it gives you
```

Append `?seed=1234` to the URL for a different (still deterministic) world.

Controls: click to capture the mouse, **WASD** to move, **Space** to jump,
**Esc** to release the mouse. Fall into the void and you respawn.

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
  voxelVolume.ts           Dense Uint16Array cubic volume, bounds-checked
  chunk.ts, world.ts       Chunk wrapper + chunk map (get/set, dirty propagation)
  mesher.ts                Culled face mesher → typed arrays (opaque/water passes)
  terrain.ts               Seeded RNG, value-noise fBm, height, chunk generator
  streaming.ts             Pure streaming math: desired set, priority, unload rings
src/player/
  controller.ts            Pure physics: look, gravity, AABB per-axis collision
  input.ts                 DOM keyboard + pointer-lock mouse
src/render/                The only three.js code (see ADR-002)
  bootstrap.ts             Renderer, scene, camera, resize, frame loop
  voxelGeometry.ts         Mesher output → BufferGeometry
  voxelMaterial.ts         Voxel shader: palette texture, variation, light, fog
  chunkMeshes.ts           Mesh cache, streaming queue, dirty remesh, disposal
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
  `materialIds`, `voxelOrigins`, `indices`), not scene objects.
- Strict TypeScript, ESLint + Prettier, and tests are enforced in CI
  (`.github/workflows/ci.yml`: lint → typecheck → test → build on Node 22).
