import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, STONE, WATER, WOOD } from '../src/voxel/materials';
import { FireSim } from '../src/voxel/fire';
import {
  MAX_CANTILEVER,
  MAX_COLLAPSE_CELLS,
  STRUCTURE_MARGIN,
  StructuralSim,
  analyzeStructure,
  structureRegionFor,
  type CollapseEvent,
} from '../src/voxel/structure';

/**
 * Test world: a bedrock floor at WORLD y=0 (generator-written, so it is not
 * journaled — exactly the "natural terrain" case), plus an optional
 * natural stone column at (8, 8) spanning world y0..y1. Everything else
 * is placed through `setVoxel` (journaled, like player builds).
 */
function world(column?: { y0: number; y1: number }): World {
  const w = new World((chunk) => {
    const { x: ox, y: oy, z: oz } = chunk.origin;
    const size = chunk.volume.size;
    if (oy === 0) {
      for (let z = 0; z < size; z++) {
        for (let x = 0; x < size; x++) chunk.volume.set(x, 0, z, STONE);
      }
    }
    if (column && ox === 0 && oz === 0) {
      for (let wy = column.y0; wy <= column.y1; wy++) {
        if (wy >= oy && wy < oy + size) chunk.volume.set(8, wy - oy, 8, STONE);
      }
    }
  });
  for (let cy = 0; cy < 2; cy++) {
    for (let cz = 0; cz < 3; cz++) {
      for (let cx = 0; cx < 3; cx++) w.ensureChunk(cx, cy, cz);
    }
  }
  return w;
}

/** A 13×5 roof at y=6 on two 1×5 pillars at (6,8) and (12,8). */
function buildPavilion(w: World): void {
  for (const x of [6, 12]) {
    for (let y = 1; y <= 5; y++) w.setVoxel(x, y, 8, STONE);
  }
  for (let x = 4; x <= 16; x++) {
    for (let z = 6; z <= 10; z++) w.setVoxel(x, 6, z, STONE);
  }
}

const roofCells = 13 * 5;

describe('analyzeStructure — support', () => {
  it('a roof on intact pillars is fully supported', () => {
    const w = world();
    buildPavilion(w);
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 6, y: 1, z: 8 }, max: { x: 12, y: 6, z: 8 } }),
    );
    expect(result.checked).toBe(true);
    expect(result.unsupportedCount).toBe(0);
    expect(result.collapse).toHaveLength(0);
  });

  it('removing the pillars leaves the whole roof unsupported', () => {
    const w = world();
    buildPavilion(w);
    for (const x of [6, 12]) {
      for (let y = 1; y <= 5; y++) w.setVoxel(x, y, 8, AIR);
    }
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 6, y: 1, z: 8 }, max: { x: 12, y: 6, z: 8 } }),
    );
    expect(result.checked).toBe(true);
    expect(result.unsupportedCount).toBe(roofCells);
    // Every reported cell is part of the roof slab, at roof height.
    for (const cell of result.collapse) {
      expect(cell.y).toBe(6);
      expect(cell.x).toBeGreaterThanOrEqual(4);
      expect(cell.x).toBeLessThanOrEqual(16);
      expect(cell.z).toBeGreaterThanOrEqual(6);
      expect(cell.z).toBeLessThanOrEqual(10);
      expect(cell.stressed).toBe(false);
    }
  });

  it('one standing pillar holds only the roof within the cantilever limit', () => {
    const w = world();
    buildPavilion(w);
    for (let y = 1; y <= 5; y++) w.setVoxel(12, y, 8, AIR); // only x=6 remains
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 6, y: 1, z: 8 }, max: { x: 12, y: 6, z: 8 } }),
    );
    // Roof cells further than MAX_CANTILEVER groundless hops from the
    // remaining pillar drop; the near half stays up (cantilevered).
    const far = result.collapse.filter(
      (c) => Math.abs(c.x - 6) + Math.abs(c.z - 8) > MAX_CANTILEVER,
    );
    const near = result.collapse.filter(
      (c) => Math.abs(c.x - 6) + Math.abs(c.z - 8) <= MAX_CANTILEVER,
    );
    expect(far.length).toBe(26);
    expect(near).toHaveLength(0);
    expect(result.unsupportedCount).toBe(26);
  });

  it('the terrain floor itself is anchored through the bedrock', () => {
    const w = new World((chunk) => chunk.volume.fill(STONE));
    w.ensureChunk(0, 0, 0);
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 4, y: 2, z: 4 }, max: { x: 10, y: 2, z: 10 } }),
    );
    expect(result.unsupportedCount).toBe(0);
  });

  it('water and air never fall', () => {
    const w = world();
    // Suspended water block with nothing under it.
    w.setVoxel(8, 10, 8, WATER);
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 8, y: 10, z: 8 }, max: { x: 8, y: 10, z: 8 } }),
    );
    expect(result.unsupportedCount).toBe(0);
  });

  it('cells touching the region boundary are assumed anchored', () => {
    const w = world();
    w.setVoxel(20, 8, 20, STONE); // lone block exactly at the region max edge
    const result = analyzeStructure(w, {
      min: { x: 16, y: 0, z: 16 },
      max: { x: 20, y: 12, z: 20 },
    });
    expect(result.unsupportedCount).toBe(0);
  });

  it('skips regions above the scan budget', () => {
    const w = world();
    const result = analyzeStructure(
      w,
      { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 60, z: 100 } },
      1000,
    );
    expect(result.checked).toBe(false);
    expect(result.collapse).toHaveLength(0);
    expect(result.scanned).toBe(0);
  });

  it('the default region stays inside the scan budget for house-scale edits', () => {
    const affected = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
    const region = structureRegionFor(affected);
    const cells =
      (region.max.x - region.min.x + 1) *
      (region.max.y - region.min.y + 1) *
      (region.max.z - region.min.z + 1);
    expect(cells).toBeLessThanOrEqual(150_000);
    expect(STRUCTURE_MARGIN).toBe(12);
  });
});

