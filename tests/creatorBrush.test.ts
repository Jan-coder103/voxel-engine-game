import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { applyEdits, EditHistory, type VoxelEdit } from '../src/voxel/edits';
import { AIR, DIRT, GRASS, SAND, STONE, WATER } from '../src/voxel/materials';
import {
  BRUSH_MAX_SIZE,
  BRUSH_MIN_SIZE,
  brushBounds,
  brushCells,
  brushEdits,
  clampBrushSize,
  type Brush,
} from '../src/creator/brush';

const C = { x: 0, y: 5, z: 0 };

function baseBrush(overrides: Partial<Brush> = {}): Brush {
  return {
    shape: 'sphere',
    tool: 'place',
    size: 2,
    material: STONE,
    replaceFrom: AIR,
    seed: 7,
    density: 0.5,
    ...overrides,
  };
}

function emptyWorld(): World {
  const world = new World(() => {});
  world.ensureChunk(0, 0, 0);
  return world;
}

function apply(world: World, edits: VoxelEdit[]): void {
  const command = applyEdits(world, edits, 'test');
  if (command) void command;
}

describe('brush sizes', () => {
  it('clamps to the documented range', () => {
    expect(clampBrushSize(-3)).toBe(BRUSH_MIN_SIZE);
    expect(clampBrushSize(2.7)).toBe(3);
    expect(clampBrushSize(99)).toBe(BRUSH_MAX_SIZE);
  });
});

describe('brushCells shapes', () => {
  it('sphere of radius 1 is the 7-cell plus shape', () => {
    const cells = brushCells(baseBrush({ shape: 'sphere', size: 1 }), C);
    expect(cells).toHaveLength(7);
    expect(cells).toContainEqual(C);
    expect(cells).toContainEqual({ x: 1, y: 5, z: 0 });
    expect(cells).not.toContainEqual({ x: 1, y: 6, z: 0 }); // diagonal excluded
  });

  it('box of size 1 is a single cell; size 2 is 3×3×3', () => {
    expect(brushCells(baseBrush({ shape: 'box', size: 1 }), C)).toEqual([C]);
    expect(brushCells(baseBrush({ shape: 'box', size: 2 }), C)).toHaveLength(27);
  });

  it('cylinder is a horizontal disc with height', () => {
    const cells = brushCells(baseBrush({ shape: 'cylinder', size: 2 }), C);
    // disc: 13 cells (radius 2) × 3 layers (|dy| ≤ 1) = 39
    expect(cells).toHaveLength(39);
    expect(cells.some((c) => c.y === C.y - 1)).toBe(true);
    expect(cells.some((c) => c.y === C.y + 2)).toBe(false); // |dy| ≤ size-1
  });

  it('noise brush is a deterministic subset of the sphere', () => {
    const brush = baseBrush({ shape: 'noise', size: 3, density: 0.4, seed: 42 });
    const sphere = new Set(
      brushCells(baseBrush({ shape: 'sphere', size: 3 }), C).map((c) => `${c.x},${c.y},${c.z}`),
    );
    const cells = brushCells(brush, C);
    for (const cell of cells) {
      expect(sphere.has(`${cell.x},${cell.y},${cell.z}`)).toBe(true);
    }
    // Deterministic: same seed → same cells; different seed → (almost surely) different.
    expect(brushCells(brush, C)).toEqual(cells);
    expect(brushCells({ ...brush, seed: 43 }, C)).not.toEqual(cells);
    // Density gate holds for large samples (allow slack for the hash).
    const big = brushCells({ ...brush, size: 6, density: 0.4 }, C);
    const bigSphere = brushCells(baseBrush({ shape: 'sphere', size: 6 }), C).length;
    expect(big.length).toBeGreaterThan(bigSphere * 0.2);
    expect(big.length).toBeLessThan(bigSphere * 0.6);
  });

  it('bounds cover exactly the shape extent', () => {
    const bounds = brushBounds(baseBrush({ shape: 'sphere', size: 2 }), C);
    expect(bounds).toEqual({
      min: { x: -2, y: 3, z: -2 },
      max: { x: 2, y: 7, z: 2 },
    });
    const boxBounds = brushBounds(baseBrush({ shape: 'box', size: 2 }), C);
    expect(boxBounds.min).toEqual({ x: -1, y: 4, z: -1 });
  });
});

