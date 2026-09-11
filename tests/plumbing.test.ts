import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, PIPE, PUMP, STONE, TAP, WATER } from '../src/voxel/materials';
import { FluidSim, WATER_SOURCE_LEVEL } from '../src/voxel/fluid';
import { PlumbingSim, POUR_PERIOD } from '../src/voxel/plumbing';

/**
 * Plumbing fixtures (Phase 15). A flat stone plane (solid y ≤ 8) with a
 * lake carved into it: water sources at y ≤ 8 in a 6×6 basin around
 * (14, 14), surface at y=9. Networks are laid at y=9 next to the lake.
 * The sim is always constructed BEFORE any cells are written.
 */

function worldWithLake(): World {
  return new World((chunk) => {
    const o = chunk.origin;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let ly = 0; ly < 16; ly++) {
          const y = o.y + ly;
          const x = o.x + lx;
          const z = o.z + lz;
          const inLake = x >= 12 && x <= 17 && z >= 12 && z <= 17;
          chunk.volume.set(lx, ly, lz, y <= 8 && !inLake ? STONE : AIR);
        }
      }
    }
  });
}

function groundChunked(world: World): void {
  for (let cz = 0; cz <= 1; cz++) for (let cx = 0; cx <= 1; cx++) world.ensureChunk(cx, 0, cz);
}

interface Rig {
  world: World;
  fluid: FluidSim;
  plumbing: PlumbingSim;
}

function rig(): Rig {
  const world = worldWithLake();
  groundChunked(world);
  const fluid = new FluidSim(world);
  const plumbing = new PlumbingSim(world, fluid);
  return { world, fluid, plumbing };
}

/** Pump at the lake edge (water on both −x neighbors), pipe run +x, tap. */
function network(
  world: World,
  cells: { pump: [number, number] | null; pipe: [number, number][]; tap: [number, number] | null },
): void {
  if (cells.pump) world.setVoxel(cells.pump[0], 9, cells.pump[1], PUMP);
  for (const [x, z] of cells.pipe) world.setVoxel(x, 9, z, PIPE);
  if (cells.tap) world.setVoxel(cells.tap[0], 9, cells.tap[1], TAP);
}

