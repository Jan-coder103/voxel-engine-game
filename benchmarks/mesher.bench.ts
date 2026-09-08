import { bench, describe } from 'vitest';
import { meshVolume } from '../src/voxel/mesher';
import { STONE } from '../src/voxel/materials';
import { VoxelVolume } from '../src/voxel/voxelVolume';

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

describe('meshVolume', () => {
  bench('solid 16³', () => {
    meshVolume(solidVolume(16));
  });

  bench('checker 16³ (worst case)', () => {
    meshVolume(noisyVolume(16));
  });

  bench('solid 32³', () => {
    meshVolume(solidVolume(32));
  });

  bench('checker 32³ (worst case)', () => {
    meshVolume(noisyVolume(32));
  });
});
