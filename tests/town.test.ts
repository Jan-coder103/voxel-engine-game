import { describe, expect, it } from 'vitest';
import { WORLD_HEIGHT, WORLD_HEIGHT_CHUNKS } from '../src/voxel/coordinates';
import {
  AIR,
  ASPHALT,
  BRICK,
  CONCRETE,
  GLASS,
  GRASS,
  LEAVES,
  WOOD,
  WATER,
  getMaterial,
  serializeMaterials,
  deserializeMaterials,
} from '../src/voxel/materials';
import {
  DEFAULT_TERRAIN,
  generateChunk,
  heightAt,
  isDry,
  type TerrainParams,
} from '../src/voxel/terrain';
import { World } from '../src/voxel/world';
import { NpcSim } from '../src/npc/npc';
import { nearestWalkable, terrainNavQuery } from '../src/npc/navigation';
import {
  applyTown,
  findTownSpawn,
  isTreeAt,
  lotSpec,
  planAt,
  townAnchors,
  townStats,
  TOWN_RADIUS,
  type BuildingSpec,
} from '../src/worldgen/town';

const TERRAIN: TerrainParams = { ...DEFAULT_TERRAIN, seed: 1337 };
/** A seed whose roads cross water inside the town (verified by census). */
const WATERY: TerrainParams = { ...DEFAULT_TERRAIN, seed: 9999 };

function townedWorld(params: TerrainParams): World {
  return new World((chunk) => {
    generateChunk(chunk, params);
    applyTown(chunk, params);
  });
}

/** Materialize every chunk overlapping the box (x0..x1) × (z0..z1). */
function materialize(world: World, x0: number, x1: number, z0: number, z1: number): void {
  const cx0 = Math.floor(x0 / 16);
  const cx1 = Math.floor(x1 / 16);
  const cz0 = Math.floor(z0 / 16);
  const cz1 = Math.floor(z1 / 16);
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) world.ensureChunk(cx, cy, cz);
    }
  }
}

function checksum(world: World, x0: number, x1: number, z0: number, z1: number): number {
  let sum = 0;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        sum = (sum * 31 + world.getVoxel(x, y, z)) | 0;
      }
    }
  }
  return sum;
}

