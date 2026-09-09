import type { VoxelData } from './voxelVolume';
import { AIR, WATER, isOpaque, type VoxelMaterialID } from './materials';
import type { ChunkMesh, MeshData, VoxelQuery } from './mesher';

/**
 * Greedy culled-face mesher (Phase 6): identical face set and winding to
 * the naive `meshVolume` baseline, but coplanar unit faces that share a
 * material and facing merge into maximal rectangles — far fewer quads
 * for terrain-like volumes (see docs/performance.md for the measured
 * gap).
 *
 * Per-axis sweep (d = sweep axis, u/v the in-plane axes): each slice
 * boundary builds a mask of visible faces (which cell emits toward
 * which neighbor, same emission rules as the naive mesher), then the
 * mask is greedily partitioned into maximal same-signature rectangles.
 * Emission rules:
 * - opaque voxel: emits a face iff the neighbor is NOT opaque (air or
 *   water) — underwater terrain stays visible through the water.
 * - water: emits a face iff the neighbor is air.
 *
 * Per-voxel brightness variation is preserved without a voxelOrigin
 * attribute: the voxel shader derives the voxel cell from the fragment's
 * world position, so merged quads still shade per-voxel.
 */

/** True if `m` shows a face against `neighbor` (naive-mesher rules). */
function emits(m: VoxelMaterialID, neighbor: VoxelMaterialID): boolean {
  if (m === AIR) return false;
  return m === WATER ? neighbor === AIR : !isOpaque(neighbor);
}

/** Growable Float32 buffer for 3-component attributes (positions/normals). */
class FloatBuf {
  private buf: Float32Array;
  private len = 0;

  constructor(capacity = 1024) {
    this.buf = new Float32Array(capacity);
  }

  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.buf.length) this.grow();
    this.buf[this.len++] = a;
    this.buf[this.len++] = b;
    this.buf[this.len++] = c;
  }

  get length(): number {
    return this.len;
  }

  toTypedArray(): Float32Array {
    return this.buf.slice(0, this.len);
  }

  private grow(): void {
    const next = new Float32Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
}

/** Growable typed buffer for 1-component attributes. */
class ValueBuf<T extends Uint16Array | Uint32Array> {
  private buf: T;
  private len = 0;
  private readonly make: new (n: number) => T;

  constructor(initial: T) {
    this.buf = initial;
    this.make = initial.constructor as new (n: number) => T;
  }

  push(v: number): void {
    if (this.len + 1 > this.buf.length) this.grow();
    this.buf[this.len++] = v;
  }

  /** Append several values (quad indices). */
  pushAll(...values: number[]): void {
    if (this.len + values.length > this.buf.length) this.grow();
    for (const v of values) this.buf[this.len++] = v;
  }

  get length(): number {
    return this.len;
  }

  toTypedArray(): T {
    return this.buf.slice(0, this.len) as T;
  }

