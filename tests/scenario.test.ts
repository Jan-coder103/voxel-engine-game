import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, BRICK, PIPE, PUMP, STONE, TAP, WATER, WOOD } from '../src/voxel/materials';
import { FluidSim } from '../src/voxel/fluid';
import { FireSim } from '../src/voxel/fire';
import { StructuralSim } from '../src/voxel/structure';
import { PlumbingSim } from '../src/voxel/plumbing';
import { NpcSim } from '../src/npc/npc';
import type { NavCell } from '../src/npc/navigation';
import type { VoxelEdit } from '../src/voxel/edits';
import type { Weather } from '../src/sim/atmosphere';
import { EventBus } from '../src/sim/events';
import {
  ScenarioEngine,
  type ScenarioContext,
  type ScenarioEngineEvent,
  type ScenarioIo,
} from '../src/scenario/engine';
import {
  buildScenario,
  enumerateBuildings,
  resolveSites,
  scenarioReady,
  scenarioTarget,
  type BuildingSite,
  type ScenarioSites,
} from '../src/scenario/definitions';
import { DEFAULT_TERRAIN, generateChunk, heightAt } from '../src/voxel/terrain';
import { applyTown } from '../src/worldgen/town';

/**
 * Scenario system (Phase 18): engine semantics on stub rigs, then every
 * scenario staged for real — burst mains pour through the Phase 15
 * plumbing, fires spread through the Phase 10 fire sim, collapses ride
 * the Phase 11 support graph, and the rescue victim is a real Phase 12
 * figure navigating out through the door the player dug open.
 */

// --- fixtures -------------------------------------------------------------

/** Flat stone plane (solid y ≤ 8) with a water-filled 6×6 lake at (12–17)². */
function lakeWorld(): World {
  return new World((chunk) => {
    const o = chunk.origin;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let ly = 0; ly < 16; ly++) {
          const y = o.y + ly;
          const x = o.x + lx;
          const z = o.z + lz;
          const inLake = x >= 12 && x <= 17 && z >= 12 && z <= 17;
          let material: number = AIR;
          if (y <= 8 && inLake) material = WATER;
          else if (y <= 8) material = STONE;
          chunk.volume.set(lx, ly, lz, material);
        }
      }
    }
  });
}

/** Flat stone plane (solid y ≤ 8), no lake. */
function flatWorld(): World {
  return new World((chunk) => {
    const o = chunk.origin;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let ly = 0; ly < 16; ly++) {
          chunk.volume.set(lx, ly, lz, o.y + ly <= 8 ? STONE : AIR);
        }
      }
    }
  });
}

/** Load every chunk a test touches (fixtures stay within ±3 chunks). */
function loadAll(world: World): void {
  for (let cy = 0; cy < 3; cy++) {
    for (let cz = -3; cz <= 3; cz++) {
      for (let cx = -3; cx <= 3; cx++) world.ensureChunk(cx, cy, cz);
    }
  }
}

interface Rig {
  world: World;
  fluid: FluidSim;
  fire: FireSim;
  structure: StructuralSim;
  plumbing: PlumbingSim;
  npc: NpcSim;
  bus: EventBus;
  playerPos: { x: number; y: number; z: number };
  io: ScenarioIo;
  engine: ScenarioEngine;
  events: ScenarioEngineEvent[];
  weather: Weather[];
  notes: string[];
}

