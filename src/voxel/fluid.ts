import type { Chunk } from './chunk';
import { worldToChunk, worldToLocal } from './coordinates';
import { AIR, WATER } from './materials';
import type { World } from './world';

/**
 * Cellular water simulation (Phase 9): every cell holds a water level
 * 0–255. Level semantics:
 *
 * - 0: no water (the voxel material is anything, typically air).
 * - 1–254: *flowing* water — finite mass, moves under gravity and
 *   equalizes with neighbors. The voxel material is WATER and the sparse
 *   level map carries the exact amount.
 * - 255: *source* — an inexhaustible cell (terrain lakes below sea level,
 *   player-placed water). Stored as `WATER` material with NO map entry,
 *   so the default read is "source" and terrain generation needs no
 *   fluid-side work. Sources keep their level forever and push mass
 *   outward; they cannot be created by flow (non-source levels cap at
 *   254, which makes "255" unambiguous).
 *
 * Movement rules per active cell (integer math, deterministic):
 * 1. Gravity: dump as much mass as the cell below can take (down to 254).
 * 2. Horizontal equalization: for each of the 4 side neighbors in a fixed
 *    order, when the level difference is ≥ 2, transfer half the
 *    difference (integer floor). After a transfer the difference is 0 or
 *    1, so neighbor pairs never oscillate.
 * Every rule only moves mass between cells — a source-free closed system
 * conserves total mass exactly (unit-tested).
 *
 * State coupling with the world: writes go through `World.setVoxel`, so
 * dirty-flag remeshing and the edit journal pick fluid changes up for
 * free (they persist across save/load). The sim learns about *external*
 * edits (undo, placement, explosions, collapses) through the World's
 * `onVoxelChanged` hook: a cell written to a non-water material loses its
 * level (displacement/vaporization); a cell written to WATER with no
 * level entry is by definition a source.
 *
 * Activity budget: only cells in the `active` set are simulated; a cell
 * that stops changing sleeps, and any level change re-wakes its
 * neighborhood. `tick` processes at most `budget` cells (insertion
 * order), so a dam break spreads its cost over frames.
 *
 * Pure: no three.js, no DOM (ADR-002). The World reference is the only
 * dependency; all methods are deterministic given the same edit/tick
 * sequence (ADR-005).
 */

/** Level of a source cell (also the capacity of any cell). */
export const WATER_SOURCE_LEVEL = 255;
/** Highest level flowing (non-source) water can hold. */
export const WATER_FLOW_MAX = WATER_SOURCE_LEVEL - 1;

/** Default per-tick cell budget (main.ts passes its own tuned value). */
export const DEFAULT_FLUID_BUDGET = 384;

/**
 * Packed key for a world cell in the active set. y < 64, x/z within
 * ±0x80000 — the playable envelope by a wide margin; cells outside it
 * never enter the simulation (defensive, unreachable in practice).
 */
const KEY_OFFSET = 0x80000;
const KEY_XZ_SPAN = 0x100000;
const KEY_Y_SPAN = 0x40;

export function packCellKey(x: number, y: number, z: number): number {
  return ((x + KEY_OFFSET) * KEY_XZ_SPAN + (z + KEY_OFFSET)) * KEY_Y_SPAN + y;
}

export function unpackCellKey(key: number): { x: number; y: number; z: number } {
  const y = key % KEY_Y_SPAN;
  const rest = (key - y) / KEY_Y_SPAN;
  const zc = rest % KEY_XZ_SPAN;
  const x = (rest - zc) / KEY_XZ_SPAN;
  return { x: x - KEY_OFFSET, y, z: zc - KEY_OFFSET };
}

function inKeyRange(x: number, y: number, z: number): boolean {
  return (
    x >= -KEY_OFFSET &&
    x < KEY_OFFSET &&
    z >= -KEY_OFFSET &&
    z < KEY_OFFSET &&
    y >= 0 &&
    y < KEY_Y_SPAN
  );
}

