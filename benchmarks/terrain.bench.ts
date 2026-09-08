import { bench, describe } from 'vitest';
import { CHUNK_SIZE } from '../src/voxel/coordinates';
import { Chunk } from '../src/voxel/chunk';
import { DEFAULT_TERRAIN, generateChunk, heightAt } from '../src/voxel/terrain';

describe('terrain generation', () => {
  bench('generateChunk (16×16 columns)', () => {
    const chunk = new Chunk({ x: 0, y: 0, z: 0 });
    generateChunk(chunk, DEFAULT_TERRAIN);
  });

  bench('heightAt 256 columns (one chunk footprint)', () => {
    let sum = 0;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        sum += heightAt(x, z, DEFAULT_TERRAIN);
      }
    }
    if (sum < 0) throw new Error('unreachable');
  });
});