function makeRig(world: World, npcOptions: { population?: number } = {}): Rig {
  loadAll(world);
  const fluid = new FluidSim(world);
  const fire = new FireSim(world);
  const structure = new StructuralSim(world);
  const plumbing = new PlumbingSim(world, fluid);
  const npc = new NpcSim(world, 1234, npcOptions);
  const bus = new EventBus();
  const rig = {
    world,
    fluid,
    fire,
    structure,
    plumbing,
    npc,
    bus,
    playerPos: { x: 0, y: 9, z: 0 },
    events: [],
    weather: [],
    notes: [],
  } as unknown as Rig;
  // main's wiring, in miniature: sim events ride the bus, collapses fall
  // as real edits, and the engine hears everything.
  fire.onEvent = (event) => bus.emit(event);
  npc.onEvent = (event) => bus.emit(event);
  structure.onCollapse = ({ cells }) => {
    for (const cell of cells) world.setVoxel(cell.x, cell.y, cell.z, AIR);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const cell of cells) {
      cx += cell.x;
      cy += cell.y;
      cz += cell.z;
    }
    bus.emit({
      type: 'structureCollapsed',
      x: cx / cells.length,
      y: cy / cells.length,
      z: cz / cells.length,
      cells: cells.length,
    });
  };
  rig.io = {
    world,
    npc,
    player: () => rig.playerPos,
    sensors: {
      leakCount: () => plumbing.leakCount,
      litCount: () => 0,
      burningCount: () => fire.burningCount,
    },
    edit: (edits: readonly VoxelEdit[], _label: string) => {
      for (const e of edits) world.setVoxel(e.x, e.y, e.z, e.material);
    },
    ignite: (x, y, z) => fire.ignite(x, y, z),
    forceWeather: (weather) => rig.weather.push(weather),
    ensureAround: () => {}, // fixture worlds are fully loaded
    spawnAt: (cell: NavCell) => npc.spawn(cell)?.id,
    setCounter: (key, value) => rig.engine.setCounter(key, value),
    announce: (text) => rig.notes.push(text),
  };
  rig.engine = new ScenarioEngine();
  rig.engine.onEvent = (event) => rig.events.push(event);
  bus.onAny((event) => rig.engine.onGameEvent(event));
  return rig;
}

/** One fixed step of the whole rig, in main's order; scenario last. */
function step(rig: Rig): void {
  rig.fluid.tick(384);
  rig.fire.tick(256);
  rig.structure.tick(2);
  rig.plumbing.tick(2);
  rig.npc.tick(rig.playerPos);
  rig.engine.tick(rig.io);
}

function runFor(rig: Rig, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(rig);
}

/** Wait until a predicate holds (rig ticks) or give up after `max`. */
function runUntil(rig: Rig, predicate: () => boolean, max = 1200): boolean {
  for (let i = 0; i < max; i++) {
    if (predicate()) return true;
    step(rig);
  }
  return predicate();
}

/**
 * Pump (lake rim) + pipe run + tap at y = 9 — the Phase 15 layout, laid
 * on SOLID ground (z = 20 is outside the lake basin): the generated main
 * is buried or post-supported, and the structural sim would rightly
 * topple a floating one once the burst hole appears.
 */
function layMain(world: World): { pump: NavCell; tap: NavCell; burst: NavCell } {
  world.setVoxel(12, 9, 20, WATER); // feeder pool cell beside the pump
  world.setVoxel(13, 9, 20, PUMP);
  for (const x of [14, 15, 16, 17]) world.setVoxel(x, 9, 20, PIPE);
  world.setVoxel(18, 9, 20, TAP);
  return {
    pump: { x: 13, y: 9, z: 20 },
    tap: { x: 18, y: 9, z: 20 },
    burst: { x: 16, y: 9, z: 20 },
  };
}

/** Wood shell: floor y=8, walls y 9–10, roof y=11, door gap at +x. */
function buildWoodHouse(world: World, bx: number, bz: number, w: number, d: number): BuildingSite {
  for (let z = bz; z < bz + d; z++) {
    for (let x = bx; x < bx + w; x++) {
      world.setVoxel(x, 8, z, WOOD); // floor
      world.setVoxel(x, 11, z, WOOD); // roof
    }
  }
  for (let y = 9; y <= 10; y++) {
    for (let z = bz; z < bz + d; z++) {
      for (let x = bx; x < bx + w; x++) {
        const edge = x === bx || x === bx + w - 1 || z === bz || z === bz + d - 1;
        if (edge) world.setVoxel(x, y, z, WOOD);
      }
    }
  }
  world.setVoxel(bx + w - 1, 9, bz + 1, AIR); // doorway (feet)
  world.setVoxel(bx + w - 1, 10, bz + 1, AIR); // doorway (head)
  const spec = {
    type: 'house' as const,
    ox: bx - 2,
    oz: bz - 2,
    bx,
    bz,
    w,
    d,
    baseY: 9,
    doorSide: 0 as const,
    doorPos: 1,
    floors: 1 as const,
    door: { x: bx + w, y: 9, z: bz + 1 },
  };
  return {
    spec,
    box: {
      min: { x: bx - 1, y: 7, z: bz - 1 },
      max: { x: bx + w, y: 19, z: bz + d },
    },
  };
}

