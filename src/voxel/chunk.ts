import { type ChunkCoordinate, chunkKeyCoord } from './coordinates';
import { CHUNK_SIZE } from './coordinates';
import { PackedVolume } from './packedVolume';
import type { VoxelData } from './voxelVolume';

/**
 * One chunk: a 16³ slice of the world plus its mesh-related state.
 * Data lives in a palette-compressed volume (Phase 6); `dirty` marks that
 * voxel data changed since the last mesh build (set by edits and by
 * generation of neighbors — boundary faces need remeshing when a
 * neighbor appears).
 *
 * Light storage (Phase 17): the light field keeps one byte per voxel for
 * each channel (sky 0–15, block 0–15) on the chunk, allocated lazily by
 * the LightField when the chunk is initialized — so unloading a chunk
 * frees its light with it, and chunks the light field has never touched
 * render with the "full sky" default.
 */
export class Chunk {
  readonly volume: VoxelData = new PackedVolume(CHUNK_SIZE);
  dirty = true;
  /** Per-voxel sky light 0–15 (index layout = volume index), when initialized. */
  lightSky?: Uint8Array;
  /** Per-voxel block light 0–15 (index layout = volume index), when initialized. */
  lightBlock?: Uint8Array;

  constructor(readonly coord: ChunkCoordinate) {}

  get key(): string {
    return chunkKeyCoord(this.coord);
  }

  /** World-space voxel origin of this chunk (its minimum corner). */
  get origin(): { x: number; y: number; z: number } {
    return {
      x: this.coord.x * CHUNK_SIZE,
      y: this.coord.y * CHUNK_SIZE,
      z: this.coord.z * CHUNK_SIZE,
    };
  }
}
