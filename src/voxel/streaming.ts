import {
  type ChunkCoordinate,
  type WorldCoordinate,
  WORLD_HEIGHT_CHUNKS,
  worldToChunk,
} from './coordinates';

/**
 * Pure streaming math: which chunks should exist around the player, in
 * what order to build them, and when to let go. No three.js, no DOM —
 * the render-side ChunkMeshManager consumes these.
 */

export interface StreamingParams {
  /** Radius in chunks (XZ) around the player that must be meshed. */
  renderRadius: number;
  /** Number of vertical chunk layers (world height / chunk size). */
  worldHeightChunks: number;
}

export interface DesiredChunk {
  coord: ChunkCoordinate;
  /** Squared XZ chunk distance from the player chunk. */
  distSq: number;
}

export function streamingParams(renderRadius: number): StreamingParams {
  return { renderRadius, worldHeightChunks: WORLD_HEIGHT_CHUNKS };
}

/** Every chunk that should be meshed around the player chunk (all Y layers). */
export function desiredChunkCoords(
  playerChunkX: number,
  playerChunkZ: number,
  params: StreamingParams,
): DesiredChunk[] {
  const desired: DesiredChunk[] = [];
  const r = params.renderRadius;
  const limitSq = r * r;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const distSq = dx * dx + dz * dz;
      if (distSq > limitSq) continue;
      for (let y = 0; y < params.worldHeightChunks; y++) {
        desired.push({
          coord: { x: playerChunkX + dx, y, z: playerChunkZ + dz },
          distSq,
        });
      }
    }
  }
  return desired;
}

/** Player position → player chunk (Y clamped into the world). */
export function playerChunk(position: WorldCoordinate): ChunkCoordinate {
  return {
    x: worldToChunk(position.x),
    y: Math.min(Math.max(worldToChunk(position.y), 0), WORLD_HEIGHT_CHUNKS - 1),
    z: worldToChunk(position.z),
  };
}

/**
 * Build priority: distance first, with a small bonus (≤ 1) for chunks in
 * the camera's facing direction so ties fill the view ahead. Distance
 * always dominates — the bonus only breaks ties. Lower = build sooner.
 */
export function chunkPriority(
  chunk: ChunkCoordinate,
  playerChunkX: number,
  playerChunkZ: number,
  cameraDirXZ: { x: number; z: number },
): number {
  const dx = chunk.x - playerChunkX;
  const dz = chunk.z - playerChunkZ;
  const distSq = dx * dx + dz * dz;
  if (distSq === 0) return 0; // the player's own chunk comes first
  const dist = Math.sqrt(distSq);
  const dirLen = Math.hypot(cameraDirXZ.x, cameraDirXZ.z) || 1;
  // Alignment ∈ [-1, 1]: 1 directly ahead, -1 directly behind.
  const alignment = (dx * cameraDirXZ.x + dz * cameraDirXZ.z) / (dist * dirLen);
  return distSq + 1 - alignment;
}

/** Meshes are dropped one ring outside the render radius. */
export function shouldUnloadMesh(
  coord: ChunkCoordinate,
  playerChunkX: number,
  playerChunkZ: number,
  params: StreamingParams,
): boolean {
  const dx = coord.x - playerChunkX;
  const dz = coord.z - playerChunkZ;
  const r = params.renderRadius + 1;
  return dx * dx + dz * dz > r * r;
}

/** Chunk data is kept one ring beyond mesh unload (cheap, preserves edits). */
export function shouldUnloadData(
  coord: ChunkCoordinate,
  playerChunkX: number,
  playerChunkZ: number,
  params: StreamingParams,
): boolean {
  const dx = coord.x - playerChunkX;
  const dz = coord.z - playerChunkZ;
  const r = params.renderRadius + 2;
  return dx * dx + dz * dz > r * r;
}