/** Two-story wood building (slab at y=12) for collapse/demolition. */
function buildTwoStory(world: World, bx: number, bz: number, w: number, d: number): BuildingSite {
  for (let z = bz; z < bz + d; z++) {
    for (let x = bx; x < bx + w; x++) {
      world.setVoxel(x, 8, z, WOOD); // ground floor
      world.setVoxel(x, 12, z, WOOD); // slab
      world.setVoxel(x, 16, z, WOOD); // roof
    }
  }
  for (const [y0, y1] of [
    [9, 11],
    [13, 15],
  ]) {
    for (let y = y0; y <= y1; y++) {
      for (let z = bz; z < bz + d; z++) {
        for (let x = bx; x < bx + w; x++) {
          const edge = x === bx || x === bx + w - 1 || z === bz || z === bz + d - 1;
          if (edge) world.setVoxel(x, y, z, WOOD);
        }
      }
    }
  }
  world.setVoxel(bx + w - 1, 9, bz + 1, AIR);
  world.setVoxel(bx + w - 1, 10, bz + 1, AIR);
  const spec = {
    type: 'house' as const,
    ox: bx - 2,
    oz: bz - 2,
    bx,
    bz,
    w,
    d,
    baseY: 9,
    doorSide: 0 as const,
    doorPos: 1,
    floors: 2 as const,
    door: { x: bx + w, y: 9, z: bz + 1 },
  };
  return {
    spec,
    box: {
      min: { x: bx - 1, y: 7, z: bz - 1 },
      max: { x: bx + w, y: 23, z: bz + d },
    },
  };
}

function sitesWith(
  buildings: readonly BuildingSite[],
  overrides: Partial<ScenarioSites> = {},
): ScenarioSites {
  const first = buildings[0]?.spec.door ?? { x: 0, z: 0 };
  return {
    spawn: { x: first.x + 10, y: 9, z: first.z + 10 },
    buildings,
    generator: { x: 60, y: 9, z: 60 },
    ...overrides,
  };
}

// --- engine semantics -----------------------------------------------------

