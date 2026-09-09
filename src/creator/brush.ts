import type { WorldCoordinate } from '../voxel/coordinates';
import { AIR, WATER, type VoxelMaterialID } from '../voxel/materials';
import type { VoxelEdit } from '../voxel/edits';
import { hash3 } from '../voxel/terrain';

/**
 * Brush core (Phase 7): shapes × tools → edit lists. Pure — a brush never
 * touches the world directly; it produces `VoxelEdit[]` that flow through
 * `applyEdits`, so one stroke is one grouped, undoable command and the
 * persistence journal picks it up for free.
 *
 * Conventions:
 * - `center` is the targeted voxel cell; shape tests use cell centers
 *   (x + 0.5), so a radius-N sphere is symmetric around the target.
 * - Size 1 is the smallest useful brush (sphere = 7 cells, box = 1 cell,
 *   cylinder = 5 cells).
 * - The bedrock floor (y ≤ 0) is never affected; placement refuses cells
 *   the player overlaps via the `excludes` predicate.
 */

export type BrushShape = 'sphere' | 'box' | 'cylinder' | 'noise';
/**
 * `explode` is the Phase 8 destruction entry point: it is routed to
 * `explode()` in `voxel/damage.ts` (its own edit list + debris), not to
 * `brushEdits`.
 */
export type BrushTool = 'place' | 'delete' | 'paint' | 'replace' | 'explode';

export const BRUSH_MIN_SIZE = 1;
export const BRUSH_MAX_SIZE = 8;

export interface Brush {
  shape: BrushShape;
  tool: BrushTool;
  /** Sphere/cylinder radius; box half-extent. Clamped to [MIN, MAX]. */
  size: number;
  /** Target material for place/paint/replace. */
  material: VoxelMaterialID;
  /**
   * Source material for the replace tool; AIR (the default) is the
   * wildcard "any non-air".
   */
  replaceFrom: VoxelMaterialID;
  /** Scatter seed for the noise brush — deterministic, no RNG state. */
  seed: number;
  /** [0, 1] fraction of shape cells kept by the noise brush. */
  density: number;
}

export function clampBrushSize(size: number): number {
  return Math.min(Math.max(Math.round(size), BRUSH_MIN_SIZE), BRUSH_MAX_SIZE);
}

/** Inclusive integer bounds of the cells a brush can touch. */
export function brushBounds(
  brush: Pick<Brush, 'shape' | 'size'>,
  center: WorldCoordinate,
): { min: WorldCoordinate; max: WorldCoordinate } {
  const size = clampBrushSize(brush.size);
  const r = brush.shape === 'box' ? size - 1 : size;
  return {
    min: { x: center.x - r, y: center.y - r, z: center.z - r },
    max: { x: center.x + r, y: center.y + r, z: center.z + r },
  };
}

function inSphere(dx: number, dy: number, dz: number, r: number): boolean {
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** True if the cell (whose center is offset by dx,dy,dz from the brush center) is in the shape. */
function inShape(brush: Brush, dx: number, dy: number, dz: number, cell: WorldCoordinate): boolean {
  const size = clampBrushSize(brush.size);
  switch (brush.shape) {
    case 'sphere':
      return inSphere(dx, dy, dz, size);
    case 'box':
      return Math.abs(dx) <= size - 1 && Math.abs(dy) <= size - 1 && Math.abs(dz) <= size - 1;
    case 'cylinder':
      return dx * dx + dz * dz <= size * size && Math.abs(dy) <= size - 1;
    case 'noise':
      return (
        inSphere(dx, dy, dz, size) && hash3(cell.x, cell.y, cell.z, brush.seed) < brush.density
      );
  }
}

/** Every cell the brush shape covers (unordered; deterministic). */
export function brushCells(brush: Brush, center: WorldCoordinate): WorldCoordinate[] {
  const bounds = brushBounds(brush, center);
  const cells: WorldCoordinate[] = [];
  for (let y = bounds.min.y; y <= bounds.max.y; y++) {
    for (let z = bounds.min.z; z <= bounds.max.z; z++) {
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        if (inShape(brush, x - center.x, y - center.y, z - center.z, { x, y, z })) {
          cells.push({ x, y, z });
        }
      }
    }
  }
  return cells;
}

/**
 * The edit list a brush stroke produces at `center`. `query` reads the
 * world (tools only touch cells that match their preconditions); `excludes`
 * lets callers refuse cells (player overlap). Bedrock is never touched.
 */
export function brushEdits(
  brush: Brush,
  center: WorldCoordinate,
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  excludes?: (cell: WorldCoordinate) => boolean,
): VoxelEdit[] {
  const edits: VoxelEdit[] = [];
  for (const cell of brushCells(brush, center)) {
    if (cell.y <= 0) continue; // bedrock floor stays closed
    if (excludes && excludes(cell)) continue;
    const current = query(cell.x, cell.y, cell.z);
    let target: VoxelMaterialID | undefined;
    switch (brush.tool) {
      case 'place':
        // Placement into water displaces it (Phase 9); placement builds in
        // air as before.
        if (current === AIR || current === WATER) target = brush.material;
        break;
      case 'delete':
        if (current !== AIR) target = AIR;
        break;
      case 'paint':
        if (current !== AIR) target = brush.material;
        break;
      case 'replace':
        if (current !== AIR && (brush.replaceFrom === AIR || current === brush.replaceFrom)) {
          target = brush.material;
        }
        break;
    }
    if (target === undefined) continue;
    // Water is a first-class placeable material (Phase 9): placing it
    // creates fluid sources. Paint/replace still skip water cells — the
    // fluid owns them; delete and place are the sanctioned interactions.
    if (current === WATER && brush.tool !== 'delete' && brush.tool !== 'place') continue;
    edits.push({ x: cell.x, y: cell.y, z: cell.z, material: target });
  }
  return edits;
}
