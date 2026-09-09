import { describe, expect, it } from 'vitest';
import { raycastVoxels, isNotAir } from '../src/voxel/raycast';
import { AIR, STONE, WATER, type VoxelMaterialID } from '../src/voxel/materials';
import { VoxelVolume } from '../src/voxel/voxelVolume';

/** Volume-based query; OOB reads air (mirrors World.getVoxel policy). */
function queryFrom(volume: VoxelVolume) {
  return (x: number, y: number, z: number) => volume.getOrAir(x, y, z);
}

describe('raycastVoxels', () => {
  it('hits the first non-air cell along +Z and reports its entry face', () => {
    const volume = new VoxelVolume(4);
    volume.set(2, 2, 3, STONE);
    const hit = raycastVoxels(
      { origin: { x: 2.5, y: 2.5, z: -2 }, direction: { x: 0, y: 0, z: 1 } },
      10,
      queryFrom(volume),
    );
    expect(hit).toBeDefined();
    expect(hit!.voxel).toEqual({ x: 2, y: 2, z: 3 });
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: -1 });
    expect(hit!.distance).toBeCloseTo(5, 6); // enters z=3 plane from z=-2
    expect(hit!.point.z).toBeCloseTo(3, 6);
    expect(hit!.material).toBe(STONE);
  });

  it('walks through air and stops at the nearest hit', () => {
    const volume = new VoxelVolume(8);
    volume.set(1, 1, 1, STONE);
    volume.set(1, 1, 4, STONE);
    const hit = raycastVoxels(
      { origin: { x: 1.5, y: 1.5, z: -3 }, direction: { x: 0, y: 0, z: 1 } },
      30,
      queryFrom(volume),
    );
    expect(hit!.voxel).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('returns undefined when nothing is within max distance', () => {
    const volume = new VoxelVolume(8);
    volume.set(1, 1, 6, STONE);
    const hit = raycastVoxels(
      { origin: { x: 1.5, y: 1.5, z: -3 }, direction: { x: 0, y: 0, z: 1 } },
      5,
      queryFrom(volume),
    );
    expect(hit).toBeUndefined();
  });

  it('returns undefined for a zero-length direction', () => {
    const volume = new VoxelVolume(4);
    const hit = raycastVoxels(
      { origin: { x: 0.5, y: 0.5, z: 0.5 }, direction: { x: 0, y: 0, z: 0 } },
      10,
      queryFrom(volume),
    );
    expect(hit).toBeUndefined();
  });

  it('handles a ray starting inside a solid cell with a zero normal', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, STONE);
    const hit = raycastVoxels(
      { origin: { x: 1.5, y: 1.5, z: 1.5 }, direction: { x: 1, y: 0, z: 0 } },
      10,
      queryFrom(volume),
    );
    expect(hit!.voxel).toEqual({ x: 1, y: 1, z: 1 });
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 0 });
    expect(hit!.distance).toBe(0);
  });

  it('traverses diagonally, entering each cell through the shared face', () => {
    const volume = new VoxelVolume(8);
    volume.set(2, 2, 0, STONE);
    const hit = raycastVoxels(
      { origin: { x: 0.5, y: 0.5, z: 0.5 }, direction: { x: 1, y: 1, z: 0 } },
      30,
      queryFrom(volume),
    );
    // Cell path (0,0,0) → (1,0,0) → (1,1,0) → (2,1,0) → (2,2,0): the x
    // and y crossings of the "2" boundary tie; x goes first, so (2,2,0)
    // is entered through its -Y face at t = 1.5·√2.
    expect(hit!.voxel).toEqual({ x: 2, y: 2, z: 0 });
    expect(hit!.normal).toEqual({ x: 0, y: -1, z: 0 });
    expect(hit!.distance).toBeCloseTo(1.5 * Math.SQRT2, 6);
  });

  it('works with negative world coordinates', () => {
    const worldCells = new Set<string>(['-1,0,-3']);
    const query = (x: number, y: number, z: number): VoxelMaterialID =>
      worldCells.has(`${x},${y},${z}`) ? STONE : AIR;
    const hit = raycastVoxels(
      { origin: { x: -0.5, y: 0.5, z: -0.5 }, direction: { x: 0, y: 0, z: -1 } },
      20,
      query,
    );
    // Start cell is (−1,0,−1); crossing z=−1 enters (−1,0,−2) at t=0.5,
    // crossing z=−2 enters (−1,0,−3) at t=1.5.
    expect(hit!.voxel).toEqual({ x: -1, y: 0, z: -3 });
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(hit!.distance).toBeCloseTo(1.5, 6);
    expect(hit!.point.z).toBeCloseTo(-2, 6);
  });

  it('honors the predicate: water is skipped when not targetable', () => {
    const volume = new VoxelVolume(8);
    volume.set(1, 1, 1, WATER);
    volume.set(1, 1, 3, STONE);
    const query = queryFrom(volume);
    const editTargetable = (m: VoxelMaterialID) => m !== AIR && m !== WATER;

    const throughWater = raycastVoxels(
      { origin: { x: 1.5, y: 1.5, z: -2 }, direction: { x: 0, y: 0, z: 1 } },
      20,
      query,
      editTargetable,
    );
    expect(throughWater!.voxel).toEqual({ x: 1, y: 1, z: 3 });

    const defaultHit = raycastVoxels(
      { origin: { x: 1.5, y: 1.5, z: -2 }, direction: { x: 0, y: 0, z: 1 } },
      20,
      query,
      isNotAir,
    );
    expect(defaultHit!.voxel).toEqual({ x: 1, y: 1, z: 1 });
    expect(defaultHit!.material).toBe(WATER);
  });

  it('normalizes a non-unit direction before traversal', () => {
    const volume = new VoxelVolume(8);
    volume.set(0, 0, 3, STONE);
    const hit = raycastVoxels(
      { origin: { x: 0.5, y: 0.5, z: -0.5 }, direction: { x: 0, y: 0, z: 7 } },
      10,
      queryFrom(volume),
    );
    expect(hit!.voxel).toEqual({ x: 0, y: 0, z: 3 });
    // Start cell is (0,0,−1); entering (0,0,3) crosses z=3 at t=3.5
    // world units even though the raw direction had length 7.
    expect(hit!.distance).toBeCloseTo(3.5, 6);
  });
});
