import { describe, expect, it } from 'vitest';
import {
  AtmosphereSim,
  DAY_TICKS,
  SEASONS,
  START_TICK,
  TICKS_PER_HOUR,
  WEATHERS,
  skyPalette,
} from '../src/sim/atmosphere';
import { hash3 } from '../src/voxel/terrain';
import { World } from '../src/voxel/world';
import { AIR, STONE, WOOD } from '../src/voxel/materials';
import { FireSim } from '../src/voxel/fire';
import { NpcSim } from '../src/npc/npc';
import type { GameEvent } from '../src/sim/events';

/**
 * Phase 16 atmosphere tests: the world clock, the deterministic weather
 * chain, the sun/season path, the palette mapping, and the two couplings
 * that consume it — rain vs. fire and the NPC schedule/light clock.
 */

function flatWorld(): World {
  return new World((chunk) => {
    const o = chunk.origin;
    for (let lz = 0; lz < 16; lz++)
      for (let lx = 0; lx < 16; lx++)
        for (let ly = 0; ly < 16; ly++) chunk.volume.set(lx, ly, lz, o.y + ly <= 8 ? STONE : AIR);
  });
}

function groundChunked(world: World): void {
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, 0, cz);
}

describe('atmosphere: clock', () => {
  it('starts at 08:00 and advances one hour per 100 ticks', () => {
    const sim = new AtmosphereSim(1);
    expect(sim.snapshot.hour).toBe(8);
    for (let i = 0; i < TICKS_PER_HOUR; i++) sim.tick();
    expect(sim.hourOfDay).toBe(9);
    expect(sim.clockString()).toBe('09:00');
  });

  it('counts days and names seasons', () => {
    const sim = new AtmosphereSim(1);
    sim.syncTo(1.5 * DAY_TICKS);
    expect(sim.snapshot.day).toBe(1);
    sim.syncTo(SEASONS.length * 0 * DAY_TICKS); // no-op sanity
    sim.syncTo(12 * DAY_TICKS + 12 * TICKS_PER_HOUR);
    expect(sim.snapshot.season).toBe('summer'); // days 8–15
    sim.syncTo(28 * DAY_TICKS);
    expect(sim.snapshot.season).toBe('winter'); // days 24–31
  });
});

describe('atmosphere: determinism', () => {
  it('produces identical chains for identical seeds and ticks', () => {
    const a = new AtmosphereSim(42);
    const b = new AtmosphereSim(42);
    for (let i = 0; i < 5000; i++) a.tick();
    b.syncTo(START_TICK + 5000);
    expect(a.exportState()).toEqual(b.exportState());
  });

  it('syncTo equals stepping from a deep mid-chain point', () => {
    const a = new AtmosphereSim(7);
    const b = new AtmosphereSim(7);
    a.syncTo(START_TICK + 100_000);
    b.syncTo(START_TICK + 100_000);
    for (let i = 0; i < 500; i++) a.tick();
    b.syncTo(START_TICK + 100_500);
    expect(a.exportState()).toEqual(b.exportState());
  });

  it('different seeds eventually disagree', () => {
    const a = new AtmosphereSim(1);
    const b = new AtmosphereSim(2);
    let diverged = false;
    for (let t = 0; t < 30_000 && !diverged; t++) {
      a.tick();
      b.tick();
      diverged = a.exportState().weather !== b.exportState().weather;
    }
    expect(diverged).toBe(true);
  });
});

