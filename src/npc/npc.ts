import type { World } from '../voxel/world';
import { AIR, WATER, isSolidForCollision, type VoxelMaterialID } from '../voxel/materials';
import { hash3 } from '../voxel/terrain';
import { WORLD_HEIGHT } from '../voxel/coordinates';
import type { GameEvent } from '../sim/events';
import {
  DAY_TICKS as ATMOS_DAY_TICKS,
  TICKS_PER_HOUR as ATMOS_TICKS_PER_HOUR,
} from '../sim/atmosphere';
import {
  canSee,
  hasLineOfSight,
  SIGHT_DISTANCE,
  ThreatBoard,
  type Point3,
  type ThreatKind,
  type ThreatPoint,
} from './perception';
import {
  findPath,
  nearestWalkable,
  pathTouches,
  terrainNavQuery,
  type NavCell,
  type NavQuery,
} from './navigation';

/**
 * NPC simulation (Phases 12–13): a small population of wandering figures
 * that live on the nav grid — schedule-driven days (work, leisure,
 * sleep at home), needs that accumulate deterministically, and paths
 * that survive a mutable world (edits and collapses invalidate only the
 * paths they touch — local invalidation, plan §40). Phase 13 adds
 * perception and reactions (plan §111): events on the bus (explosions,
 * collapses, ignitions) are heard within an attenuation radius, recent
 * threat sites are *seen* with distance + FOV + voxel line-of-sight, and
 * fear drives the two reaction states — `flee` (panic: run from the
 * nearest remembered threat, faster than normal, sleep interrupted) and
 * `investigate` (walk toward a heard noise, look, resume). Water at the
 * feet is its own message: floods drive figures out with no bus event.
 *
 * Believability over accuracy, deliberately:
 * - Movement is grid-following (cell centers), not physics. The one
 *   physical rule: when the ground under a figure vanishes (collapse),
 *   it falls with gravity until it lands — and is despawned if it lands
 *   in water ("swept away").
 * - Explosion damage is a distance falloff quartered when a wall blocks
 *   line of sight; death emits `npcDied` for audio/scripts (Phase 17+).
 * - Needs (hunger, sleep) accumulate and sleep gates behavior; hunger
 *   has no consumer yet (no food exists to eat) and only reads out in
 *   tests/debug until an economy lands.
 * - Population is transient and never saved: figures spawn and despawn
 *   around the player deterministically (hash-scattered rings), so a
 *   reloaded world repopulates identically. The schedule reads the
 *   atmosphere's world clock when main injects one (Phase 16); without
 *   it the sim counts its own ticks (tests, standalone use).
 *
 * Pure: no three.js, no DOM (ADR-002). No sequential RNG — every
 * "random" choice hashes (npc id, salt, tick, world seed), so the same
 * tick sequence reproduces bit-identically (ADR-005).
 */

/** One simulated figure. Positions are float world coords, feet at y. */
export interface NpcState {
  readonly id: number;
  position: { x: number; y: number; z: number };
  yaw: number;
  activity: 'idle' | 'wander' | 'goto' | 'sleep' | 'flee' | 'investigate';
  /** What the current `goto` is for (drives arrival behavior + viz). */
  intent: 'home' | 'work' | 'wander' | 'flee' | 'investigate';
  health: number;
  /** 0–100; ≥ PANIC_THRESHOLD overrides the schedule with flight. */
  fear: number;
  needs: { hunger: number; sleep: number };
  home: NavCell;
  work: NavCell;
  /** Remaining path cells (from the current one to the destination). */
  path: NavCell[];
  pathIndex: number;
  /** Set by world edits/collapses; the next budgeted decide re-paths. */
  repath: boolean;
  /** Idle countdown in ticks. */
  waitTicks: number;
  /** Ground vanished underfoot (collapse): gravity until landing. */
  falling: boolean;
  velocityY: number;
}

/** Horizontal speed in cells per second (noticeably slower than the player). */
export const NPC_SPEED = 2.2;
/** Fall acceleration while unsupported (matches the player's gravity). */
export const NPC_GRAVITY = 24;
/** Figures kept alive around the population center. */
export const MAX_POPULATION = 16;
/** Figures farther than this (XZ) from the center despawn. */
export const DESPAWN_RADIUS = 80;
/** Path decisions (A* searches) per tick — collapse bursts spread out. */
export const DECIDES_PER_TICK = 3;

/** Fear at (and above) which a figure flees instead of living its life. */
export const PANIC_THRESHOLD = 50;
/** Base distance of a panic run (cells), plus a per-figure scatter. */
export const FLEE_DISTANCE = 14;
/** Speed multiplier while fleeing (panic is faster than a stroll). */
export const FLEE_SPEED_MULT = 1.6;
/** Ticks between a figure's perception scans, staggered by id. */
export const SCAN_PERIOD = 10;

