import type { VoxelEdit } from '../voxel/edits';
import type { World } from '../voxel/world';
import { AIR, WATER, type VoxelMaterialID } from '../voxel/materials';
import type { GameEvent, GameEventType } from '../sim/events';
import type { Weather } from '../sim/atmosphere';
import type { NavCell } from '../npc/navigation';
import type { NpcSim, NpcState } from '../npc/npc';

/**
 * Scenario system (Phase 18, plan §66/§118). A scenario is a small,
 * declarative vignette layered over the live simulation: a `setup` that
 * stages the world (burst a main, ignite a house, trap a figure),
 * *objectives* the player completes or fails, and one-shot *triggers*
 * for timed beats (hints, escalations). The engine is a pure,
 * tick-driven evaluator — it observes the game event bus and the sims
 * through an injected I/O interface and never touches three.js or the
 * DOM (ADR-002). No RNG anywhere: the same tick sequence produces the
 * same run (ADR-005).
 *
 * Scenario state is transient like fire/NPC state — it is not part of
 * the save format; consequences the setup writes go through the normal
 * edit journal and persist as usual.
 *
 * Evaluation order per tick (fixed): triggers → scenario-level fail →
 * objectives in declaration order. An objective completes when its
 * `done` condition fires; a `failed` condition, an expired `deadline`,
 * or the scenario-level `failed`/`timeLimit` ends the run. Objectives
 * without a `done` condition are pure guards — they never block
 * completion and are marked done when the scenario completes.
 *
 * Conditions are pure functions of a `ScenarioContext` (a tick counter,
 * the event log, scratch counters, and box/world queries). All loops
 * have fixed orders; nothing allocates per tick except rare event-log
 * pushes.
 */

export type ScenarioStatus = 'idle' | 'running' | 'complete' | 'failed';
export type ObjectiveStatus = 'pending' | 'done' | 'failed';

/** Inclusive cell bounds for box queries. */
export interface ScenarioBox {
  readonly min: { x: number; y: number; z: number };
  readonly max: { x: number; y: number; z: number };
}

/**
 * Everything a scenario may read and do. main implements this over the
 * live game; tests implement it over fixture rigs. Reads go through the
 * same handles the HUD uses — no scenario writes voxels directly except
 * through `edit` (journaled, remeshed, sims-notified like any edit).
 */
export interface ScenarioIo {
  readonly world: World;
  readonly npc: NpcSim;
  /** Live player position (feet). */
  readonly player: () => { x: number; y: number; z: number };
  /** Cheap sim readouts conditions guard on. */
  readonly sensors: {
    /** Registered plumbing leaks (the flood's "stop the leak"). */
    readonly leakCount: () => number;
    /** Lit lamps (a blackout beat). */
    readonly litCount: () => number;
    /** Burning cells (the fire's "put it out"). */
    readonly burningCount: () => number;
  };
  /** Apply journaled voxel edits (one undoable command per call). */
  edit(edits: readonly VoxelEdit[], label: string): void;
  /** Ignite one flammable cell (fire sim rules apply). */
  ignite(x: number, y: number, z: number): boolean;
  /** Pin the weather (scenarios stage their own sky). */
  forceWeather(weather: Weather): void;
  /** Force-load the chunks in an XZ square so setup edits land. */
  ensureAround(x: number, z: number, radius: number): void;
  /** Spawn a figure; returns its id (for tracking objectives). */
  spawnAt(cell: NavCell): number | undefined;
  /** Scenario scratch counters (survive for the whole run). */
  setCounter(key: string, value: number): void;
  /** Show a scenario message (HUD line; no-op without a HUD). */
  announce(text: string): void;
}

