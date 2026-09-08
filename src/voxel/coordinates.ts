/**
 * World, chunk, and local voxel coordinate conversions.
 *
 * Conventions (see docs/architecture.md):
 * - One chunk is a cube of CHUNK_SIZE^3 voxels.
 * - Chunk coordinates use `Math.floor` division so negative world
 *   coordinates map correctly (voxel 0 of chunk -1 is world -16).
 * - All functions are pure and integer-exact for integer inputs.
 */

/** Voxels per chunk edge. Phase 1 world is a single chunk-sized volume. */
export const CHUNK_SIZE = 16;

/** Position in world space, in voxels (1 unit = 1 voxel edge for now). */
export interface WorldCoordinate {
  x: number;
  y: number;
  z: number;
}

/** Chunk grid position (chunk-space, may be negative). */
export interface ChunkCoordinate {
  x: number;
  y: number;
  z: number;
}

/** Voxel position inside a chunk, always in `[0, CHUNK_SIZE)`. */
export interface LocalVoxelCoordinate {
  x: number;
  y: number;
  z: number;
}

/** World scalar → chunk scalar. Floor division, correct for negatives. */
export function worldToChunk(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

/** World scalar → local voxel scalar in `[0, CHUNK_SIZE)`, even for negatives. */
export function worldToLocal(v: number): number {
  return v - worldToChunk(v) * CHUNK_SIZE;
}

/** Chunk scalar + local voxel scalar → world scalar. */
export function chunkToWorld(chunk: number, local: number): number {
  return chunk * CHUNK_SIZE + local;
}

export function worldToChunkCoord(world: WorldCoordinate): ChunkCoordinate {
  return {
    x: worldToChunk(world.x),
    y: worldToChunk(world.y),
    z: worldToChunk(world.z),
  };
}

export function worldToLocalCoord(world: WorldCoordinate): LocalVoxelCoordinate {
  return {
    x: worldToLocal(world.x),
    y: worldToLocal(world.y),
    z: worldToLocal(world.z),
  };
}

export function chunkCoordToWorld(
  chunk: ChunkCoordinate,
  local: LocalVoxelCoordinate,
): WorldCoordinate {
  return {
    x: chunkToWorld(chunk.x, local.x),
    y: chunkToWorld(chunk.y, local.y),
    z: chunkToWorld(chunk.z, local.z),
  };
}
