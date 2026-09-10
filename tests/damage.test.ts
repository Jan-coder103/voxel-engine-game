import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { applyEdits } from '../src/voxel/edits';
import { AIR, DIRT, GRASS, STONE, WATER } from '../src/voxel/materials';
import { debrisFromCells, explode } from '../src/voxel/damage';

const CENTER = { x: 8.5, y: 8.5, z: 8.5 };

function filledWorld(material: number): World {
  const world = new World((chunk) => chunk.volume.fill(material));
  for (let cy = 0; cy < 2; cy++) {
    for (let cz = 0; cz < 2; cz++) {
      for (let cx = 0; cx < 2; cx++) world.ensureChunk(cx, cy, cz);
    }
  }
  return world;
}

/** Distance from the blast center to a cell's center. */
const dist = (x: number, y: number, z: number) =>
  Math.sqrt((x + 0.5 - CENTER.x) ** 2 + (y + 0.5 - CENTER.y) ** 2 + (z + 0.5 - CENTER.z) ** 2);

describe('explode', () => {
  it('fractures everything at the core, only soft materials at the edge', () => {
    const stone = filledWorld(STONE);
    const dirt = filledWorld(DIRT);
    const reachStone = 6 * (0.35 + 0.65 * (1 - 0.85)); // ≈ 2.79
    const reachDirt = 6 * (0.35 + 0.65 * (1 - 0.4)); // ≈ 4.29

    const rStone = explode(CENTER, 6, (x, y, z) => stone.getVoxel(x, y, z), {
      seed: 1,
      maxDebris: 32,
    });
    applyEdits(stone, rStone.edits, 'blast');
    const rDirt = explode(CENTER, 6, (x, y, z) => dirt.getVoxel(x, y, z), {
      seed: 1,
      maxDebris: 32,
    });
    applyEdits(dirt, rDirt.edits, 'blast');

    // Cell at distance ~3.6: survives in stone, gone in dirt.
    const probe = { x: 8, y: 8, z: 5 }; // dist = 3.5
    expect(dist(probe.x, probe.y, probe.z)).toBeGreaterThan(reachStone);
    expect(dist(probe.x, probe.y, probe.z)).toBeLessThan(reachDirt);
    expect(stone.getVoxel(probe.x, probe.y, probe.z)).toBe(STONE);
    expect(dirt.getVoxel(probe.x, probe.y, probe.z)).toBe(AIR);

    // Cell right at the core is destroyed in both.
    expect(stone.getVoxel(8, 8, 8)).toBe(AIR);
    expect(dirt.getVoxel(8, 8, 8)).toBe(AIR);

    expect(rDirt.destroyed).toBeGreaterThan(rStone.destroyed);
  });

  it('never touches bedrock; water vaporizes without debris', () => {
    const world = new World((chunk) => chunk.volume.fill(WATER));
    world.ensureChunk(0, 0, 0);
    world.setVoxel(5, 0, 5, STONE); // bedrock floor is stone at y=0
    const result = explode({ x: 5.5, y: 0.5, z: 5.5 }, 5, (x, y, z) => world.getVoxel(x, y, z), {
      seed: 3,
      maxDebris: 16,
    });
    // Water within reach becomes air (Phase 9 vaporization)...
    expect(result.edits.length).toBeGreaterThan(0);
    for (const edit of result.edits) {
      expect(edit.y).toBeGreaterThan(0); // bedrock immune
      expect(edit.material).toBe(AIR);
    }
    // ...but never fractures into debris and does not count as destroyed.
    expect(result.debris).toHaveLength(0);
    expect(result.destroyed).toBe(0);
    applyEdits(world, result.edits, 'blast');
    expect(world.getVoxel(5, 1, 5)).toBe(AIR); // core water vaporized
    expect(world.getVoxel(5, 0, 5)).toBe(STONE); // bedrock intact
  });

  it('ignores air cells and reports only real fractures', () => {
    const world = new World(() => {});
    world.ensureChunk(0, 0, 0);
    const result = explode(CENTER, 4, (x, y, z) => world.getVoxel(x, y, z), {
      seed: 5,
      maxDebris: 8,
    });
    expect(result.destroyed).toBe(0);
    expect(result.edits).toHaveLength(0);
    expect(result.debris).toHaveLength(0);
  });

  it('is deterministic per seed and caps debris', () => {
    const world = filledWorld(GRASS);
    const query = (x: number, y: number, z: number) => world.getVoxel(x, y, z);
    const a = explode(CENTER, 6, query, { seed: 42, maxDebris: 20 });
    const b = explode(CENTER, 6, query, { seed: 42, maxDebris: 20 });
    const c = explode(CENTER, 6, query, { seed: 43, maxDebris: 20 });
    expect(a.debris).toEqual(b.debris);
    expect(a.debris).not.toEqual(c.debris);
    expect(a.debris.length).toBeLessThanOrEqual(20);
    expect(a.destroyed).toBeGreaterThan(100);
  });

  it('blast edits flow through applyEdits as one undoable command', () => {
    const world = filledWorld(STONE);
    const history = { undone: false };
    const result = explode(CENTER, 5, (x, y, z) => world.getVoxel(x, y, z), {
      seed: 9,
      maxDebris: 16,
    });
    const command = applyEdits(world, result.edits, 'explode')!;
    expect(result.destroyed).toBeGreaterThan(0);
    // Simulate undo via the captured previous values.
    applyEdits(world, command.previous, 'undo-explode');
    expect(world.getVoxel(8, 8, 8)).toBe(STONE);
    expect(history).toBeDefined();
  });
});

describe('debrisFromCells', () => {
  it('samples collapse cells deterministically and respects the cap', () => {
    const world = filledWorld(STONE);
    const cells = [];
    for (let y = 20; y < 24; y++) {
      for (let x = 4; x < 14; x++) {
        for (let z = 4; z < 14; z++) cells.push({ x, y, z });
      }
    }
    const opts = { seed: 7, maxDebris: 30, x: 8.5, z: 8.5 };
    const a = debrisFromCells(cells, (x, y, z) => world.getVoxel(x, y, z), opts);
    const b = debrisFromCells(cells, (x, y, z) => world.getVoxel(x, y, z), opts);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(30);
    expect(a.length).toBeGreaterThan(0);
    for (const spec of a) {
      expect(spec.vy).toBeLessThan(0); // collapse tumbles downward
      expect(spec.material).toBe(STONE);
    }
  });

  it('skips cells that are already air', () => {
    const world = new World(() => {});
    world.ensureChunk(0, 0, 0);
    const specs = debrisFromCells([{ x: 1, y: 2, z: 3 }], (x, y, z) => world.getVoxel(x, y, z), {
      seed: 1,
      maxDebris: 4,
      x: 0,
      z: 0,
    });
    expect(specs).toHaveLength(0);
  });
});
