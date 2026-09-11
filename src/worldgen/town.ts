import type { Chunk } from '../voxel/chunk';
import { CHUNK_SIZE } from '../voxel/coordinates';
import {
  AIR,
  ASPHALT,
  BRICK,
  CONCRETE,
  GLASS,
  GRASS,
  LEAVES,
  WOOD,
  type VoxelMaterialID,
} from '../voxel/materials';
import {
  findSpawn,
  generateChunk,
  hash3,
  heightAt,
  isDry,
  type TerrainParams,
} from '../voxel/terrain';

/**
 * Procedural town (Phase 14, plan §112): a seeded grid of roads, blocks,
 * lots, and buildings laid over the existing terrain function.
 *
 * Everything is a pure function of (seed, coordinates) — same contract as
 * the terrain (see src/voxel/terrain.ts). There is no town state: any
 * chunk can be generated in any order, unloaded chunks regenerate
 * identically, and the save format is untouched (town buildings are part
 * of generation; the edit journal on top of them is already how player
 * changes persist).
 *
 * Layout:
 * - Roads run on a 24-cell grid (3 cells wide) inside a 96-cell square
 *   around the world origin, with per-seed offsets. Dry road cells
 *   resurface the terrain top with asphalt; water columns become wooden
 *   bridges — a deck one block above the waterline on posts every other
 *   cell, so a burned post genuinely drops its deck (support graph).
 * - The space between roads is tiled with 10×10 lots. Each lot
 *   hash-picks a building (house / shop / industrial) or stays a yard,
 *   some with a tree. Buildings level a one-block apron (concrete
 *   foundation or a cut), then raise walls, windows, a door, a roof
 *   (gable for houses, flat + parapet for shops, slab for industry), and
 *   a little furniture. Two-story houses get a real interior staircase
 *   with a slab opening — walkable by NPCs (one-block steps).
 * - Outside the town radius the land is wild: sparse lattice-gated trees
 *   (trunk + canopy) on dry grass.
 *
 * Believability over accuracy: spans stay inside the structural sim's
 * cantilever budget (walls + anchored gable ends carry the roof), doors
 * are exactly two cells tall, and all "random" choices hash from the lot
 * origin — no sequential RNG anywhere (ADR-005).
 */

/** Town extent: roads and lots exist where max(|x|, |z|) ≤ RADIUS. */
export const TOWN_RADIUS = 96;
/** Road line spacing and half-width (cells |u| ≤ 1 of a line are road). */
export const ROAD_SPACING = 24;
const ROAD_HALF = 1;
/** Interior block band [line + 2, line + 22): tiled with 2×2 lots. */
const LOT_SIZE = 10;
/** Tree anchors live on this lattice in wild land (canopy reach ±2). */
const TREE_LATTICE = 5;

export type PlanKind = 'road' | 'lot' | 'wild';

export interface TownPlan {
  kind: PlanKind;
  /** Origin of the 10×10 lot containing this cell (kind === 'lot'). */
  lot?: { x: number; z: number };
}

export type BuildingType = 'house' | 'shop' | 'industrial';

export interface BuildingSpec {
  type: BuildingType;
  /** Lot origin. */
  ox: number;
  oz: number;
  /** Footprint min corner (the pad covers footprint ± 1). */
  bx: number;
  bz: number;
  /** Footprint size in cells (6–8). */
  w: number;
  d: number;
  /** Ground-floor standing level: feet cells and door cells sit at this y. */
  baseY: number;
  /** Door wall: 0 = +x, 1 = −x, 2 = +z, 3 = −z. */
  doorSide: 0 | 1 | 2 | 3;
  /** Door position along its wall, ≥ 1 from each corner. */
  doorPos: number;
  /** Houses only: 1 = bungalow, 2 = has an upstairs + staircase. */
  floors: 1 | 2;
  /** First walkable cell outside the door (the NPC home/work anchor). */
  door: { x: number; y: number; z: number };
}

export interface LotSpec {
  ox: number;
  oz: number;
  /** undefined → yard/park (grass, maybe a tree). */
  building?: BuildingSpec;
  /** Yards: a tree at the lot center. */
  tree: boolean;
}

const mod = (v: number, m: number): number => ((v % m) + m) % m;

function roadOffset(seed: number, salt: number): number {
  return 4 + Math.floor(hash3(salt, 977, salt + 1, seed) * 16);
}

