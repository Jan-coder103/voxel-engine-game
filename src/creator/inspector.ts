import type { WorldCoordinate } from '../voxel/coordinates';
import { getMaterial, hardnessOf, WATER, type VoxelMaterialID } from '../voxel/materials';

/**
 * Voxel inspector (Phase 7): structured lookups for the HUD panel. Pure —
 * takes a voxel query, returns display data; main.ts formats it.
 * Since Phase 9 it also reports a water cell's fluid level.
 */

export interface VoxelInspection {
  coords: WorldCoordinate;
  material: VoxelMaterialID;
  name: string;
  colorHex: number;
  /** Relative destruction resistance [0, 1]. */
  hardness: number;
  /** Fluid level 0–255 when inspecting water, else undefined. */
  water?: number;
  /** Fuel remaining (ticks) when the cell is burning, else undefined. */
  burning?: number;
}

/** Inspect one cell; `query` is usually `world.getVoxel`. */
export function inspectVoxel(
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  x: number,
  y: number,
  z: number,
  waterLevel?: number,
  burningFuel?: number,
): VoxelInspection {
  const material = query(x, y, z);
  const def = getMaterial(material);
  return {
    coords: { x, y, z },
    material,
    name: def.name,
    colorHex: def.color,
    hardness: hardnessOf(material),
    water: material === WATER ? (waterLevel ?? 0) : undefined,
    burning: burningFuel && burningFuel > 0 ? burningFuel : undefined,
  };
}

/** One-line HUD summary of a cell (or the "no target" placeholder). */
export function formatInspection(inspection: VoxelInspection | undefined): string {
  if (!inspection) return 'inspect —';
  const { coords, name, hardness, water, burning } = inspection;
  const waterText = water !== undefined ? ` · water ${water}/255` : '';
  const burnText = burning !== undefined ? ` · burning ${burning} fuel` : '';
  return `inspect ${coords.x},${coords.y},${coords.z} ${name} · hardness ${hardness.toFixed(2)}${waterText}${burnText}`;
}
