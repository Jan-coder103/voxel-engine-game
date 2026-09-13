import * as THREE from 'three';
import type { MeshData } from '../voxel/mesher';

/**
 * Mesher output → three.js BufferGeometry. This is the one place where
 * mesh data meets three.js; the mesher itself stays renderer-agnostic.
 * `voxelSize` bakes LOD scaling into positions (LOD1 = 2 so one mesh
 * voxel spans 2 world voxels). Color/material lookups happen in the voxel
 * shader (voxelMaterial.ts). The optional `waterDrop` attribute (flow
 * height) is bound when the mesher produced one; `aLight` (sky/block
 * pairs) and `aAO` (corner occlusion) come from the light-aware greedy
 * mesher and drive the shader's per-vertex light terms (Phase 17).
 */

export function buildVoxelGeometry(mesh: MeshData, voxelSize = 1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute(
    'materialId',
    new THREE.BufferAttribute(new Float32Array(mesh.materialIds), 1),
  );
  if (mesh.waterDrop) {
    geometry.setAttribute('waterDrop', new THREE.BufferAttribute(mesh.waterDrop, 1));
  }
  if (mesh.light) {
    geometry.setAttribute('aLight', new THREE.BufferAttribute(mesh.light, 2));
  }
  if (mesh.ao) {
    geometry.setAttribute('aAO', new THREE.BufferAttribute(mesh.ao, 1));
  }
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  if (voxelSize !== 1) geometry.scale(voxelSize, voxelSize, voxelSize);
  return geometry;
}
