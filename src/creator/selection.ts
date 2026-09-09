import type { WorldCoordinate } from '../voxel/coordinates';
import type { VoxelMaterialID } from '../voxel/materials';

/**
 * Box selection (Phase 7): two corner clicks define an axis-aligned box of
 * voxel cells. Pure math + a pure region copy — the render layer draws the
 * wireframe, the clipboard consumes the copy.
 */

export interface BoxSelection {
  /** Inclusive minimum corner (all components ≤ max's). */
  min: WorldCoordinate;
  /** Inclusive maximum corner. */
  max: WorldCoordinate;
}

/** Normalize two clicked corners into a canonical min/max box. */
export function selectionBounds(a: WorldCoordinate, b: WorldCoordinate): BoxSelection {
  return {
    min: {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      z: Math.min(a.z, b.z),
    },
    max: {
      x: Math.max(a.x, b.x),
      y: Math.max(a.y, b.y),
      z: Math.max(a.z, b.z),
    },
  };
}

/** Cell count along each axis (1 per axis for a single-cell selection). */
export function selectionSize(bounds: BoxSelection): { x: number; y: number; z: number } {
  return {
    x: bounds.max.x - bounds.min.x + 1,
    y: bounds.max.y - bounds.min.y + 1,
    z: bounds.max.z - bounds.min.z + 1,
  };
}

/** Hard cap so a mis-click can't allocate gigabytes; enforced by callers. */
export const MAX_SELECTION_VOLUME = 32 * 32 * 32;

/** True if the selection's cell count fits in the clipboard budget. */
export function selectionFits(bounds: BoxSelection): boolean {
  const s = selectionSize(bounds);
  return s.x * s.y * s.z <= MAX_SELECTION_VOLUME;
}

/** A copied volume: materials in the same flat layout as `VoxelVolume`
 * (`x + z·sx + y·sx·sz`), including air — transforms must round-trip. */
export interface VolumeSnapshot {
  size: { x: number; y: number; z: number };
  voxels: Uint16Array;
}

/** Read a region into a snapshot. `query` is usually `world.getVoxel`. */
export function copyRegion(
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  bounds: BoxSelection,
): VolumeSnapshot {
  const size = selectionSize(bounds);
  const voxels = new Uint16Array(size.x * size.y * size.z);
  let i = 0;
  for (let y = bounds.min.y; y <= bounds.max.y; y++) {
    for (let z = bounds.min.z; z <= bounds.max.z; z++) {
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        voxels[i++] = query(x, y, z);
      }
    }
  }
  return { size, voxels };
}
