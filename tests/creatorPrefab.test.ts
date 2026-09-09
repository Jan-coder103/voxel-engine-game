import { describe, expect, it } from 'vitest';
import { AIR, DIRT, STONE } from '../src/voxel/materials';
import { MemorySaveStore } from '../src/voxel/persistence';
import { serializePrefab, deserializePrefab, PrefabLibrary } from '../src/creator/prefab';
import type { ClipboardVolume } from '../src/creator/clipboard';

function testClip(): ClipboardVolume {
  // 3×2×2 with a stone slab and one air pocket.
  const voxels = new Uint16Array(12).fill(DIRT);
  voxels[0] = STONE;
  voxels[7] = AIR;
  return { size: { x: 3, y: 2, z: 2 }, voxels };
}

describe('prefab serialization', () => {
  it('round-trips a volume through JSON', () => {
    const clip = testClip();
    const json = JSON.stringify(serializePrefab(clip, 'hut', 1234));
    const { name, clip: restored } = deserializePrefab(json);
    expect(name).toBe('hut');
    expect(restored.size).toEqual(clip.size);
    expect([...restored.voxels]).toEqual([...clip.voxels]);
  });

  it('serializes compactly via RLE', () => {
    const clip = { size: { x: 8, y: 8, z: 8 }, voxels: new Uint16Array(512) };
    clip.voxels[100] = STONE;
    const payload = serializePrefab(clip, 'rle');
    expect(payload.runs.length).toBeLessThanOrEqual(6); // air run, stone, air run
    expect(payload.solidVoxels).toBe(1);
  });

  it('rejects a wrong version', () => {
    const payload = serializePrefab(testClip(), 'v');
    const json = JSON.stringify({ ...payload, version: 99 });
    expect(() => deserializePrefab(json)).toThrow(/version/);
  });

  it('rejects runs that overflow or underflow the declared size', () => {
    const base = serializePrefab(testClip(), 'v');
    expect(() =>
      deserializePrefab(JSON.stringify({ ...base, size: { x: 2, y: 2, z: 2 } })),
    ).toThrow(/overflow|cover/);
    const truncated = { ...base, runs: base.runs.slice(0, base.runs.length - 2) };
    expect(() => deserializePrefab(JSON.stringify(truncated))).toThrow(/cover/);
    const odd = { ...base, runs: [...base.runs, 1] };
    expect(() => deserializePrefab(JSON.stringify(odd))).toThrow(/even-length/);
  });

  it('rejects a malformed solid count', () => {
    const base = serializePrefab(testClip(), 'v');
    expect(() => deserializePrefab(JSON.stringify({ ...base, solidVoxels: 999 }))).toThrow(
      /solid voxel/,
    );
  });
});

describe('PrefabLibrary', () => {
  it('saves, lists, loads, and deletes prefabs without touching other keys', () => {
    const store = new MemorySaveStore();
    store.set('autosave', '{}');
    const library = new PrefabLibrary(store);

    library.save(testClip(), 'arch');
    library.save({ size: { x: 1, y: 1, z: 1 }, voxels: new Uint16Array([STONE]) }, 'pillar');

    expect(library.list()).toEqual(['arch', 'pillar']);
    expect(store.get('autosave')).toBe('{}');

    const loaded = library.load('arch')!;
    expect(loaded.size).toEqual({ x: 3, y: 2, z: 2 });
    expect([...loaded.voxels]).toEqual([...testClip().voxels]);

    library.delete('arch');
    expect(library.list()).toEqual(['pillar']);
    expect(library.load('arch')).toBeUndefined();
  });

  it('reads a corrupt prefab as undefined instead of throwing', () => {
    const store = new MemorySaveStore();
    const library = new PrefabLibrary(store);
    store.set('prefab:broken', '{not json');
    expect(library.load('broken')).toBeUndefined();
  });

  it('air prefabs survive the empty-run encoding', () => {
    const clip: ClipboardVolume = { size: { x: 2, y: 2, z: 2 }, voxels: new Uint16Array(8) };
    const json = JSON.stringify(serializePrefab(clip, 'empty'));
    const restored = deserializePrefab(json);
    expect(restored.clip.voxels.every((v) => v === AIR)).toBe(true);
  });
});
