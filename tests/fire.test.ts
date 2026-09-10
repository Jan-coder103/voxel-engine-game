import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { BLAST_HEAT, FireSim, IGNITION_BASE, ignitionHeat } from '../src/voxel/fire';
import { AIR, DIRT, GRASS, SAND, STONE, WATER, WOOD, fireProfileOf } from '../src/voxel/materials';
import { explode } from '../src/voxel/damage';
import type { GameEvent } from '../src/sim/events';

/**
 * Phase 10 fire tests: ignition rules, spread, fuel/burn-out, water
 * coupling, smothering, explosion heat, budget, sleep/wake, determinism,
 * and journal interplay (burned voxels persist like any other edit).
 */

/** An empty world with chunks covering x/z ∈ [-16, 32), both Y layers. */
function emptyWorld(): World {
  const world = new World(() => {});
  for (let cy = 0; cy < 2; cy++)
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
  return world;
}

function recorder(world: World): { fire: FireSim; events: GameEvent[] } {
  const fire = new FireSim(world);
  const events: GameEvent[] = [];
  fire.onEvent = (event) => events.push(event);
  return { fire, events };
}

describe('ignition rules', () => {
  it('ignites wood and reports fuel', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire } = recorder(world);
    expect(fire.ignite(0, 1, 0)).toBe(true);
    expect(fire.isBurning(0, 1, 0)).toBe(true);
    expect(fire.fuelAt(0, 1, 0)).toBe(fireProfileOf(WOOD).burnDuration);
    expect(fire.activeCount).toBeGreaterThan(0);
  });

  it('refuses non-flammable cells', () => {
    const world = emptyWorld();
    const { fire } = recorder(world);
    world.setVoxel(0, 1, 0, STONE);
    world.setVoxel(1, 1, 0, SAND);
    world.setVoxel(2, 1, 0, DIRT);
    expect(fire.ignite(0, 1, 0)).toBe(false);
    expect(fire.ignite(1, 1, 0)).toBe(false);
    expect(fire.ignite(2, 1, 0)).toBe(false);
    expect(fire.ignite(3, 1, 0)).toBe(false); // air
    expect(fire.burningCount).toBe(0);
  });

  it('refuses cells that touch water', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    world.setVoxel(1, 1, 0, WATER);
    const { fire } = recorder(world);
    expect(fire.ignite(0, 1, 0)).toBe(false);
    expect(fire.isBurning(0, 1, 0)).toBe(false);
  });

  it('igniting a burning cell is a no-op that keeps its fuel', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire } = recorder(world);
    expect(fire.ignite(0, 1, 0)).toBe(true);
    fire.tick();
    const fuel = fire.fuelAt(0, 1, 0);
    expect(fire.ignite(0, 1, 0)).toBe(true);
    expect(fire.fuelAt(0, 1, 0)).toBe(fuel);
  });

  it('ignition thresholds rise as flammability falls', () => {
    expect(ignitionHeat(1)).toBe(1);
    expect(ignitionHeat(fireProfileOf(WOOD).flammability)).toBeLessThan(
      ignitionHeat(fireProfileOf(GRASS).flammability),
    );
    expect(ignitionHeat(0)).toBe(Math.round(IGNITION_BASE));
  });
});

