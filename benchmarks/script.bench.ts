/* eslint-disable no-console */
// Run directly (npx vite-node benchmarks/script.bench.ts): prints one line
// per scene. The vitest-bench variant of this suite lives in scenario.bench.
import { ScriptEngine, type ScriptDef } from '../src/script/engine';
import type { ScenarioIo } from '../src/scenario/engine';
import type { GameEvent } from '../src/sim/events';

/**
 * Scripting benchmarks (Phase 19). The engine sits in the fixed step
 * next to the scenario tick, so the per-tick cost is the budget line;
 * event-fire cost matters because bus emissions route through it.
 * Micro numbers from the dev VM — treat as relative, not absolute.
 */

const io: ScenarioIo = {
  world: { getVoxel: () => 0 },
  npc: { list: () => [] },
  player: () => ({ x: 0, y: 0, z: 0 }),
  sensors: { leakCount: () => 0, litCount: () => 0, burningCount: () => 0 },
  edit: () => {},
  ignite: () => false,
  forceWeather: () => {},
  ensureAround: () => {},
  spawnAt: () => undefined,
  setCounter: () => {},
  announce: () => {},
} as unknown as ScenarioIo;

const busyDef: ScriptDef = {
  id: 'bench',
  triggers: [
    { id: 'never', when: () => false, run: () => {} },
    { id: 'never2', when: () => false, run: () => {} },
    { id: 'blast', on: [{ type: 'explosion' }], run: () => {} },
  ],
};

function msPerOp(fn: () => void, ops: number): number {
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  return (t1 - t0) / ops;
}

// 1. idle tick with one loaded script (two condition checks)
{
  const engine = new ScriptEngine();
  engine.attach(io);
  engine.load(busyDef, io);
  const ops = 200_000;
  const per = msPerOp(() => {
    for (let i = 0; i < ops; i++) engine.tick(io);
  }, ops);
  console.log(`script tick (1 script, 2 condition checks): ${(per * 1000).toFixed(3)} µs/tick`);
}

// 2. event fire cost (event trigger + gate + log record under a full log)
{
  const engine = new ScriptEngine();
  engine.attach(io);
  engine.load(busyDef, io);
  // fill the log to its cap so queries/log pushes run worst-case
  const filler: GameEvent = { type: 'powerLost', x: 0, y: 0, z: 0 };
  for (let i = 0; i < 512; i++) engine.onGameEvent(filler);
  const ops = 100_000;
  const blast: GameEvent = { type: 'explosion', x: 5, y: 5, z: 5, radius: 4, destroyed: 9 };
  const per = msPerOp(() => {
    for (let i = 0; i < ops; i++) engine.onGameEvent(blast);
  }, ops);
  console.log(`script event fire (512-entry log): ${(per * 1000).toFixed(3)} µs/event`);
}

// 3. timer-only tick (no scripts loaded — the early-exit path)
{
  const engine = new ScriptEngine();
  engine.attach(io);
  engine.after(10, () => {});
  const ops = 200_000;
  const per = msPerOp(() => {
    for (let i = 0; i < ops; i++) engine.tick(io);
  }, ops);
  console.log(`script tick (timers only, early exit): ${(per * 1000).toFixed(3)} µs/tick`);
}
