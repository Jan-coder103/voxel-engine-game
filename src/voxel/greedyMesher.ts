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
 *
 * Water flow height (Phase 9): the optional `waterLevel` query reports a
 * cell's fluid level (0–255). A water cell with air above (a surface
 * cell) emits its quads with a `waterDrop` vertex attribute — the
 * distance its top corners sink, `(255 − level) / 255` — which the water
 * shader subtracts from Y. Drop is part of the merge signature, so quads
 * never mix heights; submerged cells (no air above) merge at full height
 * exactly as before, keeping lakes cheap. The emitted face SET is
 * unchanged (positions stay unit-cube); the attribute is additive, which
 * keeps the greedy↔naive equivalence tests meaningful.
 *
 * Light + ambient occlusion (Phase 17): the optional `light` query
 * reports a cell's packed light (`sky << 4 | block`) and each face
 * samples it at the cell the face looks into — light is part of the
 * merge signature, so quads never smear bright into dark. Each quad
 * corner also gets a classic 3-sample vertex AO (two edge neighbors +
 * the diagonal in the face plane, around that corner's air cell), so
 * corners darken where geometry folds. AO is sampled per quad corner,
 * not per unit face — merging stays maximal and open terrain (uniform
 * light, uniform AO) still merges into huge quads. Both attributes are
 * additive outputs; the face set is unchanged.
 */

/** True if `m` shows a face against `neighbor` (naive-mesher rules). */
function emits(m: VoxelMaterialID, neighbor: VoxelMaterialID): boolean {
  if (m === AIR) return false;
  return m === WATER ? neighbor === AIR : !isOpaque(neighbor);
}

/**
 * Merge-signature bits for water faces: bit 13 = surfaced (air above,
 * partial level), bits 5–12 = level, bits 0–4 = the emitting cell's y.
 * A surfaced PARTIAL cell carries its height so surface rows at different
 * elevations never merge into one quad (each needs its own drop height);
 * full cells (level 255 or no level query) and submerged cells return 0
 * and merge freely at full height — lakes stay cheap.
 */
const AUX_SURFACED = 1 << 13;

function waterAux(level: number, cellY: number, surfaced: boolean): number {
  if (!surfaced || level >= 255 || level <= 0) return 0;
  return AUX_SURFACED | (level << 5) | cellY;
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

  push2(a: number, b: number): void {
    if (this.len + 2 > this.buf.length) this.grow();
    this.buf[this.len++] = a;
    this.buf[this.len++] = b;
  }

  push(v: number): void {
    if (this.len + 1 > this.buf.length) this.grow();
    this.buf[this.len++] = v;
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

// Scratch for vertexAO (module-level to keep the hot loop alloc-free).
const p1 = [0, 0, 0];
const p2 = [0, 0, 0];
const p3 = [0, 0, 0];

/** Classic 3-sample vertex AO: occupancy of the two edge neighbors and
 * the diagonal around the air cell (the cell the face looks into),
 * offset one step along u/v toward the corner. 3 = open corner, 0 = a
 * fully folded corner (both edges solid). */
function vertexAO(
  voxelAt: VoxelQuery,
  air: number[],
  u: number,
  v: number,
  su: number,
  sv: number,
): number {
  p1[0] = p2[0] = p3[0] = air[0];
  p1[1] = p2[1] = p3[1] = air[1];
  p1[2] = p2[2] = p3[2] = air[2];
  p1[u] += su;
  p2[v] += sv;
  p3[u] += su;
  p3[v] += sv;
  const side1 = isOpaque(voxelAt(p1[0], p1[1], p1[2])) ? 1 : 0;
  const side2 = isOpaque(voxelAt(p2[0], p2[1], p2[2])) ? 1 : 0;
  const corner = isOpaque(voxelAt(p3[0], p3[1], p3[2])) ? 1 : 0;
  return side1 !== 0 && side2 !== 0 ? 0 : 3 - (side1 + side2 + corner);
}

/** Extract an outward-facing culled mesh, merging coplanar faces. */
export function meshVolumeGreedy(
  volume: VoxelData,
  query: VoxelQuery,
  waterLevel?: (x: number, y: number, z: number) => number,
  light?: (x: number, y: number, z: number) => number,
): ChunkMesh {
  const size = volume.size;
  const voxelAt: VoxelQuery = (x, y, z) =>
    volume.inBounds(x, y, z) ? volume.get(x, y, z) : query(x, y, z);

  const opaque = {
    positions: new FloatBuf(),
    normals: new FloatBuf(),
    materialIds: new ValueBuf<Uint16Array>(new Uint16Array(256)),
    indices: new ValueBuf<Uint32Array>(new Uint32Array(256)),
    light: new FloatBuf(),
    ao: new FloatBuf(),
  };
  const water = {
    positions: new FloatBuf(),
    normals: new FloatBuf(),
    materialIds: new ValueBuf<Uint16Array>(new Uint16Array(64)),
    indices: new ValueBuf<Uint32Array>(new Uint32Array(64)),
    drops: new FloatBuf(),
    light: new FloatBuf(),
  };

  // Reused per-slice face masks: which material emits at this in-plane
  // cell, toward +d (1) or -d (-1), plus the water merge signature
  // (0 for opaque faces and submerged water) and the packed light of the
  // cell the face looks into (0 when no light query); 0 material = no
  // face (AIR is id 0, so the sentinel doubles as the air material value).
  const maskMaterial = new Int16Array(size * size);
  const maskDir = new Int8Array(size * size);
  const maskAux = new Int16Array(size * size);
  const maskLight = new Int16Array(size * size);

  const x = [0, 0, 0];
  const q = [0, 0, 0];
  const air = [0, 0, 0];
  const ao = [0, 0, 0, 0];

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
            maskAux[n] = faceAux(a, x[0], x[1], x[2], voxelAt, waterLevel);
            if (light) {
              air[0] = x[0] + q[0];
              air[1] = x[1] + q[1];
              air[2] = x[2] + q[2];
              maskLight[n] = light(air[0], air[1], air[2]);
            }
          } else if (bInside && emits(b, a)) {
            maskMaterial[n] = b;
            maskDir[n] = -1;
            maskAux[n] = faceAux(b, x[0] + q[0], x[1] + q[1], x[2] + q[2], voxelAt, waterLevel);
            if (light) {
              air[0] = x[0];
              air[1] = x[1];
              air[2] = x[2];
              maskLight[n] = light(air[0], air[1], air[2]);
            }
          } else {
            maskMaterial[n] = 0;
            maskDir[n] = 0;
            maskAux[n] = 0;
            if (light) maskLight[n] = 0;
          }
        }
      }

      // 2. Greedily merge the mask into maximal rectangles.
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size;) {
          const idx = j * size + i;
          const material = maskMaterial[idx];
          if (material === 0) {
            i++;
            continue;
          }
          const dir = maskDir[idx];
          const aux = maskAux[idx];
          const faceLight = light ? maskLight[idx] : -1;

          let width = 1;
          while (
            i + width < size &&
            maskMaterial[idx + width] === material &&
            maskDir[idx + width] === dir &&
            maskAux[idx + width] === aux &&
            (!light || maskLight[idx + width] === faceLight)
          ) {
            width++;
          }
          let height = 1;
          grow: while (j + height < size) {
            for (let k = 0; k < width; k++) {
              const below = (j + height) * size + i + k;
              if (
                maskMaterial[below] !== material ||
                maskDir[below] !== dir ||
                maskAux[below] !== aux ||
                (light && maskLight[below] !== faceLight)
              ) {
                break grow;
              }
            }
            height++;
          }

          // Per-corner vertex AO around each corner's own air cell
          // (opaque pass only — water shades uniformly). Corners in the
          // same order emitQuad pushes them: c0, c1, c2, c3.
          let hasAO = false;
          if (light && material !== WATER) {
            hasAO = true;
            air[d] = dir > 0 ? x[d] + 1 : x[d];
            for (let ci = 0; ci < 4; ci++) {
              const highU = ci === 1 || ci === 3;
              const highV = ci >= 2;
              air[u] = i + (highU ? width - 1 : 0);
              air[v] = j + (highV ? height - 1 : 0);
              ao[ci] = vertexAO(voxelAt, air, u, v, highU ? 1 : -1, highV ? 1 : -1);
            }
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
            aux,
            faceLight,
            hasAO ? ao : undefined,
          );

          for (let l = 0; l < height; l++) {
            for (let k = 0; k < width; k++) maskMaterial[(j + l) * size + i + k] = 0;
          }
          i += width;
        }
      }
    }
  }

  if (!light) {
    return {
      opaque: toMeshData(opaque),
      water: toMeshData(water, (buffers) => (buffers as typeof water).drops.toTypedArray()),
    };
  }
  return {
    opaque: toMeshData(opaque, undefined, true),
    water: toMeshData(water, (buffers) => (buffers as typeof water).drops.toTypedArray(), true),
  };
}

