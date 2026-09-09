import type { WorldCoordinate } from './coordinates';
import { WORLD_HEIGHT } from './coordinates';
import { AIR, WATER, type VoxelMaterialID } from './materials';

/**
 * Support check (Phase 8): after destructive edits, find solid cells that
 * are no longer connected to the ground and would fall. This is the
 * simplified, believable version of the Phase 11 structural graph — a
 * 6-connected flood fill over a bounded region around the edit, anchored
 * at the bedrock floor and at the region's horizontal boundary (anything
 * continuing past the scan edge is assumed grounded, which keeps the scan
 * local instead of world-wide).
 *
 * Budgeted: regions above the scan cap report `checked: false` and the
 * caller skips collapse for that edit instead of hitching the frame.
 */

export interface SupportRegion {
  /** Inclusive min corner (y is usually 0). */
  min: WorldCoordinate;
  /** Inclusive max corner. */
  max: WorldCoordinate;
}

/** Region cells (including air) the check is willing to scan. */
export const SUPPORT_SCAN_BUDGET = 150_000;

/**
 * How far the scan extends past the affected edit bounds horizontally and
 * upward. A house-scale structure fits well inside; larger builds anchor
 * at the scan edge and are intentionally left standing.
 */
export const SUPPORT_MARGIN = 12;

export interface SupportCheckResult {
  /** Cells that would fall (empty when everything is supported). */
  unsupported: WorldCoordinate[];
  /** False when the region exceeded the scan budget (check skipped). */
  checked: boolean;
  /** Cells scanned — diagnostics/profiling. */
  scanned: number;
}

/** The scan region for an affected edit bounds (pure helper for callers). */
export function supportRegionFor(affected: {
  min: WorldCoordinate;
  max: WorldCoordinate;
}): SupportRegion {
  return {
    min: {
      x: affected.min.x - SUPPORT_MARGIN,
      y: 0,
      z: affected.min.z - SUPPORT_MARGIN,
    },
    max: {
      x: affected.max.x + SUPPORT_MARGIN,
      y: Math.min(affected.max.y + SUPPORT_MARGIN, WORLD_HEIGHT - 1),
      z: affected.max.z + SUPPORT_MARGIN,
    },
  };
}

function isSolid(material: VoxelMaterialID): boolean {
  return material !== AIR && material !== WATER;
}

/**
 * Find unsupported solid cells in the region. `query` is usually
 * `world.getVoxel` (unloaded chunks read as air).
 *
 * Two passes: snapshot the region's solidity into a flat buffer (one
 * world query per cell), then flood-fill over the buffer with inline
 * index math — the BFS itself allocates nothing per cell, which keeps a
 * house-scale check in low single-digit milliseconds.
 */
export function checkSupport(
  query: (x: number, y: number, z: number) => VoxelMaterialID,
  region: SupportRegion,
  cellBudget = SUPPORT_SCAN_BUDGET,
): SupportCheckResult {
  const sx = region.max.x - region.min.x + 1;
  const sy = region.max.y - region.min.y + 1;
  const sz = region.max.z - region.min.z + 1;
  const layer = sx * sz;
  if (sx * sy * sz > cellBudget) {
    return { unsupported: [], checked: false, scanned: 0 };
  }

  // Pass 1: snapshot solidity (1 = solid) with a single world query per cell.
  const solid = new Uint8Array(sx * sy * sz);
  for (let y = 0; y < sy; y++) {
    const wy = region.min.y + y;
    for (let z = 0; z < sz; z++) {
      const wz = region.min.z + z;
      for (let x = 0; x < sx; x++) {
        if (isSolid(query(region.min.x + x, wy, wz))) solid[x + z * sx + y * layer] = 1;
      }
    }
  }

  // Pass 2: connected components over the snapshot.
  const visited = new Uint8Array(solid.length);
  const queue = new Int32Array(solid.length);
  const component: number[] = [];
  const unsupported: WorldCoordinate[] = [];
  let scanned = 0;

  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || visited[start]) continue;

    // BFS one connected component, collecting flat indices.
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let anchored = false;
    component.length = 0;
    while (head < tail) {
      const flat = queue[head++];
      component.push(flat);
      scanned++;

      const lx = flat % sx;
      const lz = ((flat - lx) / sx) % sz;
      const ly = (flat - lx - lz * sx) / layer;
      if (ly === 0 || lx === 0 || lx === sx - 1 || lz === 0 || lz === sz - 1) {
        anchored = true; // bedrock below (y=0 layer) or grounded past the edge
      }

      // Six neighbors, inline; x/z edges of the region act as anchors, so
      // we can skip walking out of bounds there.
      if (lx > 0 && !visited[flat - 1] && solid[flat - 1]) {
        visited[flat - 1] = 1;
        queue[tail++] = flat - 1;
      }
      if (lx < sx - 1 && !visited[flat + 1] && solid[flat + 1]) {
        visited[flat + 1] = 1;
        queue[tail++] = flat + 1;
      }
      if (lz > 0 && !visited[flat - sx] && solid[flat - sx]) {
        visited[flat - sx] = 1;
        queue[tail++] = flat - sx;
      }
      if (lz < sz - 1 && !visited[flat + sx] && solid[flat + sx]) {
        visited[flat + sx] = 1;
        queue[tail++] = flat + sx;
      }
      if (ly > 0 && !visited[flat - layer] && solid[flat - layer]) {
        visited[flat - layer] = 1;
        queue[tail++] = flat - layer;
      }
      if (ly < sy - 1 && !visited[flat + layer] && solid[flat + layer]) {
        visited[flat + layer] = 1;
        queue[tail++] = flat + layer;
      }
    }

    if (!anchored) {
      for (const flat of component) {
        const lx = flat % sx;
        const lz = ((flat - lx) / sx) % sz;
        const ly = (flat - lx - lz * sx) / layer;
        unsupported.push({
          x: region.min.x + lx,
          y: region.min.y + ly,
          z: region.min.z + lz,
        });
      }
    }
  }

  return { unsupported, checked: true, scanned };
}