describe('atmosphere: weather machine', () => {
  it('reaches every weather state across seeds', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const sim = new AtmosphereSim(seed);
      for (let t = 0; t < 400_000; t += 1500) {
        sim.syncTo(START_TICK + t);
        seen.add(sim.weather);
      }
    }
    for (const w of WEATHERS) expect(seen.has(w)).toBe(true);
  });

  it('changes weather smoothly — no per-tick jumps', () => {
    const sim = new AtmosphereSim(3);
    let last = sim.snapshot.cloudiness;
    for (let i = 0; i < 6000; i++) {
      sim.tick();
      const now = sim.snapshot.cloudiness;
      expect(Math.abs(now - last)).toBeLessThan(0.02);
      last = now;
    }
  });

  it('forceWeather takes effect within its fade', () => {
    const sim = new AtmosphereSim(3);
    sim.forceWeather('storm', 10_000);
    expect(sim.weather).toBe('storm');
    for (let i = 0; i < 60; i++) sim.tick();
    expect(sim.snapshot.precip).toBeGreaterThan(0.5);
  });

  it('strikes lightning only in storms, deterministically', () => {
    const sim = new AtmosphereSim(5);
    sim.forceWeather('storm', 200_000);
    const strikes: { x: number; z: number }[] = [];
    sim.onStrike = (x, z) => strikes.push({ x, z });
    // Find the next tick whose hash rolls under the strike chance —
    // the same hash the sim rolls, so the wait is exact, not lucky.
    let t = sim.timeTicks + 1;
    while (hash3(5, 7777, t, 0) >= 1 / 650) t++;
    sim.syncTo(t - 1);
    sim.tick();
    expect(strikes.length).toBe(1);
    const dist = Math.hypot(strikes[0].x, strikes[0].z);
    expect(dist).toBeGreaterThanOrEqual(9);
    expect(dist).toBeLessThanOrEqual(45);
    // A clear tick on the same chain strikes nothing.
    const strikesBefore = strikes.length;
    sim.syncTo(t + 50);
    sim.tick();
    expect(strikes.length).toBe(strikesBefore);
  });
});

describe('atmosphere: sun and seasons', () => {
  it('is light at noon and dark at midnight', () => {
    const sim = new AtmosphereSim(1);
    sim.syncTo(12 * TICKS_PER_HOUR);
    expect(sim.snapshot.sunElevation).toBeGreaterThan(0.55);
    expect(sim.snapshot.daylight).toBeGreaterThan(0.9);
    sim.syncTo(0); // midnight of day 0
    expect(sim.snapshot.sunElevation).toBeLessThan(0);
    expect(sim.snapshot.daylight).toBe(0);
  });

  it('summer noon is higher than winter noon, and summer mornings start earlier', () => {
    const sim = new AtmosphereSim(1);
    sim.syncTo(12 * DAY_TICKS + 12 * TICKS_PER_HOUR); // summer noon
    const summerNoon = sim.snapshot.sunElevation;
    sim.syncTo(28 * DAY_TICKS + 12 * TICKS_PER_HOUR); // winter noon
    const winterNoon = sim.snapshot.sunElevation;
    expect(summerNoon).toBeGreaterThan(winterNoon);

    sim.syncTo(12 * DAY_TICKS + 6 * TICKS_PER_HOUR); // 06:00 in summer
    expect(sim.snapshot.daylight).toBeGreaterThan(0);
    sim.syncTo(28 * DAY_TICKS + 6 * TICKS_PER_HOUR); // 06:00 in winter
    expect(sim.snapshot.daylight).toBe(0);
  });

  it('winter is colder than summer, storms cooler than clear, nights cooler than afternoons', () => {
    const summer = new AtmosphereSim(1);
    summer.syncTo(12 * DAY_TICKS + 14 * TICKS_PER_HOUR);
    const winter = new AtmosphereSim(1);
    winter.syncTo(28 * DAY_TICKS + 14 * TICKS_PER_HOUR);
    expect(summer.temperature).toBeGreaterThan(winter.temperature);

    const clear = new AtmosphereSim(9);
    clear.syncTo(12 * DAY_TICKS + 14 * TICKS_PER_HOUR);
    const stormy = new AtmosphereSim(9);
    stormy.syncTo(12 * DAY_TICKS + 14 * TICKS_PER_HOUR);
    stormy.forceWeather('storm', 50_000);
    for (let i = 0; i < 200; i++) stormy.tick();
    expect(clear.temperature).toBeGreaterThan(stormy.temperature);

    const night = new AtmosphereSim(1);
    night.syncTo(12 * DAY_TICKS + 2 * TICKS_PER_HOUR);
    const afternoon = new AtmosphereSim(1);
    afternoon.syncTo(12 * DAY_TICKS + 14 * TICKS_PER_HOUR);
    expect(afternoon.temperature).toBeGreaterThan(night.temperature);
  });

  it('snows in a winter storm, rains in a summer one', () => {
    const winter = new AtmosphereSim(1);
    winter.syncTo(28 * DAY_TICKS);
    winter.forceWeather('rain', 50_000);
    for (let i = 0; i < 100; i++) winter.tick();
    expect(winter.snapshot.snowing).toBe(true);

    const summer = new AtmosphereSim(1);
    summer.syncTo(12 * DAY_TICKS);
    summer.forceWeather('rain', 50_000);
    for (let i = 0; i < 100; i++) summer.tick();
    expect(summer.snapshot.snowing).toBe(false);
  });
});

