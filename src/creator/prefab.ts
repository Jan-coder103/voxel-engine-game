import { AIR, type VoxelMaterialID } from '../voxel/materials';
import type { SaveStore } from '../voxel/persistence';
import type { ClipboardVolume } from './clipboard';

/**
 * Prefabs (Phase 7): saved clipboard volumes, stored as versioned JSON
 * with the same discipline as the world save — validate on load, never
 * load silently against a drifted schema. Voxels are run-length encoded
 * ([material, runLength, …]) because prefab content is mostly air.
 */

export const PREFAB_FORMAT_VERSION = 1;

export interface SerializedPrefabV1 {
  version: typeof PREFAB_FORMAT_VERSION;
  name: string;
  size: { x: number; y: number; z: number };
  /** RLE pairs: [material, runLength] repeated; sum(runLength) === sx·sy·sz. */
  runs: number[];
  /** Number of non-air voxels (informational, sanity-checked on load). */
  solidVoxels: number;
  createdAt: number;
}

/** Encode a clipboard volume into a serializable payload (not a string). */
export function serializePrefab(
  clip: ClipboardVolume,
  name: string,
  createdAt = Date.now(),
): SerializedPrefabV1 {
  const runs: number[] = [];
  let current = clip.voxels[0] ?? AIR;
  let run = 0;
  let solidVoxels = 0;
  for (const material of clip.voxels) {
    if (material === current) {
      run++;
    } else {
      runs.push(current, run);
      current = material;
      run = 1;
    }
    if (material !== AIR) solidVoxels++;
  }
  if (run > 0) runs.push(current, run);
  return {
    version: PREFAB_FORMAT_VERSION,
    name,
    size: { ...clip.size },
    runs,
    solidVoxels,
    createdAt,
  };
}

/** Parse + validate a prefab JSON string. Throws on any shape drift. */
export function deserializePrefab(json: string): { name: string; clip: ClipboardVolume } {
  const parsed = JSON.parse(json) as Partial<SerializedPrefabV1>;
  if (parsed.version !== PREFAB_FORMAT_VERSION) {
    throw new Error(
      `Prefab format version mismatch: expected ${PREFAB_FORMAT_VERSION}, got ${parsed.version}`,
    );
  }
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error('Prefab is missing a "name"');
  }
  const size = parsed.size as Partial<SerializedPrefabV1['size']> | undefined;
  if (
    !size ||
    !Number.isInteger(size.x) ||
    !Number.isInteger(size.y) ||
    !Number.isInteger(size.z) ||
    (size.x ?? 0) <= 0 ||
    (size.y ?? 0) <= 0 ||
    (size.z ?? 0) <= 0
  ) {
    throw new Error('Prefab is missing a valid "size"');
  }
  if (!Array.isArray(parsed.runs) || parsed.runs.length % 2 !== 0) {
    throw new Error('Prefab "runs" must be an even-length array');
  }
  const total = size.x! * size.y! * size.z!;
  const voxels = new Uint16Array(total);
  let offset = 0;
  let solidVoxels = 0;
  for (let i = 0; i < parsed.runs.length; i += 2) {
    const material = parsed.runs[i];
    const runLength = parsed.runs[i + 1];
    if (
      !Number.isInteger(material) ||
      (material as number) < 0 ||
      !Number.isInteger(runLength) ||
      (runLength as number) <= 0
    ) {
      throw new Error(`Prefab run ${i / 2} is malformed`);
    }
    if (offset + runLength! > total) {
      throw new Error('Prefab runs overflow the declared size');
    }
    if (material !== AIR) solidVoxels += runLength!;
    voxels.fill(material as VoxelMaterialID, offset, offset + runLength!);
    offset += runLength!;
  }
  if (offset !== total) {
    throw new Error(`Prefab runs cover ${offset} of ${total} voxels`);
  }
  if (parsed.solidVoxels !== undefined && parsed.solidVoxels !== solidVoxels) {
    throw new Error('Prefab solid voxel count does not match its runs');
  }
  return {
    name: parsed.name,
    clip: { size: { x: size.x!, y: size.y!, z: size.z! }, voxels },
  };
}

/**
 * Named prefab collection over any `SaveStore`. Keys are namespaced under
 * `prefab:` so the world autosave never collides with them.
 */
export class PrefabLibrary {
  static readonly KEY_PREFIX = 'prefab:';

  constructor(private readonly store: SaveStore) {}

  save(clip: ClipboardVolume, name: string): void {
    this.store.set(PrefabLibrary.KEY_PREFIX + name, JSON.stringify(serializePrefab(clip, name)));
  }

  load(name: string): ClipboardVolume | undefined {
    const json = this.store.get(PrefabLibrary.KEY_PREFIX + name);
    if (json === undefined) return undefined;
    try {
      return deserializePrefab(json).clip;
    } catch (error) {
      console.warn(`Prefab "${name}" is unreadable; skipping`, error);
      return undefined;
    }
  }

  list(): string[] {
    return this.store
      .keys()
      .filter((key) => key.startsWith(PrefabLibrary.KEY_PREFIX))
      .map((key) => key.slice(PrefabLibrary.KEY_PREFIX.length))
      .sort();
  }

  delete(name: string): void {
    this.store.delete(PrefabLibrary.KEY_PREFIX + name);
  }
}
