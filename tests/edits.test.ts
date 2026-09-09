import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import {
  applyEdits,
  EditHistory,
  intersectsPlayerCell,
  MAX_HISTORY,
  type VoxelEdit,
} from '../src/voxel/edits';
import { AIR, GRASS, STONE, WATER } from '../src/voxel/materials';

function filledWorld(): World {
  const world = new World((chunk) => chunk.volume.fill(STONE));
  world.ensureChunk(0, 0, 0);
  return world;
}

describe('applyEdits', () => {
  it('changes cells and captures the previous materials', () => {
    const world = filledWorld();
    const command = applyEdits(
      world,
      [
        { x: 0, y: 0, z: 0, material: GRASS },
        { x: 1, y: 2, z: 3, material: WATER },
      ],
      'test',
    );
    expect(command).toBeDefined();
    expect(command!.edits).toHaveLength(2);
    expect(command!.previous).toEqual([
      { x: 0, y: 0, z: 0, material: STONE },
      { x: 1, y: 2, z: 3, material: STONE },
    ]);
    expect(world.getVoxel(0, 0, 0)).toBe(GRASS);
    expect(world.getVoxel(1, 2, 3)).toBe(WATER);
  });

  it('skips no-op cells and fails cleanly when nothing changes', () => {
    const world = filledWorld();
    const partial = applyEdits(world, [{ x: 0, y: 0, z: 0, material: STONE }], 'noop');
    expect(partial).toBeUndefined();

    const mixed = applyEdits(
      world,
      [
        { x: 0, y: 0, z: 0, material: STONE }, // no-op
        { x: 2, y: 0, z: 2, material: GRASS }, // real change
      ],
      'mixed',
    );
    expect(mixed!.edits).toHaveLength(1);
    expect(mixed!.edits[0].x).toBe(2);
  });

  it('drops edits to unloaded chunks instead of failing', () => {
    const world = filledWorld();
    const command = applyEdits(
      world,
      [
        { x: 0, y: 0, z: 0, material: GRASS },
        { x: 500, y: 0, z: 500, material: GRASS }, // unloaded
      ],
      'mixed-load',
    );
    expect(command!.edits).toHaveLength(1);
  });
});

describe('EditHistory', () => {
  it('undo restores the previous material, redo re-applies it', () => {
    const world = filledWorld();
    const history = new EditHistory();
    const command = applyEdits(world, [{ x: 3, y: 1, z: 4, material: GRASS }], 'place')!;
    history.push(command);

    expect(history.undo(world)).toBe(true);
    expect(world.getVoxel(3, 1, 4)).toBe(STONE);
    expect(history.canUndo).toBe(false);

    expect(history.redo(world)).toBe(true);
    expect(world.getVoxel(3, 1, 4)).toBe(GRASS);
    expect(history.canRedo).toBe(false);
  });

  it('returns false when there is nothing to undo/redo', () => {
    const world = filledWorld();
    const history = new EditHistory();
    expect(history.undo(world)).toBe(false);
    expect(history.redo(world)).toBe(false);
  });

  it('pushing after an undo drops the redo branch', () => {
    const world = filledWorld();
    const history = new EditHistory();
    history.push(applyEdits(world, [{ x: 0, y: 0, z: 0, material: GRASS }], 'a')!);
    history.undo(world);
    expect(history.canRedo).toBe(true);
    history.push(applyEdits(world, [{ x: 1, y: 1, z: 1, material: WATER }], 'b')!);
    expect(history.canRedo).toBe(false);
  });

  it('undoes multi-cell commands atomically', () => {
    const world = filledWorld();
    const history = new EditHistory();
    const edits: VoxelEdit[] = [
      { x: 0, y: 0, z: 0, material: GRASS },
      { x: 1, y: 0, z: 0, material: WATER },
      { x: 2, y: 0, z: 0, material: GRASS },
    ];
    history.push(applyEdits(world, edits, 'wall')!);
    history.undo(world);
    for (const edit of edits) expect(world.getVoxel(edit.x, edit.y, edit.z)).toBe(STONE);
    history.redo(world);
    expect(world.getVoxel(0, 0, 0)).toBe(GRASS);
    expect(world.getVoxel(1, 0, 0)).toBe(WATER);
    expect(world.getVoxel(2, 0, 0)).toBe(GRASS);
  });

  it('caps the undo stack at MAX_HISTORY entries', () => {
    const world = filledWorld();
    const history = new EditHistory();
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      const x = i % 16;
      const y = Math.floor(i / 16) % 16;
      history.push(applyEdits(world, [{ x, y, z: 15, material: i % 2 ? GRASS : WATER }], 'fill')!);
    }
    expect(history.depth).toBe(MAX_HISTORY);
  });
});

