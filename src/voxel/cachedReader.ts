import { worldToChunk } from './coordinates';
import { AIR, type VoxelMaterialID } from './materials';
import type { Chunk } from './chunk';
import type { World } from './world';

/**
 * A getVoxel-shaped reader with a real chunk cache (Phase 15). The
 * World's own memo holds ONE chunk; component BFS hops between chunks
 * on nearly every read and thrashes it — measured ~0.9 µs per call on a
 * town-scale grid, which put a full power-grid rebuild at ~30 ms. With
 * a cache sized for the component's working set, chunk switches cost
 * one map lookup and in-chunk reads are direct (~30× faster overall).
 *
 * The cache is stale the moment chunks load or unload, so a reader is
 * strictly a per-rebuild object: create it, flood with it, drop it.
 * Never store it on the sim.
 */
export function makeCachedReader(
  world: World,
): (x: number, y: number, z: number) => VoxelMaterialID {
  type Entry = { cx: number; cy: number; cz: number; chunk: Chunk | undefined };
  const entries = new Map<number, Entry>();
  let last: Entry | undefined;
  return (x, y, z) => {
    const cx = worldToChunk(x);
    const cy = worldToChunk(y);
    const cz = worldToChunk(z);
    let entry = last;
    if (!entry || entry.cx !== cx || entry.cy !== cy || entry.cz !== cz) {
      // Integer key: chunk coords fit comfortably in ±0x8000 / ±8.
      const key = (cx + 0x8000) * 0x100000000 + (cz + 0x8000) * 0x10 + (cy + 8);
      entry = entries.get(key);
      if (!entry) {
        entry = { cx, cy, cz, chunk: world.getChunk(cx, cy, cz) };
        entries.set(key, entry);
      }
      last = entry;
    }
    const chunk = entry.chunk;
    if (!chunk) return AIR;
    return chunk.volume.getOrAir(x - cx * 16, y - cy * 16, z - cz * 16);
  };
}
