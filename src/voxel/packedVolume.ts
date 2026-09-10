import { AIR, type VoxelMaterialID } from './materials';
import { OccupancyGrid } from './occupancy';
import type { VoxelData } from './voxelVolume';

/**
 * Palette-compressed cubic volume (Phase 6): a per-volume list of the
 * materials actually present plus bit-packed palette indices, with an
 * occupancy grid for O(1) air tests and empty-volume checks.
 *
 * Same contract as dense `VoxelVolume` (both satisfy `VoxelData`):
 * y-major index layout, `get` throws OOB, `getOrAir` reads air outside,
 * `set`/`setByIndex` report OOB writes as false.
 *
 * Growth policy: indices start at 1 bit and widen (1→2→4) when a new
 * material joins a full palette; the 5th distinct material forces 4 bits
 * (15 more slots). If a volume ever holds more than 16 distinct materials
 * the palette is rebuilt at 8 bits; beyond 256 the caller has left the
 * design envelope (see docs/voxel-storage.md) and construction throws —
 * dense storage is the fallback representation at that scale.
 *
 * Memory: 16³ dense = 8192 B; a one-material chunk packs to
 * 512 B (occupancy) + 32 B (words) + palette.
 */
export class PackedVolume implements VoxelData {
  readonly size: number;
  readonly voxelCount: number;

  private palette: Uint16Array = new Uint16Array(0);
  private bits = 0; // 0 → provably all air (no palette yet)
  private perWord = 0; // voxels per Uint32 (no word straddling)
  private mask = 0;
  private data = new Uint32Array(0);
  private readonly occupancy: OccupancyGrid;

  constructor(size: number) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`PackedVolume size must be a positive integer, got ${size}`);
    }
    this.size = size;
    this.voxelCount = size * size * size;
    this.occupancy = new OccupancyGrid(this.voxelCount);
  }

  /** Distinct non-... materials currently in the palette. */
  get paletteSize(): number {
    return this.palette.length;
  }

  /** Bytes held by the packed payload + occupancy (for benchmarks). */
  get memoryBytes(): number {
    return this.data.byteLength + this.occupancyWordsBytes();
  }

  private occupancyWordsBytes(): number {
    // Exposed for benchmarks without reaching into the grid.
    return Math.ceil(this.voxelCount / 32) * 4;
  }

  index(x: number, y: number, z: number): number {
    return x + z * this.size + y * this.size * this.size;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && z >= 0 && z < this.size;
  }

  get(x: number, y: number, z: number): VoxelMaterialID {
    this.assertInBounds(x, y, z);
    return this.getByIndex(this.index(x, y, z));
  }

  getOrAir(x: number, y: number, z: number): VoxelMaterialID {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.getByIndex(this.index(x, y, z));
  }

  set(x: number, y: number, z: number, material: VoxelMaterialID): boolean {
    if (!this.inBounds(x, y, z)) return false;
    this.setByIndex(this.index(x, y, z), material);
    return true;
  }

  getByIndex(index: number): VoxelMaterialID {
    this.assertIndexInBounds(index);
    if (this.bits === 0) return AIR;
    if (!this.occupancy.get(index)) return AIR;
    const entry =
      (this.data[(index / this.perWord) | 0] >>> ((index % this.perWord) * this.bits)) & this.mask;
    return this.palette[entry];
  }

  setByIndex(index: number, material: VoxelMaterialID): boolean {
    if (index < 0 || index >= this.voxelCount) return false;
    if (material === AIR) {
      if (this.bits === 0 || !this.occupancy.get(index)) return true; // already air
      // Air is a palette entry like any other; keep the entry, drop the bit.
      this.occupancy.clear(index);
      return true;
    }
    if (this.bits === 0) this.initializePalette(material);
    const entry = this.palette.indexOf(material);
    const resolved = entry === -1 ? this.admitMaterial(material) : entry;

    const word = (index / this.perWord) | 0;
    const shift = (index % this.perWord) * this.bits;
    this.data[word] = (this.data[word] & ~(this.mask << shift)) | (resolved << shift);
    this.occupancy.set(index);
    return true;
  }

  fill(material: VoxelMaterialID): void {
    for (let i = 0; i < this.voxelCount; i++) this.setByIndex(i, material);
  }

  /** First non-air write: create a 1-bit palette with this material. */
  private initializePalette(material: VoxelMaterialID): void {
    this.palette = new Uint16Array([material]);
    this.bits = 1;
    this.perWord = 32;
    this.mask = 1;
    this.data = new Uint32Array(Math.ceil(this.voxelCount / this.perWord));
  }

  /** Add a material to the palette, widening/rebuilding when full. */
  private admitMaterial(material: VoxelMaterialID): number {
    const newSize = this.palette.length + 1;
    const requiredBits = bitsForPalette(newSize);
    if (requiredBits > this.bits) this.repack(requiredBits);
    const entry = this.palette.length;
    const grown = new Uint16Array(newSize);
    grown.set(this.palette);
    grown[entry] = material;
    this.palette = grown;
    return entry;
  }

  /** Rebuild the payload at a wider bit width, re-encoding every voxel. */
  private repack(newBits: number): void {
    const oldBits = this.bits;
    const oldPerWord = this.perWord;
    const oldData = this.data;
    const oldMask = this.mask;

    this.bits = newBits;
    this.perWord = Math.floor(32 / newBits);
    this.mask = (1 << newBits) - 1;
    this.data = new Uint32Array(Math.ceil(this.voxelCount / this.perWord));

    if (oldBits === 0) return;
    for (let i = 0; i < this.voxelCount; i++) {
      if (!this.occupancy.get(i)) continue;
      const entry = (oldData[(i / oldPerWord) | 0] >>> ((i % oldPerWord) * oldBits)) & oldMask;
      this.data[(i / this.perWord) | 0] |= entry << ((i % this.perWord) * this.bits);
    }
  }

  private assertInBounds(x: number, y: number, z: number): void {
    if (!this.inBounds(x, y, z)) {
      throw new RangeError(
        `Voxel coordinates out of bounds: (${x}, ${y}, ${z}) for size ${this.size}`,
      );
    }
  }

  private assertIndexInBounds(index: number): void {
    if (index < 0 || index >= this.voxelCount) {
      throw new RangeError(`Voxel index out of bounds: ${index} for ${this.voxelCount} voxels`);
    }
  }
}

/** Smallest of {1, 2, 4, 8} bits that holds `size` palette entries. */
function bitsForPalette(size: number): number {
  if (size <= 2) return 1;
  if (size <= 4) return 2;
  if (size <= 16) return 4;
  if (size <= 256) return 8;
  throw new RangeError(
    `PackedVolume supports at most 256 distinct materials, tried to admit ${size}`,
  );
}
