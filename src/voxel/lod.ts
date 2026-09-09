import { AIR, type VoxelMaterialID } from './materials';
import { VoxelVolume, type VoxelData } from './voxelVolume';

/**
 * Level-of-detail math for chunk meshes (Phase 6). Pure: the chunk mesh
 * manager asks `desiredLod` per chunk each frame and remeshes on change.
 *
 * Levels: 0 = full-resolution mesh; 1 = one mesh voxel per 2³ block
 * (majority material), built by the same greedy mesher and scaled up 2×.
 * Selection uses two distance thresholds so a chunk sitting at the
 * boundary cannot flicker between levels (switch away only past `high`,
 * back only inside `low`).
 */

export type LodLevel = 0 | 1;

/** LOD1 voxel spans this many world voxels per edge. */
export const LOD1_FACTOR = 2;

export interface LodParams {
  /** Chunk distance beyond which meshes drop to LOD1. */
  high: number;
  /** Chunk distance inside which LOD1 meshes return to full detail. */
  low: number;
}

export const DEFAULT_LOD_PARAMS: LodParams = { high: 4.5, low: 3.5 };

/**
 * Hysteresis selection: `distChunks` is the chunk's XZ distance from the
 * player chunk. With no current level (fresh chunk), thresholds compare
 * directly against `high`.
 */
export function desiredLod(distChunks: number, params: LodParams, current?: LodLevel): LodLevel {
  if (params.low >= params.high) {
    throw new RangeError('LodParams.low must be smaller than high (hysteresis band)');
  }
  if (current === 1) return distChunks < params.low ? 0 : 1;
  return distChunks > params.high ? 1 : 0;
}

/**
 * Downsample a volume by `factor` per axis: each output cell holds the
 * most frequent material of its f³ block, counting air as a candidate —
 * and ties resolve to air. The air-conservative tie-break matters: a
 * block that is only half terrain must NOT become fully terrain, or LOD1
 * surfaces sit visibly above the full-resolution mesh and "pop down"
 * when the player approaches. With this rule LOD1 never adds terrain;
 * at worst it erodes up to one (block-aligned) layer.
 */
export function downsampleVolume(volume: VoxelData, factor = LOD1_FACTOR): VoxelVolume {
  if (volume.size % factor !== 0) {
    throw new RangeError(`Volume size ${volume.size} is not divisible by factor ${factor}`);
  }
  const out = new VoxelVolume(volume.size / factor);
  const counts = new Map<VoxelMaterialID, number>();
  const blockSize = factor * factor * factor;

  for (let oz = 0; oz < out.size; oz++) {
    for (let oy = 0; oy < out.size; oy++) {
      for (let ox = 0; ox < out.size; ox++) {
        counts.clear();
        let airCount = 0;
        let best: VoxelMaterialID = AIR;
        let bestCount = 0;
        for (let dz = 0; dz < factor; dz++) {
          for (let dy = 0; dy < factor; dy++) {
            for (let dx = 0; dx < factor; dx++) {
              const material = volume.get(ox * factor + dx, oy * factor + dy, oz * factor + dz);
              if (material === AIR) {
                airCount++;
                continue;
              }
              const next = (counts.get(material) ?? 0) + 1;
              counts.set(material, next);
              // Strict > keeps the earliest material on non-air ties.
              if (next > bestCount) {
                best = material;
                bestCount = next;
              }
            }
          }
        }
        // Air wins ties against the strongest non-air material (which
        // also covers all-air blocks, where bestCount is 0).
        out.set(ox, oy, oz, airCount * 2 >= blockSize ? AIR : best);
      }
    }
  }
  return out;
}
