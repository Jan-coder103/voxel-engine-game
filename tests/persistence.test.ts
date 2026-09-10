import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { DEFAULT_TERRAIN, type TerrainParams, generateChunk } from '../src/voxel/terrain';
import { GRASS, STONE } from '../src/voxel/materials';
import {
  AutosavePolicy,
  deserializeWorld,
  MemorySaveStore,
  migrateWorld,
  serializeWorld,
  WORLD_FORMAT_VERSION,
} from '../src/voxel/persistence';

const TERRAIN: TerrainParams = { ...DEFAULT_TERRAIN, seed: 99 };

function worldWithEdits(): World {
  const world = new World((chunk) => generateChunk(chunk, TERRAIN));
  world.ensureChunk(0, 0, 0);
  world.ensureChunk(0, 1, 0); // upper layer (y 16–31)
  world.setVoxel(2, 12, 3, GRASS); // chunk (0,0,0)
  world.setVoxel(3, 20, 3, STONE); // chunk (0,1,0)
  return world;
}

describe('world serialization (v1)', () => {
  it('round-trips seed, terrain, and edits through JSON', () => {
    const source = worldWithEdits();
    const json = JSON.stringify(serializeWorld(source, TERRAIN, 1234));

    const data = deserializeWorld(json);
    expect(data.version).toBe(WORLD_FORMAT_VERSION);
    expect(data.seed).toBe(TERRAIN.seed);
    expect(data.terrain).toEqual(TERRAIN);
    expect(data.savedAt).toBe(1234);
    expect(Object.keys(data.edits).sort()).toEqual(['0,0,0', '0,1,0']);

    const restored = new World((chunk) => generateChunk(chunk, TERRAIN));
    restored.loadEdits(data.edits);
    restored.ensureChunk(0, 0, 0);
    restored.ensureChunk(0, 1, 0);
    expect(restored.getVoxel(2, 12, 3)).toBe(GRASS);
    expect(restored.getVoxel(3, 20, 3)).toBe(STONE);
    // Untouched terrain still regenerates from the seed.
    expect(restored.getVoxel(5, 1, 5)).not.toBe(0);
  });

  it('an empty world serializes to an empty edit map', () => {
    const world = new World((chunk) => generateChunk(chunk, TERRAIN));
    world.ensureChunk(0, 0, 0);
    const data = deserializeWorld(JSON.stringify(serializeWorld(world, TERRAIN)));
    expect(data.edits).toEqual({});
  });

  it('edits that write back the original material still persist as set', () => {
    // Journal stores applied values (not diffs vs the generator), so a
    // "revert by hand" stays stable across future generator changes.
    const world = worldWithEdits();
    world.setVoxel(2, 12, 3, 5); // overwrite with a different material (wood)
    const data = deserializeWorld(JSON.stringify(serializeWorld(world, TERRAIN)));
    const entries = data.edits['0,0,0']!;
    expect(entries).toContainEqual([world.getChunk(0, 0, 0)!.volume.index(2, 12, 3), 5]);
  });
});

describe('save migration + validation', () => {
  it('passes a current-version payload through unchanged', () => {
    const payload = JSON.parse(JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN)));
    expect(migrateWorld(payload)).toEqual(payload);
  });

  it('migrates a v1 save to v2 with empty fluid levels', () => {
    const v1 = JSON.parse(JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN)));
    v1.version = 1;
    delete v1.waterLevels;
    const migrated = migrateWorld(v1);
    expect(migrated.version).toBe(2);
    expect(migrated.waterLevels).toEqual({});
    expect(migrated.edits).toEqual(v1.edits);
  });

  it('rejects a newer save version with a clear error', () => {
    const payload = {
      ...JSON.parse(JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN))),
      version: 99,
    };
    expect(() => migrateWorld(payload)).toThrow(/newer than this build/);
  });

  it('rejects an older version with no migration path', () => {
    const payload = {
      ...JSON.parse(JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN))),
      version: 0,
    };
    expect(() => migrateWorld(payload)).toThrow(/No migration path from save version 0/);
  });

  it('rejects payloads missing required blocks', () => {
    expect(() => migrateWorld({ version: 2 })).toThrow(/seed/);
    expect(() => migrateWorld({ version: 2, seed: 1 })).toThrow(/terrain/);
    expect(() => migrateWorld({ version: 2, seed: 1, terrain: TERRAIN })).toThrow(/materials/);
    expect(() =>
      migrateWorld({
        version: 2,
        seed: 1,
        terrain: TERRAIN,
        materials: { version: 1, materials: [] },
      }),
    ).toThrow(/edits/);
    expect(() =>
      migrateWorld({
        version: 2,
        seed: 1,
        terrain: TERRAIN,
        materials: { version: 1, materials: [] },
        edits: {},
      }),
    ).toThrow(/waterLevels/);
  });

  it('rejects malformed edit entries', () => {
    const payload = JSON.parse(JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN)));
    payload.edits['0,0,0'] = [[1, 2, 3]]; // [index, material, junk]
    expect(() => migrateWorld(payload)).toThrow(/malformed/);
  });

  it('rejects malformed fluid level entries (0/255/non-integer)', () => {
    for (const bad of [0, 255, -1, 1.5]) {
      const payload = JSON.parse(JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN)));
      payload.waterLevels = { '0,0,0': [[3, bad]] };
      expect(() => migrateWorld(payload)).toThrow(/water levels.*malformed/);
    }
  });

  it('round-trips fluid levels through serialize/deserialize', () => {
    const levels: Record<string, [number, number][]> = {
      '0,0,0': [
        [5, 200],
        [130, 1],
      ],
    };
    const data = deserializeWorld(
      JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN, 1234, levels)),
    );
    expect(data.waterLevels).toEqual(levels);
  });

  it('deserializeWorld fails on a corrupted material table', () => {
    const payload = JSON.parse(JSON.stringify(serializeWorld(worldWithEdits(), TERRAIN)));
    payload.materials.materials[1].color = 0xff00ff; // grass recolored
    expect(() => deserializeWorld(JSON.stringify(payload))).toThrow(/does not match registry/);
  });

  it('deserializeWorld fails cleanly on truncated JSON', () => {
    expect(() => deserializeWorld('{"version":1,')).toThrow();
  });
});

describe('SaveStore + AutosavePolicy', () => {
  it('memory store get/set/delete', () => {
    const store = new MemorySaveStore();
    expect(store.get('k')).toBeUndefined();
    store.set('k', 'v1');
    expect(store.get('k')).toBe('v1');
    store.set('k', 'v2');
    expect(store.get('k')).toBe('v2');
    store.delete('k');
    expect(store.get('k')).toBeUndefined();
  });

  it('autosave fires only when dirty and the interval has elapsed', () => {
    const autosave = new AutosavePolicy({ intervalMs: 10_000 }, 0);
    expect(autosave.shouldSave(5_000)).toBe(false); // not dirty

    autosave.markDirty();
    expect(autosave.shouldSave(5_000)).toBe(false); // too soon
    expect(autosave.shouldSave(10_000)).toBe(true); // due now

    expect(autosave.shouldSave(15_000)).toBe(false); // saved, not dirty again
    autosave.markDirty();
    expect(autosave.shouldSave(19_999)).toBe(false); // re-armed at 10s
    expect(autosave.shouldSave(20_000)).toBe(true);
  });
});
