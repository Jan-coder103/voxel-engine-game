import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { FluidSim, WATER_FLOW_MAX, packCellKey, unpackCellKey } from '../src/voxel/fluid';
import { AIR, STONE, WATER } from '../src/voxel/materials';
import { worldToChunk, worldToLocal } from '../src/voxel/coordinates';

/**
 * Phase 9 fluid tests: mass conservation, gravity, equalization, closed
 * boundaries, cross-chunk flow, source semantics, sleep/wake, save-state
 * round-trips, and determinism.
 */

/** An empty world with chunks covering x/z ∈ [-16, 32), both Y layers. */
function emptyWorld(): World {
  const world = new World(() => {});
  for (let cy = 0; cy < 2; cy++)
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
  return world;
}

/** A walled basin: stone floor at y=0, walls up to `wallHeight`, open sky. */
function basinWorld(halfExtent = 3, wallHeight = 3): World {
  const world = emptyWorld();
  for (let z = -halfExtent; z <= halfExtent; z++) {
    for (let x = -halfExtent; x <= halfExtent; x++) {
      world.setVoxel(x, 0, z, STONE);
      if (Math.abs(x) === halfExtent || Math.abs(z) === halfExtent) {
        for (let y = 1; y <= wallHeight; y++) world.setVoxel(x, y, z, STONE);
      }
    }
  }
  return world;
}

/** Volume index layout shared with VoxelVolume (y-major, 16³ chunks). */
function volumeIndex(x: number, y: number, z: number): number {
  const lx = worldToLocal(x);
  const ly = worldToLocal(y);
  const lz = worldToLocal(z);
  return lx + lz * 16 + ly * 16 * 16;
}

function chunkKey(x: number, y: number, z: number): string {
  return `${worldToChunk(x)},${worldToChunk(y)},${worldToChunk(z)}`;
}

/**
 * Seed flowing (non-source) water cells: material WATER plus explicit
 * sparse levels, then wake the area. Cells with level 0 get no material
 * (they are dry — a WATER material without an entry is a source).
 */
function seedFlowing(
  world: World,
  fluid: FluidSim,
  cells: readonly [number, number, number, number][],
): void {
  const byChunk = new Map<string, [number, number][]>();
  for (const [x, y, z, level] of cells) {
    if (level <= 0) continue;
    world.setVoxel(x, y, z, WATER);
    const key = chunkKey(x, y, z);
    const list = byChunk.get(key) ?? [];
    list.push([volumeIndex(x, y, z), level]);
    byChunk.set(key, list);
  }
  fluid.loadLevels(Object.fromEntries(byChunk));
  for (const [x, y, z] of cells) fluid.wake(x, y, z);
}

/** Place a source the way the game does: write the WATER material. */
function placeSource(world: World, x: number, y: number, z: number): void {
  world.setVoxel(x, y, z, WATER);
}

describe('cell key packing', () => {
  it('round-trips positive and negative coordinates', () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [1, 2, 3],
      [-1, 0, -1],
      [-12345, 31, 98765],
      [524287, 63, -524288],
    ]) {
      expect(unpackCellKey(packCellKey(x, y, z))).toEqual({ x, y, z });
    }
  });
});

describe('fluid levels and sources', () => {
  it('a placed water cell is a source', () => {
    const world = emptyWorld();
    const fluid = new FluidSim(world);
    placeSource(world, 2, 5, 2);
    expect(world.getVoxel(2, 5, 2)).toBe(WATER);
    expect(fluid.levelAt(2, 5, 2)).toBe(255);
    expect(fluid.isSource(2, 5, 2)).toBe(true);
  });

  it('flowing cells hold their seeded level and are not sources', () => {
    const world = emptyWorld();
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[2, 5, 2, 200]]);
    expect(fluid.levelAt(2, 5, 2)).toBe(200);
    expect(fluid.isSource(2, 5, 2)).toBe(false);
  });

  it('dry and unloaded cells read as level 0', () => {
    const world = emptyWorld();
    const fluid = new FluidSim(world);
    expect(fluid.levelAt(0, 0, 0)).toBe(0);
    expect(fluid.levelAt(1000, 5, 1000)).toBe(0);
  });
});

