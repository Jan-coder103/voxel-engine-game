import { describe, expect, it } from 'vitest';
import { meshVolume } from '../src/voxel/mesher';
import { meshVolumeGreedy } from '../src/voxel/greedyMesher';
import type { ChunkMesh, MeshData } from '../src/voxel/mesher';
import { VoxelVolume, type VoxelData } from '../src/voxel/voxelVolume';
import { AIR, DIRT, GRASS, SAND, STONE, WATER } from '../src/voxel/materials';
import { Chunk } from '../src/voxel/chunk';
import { World } from '../src/voxel/world';
import { generateChunk, DEFAULT_TERRAIN, mulberry32 } from '../src/voxel/terrain';

const localQuery = (volume: VoxelData) => (x: number, y: number, z: number) =>
  volume.getOrAir(x, y, z);

/**
 * Split a mesh into its multiset of unit faces: one key per (cell,
 * facing, material). Greedy and naive meshes of the same volume must
 * produce identical multisets — merging changes quad topology only.
 */
function unitFaceSet(mesh: ChunkMesh): Map<string, number> {
  const faces = new Map<string, number>();
  const add = (pass: MeshData) => {
    for (let q = 0; q < pass.quadCount; q++) {
      const v0 = q * 4;
      const p = (i: number) => [
        pass.positions[(v0 + i) * 3],
        pass.positions[(v0 + i) * 3 + 1],
        pass.positions[(v0 + i) * 3 + 2],
      ];
      const [x0, y0, z0] = p(0);
      const [x1, y1, z1] = p(1);
      const [x2, y2, z2] = p(2);
      const nx = pass.normals[v0 * 3];
      const ny = pass.normals[v0 * 3 + 1];
      const nz = pass.normals[v0 * 3 + 2];
      const material = pass.materialIds[v0];

      // Axis-aligned rectangle: bounds per axis from the 4 corners.
      const xs = [x0, x1, x2, pass.positions[(v0 + 3) * 3]];
      const ys = [y0, y1, y2, pass.positions[(v0 + 3) * 3 + 1]];
      const zs = [z0, z1, z2, pass.positions[(v0 + 3) * 3 + 2]];
      const min = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
      const max = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];

      // The face plane sits on the + side of the cells for dir +1.
      const cellD =
        nx === 1
          ? min[0] - 1
          : ny === 1
            ? min[1] - 1
            : nz === 1
              ? min[2] - 1
              : nx === -1
                ? min[0]
                : ny === -1
                  ? min[1]
                  : min[2];
      for (let a = min[0]; a < (nx !== 0 ? min[0] + 1 : max[0]); a++) {
        for (let b = min[1]; b < (ny !== 0 ? min[1] + 1 : max[1]); b++) {
          for (let c = min[2]; c < (nz !== 0 ? min[2] + 1 : max[2]); c++) {
            const cx = nx !== 0 ? cellD : a;
            const cy = ny !== 0 ? cellD : b;
            const cz = nz !== 0 ? cellD : c;
            const key = `${cx},${cy},${cz}|${nx},${ny},${nz}|${material}`;
            faces.set(key, (faces.get(key) ?? 0) + 1);
          }
        }
      }
    }
  };
  add(mesh.opaque);
  add(mesh.water);
  return faces;
}

function expectSameFaces(a: ChunkMesh, b: ChunkMesh, context: string): void {
  const fa = unitFaceSet(a);
  const fb = unitFaceSet(b);
  expect(fa.size, context).toBe(fb.size);
  for (const [key, count] of fa) {
    expect(fb.get(key), `${context}: ${key}`).toBe(count);
  }
}

