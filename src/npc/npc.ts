import type { World } from '../voxel/world';
import { AIR, WATER, isSolidForCollision } from '../voxel/materials';
import { hash3 } from '../voxel/terrain';
import { WORLD_HEIGHT } from '../voxel/coordinates';
import {
  findPath,
  nearestWalkable,
  pathTouches,
  terrainNavQuery,
  type NavCell,
  type NavQuery,
} from './navigation';

/**
 * NPC simulation (Phase 12): a small population of wandering figures
 * that live on the nav grid — schedule-driven days (work, leisure,
 * sleep at home), needs that accumulate deterministically, and paths
 * that survive a mutable world (edits and collapses invalidate only the
 * paths they touch — local invalidation, plan §40).
 *
 * Believability over accuracy, deliberately:
 * - Movement is grid-following (cell centers), not physics. The one
 *   physical rule: when the ground under a figure vanishes (collapse),
 *   it falls with gravity until it lands — and is despawned if it lands
 *   in water ("swept away").
 * - Needs (hunger, sleep) accumulate and sleep gates behavior; hunger
 *   has no consumer yet (no food exists to eat) and only reads out in
 *   tests/debug until an economy lands.
 * - Population is transient and never saved: figures spawn and despawn
 *   around the player deterministically (hash-scattered rings), so a
 *   reloaded world repopulates identically. The schedule "clock" is a
 *   tick counter, not real time; the Phase 15/16 weather cycle will
 *   become its source.
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
  activity: 'idle' | 'wander' | 'goto' | 'sleep';
  /** What the current `goto` is for (drives arrival behavior + viz). */
  intent: 'home' | 'work' | 'wander';
  health: number;
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

/** Schedule clock: 100 ticks per game hour, 2400 per day (40 s real time). */
export const TICKS_PER_HOUR = 100;
export const DAY_TICKS = TICKS_PER_HOUR * 24;
const SLEEP_START_HOUR = 22;
const SLEEP_END_HOUR = 6;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;
/** Sleep need that sends a figure home early, day or night. */
const SLEEPY_THRESHOLD = 80;
/** Sleep need at wake-up (figures don't sleep the need to exactly 0). */
const RESTED_THRESHOLD = 20;

const WANDER_RADIUS = 10;

export function isNightHour(hour: number): boolean {
  return hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR;
}

export function isWorkHour(hour: number): boolean {
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

export interface NpcSimOptions {
  /** Target population (defaults to MAX_POPULATION). */
  population?: number;
}

export class NpcSim {
  /** Ticks since world start; starts at 08:00. Debug/tests may set it. */
  timeTicks = 8 * TICKS_PER_HOUR;
  private tickCount = 0;
  private nextId = 1;
  private readonly npcs: NpcState[] = [];
  private readonly query: NavQuery;
  private readonly population: number;

  constructor(
    private readonly world: World,
    private readonly seed: number,
    options: NpcSimOptions = {},
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

  /** Current game hour as a float (e.g. 13.5 = 13:30). */
  hourOfDay(): number {
    return (this.timeTicks % DAY_TICKS) / TICKS_PER_HOUR;
  }

  /** Forget all figures and the clock (world reset/load). */
  reset(): void {
    this.npcs.length = 0;
    this.timeTicks = 8 * TICKS_PER_HOUR;
    this.tickCount = 0;
  }

  /**
   * One fixed step: advance the clock and needs, run behaviors, move
   * figures, then maintain the population around `center` (the player).
   */
  tick(center: { x: number; z: number }): void {
    this.timeTicks++;
    this.tickCount++;
    const hour = this.hourOfDay();
    let decideBudget = DECIDES_PER_TICK;

    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      this.stepNeeds(npc, hour);
      if (this.stepFall(npc, i)) continue; // mid-fall: physics only
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
        this.npcs.splice(index, 1); // landed in a lake: swept away
      } else {
        npc.repath = true;
        npc.path.length = 0;
        npc.pathIndex = 0;
      }
    }
    return true;
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
    const step = NPC_SPEED / 60;
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
      needs: { hunger: this.rand(id, 51) * 20, sleep: this.rand(id, 52) * 30 },
      home: anchor(61, 3, 7),
      work: anchor(71, 8, 16),
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