describe('analyzeStructure — cantilever', () => {
  /** Solid wall column at x=0 (z=8) plus a plank bridge at y=6. */
  function bridge(w: World, length: number): void {
    for (let y = 0; y <= 10; y++) w.setVoxel(0, y, 8, STONE);
    for (let x = 1; x <= length; x++) w.setVoxel(x, 6, 8, STONE);
  }

  it(`a plank bridge up to ${MAX_CANTILEVER} long holds from the wall`, () => {
    const w = world();
    bridge(w, MAX_CANTILEVER);
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 0, y: 6, z: 8 }, max: { x: MAX_CANTILEVER, y: 6, z: 8 } }),
    );
    expect(result.unsupportedCount).toBe(0);
  });

  it('one plank too far drops exactly the tip', () => {
    const w = world();
    bridge(w, MAX_CANTILEVER + 1);
    const result = analyzeStructure(
      w,
      structureRegionFor({
        min: { x: 0, y: 6, z: 8 },
        max: { x: MAX_CANTILEVER + 1, y: 6, z: 8 },
      }),
    );
    expect(result.collapse).toEqual([{ x: MAX_CANTILEVER + 1, y: 6, z: 8, stressed: false }]);
  });
});

describe('analyzeStructure — stress', () => {
  it('a too-tall wood tower fractures at its base when disturbed', () => {
    const w = world();
    for (let y = 1; y <= 23; y++) w.setVoxel(8, y, 8, WOOD);
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 8, y: 1, z: 8 }, max: { x: 8, y: 23, z: 8 } }),
    );
    expect(result.unsupportedCount).toBe(0);
    expect(result.overstressedCount).toBe(1); // only the base carries 23 > 22
    expect(result.collapse).toEqual([{ x: 8, y: 1, z: 8, stressed: true }]);
  });

  it('natural terrain never overstresses, even in tall columns', () => {
    // A natural 25-tall stone column — generator-written, not journaled.
    const w = world({ y0: 1, y1: 25 });
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 8, y: 1, z: 8 }, max: { x: 8, y: 25, z: 8 } }),
    );
    expect(result.unsupportedCount).toBe(0);
    expect(result.overstressedCount).toBe(0);
  });

  it('load counts overlying terrain: a wood post propping a heavy slab fails', () => {
    // A natural stone column y=2..30 (29 cells) resting on the player's post.
    const w = world({ y0: 2, y1: 30 });
    w.setVoxel(8, 1, 8, WOOD);
    const result = analyzeStructure(
      w,
      structureRegionFor({ min: { x: 8, y: 1, z: 8 }, max: { x: 8, y: 30, z: 8 } }),
    );
    // The post carries 30 > 22 and fractures; the natural stone above it
    // is exempt from stress and only falls once the post is gone.
    expect(result.unsupportedCount).toBe(0);
    expect(result.overstressedCount).toBe(1);
    expect(result.collapse).toEqual([{ x: 8, y: 1, z: 8, stressed: true }]);
  });

  it('progressive cascade: after the base fractures, the rest loses support', () => {
    const w = world();
    for (let y = 1; y <= 23; y++) w.setVoxel(8, y, 8, WOOD);
    const region = structureRegionFor({
      min: { x: 8, y: 1, z: 8 },
      max: { x: 8, y: 23, z: 8 },
    });
    const first = analyzeStructure(w, region);
    expect(first.collapse).toEqual([{ x: 8, y: 1, z: 8, stressed: true }]);
    // Apply the fracture the way the game layer does, then re-analyze.
    for (const cell of first.collapse) w.setVoxel(cell.x, cell.y, cell.z, AIR);
    const second = analyzeStructure(w, region);
    expect(second.overstressedCount).toBe(0);
    expect(second.unsupportedCount).toBe(22); // the whole upper tower
  });
});

