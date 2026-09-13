import { describe, expect, it } from 'vitest';
import { World } from '../src/voxel/world';
import { LightField, LIGHT_MAX } from '../src/voxel/light';
import { meshVolumeGreedy } from '../src/voxel/greedyMesher';
import { VoxelVolume } from '../src/voxel/voxelVolume';
import { AIR, GLASS, GENERATOR, STONE, WATER } from '../src/voxel/materials';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../src/voxel/coordinates';

/**
 * Phase 17 light field tests: sky columns and the free-fall rule,
 * lateral spread and attenuation, water/glass opacity, block-light
 * sources (add/remove/occlude/combine), chunk-boundary flow, static
 * emission, incremental-vs-full-recompute equivalence (the gold
 * property), determinism, budget behavior, and the mesher's light/AO
 * attributes and merge-signature behavior.
 */

/** Flat world: stone up to y=4, air above, chunks over x/z ∈ [-16, 32). */
function flatWorld(): { world: World; light: LightField } {
  const world = new World((chunk) => {
    if (chunk.coord.y !== 0) return; // ground lives in the lower layer only
    for (let ly = 0; ly <= 4; ly++)
      for (let lz = 0; lz < CHUNK_SIZE; lz++)
        for (let lx = 0; lx < CHUNK_SIZE; lx++) chunk.volume.set(lx, ly, lz, STONE);
  });
  const light = new LightField(world);
  for (let cy = 0; cy < 2; cy++)
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
  drain(light);
  return { world, light };
}

function drain(light: LightField): void {
  for (let i = 0; i < 1000 && light.pendingCount > 0; i++) light.tick(4096);
  expect(light.pendingCount).toBe(0);
}

/** All cells of all loaded chunks, as [x, y, z] tuples. */
function* cells(world: World): Generator<[number, number, number]> {
  for (const chunk of world.chunks.values()) {
    const { x: cx, y: cy, z: cz } = chunk.coord;
    for (let ly = 0; ly < CHUNK_SIZE; ly++)
      for (let lz = 0; lz < CHUNK_SIZE; lz++)
        for (let lx = 0; lx < CHUNK_SIZE; lx++)
          yield [cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly, cz * CHUNK_SIZE + lz];
  }
}

describe('sky light', () => {
  it('fills open sky columns and leaves solids dark', () => {
    const { light } = flatWorld();
    expect(light.skyAt(3, 30, 3)).toBe(LIGHT_MAX);
    expect(light.skyAt(3, 5, 3)).toBe(LIGHT_MAX); // just above the ground
    expect(light.skyAt(3, 4, 3)).toBe(0); // inside the ground
  });

  it('propagates 15 straight down through air (shafts stay bright)', () => {
    const { world, light } = flatWorld();
    // A walled shaft from y=5..28 at x=8,z=8.
    for (let y = 5; y <= 28; y++) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        world.setVoxel(8 + dx, y, 8 + dz, STONE);
      }
    }
    drain(light);
    expect(light.skyAt(8, 28, 8)).toBe(LIGHT_MAX);
    expect(light.skyAt(8, 6, 8)).toBe(LIGHT_MAX); // free fall all the way down
  });

  it('shades under an overhang with −1 lateral steps', () => {
    const { world, light } = flatWorld();
    // Slab at y=10 spanning x ∈ [5, 15], all z — the shade below its
    // center is fed from the open columns at x=4 and x=16.
    for (let x = 5; x <= 15; x++)
      for (let z = 0; z < CHUNK_SIZE; z++) world.setVoxel(x, 10, z, STONE);
    drain(light);
    expect(light.skyAt(4, 9, 8)).toBe(LIGHT_MAX); // beside the slab: open column
    expect(light.skyAt(5, 9, 8)).toBe(LIGHT_MAX - 1);
    expect(light.skyAt(10, 9, 8)).toBe(LIGHT_MAX - 6); // 5 steps in from x=4
    expect(light.skyAt(10, 8, 8)).toBe(LIGHT_MAX - 6); // fed laterally too, same row below
  });

  it('attenuates through water and glass', () => {
    const { world, light } = flatWorld();
    // A 3-deep pool: water at y=5..7 over the ground with walls holding it.
    for (let y = 5; y <= 7; y++)
      for (let z = 6; z <= 10; z++) for (let x = 6; x <= 10; x++) world.setVoxel(x, y, z, WATER);
    drain(light);
    expect(light.skyAt(8, 7, 8)).toBe(LIGHT_MAX - 2); // entering water costs 2
    expect(light.skyAt(8, 6, 8)).toBe(LIGHT_MAX - 4);
    expect(light.skyAt(8, 5, 8)).toBe(LIGHT_MAX - 6);

    // A glass pane roof: entering glass costs 1. The cell below reads 14,
    // not 13 — the lateral path from the open air beside the pane (−1)
    // beats the vertical one (through glass −1, then −1 again).
    world.setVoxel(20, 10, 3, GLASS);
    drain(light);
    expect(light.skyAt(20, 10, 3)).toBe(LIGHT_MAX - 1);
    expect(light.skyAt(20, 9, 3)).toBe(LIGHT_MAX - 1);
  });
});

