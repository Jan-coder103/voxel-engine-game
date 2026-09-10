import { describe, expect, it } from 'vitest';
import { DEFAULT_LOD_PARAMS, LOD1_FACTOR, desiredLod, downsampleVolume } from '../src/voxel/lod';
import { VoxelVolume } from '../src/voxel/voxelVolume';
import { AIR, DIRT, GRASS, SAND, STONE, WATER } from '../src/voxel/materials';
import { Chunk } from '../src/voxel/chunk';
import { generateChunk, DEFAULT_TERRAIN } from '../src/voxel/terrain';

describe('desiredLod', () => {
  const params = DEFAULT_LOD_PARAMS; // { high: 4.5, low: 3.5 }

  it('drops to LOD1 beyond the high threshold', () => {
    expect(desiredLod(4.6, params)).toBe(1);
    expect(desiredLod(20, params)).toBe(1);
  });

  it('stays full-detail inside the low threshold', () => {
    expect(desiredLod(0, params)).toBe(0);
    expect(desiredLod(3.4, params)).toBe(0);
    expect(desiredLod(3.4, params, 1)).toBe(0); // back inside → restore
  });

  it('keeps the current level inside the hysteresis band', () => {
    expect(desiredLod(4, params, 0)).toBe(0); // not yet past high
    expect(desiredLod(4, params, 1)).toBe(1); // not yet inside low
    expect(desiredLod(4.5, params, 1)).toBe(1);
  });

  it('rejects an inverted threshold pair', () => {
    expect(() => desiredLod(1, { high: 2, low: 2 })).toThrow(RangeError);
  });
});

describe('downsampleVolume', () => {
  it('reduces 16³ to 8³ with majority materials per 2³ block', () => {
    const volume = new VoxelVolume(16);
    volume.fill(STONE);
    expect(downsampleVolume(volume).size).toBe(8);
    const lod = downsampleVolume(volume);
    for (let z = 0; z < 8; z++)
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(lod.get(x, y, z)).toBe(STONE);
  });

  it('mostly-air blocks erode to air', () => {
    const volume = new VoxelVolume(8);
    volume.set(0, 0, 0, STONE);
    const lod = downsampleVolume(volume);
    expect(lod.get(0, 0, 0)).toBe(AIR); // 1/8 solid: air majority wins
    expect(lod.get(1, 1, 1)).toBe(AIR);
  });

  it('non-air majority wins; ties resolve to air (never inflates)', () => {
    const volume = new VoxelVolume(2);
    // Block: 4 water, 3 stone, 1 air → water (strict majority).
    volume.fill(WATER);
    volume.set(1, 1, 1, STONE);
    volume.set(0, 1, 1, STONE);
    volume.set(1, 0, 1, STONE);
    volume.set(0, 0, 0, AIR);
    expect(downsampleVolume(volume).get(0, 0, 0)).toBe(WATER);

    // 4 stone vs 4 air → air: a half-solid surface block must not
    // become solid, or LOD1 terrain sits above the real surface.
    const half = new VoxelVolume(2);
    half.fill(STONE);
    for (const [x, z] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const)
      half.set(x, 1, z, AIR);
    expect(downsampleVolume(half).get(0, 0, 0)).toBe(AIR);

    // Tie between two non-air materials also goes to air.
    const tie = new VoxelVolume(2);
    tie.set(0, 0, 0, STONE);
    tie.set(1, 0, 0, STONE);
    tie.set(0, 0, 1, SAND);
    tie.set(1, 0, 1, SAND);
    expect(downsampleVolume(tie).get(0, 0, 0)).toBe(AIR);
  });

  it('LOD1 of a column never rises above the real surface', () => {
    const fillTo = (volume: VoxelVolume, height: number) => {
      for (let y = 0; y < height; y++)
        for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) volume.set(x, y, z, STONE);
    };

    // 32³ volume → 16³ LOD, so blocks {16,17} are covered at ly=8.
    const odd = new VoxelVolume(32);
    fillTo(odd, 17);
    const oddLod = downsampleVolume(odd);
    // Odd surface 17: block {16,17} is half solid → air; the column
    // tops out at ly=7 (voxels 14–15), never above the real surface.
    expect(oddLod.get(0, 8, 0)).toBe(AIR);
    expect(oddLod.get(0, 7, 0)).toBe(STONE);

    const even = new VoxelVolume(32);
    fillTo(even, 18);
    const evenLod = downsampleVolume(even);
    // Even surface 18: block {16,17} fully solid → exact top at ly=8.
    expect(evenLod.get(0, 8, 0)).toBe(STONE);
    expect(evenLod.get(0, 9, 0)).toBe(AIR);
  });

  it('preserves the dominant material of real terrain columns', () => {
    const chunk = new Chunk({ x: 0, y: 0, z: 0 });
    generateChunk(chunk, DEFAULT_TERRAIN);
    const lod = downsampleVolume(chunk.volume);
    // Surface-ish block just above the stone core keeps a non-air material.
    let nonAir = 0;
    for (let z = 0; z < 8; z++)
      for (let x = 0; x < 8; x++) {
        if (lod.get(x, 0, z) !== AIR) nonAir++;
      }
    expect(nonAir).toBe(64); // y=0 is always solid (bedrock/stone)
  });

  it('rejects sizes that do not divide evenly', () => {
    expect(() => downsampleVolume(new VoxelVolume(5), LOD1_FACTOR)).toThrow(RangeError);
  });

  it('keeps DIRT/GRASS distinct where the majority says so', () => {
    const volume = new VoxelVolume(2);
    volume.fill(GRASS);
    volume.set(0, 0, 0, DIRT);
    expect(downsampleVolume(volume).get(0, 0, 0)).toBe(GRASS);
  });
});