describe('scenario engine', () => {
  it('runs setup, announces, and counts ticks; idle ticks do nothing', () => {
    const rig = makeRig(flatWorld());
    let setups = 0;
    const def = {
      id: 't',
      title: 'T',
      briefing: 'b',
      setup: () => {
        setups++;
      },
      objectives: [],
    };
    rig.engine.tick(rig.io); // idle: no-op
    expect(rig.engine.current).toBe('idle');
    rig.engine.start(def, rig.io);
    expect(setups).toBe(1);
    expect(rig.engine.current).toBe('running');
    expect(rig.notes).toContain('b');
    expect(rig.events[0]).toMatchObject({ type: 'started', id: 't' });
    runFor(rig, 5);
    expect(rig.engine.elapsed).toBe(5);
  });

  it('completes when every done-objective is done and marks guard-only objectives', () => {
    const rig = makeRig(flatWorld());
    rig.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        objectives: [
          { id: 'g', description: 'guard', failed: () => false },
          { id: 'd', description: 'main', done: (ctx) => ctx.ticks >= 3 },
        ],
      },
      rig.io,
    );
    runFor(rig, 3);
    expect(rig.engine.current).toBe('complete');
    const views = rig.engine.objectiveViews();
    expect(views.map((v) => v.status)).toEqual(['done', 'done']);
    expect(rig.events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('fails with the objective description when a failed-condition fires', () => {
    const rig = makeRig(flatWorld());
    rig.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        objectives: [
          {
            id: 'x',
            description: 'do not touch the red button',
            failed: (ctx) => ctx.ticks >= 2,
          },
        ],
      },
      rig.io,
    );
    runFor(rig, 2);
    expect(rig.engine.current).toBe('failed');
    expect(rig.engine.failReason).toBe('do not touch the red button');
  });

  it('enforces deadlines only while unlocked, and honors after-gates', () => {
    const rig = makeRig(flatWorld());
    rig.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        objectives: [
          {
            id: 'gated',
            description: 'late work',
            after: (ctx) => ctx.counter('go') === 1,
            done: () => true,
            deadline: 5,
          },
        ],
      },
      rig.io,
    );
    runFor(rig, 20); // locked the whole time: the clock must not run
    expect(rig.engine.current).toBe('running');
    rig.engine.setCounter('go', 1);
    runFor(rig, 4); // unlocked now: done fires before the deadline (5)
    expect(rig.engine.current).toBe('complete');

    const rig2 = makeRig(flatWorld());
    rig2.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        objectives: [
          {
            id: 'gated',
            description: 'late work',
            after: (ctx) => ctx.counter('go') === 1,
            done: () => false,
            deadline: 5,
          },
        ],
      },
      rig2.io,
    );
    rig2.engine.setCounter('go', 1);
    runFor(rig2, 7);
    expect(rig2.engine.current).toBe('failed');
    expect(rig2.engine.failReason).toBe('too slow: late work');
  });

  it('fires each trigger once, at its tick', () => {
    const rig = makeRig(flatWorld());
    const seen: number[] = [];
    rig.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        objectives: [{ id: 'g', description: 'g', done: (ctx) => ctx.ticks >= 4 }],
        triggers: [
          {
            id: 'beat',
            when: (ctx) => ctx.ticks === 2,
            run: (_io, ctx) => seen.push(ctx.ticks),
          },
        ],
      },
      rig.io,
    );
    runFor(rig, 6);
    expect(seen).toEqual([2]);
  });

  it('applies scenario-level failure and time limits', () => {
    const rig = makeRig(flatWorld());
    rig.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        failed: (ctx) => ctx.counter('boom') === 1,
        objectives: [{ id: 'g', description: 'g', done: () => false }],
      },
      rig.io,
    );
    rig.engine.setCounter('boom', 1);
    rig.engine.tick(rig.io);
    expect(rig.engine.current).toBe('failed');
    expect(rig.engine.failReason).toBe('the situation got out of hand');

    const rig2 = makeRig(flatWorld());
    rig2.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        timeLimit: 10,
        objectives: [{ id: 'g', description: 'g', done: () => false }],
      },
      rig2.io,
    );
    runFor(rig2, 10);
    expect(rig2.engine.current).toBe('failed');
    expect(rig2.engine.failReason).toBe('out of time');
  });

  it('records bus events while running and answers the event queries', () => {
    const rig = makeRig(flatWorld());
    let probe: ScenarioContext | undefined;
    rig.engine.start(
      {
        id: 't',
        title: 'T',
        briefing: '',
        objectives: [{ id: 'g', description: 'g', done: (ctx) => ctx.ticks >= 6 }],
        triggers: [
          {
            id: 'probe',
            when: (ctx) => ctx.ticks === 3,
            run: (_io, ctx) => {
              probe = ctx;
            },
          },
        ],
      },
      rig.io,
    );
    rig.engine.onGameEvent({ type: 'fireIgnited', x: 1, y: 2, z: 3 }); // tick 0
    step(rig); // ticks = 1
    rig.bus.emit({ type: 'fireIgnited', x: 1, y: 2, z: 3 });
    rig.bus.emit({ type: 'fireIgnited', x: 50, y: 2, z: 50 });
    step(rig); // ticks = 2
    rig.bus.emit({ type: 'explosion', x: 2, y: 2, z: 3, radius: 2, destroyed: 1 });
    step(rig); // ticks = 3 — the trigger captures this tick's context
    expect(rig.engine.elapsed).toBe(3);
    expect(probe?.events('fireIgnited')).toBe(3); // incl. the manual one
    expect(probe?.events('explosion')).toBe(1);
    expect(probe?.eventsNear('fireIgnited', 1, 2, 3, 1)).toBe(2);
    expect(probe?.eventsNear('fireIgnited', 40, 2, 50, 12)).toBe(1);
    expect(
      probe?.eventsInBox('explosion', { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 3 } }),
    ).toBe(1);
    expect(probe?.lastEventTick('fireIgnited', 1, 2, 3, 1)).toBe(1);
    expect(probe?.eventsQuiet('fireIgnited', 1, 2, 3, 1, 2)).toBe(true); // last @1, now @3
    expect(probe?.eventsQuiet('fireIgnited', 1, 2, 3, 1, 3)).toBe(false);

    // Restarting clears the log.
    rig.engine.start(
      {
        id: 't2',
        title: 'T',
        briefing: '',
        objectives: [],
        triggers: [
          {
            id: 'probe',
            when: () => true,
            run: (_io, ctx) => {
              probe = ctx;
            },
          },
        ],
      },
      rig.io,
    );
    step(rig);
    expect(probe?.events('fireIgnited')).toBe(0);
  });

  it('stops cleanly and restarting replaces the run', () => {
    const rig = makeRig(flatWorld());
    rig.engine.start(
      {
        id: 'a',
        title: 'A',
        briefing: '',
        objectives: [{ id: 'g', description: 'g', done: () => false }],
      },
      rig.io,
    );
    runFor(rig, 3);
    rig.engine.stop();
    expect(rig.engine.current).toBe('idle');
    expect(rig.engine.active).toBeUndefined();
    rig.engine.start(
      {
        id: 'b',
        title: 'B',
        briefing: '',
        objectives: [{ id: 'g', description: 'g', done: (ctx) => ctx.ticks >= 1 }],
      },
      rig.io,
    );
    expect(rig.engine.elapsed).toBe(0); // restarted clock
    runFor(rig, 1);
    expect(rig.engine.current).toBe('complete');
  });

  it('counts cells in boxes through the world', () => {
    const rig = makeRig(flatWorld());
    rig.world.setVoxel(2, 9, 2, WOOD);
    rig.world.setVoxel(3, 9, 2, WATER);
    let probe: ScenarioContext | undefined;
    rig.engine.start(
      {
        id: 'probe',
        title: 'P',
        briefing: '',
        objectives: [{ id: 'g', description: 'g', done: (ctx) => ctx.ticks >= 2 }],
        triggers: [
          {
            id: 'read',
            when: () => true,
            run: (_io, ctx) => {
              probe = ctx;
            },
          },
        ],
      },
      rig.io,
    );
    step(rig);
    const box = { min: { x: 0, y: 8, z: 0 }, max: { x: 5, y: 10, z: 5 } };
    expect(probe?.countInBox(box, WOOD)).toBe(1);
    // The placed water is a fluid source and spreads while the rig runs,
    // so the census sees a blob, not a single cell.
    expect(probe?.countInBox(box, WATER)).toBeGreaterThanOrEqual(1);
    expect(probe?.countInBox(box, STONE)).toBe(36); // one solid layer
  });
});

