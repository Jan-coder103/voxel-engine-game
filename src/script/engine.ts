import type { VoxelMaterialID } from '../voxel/materials';
import type { GameEvent, GameEventType } from '../sim/events';
import type { ScenarioBox, ScenarioIo } from '../scenario/engine';

/**
 * Scripting system (Phase 19, plan §119). Rules that run continuously
 * over the live simulation — the generalization of the scenario
 * engine's shape: a script subscribes to bus *events* (with position
 * filters), polls *conditions*, and runs *actions* through the same
 * `ScenarioIo` the scenarios act through (journaled edits, ignite,
 * weather, spawns, announcements). A shared variable store and tick
 * timers round out the surface.
 *
 * Like the scenario engine, this is a pure, tick-driven evaluator: no
 * three.js, no DOM (ADR-002), no RNG, fixed iteration order everywhere
 * (ADR-005). Scripts are creator logic, not world state — they are not
 * saved, and a load (L) does not stop them; their effects persist the
 * same way any edit does.
 *
 * Per-tick order: due timers (creation order) → condition triggers
 * (script load order, then declaration order). Event triggers fire
 * synchronously inside `onGameEvent` (bus emission order), so a script
 * reacts between ticks exactly like the NPC sim's `notify` does.
 *
 * An event trigger's `if` gate is evaluated at fire time; when false,
 * the event is consumed for that trigger (events are instantaneous —
 * a rule that must re-check later belongs on `when`, which fires on
 * the condition's rising edge and re-arms when it releases).
 */

export type ScriptCondition = (ctx: ScriptContext) => boolean;
export type ScriptAction = (io: ScenarioIo, ctx: ScriptContext) => void;

/** A bus-event subscription: type plus an optional position filter. */
export interface ScriptEventFilter {
  readonly type: GameEventType;
  /** Within `radius` of a point (squared-distance match). */
  readonly near?: { x: number; y: number; z: number; radius: number };
  /** Inside an inclusive box. */
  readonly inBox?: ScenarioBox;
}

/** Everything a condition or action may read and write, per tick. */
export interface ScriptContext {
  readonly io: ScenarioIo;
  /** Ticks since the engine was constructed (first tick is 1). */
  readonly ticks: number;
  /** Script variables (shared across all loaded scripts). */
  variable(name: string): number;
  setVariable(name: string, value: number): void;
  /** How many events of a type were recorded (filtered or not). */
  /** How many events of a type were recorded (filtered or not). */
  events(type: GameEventType): number;
  /** Events of a type within `radius` of a point since recording began. */
  eventsNear(type: GameEventType, x: number, y: number, z: number, radius: number): number;
  /** Events of a type inside an inclusive box. */
  eventsInBox(type: GameEventType, box: ScenarioBox): number;
  /** Tick of the most recent matching event, or -1. */
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
  /** Count cells of a material in an inclusive box (budgeted). */
  countInBox(box: ScenarioBox, material: VoxelMaterialID): number;
}

/** A rule: on bus events (`on`) and/or a rising-edge condition (`when`). */
export interface ScriptTrigger {
  readonly id: string;
  /** Fires synchronously when one of these bus events matches. */
  readonly on?: readonly ScriptEventFilter[];
  /** Fires once per rising edge of this per-tick condition. */
  readonly when?: ScriptCondition;
  /** Extra gate at fire time (false swallows the trigger's event). */
  readonly if?: ScriptCondition;
  /** Minimum ticks between fires (undefined/0 = uncooled). */
  readonly cooldown?: number;
  /** Lifetime fire cap (undefined = unlimited). */
  readonly maxFires?: number;
  readonly run: ScriptAction;
}

export interface ScriptDef {
  readonly id: string;
  /** Human-readable note (HUD/console surface later). */
  readonly description?: string;
  /** Runs once at load: initialize variables. */
  readonly setup?: ScriptAction;
  readonly triggers: readonly ScriptTrigger[];
}