/** Schedule clock: 100 ticks per game hour, 2400 per day (40 s real time).
 * The constants live in the atmosphere module (Phase 16) — the world
 * clock — and are re-exported here for the sim's existing consumers. */
export const TICKS_PER_HOUR = ATMOS_TICKS_PER_HOUR;
export const DAY_TICKS = ATMOS_DAY_TICKS;
const SLEEP_START_HOUR = 22;
const SLEEP_END_HOUR = 6;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;
/** Sleep need that sends a figure home early, day or night. */
const SLEEPY_THRESHOLD = 80;
/** Sleep need at wake-up (figures don't sleep the need to exactly 0). */
const RESTED_THRESHOLD = 20;

const WANDER_RADIUS = 10;
/** A town anchor farther than this (Manhattan) is "not near" a spawn. */
const ANCHOR_MAX_DISTANCE = 48;

/** Fear gained per perception scan when a threat of this kind is seen. */
const FEAR_ON_SIGHT: Record<ThreatKind, number> = {
  explosion: 45,
  collapse: 30,
  fire: 25,
  water: 60,
};
/** Figures this close (cells) to a lamp dying look over curiously. */
const POWER_OUTAGE_RADIUS = 10;
/** Fear decay per tick — panic subsides in seconds of real time. */
const FEAR_DECAY_AWAKE = 0.1;
const FEAR_DECAY_ASLEEP = 0.15;
/** Sleepers don't look, but noise/heat this close wakes anyone (cells). */
const SLEEPER_WAKE_RADIUS = 5;
/**
 * Seen threats only build fear within this range (cells) — a distant
 * blaze or rubble pile is scenery until you are near it; the *event*
 * already delivered its fear when heard. Keeps investigators walking
 * toward a rumble instead of panicking at first glance.
 */
const ALARM_RADIUS = 12;
/** Horizontal neighbor order for the water-proximity check. */
const SENSE_NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Outbound event: a figure died (audio/scripts subscribe, Phase 17+). */
export type NpcEvent = Extract<GameEvent, { type: 'npcDied' }>;

export function isNightHour(hour: number): boolean {
  return hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR;
}

