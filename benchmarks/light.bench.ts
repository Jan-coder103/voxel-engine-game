import { bench, describe } from 'vitest';
import { World } from '../src/voxel/world';
import { LightField } from '../src/voxel/light';
import { meshVolumeGreedy } from '../src/voxel/greedyMesher';
import { VoxelVolume } from '../src/voxel/voxelVolume';
import { generateChunk, DEFAULT_TERRAIN } from '../src/voxel/terrain';
import { applyTown } from '../src/worldgen/town';
import { CHUNK_SIZE } from '../src/voxel/coordinates';
import { AIR, STONE } from '../src/voxel/materials';

/**
 * Light field baselines (Phase 17). The per-edit incremental update is
 * the number that shares the frame with everything else (user-paced
 * edits remesh 1–2 chunks already), chunk init rides chunk streaming,
 * and the lamp-fill case is the town boot (≈500 street lamps). The
 * mesher delta shows what the light query + AO sampling add to the
 * 2.5 ms terrain-chunk mesh. Recorded on the 2–3 core dev VM.
 */

/** Town-seeded world with every chunk around the origin materialized. */
function townWorld(radius: number): { world: World; light: LightField } {
  const terrain = { ...DEFAULT_TERRAIN, seed: 24680 };
  const world = new World((chunk) => {
    generateChunk(chunk, terrain);
    applyTown(chunk, terrain);
  });
  const light = new LightField(world);
  for (let cz = -radius; cz <= radius; cz++)
    for (let cx = -radius; cx <= radius; cx++)
      for (let cy = 0; cy < 2; cy++) world.ensureChunk(cx, cy, cz);
  return { world, light };
}

function drain(light: LightField): void {
  for (let i = 0; i < 2000 && light.pendingCount > 0; i++) light.tick(4096);
}

describe('light field', () => {
  bench('chunk init — town chunk (columns + boundary + lit pass)', () => {
    const terrain = { ...DEFAULT_TERRAIN, seed: 24680 };
    const world = new World((chunk) => {
      generateChunk(chunk, terrain);
      applyTown(chunk, terrain);
    });
    const light = new LightField(world);
    // One fresh chunk per iteration, 16 chunks from town center.
    world.ensureChunk(2, 0, 2);
    drain(light);
  });

  bench('incremental update — place + remove a wall block in a lit town street', () => {
    const { world, light } = townWorld(1);
    drain(light);
    world.setVoxel(8, 12, 8, STONE); // shades the street: removal BFS + column demote
    drain(light);
    world.setVoxel(8, 12, 8, AIR); // re-opens: column refill + lateral re-add
    drain(light);
  });

  bench('lamp fill — 100 sources in open air (initial sync)', () => {
    const { light } = townWorld(1);
    drain(light);
    let placed = 0;
    for (let z = -32; z < 32 && placed < 100; z += 8) {
      for (let x = -32; x < 32 && placed < 100; x += 8) {
        // Open-air sources 3 above town ground level.
        light.setSource(x, 14, z, 15);
        placed++;
      }
    }
    drain(light);
  });
});

describe('mesher × light', () => {
  /** Real generated terrain chunk (the mesher bench's standard subject). */
  function terrainVolume(): { volume: VoxelVolume; world: World } {
    const terrain = { ...DEFAULT_TERRAIN, seed: 1337 };
    const world = new World((chunk) => generateChunk(chunk, terrain));
    world.ensureChunk(0, 0, 0);
    const src = world.getChunk(0, 0, 0)!.volume;
    const volume = new VoxelVolume(CHUNK_SIZE);
    for (let y = 0; y < CHUNK_SIZE; y++)
      for (let z = 0; z < CHUNK_SIZE; z++)
        for (let x = 0; x < CHUNK_SIZE; x++) volume.set(x, y, z, src.get(x, y, z));
    return { volume, world };
  }

  bench('terrain chunk — greedy, no light query (Phase 6 baseline)', () => {
    const { volume, world } = terrainVolume();
    meshVolumeGreedy(volume, (x, y, z) => world.getVoxel(x, y, z));
  });

  bench('terrain chunk — greedy, light query + vertex AO (Phase 17)', () => {
    const { volume, world } = terrainVolume();
    meshVolumeGreedy(
      volume,
      (x, y, z) => world.getVoxel(x, y, z),
      undefined,
      (_x, y, _z) => (y > 8 ? 0xff : 0x80),
    );
  });
});
