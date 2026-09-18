import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { WATER, WOOD } from '../src/voxel/materials';
import { FireSim } from '../src/voxel/fire';
import { EventBus } from '../src/sim/events';
import { ScriptEngine, type ScriptDef } from '../src/script/engine';
import type { ScenarioIo } from '../src/scenario/engine';
import type { VoxelEdit } from '../src/voxel/edits';

/**
 * Scripting system (Phase 19): event triggers (filters, if/cooldown/
 * maxFires gates), rising-edge condition triggers, the shared variable
 * store, tick timers, and an end-to-end vignette over the real fire sim.
 */

interface Rig {
  world: World;
  fire: FireSim;
  bus: EventBus;
  io: ScenarioIo;
  edits: VoxelEdit[][];
  notes: string[];
  weather: string[];
  spawnCount: number;
}

function makeRig(): Rig & { engine: ScriptEngine } {
  const world = new World((chunk) => {
    const o = chunk.origin;
    for (let ly = 0; ly <= 8 && o.y + ly <= 8; ly++)
      for (let lz = 0; lz < 16; lz++)
        for (let lx = 0; lx < 16; lx++) chunk.volume.set(lx, ly, lz, 3); // stone floor
  });
  // load every column's chunk (flat world spans a few chunks)
  for (let cz = -1; cz <= 1; cz++)
    for (let cx = -1; cx <= 1; cx++) for (let cy = 0; cy < 3; cy++) world.ensureChunk(cx, cy, cz);

  const fire = new FireSim(world);
  const bus = new EventBus();
  const rig: Rig = {
    world,
    fire,
    bus,
    io: undefined as unknown as ScenarioIo,
    edits: [],
    notes: [],
    weather: [],
    spawnCount: 0,
  };
  rig.io = {
    world,
    npc: { list: () => [], spawn: undefined } as unknown as ScenarioIo['npc'],
    player: () => ({ x: 0, y: 9, z: 0 }),
    sensors: {
      leakCount: () => 0,
      litCount: () => 0,
      burningCount: () => fire.burningCount,
    },
    edit: (edits: readonly VoxelEdit[]) => {
      rig.edits.push([...edits]);
      for (const e of edits) world.setVoxel(e.x, e.y, e.z, e.material);
    },
    ignite: (x, y, z) => fire.ignite(x, y, z),
    forceWeather: (w) => rig.weather.push(w),
    ensureAround: () => {},
    spawnAt: () => {
      rig.spawnCount++;
      return rig.spawnCount;
    },
    setCounter: () => {},
    announce: (text) => rig.notes.push(text),
  };
  const engine = new ScriptEngine();
  engine.attach(rig.io);
  // main's wiring, in miniature: sim events ride the bus, the engine hears everything
  fire.onEvent = (event) => bus.emit(event);
  bus.onAny((event) => engine.onGameEvent(event));
  return { ...rig, engine };
}

const def = (
  id: string,
  triggers: ScriptDef['triggers'],
  setup?: ScriptDef['setup'],
): ScriptDef => ({
  id,
  triggers,
  setup,
});

