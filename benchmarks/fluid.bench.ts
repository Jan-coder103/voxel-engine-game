import { bench, describe } from 'vitest';
import { World } from '../src/voxel/world';
import { FluidSim } from '../src/voxel/fluid';
import { STONE, WATER } from '../src/voxel/materials';
import { DEFAULT_TERRAIN, generateChunk } from '../src/voxel/terrain';
import { worldToChunk, worldToLocal } from '../src/voxel/coordinates';

/**
 * Fluid baselines (Phase 9). The budget question: does one `tick` at the
 * game's activity budget (384 cells, 60 Hz) stay well inside a 16 ms
 * frame — including the worst case, a puddle cascading across a floor.
 */

/** Floored 22×22 basin (x,z ∈ [1,23)), rim walls, chunks (0..1)². */
function basinWorld(): World {
  const world = new World(() => {});
  for (let cy = 0; cy < 2; cy++)
    for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) world.ensureChunk(cx, cy, cz);
  for (let z = 0; z < 24; z++) {
    for (let x = 0; x < 24; x++) {
      world.setVoxel(x, 0, z, STONE);
      if (x === 0 || x === 23 || z === 0 || z === 23) world.setVoxel(x, 1, z, STONE);
    }
  }
  return world;
}

/** Seed flowing water cells (level 200) at y=1 across the basin floor. */
function seedPuddle(world: World, fluid: FluidSim, count: number): void {
  const byChunk = new Map<string, [number, number][]>();
  const cells: [number, number][] = [];
  for (let z = 1; z < 23 && cells.length < count; z++) {
    for (let x = 1; x < 23 && cells.length < count; x++) {
      world.setVoxel(x, 1, z, WATER);
      cells.push([x, z]);
      const key = `${worldToChunk(x)},0,${worldToChunk(z)}`;
      const list = byChunk.get(key) ?? [];
      list.push([worldToLocal(x) + worldToLocal(z) * 16 + 1 * 256, 200]);
      byChunk.set(key, list);
    }
  }
  fluid.loadLevels(Object.fromEntries(byChunk));
  for (const [x, z] of cells) fluid.wake(x, 1, z);
}

describe('fluid', () => {
  bench('tick — 384 active cells on a floor (game budget)', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedPuddle(world, fluid, 384);
    fluid.tick(384);
  });

  bench('tick — puddle mid-spread, 10 ticks (steady-state churn)', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedPuddle(world, fluid, 484);
    for (let i = 0; i < 10; i++) fluid.tick(384);
  });

  bench('settle — source floods a 22×22 basin (full scenario)', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    world.setVoxel(11, 2, 11, STONE); // pillar
    world.setVoxel(11, 3, 11, WATER); // source above it
    fluid.settle(2000, 384);
  });

  bench('terrain chunk generation + lake wake (streaming cost)', () => {
    const world = new World((chunk) => generateChunk(chunk, DEFAULT_TERRAIN));
    const fluid = new FluidSim(world);
    // The demo-area lake chunks (seed 1337 has water near the origin).
    world.ensureChunk(0, 0, 0);
    world.ensureChunk(0, 1, 0);
    world.ensureChunk(-1, 0, 0);
    fluid.tick(384);
  });
});
