import { packCellKey, unpackCellKey } from './fluid';
import { makeCachedReader } from './cachedReader';
import { COPPER, GENERATOR, LAMP, type VoxelMaterialID } from './materials';
import type { Chunk } from './chunk';
import type { World } from './world';
import type { GameEvent } from '../sim/events';

/**
 * Power grid simulation (Phase 15, plan §113/§47 simplified): which lamps
 * are lit. The grid is a graph over utility cells — copper conducts, a
 * generator supplies, a lamp consumes — discovered as connected
 * components of the three materials (6-neighbor).
 *
 * Believable over accurate (plan §47 is a sketch, not an EE model):
 * there is no voltage, current, or resistance — a component is powered
 * when it holds at least one intact generator, and its lamps are lit in
 * BFS order from the generators until the supply runs out
 * (`capacityPerGenerator` consumers each). Overload therefore browns out
 * the lamps farthest from the plant, deterministically. Generator fuel,
 * switches, and per-consumer draw are deferred until an economy exists.
 *
 * Local rebuilds (the structure.ts pattern): world writes touching a
 * utility cell queue that cell; each tick rebuilds at most a few
 * components (BFS with a hard cell cap — components bigger than the cap
 * are left as-is rather than half-computed). Chunks streaming in are
 * scanned silently: discovering existing state is not a state change, so
 * only edit-triggered rebuilds emit `powerLost` / `powerRestored` events
 * (one per flipped lamp, the Phase 13 NPC wiring consumes them).
 *
 * State is transient and derived: the lit set rebuilds from voxels
 * (journal replay + rescan) after a load, so the save format is
 * untouched.
 *
 * Pure: no three.js, no DOM (ADR-002). Deterministic given the same
 * edit/tick sequence — fixed neighbor order, no RNG (ADR-005).
 */

/** One generator supplies this many consumers (lamps). */
export const DEFAULT_CAPACITY_PER_GENERATOR = 1024;

/** Hard cap on cells in one component rebuild (town grid ≈ 6k cells). */
export const DEFAULT_MAX_COMPONENT = 65_536;

/** Component rebuilds per tick (main passes its own value). */
export const DEFAULT_REBUILDS_PER_TICK = 1;

export type PowerEvent = Extract<GameEvent, { type: 'powerLost' | 'powerRestored' }>;

