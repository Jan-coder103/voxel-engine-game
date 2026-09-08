import { describe, expect, it } from 'vitest';
import { meshVolume, type VoxelQuery } from '../src/voxel/mesher';
import { AIR, GRASS, STONE, WATER } from '../src/voxel/materials';
import { VoxelVolume } from '../src/voxel/voxelVolume';

/** Standalone-volume query: outside the volume is air. */
function localQuery(volume: VoxelVolume): VoxelQuery {
  return (x, y, z) => volume.getOrAir(x, y, z);
}

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
    const volume = new VoxelVolume(4);
    const mesh = meshVolume(volume, localQuery(volume));
    expect(mesh.opaque.quadCount).toBe(0);
    expect(mesh.water.quadCount).toBe(0);
    expect(mesh.opaque.positions.length).toBe(0);
    expect(mesh.opaque.indices.length).toBe(0);
  });

  it('emits exactly 6 outward-facing quads for a single voxel', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, STONE);
    const mesh = meshVolume(volume, localQuery(volume));
    const { positions, normals } = mesh.opaque;

    expect(mesh.opaque.quadCount).toBe(6);
    expect(positions.length).toBe(6 * 4 * 3);
    expect(mesh.opaque.materialIds.length).toBe(6 * 4);
    expect(mesh.opaque.indices.length).toBe(6 * 6);

    // Every quad's stored normal matches its geometric winding normal and
    // points away from the voxel center (1.5, 1.5, 1.5).
    for (let quad = 0; quad < 6; quad++) {
      const base = quad * 4;
      const [cx, cy, cz] = quadNormal(positions, base);
      const nx = normals[base * 3];
      const ny = normals[base * 3 + 1];
      const nz = normals[base * 3 + 2];
      // Cross product is parallel to the stored normal and same-direction.
      expect(cx).toBeCloseTo(nx * Math.hypot(cx, cy, cz), 5);
      expect(cy).toBeCloseTo(ny * Math.hypot(cx, cy, cz), 5);
      expect(cz).toBeCloseTo(nz * Math.hypot(cx, cy, cz), 5);
      // Outward: dot(normal, faceCenter - voxelCenter) > 0.
      const fx =
        (positions[base * 3] +
          positions[(base + 1) * 3] +
          positions[(base + 2) * 3] +
          positions[(base + 3) * 3]) /
        4;
      const fy =
        (positions[base * 3 + 1] +
          positions[(base + 1) * 3 + 1] +
          positions[(base + 2) * 3 + 1] +
          positions[(base + 3) * 3 + 1]) /
        4;
      const fz =
        (positions[base * 3 + 2] +
          positions[(base + 1) * 3 + 2] +
          positions[(base + 2) * 3 + 2] +
          positions[(base + 3) * 3 + 2]) /
        4;
      expect((fx - 1.5) * nx + (fy - 1.5) * ny + (fz - 1.5) * nz).toBeGreaterThan(0);
    }
  });

  it('culls faces shared between two adjacent voxels', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, STONE);
    volume.set(2, 1, 1, STONE);
    const mesh = meshVolume(volume, localQuery(volume));
    // 2 voxels × 6 faces − 2 hidden shared faces = 10 quads.
    expect(mesh.opaque.quadCount).toBe(10);
  });

  it('fully buries interior voxels (2×2×2 solid block: 24 quads)', () => {
    const volume = new VoxelVolume(6);
    for (let y = 1; y < 3; y++)
      for (let z = 1; z < 3; z++) for (let x = 1; x < 3; x++) volume.set(x, y, z, STONE);
    expect(meshVolume(volume, localQuery(volume)).opaque.quadCount).toBe(24);
  });

  it('emits faces at volume boundaries (outside counts as air)', () => {
    const volume = new VoxelVolume(2);
    volume.fill(STONE);
    const mesh = meshVolume(volume, localQuery(volume));
    // Only the 6 outer hull faces of the 2³ block survive culling.
    expect(mesh.opaque.quadCount).toBe(6 * 2 * 2);
  });

  it('culls boundary faces against solid neighbors from the query', () => {
    const volume = new VoxelVolume(4);
    volume.set(3, 1, 1, STONE); // voxel at the +X edge
    const mesh = meshVolume(volume, localQuery(volume));
    expect(mesh.opaque.quadCount).toBe(6);

    // Pretend the neighboring chunk has a solid voxel at the same height.
    const withNeighbor: VoxelQuery = (x, y, z) => (x >= 4 ? STONE : volume.getOrAir(x, y, z));
    const culled = meshVolume(volume, withNeighbor);
    expect(culled.opaque.quadCount).toBe(5); // +X face now hidden
  });

  it('emits voxelOrigins for shader variation', () => {
    const volume = new VoxelVolume(4);
    volume.set(2, 1, 1, STONE);
    const mesh = meshVolume(volume, localQuery(volume));
    expect(mesh.opaque.voxelOrigins.length).toBe(mesh.opaque.positions.length);
    const origins = mesh.opaque.voxelOrigins;
    for (let v = 0; v < origins.length / 3; v++) {
      expect(origins[v * 3]).toBe(2);
      expect(origins[v * 3 + 1]).toBe(1);
      expect(origins[v * 3 + 2]).toBe(1);
    }
  });

  describe('water', () => {
    it('emits water faces only against air, into the water pass', () => {
      const volume = new VoxelVolume(4);
      volume.set(1, 1, 1, WATER);
      const mesh = meshVolume(volume, localQuery(volume));
      expect(mesh.water.quadCount).toBe(6);
      expect(mesh.opaque.quadCount).toBe(0);
      expect(mesh.water.materialIds.every((id) => id === WATER)).toBe(true);
    });

    it('culls water-water interfaces', () => {
      const volume = new VoxelVolume(4);
      volume.set(1, 1, 1, WATER);
      volume.set(2, 1, 1, WATER);
      const mesh = meshVolume(volume, localQuery(volume));
      expect(mesh.water.quadCount).toBe(10);
    });

    it('keeps solid faces visible against water (underwater terrain)', () => {
      const volume = new VoxelVolume(4);
      volume.set(1, 1, 1, STONE);
      volume.set(2, 1, 1, WATER); // water where the stone's +X face is
      const mesh = meshVolume(volume, localQuery(volume));
      // Stone emits all 6 faces (water is not opaque) and water emits only
      // the face pointing away from the stone (its -X face is against stone).
      expect(mesh.opaque.quadCount).toBe(6);
      expect(mesh.water.quadCount).toBe(5);
    });
  });

  it('propagates material IDs onto generated vertices', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, GRASS);
    volume.set(2, 1, 1, STONE);
    const mesh = meshVolume(volume, localQuery(volume));
    for (let v = 0; v < mesh.opaque.materialIds.length; v++) {
      expect([GRASS, STONE]).toContain(mesh.opaque.materialIds[v]);
    }
    // Grass's +X face is culled by the stone neighbor: 5 faces × 4 verts.
    const grassVerts = mesh.opaque.materialIds.filter((id) => id === GRASS).length;
    expect(grassVerts).toBe(5 * 4);
    const stoneVerts = mesh.opaque.materialIds.filter((id) => id === STONE).length;
    expect(stoneVerts).toBe(5 * 4);
  });

  it('produces indices referencing valid vertices in quad pattern', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, STONE);
    volume.set(1, 2, 1, STONE);
    const mesh = meshVolume(volume, localQuery(volume));
    const { indices, positions, quadCount } = mesh.opaque;
    expect(indices.length).toBe(quadCount * 6);
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBeLessThan(positions.length / 3);
    }
    for (let quad = 0; quad < quadCount; quad++) {
      const b = quad * 6;
      expect(indices[b]).toBe(quad * 4);
      expect(indices[b + 1]).toBe(quad * 4 + 1);
      expect(indices[b + 2]).toBe(quad * 4 + 2);
      expect(indices[b + 3]).toBe(quad * 4 + 2);
      expect(indices[b + 4]).toBe(quad * 4 + 1);
      expect(indices[b + 5]).toBe(quad * 4 + 3);
    }
  });

  it('meshes a fully solid 16³ volume to its hull only', () => {
    const volume = new VoxelVolume(16);
    volume.fill(STONE);
    const mesh = meshVolume(volume, localQuery(volume));
    expect(mesh.opaque.quadCount).toBe(6 * 256);
    expect(volume.getOrAir(-1, 0, 0)).toBe(AIR);
  });
});
