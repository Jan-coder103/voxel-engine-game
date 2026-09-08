import * as THREE from 'three';
import { type ChunkCoordinate, chunkKey, worldToChunk } from '../voxel/coordinates';
import { meshVolume } from '../voxel/mesher';
import {
  type DesiredChunk,
  type StreamingParams,
  chunkPriority,
  desiredChunkCoords,
  shouldUnloadMesh,
} from '../voxel/streaming';
import type { Chunk } from '../voxel/chunk';
import type { World } from '../voxel/world';
import { buildVoxelGeometry, createVoxelMaterial } from './voxelGeometry';

/**
 * Owns the three.js meshes for the world's chunks (the mesh cache):
 * builds queued chunks nearest-first, remeshes dirty chunks (edits,
 * neighbor generation), and disposes geometry that leaves the render
 * radius. This is the only streaming component that touches three.js.
 */

export interface ChunkMeshStats {
  /** Chunks that currently have mesh cache entries (meshed or empty). */
  meshed: number;
  /** Desired chunks not yet built. */
  queued: number;
  /** Chunks rebuilt this frame (edits / neighbor generation). */
  remeshed: number;
  /** Chunks generated this frame. */
  generated: number;
  /** Total quads across all chunk meshes. */
  quads: number;
}

interface ChunkEntry {
  coord: ChunkCoordinate;
  opaque: THREE.Mesh | undefined;
  water: THREE.Mesh | undefined;
  quads: number;
}

export interface ChunkMeshManagerParams {
  streaming: StreamingParams;
  /** Max chunks meshed per update (new + remeshed combined). */
  meshBudgetPerFrame: number;
}

const DEFAULT_PARAMS: ChunkMeshManagerParams = {
  streaming: { renderRadius: 4, worldHeightChunks: 2 },
  meshBudgetPerFrame: 3,
};

export class ChunkMeshManager {
  private readonly entries = new Map<string, ChunkEntry>();
  /** Shared material — geometries are per-chunk, the material is not. */
  private readonly material = createVoxelMaterial();
  readonly stats: ChunkMeshStats = {
    meshed: 0,
    queued: 0,
    remeshed: 0,
    generated: 0,
    quads: 0,
  };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly params: ChunkMeshManagerParams = DEFAULT_PARAMS,
  ) {}

  /**
   * One streaming step around the player. `cameraDirXZ` is the camera's
   * horizontal facing (used to prioritize the view ahead).
   */
  update(
    playerPos: { x: number; y: number; z: number },
    cameraDirXZ: { x: number; z: number },
  ): void {
    const playerX = worldToChunk(playerPos.x);
    const playerZ = worldToChunk(playerPos.z);
    this.stats.remeshed = 0;
    this.stats.generated = 0;

    // 1. Edits and newly generated neighbors: remesh dirty cached chunks
    // first so visible changes always win over new chunks.
    let budget = this.params.meshBudgetPerFrame;
    for (const [key, entry] of this.entries) {
      if (budget <= 0) break;
      const chunk = this.world.getChunk(entry.coord.x, entry.coord.y, entry.coord.z);
      if (!chunk) {
        // Data was pruned underneath the mesh; drop the stale mesh.
        this.disposeEntry(key);
        continue;
      }
      if (chunk.dirty) {
        this.meshChunk(chunk, entry);
        budget--;
        this.stats.remeshed++;
      }
    }

    // 2. Missing chunks: nearest-first, camera-facing bonus.
    const desired = desiredChunkCoords(playerX, playerZ, this.params.streaming);
    const missing = desired.filter(
      (d) => !this.entries.has(chunkKey(d.coord.x, d.coord.y, d.coord.z)),
    );
    missing.sort(
      (a, b) =>
        this.priority(a, playerX, playerZ, cameraDirXZ) -
        this.priority(b, playerX, playerZ, cameraDirXZ),
    );
    for (const d of missing) {
      if (budget <= 0) break;
      const chunk = this.world.ensureChunk(d.coord.x, d.coord.y, d.coord.z);
      this.meshChunk(chunk);
      budget--;
      this.stats.generated++;
    }

    // 3. Unload meshes outside the radius (geometry disposed; chunk data
    // is pruned separately by the world with a larger margin).
    for (const [key, entry] of this.entries) {
      if (shouldUnloadMesh(entry.coord, playerX, playerZ, this.params.streaming)) {
        this.disposeEntry(key);
      }
    }

    this.stats.meshed = this.entries.size;
    this.stats.queued = Math.max(0, missing.length - this.stats.generated);
    let quads = 0;
    for (const entry of this.entries.values()) quads += entry.quads;
    this.stats.quads = quads;
  }

  /** Dispose all meshes and clear the cache (for shutdown/tests). */
  dispose(): void {
    for (const key of [...this.entries.keys()]) this.disposeEntry(key);
  }

  private priority(
    d: DesiredChunk,
    playerX: number,
    playerZ: number,
    cameraDirXZ: { x: number; z: number },
  ): number {
    return chunkPriority(d.coord, playerX, playerZ, cameraDirXZ);
  }

  private meshChunk(chunk: Chunk, existing?: ChunkEntry): void {
    const origin = chunk.origin;
    const mesh = meshVolume(chunk.volume, (lx, ly, lz) =>
      this.world.getVoxel(origin.x + lx, origin.y + ly, origin.z + lz),
    );

    const entry: ChunkEntry = existing ?? {
      coord: chunk.coord,
      opaque: undefined,
      water: undefined,
      quads: 0,
    };
    this.disposeEntryMeshes(entry);

    if (mesh.opaque.quadCount > 0) {
      entry.opaque = this.addMesh(buildVoxelGeometry(mesh.opaque), this.material, origin);
    }
    if (mesh.water.quadCount > 0) {
      entry.water = this.addMesh(buildVoxelGeometry(mesh.water), this.material, origin);
    }
    entry.quads = mesh.opaque.quadCount + mesh.water.quadCount;
    chunk.dirty = false;
    if (!existing) this.entries.set(chunk.key, entry);
  }

  private addMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    origin: { x: number; y: number; z: number },
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    // Geometry is in chunk-local coordinates; place it in the world once.
    // Static meshes skip per-frame matrix updates.
    mesh.position.set(origin.x, origin.y, origin.z);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    return mesh;
  }

  private disposeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.disposeEntryMeshes(entry);
    this.entries.delete(key);
  }

  private disposeEntryMeshes(entry: ChunkEntry): void {
    for (const mesh of [entry.opaque, entry.water]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    entry.opaque = undefined;
    entry.water = undefined;
    entry.quads = 0;
  }
}