describe('brushEdits tools', () => {
  it('place fills only air cells', () => {
    const world = emptyWorld();
    world.setVoxel(0, 5, 0, GRASS); // occupied — place must skip it
    const edits = brushEdits(
      baseBrush({ shape: 'box', size: 2, tool: 'place', material: STONE }),
      C,
      (x, y, z) => world.getVoxel(x, y, z),
    );
    apply(world, edits);
    expect(world.getVoxel(0, 5, 0)).toBe(GRASS); // untouched
    expect(world.getVoxel(1, 5, 0)).toBe(STONE); // air filled
    expect(edits.every((edit) => edit.material === STONE)).toBe(true);
  });

  it('delete clears every non-air cell to air', () => {
    const world = emptyWorld();
    const mid = { x: 8, y: 5, z: 8 }; // keep the whole brush inside chunk 0
    apply(
      world,
      brushEdits(
        baseBrush({ shape: 'box', size: 2, tool: 'place', material: DIRT }),
        mid,
        () => AIR,
      ),
    );
    const edits = brushEdits(baseBrush({ shape: 'box', size: 2, tool: 'delete' }), mid, (x, y, z) =>
      world.getVoxel(x, y, z),
    );
    expect(edits).toHaveLength(27);
    apply(world, edits);
    expect(world.getVoxel(9, 5, 9)).toBe(AIR);
  });

  it('paint recolors non-air cells only', () => {
    const world = emptyWorld();
    world.setVoxel(0, 5, 0, GRASS);
    const edits = brushEdits(
      baseBrush({ shape: 'box', size: 2, tool: 'paint', material: SAND }),
      C,
      (x, y, z) => world.getVoxel(x, y, z),
    );
    expect(edits).toHaveLength(1);
    apply(world, edits);
    expect(world.getVoxel(0, 5, 0)).toBe(SAND);
    expect(world.getVoxel(1, 5, 1)).toBe(AIR); // air was not painted in
  });

  it('replace targets one material; replaceFrom AIR is the wildcard', () => {
    const world = emptyWorld();
    world.setVoxel(0, 5, 0, STONE);
    world.setVoxel(1, 5, 0, DIRT);
    const targeted = brushEdits(
      baseBrush({ shape: 'box', size: 2, tool: 'replace', material: SAND, replaceFrom: STONE }),
      C,
      (x, y, z) => world.getVoxel(x, y, z),
    );
    expect(targeted).toEqual([{ x: 0, y: 5, z: 0, material: SAND }]);

    const wildcard = brushEdits(
      baseBrush({ shape: 'box', size: 2, tool: 'replace', material: SAND, replaceFrom: AIR }),
      C,
      (x, y, z) => world.getVoxel(x, y, z),
    );
    expect(wildcard).toHaveLength(2);
  });

  it('never touches the bedrock floor', () => {
    const world = new World((chunk) => chunk.volume.fill(STONE));
    world.ensureChunk(0, 0, 0);
    for (const tool of ['delete', 'paint', 'replace'] as const) {
      const edits = brushEdits(
        baseBrush({ shape: 'sphere', size: 4, tool, material: SAND }),
        { x: 3, y: 0, z: 3 },
        (x, y, z) => world.getVoxel(x, y, z),
      );
      expect(edits.every((edit) => edit.y > 0)).toBe(true);
    }
  });

  it('honors the excludes predicate (player guard)', () => {
    const edits = brushEdits(
      baseBrush({ shape: 'box', size: 3, tool: 'place', material: STONE }),
      C,
      () => AIR,
      (cell) => cell.x === 0 && cell.y === 5 && cell.z === 0,
    );
    expect(edits.find((edit) => edit.x === 0 && edit.y === 5 && edit.z === 0)).toBeUndefined();
    expect(edits.length).toBeGreaterThan(0);
  });

  it('water: placeable as a material, displaced by place, skipped by paint, deletable', () => {
    const world = emptyWorld();
    world.setVoxel(0, 5, 0, WATER);
    const query = (x: number, y: number, z: number) => world.getVoxel(x, y, z);
    // Paint never recolors water (the fluid owns those cells).
    expect(
      brushEdits(baseBrush({ shape: 'box', size: 2, tool: 'paint', material: SAND }), C, query),
    ).toHaveLength(0);
    // Placing stone into water displaces it.
    expect(
      brushEdits(baseBrush({ shape: 'box', size: 2, tool: 'place', material: STONE }), C, query),
    ).toContainEqual({ x: 0, y: 5, z: 0, material: STONE });
    // Delete removes water.
    expect(brushEdits(baseBrush({ shape: 'box', size: 2, tool: 'delete' }), C, query)).toEqual([
      { x: 0, y: 5, z: 0, material: AIR },
    ]);
    // Water itself is a placeable material (creates fluid sources).
    expect(
      brushEdits(
        baseBrush({ shape: 'box', size: 2, tool: 'place', material: WATER }),
        C,
        () => AIR,
      ),
    ).toContainEqual({ x: 0, y: 5, z: 0, material: WATER });
  });
});

describe('brush strokes are one undoable command', () => {
  it('applyEdits round-trips a delete stroke', () => {
    const world = emptyWorld();
    const history = new EditHistory();
    apply(
      world,
      brushEdits(baseBrush({ shape: 'box', size: 2, tool: 'place', material: DIRT }), C, () => AIR),
    );
    const stroke = applyEdits(
      world,
      brushEdits(baseBrush({ shape: 'box', size: 2, tool: 'delete' }), C, (x, y, z) =>
        world.getVoxel(x, y, z),
      ),
      'brush delete',
    )!;
    history.push(stroke);
    expect(world.getVoxel(1, 5, 1)).toBe(AIR);
    history.undo(world);
    expect(world.getVoxel(1, 5, 1)).toBe(DIRT);
  });
});
