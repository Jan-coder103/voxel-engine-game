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

const defs: readonly MaterialDef[] = [
  { id: AIR, name: 'air', color: 0x000000, opaque: false, solid: false },
  { id: GRASS, name: 'grass', color: 0x5fae4a, opaque: true, solid: true },
  { id: DIRT, name: 'dirt', color: 0x8a6238, opaque: true, solid: true },
  { id: STONE, name: 'stone', color: 0x8d8d95, opaque: true, solid: true },
  { id: SAND, name: 'sand', color: 0xd8c98a, opaque: true, solid: true },
  { id: WOOD, name: 'wood', color: 0x9c7141, opaque: true, solid: true },
  { id: WATER, name: 'water', color: 0x3d6fd1, opaque: false, solid: false },
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
