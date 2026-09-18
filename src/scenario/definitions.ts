import {
  AIR,
  BRICK,
  PIPE,
  WATER,
  fireProfileOf,
  isOpaque,
  type VoxelMaterialID,
} from '../voxel/materials';
import { heightAt, type TerrainParams } from '../voxel/terrain';
import {
  ROAD_SPACING,
  TOWN_RADIUS,
  findTownSpawn,
  lotSpec,
  planAt,
  roadOffset,
  type BuildingSpec,
} from '../worldgen/town';
import { generatorSite, pipelineRoute } from '../worldgen/utilities';
import { terrainNavQuery, type NavCell } from '../npc/navigation';
import type { World } from '../voxel/world';
import { distance, isSubstance, type ScenarioBox, type ScenarioDef } from './engine';

/**
 * The five launch scenarios (Phase 18) and the pure site resolution they
 * are staged from. Sites are derived deterministically from the seeded
 * terrain/town/utilities — the same world always stages the same
 * vignettes (ADR-005); no scenario hardcodes coordinates.
 *
 * Each definition is a small declarative script for the engine
 * (`./engine`): a `setup` that stages the world through `ScenarioIo`,
 * objectives the player completes or fails, and one-shot triggers for
 * timed beats. Everything runs against the *live* sims — a burst main
 * is the Phase 15 plumbing pouring Phase 9 water, a collapse is the
 * Phase 11 support graph, a trapped figure is a real Phase 12 NPC.
 *
 * Pure: no three.js, no DOM (ADR-002).
 */