// --- the five scenarios ---------------------------------------------------

describe('flood scenario', () => {
  it('bursts the main, and stop-the-leak completes when the supply is cut', () => {
    const rig = makeRig(lakeWorld());
    const main = layMain(rig.world);
    rig.plumbing.settle();
    expect(rig.plumbing.tapCount).toBe(1); // the main is pressurized

    const sites = sitesWith([], { main, generator: { x: 60, y: 9, z: 60 } });
    const def = buildScenario('flood', sites);
    expect(def).toBeDefined();
    expect(scenarioReady('flood', rig.world, sites)).toBe(true);
    rig.engine.start(def!, rig.io);
    expect(rig.weather).toContain('rain');
    expect(rig.world.getVoxel(main.burst.x, main.burst.y, main.burst.z)).toBe(AIR);
    expect(rig.plumbing.leakCount).toBe(1); // registered synchronously

    // Water pours into the hole and the scenario stays open.
    runFor(rig, 40);
    expect(rig.world.getVoxel(main.burst.x, main.burst.y, main.burst.z)).toBe(WATER);
    expect(rig.engine.current).toBe('running');

    // Cut the supply between pump and break; the far side depressurizes
    // and the leak is pruned → the scenario completes.
    rig.world.setVoxel(14, 9, 20, AIR);
    const done = runUntil(rig, () => rig.engine.current !== 'running', 600);
    expect(done).toBe(true);
    expect(rig.engine.current).toBe('complete');
    expect(rig.plumbing.leakCount).toBe(0);
  });

  it('fails if water reaches the power plant', () => {
    const rig = makeRig(lakeWorld());
    const main = layMain(rig.world);
    rig.plumbing.settle();
    // The "power plant" sits in a hollow right next to the burst.
    const sites = sitesWith([], { main, generator: { x: 20, y: 10, z: 20 } });
    rig.engine.start(buildScenario('flood', sites)!, rig.io);
    // Flood the guard box directly (the physics is not the point here).
    rig.fluid.pour(20, 10, 20, 10);
    const done = runUntil(rig, () => rig.engine.current !== 'running', 200);
    expect(done).toBe(true);
    expect(rig.engine.current).toBe('failed');
    expect(rig.engine.failReason).toBe('Keep the water off the power plant');
  });
});

