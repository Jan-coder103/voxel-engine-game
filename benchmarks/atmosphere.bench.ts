import { bench, describe } from 'vitest';
import { AtmosphereSim, START_TICK } from '../src/sim/atmosphere';
import { World } from '../src/voxel/world';
import { BLAST_HEAT, FireSim } from '../src/voxel/fire';
import { WOOD } from '../src/voxel/materials';

/**
 * Atmosphere baselines (Phase 16). The sim's per-tick cost must be
 * noise next to the frame budget — it runs every fixed step — and the
 * fire sim's rain path (per-burning-cell sky-exposure scans) must not
 * blow the fire budget when a storm meets a wide fire front. The fire
 * cases mirror benchmarks/fire.bench.ts's slab so the rain overhead is
 * readable against the clear-sky baseline.
 */

describe('atmosphere', () => {
  bench('tick — one fixed step (clock + weather + refresh)', () => {
    const sim = new AtmosphereSim(42);
    for (let i = 0; i < 60; i++) sim.tick();
  });

  bench('syncTo — fast-forward a full game year (76,800 ticks)', () => {
    const sim = new AtmosphereSim(42);
    sim.syncTo(START_TICK + 76_800);
  });
});

describe('fire × rain', () => {
  /** 16×16 wood slab at y=1 (256 cells), all just ignited. */
  function burningWorld(rain: number): FireSim {
    const world = new World(() => {});
    for (let cy = 0; cy < 2; cy++)
      for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) world.ensureChunk(cx, cy, cz);
    const fire = new FireSim(world);
    const cells: { x: number; y: number; z: number }[] = [];
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        world.setVoxel(x, 1, z, WOOD);
        cells.push({ x, y: 1, z });
      }
    }
    fire.heatCells(cells, BLAST_HEAT);
    fire.setRain(rain);
    fire.tick(256); // ignite everything — the next tick is steady burn
    return fire;
  }

  bench('tick — 256 burning cells, clear sky (no exposure scans)', () => {
    burningWorld(0).tick(256);
  });

  bench('tick — 256 burning cells, storm (per-cell sky scans)', () => {
    burningWorld(1).tick(256);
  });
});