/** Everything a condition may look at. Rebuilt per tick by the engine. */
export interface ScenarioContext {
  readonly io: ScenarioIo;
  /** Ticks since the scenario started (first evaluated tick is 1). */
  readonly ticks: number;
  /** How many bus events of a type fired since the start. */
  events(type: GameEventType): number;
  /**
   * How many events of a type fired within `radius` of a point since
   * the start (squared-distance match, exact centers).
   */
  eventsNear(type: GameEventType, x: number, y: number, z: number, radius: number): number;
  /**
   * How many events of a type fired inside an inclusive box since the
   * start (box guards don't have the shared-edge overlap radii do).
   */
  eventsInBox(type: GameEventType, box: ScenarioBox): number;
  /** Tick of the most recent matching event, or -1 when none fired. */
  lastEventTick(type: GameEventType, x: number, y: number, z: number, radius: number): number;
  /** True when no matching event fired in the last `span` ticks. */
  eventsQuiet(
    type: GameEventType,
    x: number,
    y: number,
    z: number,
    radius: number,
    span: number,
  ): boolean;
  /** Scenario scratch value (0 when never set). */
  counter(key: string): number;
  /** Count cells of a material in an inclusive box (bounded). */
  countInBox(box: ScenarioBox, material: VoxelMaterialID): number;
  /** Live figure by id. */
  npcById(id: number): NpcState | undefined;
}

/** A pure predicate over the scenario context. */
export type ScenarioCondition = (ctx: ScenarioContext) => boolean;

export interface ScenarioObjective {
  readonly id: string;
  /** HUD text. */
  readonly description: string;
  /** Hidden (unevaluated, cannot complete/fail) until this fires once. */
  readonly after?: ScenarioCondition;
  readonly done?: ScenarioCondition;
  readonly failed?: ScenarioCondition;
  /**
   * Ticks from scenario start before the objective auto-fails — but only
   * counted while unlocked (a locked objective's clock has not started).
   */
  readonly deadline?: number;
}

/** A one-shot beat: when `when` fires, `run` stages the next moment. */
export interface ScenarioTrigger {
  readonly id: string;
  readonly when: ScenarioCondition;
  readonly run: (io: ScenarioIo, ctx: ScenarioContext) => void;
}

export interface ScenarioDef {
  readonly id: string;
  readonly title: string;
  /** Announced at start. */
  readonly briefing: string;
  /** Stage the world once, before the first tick. */
  readonly setup?: (io: ScenarioIo) => void;
  readonly objectives: readonly ScenarioObjective[];
  readonly triggers?: readonly ScenarioTrigger[];
  /** Whole-scenario failure (checked every tick). */
  readonly failed?: ScenarioCondition;
  /** Run fails when this many ticks elapse. */
  readonly timeLimit?: number;
}

export type ScenarioEngineEvent =
  | { type: 'started'; id: string; title: string }
  | { type: 'objective'; objectiveId: string; status: 'done' | 'failed'; description: string }
  | { type: 'complete'; id: string }
  | { type: 'failed'; id: string; reason: string };

/** Event-log entry (positions are the event's own; defaults 0). */
interface EventRecord {
  readonly type: GameEventType;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tick: number;
}

/** Event log cap — near events are what scenarios reason about. */
const EVENT_LOG_CAP = 512;
/** Cell budget for `countInBox` (a guard against runaway boxes). */
const BOX_CELL_BUDGET = 50_000;

/** Euclidean distance between two points. */
export function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface ObjectiveView {
  readonly id: string;
  readonly description: string;
  readonly status: ObjectiveStatus;
  /** True while an `after` gate has not unlocked the objective. */
  readonly hidden: boolean;
}

/**
 * The tick-driven evaluator. Construct once; feed bus events and fixed
 * steps; start/stop scenario definitions at will. `io` is passed to
 * `start`/`tick` (main passes the same object every time) so the engine
 * has no construction-order constraints on the game's own wiring.
 */
export class ScenarioEngine {
  /** Wired by main (audio, scripting, future systems). */
  onEvent?: (event: ScenarioEngineEvent) => void;

  private def: ScenarioDef | undefined;
  private status: ScenarioStatus = 'idle';
  private ticks = 0;
  private failureReason: string | undefined;
  /** A scenario needs at least one positive objective to be completable. */
  private anyDoneObjectives = false;
  private readonly objectiveStates: ObjectiveStatus[] = [];
  private readonly objectiveUnlocked: boolean[] = [];
  private readonly firedTriggers = new Set<string>();
  private readonly counters = new Map<string, number>();
  private readonly eventLog: EventRecord[] = [];
  private readonly eventTotals = new Map<GameEventType, number>();