describe('StructuralSim', () => {
  const collect = (): { events: CollapseEvent[]; sim: StructuralSim; w: World } => {
    const w = world();
    const sim = new StructuralSim(w);
    const events: CollapseEvent[] = [];
    sim.onCollapse = (event) => {
      events.push(event);
      for (const cell of event.cells) w.setVoxel(cell.x, cell.y, cell.z, AIR);
    };
    return { events, sim, w };
  };

  it('placements never queue an analysis', () => {
    const { sim, w } = collect();
    w.setVoxel(8, 5, 8, STONE); // floating block — building freedom
    expect(sim.pendingCount).toBe(0);
  });

  it('water displacing air never queues an analysis', () => {
    const { sim, w } = collect();
    w.setVoxel(8, 5, 8, WATER); // air → water: no support lost
    expect(sim.pendingCount).toBe(0);
  });

  it('a removal queues a merged region and proposes the collapse', () => {
    const { events, sim, w } = collect();
    buildPavilion(w);
    // Remove both pillars: two writes, one merged region.
    for (const x of [6, 12]) {
      for (let y = 1; y <= 5; y++) w.setVoxel(x, y, 8, AIR);
    }
    expect(sim.pendingCount).toBe(1);
    expect(sim.tick(1)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].cells).toHaveLength(roofCells);
    expect(events[0].unsupportedCount).toBe(roofCells);
    // Applying the collapse re-queued the region; the next tick is quiet
    // (bedrock floor only — nothing left to fall).
    expect(sim.pendingCount).toBeGreaterThanOrEqual(1);
    sim.settle(8);
    expect(sim.collapseCount).toBe(1);
    for (let x = 4; x <= 16; x++) {
      for (let z = 6; z <= 10; z++) expect(w.getVoxel(x, 6, z)).toBe(AIR);
    }
  });

  it('staged collapse cascades across ticks', () => {
    const { events, sim, w } = collect();
    for (let y = 1; y <= 23; y++) w.setVoxel(8, y, 8, WOOD);
    w.setVoxel(8, 1, 9, STONE); // a neighbor block (placing never triggers)
    expect(sim.pendingCount).toBe(0);
    w.setVoxel(8, 1, 9, AIR); // ...but digging it out is the disturbance
    sim.settle(16);
    // Stage 1: base fractures under load. Stage 2: the upper tower falls.
    expect(events.length).toBeGreaterThanOrEqual(2);
    const allCells = events.flatMap((e) => e.cells);
    const fallen = allCells.filter((c) => c.z === 8 && c.y >= 1 && c.y <= 23);
    expect(fallen).toHaveLength(23);
    expect(events[0].cells[0]).toMatchObject({ x: 8, y: 1, z: 8, stressed: true });
    for (let y = 1; y <= 23; y++) expect(w.getVoxel(8, y, 8)).toBe(AIR);
  });

  it('truncates collapses past the cell cap and finishes via the cascade', () => {
    const { events, sim, w } = collect();
    // Chunk map first: writes into unloaded chunks would be refused.
    for (let cz = -1; cz <= 3; cz++) {
      for (let cx = -1; cx <= 3; cx++) w.ensureChunk(cx, 0, cz);
    }
    // A 43×43×3 floating slab: 5547 cells > the 4096 cap, and its scan
    // region (67×32×67 ≈ 144k) stays inside the default budget.
    for (let x = 0; x <= 42; x++) {
      for (let z = 0; z <= 42; z++) {
        for (let y = 10; y <= 12; y++) w.setVoxel(x, y, z, STONE);
      }
    }
    sim.queueRegion(
      structureRegionFor({ min: { x: 0, y: 10, z: 0 }, max: { x: 42, y: 12, z: 42 } }),
    );
    sim.tick(1);
    expect(events).toHaveLength(1);
    expect(events[0].cells).toHaveLength(MAX_COLLAPSE_CELLS);
    expect(sim.lastReport?.truncated).toBe(true);
    expect(sim.lastReport?.unsupportedCount).toBe(43 * 43 * 3);
    sim.settle(64);
    let left = 0;
    for (let x = 0; x <= 42; x++) {
      for (let z = 0; z <= 42; z++) {
        for (let y = 10; y <= 12; y++) if (w.getVoxel(x, y, z) !== AIR) left++;
      }
    }
    expect(left).toBe(0);
  });

  it('is deterministic across identical worlds', () => {
    const run = (): CollapseEvent[] => {
      const { events, sim, w } = collect();
      buildPavilion(w);
      for (let y = 1; y <= 5; y++) w.setVoxel(12, y, 8, AIR);
      sim.settle(16);
      return events;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reset forgets pending work', () => {
    const { sim, w } = collect();
    buildPavilion(w);
    for (let y = 1; y <= 5; y++) w.setVoxel(6, y, 8, AIR);
    expect(sim.pendingCount).toBe(1);
    sim.reset();
    expect(sim.pendingCount).toBe(0);
    expect(sim.tick(1)).toBe(0);
  });
});

