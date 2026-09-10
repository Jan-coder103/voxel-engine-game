import { bench, describe } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, STONE, WOOD } from '../src/voxel/materials';
import { DEFAULT_TERRAIN, findSpawn, generateChunk } from '../src/voxel/terrain';
import { StructuralSim, analyzeStructure, structureRegionFor } from '../src/voxel/structure';

/**
 * Structural baselines (Phase 11). The gate: one analysis after a
 * house-scale edit must stay under 5 ms (plan §109), on real terrain,
 * including the full-height column scan. Worlds are built once outside
 * the timed body; each bench times one analysis (or one full cascade).
 */

/** Real seeded terrain around spawn, 5×2×5 chunks. */
function terrainWorld(): { world: World; spawn: { x: number; y: number; z: number } } {
  const world = new World((chunk) => generateChunk(chunk, DEFAULT_TERRAIN));
  const spawn = findSpawn(DEFAULT_TERRAIN);
  const cx0 = Math.floor(spawn.x / 16);
  const cz0 = Math.floor(spawn.z / 16);
  for (let cy = 0; cy < 2; cy++) {
    for (let cz = cz0 - 2; cz <= cz0 + 2; cz++) {
      for (let cx = cx0 - 2; cx <= cx0 + 2; cx++) world.ensureChunk(cx, cy, cz);
    }
  }
  return { world, spawn };
}

/** A 9×9 stone pavilion roof on four wood pillars, standing on the surface. */
function buildHouse(world: World, x0: number, z0: number, ground: number): void {
  const top = ground + 5;
  for (const [dx, dz] of [
    [0, 0],
    [8, 0],
    [0, 8],
    [8, 8],
  ]) {
    for (let y = ground; y < top; y++) world.setVoxel(x0 + dx, y, z0 + dz, WOOD);
  }
  for (let x = x0; x <= x0 + 8; x++) {
    for (let z = z0; z <= z0 + 8; z++) world.setVoxel(x, top, z, STONE);
  }
}

function surfaceTop(world: World, x: number, z: number): number {
  for (let y = 31; y >= 0; y--) {
    if (world.getVoxel(x, y, z) !== AIR) return y + 1;
  }
  return 1;
}

describe('structure', () => {
  const { world: houseWorld, spawn } = terrainWorld();
  const hx = Math.round(spawn.x) + 4;
  const hz = Math.round(spawn.z) + 4;
  const ground = surfaceTop(houseWorld, hx, hz);
  buildHouse(houseWorld, hx, hz, ground);
  const houseRegion = structureRegionFor({
    min: { x: hx, y: ground, z: hz },
    max: { x: hx, y: ground, z: hz },
  });

  bench('GATE: house-scale analysis on real terrain (single edit, 25×32×25)', () => {
    analyzeStructure(houseWorld, houseRegion);
  });

  const stoneWorld = new World((chunk) => chunk.volume.fill(STONE));
  for (let cy = 0; cy < 2; cy++) {
    for (let cz = 0; cz < 3; cz++) {
      for (let cx = 0; cx < 3; cx++) stoneWorld.ensureChunk(cx, cy, cz);
    }
  }
  const solidRegion = structureRegionFor({
    min: { x: 24, y: 16, z: 24 },
    max: { x: 24, y: 16, z: 24 },
  });

  bench('worst case: fully solid stone region (every cell is BFS work)', () => {
    analyzeStructure(stoneWorld, solidRegion);
  });

  const brushRegion = structureRegionFor({
    min: { x: hx - 8, y: ground, z: hz - 8 },
    max: { x: hx + 8, y: ground + 16, z: hz + 8 },
  });

  bench('large brush-delete region on real terrain (41×32×41 ≈ 54k cells)', () => {
    analyzeStructure(houseWorld, brushRegion);
  });

  const { world: towerWorld, spawn: ts } = terrainWorld();
  const tx = Math.round(ts.x) + 3;
  const tz = Math.round(ts.z) - 3;
  const tg = surfaceTop(towerWorld, tx, tz);
  for (let y = tg; y < tg + 24 && y < 31; y++) towerWorld.setVoxel(tx, y, tz, WOOD);
  const towerRegion = structureRegionFor({
    min: { x: tx, y: tg, z: tz },
    max: { x: tx, y: tg, z: tz },
  });

  bench('overstress analysis: 24-tall wood tower on terrain', () => {
    analyzeStructure(towerWorld, towerRegion);
  });

  // One world + one sim reused across iterations (a fresh sim per run
  // would chain another hook onto the world each time). Placements never
  // queue analyses, so rebuilding the house is free of structural work;
  // the timed body is ~100 rebuild writes + 15 removals + the cascade.
  const { world: scenarioWorld, spawn: s } = terrainWorld();
  const sx0 = Math.round(s.x) + 4;
  const sz0 = Math.round(s.z) + 4;
  const sg = surfaceTop(scenarioWorld, sx0, sz0);
  const scenarioSim = new StructuralSim(scenarioWorld);
  scenarioSim.onCollapse = (event) => {
    for (const cell of event.cells) scenarioWorld.setVoxel(cell.x, cell.y, cell.z, AIR);
  };

  bench('scenario: knock out a pillar → full cascade to rest (sim + edits)', () => {
    buildHouse(scenarioWorld, sx0, sz0, sg);
    // Remove three of four pillars: the roof cantilevers off the last one.
    for (const [dx, dz] of [
      [8, 0],
      [0, 8],
      [8, 8],
    ]) {
      for (let y = sg; y < sg + 5; y++) scenarioWorld.setVoxel(sx0 + dx, y, sz0 + dz, AIR);
    }
    scenarioSim.settle(16);
    // Reset for the next iteration: strip the fallen roof back to air.
    for (let x = sx0; x <= sx0 + 8; x++) {
      for (let z = sz0; z <= sz0 + 8; z++) {
        if (scenarioWorld.getVoxel(x, sg + 5, z) !== AIR) {
          scenarioWorld.setVoxel(x, sg + 5, z, AIR);
        }
      }
    }
    scenarioSim.reset();
  });
});