  get active(): ScenarioDef | undefined {
    return this.status === 'running' ? this.def : undefined;
  }

  get current(): ScenarioStatus {
    return this.status;
  }

  /** Title of the current (or most recent) scenario, for the HUD. */
  get title(): string {
    return this.def?.title ?? '';
  }

  get elapsed(): number {
    return this.ticks;
  }

  get failReason(): string | undefined {
    return this.failureReason;
  }

  /** HUD snapshot of the objective list (empty when idle). */
  objectiveViews(): readonly ObjectiveView[] {
    if (!this.def) return [];
    return this.def.objectives.map((objective, i) => ({
      id: objective.id,
      description: objective.description,
      status: this.objectiveStates[i],
      hidden: !this.objectiveUnlocked[i],
    }));
  }

  /** Start a scenario (stops any running one first). */
  start(def: ScenarioDef, io: ScenarioIo): void {
    if (this.status === 'running') this.stop();
    this.def = def;
    this.status = 'running';
    this.ticks = 0;
    this.failureReason = undefined;
    this.objectiveStates.length = 0;
    this.objectiveUnlocked.length = 0;
    this.firedTriggers.clear();
    this.counters.clear();
    this.eventLog.length = 0;
    this.eventTotals.clear();
    this.anyDoneObjectives = false;
    for (const objective of def.objectives) {
      // Guard-only objectives have no `after` gate to wait for.
      this.objectiveStates.push('pending');
      this.objectiveUnlocked.push(objective.after === undefined);
      if (objective.done !== undefined) this.anyDoneObjectives = true;
    }
    def.setup?.(io);
    io.announce(def.briefing);
    this.onEvent?.({ type: 'started', id: def.id, title: def.title });
  }

  /** Abandon the current run (idle; the last result stays readable). */
  stop(): void {
    this.status = 'idle';
    this.failureReason = undefined;
  }

  setCounter(key: string, value: number): void {
    this.counters.set(key, value);
  }

  /** Record one bus event (only while a scenario runs). */
  onGameEvent(event: GameEvent): void {
    if (this.status !== 'running') return;
    const record: EventRecord = {
      type: event.type,
      x: 'x' in event ? event.x : 0,
      y: 'y' in event ? event.y : 0,
      z: 'z' in event ? event.z : 0,
      tick: this.ticks,
    };
    this.eventLog.push(record);
    if (this.eventLog.length > EVENT_LOG_CAP) this.eventLog.shift();
    this.eventTotals.set(event.type, (this.eventTotals.get(event.type) ?? 0) + 1);
  }

  /** One fixed step. No-op while idle. */
  tick(io: ScenarioIo): void {
    const def = this.def;
    if (!def || this.status !== 'running') return;
    this.ticks++;
    const ctx = this.buildContext(io);

    // Timed beats first: a trigger's staging should be visible to the
    // same tick's objective evaluation.
    for (const trigger of def.triggers ?? []) {
      if (this.firedTriggers.has(trigger.id)) continue;
      if (!trigger.when(ctx)) continue;
      this.firedTriggers.add(trigger.id);
      trigger.run(io, ctx);
    }

    if (def.failed?.(ctx)) {
      this.fail(def.id, 'the situation got out of hand');
      return;
    }
    if (def.timeLimit !== undefined && this.ticks >= def.timeLimit) {
      this.fail(def.id, 'out of time');
      return;
    }

    let allDone = true;
    for (let i = 0; i < def.objectives.length; i++) {
      const objective = def.objectives[i];
      if (this.objectiveStates[i] !== 'pending') continue;
      // Locked objectives neither complete nor fail (nor tick clocks).
      if (!this.objectiveUnlocked[i]) {
        if (objective.after?.(ctx)) this.objectiveUnlocked[i] = true;
        else {
          allDone = false;
          continue;
        }
      }
      if (objective.done?.(ctx)) {
        this.objectiveStates[i] = 'done';
        this.onEvent?.({
          type: 'objective',
          objectiveId: objective.id,
          status: 'done',
          description: objective.description,
        });
        continue;
      }
      if (objective.failed?.(ctx)) {
        this.objectiveStates[i] = 'failed';
        this.onEvent?.({
          type: 'objective',
          objectiveId: objective.id,
          status: 'failed',
          description: objective.description,
        });
        this.fail(def.id, objective.description);
        return;
      }
      if (objective.deadline !== undefined && this.ticks > objective.deadline) {
        this.objectiveStates[i] = 'failed';
        this.onEvent?.({
          type: 'objective',
          objectiveId: objective.id,
          status: 'failed',
          description: objective.description,
        });
        this.fail(def.id, `too slow: ${objective.description}`);
        return;
      }
      // Guard-only objectives (no done condition) never block completion.
      if (objective.done !== undefined) allDone = false;
    }

    if (allDone && this.anyDoneObjectives) {
      // Guards held to the end: mark them done for the HUD.
      for (let i = 0; i < this.objectiveStates.length; i++) {
        if (this.objectiveStates[i] === 'pending') this.objectiveStates[i] = 'done';
      }
      this.status = 'complete';
      this.onEvent?.({ type: 'complete', id: def.id });
    }
  }

