import { bench, describe } from 'vitest';
import { VoxelVolume } from '../src/voxel/voxelVolume';
import { PackedVolume } from '../src/voxel/packedVolume';
import { GRASS, STONE, WATER } from '../src/voxel/materials';
import { mulberry32 } from '../src/voxel/terrain';

/**
 * Dense (Uint16Array) vs palette-compressed storage: sequential fill,
 * random access, and meshing-shaped neighbor sweeps. Fills favor the
 * packed representation (few materials, long runs); the random-op mix
 * is where its repack/palette costs show.
 */

function terrainLike<T extends VoxelVolume | PackedVolume>(volume: T): T {
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const h = 8 + ((x * 7 + z * 13) % 5);
      for (let y = 0; y < 12; y++) {
        volume.set(x, y, z, y === 0 ? STONE : y < h - 1 ? STONE : y === h - 1 ? GRASS : WATER);
      }
    }
  return volume;
}

describe('storage fill (terrain-like 16³)', () => {
  bench('dense', () => {
    terrainLike(new VoxelVolume(16));
  });

  bench('packed', () => {
    terrainLike(new PackedVolume(16));
  });
});

describe('storage sequential read (whole 16³ volume)', () => {
  const dense = terrainLike(new VoxelVolume(16));
  const packed = terrainLike(new PackedVolume(16));

  bench('dense getOrAir ×4096', () => {
    let sum = 0;
    for (let i = 0; i < 4096; i++) sum += dense.getOrAir(i % 16, (i / 16) % 16, (i / 256) % 16);
    if (sum < 0) throw new Error('unreachable');
  });

  bench('packed getOrAir ×4096', () => {
    let sum = 0;
    for (let i = 0; i < 4096; i++) sum += packed.getOrAir(i % 16, (i / 16) % 16, (i / 256) % 16);
    if (sum < 0) throw new Error('unreachable');
  });
});

describe('storage random mixed ops (60% read / 40% write, 6 materials)', () => {
  const rng = mulberry32(42);
  const coords = Array.from({ length: 4096 }, () => [
    Math.floor(rng() * 16),
    Math.floor(rng() * 16),
    Math.floor(rng() * 16),
  ]);
  const mats = [0, GRASS, STONE, WATER, 0, STONE];

  bench('dense ×4096', () => {
    const volume = new VoxelVolume(16);
    for (const [x, y, z] of coords) volume.set(x, y, z, mats[(x + y + z) % mats.length]);
  });

  bench('packed ×4096', () => {
    const volume = new PackedVolume(16);
    for (const [x, y, z] of coords) volume.set(x, y, z, mats[(x + y + z) % mats.length]);
  });
});