export const SCENARIO_IDS = ['flood', 'fire', 'collapse', 'demolition', 'rescue'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIO_TITLES: Record<ScenarioId, string> = {
  flood: 'Burst water main',
  fire: 'House fire',
  collapse: 'The collapse',
  demolition: 'Controlled demolition',
  rescue: 'Trapped!',
};

/** A generated building plus the voxel box it occupies. */
export interface BuildingSite {
  readonly spec: BuildingSpec;
  readonly box: ScenarioBox;
}

/** Deterministic staging data for one world. */
export interface ScenarioSites {
  readonly spawn: { x: number; y: number; z: number };
  /** Generated buildings, nearest-first from the spawn. */
  readonly buildings: readonly BuildingSite[];
  /** The water main (undefined on dry seeds — no flood scenario). */
  readonly main?: {
    readonly pump: NavCell;
    readonly tap: NavCell;
    readonly burst: NavCell;
  };
  /** The power plant's lower generator block. */
  readonly generator: { x: number; y: number; z: number };
}

/** Height above baseY a building may reach (walls + roof ridge), + slack. */
function buildingHeightBound(spec: BuildingSpec): number {
  if (spec.type === 'house') return spec.floors === 2 ? 14 : 10;
  return 8;
}

function buildingBox(spec: BuildingSpec): ScenarioBox {
  return {
    min: { x: spec.bx - 1, y: spec.baseY - 2, z: spec.bz - 1 },
    max: {
      x: spec.bx + spec.w,
      y: spec.baseY + buildingHeightBound(spec),
      z: spec.bz + spec.d,
    },
  };
}

/**
 * The building's own body: footprint plus courses from the floor up —
 * no terrain pad, no apron. Destruction baselines count over this box
 * (the surrounding ground must not inflate the "how much is gone" math).
 */
function buildingBody(spec: BuildingSpec): ScenarioBox {
  return {
    min: { x: spec.bx, y: spec.baseY - 1, z: spec.bz },
    max: {
      x: spec.bx + spec.w - 1,
      y: spec.baseY + buildingHeightBound(spec),
      z: spec.bz + spec.d - 1,
    },
  };
}

function boxCenter(box: ScenarioBox): { x: number; y: number; z: number } {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
}

/** mod that is correct for negatives (road-lattice arithmetic). */
function latticeMod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/**
 * Every viable building in the town square. Lot origins are read off
 * `planAt` (never re-derived), so this stays correct even if the lot
 * lattice changes; the census cost matches `townStats` (~2 ms, one-time).
 */
export function enumerateBuildings(params: TerrainParams): BuildingSpec[] {
  const seen = new Set<string>();
  const out: BuildingSpec[] = [];
  for (let z = -TOWN_RADIUS; z <= TOWN_RADIUS; z++) {
    for (let x = -TOWN_RADIUS; x <= TOWN_RADIUS; x++) {
      const plan = planAt(x, z, params);
      if (plan.kind !== 'lot' || !plan.lot) continue;
      const key = `${plan.lot.x},${plan.lot.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lot = lotSpec(plan.lot.x, plan.lot.z, params);
      if (lot.building) out.push(lot.building);
    }
  }
  return out;
}

/**
 * The scenario's building: fire/rescue want houses (furniture, bedrooms,
 * interiors), the rest take whatever stands nearest the spawn. The FIRST
 * suitable entry in array order wins — `sites.buildings` is sorted
 * nearest-first, and main's startScenario rotates the array per candidate,
 * so this honors the rotation contract: after a rotation, the staged
 * target is always `activeSites().buildings[0]`. (Never re-derive
 * "nearest" here: a fresh proximity scan would ignore the rotation and
 * stage every attempt on the same global-nearest building.)
 */
export function scenarioTarget(id: ScenarioId, sites: ScenarioSites): BuildingSite | undefined {
  const prefer: BuildingSpec['type'] | undefined =
    id === 'fire' || id === 'rescue' ? 'house' : undefined;
  if (prefer !== undefined) {
    const house = sites.buildings.find((site) => site.spec.type === prefer);
    if (house) return house;
  }
  return sites.buildings[0];
}

/** A burst cell on the main: dry lane, clear of pump, riser, and cable crossings. */
function pickBurstCell(
  route: NonNullable<ReturnType<typeof pipelineRoute>>,
  params: TerrainParams,
): NavCell | undefined {
  const z = route.z;
  const lo = Math.min(route.pumpX, route.endX) + 3;
  const hi = Math.max(route.pumpX, route.endX) - 3;
  if (hi < lo) return undefined;
  const mid = Math.floor((lo + hi) / 2);
  for (let d = 0; d <= hi - lo; d++) {
    for (const x of d === 0 ? [mid] : [mid + d, mid - d]) {
      if (x < lo || x > hi) continue;
      const h = heightAt(x, z, params);
      if (h < params.seaLevel) continue; // submerged lane: the deck crossing
      if (latticeMod(x - roadOffset(params.seed, 1), ROAD_SPACING) === 0) {
        continue; // cable crossing: the main dives a cell deeper here
      }
      return { x, y: h - 2, z };
    }
  }
  return undefined;
}

/**
 * Resolve the staging sites for a world. Pure and deterministic; call
 * once per session (it enumerates the town once).
 */
export function resolveSites(params: TerrainParams): ScenarioSites {
  const spawn = findTownSpawn(params);
  const buildings = enumerateBuildings(params)
    .map((spec) => ({ spec, box: buildingBox(spec) }))
    .sort((a, b) => {
      const da = Math.abs(a.spec.door.x - spawn.x) + Math.abs(a.spec.door.z - spawn.z);
      const db = Math.abs(b.spec.door.x - spawn.x) + Math.abs(b.spec.door.z - spawn.z);
      return da - db || a.spec.door.x - b.spec.door.x || a.spec.door.z - b.spec.door.z;
    });

  const route = pipelineRoute(params);
  let main: ScenarioSites['main'];
  if (route) {
    const burst = pickBurstCell(route, params);
    if (burst) {
      const tapH = heightAt(route.endX, route.z, params);
      main = {
        pump: { x: route.pumpX, y: params.seaLevel - 1, z: route.z },
        tap: { x: route.endX, y: tapH + 1, z: route.z },
        burst,
      };
    }
  }

  const gen = generatorSite(params);
  const genH = heightAt(gen.x, gen.z, params);
  const genY = genH < params.seaLevel ? params.seaLevel + 2 : genH + 1;
  return { spawn, buildings, main, generator: { x: gen.x, y: genY, z: gen.z } };
}

// --- world-inspection helpers (setup + validation read the live world) ---

function countMaterial(world: World, box: ScenarioBox, material: VoxelMaterialID): number {
  let count = 0;
  for (let y = box.min.y; y <= box.max.y; y++) {
    for (let z = box.min.z; z <= box.max.z; z++) {
      for (let x = box.min.x; x <= box.max.x; x++) {
        if (world.getVoxel(x, y, z) === material) count++;
      }
    }
  }
  return count;
}

/** Count substance (solid, non-water) cells in one y-course of a box. */
function countCourse(world: World, box: ScenarioBox, y: number): number {
  let count = 0;
  for (let z = box.min.z; z <= box.max.z; z++) {
    for (let x = box.min.x; x <= box.max.x; x++) {
      if (isSubstance(world.getVoxel(x, y, z))) count++;
    }
  }
  return count;
}

/** True when all six neighbors are opaque — a fire here smothers at once. */
function isSealed(world: World, x: number, y: number, z: number): boolean {
  return (
    isOpaque(world.getVoxel(x + 1, y, z)) &&
    isOpaque(world.getVoxel(x - 1, y, z)) &&
    isOpaque(world.getVoxel(x, y + 1, z)) &&
    isOpaque(world.getVoxel(x, y - 1, z)) &&
    isOpaque(world.getVoxel(x, y, z + 1)) &&
    isOpaque(world.getVoxel(x, y, z - 1))
  );
}

/**
 * First flammable cell in a box (fixed y→z→x scan order — the fire
 * starts low). Skips cells touching water (`FireSim.ignite` would
 * refuse them) and sealed pockets (the fire sim smothers those on the
 * same tick — staging a blaze there would "win" the scenario instantly).
 */
export function findFlammable(world: World, box: ScenarioBox): NavCell | undefined {
  for (let y = box.min.y; y <= box.max.y; y++) {
    for (let z = box.min.z; z <= box.max.z; z++) {
      for (let x = box.min.x; x <= box.max.x; x++) {
        const profile = fireProfileOf(world.getVoxel(x, y, z));
        if (profile.flammability <= 0 || profile.burnDuration <= 0) continue;
        const wet =
          world.getVoxel(x + 1, y, z) === WATER ||
          world.getVoxel(x - 1, y, z) === WATER ||
          world.getVoxel(x, y + 1, z) === WATER ||
          world.getVoxel(x, y - 1, z) === WATER ||
          world.getVoxel(x, y, z + 1) === WATER ||
          world.getVoxel(x, y, z - 1) === WATER;
        if (wet) continue;
        if (isSealed(world, x, y, z)) continue;
        return { x, y, z };
      }
    }
  }
  return undefined;
}

/** First walkable interior cell (feet on the floor, headroom clear). */
export function findInteriorStand(world: World, spec: BuildingSpec): NavCell | undefined {
  const query = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
  const top = spec.baseY + (spec.floors === 2 ? 8 : 4);
  for (let y = spec.baseY; y <= top; y++) {
    for (let z = spec.bz + 1; z <= spec.bz + spec.d - 2; z++) {
      for (let x = spec.bx + 1; x <= spec.bx + spec.w - 2; x++) {
        if (query.walkable(x, y, z)) return { x, y, z };
      }
    }
  }
  return undefined;
}

/**
 * Can this scenario actually run here? main checks right before start
 * (after force-loading the site's chunks): the flood needs the generated
 * main intact, the fire a flammable house, the rescue an interior to
 * trap someone in. Prevents "instant win/lose" from a vanished fixture.
 */
export function scenarioReady(id: ScenarioId, world: World, sites: ScenarioSites): boolean {
  switch (id) {
    case 'flood':
      return (
        sites.main !== undefined &&
        world.getVoxel(sites.main.burst.x, sites.main.burst.y, sites.main.burst.z) === PIPE
      );
    case 'fire': {
      const site = scenarioTarget('fire', sites);
      // Validate the building body (footprint, floor up) — the same box
      // setup ignites from. The outer box would find the grass apron and
      // stage a lawn fire that leaps to the neighbors within seconds.
      return site !== undefined && findFlammable(world, buildingBody(site.spec)) !== undefined;
    }
    case 'collapse':
    case 'demolition': {
      const site = scenarioTarget(id, sites);
      if (!site) return false;
      // The wall course we (or the player) will act on must exist.
      let substance = 0;
      for (let y = site.spec.baseY; y <= site.spec.baseY + 1 && substance < 16; y++) {
        substance += countCourse(world, site.box, y);
      }
      return substance >= 16;
    }
    case 'rescue': {
      const site = scenarioTarget('rescue', sites);
      return site !== undefined && findInteriorStand(world, site.spec) !== undefined;
    }
  }
}

// --- the scenarios -------------------------------------------------------

/**
 * FLOOD — plan §66 "The Flood" in miniature: the generated water main
 * bursts under the street (a real Phase 15 leak pouring Phase 9 water);
 * the player stops the leak (cut the pipe between the lake pump and the
 * break, or take out the pump) while keeping the water off the power
 * plant — where it would short the town's grid.
 */
function floodScenario(sites: ScenarioSites): ScenarioDef | undefined {
  const main = sites.main;
  if (!main) return undefined;
  const gen = sites.generator;
  const genBox: ScenarioBox = {
    min: { x: gen.x - 1, y: gen.y - 1, z: gen.z - 1 },
    max: { x: gen.x + 1, y: gen.y + 1, z: gen.z + 1 },
  };
  return {
    id: 'flood',
    title: SCENARIO_TITLES.flood,
    briefing: 'The water main has burst under the street! Stop the leak before the block floods.',
    setup(io) {
      io.forceWeather('rain'); // the showcase mood — and it soaks the crew
      io.ensureAround(main.burst.x, main.burst.z, 3);
      io.edit([{ ...main.burst, material: AIR }], 'scenario: the main bursts');
    },
    objectives: [
      {
        id: 'protect',
        description: 'Keep the water off the power plant',
        failed: (ctx) => ctx.countInBox(genBox, WATER) > 0,
      },
      {
        id: 'stop',
        description: 'Stop the leak',
        done: (ctx) => ctx.ticks > 30 && ctx.io.sensors.leakCount() === 0,
        deadline: 4800,
      },
    ],
    triggers: [
      {
        id: 'hint',
        when: (ctx) => ctx.ticks === 1200,
        run: (io) =>
          io.announce(
            'Hint: the leak is fed from the lake pump — dig up the pipe between them, or take out the pump.',
          ),
      },
    ],
  };
}

/**
 * FIRE — plan §66: a house ignites (interior first, like a stove fire);
 * douse the blaze with placed water before more than half the structure
 * is consumed and before it jumps to a neighboring building. Rain is
 * pinned clear: this is the player's fire, not the weather's.
 */
function fireScenario(sites: ScenarioSites): ScenarioDef | undefined {
  const site = scenarioTarget('fire', sites);
  if (!site) return undefined;
  const box = site.box;
  const body = buildingBody(site.spec);
  const center = boxCenter(box);
  const neighbors = sites.buildings.filter(
    (other) =>
      other !== site &&
      Math.abs(other.spec.door.x - center.x) + Math.abs(other.spec.door.z - center.z) <= 30,
  );
  // The guard watches the neighbors' structures (body boxes), not their
  // outer boxes: a box reaches lawn level, and a burning lawn crosses the
  // ~1-cell-per-tick grass in under a second — unwinnable. Scorched lawns
  // are survivable; a neighbor's walls catching is not.
  const neighborBodies = neighbors.map((nb) => buildingBody(nb.spec));
  return {
    id: 'fire',
    title: SCENARIO_TITLES.fire,
    briefing:
      'A house is ablaze! Douse it before the house burns down — and keep it off the neighbors.',
    setup(io) {
      io.forceWeather('clear');
      io.ensureAround(center.x, center.z, 3);
      // Ignite inside the building body (footprint, floor up — "a stove
      // fire"), never the apron: the outer box reaches the grass lawn, and
      // a lawn fire crosses to a neighbor's box in ~10 ticks — unwinnable.
      const cell = findFlammable(io.world, body);
      if (cell) io.ignite(cell.x, cell.y, cell.z);
      io.setCounter('air0', countMaterial(io.world, body, AIR));
      io.setCounter('solid0', solidCourseTotal(io.world, body));
    },
    objectives: [
      {
        id: 'extinguish',
        description: 'Put the blaze out',
        done: (ctx) => ctx.ticks > 30 && ctx.io.sensors.burningCount() === 0,
        deadline: 7200,
      },
      {
        id: 'standing',
        description: 'Keep the house standing',
        // More than half the original structure consumed → lost it.
        failed: (ctx) =>
          (ctx.countInBox(body, AIR) - ctx.counter('air0')) * 2 > ctx.counter('solid0'),
      },
      {
        id: 'neighbors',
        description: 'Keep it off the neighbors',
        failed: (ctx) => neighborBodies.some((nb) => ctx.eventsInBox('fireIgnited', nb) > 2),
      },
    ],
  };
}

/** Total substance cells in a box (fire's destruction baseline). */
function solidCourseTotal(world: World, box: ScenarioBox): number {
  let total = 0;
  for (let y = box.min.y; y <= box.max.y; y++) total += countCourse(world, box, y);
  return total;
}

/**
 * COLLAPSE — the ground floor gives way (the staging carves both wall
 * courses; the Phase 11 support graph does the rest). The player gets
 * clear, waits out the staged cascade, and the witness who walked up to
 * watch stays alive (they will panic and flee on their own — Phase 13).
 */
function collapseScenario(sites: ScenarioSites): ScenarioDef | undefined {
  const site = scenarioTarget('collapse', sites);
  if (!site) return undefined;
  const spec = site.spec;
  const box = site.box;
  const center = boxCenter(box);
  const ground: ScenarioBox = {
    min: { x: box.min.x, y: spec.baseY, z: box.min.z },
    max: { x: box.max.x, y: spec.baseY + 1, z: box.max.z },
  };
  return {
    id: 'collapse',
    title: SCENARIO_TITLES.collapse,
    briefing:
      'The ground floor just gave way — the structure is coming down! Get clear and keep the witness safe.',
    setup(io) {
      io.forceWeather('clear');
      io.ensureAround(center.x, center.z, 3);
      const edits = [];
      for (let y = ground.min.y; y <= ground.max.y; y++) {
        for (let z = ground.min.z; z <= ground.max.z; z++) {
          for (let x = ground.min.x; x <= ground.max.x; x++) {
            if (isSubstance(io.world.getVoxel(x, y, z))) {
              edits.push({ x, y, z, material: AIR });
            }
          }
        }
      }
      io.edit(edits, 'scenario: the ground floor gives way');
      const witness = io.spawnAt(spec.door);
      io.setCounter('witness', witness ?? 0);
    },
    objectives: [
      {
        id: 'clear',
        description: 'Get clear of the building',
        done: (ctx) => distance(ctx.io.player(), center) > 14,
        deadline: 900,
      },
      {
        id: 'over',
        description: 'The collapse plays out',
        after: (ctx) => ctx.events('structureCollapsed') > 0,
        done: (ctx) => ctx.eventsQuiet('structureCollapsed', center.x, center.y, center.z, 24, 240),
        deadline: 5400,
      },
      {
        id: 'witness',
        description: 'The witness stays safe',
        failed: (ctx) => ctx.eventsNear('npcDied', spec.door.x, spec.door.y, spec.door.z, 12) > 0,
      },
    ],
  };
}

/**
 * DEMOLITION — plan §66 "Controlled demolition": bring the building
 * down (explosions in creator mode, or by hand), clean — no blasts, fires,
 * or casualties in the neighbors, nobody hurt on the street.
 */
function demolitionScenario(sites: ScenarioSites): ScenarioDef | undefined {
  const site = scenarioTarget('demolition', sites);
  if (!site) return undefined;
  const box = site.box;
  const body = buildingBody(site.spec);
  const center = boxCenter(box);
  const neighbors = sites.buildings.filter(
    (other) =>
      other !== site &&
      Math.abs(other.spec.door.x - center.x) + Math.abs(other.spec.door.z - center.z) <= 34,
  );
  const neighborBodies = neighbors.map((nb) => buildingBody(nb.spec));
  return {
    id: 'demolition',
    title: SCENARIO_TITLES.demolition,
    briefing: 'Bring this building down — clean. Keep the neighbors standing and nobody hurt.',
    setup(io) {
      io.forceWeather('clear');
      io.ensureAround(center.x, center.z, 3);
      io.setCounter('air0', countMaterial(io.world, body, AIR));
      io.setCounter('solid0', solidCourseTotal(io.world, body));
    },
    objectives: [
      {
        id: 'level',
        description: 'Level the building',
        // A staged collapse at the site — or ¾ of it removed by hand.
        done: (ctx) =>
          ctx.eventsNear('structureCollapsed', center.x, center.y, center.z, 18) > 0 ||
          (ctx.countInBox(body, AIR) - ctx.counter('air0')) * 4 >= ctx.counter('solid0') * 3,
        deadline: 9600,
      },
      {
        id: 'clean',
        description: 'Keep the neighbors standing',
        // Blasts anywhere in a neighbor's box are collateral; fires count
        // only when the neighbor's own structure catches (body box — lawns
        // burn too fast to gate on).
        failed: (ctx) =>
          neighbors.some(
            (nb, i) =>
              ctx.eventsInBox('explosion', nb.box) > 0 ||
              ctx.eventsInBox('fireIgnited', neighborBodies[i]) > 2,
          ),
      },
      {
        id: 'safety',
        description: 'Nobody gets hurt',
        failed: (ctx) => ctx.eventsNear('npcDied', center.x, center.y, center.z, 18) > 0,
      },
    ],
    triggers: [
      {
        id: 'hint',
        when: (ctx) => ctx.ticks === 600,
        run: (io) =>
          io.announce(
            'Hint: creator mode (C) has the explosion tool — or take out the ground walls by hand.',
          ),
      },
    ],
  };
}

/**
 * RESCUE — plan §66 "The Collapse"'s rescue half: a figure is trapped
 * inside a house whose doorway has been boarded up. Dig the door open
 * (by hand — a blast next to the patient is a rescue gone wrong) and the
 * figure walks out on its own schedule.
 */
function rescueScenario(sites: ScenarioSites): ScenarioDef | undefined {
  const site = scenarioTarget('rescue', sites);
  if (!site) return undefined;
  const spec = site.spec;
  const door = spec.door;
  // doorSide: 0 = +x wall, 1 = −x, 2 = +z, 3 = −z — inward is its mirror.
  const inward = [
    { x: -1, z: 0 },
    { x: 1, z: 0 },
    { x: 0, z: -1 },
    { x: 0, z: 1 },
  ][spec.doorSide];
  const opening: NavCell[] = [
    { x: door.x + inward.x, y: door.y, z: door.z + inward.z },
    { x: door.x + inward.x, y: door.y + 1, z: door.z + inward.z },
  ];
  return {
    id: 'rescue',
    title: SCENARIO_TITLES.rescue,
    briefing:
      'Someone is trapped in the boarded-up house. Dig them out — by hand, not with blasts.',
    setup(io) {
      io.forceWeather('clear');
      io.ensureAround(door.x, door.z, 3);
      const stand = findInteriorStand(io.world, spec);
      if (stand) {
        const victim = io.spawnAt(stand);
        io.setCounter('victim', victim ?? 0);
      }
      io.edit(
        opening.map((cell) => ({ ...cell, material: BRICK })),
        'scenario: board up the door',
      );
    },
    objectives: [
      {
        id: 'out',
        description: 'Get the figure out of the house',
        done: (ctx) => {
          const victim = ctx.npcById(ctx.counter('victim'));
          return victim !== undefined && distance(victim.position, door) > 6;
        },
        deadline: 14400,
      },
      {
        id: 'alive',
        description: 'The figure survives',
        failed: (ctx) => ctx.npcById(ctx.counter('victim')) === undefined,
      },
    ],
    triggers: [
      {
        id: 'hint',
        when: (ctx) => ctx.ticks === 900,
        run: (io) => io.announce('Hint: the doorway is boarded — dig the two blocks out.'),
      },
    ],
  };
}

/** Build a scenario definition for a world (undefined = cannot run here). */
export function buildScenario(id: ScenarioId, sites: ScenarioSites): ScenarioDef | undefined {
  switch (id) {
    case 'flood':
      return floodScenario(sites);
    case 'fire':
      return fireScenario(sites);
    case 'collapse':
      return collapseScenario(sites);
    case 'demolition':
      return demolitionScenario(sites);
    case 'rescue':
      return rescueScenario(sites);
  }
}
