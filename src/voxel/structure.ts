import type { WorldCoordinate } from './coordinates';
import { CHUNK_SIZE, WORLD_HEIGHT, worldToChunk } from './coordinates';
import { AIR, strengthOf, WATER, type VoxelMaterialID } from './materials';
import type { World } from './world';

/**
 * Structural simulation (Phase 11): which solid cells are supported, and
 * which carry more load than their material can take. This replaces the
 * Phase 8 edit-time support approximation with a budgeted, ticked sim
 * that doubles as the fire → collapse coupling: every support-losing
 * write (tool removal, brush delete, cut, explosion, collapse cascade,
 * fire burn-out) re-queues its neighborhood through the World's change
 * hook.
 *
 * The model is a graph over solid cells, rebuilt locally per analysis
 * (believable over correct, plan §109):
 *
 * - **Nodes** are solid cells in the scan region; **connections** are the
 *   6-neighbor adjacencies. A vertical connection always transmits
 *   support; a horizontal connection transmits it only within a limited
 *   cantilever span.
 * - **Support** = a path from the bedrock layer (or from the region's
 *   horizontal boundary, which is assumed to continue into grounded
 *   terrain) that hops onto at most `MAX_CANTILEVER` groundless cells.
 *   Concretely a 0/1-cost BFS: stepping onto a cell with solid ground
 *   below is free, stepping onto one hanging in the air costs 1. Floors,
 *   plank bridges and roof overhangs hold while they stay within reach
 *   of a wall or pier; a roof whose last pillar is gone is disconnected
 *   entirely and falls.
 * - **Stress** = vertical stack load: a cell carries one mass unit for
 *   itself plus everything solid above it in its column. When the load
 *   exceeds the material's `strengthOf` threshold the cell fractures.
 *   Only cells with journaled edits are stress-eligible — natural
 *   terrain is assumed at rest (a 30-voxel stone cliff is fine; a
 *   23-voxel player-built wood tower is not). Load counts all overlying
 *   mass, so propping up terrain with wood posts still fails believably.
 *
 * Collapse is progressive: cells that fail become AIR (one grouped
 * undoable command in the game layer), which re-queues the region and
 * lets the next tick discover whatever the first stage left hanging.
 *
 * Determinism (ADR-005): fixed iteration orders, no RNG — the same
 * world + trigger produces the same collapse list.
 *
 * Pure: no three.js, no DOM (ADR-002).
 */

/**
 * How far an analysis extends past the affected edit bounds horizontally.
 * Vertically a region always spans the full world height: loads are
 * column stacks, so a cut-off top would undercount them, and at 32
 * voxels the extra rows are cheap. A house-scale structure fits well
 * inside the margin; larger builds anchor at the scan edge and are
 * intentionally left standing.
 */
export const STRUCTURE_MARGIN = 12;

/** Region cells (including air) one analysis is willing to scan. */
export const STRUCTURE_SCAN_BUDGET = 150_000;

/**
 * Groundless cells a support path may hop onto before it stops
 * transmitting support (the cantilever limit). Rooms up to ~12 voxels
 * across hold their floors from the walls; longer spans need a mid pier
 * or they drop when disturbed.
 */
export const MAX_CANTILEVER = 6;

/**
 * Hard cap on cells removed by one analysis. Bigger failures truncate
 * and let the cascade (next tick's re-analysis) finish the job, which
 * keeps a single collapse command and its debris bounded.
 */
export const MAX_COLLAPSE_CELLS = 4096;

/** Boxes waiting for analysis (bounded; see `queueRegion`). */
const MAX_PENDING_REGIONS = 32;

/** Unreachable marker in the BFS cost buffer. */
const UNSUPPORTED = 255;

/** Bit 7 of a snapshot byte: the cell carries a journaled edit. */
const EDITED_FLAG = 0x80;
const MATERIAL_MASK = 0x7f;

export interface SupportRegion {
  /** Inclusive min corner (y is usually 0). */
  min: WorldCoordinate;
  /** Inclusive max corner. */
  max: WorldCoordinate;
}

export interface CollapseCell extends WorldCoordinate {
  /** True when the cell fractured under load (vs. lost its support path). */
  stressed: boolean;
}