/** Water merge signature for the face emitted by the cell at (cx,cy,cz). */
function faceAux(
  material: VoxelMaterialID,
  cx: number,
  cy: number,
  cz: number,
  voxelAt: VoxelQuery,
  waterLevel: ((x: number, y: number, z: number) => number) | undefined,
): number {
  if (material !== WATER || !waterLevel) return 0;
  return waterAux(waterLevel(cx, cy, cz), cy, voxelAt(cx, cy + 1, cz) === AIR);
}

/**
 * Emit one merged quad. The face plane sits at `plane` along axis d;
 * the rectangle spans [i, i+width) along u and [j, j+height) along v.
 * Winding (CCW from outside): u × v = d holds for the cyclic axis
 * assignment u = (d+1)%3, v = (d+2)%3, so +d faces use (c0,c1,c2)
 * and -d faces swap to (c0,c2,c1).
 *
 * `aux` carries the water flow signature (0 for opaque). For surfaced
 * water the quad's top-edge vertices get a `waterDrop` of
 * (255 − level) / 255 — the shader sinks them — except on −Y faces
 * (undersides stay square). Merged quads share one signature, so every
 * dropped vertex sinks by the same amount.
 *
 * `faceLight` is the packed light (`sky << 4 | block`, −1 = no query) of
 * the cell the face looks into, identical across the merged quad — every
 * vertex gets the same unpacked `aLight` pair. `ao` carries the four
 * corner AO levels (0–3, c0/c1/c2/c3 order); vertices receive them in
 * the emitted corner order (the −d facing swaps c1/c2) as `aAO`.
 */
