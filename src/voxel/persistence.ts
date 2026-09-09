import type { TerrainParams } from './terrain';
import { serializeMaterials, deserializeMaterials, MATERIAL_FORMAT_VERSION } from './materials';
import type { World } from './world';

/**
 * World persistence (pure — no DOM). The save unit is the *edit journal*:
 * terrain regenerates from the seed, so a save is (seed, terrain params,
 * material table snapshot, per-chunk edited voxels). This keeps saves
 * small and lets the same file restore a world of any streamed size.
 *
 * Since v2 the save also carries the fluid sim's non-default water levels
 * (Phase 9): cells listed as [voxelIndex, level] hold flowing water of
 * that amount; a WATER material cell absent from the list is a source
 * (level 255); anything else is dry. Terrain lakes need no entries.
 *
 * Format versioning: `migrateWorld` walks a payload forward through a
 * chain of migrators, one step per version. The chain exists so future
 * formats migrate instead of breaking old saves.
 */

export const WORLD_FORMAT_VERSION = 2;

/** Version 1 payload (first format). `edits`: chunkKey → [voxelIndex, materialId][]. */
export interface SerializedWorldV1 {
  version: 1;
  /** Save time, milliseconds since epoch (informational). */
  savedAt: number;
  seed: number;
  terrain: TerrainParams;
  /** Embedded material registry snapshot (see serializeMaterials). */
  materials: { version: number; materials: unknown[] };
  edits: Record<string, [number, number][]>;
}

/**
 * Version 2 payload: adds the fluid level map. Levels are sparse — only
 * flowing water (1–254) is listed, so an empty world costs nothing.
 */
export interface SerializedWorldV2 extends Omit<SerializedWorldV1, 'version'> {
  version: 2;
  waterLevels: Record<string, [number, number][]>;
}

export type SerializedWorld = SerializedWorldV2;

interface AnyVersioned {
  version?: unknown;
}

/**
 * One migration step: take a payload at version N (already validated to
 * be shaped like N) and return the equivalent payload at N+1.
 */
type Migration = (payload: Record<string, unknown>) => Record<string, unknown>;

/** Migrators keyed by the version they upgrade FROM. */
const MIGRATIONS: Record<number, Migration> = {
  // v1 → v2: v1 has no fluid state; every water cell is a source (the
  // level map starts empty), which matches how v1 worlds were made.
  1: (payload) => ({ ...payload, version: 2, waterLevels: {} }),
};

/**
 * Walk a parsed payload forward to `WORLD_FORMAT_VERSION`. Throws on
 * missing versions, versions newer than this build knows, or a broken
 * chain — callers should treat the save as unloadable, not guess.
 */
export function migrateWorld(parsed: unknown): SerializedWorld {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Save is not an object');
  }
  let payload = parsed as Record<string, unknown>;
  let version = payloadVersion(payload);
  while (version < WORLD_FORMAT_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new Error(`No migration path from save version ${version}`);
    }
    payload = migration(payload);
    version = payloadVersion(payload);
  }
  if (version > WORLD_FORMAT_VERSION) {
    throw new Error(
      `Save version ${version} is newer than this build supports (${WORLD_FORMAT_VERSION})`,
    );
  }
  return validateV2(payload);
}

function payloadVersion(payload: AnyVersioned): number {
  if (typeof payload.version !== 'number') {
    throw new Error('Save is missing a numeric "version"');
  }
  return payload.version;
}