describe('script engine', () => {
  it('fires event triggers on matching events, in load order', () => {
    const r = makeRig();
    const fired: string[] = [];
    r.engine.load(
      def('a', [{ id: 't1', on: [{ type: 'fireIgnited' }], run: () => fired.push('a:t1') }]),
      r.io,
    );
    r.engine.load(
      def('b', [{ id: 't2', on: [{ type: 'fireIgnited' }], run: () => fired.push('b:t2') }]),
      r.io,
    );
    r.bus.emit({ type: 'fireIgnited', x: 1, y: 9, z: 1 });
    r.bus.emit({ type: 'powerLost', x: 1, y: 9, z: 1 });
    expect(fired).toEqual(['a:t1', 'b:t2']);
  });

  it('filters events by radius and box', () => {
    const r = makeRig();
    const fired: string[] = [];
    r.engine.load(
      def('s', [
        {
          id: 'near',
          on: [{ type: 'explosion', near: { x: 0, y: 0, z: 0, radius: 10 } }],
          run: () => fired.push('near'),
        },
        {
          id: 'box',
          on: [
            {
              type: 'explosion',
              inBox: { min: { x: 50, y: 0, z: 50 }, max: { x: 60, y: 9, z: 60 } },
            },
          ],
          run: () => fired.push('box'),
        },
      ]),
      r.io,
    );
    r.bus.emit({ type: 'explosion', x: 8, y: 0, z: 0, radius: 3, destroyed: 0 }); // near ✓
    r.bus.emit({ type: 'explosion', x: 55, y: 5, z: 55, radius: 3, destroyed: 0 }); // box ✓
    r.bus.emit({ type: 'explosion', x: 40, y: 0, z: 0, radius: 3, destroyed: 0 }); // neither
    expect(fired).toEqual(['near', 'box']);
  });

  it('gates: if swallows the event, cooldown spaces fires, maxFires caps them', () => {
    const r = makeRig();
    let gate = false;
    let fires = 0;
    r.engine.load(
      def('g', [
        {
          id: 'gated',
          on: [{ type: 'fireIgnited' }],
          if: () => gate,
          run: () => fires++,
        },
        {
          id: 'cooled',
          on: [{ type: 'powerLost' }],
          cooldown: 10,
          run: () => fires++,
        },
        {
          id: 'capped',
          on: [{ type: 'powerRestored' }],
          maxFires: 2,
          run: () => fires++,
        },
      ]),
      r.io,
    );
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 }); // if=false: swallowed
    gate = true;
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 }); // fires
    expect(fires).toBe(1);

    r.bus.emit({ type: 'powerLost', x: 0, y: 9, z: 0 }); // cooled fires
    r.bus.emit({ type: 'powerLost', x: 0, y: 9, z: 0 }); // cooldown holds
    for (let i = 0; i < 10; i++) r.engine.tick(r.io); // cooldown elapses
    r.bus.emit({ type: 'powerLost', x: 0, y: 9, z: 0 }); // fires again
    expect(fires).toBe(3);

    r.bus.emit({ type: 'powerRestored', x: 0, y: 9, z: 0 });
    r.bus.emit({ type: 'powerRestored', x: 0, y: 9, z: 0 });
    r.bus.emit({ type: 'powerRestored', x: 0, y: 9, z: 0 }); // capped at 2
    expect(fires).toBe(5);
  });

  it('when-triggers fire on the rising edge and re-arm after release', () => {
    const r = makeRig();
    let hot = false;
    let fires = 0;
    r.engine.load(def('e', [{ id: 'edge', when: () => hot, run: () => fires++ }]), r.io);
    r.engine.tick(r.io); // false → false
    expect(fires).toBe(0);
    hot = true;
    r.engine.tick(r.io); // rising edge
    expect(fires).toBe(1);
    r.engine.tick(r.io); // still true: no refire
    expect(fires).toBe(1);
    hot = false;
    r.engine.tick(r.io); // falling edge
    hot = true;
    r.engine.tick(r.io); // re-armed
    expect(fires).toBe(2);
  });

  it('shares variables across scripts and ticks; setup initializes them', () => {
    const r = makeRig();
    r.engine.load(
      def('v', [{ id: 'noop', when: () => false, run: () => {} }], (_io, ctx) => {
        ctx.setVariable('blazes', 5);
      }),
      r.io,
    );
    expect(r.engine.variable('blazes')).toBe(5);
    r.engine.load(
      def('w', [
        {
          id: 'count',
          on: [{ type: 'fireIgnited' }],
          run: (_io, ctx) => ctx.setVariable('blazes', ctx.variable('blazes') + 1),
        },
      ]),
      r.io,
    );
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 });
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 });
    expect(r.engine.variable('blazes')).toBe(7);
    expect(r.engine.variable('never-set')).toBe(0);
  });

  it('timers fire once (after) or repeat (every), in creation order, and cancel', () => {
    const r = makeRig();
    const log: string[] = [];
    r.engine.after(3, () => log.push('a'));
    const repeat = r.engine.every(2, () => log.push('e'));
    r.engine.after(2, () => log.push('b'));
    repeat.cancel();
    r.engine.tick(r.io); // t1
    r.engine.tick(r.io); // t2: 'b'
    expect(log).toEqual(['b']);
    r.engine.tick(r.io); // t3: 'a'
    expect(log).toEqual(['b', 'a']);
    r.engine.tick(r.io); // t4: repeat was cancelled — nothing
    expect(log).toEqual(['b', 'a']);
  });

  it('timers run before condition triggers in the same tick', () => {
    const r = makeRig();
    const order: string[] = [];
    r.engine.after(1, (_io, ctx) => {
      ctx.setVariable('ready', 1);
      order.push('timer');
    });
    r.engine.load(
      def('c', [
        { id: 'see', when: (ctx) => ctx.variable('ready') === 1, run: () => order.push('when') },
      ]),
      r.io,
    );
    r.engine.tick(r.io);
    expect(order).toEqual(['timer', 'when']);
  });

  it('reload resets a script’s fire state; unload removes it; clear resets all', () => {
    const r = makeRig();
    let fires = 0;
    const capped = def('cap', [
      { id: 'once', on: [{ type: 'fireIgnited' }], maxFires: 1, run: () => fires++ },
    ]);
    r.engine.load(capped, r.io);
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 });
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 });
    expect(fires).toBe(1);
    r.engine.load(capped, r.io); // same id: state reset
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 });
    expect(fires).toBe(2);

    r.engine.unload('cap');
    r.bus.emit({ type: 'fireIgnited', x: 0, y: 9, z: 0 });
    expect(fires).toBe(2);
    expect(r.engine.size).toBe(0);
    // unloaded: events are no longer recorded
    r.engine.load(
      def('q', [{ id: 'peek', when: (ctx) => ctx.events('fireIgnited') === 0, run: () => {} }]),
      r.io,
    );
    expect(r.engine.variable('_')).toBe(0);
    r.engine.tick(r.io); // the clock runs on ticks, not events
    r.engine.clear(); // clears scripts/vars/timers/log — the clock keeps counting
    expect(r.engine.size).toBe(0);
    expect(r.engine.elapsed).toBeGreaterThan(0);
  });

  it('queries the event log (counts, near, box, quiet)', () => {
    const r = makeRig();
    const seen: { events: number; near: number; box: number; quietAtLoad: boolean }[] = [];
    r.engine.load(
      def('log', [
        {
          id: 'watch',
          when: (ctx) => {
            seen.push({
              events: ctx.events('fireIgnited'),
              near: ctx.eventsNear('fireIgnited', 0, 0, 0, 5),
              box: ctx.eventsInBox('fireIgnited', {
                min: { x: -2, y: 0, z: -2 },
                max: { x: 2, y: 12, z: 2 },
              }),
              quietAtLoad: ctx.eventsQuiet('fireIgnited', 0, 0, 0, 5, 3),
            });
            return false;
          },
          run: () => {},
        },
      ]),
      r.io,
    );
    r.bus.emit({ type: 'fireIgnited', x: 1, y: 0, z: 1 }); // near ✓ box ✓
    r.bus.emit({ type: 'fireIgnited', x: 40, y: 0, z: 40 }); // neither
    r.engine.tick(r.io);
    r.engine.tick(r.io);
    r.engine.tick(r.io);
    r.engine.tick(r.io); // last fire was 3 ticks ago: quiet(3) is now true
    expect(seen.length).toBe(4);
    expect(seen[0]).toEqual({ events: 2, near: 1, box: 1, quietAtLoad: false });
    expect(seen[3].quietAtLoad).toBe(true);
  });

  it('vignette: a burning post announces and wets the ground (real fire sim)', () => {
    const r = makeRig();
    r.world.setVoxel(4, 9, 4, WOOD);
    r.engine.load(
      def('watchfire', [
        {
          id: 'blaze',
          on: [{ type: 'fireIgnited', near: { x: 4, y: 9, z: 4, radius: 6 } }],
          run: (io, ctx) => {
            ctx.setVariable('blazes', ctx.variable('blazes') + 1);
            io.announce('Fire spotted near the post!');
            io.edit([{ x: 4, y: 8, z: 4, material: WATER }], 'script: wet the ground');
          },
        },
      ]),
      r.io,
    );
    expect(r.fire.ignite(4, 9, 4)).toBe(true); // fireIgnited rides the bus → the script fires
    expect(r.engine.variable('blazes')).toBe(1);
    expect(r.notes).toContain('Fire spotted near the post!');
    expect(r.world.getVoxel(4, 8, 4)).toBe(WATER);
    // the sim keeps the scene honest: water beside the blaze snuffs it
    const out = r.fire;
    let ticks = 0;
    while (out.burningCount > 0 && ticks < 200) {
      out.tick();
      ticks++;
    }
    expect(out.burningCount).toBe(0);
  });
});