describe('meshVolumeGreedy — correctness', () => {
  it('matches the naive mesher on a single voxel', () => {
    const volume = new VoxelVolume(4);
    volume.set(1, 2, 1, STONE);
    expectSameFaces(
      meshVolumeGreedy(volume, localQuery(volume)),
      meshVolume(volume, localQuery(volume)),
      'single',
    );
  });

  it('merges a solid volume to 6 quads (naive needs many more)', () => {
    const volume = new VoxelVolume(8);
    volume.fill(STONE);
    const greedy = meshVolumeGreedy(volume, localQuery(volume));
    expect(greedy.opaque.quadCount).toBe(6);
    expect(meshVolume(volume, localQuery(volume)).opaque.quadCount).toBe(6 * 8 * 8);
  });

  it('emits one quad per face in the checkerboard worst case', () => {
    const volume = new VoxelVolume(8);
    for (let z = 0; z < 8; z++)
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          if ((x + y + z) % 2 === 0) volume.set(x, y, z, STONE);
        }
    const greedy = meshVolumeGreedy(volume, localQuery(volume));
    const naive = meshVolume(volume, localQuery(volume));
    expect(greedy.opaque.quadCount).toBe(naive.opaque.quadCount);
    expectSameFaces(greedy, naive, 'checker');
  });

  it('keeps water faces in the water pass and merged', () => {
    const volume = new VoxelVolume(4);
    for (let z = 0; z < 3; z++)
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) volume.set(x, y, z, WATER);
    const mesh = meshVolumeGreedy(volume, localQuery(volume));
    expect(mesh.opaque.quadCount).toBe(0);
    expect(mesh.water.quadCount).toBe(6); // one quad per cube side
  });

  it('winds every quad CCW against its stored normal (both facings)', () => {
    const rng = mulberry32(777);
    const volume = new VoxelVolume(8);
    for (let z = 0; z < 8; z++)
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const r = rng();
          volume.set(x, y, z, r < 0.4 ? STONE : r < 0.5 ? WATER : AIR);
        }
    const mesh = meshVolumeGreedy(volume, localQuery(volume));
    for (const pass of [mesh.opaque, mesh.water]) {
      for (let q = 0; q < pass.quadCount; q++) {
        const v = q * 12;
        const e1 = [
          pass.positions[v + 3] - pass.positions[v],
          pass.positions[v + 4] - pass.positions[v + 1],
          pass.positions[v + 5] - pass.positions[v + 2],
        ];
        const e2 = [
          pass.positions[v + 6] - pass.positions[v],
          pass.positions[v + 7] - pass.positions[v + 1],
          pass.positions[v + 8] - pass.positions[v + 2],
        ];
        const cross = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ];
        const dot =
          cross[0] * pass.normals[v] +
          cross[1] * pass.normals[v + 1] +
          cross[2] * pass.normals[v + 2];
        expect(dot).toBeGreaterThan(0);
      }
    }
  });
});

describe('meshVolumeGreedy — equivalence with the naive baseline', () => {
  it('matches on 40 random mixed volumes', () => {
    const rng = mulberry32(20260909);
    const materials = [AIR, AIR, GRASS, DIRT, STONE, SAND, WATER];
    for (let trial = 0; trial < 40; trial++) {
      const volume = new VoxelVolume(8);
      for (let z = 0; z < 8; z++)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            volume.set(x, y, z, materials[Math.floor(rng() * materials.length)]);
          }
      expectSameFaces(
        meshVolumeGreedy(volume, localQuery(volume)),
        meshVolume(volume, localQuery(volume)),
        `random trial ${trial}`,
      );
    }
  });

  it('matches on real terrain chunks (packed chunk storage)', () => {
    for (const [cx, cz] of [
      [0, 0],
      [-1, 2],
      [3, -4],
    ] as const) {
      const chunk = new Chunk({ x: cx, y: 0, z: cz });
      generateChunk(chunk, DEFAULT_TERRAIN);
      const query = localQuery(chunk.volume);
      expectSameFaces(
        meshVolumeGreedy(chunk.volume, query),
        meshVolume(chunk.volume, query),
        `terrain chunk ${cx},${cz}`,
      );
    }
  });

  it('matches when meshing across chunk borders via the world query', () => {
    const world = new World((chunk) => generateChunk(chunk, DEFAULT_TERRAIN));
    // Two adjacent columns so the shared boundary has real terrain faces.
    world.ensureChunk(0, 0, 0);
    world.ensureChunk(1, 0, 0);
    for (const coord of [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]) {
      const chunk = world.getChunk(coord.x, coord.y, coord.z)!;
      const origin = chunk.origin;
      const worldQuery = (lx: number, ly: number, lz: number) =>
        world.getVoxel(origin.x + lx, origin.y + ly, origin.z + lz);
      expectSameFaces(
        meshVolumeGreedy(chunk.volume, worldQuery),
        meshVolume(chunk.volume, worldQuery),
        `world chunk ${coord.x},${coord.z}`,
      );
    }
  });
});