describe('spread and burn-out', () => {
  it('fire consumes a connected wood structure to air', () => {
    const world = emptyWorld();
    for (let y = 1; y <= 3; y++)
      for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) world.setVoxel(x, y, z, WOOD);
    const { fire } = recorder(world);
    expect(fire.ignite(0, 1, 0)).toBe(true);
    fire.settle();
    for (let y = 1; y <= 3; y++)
      for (let z = -1; z <= 1; z++)
        for (let x = -1; x <= 1; x++) expect(world.getVoxel(x, y, z)).toBe(AIR);
    expect(fire.burningCount).toBe(0);
    expect(fire.activeCount).toBe(0);
    expect(fire.tick()).toBe(0);
  });

  it('fire does not cross non-flammable material', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    world.setVoxel(1, 1, 0, STONE);
    world.setVoxel(2, 1, 0, WOOD);
    const { fire } = recorder(world);
    fire.ignite(0, 1, 0);
    fire.settle();
    expect(world.getVoxel(0, 1, 0)).toBe(AIR);
    expect(world.getVoxel(1, 1, 0)).toBe(STONE);
    expect(world.getVoxel(2, 1, 0)).toBe(WOOD);
  });

  it('a cell burns exactly its burn duration, then becomes air', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, GRASS);
    const { fire } = recorder(world);
    const duration = fireProfileOf(GRASS).burnDuration; // 64
    fire.ignite(0, 1, 0);
    for (let i = 0; i < duration - 1; i++) fire.tick();
    expect(fire.isBurning(0, 1, 0)).toBe(true);
    expect(fire.fuelAt(0, 1, 0)).toBe(1);
    fire.tick();
    expect(world.getVoxel(0, 1, 0)).toBe(AIR);
    expect(fire.isBurning(0, 1, 0)).toBe(false);
  });

  it('wood still burns after 100 ticks (long fuel)', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire } = recorder(world);
    fire.ignite(0, 1, 0);
    for (let i = 0; i < 100; i++) fire.tick();
    expect(fire.isBurning(0, 1, 0)).toBe(true);
    expect(fire.fuelAt(0, 1, 0)).toBe(fireProfileOf(WOOD).burnDuration - 100);
  });

  it('burn-out is journaled and survives chunk regeneration', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire } = recorder(world);
    fire.ignite(0, 1, 0);
    fire.settle();
    expect(world.getVoxel(0, 1, 0)).toBe(AIR);
    world.unloadChunk(0, 0, 0);
    world.ensureChunk(0, 0, 0); // journal replays on regeneration
    expect(world.getVoxel(0, 1, 0)).toBe(AIR);
  });
});

describe('water coupling', () => {
  it('adjacent water extinguishes a burning cell (milestone 8)', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire, events } = recorder(world);
    fire.ignite(0, 1, 0);
    expect(fire.isBurning(0, 1, 0)).toBe(true);
    world.setVoxel(1, 1, 0, WATER); // external write wakes the sim
    fire.settle();
    expect(fire.isBurning(0, 1, 0)).toBe(false);
    expect(world.getVoxel(0, 1, 0)).toBe(WOOD); // doused, not consumed
    const extinguished = events.filter((e) => e.type === 'fireExtinguished');
    expect(extinguished).toHaveLength(1);
    expect(extinguished[0]).toMatchObject({ type: 'fireExtinguished', cause: 'water' });
  });

  it('water survives the encounter', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire } = recorder(world);
    fire.ignite(0, 1, 0);
    world.setVoxel(0, 2, 0, WATER);
    fire.settle();
    expect(world.getVoxel(0, 2, 0)).toBe(WATER);
    expect(fire.isBurning(0, 1, 0)).toBe(false);
  });
});

describe('smothering', () => {
  it('a fully enclosed burning cell is smothered, not consumed', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      world.setVoxel(dx, 1 + dy, dz, STONE);
    }
    const { fire, events } = recorder(world);
    expect(fire.ignite(0, 1, 0)).toBe(true);
    fire.settle();
    expect(fire.isBurning(0, 1, 0)).toBe(false);
    expect(world.getVoxel(0, 1, 0)).toBe(WOOD); // starved, not burned out
    expect(events.filter((e) => e.type === 'fireExtinguished')).toHaveLength(1);
  });
});

