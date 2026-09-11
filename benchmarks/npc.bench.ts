import { bench, describe } from 'vitest';
import { World } from '../src/voxel/world';
import { STONE } from '../src/voxel/materials';
import { DEFAULT_TERRAIN, findSpawn, generateChunk } from '../src/voxel/terrain';
import { terrainNavQuery, nearestWalkable, findPath } from '../src/npc/navigation';
import { NpcSim } from '../src/npc/npc';

/**
 * NPC baselines (Phase 12). The gates: a typical A* re-path must be
 * well under a millisecond (main budgets 3 decisions per fixed step),
 * and a full population tick must be far below the 16 ms frame. Worlds
 * are built once outside the timed body.
 */

/** Real seeded terrain around spawn, 7×2×7 chunks (~112 m across). */
function terrainWorld(): { world: World; spawn: { x: number; y: number; z: number } } {
  const world = new World((chunk) => generateChunk(chunk, DEFAULT_TERRAIN));
  const spawn = findSpawn(DEFAULT_TERRAIN);
  const cx0 = Math.floor(spawn.x / 16);
  const cz0 = Math.floor(spawn.z / 16);
  for (let cy = 0; cy < 2; cy++) {
    for (let cz = cz0 - 3; cz <= cz0 + 3; cz++) {
      for (let cx = cx0 - 3; cx <= cx0 + 3; cx++) world.ensureChunk(cx, cy, cz);
    }
  }
  return { world, spawn };
}

describe('npc navigation', () => {
  const { world, spawn } = terrainWorld();
  const query = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
  const start = nearestWalkable(
    query,
    Math.floor(spawn.x),
    Math.round(spawn.y),
    Math.floor(spawn.z),
  )!;

  // A mid-distance goal ~24 cells east, anchored to walkable ground.
  const goal = nearestWalkable(query, start.x + 24, start.y, start.z, 6)!;

  bench('GATE: mid-distance re-path on real terrain (~24 cells)', () => {
    findPath(query, start, goal);
  });

  // Worst case: a walkable goal sealed inside a 3-high wall ring ~12 away
  // — the search only exhausts after flooding the whole reachable area.
  const sealed = nearestWalkable(query, start.x + 12, start.y, start.z, 6)!;
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
    for (let dy = 0; dy < 3; dy++) {
      world.setVoxel(sealed.x + dx, sealed.y + dy, sealed.z + dz, STONE);
    }
  }
  bench('worst case: sealed goal (floods the whole budget, unreachable)', () => {
    findPath(query, start, sealed);
  });

  bench('nearestWalkable anchor scan (r=6)', () => {
    nearestWalkable(query, start.x + 3, start.y + 3, start.z + 3, 6);
  });
});

describe('npc simulation', () => {
  const { world } = terrainWorld();
  const center = {
    x: Math.round(findSpawn(DEFAULT_TERRAIN).x),
    z: Math.round(findSpawn(DEFAULT_TERRAIN).z),
  };

  function populatedSim(count: number): NpcSim {
    const sim = new NpcSim(world, DEFAULT_TERRAIN.seed, { population: count });
    // Warm up: spawn + settle into schedule/wander activity.
    for (let i = 0; i < 600; i++) sim.tick(center);
    return sim;
  }

  const full = populatedSim(16);

  bench('GATE: full population tick (16 wandering NPCs)', () => {
    full.tick(center);
  });

  const sparse = populatedSim(4);
  bench('sparse population tick (4 NPCs, mostly idle)', () => {
    sparse.tick(center);
  });
});
