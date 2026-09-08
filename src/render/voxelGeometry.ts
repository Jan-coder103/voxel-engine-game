import * as THREE from 'three';
import type { MeshData } from '../voxel/mesher';
import type { VoxelMaterialID } from '../voxel/materials';

/**
 * Mesher output → three.js BufferGeometry. This is the one place where
 * mesh data meets three.js; the mesher itself stays renderer-agnostic.
 */

/** Diffuse colors per material ID, used until the Phase 4 shader lands. */
const MATERIAL_COLORS = new Map<VoxelMaterialID, number>([
  [1 /* GRASS */, 0x5fae4a],
  [2 /* DIRT */, 0x8a6238],
  [3 /* STONE */, 0x8d8d95],
  [4 /* WOOD */, 0x9c7141],
]);

const DEFAULT_COLOR = 0xcc00cc; // loud magenta: material missing from the table

export function buildVoxelGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('materialId', new THREE.BufferAttribute(mesh.materialIds, 1));

  // Bake per-vertex colors for the standard material pipeline.
  const colorCount = mesh.materialIds.length;
  const colors = new Float32Array(colorCount * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < colorCount; i++) {
    tmp.setHex(MATERIAL_COLORS.get(mesh.materialIds[i]) ?? DEFAULT_COLOR, THREE.SRGBColorSpace);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

export function createVoxelMaterial(): THREE.MeshLambertMaterial {
  // Air is handled by not emitting faces, so no transparency needed.
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}
