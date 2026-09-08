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
  const query = (volume: VoxelVolume) => (x: number, y: number, z: number) =>
    volume.getOrAir(x, y, z);

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
});
