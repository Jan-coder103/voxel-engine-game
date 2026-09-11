import { isSolidForCollision, WATER, type VoxelMaterialID } from '../voxel/materials';

/**
 * NPC navigation (Phase 12): walkable-cell queries + A* over the voxel
 * grid. The "graph" is implicit — every standable cell is a node, its
 * four horizontal neighbors with a legal vertical step are edges — so
 * there is no structure to rebuild after edits (plan §40's warning).
 * Local invalidation is the NPC sim's job: paths are short cell lists,
 * and a world write that crosses one marks that NPC for a re-path (see
 * npc.ts).
 *
 * Walkability rules (believable over correct):
 * - A cell is walkable when it and the cell above are open (headroom for
 *   a ~1.8-tall figure) and the cell below is solid (floor).
 * - Water is not open: NPCs wade nowhere and swim never — they path
 *   around lakes. Water is non-solid, so this is an explicit material
 *   check, not a solidity one.
 * - Moves: flat, one up (a step), or a drop of up to MAX_DROP. Jumps,
 *   ledges higher than one, and deeper drops are not pathable.
 *
 * Pure: no three.js, no DOM (ADR-002). Everything is deterministic given
 * the same world contents — neighbor order is fixed, the open heap
 * breaks ties by insertion order, and there is no RNG (ADR-005).
 */

/** A pathable cell: feet position; floor below, body + headroom above. */
export interface NavCell {
  x: number;
  y: number;
  z: number;
}

/** Deepest drop A* will path (anything steeper is a cliff, not a step). */
export const MAX_DROP = 3;

export interface NavQuery {
  /** True when a cell is neither solid nor water (an NPC may pass through). */
  open(x: number, y: number, z: number): boolean;
  /** True when an NPC may stand with its feet in this cell. */
  walkable(x: number, y: number, z: number): boolean;
}

/** The standard terrain query: solid registry materials + water avoidance. */
export function terrainNavQuery(
  materialAt: (x: number, y: number, z: number) => VoxelMaterialID,
): NavQuery {
  const open = (x: number, y: number, z: number): boolean => {
    const m = materialAt(x, y, z);
    return m !== WATER && !isSolidForCollision(m);
  };
  return {
    open,
    walkable(x, y, z) {
      return (
        y > 0 && open(x, y, z) && open(x, y + 1, z) && isSolidForCollision(materialAt(x, y - 1, z))
      );
    },
  };
}

/**
 * Nearest walkable cell to (x, y, z), scanning XZ rings up to `radius`
 * with a ±4 y window per cell (terrain slopes, small ledges). Returns
 * undefined when none exists — the caller idles instead of pathing. Used
 * to anchor spawns, homes, goals, and re-paths when the exact cell is
 * blocked or mid-air.
 */
export function nearestWalkable(
  query: NavQuery,
  x: number,
  y: number,
  z: number,
  radius = 6,
): NavCell | undefined {
  if (query.walkable(x, y, z)) return { x, y, z };
  for (let r = 1; r <= radius; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy = 4; dy >= -4; dy--) {
          if (query.walkable(x + dx, y + dy, z + dz)) {
            return { x: x + dx, y: y + dy, z: z + dz };
          }
        }
      }
    }
  }
  return undefined;
}

export interface PathResult {
  /** Cells from the first step after `start` through `goal`, inclusive. */
  cells: NavCell[];
}

export interface AStarOptions {
  /** Maximum dequeued nodes; keeps a hopeless search bounded. */
  maxExpansions?: number;
  /** Search abandons branches past this path length. */
  maxCost?: number;
}

interface HeapNode {
  x: number;
  y: number;
  z: number;
  g: number;
  f: number;
  /** Insertion counter — deterministic tie-break for equal f. */
  seq: number;
}

/** Binary min-heap ordered by (f, seq). */
class MinHeap {
  private nodes: HeapNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: HeapNode): void {
    const a = this.nodes;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(a[i], a[parent])) {
        [a[i], a[parent]] = [a[parent], a[i]];
        i = parent;
      } else break;
    }
  }

  pop(): HeapNode | undefined {
    const a = this.nodes;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }

  private less(a: HeapNode, b: HeapNode): boolean {
    return a.f < b.f || (a.f === b.f && a.seq < b.seq);
  }
}