describe('meshVolumeGreedy — water flow height (Phase 9)', () => {
  it('sinks surfaced water top faces by (255 − level)/255 and keeps submerged full', () => {
    const volume = new VoxelVolume(4);
    // A full column (submerged except the top) plus a half-full puddle.
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 2; z++) for (let x = 0; x < 2; x++) volume.set(x, y, z, WATER);
    volume.set(2, 0, 0, WATER);
    const level = (x: number, y: number) => (y === 0 && x === 2 ? 128 : 255);
    const mesh = meshVolumeGreedy(volume, localQuery(volume), level);
    expect(mesh.water.waterDrop).toBeDefined();

    // Top face of the 2×2 column: full cells (level 255) → drop 0.
    // The puddle at (2,0,0): level 128 → drop (255-128)/255.
    const expectedPuddleDrop = (255 - 128) / 255;
    const topFaces: number[][] = [];
    for (let q = 0; q < mesh.water.quadCount; q++) {
      const v0 = q * 4;
      const ny = mesh.water.normals[v0 * 3 + 1];
      const dir = mesh.water.normals[v0 * 3 + 1];
      const y = mesh.water.positions[v0 * 3 + 1];
      if (ny === 1 && dir === 1) topFaces.push([q, y]);
    }
    // Two +Y quads: the column top (drop 0 everywhere) and the puddle top.
    expect(topFaces.length).toBeGreaterThanOrEqual(2);
    const dropsAt = (q: number) => {
      const drops: number[] = [];
      for (let i = 0; i < 4; i++) drops.push(mesh.water.waterDrop![q * 4 + i]);
      return drops;
    };
    const columnTop = topFaces.find(([, y]) => y === 3)!;
    const puddleTop = topFaces.find(([, y]) => y === 1)!;
    expect(dropsAt(columnTop[0])).toEqual([0, 0, 0, 0]);
    for (const d of dropsAt(puddleTop[0]))
      expect(Math.abs(d - expectedPuddleDrop)).toBeLessThan(1e-6);

    // Submerged cells (water above): no drop on their side faces either —
    // the column interior emits nothing; only the surface matters.
    const anyDrop = Array.from(mesh.water.waterDrop!).some((d) => d > 0);
    expect(anyDrop).toBe(true); // the puddle contributed drops
  });

  it('water levels never change the emitted face set (equivalence holds)', () => {
    const volume = new VoxelVolume(6);
    const rng = mulberry32(4242);
    for (let z = 0; z < 6; z++)
      for (let y = 0; y < 6; y++)
        for (let x = 0; x < 6; x++) {
          const r = rng();
          volume.set(x, y, z, r < 0.3 ? STONE : r < 0.55 ? WATER : AIR);
        }
    const level = (x: number, y: number, z: number) => Math.floor(hashish(x, y, z) * 255);
    const withLevels = meshVolumeGreedy(volume, localQuery(volume), level);
    const without = meshVolumeGreedy(volume, localQuery(volume));
    expectSameFaces(withLevels, without, 'levels do not change faces');
  });

  it('side faces of a surfaced cell drop only their top edge', () => {
    const volume = new VoxelVolume(2);
    volume.set(0, 0, 0, WATER); // lone half-full cell on bedrock-less air
    volume.set(0, 0, 1, STONE); // support so only +X / -X / +Y faces emit against air
    const mesh = meshVolumeGreedy(volume, localQuery(volume), () => 51); // drop = 0.8
    for (let q = 0; q < mesh.water.quadCount; q++) {
      const drops = [0, 1, 2, 3].map((i) => mesh.water.waterDrop![q * 4 + i]);
      const ys = [0, 1, 2, 3].map((i) => mesh.water.positions[(q * 4 + i) * 3 + 1]);
      const ny = mesh.water.normals[q * 4 * 3 + 1];
      const topY = Math.max(...ys);
      if (ny === -1) {
        // Undersides stay square (the drop only sinks top edges).
        expect(drops).toEqual([0, 0, 0, 0]);
        continue;
      }
      for (let i = 0; i < 4; i++) {
        if (ys[i] === topY) expect(drops[i]).toBeCloseTo(0.8, 6);
        else expect(drops[i]).toBe(0);
      }
    }
  });
});

/** Cheap deterministic stand-in level function for equivalence testing. */
function hashish(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 2246822519) + Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
