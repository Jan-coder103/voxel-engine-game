import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { applyEdits, type VoxelEdit } from '../src/voxel/edits';
import { AIR, DIRT, GRASS, STONE, type VoxelMaterialID } from '../src/voxel/materials';
import {
  copyRegion,
  selectionBounds,
  selectionFits,
  selectionSize,
  MAX_SELECTION_VOLUME,
} from '../src/creator/selection';
import {
  clipboardGet,
  mirrorClipboardX,
  pasteEdits,
  remapClipboard,
  rotateClipboardY,
  type ClipboardVolume,
} from '../src/creator/clipboard';

describe('selection', () => {
  it('normalizes corners in any click order', () => {
    const bounds = selectionBounds({ x: 4, y: -2, z: 9 }, { x: 1, y: 3, z: 5 });
    expect(bounds.min).toEqual({ x: 1, y: -2, z: 5 });
    expect(bounds.max).toEqual({ x: 4, y: 3, z: 9 });
    expect(selectionSize(bounds)).toEqual({ x: 4, y: 6, z: 5 });
  });

  it('a single cell is a 1×1×1 selection', () => {
    const bounds = selectionBounds({ x: 2, y: 2, z: 2 }, { x: 2, y: 2, z: 2 });
    expect(selectionSize(bounds)).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('the volume budget rejects a 33³ box and accepts 32³', () => {
    const big = selectionBounds({ x: 0, y: 0, z: 0 }, { x: 32, y: 32, z: 32 });
    expect(selectionFits(big)).toBe(false);
    const ok = selectionBounds({ x: 0, y: 0, z: 0 }, { x: 31, y: 31, z: 31 });
    expect(selectionFits(ok)).toBe(true);
    expect(MAX_SELECTION_VOLUME).toBe(32 * 32 * 32);
  });

  it('copyRegion snapshots every cell including air', () => {
    const world = new World((chunk) => chunk.volume.fill(STONE));
    world.ensureChunk(0, 0, 0);
    world.setVoxel(1, 1, 1, AIR);
    const clip = copyRegion((x, y, z) => world.getVoxel(x, y, z), {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    });
    expect(clip.size).toEqual({ x: 2, y: 2, z: 2 });
    expect(clipboardGet(clip, 1, 1, 1)).toBe(AIR);
    expect(clipboardGet(clip, 0, 1, 1)).toBe(STONE);
  });
});

/** 2×1×2 volume with four distinct materials, so orientation is visible. */
function asymmetric(): VoxelMaterialID[] {
  return [STONE, DIRT, GRASS, AIR];
}

describe('clipboard transforms', () => {
  it('rotating four times returns the original', () => {
    const clip = { size: { x: 2, y: 1, z: 2 }, voxels: new Uint16Array(asymmetric()) };
    let rotated: ClipboardVolume = clip;
    for (let i = 0; i < 4; i++) rotated = rotateClipboardY(rotated, 1);
    expect([...rotated.voxels]).toEqual([...clip.voxels]);
    expect(rotated.size).toEqual(clip.size);
  });

  it('rotating +1 then -1 returns the original', () => {
    const clip = { size: { x: 2, y: 1, z: 2 }, voxels: new Uint16Array(asymmetric()) };
    expect(rotateClipboardY(rotateClipboardY(clip, 1), -1).voxels).toEqual(clip.voxels);
  });

  it('a +1 rotation transposes x/z with a mirror, swapping size axes', () => {
    // Layout (x,z): [0]=(S,z0) [1]=(D) / [2]=(G) [3]=(air); +1 turns it 90° CW.
    const clip = { size: { x: 2, y: 1, z: 2 }, voxels: new Uint16Array(asymmetric()) };
    const rotated = rotateClipboardY(clip, 1);
    expect(rotated.size).toEqual({ x: 2, y: 1, z: 2 });
    expect(clipboardGet(rotated, 0, 0, 0)).toBe(GRASS); // old (0,1) → new (0,0)
    expect(clipboardGet(rotated, 1, 0, 0)).toBe(STONE); // old (0,0) → new (1,0)
    expect(clipboardGet(rotated, 0, 0, 1)).toBe(AIR); // old (1,1) → new (0,1)
    expect(clipboardGet(rotated, 1, 0, 1)).toBe(DIRT); // old (1,0) → new (1,1)
  });

  it('odd rotations swap the x/z sizes', () => {
    const clip = { size: { x: 3, y: 2, z: 1 }, voxels: new Uint16Array(6).fill(STONE) };
    expect(rotateClipboardY(clip, 1).size).toEqual({ x: 1, y: 2, z: 3 });
    expect(rotateClipboardY(clip, 2).size).toEqual({ x: 3, y: 2, z: 1 });
  });

  it('mirror flips x and is involutive', () => {
    const clip = { size: { x: 2, y: 1, z: 2 }, voxels: new Uint16Array(asymmetric()) };
    const mirrored = mirrorClipboardX(clip);
    expect(clipboardGet(mirrored, 0, 0, 0)).toBe(DIRT);
    expect(clipboardGet(mirrored, 1, 0, 0)).toBe(STONE);
    expect(mirrorClipboardX(mirrored).voxels).toEqual(clip.voxels);
  });

  it('remap renames only mapped materials', () => {
    const clip = { size: { x: 2, y: 1, z: 1 }, voxels: new Uint16Array([STONE, DIRT]) };
    const remapped = remapClipboard(clip, new Map([[STONE, GRASS]]));
    expect([...remapped.voxels]).toEqual([GRASS, DIRT]);
  });
});

describe('paste', () => {
  it('default paste writes non-air cells only, as one grouped command', () => {
    const world = new World((chunk) => chunk.volume.fill(STONE));
    world.ensureChunk(0, 0, 0);
    const clip = { size: { x: 2, y: 1, z: 2 }, voxels: new Uint16Array(asymmetric()) };
    const edits = pasteEdits(clip, { x: 4, y: 2, z: 4 });
    expect(edits.every((edit) => edit.material !== AIR)).toBe(true);
    expect(edits).toHaveLength(3);
    const command = applyEdits(world, edits, 'paste')!;
    expect(command.previous.every((prev) => prev.material === STONE)).toBe(true);
    expect(world.getVoxel(4, 2, 4)).toBe(STONE);
    expect(world.getVoxel(5, 2, 4)).toBe(DIRT);
  });

  it('solid paste recreates the copied region exactly', () => {
    const world = new World((chunk) => chunk.volume.fill(STONE));
    world.ensureChunk(0, 0, 0);
    const clip = { size: { x: 2, y: 1, z: 2 }, voxels: new Uint16Array(asymmetric()) };
    const edits: VoxelEdit[] = pasteEdits(clip, { x: 0, y: 8, z: 0 }, { solid: true });
    expect(edits).toHaveLength(4);
    applyEdits(world, edits, 'paste-solid');
    expect(world.getVoxel(1, 8, 1)).toBe(AIR);
    expect(world.getVoxel(0, 8, 1)).toBe(GRASS);
  });

  it('copy → rotate → paste matches a hand-built expectation', () => {
    const world = new World(() => {});
    world.ensureChunk(0, 0, 0);
    // An L-shaped wall in the source region.
    world.setVoxel(0, 5, 0, STONE);
    world.setVoxel(1, 5, 0, STONE);
    world.setVoxel(1, 5, 1, STONE);
    const clip = copyRegion((x, y, z) => world.getVoxel(x, y, z), {
      min: { x: 0, y: 5, z: 0 },
      max: { x: 1, y: 5, z: 1 },
    });
    const rotated = rotateClipboardY(clip, 1);
    applyEdits(world, pasteEdits(rotated, { x: 8, y: 5, z: 8 }), 'paste-rot');
    // Rotation (+1) maps (x,z) → (1−z, x): source cells (0,0),(1,0),(1,1)
    // land at (9,5,8), (9,5,9), (8,5,9); the old corner (8,5,8) is air.
    expect(world.getVoxel(9, 5, 8)).toBe(STONE);
    expect(world.getVoxel(9, 5, 9)).toBe(STONE);
    expect(world.getVoxel(8, 5, 9)).toBe(STONE);
    expect(world.getVoxel(8, 5, 8)).toBe(AIR);
  });
});