/** Fixed horizontal neighbor order — part of the determinism contract. */
const NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Vertical steps per neighbor: climb 1, flat, drops down to MAX_DROP. */
const STEPS: readonly number[] = [1, 0, -1, -2, -3];

/**
 * A* from `start` to `goal` (both walkable; callers anchor with
 * `nearestWalkable` first). Returns the cell list excluding the start and
 * including the goal, or undefined when unreachable or over budget.
 * The Manhattan-distance heuristic is admissible: every move costs 1 and
 * changes the XZ Manhattan distance by exactly 1.
 */
export function findPath(
  query: NavQuery,
  start: NavCell,
  goal: NavCell,
  options: AStarOptions = {},
): PathResult | undefined {
  if (start.x === goal.x && start.y === goal.y && start.z === goal.z) return { cells: [] };
  if (!query.walkable(goal.x, goal.y, goal.z)) return undefined;

  const maxExpansions = options.maxExpansions ?? 2048;
  const maxCost = options.maxCost ?? 512;

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, NavCell>();
  const open = new MinHeap();
  let seq = 0;

  // Packed cell key: y ∈ [0, 64) fits 6 bits; x/z within ±2048 is far
  // past the streamed envelope (same approach as the fluid sim's keys).
  const key = (x: number, y: number, z: number): number =>
    ((x + 2048) * 4096 + (z + 2048)) * 64 + y;

  const h = (x: number, z: number): number => Math.abs(x - goal.x) + Math.abs(z - goal.z);

  const startKey = key(start.x, start.y, start.z);
  gScore.set(startKey, 0);
  open.push({ x: start.x, y: start.y, z: start.z, g: 0, f: h(start.x, start.z), seq: seq++ });

  let expansions = 0;
  while (open.size > 0) {
    const current = open.pop();
    if (!current) break;
    const cKey = key(current.x, current.y, current.z);
    if (current.g > (gScore.get(cKey) ?? Number.POSITIVE_INFINITY)) continue; // stale entry
    if (current.x === goal.x && current.y === goal.y && current.z === goal.z) {
      const cells: NavCell[] = [];
      let node: NavCell | undefined = { x: current.x, y: current.y, z: current.z };
      while (node && !(node.x === start.x && node.y === start.y && node.z === start.z)) {
        cells.push(node);
        node = cameFrom.get(key(node.x, node.y, node.z));
      }
      cells.reverse();
      return { cells };
    }
    if (++expansions > maxExpansions) return undefined;

    for (const [dx, dz] of NEIGHBORS) {
      const nx = current.x + dx;
      const nz = current.z + dz;
      for (const dy of STEPS) {
        const ny = current.y + dy;
        if (ny <= 0) continue;
        if (!query.walkable(nx, ny, nz)) continue;
        // A deeper drop must fall clear past the lip: every cell between
        // the ledge and the landing must be open, or the figure would
        // clip through a protruding column while "falling".
        if (dy < -1) {
          let clear = true;
          for (let sy = -1; sy > dy; sy--) {
            if (!query.open(nx, current.y + sy, nz)) {
              clear = false;
              break;
            }
          }
          if (!clear) continue;
        }
        const nG = current.g + 1;
        if (nG > maxCost) continue;
        const nKey = key(nx, ny, nz);
        const oldG = gScore.get(nKey);
        if (oldG !== undefined && oldG <= nG) continue;
        gScore.set(nKey, nG);
        cameFrom.set(nKey, { x: current.x, y: current.y, z: current.z });
        open.push({ x: nx, y: ny, z: nz, g: nG, f: nG + h(nx, nz), seq: seq++ });
      }
    }
  }
  return undefined;
}

/**
 * True when any cell of `cells` — or the floor directly under it — is
 * (x, y, z). Path invalidation checks floors too: removing ground under
 * a path cell breaks the walk as surely as filling the cell itself.
 */
export function pathTouches(cells: readonly NavCell[], x: number, y: number, z: number): boolean {
  for (const c of cells) {
    if (c.x === x && c.z === z && (c.y === y || c.y - 1 === y)) return true;
  }
  return false;
}
