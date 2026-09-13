import { CHUNK_SIZE, WORLD_HEIGHT, worldToChunk, worldToLocal } from './coordinates';
import { packCellKey, unpackCellKey } from './fluid';
import { AIR, WATER, GLASS, emissionOf, getMaterial, type VoxelMaterialID } from './materials';
import type { Chunk } from './chunk';
import type { World } from './world';

/**
 * Voxel light field (Phase 17): two per-voxel channels, Minecraft-shaped
 * because that is the believable-at-16³ version of plan §30's "voxel AO /
 * dynamic lighting updates".
 *
 * - **Sky light** 0–15: a cell is 15 iff every cell above it (world top =
 *   open sky) lets light through; the 15 propagates straight down for
 *   free through air, spreads sideways at −1 per step, and attenuates
 *   through water (−2) and glass (−1). Opaque voxels block — leaves make
 *   tree shade, roofs make dark rooms.
 * - **Block light** 0–15: point sources (lit lamps, burning cells via
 *   main's source sync; self-luminous machines via `emissionOf`) spread
 *   at −1 per step with the same attenuation.
 *
 * Storage is two Uint8Arrays on each Chunk (allocated lazily at init) —
 * unloading a chunk frees its light with it. Chunks the field has never
 * initialized read as "full sky, no block light" through the mesher
 * query, so the world never renders darker than the pre-light look while
 * initialization streams in.
 *
 * Updates are the standard two-queue incremental algorithm, budgeted per
 * fixed step like the fluid sim: a voxel change removes the cell's stale
 * light (BFS that darkens everything dimmer, re-seeding brighter
 * borders), re-walks the edited sky column, then re-adds from the
 * border seeds; sources re-add from their cell. A chunk that generates
 * initializes its columns directly and seeds both border directions, so
 * light crosses chunk boundaries exactly like the fluid sim's.
 *
 * Every changed value marks the chunk (and its boundary neighbors) mesh
 * dirty, so remeshing picks the light up through the normal frame budget.
 *
 * Determinism (ADR-005): fixed neighbor order, no RNG; the same edit
 * sequence yields the same field. Property-tested against a from-scratch
 * recompute. Pure: no three.js, no DOM (ADR-002).
 */

export const LIGHT_MAX = 15;

/** Default per-tick BFS pop budget (main.ts passes its own tuned value). */
export const DEFAULT_LIGHT_BUDGET = 1200;

/** Light opacity when a ray enters the material (256 = fully blocked). */
const OPACITY_CLEAR = 0;
const OPACITY_GLASS = 1;
const OPACITY_WATER = 2;
const OPACITY_BLOCKED = 256;

function lightOpacity(m: VoxelMaterialID): number {
  if (m === AIR) return OPACITY_CLEAR;
  if (m === GLASS) return OPACITY_GLASS;
  if (m === WATER) return OPACITY_WATER;
  return getMaterial(m).opaque ? OPACITY_BLOCKED : OPACITY_CLEAR;
}

/** Fixed 6-neighbor order — part of the determinism contract. */
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const enum Channel {
  Sky = 0,
  Block = 1,
}

export class LightField {
  /** Packed cell keys waiting to push light outward (per channel). */
  private readonly addSky: number[] = [];
  private readonly addBlock: number[] = [];
  /** Removal BFS: cell + the level it used to hold (per channel). */
  private readonly remSky: number[] = [];
  private readonly remSkyLevel: number[] = [];
  private readonly remBlock: number[] = [];
  private readonly remBlockLevel: number[] = [];
  private addSkyHead = 0;
  private addBlockHead = 0;
  private remSkyHead = 0;
  private remBlockHead = 0;

  /** Dynamic block-light sources: packed key → level 1–15. Lamps follow
   * the power sim's lit set, burning cells the fire sim's — main diffs
   * both into `setSource` calls (idempotent; only changes queue BFS). */
  private readonly sources = new Map<number, number>();

  /** One-slot chunk memo — BFS locality makes the World's map lookup the
   * hot path otherwise (same pattern as the utilities' cached reader). */
  private cacheKey = '';
  private cacheChunk: Chunk | undefined;

  /** Cells waiting in any queue (HUD/debug). */
  get pendingCount(): number {
    return (
      this.addSky.length -
      this.addSkyHead +
      (this.addBlock.length - this.addBlockHead) +
      (this.remSky.length - this.remSkyHead) +
      (this.remBlock.length - this.remBlockHead)
    );
  }

