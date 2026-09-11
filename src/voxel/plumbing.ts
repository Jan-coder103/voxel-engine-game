import { packCellKey, unpackCellKey } from './fluid';
import { makeCachedReader } from './cachedReader';
import { PIPE, PUMP, TAP, WATER, type VoxelMaterialID } from './materials';
import type { Chunk } from './chunk';
import type { World } from './world';
import type { FluidSim } from './fluid';

/**
 * Plumbing simulation (Phase 15, plan §113/§48 simplified): which pipes
 * are pressurized, and where the water escapes. The network is a graph
 * over utility cells — pipe conducts, a pump pressurizes, a tap is a
 * fixture — discovered as connected components of the three materials
 * (6-neighbor).
 *
 * Believable over accurate: no pressure drop, flow rate, or valve model.
 * A pump is self-powered (a diesel pump by the lake) and pressurizes its
 * whole component when water touches any of its six faces. While a
 * component is pressurized:
 *
 * - **Leaks** — a pipe destroyed by a tool, explosion, collapse, or dig
 *   registers its old cell as a leak; every pour period the sim fills
 *   the hole with flowing water through the Phase 9 fluid (`FluidSim.pour`),
 *   so a severed main genuinely floods the street. Destroy the pump (or
 *   drain the lake) and the leak stops refilling.
 * - **Taps** — a pressurized tap spurts water into the first air cell
 *   beside it, giving the town a working fountain; kill the pump and the
 *   tap runs dry.
 *
 * Leaked water is real fluid-sim water: it flows, spreads, puts out
 * fires, and sweeps NPCs — the Phase 22 "pipe → floor → room" flooding
 * chain falls out of the coupling for free.
 *
 * Local rebuilds (the power.ts pattern): writes touching a plumbing cell
 * queue that cell; each tick rebuilds at most a few components (BFS with
 * a hard cell cap) and pours on a fixed period. Chunk-ready scans update
 * state silently. All state is transient and derived from voxels — the
 * save format is untouched (leaked water persists through the fluid
 * journal; the leak *source* itself rebuilds after a load).
 *
 * Pure: no three.js, no DOM (ADR-002). Deterministic given the same
 * edit/tick sequence (ADR-005).
 */

/** Ticks between pour passes (leaks + taps); lets the fluid spread. */
export const POUR_PERIOD = 8;

/** Flowing level dumped per pour (a main line has real pressure). */
export const POUR_LEVEL = 10;

/** Hard cap on cells in one component rebuild (town main ≈ 200 cells). */
export const DEFAULT_MAX_COMPONENT = 65_536;

/** Component rebuilds per tick (main passes its own value). */
export const DEFAULT_REBUILDS_PER_TICK = 1;

export function isPlumbingCell(material: VoxelMaterialID): boolean {
  return material === PIPE || material === PUMP || material === TAP;
}

/** Fixed 6-neighbor order — part of the determinism contract. */
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Side-neighbor order for tap emission (fixed — determinism). */
const TAP_SIDES: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
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

export interface PlumbingSimOptions {
  maxComponent?: number;
}

export class PlumbingSim {
  /** Bumped whenever pressurized/leak/tap state changed (render caches). */
  revision = 0;

  private readonly pressurized = new Set<number>();
  private readonly leaks = new Set<number>();
  private readonly activeTaps = new Set<number>();
  private readonly queue: { x: number; y: number; z: number }[] = [];
  private readonly maxComponent: number;
  private tickCount = 0;

