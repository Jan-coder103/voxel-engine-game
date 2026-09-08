import { describe, expect, it } from 'vitest';
import {
  chunkPriority,
  desiredChunkCoords,
  playerChunk,
  shouldUnloadData,
  shouldUnloadMesh,
  streamingParams,
} from '../src/voxel/streaming';

const params = streamingParams(2); // radius 2, world height from constants

describe('desiredChunkCoords', () => {
  it('returns a circular XZ footprint with every Y layer', () => {
    const desired = desiredChunkCoords(10, -5, params);
    // Circle of radius 2: 13 columns × 2 layers.
    expect(desired.length).toBe(13 * params.worldHeightChunks);

    const coords = desired.map((d) => `${d.coord.x},${d.coord.y},${d.coord.z}`);
    expect(coords).toContain('10,0,-5');
    expect(coords).toContain('10,1,-5');
    expect(coords).toContain('12,0,-5'); // edge of radius
    expect(coords).not.toContain('12,0,-4'); // distSq 8 > 4 — outside
    expect(coords).not.toContain('13,0,-5');
  });

  it('centers the footprint on the player chunk', () => {
    const desired = desiredChunkCoords(-40, 40, params);
    for (const d of desired) {
      const dx = d.coord.x + 40;
      const dz = d.coord.z - 40;
      expect(dx * dx + dz * dz).toBeLessThanOrEqual(4);
    }
  });
});

describe('playerChunk', () => {
  it('converts position to chunk coordinates with clamped Y', () => {
    expect(playerChunk({ x: 33, y: 20, z: -1 })).toEqual({ x: 2, y: 1, z: -1 });
    expect(playerChunk({ x: -0.5, y: -50, z: 15.9 })).toEqual({ x: -1, y: 0, z: 0 });
  });
});

describe('chunkPriority', () => {
  const camDir = { x: 1, z: 0 }; // facing +X

  it('prefers nearer chunks', () => {
    const near = chunkPriority({ x: 1, y: 0, z: 0 }, 0, 0, camDir);
    const far = chunkPriority({ x: 2, y: 0, z: 0 }, 0, 0, camDir);
    expect(near).toBeLessThan(far);
  });

  it('breaks distance ties toward the camera direction', () => {
    const ahead = chunkPriority({ x: 2, y: 0, z: 0 }, 0, 0, camDir); // +X, in view
    const behind = chunkPriority({ x: -2, y: 0, z: 0 }, 0, 0, camDir); // -X, behind
    const beside = chunkPriority({ x: 0, y: 0, z: 2 }, 0, 0, camDir); // +Z, sideways
    expect(ahead).toBeLessThan(beside);
    expect(beside).toBeLessThan(behind);
  });
});

describe('unload predicates', () => {
  it('keeps meshes one ring and data two rings beyond the render radius', () => {
    const inside = { x: 2, y: 0, z: 0 };
    const meshRing = { x: 3, y: 0, z: 0 }; // radius+1
    const dataRing = { x: 4, y: 0, z: 0 }; // radius+2
    const outside = { x: 5, y: 0, z: 0 };

    expect(shouldUnloadMesh(inside, 0, 0, params)).toBe(false);
    expect(shouldUnloadMesh(meshRing, 0, 0, params)).toBe(false);
    expect(shouldUnloadMesh(dataRing, 0, 0, params)).toBe(true);

    expect(shouldUnloadData(meshRing, 0, 0, params)).toBe(false);
    expect(shouldUnloadData(dataRing, 0, 0, params)).toBe(false);
    expect(shouldUnloadData(outside, 0, 0, params)).toBe(true);
  });
});
