# MICRO//WORLD

Browser-based voxel simulation engine and sandbox: a microvoxel world with
destructible, editable terrain, flowing water, fire, collapsing structures,
and NPCs that react to all of it. Long-term roadmap lives in
`MICRO_WORLD_DEVELOPMENT_PLAN.md`; session-by-session state lives in
`MICRO_WORLD_PROGRESS.md`.

**Current state:** Phase 1 (First Pixel) — walk around a voxel demo world.
First-person controls, voxel storage, naive face meshing, AABB collision.

## Quickstart

Requires Node 22+.

```sh
npm install
npm run dev        # dev server, print the URL it gives you
```

Controls: click to capture the mouse, **WASD** to move, **Space** to jump,
**Esc** to release the mouse. Walk off the world edge and you respawn.

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
src/main.ts                Game wiring: world → mesh → scene → loop
src/voxel/                 World state (no three.js — see ADR-002)
  coordinates.ts           World/chunk/local conversions, negative-safe
  materials.ts             Material IDs (air = 0), full registry in Phase 4
  voxelVolume.ts           Dense Uint16Array cubic volume, bounds-checked
  mesher.ts                Naive culled face mesher → plain typed arrays
  demoWorld.ts             The 16³ Phase 1 level
src/player/
  controller.ts            Pure physics: look, gravity, AABB per-axis collision
  input.ts                 DOM keyboard + pointer-lock mouse
src/render/                The only three.js code (see ADR-002)
  bootstrap.ts             Renderer, scene, camera, lights, resize, loop
  voxelGeometry.ts         Mesher output → BufferGeometry + material
tests/                     Vitest unit tests (node environment)
benchmarks/                Vitest benchmarks (`npm run bench`)
docs/                      Architecture, performance, known issues
```

## Conventions

- **World/sim code never imports three.js.** `src/render/` consumes world
  state; nothing in `src/voxel/` or `src/player/` knows a renderer exists.
  This keeps the simulation unit-testable in node and open to a future
  WebGPU renderer.
- Mesher output is plain typed arrays (`positions`, `normals`,
  `materialIds`, `indices`), not scene objects.
- Strict TypeScript, ESLint + Prettier, and tests are enforced in CI
  (`.github/workflows/ci.yml`: lint → typecheck → test → build on Node 22).
