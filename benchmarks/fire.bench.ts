import { bench, describe } from 'vitest';
import { World } from '../src/voxel/world';
import { BLAST_HEAT, FireSim } from '../src/voxel/fire';
import { GRASS, WOOD } from '../src/voxel/materials';

/**
 * Fire baselines (Phase 10). The budget question mirrors the fluid sim:
 * does one `tick` at the game's activity budget (256 cells, 60 Hz) stay
 * well inside a 16 ms frame — including the worst case, a fire front
 * spreading across fresh fuel.
 */

/** Chunks covering the 24×24 play area, both Y layers. */
function openWorld(): World {
  const world = new World(() => {});
  for (let cy = 0; cy < 2; cy++)
    for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) world.ensureChunk(cx, cy, cz);
  return world;
}

/** 16×16 wood slab at y=1 (256 cells) with the whole area heat-ignited. */
function burningSlab(world: World, fire: FireSim): void {
  const cells: { x: number; y: number; z: number }[] = [];
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      world.setVoxel(x, 1, z, WOOD);
      cells.push({ x, y: 1, z });
    }
  }
  fire.heatCells(cells, BLAST_HEAT);
  fire.tick(256); // ignite everything, so the next tick is steady burn
}

describe('fire', () => {
  bench('tick — 256 burning slab cells, no fresh fuel (game budget)', () => {
    const world = openWorld();
    const fire = new FireSim(world);
    burningSlab(world, fire);
    fire.tick(256);
  });

  bench('tick — fire front: burning slab against a grass field', () => {
    const world = openWorld();
    const fire = new FireSim(world);
    burningSlab(world, fire);
    // Fresh tinder around two slab edges: the spread path deposits heat
    // and ignites every tick — the expensive case.
    for (let z = -4; z < 0; z++) {
      for (let x = -4; x < 20; x++) world.setVoxel(x, 1, z, GRASS);
    }
    for (let x = 16; x < 20; x++) {
      for (let z = 0; z < 16; z++) world.setVoxel(x, 1, z, GRASS);
    }
    fire.tick(256);
  });

  bench('scenario — 20×20 wood platform burns out completely', () => {
    const world = openWorld();
    const fire = new FireSim(world);
    const cells: { x: number; y: number; z: number }[] = [];
    for (let z = 0; z < 20; z++) {
      for (let x = 0; x < 20; x++) {
        world.setVoxel(x, 1, z, WOOD);
        cells.push({ x, y: 1, z });
      }
    }
    fire.heatCells(cells, BLAST_HEAT);
    fire.settle(4000, 256);
  });
});
