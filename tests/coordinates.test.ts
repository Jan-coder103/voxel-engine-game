import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  chunkCoordToWorld,
  chunkToWorld,
  worldToChunk,
  worldToChunkCoord,
  worldToLocal,
  worldToLocalCoord,
} from '../src/voxel/coordinates';

describe('scalar conversions', () => {
  it('maps positive world coordinates to chunks', () => {
    expect(worldToChunk(0)).toBe(0);
    expect(worldToChunk(5)).toBe(0);
    expect(worldToChunk(CHUNK_SIZE - 1)).toBe(0);
    expect(worldToChunk(CHUNK_SIZE)).toBe(1);
    expect(worldToChunk(3 * CHUNK_SIZE + 7)).toBe(3);
  });

  it('maps negative world coordinates to negative chunks (floor division)', () => {
    expect(worldToChunk(-1)).toBe(-1);
    expect(worldToChunk(-CHUNK_SIZE)).toBe(-1);
    expect(worldToChunk(-CHUNK_SIZE - 1)).toBe(-2);
    expect(worldToChunk(-5 * CHUNK_SIZE)).toBe(-5);
  });

  it('keeps local coordinates in [0, CHUNK_SIZE)', () => {
    expect(worldToLocal(0)).toBe(0);
    expect(worldToLocal(15)).toBe(15);
    expect(worldToLocal(16)).toBe(0);
    expect(worldToLocal(-1)).toBe(15);
    expect(worldToLocal(-16)).toBe(0);
    expect(worldToLocal(-17)).toBe(15);
  });

  it('round-trips chunk+local back to world across signs and boundaries', () => {
    const samples = [0, 1, 15, 16, 17, 31, 32, 255, 1000, -1, -15, -16, -17, -32, -255, -1000];
    for (const world of samples) {
      expect(chunkToWorld(worldToChunk(world), worldToLocal(world))).toBe(world);
    }
  });

  it('handles exact chunk boundaries', () => {
    for (const boundary of [-32, -16, 0, 16, 32]) {
      expect(worldToLocal(boundary)).toBe(0);
      expect(worldToChunk(boundary)).toBe(boundary / CHUNK_SIZE);
    }
  });

  it('handles large coordinates without precision loss', () => {
    const big = 2 ** 30 + 5;
    expect(chunkToWorld(worldToChunk(big), worldToLocal(big))).toBe(big);
    const bigNegative = -(2 ** 30) - 5;
    expect(chunkToWorld(worldToChunk(bigNegative), worldToLocal(bigNegative))).toBe(bigNegative);
  });
});

describe('vector conversions', () => {
  it('converts world → chunk coordinate per axis', () => {
    expect(worldToChunkCoord({ x: -1, y: 0, z: 17 })).toEqual({ x: -1, y: 0, z: 1 });
  });

  it('converts world → local coordinate per axis', () => {
    expect(worldToLocalCoord({ x: -1, y: 0, z: 17 })).toEqual({ x: 15, y: 0, z: 1 });
  });

  it('round-trips world → chunk+local → world', () => {
    const worlds = [
      { x: 0, y: 0, z: 0 },
      { x: -1, y: -16, z: -17 },
      { x: 1234, y: -5678, z: 910 },
      { x: 15, y: 16, z: 32 },
    ];
    for (const world of worlds) {
      const chunk = worldToChunkCoord(world);
      const local = worldToLocalCoord(world);
      expect(chunkCoordToWorld(chunk, local)).toEqual(world);
    }
  });
});