describe('fire scenario', () => {
  it('stages a blaze in the nearest house and completes when it is doused', () => {
    const rig = makeRig(flatWorld());
    const house = buildWoodHouse(rig.world, 20, 20, 6, 5);
    const sites = sitesWith([house]);
    expect(scenarioReady('fire', rig.world, sites)).toBe(true);
    rig.engine.start(buildScenario('fire', sites)!, rig.io);
    expect(rig.weather).toContain('clear');
    expect(rig.fire.burningCount).toBeGreaterThan(0);
    runFor(rig, 32); // let it spread past the "out" guard
    expect(rig.engine.current).toBe('running');

    // Douse: water over every substance cell of the ground story.
    for (let y = 8; y <= 10; y++) {
      for (let z = 19; z <= 26; z++) {
        for (let x = 19; x <= 27; x++) {
          const m = rig.world.getVoxel(x, y, z);
          if (m !== AIR) rig.world.setVoxel(x, y, z, WATER);
        }
      }
    }
    const done = runUntil(rig, () => rig.engine.current !== 'running', 400);
    expect(done).toBe(true);
    expect(rig.engine.current).toBe('complete');
    expect(rig.fire.burningCount).toBe(0);
  });

  it('fails when the house burns down past half its structure', () => {
    const rig = makeRig(flatWorld());
    const house = buildWoodHouse(rig.world, 20, 20, 6, 5);
    rig.engine.start(buildScenario('fire', sitesWith([house]))!, rig.io);
    const done = runUntil(rig, () => rig.engine.current !== 'running', 6000);
    expect(done).toBe(true);
    expect(rig.engine.current).toBe('failed');
    expect(rig.engine.failReason).toBe('Keep the house standing');
  });

  it('fails when fire reaches a neighboring building', () => {
    const rig = makeRig(flatWorld());
    const house = buildWoodHouse(rig.world, 20, 20, 6, 5);
    const neighbor = buildWoodHouse(rig.world, 34, 20, 6, 5); // 8 cells away
    // Spawn beside the house so it (not the closer-to-spawn neighbor) is
    // the scenario's target.
    rig.engine.start(
      buildScenario('fire', sitesWith([house, neighbor], { spawn: { x: 20, y: 9, z: 30 } }))!,
      rig.io,
    );
    expect(rig.engine.active?.id).toBe('fire');
    // The blaze jumps: ignitions reported inside the neighbor's box.
    for (let i = 0; i < 4; i++) {
      rig.bus.emit({
        type: 'fireIgnited',
        x: neighbor.spec.bx,
        y: 9,
        z: neighbor.spec.bz,
      });
    }
    rig.engine.tick(rig.io);
    expect(rig.engine.current).toBe('failed');
    expect(rig.engine.failReason).toBe('Keep it off the neighbors');
  });
});