describe('fire → structure coupling', () => {
  it('a burned-through pillar drops its roof', () => {
    const w = world();
    const fire = new FireSim(w);
    const structure = new StructuralSim(w); // chains onto the fire hook
    const events: CollapseEvent[] = [];
    structure.onCollapse = (event) => {
      events.push(event);
      for (const cell of event.cells) w.setVoxel(cell.x, cell.y, cell.z, AIR);
    };

    // 3-tall wood pillar with a 5×5 stone roof.
    for (let y = 1; y <= 3; y++) w.setVoxel(8, y, 8, WOOD);
    for (let x = 6; x <= 10; x++) {
      for (let z = 6; z <= 10; z++) w.setVoxel(x, 4, z, STONE);
    }
    for (let y = 1; y <= 3; y++) expect(fire.ignite(8, y, 8)).toBe(true);
    fire.settle();
    // The pillar burned away to air (journaled writes through the world).
    for (let y = 1; y <= 3; y++) expect(w.getVoxel(8, y, 8)).toBe(AIR);
    structure.settle(16);
    expect(structure.collapseCount).toBeGreaterThanOrEqual(1);
    for (let x = 6; x <= 10; x++) {
      for (let z = 6; z <= 10; z++) expect(w.getVoxel(x, 4, z)).toBe(AIR);
    }
  });
});

describe('World edit journal (stress exemption contract)', () => {
  it('isEdited distinguishes generator cells from written cells', () => {
    const w = world();
    expect(w.isEdited(8, 0, 8)).toBe(false); // bedrock from the generator
    w.setVoxel(8, 5, 8, STONE);
    expect(w.isEdited(8, 5, 8)).toBe(true);
  });

  it('isEdited survives chunk unload and regeneration', () => {
    const w = world();
    w.setVoxel(8, 5, 8, STONE);
    w.unloadChunk(0, 0, 0);
    w.ensureChunk(0, 0, 0);
    expect(w.isEdited(8, 5, 8)).toBe(true);
  });
});
