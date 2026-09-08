import type { WorldCoordinate } from '../voxel/coordinates';

/**
 * First-person player simulation. Pure: no DOM, no three.js — takes an
 * input snapshot and a solid-voxel query, integrates physics, resolves
 * collisions per axis against the voxel grid (AABB sweep, axis by axis).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState {
  /** Feet position (bottom center of the AABB). */
  position: Vec3;
  velocity: Vec3;
  /** Horizontal look angle, radians. yaw = 0 faces -Z. */
  yaw: number;
  /** Vertical look angle, radians, clamped to ±π/2. */
  pitch: number;
  /** True while standing on a solid voxel (refreshed every step). */
  onGround: boolean;
}

export interface FrameInput {
  /** Strafe: +1 right, -1 left. */
  moveX: number;
  /** Forward: +1 forward, -1 back. */
  moveZ: number;
  jump: boolean;
  /** Mouse look deltas, already converted to radians. */
  yawDelta: number;
  pitchDelta: number;
}

/** Player AABB is WIDTH × HEIGHT, centered on the feet position in X/Z. */
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

export const WALK_SPEED = 4.3;
export const GRAVITY = 24;
/** Jump velocity for a ~1.1 voxel-high hop: v² / (2g) ≈ 1.08 m. */
export const JUMP_SPEED = 7.2;

const EPS = 1e-7;

export function createPlayerState(spawn: WorldCoordinate): PlayerState {
  return {
    position: { x: spawn.x, y: spawn.y, z: spawn.z },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: Math.PI, // face +Z toward the demo cube
    pitch: 0,
    onGround: false,
  };
}

/** Apply mouse look. Deltas are radians (positive yawDelta = turn right). */
export function applyLook(state: PlayerState, input: FrameInput): void {
  state.yaw -= input.yawDelta;
  state.pitch -= input.pitchDelta;
  const limit = Math.PI / 2;
  if (state.pitch > limit) state.pitch = limit;
  if (state.pitch < -limit) state.pitch = -limit;
}

/** Eye position for the camera (feet + eye height). */
export function eyePosition(state: PlayerState): Vec3 {
  return {
    x: state.position.x,
    y: state.position.y + EYE_HEIGHT,
    z: state.position.z,
  };
}

/** True if any voxel cell overlapping the given AABB is solid. */
function aabbIntersectsSolid(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  solidAt: (x: number, y: number, z: number) => boolean,
): boolean {
  const x0 = Math.floor(minX);
  const x1 = Math.floor(maxX - EPS);
  const y0 = Math.floor(minY);
  const y1 = Math.floor(maxY - EPS);
  const z0 = Math.floor(minZ);
  const z1 = Math.floor(maxZ - EPS);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (solidAt(x, y, z)) return true;
      }
    }
  }
  return false;
}

/**
 * Advance the player one fixed timestep: look, jump, gravity, then
 * move-and-collide along Y, X, Z in that order.
 */
export function stepPlayer(
  state: PlayerState,
  input: FrameInput,
  solidAt: (x: number, y: number, z: number) => boolean,
  dt: number,
): void {
  applyLook(state, input);

  // Horizontal wish direction in world space, normalized so diagonals
  // aren't faster.
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  let wishX = input.moveX * cos - input.moveZ * sin;
  let wishZ = -input.moveX * sin - input.moveZ * cos;
  const wishLength = Math.hypot(wishX, wishZ);
  if (wishLength > 1) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }
  state.velocity.x = wishX * WALK_SPEED;
  state.velocity.z = wishZ * WALK_SPEED;

  if (input.jump && state.onGround) {
    state.velocity.y = JUMP_SPEED;
    state.onGround = false;
  }
  state.velocity.y -= GRAVITY * dt;

  const half = PLAYER_WIDTH / 2;
  const p = state.position;
  const v = state.velocity;

  // Y axis: land on floors / bump ceilings.
  p.y += v.y * dt;
  if (
    aabbIntersectsSolid(
      p.x - half,
      p.y,
      p.z - half,
      p.x + half,
      p.y + PLAYER_HEIGHT,
      p.z + half,
      solidAt,
    )
  ) {
    if (v.y <= 0) {
      // Penetrated cell below the feet; rest on its top plane.
      p.y = Math.floor(p.y - EPS) + 1 + EPS;
      state.onGround = true;
    } else {
      // Head penetrated a cell; clamp below its bottom plane.
      p.y = Math.floor(p.y + PLAYER_HEIGHT - EPS) - PLAYER_HEIGHT - EPS;
    }
    v.y = 0;
  } else if (v.y < 0) {
    state.onGround = false;
  }

  // X axis.
  p.x += v.x * dt;
  if (
    aabbIntersectsSolid(
      p.x - half,
      p.y,
      p.z - half,
      p.x + half,
      p.y + PLAYER_HEIGHT,
      p.z + half,
      solidAt,
    )
  ) {
    if (v.x > 0) {
      p.x = Math.floor(p.x + half - EPS) - half - EPS;
    } else if (v.x < 0) {
      p.x = Math.floor(p.x - half - EPS) + 1 + half + EPS;
    }
    v.x = 0;
  }

  // Z axis.
  p.z += v.z * dt;
  if (
    aabbIntersectsSolid(
      p.x - half,
      p.y,
      p.z - half,
      p.x + half,
      p.y + PLAYER_HEIGHT,
      p.z + half,
      solidAt,
    )
  ) {
    if (v.z > 0) {
      p.z = Math.floor(p.z + half - EPS) - half - EPS;
    } else if (v.z < 0) {
      p.z = Math.floor(p.z - half - EPS) + 1 + half + EPS;
    }
    v.z = 0;
  }
}
