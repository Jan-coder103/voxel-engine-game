import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { AIR, COPPER, GENERATOR, LAMP, STONE } from '../src/voxel/materials';
import { PowerSim, type PowerEvent } from '../src/voxel/power';

/**
 * Power grid fixtures (Phase 15). A flat stone plane (solid y ≤ 8) so
 * networks can be laid out in a readable line at y = 9. The sim is
 * always constructed BEFORE any cells are written — the queue is fed by
 * the World's change hook, exactly like the wired game.
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

/** Lay a straight network along +x at y=9 starting at `origin`. */
function lineNetwork(
  world: World,
  parts: ('generator' | 'copper' | 'lamp')[],
  origin = { x: 4, z: 4 },
): void {
  parts.forEach((part, i) => {
    const material = part === 'generator' ? GENERATOR : part === 'copper' ? COPPER : LAMP;
    if (!world.setVoxel(origin.x + i, 9, origin.z, material)) throw new Error('setVoxel failed');
  });
}

function wired(
  world: World,
  options?: ConstructorParameters<typeof PowerSim>[1],
): { events: PowerEvent[]; sim: PowerSim } {
  const sim = new PowerSim(world, options);
  const events: PowerEvent[] = [];
  sim.onEvent = (event) => events.push(event);
  return { sim, events };
}

describe('power grid', () => {
  it('lights a lamp connected to a generator through wire', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world);
    lineNetwork(world, ['generator', 'copper', 'copper', 'lamp']);
    sim.settle();
    expect(sim.litCount).toBe(1);
    expect(sim.isLit(7, 9, 4)).toBe(true);
  });

  it('stays dark without a generator', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world);
    lineNetwork(world, ['copper', 'copper', 'lamp']);
    sim.settle();
    expect(sim.litCount).toBe(0);
    expect(sim.isLit(6, 9, 4)).toBe(false);
  });

  it('reports powerLost when the wire is cut and powerRestored when mended', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, events } = wired(world);
    lineNetwork(world, ['generator', 'copper', 'copper', 'lamp']);
    sim.settle();
    expect(sim.isLit(7, 9, 4)).toBe(true);

    expect(events.map((e) => e.type)).toEqual(['powerRestored']); // built → lit
    expect(world.setVoxel(5, 9, 4, AIR)).toBe(true); // cut the wire
    sim.settle();
    expect(sim.isLit(7, 9, 4)).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['powerRestored', 'powerLost']);
    expect(events[0]).toMatchObject({ x: 7, y: 9, z: 4 });

    expect(world.setVoxel(5, 9, 4, COPPER)).toBe(true); // mend it
    sim.settle();
    expect(sim.isLit(7, 9, 4)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['powerRestored', 'powerLost', 'powerRestored']);
  });

  it('goes dark when the generator is destroyed', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim, events } = wired(world);
    lineNetwork(world, ['generator', 'copper', 'lamp']);
    sim.settle();
    expect(sim.litCount).toBe(1);
    world.setVoxel(4, 9, 4, AIR);
    sim.settle();
    expect(sim.litCount).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['powerRestored', 'powerLost']);
  });

  it('browns out the lamps farthest from the generator when overloaded', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world, { capacityPerGenerator: 2 });
    // gen, 2 wire, lamp, wire, lamp, wire, lamp: nearest lamps win.
    lineNetwork(world, [
      'generator',
      'copper',
      'copper',
      'lamp',
      'copper',
      'lamp',
      'copper',
      'lamp',
    ]);
    sim.settle();
    expect(sim.isLit(7, 9, 4)).toBe(true); // nearest
    expect(sim.isLit(9, 9, 4)).toBe(true);
    expect(sim.isLit(11, 9, 4)).toBe(false); // beyond supply
    expect(sim.litCount).toBe(2);
  });

  it('keeps separate networks independent', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world);
    lineNetwork(world, ['generator', 'copper', 'lamp'], { x: 4, z: 4 });
    lineNetwork(world, ['lamp', 'copper'], { x: 4, z: 12 }); // no generator
    sim.settle();
    expect(sim.isLit(6, 9, 4)).toBe(true);
    expect(sim.isLit(4, 9, 12)).toBe(false);
  });

  it('only edits touching utility cells queue rebuilds', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world);
    expect(world.setVoxel(10, 10, 10, STONE)).toBe(true);
    expect(sim.pendingCount).toBe(0);
    expect(world.setVoxel(10, 10, 10, COPPER)).toBe(true);
    expect(sim.pendingCount).toBe(1);
  });

  it('discovery scans apply state silently; edits report flips', () => {
    // Utility cells baked into generation arrive through onChunkReady:
    // they light without events (discovering, not changing).
    const world = new World((chunk) => {
      const o = chunk.origin;
      for (let lz = 0; lz < 16; lz++)
        for (let lx = 0; lx < 16; lx++)
          for (let ly = 0; ly < 16; ly++) chunk.volume.set(lx, ly, lz, o.y + ly <= 8 ? STONE : AIR);
      // A generator-wire-lamp line generated in place at (4..7, 9, 4).
      chunk.volume.set(4, 9, 4, GENERATOR);
      chunk.volume.set(5, 9, 4, COPPER);
      chunk.volume.set(6, 9, 4, COPPER);
      chunk.volume.set(7, 9, 4, LAMP);
    });
    const { sim, events } = wired(world);
    groundChunked(world); // fires onChunkReady → silent scan
    sim.settle();
    expect(sim.isLit(7, 9, 4)).toBe(true);
    expect(events).toEqual([]);
  });

  it('rescan() re-derives the lit set after a world reset', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world);
    lineNetwork(world, ['generator', 'copper', 'lamp']);
    sim.settle();
    expect(sim.litCount).toBe(1);
    sim.reset();
    expect(sim.litCount).toBe(0);
    sim.rescan();
    sim.settle();
    expect(sim.litCount).toBe(1);
  });

  it('leaves oversize components untouched instead of half-computing them', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world, { maxComponent: 2 });
    lineNetwork(world, ['generator', 'copper', 'copper', 'lamp']);
    sim.settle();
    expect(sim.litCount).toBe(0); // never rebuilt: no stale guesses
  });

  it('is deterministic for the same edit sequence', () => {
    const run = (): string => {
      const world = flatWorld();
      groundChunked(world);
      const sim = new PowerSim(world);
      lineNetwork(world, ['generator', 'copper', 'copper', 'lamp']);
      sim.settle();
      world.setVoxel(5, 9, 4, AIR);
      sim.settle();
      world.setVoxel(5, 9, 4, COPPER);
      sim.settle();
      return JSON.stringify(sim.exportState());
    };
    expect(run()).toBe(run());
  });

  it('isLit refuses cells that are no longer lamps', () => {
    const world = flatWorld();
    groundChunked(world);
    const { sim } = wired(world);
    lineNetwork(world, ['generator', 'copper', 'lamp']);
    sim.settle();
    expect(sim.isLit(6, 9, 4)).toBe(true);
    world.setVoxel(6, 9, 4, AIR);
    expect(sim.isLit(7, 9, 4)).toBe(false); // stale entry self-corrects
  });
});
