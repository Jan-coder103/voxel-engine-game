import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../src/voxel/coordinates';
import { Chunk } from '../src/voxel/chunk';
import { AIR, DIRT, GRASS, SAND, STONE, WATER } from '../src/voxel/materials';
import {
  DEFAULT_TERRAIN,
  type TerrainParams,
  findSpawn,
  generateChunk,
  heightAt,
  isDry,
  mulberry32,
} from '../src/voxel/terrain';

function chunkKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function generateAt(cx: number, cy: number, cz: number, params: TerrainParams): Chunk {
  const chunk = new Chunk({ x: cx, y: cy, z: cz });
  generateChunk(chunk, params);
  return chunk;
}

describe('seeded RNG', () => {
  it('produces identical sequences for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('heightAt', () => {
  it('is deterministic and within world bounds', () => {
    for (const [x, z] of [
      [0, 0],
      [123, -456],
      [-789, 12],
      [1000, 1000],
    ]) {
      const h1 = heightAt(x, z, DEFAULT_TERRAIN);
      const h2 = heightAt(x, z, DEFAULT_TERRAIN);
      expect(h1).toBe(h2);
      expect(h1).toBeGreaterThanOrEqual(2);
      expect(h1).toBeLessThanOrEqual(WORLD_HEIGHT - 2);
    }
  });

  it('varies across the world (hills and mountains exist)', () => {
    const heights = new Set<number>();
    for (let i = 0; i < 400; i++) {
      heights.add(heightAt(i * 7 - 1400, i * 13 - 2600, DEFAULT_TERRAIN));
    }
    expect(heights.size).toBeGreaterThan(8);
  });

  it('depends on the seed', () => {
    const a = heightAt(50, 50, { ...DEFAULT_TERRAIN, seed: 1 });
    const b = heightAt(50, 50, { ...DEFAULT_TERRAIN, seed: 2 });
    expect(a).not.toBe(b);
  });
});

describe('generateChunk determinism', () => {
  it('generates identical bytes for the same chunk and seed', () => {
    const a = generateAt(2, 0, -1, DEFAULT_TERRAIN);
    const b = generateAt(2, 0, -1, DEFAULT_TERRAIN);
    expect(b.volume.voxelCount).toBe(a.volume.voxelCount);
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        for (let k = 0; k < 16; k++) {
          expect(b.volume.get(i, j, k)).toBe(a.volume.get(i, j, k));
        }
      }
    }
  });

  it('is independent of generation order (streaming-safe)', () => {
    // Generate the target chunk alone...
    const alone = generateAt(3, 1, 3, DEFAULT_TERRAIN);
    // ...and again after generating all its neighbors first.
    const afterNeighbors = generateAt(3, 1, 3, DEFAULT_TERRAIN);
    const neighborKeys = [
      chunkKey(2, 1, 3),
      chunkKey(4, 1, 3),
      chunkKey(3, 0, 3),
      chunkKey(3, 1, 2),
      chunkKey(3, 1, 4),
    ];
    for (const key of neighborKeys) {
      const [cx, cy, cz] = key.split(',').map(Number);
      generateAt(cx, cy, cz, DEFAULT_TERRAIN);
    }
    const regenerated = generateAt(3, 1, 3, DEFAULT_TERRAIN);
    for (let i = 0; i < 16; i++) {
      expect(regenerated.volume.get(i, 8, i)).toBe(alone.volume.get(i, 8, i));
      expect(regenerated.volume.get(i, 0, i)).toBe(afterNeighbors.volume.get(i, 0, i));
    }
  });

  it('produces different worlds for different seeds', () => {
    const a = generateAt(0, 0, 0, { ...DEFAULT_TERRAIN, seed: 1 });
    const b = generateAt(0, 0, 0, { ...DEFAULT_TERRAIN, seed: 2 });
    const differs = Array.from(
      { length: CHUNK_SIZE },
      (_, i) => a.volume.get(i, 12, i) !== b.volume.get(i, 12, i),
    ).some(Boolean);
    expect(differs).toBe(true);
  });
});

describe('terrain content rules', () => {
  const chunk = generateAt(0, 0, 0, DEFAULT_TERRAIN);
  const upper = generateAt(0, 1, 0, DEFAULT_TERRAIN);

  function voxel(wx: number, wy: number, wz: number): number {
    if (wy < 16) return chunk.volume.get(wx, wy, wz);
    return upper.volume.get(wx, wy - 16, wz);
  }

  it('has bedrock stone at y=0 everywhere', () => {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        expect(voxel(x, 0, z)).toBe(STONE);
      }
    }
  });

  it('follows the layer rules (top grass/sand, dirt band, stone core)', () => {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const h = heightAt(x, z, DEFAULT_TERRAIN);
        const beach = h <= DEFAULT_TERRAIN.seaLevel; // sand at/under waterline
        expect(voxel(x, h - 1, z)).toBe(beach ? SAND : GRASS);
        if (h >= 4) {
          expect(voxel(x, h - 2, z)).toBe(beach ? SAND : DIRT);
          expect(voxel(x, h - 3, z)).toBe(beach ? SAND : DIRT);
          expect(voxel(x, h - 4, z)).toBe(STONE);
        }
        // Nothing solid above the surface except water below sea level.
        const above = voxel(x, h + 2, z);
        expect(above === AIR || above === WATER).toBe(true);
      }
    }
  });

  it('fills water exactly up to sea level where terrain dips below it', () => {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const h = heightAt(x, z, DEFAULT_TERRAIN);
        if (h < DEFAULT_TERRAIN.seaLevel) {
          expect(voxel(x, h, z)).toBe(WATER);
          expect(voxel(x, DEFAULT_TERRAIN.seaLevel - 1, z)).toBe(WATER);
          expect(voxel(x, DEFAULT_TERRAIN.seaLevel, z)).toBe(AIR);
          // Underwater columns are sand-capped.
          expect(voxel(x, h - 1, z)).toBe(SAND);
        } else {
          expect(voxel(x, h, z)).toBe(AIR);
        }
      }
    }
  });

  it('contains both water and dry land across the world', () => {
    let hasWater = false;
    let hasLand = false;
    for (let z = -240; z <= 240; z += 4) {
      for (let x = -240; x <= 240; x += 4) {
        const h = heightAt(x, z, DEFAULT_TERRAIN);
        if (h < DEFAULT_TERRAIN.seaLevel) hasWater = true;
        if (isDry(h, DEFAULT_TERRAIN)) hasLand = true;
      }
    }
    expect(hasLand).toBe(true);
    expect(hasWater).toBe(true);
  });
});

describe('findSpawn', () => {
  it('returns a dry, above-water spawn with feet on the surface', () => {
    const spawn = findSpawn(DEFAULT_TERRAIN);
    const h = heightAt(Math.floor(spawn.x), Math.floor(spawn.z), DEFAULT_TERRAIN);
    expect(isDry(h, DEFAULT_TERRAIN)).toBe(true);
    expect(spawn.y).toBe(h);
  });

  it('is deterministic', () => {
    expect(findSpawn(DEFAULT_TERRAIN)).toEqual(findSpawn(DEFAULT_TERRAIN));
  });
});
