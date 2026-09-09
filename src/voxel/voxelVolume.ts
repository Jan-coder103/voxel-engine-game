import { AIR, type VoxelMaterialID } from './materials';

/**
 * The storage-agnostic voxel surface: dense `VoxelVolume` and the
 * palette-compressed `PackedVolume` both satisfy it, so the world,
 * mesher, and collision code never care which one backs a chunk.
 */
export interface VoxelData {
  readonly size: number;
  readonly voxelCount: number;
  /** Flat index for in-bounds local coordinates. */
  index(x: number, y: number, z: number): number;
  inBounds(x: number, y: number, z: number): boolean;
  /** Read a voxel. Throws if out of bounds — use `getOrAir` at world edges. */
  get(x: number, y: number, z: number): VoxelMaterialID;
  /** Read a voxel, treating out-of-bounds as air. */
  getOrAir(x: number, y: number, z: number): VoxelMaterialID;
  /** Write a voxel. Returns false (and writes nothing) if out of bounds. */
  set(x: number, y: number, z: number, material: VoxelMaterialID): boolean;
  /** Read by flat index (`index(x, y, z)` layout). Throws on bad index. */
  getByIndex(index: number): VoxelMaterialID;
  /** Write by flat index. Returns false (and writes nothing) on bad index. */
  setByIndex(index: number, material: VoxelMaterialID): boolean;
  /** Fill the whole volume with one material. */
  fill(material: VoxelMaterialID): void;
}

/**
 * Dense cubic voxel volume backed by a flat Uint16Array.
 *
 * Index layout is y-major: `index = x + z * size + y * size * size`, so a
 * horizontal layer is contiguous — friendly for terrain generation and
 * top-down iteration.
 *
 * Bounds policy:
 * - `get` throws on out-of-bounds (programmer error inside the volume).
 * - `getOrAir` treats everything outside as air (world-facing queries:
 *   mesher culling, collision) so callers need no special cases.
 * - `set` reports out-of-bounds writes by returning `false`.
 */
export class VoxelVolume implements VoxelData {
  readonly size: number;
  private readonly data: Uint16Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`VoxelVolume size must be a positive integer, got ${size}`);
    }
    this.size = size;
    this.data = new Uint16Array(size * size * size);
  }

  get voxelCount(): number {
    return this.data.length;
  }

  /** Flat index for in-bounds local coordinates. */
  index(x: number, y: number, z: number): number {
    return x + z * this.size + y * this.size * this.size;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && z >= 0 && z < this.size;
  }

  /** Read a voxel. Throws if out of bounds — use `getOrAir` at world edges. */
  get(x: number, y: number, z: number): VoxelMaterialID {
    this.assertInBounds(x, y, z);
    return this.data[this.index(x, y, z)];
  }

  /** Read a voxel, treating out-of-bounds as air. */
  getOrAir(x: number, y: number, z: number): VoxelMaterialID {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.data[this.index(x, y, z)];
  }

  /** Write a voxel. Returns false (and writes nothing) if out of bounds. */
  set(x: number, y: number, z: number, material: VoxelMaterialID): boolean {
    if (!this.inBounds(x, y, z)) return false;
    this.data[this.index(x, y, z)] = material;
    return true;
  }

  /** Read by flat index (`index(x, y, z)` layout). Throws on bad index. */
  getByIndex(index: number): VoxelMaterialID {
    this.assertIndexInBounds(index);
    return this.data[index];
  }

  /** Write by flat index. Returns false (and writes nothing) on bad index. */
  setByIndex(index: number, material: VoxelMaterialID): boolean {
    if (index < 0 || index >= this.data.length) return false;
    this.data[index] = material;
    return true;
  }

  /** Fill the whole volume with one material. */
  fill(material: VoxelMaterialID): void {
    this.data.fill(material);
  }

  private assertInBounds(x: number, y: number, z: number): void {
    if (!this.inBounds(x, y, z)) {
      throw new RangeError(
        `Voxel coordinates out of bounds: (${x}, ${y}, ${z}) for size ${this.size}`,
      );
    }
  }

  private assertIndexInBounds(index: number): void {
    if (index < 0 || index >= this.data.length) {
      throw new RangeError(`Voxel index out of bounds: ${index} for ${this.data.length} voxels`);
    }
  }
}