function emitQuad(
  buffers: {
    positions: FloatBuf;
    normals: FloatBuf;
    materialIds: ValueBuf<Uint16Array>;
    indices: ValueBuf<Uint32Array>;
    drops?: FloatBuf;
    light?: FloatBuf;
    ao?: FloatBuf;
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
  aux = 0,
  faceLight = -1,
  ao?: number[],
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

  let drop = 0;
  if (material === WATER && aux !== 0 && !(d === 1 && dir < 0)) {
    // Mask off the surfaced flag; bits 5–12 hold the level.
    drop = (255 - ((aux >> 5) & 0xff)) / 255;
  }
  const topY = Math.max(c0[1], c1[1], c2[1], c3[1]);

  // One index pattern serves both facings: for -d the reordered corner
  // list reverses the winding of both triangles. AO follows the same
  // reordering (c0/c1/c2/c3 levels → emitted corner order).
  const base = buffers.materialIds.length;
  const corners = dir > 0 ? [c0, c1, c2, c3] : [c0, c2, c1, c3];
  const aoOrder = dir > 0 ? [0, 1, 2, 3] : [0, 2, 1, 3];
  const sky = faceLight >= 0 ? (faceLight >> 4) / LIGHT_SCALE : 0;
  const block = faceLight >= 0 ? (faceLight & 0xf) / LIGHT_SCALE : 0;
  for (let vi = 0; vi < 4; vi++) {
    const [cx, cy, cz] = corners[vi];
    buffers.positions.push3(cx, cy, cz);
    buffers.normals.push3(normal[0], normal[1], normal[2]);
    buffers.materialIds.push(material);
    buffers.drops?.push(drop > 0 && cy === topY ? drop : 0);
    if (buffers.light && faceLight >= 0) buffers.light.push2(sky, block);
    if (buffers.ao && ao) buffers.ao.push(ao[aoOrder[vi]] / 3);
  }
  buffers.indices.pushAll(base, base + 1, base + 2, base + 2, base + 1, base + 3);
}

/** Light levels are 0–15; attributes are normalized by this. */
const LIGHT_SCALE = 15;

function toMeshData(
  buffers: {
    positions: FloatBuf;
    normals: FloatBuf;
    materialIds: ValueBuf<Uint16Array>;
    indices: ValueBuf<Uint32Array>;
    drops?: FloatBuf;
    light?: FloatBuf;
    ao?: FloatBuf;
  },
  extractDrops?: (buffers: {
    positions: FloatBuf;
    normals: FloatBuf;
    materialIds: ValueBuf<Uint16Array>;
    indices: ValueBuf<Uint32Array>;
    drops?: FloatBuf;
    light?: FloatBuf;
    ao?: FloatBuf;
  }) => Float32Array,
  withLight = false,
): MeshData {
  return {
    positions: buffers.positions.toTypedArray(),
    normals: buffers.normals.toTypedArray(),
    materialIds: buffers.materialIds.toTypedArray(),
    indices: buffers.indices.toTypedArray(),
    quadCount: buffers.materialIds.length / 4,
    ...(extractDrops ? { waterDrop: extractDrops(buffers) } : {}),
    ...(withLight && buffers.light
      ? {
          light: buffers.light.toTypedArray(),
          ...(buffers.ao ? { ao: buffers.ao.toTypedArray() } : {}),
        }
      : {}),
  };
}
