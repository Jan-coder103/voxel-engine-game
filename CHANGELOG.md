# Changelog

All notable changes to MICRO//WORLD are documented here.
Format loosely follows Keep a Changelog; versioning is informal until
the first external release.

## [0.2.0] — 2026-09-08 — Phases 2–4 (Chunks, Terrain, Materials)

### Added

- Chunk system: `Chunk` (16³ + dirty flag), `World` chunk map with
  world-space get/set, boundary-edit dirty propagation to neighbor
  chunks, radius-based data pruning, lifecycle (ensure/unload).
- Streaming: pure desired-set/priority/unload math plus the render-side
  `ChunkMeshManager` — nearest-first mesh queue with per-frame budget,
  camera-direction tie-break, dirty remeshing, geometry disposal.
- Mesher v2: cross-chunk neighbor queries, opaque/water pass split
  (underwater terrain visible through water), per-vertex voxel origins.
- Deterministic terrain: mulberry32 RNG, integer-hash value noise + fBm,
  hill/mountain height function, sea level, layered materials (bedrock,
  stone, dirt, grass, sand beaches, water), dry-land spawn scan.
- Material registry: 7 materials with metadata (color, opaque, solid),
  id/name lookup, versioned JSON serialization with validation.
- Voxel shader: palette texture indexed by materialId, per-voxel
  brightness variation, in-shader lighting + fog, transparent water.
- 44 new tests (82 total) and terrain benchmarks.

### Fixed

- Chunk meshes were never positioned in world space (all chunks stacked
  at the origin — masked by Phase 2's flat world, exposed by terrain).

## [0.1.0] — 2026-09-08 — Phase 0 + Phase 1 (First Pixel)

### Added

- Tooling: TypeScript (strict), Vite, Vitest (node env), ESLint flat
  config, Prettier, CI workflow (lint → typecheck → test → build,
  Node 22).
- World state: `VoxelVolume` dense cubic storage (`Uint16Array`,
  bounds-checked), negative-safe world/chunk/local coordinate
  conversions, material IDs (air = 0), demo world generator.
- Meshing: naive culled face mesher producing plain typed arrays;
  BufferGeometry builder with per-vertex colors + `materialId`
  attribute; renderer bootstrap (scene, camera, lights, resize, loop).
- Player: pointer-lock mouse look, WASD + jump, gravity, per-axis AABB
  voxel collision at fixed 60 Hz timestep, void respawn.
- Tests: 38 unit tests across coordinates, storage, mesher (incl.
  winding verification), controller. Mesher benchmarks with recorded
  baselines in `docs/performance.md`.
- Docs: README, architecture, performance, known issues, progress
  tracker.
