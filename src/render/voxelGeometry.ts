import * as THREE from 'three';
import type { MeshData } from '../voxel/mesher';
import { getMaterial } from '../voxel/materials';

/**
 * Mesher output → three.js BufferGeometry. This is the one place where
 * mesh data meets three.js; the mesher itself stays renderer-agnostic.
 */

export function buildVoxelGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('materialId', new THREE.BufferAttribute(mesh.materialIds, 1));

  // Bake per-vertex colors for the standard material pipeline. (Phase 4
  // replaces this with the palette shader; the attribute stays.)
  const colorCount = mesh.materialIds.length;
  const colors = new Float32Array(colorCount * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < colorCount; i++) {
    tmp.setHex(getMaterial(mesh.materialIds[i]).color, THREE.SRGBColorSpace);
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
