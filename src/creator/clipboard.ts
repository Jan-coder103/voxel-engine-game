import type { WorldCoordinate } from '../voxel/coordinates';
import { AIR, type VoxelMaterialID } from '../voxel/materials';
import type { VoxelEdit } from '../voxel/edits';
import type { VolumeSnapshot } from './selection';

/**
 * Clipboard (Phase 7): pure transforms over a copied volume. Copy/cut
 * produce a `VolumeSnapshot`; rotate/mirror/remap return new snapshots;
 * paste flattens a snapshot into an edit list that flows through
 * `applyEdits` as one grouped, undoable command.
 *
 * Volume layout matches `VoxelVolume`: index = x + z·sx + y·sx·sz.
 */

export type ClipboardVolume = VolumeSnapshot;

function index(sx: number, sz: number, x: number, y: number, z: number): number {
  return x + z * sx + y * sx * sz;
}

export function clipboardGet(
  clip: ClipboardVolume,
  x: number,
  y: number,
  z: number,
): VoxelMaterialID {
  return clip.voxels[index(clip.size.x, clip.size.z, x, y, z)];
}

/**
 * Rotate 90° steps around the vertical (Y) axis. Positive `quarters` turns
 * the content clockwise when viewed from above; size.x and size.z swap on
 * odd quarters. Out-of-range quarter counts wrap (modulo 4).
 */
export function rotateClipboardY(clip: ClipboardVolume, quarters: number): ClipboardVolume {
  const q = ((quarters % 4) + 4) % 4;
  if (q === 0) return clip;
  const once = q === 1 || q === 3;
  const size = once ? { x: clip.size.z, y: clip.size.y, z: clip.size.x } : { ...clip.size };
  const out = new Uint16Array(size.x * size.y * size.z);
  for (let y = 0; y < clip.size.y; y++) {
    for (let z = 0; z < clip.size.z; z++) {
      for (let x = 0; x < clip.size.x; x++) {
        const v = clip.voxels[index(clip.size.x, clip.size.z, x, y, z)];
        if (q === 1) out[index(size.x, size.z, size.x - 1 - z, y, x)] = v;
        else if (q === 2) out[index(size.x, size.z, size.x - 1 - x, y, size.z - 1 - z)] = v;
        else out[index(size.x, size.z, z, y, size.z - 1 - x)] = v;
      }
    }
  }
  return { size, voxels: out };
}

/** Mirror across the volume's local X axis (content flips left↔right). */
export function mirrorClipboardX(clip: ClipboardVolume): ClipboardVolume {
  const out = new Uint16Array(clip.voxels.length);
  for (let y = 0; y < clip.size.y; y++) {
    for (let z = 0; z < clip.size.z; z++) {
      for (let x = 0; x < clip.size.x; x++) {
        out[index(clip.size.x, clip.size.z, clip.size.x - 1 - x, y, z)] =
          clip.voxels[index(clip.size.x, clip.size.z, x, y, z)];
      }
    }
  }
  return { size: { ...clip.size }, voxels: out };
}

/** Rename materials via a mapping; unmapped ids pass through unchanged. */
export function remapClipboard(
  clip: ClipboardVolume,
  mapping: ReadonlyMap<VoxelMaterialID, VoxelMaterialID>,
): ClipboardVolume {
  const out = new Uint16Array(clip.voxels.length);
  for (let i = 0; i < clip.voxels.length; i++) {
    out[i] = mapping.get(clip.voxels[i]) ?? clip.voxels[i];
  }
  return { size: { ...clip.size }, voxels: out };
}

/**
 * Flatten the clipboard into an edit list anchored with its minimum corner
 * at `origin`. Air cells in the snapshot are skipped by default (pasting
 * never gouges holes in the world); `solid` pastes them too, recreating
 * the copied volume exactly.
 */
export function pasteEdits(
  clip: ClipboardVolume,
  origin: WorldCoordinate,
  options: { solid?: boolean } = {},
): VoxelEdit[] {
  const edits: VoxelEdit[] = [];
  for (let y = 0; y < clip.size.y; y++) {
    for (let z = 0; z < clip.size.z; z++) {
      for (let x = 0; x < clip.size.x; x++) {
        const material = clipboardGet(clip, x, y, z);
        if (material === AIR && !options.solid) continue;
        edits.push({ x: origin.x + x, y: origin.y + y, z: origin.z + z, material });
      }
    }
  }
  return edits;
}
