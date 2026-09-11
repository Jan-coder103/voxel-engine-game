import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { STONE, WATER } from '../src/voxel/materials';
import { DEFAULT_TERRAIN, findSpawn, generateChunk } from '../src/voxel/terrain';
import {
  findPath,
  MAX_DROP,
  nearestWalkable,
  pathTouches,
  terrainNavQuery,
  type NavCell,
  type NavQuery,
} from '../src/npc/navigation';

/**
 * Navigation fixtures (Phase 12). Tiny worlds are heightmaps: solid
 * columns fill y < h(x, z), with optional wall/water overrides. A cell is
 * walkable exactly at its column height.
 */

function heightmapQuery(
  height: (x: number, z: number) => number,
  overrides: { walls?: Set<string>; water?: Set<string> } = {},
): NavQuery {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const solid = (x: number, y: number, z: number) => {
    if (overrides.walls?.has(key(x, y, z))) return true;
    return y < height(x, z);
  };
  const water = (x: number, y: number, z: number) => overrides.water?.has(key(x, y, z)) ?? false;
  const open = (x: number, y: number, z: number) => !solid(x, y, z) && !water(x, y, z);
  return {
    open,
    walkable(x, y, z) {
      return y > 0 && open(x, y, z) && open(x, y + 1, z) && solid(x, y - 1, z);
    },
  };
}

const flat = (h: number) => heightmapQuery(() => h);

function cellKey(c: NavCell): string {
  return `${c.x},${c.y},${c.z}`;
}

/** True when steps are adjacent horizontal moves with a legal vertical step. */
function expectLegalSteps(cells: readonly NavCell[]): void {
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const manhattan = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
    expect(manhattan, `step ${i - 1}→${i}`).toBe(1);
    expect(b.y - a.y, `step ${i - 1}→${i} dy`).toBeLessThanOrEqual(1);
    expect(b.y - a.y, `step ${i - 1}→${i} dy`).toBeGreaterThanOrEqual(-MAX_DROP);
  }
}

describe('navigation: walkability + anchoring', () => {
  it('nearestWalkable returns the cell itself when walkable', () => {
    const q = flat(8);
    expect(nearestWalkable(q, 3, 8, 3)).toEqual({ x: 3, y: 8, z: 3 });
  });

  it('nearestWalkable finds a nearby stand when the cell is mid-air or buried', () => {
    const q = flat(8);
    const inAir = nearestWalkable(q, 3, 12, 3);
    expect(inAir?.y).toBe(8);
    const buried = nearestWalkable(q, 3, 5, 3);
    expect(buried?.y).toBe(8);
  });

  it('nearestWalkable gives up inside solid with no stand in range', () => {
    const q = heightmapQuery(() => 30); // everything buried except a thin top
    expect(nearestWalkable(q, 0, 5, 0, 2)).toBeUndefined();
  });

  it('terrainNavQuery marks solid ground walkable and water not open', () => {
    const world = new World((chunk) => {
      const o = chunk.origin;
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++)
          for (let y = 0; y < 16; y++)
            chunk.volume.set(x, y, z, y <= 4 ? (y === 4 && o.x + x === 5 ? WATER : STONE) : 0);
    });
    world.ensureChunk(0, 0, 0);
    const q = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
    expect(q.walkable(0, 5, 0)).toBe(true);
    expect(q.walkable(0, 6, 0)).toBe(false); // no floor
    expect(q.open(5, 4, 0)).toBe(false); // water is not open
    expect(q.walkable(5, 5, 0)).toBe(false); // standing IN water refused
  });
});

