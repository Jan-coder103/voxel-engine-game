import { describe, expect, it } from 'vitest';
import { meshVolume } from '../src/voxel/mesher';
import { AIR, GRASS, STONE } from '../src/voxel/materials';
import { VoxelVolume } from '../src/voxel/voxelVolume';

/** Cross product of quad edges (v1-v0) × (v2-v0). */
function quadNormal(positions: Float32Array, base: number): [number, number, number] {
  const ax = positions[(base + 1) * 3] - positions[base * 3];
  const ay = positions[(base + 1) * 3 + 1] - positions[base * 3 + 1];
  const az = positions[(base + 1) * 3 + 2] - positions[base * 3 + 2];
  const bx = positions[(base + 2) * 3] - positions[base * 3];
  const by = positions[(base + 2) * 3 + 1] - positions[base * 3 + 1];
  const bz = positions[(base + 2) * 3 + 2] - positions[base * 3 + 2];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

describe('meshVolume', () => {
  it('returns empty buffers for an empty volume', () => {
    const mesh = meshVolume(new VoxelVolume(4));
    expect(mesh.quadCount).toBe(0);
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });

  it('emits exactly 6 outward-facing quads for a single voxel', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, STONE);
    const mesh = meshVolume(volume);

    expect(mesh.quadCount).toBe(6);
    expect(mesh.positions.length).toBe(6 * 4 * 3);
    expect(mesh.materialIds.length).toBe(6 * 4);
    expect(mesh.indices.length).toBe(6 * 6);

    // Every quad's stored normal matches its geometric winding normal and
    // points away from the voxel center (1.5, 1.5, 1.5).
    for (let quad = 0; quad < 6; quad++) {
      const base = quad * 4;
      const [cx, cy, cz] = quadNormal(mesh.positions, base);
      const nx = mesh.normals[base * 3];
      const ny = mesh.normals[base * 3 + 1];
      const nz = mesh.normals[base * 3 + 2];
      // Cross product is parallel to the stored normal and same-direction.
      expect(cx).toBeCloseTo(nx * Math.hypot(cx, cy, cz), 5);
      expect(cy).toBeCloseTo(ny * Math.hypot(cx, cy, cz), 5);
      expect(cz).toBeCloseTo(nz * Math.hypot(cx, cy, cz), 5);
      // Outward: dot(normal, faceCenter - voxelCenter) > 0.
      const fx =
        (mesh.positions[base * 3] +
          mesh.positions[(base + 1) * 3] +
          mesh.positions[(base + 2) * 3] +
          mesh.positions[(base + 3) * 3]) /
        4;
      const fy =
        (mesh.positions[base * 3 + 1] +
          mesh.positions[(base + 1) * 3 + 1] +
          mesh.positions[(base + 2) * 3 + 1] +
          mesh.positions[(base + 3) * 3 + 1]) /
        4;
      const fz =
        (mesh.positions[base * 3 + 2] +
          mesh.positions[(base + 1) * 3 + 2] +
          mesh.positions[(base + 2) * 3 + 2] +
          mesh.positions[(base + 3) * 3 + 2]) /
        4;
      expect((fx - 1.5) * nx + (fy - 1.5) * ny + (fz - 1.5) * nz).toBeGreaterThan(0);
    }
  });

  it('culls faces shared between two adjacent voxels', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, STONE);
    volume.set(2, 1, 1, STONE);
    const mesh = meshVolume(volume);
    // 2 voxels × 6 faces − 2 hidden shared faces = 10 quads.
    expect(mesh.quadCount).toBe(10);
  });

  it('fully buries interior voxels (2×2×2 solid block: 24 quads)', () => {
    const volume = new VoxelVolume(6);
    for (let y = 1; y < 3; y++)
      for (let z = 1; z < 3; z++) for (let x = 1; x < 3; x++) volume.set(x, y, z, STONE);
    expect(meshVolume(volume).quadCount).toBe(24);
  });

  it('emits faces at volume boundaries (outside counts as air)', () => {
    const volume = new VoxelVolume(2);
    volume.fill(STONE);
    const mesh = meshVolume(volume);
    // Only the 6 outer hull faces of the 2³ block survive culling.
    expect(mesh.quadCount).toBe(6 * 2 * 2);
  });

  it('propagates material IDs onto generated vertices', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, GRASS);
    volume.set(2, 1, 1, STONE);
    const mesh = meshVolume(volume);
    for (let v = 0; v < mesh.materialIds.length; v++) {
      expect([GRASS, STONE]).toContain(mesh.materialIds[v]);
    }
    // Grass's +X face is culled by the stone neighbor: 5 faces × 4 verts.
    const grassVerts = mesh.materialIds.filter((id) => id === GRASS).length;
    expect(grassVerts).toBe(5 * 4);
    const stoneVerts = mesh.materialIds.filter((id) => id === STONE).length;
    expect(stoneVerts).toBe(5 * 4);
  });

  it('produces indices referencing valid vertices in quad pattern', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, STONE);
    volume.set(1, 2, 1, STONE);
    const mesh = meshVolume(volume);
    expect(mesh.indices.length).toBe(mesh.quadCount * 6);
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]).toBeLessThan(mesh.positions.length / 3);
    }
    for (let quad = 0; quad < mesh.quadCount; quad++) {
      const b = quad * 6;
      expect(mesh.indices[b]).toBe(quad * 4);
      expect(mesh.indices[b + 1]).toBe(quad * 4 + 1);
      expect(mesh.indices[b + 2]).toBe(quad * 4 + 2);
      expect(mesh.indices[b + 3]).toBe(quad * 4 + 2);
      expect(mesh.indices[b + 4]).toBe(quad * 4 + 1);
      expect(mesh.indices[b + 5]).toBe(quad * 4 + 3);
    }
  });

  it('meshes the demo world without exposing fully enclosed faces', () => {
    // Sanity: a solid volume's hull for a 16³ fully-solid world is 6·16².
    const volume = new VoxelVolume(16);
    volume.fill(STONE);
    expect(meshVolume(volume).quadCount).toBe(6 * 256);
    expect(volume.getOrAir(-1, 0, 0)).toBe(AIR);
  });
});
