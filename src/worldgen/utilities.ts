import {
  COPPER,
  GENERATOR,
  LAMP,
  PIPE,
  PUMP,
  TAP,
  WOOD,
  type VoxelMaterialID,
} from '../voxel/materials';
import { hash3, heightAt, type TerrainParams } from '../voxel/terrain';
import { planAt, ROAD_SPACING, roadOffset, TOWN_RADIUS } from './town';

/**
 * Town utilities (Phase 15, plan §113): the generated consumers and
 * networks the power/plumbing sims run on. Pure functions of (seed,
 * coordinates), same contract as the town itself — any chunk in any
 * order paints the same cells, and the save format is untouched.
 *
 * **Power grid.** A copper cable is buried one block under the surface
 * of every road-line center column (real streets hide their cables; it
 * also keeps the structural sim happy — every cable cell is grounded).
 * Metal lampposts rise from the cable at every 8th center column (seeded
 * offset), each with a lamp head; one generator block at the town's
 * central intersection feeds the whole grid through a copper vault. Cut
 * the cable (dig through the road, explosion) and the lamps behind the
 * cut go dark — the Phase 15 power sim rebuilds the component and emits
 * `powerLost`.
 *
 * **Water main.** One pipeline per town: a pump submerged at the lake
 * nearest the center, a buried main running to the town center, and a
 * standpipe with a tap by the road. The main runs down the road's
 * *edge lane* (one cell beside the center line — still asphalt/bridge,
 * but free of poles), at h−2, diving to h−3 under the cable crossings
 * so the cable keeps its support, and at deck level −1 under water with
 * a support post every other cell. Break the main and the plumbing sim
 * pours real Phase 9 water into the hole until the pump is destroyed.
 *
 * All "random" choices hash — no sequential RNG (ADR-005).
 */

/** Lampposts every N cells along a road-line center column. */
export const LAMP_SPACING = 8;

const mod = (v: number, m: number): number => ((v % m) + m) % m;

/** The road-line coordinate (center column) nearest to 0 on one axis. */
export function centerLine(off: number): number {
  return off + Math.round(-off / ROAD_SPACING) * ROAD_SPACING;
}

/** The central road intersection — the generator site. */
export function generatorSite(params: TerrainParams): { x: number; z: number } {
  return { x: centerLine(roadOffset(params.seed, 1)), z: centerLine(roadOffset(params.seed, 2)) };
}

/** True if (x, z) is a road-line center column (carries the buried cable). */
export function cableAt(x: number, z: number, params: TerrainParams): boolean {
  if (Math.max(Math.abs(x), Math.abs(z)) > TOWN_RADIUS) return false;
  if (planAt(x, z, params).kind !== 'road') return false;
  // A column may sit on a vertical line's lane AND a horizontal line's
  // center (or vice versa) — it carries the cable in the center case.
  return onVerticalCenter(x, params) || mod(z - roadOffset(params.seed, 2), ROAD_SPACING) === 0;
}

/** True if (x, z) sits on a vertical road line's center (cable along z). */
function onVerticalCenter(x: number, params: TerrainParams): boolean {
  return mod(x - roadOffset(params.seed, 1), ROAD_SPACING) === 0;
}

/** Cable level for a road-center column (dry: h−2; submerged: deck − 1). */
function cableLevel(x: number, z: number, params: TerrainParams): number {
  const h = heightAt(x, z, params);
  return isSubmerged(h, params) ? params.seaLevel - 1 : h - 2;
}

/** A column is actually under water (not just at the waterline beach). */
function isSubmerged(h: number, params: TerrainParams): boolean {
  return h < params.seaLevel;
}

/** Deterministic per-line pole phase in [0, LAMP_SPACING). */
function lampOffset(line: number, seed: number): number {
  return Math.floor(hash3(line, 71, 0, seed) * LAMP_SPACING);
}