interface LoadedScript {
  readonly def: ScriptDef;
  /** Fires per trigger id (maxFires bookkeeping). */
  readonly fired: Map<string, number>;
  /** Last fire tick per trigger id (cooldown bookkeeping). */
  readonly lastFire: Map<string, number>;
  /** Rising-edge state per trigger id (`when` triggers only). */
  readonly satisfied: Map<string, boolean>;
}

interface Timer {
  readonly id: number;
  /** Next fire tick (inclusive). */
  dueAt: number;
  /** 0 = one-shot; otherwise repeats every `interval` ticks. */
  readonly interval: number;
  readonly run: ScriptAction;
  cancelled: boolean;
}

/** Cancel a timer before it (re)fires. */
export interface TimerHandle {
  cancel(): void;
}

/** Event-log entry. */
interface LogRecord {
  readonly type: GameEventType;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tick: number;
}

/** Event-log cap — matches the scenario engine's budget. */
const EVENT_LOG_CAP = 512;
/** Cell budget for `countInBox` — matches the scenario engine's guard. */
const BOX_CELL_BUDGET = 50_000;

/**
 * The tick-driven evaluator. Construct once; `attach` the game's io
 * (event triggers fire between ticks, so they need a stored io — bus
 * emissions carry none); feed bus events and fixed steps; load/unload
 * script definitions at will (same-id load replaces and resets that
 * script's fire/cooldown/edge state). The variable store and timers are
 * engine-level: they survive script reloads and are cleared only by
 * `clear()`.
 */
export class ScriptEngine {
  private readonly scripts = new Map<string, LoadedScript>();
  private readonly timers: Timer[] = [];
  private readonly variables = new Map<string, number>();
  private readonly log: LogRecord[] = [];
  private ticks = 0;
  private nextTimerId = 1;
  private io: ScenarioIo | undefined;

  /** Wire the io used for event-trigger actions (main does this once). */
  attach(io: ScenarioIo): void {
    this.io = io;
  }

  /** Loaded script count (0 → events are not even recorded). */
  get size(): number {
    return this.scripts.size;
  }

  get elapsed(): number {
    return this.ticks;
  }

  variable(name: string): number {
    return this.variables.get(name) ?? 0;
  }

  setVariable(name: string, value: number): void {
    this.variables.set(name, value);
  }

  /**
   * Load (or replace) a script. Runs its setup immediately — a setup
   * action sees the fresh state of its own script, but shares the
   * engine's variables and timers with everything else.
   */
  load(def: ScriptDef, io: ScenarioIo): void {
    const loaded: LoadedScript = {
      def,
      fired: new Map(),
      lastFire: new Map(),
      satisfied: new Map(),
    };
    this.scripts.set(def.id, loaded);
    def.setup?.(io, this.context(io));
  }

  /** Remove a script (its timers keep running — cancel them yourself). */
  unload(id: string): boolean {
    return this.scripts.delete(id);
  }

  /** Remove every script, cancel every timer, clear variables and log. */
  clear(): void {
    this.scripts.clear();
    this.timers.length = 0;
    this.variables.clear();
    this.log.length = 0;
  }

  /** One-shot timer: fires `ticks` from now (minimum 1). */
  after(ticks: number, run: ScriptAction): TimerHandle {
    return this.addTimer(Math.max(1, Math.round(ticks)), 0, run);
  }

  /** Repeating timer: fires every `ticks` ticks, starting one period out. */
  every(ticks: number, run: ScriptAction): TimerHandle {
    const interval = Math.max(1, Math.round(ticks));
    return this.addTimer(interval, interval, run);
  }

  /** Record one bus event and fire matching event triggers. */
  onGameEvent(event: GameEvent): void {
    if (this.scripts.size === 0 || !this.io) return; // nothing loaded / not wired yet
    const x = 'x' in event ? event.x : 0;
    const y = 'y' in event ? event.y : 0;
    const z = 'z' in event ? event.z : 0;
    this.log.push({ type: event.type, x, y, z, tick: this.ticks });
    if (this.log.length > EVENT_LOG_CAP) this.log.shift();

    for (const script of this.scripts.values()) {
      for (const trigger of script.def.triggers) {
        if (!trigger.on?.length) continue;
        if (!trigger.on.some((filter) => matchesFilter(filter, event, x, y, z))) continue;
        if (this.fire(script, trigger)) break; // one fire per event
      }
    }
  }