  private grow(): void {
    const next = new this.make(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
}

/** Extract an outward-facing culled mesh, merging coplanar faces. */
export function meshVolumeGreedy(volume: VoxelData, query: VoxelQuery): ChunkMesh {
  const size = volume.size;
  const voxelAt: VoxelQuery = (x, y, z) =>
    volume.inBounds(x, y, z) ? volume.get(x, y, z) : query(x, y, z);

  const opaque = {
    positions: new FloatBuf(),
    normals: new FloatBuf(),
    materialIds: new ValueBuf<Uint16Array>(new Uint16Array(256)),
    indices: new ValueBuf<Uint32Array>(new Uint32Array(256)),
  };
  const water = {
    positions: new FloatBuf(),
    normals: new FloatBuf(),
    materialIds: new ValueBuf<Uint16Array>(new Uint16Array(64)),
    indices: new ValueBuf<Uint32Array>(new Uint32Array(64)),
  };

  // Reused per-slice face masks: which material emits at this in-plane
  // cell, toward +d (1) or -d (-1); 0 = no face (AIR is id 0, so the
  // sentinel doubles as the air material value).
  const maskMaterial = new Int16Array(size * size);
  const maskDir = new Int8Array(size * size);

  const x = [0, 0, 0];
  const q = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    q[0] = q[1] = q[2] = 0;
    q[d] = 1;

    for (x[d] = -1; x[d] < size; x[d]++) {
      // 1. Build the face mask for the boundary between slices
      //    x[d] and x[d]+1 (out-of-range cells read through `query`).
      //    Only cells INSIDE the volume may emit: an outside cell's face
      //    belongs to the neighbor chunk's mesh.
      const aInside = x[d] >= 0;
      const bInside = x[d] < size - 1;
      let n = 0;
      for (x[v] = 0; x[v] < size; x[v]++) {
        for (x[u] = 0; x[u] < size; x[u]++, n++) {
          const a = voxelAt(x[0], x[1], x[2]);
          const b = voxelAt(x[0] + q[0], x[1] + q[1], x[2] + q[2]);
          if (aInside && emits(a, b)) {
            maskMaterial[n] = a;
            maskDir[n] = 1;
          } else if (bInside && emits(b, a)) {
            maskMaterial[n] = b;
            maskDir[n] = -1;
          } else {
            maskMaterial[n] = 0;
            maskDir[n] = 0;
          }
        }
      }

      // 2. Greedily merge the mask into maximal rectangles.
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; ) {
          const idx = j * size + i;
          const material = maskMaterial[idx];
          if (material === 0) {
            i++;
            continue;
          }
          const dir = maskDir[idx];

          let width = 1;
          while (
            i + width < size &&
            maskMaterial[idx + width] === material &&
            maskDir[idx + width] === dir
          ) {
            width++;
          }
          let height = 1;
          grow: while (j + height < size) {
            for (let k = 0; k < width; k++) {
              const below = (j + height) * size + i + k;
              if (maskMaterial[below] !== material || maskDir[below] !== dir) break grow;
            }
            height++;
          }

          emitQuad(
            material === WATER ? water : opaque,
            d,
            u,
            v,
            x[d] + 1,
            i,
            j,
            width,
            height,
            dir,
            material,
          );

          for (let l = 0; l < height; l++) {
            for (let k = 0; k < width; k++) maskMaterial[(j + l) * size + i + k] = 0;
          }
          i += width;
        }
      }
    }
  }

  return { opaque: toMeshData(opaque), water: toMeshData(water) };
}

/**
 * Emit one merged quad. The face plane sits at `plane` along axis d;
 * the rectangle spans [i, i+width) along u and [j, j+height) along v.
 * Winding (CCW from outside): u × v = d holds for the cyclic axis
 * assignment u = (d+1)%3, v = (d+2)%3, so +d faces use (c0,c1,c2)
 * and -d faces swap to (c0,c2,c1).
 */
function emitQuad(
  buffers: {
    positions: FloatBuf;
    normals: FloatBuf;
    materialIds: ValueBuf<Uint16Array>;
    indices: ValueBuf<Uint32Array>;
  },
  d: number,
  u: number,
  v: number,
  plane: number,
  i: number,
  j: number,
  width: number,
  height: number,
  dir: number,
  material: VoxelMaterialID,
): void {
  const c0 = [0, 0, 0];
  const c1 = [0, 0, 0];
  const c2 = [0, 0, 0];
  const c3 = [0, 0, 0];
  c0[d] = c1[d] = c2[d] = c3[d] = plane;
  // Rectangle [i, i+width) × [j, j+height) in the u/v plane:
  // c0 = (i,j), c1 = (i+w, j), c2 = (i, j+h), c3 = (i+w, j+h), so
  // (c1−c0) × (c2−c0) = w·h·(u × v) = +d and +d faces wind CCW.
  c0[v] = c1[v] = j;
  c2[v] = c3[v] = j + height;
  c0[u] = c2[u] = i;
  c1[u] = c3[u] = i + width;

  const normal: number[] = [0, 0, 0];
  normal[d] = dir;

  // One index pattern serves both facings: for -d the reordered corner
  // list reverses the winding of both triangles.
  const base = buffers.materialIds.length;
  const corners = dir > 0 ? [c0, c1, c2, c3] : [c0, c2, c1, c3];
  for (const [cx, cy, cz] of corners) {
    buffers.positions.push3(cx, cy, cz);
    buffers.normals.push3(normal[0], normal[1], normal[2]);
    buffers.materialIds.push(material);
  }
  buffers.indices.pushAll(base, base + 1, base + 2, base + 2, base + 1, base + 3);
}

function toMeshData(buffers: {
  positions: FloatBuf;
  normals: FloatBuf;
  materialIds: ValueBuf<Uint16Array>;
  indices: ValueBuf<Uint32Array>;
}): MeshData {
  return {
    positions: buffers.positions.toTypedArray(),
    normals: buffers.normals.toTypedArray(),
    materialIds: buffers.materialIds.toTypedArray(),
    indices: buffers.indices.toTypedArray(),
    quadCount: buffers.materialIds.length / 4,
  };
}