/** True if a lamppost stands at this (already road-center) column. */
export function lampPostAt(x: number, z: number, params: TerrainParams): boolean {
  const gx = generatorSite(params);
  if (x === gx.x && z === gx.z) return false; // the generator owns this cell
  // Vertical line centers host poles on their z-lattice, horizontal
  // centers on their x-lattice; at intersections either rule may fire.
  if (onVerticalCenter(x, params) && mod(z - lampOffset(x, params.seed), LAMP_SPACING) === 0) {
    return true;
  }
  if (mod(z - roadOffset(params.seed, 2), ROAD_SPACING) === 0) {
    return mod(x - lampOffset(z, params.seed), LAMP_SPACING) === 0;
  }
  return false;
}

const poleAt = lampPostAt;

/**
 * Paint the utilities for one road column: the buried cable under every
 * road-line center column (with stair-step fills where the terrain
 * rises past its neighbor), and (on pole columns) the lamppost rising
 * from it — or the central generator structure on its intersection.
 * Called after the road surface exists.
 */
export function paintRoadUtilities(
  x: number,
  z: number,
  params: TerrainParams,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  if (!cableAt(x, z, params)) return;
  const h = heightAt(x, z, params);
  const gx = generatorSite(params);
  const isGenerator = x === gx.x && z === gx.z;
  if (!isSubmerged(h, params)) {
    const y = h - 2;
    set(x, y, z, COPPER); // buried cable
    paintCableFills(x, z, y, params, set);
    if (isGenerator) {
      set(x, h - 1, z, COPPER); // vault access to the grid
      set(x, h, z, COPPER); // pedestal
      set(x, h + 1, z, GENERATOR);
      set(x, h + 2, z, GENERATOR);
      return;
    }
    if (poleAt(x, z, params)) {
      set(x, h - 1, z, COPPER); // pole base (replaces the asphalt top)
      set(x, h, z, COPPER);
      set(x, h + 1, z, COPPER);
      set(x, h + 2, z, COPPER);
      set(x, h + 3, z, LAMP);
    }
  } else {
    // Water column: the cable runs submerged under the bridge deck,
    // resting on the deck posts every other cell.
    const y = params.seaLevel - 1;
    set(x, y, z, COPPER);
    paintCableFills(x, z, y, params, set);
    if (isGenerator) {
      // A bridge crossing at the center: the plant stands on the deck.
      set(x, params.seaLevel, z, COPPER); // through the deck
      set(x, params.seaLevel + 1, z, COPPER); // pedestal
      set(x, params.seaLevel + 2, z, GENERATOR);
      set(x, params.seaLevel + 3, z, GENERATOR);
      return;
    }
    if (poleAt(x, z, params)) {
      set(x, params.seaLevel, z, COPPER); // through the deck
      set(x, params.seaLevel + 1, z, COPPER);
      set(x, params.seaLevel + 2, z, COPPER);
      set(x, params.seaLevel + 3, z, LAMP);
    }
  }
}

/**
 * Cable stair fills: when an in-line neighbor's cable sits lower, this
 * (higher) column extends down to it, keeping the grid connected across
 * terrain steps. All fill cells stay buried — the fills live on the dry
 * column, which is always the higher or equal one.
 */
function paintCableFills(
  x: number,
  z: number,
  y: number,
  params: TerrainParams,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  const neighbors: [number, number][] = [];
  if (onVerticalCenter(x, params)) {
    neighbors.push([x, z - 1], [x, z + 1]);
  }
  if (mod(z - roadOffset(params.seed, 2), ROAD_SPACING) === 0) {
    neighbors.push([x - 1, z], [x + 1, z]);
  }
  for (const [nx, nz] of neighbors) {
    const ny = cableLevel(nx, nz, params);
    for (let fy = ny; fy < y; fy++) set(x, fy, z, COPPER);
  }
}

export interface PipelineRoute {
  /** The lane row (constant z, one cell beside a road center line). */
  z: number;
  /** Pump column (submerged; water also at pumpX + sign(pumpX)). */
  pumpX: number;
  /** Riser column near the center (dry, no cable above the main). */
  endX: number;
}

/**
 * The town's water-main route: the road line nearest the center whose
 * utility lane crosses water, its nearest-to-center water column (the
 * pump), and a riser column near the center. Undefined when no candidate
 * lane crosses water — a dry-seed town simply has no water main.
 */