  /** One fixed step: due timers, then condition triggers. No-op when empty. */
  tick(io: ScenarioIo): void {
    if (this.scripts.size === 0 && this.timers.length === 0) return;
    this.ticks++;
    const ctx = this.context(io);

    for (let i = 0; i < this.timers.length; i++) {
      const timer = this.timers[i];
      if (timer.cancelled || timer.dueAt > this.ticks) continue;
      timer.run(io, ctx);
      if (timer.interval > 0) {
        timer.dueAt = this.ticks + timer.interval;
      } else {
        this.timers.splice(i, 1);
        i--;
      }
    }

    for (const script of this.scripts.values()) {
      for (const trigger of script.def.triggers) {
        if (!trigger.when) continue;
        const now = trigger.when(ctx);
        const was = script.satisfied.get(trigger.id) ?? false;
        script.satisfied.set(trigger.id, now);
        if (now && !was && this.gatesOpen(script, trigger, ctx)) {
          this.execute(script, trigger, ctx);
        }
      }
    }
  }

  // --- internals ---------------------------------------------------------

  private addTimer(delay: number, interval: number, run: ScriptAction): TimerHandle {
    const timer: Timer = {
      id: this.nextTimerId++,
      dueAt: this.ticks + delay,
      interval,
      run,
      cancelled: false,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /** Attempt to fire an event trigger; returns false if gated shut. */
  private fire(script: LoadedScript, trigger: ScriptTrigger): boolean {
    if (!this.io) return false;
    const ctx = this.context(this.io);
    if (!this.gatesOpen(script, trigger, ctx)) return false;
    this.execute(script, trigger, ctx);
    return true;
  }

  private gatesOpen(script: LoadedScript, trigger: ScriptTrigger, ctx: ScriptContext): boolean {
    if (trigger.if && !trigger.if(ctx)) return false;
    if (trigger.maxFires !== undefined && (script.fired.get(trigger.id) ?? 0) >= trigger.maxFires) {
      return false;
    }
    const cooldown = trigger.cooldown ?? 0;
    if (cooldown > 0) {
      const last = script.lastFire.get(trigger.id);
      if (last !== undefined && this.ticks - last < cooldown) return false;
    }
    return true;
  }

  private execute(script: LoadedScript, trigger: ScriptTrigger, ctx: ScriptContext): void {
    script.fired.set(trigger.id, (script.fired.get(trigger.id) ?? 0) + 1);
    script.lastFire.set(trigger.id, this.ticks);
    trigger.run(ctx.io, ctx);
  }

  private context(io: ScenarioIo): ScriptContext {
    const lastEventTick = (
      type: GameEventType,
      x: number,
      y: number,
      z: number,
      radius: number,
    ): number => {
      const r2 = radius * radius;
      let last = -1;
      for (const record of this.log) {
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
      variable: (name) => this.variable(name),
      setVariable: (name, value) => this.setVariable(name, value),
      events: (type) => {
        let count = 0;
        for (const record of this.log) if (record.type === type) count++;
        return count;
      },
      eventsNear: (type, x, y, z, radius) => {
        const r2 = radius * radius;
        let count = 0;
        for (const record of this.log) {
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
        for (const record of this.log) {
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
    };
  }
}

/** Does one event match one filter (type + optional position filter)? */
function matchesFilter(
  filter: ScriptEventFilter,
  event: GameEvent,
  x: number,
  y: number,
  z: number,
): boolean {
  if (filter.type !== event.type) return false;
  if (filter.near) {
    const { near } = filter;
    const dx = x - near.x;
    const dy = y - near.y;
    const dz = z - near.z;
    if (dx * dx + dy * dy + dz * dz > near.radius * near.radius) return false;
  }
  if (filter.inBox) {
    const box = filter.inBox;
    if (
      x < box.min.x ||
      x > box.max.x ||
      y < box.min.y ||
      y > box.max.y ||
      z < box.min.z ||
      z > box.max.z
    ) {
      return false;
    }
  }
  return true;
}
