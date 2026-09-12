import { worldToChunk, WORLD_HEIGHT } from './coordinates';
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
 * 2. Burning cell in falling weather with an open sky (Phase 16) soaks
 *    toward `WET_THRESHOLD` and is extinguished (cause `rain`); roofed
 *    cells dry out instead, exposed heat cools twice as fast, and new
 *    exposed ignition is refused while any rain falls.
 * 3. Burning cell with all six neighbors opaque → smothered (no air).
 * 4. Burning cell with fuel ≤ 1 burns out: the voxel becomes AIR (real
 *    world write — journaled, remeshed, visible to the fluid sim).
 * 5. Otherwise fuel decreases and heat is deposited into each flammable
 *    non-burning neighbor.
 * 6. Non-burning cell whose heat reaches `ignitionHeat(flammability)`
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
/**
 * Wetness (ticks of full-rain exposure) that douses a burning cell —
 * Phase 16 weather coupling. At half rain it takes twice as long, and
 * a roofed fire never accumulates wetness at all.
 */
export const WET_THRESHOLD = 60;

/** Default per-tick cell budget (main.ts passes its own tuned value). */
export const DEFAULT_FIRE_BUDGET = 256;

/** Ignition threshold for a flammability value (never below 1 tick of heat). */
export function ignitionHeat(flammability: number): number {
  return Math.max(1, Math.round(IGNITION_BASE * (1 - flammability)));
}

export type FireEvent = Extract<GameEvent, { type: 'fireIgnited' | 'fireExtinguished' }>;
type ExtinguishCause = Extract<GameEvent, { type: 'fireExtinguished' }>['cause'];

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
  /** Packed cell key → rain wetness (burning cells, while it rains). */
  private readonly wet = new Map<number, number>();
  /** Cells to simulate, insertion-ordered; packed keys. */
  private readonly active = new Set<number>();
  /** Precipitation intensity 0–1 (Phase 16 weather coupling). */
  private rain = 0;
  private dirty = false;

  /** Wired by main to the game event bus (pure core stays bus-agnostic). */
  onEvent?: (event: FireEvent) => void;

  constructor(private readonly world: World) {
    // The World exposes a single change hook; whatever sim was built first
    // owns it. Wrap instead of overwrite so both sims observe edits.
    const previous = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material, before) => {
      previous?.(x, y, z, material, before);
      const key = packCellKey(x, y, z);
      // Any external write (edit, undo, fluid, collapse) resets the cell's
      // fire state — fresh material starts cold — and re-evaluates the spot.
      if (this.burning.delete(key) || this.heat.delete(key)) this.dirty = true;
      this.wet.delete(key);
      this.activate(x, y, z);
    };
  }

  /**
   * Current precipitation (Phase 16): while it rains, cells open to the
   * sky soak toward `WET_THRESHOLD` and go out (cause `rain`), roofed
   * fires are safe, exposed heat cools faster, and new exposed ignition
   * is refused. main feeds this from the atmosphere every fixed step.
   */
  setRain(intensity: number): void {
    this.rain = Math.max(0, Math.min(1, intensity));
  }

  get rainLevel(): number {
    return this.rain;
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
   * Ignite one cell directly (creator tool, lightning). Refuses
   * non-flammable cells, cells already burning, and anything touching
   * water. `force` overrules the rain refusal (lightning is hotter
   * than weather); returns whether the cell caught.
   */
  ignite(x: number, y: number, z: number, force = false): boolean {
    if (!inKeyRange(x, y, z) || !this.isLoaded(x, y, z)) return false;
    const key = packCellKey(x, y, z);
    if (this.burning.has(key)) return true;
    const profile = fireProfileOf(this.world.getVoxel(x, y, z));
    if (profile.flammability <= 0 || profile.burnDuration <= 0) return false;
    if (this.hasWaterNeighbor(x, y, z)) return false;
    // Rain beating down on an exposed spot refuses to light (Phase 16);
    // sheltered cells light as usual.
    if (!force && this.rain > 0 && this.isSkyExposed(x, y, z)) return false;
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
  exportState(): {
    burning: [number, number][];
    heat: [number, number][];
    wet: [number, number][];
    rain: number;
  } {
    return {
      burning: [...this.burning.entries()].sort((a, b) => a[0] - b[0]),
      heat: [...this.heat.entries()].sort((a, b) => a[0] - b[0]),
      wet: [...this.wet.entries()].sort((a, b) => a[0] - b[0]),
      rain: this.rain,
    };
  }

  /** Forget all fire state (world reset / save load). */
  reset(): void {
    this.burning.clear();
    this.heat.clear();
    this.wet.clear();
    this.active.clear();
    this.rain = 0;
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

  private extinguish(x: number, y: number, z: number, key: number, cause: ExtinguishCause): void {
    this.burning.delete(key);
    this.heat.delete(key);
    this.wet.delete(key);
    this.onEvent?.({ type: 'fireExtinguished', x, y, z, cause });
  }

  /** Fuel spent: the cell is consumed — a real, journaled world edit. */
  private burnOut(x: number, y: number, z: number, key: number): void {
    this.burning.delete(key);
    this.heat.delete(key);
    this.wet.delete(key);
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
      if (this.rain > 0 && this.stepRain(x, y, z, key)) return; // doused
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
      // Rain cools exposed embers: they shed heat twice as fast.
      const decay = this.rain > 0 && this.isSkyExposed(x, y, z) ? HEAT_DECAY * 2 : HEAT_DECAY;
      const next = h - decay;
      if (next <= 0) this.heat.delete(key);
      else {
        this.heat.set(key, next);
        this.active.add(key); // keep decaying
      }
    }
  }

  /**
   * One tick of rain on a burning cell: exposed cells soak toward the
   * wet threshold (then douse, cause `rain`), roofed cells dry out.
   * Returns true when the fire went out. Deterministic — no RNG, just
   * accumulated wetness from the (deterministic) weather.
   */
  private stepRain(x: number, y: number, z: number, key: number): boolean {
    if (this.isSkyExposed(x, y, z)) {
      const wet = (this.wet.get(key) ?? 0) + this.rain;
      if (wet >= WET_THRESHOLD) {
        this.extinguish(x, y, z, key, 'rain');
        return true;
      }
      this.wet.set(key, wet);
    } else {
      const wet = (this.wet.get(key) ?? 0) - this.rain * 0.5;
      if (wet <= 0) this.wet.delete(key);
      else this.wet.set(key, wet);
    }
    return false;
  }

  /** True when nothing but air/water stands above the cell — rain lands. */
  private isSkyExposed(x: number, y: number, z: number): boolean {
    for (let sy = y + 1; sy < WORLD_HEIGHT; sy++) {
      const m = this.world.getVoxel(x, sy, z);
      if (m !== AIR && m !== WATER) return false;
    }
    return true;
  }
}
