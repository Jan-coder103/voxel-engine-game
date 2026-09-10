import { bench, describe } from 'vitest';
import { World } from '../src/voxel/world';
import { STONE } from '../src/voxel/materials';
import { explode } from '../src/voxel/damage';
import { analyzeStructure, structureRegionFor } from '../src/voxel/structure';

/**
 * Destruction baselines (Phase 8). The gate budget: an explosion plus its
 * structural analysis must fit comfortably inside a 16 ms frame at house
 * scale. (The support-check benches now run the Phase 11 analysis over
 * the same regions so the old baselines stay directly comparable; the
 * Phase 11 scenarios live in structure.bench.ts.)
 */

function stoneWorld(): World {
  const world = new World((chunk) => chunk.volume.fill(STONE));
  for (let cy = 0; cy < 2; cy++) {
    for (let cz = 0; cz < 3; cz++) {
      for (let cx = 0; cx < 3; cx++) world.ensureChunk(cx, cy, cz);
    }
  }
  return world;
}

describe('destruction', () => {
  bench('explode r=6 in solid stone', () => {
    const world = stoneWorld();
    explode({ x: 24.5, y: 24.5, z: 24.5 }, 6, (x, y, z) => world.getVoxel(x, y, z), {
      seed: 1,
      maxDebris: 64,
    });
  });

  bench('explode r=10 in solid stone (creator max)', () => {
    const world = stoneWorld();
    explode({ x: 24.5, y: 24.5, z: 24.5 }, 10, (x, y, z) => world.getVoxel(x, y, z), {
      seed: 1,
      maxDebris: 64,
    });
  });

  bench('support analysis — house-scale region (25×37×25)', () => {
    const world = stoneWorld();
    // Carve a pavilion: 4 walls with a roof, then check a region around it.
    for (let x = 16; x <= 32; x++) {
      for (let y = 25; y <= 28; y++) {
        world.setVoxel(x, y, 20, STONE);
        world.setVoxel(x, y, 36, STONE);
      }
    }
    const region = structureRegionFor({
      min: { x: 24, y: 24, z: 28 },
      max: { x: 24, y: 24, z: 28 },
    });
    analyzeStructure(world, region);
  });

  bench('support analysis — supported terrain region', () => {
    const world = stoneWorld();
    const region = structureRegionFor({
      min: { x: 20, y: 20, z: 20 },
      max: { x: 28, y: 28, z: 28 },
    });
    analyzeStructure(world, region);
  });
});
