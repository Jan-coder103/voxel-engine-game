/**
 * Voxel material registry (Phase 4 structure, landed early because the
 * mesher's face-culling rule needs the opaque/solid classification).
 *
 * 0 must always be air: fresh typed arrays are zero-initialized to air,
 * and missing/unloaded chunks read as air everywhere.
 *
 * IDs are a stable serialization contract: never renumber or reuse an
 * id — saves reference materials by id. `serializeMaterials` captures
 * the table so future formats can migrate.
 */

export type VoxelMaterialID = number;

export interface MaterialDef {
  readonly id: VoxelMaterialID;
  readonly name: string;
  /** sRGB hex color; the voxel shader palette samples this. */
  readonly color: number;
  /** Opaque materials hide neighboring faces and count as walls. */
  readonly opaque: boolean;
  /** Solid materials collide with the player. */
  readonly solid: boolean;
}

export const AIR: VoxelMaterialID = 0;
export const GRASS: VoxelMaterialID = 1;
export const DIRT: VoxelMaterialID = 2;
export const STONE: VoxelMaterialID = 3;
export const SAND: VoxelMaterialID = 4;
export const WOOD: VoxelMaterialID = 5;
export const WATER: VoxelMaterialID = 6;
// Town materials (Phase 14). Appended after the original seven — ids are a
// serialization contract and older saves' snapshots validate against these.
export const ASPHALT: VoxelMaterialID = 7;
export const CONCRETE: VoxelMaterialID = 8;
export const BRICK: VoxelMaterialID = 9;
export const GLASS: VoxelMaterialID = 10;
export const LEAVES: VoxelMaterialID = 11;
// Utility materials (Phase 15). Same append-only contract: the power grid
// (copper, lamp, generator) and the water main (pipe, pump, tap) identify
// themselves by material so the sims can find their networks.
export const COPPER: VoxelMaterialID = 12;
export const LAMP: VoxelMaterialID = 13;
export const GENERATOR: VoxelMaterialID = 14;
export const PIPE: VoxelMaterialID = 15;
export const PUMP: VoxelMaterialID = 16;
export const TAP: VoxelMaterialID = 17;

const defs: readonly MaterialDef[] = [
  { id: AIR, name: 'air', color: 0x000000, opaque: false, solid: false },
  { id: GRASS, name: 'grass', color: 0x5fae4a, opaque: true, solid: true },
  { id: DIRT, name: 'dirt', color: 0x8a6238, opaque: true, solid: true },
  { id: STONE, name: 'stone', color: 0x8d8d95, opaque: true, solid: true },
  { id: SAND, name: 'sand', color: 0xd8c98a, opaque: true, solid: true },
  { id: WOOD, name: 'wood', color: 0x9c7141, opaque: true, solid: true },
  { id: WATER, name: 'water', color: 0x3d6fd1, opaque: false, solid: false },
  { id: ASPHALT, name: 'asphalt', color: 0x3b3b40, opaque: true, solid: true },
  { id: CONCRETE, name: 'concrete', color: 0xb3b1a8, opaque: true, solid: true },
  { id: BRICK, name: 'brick', color: 0xa5553f, opaque: true, solid: true },
  // Glass renders as a solid pale pane (no transmission yet — known-issue).
  { id: GLASS, name: 'glass', color: 0xbfe3ef, opaque: true, solid: true },
  { id: LEAVES, name: 'leaves', color: 0x3f7d33, opaque: true, solid: true },
  // Utilities (Phase 15). Copper doubles as conduit and lamppost material.
  { id: COPPER, name: 'copper', color: 0xc47a3d, opaque: true, solid: true },
  { id: LAMP, name: 'lamp', color: 0x6e6552, opaque: true, solid: true },
  { id: GENERATOR, name: 'generator', color: 0x4a4f58, opaque: true, solid: true },
  { id: PIPE, name: 'pipe', color: 0x7d8a94, opaque: true, solid: true },
  { id: PUMP, name: 'pump', color: 0x8a4a3a, opaque: true, solid: true },
  { id: TAP, name: 'tap', color: 0xc9a441, opaque: true, solid: true },
];

export const MATERIALS: readonly MaterialDef[] = defs;

export const MATERIALS_BY_NAME: ReadonlyMap<string, MaterialDef> = new Map(
  defs.map((def) => [def.name, def]),
);

/** Lookup by id; unknown ids fall back to air (defensive against corrupt data). */
export function getMaterial(id: VoxelMaterialID): MaterialDef {
  return defs[id] ?? defs[AIR];
}

export function materialByName(name: string): MaterialDef | undefined {
  return MATERIALS_BY_NAME.get(name);
}

export function isOpaque(id: VoxelMaterialID): boolean {
  return getMaterial(id).opaque;
}

export function isSolidForCollision(id: VoxelMaterialID): boolean {
  return getMaterial(id).solid;
}

/**
 * Relative resistance to the destruction damage field (Phase 8): 0 = a
 * blast erases it to the very edge of its radius, 1 = only the blast core
 * reaches it. A derived balance table, not a serialized registry field —
 * the save format keeps validating the four registry fields above.
 * Unknown ids fall back to a mid-value (defensive against corrupt data).
 */
