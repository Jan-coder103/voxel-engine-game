import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, STONE, isSolidForCollision } from '../src/voxel/materials';
import { NpcSim, DAY_TICKS, TICKS_PER_HOUR, type NpcState } from '../src/npc/npc';

/**
 * NPC sim fixtures (Phase 12). The default world is a flat stone plane
 * with the surface at y=9 (solid y ≤ 8): no terrain surprises, so
 * schedule/behavior/movement rules are readable in the assertions.
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

const CENTER = { x: 8, z: 8 };

/** Run n ticks; returns the sim. */
function run(sim: NpcSim, n: number, center: { x: number; z: number } = CENTER): NpcSim {
  for (let i = 0; i < n; i++) sim.tick(center);
  return sim;
}

function first(sim: NpcSim): NpcState {
  expect(sim.count).toBeGreaterThan(0);
  return sim.list()[0];
}

/** True when the figure's feet cell is solid (a walk invariant). */
function insideSolid(world: World, npc: NpcState): boolean {
  return isSolidForCollision(
    world.getVoxel(
      Math.floor(npc.position.x),
      Math.floor(npc.position.y),
      Math.floor(npc.position.z),
    ),
  );
}

describe('npc: clock + spawn', () => {
  it('starts at 08:00 and advances one hour per 100 ticks', () => {
    const sim = new NpcSim(flatWorld(), 1);
    expect(sim.hourOfDay()).toBe(8);
    run(sim, TICKS_PER_HOUR);
    expect(sim.hourOfDay()).toBe(9);
  });

  it('spawns figures on walkable cells with feet on the ground', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    expect(npc.position).toEqual({ x: 4.5, y: 9, z: 4.5 });
    expect(npc.health).toBe(100);
    expect(npc.activity).toBe('idle');
    // Home and work anchors are walkable cells on the plane.
    for (const anchor of [npc.home, npc.work]) {
      expect(world.getVoxel(anchor.x, anchor.y - 1, anchor.z)).toBe(STONE);
      expect(world.getVoxel(anchor.x, anchor.y, anchor.z)).toBe(AIR);
    }
  });

  it('reset clears the population and the clock', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    sim.spawn({ x: 4, y: 9, z: 4 });
    run(sim, 50);
    sim.reset();
    expect(sim.count).toBe(0);
    expect(sim.hourOfDay()).toBe(8);
  });
});

describe('npc: needs', () => {
  it('hunger and sleep rise while awake, deterministically', () => {
    const make = () => {
      const world = flatWorld();
      groundChunked(world);
      const sim = new NpcSim(world, 1);
      const npc = sim.spawn({ x: 4, y: 9, z: 4 });
      return { sim, start: { ...npc.needs } };
    };
    const a = make();
    const b = make();
    run(a.sim, 500);
    run(b.sim, 500);
    const na = first(a.sim).needs;
    const nb = first(b.sim).needs;
    expect(na).toEqual(nb);
    expect(na.hunger).toBeGreaterThan(a.start.hunger);
    // Sleep rises by 100 per (virtual) day while awake.
    expect(na.sleep - a.start.sleep).toBeCloseTo(500 * (100 / DAY_TICKS), 5);
  });

  it('sleeping restores sleep need', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    npc.needs.sleep = 95;
    sim.timeTicks = 23 * TICKS_PER_HOUR; // night: bedtime
    let slept = false;
    for (let i = 0; i < 1400 && !slept; i++) {
      sim.tick(CENTER);
      if (npc.activity === 'sleep') slept = true;
    }
    expect(slept).toBe(true);
    // Rest runs until the need drops below the wake threshold (~450 ticks
    // of sleep), then the figure wakes even in the middle of the night…
    let woke = false;
    for (let i = 0; i < 900 && !woke; i++) {
      sim.tick(CENTER);
      if (npc.activity !== 'sleep') woke = true;
    }
    expect(woke).toBe(true);
    expect(npc.needs.sleep).toBeLessThan(30);
  });
});

describe('npc: schedule + behavior', () => {
  it('goes home and sleeps at night, then wakes at dawn', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    sim.timeTicks = 23 * TICKS_PER_HOUR;
    // Night is 7 game hours; give the walk + idle waits room to finish.
    let slept = false;
    for (let i = 0; i < 1400 && !slept; i++) {
      sim.tick(CENTER);
      if (npc.activity === 'sleep') slept = true;
    }
    expect(slept).toBe(true);
    // Sleepers rest at their home anchor.
    expect(npc.position.x).toBe(npc.home.x + 0.5);
    expect(npc.position.z).toBe(npc.home.z + 0.5);
    // Past dawn the figure wakes up.
    sim.timeTicks = 7 * TICKS_PER_HOUR;
    run(sim, DAY_TICKS / 4);
    expect(npc.activity).not.toBe('sleep');
  });

  it('exhaustion sends the figure to bed even at noon', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    npc.needs.sleep = 95; // dead on their feet
    sim.timeTicks = 12 * TICKS_PER_HOUR; // noon
    let slept = false;
    for (let i = 0; i < 1400 && !slept; i++) {
      sim.tick(CENTER);
      if (npc.activity === 'sleep') slept = true;
    }
    expect(slept).toBe(true);
  });

  it('wanders during evening leisure and actually moves', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    sim.timeTicks = 18 * TICKS_PER_HOUR; // after work, before bed
    let moved = 0;
    let wandered = false;
    const startX = npc.position.x;
    for (let i = 0; i < 2000; i++) {
      sim.tick(CENTER);
      if (npc.activity === 'wander') wandered = true;
      if (npc.position.x !== startX) moved++;
    }
    expect(wandered).toBe(true);
    expect(moved).toBeGreaterThan(0);
  });
});

