import { worldToChunk } from './coordinates';
import { packCellKey, unpackCellKey } from './fluid';
import { AIR, fireProfileOf, isOpaque, WATER } from './materials';
import type { World } from './world';
import type { GameEvent } from '../sim/events';

/**
 * Cellular fire simulation (Phase 10). Believable over accurate: there is
 * no temperature field or oxygen meter — a burning cell is a fuel value,
 * and heat is an integer accumulator that only builds in flammable cells.
 *
 * State per world cell (all transient — fires do not persist in saves;
 * their *consequences* do, because burn-out writes through `World.setVoxel`
 * and lands in the edit journal):
 *
 * - `burning`: packed cell key → fuel remaining (ticks). The voxel keeps
 *   its material while it burns; embers/smoke particles visualize it.
 * - `heat`: packed cell key → accumulated heat. Only flammable cells hold
 *   heat, deposited by burning neighbors; heat decays when the cell ticks.
 * - `active`: insertion-ordered set of cells to simulate this budget.
 *
 * Rules per active cell, integer math, fixed neighbor order:
 * 1. Burning cell next to water → extinguished (cause `water`).
 * 2. Burning cell with all six neighbors opaque → smothered (no air).
 * 3. Burning cell with fuel ≤ 1 burns out: the voxel becomes AIR (real
 *    world write — journaled, remeshed, visible to the fluid sim).
 * 4. Otherwise fuel decreases and heat is deposited into each flammable
 *    non-burning neighbor.
 * 5. Non-burning cell whose heat reaches `ignitionHeat(flammability)`
 *    ignites with its material's burn duration.
 *
 * Determinism (ADR-005): no RNG anywhere — the same edit/tick sequence
 * produces the same fire. Activity budget mirrors the fluid sim; a cell
 * that stops changing sleeps and any write near it re-wakes the area.
 *
 * Construction order matters: construct AFTER `FluidSim` — both sims
 * observe world mutations through the World's single `onVoxelChanged`
 * hook and chain onto whatever hook exists when they are built.
 *
 * Pure: no three.js, no DOM (ADR-002).
 */

/** Heat one burning cell deposits into each flammable neighbor per tick. */
export const HEAT_PER_TICK = 2;
/** Heat a non-burning cell sheds each time it is ticked. */
export const HEAT_DECAY = 1;
/**
 * Ignition heat scale: a material with flammability 0.9 (wood) ignites at
 * heat 1 (~1 tick beside a fire), grass at 5 (~5 ticks), so tinder needs
 * a sustained blaze and stacked burning neighbors spread faster.
 */
export const IGNITION_BASE = 12;
/** Heat an explosion dumps on each flammable cell at the crater rim. */
export const BLAST_HEAT = 8;

/** Default per-tick cell budget (main.ts passes its own tuned value). */
export const DEFAULT_FIRE_BUDGET = 256;

/** Ignition threshold for a flammability value (never below 1 tick of heat). */
export function ignitionHeat(flammability: number): number {
  return Math.max(1, Math.round(IGNITION_BASE * (1 - flammability)));
}

export type FireEvent = Extract<GameEvent, { type: 'fireIgnited' | 'fireExtinguished' }>;

/** Fixed 6-neighbor order — part of the determinism contract. */
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// Key packing bounds — must match fluid.ts (same packed-key space).
const KEY_OFFSET = 0x80000;
const KEY_Y_SPAN = 0x40;

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

export class FireSim {
  /** Packed cell key → fuel remaining (ticks). */
  private readonly burning = new Map<number, number>();
  /** Packed cell key → accumulated heat (flammable cells only). */
  private readonly heat = new Map<number, number>();
  /** Cells to simulate, insertion-ordered; packed keys. */
  private readonly active = new Set<number>();
  private dirty = false;

  /** Wired by main to the game event bus (pure core stays bus-agnostic). */
  onEvent?: (event: FireEvent) => void;

