import type { World } from './world';
import type { VoxelMaterialID } from './materials';
import type { WorldCoordinate } from './coordinates';

/**
 * Edits as commands: every world mutation goes through `applyEdits`, which
 * captures the previous materials, applies through `World.setVoxel` (so
 * dirty-flag remeshing and the persistence journal stay authoritative),
 * and returns one `EditCommand`. The history is a standard undo/redo
 * stack pair: pushing clears the redo branch, undo/redo re-apply stored
 * values, and a cap bounds memory for large brush strokes.
 */

/** One cell change: world-space voxel + the material it becomes. */
export interface VoxelEdit {
  x: number;
  y: number;
  z: number;
  material: VoxelMaterialID;
}

export interface EditCommand {
  /** Human-readable reason (HUD/undo tooltip, debugging). */
  readonly label: string;
  /** Values applied by this command (redo replays these). */
  readonly edits: readonly VoxelEdit[];
  /** Values captured before applying (undo restores these). */
  readonly previous: readonly VoxelEdit[];
}

/** Max commands kept for undo; oldest commands fall off the far end. */
export const MAX_HISTORY = 128;

/**
 * Apply edits to the world as one grouped command. Cells whose material
 * would not change are skipped; if nothing changes, returns undefined and
 * the history stays untouched. Applies even where `setVoxel` fails
 * (unloaded chunks) is impossible by construction: failed cells are
 * skipped too, so the command is exactly what changed.
 */
export function applyEdits(world: World, edits: readonly VoxelEdit[], label: string): EditCommand | undefined {
  const applied: VoxelEdit[] = [];
  const previous: VoxelEdit[] = [];
  for (const edit of edits) {
    const before = world.getVoxel(edit.x, edit.y, edit.z);
    if (before === edit.material) continue;
    if (!world.setVoxel(edit.x, edit.y, edit.z, edit.material)) continue;
    applied.push(edit);
    previous.push({ x: edit.x, y: edit.y, z: edit.z, material: before });
  }
  if (applied.length === 0) return undefined;
  return { label, edits: applied, previous };
}

export class EditHistory {
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /** Record an already-applied command; drops the redo branch. */
  push(command: EditCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Revert the newest command. Returns true if it ran. */
  undo(world: World): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    applyCaptured(world, command.previous);
    this.redoStack.push(command);
    return true;
  }

  /** Re-apply the most recently undone command. Returns true if it ran. */
  redo(world: World): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    applyCaptured(world, command.edits);
    this.undoStack.push(command);
    return true;
  }

  /** Forget all history (world reset / load). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Apply stored values directly; used by undo/redo on known cells. */
function applyCaptured(world: World, edits: readonly VoxelEdit[]): void {
  for (const edit of edits) world.setVoxel(edit.x, edit.y, edit.z, edit.material);
}

/**
 * True if the voxel cell `[x, x+1) × …` overlaps the player AABB at
 * `playerPos` (feet center). Editing uses this to refuse placements that
 * would bury the player. Pure, shared with tests.
 */
export function intersectsPlayerCell(
  voxel: WorldCoordinate,
  playerPos: { x: number; y: number; z: number },
  halfWidth: number,
  height: number,
): boolean {
  return (
    voxel.x + 1 > playerPos.x - halfWidth &&
    voxel.x < playerPos.x + halfWidth &&
    voxel.y + 1 > playerPos.y &&
    voxel.y < playerPos.y + height &&
    voxel.z + 1 > playerPos.z - halfWidth &&
    voxel.z < playerPos.z + halfWidth
  );
}