describe('npc: navigation in a mutable world', () => {
  it('re-paths when a wall rises across the path (local invalidation)', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    sim.timeTicks = 18 * TICKS_PER_HOUR;
    // Walk until a path is active.
    for (let i = 0; i < 600 && npc.pathIndex >= npc.path.length; i++) sim.tick(CENTER);
    expect(npc.path.length).toBeGreaterThan(0);
    // Wall off every remaining path cell (2 high, so no step-over).
    for (let i = npc.pathIndex; i < npc.path.length; i++) {
      const c = npc.path[i];
      world.setVoxel(c.x, c.y, c.z, STONE);
      world.setVoxel(c.x, c.y + 1, c.z, STONE);
    }
    expect(npc.repath).toBe(true);
    // From here on the figure must never stand inside solid matter.
    for (let i = 0; i < 1000; i++) {
      sim.tick(CENTER);
      expect(insideSolid(world, npc)).toBe(false);
    }
  });

  it('falls when the ground under it vanishes and lands on the next floor', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1);
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    world.setVoxel(4, 8, 4, AIR); // floor gone (as a collapse would)
    run(sim, 30);
    expect(npc.falling).toBe(false); // landed by now
    expect(npc.position.y).toBeLessThan(9);
    expect(insideSolid(world, npc)).toBe(false);
  });

  it('is swept away when it lands in water', () => {
    const world = flatWorld();
    groundChunked(world);
    const sim = new NpcSim(world, 1, { population: 0 });
    const npc = sim.spawn({ x: 4, y: 9, z: 4 });
    // A water pocket one floor down.
    world.setVoxel(4, 8, 4, AIR);
    world.setVoxel(4, 7, 4, AIR);
    world.setVoxel(4, 7, 4, 6); // WATER — setVoxel overwrite
    world.setVoxel(4, 8, 4, 6);
    run(sim, 60);
    expect(sim.list().includes(npc)).toBe(false);
  });
});

describe('npc: population', () => {
  it('fills toward the target and despawns strays', () => {
    const world = flatWorld();
    // Wide ground plane so ring spawns at r ≤ 60 land on solid ground.
    for (let cz = -4; cz <= 4; cz++) for (let cx = -4; cx <= 4; cx++) world.ensureChunk(cx, 0, cz);
    const sim = new NpcSim(world, 1, { population: 5 });
    run(sim, 100);
    expect(sim.count).toBe(5);
    // Moving the center far away strands everyone → despawned.
    run(sim, 200, { x: 8 + 400, z: 8 });
    expect(sim.count).toBe(0);
  });
});

describe('npc: determinism + invariants', () => {
  it('identical sims tick identically', () => {
    const make = () => {
      const world = flatWorld();
      groundChunked(world);
      const sim = new NpcSim(world, 4242);
      sim.spawn({ x: 4, y: 9, z: 4 });
      sim.spawn({ x: 10, y: 9, z: 10 });
      return { world, sim };
    };
    const a = make();
    const b = make();
    for (let i = 0; i < 1200; i++) {
      a.sim.tick(CENTER);
      b.sim.tick(CENTER);
    }
    const sa = a.sim.list().map((n) => ({
      p: { ...n.position },
      yaw: n.yaw,
      act: n.activity,
      needs: { ...n.needs },
    }));
    const sb = b.sim.list().map((n) => ({
      p: { ...n.position },
      yaw: n.yaw,
      act: n.activity,
      needs: { ...n.needs },
    }));
    expect(sa).toEqual(sb);
  });

  it('survives 5000 ticks without ever standing inside solid matter', () => {
    const world = flatWorld();
    groundChunked(world);
    // A caller also carves and builds while the sim runs.
    const sim = new NpcSim(world, 7, { population: 4 });
    let maxSeen = 0;
    for (let i = 0; i < 5000; i++) {
      if (i === 1000) world.setVoxel(8, 9, 8, STONE); // wall on the plaza
      if (i === 2000) world.setVoxel(8, 9, 8, AIR);
      if (i === 3000) world.setVoxel(12, 8, 12, AIR); // hole
      sim.tick(CENTER);
      maxSeen = Math.max(maxSeen, sim.count);
      for (const npc of sim.list()) {
        expect(insideSolid(world, npc)).toBe(false);
        expect(npc.position.y).toBeGreaterThan(0);
        expect(npc.position.y).toBeLessThan(32);
        expect(npc.health).toBe(100);
      }
    }
    expect(maxSeen).toBeGreaterThan(0);
  });
});
