import { bench, describe } from 'vitest';
import { Chunk } from '../src/voxel/chunk';
import { DEFAULT_TERRAIN, generateChunk, heightAt, type TerrainParams } from '../src/voxel/terrain';
import { applyTown, planAt, townStats, TOWN_RADIUS } from '../src/worldgen/town';

const TERRAIN: TerrainParams = { ...DEFAULT_TERRAIN, seed: 1337 };

function chunkAt(cx: number, cz: number): Chunk {
  return new Chunk({ x: cx, y: 0, z: cz });
}

describe('town generation', () => {
  bench('applyTown: town-center chunk (roads + buildings)', () => {
    const chunk = chunkAt(0, 0);
    generateChunk(chunk, TERRAIN);
    applyTown(chunk, TERRAIN);
  });

  bench('applyTown: outskirts chunk (roads + wild trees)', () => {
    const chunk = chunkAt(6, 0);
    generateChunk(chunk, TERRAIN);
    applyTown(chunk, TERRAIN);
  });

  bench('applyTown: wild chunk (outside the town square)', () => {
    const chunk = chunkAt(8, 8);
    generateChunk(chunk, TERRAIN);
    applyTown(chunk, TERRAIN);
  });

  bench('planAt 256 columns (one chunk footprint)', () => {
    let roads = 0;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if (planAt(x, z, TERRAIN).kind === 'road') roads++;
      }
    }
    if (roads < 0) throw new Error('unreachable');
  });

  bench('town census (allLots + viability, ~256 lots)', () => {
    const stats = townStats(TERRAIN);
    if (stats.houses < 0) throw new Error('unreachable');
  });

  bench('spawn search from origin', () => {
    const spawn = { x: 0, z: 0 };
    void spawn;
    // Mirrors findTownSpawn's typical cost: a few plan lookups.
    let n = 0;
    for (let r = 0; r < 3; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (heightAt(dx, dz, TERRAIN) > TERRAIN.seaLevel) n++;
        }
      }
    }
    if (n > TOWN_RADIUS) throw new Error('unreachable');
  });
});