describe('collapse scenario', () => {
  it('brings the carved building down, then completes once it settles', () => {
    const rig = makeRig(flatWorld(), { population: 0 });
    const tower = buildTwoStory(rig.world, 20, 20, 6, 5);
    rig.playerPos = { x: 60, y: 9, z: 60 }; // player well clear
    rig.engine.start(buildScenario('collapse', sitesWith([tower]))!, rig.io);
    // Setup carved the ground courses and spawned a witness outside.
    expect(rig.world.getVoxel(20, 9, 20)).toBe(AIR);
    expect(rig.npc.count).toBe(1);
    runFor(rig, 2);
    expect(rig.engine.objectiveViews()[0]).toMatchObject({ status: 'done' }); // clear

    // The support graph takes the upper structure down; 'over' unlocks.
    const unlocked = runUntil(rig, () => rig.engine.objectiveViews()[1].hidden === false, 600);
    expect(unlocked).toBe(true);
    expect(rig.events.some((e) => e.type === 'objective' && e.status === 'done')).toBe(true);
    // …and once the cascade is quiet for 240 ticks, the scenario completes.
    const settled = runUntil(rig, () => rig.engine.current !== 'running', 2000);
    expect(settled).toBe(true);
    expect(rig.engine.current).toBe('complete');
    expect(rig.npc.count).toBe(1); // the witness is alive
  });

  it('fails if the witness dies in the rubble', () => {
    const rig = makeRig(flatWorld(), { population: 0 });
    const tower = buildTwoStory(rig.world, 20, 20, 6, 5);
    rig.playerPos = { x: 60, y: 9, z: 60 };
    rig.engine.start(buildScenario('collapse', sitesWith([tower]))!, rig.io);
    rig.bus.emit({
      type: 'npcDied',
      x: tower.spec.door.x,
      y: tower.spec.door.y,
      z: tower.spec.door.z,
      cause: 'drowned',
    });
    rig.engine.tick(rig.io);
    expect(rig.engine.current).toBe('failed');
    expect(rig.engine.failReason).toBe('The witness stays safe');
  });
});

describe('demolition scenario', () => {
  it('completes when the target is brought down cleanly', () => {
    const rig = makeRig(flatWorld(), { population: 0 });
    const target = buildTwoStory(rig.world, 20, 20, 6, 5);
    const neighbor = buildTwoStory(rig.world, 60, 60, 6, 5);
    rig.playerPos = { x: 60, y: 9, z: 60 };
    rig.engine.start(buildScenario('demolition', sitesWith([target, neighbor]))!, rig.io);
    expect(rig.engine.current).toBe('running');

    // The player razes it by hand: remove every substance cell in the box.
    for (let y = target.box.min.y; y <= target.box.max.y; y++) {
      for (let z = target.box.min.z; z <= target.box.max.z; z++) {
        for (let x = target.box.min.x; x <= target.box.max.x; x++) {
          const m = rig.world.getVoxel(x, y, z);
          if (m !== AIR && m !== WATER) rig.world.setVoxel(x, y, z, AIR);
        }
      }
    }
    const done = runUntil(rig, () => rig.engine.current !== 'running', 900);
    expect(done).toBe(true);
    expect(rig.engine.current).toBe('complete');
  });

  it('fails on collateral: an explosion inside a neighbor box', () => {
    const rig = makeRig(flatWorld(), { population: 0 });
    const target = buildTwoStory(rig.world, 20, 20, 6, 5);
    const neighbor = buildTwoStory(rig.world, 44, 20, 6, 5);
    rig.engine.start(
      buildScenario(
        'demolition',
        sitesWith([target, neighbor], { spawn: { x: 20, y: 9, z: 40 } }),
      )!,
      rig.io,
    );
    rig.bus.emit({
      type: 'explosion',
      x: neighbor.spec.bx + 1,
      y: 10,
      z: neighbor.spec.bz + 1,
      radius: 3,
      destroyed: 10,
    });
    rig.engine.tick(rig.io);
    expect(rig.engine.current).toBe('failed');
    expect(rig.engine.failReason).toBe('Keep the neighbors standing');
  });
});

describe('rescue scenario', () => {
  it('boards the door, and the dug-out figure walks free', () => {
    const rig = makeRig(flatWorld(), { population: 0 });
    const house = buildWoodHouse(rig.world, 20, 20, 6, 5);
    rig.engine.start(buildScenario('rescue', sitesWith([house]))!, rig.io);
    const door = house.spec.door;
    const boards = [
      { x: door.x - 1, y: 9, z: door.z },
      { x: door.x - 1, y: 10, z: door.z },
    ];
    expect(rig.world.getVoxel(boards[0].x, 9, boards[0].z)).toBe(BRICK);
    expect(rig.world.getVoxel(boards[1].x, 10, boards[1].z)).toBe(BRICK);
    expect(rig.npc.count).toBe(1);
    const victim = rig.npc.list()[0];

    // The victim tries to leave and cannot (boarded in).
    runFor(rig, 200);
    expect(Math.hypot(victim.position.x - door.x, victim.position.z - door.z)).toBeLessThan(8);

    // The player digs the boards out; the schedule sends the figure out.
    rig.npc.timeTicks = 9 * 100;
    rig.world.setVoxel(boards[0].x, 9, boards[0].z, AIR);
    rig.world.setVoxel(boards[1].x, 10, boards[1].z, AIR);
    const freed = runUntil(rig, () => rig.engine.current !== 'running', 4000);
    expect(freed).toBe(true);
    expect(rig.engine.current).toBe('complete');
    expect(rig.npc.count).toBe(1); // alive, not dead
  });
});