describe('navigation: A*', () => {
  it('returns an empty path when start equals goal', () => {
    const q = flat(8);
    expect(findPath(q, { x: 2, y: 8, z: 2 }, { x: 2, y: 8, z: 2 })?.cells).toEqual([]);
  });

  it('refuses a goal that is not walkable', () => {
    const q = flat(8);
    expect(findPath(q, { x: 2, y: 8, z: 2 }, { x: 2, y: 20, z: 2 })).toBeUndefined();
  });

  it('paths in a straight line over flat ground with all cells walkable', () => {
    const q = flat(8);
    const result = findPath(q, { x: 0, y: 8, z: 0 }, { x: 5, y: 8, z: 3 });
    expect(result).toBeDefined();
    const cells = result!.cells;
    expect(cells[cells.length - 1]).toEqual({ x: 5, y: 8, z: 3 });
    expect(cells.length).toBeLessThanOrEqual(8); // optimal Manhattan distance
    for (const c of cells) expect(q.walkable(c.x, c.y, c.z)).toBe(true);
    expectLegalSteps(cells);
  });

  it('routes around a wall through the gap', () => {
    // Two-high wall row at z=0 (x=0..5 except the gap at x=2): too tall to
    // step onto, so the only route threads through the gap.
    const walls = new Set<string>();
    for (let x = 0; x <= 5; x++) {
      if (x === 2) continue;
      walls.add(`${x},8,0`);
      walls.add(`${x},9,0`);
    }
    const q = heightmapQuery(() => 8, { walls });
    const result = findPath(q, { x: 0, y: 8, z: 2 }, { x: 5, y: 8, z: -2 });
    expect(result).toBeDefined();
    for (const c of result!.cells) {
      expect(q.walkable(c.x, c.y, c.z)).toBe(true); // never inside the wall
    }
    // The only opening is the gap — the path must thread through it.
    expect(result!.cells.some((c) => c.x === 2 && c.z === 0)).toBe(true);
  });

  it('fails when the goal is fully walled off', () => {
    // Goal enclosed by a full 3-high ring on a flat plane (the goal's own
    // column stays open so the goal itself is walkable).
    const ring = new Set<string>();
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      for (let dy = 0; dy < 3; dy++) ring.add(`${10 + dx},${8 + dy},${10 + dz}`);
    }
    const q = heightmapQuery(() => 8, { walls: ring });
    expect(q.walkable(10, 8, 10)).toBe(true);
    expect(findPath(q, { x: 0, y: 8, z: 0 }, { x: 10, y: 8, z: 10 })).toBeUndefined();
  });

  it('climbs single steps but not two-high ledges', () => {
    const q = heightmapQuery((x) => (x >= 4 ? 9 : 8));
    const up = findPath(q, { x: 0, y: 8, z: 0 }, { x: 6, y: 9, z: 0 });
    expect(up).toBeDefined();
    const q2 = heightmapQuery((x) => (x >= 4 ? 10 : 8));
    expect(findPath(q2, { x: 0, y: 8, z: 0 }, { x: 6, y: 10, z: 0 })).toBeUndefined();
  });

  it('drops up to MAX_DROP and refuses deeper cliffs', () => {
    const q = heightmapQuery((x) => (x >= 4 ? 6 : 8)); // drop of 2
    const down = findPath(q, { x: 0, y: 8, z: 0 }, { x: 6, y: 6, z: 0 });
    expect(down).toBeDefined();
    expectLegalSteps(down!.cells);
    const deep = heightmapQuery((x) => (x >= 4 ? 4 : 8)); // drop of 4 > MAX_DROP
    expect(findPath(deep, { x: 0, y: 8, z: 0 }, { x: 6, y: 4, z: 0 })).toBeUndefined();
  });

  it('refuses a deep drop whose lip is overhung (no clipping through columns)', () => {
    // Bespoke sealed fixture: from the start, the only legal-looking move
    // is a drop of 3 onto (1,5,0) — but the drop shaft is sealed at y=6/7
    // (overhang), so the lip-clearance rule must refuse it. Every other
    // neighbor is unwalkable, so the search exhausts.
    const q: NavQuery = {
      open: (x, y, z) => {
        if (x === 0 && y === 8 && z === 0) return true;
        if (x === 1 && z === 0) return y === 5; // shaft below the lip blocked
        return false;
      },
      walkable: (x, y, z) => (x === 0 && y === 8 && z === 0) || (x === 1 && y === 5 && z === 0),
    };
    expect(findPath(q, { x: 0, y: 8, z: 0 }, { x: 1, y: 5, z: 0 })).toBeUndefined();
    // Sanity: with the shaft open the same drop is legal.
    const clear: NavQuery = {
      open: (x, y, z) => {
        if (x === 0 && y === 8 && z === 0) return true;
        if (x === 1 && z === 0) return y === 5 || y === 6 || y === 7;
        return false;
      },
      walkable: (x, y, z) => (x === 0 && y === 8 && z === 0) || (x === 1 && y === 5 && z === 0),
    };
    expect(findPath(clear, { x: 0, y: 8, z: 0 }, { x: 1, y: 5, z: 0 })).toBeDefined();
  });

  it('never paths through water; crosses at the land bridge', () => {
    const water = new Set<string>();
    for (let x = 2; x <= 6; x++) water.add(`${x},8,0`);
    const q = heightmapQuery(() => 8, { water });
    const result = findPath(q, { x: 0, y: 8, z: 0 }, { x: 8, y: 8, z: 0 });
    // The direct line is flooded; the only land route is around it.
    expect(result).toBeDefined();
    for (const c of result!.cells) {
      expect(q.open(c.x, c.y, c.z)).toBe(true);
      expect(water.has(`${c.x},${c.y},${c.z}`)).toBe(false);
    }
  });

  it('respects the expansion budget instead of searching forever', () => {
    const q = flat(8);
    expect(
      findPath(q, { x: 0, y: 8, z: 0 }, { x: 60, y: 8, z: 60 }, { maxExpansions: 8 }),
    ).toBeUndefined();
    expect(
      findPath(q, { x: 0, y: 8, z: 0 }, { x: 60, y: 8, z: 60 }, { maxCost: 30 }),
    ).toBeUndefined();
  });

  it('is deterministic: identical fixture, identical path', () => {
    const make = () => heightmapQuery((x, z) => 8 + ((x * 7 + z * 3) % 3 === 0 ? 1 : 0));
    const a = findPath(make(), { x: 0, y: 8, z: 0 }, { x: 12, y: 9, z: 9 });
    const b = findPath(make(), { x: 0, y: 8, z: 0 }, { x: 12, y: 9, z: 9 });
    expect(a).toBeDefined();
    expect(a!.cells.map(cellKey)).toEqual(b!.cells.map(cellKey));
  });
});

