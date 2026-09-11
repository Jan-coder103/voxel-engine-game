import { bench, describe } from 'vitest';
import { WORLD_HEIGHT_CHUNKS } from '../src/voxel/coordinates';
import { AIR, COPPER, PIPE } from '../src/voxel/materials';
import { DEFAULT_TERRAIN, generateChunk, heightAt, type TerrainParams } from '../src/voxel/terrain';
import { World } from '../src/voxel/world';
import { FluidSim } from '../src/voxel/fluid';
import { PowerSim } from '../src/voxel/power';
import { PlumbingSim, POUR_PERIOD } from '../src/voxel/plumbing';
import { applyTown } from '../src/worldgen/town';
import { pipelineRoute } from '../src/worldgen/utilities';
import { Chunk } from '../src/voxel/chunk';

/**
 * Utilities benchmarks (Phase 15). One towned world is built up front
 * (the generators are measured in town.bench.ts); the benches here
 * toggle a cable/pipe cell each iteration — every flip queues a full
 * town-grid component rebuild, so the numbers are per-rebuild costs.
 */

const TERRAIN: TerrainParams = { ...DEFAULT_TERRAIN, seed: 1337 };

const world = new World((chunk) => {
  generateChunk(chunk, TERRAIN);
  applyTown(chunk, TERRAIN);
});
for (let cz = -7; cz < 7; cz++) {
  for (let cx = -7; cx < 7; cx++) {
    for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) world.ensureChunk(cx, cy, cz);
  }
}
const fluid = new FluidSim(world);
const power = new PowerSim(world);
const plumbing = new PlumbingSim(world, fluid);
power.settle();
plumbing.settle();

const ROUTE = pipelineRoute(TERRAIN)!;
// A buried-cable cell near the generator's line (a cut here rebuilds the
// whole ~5.4k-cell town grid).
const CABLE = { x: 4, y: heightAt(4, 10, TERRAIN) - 2, z: 10 };
if (world.getVoxel(CABLE.x, CABLE.y, CABLE.z) !== COPPER) {
  throw new Error(`cable fixture wrong: ${world.getVoxel(CABLE.x, CABLE.y, CABLE.z)}`);
}
// A mid-route main cell for the plumbing rebuild.
const MAIN_MID = Math.round((ROUTE.pumpX + ROUTE.endX) / 2);
let mainY = -1;
for (let y = 0; y < 32; y++) {
  if (world.getVoxel(MAIN_MID, y, ROUTE.z) === PIPE) {
    mainY = y;
    break;
  }
}
if (mainY < 0) throw new Error('main fixture wrong');

describe('power grid (Phase 15)', () => {
  bench('GATE: full town-grid rebuild after a cable flip (~5.4k cells)', () => {
    // One iteration = cut + mend: two identical full-component rebuilds,
    // state restored for the next pass.
    world.setVoxel(CABLE.x, CABLE.y, CABLE.z, AIR);
    power.tick(1);
    world.setVoxel(CABLE.x, CABLE.y, CABLE.z, COPPER);
    power.tick(1);
  });

  bench('chunk scan + settle on a freshly generated town chunk', () => {
    // Generation dominates this number (see town.bench.ts); the scan
    // itself queues at most one rebuild seed per chunk.
    const chunk = new Chunk({ x: 10, y: 0, z: 0 });
    generateChunk(chunk, TERRAIN);
    applyTown(chunk, TERRAIN);
    power.settle(1);
  });
});

describe('plumbing (Phase 15)', () => {
  bench('GATE: main rebuild after a pipe flip (~100 cells)', () => {
    // One iteration = burst + mend: two identical component rebuilds.
    world.setVoxel(MAIN_MID, mainY, ROUTE.z, AIR);
    plumbing.tick(1);
    world.setVoxel(MAIN_MID, mainY, ROUTE.z, PIPE);
    plumbing.tick(1);
  });

  bench('pour pass cadence (8 ticks incl. one pass)', () => {
    for (let i = 0; i < POUR_PERIOD; i++) plumbing.tick(1);
  });
});

describe('generation overhead (Phase 15)', () => {
  bench('pipelineRoute scan (early exit, lane chunk gate)', () => {
    const route = pipelineRoute(TERRAIN);
    if (!route) throw new Error('route vanished');
  });

  bench('applyTown with utilities: town-center chunk', () => {
    const chunk = new Chunk({ x: 0, y: 0, z: 0 });
    generateChunk(chunk, TERRAIN);
    applyTown(chunk, TERRAIN);
  });
});
