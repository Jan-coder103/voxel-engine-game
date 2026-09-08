import type { VoxelVolume } from './voxelVolume';
import { AIR, WATER, isOpaque, type VoxelMaterialID } from './materials';

/**
 * Naive culled face mesher: one quad per voxel face that touches air (or,
 * for opaque voxels, touches water). Pure data in, plain arrays out — no
 * three.js here (ADR-002), so this is unit-testable in node.
 *
 * Face-culling rules:
 * - opaque voxel: emits a face iff the neighbor is NOT opaque (air or
 *   water) — underwater terrain stays visible through the water.
 * - water: emits a face iff the neighbor is air — water-water and
 *   water-solid interfaces are hidden.
 *
 * Neighbor access: `query` receives volume-local coordinates and may be
 * asked for coordinates outside `[0, size)`; chunk meshing passes one
 * that reads the neighboring chunks. Missing neighbors read as air.
 */

/** Quad corner offsets, ordered so triangles [0,1,2, 2,1,3] wind CCW
 * when viewed from outside the face (three.js front-face convention). */
interface FaceDef {
  dir: readonly [number, number, number];
  corners: readonly (readonly [number, number, number])[];
}

const FACES: readonly FaceDef[] = [
  {
    // -X
    dir: [-1, 0, 0],
    corners: [
      [0, 1, 0],
      [0, 0, 0],
      [0, 1, 1],
      [0, 0, 1],
    ],
  },
  {
    // +X
    dir: [1, 0, 0],
    corners: [
      [1, 1, 1],
      [1, 0, 1],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
  {
    // -Y
    dir: [0, -1, 0],
    corners: [
      [1, 0, 1],
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, 0],
    ],
  },
  {
    // +Y
    dir: [0, 1, 0],
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [0, 1, 0],
      [1, 1, 0],
    ],
  },
  {
    // -Z
    dir: [0, 0, -1],
    corners: [
      [1, 0, 0],
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    // +Z
    dir: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ],
  },
];

/** Mesh buffers for one pass. Vertex attributes are per-vertex. */
export interface MeshData {
  /** 3 floats per vertex, voxel-corner coordinates (voxel at origin spans [0,1]). */
  positions: Float32Array;
  /** 3 floats per vertex, unit axis normals. */
  normals: Float32Array;
  /** Material ID per vertex (per-face in practice). */
  materialIds: Uint16Array;
  /** 3 floats per vertex, the integer voxel the vertex belongs to (shader variation). */
  voxelOrigins: Float32Array;
  /** Triangle indices, 6 per quad. */
  indices: Uint32Array;
  readonly quadCount: number;
}

/** Opaque and water passes for one volume (water renders transparent). */
export interface ChunkMesh {
  opaque: MeshData;
  water: MeshData;
}

/** Local-coordinate voxel query; coordinates may leave `[0, size)`. */
export type VoxelQuery = (x: number, y: number, z: number) => VoxelMaterialID;

interface MeshBuffers {
  positions: number[];
  normals: number[];
  materialIds: number[];
  voxelOrigins: number[];
  indices: number[];
}

function emptyBuffers(): MeshBuffers {
  return { positions: [], normals: [], materialIds: [], voxelOrigins: [], indices: [] };
}

function toMeshData(buffers: MeshBuffers): MeshData {
  return {
    positions: new Float32Array(buffers.positions),
    normals: new Float32Array(buffers.normals),
    materialIds: new Uint16Array(buffers.materialIds),
    voxelOrigins: new Float32Array(buffers.voxelOrigins),
    indices: new Uint32Array(buffers.indices),
    quadCount: buffers.indices.length / 6,
  };
}

/** Extract an outward-facing culled mesh from a volume. */
export function meshVolume(volume: VoxelVolume, query: VoxelQuery): ChunkMesh {
  // In-bounds reads always come from the volume itself, so a query that
  // (incorrectly) handles in-bounds coordinates cannot corrupt the mesh.
  const voxelAt: VoxelQuery = (x, y, z) =>
    volume.inBounds(x, y, z) ? volume.get(x, y, z) : query(x, y, z);

  const opaque = emptyBuffers();
  const water = emptyBuffers();

  const size = volume.size;
  for (let y = 0; y < size; y++) {
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const material = voxelAt(x, y, z);
        if (material === AIR) continue;

        const buffers = material === WATER ? water : opaque;
        const emitsAgainst = (neighbor: VoxelMaterialID) =>
          material === WATER ? neighbor === AIR : !isOpaque(neighbor);

        for (const face of FACES) {
          const [dx, dy, dz] = face.dir;
          const neighbor = voxelAt(x + dx, y + dy, z + dz);
          if (!emitsAgainst(neighbor)) continue;

          const vertexBase = buffers.positions.length / 3;
          for (const [cx, cy, cz] of face.corners) {
            buffers.positions.push(x + cx, y + cy, z + cz);
            buffers.normals.push(dx, dy, dz);
            buffers.materialIds.push(material);
            buffers.voxelOrigins.push(x, y, z);
          }
          buffers.indices.push(vertexBase, vertexBase + 1, vertexBase + 2);
          buffers.indices.push(vertexBase + 2, vertexBase + 1, vertexBase + 3);
        }
      }
    }
  }

  return { opaque: toMeshData(opaque), water: toMeshData(water) };
}