/** Structural validation for the v2 payload (post-migration). */
function validateV2(payload: Record<string, unknown>): SerializedWorldV2 {
  if (payload.version !== WORLD_FORMAT_VERSION) {
    throw new Error(`Expected save version ${WORLD_FORMAT_VERSION}, got ${payload.version}`);
  }
  if (typeof payload.seed !== 'number') throw new Error('Save is missing "seed"');
  const terrain = payload.terrain as Partial<TerrainParams> | undefined;
  if (
    !terrain ||
    typeof terrain.seed !== 'number' ||
    typeof terrain.baseHeight !== 'number' ||
    typeof terrain.hillAmplitude !== 'number' ||
    typeof terrain.mountainAmplitude !== 'number' ||
    typeof terrain.seaLevel !== 'number'
  ) {
    throw new Error('Save is missing a valid "terrain" block');
  }
  const materials = payload.materials as Partial<{ version: number; materials: unknown }> | undefined;
  if (!materials || materials.version !== MATERIAL_FORMAT_VERSION || !Array.isArray(materials.materials)) {
    throw new Error('Save is missing a valid "materials" block');
  }
  const edits = payload.edits as Record<string, unknown> | undefined;
  if (!edits || typeof edits !== 'object') throw new Error('Save is missing "edits"');
  for (const [key, entries] of Object.entries(edits)) {
    if (!Array.isArray(entries)) throw new Error(`Save edits for chunk ${key} are not an array`);
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !Number.isInteger(entry[0]) ||
        !Number.isInteger(entry[1])
      ) {
        throw new Error(`Save edits for chunk ${key} contain a malformed entry`);
      }
    }
  }
  const waterLevels = payload.waterLevels as Record<string, unknown> | undefined;
  if (!waterLevels || typeof waterLevels !== 'object') {
    throw new Error('Save is missing "waterLevels"');
  }
  for (const [key, entries] of Object.entries(waterLevels)) {
    if (!Array.isArray(entries)) throw new Error(`Save water levels for chunk ${key} are not an array`);
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !Number.isInteger(entry[0]) ||
        !Number.isInteger(entry[1]) ||
        entry[1] < 1 ||
        entry[1] > 254
      ) {
        throw new Error(`Save water levels for chunk ${key} contain a malformed entry`);
      }
    }
  }
  return payload as unknown as SerializedWorldV2;
}

/** Build a save payload from the live world (and its fluid state). */
export function serializeWorld(
  world: World,
  terrain: TerrainParams,
  savedAt = Date.now(),
  waterLevels: Record<string, [number, number][]> = {},
): SerializedWorldV2 {
  return {
    version: WORLD_FORMAT_VERSION,
    savedAt,
    seed: terrain.seed,
    terrain: { ...terrain },
    materials: JSON.parse(serializeMaterials()) as SerializedWorldV2['materials'],
    edits: world.exportEdits(),
    waterLevels,
  };
}

/**
 * Parse + migrate + validate a save string. The embedded material table
 * is checked against the live registry (same contract as
 * deserializeMaterials): a drifted table must fail the load, not load
 * into a world whose rendering/culling means something else.
 */
export function deserializeWorld(json: string): SerializedWorld {
  const migrated = migrateWorld(JSON.parse(json));
  deserializeMaterials(JSON.stringify(migrated.materials));
  return migrated;
}

/** Storage backend for saves. The browser impl wraps localStorage. */
export interface SaveStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  /** All keys currently in the store (without any backend prefix). */
  keys(): string[];
}

/** In-memory store for tests and headless use. */
export class MemorySaveStore implements SaveStore {
  private readonly map = new Map<string, string>();

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

export interface AutosaveOptions {
  /** Interval between saves in ms (a dirty save is never written sooner). */
  intervalMs: number;
}

/**
 * Autosave policy: save at most every `intervalMs`, and only when
 * something changed since the last save. Pure — the caller owns the clock
 * and the actual store write, so tests inject a fake `now`.
 */
export class AutosavePolicy {
  private dirty = false;
  private lastSaveAt: number;

  constructor(private readonly options: AutosaveOptions, now = 0) {
    this.lastSaveAt = now;
  }

  /** Mark the world as changed (call after any edit/load). */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Advance time. Returns true exactly when a save should happen now.
   * Saving resets the dirty flag and the timer; further edits re-arm it.
   */
  shouldSave(now: number): boolean {
    if (!this.dirty) return false;
    if (now - this.lastSaveAt < this.options.intervalMs) return false;
    this.dirty = false;
    this.lastSaveAt = now;
    return true;
  }
}