/** The town plan for one column: road, lot (with origin), or wild. */
export function planAt(x: number, z: number, params: TerrainParams): TownPlan {
  if (Math.max(Math.abs(x), Math.abs(z)) > TOWN_RADIUS) return { kind: 'wild' };
  const ux = mod(x - roadOffset(params.seed, 1), ROAD_SPACING);
  const uz = mod(z - roadOffset(params.seed, 2), ROAD_SPACING);
  if (
    ux <= ROAD_HALF ||
    ux >= ROAD_SPACING - ROAD_HALF ||
    uz <= ROAD_HALF ||
    uz >= ROAD_SPACING - ROAD_HALF
  ) {
    return { kind: 'road' };
  }
  const lineX = x - ux;
  const lineZ = z - uz;
  return {
    kind: 'lot',
    lot: {
      x: lineX + 2 + (ux < 12 ? 0 : LOT_SIZE),
      z: lineZ + 2 + (uz < 12 ? 0 : LOT_SIZE),
    },
  };
}

/** Upper bound on building height above baseY (viability + roof ridge). */
function heightBudget(spec: { type: BuildingType; floors: 1 | 2 }): number {
  if (spec.type === 'house') return spec.floors === 2 ? 12 : 8;
  return 6; // shop parapet / industrial slab
}

/**
 * The deterministic lot contents. Computing viability (all-dry pad,
 * height clearance) needs a handful of height queries — cheap, and
 * cached by callers that paint many columns of the same lot.
 */
export function lotSpec(ox: number, oz: number, params: TerrainParams): LotSpec {
  const r = (salt: number) => hash3(ox, salt, oz, params.seed);
  const dist = Math.max(Math.abs(ox), Math.abs(oz));

  const roll = r(1);
  if (roll <= 0.14) return { ox, oz, tree: r(3) < 0.4 }; // yard / pocket park

  const t = r(2);
  const type: BuildingType = t < 0.6 ? 'house' : t < 0.78 ? 'shop' : 'industrial';

  const w = 6 + Math.floor(r(4) * 3);
  const d = 6 + Math.floor(r(5) * 3);
  const bx = ox + Math.floor((LOT_SIZE - w) / 2);
  const bz = oz + Math.floor((LOT_SIZE - d) / 2);
  const baseY = heightAt(bx + (w >> 1), bz + (d >> 1), params);
  const doorSide = Math.floor(r(6) * 4) as 0 | 1 | 2 | 3;
  const wallLen = doorSide < 2 ? d : w;
  const doorPos = 1 + Math.floor(r(7) * (wallLen - 2));
  const floors: 1 | 2 = type === 'house' && r(8) < (dist < 48 ? 0.45 : 0.15) ? 2 : 1;

  const spec: BuildingSpec = {
    type,
    ox,
    oz,
    bx,
    bz,
    w,
    d,
    baseY,
    doorSide,
    doorPos,
    floors,
    door: doorFrontCell(bx, bz, w, d, baseY, doorSide, doorPos),
  };

  // Viable only when the pad (footprint ± 1) is dry land, the structure
  // fits below the world ceiling, and it stays inside the town square.
  let viable = baseY + heightBudget(spec) <= 29;
  viable &&=
    Math.max(Math.abs(bx - 1), Math.abs(bx + w), Math.abs(bz - 1), Math.abs(bz + d)) <= TOWN_RADIUS;
  for (let pz = bz - 1; viable && pz <= bz + d; pz++) {
    for (let px = bx - 1; px <= bx + w; px++) {
      if (!isDry(heightAt(px, pz, params), params)) {
        viable = false;
        break;
      }
    }
  }
  return viable ? { ox, oz, building: spec, tree: false } : { ox, oz, tree: r(3) < 0.4 };
}

function doorFrontCell(
  bx: number,
  bz: number,
  w: number,
  d: number,
  baseY: number,
  side: 0 | 1 | 2 | 3,
  pos: number,
): { x: number; y: number; z: number } {
  switch (side) {
    case 0:
      return { x: bx + w, y: baseY, z: bz + pos };
    case 1:
      return { x: bx - 1, y: baseY, z: bz + pos };
    case 2:
      return { x: bx + pos, y: baseY, z: bz + d };
    default:
      return { x: bx + pos, y: baseY, z: bz - 1 };
  }
}