export interface StructureReport {
  /** Cells that fail (unsupported or overstressed), capped. */
  collapse: CollapseCell[];
  /** Solid cells with no support path (pre-cap). */
  unsupportedCount: number;
  /** Supported edited cells whose column load exceeds their strength (pre-cap). */
  overstressedCount: number;
  /** False when the region exceeded the scan budget (analysis skipped). */
  checked: boolean;
  /** Region cells examined — diagnostics/profiling. */
  scanned: number;
  /** True when `collapse` hit `MAX_COLLAPSE_CELLS` (the cascade finishes). */
  truncated: boolean;
}

export interface CollapseEvent {
  cells: CollapseCell[];
  unsupportedCount: number;
  overstressedCount: number;
}

/** The scan region for an affected edit bounds (pure helper for callers). */
export function structureRegionFor(affected: {
  min: WorldCoordinate;
  max: WorldCoordinate;
}): SupportRegion {
  return {
    min: {
      x: affected.min.x - STRUCTURE_MARGIN,
      y: 0,
      z: affected.min.z - STRUCTURE_MARGIN,
    },
    max: {
      x: affected.max.x + STRUCTURE_MARGIN,
      y: WORLD_HEIGHT - 1,
      z: affected.max.z + STRUCTURE_MARGIN,
    },
  };
}

function isSolid(material: VoxelMaterialID): boolean {
  return material !== AIR && material !== WATER;
}

/**
 * Analyze one region of the world. `world` is read directly so the
 * snapshot can iterate chunk-by-chunk (missing chunks read as air) and
 * consult each chunk's edit journal once instead of per cell.
 */
