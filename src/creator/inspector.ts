import type { WorldCoordinate } from '../voxel/coordinates';
import { getMaterial, hardnessOf, type VoxelMaterialID } from '../voxel/materials';

/**
 * Voxel inspector (Phase 7): structured lookups for the HUD panel. Pure —
 * takes a voxel query, returns display data; main.ts formats it.
 */

export interface VoxelInspection {
  coords: WorldCoordinate;
  material: VoxelMaterialID;
  name: string;
  colorHex: number;
  /** Relative destruction resistance [0, 1]. */
  hardness: number;
}

/** Inspect one cell; `query` is usually `world.getVoxel`. */
export function inspectVoxel(
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  x: number,
  y: number,
  z: number,
): VoxelInspection {
  const material = query(x, y, z);
  const def = getMaterial(material);
  return {
    coords: { x, y, z },
    material,
    name: def.name,
    colorHex: def.color,
    hardness: hardnessOf(material),
  };
}

/** One-line HUD summary of a cell (or the "no target" placeholder). */
export function formatInspection(inspection: VoxelInspection | undefined): string {
  if (!inspection) return 'inspect —';
  const { coords, name, hardness } = inspection;
  return `inspect ${coords.x},${coords.y},${coords.z} ${name} · hardness ${hardness.toFixed(2)}`;
}
