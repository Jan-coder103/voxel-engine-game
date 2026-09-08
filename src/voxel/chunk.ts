import { type ChunkCoordinate, chunkKeyCoord } from './coordinates';
import { CHUNK_SIZE } from './coordinates';
import { VoxelVolume } from './voxelVolume';

/**
 * One chunk: a 16³ slice of the world plus its mesh-related state.
 * Data lives in `volume`; `dirty` marks that voxel data changed since
 * the last mesh build (set by edits and by generation of neighbors —
 * boundary faces need remeshing when a neighbor appears).
 */
export class Chunk {
  readonly volume = new VoxelVolume(CHUNK_SIZE);
  dirty = true;

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
