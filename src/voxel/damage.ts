import type { WorldCoordinate } from './coordinates';
import { AIR, fireProfileOf, hardnessOf, WATER, type VoxelMaterialID } from './materials';
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
 * Water (Phase 9) is vaporized within reach — no debris, no resistance —
 * and the fluid system then floods the crater back from surrounding
 * sources.
 *
 * Phase 10 heat coupling: flammable cells that survive just outside the
 * fracture reach are reported in `heated` so the fire sim can ignite them
 * (the blast is a moving ignition source, not just a hole punch).
 */

/**
 * Fraction of the blast radius that reaches a material: hardness 1 stone
 * survives beyond CORE_FRACTION, hardness 0 material is stripped to the
 * very edge. cellDist ≤ radius · (CORE + (1−CORE) · (1 − hardness)).
 */
const CORE_FRACTION = 0.35;

const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

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
  /** Flammable survivors at the crater rim — feed to FireSim.heatCells. */
  heated: WorldCoordinate[];
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
  const destroyedCells = new Set<string>();
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const material = query(x, y, z);
        if (material === AIR) continue;
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        const dz = z + 0.5 - center.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const reach = radius * (CORE_FRACTION + (1 - CORE_FRACTION) * (1 - hardnessOf(material)));
        if (dist > reach) continue;
        edits.push({ x, y, z, material: AIR });
        destroyedCells.add(`${x},${y},${z}`);
        // Water vaporizes with no debris; only solids fracture into pieces.
        if (material === WATER) continue;
        hitCells.push({ x, y, z });
        hitMaterials.push(material);
      }
    }
  }

  // Heat rim: flammable cells that survived directly beside destroyed
  // ones. Deterministic scan order, deduplicated across shared neighbors.
  const heated: WorldCoordinate[] = [];
  const heatedSeen = new Set<string>();
  for (const cell of hitCells) {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const nz = cell.z + dz;
      const nKey = `${nx},${ny},${nz}`;
      if (destroyedCells.has(nKey) || heatedSeen.has(nKey)) continue;
      if (fireProfileOf(query(nx, ny, nz)).flammability <= 0) continue;
      heatedSeen.add(nKey);
      heated.push({ x: nx, y: ny, z: nz });
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

  return { edits, debris, destroyed: hitCells.length, heated };
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