describe('atmosphere: palette', () => {
  it('noon is bright with no stars; night is dark with stars', () => {
    const sim = new AtmosphereSim(1);
    sim.syncTo(12 * TICKS_PER_HOUR);
    const noon = skyPalette(sim.snapshot);
    expect(noon.sunIntensity).toBeGreaterThan(0.9);
    expect(noon.starOpacity).toBeLessThan(0.05);
    const noonLuma = (noon.zenith >> 16) + ((noon.zenith >> 8) & 255);

    sim.syncTo(0);
    const night = skyPalette(sim.snapshot);
    expect(night.sunIntensity).toBe(0);
    expect(night.starOpacity).toBeGreaterThan(0.5);
    const nightLuma = (night.zenith >> 16) + ((night.zenith >> 8) & 255);
    expect(nightLuma).toBeLessThan(noonLuma / 4);
    expect(night.moonDisc).toBeGreaterThan(0);
  });

  it('the horizon warms at dawn', () => {
    const sim = new AtmosphereSim(1);
    // Sunrise of a summer day: daylight 0.56 → the sun crests at 05:28.
    const summerSunrise = Math.round(((1 - 0.56) / 2) * DAY_TICKS);
    sim.syncTo(12 * DAY_TICKS + summerSunrise);
    expect(Math.abs(sim.snapshot.sunElevation)).toBeLessThan(0.05);
    const dawn = skyPalette(sim.snapshot);
    const r = (dawn.horizon >> 16) & 255;
    const b = dawn.horizon & 255;
    expect(r).toBeGreaterThan(b);
  });

  it('storms darken a clear noon', () => {
    const sim = new AtmosphereSim(1);
    sim.syncTo(12 * DAY_TICKS + 12 * TICKS_PER_HOUR);
    const clear = skyPalette(sim.snapshot);
    sim.forceWeather('storm', 50_000);
    for (let i = 0; i < 200; i++) sim.tick();
    const storm = skyPalette(sim.snapshot);
    expect(storm.sunIntensity).toBeLessThan(clear.sunIntensity / 2);
    expect(storm.zenith).not.toBe(clear.zenith);
  });
});

describe('fire × rain (Phase 16 coupling)', () => {
  it('douses an exposed fire with cause rain and leaves the voxel', () => {
    const world = new World(() => {});
    for (let cy = 0; cy < 2; cy++)
      for (let cz = -1; cz <= 1; cz++)
        for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
    world.setVoxel(0, 1, 0, WOOD);
    const fire = new FireSim(world);
    const events: GameEvent[] = [];
    fire.onEvent = (event) => events.push(event);
    expect(fire.ignite(0, 1, 0)).toBe(true);
    fire.setRain(1);
    let doused = false;
    for (let i = 0; i < 200 && !doused; i++) {
      fire.tick();
      doused = !fire.isBurning(0, 1, 0);
    }
    expect(doused).toBe(true);
    const last = [...events].reverse().find((e) => e.type === 'fireExtinguished');
    expect(last && last.type === 'fireExtinguished' && last.cause).toBe('rain');
    expect(world.getVoxel(0, 1, 0)).toBe(WOOD); // doused, not consumed
  });

  it('a roofed fire keeps burning through the same rain', () => {
    const world = new World(() => {});
    for (let cy = 0; cy < 2; cy++)
      for (let cz = -1; cz <= 1; cz++)
        for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
    world.setVoxel(0, 1, 0, WOOD);
    world.setVoxel(0, 2, 0, STONE); // a roof: rain never reaches the fire
    const fire = new FireSim(world);
    expect(fire.ignite(0, 1, 0)).toBe(true);
    fire.setRain(1);
    for (let i = 0; i < 200; i++) fire.tick();
    expect(fire.isBurning(0, 1, 0)).toBe(true);
    expect(fire.exportState().wet.length).toBe(0);
  });

  it('refuses exposed ignition in rain unless forced', () => {
    const world = new World(() => {});
    for (let cy = 0; cy < 2; cy++)
      for (let cz = -1; cz <= 1; cz++)
        for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
    world.setVoxel(0, 1, 0, WOOD);
    world.setVoxel(4, 1, 4, WOOD);
    world.setVoxel(4, 2, 4, STONE);
    const fire = new FireSim(world);
    fire.setRain(1);
    expect(fire.ignite(0, 1, 0)).toBe(false); // exposed in the rain
    expect(fire.ignite(4, 1, 4)).toBe(true); // roofed: fine
    expect(fire.ignite(0, 1, 0, true)).toBe(true); // lightning forces it
    expect(fire.isBurning(0, 1, 0)).toBe(true);
  });
});