/** Fixed horizontal neighbor order — part of the determinism contract. */
const SIDE_NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class FluidSim {
  /** Sparse non-default levels: chunk key → (voxel index → 1..254). */
  private readonly levels = new Map<string, Map<number, number>>();
  /** Cells to simulate, insertion-ordered; packed keys. */
  private readonly active = new Set<number>();
  /** One-slot memo for the per-chunk level maps (hot read path). */
  private memoKey: string | undefined;
  private memoMap: Map<number, number> | undefined;
  private dirty = false;

  constructor(private readonly world: World) {
    // Wrap whatever hook exists (a sim constructed earlier, e.g. fire
    // chaining onto this one's) instead of assuming the field is empty.
    const previous = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material, before) => {
      previous?.(x, y, z, material, before);
      if (material !== WATER) this.deleteLevel(x, y, z);
      this.activateAround(x, y, z);
    };
    world.onChunkReady = (chunk) => this.onChunkReady(chunk);
  }

  /** Cells waiting to simulate (HUD/debug). */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * True if any level changed since the last `takeDirty` — the autosave
   * gate reads this so flowed water persists.
   */
  takeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  /** Water level at a world cell: 0 (incl. unloaded chunks), 1–254 flow, 255 source. */
  levelAt(x: number, y: number, z: number): number {
    if (this.world.getVoxel(x, y, z) !== WATER) return 0;
    const map = this.levelsForChunk(worldToChunk(x), worldToChunk(y), worldToChunk(z));
    if (!map) return WATER_SOURCE_LEVEL;
    return map.get(levelIndex(x, y, z)) ?? WATER_SOURCE_LEVEL;
  }

  /** True if the cell is an inexhaustible source (material water, no entry). */
  isSource(x: number, y: number, z: number): boolean {
    return this.levelAt(x, y, z) === WATER_SOURCE_LEVEL;
  }

  /** Schedule one cell and its 6 neighbors for simulation. */
  activateAround(x: number, y: number, z: number): void {
    this.activate(x, y, z);
    this.activate(x + 1, y, z);
    this.activate(x - 1, y, z);
    this.activate(x, y + 1, z);
    this.activate(x, y - 1, z);
    this.activate(x, y, z + 1);
    this.activate(x, y, z - 1);
  }

  /** Public activation (tests, debug tooling): wake a cell's neighborhood. */
  wake(x: number, y: number, z: number): void {
    this.activateAround(x, y, z);
  }

  /**
   * Run one simulation step over at most `budget` active cells. Returns
   * how many cells were processed. Deterministic given the same history.
   */
  tick(budget: number = DEFAULT_FLUID_BUDGET): number {
    if (this.active.size === 0) return 0;
    const batch: number[] = [];
    for (const key of this.active) {
      batch.push(key);
      if (batch.length >= budget) break;
    }
    for (const key of batch) {
      this.active.delete(key);
      this.updateCell(key);
    }
    return batch.length;
  }

  /**
   * Run ticks until the water rests or `maxTicks` is reached (tests and
   * tooling; the game loop calls `tick` directly).
   */
  settle(maxTicks = 600, budget = DEFAULT_FLUID_BUDGET): number {
    let ticks = 0;
    while (this.active.size > 0 && ticks < maxTicks) {
      this.tick(budget);
      ticks++;
    }
    return ticks;
  }

  /** Total water mass in a region (inclusive bounds) — tests/debug. */
  totalMass(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): number {
    let mass = 0;
    for (let y = minY; y <= maxY; y++)
      for (let z = minZ; z <= maxZ; z++)
        for (let x = minX; x <= maxX; x++) mass += this.levelAt(x, y, z);
    return mass;
  }

  // --- persistence -------------------------------------------------------

  /**
   * Sparse levels for the save file: chunk key → [voxelIndex, level][].
   * Only flowing cells (1–254) are listed; everything else is derivable
   * (no water = 0, plain water material = source).
   */
  exportLevels(): Record<string, [number, number][]> {
    const out: Record<string, [number, number][]> = {};
    for (const [key, map] of this.levels) {
      if (map.size === 0) continue;
      out[key] = [...map.entries()];
    }
    return out;
  }

  /**
   * Replace all fluid state from a save payload. Existing levels and the
   * active set are cleared (loads are world resets); entries for chunks
   * not yet generated apply when the chunk appears.
   */
  loadLevels(data: Record<string, readonly [number, number][]>): void {
    this.levels.clear();
    this.active.clear();
    this.memoKey = undefined;
    this.memoMap = undefined;
    for (const [key, entries] of Object.entries(data)) {
      const map = new Map<number, number>();
      for (const [index, level] of entries) {
        if (level > 0 && level < WATER_SOURCE_LEVEL) map.set(index, level);
      }
      if (map.size > 0) this.levels.set(key, map);
    }
  }

  /** Forget all fluid state (world reset). */
  reset(): void {
    this.levels.clear();
    this.active.clear();
    this.memoKey = undefined;
    this.memoMap = undefined;
    this.dirty = false;
  }

  // --- internals ---------------------------------------------------------

  /** A freshly generated chunk may unlock flow at the streaming frontier. */
  private onChunkReady(chunk: Chunk): void {
    const ox = chunk.coord.x * 16;
    const oy = chunk.coord.y * 16;
    const oz = chunk.coord.z * 16;
    // Wake water inside the new chunk (journal replay / loaded levels may
    // have created it) and in the six face-adjacent planes of the OLD
    // neighbors — a source parked at the old boundary resumes flowing
    // into the newly loaded area. Sources have no sparse entry, so the
    // boundary planes are probed by material.
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        this.wakeIfWater(ox - 1, oy + i, oz + j);
        this.wakeIfWater(ox + 16, oy + i, oz + j);
        this.wakeIfWater(ox + i, oy - 1, oz + j);
        this.wakeIfWater(ox + i, oy + 16, oz + j);
        this.wakeIfWater(ox + i, oy + j, oz - 1);
        this.wakeIfWater(ox + i, oy + j, oz + 16);
      }
    }
    for (let ly = 0; ly < 16; ly++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          if (chunk.volume.getOrAir(lx, ly, lz) === WATER) {
            this.activateAround(ox + lx, oy + ly, oz + lz);
          }
        }
      }
    }
  }

  private wakeIfWater(x: number, y: number, z: number): void {
    if (this.world.getVoxel(x, y, z) === WATER) this.activateAround(x, y, z);
  }

  private levelsForChunk(cx: number, cy: number, cz: number): Map<number, number> | undefined {
    const key = chunkKeyOf(cx, cy, cz);
    if (key === this.memoKey) return this.memoMap;
    const map = this.levels.get(key);
    this.memoKey = key;
    this.memoMap = map;
    return map;
  }

  private mapForWrite(cx: number, cy: number, cz: number): Map<number, number> {
    const key = chunkKeyOf(cx, cy, cz);
    let map = this.levels.get(key);
    if (!map) {
      map = new Map();
      this.levels.set(key, map);
    }
    if (key !== this.memoKey) {
      this.memoKey = key;
      this.memoMap = map;
    }
    return map;
  }

  private deleteLevel(x: number, y: number, z: number): void {
    const map = this.levelsForChunk(worldToChunk(x), worldToChunk(y), worldToChunk(z));
    if (!map) return;
    const index = levelIndex(x, y, z);
    if (!map.delete(index)) return;
    if (map.size === 0) {
      this.levels.delete(this.memoKey!);
      this.memoKey = undefined;
      this.memoMap = undefined;
    }
    this.dirty = true;
  }

  private activate(x: number, y: number, z: number): void {
    if (!inKeyRange(x, y, z)) return;
    this.active.add(packCellKey(x, y, z));
  }

  /**
   * Write a level, keeping the sparse map and the voxel material in sync.
   * Returns false when the cell refused the write (unloaded chunk) — the
   * caller must not propagate mass or re-activate in that case, or a
   * frontier cell would wake itself forever. Fails silently: reads keep
   * returning the old level because the material never changed.
   */
  private setLevel(x: number, y: number, z: number, level: number): boolean {
    const current = this.levelAt(x, y, z);
    if (current === level) return true;
    const isWater = current > 0;
    const wantWater = level > 0;
    if (isWater !== wantWater) {
      if (!this.world.setVoxel(x, y, z, wantWater ? WATER : AIR)) return false;
    }
    if (level > 0 && level < WATER_SOURCE_LEVEL) {
      this.mapForWrite(worldToChunk(x), worldToChunk(y), worldToChunk(z)).set(
        levelIndex(x, y, z),
        level,
      );
    } else {
      this.deleteLevel(x, y, z);
    }
    this.dirty = true;
    return true;
  }

  /** One cell's movement rules for one tick. */
  private updateCell(key: number): void {
    const { x, y, z } = unpackCellKey(key);
    const level = this.levelAt(x, y, z);
    if (level <= 0) return; // stale activation
    const source = level === WATER_SOURCE_LEVEL;

    // 1. Gravity: everything the cell below accepts falls at once.
    if (y > 0) {
      const below = this.levelAt(x, y - 1, z);
      if (below < WATER_SOURCE_LEVEL && this.canReceive(x, y - 1, z)) {
        const space = WATER_FLOW_MAX - below;
        const move = Math.min(level, space);
        if (move > 0) {
          if (!this.setLevel(x, y - 1, z, below + move)) return; // unloaded: waits
          this.setLevel(x, y, z, source ? WATER_SOURCE_LEVEL : level - move);
          this.activateAround(x, y - 1, z);
          this.activateAround(x, y, z);
          return;
        }
      }
    }

    // 2. Horizontal equalization toward lower side neighbors.
    let current = this.levelAt(x, y, z);
    if (current <= 0) return;
    const isSource = current === WATER_SOURCE_LEVEL;
    for (const [dx, dz] of SIDE_NEIGHBORS) {
      if (!isSource && current <= 1) break;
      const nx = x + dx;
      const nz = z + dz;
      const neighbor = this.levelAt(nx, y, nz);
      if (neighbor >= WATER_FLOW_MAX || !this.canReceive(nx, y, nz)) continue;
      const diff = current - neighbor;
      if (diff < 2) continue;
      const move = diff >> 1;
      if (!this.setLevel(nx, y, nz, neighbor + move)) continue; // unloaded side
      current -= move;
      this.setLevel(x, y, z, isSource ? WATER_SOURCE_LEVEL : current);
      this.activateAround(nx, y, nz);
      this.activateAround(x, y, z);
      if (current <= 0) break;
    }
  }

  /** A cell can hold water iff it is air or already water. */
  private canReceive(x: number, y: number, z: number): boolean {
    const material = this.world.getVoxel(x, y, z);
    return material === AIR || material === WATER;
  }
}

/** Chunk-grid key for the level map (string, matching Chunk.key layout). */
function chunkKeyOf(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

/** Chunk volume index for a world cell (VoxelVolume index layout). */
function levelIndex(x: number, y: number, z: number): number {
  const lx = worldToLocal(x);
  const ly = worldToLocal(y);
  const lz = worldToLocal(z);
  return lx + lz * 16 + ly * 16 * 16;
}
