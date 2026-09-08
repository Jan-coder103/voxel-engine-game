/**
 * Voxel material IDs. The full registry lives in Phase 4; Phase 1 only
 * needs a stable air sentinel and a handful of IDs for the demo world.
 *
 * 0 must always be air: mesher culling and bounds handling treat 0 as
 * "nothing there", and fresh typed arrays are zero-initialized to air.
 */

export type VoxelMaterialID = number;

export const AIR: VoxelMaterialID = 0;
export const GRASS: VoxelMaterialID = 1;
export const DIRT: VoxelMaterialID = 2;
export const STONE: VoxelMaterialID = 3;
export const WOOD: VoxelMaterialID = 4;

/** True if the material occupies space (anything but air). */
export function isSolidMaterial(id: VoxelMaterialID): boolean {
  return id !== AIR;
}