/** Wild land tree gate: sparse lattice, dry grass only, hash-selected. */
export function isTreeAt(tx: number, tz: number, params: TerrainParams): boolean {
  if (mod(tx, TREE_LATTICE) !== 0 || mod(tz, TREE_LATTICE) !== 0) return false;
  if (planAt(tx, tz, params).kind !== 'wild') return false;
  const h = heightAt(tx, tz, params);
  if (!isDry(h, params)) return false;
  return hash3(tx, 31, tz, params.seed) < 0.45;
}

/** Trunk height (4–6) for a tree anchor. */
function treeTrunk(tx: number, tz: number, params: TerrainParams): number {
  return 4 + Math.floor(hash3(tx, 32, tz, params.seed) * 3);
}

/**
 * Paint one road column: asphalt resurfacing on dry land, or a wooden
 * bridge over water — deck one block above the waterline (flush with the
 * shore at sea level), posts down to the lakebed every other cell.
 */
function paintRoadColumn(
  x: number,
  z: number,
  params: TerrainParams,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  const h = heightAt(x, z, params);
  if (isDry(h, params)) {
    set(x, h - 1, z, ASPHALT);
    return;
  }
  set(x, params.seaLevel, z, WOOD); // deck (feet cell above stays dry)
  if (mod(x + z, 2) === 0) {
    for (let y = h; y < params.seaLevel; y++) set(x, y, z, WOOD); // post to bed
  }
}

/**
 * Paint one tree: trunk from the surface, canopy layers around the top.
 * Leaves only fill air (the caller's `setSoft`), so slopes and buildings
 * never get engulfed.
 */
function paintTree(
  tx: number,
  tz: number,
  params: TerrainParams,
  setSoft: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  const h = heightAt(tx, tz, params);
  const top = h + treeTrunk(tx, tz, params) - 1;
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ax = Math.abs(dx);
      const az = Math.abs(dz);
      const x = tx + dx;
      const z = tz + dz;
      const corner = ax === 2 && az === 2;
      if (ax <= 2 && az <= 2 && !(corner && hash3(x, 33, z, params.seed) < 0.5)) {
        setSoft(x, top - 1, z, LEAVES);
        setSoft(x, top, z, LEAVES);
      }
      if (ax <= 1 && az <= 1) setSoft(x, top + 1, z, LEAVES);
      if (ax + az <= 1) setSoft(x, top + 2, z, LEAVES);
    }
  }
  for (let y = h; y <= top; y++) set(tx, y, tz, WOOD);
}

/** Interior cell of the stair wall: step i (0–3) or −1. Deterministic. */
function stairStepAt(spec: BuildingSpec, px: number, pz: number): number {
  if (spec.type !== 'house' || spec.floors !== 2) return -1;
  // Stairs run along the wall opposite the door, one cell inboard.
  if (spec.doorSide < 2) {
    const x = spec.doorSide === 0 ? spec.bx + spec.w - 2 : spec.bx + 1;
    if (px !== x) return -1;
    const off = pz - spec.bz - 1;
    return off >= 0 && off <= 3 ? off : -1;
  }
  const z = spec.doorSide === 2 ? spec.bz + spec.d - 2 : spec.bz + 1;
  if (pz !== z) return -1;
  const off = px - spec.bx - 1;
  return off >= 0 && off <= 3 ? off : -1;
}

/** Slab opening above the top stair steps (headroom for the climb). */
function isSlabHole(spec: BuildingSpec, px: number, pz: number): boolean {
  const step = stairStepAt(spec, px, pz);
  return step === 2 || step === 3;
}

/**
 * Paint a whole lot (called once per intersecting chunk; `set` clips to
 * the chunk, `setSoft` only fills air): pad leveling, walls with door +
 * windows, roof, stairs, furniture. Interior walls are hollow by
 * construction; spans stay well inside the structural cantilever budget.
 */