describe('block light', () => {
  it('spreads from a source with −1 per step inside a sealed room', () => {
    const { world, light } = flatWorld();
    // Sealed box y=6..9, x/z=6..10 (walls solid, interior air) — no sky.
    for (let y = 6; y <= 9; y++)
      for (let z = 5; z <= 11; z++)
        for (let x = 5; x <= 11; x++) {
          const shell = x === 5 || x === 11 || z === 5 || z === 11 || y === 6 || y === 9;
          if (shell) world.setVoxel(x, y, z, STONE);
        }
    light.setSource(8, 8, 8, LIGHT_MAX);
    drain(light);
    expect(light.blockAt(8, 8, 8)).toBe(LIGHT_MAX);
    expect(light.blockAt(9, 8, 8)).toBe(LIGHT_MAX - 1);
    expect(light.blockAt(8, 8, 5)).toBe(0); // inside the wall: no light
    expect(light.skyAt(8, 8, 8)).toBe(0); // roofed: no sky either
  });

  it('removing a source darkens the whole field again', () => {
    const { light } = flatWorld();
    light.setSource(0, 8, 0, 12);
    drain(light);
    expect(light.blockAt(3, 8, 0)).toBe(9);
    light.setSource(0, 8, 0, 0);
    drain(light);
    expect(light.blockAt(0, 8, 0)).toBe(0);
    expect(light.blockAt(3, 8, 0)).toBe(0);
  });

  it('occludes block light with walls', () => {
    const { world, light } = flatWorld();
    // Wall at x=2 (y=6..10, z=-1..1), source west of it.
    for (let y = 6; y <= 10; y++) for (let z = -1; z <= 1; z++) world.setVoxel(2, y, z, STONE);
    light.setSource(0, 8, 0, 12);
    drain(light);
    // Beside the source: −1. East of the wall the direct path is gone —
    // light only arrives the long way around (over y=11+), much dimmer.
    expect(light.blockAt(1, 8, 0)).toBe(11);
    expect(light.blockAt(4, 8, 0)).toBeLessThanOrEqual(12 - 8);
  });

  it('keeps the maximum of overlapping sources', () => {
    const { light } = flatWorld();
    light.setSource(-6, 8, 0, 10);
    light.setSource(6, 8, 0, 10);
    drain(light);
    expect(light.blockAt(0, 8, 0)).toBeGreaterThanOrEqual(4); // lit from both sides
    expect(light.blockAt(-5, 8, 0)).toBe(9);
  });

  it('sources in unloaded chunks wait for initialization', () => {
    const world = new World(() => {});
    const light = new LightField(world);
    light.setSource(2, 8, 2, 12);
    world.ensureChunk(0, 0, 0);
    drain(light);
    expect(light.blockAt(2, 8, 2)).toBe(12);
    expect(light.blockAt(3, 8, 2)).toBe(11);
  });
});

