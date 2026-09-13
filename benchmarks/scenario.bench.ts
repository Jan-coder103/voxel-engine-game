import { bench, describe } from 'vitest';
import { World } from '../src/voxel/world';
import { FluidSim } from '../src/voxel/fluid';
import { FireSim } from '../src/voxel/fire';
import { StructuralSim } from '../src/voxel/structure';
import { PlumbingSim } from '../src/voxel/plumbing';
import { NpcSim } from '../src/npc/npc';
import { ScenarioEngine, type ScenarioIo } from '../src/scenario/engine';
import { buildScenario, resolveSites, type ScenarioSites } from '../src/scenario/definitions';
import { DEFAULT_TERRAIN, generateChunk } from '../src/voxel/terrain';
import { applyTown } from '../src/worldgen/town';

/**
 * Scenario baselines (Phase 18). The engine runs every fixed step, so
 * its idle evaluation cost must be noise (it is a handful of closures
 * over cached counts — no scans). The heavy parts of a scenario (fire
 * spread, flood pouring, collapse analyses) are budgeted inside their
 * own sims and measured there; these numbers isolate the scenario
 * layer's own overhead, including a live event stream to evaluate
 * event queries against.
 */

function scenarioRig(): { engine: ScenarioEngine; io: ScenarioIo; sites: ScenarioSites } {
  const terrain = { ...DEFAULT_TERRAIN, seed: 24680 };
  const world = new World((chunk) => {
    generateChunk(chunk, terrain);
    applyTown(chunk, terrain);
  });
  // Load the square around the fire target so the staged sims have cells.
  const sites = resolveSites(terrain);
  const cx = Math.floor(sites.buildings[0].spec.door.x / 16);
  const cz = Math.floor(sites.buildings[0].spec.door.z / 16);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let cy = 0; cy < 3; cy++) world.ensureChunk(cx + dx, cy, cz + dz);
    }
  }
  const fluid = new FluidSim(world);
  const fire = new FireSim(world);
  new StructuralSim(world); // wired for event fidelity; collapses don't occur here
  const plumbing = new PlumbingSim(world, fluid);
  const npc = new NpcSim(world, terrain.seed, { population: 0 });
  const engine = new ScenarioEngine();
  const io: ScenarioIo = {
    world,
    npc,
    player: () => ({ x: 0, y: 9, z: 0 }),
    sensors: {
      leakCount: () => plumbing.leakCount,
      litCount: () => 0,
      burningCount: () => fire.burningCount,
    },
    edit: () => {},
    ignite: (x, y, z) => fire.ignite(x, y, z),
    forceWeather: () => {},
    ensureAround: () => {},
    spawnAt: (cell) => npc.spawn(cell)?.id,
    setCounter: (key, value) => engine.setCounter(key, value),
    announce: () => {},
  };
  return { engine, io, sites };
}

describe('scenario engine', () => {
  bench('idle fire-scenario tick (objectives + sensors, no events)', () => {
    const { engine, io, sites } = scenarioRig();
    const def = buildScenario('fire', sites)!;
    engine.start(def, io);
    for (let i = 0; i < 600; i++) engine.tick(io); // 10 s of fixed steps
  });

  bench('fire-scenario tick under a 512-event stream', () => {
    const { engine, io, sites } = scenarioRig();
    const def = buildScenario('fire', sites)!;
    engine.start(def, io);
    for (let i = 0; i < 512; i++) {
      engine.onGameEvent({ type: 'fireIgnited', x: i % 40, y: 9, z: (i * 7) % 40 });
    }
    for (let i = 0; i < 600; i++) engine.tick(io);
  });
});
