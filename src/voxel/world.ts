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
 *
 * Edit journal: every successful `setVoxel` is recorded per chunk as
 * (local voxel index → material). When a chunk is unloaded and later
 * regenerated (or a save is loaded before streaming reaches a chunk),
 * the journal replays on top of the generator, so player edits survive
 * pruning deterministically. The journal IS the persistence unit —
 * `exportEdits`/`loadEdits` are its serialized form.
 */
export class World {
  readonly chunks = new Map<string, Chunk>();
  private readonly editJournal = new Map<string, Map<number, VoxelMaterialID>>();
  // One-slot chunk memo for hot read paths (region scans, raycasts).
  // Invalidated whenever the chunk map's membership changes.
  private cachedChunk: Chunk | undefined;
  private cachedAtX = NaN;
  private cachedAtY = NaN;
  private cachedAtZ = NaN;

  /**
   * Optional observer hooks (Phase 9): the fluid simulation subscribes to
   * stay in sync with world mutations it did not perform. `onVoxelChanged`
   * fires after every successful `setVoxel` (edits, undo/redo, sim writes);
   * `onChunkReady` fires once at the end of `ensureChunk` (after journal
   * replay). Both are plain fields so tests can attach/detach freely.
   *
   * `onVoxelChanged` also receives the material the cell held before the
   * write (Phase 11): the structural sim only re-analyzes when solid
   * matter vanished, which the new material alone cannot distinguish
   * (floods write water into air; only edits replace solids).
   */
  onVoxelChanged?: (
    x: number,
    y: number,
    z: number,
    material: VoxelMaterialID,
    previous: VoxelMaterialID,
  ) => void;
  onChunkReady?: (chunk: Chunk) => void;

  constructor(private readonly generate: ChunkGenerator = () => {}) {}

  getChunk(x: number, y: number, z: number): Chunk | undefined {
    return this.chunks.get(chunkKey(x, y, z));
  }

  private cachedGetChunk(x: number, y: number, z: number): Chunk | undefined {
    if (x !== this.cachedAtX || y !== this.cachedAtY || z !== this.cachedAtZ) {
      this.cachedChunk = this.chunks.get(chunkKey(x, y, z));
      this.cachedAtX = x;
      this.cachedAtY = y;
      this.cachedAtZ = z;
    }
    return this.cachedChunk;
  }

  private invalidateChunkCache(): void {
    this.cachedAtX = NaN;
  }

  /**
   * Get or create a chunk. New chunks run the generator once, then any
   * journaled edits for that chunk replay. Generating a chunk invalidates
   * existing neighbor meshes (their boundary faces were built against air).
   */
  ensureChunk(x: number, y: number, z: number): Chunk {
    const existing = this.getChunk(x, y, z);
    if (existing) return existing;

    const coord: ChunkCoordinate = { x, y, z };
    const chunk = new Chunk(coord);
    this.generate(chunk);
    const journaled = this.editJournal.get(chunk.key);
    if (journaled) {
      for (const [index, material] of journaled) chunk.volume.setByIndex(index, material);
    }
    this.chunks.set(chunk.key, chunk);
    this.invalidateChunkCache();
    this.markNeighborsDirty(x, y, z);
    this.onChunkReady?.(chunk);
    return chunk;
  }

  /** Number of chunks that have at least one journaled edit. */
  get editedChunkCount(): number {
    return this.editJournal.size;
  }

  /**
   * Serialized form of the journal: chunk key → [voxelIndex, material][]
   * in the volume's index layout. Pure data for the persistence layer.
   */
  exportEdits(): Record<string, [number, VoxelMaterialID][]> {
    const out: Record<string, [number, VoxelMaterialID][]> = {};
    for (const [key, edits] of this.editJournal) {
      out[key] = [...edits.entries()];
    }
    return out;
  }

  /**
   * Replace the journal with serialized edits. Loaded chunks that match a
   * key get the edits applied immediately; unloaded chunks pick them up
   * when `ensureChunk` generates them.
   */
  loadEdits(edits: Record<string, readonly [number, VoxelMaterialID][]>): void {
    this.editJournal.clear();
    for (const [key, entries] of Object.entries(edits)) {
      this.editJournal.set(key, new Map(entries));
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      for (const [index, material] of entries) chunk.volume.setByIndex(index, material);
      chunk.dirty = true;
    }
  }

  /** Drop a chunk's data. Render meshes must be disposed by the caller first. */
  unloadChunk(x: number, y: number, z: number): boolean {
    this.invalidateChunkCache();
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
    if (removed > 0) this.invalidateChunkCache();
    return removed;
  }

  /**
   * True if the cell carries a journaled edit — it was written through
   * `setVoxel` at least once (player edit, brush, sim write, undo) rather
   * than coming straight from the generator. The structural stress model
   * uses this to leave natural terrain alone (see structure.ts).
   */
  isEdited(x: number, y: number, z: number): boolean {
    const cx = worldToChunk(x);
    const cy = worldToChunk(y);
    const cz = worldToChunk(z);
    const chunk = this.chunks.get(chunkKey(cx, cy, cz));
    if (!chunk) return false;
    const journaled = this.editJournal.get(chunk.key);
    if (!journaled) return false;
    return journaled.has(chunk.volume.index(worldToLocal(x), worldToLocal(y), worldToLocal(z)));
  }

  /**
   * Read-only view of one chunk's journal (voxel index → material), for
   * region scans that would otherwise call `isEdited` per cell.
   */
  journalFor(key: string): ReadonlyMap<number, VoxelMaterialID> | undefined {
    return this.editJournal.get(key);
  }

  /** Read a voxel anywhere in world space; unloaded chunks are air. */
  getVoxel(x: number, y: number, z: number): VoxelMaterialID {
    const chunk = this.cachedGetChunk(worldToChunk(x), worldToChunk(y), worldToChunk(z));
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
    const previous = chunk.volume.getOrAir(lx, ly, lz);
    if (!chunk.volume.set(lx, ly, lz, material)) return false;

    // Journal the edit so it survives unload/regeneration and persists.
    let journaled = this.editJournal.get(chunk.key);
    if (!journaled) {
      journaled = new Map();
      this.editJournal.set(chunk.key, journaled);
    }
    journaled.set(chunk.volume.index(lx, ly, lz), material);

    chunk.dirty = true;
    // Boundary voxels also change the neighbor chunk's culled faces.
    if (lx === 0) this.markDirty(cx - 1, cy, cz);
    if (lx === CHUNK_SIZE - 1) this.markDirty(cx + 1, cy, cz);
    if (ly === 0) this.markDirty(cx, cy - 1, cz);
    if (ly === CHUNK_SIZE - 1) this.markDirty(cx, cy + 1, cz);
    if (lz === 0) this.markDirty(cx, cy, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markDirty(cx, cy, cz + 1);
    this.onVoxelChanged?.(x, y, z, material, previous);
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