describe('static emission and chunk boundaries', () => {
  it('a placed generator glows (emissionOf path)', () => {
    const { world, light } = flatWorld();
    world.setVoxel(3, 5, 3, GENERATOR);
    drain(light);
    expect(light.blockAt(3, 5, 3)).toBe(7);
    expect(light.blockAt(4, 5, 3)).toBe(6);
    world.setVoxel(3, 5, 3, AIR);
    drain(light);
    expect(light.blockAt(3, 5, 3)).toBe(0);
    expect(light.blockAt(4, 5, 3)).toBe(0);
  });

  it('generated generators glow (init scan path)', () => {
    const world = new World((chunk) => {
      if (chunk.coord.x === 0 && chunk.coord.y === 0 && chunk.coord.z === 0) {
        chunk.volume.set(14, 6, 2, GENERATOR); // 2 cells west of the border
      }
    });
    const light = new LightField(world);
    world.ensureChunk(0, 0, 0);
    world.ensureChunk(1, 0, 0);
    drain(light);
    expect(light.blockAt(14, 6, 2)).toBe(7);
    expect(light.blockAt(CHUNK_SIZE, 6, 2)).toBe(5); // across the border, −2
    expect(light.blockAt(CHUNK_SIZE + 1, 6, 2)).toBe(4);
  });

  it('light crosses chunk boundaries in both directions', () => {
    const { world, light } = flatWorld();
    // Roofed room straddling the x=0 chunk border: one source inside.
    for (let y = 6; y <= 9; y++)
      for (let z = -2; z <= 2; z++) {
        world.setVoxel(-1, y, z, STONE);
        world.setVoxel(2, y, z, STONE);
        world.setVoxel(
          0,
          y,
          z === 0 ? 0 : z,
          y === 9 || y === 6 || Math.abs(z) === 2 ? STONE : AIR,
        );
      }
    light.setSource(0, 7, 0, LIGHT_MAX);
    drain(light);
    expect(light.blockAt(0, 7, 0)).toBe(LIGHT_MAX);
    expect(light.blockAt(1, 7, 1)).toBe(LIGHT_MAX - 2); // diagonal inside
    // And sky light from an open column in one chunk feeds a cave mouth
    // in the neighbor: dig a shaft at x=-5, check light under the border.
    for (let y = 5; y <= 12; y++) world.setVoxel(-5, y, 0, AIR);
    drain(light);
    expect(light.skyAt(-5, 5, 0)).toBe(LIGHT_MAX);
  });

  it('uninitialized chunks read as full sky (streaming default)', () => {
    const world = new World(() => {});
    const light = new LightField(world);
    expect(light.skyAt(500, 20, 500)).toBe(LIGHT_MAX);
    expect(light.blockAt(500, 20, 500)).toBe(0);
    expect(light.packedAt(500, 20, 500)).toBe((LIGHT_MAX << 4) | 0);
  });
});

describe('incremental equals full recompute', () => {
  it('matches a from-scratch field after 60 random edits (two channels)', () => {
    // Seeded LCG — reproducible without Math.random.
    let s = 0x2f6e2b1;
    const rand = (n: number) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s % n;
    };

    const build = () => {
      const world = new World(() => {});
      const light = new LightField(world);
      for (let cy = 0; cy < 2; cy++)
        for (let cz = -1; cz <= 1; cz++)
          for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
      return { world, light };
    };
    const a = build();

    // Terrain-ish blob: a hilly stone mass with some water pockets.
    for (let x = -12; x <= 12; x++)
      for (let z = -12; z <= 12; z++) {
        const h = 6 + (Math.abs((x * 7 + z * 13) % 5) % 5);
        for (let y = 0; y <= h; y++) a.world.setVoxel(x, y, z, STONE);
        if ((x * 31 + z * 17) % 11 === 0) a.world.setVoxel(x, h, z, WATER);
      }
    drain(a.light);
    // Sprinkle an arch, a room, and a lamp-ish source.
    for (let x = -3; x <= 3; x++) a.world.setVoxel(x, 10, 0, STONE);
    for (let y = 8; y <= 9; y++) a.world.setVoxel(0, y, 0, AIR);
    a.light.setSource(0, 8, 0, 12);

    // 60 random edits: place stone, dig air, pour water, drop glass.
    const mats = [STONE, AIR, WATER, GLASS];
    for (let i = 0; i < 60; i++) {
      const x = rand(25) - 12;
      const y = 1 + rand(WORLD_HEIGHT - 4);
      const z = rand(25) - 12;
      a.world.setVoxel(x, y, z, mats[rand(mats.length)]);
      drain(a.light);
    }

    // Reference: identical voxels AND sources, field computed from scratch.
    const edits = a.world.exportEdits();
    const bWorld = new World(() => {});
    const bLight = new LightField(bWorld);
    bWorld.loadEdits(edits);
    bLight.setSource(0, 8, 0, 12);
    for (let cy = 0; cy < 2; cy++)
      for (let cz = -1; cz <= 1; cz++)
        for (let cx = -1; cx <= 1; cx++) bWorld.ensureChunk(cx, cy, cz);
    drain(bLight);

    const divergences: string[] = [];
    for (const [x, y, z] of cells(a.world)) {
      const as = a.light.skyAt(x, y, z);
      const bs = bLight.skyAt(x, y, z);
      const ab = a.light.blockAt(x, y, z);
      const bb = bLight.blockAt(x, y, z);
      if (as !== bs || ab !== bb) {
        divergences.push(
          `(${x},${y},${z}) sky ${as} vs ${bs}, block ${ab} vs ${bb}` +
            ` voxel ${a.world.getVoxel(x, y, z)}`,
        );
        if (divergences.length >= 5) break;
      }
    }
    expect(divergences).toEqual([]);
  });
});