  constructor(private readonly world: World) {
    // The World exposes a single change hook; whatever sim was built first
    // owns it. Wrap instead of overwrite so both sims observe edits.
    const previous = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material) => {
      previous?.(x, y, z, material);
      const key = packCellKey(x, y, z);
      // Any external write (edit, undo, fluid, collapse) resets the cell's
      // fire state — fresh material starts cold — and re-evaluates the spot.
      if (this.burning.delete(key) || this.heat.delete(key)) this.dirty = true;
      this.activate(x, y, z);
    };
  }

  /** Cells waiting to simulate (HUD/debug). */
  get activeCount(): number {
    return this.active.size;
  }

  /** Currently burning cells (HUD/render). */
  get burningCount(): number {
    return this.burning.size;
  }

  /**
   * True if any fire state changed since the last `takeDirty` — burn-out
   * edits go through the journal, so the autosave gate must hear about them.
   */
  takeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  /** True if the cell is currently burning. */
  isBurning(x: number, y: number, z: number): boolean {
    return this.burning.has(packCellKey(x, y, z));
  }

  /** Fuel remaining on a burning cell (ticks); 0 when not burning. */
  fuelAt(x: number, y: number, z: number): number {
    return this.burning.get(packCellKey(x, y, z)) ?? 0;
  }

  /**
   * Ignite one cell directly (creator tool). Refuses non-flammable cells,
   * cells already burning, and anything touching water. Returns whether
   * the cell caught.
   */
  ignite(x: number, y: number, z: number): boolean {
    if (!inKeyRange(x, y, z) || !this.isLoaded(x, y, z)) return false;
    const key = packCellKey(x, y, z);
    if (this.burning.has(key)) return true;
    const profile = fireProfileOf(this.world.getVoxel(x, y, z));
    if (profile.flammability <= 0 || profile.burnDuration <= 0) return false;
    if (this.hasWaterNeighbor(x, y, z)) return false;
    this.igniteCell(x, y, z, key, profile.burnDuration);
    return true;
  }

  /**
   * Deposit blast heat on a set of cells (explosion crater rim). Hot
   * flammable cells ignite through the normal path within a tick or two,
   * so the fire visibly spreads out of the wreck instead of popping in.
   */
  heatCells(cells: readonly { x: number; y: number; z: number }[], amount = BLAST_HEAT): void {
    for (const cell of cells) {
      const { x, y, z } = cell;
      if (!inKeyRange(x, y, z) || !this.isLoaded(x, y, z)) continue;
      const key = packCellKey(x, y, z);
      if (this.burning.has(key)) continue;
      if (fireProfileOf(this.world.getVoxel(x, y, z)).flammability <= 0) continue;
      this.heat.set(key, (this.heat.get(key) ?? 0) + amount);
      this.active.add(key);
    }
  }

  /** Schedule one cell and its 6 neighbors for simulation. */
  activateAround(x: number, y: number, z: number): void {
    this.activate(x, y, z);
    for (const [dx, dy, dz] of NEIGHBORS) this.activate(x + dx, y + dy, z + dz);
  }

  /**
   * Run one simulation step over at most `budget` active cells. Returns
   * how many cells were processed. Deterministic given the same history.
   */
  tick(budget: number = DEFAULT_FIRE_BUDGET): number {
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

  /** Run ticks until the fire dies out or `maxTicks` is reached (tests). */
  settle(maxTicks = 4000, budget = DEFAULT_FIRE_BUDGET): number {
    let ticks = 0;
    while (this.active.size > 0 && ticks < maxTicks) {
      this.tick(budget);
      ticks++;
    }
    return ticks;
  }

  /** Snapshot of burning cells for the render-side particle systems. */
  burningList(): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const key of this.burning.keys()) out.push(unpackCellKey(key));
    return out;
  }

  /** Full sim state for determinism tests and debug tooling. */
  exportState(): { burning: [number, number][]; heat: [number, number][] } {
    return {
      burning: [...this.burning.entries()].sort((a, b) => a[0] - b[0]),
      heat: [...this.heat.entries()].sort((a, b) => a[0] - b[0]),
    };
  }

  /** Forget all fire state (world reset / save load). */
  reset(): void {
    this.burning.clear();
    this.heat.clear();
    this.active.clear();
    this.dirty = false;
  }

  // --- internals ---------------------------------------------------------

  private isLoaded(x: number, y: number, z: number): boolean {
    return this.world.getChunk(worldToChunk(x), worldToChunk(y), worldToChunk(z)) !== undefined;
  }

  private activate(x: number, y: number, z: number): void {
    if (!inKeyRange(x, y, z)) return;
    this.active.add(packCellKey(x, y, z));
  }

  private igniteCell(x: number, y: number, z: number, key: number, fuel: number): void {
    this.burning.set(key, fuel);
    this.heat.delete(key);
    this.activateAround(x, y, z);
    this.onEvent?.({ type: 'fireIgnited', x, y, z });
  }

  private extinguish(
    x: number,
    y: number,
    z: number,
    key: number,
    cause: 'water' | 'smothered',
  ): void {
    this.burning.delete(key);
    this.heat.delete(key);
    this.onEvent?.({ type: 'fireExtinguished', x, y, z, cause });
  }

  /** Fuel spent: the cell is consumed — a real, journaled world edit. */
  private burnOut(x: number, y: number, z: number, key: number): void {
    this.burning.delete(key);
    this.heat.delete(key);
    this.world.setVoxel(x, y, z, AIR);
    this.activateAround(x, y, z);
    this.dirty = true;
  }

  private hasWaterNeighbor(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (this.world.getVoxel(x + dx, y + dy, z + dz) === WATER) return true;
    }
    return false;
  }

  /** Fully buried in opaque material: no air access, the fire smothers. */
  private isFullyEnclosed(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (!isOpaque(this.world.getVoxel(x + dx, y + dy, z + dz))) return false;
    }
    return true;
  }

  private spreadHeat(x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!inKeyRange(nx, ny, nz) || !this.isLoaded(nx, ny, nz)) continue;
      const nKey = packCellKey(nx, ny, nz);
      if (this.burning.has(nKey)) continue;
      if (fireProfileOf(this.world.getVoxel(nx, ny, nz)).flammability <= 0) continue;
      this.heat.set(nKey, (this.heat.get(nKey) ?? 0) + HEAT_PER_TICK);
      this.active.add(nKey);
    }
  }

  /** One cell's rules for one tick. */
  private updateCell(key: number): void {
    const { x, y, z } = unpackCellKey(key);
    if (!this.isLoaded(x, y, z)) {
      // Its chunk streamed away: out of simulation range, fire forgotten.
      this.burning.delete(key);
      this.heat.delete(key);
      return;
    }
    const material = this.world.getVoxel(x, y, z);
    const fuel = this.burning.get(key);

    if (fuel !== undefined) {
      if (this.hasWaterNeighbor(x, y, z)) {
        this.extinguish(x, y, z, key, 'water');
        return;
      }
      if (this.isFullyEnclosed(x, y, z)) {
        this.extinguish(x, y, z, key, 'smothered');
        return;
      }
      if (material === AIR || material === WATER) {
        // Defensive: the voxel vanished without the hook (never happens
        // via World) — drop the fire instead of burning a phantom.
        this.burning.delete(key);
        return;
      }
      if (fuel <= 1) {
        this.burnOut(x, y, z, key);
        return;
      }
      this.burning.set(key, fuel - 1);
      this.spreadHeat(x, y, z);
      this.active.add(key); // keep burning next tick
      return;
    }

    // Not burning: ignite at threshold, otherwise shed a little heat.
    const profile = fireProfileOf(material);
    const h = this.heat.get(key) ?? 0;
    if (profile.flammability > 0 && h >= ignitionHeat(profile.flammability)) {
      this.igniteCell(x, y, z, key, profile.burnDuration);
      return;
    }
    if (h > 0) {
      const next = h - HEAT_DECAY;
      if (next <= 0) this.heat.delete(key);
      else {
        this.heat.set(key, next);
        this.active.add(key); // keep decaying
      }
    }
  }
}
