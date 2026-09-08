import { describe, expect, it } from 'vitest';
import {
  AIR,
  DIRT,
  GRASS,
  MATERIALS,
  MATERIALS_BY_NAME,
  MATERIAL_FORMAT_VERSION,
  SAND,
  STONE,
  WATER,
  WOOD,
  deserializeMaterials,
  getMaterial,
  isOpaque,
  isSolidForCollision,
  materialByName,
  serializeMaterials,
} from '../src/voxel/materials';

describe('material registry', () => {
  it('has unique ids with air fixed at 0', () => {
    const ids = MATERIALS.map((m) => m.id);
    expect(new Set(ids).size).toBe(MATERIALS.length);
    expect(AIR).toBe(0);
    expect(getMaterial(AIR).name).toBe('air');
  });

  it('classifies materials correctly', () => {
    expect(isOpaque(AIR)).toBe(false);
    expect(isOpaque(WATER)).toBe(false);
    expect(isOpaque(STONE)).toBe(true);
    expect(isSolidForCollision(WATER)).toBe(false);
    expect(isSolidForCollision(GRASS)).toBe(true);
  });

  it('looks up by name round-trip', () => {
    for (const def of MATERIALS) {
      expect(materialByName(def.name)).toBe(def);
      expect(getMaterial(def.id).name).toBe(def.name);
    }
    expect(materialByName('unobtainium')).toBeUndefined();
    expect(MATERIALS_BY_NAME.size).toBe(MATERIALS.length);
  });

  it('falls back to air for unknown ids instead of crashing', () => {
    expect(getMaterial(999).name).toBe('air');
    expect(isOpaque(999)).toBe(false);
  });

  it('includes the phase 4 checklist materials', () => {
    const names = MATERIALS.map((m) => m.name);
    for (const name of ['air', 'grass', 'dirt', 'stone', 'sand', 'wood', 'water']) {
      expect(names).toContain(name);
    }
  });

  it('assigns distinct render colors', () => {
    const colors = MATERIALS.filter((m) => m.id !== AIR).map((m) => m.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('material serialization', () => {
  it('round-trips through JSON', () => {
    const json = serializeMaterials();
    const restored = deserializeMaterials(json);
    expect(restored).toEqual(MATERIALS);
  });

  it('embeds a format version', () => {
    const parsed = JSON.parse(serializeMaterials()) as { version: number };
    expect(parsed.version).toBe(MATERIAL_FORMAT_VERSION);
    expect(MATERIAL_FORMAT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('rejects version drift and tampered entries', () => {
    const json = serializeMaterials();
    const wrongVersion = { ...JSON.parse(json), version: 99 };
    expect(() => deserializeMaterials(JSON.stringify(wrongVersion))).toThrow(/version/i);

    const tampered = JSON.parse(json) as {
      materials: { id: number; name: string; color: number }[];
    };
    tampered.materials[STONE].name = 'not-stone';
    expect(() => deserializeMaterials(JSON.stringify(tampered))).toThrow(/does not match/i);
  });

  it('keeps SAND and WOOD ids distinct from neighbors', () => {
    expect(SAND).not.toBe(WOOD);
    expect(getMaterial(SAND).opaque).toBe(true);
  });

  it('treats DIRT consistently across lookup paths', () => {
    expect(materialByName('dirt')?.id).toBe(DIRT);
    expect(getMaterial(DIRT).opaque).toBe(true);
  });
});