describe('navigation: path invalidation helper', () => {
  it('pathTouches hits path cells and their floors, misses elsewhere', () => {
    const cells: NavCell[] = [
      { x: 3, y: 8, z: 0 },
      { x: 4, y: 8, z: 0 },
    ];
    expect(pathTouches(cells, 4, 8, 0)).toBe(true);
    expect(pathTouches(cells, 3, 7, 0)).toBe(true); // floor under a path cell
    expect(pathTouches(cells, 4, 9, 0)).toBe(false);
    expect(pathTouches(cells, 6, 8, 0)).toBe(false);
  });
});

describe('navigation: real terrain', () => {
  it('finds a legal short path near spawn on generated terrain', () => {
    const world = new World((chunk) => generateChunk(chunk, DEFAULT_TERRAIN));
    const spawn = findSpawn(DEFAULT_TERRAIN);
    const cx = Math.floor(spawn.x / 16);
    const cz = Math.floor(spawn.z / 16);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) world.ensureChunk(cx + dx, 0, cz + dz);

    const q = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
    const start = nearestWalkable(q, Math.floor(spawn.x), Math.round(spawn.y), Math.floor(spawn.z));
    expect(start).toBeDefined();

    // Seek a reachable goal 6–10 cells away (terrain may have cliffs/water).
    let found: NavCell[] | undefined;
    for (let r = 6; r <= 10 && !found; r++) {
      for (const [dx, dz] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
        [r, r],
      ]) {
        const goal = nearestWalkable(q, start!.x + dx, start!.y, start!.z + dz, 2);
        if (!goal) continue;
        const result = findPath(q, start!, goal);
        if (result) {
          found = result.cells;
          break;
        }
      }
    }
    expect(found).toBeDefined();
    for (const c of found!) expect(q.walkable(c.x, c.y, c.z)).toBe(true);
    expectLegalSteps(found!);
  });
});
