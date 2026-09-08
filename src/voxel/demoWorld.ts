import { CHUNK_SIZE } from './coordinates';
import { DIRT, GRASS, STONE, WOOD } from './materials';
import { VoxelVolume } from './voxelVolume';

/**
 * Phase 1 demo world: a single chunk-sized volume (16³) containing a
 * ground slab, a central cube to walk around, and a step pyramid so the
 * player can climb via jumping. Coordinates outside the volume are air;
 * the game layer respawns the player if they walk off the edge.
 */
export function createDemoWorld(): VoxelVolume {
  const world = new VoxelVolume(CHUNK_SIZE);
  const s = world.size;

  // Ground slab: 3 layers, grass on top.
  for (let y = 0; y < 3; y++) {
    for (let z = 0; z < s; z++) {
      for (let x = 0; x < s; x++) {
        world.set(x, y, z, y === 2 ? GRASS : DIRT);
      }
    }
  }

  // Central stone cube (5³) sitting on the slab — the cube to walk around.
  for (let y = 3; y < 8; y++) {
    for (let z = 6; z < 11; z++) {
      for (let x = 6; x < 11; x++) {
        world.set(x, y, z, STONE);
      }
    }
  }

  // Step pyramid against the cube's -X face: 1, 2, 3 voxels high,
  // each step jumpable so the player can reach the cube's top.
  for (let step = 0; step < 3; step++) {
    const height = step + 1;
    const x = 5 - step;
    for (let y = 3; y < 3 + height; y++) {
      for (let z = 7; z < 10; z++) {
        world.set(x, y, z, WOOD);
      }
    }
  }

  return world;
}

/** Default player spawn: center of the slab, feet on the grass layer. */
export function demoWorldSpawn(): { x: number; y: number; z: number } {
  return { x: CHUNK_SIZE / 2 + 0.5, y: 3, z: 2.5 };
}
