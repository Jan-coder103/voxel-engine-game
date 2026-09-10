import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, STONE, WATER } from '../src/voxel/materials';
import { checkSupport, supportRegionFor, SUPPORT_MARGIN } from '../src/voxel/support';

function world(): World {
  const w = new World((chunk) => {
    // Bedrock floor like the real generator: solid at y=0.
    for (let z = 0; z < chunk.volume.size; z++) {
      for (let x = 0; x < chunk.volume.size; x++) chunk.volume.set(x, 0, z, STONE);
    }
  });
  for (let cy = 0; cy < 2; cy++) {
    for (let cz = 0; cz < 3; cz++) {
      for (let cx = 0; cx < 3; cx++) w.ensureChunk(cx, cy, cz);
    }
  }
  return w;
}

/** A 13×9 roof at y=6 on two 1×5 pillars at (6,8) and (12,8). */
function buildPavilion(w: World): void {
  for (const x of [6, 12]) {
    for (let y = 1; y <= 5; y++) w.setVoxel(x, y, 8, STONE);
  }
  for (let x = 4; x <= 16; x++) {
    for (let z = 4; z <= 12; z++) w.setVoxel(x, 6, z, STONE);
  }
}

describe('checkSupport', () => {
  it('a roof on intact pillars is fully supported', () => {
    const w = world();
    buildPavilion(w);
    const result = checkSupport(
      (x, y, z) => w.getVoxel(x, y, z),
      supportRegionFor({ min: { x: 6, y: 4, z: 7 }, max: { x: 12, y: 4, z: 9 } }),
    );
    expect(result.checked).toBe(true);
    expect(result.unsupported).toHaveLength(0);
  });

  it('removing the pillars leaves only the roof unsupported', () => {
    const w = world();
    buildPavilion(w);
    for (const x of [6, 12]) {
      for (let y = 1; y <= 5; y++) w.setVoxel(x, y, 8, AIR);
    }
    const result = checkSupport(
      (x, y, z) => w.getVoxel(x, y, z),
      supportRegionFor({ min: { x: 6, y: 1, z: 7 }, max: { x: 12, y: 4, z: 9 } }),
    );
    expect(result.checked).toBe(true);
    const roofCells = result.unsupported.filter((c) => c.y === 6);
    expect(roofCells.length).toBe(117); // the full 13×9 slab
    // Nothing at pillar height falls (the pillars are gone, i.e. air).
    expect(result.unsupported.some((c) => c.y < 6)).toBe(false);
    // Every reported cell is part of the 13×9 roof slab.
    for (const cell of roofCells) {
      expect(cell.x).toBeGreaterThanOrEqual(4);
      expect(cell.x).toBeLessThanOrEqual(16);
      expect(cell.z).toBeGreaterThanOrEqual(4);
      expect(cell.z).toBeLessThanOrEqual(12);
    }
  });

  it('a roof attached to a standing pillar stays supported', () => {
    const w = world();
    buildPavilion(w);
    for (let y = 1; y <= 5; y++) w.setVoxel(12, y, 8, AIR); // only x=6 pillar remains
    const result = checkSupport(
      (x, y, z) => w.getVoxel(x, y, z),
      supportRegionFor({ min: { x: 6, y: 1, z: 7 }, max: { x: 12, y: 4, z: 9 } }),
    );
    expect(result.unsupported).toHaveLength(0);
  });

  it('the terrain floor itself is anchored through the bedrock', () => {
    const w = new World((chunk) => chunk.volume.fill(STONE));
    w.ensureChunk(0, 0, 0);
    const result = checkSupport(
      (x, y, z) => w.getVoxel(x, y, z),
      supportRegionFor({ min: { x: 4, y: 2, z: 4 }, max: { x: 10, y: 2, z: 10 } }),
    );
    expect(result.unsupported).toHaveLength(0);
  });

  it('water and air never fall', () => {
    const w = world();
    // Suspended water block with nothing under it.
    w.setVoxel(8, 10, 8, WATER);
    const result = checkSupport(
      (x, y, z) => w.getVoxel(x, y, z),
      supportRegionFor({ min: { x: 8, y: 10, z: 8 }, max: { x: 8, y: 10, z: 8 } }),
    );
    expect(result.unsupported).toHaveLength(0);
  });

  it('cells touching the region boundary are assumed anchored', () => {
    const w = world();
    w.setVoxel(20, 8, 20, STONE); // lone block exactly at the region max edge
    const result = checkSupport((x, y, z) => w.getVoxel(x, y, z), {
      min: { x: 16, y: 0, z: 16 },
      max: { x: 20, y: 12, z: 20 },
    });
    expect(result.unsupported).toHaveLength(0);
  });

  it('skips regions above the scan budget', () => {
    const w = world();
    const result = checkSupport(
      (x, y, z) => w.getVoxel(x, y, z),
      { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 60, z: 100 } },
      1000,
    );
    expect(result.checked).toBe(false);
    expect(result.unsupported).toHaveLength(0);
    expect(result.scanned).toBe(0);
  });

  it('the default region stays inside the scan budget for house-scale edits', () => {
    const affected = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
    const region = supportRegionFor(affected);
    const cells =
      (region.max.x - region.min.x + 1) *
      (region.max.y - region.min.y + 1) *
      (region.max.z - region.min.z + 1);
    expect(cells).toBeLessThanOrEqual(150_000);
    expect(SUPPORT_MARGIN).toBe(12);
  });
});