export function analyzeStructure(
  world: World,
  region: SupportRegion,
  cellBudget = STRUCTURE_SCAN_BUDGET,
): StructureReport {
  const minX = region.min.x;
  const minY = region.min.y;
  const minZ = region.min.z;
  const maxX = region.max.x;
  const maxY = region.max.y;
  const maxZ = region.max.z;
  const sx = maxX - minX + 1;
  const sy = maxY - minY + 1;
  const sz = maxZ - minZ + 1;
  const layer = sx * sz;
  const volume = sx * sy * sz;
  if (sx <= 0 || sy <= 0 || sz <= 0 || volume > cellBudget) {
    return {
      collapse: [],
      unsupportedCount: 0,
      overstressedCount: 0,
      checked: false,
      scanned: 0,
      truncated: false,
    };
  }

  // Pass 1 — snapshot: `solid` is the 0/1 buffer every later pass reads
  // (no function calls in the hot loops); `meta` keeps the material in
  // the low bits and the journaled-edit flag in bit 7 for the stress
  // pass. Missing chunks stay zero (air).
  const solid = new Uint8Array(volume);
  const meta = new Uint8Array(volume);
  const air = AIR;
  const water = WATER;
  for (let cy = worldToChunk(minY); cy <= worldToChunk(maxY); cy++) {
    const oy = cy * CHUNK_SIZE;
    const y0 = Math.max(minY, oy);
    const y1 = Math.min(maxY, oy + CHUNK_SIZE - 1);
    for (let cz = worldToChunk(minZ); cz <= worldToChunk(maxZ); cz++) {
      const oz = cz * CHUNK_SIZE;
      const z0 = Math.max(minZ, oz);
      const z1 = Math.min(maxZ, oz + CHUNK_SIZE - 1);
      for (let cx = worldToChunk(minX); cx <= worldToChunk(maxX); cx++) {
        const chunk = world.getChunk(cx, cy, cz);
        if (!chunk) continue;
        const ox = cx * CHUNK_SIZE;
        const x0 = Math.max(minX, ox);
        const x1 = Math.min(maxX, ox + CHUNK_SIZE - 1);
        const journal = world.journalFor(chunk.key);
        const data = chunk.volume;
        for (let wy = y0; wy <= y1; wy++) {
          const ly = wy - oy;
          const yBase = (wy - minY) * layer;
          for (let wz = z0; wz <= z1; wz++) {
            const lz = wz - oz;
            let flat = yBase + (wz - minZ) * sx + (x0 - minX);
            for (let wx = x0; wx <= x1; wx++, flat++) {
              const lx = wx - ox;
              const material = data.getOrAir(lx, ly, lz);
              if (material === air) continue;
              if (material !== water) solid[flat] = 1;
              meta[flat] =
                journal !== undefined && journal.has(data.index(lx, ly, lz))
                  ? material | EDITED_FLAG
                  : material;
            }
          }
        }
      }
    }
  }

  // Pass 2 — column load: each solid cell carries itself plus everything
  // solid above it in the same column (top-down sweep).
  const load = new Uint8Array(volume);
  for (let y = sy - 1; y >= 0; y--) {
    const yBase = y * layer;
    for (let i = yBase; i < yBase + layer; i++) {
      if (solid[i] === 0) continue;
      load[i] = 1 + (y < sy - 1 ? load[i + layer] : 0);
    }
  }

  // Pass 3 — support BFS with cantilever costs. cost[i] is the fewest
  // groundless hops over any support path from an anchor to cell i.
  // Entries are re-pushed only on improvement, so each cell is queued at
  // most MAX_CANTILEVER + 1 times; the queue encodes (flat, cost).
  const cost = new Uint8Array(volume).fill(UNSUPPORTED);
  const queue = new Int32Array(volume * (MAX_CANTILEVER + 1) + 8);
  let head = 0;
  let tail = 0;

  // Anchors: the bedrock layer and the region's horizontal boundary —
  // cells there are assumed to continue into grounded structure.
  for (let y = 0; y < sy; y++) {
    const anchorRow = minY + y === 0;
    for (let z = 0; z < sz; z++) {
      const edgeZ = z === 0 || z === sz - 1;
      for (let x = 0; x < sx; x++) {
        if (!anchorRow && !edgeZ && x !== 0 && x !== sx - 1) continue;
        const i = y * layer + z * sx + x;
        if (solid[i] === 0) continue;
        cost[i] = 0;
        queue[tail++] = i * 8;
      }
    }
  }

  // Horizontal moves cost a hop unless the target stands on solid
  // ground; vertical moves are free (one cell rests on the other).
  const relax = (next: number, horizontal: boolean, c: number): void => {
    if (solid[next] === 0) return;
    const grounded = next >= layer && solid[next - layer] === 1;
    const nextCost = horizontal && !grounded ? c + 1 : c;
    if (nextCost > MAX_CANTILEVER || nextCost >= cost[next]) return;
    cost[next] = nextCost;
    queue[tail++] = next * 8 + nextCost;
  };

  while (head < tail) {
    const entry = queue[head++];
    const c = entry & 7;
    const flat = (entry - c) / 8;
    if (c > cost[flat]) continue; // superseded by a cheaper path
    const lx = flat % sx;
    const lz = ((flat - lx) / sx) % sz;
    const ly = (flat - lx - lz * sx) / layer;
    if (lx > 0) relax(flat - 1, true, c);
    if (lx < sx - 1) relax(flat + 1, true, c);
    if (lz > 0) relax(flat - sx, true, c);
    if (lz < sz - 1) relax(flat + sx, true, c);
    if (ly > 0) relax(flat - layer, false, c);
    if (ly < sy - 1) relax(flat + layer, false, c);
  }

  // Pass 4 — failures: everything unreachable, plus supported edited
  // cells carrying more than their material's strength.
  const collapse: CollapseCell[] = [];
  let unsupportedCount = 0;
  let overstressedCount = 0;
  let truncated = false;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const i = y * layer + z * sx + x;
        if (solid[i] === 0) continue;
        const m = meta[i];
        let stressed: boolean;
        if (cost[i] === UNSUPPORTED) {
          unsupportedCount++;
          stressed = false;
        } else if ((m & EDITED_FLAG) !== 0 && load[i] > strengthOf(m & MATERIAL_MASK)) {
          overstressedCount++;
          stressed = true;
        } else {
          continue;
        }
        if (collapse.length < MAX_COLLAPSE_CELLS) {
          collapse.push({ x: minX + x, y: minY + y, z: minZ + z, stressed });
        } else {
          truncated = true;
        }
      }
    }
  }

  return {
    collapse,
    unsupportedCount,
    overstressedCount,
    checked: true,
    scanned: volume,
    truncated,
  };
}