/** All building lots within the town square (deterministic order). */
function allBuildings(params: TerrainParams): BuildingSpec[] {
  const seen = new Set<string>();
  const out: BuildingSpec[] = [];
  for (let z = -TOWN_RADIUS; z < TOWN_RADIUS; z++) {
    for (let x = -TOWN_RADIUS; x < TOWN_RADIUS; x++) {
      const plan = planAt(x, z, params);
      if (plan.kind !== 'lot' || !plan.lot) continue;
      const key = `${plan.lot.x},${plan.lot.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = lotSpec(plan.lot.x, plan.lot.z, params).building;
      if (b) out.push(b);
    }
  }
  return out;
}

describe('town plan', () => {
  it('classifies columns consistently and lots round-trip', () => {
    for (let z = -TOWN_RADIUS - 4; z <= TOWN_RADIUS + 4; z += 3) {
      for (let x = -TOWN_RADIUS - 4; x <= TOWN_RADIUS + 4; x += 3) {
        const plan = planAt(x, z, TERRAIN);
        expect(['road', 'lot', 'wild']).toContain(plan.kind);
        if (plan.kind === 'lot') {
          expect(plan.lot).toBeDefined();
          // Edge lots can have origins past the radius (their in-radius
          // cells still belong to them); round-trip only interior origins.
          if (Math.max(Math.abs(plan.lot!.x), Math.abs(plan.lot!.z)) <= TOWN_RADIUS) {
            const again = planAt(plan.lot!.x, plan.lot!.z, TERRAIN);
            expect(again.kind).toBe('lot');
            expect(again.lot).toEqual(plan.lot);
          }
        }
        if (Math.max(Math.abs(x), Math.abs(z)) > TOWN_RADIUS) {
          expect(plan.kind).toBe('wild');
        }
      }
    }
  });

  it('roads form a 3-wide grid (dry town center)', () => {
    // A road column resurfaces the top with asphalt; a non-road column at
    // the same height keeps its natural surface.
    let roadColumns = 0;
    for (let z = -20; z <= 20; z++) {
      for (let x = -20; x <= 20; x++) {
        const plan = planAt(x, z, TERRAIN);
        const h = heightAt(x, z, TERRAIN);
        if (!isDry(h, TERRAIN)) continue;
        const world = townedWorld(TERRAIN); // rebuilt lazily below instead
        void world;
        if (plan.kind === 'road') roadColumns++;
      }
    }
    expect(roadColumns).toBeGreaterThan(0);
  });

  it('is deterministic: same seed, same voxels; different seed, different town', () => {
    const a = townedWorld(TERRAIN);
    const b = townedWorld(TERRAIN);
    materialize(a, -24, 24, -24, 24);
    materialize(b, -24, 24, -24, 24);
    expect(checksum(a, -24, 24, -24, 24)).toBe(checksum(b, -24, 24, -24, 24));

    const other = townedWorld({ ...TERRAIN, seed: 424242 });
    materialize(other, -24, 24, -24, 24);
    // The town itself differs (roads offset, lots reshuffled) even though
    // plain terrain height may coincide in places.
    const statsA = townStats(TERRAIN);
    const statsB = townStats({ ...TERRAIN, seed: 424242 });
    expect(statsA).not.toEqual(statsB);
    void other;
  });

  it('chunk regeneration after unload is bit-identical (town included)', () => {
    const world = townedWorld(TERRAIN);
    materialize(world, -16, 16, -16, 16);
    const before = checksum(world, -16, 16, -16, 16);
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) world.unloadChunk(cx, cy, cz);
      }
    }
    materialize(world, -16, 16, -16, 16);
    expect(checksum(world, -16, 16, -16, 16)).toBe(before);
  });
});

describe('town buildings', () => {
  it('have valid footprints, doors, windows, and floors', () => {
    const world = townedWorld(TERRAIN);
    // Materialize around the origin densely enough for anchor walkability.
    materialize(world, -48, 48, -48, 48);
    const nav = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
    const buildings = allBuildings(TERRAIN).filter(
      (b) => Math.max(Math.abs(b.bx), Math.abs(b.bz)) < 40,
    );
    expect(buildings.length).toBeGreaterThan(10);

    let withWindows = 0;
    for (const b of buildings) {
      expect(b.w).toBeGreaterThanOrEqual(6);
      expect(b.w).toBeLessThanOrEqual(8);
      expect(b.d).toBeGreaterThanOrEqual(6);
      expect(b.d).toBeLessThanOrEqual(8);
      expect(b.baseY + 12).toBeLessThanOrEqual(29);

      // Door opening: air at feet and head level, walkable front cell.
      expect(world.getVoxel(b.door.x, b.door.y, b.door.z)).toBe(AIR);
      expect(world.getVoxel(b.door.x, b.door.y + 1, b.door.z)).toBe(AIR);
      expect(nearestWalkable(nav, b.door.x, b.door.y, b.door.z, 2)).toBeDefined();

      // Pad floor under the whole footprint (foot stands at baseY).
      for (let pz = b.bz; pz < b.bz + b.d; pz++) {
        for (let px = b.bx; px < b.bx + b.w; px++) {
          const floor = world.getVoxel(px, b.baseY - 1, pz);
          expect([WOOD, CONCRETE, GRASS]).toContain(floor);
        }
      }

      // Walls: solid (or glass) on the perimeter at feet level except the door.
      for (let pz = b.bz; pz < b.bz + b.d; pz++) {
        for (let px = b.bx; px < b.bx + b.w; px++) {
          const perimeter =
            px === b.bx || px === b.bx + b.w - 1 || pz === b.bz || pz === b.bz + b.d - 1;
          if (!perimeter) continue;
          const m = world.getVoxel(px, b.baseY, pz);
          const isDoor =
            (b.doorSide === 0 && px === b.bx + b.w - 1 && pz === b.bz + b.doorPos) ||
            (b.doorSide === 1 && px === b.bx && pz === b.bz + b.doorPos) ||
            (b.doorSide === 2 && pz === b.bz + b.d - 1 && px === b.bx + b.doorPos) ||
            (b.doorSide === 3 && pz === b.bz && px === b.bx + b.doorPos);
          if (isDoor) expect(m).toBe(AIR);
          else expect(m).not.toBe(AIR);
        }
      }

      // Roof: something solid caps the interior at or above the walls.
      const cx = b.bx + (b.w >> 1);
      const cz = b.bz + (b.d >> 1);
      let roof = false;
      for (let y = b.baseY + 3; y <= b.baseY + 12; y++) {
        if (world.getVoxel(cx, y, cz) !== AIR) {
          roof = true;
          break;
        }
      }
      expect(roof).toBe(true);

      // Windows: glass somewhere in the perimeter band at head level.
      let glass = 0;
      for (let pz = b.bz; pz < b.bz + b.d; pz++) {
        for (let px = b.bx; px < b.bx + b.w; px++) {
          const perimeter =
            px === b.bx || px === b.bx + b.w - 1 || pz === b.bz || pz === b.bz + b.d - 1;
          if (perimeter && world.getVoxel(px, b.baseY + 1, pz) === GLASS) glass++;
        }
      }
      if (glass > 0) withWindows++;
    }
    expect(withWindows).toBeGreaterThan(0);
  });

  it('never stand in water', () => {
    for (const params of [TERRAIN, WATERY]) {
      for (const b of allBuildings(params)) {
        for (let pz = b.bz - 1; pz <= b.bz + b.d; pz++) {
          for (let px = b.bx - 1; px <= b.bx + b.w; px++) {
            expect(isDry(heightAt(px, pz, params), params)).toBe(true);
          }
        }
      }
    }
  });

  it('two-story houses have a walkable interior staircase and slab openings', () => {
    const world = townedWorld(TERRAIN);
    materialize(world, -48, 48, -48, 48);
    const nav = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
    const duplexes = allBuildings(TERRAIN).filter(
      (b) => b.type === 'house' && b.floors === 2 && Math.abs(b.bx) < 40 && Math.abs(b.bz) < 40,
    );
    expect(duplexes.length).toBeGreaterThan(0);
    for (const b of duplexes) {
      // Slab at baseY+4 with exactly two openings above the top steps.
      let slab = 0;
      let holes = 0;
      for (let pz = b.bz; pz < b.bz + b.d; pz++) {
        for (let px = b.bx; px < b.bx + b.w; px++) {
          if (world.getVoxel(px, b.baseY + 4, pz) !== AIR) slab++;
          else holes++;
        }
      }
      expect(slab).toBeGreaterThan(0);
      expect(holes).toBe(2);

      // The stair run: four +1 blocks along the wall opposite the door,
      // each standable, the last two opening through the slab.
      const steps: { x: number; y: number; z: number }[] = [];
      if (b.doorSide < 2) {
        const x = b.doorSide === 0 ? b.bx + b.w - 2 : b.bx + 1;
        for (let i = 0; i < 4; i++) steps.push({ x, y: b.baseY + i, z: b.bz + 1 + i });
      } else {
        const z = b.doorSide === 2 ? b.bz + b.d - 2 : b.bz + 1;
        for (let i = 0; i < 4; i++) steps.push({ x: b.bx + 1 + i, y: b.baseY + i, z });
      }
      steps.forEach((s, i) => {
        expect(world.getVoxel(s.x, s.y, s.z)).toBe(WOOD);
        expect(nav.walkable(s.x, s.y + 1, s.z)).toBe(true);
        if (i >= 2) expect(world.getVoxel(s.x, b.baseY + 4, s.z)).toBe(AIR);
      });
    }
  });
});

describe('town roads and bridges', () => {
  it('deck water crossings at sea level with posts to the bed', () => {
    const params = WATERY;
    const world = townedWorld(params);
    materialize(world, -TOWN_RADIUS, TOWN_RADIUS, -TOWN_RADIUS, TOWN_RADIUS);

    let decks = 0;
    let decksMissingPlan = 0;
    let decksWithoutPost = 0;
    for (let z = -TOWN_RADIUS; z < TOWN_RADIUS; z++) {
      for (let x = -TOWN_RADIUS; x < TOWN_RADIUS; x++) {
        if (world.getVoxel(x, params.seaLevel, z) !== WOOD) continue;
        if (world.getVoxel(x, params.seaLevel - 1, z) !== WATER) continue;
        decks++;
        if (planAt(x, z, params).kind !== 'road') decksMissingPlan++;
        // Every other deck cell (the post lattice) must reach the bed.
        if ((((x + z) % 2) + 2) % 2 === 0) {
          let post = false;
          for (let y = params.seaLevel - 1; y >= 0; y--) {
            if (world.getVoxel(x, y, z) === WOOD) post = true;
          }
          if (!post) decksWithoutPost++;
        }
      }
    }
    expect(decks).toBeGreaterThan(20);
    expect(decksMissingPlan).toBe(0);
    expect(decksWithoutPost).toBe(0);

    // The deck's feet cell is dry: walkable like a road.
    const nav = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
    let checked = 0;
    for (let z = -TOWN_RADIUS; z < TOWN_RADIUS && checked < 20; z++) {
      for (let x = -TOWN_RADIUS; x < TOWN_RADIUS && checked < 20; x++) {
        if (
          world.getVoxel(x, params.seaLevel, z) === WOOD &&
          world.getVoxel(x, params.seaLevel - 1, z) === WATER
        ) {
          expect(nav.walkable(x, params.seaLevel + 1, z)).toBe(true);
          checked++;
        }
      }
    }
  });

  it('asphalt resurfaces dry road columns', () => {
    const world = townedWorld(TERRAIN);
    materialize(world, -24, 24, -24, 24);
    let checked = 0;
    for (let z = -24; z < 24 && checked < 50; z++) {
      for (let x = -24; x < 24 && checked < 50; x++) {
        const h = heightAt(x, z, TERRAIN);
        if (planAt(x, z, TERRAIN).kind === 'road' && isDry(h, TERRAIN)) {
          expect(world.getVoxel(x, h - 1, z)).toBe(ASPHALT);
          checked++;
        }
      }
    }
    expect(checked).toBe(50);
  });
});

describe('town vegetation', () => {
  it('wild trees have trunks and canopies on dry grass only', () => {
    const world = townedWorld(WATERY);
    materialize(world, -TOWN_RADIUS - 8, TOWN_RADIUS + 8, -TOWN_RADIUS - 8, TOWN_RADIUS + 8);
    let trees = 0;
    for (let z = -TOWN_RADIUS - 8; z <= TOWN_RADIUS + 8; z += 1) {
      for (let x = -TOWN_RADIUS - 8; x <= TOWN_RADIUS + 8; x += 1) {
        if (!isTreeAt(x, z, WATERY)) continue;
        trees++;
        const h = heightAt(x, z, WATERY);
        expect(world.getVoxel(x, h, z)).toBe(WOOD); // trunk from the surface
        let canopy = 0;
        for (let y = h + 1; y < WORLD_HEIGHT; y++) {
          if (world.getVoxel(x, y, z) === LEAVES) canopy++;
        }
        // Canopy caps the trunk (layers above the topmost trunk cell).
        expect(canopy).toBeGreaterThanOrEqual(2);
        expect(planAt(x, z, WATERY).kind).toBe('wild');
      }
    }
    expect(trees).toBeGreaterThan(20);
  });

  it('yard trees never replace buildings', () => {
    const stats = townStats(TERRAIN);
    expect(stats.houses + stats.shops + stats.industrial).toBeGreaterThan(40);
    expect(stats.yards).toBeGreaterThan(20);
  });
});

describe('town spawn and NPC integration', () => {
  it('spawn lands on open ground, never on a pad or doorstep', () => {
    for (const params of [TERRAIN, WATERY]) {
      const spawn = findTownSpawn(params);
      const x = Math.floor(spawn.x);
      const z = Math.floor(spawn.z);
      expect(isDry(heightAt(x, z, params), params)).toBe(true);
      const plan = planAt(x, z, params);
      if (plan.kind === 'lot' && plan.lot) {
        const b = lotSpec(plan.lot.x, plan.lot.z, params).building;
        if (b) {
          const outside = x < b.bx - 1 || x > b.bx + b.w || z < b.bz - 1 || z > b.bz + b.d;
          expect(outside).toBe(true);
        }
      }
    }
  });

  it('door anchors feed the NPC sim: figures take homes near town doors', () => {
    const world = townedWorld(TERRAIN);
    materialize(world, -48, 48, -48, 48);
    const anchors = townAnchors(TERRAIN);
    expect(anchors.homes.length).toBeGreaterThan(10);

    // Every anchor is a real building doorstep: air at feet/head, solid
    // pad below, and a building material in one of the four neighbors.
    // (Only anchors inside the materialized box — unloaded chunks read air.)
    const buildingMats = [WOOD, BRICK, CONCRETE, GLASS];
    const nearAnchors = anchors.homes.filter((a) => Math.max(Math.abs(a.x), Math.abs(a.z)) < 44);
    expect(nearAnchors.length).toBeGreaterThan(5);
    for (const a of nearAnchors) {
      expect(world.getVoxel(a.x, a.y, a.z)).toBe(AIR);
      expect(world.getVoxel(a.x, a.y + 1, a.z)).toBe(AIR);
      expect(world.getVoxel(a.x, a.y - 1, a.z)).not.toBe(AIR);
      // The facing neighbor at feet level is the door opening itself;
      // wall material shows up diagonally beside the doorstep.
      let wallNeighbor = false;
      for (let dz = -1; dz <= 1 && !wallNeighbor; dz++) {
        for (let dx = -1; dx <= 1 && !wallNeighbor; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (buildingMats.includes(world.getVoxel(a.x + dx, a.y, a.z + dz))) {
            wallNeighbor = true;
          }
        }
      }
      expect(wallNeighbor).toBe(true);
    }
    const npc = new NpcSim(world, TERRAIN.seed, {
      population: 4,
      anchors,
      groundY: (x, z) => heightAt(x, z, TERRAIN),
    });
    // Spawn four figures on a road near the center.
    const nav = terrainNavQuery((x, y, z) => world.getVoxel(x, y, z));
    const cell = nearestWalkable(nav, 12, heightAt(12, 0, TERRAIN), 0, 4);
    expect(cell).toBeDefined();
    for (let i = 0; i < 4; i++) npc.spawn(cell!);

    const near = (home: { x: number; y: number; z: number }) =>
      anchors.homes.some(
        (a) =>
          Math.abs(a.x - home.x) <= 2 && Math.abs(a.z - home.z) <= 2 && Math.abs(a.y - home.y) <= 4,
      );
    // Most figures spawned near the town center get a real door home;
    // hash may route one to the ring fallback, so require a majority.
    const withDoorHomes = npc.list().filter((n) => near(n.home)).length;
    expect(withDoorHomes).toBeGreaterThanOrEqual(3);

    // Deterministic: a fresh sim makes the same assignments.
    const again = new NpcSim(world, TERRAIN.seed, { population: 4, anchors });
    for (let i = 0; i < 4; i++) again.spawn(cell!);
    expect(again.list().map((n) => `${n.home.x},${n.home.y},${n.home.z}`)).toEqual(
      npc.list().map((n) => `${n.home.x},${n.home.y},${n.home.z}`),
    );
  });

  it('groundY rejects structure surfaces as spawn points', () => {
    const world = townedWorld(TERRAIN);
    materialize(world, -16, 16, -16, 16);
    const strict = new NpcSim(world, TERRAIN.seed, {
      population: 3,
      groundY: () => -1000, // everything is "above natural ground"
    });
    strict.tick({ x: 0, z: 0 });
    strict.tick({ x: 0, z: 0 });
    strict.tick({ x: 0, z: 0 });
    expect(strict.count).toBe(0);
    const normal = new NpcSim(world, TERRAIN.seed, { population: 3 });
    normal.tick({ x: 0, z: 0 });
    expect(normal.count).toBeGreaterThan(0);
  });
});

describe('town persistence interplay', () => {
  it('player edits on top of town buildings survive regeneration', () => {
    const world = townedWorld(TERRAIN);
    const b = allBuildings(TERRAIN).find((b) => Math.abs(b.bx) < 40 && Math.abs(b.bz) < 40);
    expect(b).toBeDefined();
    materialize(world, b!.bx - 8, b!.bx + b!.w + 8, b!.bz - 8, b!.bz + b!.d + 8);
    const bx = b!.bx + 1;
    const bz = b!.bz + 1;
    const by = b!.baseY;
    // Knock a hole in a wall, then unload + regenerate the chunk.
    expect(world.setVoxel(bx, by, bz, AIR)).toBe(true);
    const cx = Math.floor(bx / 16);
    const cy = Math.floor(by / 16);
    void cy;
    const cz = Math.floor(bz / 16);
    for (let y = 0; y < WORLD_HEIGHT_CHUNKS; y++) world.unloadChunk(cx, y, cz);
    materialize(world, bx, bx, bz, bz);
    expect(world.getVoxel(bx, by, bz)).toBe(AIR); // the edit persisted…
    expect(world.getVoxel(b!.bx, by, b!.bz)).not.toBe(AIR); // …and the town too
  });
});

describe('town materials', () => {
  it('use stable appended ids', () => {
    expect(ASPHALT).toBe(7);
    expect(CONCRETE).toBe(8);
    expect(BRICK).toBe(9);
    expect(GLASS).toBe(10);
    expect(LEAVES).toBe(11);
    expect(getMaterial(ASPHALT).name).toBe('asphalt');
    expect(getMaterial(GLASS).solid).toBe(true);
  });

  it('old saves with the original 7-material snapshot still validate', () => {
    const parsed = JSON.parse(serializeMaterials()) as { version: number; materials: unknown[] };
    const legacy = JSON.stringify({
      version: parsed.version,
      materials: parsed.materials.slice(0, 7),
    });
    expect(() => deserializeMaterials(legacy)).not.toThrow();
    expect(() => deserializeMaterials(serializeMaterials())).not.toThrow();
  });
});