export function isWorkHour(hour: number): boolean {
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

export interface NpcSimOptions {
  /** Target population (defaults to MAX_POPULATION). */
  population?: number;
  /**
   * Town door-front anchors (Phase 14): figures pick homes/workplaces
   * from these when one is within range and its cell is walkable; the
   * terrain ring fallback covers wilderness spawns and unloaded chunks.
   */
  anchors?: { homes: readonly NavCell[]; works: readonly NavCell[] };
  /**
   * Natural terrain height per column. When given, spawn candidates
   * standing above it (roofs, tree canopies, bridge decks) are rejected
   * — figures appear on streets and open ground, not on structures.
   */
  groundY?: (x: number, z: number) => number;
  /**
   * World clock (Phase 16): returns the atmosphere's tick counter, so
   * the schedule follows the real day/night cycle instead of this sim's
   * private count. When omitted the sim keeps its own clock (tests).
   */
  clock?: () => number;
  /**
   * Scene light 0–1 (Phase 16): night shrinks sight range — figures
   * see roughly a third as far by moonlight as at noon. Defaults to 1.
   */
  lightLevel?: () => number;
}

export class NpcSim {
  /** Ticks since world start; starts at 08:00. Debug/tests may set it. */
  timeTicks = 8 * TICKS_PER_HOUR;
  private tickCount = 0;
  private nextId = 1;
  private readonly npcs: NpcState[] = [];
  private readonly query: NavQuery;
  private readonly population: number;
  /** Short memory of recent explosion/collapse/fire/water sites. */
  private readonly threats = new ThreatBoard();

  /** Wired by main to the game event bus (pure core stays bus-agnostic). */
  onEvent?: (event: NpcEvent) => void;

  constructor(
    private readonly world: World,
    private readonly seed: number,
    private readonly options: NpcSimOptions = {},
  ) {
    this.query = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
    this.population = options.population ?? MAX_POPULATION;
    // Observe world mutations (edits, explosions, collapses, water) so
    // affected paths re-path. Read-only: the sim never writes voxels,
    // so hook order relative to fluid/fire/structure is irrelevant.
    const previous = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material, before) => {
      previous?.(x, y, z, material, before);
      this.invalidateAt(x, y, z);
    };
  }

  /** Live figures (render + HUD + debug hook read this). */
  list(): readonly NpcState[] {
    return this.npcs;
  }

  get count(): number {
    return this.npcs.length;
  }

  /** Figures currently panicking (HUD flavor line). */
  get fleeingCount(): number {
    let n = 0;
    for (const npc of this.npcs) if (npc.activity === 'flee') n++;
    return n;
  }

  /** Current game hour as a float (e.g. 13.5 = 13:30). */
  hourOfDay(): number {
    return (this.timeTicks % DAY_TICKS) / TICKS_PER_HOUR;
  }

  /**
   * Reactions enter here: main wires the bus's `explosion`,
   * `structureCollapsed`, and `fireIgnited` events to this. Called
   * between ticks (never re-entrant with `tick`), it damages, frightens,
   * and re-tasking figures synchronously — the next fixed step walks
   * them out of trouble within the normal decide budget.
   */
  notify(event: GameEvent): void {
    // A malformed event (NaN/∞ position from a script or a wiring bug)
    // must not poison figure state — NaN survives Math.min/Math.max and
    // would permanently break every reaction downstream.
    if (!Number.isFinite(event.x + event.y + event.z)) return;
    switch (event.type) {
      case 'explosion':
        if (!Number.isFinite(event.radius)) return;
        this.onExplosion(event);
        break;
      case 'structureCollapsed':
        if (!Number.isFinite(event.cells)) return;
        this.onCollapsed(event);
        break;
      case 'fireIgnited':
        this.onFire(event);
        break;
      case 'powerLost':
        this.onPowerOutage(event);
        break;
      default:
        break; // extinguishing/restoring is good news; npcDied is our own output
    }
  }

  /** Forget all figures, the clock, and every threat memory (reset/load).
   * With an injected world clock the clock itself survives — time is the
   * atmosphere's, not the population's. */
  reset(): void {
    this.npcs.length = 0;
    this.threats.clear();
    this.timeTicks = this.options.clock ? this.options.clock() : 8 * TICKS_PER_HOUR;
    this.tickCount = 0;
  }

  /**
   * One fixed step: advance the clock and needs, perceive on a staggered
   * cadence, run behaviors, move figures, then maintain the population
   * around `center` (the player).
   */
  tick(center: { x: number; z: number }): void {
    // The world clock (atmosphere) drives the schedule when injected;
    // otherwise the sim counts its own ticks (standalone tests).
    this.timeTicks = this.options.clock ? this.options.clock() : this.timeTicks + 1;
    this.tickCount++;
    const hour = this.hourOfDay();
    let decideBudget = DECIDES_PER_TICK;

    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      npc.fear = Math.max(
        0,
        npc.fear - (npc.activity === 'sleep' ? FEAR_DECAY_ASLEEP : FEAR_DECAY_AWAKE),
      );
      this.stepNeeds(npc, hour);
      if (this.stepFall(npc, i)) continue; // mid-fall: physics only
      if ((this.tickCount + npc.id * 3) % SCAN_PERIOD === 0) this.sense(npc);
      if (this.stepBehavior(npc, hour, decideBudget)) decideBudget--;
      this.stepMove(npc);
    }
    this.maintain(center);
  }

  // --- needs -----------------------------------------------------------------

  private stepNeeds(npc: NpcState, hour: number): void {
    if (npc.activity === 'sleep') {
      npc.needs.sleep = Math.max(0, npc.needs.sleep - 100 / (DAY_TICKS / 4));
      npc.needs.hunger = Math.max(0, npc.needs.hunger - 0.0005);
      if (!isNightHour(hour) && npc.needs.sleep <= RESTED_THRESHOLD) this.wake(npc);
      return;
    }
    npc.needs.sleep = Math.min(100, npc.needs.sleep + 100 / DAY_TICKS);
    npc.needs.hunger = Math.min(100, npc.needs.hunger + 0.001);
  }

  private wake(npc: NpcState): void {
    npc.activity = 'idle';
    npc.waitTicks = 20 + this.rand(npc.id, 11) * 100;
  }

  // --- falling (the floor vanished) --------------------------------------------

  /**
   * The block an at-rest figure stands on: feet at integral y rest on
   * block y-1 (block b spans [b, b+1)). Mid-easing (drops) this reads
   * the air cell below the ledge — the target floor check covers that.
   */
  private supportBlockY(npc: NpcState): number {
    return Math.ceil(npc.position.y) - 1;
  }

  /**
   * True while the figure is airborne or just landed this tick (no
   * behavior). Falling starts only when both the current support and —
   * while following a path — the target cell's floor are gone, so
   * legitimate pathed drops down a ledge never count as "ground vanished".
   */
  private stepFall(npc: NpcState, index: number): boolean {
    if (!npc.falling) {
      const supportGone = !isSolidForCollision(
        this.world.getVoxel(
          Math.floor(npc.position.x),
          this.supportBlockY(npc),
          Math.floor(npc.position.z),
        ),
      );
      if (supportGone) {
        const following = npc.pathIndex < npc.path.length;
        const targetFloorGone =
          following &&
          !isSolidForCollision(
            this.world.getVoxel(
              npc.path[npc.pathIndex].x,
              npc.path[npc.pathIndex].y - 1,
              npc.path[npc.pathIndex].z,
            ),
          );
        if (!following || targetFloorGone) npc.falling = true;
      }
    }
    if (!npc.falling) return false;

    npc.velocityY -= NPC_GRAVITY / 60;
    if (npc.velocityY < -20) npc.velocityY = -20;
    npc.position.y += npc.velocityY / 60;
    // Land on the first solid block the feet sink into (fall speed is
    // capped below one block per tick, so no tunneling).
    const block = Math.floor(npc.position.y - 1e-3);
    if (
      isSolidForCollision(
        this.world.getVoxel(Math.floor(npc.position.x), block, Math.floor(npc.position.z)),
      )
    ) {
      npc.position.y = block + 1;
      npc.velocityY = 0;
      npc.falling = false;
      if (
        this.world.getVoxel(Math.floor(npc.position.x), block + 1, Math.floor(npc.position.z)) ===
        WATER
      ) {
        this.despawn(index, 'drowned'); // landed in a lake: swept away
      } else {
        npc.repath = true;
        npc.path.length = 0;
        npc.pathIndex = 0;
      }
    }
    return true;
  }

  // --- perception + reactions (Phase 13) -------------------------------------

  private materialAt(x: number, y: number, z: number): VoxelMaterialID {
    return this.world.getVoxel(x, y, z);
  }

  /** An explosion hurts, deafens, and scatters. */
  private onExplosion(event: Extract<GameEvent, { type: 'explosion' }>): void {
    this.threats.add({
      x: event.x,
      y: event.y,
      z: event.z,
      kind: 'explosion',
      expiresAtTick: this.tickCount + 400,
    });
    const hearRadius = event.radius * 4 + 20;
    const panicRadius = event.radius + 6;
    const hurtRadius = event.radius + 3;
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      const dist = Math.hypot(
        npc.position.x - event.x,
        npc.position.y + 1.4 - event.y,
        npc.position.z - event.z,
      );
      if (dist <= hurtRadius) {
        // Distance falloff; the crater itself is lethal. A wall between
        // blast and figure takes the blast (LOS blocked → quarter damage).
        let dmg = dist <= hurtRadius / 2 ? 100 : 100 * (1 - dist / hurtRadius);
        if (
          !hasLineOfSight(
            (x, y, z) => this.materialAt(x, y, z),
            { x: event.x, y: event.y, z: event.z },
            { x: npc.position.x, y: npc.position.y + 1.4, z: npc.position.z },
          )
        ) {
          dmg *= 0.25;
        }
        npc.health = Math.max(0, npc.health - dmg);
        if (npc.health <= 0) {
          this.despawn(i, 'explosion');
          continue;
        }
      }
      if (dist > hearRadius) continue;
      const proximity = 1 - dist / hearRadius;
      npc.fear = Math.min(100, npc.fear + (dist <= panicRadius ? 100 : 60 + 40 * proximity));
      if (dist <= panicRadius) this.startFlee(npc);
      else this.startInvestigate(npc, event.x, event.y, event.z);
    }
  }

  /** A collapse is loud and frightening: flee up close, gawk from afar. */
  private onCollapsed(event: Extract<GameEvent, { type: 'structureCollapsed' }>): void {
    this.threats.add({
      x: event.x,
      y: event.y,
      z: event.z,
      kind: 'collapse',
      expiresAtTick: this.tickCount + 400,
    });
    const hearRadius = Math.min(60, 20 + 2 * Math.sqrt(event.cells));
    for (const npc of this.npcs) {
      const dist = Math.hypot(
        npc.position.x - event.x,
        npc.position.y - event.y,
        npc.position.z - event.z,
      );
      if (dist > hearRadius) continue;
      const gain = 30 + Math.min(40, event.cells / 4);
      npc.fear = Math.min(100, npc.fear + gain * (dist <= 10 ? 1.6 : 0.6));
      if (npc.fear >= PANIC_THRESHOLD) this.startFlee(npc);
      else this.startInvestigate(npc, event.x, event.y, event.z);
    }
  }

  /**
   * A streetlight died nearby: not dangerous, just odd. Close figures
   * glance over (small fear, investigate if idle); sleepers keep
   * sleeping — a distant lamp failing is not a lullaby interruptor.
   */
  private onPowerOutage(event: Extract<GameEvent, { type: 'powerLost' }>): void {
    for (const npc of this.npcs) {
      const d = Math.hypot(npc.position.x - event.x, npc.position.z - event.z);
      if (d > POWER_OUTAGE_RADIUS) continue;
      if (npc.activity === 'sleep' || npc.activity === 'flee') continue;
      npc.fear = Math.min(100, npc.fear + 6);
      if (npc.fear < PANIC_THRESHOLD) this.startInvestigate(npc, event.x, event.y, event.z);
    }
  }

  /** A new burning cell: remembered for vision scans; close figures react. */
  private onFire(event: Extract<GameEvent, { type: 'fireIgnited' }>): void {
    this.threats.add({
      x: event.x + 0.5,
      y: event.y + 0.5,
      z: event.z + 0.5,
      kind: 'fire',
      expiresAtTick: this.tickCount + 600,
    });
    for (const npc of this.npcs) {
      const d = Math.hypot(npc.position.x - (event.x + 0.5), npc.position.z - (event.z + 0.5));
      if (d > SLEEPER_WAKE_RADIUS) continue;
      // Sleepers startle awake (a blaze two cells over is not a lullaby);
      // awake figures need a look or a second ignition to panic.
      npc.fear = Math.min(100, npc.fear + (npc.activity === 'sleep' ? 60 : 30));
      if (npc.fear >= PANIC_THRESHOLD) this.startFlee(npc);
    }
  }

  /**
   * Staggered per-figure perception (every SCAN_PERIOD ticks, offset by
   * id so the population's scans spread across ticks): floods are felt
   * at the feet, sleepers wake for close threats, everyone else *looks*
   * at remembered threat sites. Fear gains here keep a figure fleeing
   * while the threat stays visible — and let it calm down once away.
   */
  private sense(npc: NpcState): void {
    this.threats.prune(this.tickCount);
    const bx = Math.floor(npc.position.x);
    const by = Math.floor(npc.position.y);
    const bz = Math.floor(npc.position.z);
    let waterAt: Point3 | undefined;
    if (this.world.getVoxel(bx, by, bz) === WATER) {
      waterAt = { x: bx + 0.5, y: by + 0.5, z: bz + 0.5 };
    } else {
      for (const [dx, dz] of SENSE_NEIGHBORS) {
        if (this.world.getVoxel(bx + dx, by, bz + dz) === WATER) {
          waterAt = { x: bx + dx + 0.5, y: by + 0.5, z: bz + dz + 0.5 };
          break;
        }
      }
    }
    if (waterAt) {
      this.threats.add({ ...waterAt, kind: 'water', expiresAtTick: this.tickCount + 150 });
      npc.fear = Math.min(100, npc.fear + FEAR_ON_SIGHT.water);
      this.startFlee(npc);
      return;
    }
    const eye: Point3 = { x: npc.position.x, y: npc.position.y + 1.4, z: npc.position.z };
    for (const threat of this.threats.list) {
      const d = Math.hypot(
        npc.position.x - threat.x,
        npc.position.y - threat.y,
        npc.position.z - threat.z,
      );
      if (npc.activity === 'sleep') {
        if (d <= SLEEPER_WAKE_RADIUS) {
          npc.fear = Math.min(100, npc.fear + 50);
          this.startFlee(npc);
          return;
        }
        continue;
      }
      if (d > ALARM_RADIUS) continue; // visible but too far to scare
      if (!canSee((x, y, z) => this.materialAt(x, y, z), eye, npc.yaw, threat, this.sightRange()))
        continue;
      npc.fear = Math.min(100, npc.fear + FEAR_ON_SIGHT[threat.kind]);
      if (npc.fear >= PANIC_THRESHOLD) this.startFlee(npc);
    }
  }

  /** Sight range shrinks with scene light: moonlight sees ~⅓ as far. */
  private sightRange(): number {
    const light = this.options.lightLevel?.() ?? 1;
    return SIGHT_DISTANCE * (0.35 + 0.65 * light);
  }

  /** Panic: drop everything and run (sleep included). Idempotent mid-run. */
  private startFlee(npc: NpcState): void {
    if (npc.activity === 'flee') return; // already running — keep the path
    npc.activity = 'flee';
    npc.intent = 'flee';
    npc.waitTicks = 0;
    npc.path.length = 0;
    npc.pathIndex = 0;
    npc.repath = true;
  }

  /**
   * Curiosity: walk toward a heard noise and look. Skipped while
   * sleeping (only panic wakes), already fleeing, or already on the way.
   */
  private startInvestigate(npc: NpcState, x: number, y: number, z: number): void {
    if (npc.activity === 'sleep' || npc.activity === 'flee' || npc.activity === 'investigate') {
      return;
    }
    // Stop a few cells short of the site: look, don't leap in.
    const target = nearestWalkable(this.query, Math.round(x), Math.round(y), Math.round(z), 4);
    if (!target) return;
    const start = nearestWalkable(
      this.query,
      Math.floor(npc.position.x),
      Math.round(npc.position.y),
      Math.floor(npc.position.z),
      2,
    );
    if (!start) return;
    const result = findPath(this.query, start, target, { maxExpansions: 256 });
    if (!result || result.cells.length === 0) return;
    npc.intent = 'investigate';
    npc.waitTicks = 0;
    npc.path = result.cells;
    npc.pathIndex = 0;
    npc.repath = false;
    npc.activity = 'investigate';
  }

  /** Run from the nearest remembered threat — away, with per-figure jitter. */
  private decideFlee(npc: NpcState): void {
    let threat: ThreatPoint | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const t of this.threats.list) {
      const d = (npc.position.x - t.x) ** 2 + (npc.position.z - t.z) ** 2;
      if (d < best) {
        best = d;
        threat = t;
      }
    }
    const away = threat
      ? Math.atan2(npc.position.z - threat.z, npc.position.x - threat.x)
      : this.rand(npc.id, 33) * Math.PI * 2;
    // Deterministic jitter (±~63°) so crowds don't funnel through one gap.
    const angle = away + (this.rand(npc.id, 34) - 0.5) * 1.1;
    const dist = FLEE_DISTANCE + this.rand(npc.id, 35) * 6;
    const target =
      nearestWalkable(
        this.query,
        Math.round(npc.position.x + Math.cos(angle) * dist),
        Math.round(npc.position.y),
        Math.round(npc.position.z + Math.sin(angle) * dist),
        5,
      ) ?? npc.home; // hemmed in: run for home instead
    const start = nearestWalkable(
      this.query,
      Math.floor(npc.position.x),
      Math.round(npc.position.y),
      Math.floor(npc.position.z),
      2,
    );
    if (!start) {
      npc.waitTicks = 30;
      return;
    }
    const result = findPath(this.query, start, target, { maxExpansions: 512 });
    if (!result) {
      // Nowhere to run: cower briefly; the next decide tries afresh.
      npc.waitTicks = 30 + Math.floor(this.rand(npc.id, 36) * 60);
      return;
    }
    npc.waitTicks = 0;
    npc.repath = false;
    if (result.cells.length === 0) {
      this.arrive(npc); // nowhere farther to go — catch breath, re-decide
      return;
    }
    npc.path = result.cells;
    npc.pathIndex = 0;
    npc.activity = 'flee';
  }

  // --- behavior ------------------------------------------------------------------

  /** Returns true when this step consumed one A* decision from the budget. */
  private stepBehavior(npc: NpcState, hour: number, budget: number): boolean {
    if (npc.activity === 'sleep') return false; // wake-up is stepNeeds' job
    if (npc.waitTicks > 0) {
      npc.waitTicks--;
      return false;
    }
    const needsDecision = npc.repath || npc.pathIndex >= npc.path.length;
    if (!needsDecision || budget <= 0) return false; // over budget: retry next tick
    npc.repath = false;
    this.decide(npc, hour);
    return true;
  }

  /** Choose a destination from the schedule and path toward it (or idle). */
  private decide(npc: NpcState, hour: number): void {
    // Panic overrides the schedule while there is something to flee.
    if (npc.fear >= PANIC_THRESHOLD && this.threats.size > 0) {
      this.decideFlee(npc);
      return;
    }
    const bedtime = isNightHour(hour) || npc.needs.sleep > SLEEPY_THRESHOLD;
    const worktime = !bedtime && isWorkHour(hour) && this.rand(npc.id, 21) < 0.6;

    let target: NavCell | undefined;
    if (bedtime) {
      npc.intent = 'home';
      target = npc.home;
    } else if (worktime) {
      npc.intent = 'work';
      target = npc.work;
    } else {
      npc.intent = 'wander';
      const angle = this.rand(npc.id, 31) * Math.PI * 2;
      const dist = 3 + this.rand(npc.id, 32) * (WANDER_RADIUS - 3);
      target = nearestWalkable(
        this.query,
        Math.round(npc.position.x + Math.cos(angle) * dist),
        Math.round(npc.position.y),
        Math.round(npc.position.z + Math.sin(angle) * dist),
        3,
      );
    }

    if (!target) {
      npc.activity = 'idle';
      npc.waitTicks = 40 + this.rand(npc.id, 12) * 160;
      return;
    }

    const start = nearestWalkable(
      this.query,
      Math.floor(npc.position.x),
      Math.round(npc.position.y),
      Math.floor(npc.position.z),
      2,
    );
    if (!start) {
      npc.activity = 'idle';
      npc.waitTicks = 30;
      return;
    }
    const result = findPath(this.query, start, target, { maxExpansions: 512 });
    if (!result) {
      // Unreachable (fenced in, island): idle and try again later.
      npc.activity = 'idle';
      npc.waitTicks = 60 + this.rand(npc.id, 13) * 240;
      return;
    }
    if (result.cells.length === 0) {
      // Already at the destination (e.g. bedtime arrived while home).
      npc.path.length = 0;
      npc.pathIndex = 0;
      this.arrive(npc);
      return;
    }
    npc.path = result.cells;
    npc.pathIndex = 0;
    npc.activity = npc.intent === 'wander' ? 'wander' : 'goto';
  }

  private arrive(npc: NpcState): void {
    const hour = this.hourOfDay();
    if (npc.intent === 'flee') {
      // Reached a safe spot: catch breath; the next decide re-runs flight
      // if the fear hasn't subsided (or resumes normal life if it has).
      npc.activity = 'idle';
      npc.waitTicks = 20 + Math.floor(this.rand(npc.id, 44) * 40);
      return;
    }
    if (npc.intent === 'investigate') {
      // At the site: stand and look; vision scans do the seeing.
      npc.activity = 'idle';
      npc.waitTicks = 100 + Math.floor(this.rand(npc.id, 45) * 120);
      return;
    }
    if (npc.intent === 'home' && (isNightHour(hour) || npc.needs.sleep > SLEEPY_THRESHOLD)) {
      npc.activity = 'sleep';
      return;
    }
    npc.activity = 'idle';
    // Work stays run longer than strolls between wanders.
    npc.waitTicks =
      npc.intent === 'work' ? 200 + this.rand(npc.id, 41) * 400 : 40 + this.rand(npc.id, 42) * 200;
  }

  // --- movement --------------------------------------------------------------------

  private stepMove(npc: NpcState): void {
    if (npc.activity === 'sleep' || npc.activity === 'idle') return;
    if (npc.pathIndex >= npc.path.length) return;

    const cell = npc.path[npc.pathIndex];
    if (!this.query.walkable(cell.x, cell.y, cell.z)) {
      npc.repath = true; // a wall rose across the path mid-walk
      return;
    }

    const tx = cell.x + 0.5;
    const tz = cell.z + 0.5;
    const dx = tx - npc.position.x;
    const dz = tz - npc.position.z;
    const dist = Math.hypot(dx, dz);
    const speed = npc.activity === 'flee' ? NPC_SPEED * FLEE_SPEED_MULT : NPC_SPEED;
    const step = speed / 60;
    if (dist <= step) {
      npc.position.x = tx;
      npc.position.z = tz;
      npc.position.y = cell.y;
      npc.pathIndex++;
      if (npc.pathIndex >= npc.path.length) this.arrive(npc);
      return;
    }
    npc.position.x += (dx / dist) * step;
    npc.position.z += (dz / dist) * step;
    // Vertical easing: climbs and drops are discrete cell swaps in the
    // path; glide between them so the figure doesn't teleport vertically.
    const dy = cell.y - npc.position.y;
    if (Math.abs(dy) <= step) npc.position.y = cell.y;
    else npc.position.y += Math.sign(dy) * step;
    npc.yaw = Math.atan2(-dx, -dz);
  }

  // --- population ---------------------------------------------------------------------

  /** Despawn strays, spawn toward the target (≤ 1 per tick), deterministically. */
  private maintain(center: { x: number; z: number }): void {
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      const dx = npc.position.x - center.x;
      const dz = npc.position.z - center.z;
      if (dx * dx + dz * dz > DESPAWN_RADIUS * DESPAWN_RADIUS) this.npcs.splice(i, 1);
    }
    if (this.npcs.length >= this.population) return;

    // One hash-scattered ring candidate per tick: no retry loops, so the
    // cost is bounded and the population fills gradually, deterministically.
    const slot = this.tickCount * 7 + this.npcs.length;
    const radius = 14 + hash3(slot, 5, this.tickCount, this.seed) * 46;
    const angle = hash3(slot, 6, this.tickCount, this.seed) * Math.PI * 2;
    const wx = Math.round(center.x + Math.cos(angle) * radius);
    const wz = Math.round(center.z + Math.sin(angle) * radius);
    const cell = this.spawnCandidate(wx, wz);
    if (cell) this.spawn(cell);
  }

  /** First walkable cell at a column, respecting spacing from other figures. */
  private spawnCandidate(x: number, z: number): NavCell | undefined {
    const top = this.surfaceY(x, z);
    if (top < 0) return undefined;
    const cell = nearestWalkable(this.query, x, top, z, 3);
    if (!cell) return undefined;
    // Structure surfaces (roofs, canopies, bridge decks) stand above the
    // natural terrain: no figure materializes up there.
    if (this.options.groundY && cell.y > this.options.groundY(cell.x, cell.z)) return undefined;
    for (const other of this.npcs) {
      const dx = other.position.x - (cell.x + 0.5);
      const dz = other.position.z - (cell.z + 0.5);
      if (dx * dx + dz * dz < 9) return undefined; // 3 cells of personal space
    }
    return cell;
  }

  /** Highest non-air cell + 1 in a column, or -1 when nothing is loaded. */
  private surfaceY(x: number, z: number): number {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (this.world.getVoxel(x, y, z) !== AIR) return y + 1;
    }
    return -1;
  }

  /** Spawn one figure at `cell` with a nearby home and a farther work anchor. */
  spawn(cell: NavCell): NpcState {
    const id = this.nextId++;
    const anchor = (salt: number, minR: number, maxR: number): NavCell => {
      const angle = this.rand(id, salt) * Math.PI * 2;
      const dist = minR + this.rand(id, salt + 1) * (maxR - minR);
      return (
        nearestWalkable(
          this.query,
          Math.round(cell.x + Math.cos(angle) * dist),
          cell.y,
          Math.round(cell.z + Math.sin(angle) * dist),
          4,
        ) ?? cell
      );
    };
    const npc: NpcState = {
      id,
      position: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 },
      yaw: 0,
      activity: 'idle',
      intent: 'wander',
      health: 100,
      fear: 0,
      needs: { hunger: this.rand(id, 51) * 20, sleep: this.rand(id, 52) * 30 },
      home: this.pickAnchor(this.options.anchors?.homes, cell, id, 61, anchor(61, 3, 7)),
      work: this.pickAnchor(this.options.anchors?.works, cell, id, 71, anchor(71, 8, 16)),
      path: [],
      pathIndex: 0,
      repath: false,
      waitTicks: Math.floor(this.rand(id, 81) * 120),
      falling: false,
      velocityY: 0,
    };
    this.npcs.push(npc);
    return npc;
  }

  /**
   * A town door anchor near the figure's spawn: among the closest few
   * candidates the figure hash-picks one (so neighbors don't all share a
   * door), snapped to a walkable cell; the terrain ring anchor covers
   * wilderness spawns, far towns, and not-yet-loaded chunks.
   */
  private pickAnchor(
    candidates: readonly NavCell[] | undefined,
    cell: NavCell,
    id: number,
    pickSalt: number,
    fallback: NavCell,
  ): NavCell {
    if (!candidates || candidates.length === 0) return fallback;
    const near = candidates
      .map((c) => ({ c, d: Math.abs(c.x - cell.x) + Math.abs(c.z - cell.z) }))
      .filter((e) => e.d <= ANCHOR_MAX_DISTANCE)
      .sort((a, b) => a.d - b.d || a.c.x - b.c.x || a.c.z - b.c.z)
      .slice(0, 6);
    if (near.length === 0) return fallback;
    const first = Math.floor(this.rand(id, pickSalt) * near.length);
    for (let k = 0; k < near.length; k++) {
      const { c } = near[(first + k) % near.length];
      const walkable = nearestWalkable(this.query, c.x, c.y, c.z, 2);
      if (walkable) return walkable;
    }
    return fallback;
  }

  /** Remove a figure for good (the only deaths: blasts and deep water). */
  private despawn(index: number, cause: 'explosion' | 'drowned'): void {
    const npc = this.npcs[index];
    this.npcs.splice(index, 1);
    this.onEvent?.({
      type: 'npcDied',
      x: npc.position.x,
      y: npc.position.y,
      z: npc.position.z,
      cause,
    });
  }

  // --- invalidation -----------------------------------------------------------------------

  /** A world write at this cell invalidates paths crossing it or its floor. */
  private invalidateAt(x: number, y: number, z: number): void {
    for (const npc of this.npcs) {
      if (npc.pathIndex < npc.path.length && pathTouches(npc.path, x, y, z)) {
        npc.repath = true;
      }
    }
  }

  /** Deterministic pseudo-random in [0, 1): varies per tick and purpose. */
  private rand(id: number, salt: number): number {
    return hash3(id, salt, this.timeTicks, this.seed);
  }
}
