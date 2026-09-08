import * as THREE from 'three';
import type { MeshData } from '../voxel/mesher';

/**
 * Mesher output → three.js BufferGeometry. This is the one place where
 * mesh data meets three.js; the mesher itself stays renderer-agnostic.
 * Color/material lookups happen in the voxel shader (voxelMaterial.ts).
 */

export function buildVoxelGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute(
    'materialId',
    new THREE.BufferAttribute(new Float32Array(mesh.materialIds), 1),
  );
  geometry.setAttribute('voxelOrigin', new THREE.BufferAttribute(mesh.voxelOrigins, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}
