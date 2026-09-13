import * as THREE from 'three';
import { type ChunkCoordinate, chunkKey, worldToChunk } from '../voxel/coordinates';
import { meshVolumeGreedy } from '../voxel/greedyMesher';
import {
  DEFAULT_LOD_PARAMS,
  LOD1_FACTOR,
  desiredLod,
  downsampleVolume,
  type LodLevel,
  type LodParams,
} from '../voxel/lod';
import {
  type DesiredChunk,
  type StreamingParams,
  chunkPriority,
  desiredChunkCoords,
  shouldUnloadMesh,
} from '../voxel/streaming';
import type { Chunk } from '../voxel/chunk';
import type { World } from '../voxel/world';
import { buildVoxelGeometry } from './voxelGeometry';
import type { VoxelMaterialSet } from './voxelMaterial';

/**
 * Owns the three.js meshes for the world's chunks (the mesh cache):
 * builds queued chunks nearest-first with the greedy mesher, remeshes
 * dirty chunks (edits, neighbor generation), switches far chunks to the
 * downsampled LOD1 mesh, and disposes geometry that leaves the render
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
  /** Chunks re-meshed this frame because their LOD level changed. */
  lodSwitched: number;
  /** Chunks currently rendered at LOD1. */
  lod1: number;
  /** Total quads across all chunk meshes. */
  quads: number;
}

interface ChunkEntry {
  coord: ChunkCoordinate;
  lod: LodLevel;
  opaque: THREE.Mesh | undefined;
  water: THREE.Mesh | undefined;
  quads: number;
}

export interface ChunkMeshManagerParams {
  streaming: StreamingParams;
  /** Max chunks meshed per frame (new + remeshed + LOD switches). */
  meshBudgetPerFrame: number;
  lod?: LodParams;
  /**
   * Fluid levels at world coordinates (Phase 9), 0–255; LOD0 water meshes
   * use them for flow-height rendering. LOD1 water renders as full cubes.
   */
  waterLevels?: (x: number, y: number, z: number) => number;
  /**
   * Packed light at world coordinates (Phase 17), `sky << 4 | block`; the
   * mesher samples the air cell behind every face and folds it (plus
   * vertex AO) into the merge signature and vertex attributes.
   */
  light?: (x: number, y: number, z: number) => number;
}

const DEFAULT_PARAMS: ChunkMeshManagerParams = {
  streaming: { renderRadius: 4, worldHeightChunks: 2 },
  meshBudgetPerFrame: 3,
  lod: DEFAULT_LOD_PARAMS,
};

export class ChunkMeshManager {
  private readonly entries = new Map<string, ChunkEntry>();
  private readonly lodParams: LodParams;
  readonly stats: ChunkMeshStats = {
    meshed: 0,
    queued: 0,
    remeshed: 0,
    generated: 0,
    lodSwitched: 0,
    lod1: 0,
    quads: 0,
  };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly materials: VoxelMaterialSet,
    private readonly params: ChunkMeshManagerParams = DEFAULT_PARAMS,
  ) {
    this.lodParams = params.lod ?? DEFAULT_LOD_PARAMS;
  }

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
    this.stats.lodSwitched = 0;

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
        this.meshChunk(chunk, entry, entry.lod);
        budget--;
        this.stats.remeshed++;
      }
    }

    // 2. LOD transitions with hysteresis (cheap remesh, shares budget).
    for (const entry of this.entries.values()) {
      if (budget <= 0) break;
      const dx = entry.coord.x - playerX;
      const dz = entry.coord.z - playerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const lod = desiredLod(dist, this.lodParams, entry.lod);
      if (lod === entry.lod) continue;
      const chunk = this.world.getChunk(entry.coord.x, entry.coord.y, entry.coord.z);
      if (!chunk) continue;
      this.meshChunk(chunk, entry, lod);
      budget--;
      this.stats.lodSwitched++;
    }

    // 3. Missing chunks: nearest-first, camera-facing bonus.
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
      const dx = d.coord.x - playerX;
      const dz = d.coord.z - playerZ;
      const lod = desiredLod(Math.sqrt(dx * dx + dz * dz), this.lodParams);
      this.meshChunk(chunk, undefined, lod);
      budget--;
      this.stats.generated++;
    }

    // 4. Unload meshes outside the radius (geometry disposed; chunk data
    // is pruned separately by the world with a larger margin).
    for (const [key, entry] of this.entries) {
      if (shouldUnloadMesh(entry.coord, playerX, playerZ, this.params.streaming)) {
        this.disposeEntry(key);
      }
    }

    let quads = 0;
    let lod1 = 0;
    for (const entry of this.entries.values()) {
      quads += entry.quads;
      if (entry.lod === 1) lod1++;
    }
    this.stats.meshed = this.entries.size;
    this.stats.queued = Math.max(0, missing.length - this.stats.generated);
    this.stats.lod1 = lod1;
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

  private meshChunk(chunk: Chunk, existing: ChunkEntry | undefined, lod: LodLevel): void {
    const origin = chunk.origin;
    // LOD1 meshes a half-resolution volume; the query reads one
    // representative world voxel per boundary block (culling only needs
    // the neighbor's material class, and LOD seams are far away).
    const volume = lod === 0 ? chunk.volume : downsampleVolume(chunk.volume, LOD1_FACTOR);
    const stride = lod === 1 ? LOD1_FACTOR : 1;
    // Flow heights only exist at full resolution (LOD1 water = full cube).
    const waterLevels = lod === 0 ? this.params.waterLevels : undefined;
    const light = this.params.light;
    const mesh = meshVolumeGreedy(
      volume,
      (lx, ly, lz) =>
        this.world.getVoxel(origin.x + lx * stride, origin.y + ly * stride, origin.z + lz * stride),
      waterLevels
        ? (lx, ly, lz) => waterLevels(origin.x + lx, origin.y + ly, origin.z + lz)
        : undefined,
      light
        ? (lx, ly, lz) =>
            light(origin.x + lx * stride, origin.y + ly * stride, origin.z + lz * stride)
        : undefined,
    );

    const entry: ChunkEntry = existing ?? {
      coord: chunk.coord,
      lod,
      opaque: undefined,
      water: undefined,
      quads: 0,
    };
    entry.lod = lod;
    this.disposeEntryMeshes(entry);

    if (mesh.opaque.quadCount > 0) {
      entry.opaque = this.addMesh(
        buildVoxelGeometry(mesh.opaque, lod === 1 ? LOD1_FACTOR : 1),
        this.materials.opaque,
        origin,
      );
    }
    if (mesh.water.quadCount > 0) {
      entry.water = this.addMesh(
        buildVoxelGeometry(mesh.water, lod === 1 ? LOD1_FACTOR : 1),
        this.materials.water,
        origin,
      );
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