describe('World edit journal', () => {
  it('replays journaled edits when a chunk is unloaded and regenerated', () => {
    let generations = 0;
    const world = new World((chunk) => {
      generations++;
      chunk.volume.fill(STONE);
    });
    world.ensureChunk(2, 0, -1);
    world.setVoxel(33, 5, -12, GRASS); // local (1,5,4) of (2,0,-1)

    world.unloadChunk(2, 0, -1);
    expect(world.getVoxel(33, 5, -12)).toBe(AIR); // unloaded reads air

    world.ensureChunk(2, 0, -1);
    expect(generations).toBe(2); // regenerated, not restored from cache
    expect(world.getVoxel(33, 5, -12)).toBe(GRASS); // journal replayed
  });

  it('exports and reloads the journal as serialized data', () => {
    const emptyGenerator = () => {}; // world starts as air
    const source = new World(emptyGenerator);
    source.ensureChunk(0, 0, 0);
    source.setVoxel(1, 2, 3, GRASS);
    source.setVoxel(15, 0, 15, WATER); // boundary corner of the chunk

    const exported = source.exportEdits();
    expect(Object.keys(exported)).toEqual(['0,0,0']);

    // Loaded chunks get the edits applied immediately (and remesh).
    const restored = new World(emptyGenerator);
    restored.ensureChunk(0, 0, 0);
    restored.loadEdits(exported);
    expect(restored.getVoxel(1, 2, 3)).toBe(GRASS);
    expect(restored.getVoxel(15, 0, 15)).toBe(WATER);
    expect(restored.getChunk(0, 0, 0)?.dirty).toBe(true);

    // Unloaded chunks pick the edits up on generation instead.
    const other = new World(emptyGenerator);
    other.loadEdits(exported);
    expect(other.getVoxel(1, 2, 3)).toBe(0); // still unloaded → air
    other.ensureChunk(0, 0, 0);
    expect(other.getVoxel(1, 2, 3)).toBe(GRASS);
  });

  it('round-trips through undo (undo writes also journal)', () => {
    const world = filledWorld();
    const history = new EditHistory();
    history.push(applyEdits(world, [{ x: 5, y: 5, z: 5, material: GRASS }], 'place')!);
    history.undo(world);
    expect(world.getVoxel(5, 5, 5)).toBe(STONE);

    world.unloadChunk(0, 0, 0);
    world.ensureChunk(0, 0, 0);
    expect(world.getVoxel(5, 5, 5)).toBe(STONE); // the undo survived too
  });
});

describe('intersectsPlayerCell', () => {
  const pos = { x: 0.5, y: 0, z: 0.5 };
  const half = 0.3;
  const height = 1.8;

  it('detects the cell the player stands in', () => {
    expect(intersectsPlayerCell({ x: 0, y: 0, z: 0 }, pos, half, height)).toBe(true);
    expect(intersectsPlayerCell({ x: 0, y: 1, z: 0 }, pos, half, height)).toBe(true);
  });

  it('rejects adjacent and above-head cells', () => {
    expect(intersectsPlayerCell({ x: 1, y: 0, z: 0 }, pos, half, height)).toBe(false);
    expect(intersectsPlayerCell({ x: -1, y: 0, z: 0 }, pos, half, height)).toBe(false);
    expect(intersectsPlayerCell({ x: 0, y: 0, z: 1 }, pos, half, height)).toBe(false);
    expect(intersectsPlayerCell({ x: 0, y: 2, z: 0 }, pos, half, height)).toBe(false);
  });
});