describe('determinism and budget', () => {
  it('same edits in the same order give byte-identical fields', () => {
    const build = () => {
      const world = new World(() => {});
      const light = new LightField(world);
      for (let cy = 0; cy < 2; cy++)
        for (let cz = -1; cz <= 1; cz++)
          for (let cx = -1; cx <= 1; cx++) world.ensureChunk(cx, cy, cz);
      return { world, light };
    };
    const a = build();
    const b = build();
    for (const w of [a.world, b.world]) {
      for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) w.setVoxel(x, 9, z, STONE);
      for (let y = 5; y <= 8; y++) w.setVoxel(3, y, 3, AIR);
    }
    a.light.setSource(3, 8, 3, 13);
    b.light.setSource(3, 8, 3, 13);
    drain(a.light);
    drain(b.light);
    for (const [x, y, z] of cells(a.world)) {
      expect(a.light.skyAt(x, y, z)).toBe(b.light.skyAt(x, y, z));
      expect(a.light.blockAt(x, y, z)).toBe(b.light.blockAt(x, y, z));
    }
  });

  it('a budget of 1 drains pop by pop', () => {
    const { light } = flatWorld();
    light.setSource(0, 8, 0, 10);
    expect(light.pendingCount).toBeGreaterThan(0);
    let guard = 0;
    while (light.pendingCount > 0 && guard++ < 10_000) light.tick(1);
    expect(light.pendingCount).toBe(0);
    expect(light.blockAt(2, 8, 0)).toBe(8);
  });
});

describe('mesher light and AO', () => {
  it('emits aLight per vertex and splits quads on light boundaries', () => {
    const volume = new VoxelVolume(4);
    // Two floor tiles at y=0; different light over each half.
    for (let z = 0; z < 2; z++) for (let x = 0; x < 4; x++) volume.set(x, 0, z, STONE);
    const light = (x: number): number => ((x < 2 ? 15 : 8) << 4) | 3;

    const withoutLight = meshVolumeGreedy(volume, () => AIR);
    expect(withoutLight.opaque.light).toBeUndefined();
    // A free-floating 4×2 slab: top + bottom + four sides, all merged.
    expect(withoutLight.opaque.quadCount).toBe(6);

    const mesh = meshVolumeGreedy(volume, () => AIR, undefined, light);
    // The light boundary splits every face that crosses x=2 (top, bottom,
    // and the z-sides); the x-sides sit fully in one light zone each.
    expect(mesh.opaque.quadCount).toBeGreaterThan(6);
    expect(mesh.opaque.light!.length).toBe((mesh.opaque.positions.length / 3) * 2);
    expect(mesh.opaque.ao!.length).toBe(mesh.opaque.positions.length / 3);
    // Vertex light is normalized by 15 — the first quad (low x) is sky
    // 15 / block 3.
    expect(mesh.opaque.light![0]).toBeCloseTo(1.0, 5);
    expect(mesh.opaque.light![1]).toBeCloseTo(3 / 15, 5);
  });

  it('AO darkens corners against a pillar on the floor', () => {
    const volume = new VoxelVolume(8);
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) volume.set(x, 0, z, STONE);
    // A pillar on the floor: the floor quads around it carry AO.
    volume.set(4, 1, 4, STONE);
    const uniformLight = () => (LIGHT_MAX << 4) | 0;
    const mesh = meshVolumeGreedy(volume, () => AIR, undefined, uniformLight);
    // The floor can no longer merge across the pillar's neighborhood
    // (corner AO differs), so there are several quads — and at least one
    // vertex is darker than full AO.
    expect(mesh.opaque.quadCount).toBeGreaterThan(1);
    let darkest = 3;
    for (let i = 0; i < mesh.opaque.ao!.length; i++) {
      darkest = Math.min(darkest, Math.round(mesh.opaque.ao![i] * 3));
    }
    expect(darkest).toBeLessThan(3);
  });

  it('water pass carries light but no AO', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 1, 1, WATER);
    const mesh = meshVolumeGreedy(
      volume,
      () => AIR,
      undefined,
      () => (12 << 4) | 5,
    );
    expect(mesh.water.quadCount).toBeGreaterThan(0);
    expect(mesh.water.light!.length).toBe((mesh.water.positions.length / 3) * 2);
    expect(mesh.water.ao).toBeUndefined();
  });
});
