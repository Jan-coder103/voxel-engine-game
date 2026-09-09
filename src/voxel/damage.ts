import type { WorldCoordinate } from './coordinates';
import { AIR, hardnessOf, WATER, type VoxelMaterialID } from './materials';
import type { VoxelEdit } from './edits';
import { hash3 } from './terrain';

/**
 * Damage model (Phase 8): spherical damage fields with material
 * resistance, deterministic debris generation. Pure — like the brush
 * core, nothing here mutates the world; callers flow the edit list
 * through `applyEdits` (one blast = one undoable command) and hand the
 * debris specs to the render layer's pooled systems.
 *
 * Believability over accuracy: a cell fractures when the blast reaches it
 * "strongly enough" for its hardness — soft materials are stripped to the
 * blast edge, hard stone only near the core. Bedrock (y ≤ 0) is immune.
 * Water belongs to the Phase 9 fluid system and is never affected.
 */

/**
 * Fraction of the blast radius that reaches a material: hardness 1 stone
 * survives beyond CORE_FRACTION, hardness 0 material is stripped to the
 * very edge. cellDist ≤ radius · (CORE + (1−CORE) · (1 − hardness)).
 */
const CORE_FRACTION = 0.35;

export interface DebrisSpec {
  /** World-space spawn position (voxel units, cell center + jitter). */
  x: number;
  y: number;
  z: number;
  /** Initial velocity (voxels/second). */
  vx: number;
  vy: number;
  vz: number;
  material: VoxelMaterialID;
  /** Box edge length; render layer maps this to instance scale. */
  scale: number;
}

export interface ExplosionResult {
  edits: VoxelEdit[];
  debris: DebrisSpec[];
  /** Number of solid cells the blast removed (excludes bedrock/water). */
  destroyed: number;
}

export interface ExplosionOptions {
  /** Scatter seed — same (seed, blast) always yields the same debris. */
  seed: number;
  /** Hard cap on debris pieces; deterministic subsampling keeps it. */
  maxDebris: number;
}

/** Fracture all cells a spherical blast overpowers. */
export function explode(
  center: { x: number; y: number; z: number },
  radius: number,
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  options: ExplosionOptions,
): ExplosionResult {
  const minX = Math.floor(center.x - radius);
  const maxX = Math.ceil(center.x + radius);
  const minY = Math.max(1, Math.floor(center.y - radius)); // bedrock immune
  const maxY = Math.ceil(center.y + radius);
  const minZ = Math.floor(center.z - radius);
  const maxZ = Math.ceil(center.z + radius);

  const edits: VoxelEdit[] = [];
  const hitCells: WorldCoordinate[] = [];
  const hitMaterials: VoxelMaterialID[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const material = query(x, y, z);
        if (material === AIR || material === WATER) continue;
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        const dz = z + 0.5 - center.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const reach = radius * (CORE_FRACTION + (1 - CORE_FRACTION) * (1 - hardnessOf(material)));
        if (dist > reach) continue;
        edits.push({ x, y, z, material: AIR });
        hitCells.push({ x, y, z });
        hitMaterials.push(material);
      }
    }
  }

  // Deterministic subsample: stride over the destroyed cells so the debris
  // cap holds without sequential RNG state.
  const stride = Math.max(1, Math.ceil(hitCells.length / options.maxDebris));
  const debris: DebrisSpec[] = [];
  for (let i = 0; i < hitCells.length; i += stride) {
    const cell = hitCells[i];
    const r1 = hash3(cell.x, cell.y, cell.z, options.seed);
    const r2 = hash3(cell.x, cell.y, cell.z, options.seed + 101);
    const r3 = hash3(cell.x, cell.y, cell.z, options.seed + 202);
    // Radial impulse from the blast center, upward bias, jittered speed.
    const dx = cell.x + 0.5 - center.x;
    const dy = cell.y + 0.5 - center.y;
    const dz = cell.z + 0.5 - center.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const speed = 4 + r1 * 4;
    debris.push({
      x: cell.x + 0.5 + (r1 - 0.5) * 0.5,
      y: cell.y + 0.5 + (r2 - 0.5) * 0.5,
      z: cell.z + 0.5 + (r3 - 0.5) * 0.5,
      vx: (dx / len) * speed + (r2 - 0.5) * 2,
      vy: Math.abs(dy / len) * speed * 0.6 + 2.5 + r3 * 2.5,
      vz: (dz / len) * speed + (r1 - 0.5) * 2,
      material: hitMaterials[i],
      scale: 0.45 + r1 * 0.45,
    });
  }

  return { edits, debris, destroyed: hitCells.length };
}

/**
 * Debris for an arbitrary set of fractured cells (structural collapse):
 * small random velocities, mostly tumbling downward. Deterministic per
 * (cells, seed).
 */
export function debrisFromCells(
  cells: readonly WorldCoordinate[],
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  options: ExplosionOptions & { /** Centroid the pieces tumble away from. */ x: number; z: number },
): DebrisSpec[] {
  const stride = Math.max(1, Math.ceil(cells.length / options.maxDebris));
  const debris: DebrisSpec[] = [];
  for (let i = 0; i < cells.length; i += stride) {
    const cell = cells[i];
    const material = query(cell.x, cell.y, cell.z);
    if (material === AIR || material === WATER) continue;
    const r1 = hash3(cell.x, cell.y, cell.z, options.seed);
    const r2 = hash3(cell.x, cell.y, cell.z, options.seed + 101);
    const r3 = hash3(cell.x, cell.y, cell.z, options.seed + 202);
    debris.push({
      x: cell.x + 0.5,
      y: cell.y + 0.5,
      z: cell.z + 0.5,
      vx: (cell.x + 0.5 - options.x) * 0.15 + (r1 - 0.5) * 3,
      vy: -1 - r2 * 1.5,
      vz: (cell.z + 0.5 - options.z) * 0.15 + (r3 - 0.5) * 3,
      material,
      scale: 0.4 + r1 * 0.4,
    });
  }
  return debris;
}