export function paintLot(
  spec: LotSpec,
  params: TerrainParams,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
  setSoft: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  if (spec.tree && !spec.building) {
    paintTree(spec.ox + 4, spec.oz + 4, params, setSoft, set);
    return;
  }
  const b = spec.building;
  if (!b) return;
  const { bx, bz, w, d, baseY: F, type, floors } = b;
  const wallMat = type === 'house' ? WOOD : type === 'shop' ? BRICK : CONCRETE;
  const wallH = type === 'industrial' ? 4 : floors === 2 ? 4 : 3;

  // --- pad: footprint ± 1, leveled to standing height F -------------------
  for (let pz = bz - 1; pz <= bz + d; pz++) {
    for (let px = bx - 1; px <= bx + w; px++) {
      const th = heightAt(px, pz, params);
      const inside = px >= bx && px < bx + w && pz >= bz && pz < bz + d;
      const floorMat = inside ? (type === 'industrial' ? CONCRETE : WOOD) : GRASS;
      if (th < F) {
        for (let y = th; y < F - 1; y++) set(px, y, pz, CONCRETE);
      } else if (th > F) {
        for (let y = F; y < th; y++) set(px, y, pz, AIR); // cut into the hill
      }
      set(px, F - 1, pz, floorMat);
    }
  }

  // --- walls, door, windows ----------------------------------------------
  for (let pz = bz; pz < bz + d; pz++) {
    for (let px = bx; px < bx + w; px++) {
      const onX = px === bx || px === bx + w - 1;
      const onZ = pz === bz || pz === bz + d - 1;
      if (onX || onZ) {
        const side = onX ? (px === bx ? 1 : 0) : pz === bz ? 3 : 2;
        const pos = side < 2 ? pz - bz : px - bx;
        for (let y = F; y < F + wallH; y++) {
          set(px, y, pz, wallCell(b, wallMat, side, pos, y));
        }
        if (type === 'house' && floors === 2) {
          const len = side < 2 ? d : w;
          for (let y = F + 5; y < F + 8; y++) {
            set(
              px,
              y,
              pz,
              y === F + 6 && pos > 0 && pos < len - 1 && pos % 2 === 0 ? GLASS : wallMat,
            );
          }
        }
      }
      // Upstairs: slab with stair openings, then the steps themselves.
      if (type === 'house' && floors === 2) {
        if (!isSlabHole(b, px, pz)) set(px, F + 4, pz, WOOD);
        const step = stairStepAt(b, px, pz);
        if (step >= 0) set(px, F + step, pz, WOOD);
      }
      // Roofs.
      if (type === 'house') {
        paintGableRoof(b, px, pz, set);
      } else if (type === 'shop') {
        set(px, F + 3, pz, WOOD);
        if (px === bx || px === bx + w - 1 || pz === bz || pz === bz + d - 1) {
          set(px, F + 4, pz, BRICK); // parapet
        }
      } else {
        set(px, F + 4, pz, CONCRETE);
      }
    }
  }

  paintFurniture(b, params, set);
}

/** One wall cell: door opening, windows on a rhythm, else wall material. */
function wallCell(
  b: BuildingSpec,
  wallMat: VoxelMaterialID,
  side: 0 | 1 | 2 | 3,
  pos: number,
  y: number,
): VoxelMaterialID {
  const len = side < 2 ? b.d : b.w;
  if ((y === b.baseY || y === b.baseY + 1) && side === b.doorSide && pos === b.doorPos) {
    return AIR; // the door opening
  }
  const windowY = b.type === 'industrial' ? b.baseY + 2 : b.baseY + 1;
  if (
    y === windowY &&
    pos > 0 &&
    pos < len - 1 &&
    pos % 2 === 0 &&
    !(side === b.doorSide && Math.abs(pos - b.doorPos) <= 1)
  ) {
    return GLASS;
  }
  return wallMat;
}

/** Gable roof over the footprint; ridge runs along the longer axis. */
function paintGableRoof(
  b: BuildingSpec,
  px: number,
  pz: number,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  const { bx, bz, w, d, baseY: F, floors } = b;
  const wallTop = F + (floors === 2 ? 7 : 2);
  const rb = wallTop + 1; // roof eave level
  const alongX = w >= d;
  const rise = alongX ? Math.min(pz - bz, bz + d - 1 - pz) : Math.min(px - bx, bx + w - 1 - px);
  set(px, rb + rise, pz, WOOD);
  // Gable infill at the two ridge-end walls closes the triangular profile.
  if (
    (alongX && (px === bx || px === bx + w - 1)) ||
    (!alongX && (pz === bz || pz === bz + d - 1))
  ) {
    for (let y = wallTop + 1; y < rb + rise; y++) set(px, y, pz, WOOD);
  }
}