export function pipelineRoute(params: TerrainParams): PipelineRoute | undefined {
  const offZ = roadOffset(params.seed, 2);
  const lines: number[] = [];
  for (
    let k = Math.ceil((-TOWN_RADIUS - offZ) / ROAD_SPACING);
    offZ + k * ROAD_SPACING <= TOWN_RADIUS;
    k++
  ) {
    lines.push(offZ + k * ROAD_SPACING);
  }
  lines.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);

  for (const center of lines) {
    const z = center - 1; // the lane: road surface, no poles, no cable
    // Nearest-to-center water column (ties prefer +x), needing water on
    // its far side so the pump stands in the lake, not a 1-cell puddle.
    let pumpX: number | undefined;
    for (let d = 0; d <= TOWN_RADIUS && pumpX === undefined; d++) {
      for (const s of [1, -1]) {
        const x = s * d;
        if (x === 0 || isSubmerged(heightAt(x, z, params), params) === false) continue;
        const away = x + s; // one further from the center: still water?
        if (!isSubmerged(heightAt(away, z, params), params)) continue;
        // The main occupies the top water cell along this row, so the
        // pump's water must come from the off-road side (z − 1).
        if (!isSubmerged(heightAt(x, z - 1, params), params)) continue;
        pumpX = x;
        break;
      }
    }
    if (pumpX === undefined) continue;
    // Riser: a dry, cable-free column near the center, ordered +1,-1,+2,-2.
    let endX: number | undefined;
    for (const c of [1, -1, 2, -2]) {
      if (isSubmerged(heightAt(c, z, params), params)) continue;
      if (onVerticalCenter(c, params)) continue; // cable dives under, no riser
      endX = c;
      break;
    }
    if (endX === undefined) continue;
    return { z, pumpX, endX };
  }
  return undefined;
}

/** Main level for a lane column (cable crossings dive one deeper). */
function mainLevel(x: number, z: number, params: TerrainParams): number {
  const h = heightAt(x, z, params);
  if (isSubmerged(h, params)) return params.seaLevel - 1; // under the deck
  return onVerticalCenter(x, params) ? h - 3 : h - 2;
}

/**
 * Paint the pipeline's cells inside one chunk: the buried main (with
 * vertical fills where the ground steps), support posts under water
 * crossings, the submerged pump, and the riser + tap at the end.
 */
export function paintPipeline(
  x0: number,
  x1: number,
  route: PipelineRoute,
  params: TerrainParams,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  const z = route.z;
  const lo = Math.min(route.pumpX, route.endX);
  const hi = Math.max(route.pumpX, route.endX);
  for (let x = Math.max(lo, x0); x <= Math.min(hi, x1); x++) {
    const y = mainLevel(x, z, params);
    set(x, y, z, PIPE);
    const h = heightAt(x, z, params);
    if (isSubmerged(h, params) && mod(x + z, 2) === 0) {
      // Support post under a water crossing, down to the bed (same
      // parity as the bridge posts, whose tops the main replaces).
      for (let py = h; py < y; py++) set(x, py, z, WOOD);
    }
    // Stair fills where the lane steps: this (higher) column extends
    // down to the neighbor's level. Fills stay buried — a submerged
    // column only ever fills down to a deeper cable crossing.
    for (const nx of [x - 1, x + 1]) {
      if (nx < lo || nx > hi) continue;
      const ny = mainLevel(nx, z, params);
      for (let fy = ny; fy < y; fy++) set(x, fy, z, PIPE);
    }
  }
  if (route.pumpX >= x0 && route.pumpX <= x1) {
    set(route.pumpX, params.seaLevel - 1, z, PUMP);
  }
  if (route.endX >= x0 && route.endX <= x1) {
    const h = heightAt(route.endX, z, params);
    set(route.endX, h - 1, z, PIPE); // riser through the road surface
    set(route.endX, h, z, PIPE);
    set(route.endX, h + 1, z, TAP);
  }
}