export function isPowerCell(material: VoxelMaterialID): boolean {
  return material === COPPER || material === LAMP || material === GENERATOR;
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

interface QueueEntry {
  x: number;
  y: number;
  z: number;
  /** Edit-triggered rebuilds emit events; discovery scans stay silent. */
  emit: boolean;
}

export interface PowerSimOptions {
  /** Lamps supplied per intact generator in the same component. */
  capacityPerGenerator?: number;
  /** Cell cap for one component rebuild. */
  maxComponent?: number;
}

export class PowerSim {
  /** Wired by main to the game event bus (pure core stays bus-agnostic). */
  onEvent?: (event: PowerEvent) => void;

  /** Bumped whenever the lit set changed (render caches key off this). */
  revision = 0;

  private readonly lit = new Set<number>();
  private readonly queue: QueueEntry[] = [];
  private readonly capacity: number;
  private readonly maxComponent: number;
  /** The queue entry driving the current rebuild (its `emit` flag rules). */
  private currentSeed: QueueEntry = { x: 0, y: 0, z: 0, emit: false };

  constructor(
    private readonly world: World,
    options: PowerSimOptions = {},
  ) {
    this.capacity = options.capacityPerGenerator ?? DEFAULT_CAPACITY_PER_GENERATOR;
    this.maxComponent = options.maxComponent ?? DEFAULT_MAX_COMPONENT;
    // Chain onto the World's single change hook (every sim wraps whatever
    // exists — construction order is harmless).
    const previous = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material, before) => {
      previous?.(x, y, z, material, before);
      if (isPowerCell(material) || isPowerCell(before)) {
        this.queue.push({ x, y, z, emit: true });
      }
    };
    // Chunks streaming in (or journal replay on generation) may carry
    // utility cells; scan them silently. FluidSim owns the base hook and
    // is always constructed first, so chain instead of assign.
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

  /** Lit lamp cells (HUD/render). */
  get litCount(): number {
    return this.lit.size;
  }

  /** True if this lamp cell is currently lit (and still a lamp). */
  isLit(x: number, y: number, z: number): boolean {
    if (this.world.getVoxel(x, y, z) !== LAMP) return false;
    return this.lit.has(packCellKey(x, y, z));
  }

  /** Snapshot of lit lamps for the render side (small; town scale ≈ 500). */
  litPositions(): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const key of this.lit) {
      const cell = unpackCellKey(key);
      if (this.world.getVoxel(cell.x, cell.y, cell.z) === LAMP) out.push(cell);
    }
    return out;
  }

  /**
   * Rebuild up to `maxRebuilds` components (one per queued seed, in
   * queue order). A rebuild also consumes every other queued seed inside
   * the component it visited — a chunk scan queues hundreds of cells
   * that all belong to one grid. Returns how many rebuilds ran.
   */
  tick(maxRebuilds: number = DEFAULT_REBUILDS_PER_TICK): number {
    let ran = 0;
    while (ran < maxRebuilds && this.queue.length > 0) {
      const seed = this.queue.shift() as QueueEntry;
      if (this.rebuild(seed)) ran++;
    }
    return ran;
  }

  /** Run ticks until nothing is queued or `maxTicks` is reached (tests). */
  settle(maxTicks = 256): number {
    let ticks = 0;
    while (this.queue.length > 0 && ticks < maxTicks) {
      this.tick(1);
      ticks++;
    }
    return ticks;
  }

  /** Forget the lit set and queue (load/reset); callers follow with `rescan`. */
  reset(): void {
    this.lit.clear();
    this.queue.length = 0;
    this.revision++;
  }

  /** Re-discover utility cells in every loaded chunk (silent; after a load). */
  rescan(): void {
    for (const chunk of this.world.chunks.values()) this.scanChunk(chunk);
  }

  /** Full sim state for determinism tests and debug tooling. */
  exportState(): { lit: number[] } {
    return { lit: [...this.lit].sort((a, b) => a - b) };
  }

  // --- internals ---------------------------------------------------------

  private scanChunk(chunk: Chunk): void {
    // One seed per chunk is enough: the rebuild discovers the whole
    // component from any single utility cell in it.
    const origin = chunk.origin;
    for (let ly = 0; ly < 16; ly++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          if (isPowerCell(chunk.volume.getOrAir(lx, ly, lz))) {
            this.queue.push({
              x: origin.x + lx,
              y: origin.y + ly,
              z: origin.z + lz,
              emit: false,
            });
            return;
          }
        }
      }
    }
  }

  /**
   * Rebuild the component(s) at `seed`'s neighborhood. A cut wire seeds
   * BOTH sides of the gap — separate networks now — so each side is
   * flooded and lit independently (a severed far side must go dark, not
   * inherit the plant's supply). Returns false when there was nothing to
   * do. Caps at `maxComponent` cells: oversize networks keep their
   * previous state rather than a half-computed one.
   */
  private rebuild(seed: QueueEntry): boolean {
    // The BFS reads thousands of cells across many chunks; the world's
    // own one-slot memo thrashes under that pattern (see cachedReader).
    const read = makeCachedReader(this.world);
    // The seed cell may itself be gone (a destroyed wire is the news);
    // the components live around it, so start from utility neighbors.
    const seeds: { x: number; y: number; z: number }[] = [];
    if (isPowerCell(read(seed.x, seed.y, seed.z))) {
      seeds.push({ x: seed.x, y: seed.y, z: seed.z });
    } else {
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = seed.x + dx;
        const ny = seed.y + dy;
        const nz = seed.z + dz;
        if (isPowerCell(read(nx, ny, nz))) seeds.push({ x: nx, y: ny, z: nz });
      }
    }
    if (seeds.length === 0) return false;

    this.currentSeed = seed;
    const allVisited = new Set<number>();
    let overflow = false;
    for (const start of seeds) {
      const startKey = packCellKey(start.x, start.y, start.z);
      if (allVisited.has(startKey)) continue; // covered by an earlier side
      if (!this.rebuildComponent(start, allVisited, read)) overflow = true;
    }
    if (overflow) return true; // oversize somewhere: state left untouched
    this.consumeQueue(allVisited);
    return true;
  }

  /**
   * Flood one connected component from `start`, recompute its lit lamp
   * subset, and diff it against the global lit set. Edit-triggered
   * rebuilds report every flip; discovery scans apply the same diff
   * silently (streaming in is not a state change).
   */
  private rebuildComponent(
    start: { x: number; y: number; z: number },
    allVisited: Set<number>,
    read: (x: number, y: number, z: number) => VoxelMaterialID,
  ): boolean {
    const seed = this.currentSeed;
    // BFS over the component, collecting generators and lamps. The
    // frontier carries packed keys (no per-neighbor allocations).
    const visited = new Set<number>();
    const generators: number[] = [];
    const lamps: number[] = [];
    const frontier: number[] = [packCellKey(start.x, start.y, start.z)];
    while (frontier.length > 0) {
      const key = frontier.pop() as number;
      if (visited.has(key)) continue;
      const cell = unpackCellKey(key);
      const material = read(cell.x, cell.y, cell.z);
      if (!isPowerCell(material)) continue;
      visited.add(key);
      allVisited.add(key);
      if (visited.size > this.maxComponent) return false;
      if (material === GENERATOR) generators.push(key);
      else if (material === LAMP) lamps.push(key);
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const nz = cell.z + dz;
        if (!inKeyRange(nx, ny, nz)) continue;
        const nKey = packCellKey(nx, ny, nz);
        if (!visited.has(nKey)) frontier.push(nKey);
      }
    }

    // Compute the newly lit subset of this component. Under capacity —
    // the common case — every component lamp is generator-connected and
    // lit; no walk needed. Overloaded, walk out from the generators
    // (deterministic order, fixed neighbors, head-indexed queue) so the
    // farthest lamps brown out. `shift()` would be O(n²) here.
    const newlyLit = new Set<number>();
    if (generators.length > 0) {
      const supply = generators.length * this.capacity;
      if (lamps.length <= supply) {
        for (const key of lamps) newlyLit.add(key);
      } else {
        let remaining = supply;
        const queue = generators.slice();
        const seen = new Set<number>(generators);
        let head = 0;
        while (head < queue.length && remaining > 0) {
          const key = queue[head++];
          const cell = unpackCellKey(key);
          if (read(cell.x, cell.y, cell.z) === LAMP) {
            newlyLit.add(key);
            remaining--;
            if (remaining === 0) break;
          }
          for (const [dx, dy, dz] of NEIGHBORS) {
            const nx = cell.x + dx;
            const ny = cell.y + dy;
            const nz = cell.z + dz;
            if (!inKeyRange(nx, ny, nz)) continue;
            const nKey = packCellKey(nx, ny, nz);
            if (!seen.has(nKey) && isPowerCell(read(nx, ny, nz))) {
              seen.add(nKey);
              queue.push(nKey);
            }
          }
        }
      }
    }

    let changed = false;
    for (const key of lamps) {
      const was = this.lit.has(key);
      const now = newlyLit.has(key);
      if (was === now) continue;
      changed = true;
      if (now) this.lit.add(key);
      else this.lit.delete(key);
      if (seed.emit) {
        const cell = unpackCellKey(key);
        this.onEvent?.({ type: now ? 'powerRestored' : 'powerLost', ...cell });
      }
    }
    if (changed) this.revision++;
    return true;
  }

  /** Drop queued seeds already covered by a rebuild (same component). */
  private consumeQueue(visited: Set<number>): void {
    if (this.queue.length === 0) return;
    const kept: QueueEntry[] = [];
    for (const entry of this.queue) {
      if (!visited.has(packCellKey(entry.x, entry.y, entry.z))) kept.push(entry);
    }
    this.queue.length = 0;
    this.queue.push(...kept);
  }
}
