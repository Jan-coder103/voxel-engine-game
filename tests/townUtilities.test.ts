import { describe, expect, it } from 'vitest';
import { WORLD_HEIGHT, WORLD_HEIGHT_CHUNKS } from '../src/voxel/coordinates';
import { AIR, COPPER, GENERATOR, LAMP, PIPE, PUMP, TAP, WATER } from '../src/voxel/materials';
import { DEFAULT_TERRAIN, generateChunk, type TerrainParams } from '../src/voxel/terrain';
import { World } from '../src/voxel/world';
import { FluidSim } from '../src/voxel/fluid';
import { PowerSim } from '../src/voxel/power';
import { PlumbingSim, POUR_PERIOD } from '../src/voxel/plumbing';
import { applyTown, planAt, roadOffset, ROAD_SPACING, TOWN_RADIUS } from '../src/worldgen/town';
import { cableAt, generatorSite, pipelineRoute } from '../src/worldgen/utilities';

/**
 * Town utilities (Phase 15): the generated power grid and water main.
 * The strong invariants — every generated lamp lights, every main is
 * continuous and pressurized — are pinned on two seeds: one with a dry
 * central intersection (1337) and one where the plant stands on a bridge
 * over water (13579).
 */

const DRY: TerrainParams = { ...DEFAULT_TERRAIN, seed: 1337 };
const WATERY: TerrainParams = { ...DEFAULT_TERRAIN, seed: 13579 };

function townedWorld(params: TerrainParams): World {
  return new World((chunk) => {
    generateChunk(chunk, params);
    applyTown(chunk, params);
  });
}

function materializeTown(world: World): void {
  const r = Math.ceil((TOWN_RADIUS + 1) / 16);
  for (let cz = -r; cz < r; cz++) {
    for (let cx = -r; cx < r; cx++) {
      for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) world.ensureChunk(cx, cy, cz);
    }
  }
}

/** All lamps on the road-line center columns (where poles are placed). */
function townLamps(world: World, params: TerrainParams): { x: number; y: number; z: number }[] {
  const lamps: { x: number; y: number; z: number }[] = [];
  const offX = roadOffset(params.seed, 1);
  const offZ = roadOffset(params.seed, 2);
  const visit = (x: number, z: number): void => {
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      if (world.getVoxel(x, y, z) === LAMP) lamps.push({ x, y, z });
    }
  };
  for (
    let k = Math.ceil((-TOWN_RADIUS - offX) / ROAD_SPACING);
    offX + k * ROAD_SPACING <= TOWN_RADIUS;
    k++
  ) {
    const lx = offX + k * ROAD_SPACING;
    for (let z = -TOWN_RADIUS; z <= TOWN_RADIUS; z++) visit(lx, z);
  }
  for (
    let k = Math.ceil((-TOWN_RADIUS - offZ) / ROAD_SPACING);
    offZ + k * ROAD_SPACING <= TOWN_RADIUS;
    k++
  ) {
    const lz = offZ + k * ROAD_SPACING;
    for (let x = -TOWN_RADIUS; x <= TOWN_RADIUS; x++) visit(x, lz);
  }
  return lamps;
}

function utilityAt(world: World, x: number, y: number, z: number): number {
  return world.getVoxel(x, y, z);
}

describe('generated power grid', () => {
  for (const params of [DRY, WATERY]) {
    it(`lights every generated lamp (seed ${params.seed})`, () => {
      const world = townedWorld(params);
      const fluid = new FluidSim(world); // constructed first, like main
      const power = new PowerSim(world);
      void fluid;
      materializeTown(world);
      power.settle();

      const lamps = townLamps(world, params);
      expect(lamps.length).toBeGreaterThan(200); // the walk actually finds poles
      for (const lamp of lamps) {
        expect(power.isLit(lamp.x, lamp.y, lamp.z)).toBe(true);
      }
    });
  }

  it('builds the generator on the central intersection, wired to the cable', () => {
    const world = townedWorld(DRY);
    materializeTown(world);
    const gx = generatorSite(DRY);
    expect(planAt(gx.x, gx.z, DRY).kind).toBe('road');
    expect(cableAt(gx.x, gx.z, DRY)).toBe(true);
    // Two generator blocks on a copper pedestal above the buried cable.
    let top = -1;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (utilityAt(world, gx.x, y, gx.z) === GENERATOR) {
        top = y;
        break;
      }
    }
    expect(top).toBeGreaterThan(0);
    expect(utilityAt(world, gx.x, top - 1, gx.z)).toBe(GENERATOR);
    expect(utilityAt(world, gx.x, top - 2, gx.z)).toBe(COPPER); // pedestal
    expect(utilityAt(world, gx.x, top - 3, gx.z)).toBe(COPPER); // vault/cable
    expect(utilityAt(world, gx.x, top - 4, gx.z)).toBe(COPPER); // cable
  });

  it('lampposts stand on the buried cable (pole anatomy)', () => {
    const world = townedWorld(DRY);
    materializeTown(world);
    const lamps = townLamps(world, DRY);
    expect(lamps.length).toBeGreaterThan(200);
    let checked = 0;
    for (const lamp of lamps) {
      const h = lamp.y - 3; // dry pole columns: lamp at h+3
      if (h < 3) continue;
      // Three copper pole cells above the pole base at h-1, cable at h-2.
      if (utilityAt(world, lamp.x, lamp.y - 1, lamp.z) !== COPPER) continue;
      expect(utilityAt(world, lamp.x, lamp.y - 2, lamp.z)).toBe(COPPER);
      expect(utilityAt(world, lamp.x, lamp.y - 3, lamp.z)).toBe(COPPER);
      checked++;
      if (checked >= 40) break; // spot-check a deterministic subset
    }
    expect(checked).toBe(40);
  });
});