/** A little deterministic furniture (beds, tables, counters, crates). */
function paintFurniture(
  b: BuildingSpec,
  params: TerrainParams,
  set: (x: number, y: number, z: number, m: VoxelMaterialID) => void,
): void {
  const F = b.baseY;
  const r = (salt: number) => hash3(b.ox, salt + 40, b.oz, params.seed + 0x7e0);
  const used = new Set<string>();
  const take = (x: number, z: number): boolean => {
    const key = `${x},${z}`;
    if (used.has(key) || stairStepAt(b, x, z) >= 0) return false;
    used.add(key);
    return true;
  };
  if (b.type === 'house') {
    // Bed: two blocks along an interior side wall.
    const side = ((b.doorSide + 1) % 4) as 0 | 1 | 2 | 3;
    for (let i = 1; i <= 2; i++) {
      const [x, z] = interiorCellAt(b, side, i);
      if (take(x, z)) set(x, F, z, WOOD);
    }
    // Table: a hash-picked free interior corner.
    const candidates: [number, number][] = [
      [b.bx + 1, b.bz + 1],
      [b.bx + b.w - 2, b.bz + 1],
      [b.bx + 1, b.bz + b.d - 2],
      [b.bx + b.w - 2, b.bz + b.d - 2],
    ];
    for (let i = 0; i < candidates.length; i++) {
      const [tx, tz] = candidates[(Math.floor(r(1) * candidates.length) + i) % candidates.length];
      if (take(tx, tz)) {
        set(tx, F, tz, WOOD);
        break;
      }
    }
  } else if (b.type === 'shop') {
    // Counter: a few blocks along the inside of the door wall.
    const len = b.doorSide < 2 ? b.d : b.w;
    for (let i = 0; i < 3; i++) {
      const pos = b.doorPos + 2 + i;
      if (pos > len - 2) break;
      const [wx, wz] = wallCellAt(b, b.doorSide, pos);
      const ix = b.doorSide === 0 ? wx - 1 : b.doorSide === 1 ? wx + 1 : wx;
      const iz = b.doorSide === 2 ? wz - 1 : b.doorSide === 3 ? wz + 1 : wz;
      if (take(ix, iz)) set(ix, F, iz, WOOD);
    }
  } else {
    // Crates: two wooden cubes in the back half.
    for (let i = 0; i < 2; i++) {
      const x = b.bx + 1 + Math.floor(r(2 + i) * (b.w - 2));
      const z = b.bz + Math.floor(b.d / 2) + Math.floor(r(4 + i) * (b.d / 2 - 1));
      if (take(x, z)) set(x, F, z, WOOD);
    }
  }
}

/** World cell of a wall position `pos` along `side` (perimeter line). */
function wallCellAt(b: BuildingSpec, side: 0 | 1 | 2 | 3, pos: number): [number, number] {
  if (side === 0) return [b.bx + b.w - 1, b.bz + pos];
  if (side === 1) return [b.bx, b.bz + pos];
  if (side === 2) return [b.bx + pos, b.bz + b.d - 1];
  return [b.bx + pos, b.bz];
}

/** The interior cell one step inboard of a wall position. */
function interiorCellAt(b: BuildingSpec, side: 0 | 1 | 2 | 3, pos: number): [number, number] {
  const [x, z] = wallCellAt(b, side, pos);
  if (side === 0) return [x - 1, z];
  if (side === 1) return [x + 1, z];
  if (side === 2) return [x, z - 1];
  return [x, z + 1];
}

/** Terrain + town, composed. This is the world's chunk generator. */
export function generateChunkWithTown(chunk: Chunk, params: TerrainParams): void {
  generateChunk(chunk, params);
  applyTown(chunk, params);
}

/**
 * Overlay the town onto a terrain-filled chunk. Lot and tree painters run
 * once per intersecting feature; the setter clips everything to this
 * chunk so buildings and canopies span chunk boundaries seamlessly.
 */
export function applyTown(chunk: Chunk, params: TerrainParams): void {
  const origin = chunk.origin;
  const set = (x: number, y: number, z: number, m: VoxelMaterialID): void => {
    const lx = x - origin.x;
    const ly = y - origin.y;
    const lz = z - origin.z;
    if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
      return;
    }
    chunk.volume.set(lx, ly, lz, m);
  };
  const setSoft = (x: number, y: number, z: number, m: VoxelMaterialID): void => {
    const lx = x - origin.x;
    const ly = y - origin.y;
    const lz = z - origin.z;
    if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
      return;
    }
    if (chunk.volume.getOrAir(lx, ly, lz) === AIR) chunk.volume.set(lx, ly, lz, m);
  };

  // Roads and lot discovery, column by column.
  const lots = new Map<string, LotSpec>();
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = origin.x + lx;
      const wz = origin.z + lz;
      const plan = planAt(wx, wz, params);
      if (plan.kind === 'road') {
        paintRoadColumn(wx, wz, params, set);
      } else if (plan.kind === 'lot' && plan.lot) {
        const key = `${plan.lot.x},${plan.lot.z}`;
        if (!lots.has(key)) lots.set(key, lotSpec(plan.lot.x, plan.lot.z, params));
      }
    }
  }
  for (const lot of lots.values()) paintLot(lot, params, set, setSoft);

  // Wild trees: anchors on the lattice within canopy reach of the chunk.
  for (let tz = origin.z - 2; tz < origin.z + CHUNK_SIZE + 2; tz++) {
    for (let tx = origin.x - 2; tx < origin.x + CHUNK_SIZE + 2; tx++) {
      if (isTreeAt(tx, tz, params)) paintTree(tx, tz, params, setSoft, set);
    }
  }
}

