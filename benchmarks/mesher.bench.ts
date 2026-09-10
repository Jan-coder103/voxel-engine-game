import { bench, describe } from 'vitest';
import { meshVolume } from '../src/voxel/mesher';
import { meshVolumeGreedy } from '../src/voxel/greedyMesher';
import { STONE, GRASS, SAND, WATER } from '../src/voxel/materials';
import { VoxelVolume } from '../src/voxel/voxelVolume';
import { Chunk } from '../src/voxel/chunk';
import { generateChunk, DEFAULT_TERRAIN } from '../src/voxel/terrain';

/** Checkerboard-ish solid/air pattern: worst case for face culling. */
function noisyVolume(size: number): VoxelVolume {
  const volume = new VoxelVolume(size);
  for (let y = 0; y < size; y++)
    for (let z = 0; z < size; z++)
      for (let x = 0; x < size; x++) {
        if ((x + y + z) % 2 === 0) volume.set(x, y, z, STONE);
      }
  return volume;
}

function solidVolume(size: number): VoxelVolume {
  const volume = new VoxelVolume(size);
  volume.fill(STONE);
  return volume;
}

/** Layered terrain-like volume: merging-friendly runs of one material. */
function layeredVolume(size: number): VoxelVolume {
  const volume = new VoxelVolume(size);
  for (let y = 0; y < size; y++)
    for (let z = 0; z < size; z++)
      for (let x = 0; x < size; x++) {
        volume.set(
          x,
          y,
          z,
          y < 2 ? STONE : y < 5 ? ((x + z) % 8 === 0 ? SAND : GRASS) : y < 6 ? WATER : STONE,
        );
      }
  return volume;
}

const query = (volume: VoxelVolume) => (x: number, y: number, z: number) =>
  volume.getOrAir(x, y, z);

const terrainChunk = (() => {
  const chunk = new Chunk({ x: 0, y: 0, z: 0 });
  generateChunk(chunk, DEFAULT_TERRAIN);
  return chunk;
})();

describe('meshVolume (naive baseline)', () => {
  bench('solid 16³', () => {
    const v = solidVolume(16);
    meshVolume(v, query(v));
  });

  bench('checker 16³ (worst case)', () => {
    const v = noisyVolume(16);
    meshVolume(v, query(v));
  });

  bench('solid 32³', () => {
    const v = solidVolume(32);
    meshVolume(v, query(v));
  });

  bench('checker 32³ (worst case)', () => {
    const v = noisyVolume(32);
    meshVolume(v, query(v));
  });

  bench('terrain chunk 16³', () => {
    meshVolume(terrainChunk.volume, (x, y, z) => terrainChunk.volume.getOrAir(x, y, z));
  });
});

describe('meshVolumeGreedy (production)', () => {
  bench('solid 16³', () => {
    const v = solidVolume(16);
    meshVolumeGreedy(v, query(v));
  });

  bench('checker 16³ (worst case)', () => {
    const v = noisyVolume(16);
    meshVolumeGreedy(v, query(v));
  });

  bench('layered 16³', () => {
    const v = layeredVolume(16);
    meshVolumeGreedy(v, query(v));
  });

  bench('solid 32³', () => {
    const v = solidVolume(32);
    meshVolumeGreedy(v, query(v));
  });

  bench('checker 32³ (worst case)', () => {
    const v = noisyVolume(32);
    meshVolumeGreedy(v, query(v));
  });

  bench('terrain chunk 16³', () => {
    meshVolumeGreedy(terrainChunk.volume, (x, y, z) => terrainChunk.volume.getOrAir(x, y, z));
  });
});