describe('gravity and equalization', () => {
  it('flowing water falls, spreads across the floor, and rests below its start', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 4, 0, 200]]);
    fluid.settle();
    // Nothing left in the air; all 200 mass rests on the basin floor.
    expect(fluid.totalMass(-3, 2, -3, 3, 8, 3)).toBe(0);
    expect(fluid.totalMass(-3, 1, -3, 3, 1, 3)).toBe(200);
  });

  it('falls straight down a 1×1 shaft without losing mass', () => {
    const world = emptyWorld();
    for (let y = 1; y <= 6; y++) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        world.setVoxel(dx, y, dz, STONE);
      }
    }
    world.setVoxel(0, 0, 0, STONE); // shaft floor
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 6, 0, 200]]);
    fluid.settle();
    expect(fluid.levelAt(0, 1, 0)).toBe(200); // intact at the bottom
    expect(fluid.levelAt(0, 6, 0)).toBe(0);
  });

  it('equalizes between two cells and conserves mass', () => {
    const world = basinWorld(2, 2);
    // Bury the basin floor at y=1 except for two adjacent trench cells.
    for (let z = -1; z <= 1; z++) {
      for (let x = -1; x <= 1; x++) {
        if (!(z === 0 && (x === 0 || x === 1))) world.setVoxel(x, 1, z, STONE);
      }
    }
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 1, 0, 200]]);
    fluid.settle();
    expect(fluid.levelAt(0, 1, 0)).toBe(100);
    expect(fluid.levelAt(1, 1, 0)).toBe(100);
  });

  it('a falling cell never becomes a source (254 cap)', () => {
    const world = emptyWorld();
    for (let y = 0; y <= 6; y++) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        world.setVoxel(dx, y, dz, STONE);
      }
    }
    world.setVoxel(0, 0, 0, STONE);
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 6, 0, WATER_FLOW_MAX]]);
    fluid.settle();
    expect(fluid.levelAt(0, 1, 0)).toBe(WATER_FLOW_MAX);
    expect(fluid.isSource(0, 1, 0)).toBe(false);
  });

  it('mass is exactly conserved in a closed basin across settling', () => {
    const world = basinWorld(4, 6);
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [
      [-2, 3, -1, 250],
      [0, 5, 1, 120],
      [1, 2, 2, 90],
      [-3, 4, 3, 254],
      [2, 1, -2, 60],
    ]);
    const before = fluid.totalMass(-4, 0, -4, 4, 8, 4);
    fluid.settle();
    const after = fluid.totalMass(-4, 0, -4, 4, 8, 4);
    expect(after).toBe(before);
  });

  it('solid boundaries contain water', () => {
    const world = basinWorld(2, 5);
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 3, 0, 254]]);
    fluid.settle();
    const inside = fluid.totalMass(-2, 1, -2, 2, 5, 2);
    const everywhere = fluid.totalMass(-6, 0, -6, 6, 9, 6);
    expect(inside).toBe(254);
    expect(everywhere).toBe(inside);
  });

  it('water does not enter solid cells', () => {
    const world = basinWorld();
    world.setVoxel(1, 1, 0, STONE);
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 1, 0, 200]]);
    fluid.settle();
    expect(fluid.levelAt(1, 1, 0)).toBe(0);
    expect(world.getVoxel(1, 1, 0)).toBe(STONE);
  });
});

