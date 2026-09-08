import { describe, expect, it } from 'vitest';
import { AIR, DIRT, GRASS, STONE } from '../src/voxel/materials';
import { VoxelVolume } from '../src/voxel/voxelVolume';

describe('VoxelVolume', () => {
  it('starts fully filled with air', () => {
    const volume = new VoxelVolume(4);
    for (let y = 0; y < 4; y++)
      for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) expect(volume.get(x, y, z)).toBe(AIR);
  });

  it('reads back written materials at distinct positions', () => {
    const volume = new VoxelVolume(8);
    volume.set(0, 0, 0, STONE);
    volume.set(7, 0, 0, GRASS);
    volume.set(0, 7, 0, DIRT);
    volume.set(0, 0, 7, GRASS);
    volume.set(7, 7, 7, STONE);
    volume.set(3, 3, 3, DIRT);
    expect(volume.get(0, 0, 0)).toBe(STONE);
    expect(volume.get(7, 0, 0)).toBe(GRASS);
    expect(volume.get(0, 7, 0)).toBe(DIRT);
    expect(volume.get(0, 0, 7)).toBe(GRASS);
    expect(volume.get(7, 7, 7)).toBe(STONE);
    expect(volume.get(3, 3, 3)).toBe(DIRT);
  });

  it('does not confuse adjacent voxels (index layout check)', () => {
    const volume = new VoxelVolume(4);
    volume.fill(AIR);
    for (let y = 0; y < 4; y++)
      for (let z = 0; z < 4; z++)
        for (let x = 0; x < 4; x++) {
          volume.fill(AIR);
          volume.set(x, y, z, STONE);
          for (let yy = 0; yy < 4; yy++)
            for (let zz = 0; zz < 4; zz++)
              for (let xx = 0; xx < 4; xx++) {
                const expected = xx === x && yy === y && zz === z ? STONE : AIR;
                expect(volume.get(xx, yy, zz)).toBe(expected);
              }
        }
  });

  it('rejects out-of-bounds writes and reports them', () => {
    const volume = new VoxelVolume(4);
    expect(volume.set(-1, 0, 0, STONE)).toBe(false);
    expect(volume.set(0, 4, 0, STONE)).toBe(false);
    expect(volume.set(0, 0, -1, STONE)).toBe(false);
    expect(volume.set(4, 4, 4, STONE)).toBe(false);
    expect(volume.getOrAir(-1, 0, 0)).toBe(AIR);
  });

  it('throws on out-of-bounds reads via get', () => {
    const volume = new VoxelVolume(4);
    expect(() => volume.get(-1, 0, 0)).toThrow(RangeError);
    expect(() => volume.get(0, 4, 0)).toThrow(RangeError);
  });

  it('treats out-of-bounds as air in getOrAir (negative side too)', () => {
    const volume = new VoxelVolume(4);
    volume.set(0, 0, 0, STONE);
    volume.set(3, 3, 3, STONE);
    expect(volume.getOrAir(-1, 0, 0)).toBe(AIR);
    expect(volume.getOrAir(0, -1, 0)).toBe(AIR);
    expect(volume.getOrAir(4, 3, 3)).toBe(AIR);
    expect(volume.getOrAir(3, 4, 3)).toBe(AIR);
    expect(volume.getOrAir(0, 0, 0)).toBe(STONE);
  });

  it('fill covers every voxel', () => {
    const volume = new VoxelVolume(3);
    volume.fill(GRASS);
    expect(volume.get(0, 0, 0)).toBe(GRASS);
    expect(volume.get(2, 2, 2)).toBe(GRASS);
    expect(volume.voxelCount).toBe(27);
  });

  it('rejects invalid sizes', () => {
    expect(() => new VoxelVolume(0)).toThrow(RangeError);
    expect(() => new VoxelVolume(-2)).toThrow(RangeError);
    expect(() => new VoxelVolume(2.5)).toThrow(RangeError);
  });
});
