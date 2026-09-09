/**
 * Occupancy bitset over a cubic voxel grid: one bit per voxel, set when
 * the voxel holds a non-air material. Pure bookkeeping with no material
 * knowledge — callers keep it in sync with their storage.
 *
 * Value: O(1) "is anything here" tests (empty-chunk skip in the mesher,
 * air fast-paths in reads) at 1/8 byte per voxel, vs. 2 bytes for the
 * dense Uint16 value.
 */
export class OccupancyGrid {
  readonly voxelCount: number;
  private readonly words: Uint32Array;
  private setCount = 0;

  constructor(voxelCount: number) {
    this.voxelCount = voxelCount;
    this.words = new Uint32Array(Math.ceil(voxelCount / 32));
  }

  get size(): number {
    return this.setCount;
  }

  /** True when no voxel is set — O(1) via the maintained counter. */
  get isEmpty(): boolean {
    return this.setCount === 0;
  }

  get(index: number): boolean {
    return (this.words[index >>> 5] & (1 << (index & 31))) !== 0;
  }

  /** Returns true if this call changed the bit (was clear, now set). */
  set(index: number): boolean {
    const word = index >>> 5;
    const mask = 1 << (index & 31);
    if ((this.words[word] & mask) !== 0) return false;
    this.words[word] |= mask;
    this.setCount++;
    return true;
  }

  /** Returns true if this call changed the bit (was set, now clear). */
  clear(index: number): boolean {
    const word = index >>> 5;
    const mask = 1 << (index & 31);
    if ((this.words[word] & mask) === 0) return false;
    this.words[word] &= ~mask;
    this.setCount--;
    return true;
  }
}
