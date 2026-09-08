import {
  CHUNK_SIZE,
  type ChunkCoordinate,
  chunkKey,
  worldToChunk,
  worldToLocal,
} from './coordinates';
import { AIR, type VoxelMaterialID } from './materials';
import { Chunk } from './chunk';

/** Fills a freshly created chunk with voxel data. Must be deterministic:
 * it may run at any time (streaming order), and unloaded chunks are
 * regenerated identically when the player returns. */
export type ChunkGenerator = (chunk: Chunk) => void;

/**
 * The chunk map: owns all loaded chunk data and routes world-space voxel
 * queries to the right chunk. Pure data — no three.js (ADR-002).
 *
 * Bounds policy across the map:
 * - Queries in unloaded chunks read as air (the streaming layer is
 *   responsible for loading what the player can see and touch).
 * - `setVoxel` fails in unloaded chunks and marks every chunk whose mesh
 *   depends on the voxel (own + boundary neighbors) dirty.
 */
export class World {
  readonly chunks = new Map<string, Chunk>();

  constructor(private readonly generate: ChunkGenerator = () => {}) {}

  getChunk(x: number, y: number, z: number): Chunk | undefined {
    return this.chunks.get(chunkKey(x, y, z));
  }

  /**
   * Get or create a chunk. New chunks run the generator once; generating
   * a chunk invalidates existing neighbor meshes (their boundary faces
   * were built against air).
   */
  ensureChunk(x: number, y: number, z: number): Chunk {
    const existing = this.getChunk(x, y, z);
    if (existing) return existing;

    const coord: ChunkCoordinate = { x, y, z };
    const chunk = new Chunk(coord);
    this.generate(chunk);
    this.chunks.set(chunk.key, chunk);
    this.markNeighborsDirty(x, y, z);
    return chunk;
  }

  /** Drop a chunk's data. Render meshes must be disposed by the caller first. */
  unloadChunk(x: number, y: number, z: number): boolean {
    return this.chunks.delete(chunkKey(x, y, z));
  }

  /**
   * Remove all chunks farther than `radius` chunks away (XZ distance from
   * the player chunk; vertical layers are kept). Returns how many chunks
   * were removed.
   */
  pruneBeyond(playerChunkX: number, playerChunkZ: number, radius: number): number {
    const limitSq = radius * radius;
    let removed = 0;
    for (const [key, chunk] of this.chunks) {
      const dx = chunk.coord.x - playerChunkX;
      const dz = chunk.coord.z - playerChunkZ;
      if (dx * dx + dz * dz > limitSq) {
        this.chunks.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Read a voxel anywhere in world space; unloaded chunks are air. */
  getVoxel(x: number, y: number, z: number): VoxelMaterialID {
    const chunk = this.getChunk(worldToChunk(x), worldToChunk(y), worldToChunk(z));
    if (!chunk) return AIR;
    return chunk.volume.getOrAir(worldToLocal(x), worldToLocal(y), worldToLocal(z));
  }

  /** Write a voxel anywhere in world space; fails in unloaded chunks. */
  setVoxel(x: number, y: number, z: number, material: VoxelMaterialID): boolean {
    const cx = worldToChunk(x);
    const cy = worldToChunk(y);
    const cz = worldToChunk(z);
    const chunk = this.getChunk(cx, cy, cz);
    if (!chunk) return false;

    const lx = worldToLocal(x);
    const ly = worldToLocal(y);
    const lz = worldToLocal(z);
    if (!chunk.volume.set(lx, ly, lz, material)) return false;

    chunk.dirty = true;
    // Boundary voxels also change the neighbor chunk's culled faces.
    if (lx === 0) this.markDirty(cx - 1, cy, cz);
    if (lx === CHUNK_SIZE - 1) this.markDirty(cx + 1, cy, cz);
    if (ly === 0) this.markDirty(cx, cy - 1, cz);
    if (ly === CHUNK_SIZE - 1) this.markDirty(cx, cy + 1, cz);
    if (lz === 0) this.markDirty(cx, cy, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markDirty(cx, cy, cz + 1);
    return true;
  }

  private markNeighborsDirty(x: number, y: number, z: number): void {
    this.markDirty(x - 1, y, z);
    this.markDirty(x + 1, y, z);
    this.markDirty(x, y - 1, z);
    this.markDirty(x, y + 1, z);
    this.markDirty(x, y, z - 1);
    this.markDirty(x, y, z + 1);
  }

  private markDirty(x: number, y: number, z: number): void {
    const chunk = this.getChunk(x, y, z);
    if (chunk) chunk.dirty = true;
  }
}