  // --- internals ---------------------------------------------------------

  private fail(id: string, reason: string): void {
    this.status = 'failed';
    this.failureReason = reason;
    this.onEvent?.({ type: 'failed', id, reason });
  }

  private buildContext(io: ScenarioIo): ScenarioContext {
    // One context per tick, closed over the engine's own state.

    const lastEventTick = (
      type: GameEventType,
      x: number,
      y: number,
      z: number,
      radius: number,
    ): number => {
      const r2 = radius * radius;
      let last = -1;
      for (const record of this.eventLog) {
        if (record.type !== type) continue;
        const dx = record.x - x;
        const dy = record.y - y;
        const dz = record.z - z;
        if (dx * dx + dy * dy + dz * dz <= r2 && record.tick > last) last = record.tick;
      }
      return last;
    };
    return {
      io,
      ticks: this.ticks,
      events: (type) => this.eventTotals.get(type) ?? 0,
      eventsNear: (type, x, y, z, radius) => {
        const r2 = radius * radius;
        let count = 0;
        for (const record of this.eventLog) {
          if (record.type !== type) continue;
          const dx = record.x - x;
          const dy = record.y - y;
          const dz = record.z - z;
          if (dx * dx + dy * dy + dz * dz <= r2) count++;
        }
        return count;
      },
      eventsInBox: (type, box) => {
        let count = 0;
        for (const record of this.eventLog) {
          if (record.type !== type) continue;
          if (
            record.x >= box.min.x &&
            record.x <= box.max.x &&
            record.y >= box.min.y &&
            record.y <= box.max.y &&
            record.z >= box.min.z &&
            record.z <= box.max.z
          ) {
            count++;
          }
        }
        return count;
      },
      lastEventTick,
      eventsQuiet: (type, x, y, z, radius, span) => {
        const last = lastEventTick(type, x, y, z, radius);
        return last < 0 || last <= this.ticks - span;
      },
      counter: (key) => this.counters.get(key) ?? 0,
      countInBox: (box, material) => {
        const { min, max } = box;
        const sx = max.x - min.x + 1;
        const sy = max.y - min.y + 1;
        const sz = max.z - min.z + 1;
        if (sx <= 0 || sy <= 0 || sz <= 0) return 0;
        if (sx * sy * sz > BOX_CELL_BUDGET) return 0; // misuse guard
        let count = 0;
        for (let y = min.y; y <= max.y; y++) {
          for (let z = min.z; z <= max.z; z++) {
            for (let x = min.x; x <= max.x; x++) {
              if (io.world.getVoxel(x, y, z) === material) count++;
            }
          }
        }
        return count;
      },
      npcById: (id) => {
        for (const figure of io.npc.list()) if (figure.id === id) return figure;
        return undefined;
      },
    };
  }
}

/** Shared convenience: an inclusive box from two corners (sorted). */
export function boxBetween(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): ScenarioBox {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

/** AIR + WATER are "not there" for every scenario census. */
export function isSubstance(material: VoxelMaterialID): boolean {
  return material !== AIR && material !== WATER;
}