describe('chunk boundaries', () => {
  it('flows across the border between two chunks and conserves mass', () => {
    const world = emptyWorld();
    // Floored, rimmed pit spanning the x = 15/16 chunk boundary.
    for (let z = -3; z <= 3; z++) {
      for (let x = 12; x <= 19; x++) {
        world.setVoxel(x, 0, z, STONE);
        const rim = x === 12 || x === 19 || Math.abs(z) === 3;
        if (rim) world.setVoxel(x, 1, z, STONE);
      }
    }
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[15, 1, 0, 254]]);
    fluid.settle();
    // Water crossed into chunk (1,0,0) (x = 16…).
    expect(fluid.levelAt(16, 1, 0)).toBeGreaterThan(0);
    expect(fluid.levelAt(17, 1, 0)).toBeGreaterThan(0);
    const mass = fluid.totalMass(10, 0, -5, 24, 8, 5);
    expect(mass).toBe(254);
  });

  it('wakes water when a chunk generates at the streaming frontier', () => {
    const world = new World(() => {});
    world.ensureChunk(0, 0, 0);
    const fluid = new FluidSim(world);
    world.setVoxel(15, 0, 0, STONE); // floor under the source
    placeSource(world, 15, 1, 0);
    fluid.settle();
    // x = 16 is unloaded: the source waits, holding its level.
    expect(fluid.levelAt(15, 1, 0)).toBe(255);
    expect(fluid.levelAt(16, 1, 0)).toBe(0);
    // The neighbor chunk appears; the source resumes flowing into it.
    world.ensureChunk(1, 0, 0);
    world.setVoxel(16, 0, 0, STONE); // floor in the new chunk
    fluid.settle();
    expect(fluid.levelAt(16, 1, 0)).toBeGreaterThan(0);
  });

  it('a frontier source sleeps instead of re-activating forever (regression)', () => {
    // The failing-write path must not re-activate the cell's neighborhood,
    // or every lake at the streaming edge churns the budget dry forever.
    const world = new World(() => {});
    world.ensureChunk(0, 1, 0); // only the source's own layer exists
    const fluid = new FluidSim(world);
    placeSource(world, 15, 16, 0); // gravity target (15,15,0) is unloaded
    fluid.settle();
    expect(fluid.activeCount).toBe(0);
    expect(fluid.levelAt(15, 16, 0)).toBe(255);

    // Same contract horizontally: side neighbors in unloaded chunks.
    const world2 = new World(() => {});
    world2.ensureChunk(0, 0, 0);
    const fluid2 = new FluidSim(world2);
    world2.setVoxel(15, 0, 15, STONE); // floor
    world2.setVoxel(14, 1, 15, STONE); // wall off the loaded -x side
    placeSource(world2, 15, 1, 15); // +x and +z sides are unloaded
    fluid2.settle();
    expect(fluid2.activeCount).toBe(0);
    expect(fluid2.levelAt(15, 1, 15)).toBe(255);
    // and it still resumes when the world arrives
    world2.ensureChunk(1, 0, 0);
    world2.ensureChunk(0, 0, 1);
    world2.setVoxel(16, 0, 15, STONE);
    world2.setVoxel(15, 0, 16, STONE);
    fluid2.settle();
    expect(fluid2.levelAt(16, 1, 15)).toBeGreaterThan(0);
    expect(fluid2.levelAt(15, 1, 16)).toBeGreaterThan(0);
  });
});

describe('sources', () => {
  it('a source keeps supplying and creates mass below', () => {
    const world = basinWorld(2, 1);
    const fluid = new FluidSim(world);
    world.setVoxel(1, 1, 1, STONE); // pillar inside the basin
    placeSource(world, 1, 2, 1); // source on the pillar
    fluid.settle(1200);
    const basinMass = fluid.totalMass(-2, 1, -2, 2, 4, 2);
    expect(basinMass).toBeGreaterThan(0);
    expect(fluid.isSource(1, 2, 1)).toBe(true);
    expect(fluid.levelAt(1, 2, 1)).toBe(255);
  });

  it('removing the source removes exactly the source mass', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    placeSource(world, 0, 1, 0);
    fluid.settle();
    const massWithSource = fluid.totalMass(-3, 0, -3, 3, 8, 3);
    expect(massWithSource).toBeGreaterThan(255); // the source flooded
    world.setVoxel(0, 1, 0, AIR);
    fluid.settle();
    // The source is gone; neighbors may refill the cell with their own
    // mass, but nothing else may appear or vanish.
    expect(fluid.isSource(0, 1, 0)).toBe(false);
    const massAfter = fluid.totalMass(-3, 0, -3, 3, 8, 3);
    expect(massAfter).toBe(massWithSource - 255);
  });
});

describe('sleep / wake', () => {
  it('the active set empties at rest and tick becomes a no-op', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 4, 0, 200]]);
    fluid.settle();
    expect(fluid.activeCount).toBe(0);
    expect(fluid.tick()).toBe(0);
  });

  it('an external edit wakes the neighborhood', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [
      [0, 1, 0, 100],
      [1, 1, 0, 100],
    ]);
    fluid.settle();
    expect(fluid.activeCount).toBe(0);
    world.setVoxel(2, 1, 0, AIR); // no-op write, but must wake the sim
    expect(fluid.activeCount).toBeGreaterThan(0);
    world.setVoxel(2, 0, 0, AIR); // open a drain through the floor
    fluid.settle();
    expect(fluid.levelAt(2, 0, 0) + fluid.levelAt(2, 1, 0)).toBeGreaterThan(0);
  });

  it('tick respects the budget', () => {
    const world = emptyWorld();
    const fluid = new FluidSim(world);
    // Two full layers of falling water: ~900 active cells, no floor.
    const cells: [number, number, number, number][] = [];
    for (let y = 1; y <= 2; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) cells.push([x, y, z, 200]);
      }
    }
    seedFlowing(world, fluid, cells);
    expect(fluid.activeCount).toBeGreaterThan(384);
    expect(fluid.tick(384)).toBe(384);
    expect(fluid.tick(10)).toBe(10);
  });
});

