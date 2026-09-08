import type { VoxelVolume } from './voxelVolume';
import { isSolidMaterial } from './materials';

/**
 * Naive culled face mesher: one quad per voxel face that touches air.
 * Pure data in, plain arrays out — no three.js here (ADR-002), so this
 * is unit-testable and benchmarkable in node.
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

/** Mesh buffers for one volume. Vertex attributes are per-vertex. */
export interface MeshData {
  /** 3 floats per vertex, voxel-corner coordinates (voxel at origin spans [0,1]). */
  positions: Float32Array;
  /** 3 floats per vertex, unit axis normals. */
  normals: Float32Array;
  /** Material ID per vertex (per-face in practice). */
  materialIds: Uint16Array;
  /** Triangle indices, 6 per quad. */
  indices: Uint32Array;
  readonly quadCount: number;
}

/** Extract an outward-facing culled mesh from a volume. */
export function meshVolume(volume: VoxelVolume): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const materialIds: number[] = [];
  const indices: number[] = [];
  const size = volume.size;

  for (let y = 0; y < size; y++) {
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const material = volume.getOrAir(x, y, z);
        if (!isSolidMaterial(material)) continue;

        for (const face of FACES) {
          const [dx, dy, dz] = face.dir;
          const neighbor = volume.getOrAir(x + dx, y + dy, z + dz);
          if (isSolidMaterial(neighbor)) continue;

          const vertexBase = positions.length / 3;
          for (const [cx, cy, cz] of face.corners) {
            positions.push(x + cx, y + cy, z + cz);
            normals.push(dx, dy, dz);
            materialIds.push(material);
          }
          indices.push(vertexBase, vertexBase + 1, vertexBase + 2);
          indices.push(vertexBase + 2, vertexBase + 1, vertexBase + 3);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    materialIds: new Uint16Array(materialIds),
    indices: new Uint32Array(indices),
    quadCount: indices.length / 6,
  };
}
