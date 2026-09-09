import type { WorldCoordinate } from './coordinates';
import { AIR, type VoxelMaterialID } from './materials';

/**
 * Voxel DDA raycast (Amanatides & Woo grid traversal). Pure: takes a ray
 * and a voxel query, walks cell-by-cell, and reports the first cell that
 * satisfies the hit predicate. No three.js, no DOM — the render layer
 * turns this into a selection highlight, the edit layer into place/remove.
 *
 * Conventions:
 * - The traversal checks the cell containing the origin first. A ray that
 *   starts inside a hit cell returns it with a zero `normal` and
 *   `distance` 0 (there is no entered face); callers decide what that
 *   means (editing skips placement so you cannot glue a voxel to itself).
 * - `normal` is the unit axis pointing out of the hit face, i.e. the
 *   offset from the hit voxel to the cell the ray came through.
 */

export interface RaycastHit {
  /** Cell that satisfied the predicate. */
  voxel: WorldCoordinate;
  /** Unit axis out of the hit face; all-zero when the ray starts inside. */
  normal: WorldCoordinate;
  /** Distance from origin to the hit point (entry plane of the voxel). */
  distance: number;
  /** Exact point on the entry face (origin + direction · distance). */
  point: { x: number; y: number; z: number };
  /** Material of the hit cell. */
  material: VoxelMaterialID;
}

export interface Ray {
  origin: { x: number; y: number; z: number };
  /** Need not be normalized; it is normalized defensively. */
  direction: { x: number; y: number; z: number };
}

export type VoxelPredicate = (material: VoxelMaterialID) => boolean;

/** Default hit rule: anything that is not air. */
export const isNotAir: VoxelPredicate = (material) => material !== AIR;

interface AxisState {
  /** Traversal direction along the axis: -1, 0, or +1. */
  step: number;
  /** Positive t-distance between consecutive cell boundary crossings. */
  tDelta: number;
  /** t of the next crossing along this axis. */
  tMax: number;
}

function axisState(origin: number, dir: number): AxisState {
  const cell = Math.floor(origin);
  if (dir === 0) return { step: 0, tDelta: Infinity, tMax: Infinity };
  const step = dir > 0 ? 1 : -1;
  // Distance to the boundary in front of us, as a multiple of dir.
  const boundary = dir > 0 ? cell + 1 : cell;
  return { step, tDelta: Math.abs(1 / dir), tMax: (boundary - origin) / dir };
}

/**
 * Walk the grid from `ray.origin` up to `maxDistance` and return the first
 * cell with `predicate(material) !== false`, or undefined. `query` treats
 * unloaded space as air at the World level; this function itself works
 * with any query.
 */
export function raycastVoxels(
  ray: Ray,
  maxDistance: number,
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  predicate: VoxelPredicate = isNotAir,
): RaycastHit | undefined {
  const len = Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z);
  if (len === 0) return undefined;
  const dx = ray.direction.x / len;
  const dy = ray.direction.y / len;
  const dz = ray.direction.z / len;

  const o = ray.origin;
  const x = Math.floor(o.x);
  const y = Math.floor(o.y);
  const z = Math.floor(o.z);

  // The starting cell has no entered face; a hit there is a special case.
  const startMaterial = query(x, y, z);
  if (predicate(startMaterial)) {
    return {
      voxel: { x, y, z },
      normal: { x: 0, y: 0, z: 0 },
      distance: 0,
      point: { x: o.x, y: o.y, z: o.z },
      material: startMaterial,
    };
  }

  const ax = axisState(o.x, dx);
  const ay = axisState(o.y, dy);
  const az = axisState(o.z, dz);
  let cx = x;
  let cy = y;
  let cz = z;
  let normal = { x: 0, y: 0, z: 0 };

  // Traversal ends only via the max-distance bailouts above.
  while (true) {
    // Advance through the cell boundary that comes first.
    let t: number;
    if (ax.tMax <= ay.tMax && ax.tMax <= az.tMax) {
      t = ax.tMax;
      if (t > maxDistance) return undefined;
      cx += ax.step;
      ax.tMax += ax.tDelta;
      normal = { x: -ax.step, y: 0, z: 0 };
    } else if (ay.tMax <= az.tMax) {
      t = ay.tMax;
      if (t > maxDistance) return undefined;
      cy += ay.step;
      ay.tMax += ay.tDelta;
      normal = { x: 0, y: -ay.step, z: 0 };
    } else {
      t = az.tMax;
      if (t > maxDistance) return undefined;
      cz += az.step;
      az.tMax += az.tDelta;
      normal = { x: 0, y: 0, z: -az.step };
    }

    const material = query(cx, cy, cz);
    if (predicate(material)) {
      return {
        voxel: { x: cx, y: cy, z: cz },
        normal,
        distance: t,
        point: { x: o.x + dx * t, y: o.y + dy * t, z: o.z + dz * t },
        material,
      };
    }
  }
}