  constructor(
    private readonly world: World,
    private readonly fluid: FluidSim,
    options: PlumbingSimOptions = {},
  ) {
    this.maxComponent = options.maxComponent ?? DEFAULT_MAX_COMPONENT;
    const previous = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material, before) => {
      previous?.(x, y, z, material, before);
      if (before === PIPE && material !== PIPE && material !== WATER) {
        // A broken main: remember the hole; pour time checks pressure.
        this.leaks.add(packCellKey(x, y, z));
        this.revision++;
      }
      if (isPlumbingCell(material) || isPlumbingCell(before)) {
        this.queue.push({ x, y, z });
      }
    };
    // Chain after FluidSim, which assigns the base hook in its constructor.
    const previousReady = world.onChunkReady;
    world.onChunkReady = (chunk: Chunk) => {
      previousReady?.(chunk);
      this.scanChunk(chunk);
    };
  }

  /** Cells waiting for a component rebuild (HUD/debug). */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Registered leak sites (HUD/debug; pruned when dry or unpressurized). */
  get leakCount(): number {
    return this.leaks.size;
  }

  /** Pressurized taps (HUD/debug). */
  get tapCount(): number {
    return this.activeTaps.size;
  }

  /** True if the plumbing cell belongs to a pressurized component. */
  isPressurized(x: number, y: number, z: number): boolean {
    return this.pressurized.has(packCellKey(x, y, z));
  }

  /**
   * One fixed step: a few component rebuilds, and — every POUR_PERIOD —
   * one pour pass over leaks and taps. Returns the number of rebuilds.
   */
  tick(maxRebuilds: number = DEFAULT_REBUILDS_PER_TICK): number {
    this.tickCount++;
    let ran = 0;
    while (ran < maxRebuilds && this.queue.length > 0) {
      const seed = this.queue.shift() as { x: number; y: number; z: number };
      if (this.rebuild(seed)) ran++;
    }
    if (this.tickCount % POUR_PERIOD === 0) this.pourPass();
    return ran;
  }

  /** Run ticks until nothing is queued (tests). */
  settle(maxTicks = 256): number {
    let ticks = 0;
    while (this.queue.length > 0 && ticks < maxTicks) {
      this.tick(1);
      ticks++;
    }
    return ticks;
  }

  /** Forget all state (load/reset); callers follow with `rescan`. */
  reset(): void {
    this.pressurized.clear();
    this.leaks.clear();
    this.activeTaps.clear();
    this.queue.length = 0;
    this.tickCount = 0;
    this.revision++;
  }

  /** Re-discover plumbing cells in every loaded chunk (after a load). */
  rescan(): void {
    for (const chunk of this.world.chunks.values()) this.scanChunk(chunk);
  }

  // --- internals ---------------------------------------------------------

  private scanChunk(chunk: Chunk): void {
    const origin = chunk.origin;
    for (let ly = 0; ly < 16; ly++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          if (isPlumbingCell(chunk.volume.getOrAir(lx, ly, lz))) {
            this.queue.push({ x: origin.x + lx, y: origin.y + ly, z: origin.z + lz });
          }
        }
      }
    }
  }

  /**
   * Rebuild the component(s) at `seed`'s neighborhood. A destroyed pipe
   * seeds BOTH sides of the gap — they are separate networks now, so
   * each is flooded and pressurized independently (a severed far side
   * must go dry, not inherit the pump's pressure). Refreshes the
   * pressurized-cell and tap sets per component.
   */
  private rebuild(seed: { x: number; y: number; z: number }): boolean {
    // Component floods read thousands of cells across many chunks; the
    // cached reader keeps that off the world's one-slot memo.
    const read = makeCachedReader(this.world);
    const seeds: { x: number; y: number; z: number }[] = [];
    if (isPlumbingCell(read(seed.x, seed.y, seed.z))) {
      seeds.push({ ...seed });
    } else {
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = seed.x + dx;
        const ny = seed.y + dy;
        const nz = seed.z + dz;
        if (isPlumbingCell(read(nx, ny, nz))) seeds.push({ x: nx, y: ny, z: nz });
      }
    }
    if (seeds.length === 0) return false;

    const allVisited = new Set<number>();
    for (const start of seeds) {
      const startKey = packCellKey(start.x, start.y, start.z);
      if (allVisited.has(startKey)) continue; // covered by an earlier side
      this.rebuildComponent(start, allVisited, read);
    }
    this.revision++;
    this.consumeQueue(allVisited);
    return true;
  }

  /** Flood one connected component from `start`; update its pressure. */
  private rebuildComponent(
    start: { x: number; y: number; z: number },
    allVisited: Set<number>,
    read: (x: number, y: number, z: number) => VoxelMaterialID,
  ): void {
    const visited = new Set<number>();
    const pumps: number[] = [];
    const taps: number[] = [];
    const frontier = [start];
    while (frontier.length > 0) {
      const cell = frontier.pop() as { x: number; y: number; z: number };
      const key = packCellKey(cell.x, cell.y, cell.z);
      if (visited.has(key) || allVisited.has(key)) continue;
      const material = read(cell.x, cell.y, cell.z);
      if (!isPlumbingCell(material)) continue;
      visited.add(key);
      allVisited.add(key);
      if (visited.size > this.maxComponent) return; // oversize: leave state alone
      if (material === PUMP) pumps.push(key);
      else if (material === TAP) taps.push(key);
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const nz = cell.z + dz;
        if (!inKeyRange(nx, ny, nz)) continue;
        const nKey = packCellKey(nx, ny, nz);
        if (!visited.has(nKey) && !allVisited.has(nKey)) frontier.push({ x: nx, y: ny, z: nz });
      }
    }

    // Update the global pressurized/tap sets for this component: a
    // self-powered pump pressurizes its whole network when water
    // touches any of its faces.
    const hasFedPump = pumps.some((key) => {
      const p = unpackCellKey(key);
      return NEIGHBORS.some(([dx, dy, dz]) => read(p.x + dx, p.y + dy, p.z + dz) === WATER);
    });
    for (const key of visited) this.pressurized.delete(key);
    if (hasFedPump) {
      for (const key of visited) this.pressurized.add(key);
      for (const key of taps) this.activeTaps.add(key);
    } else {
      for (const key of taps) this.activeTaps.delete(key);
    }
  }

  /** One pass: leaks and pressurized taps emit water through the fluid. */
  private pourPass(): void {
    let poured = false;
    for (const key of this.leaks) {
      const cell = unpackCellKey(key);
      if (!this.hasPressurizedPipeNeighbor(cell)) {
        this.leaks.delete(key); // dry main or pipe fully removed
        poured = true;
        continue;
      }
      if (this.fluid.pour(cell.x, cell.y, cell.z, POUR_LEVEL)) poured = true;
    }
    for (const key of this.activeTaps) {
      const cell = unpackCellKey(key);
      for (const [dx, dy, dz] of TAP_SIDES) {
        if (this.fluid.pour(cell.x + dx, cell.y + dy, cell.z + dz, POUR_LEVEL)) {
          poured = true;
          break;
        }
      }
    }
    if (poured) this.revision++;
  }

  /** A leak keeps pouring while a pressurized pipe still touches the hole. */
  private hasPressurizedPipeNeighbor(cell: { x: number; y: number; z: number }): boolean {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const nz = cell.z + dz;
      if (
        this.world.getVoxel(nx, ny, nz) === PIPE &&
        this.pressurized.has(packCellKey(nx, ny, nz))
      ) {
        return true;
      }
    }
    return false;
  }

  /** Drop queued seeds already covered by a rebuild (same component). */
  private consumeQueue(visited: Set<number>): void {
    if (this.queue.length === 0) return;
    const kept = this.queue.filter((e) => !visited.has(packCellKey(e.x, e.y, e.z)));
    this.queue.length = 0;
    this.queue.push(...kept);
  }
}