/**
 * Ticked structural sim: collects support-losing writes into merged
 * regions and runs a bounded number of analyses per fixed step.
 * Collapses are *proposed* through `onCollapse` — the game layer applies
 * them as one grouped undoable command (with debris, dust, sound), which
 * re-queues the affected region and drives the progressive cascade.
 */
export class StructuralSim {
  /** Wired by main; applying the collapse through the world re-queues. */
  onCollapse?: (event: CollapseEvent) => void;

  private readonly pending: SupportRegion[] = [];

  /** Most recent analysis (HUD/debug/verification). */
  lastReport: StructureReport | undefined;

  /** Collapses proposed so far (HUD/debug). */
  collapseCount = 0;

  constructor(private readonly world: World) {
    // Chain onto the World's single change hook (fluid and fire wrap it
    // the same way — construction order is harmless). Only transitions
    // that DESTROY solid matter matter: floods and placements never
    // undermine anything, and re-placed structures are trusted until
    // the next disturbance (building freedom, Minecraft-style).
    const previous = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material, prev) => {
      previous?.(x, y, z, material, prev);
      if (isSolid(prev) && !isSolid(material)) {
        this.queueRegion(structureRegionFor({ min: { x, y, z }, max: { x, y, z } }));
      }
    };
  }

  /** Regions waiting for analysis (HUD/debug). */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Queue a region for analysis, merging it with every pending region it
   * overlaps. The list is bounded: past `MAX_PENDING_REGIONS` all boxes
   * fold into one (the scan budget then skips it if it grew too large —
   * the same graceful degradation as the Phase 8 check).
   */
  queueRegion(region: SupportRegion): void {
    let box: SupportRegion = { min: { ...region.min }, max: { ...region.max } };
    for (let i = 0; i < this.pending.length;) {
      const other = this.pending[i];
      const disjoint =
        box.min.x > other.max.x ||
        box.max.x < other.min.x ||
        box.min.y > other.max.y ||
        box.max.y < other.min.y ||
        box.min.z > other.max.z ||
        box.max.z < other.min.z;
      if (disjoint) {
        i++;
        continue;
      }
      box = union(box, other);
      this.pending.splice(i, 1);
      i = 0; // the grown box may now overlap earlier entries
    }
    this.pending.push(box);
    if (this.pending.length > MAX_PENDING_REGIONS) {
      const folded = this.pending.reduce(union);
      this.pending.length = 0;
      this.pending.push(folded);
    }
  }

  /**
   * Analyze up to `maxAnalyses` pending regions (insertion order).
   * Returns how many analyses ran. Collapse proposals fire through
   * `onCollapse`; the edits the game layer applies in response re-queue
   * regions for the next tick, driving staged progressive collapse.
   */
  tick(maxAnalyses = 1): number {
    let ran = 0;
    while (ran < maxAnalyses && this.pending.length > 0) {
      const region = this.pending.shift() as SupportRegion;
      const report = analyzeStructure(this.world, region);
      this.lastReport = report;
      ran++;
      if (report.collapse.length > 0) {
        this.collapseCount++;
        this.onCollapse?.({
          cells: report.collapse,
          unsupportedCount: report.unsupportedCount,
          overstressedCount: report.overstressedCount,
        });
      }
    }
    return ran;
  }

  /** Run ticks until nothing is pending or `maxTicks` is reached (tests). */
  settle(maxTicks = 64): number {
    let ticks = 0;
    while (this.pending.length > 0 && ticks < maxTicks) {
      this.tick(1);
      ticks++;
    }
    return ticks;
  }

  /** Forget all pending work (world reset / save load). */
  reset(): void {
    this.pending.length = 0;
    this.lastReport = undefined;
  }
}

function union(a: SupportRegion, b: SupportRegion): SupportRegion {
  return {
    min: {
      x: Math.min(a.min.x, b.min.x),
      y: Math.min(a.min.y, b.min.y),
      z: Math.min(a.min.z, b.min.z),
    },
    max: {
      x: Math.max(a.max.x, b.max.x),
      y: Math.max(a.max.y, b.max.y),
      z: Math.max(a.max.z, b.max.z),
    },
  };
}