describe('displacement and persistence', () => {
  it('filling a water cell with a solid clears its level', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 1, 0, 150]]);
    world.setVoxel(0, 1, 0, STONE);
    expect(fluid.levelAt(0, 1, 0)).toBe(0);
    expect(world.getVoxel(0, 1, 0)).toBe(STONE);
  });

  it('level state round-trips through export/load', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [
      [0, 1, 0, 137],
      [1, 1, 0, 42],
    ]);
    placeSource(world, -1, 1, 0);
    const exported = fluid.exportLevels();

    // The real load path restores WATER materials (edit journal) before
    // levels are overlaid; mirror that here.
    const world2 = basinWorld();
    const fluid2 = new FluidSim(world2);
    for (const [x, y, z] of [
      [0, 1, 0],
      [1, 1, 0],
      [-1, 1, 0],
    ] as const) {
      world2.setVoxel(x, y, z, WATER);
    }
    fluid2.loadLevels(exported);
    expect(fluid2.levelAt(0, 1, 0)).toBe(137);
    expect(fluid2.levelAt(1, 1, 0)).toBe(42);
    // Source = plain WATER material, deliberately absent from the map.
    expect(fluid2.isSource(-1, 1, 0)).toBe(true);
  });

  it('levels apply to chunks that generate later', () => {
    const world = new World(() => {});
    const fluid = new FluidSim(world);
    fluid.loadLevels({ '0,0,0': [[volumeIndex(3, 1, 3), 99]] });
    expect(fluid.levelAt(3, 1, 3)).toBe(0); // chunk not loaded yet
    world.ensureChunk(0, 0, 0);
    world.getChunk(0, 0, 0)!.volume.set(3, 1, 3, WATER); // journal replay
    expect(fluid.levelAt(3, 1, 3)).toBe(99);
  });

  it('invalid levels are skipped on load (saves validate upstream)', () => {
    const world = emptyWorld();
    const fluid = new FluidSim(world);
    // Entries 0/255/-1 are invalid (255 is the no-entry source default);
    // loadLevels skips them rather than fabricating flowing water.
    fluid.loadLevels({
      '0,0,0': [
        [volumeIndex(0, 0, 0), 0],
        [volumeIndex(1, 0, 0), 255],
        [volumeIndex(2, 0, 0), 254],
        [volumeIndex(3, 0, 0), -1],
      ],
    });
    for (const x of [0, 1, 2, 3]) world.setVoxel(x, 0, 0, WATER);
    expect(fluid.levelAt(0, 0, 0)).toBe(255); // no entry → source default
    expect(fluid.levelAt(1, 0, 0)).toBe(255);
    expect(fluid.levelAt(2, 0, 0)).toBe(254); // the only valid entry
    expect(fluid.levelAt(3, 0, 0)).toBe(255);
  });
});

describe('determinism', () => {
  it('the same scenario settles to identical state', () => {
    const run = (): Record<string, unknown> => {
      const world = basinWorld(4, 6);
      const fluid = new FluidSim(world);
      seedFlowing(world, fluid, [
        [-2, 3, -1, 250],
        [0, 5, 1, 120],
        [1, 2, 2, 90],
      ]);
      fluid.settle();
      return fluid.exportLevels();
    };
    expect(run()).toEqual(run());
  });
});

describe('sim wiring', () => {
  it('reports dirtiness for the autosave gate', () => {
    const world = basinWorld();
    const fluid = new FluidSim(world);
    seedFlowing(world, fluid, [[0, 4, 0, 200]]);
    fluid.takeDirty(); // clear (seeding may have marked dirty)
    fluid.settle();
    expect(fluid.takeDirty()).toBe(true);
    expect(fluid.takeDirty()).toBe(false);
  });
});
