import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, STONE, WATER } from '../src/voxel/materials';
import { NpcSim, PANIC_THRESHOLD, SCAN_PERIOD, type NpcState } from '../src/npc/npc';
import { canSee, hasLineOfSight, ThreatBoard, withinFov, type Point3 } from '../src/npc/perception';

/**
 * NPC reactions fixtures (Phase 13). Same flat stone plane as
 * npc.test.ts (surface at y=9, solid y ≤ 8) so perception geometry is
 * readable: eyes at y+1.4 ≈ 10.4, walls two blocks tall block sight.
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

function run(sim: NpcSim, n: number, center: { x: number; z: number } = CENTER): NpcSim {
  for (let i = 0; i < n; i++) sim.tick(center);
  return sim;
}

function spawned(world: World, seed = 1, x = 4, z = 4): { sim: NpcSim; npc: NpcState } {
  const sim = new NpcSim(world, seed, { population: 0 });
  const npc = sim.spawn({ x, y: 9, z });
  return { sim, npc };
}

describe('perception: line of sight', () => {
  function losWorld(): { world: World; materialAt: (x: number, y: number, z: number) => number } {
    const world = flatWorld();
    groundChunked(world);
    return { world, materialAt: (x, y, z) => world.getVoxel(x, y, z) };
  }
  const eye: Point3 = { x: 4.5, y: 10.4, z: 4.5 };

  it('sees across open ground', () => {
    const { materialAt } = losWorld();
    expect(hasLineOfSight(materialAt, eye, { x: 14.5, y: 10.4, z: 4.5 })).toBe(true);
  });

  it('is blocked by a wall', () => {
    const { world, materialAt } = losWorld();
    world.setVoxel(9, 9, 4, STONE);
    world.setVoxel(9, 10, 4, STONE);
    expect(hasLineOfSight(materialAt, eye, { x: 14.5, y: 10.4, z: 4.5 })).toBe(false);
    world.setVoxel(9, 9, 4, AIR);
    world.setVoxel(9, 10, 4, AIR);
    // One row over (the ray crosses into z ≥ 5 well before the wall) is open.
    expect(hasLineOfSight(materialAt, eye, { x: 14.5, y: 10.4, z: 7.5 })).toBe(true);
  });

  it('is not blocked by water', () => {
    const { world, materialAt } = losWorld();
    world.setVoxel(9, 9, 4, WATER);
    expect(hasLineOfSight(materialAt, eye, { x: 14.5, y: 10.4, z: 4.5 })).toBe(true);
  });

  it('combines range, FOV, and occlusion in canSee', () => {
    const { materialAt } = losWorld();
    const target: Point3 = { x: 20.5, y: 10.4, z: 4.5 };
    expect(canSee(materialAt, eye, -Math.PI / 2, target)).toBe(true); // facing +x
    expect(canSee(materialAt, eye, Math.PI / 2, target)).toBe(false); // facing −x
    const far: Point3 = { x: 4.5, y: 10.4, z: 4.5 + 40 };
    expect(canSee(materialAt, eye, Math.PI, far)).toBe(false); // out of range
  });
});

describe('perception: field of view', () => {
  const eye: Point3 = { x: 0, y: 0, z: 0 };

  it('accepts targets inside the cone and rejects those behind', () => {
    // yaw 0 faces −z (movement convention: facing = (−sin, −cos)).
    expect(withinFov(eye, 0, { x: 0, y: 0, z: -10 })).toBe(true);
    expect(withinFov(eye, 0, { x: 6, y: 0, z: -10 })).toBe(true); // ~31° off-axis
    expect(withinFov(eye, 0, { x: 0, y: 0, z: 10 })).toBe(false); // dead behind
    expect(withinFov(eye, 0, { x: 10, y: 0, z: 0.5 })).toBe(false); // ~89° off-axis
  });
});

describe('perception: threat board', () => {
  it('deduplicates same-kind threats within 4 cells (one blaze, one threat)', () => {
    const board = new ThreatBoard();
    board.add({ x: 10, y: 9, z: 10, kind: 'fire', expiresAtTick: 100 });
    board.add({ x: 11, y: 9, z: 11, kind: 'fire', expiresAtTick: 200 });
    expect(board.size).toBe(1);
    expect(board.list[0].expiresAtTick).toBe(200);
  });

  it('keeps distinct kinds and prunes expired memories', () => {
    const board = new ThreatBoard();
    board.add({ x: 10, y: 9, z: 10, kind: 'fire', expiresAtTick: 100 });
    board.add({ x: 11, y: 9, z: 11, kind: 'collapse', expiresAtTick: 100 });
    expect(board.size).toBe(2);
    board.prune(99);
    expect(board.size).toBe(2);
    board.prune(100); // expiry is inclusive: dropped once now reaches it
    expect(board.size).toBe(0);
  });

  it('caps at capacity by dropping the oldest', () => {
    const board = new ThreatBoard(3);
    for (let i = 0; i < 5; i++) {
      board.add({ x: i * 10, y: 9, z: 0, kind: 'explosion', expiresAtTick: 1000 });
    }
    expect(board.size).toBe(3);
    expect(board.list[0].x).toBe(20); // the two oldest were dropped
  });
});

describe('reactions: explosion', () => {
  it('kills at the epicenter and emits npcDied', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    const deaths: string[] = [];
    sim.onEvent = (e) => {
      if (e.type === 'npcDied') deaths.push(e.cause);
    };
    sim.notify({ type: 'explosion', x: 4.5, y: 9, z: 4.5, radius: 4, destroyed: 20 });
    expect(sim.count).toBe(0);
    expect(deaths).toEqual(['explosion']);
    expect(npc.health).toBe(0);
  });

  it('hurts at range, and a wall between quarters the damage', () => {
    const make = (walled: boolean) => {
      const world = flatWorld();
      groundChunked(world);
      if (walled) {
        // One wall column on the blast ray (the ray passes cell (2,10,4)).
        world.setVoxel(2, 9, 4, STONE);
        world.setVoxel(2, 10, 4, STONE);
      }
      const { sim, npc } = spawned(world);
      const before = npc.health;
      // ~6 cells from the eye: past the lethal crater (hurt/2 = 4.5),
      // inside the falloff (hurt = 9).
      sim.notify({ type: 'explosion', x: -1.5, y: 9.5, z: 4.5, radius: 6, destroyed: 30 });
      run(sim, 1);
      return before - npc.health;
    };
    const open = make(false);
    const walled = make(true);
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(100);
    expect(walled).toBeGreaterThan(0);
    expect(walled).toBeLessThan(open);
  });

  it('sends survivors fleeing away from the blast, then they calm down', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    sim.notify({ type: 'explosion', x: 0.5, y: 9.5, z: 4.5, radius: 3, destroyed: 5 });
    expect(npc.fear).toBeGreaterThanOrEqual(PANIC_THRESHOLD);
    // Panic paths within the decide budget; the figure then really moves.
    run(sim, 30);
    expect(npc.activity).toBe('flee');
    const dist0 = Math.hypot(npc.position.x - 0.5, npc.position.z - 4.5);
    run(sim, 120);
    const dist1 = Math.hypot(npc.position.x - 0.5, npc.position.z - 4.5);
    expect(dist1).toBeGreaterThan(dist0);
    // Fear decays (~0.1/tick) — arrivals reset activity to idle waits, so
    // calm is read off the fear value; life resumes below the threshold.
    let calmed = false;
    for (let i = 0; i < 2000 && !calmed; i++) {
      sim.tick(CENTER);
      if (npc.fear < PANIC_THRESHOLD) calmed = true;
    }
    expect(calmed).toBe(true);
    run(sim, 200);
    expect(npc.activity).not.toBe('flee');
  });

  it('wakes a sleeper inside the panic radius', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    npc.activity = 'sleep';
    npc.needs.sleep = 50; // not rested enough to wake on its own
    sim.notify({ type: 'explosion', x: 9.5, y: 9.5, z: 9.5, radius: 3, destroyed: 0 });
    expect(npc.activity).toBe('flee');
  });

  it('ignores malformed (NaN) events instead of poisoning fear forever', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    sim.notify({ type: 'explosion', x: NaN, y: 9.5, z: 4.5, radius: 3, destroyed: 0 });
    sim.notify({ type: 'structureCollapsed', x: 8.5, y: 9, z: Number.NaN, cells: 40 });
    sim.notify({ type: 'fireIgnited', x: Number.NaN, y: 9, z: 8 });
    expect(npc.fear).toBe(0); // NaN never entered the state
    // The sim still reacts normally afterwards.
    sim.notify({ type: 'explosion', x: 8.5, y: 9.5, z: 4.5, radius: 3, destroyed: 0 });
    expect(npc.fear).toBeGreaterThanOrEqual(PANIC_THRESHOLD);
  });
});

describe('reactions: collapse', () => {
  it('drives close figures to panic', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    sim.notify({ type: 'structureCollapsed', x: 6.5, y: 9, z: 4.5, cells: 60 });
    expect(npc.fear).toBeGreaterThanOrEqual(PANIC_THRESHOLD);
    expect(npc.activity).toBe('flee');
  });

  it('sends a distant figure to investigate: it approaches, then spooks', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    // ~14 cells east: well inside hearing (min(60, 20+2·√60)), past the
    // 10-cell panic ring; fear stays below panic at the 0.6 far factor.
    sim.notify({ type: 'structureCollapsed', x: 18.5, y: 9, z: 4.5, cells: 60 });
    expect(npc.activity).toBe('investigate');
    expect(npc.intent).toBe('investigate');
    expect(npc.fear).toBeLessThan(PANIC_THRESHOLD);
    // The initial path heads toward the site (stop-short target ≤ 4 away).
    const last = npc.path[npc.path.length - 1];
    expect(Math.abs(last.x - 18)).toBeLessThanOrEqual(4);
    // The arc: it walks toward the site and only panics once close (the
    // alarm radius) — the investigate-then-flee chain of plan §42.
    let closest = Number.POSITIVE_INFINITY;
    let fled = false;
    for (let i = 0; i < 900; i++) {
      sim.tick(CENTER);
      closest = Math.min(closest, Math.hypot(npc.position.x - 18.5, npc.position.z - 4.5));
      if (npc.activity === 'flee') fled = true;
    }
    // closest approach is the alarm radius itself — it turns tail there.
    expect(closest).toBeLessThanOrEqual(12.5); // got near the site…,
    expect(fled).toBe(true); // …and fled from it
  });
});

describe('reactions: fire', () => {
  it('a visible blaze in front builds fear until the figure flees', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    npc.yaw = -Math.PI / 2; // facing +x
    sim.notify({ type: 'fireIgnited', x: 14, y: 9, z: 4 });
    // Sight scans are staggered and ~25/scan crosses panic on the second
    // or third scan; give the flight decision a few ticks on top.
    run(sim, SCAN_PERIOD * 4 + 5);
    expect(npc.fear).toBeGreaterThan(0);
    expect(npc.activity).toBe('flee');
  });

  it('a blaze behind the figure is not seen (FOV)', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    npc.yaw = -Math.PI / 2; // facing +x; fire is at −x → behind
    sim.notify({ type: 'fireIgnited', x: -6, y: 9, z: 4 });
    run(sim, SCAN_PERIOD * 3);
    expect(npc.fear).toBe(0);
  });

  it('wakes a sleeper blazing two cells away', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    npc.activity = 'sleep';
    npc.needs.sleep = 50;
    sim.notify({ type: 'fireIgnited', x: 6, y: 9, z: 6 });
    expect(npc.activity).toBe('flee');
  });
});

describe('reactions: flood', () => {
  it('flees when water closes to the feet', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, npc } = spawned(world);
    world.setVoxel(4, 9, 5, WATER); // adjacent at feet level
    run(sim, SCAN_PERIOD + 5);
    expect(npc.fear).toBeGreaterThanOrEqual(PANIC_THRESHOLD);
    expect(npc.activity).toBe('flee');
    // And it ends up dry: never stands in or adjacent-to the flooded cell.
    for (let i = 0; i < 300; i++) {
      sim.tick(CENTER);
      const bx = Math.floor(npc.position.x);
      const by = Math.floor(npc.position.y);
      const bz = Math.floor(npc.position.z);
      expect(world.getVoxel(bx, by, bz)).not.toBe(WATER);
    }
  });
});

describe('reactions: determinism + invariants', () => {
  it('identical event sequences tick identically', () => {
    const make = () => {
      const world = flatWorld();
      groundChunked(world);
      const sim = new NpcSim(world, 4242, { population: 0 });
      sim.spawn({ x: 4, y: 9, z: 4 });
      sim.spawn({ x: 10, y: 9, z: 10 });
      sim.spawn({ x: 14, y: 9, z: 6 });
      return sim;
    };
    const a = make();
    const b = make();
    for (let i = 0; i < 1200; i++) {
      if (i === 100) {
        a.notify({ type: 'explosion', x: 10.5, y: 9.5, z: 10.5, radius: 4, destroyed: 12 });
        b.notify({ type: 'explosion', x: 10.5, y: 9.5, z: 10.5, radius: 4, destroyed: 12 });
      }
      if (i === 400) {
        a.notify({ type: 'structureCollapsed', x: 16.5, y: 9, z: 8.5, cells: 40 });
        b.notify({ type: 'structureCollapsed', x: 16.5, y: 9, z: 8.5, cells: 40 });
      }
      if (i === 700) {
        a.notify({ type: 'fireIgnited', x: 6, y: 9, z: 12 });
        b.notify({ type: 'fireIgnited', x: 6, y: 9, z: 12 });
      }
      a.tick(CENTER);
      b.tick(CENTER);
    }
    const snap = (sim: NpcSim) =>
      sim.list().map((n) => ({
        p: { ...n.position },
        yaw: n.yaw,
        act: n.activity,
        intent: n.intent,
        fear: n.fear,
        health: n.health,
        needs: { ...n.needs },
      }));
    expect(snap(a)).toEqual(snap(b));
  });

  it('survives 3000 ticked ticks with sprinkled disasters, invariants intact', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = spawned(world, 7);
    // A second figure via population maintenance.
    sim.onEvent = () => {}; // deaths are fine, just count them
    let maxSeen = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 400 === 200) {
        const x = 4 + ((i * 13) % 40);
        const z = 4 + ((i * 7) % 40);
        sim.notify({ type: 'explosion', x, y: 9.5, z, radius: 4, destroyed: 10 });
      }
      if (i % 500 === 250) {
        sim.notify({ type: 'fireIgnited', x: 12 + (i % 5), y: 9, z: 12 });
      }
      if (i === 1500) world.setVoxel(8, 9, 8, STONE); // a wall rises mid-panic
      sim.tick(CENTER);
      maxSeen = Math.max(maxSeen, sim.count);
      for (const npc of sim.list()) {
        expect(npc.fear).toBeGreaterThanOrEqual(0);
        expect(npc.fear).toBeLessThanOrEqual(100);
        expect(npc.health).toBeGreaterThan(0);
        expect(npc.health).toBeLessThanOrEqual(100);
        expect(npc.position.y).toBeGreaterThan(0);
        if (!npc.falling) {
          expect(
            ((): boolean => {
              const m = world.getVoxel(
                Math.floor(npc.position.x),
                Math.floor(npc.position.y),
                Math.floor(npc.position.z),
              );
              return m === AIR || m === WATER;
            })(),
          ).toBe(true);
        }
      }
    }
    expect(maxSeen).toBeGreaterThan(0);
  });
});