// --- site resolution on the real generator --------------------------------

describe('scenario sites', () => {
  const params = { ...DEFAULT_TERRAIN, seed: 24680 };

  it('resolves deterministic buildings, generator, and water main', () => {
    const sites = resolveSites(params);
    expect(sites.buildings.length).toBeGreaterThan(0);
    // Nearest-first ordering from the spawn.
    const d = (s: BuildingSite) =>
      Math.abs(s.spec.door.x - sites.spawn.x) + Math.abs(s.spec.door.z - sites.spawn.z);
    for (let i = 1; i < sites.buildings.length; i++) {
      expect(d(sites.buildings[i])).toBeGreaterThanOrEqual(d(sites.buildings[0]));
    }
    expect(sites.main).toBeDefined(); // seed 24680 has a water main
    expect(sites.main!.pump.y).toBe(params.seaLevel - 1);
    // Deterministic.
    const again = resolveSites(params);
    expect(again.buildings[0].spec.door).toEqual(sites.buildings[0].spec.door);
    expect(again.main).toEqual(sites.main);
  });

  it('targets houses for fire/rescue and any building otherwise', () => {
    const sites = resolveSites(params);
    expect(scenarioTarget('fire', sites)?.spec.type).toBe('house');
    expect(scenarioTarget('rescue', sites)?.spec.type).toBe('house');
    expect(scenarioTarget('demolition', sites)).toBeDefined();
    expect(scenarioTarget('collapse', sites)).toBeDefined();
  });

  it('enumerateBuildings yields a mixed town', () => {
    const buildings = enumerateBuildings(params);
    let houses = 0;
    let shops = 0;
    let industrial = 0;
    for (const b of buildings) {
      if (b.type === 'house') houses++;
      else if (b.type === 'shop') shops++;
      else industrial++;
    }
    expect(houses).toBeGreaterThan(0);
    expect(shops).toBeGreaterThan(0);
    expect(industrial).toBeGreaterThan(0);
  });

  it('scenarioReady rejects a main that is not there', () => {
    const rig = makeRig(lakeWorld());
    const main = layMain(rig.world);
    const sites = sitesWith([], { main });
    expect(scenarioReady('flood', rig.world, sites)).toBe(true);
    rig.world.setVoxel(main.burst.x, main.burst.y, main.burst.z, STONE);
    expect(scenarioReady('flood', rig.world, sites)).toBe(false);
  });

  it('a generated world can host every scenario (seed 24680)', () => {
    const world = new World((chunk) => {
      generateChunk(chunk, params);
      applyTown(chunk, params);
    });
    const sites = resolveSites(params);
    // Force-load around the fire target and the burst cell so the
    // fixtures exist (unloaded chunks read as air).
    const ensure = (x: number, z: number) => {
      const cx = Math.floor(x / 16);
      const cz = Math.floor(z / 16);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let cy = 0; cy < 3; cy++) world.ensureChunk(cx + dx, cy, cz + dz);
        }
      }
    };
    const target = scenarioTarget('fire', sites)!;
    ensure(target.spec.door.x, target.spec.door.z);
    if (sites.main) ensure(sites.main.burst.x, sites.main.burst.z);
    expect(scenarioReady('fire', world, sites)).toBe(true);
    expect(scenarioReady('rescue', world, sites)).toBe(true);
    expect(scenarioReady('collapse', world, sites)).toBe(true);
    expect(scenarioReady('demolition', world, sites)).toBe(true);
    expect(scenarioReady('flood', world, sites)).toBe(true);
    // Every definition builds.
    for (const id of ['flood', 'fire', 'collapse', 'demolition', 'rescue'] as const) {
      expect(buildScenario(id, sites)).toBeDefined();
    }
    expect(heightAt(target.spec.bx + 1, target.spec.bz + 1, params)).toBeGreaterThan(0);
  });
});