  constructor(private readonly world: World) {
    // Chain onto the World's hooks (fluid/fire pattern — construction
    // order vs the other sims is irrelevant; this must exist before the
    // first ensureChunk so spawn chunks initialize immediately).
    const previousChanged = world.onVoxelChanged;
    world.onVoxelChanged = (x, y, z, material, before) => {
      previousChanged?.(x, y, z, material, before);
      this.handleChanged(x, y, z, material, before);
    };
    const previousReady = world.onChunkReady;
    world.onChunkReady = (chunk) => {
      previousReady?.(chunk);
      this.initChunk(chunk);
    };
  }

  // ---- World-space queries (mesher + game reads) ------------------------

  private chunkAt(x: number, y: number, z: number): Chunk | undefined {
    const key = `${worldToChunk(x)},${worldToChunk(y)},${worldToChunk(z)}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.cacheChunk = this.world.getChunk(worldToChunk(x), worldToChunk(y), worldToChunk(z));
    }
    return this.cacheChunk;
  }

  /** Sky light 0–15; chunks the field never initialized read as full sky. */
  skyAt(x: number, y: number, z: number): number {
    const chunk = this.chunkAt(x, y, z);
    if (!chunk?.lightSky) return LIGHT_MAX;
    return chunk.lightSky[this.indexOf(chunk, x, y, z)];
  }

  /** Block light 0–15 (0 for uninitialized/unloaded chunks). */
  blockAt(x: number, y: number, z: number): number {
    const chunk = this.chunkAt(x, y, z);
    if (!chunk?.lightBlock) return 0;
    return chunk.lightBlock[this.indexOf(chunk, x, y, z)];
  }

  /**
   * Mesher query: packed `sky << 4 | block` at a world cell. Unloaded or
   * uninitialized chunks read as full sky so streaming never renders dark.
   */
  packedAt(x: number, y: number, z: number): number {
    return (this.skyAt(x, y, z) << 4) | this.blockAt(x, y, z);
  }

  private indexOf(chunk: Chunk, x: number, y: number, z: number): number {
    return chunk.volume.index(worldToLocal(x), worldToLocal(y), worldToLocal(z));
  }

  // ---- Sources (main's power/fire sync + static emission) ---------------

  /**
   * Set a dynamic block-light source (level 0 removes). Idempotent: an
   * unchanged level does nothing, so main can re-sync whole sets cheaply.
   */
  setSource(x: number, y: number, z: number, level: number): void {
    const key = packCellKey(x, y, z);
    const current = this.sources.get(key) ?? 0;
    if (current === level) return;
    if (level <= 0) this.sources.delete(key);
    else this.sources.set(key, level);

    const chunk = this.chunkAt(x, y, z);
    if (!chunk?.lightBlock) return; // uninitialized: init seeds from `sources`
    const stored = this.blockAt(x, y, z);
    if (stored > 0 && stored !== level) this.enqueueRemoval(Channel.Block, key, stored);
    if (level > 0) {
      chunk.lightBlock[this.indexOf(chunk, x, y, z)] = level;
      this.addBlock.push(key);
    }
  }

  // ---- Fixed-step drain --------------------------------------------------

  /**
   * Drain up to `budget` queue pops. Removals run before additions only
   * by FIFO order — each entry was queued after its predecessor's writes,
   * which is what makes the two-queue dance converge.
   */
  tick(budget: number): void {
    let popped = 0;
    while (popped < budget && this.remSkyHead < this.remSky.length) {
      const key = this.remSky[this.remSkyHead];
      const level = this.remSkyLevel[this.remSkyHead];
      this.remSkyHead++;
      this.processRemoval(Channel.Sky, key, level);
      popped++;
    }
    while (popped < budget && this.remBlockHead < this.remBlock.length) {
      const key = this.remBlock[this.remBlockHead];
      const level = this.remBlockLevel[this.remBlockHead];
      this.remBlockHead++;
      this.processRemoval(Channel.Block, key, level);
      popped++;
    }
    while (popped < budget && this.addSkyHead < this.addSky.length) {
      this.processAdd(Channel.Sky, this.addSky[this.addSkyHead]);
      this.addSkyHead++;
      popped++;
    }
    while (popped < budget && this.addBlockHead < this.addBlock.length) {
      this.processAdd(Channel.Block, this.addBlock[this.addBlockHead]);
      this.addBlockHead++;
      popped++;
    }
    // Compact the queues once they are mostly drained (amortized O(1)).
    if (this.addSkyHead > 4096 && this.addSkyHead * 2 > this.addSky.length) this.compact();
  }

  private compact(): void {
    this.addSky.copyWithin(0, this.addSkyHead);
    this.addBlock.copyWithin(0, this.addBlockHead);
    this.remSky.copyWithin(0, this.remSkyHead);
    this.remSkyLevel.copyWithin(0, this.remSkyHead);
    this.remBlock.copyWithin(0, this.remBlockHead);
    this.remBlockLevel.copyWithin(0, this.remBlockHead);
    this.addSky.length -= this.addSkyHead;
    this.addBlock.length -= this.addBlockHead;
    this.remSky.length -= this.remSkyHead;
    this.remSkyLevel.length -= this.remSkyHead;
    this.remBlock.length -= this.remBlockHead;
    this.remBlockLevel.length -= this.remBlockHead;
    this.addSkyHead = this.addBlockHead = this.remSkyHead = this.remBlockHead = 0;
  }

  // ---- Voxel changes (the World hook) ------------------------------------

  private handleChanged(
    x: number,
    y: number,
    z: number,
    material: VoxelMaterialID,
    before: VoxelMaterialID,
  ): void {
    const chunk = this.chunkAt(x, y, z);
    if (!chunk?.lightSky) return; // uninitialized: init will see the new voxel
    const key = packCellKey(x, y, z);
    const sky = this.skyAt(x, y, z);
    const block = this.blockAt(x, y, z);
    if (sky > 0) this.enqueueRemoval(Channel.Sky, key, sky);
    if (block > 0) this.enqueueRemoval(Channel.Block, key, block);

    // Static emission: reconcile self-luminous materials (a placed or
    // destroyed generator). Dynamic sources (lamp/fire) are main's — a
    // material change here drops nothing of theirs.
    const previousEmission = emissionOf(before);
    const emission = emissionOf(material);
    if (previousEmission > 0 && this.sources.get(key) === previousEmission) {
      this.sources.delete(key);
    }
    if (emission > 0) this.setSource(x, y, z, emission);

    // Light re-enters from every side (the column walk handles the top).
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      const neighbor = this.chunkAt(nx, ny, nz);
      if (!neighbor?.lightSky) continue;
      const nKey = packCellKey(nx, ny, nz);
      this.addSky.push(nKey);
      this.addBlock.push(nKey);
    }
    this.recomputeColumn(x, z);
  }

  /**
   * Re-walk one world column top-down: open sky cells must hold 15, the
   * first blocker ends the free column, and any cell below the break that
   * still stores 15 was column light that no longer has a path — demote
   * it (the removal BFS redistributes from brighter neighbors).
   */
  private recomputeColumn(x: number, z: number): void {
    let open = true;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (open && lightOpacity(this.world.getVoxel(x, y, z)) !== OPACITY_CLEAR) open = false;
      const chunk = this.chunkAt(x, y, z);
      if (!chunk?.lightSky) continue;
      const key = packCellKey(x, y, z);
      if (open) {
        if (this.skyAt(x, y, z) !== LIGHT_MAX) {
          chunk.lightSky[this.indexOf(chunk, x, y, z)] = LIGHT_MAX;
          this.markDirtyAt(x, y, z);
          this.addSky.push(key);
        }
      } else if (this.skyAt(x, y, z) === LIGHT_MAX) {
        this.enqueueRemoval(Channel.Sky, key, LIGHT_MAX);
      }
    }
  }

  // ---- Chunk initialization ----------------------------------------------

  /**
   * Allocate the chunk's light arrays and fill them: sky columns directly,
   * then border seeds so light flows both ways across the new boundary.
   * Sources inside the chunk (dynamic + static) light up from here.
   */
  private initChunk(chunk: Chunk): void {
    if (chunk.lightSky) return;
    chunk.lightSky = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    chunk.lightBlock = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    this.cacheKey = '';

    const { x: cx, y: cy, z: cz } = chunk.coord;
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = baseX + lx;
        const z = baseZ + lz;
        // Walk from the world top so an opaque roof in a chunk *above*
        // shades this one; unloaded cells above read as air (sky). Fresh
        // arrays are zero-filled, so only open-sky cells need writing —
        // shadowed cells wait for the BFS seeds below.
        let open = true;
        for (let y = WORLD_HEIGHT - 1; y >= baseY; y--) {
          const wasOpen = open;
          if (open && lightOpacity(this.world.getVoxel(x, y, z)) !== OPACITY_CLEAR) open = false;
          if (open) {
            if (y >= baseY + CHUNK_SIZE) continue;
            chunk.lightSky[chunk.volume.index(lx, y - baseY, lz)] = LIGHT_MAX;
          } else if (wasOpen) {
            // The column breaks here: seed every neighbor of the blocker
            // — the lit cells beside it feed the shadow laterally, the
            // open cell above feeds straight down (pools dim with depth,
            // overhang undersides pick up −1 steps).
            for (const [dx, dy, dz] of [
              [1, 0, 0],
              [-1, 0, 0],
              [0, 0, 1],
              [0, 0, -1],
              [0, 1, 0],
              [0, -1, 0],
            ] as const) {
              const sx = x + dx;
              const sy = y + dy;
              const sz = z + dz;
              if (this.skyAt(sx, sy, sz) > 1) this.addSky.push(packCellKey(sx, sy, sz));
            }
            // A blocker in a freshly generated chunk can also orphan sky
            // 15s in ALREADY-INITIALIZED chunks below (streaming order is
            // arbitrary). Demote the topmost one — the removal cascade's
            // free-fall rule eats the rest of the column downward.
            for (let by = y - 1; by >= 0; by--) {
              const below = this.chunkAt(x, by, z);
              if (!below?.lightSky) continue;
              const stored =
                below.lightSky[
                  below.volume.index(worldToLocal(x), worldToLocal(by), worldToLocal(z))
                ];
              if (stored === LIGHT_MAX) {
                this.enqueueRemoval(Channel.Sky, packCellKey(x, by, z), LIGHT_MAX);
                break;
              }
            }
          }
        }
      }
    }

    // Dynamic + static sources inside this chunk (lamps lit before the
    // chunk arrived, burning cells, generators).
    for (const [key, level] of this.sources) {
      const { x, y, z } = unpackCellKey(key);
      if (
        x >= baseX &&
        x < baseX + CHUNK_SIZE &&
        y >= baseY &&
        y < baseY + CHUNK_SIZE &&
        z >= baseZ &&
        z < baseZ + CHUNK_SIZE
      ) {
        chunk.lightBlock[chunk.volume.index(x - baseX, y - baseY, z - baseZ)] = level;
        this.addBlock.push(key);
      }
    }
    // Static emission from generated materials (generators in fresh town
    // chunks; the journal replays before this hook fires).
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const emission = emissionOf(chunk.volume.get(lx, ly, lz));
          if (emission > 0) {
            const key = packCellKey(baseX + lx, baseY + ly, baseZ + lz);
            if (!this.sources.has(key)) {
              this.sources.set(key, emission);
              chunk.lightBlock[chunk.volume.index(lx, ly, lz)] = emission;
              this.addBlock.push(key);
            }
          }
        }
      }
    }

    // Border seeds, both directions: this chunk's edge cells push their
    // light inward-out, and the neighbors' edge cells push into here.
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        this.seedBorder(baseX, baseY + ly, baseZ + lz, -1, 0, 0);
        this.seedBorder(baseX + CHUNK_SIZE - 1, baseY + ly, baseZ + lz, 1, 0, 0);
      }
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        this.seedBorder(baseX + lx, baseY + ly, baseZ, 0, 0, -1);
        this.seedBorder(baseX + lx, baseY + ly, baseZ + CHUNK_SIZE - 1, 0, 0, 1);
      }
    }
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        this.seedBorder(baseX + lx, baseY, baseZ + lz, 0, -1, 0);
        this.seedBorder(baseX + lx, baseY + CHUNK_SIZE - 1, baseZ + lz, 0, 1, 0);
      }
    }

    // Lit-boundary pass: seed every lit cell that borders a dimmer
    // transparent cell (in this chunk or an initialized neighbor). The
    // column walk sets 15s without queueing them, so shadows beside open
    // columns — under overhangs, beside pool walls, inside rooms whose
    // roof chunk generated later — would otherwise wait forever for a
    // feeder. Most cells have all-equal neighbors and early-out.
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const index = chunk.volume.index(lx, ly, lz);
          const sky = chunk.lightSky[index];
          const block = chunk.lightBlock[index];
          if (sky <= 1 && block <= 1) continue;
          const x = baseX + lx;
          const y = baseY + ly;
          const z = baseZ + lz;
          let seedSky = false;
          let seedBlock = false;
          for (const [dx, dy, dz] of NEIGHBORS) {
            const nx = x + dx;
            const ny = y + dy;
            const nz = z + dz;
            if (ny < 0 || ny >= WORLD_HEIGHT) continue;
            const neighbor = this.chunkAt(nx, ny, nz);
            if (!neighbor?.lightSky || !neighbor.lightBlock) continue;
            if (lightOpacity(this.world.getVoxel(nx, ny, nz)) === OPACITY_BLOCKED) continue;
            const nIndex = neighbor.volume.index(
              worldToLocal(nx),
              worldToLocal(ny),
              worldToLocal(nz),
            );
            if (sky > 1 && neighbor.lightSky[nIndex] < sky - 1) seedSky = true;
            if (block > 1 && neighbor.lightBlock[nIndex] < block - 1) seedBlock = true;
            if (seedSky && seedBlock) break;
          }
          if (seedSky) this.addSky.push(packCellKey(x, y, z));
          if (seedBlock) this.addBlock.push(packCellKey(x, y, z));
        }
      }
    }
  }

  /** Queue one border cell of a freshly initialized chunk (and its outer
   * neighbor) so pre-existing light re-balances across the boundary. */
  private seedBorder(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    if (this.skyAt(x, y, z) > 1) this.addSky.push(packCellKey(x, y, z));
    if (this.blockAt(x, y, z) > 1) this.addBlock.push(packCellKey(x, y, z));
    const ox = x + dx;
    const oy = y + dy;
    const oz = z + dz;
    if (this.skyAt(ox, oy, oz) > 1) this.addSky.push(packCellKey(ox, oy, oz));
    if (this.blockAt(ox, oy, oz) > 1) this.addBlock.push(packCellKey(ox, oy, oz));
  }

  /** Initialize every loaded chunk (load path: reset() then rescan()). */
  rescan(): void {
    this.cacheKey = '';
    for (const chunk of this.world.chunks.values()) this.initChunk(chunk);
  }

  /** Drop all light state (arrays, queues, sources). */
  reset(): void {
    for (const chunk of this.world.chunks.values()) {
      chunk.lightSky = undefined;
      chunk.lightBlock = undefined;
    }
    this.addSky.length = 0;
    this.addBlock.length = 0;
    this.remSky.length = 0;
    this.remSkyLevel.length = 0;
    this.remBlock.length = 0;
    this.remBlockLevel.length = 0;
    this.addSkyHead = this.addBlockHead = this.remSkyHead = this.remBlockHead = 0;
    this.sources.clear();
    this.cacheKey = '';
  }

  // ---- BFS ---------------------------------------------------------------

  private enqueueRemoval(channel: Channel, key: number, level: number): void {
    if (level <= 0) return;
    const cell = unpackCellKey(key);
    const chunk = this.chunkAt(cell.x, cell.y, cell.z);
    if (!chunk?.lightSky) return;
    const index = this.indexOf(chunk, cell.x, cell.y, cell.z);
    if (channel === Channel.Sky) {
      chunk.lightSky[index] = 0;
      this.remSky.push(key);
      this.remSkyLevel.push(level);
    } else if (chunk.lightBlock) {
      chunk.lightBlock[index] = 0;
      this.remBlock.push(key);
      this.remBlockLevel.push(level);
    }
    this.markDirtyAt(cell.x, cell.y, cell.z);
  }

  /** Darken everything the removed light was feeding; re-seed brighter
   * borders back onto the add queue. Sky 15 cascades straight down for
   * free through clear air (the column rule). If the cell already holds
   * at least `level` again, this entry is stale (the column walk or a
   * brighter path re-lit it after the enqueue) — re-seed and stop. */
  private processRemoval(channel: Channel, key: number, level: number): void {
    const cell = unpackCellKey(key);
    const current =
      channel === Channel.Sky
        ? this.skyAt(cell.x, cell.y, cell.z)
        : this.blockAt(cell.x, cell.y, cell.z);
    if (current >= level) {
      if (channel === Channel.Sky) this.addSky.push(key);
      else this.addBlock.push(key);
      return;
    }
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const nz = cell.z + dz;
      const chunk = this.chunkAt(nx, ny, nz);
      if (!chunk?.lightSky) continue;
      const neighbor = this.world.getVoxel(nx, ny, nz);
      const opacity = lightOpacity(neighbor);
      if (opacity === OPACITY_BLOCKED) continue;
      const nKey = packCellKey(nx, ny, nz);
      const nv = channel === Channel.Sky ? this.skyAt(nx, ny, nz) : this.blockAt(nx, ny, nz);
      if (nv === 0) continue;
      const freeFall =
        channel === Channel.Sky && level === LIGHT_MAX && dy === -1 && opacity === OPACITY_CLEAR;
      if (nv < level || freeFall) {
        this.enqueueRemoval(channel, nKey, nv);
      } else {
        // Brighter or equal: it survives; let it re-light this side.
        if (channel === Channel.Sky) this.addSky.push(nKey);
        else this.addBlock.push(nKey);
      }
    }
  }

  /** Spread light from a cell whose value is already set (column fill,
   * source, or a previous pop). Reads the source map so a queued add
   * after a removal still finds the source level. */
  private processAdd(channel: Channel, key: number): void {
    const cell = unpackCellKey(key);
    const from = this.chunkAt(cell.x, cell.y, cell.z);
    if (!from?.lightSky || !from.lightBlock) return;
    const fromIndex = this.indexOf(from, cell.x, cell.y, cell.z);
    const fromArray = channel === Channel.Sky ? from.lightSky : from.lightBlock;
    let level = fromArray[fromIndex];
    if (channel === Channel.Block) {
      const source = this.sources.get(key) ?? 0;
      if (source > level) {
        level = source;
        from.lightBlock[fromIndex] = level;
        this.markDirtyAt(cell.x, cell.y, cell.z);
      }
    }
    if (level <= 1) return;

    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const nz = cell.z + dz;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const chunk = this.chunkAt(nx, ny, nz);
      if (!chunk?.lightSky || !chunk.lightBlock) continue;
      const opacity = lightOpacity(this.world.getVoxel(nx, ny, nz));
      if (opacity === OPACITY_BLOCKED) continue;
      const next =
        channel === Channel.Sky && level === LIGHT_MAX && dy === -1 && opacity === OPACITY_CLEAR
          ? LIGHT_MAX
          : level - Math.max(1, opacity);
      const index = chunk.volume.index(worldToLocal(nx), worldToLocal(ny), worldToLocal(nz));
      const target = channel === Channel.Sky ? chunk.lightSky : chunk.lightBlock;
      if (next > target[index]) {
        target[index] = next;
        this.markDirtyAt(nx, ny, nz);
        if (channel === Channel.Sky) this.addSky.push(packCellKey(nx, ny, nz));
        else this.addBlock.push(packCellKey(nx, ny, nz));
      }
    }
  }

  /** A light change alters what the chunk's mesh should look like — the
   * same boundary rule as World.setVoxel (neighbor chunks culled faces
   * don't change, but their sampled light does). */
  private markDirtyAt(x: number, y: number, z: number): void {
    const cx = worldToChunk(x);
    const cy = worldToChunk(y);
    const cz = worldToChunk(z);
    this.markDirty(cx, cy, cz);
    const lx = worldToLocal(x);
    const ly = worldToLocal(y);
    const lz = worldToLocal(z);
    if (lx === 0) this.markDirty(cx - 1, cy, cz);
    if (lx === CHUNK_SIZE - 1) this.markDirty(cx + 1, cy, cz);
    if (ly === 0) this.markDirty(cx, cy - 1, cz);
    if (ly === CHUNK_SIZE - 1) this.markDirty(cx, cy + 1, cz);
    if (lz === 0) this.markDirty(cx, cy, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markDirty(cx, cy, cz + 1);
  }

  private markDirty(x: number, y: number, z: number): void {
    const chunk = this.world.getChunk(x, y, z);
    if (chunk) chunk.dirty = true;
  }
}
