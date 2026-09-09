import { describe, expect, it } from 'vitest';
import { OccupancyGrid } from '../src/voxel/occupancy';
import { PackedVolume } from '../src/voxel/packedVolume';
import { VoxelVolume, type VoxelData } from '../src/voxel/voxelVolume';
import { AIR, DIRT, GRASS, SAND, STONE, WATER } from '../src/voxel/materials';
import { mulberry32 } from '../src/voxel/terrain';

describe('OccupancyGrid', () => {
  it('tracks set/clear with an exact count', () => {
    const grid = new OccupancyGrid(1000);
    expect(grid.isEmpty).toBe(true);
    expect(grid.set(0)).toBe(true);
    expect(grid.set(31)).toBe(true);
    expect(grid.set(32)).toBe(true);
    expect(grid.size).toBe(3);
    expect(grid.get(31)).toBe(true);
    expect(grid.get(63)).toBe(false);

    expect(grid.clear(31)).toBe(true);
    expect(grid.clear(31)).toBe(false); // already clear
    expect(grid.size).toBe(2);
    expect(grid.set(0)).toBe(false); // already set
    expect(grid.isEmpty).toBe(false);
  });

  it('handles the word boundaries of a 16³ grid', () => {
    const grid = new OccupancyGrid(16 ** 3);
    for (const index of [0, 4095, 2048, 63, 64]) {
      grid.set(index);
      expect(grid.get(index)).toBe(true);
    }
    expect(grid.size).toBe(5);
  });
});

describe('PackedVolume', () => {
  it('starts all-air and satisfies the shared bounds policy', () => {
    const volume = new PackedVolume(4);
    expect(volume.voxelCount).toBe(64);
    expect(volume.get(0, 0, 0)).toBe(AIR);
    expect(volume.getOrAir(-1, 0, 0)).toBe(AIR);
    expect(volume.getOrAir(4, 4, 4)).toBe(AIR);
    expect(volume.set(-1, 0, 0, STONE)).toBe(false);
    expect(volume.setByIndex(-1, STONE)).toBe(false);
    expect(volume.setByIndex(64, STONE)).toBe(false);
    expect(() => volume.get(4, 0, 0)).toThrow(RangeError);
    expect(() => volume.getByIndex(-1)).toThrow(RangeError);
  });

  it('round-trips values and keeps the dense index layout', () => {
    const packed = new PackedVolume(8);
    const dense = new VoxelVolume(8);
    const samples: [number, number, number, number][] = [
      [0, 0, 0, STONE],
      [7, 7, 7, GRASS],
      [3, 2, 5, WATER],
      [7, 0, 0, DIRT],
      [0, 7, 7, GRASS],
    ];
    for (const [x, y, z, m] of samples) {
      packed.set(x, y, z, m);
      dense.set(x, y, z, m);
    }
    for (const [x, y, z, m] of samples) {
      expect(packed.get(x, y, z)).toBe(m);
      expect(packed.getByIndex(packed.index(x, y, z))).toBe(m);
      expect(packed.index(x, y, z)).toBe(dense.index(x, y, z));
    }
    expect(packed.paletteSize).toBe(4); // stone, grass, water, dirt
  });

  it('overwrites and clears values, staying correct across reuse', () => {
    const volume = new PackedVolume(4);
    volume.set(1, 1, 1, STONE);
    volume.set(1, 1, 1, GRASS);
    expect(volume.get(1, 1, 1)).toBe(GRASS);
    volume.set(1, 1, 1, AIR);
    expect(volume.get(1, 1, 1)).toBe(AIR);
    volume.set(1, 1, 1, WATER); // reuse the cleared cell
    expect(volume.get(1, 1, 1)).toBe(WATER);
  });

  it('grows the palette across the 1→2→4→8 bit boundaries', () => {
    const volume = new PackedVolume(4);
    volume.set(0, 0, 0, STONE);
    volume.set(1, 0, 0, STONE);
    expect(volume.paletteSize).toBe(1);
    volume.set(2, 0, 0, GRASS);
    volume.set(3, 0, 0, DIRT); // 4 distinct → 2 bits
    volume.set(0, 1, 0, WATER); // 5 distinct → 4 bits
    for (const [x, y, z] of [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [0, 1, 0],
    ] as const) {
      expect(volume.get(x, y, z)).not.toBe(AIR);
    }
    expect(volume.get(0, 0, 0)).toBe(STONE);
    expect(volume.get(0, 1, 0)).toBe(WATER);
    // All previously-written values survive each repack.
    expect(volume.get(2, 0, 0)).toBe(GRASS);
    expect(volume.get(3, 0, 0)).toBe(DIRT);
  });

  it('matches a dense volume under a random op sequence', () => {
    const rng = mulberry32(20260909);
    const packed = new PackedVolume(16);
    const dense = new VoxelVolume(16);
    const materials = [AIR, GRASS, DIRT, STONE, SAND, WATER];
    for (let op = 0; op < 8000; op++) {
      const x = Math.floor(rng() * 16);
      const y = Math.floor(rng() * 16);
      const z = Math.floor(rng() * 16);
      const m = materials[Math.floor(rng() * materials.length)];
      expect(packed.set(x, y, z, m)).toBe(dense.set(x, y, z, m));
    }
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          expect(packed.get(x, y, z)).toBe(dense.get(x, y, z));
        }
      }
    }
  });

  it('uses far less memory than dense for typical chunk content', () => {
    const packed = new PackedVolume(16);
    packed.set(3, 5, 7, GRASS);
    expect(packed.memoryBytes).toBeLessThan(16 * 16 * 16 * 2); // dense bytes
  });

  it('caps at 256 distinct materials', () => {
    const volume = new PackedVolume(16);
    for (let id = 1; id <= 256; id++) volume.set(id % 16, 0, 0, id);
    expect(() => volume.set(0, 1, 0, 257)).toThrow(RangeError);
  });

  it('works as chunk storage through the World', async () => {
    const { World } = await import('../src/voxel/world');
    const world = new World((chunk) => {
      chunk.volume.fill(STONE);
      chunk.volume.set(0, 0, 0, GRASS);
    });
    world.ensureChunk(0, 0, 0);
    expect(world.getVoxel(0, 0, 0)).toBe(GRASS);
    expect(world.getVoxel(5, 5, 5)).toBe(STONE);
    expect(world.setVoxel(9, 9, 9, WATER)).toBe(true);
    expect(world.getVoxel(9, 9, 9)).toBe(WATER);
  });

  it('satisfies the VoxelData contract surface', () => {
    const volume: VoxelData = new PackedVolume(4);
    expect(volume.size).toBe(4);
    volume.fill(DIRT);
    expect(volume.get(2, 2, 2)).toBe(DIRT);
  });
});
