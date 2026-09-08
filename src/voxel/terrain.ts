import { CHUNK_SIZE, WORLD_HEIGHT } from './coordinates';
import { type Chunk } from './chunk';
import { AIR, DIRT, GRASS, SAND, STONE, WATER, type VoxelMaterialID } from './materials';

/**
 * Deterministic seeded terrain: integer-hash value noise, fBm hills,
 * mountain-masked amplification, sea level, and layered materials.
 *
 * Every function is a pure function of (seed, coordinates): generation
 * order never matters, unloaded chunks regenerate identically, and the
 * same seed produces the same world on every machine. No sequential RNG
 * state lives in generation (the seeded RNG export exists for future
 * non-noise uses like scatter features).
 */

export interface TerrainParams {
  seed: number;
  baseHeight: number;
  hillAmplitude: number;
  mountainAmplitude: number;
  seaLevel: number;
}

export const DEFAULT_TERRAIN: TerrainParams = {
  seed: 1337,
  baseHeight: 12,
  hillAmplitude: 7,
  mountainAmplitude: 13,
  seaLevel: 10,
};

/** Small, fast, seedable PRNG (mulberry32). Deterministic per seed. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer-coordinate hash → [0, 1). Pure; no sequential state. */
function hash2(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth quintic fade for noise interpolation. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 2D value noise in [-1, 1] at arbitrary (fractional) coordinates. */
export function valueNoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fz);

  const n00 = hash2(ix, iz, seed);
  const n10 = hash2(ix + 1, iz, seed);
  const n01 = hash2(ix, iz + 1, seed);
  const n11 = hash2(ix + 1, iz + 1, seed);

  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 2 - 1;
}

/** Fractal Brownian motion over value noise, normalized to [-1, 1]. */
export function fbm2(
  x: number,
  z: number,
  seed: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * frequency, z * frequency, seed + i * 1013) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/** Surface height at a world column: solid voxels fill y < height. */
export function heightAt(x: number, z: number, params: TerrainParams): number {
  const hills = fbm2(x / 28, z / 28, params.seed + 1, 4);
  const mountainMask = fbm2(x / 110, z / 110, params.seed + 2, 3);
  const mountains = Math.max(0, mountainMask) ** 2 * params.mountainAmplitude;
  const h = Math.round(params.baseHeight + hills * params.hillAmplitude + mountains);
  // Leave one air layer at the top and never go below bedrock + 1.
  return Math.min(Math.max(h, 2), WORLD_HEIGHT - 2);
}

/** True if a column at surface height `h` stands above the water line. */
export function isDry(h: number, params: TerrainParams): boolean {
  return h > params.seaLevel;
}

/** Material for one voxel of a column with surface height `h`. */
function materialAt(wy: number, h: number, params: TerrainParams): VoxelMaterialID {
  if (wy >= h) {
    // Above the surface: water fills up to (not including) sea level.
    if (h < params.seaLevel && wy < params.seaLevel) return WATER;
    return AIR;
  }
  if (wy === 0) return STONE; // bedrock
  const beach = h <= params.seaLevel; // sand at and below the waterline
  if (wy === h - 1) return beach ? SAND : GRASS;
  if (wy >= h - 3) return beach ? SAND : DIRT;
  return STONE;
}

/** Fill one chunk from the terrain function. Pure in (seed, chunk coord). */
export function generateChunk(chunk: Chunk, params: TerrainParams): void {
  const origin = chunk.origin;
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const h = heightAt(origin.x + lx, origin.z + lz, params);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const material = materialAt(origin.y + ly, h, params);
        if (material !== AIR) chunk.volume.set(lx, ly, lz, material);
      }
    }
  }
}

/**
 * Deterministic spawn: the first dry column found scanning outward from
 * the world origin (ring by ring), or the origin column as a fallback.
 */
export function findSpawn(params: TerrainParams): { x: number; y: number; z: number } {
  for (let r = 0; r < 128; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // Only the ring's perimeter keeps the scan O(r) per ring.
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const h = heightAt(dx, dz, params);
        if (isDry(h, params)) {
          return { x: dx + 0.5, y: h, z: dz + 0.5 };
        }
      }
    }
  }
  return { x: 0.5, y: heightAt(0, 0, params), z: 0.5 };
}