export interface TownAnchors {
  /** House door-front cells (NPC homes). */
  homes: { x: number; y: number; z: number }[];
  /** Shop + industrial door-front cells (NPC workplaces). */
  works: { x: number; y: number; z: number }[];
}

/**
 * Every building's door-front cell, grouped for the NPC sim. Positions
 * only — walkability is checked when a figure picks its anchor (the
 * chunk may not be loaded yet, in which case the sim falls back to the
 * terrain ring anchors).
 */
export function townAnchors(params: TerrainParams): TownAnchors {
  const anchors: TownAnchors = { homes: [], works: [] };
  for (const lot of allLots(params)) {
    const b = lot.building;
    if (!b) continue;
    const target = b.type === 'house' ? anchors.homes : anchors.works;
    target.push(b.door);
  }
  return anchors;
}

export interface TownStats {
  houses: number;
  shops: number;
  industrial: number;
  yards: number;
}

/** One-pass town census (HUD/verification/tests). */
export function townStats(params: TerrainParams): TownStats {
  const stats: TownStats = { houses: 0, shops: 0, industrial: 0, yards: 0 };
  for (const lot of allLots(params)) {
    const t = lot.building?.type;
    if (t === 'house') stats.houses++;
    else if (t === 'shop') stats.shops++;
    else if (t === 'industrial') stats.industrial++;
    else stats.yards++;
  }
  return stats;
}

/** Every lot origin in the town square (4 per block), on the road lattice. */
function* allLots(params: TerrainParams): Generator<LotSpec> {
  const offX = roadOffset(params.seed, 1);
  const offZ = roadOffset(params.seed, 2);
  // Road lines sit at off + k·SPACING; visit each line whose lots start
  // inside the square (line + 2, up to the last full lot).
  const kx0 = Math.ceil((-TOWN_RADIUS - offX) / ROAD_SPACING);
  const kz0 = Math.ceil((-TOWN_RADIUS - offZ) / ROAD_SPACING);
  for (let kz = kz0; offZ + kz * ROAD_SPACING <= TOWN_RADIUS - 2; kz++) {
    for (let kx = kx0; offX + kx * ROAD_SPACING <= TOWN_RADIUS - 2; kx++) {
      const lineX = offX + kx * ROAD_SPACING;
      const lineZ = offZ + kz * ROAD_SPACING;
      for (const i of [0, 1]) {
        for (const j of [0, 1]) {
          yield lotSpec(lineX + 2 + i * LOT_SIZE, lineZ + 2 + j * LOT_SIZE, params);
        }
      }
    }
  }
}

/**
 * Spawn point for the towned world: the deterministic terrain spawn,
 * nudged off building pads and trees onto open ground (a road whenever
 * one is close). Pure — respawn after a void fall returns here.
 */
export function findTownSpawn(params: TerrainParams): { x: number; y: number; z: number } {
  const base = findSpawn(params);
  const spawnable = (x: number, z: number): boolean => {
    const plan = planAt(x, z, params);
    if (!isDry(heightAt(x, z, params), params)) return false;
    if (plan.kind === 'lot' && plan.lot) {
      const b = lotSpec(plan.lot.x, plan.lot.z, params).building;
      if (b && x >= b.bx - 1 && x <= b.bx + b.w && z >= b.bz - 1 && z <= b.bz + b.d) {
        return false; // on a building pad or doorstep
      }
    }
    return !isTreeAt(x, z, params);
  };
  for (let r = 0; r <= 32; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = Math.round(base.x) + dx;
        const z = Math.round(base.z) + dz;
        if (spawnable(x, z)) return { x: x + 0.5, y: heightAt(x, z, params), z: z + 0.5 };
      }
    }
  }
  return base;
}
