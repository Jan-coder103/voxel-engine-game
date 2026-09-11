import { isSolidForCollision, type VoxelMaterialID } from '../voxel/materials';
import { raycastVoxels } from '../voxel/raycast';

/**
 * NPC perception (Phase 13): the pure geometry half of reacting to the
 * world. Vision is a distance + field-of-view + voxel line-of-sight test
 * (the Phase 5 DDA reused — a wall really does block sight), and hearing
 * is plain distance attenuation: every GameEvent that matters carries a
 * world position, and a "hear radius" formula per event kind decides who
 * notices it. The behavior half (fear, flee, investigate) lives in
 * npc.ts; this module only answers spatial questions.
 *
 * The `ThreatBoard` is the sim's short memory of where bad things
 * happened: event positions with a tick expiry, capped and deduplicated
 * (a spreading fire emits one `fireIgnited` per cell — one blaze should
 * be one threat, not forty).
 *
 * Pure: no three.js, no DOM (ADR-002). Deterministic given world
 * contents — no RNG anywhere (ADR-005).
 */

/** Horizontal sight range in cells. */
export const SIGHT_DISTANCE = 24;
/** Total horizontal field of view (radians) — deliberately tunnel-ish. */
export const FIELD_OF_VIEW = (130 * Math.PI) / 180;
const COS_HALF_FOV = Math.cos(FIELD_OF_VIEW / 2);

/** A world-space point (cells; floats for event centroids). */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * True when nothing solid stands between `from` and `to`. The ray stops
 * `margin` short of `to` so a threat that *is* matter (a burning block)
 * does not occlude itself; solids block sight, water and air do not.
 */
export function hasLineOfSight(
  materialAt: (x: number, y: number, z: number) => VoxelMaterialID,
  from: Point3,
  to: Point3,
  margin = 0.75,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= margin) return true;
  const hit = raycastVoxels(
    { origin: from, direction: { x: dx, y: dy, z: dz } },
    dist - margin,
    materialAt,
    (m) => isSolidForCollision(m),
  );
  return hit === undefined;
}

/**
 * True when `target` lies inside the horizontal field of view of an eye
 * at `eye` facing `yaw` (the movement convention: facing = (−sin, −cos)).
 * Vertical angle is ignored — believable over correct.
 */
export function withinFov(eye: Point3, yaw: number, target: Point3): boolean {
  const dx = target.x - eye.x;
  const dz = target.z - eye.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true; // standing on it
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  return (dx / len) * fx + (dz / len) * fz >= COS_HALF_FOV;
}

/** Full vision test: range, then field of view, then occlusion. */
export function canSee(
  materialAt: (x: number, y: number, z: number) => VoxelMaterialID,
  eye: Point3,
  yaw: number,
  target: Point3,
): boolean {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  if (Math.hypot(dx, dy, dz) > SIGHT_DISTANCE) return false;
  if (!withinFov(eye, yaw, target)) return false;
  return hasLineOfSight(materialAt, eye, target);
}

/** What kind of bad thing a threat point remembers. */
export type ThreatKind = 'explosion' | 'collapse' | 'fire' | 'water';

export interface ThreatPoint {
  x: number;
  y: number;
  z: number;
  kind: ThreatKind;
  /** Sim tick after which the memory lapses. */
  expiresAtTick: number;
}

/**
 * Capped, deduplicated, expiring list of recent event sites. The NPC sim
 * scans it (vision) and aims flee/investigate paths at it (behavior).
 */
export class ThreatBoard {
  private points: ThreatPoint[] = [];

  constructor(private readonly capacity = 12) {}

  /**
   * Remember a threat. A point of the same kind within 4 cells refreshes
   * the existing memory instead of adding another (one blaze, one
   * threat); past the capacity the oldest memory is dropped.
   */
  add(point: ThreatPoint): void {
    for (const q of this.points) {
      if (
        q.kind === point.kind &&
        (q.x - point.x) ** 2 + (q.y - point.y) ** 2 + (q.z - point.z) ** 2 < 16
      ) {
        q.expiresAtTick = Math.max(q.expiresAtTick, point.expiresAtTick);
        return;
      }
    }
    if (this.points.length >= this.capacity) this.points.shift();
    this.points.push(point);
  }

  /** Drop expired memories (cheap; called from the staggered scans). */
  prune(now: number): void {
    if (this.points.some((p) => p.expiresAtTick <= now)) {
      this.points = this.points.filter((p) => p.expiresAtTick > now);
    }
  }

  get list(): readonly ThreatPoint[] {
    return this.points;
  }

  get size(): number {
    return this.points.length;
  }

  clear(): void {
    this.points.length = 0;
  }
}
