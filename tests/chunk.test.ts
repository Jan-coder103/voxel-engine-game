import { describe, expect, it } from 'vitest';
import { Chunk } from '../src/voxel/chunk';
import { CHUNK_SIZE } from '../src/voxel/coordinates';
import { DIRT, GRASS, STONE } from '../src/voxel/materials';
import { World } from '../src/voxel/world';

describe('Chunk', () => {
  it('starts as a dirty 16³ air volume with derived key and origin', () => {
    const chunk = new Chunk({ x: -2, y: 0, z: 7 });
    expect(chunk.key).toBe('-2,0,7');
    expect(chunk.dirty).toBe(true);
    expect(chunk.volume.voxelCount).toBe(CHUNK_SIZE ** 3);
    expect(chunk.volume.get(0, 0, 0)).toBe(0);
    expect(chunk.origin).toEqual({ x: -32, y: 0, z: 112 });
  });
});

describe('World', () => {
  it('generates a chunk once and returns the same instance afterwards', () => {
    const generated: string[] = [];
    const world = new World((chunk) => {
      generated.push(chunk.key);
      chunk.volume.set(0, 0, 0, STONE);
    });
    const a = world.ensureChunk(3, 0, 4);
    const b = world.ensureChunk(3, 0, 4);
    expect(b).toBe(a);
    expect(generated).toEqual(['3,0,4']);
    expect(a.volume.get(0, 0, 0)).toBe(STONE);
  });

  it('reads unloaded chunks as air', () => {
    const world = new World();
    expect(world.getVoxel(100, 5, -100)).toBe(0);
    expect(world.setVoxel(100, 5, -100, STONE)).toBe(false);
  });

  it('routes world-space voxel writes to the owning chunk', () => {
    const world = new World();
    world.ensureChunk(0, 0, 0);
    expect(world.setVoxel(5, 3, 9, GRASS)).toBe(true);
    expect(world.getVoxel(5, 3, 9)).toBe(GRASS);
    // Local read matches: local (5,3,9) of chunk (0,0,0).
    expect(world.getChunk(0, 0, 0)?.volume.get(5, 3, 9)).toBe(GRASS);
  });

  it('handles negative world coordinates', () => {
    const world = new World();
    world.ensureChunk(-1, 0, -1);
    expect(world.setVoxel(-1, 2, -16, DIRT)).toBe(true);
    expect(world.getVoxel(-1, 2, -16)).toBe(DIRT);
    // Local (15, 2, 0) of chunk (-1, 0, -1) = world (-1, 2, -16).
    expect(world.getChunk(-1, 0, -1)?.volume.get(15, 2, 0)).toBe(DIRT);
  });

  it('marks the chunk and boundary neighbors dirty on boundary edits', () => {
    const world = new World();
    const a = world.ensureChunk(0, 0, 0);
    const b = world.ensureChunk(1, 0, 0);
    for (const chunk of [a, b]) chunk.dirty = false;

    // Interior edit: only own chunk.
    world.setVoxel(4, 0, 4, STONE);
    expect(a.dirty).toBe(true);
    expect(b.dirty).toBe(false);

    a.dirty = false;
    // Boundary edit at local x=15: neighbor +X must remesh too.
    world.setVoxel(15, 0, 4, STONE);
    expect(a.dirty).toBe(true);
    expect(b.dirty).toBe(true);
  });

  it('marks existing neighbors dirty when a new chunk is generated', () => {
    const world = new World();
    const a = world.ensureChunk(0, 0, 0);
    a.dirty = false;
    world.ensureChunk(1, 0, 0);
    expect(a.dirty).toBe(true);
  });

  it('prunes chunks beyond the radius (XZ distance, any Y)', () => {
    const world = new World();
    world.ensureChunk(0, 0, 0);
    world.ensureChunk(0, 1, 0); // same column, other layer — kept
    world.ensureChunk(2, 0, 0); // dist 2 — kept at radius 2
    world.ensureChunk(3, 0, 0); // dist 3 — pruned
    world.ensureChunk(0, 0, -3); // dist 3 — pruned

    const removed = world.pruneBeyond(0, 0, 2);
    expect(removed).toBe(2);
    expect(world.getChunk(3, 0, 0)).toBeUndefined();
    expect(world.getChunk(0, 0, -3)).toBeUndefined();
    expect(world.getChunk(0, 0, 0)).toBeDefined();
    expect(world.getChunk(0, 1, 0)).toBeDefined();
    expect(world.getChunk(2, 0, 0)).toBeDefined();
  });
});