describe('generated water main', () => {
  it('runs a continuous pressurized main from pump to tap', () => {
    const params = DRY;
    const route = pipelineRoute(params);
    expect(route).toBeDefined();
    const world = townedWorld(params);
    const fluid = new FluidSim(world);
    const plumbing = new PlumbingSim(world, fluid);
    materializeTown(world);
    plumbing.settle();

    // Pump stands in water.
    const pump = { x: route!.pumpX, y: params.seaLevel - 1, z: route!.z };
    expect(utilityAt(world, pump.x, pump.y, pump.z)).toBe(PUMP);
    const wetNeighbor = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ].some(([dx, dy, dz]) => utilityAt(world, pump.x + dx, pump.y + dy, pump.z + dz) === WATER);
    expect(wetNeighbor).toBe(true);

    // The tap is at the route's end and the network reaches it.
    const tap = { x: route!.endX, z: route!.z };
    let tapY = -1;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      if (utilityAt(world, tap.x, y, tap.z) === TAP) {
        tapY = y;
        break;
      }
    }
    expect(tapY).toBeGreaterThan(0);
    expect(plumbing.tapCount).toBe(1);
    expect(plumbing.isPressurized(tap.x, tapY - 1, tap.z)).toBe(true); // riser

    // After a pour pass the tap has wet the first air cell beside it.
    for (let i = 0; i <= POUR_PERIOD + 1; i++) plumbing.tick(4);
    const wet = [1, -1].some(
      (dx) =>
        utilityAt(world, tap.x + dx, tapY, tap.z) === WATER ||
        utilityAt(world, tap.x, tapY, tap.z + dx) === WATER,
    );
    expect(wet).toBe(true);
  });

  it('bursting the main floods the lane; ripping the pump stops it', () => {
    const params = DRY;
    const route = pipelineRoute(params)!;
    const world = townedWorld(params);
    const fluid = new FluidSim(world);
    const plumbing = new PlumbingSim(world, fluid);
    materializeTown(world);
    plumbing.settle();

    // Break a mid-route main cell.
    const midX = Math.round((route.pumpX + route.endX) / 2);
    let breakY = -1;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      if (utilityAt(world, midX, y, route.z) === PIPE) {
        breakY = y;
        break;
      }
    }
    expect(breakY).toBeGreaterThan(0);
    expect(world.setVoxel(midX, breakY, route.z, AIR)).toBe(true);
    plumbing.settle();
    expect(plumbing.leakCount).toBe(1);

    for (let i = 0; i <= POUR_PERIOD + 1; i++) plumbing.tick(4);
    expect(utilityAt(world, midX, breakY, route.z)).toBe(WATER); // hole refills
    expect(fluid.levelAt(midX, breakY, route.z)).toBeGreaterThan(0);
    expect(fluid.levelAt(midX, breakY, route.z)).toBeLessThan(255); // flowing

    // Rip out the pump: the main depressurizes and the leak is pruned.
    expect(world.setVoxel(route.pumpX, params.seaLevel - 1, route.z, AIR)).toBe(true);
    plumbing.settle();
    for (let i = 0; i <= POUR_PERIOD * 2 + 2; i++) plumbing.tick(4);
    expect(plumbing.leakCount).toBe(0);
  });

  it('route computation is deterministic and pure', () => {
    expect(pipelineRoute(DRY)).toEqual(pipelineRoute(DRY));
    expect(pipelineRoute(WATERY)).toEqual(pipelineRoute(WATERY));
  });
});

describe('utility material ids (serialization contract)', () => {
  it('keeps the appended utility ids stable', () => {
    expect(COPPER).toBe(12);
    expect(LAMP).toBe(13);
    expect(GENERATOR).toBe(14);
    expect(PIPE).toBe(15);
    expect(PUMP).toBe(16);
    expect(TAP).toBe(17);
  });
});