describe('npc × atmosphere (Phase 16 wiring)', () => {
  it('the schedule follows an injected world clock, and reset keeps it', () => {
    const world = flatWorld();
    groundChunked(world);
    let worldTicks = 8 * TICKS_PER_HOUR;
    const sim = new NpcSim(world, 1, { clock: () => worldTicks });
    sim.spawn({ x: 4, y: 9, z: 4 });
    for (let i = 0; i < 50; i++) sim.tick({ x: 8, z: 8 });
    expect(sim.hourOfDay()).toBe(8); // a stopped clock holds the hour
    worldTicks = 23 * TICKS_PER_HOUR;
    for (let i = 0; i < 1; i++) sim.tick({ x: 8, z: 8 });
    expect(sim.hourOfDay()).toBe(23);
    worldTicks = 25 * TICKS_PER_HOUR; // next-day 01:00
    sim.tick({ x: 8, z: 8 });
    expect(sim.hourOfDay()).toBe(1);
    sim.reset();
    expect(sim.hourOfDay()).toBe(1); // the clock is the atmosphere's
  });

  it('night sends figures home', () => {
    const world = flatWorld();
    groundChunked(world);
    let worldTicks = 8 * TICKS_PER_HOUR;
    const sim = new NpcSim(world, 1, { clock: () => worldTicks });
    const figure = sim.spawn({ x: 4, y: 9, z: 4 });
    figure.waitTicks = 0;
    worldTicks = 23 * TICKS_PER_HOUR;
    for (let i = 0; i < 400; i++) sim.tick({ x: 8, z: 8 });
    const seen = sim.list()[0];
    expect(seen.activity === 'sleep' || seen.intent === 'home').toBe(true);
  });

  it('moonlight shrinks sight: a nearby fire is seen by day, missed by night', () => {
    const make = (lightLevel: () => number) => {
      const world = flatWorld();
      groundChunked(world);
      const sim = new NpcSim(world, 1, { lightLevel });
      const figure = sim.spawn({ x: 4, y: 9, z: 4 });
      figure.waitTicks = 1000; // stand still, face -Z (yaw 0)
      // A fire threat 10 cells ahead: inside the 12-cell alarm radius
      // (so vision decides) but outside moonlit sight (24·0.35 ≈ 8.4),
      // and too far to wake/startle directly (5). Only a vision scan
      // can add fear — sight range is the discriminator.
      sim.notify({ type: 'fireIgnited', x: 4, y: 10, z: -6 });
      return { sim, figure };
    };
    const day = make(() => 1);
    const night = make(() => 0);
    for (let i = 0; i < 25; i++) {
      day.sim.tick({ x: 8, z: 8 });
      night.sim.tick({ x: 8, z: 8 });
    }
    expect(day.figure.fear).toBeGreaterThan(10); // seen → afraid
    expect(night.figure.fear).toBe(0); // beyond moonlit sight range
  });
});