describe('plumbing', () => {
  it('pressurizes a network fed by a submerged pump and runs its tap', () => {
    const { world, plumbing } = rig();
    // Pump at the lake rim column (12,14) has water at (11,9,14)? No —
    // water lives at y ≤ 8; the pump sits ON the rim at y=9 touching the
    // water cell below-left. Use (13,14): below is lake water? The lake
    // floor is stone here; give the pump an explicit water neighbor.
    world.setVoxel(11, 9, 14, WATER); // feeder pool cell beside the pump
    network(world, {
      pump: [12, 14],
      pipe: [
        [13, 14],
        [14, 14],
      ],
      tap: [15, 14],
    });
    plumbing.settle();
    expect(plumbing.tapCount).toBe(1);
    expect(plumbing.isPressurized(13, 9, 14)).toBe(true);

    // After one pour pass the tap has wet the first air cell beside it.
    for (let i = 0; i <= POUR_PERIOD + 1; i++) plumbing.tick(4);
    const wet = [1, -1].some(
      (dx) => world.getVoxel(15 + dx, 9, 14) === WATER || world.getVoxel(15, 9, 14 + dx) === WATER,
    );
    expect(wet).toBe(true);
  });

  it('stays dry without a pump', () => {
    const { world, plumbing } = rig();
    network(world, {
      pump: null,
      pipe: [
        [13, 14],
        [14, 14],
      ],
      tap: [15, 14],
    });
    plumbing.settle();
    expect(plumbing.tapCount).toBe(0);
    for (let i = 0; i <= POUR_PERIOD + 1; i++) plumbing.tick(4);
    let wet = false;
    for (let x = 12; x <= 17; x++)
      for (let z = 12; z <= 17; z++) if (world.getVoxel(x, 9, z) === WATER) wet = true;
    expect(wet).toBe(false);
  });

  it('a broken pipe pours real water while the main is pressurized', () => {
    const { world, fluid, plumbing } = rig();
    world.setVoxel(11, 9, 14, WATER);
    network(world, {
      pump: [12, 14],
      pipe: [
        [13, 14],
        [14, 14],
      ],
      tap: null,
    });
    plumbing.settle();
    expect(plumbing.isPressurized(14, 9, 14)).toBe(true);

    world.setVoxel(14, 9, 14, AIR); // burst the main
    plumbing.settle();
    expect(plumbing.leakCount).toBe(1);
    for (let i = 0; i <= POUR_PERIOD + 1; i++) plumbing.tick(4);
    expect(world.getVoxel(14, 9, 14)).toBe(WATER); // the hole refills
    expect(fluid.levelAt(14, 9, 14)).toBeGreaterThan(0);
    expect(fluid.levelAt(14, 9, 14)).toBeLessThan(WATER_SOURCE_LEVEL); // flowing
  });

  it('destroying the pump stops the leak and dries the tap', () => {
    const { world, plumbing } = rig();
    world.setVoxel(11, 9, 14, WATER);
    network(world, {
      pump: [12, 14],
      pipe: [
        [13, 14],
        [14, 14],
      ],
      tap: [15, 14],
    });
    plumbing.settle();
    expect(plumbing.tapCount).toBe(1);

    world.setVoxel(12, 9, 14, AIR); // rip out the pump
    plumbing.settle();
    expect(plumbing.tapCount).toBe(0);
    for (let i = 0; i <= POUR_PERIOD * 2 + 2; i++) plumbing.tick(4);
    expect(plumbing.leakCount).toBe(0); // nothing re-pressurizes the main
  });

  it('a break in an unpressurized network is pruned, not fed', () => {
    const { world, plumbing } = rig();
    network(world, {
      pump: null,
      pipe: [[13, 14]],
      tap: null,
    });
    plumbing.settle();
    world.setVoxel(13, 9, 14, AIR);
    plumbing.settle();
    expect(plumbing.leakCount).toBe(1); // registered on destruction…
    for (let i = 0; i <= POUR_PERIOD + 1; i++) plumbing.tick(4);
    expect(plumbing.leakCount).toBe(0); // …pruned: no pressurized neighbor
  });

  it('severing the main depressurizes only the far side', () => {
    const { world, plumbing } = rig();
    world.setVoxel(11, 9, 14, WATER);
    network(world, {
      pump: [12, 14],
      pipe: [
        [13, 14],
        [14, 14],
        [15, 14],
        [16, 14],
      ],
      tap: [17, 14],
    });
    plumbing.settle();
    expect(plumbing.isPressurized(13, 9, 14)).toBe(true);
    expect(plumbing.isPressurized(16, 9, 14)).toBe(true);

    world.setVoxel(15, 9, 14, AIR); // cut between 14 and 16
    plumbing.settle();
    expect(plumbing.isPressurized(14, 9, 14)).toBe(true); // pump side holds
    expect(plumbing.isPressurized(16, 9, 14)).toBe(false); // far side is dead
    expect(plumbing.tapCount).toBe(0); // the tap dried up
  });

  it('rescan() rediscovers networks after a reset', () => {
    const { world, plumbing } = rig();
    world.setVoxel(11, 9, 14, WATER);
    network(world, {
      pump: [12, 14],
      pipe: [[13, 14]],
      tap: null,
    });
    plumbing.settle();
    expect(plumbing.isPressurized(13, 9, 14)).toBe(true);
    plumbing.reset();
    plumbing.rescan();
    plumbing.settle();
    expect(plumbing.isPressurized(13, 9, 14)).toBe(true);
  });

  it('fluid.pour refuses non-air cells and source levels', () => {
    const { world, fluid } = rig();
    expect(fluid.pour(4, 9, 4, 8)).toBe(true);
    expect(fluid.pour(4, 9, 4, 8)).toBe(false); // occupied
    expect(fluid.pour(5, 9, 4, WATER_SOURCE_LEVEL)).toBe(false);
    expect(fluid.pour(6, 9, 4, 0)).toBe(false);
    expect(world.getVoxel(4, 9, 4)).toBe(WATER);
    expect(fluid.levelAt(4, 9, 4)).toBe(8);
  });
});