const MATERIAL_HARDNESS: Readonly<Record<number, number>> = {
  [GRASS]: 0.35,
  [DIRT]: 0.4,
  [STONE]: 0.85,
  [SAND]: 0.25,
  [WOOD]: 0.55,
  [WATER]: 0.05,
  [ASPHALT]: 0.7,
  [CONCRETE]: 0.8,
  [BRICK]: 0.65,
  [GLASS]: 0.15,
  [LEAVES]: 0.1,
  [COPPER]: 0.7,
  [LAMP]: 0.3,
  [GENERATOR]: 0.85,
  [PIPE]: 0.75,
  [PUMP]: 0.85,
  [TAP]: 0.5,
};

export function hardnessOf(id: VoxelMaterialID): number {
  return MATERIAL_HARDNESS[id] ?? 0.5;
}

/**
 * Fire behavior (Phase 10): how readily a material ignites and how long a
 * burning cell of it keeps burning. A derived balance table like
 * MATERIAL_HARDNESS — not part of the serialized registry. Materials
 * absent from the table are fireproof.
 */
export interface FireProfile {
  /** Relative ease of ignition in [0, 1]; 0 = non-flammable. */
  readonly flammability: number;
  /** Ticks of fuel one burning cell of this material provides. */
  readonly burnDuration: number;
}

const MATERIAL_FIRE: Readonly<Record<number, FireProfile>> = {
  // Grass is tinder: catches slowly, burns out fast. Wood is the fuel
  // backbone: hard to start from a single spark but burns a long time.
  [GRASS]: { flammability: 0.55, burnDuration: 64 },
  [WOOD]: { flammability: 0.9, burnDuration: 480 },
  // Foliage flashes over in seconds; a burning canopy rains embers.
  [LEAVES]: { flammability: 0.75, burnDuration: 32 },
};

const FIREPROOF: FireProfile = { flammability: 0, burnDuration: 0 };

export function fireProfileOf(id: VoxelMaterialID): FireProfile {
  return MATERIAL_FIRE[id] ?? FIREPROOF;
}

/**
 * Structural load capacity (Phase 11): how much stacked mass (in voxels)
 * a cell of this material can carry before it fractures. A derived
 * balance table like MATERIAL_HARDNESS/MATERIAL_FIRE — not serialized.
 *
 * The world is 32 voxels tall, so these thresholds sit deliberately
 * below build height: a wood column of 23+ collapses when disturbed,
 * dirt/sand/grass much sooner, stone effectively never (it is as strong
 * as the world is tall). Natural terrain never trips these values
 * anyway — the structural sim only stresses cells with journaled edits
 * (see src/voxel/structure.ts).
 */
const MATERIAL_STRENGTH: Readonly<Record<number, number>> = {
  [GRASS]: 14,
  [DIRT]: 16,
  [SAND]: 10,
  [STONE]: 26,
  [WOOD]: 22,
  [ASPHALT]: 24,
  [CONCRETE]: 26,
  [BRICK]: 22,
  [GLASS]: 4,
  [LEAVES]: 6,
  [COPPER]: 20,
  [LAMP]: 4,
  [GENERATOR]: 26,
  [PIPE]: 24,
  [PUMP]: 26,
  [TAP]: 18,
};

export function strengthOf(id: VoxelMaterialID): number {
  return MATERIAL_STRENGTH[id] ?? 18;
}

/** Bump when the serialized table layout changes (not when entries are added). */
export const MATERIAL_FORMAT_VERSION = 1;

interface SerializedMaterial {
  id: VoxelMaterialID;
  name: string;
  color: number;
  opaque: boolean;
  solid: boolean;
}

interface SerializedMaterials {
  version: number;
  materials: SerializedMaterial[];
}

/** Stable JSON form of the registry, for embedding in world saves. */
export function serializeMaterials(): string {
  const payload: SerializedMaterials = {
    version: MATERIAL_FORMAT_VERSION,
    materials: defs.map(({ id, name, color, opaque, solid }) => ({
      id,
      name,
      color,
      opaque,
      solid,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Parse a serialized registry. Validates shape and id consistency against
 * the live table; throws on version drift or mismatched entries so callers
 * never silently load a world against the wrong materials.
 */
export function deserializeMaterials(json: string): readonly MaterialDef[] {
  const parsed = JSON.parse(json) as Partial<SerializedMaterials>;
  if (parsed.version !== MATERIAL_FORMAT_VERSION) {
    throw new Error(
      `Material format version mismatch: expected ${MATERIAL_FORMAT_VERSION}, got ${parsed.version}`,
    );
  }
  if (!Array.isArray(parsed.materials)) {
    throw new Error('Serialized materials missing "materials" array');
  }
  return parsed.materials.map((entry) => {
    const live = getMaterial(entry.id);
    if (live.id === AIR && entry.id !== AIR) {
      throw new Error(`Serialized material has out-of-range id ${entry.id}`);
    }
    if (
      live.name !== entry.name ||
      live.color !== entry.color ||
      live.opaque !== entry.opaque ||
      live.solid !== entry.solid
    ) {
      throw new Error(
        `Serialized material ${entry.id} (${entry.name}) does not match registry entry ${live.name}`,
      );
    }
    return live;
  });
}