describe('explosion heat', () => {
  it('blast heat ignites flammable cells within a couple of ticks', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire } = recorder(world);
    fire.heatCells([{ x: 0, y: 1, z: 0 }], BLAST_HEAT);
    expect(fire.isBurning(0, 1, 0)).toBe(false); // heat first, then ignition
    fire.tick();
    fire.tick();
    expect(fire.isBurning(0, 1, 0)).toBe(true);
  });

  it('blast heat does nothing to non-flammable cells', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, STONE);
    const { fire } = recorder(world);
    fire.heatCells([{ x: 0, y: 1, z: 0 }], BLAST_HEAT);
    fire.settle();
    expect(fire.burningCount).toBe(0);
    expect(world.getVoxel(0, 1, 0)).toBe(STONE);
    expect(fire.activeCount).toBe(0);
  });

  it('explode reports flammable rim cells and nothing destroyed', () => {
    const world = emptyWorld();
    // Wood slab along +x at y=1; blast at the slab's west end.
    for (let x = 0; x <= 6; x++) world.setVoxel(x, 1, 0, WOOD);
    const result = explode({ x: 0.5, y: 1.5, z: 0.5 }, 6, (x, y, z) => world.getVoxel(x, y, z), {
      seed: 7,
      maxDebris: 16,
    });
    // Wood reach = 6 · (0.35 + 0.65 · 0.45) ≈ 3.86 → x ≤ 3 destroyed,
    // x = 4 survives adjacent to the crater rim → heated.
    expect(world.getVoxel(3, 1, 0)).toBe(WOOD); // explode is pure: no edits applied
    expect(result.heated).toContainEqual({ x: 4, y: 1, z: 0 });
    const edited = new Set(result.edits.map((e) => `${e.x},${e.y},${e.z}`));
    for (const cell of result.heated) {
      expect(edited.has(`${cell.x},${cell.y},${cell.z}`)).toBe(false);
      expect(fireProfileOf(world.getVoxel(cell.x, cell.y, cell.z)).flammability).toBeGreaterThan(0);
    }
  });
});

describe('budget and sleep', () => {
  it('tick respects the budget', () => {
    const world = emptyWorld();
    const { fire } = recorder(world);
    const cells: { x: number; y: number; z: number }[] = [];
    for (let z = 0; z < 20; z++) {
      for (let x = 0; x < 20; x++) {
        world.setVoxel(x, 1, z, WOOD);
        cells.push({ x, y: 1, z });
      }
    }
    fire.heatCells(cells, BLAST_HEAT);
    expect(fire.activeCount).toBeGreaterThan(256);
    expect(fire.tick(256)).toBe(256);
    expect(fire.tick(10)).toBe(10);
  });

  it('external edits wake a settled sim', () => {
    const world = emptyWorld();
    const { fire } = recorder(world);
    fire.settle();
    expect(fire.activeCount).toBe(0);
    world.setVoxel(5, 1, 5, WOOD);
    expect(fire.activeCount).toBeGreaterThan(0);
  });
});

describe('events', () => {
  it('emits fireIgnited on ignition', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire, events } = recorder(world);
    fire.ignite(0, 1, 0);
    expect(events).toContainEqual({ type: 'fireIgnited', x: 0, y: 1, z: 0 });
  });

  it('emits fireIgnited when heat reaches the threshold', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    world.setVoxel(1, 1, 0, WOOD);
    const { fire, events } = recorder(world);
    fire.ignite(1, 1, 0);
    fire.settle();
    expect(events.filter((e) => e.type === 'fireIgnited')).toHaveLength(2);
  });
});

describe('determinism', () => {
  it('the same scenario produces identical fire state and world', () => {
    const run = (): { state: unknown; voxels: number[] } => {
      const world = emptyWorld();
      for (let z = -2; z <= 2; z++) {
        for (let x = -2; x <= 2; x++) world.setVoxel(x, 1, z, x + z >= 0 ? WOOD : GRASS);
      }
      world.setVoxel(0, 2, 0, WOOD);
      const { fire } = recorder(world);
      fire.ignite(0, 1, 0);
      for (let i = 0; i < 100; i++) fire.tick(64);
      const voxels: number[] = [];
      for (let y = 0; y <= 4; y++)
        for (let z = -3; z <= 3; z++)
          for (let x = -3; x <= 3; x++) voxels.push(world.getVoxel(x, y, z));
      return { state: fire.exportState(), voxels };
    };
    const a = run();
    const b = run();
    expect(a.state).toEqual(b.state);
    expect(a.voxels).toEqual(b.voxels);
  });
});

describe('reset', () => {
  it('clears all fire state', () => {
    const world = emptyWorld();
    world.setVoxel(0, 1, 0, WOOD);
    const { fire } = recorder(world);
    fire.ignite(0, 1, 0);
    fire.reset();
    expect(fire.burningCount).toBe(0);
    expect(fire.activeCount).toBe(0);
    expect(fire.isBurning(0, 1, 0)).toBe(false);
    expect(fire.tick()).toBe(0);
  });
});
