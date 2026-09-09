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
  /** True while any part of the player is in water (refreshed every step). */
  inWater: boolean;
  /**
   * True for the step after a water wall-assist fired, so the boost
   * survives the swim-speed cap while the player hauls over a ledge.
   */
  climbBoost: boolean;
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

// --- Water (Phase 9) -------------------------------------------------------
/** Reduced gravity while in water (buoyancy counteracts most of it). */
export const WATER_GRAVITY = 5;
/** Exponential vertical drag per second in water (damps falls and rises). */
export const WATER_DRAG = 3.2;
/** Terminal sinking speed in water. */
export const WATER_SINK_SPEED = 2.2;
/** Maximum upward swim speed while holding jump in water. */
export const WATER_SWIM_SPEED = 3.4;
/** Swim acceleration while holding jump in water. */
export const WATER_SWIM_ACCEL = 18;
/** Horizontal speed multiplier while wading/swimming. */
export const WATER_WALK_FACTOR = 0.55;
/**
 * Wall-assist burst when swimming against a ledge holding jump. Tall
 * enough to ballistic-clear a one-voxel shore above the waterline
 * (v²/2g ≈ 1.7 m) — hauling out of a pool is a real hop.
 */
export const WATER_CLIMB_SPEED = 9;

const EPS = 1e-7;

export function createPlayerState(spawn: WorldCoordinate): PlayerState {
  return {
    position: { x: spawn.x, y: spawn.y, z: spawn.z },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: Math.PI, // face +Z toward the demo cube
    pitch: 0,
    onGround: false,
    inWater: false,
    climbBoost: false,
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
 * True if the height `py` is below the water surface in its cell.
 * `waterAt` reports the cell's fluid level (0–255).
 */
function submergedAt(
  waterAt: (x: number, y: number, z: number) => number,
  px: number,
  py: number,
  pz: number,
): boolean {
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  const level = waterAt(cx, cy, cz);
  return level > 0 && cy + level / 255 > py;
}

/**
 * Advance the player one fixed timestep: look, jump, gravity (buoyant in
 * water), then move-and-collide along Y, X, Z in that order. The optional
 * `waterAt` query enables swimming/buoyancy (Phase 9); without it the
 * player ignores water exactly as before.
 */
export function stepPlayer(
  state: PlayerState,
  input: FrameInput,
  solidAt: (x: number, y: number, z: number) => boolean,
  dt: number,
  waterAt?: (x: number, y: number, z: number) => number,
): void {
  applyLook(state, input);

  // Water probes: slightly above the feet (wading) and at the eye
  // (submerged). Either counts as "in water".
  const p = state.position;
  const eye = eyePosition(state);
  state.inWater =
    waterAt !== undefined &&
    (submergedAt(waterAt, p.x, p.y + 0.2, p.z) || submergedAt(waterAt, eye.x, eye.y, eye.z));

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
  const speed = state.inWater ? WALK_SPEED * WATER_WALK_FACTOR : WALK_SPEED;
  state.velocity.x = wishX * speed;
  state.velocity.z = wishZ * speed;

  if (input.jump && state.onGround) {
    state.velocity.y = JUMP_SPEED;
    state.onGround = false;
  }
  if (state.inWater) {
    // Buoyant vertical motion: weak gravity, strong drag, capped rise and
    // sink; holding jump swims up. A climb boost (set at the end of the
    // previous step) is exempt from the swim cap for this one step so the
    // wall-assist burst can carry the player over a ledge.
    state.velocity.y -= WATER_GRAVITY * dt;
    if (input.jump) state.velocity.y += WATER_SWIM_ACCEL * dt;
    const damp = Math.max(0, 1 - WATER_DRAG * dt);
    state.velocity.y *= damp;
    if (state.velocity.y < -WATER_SINK_SPEED) state.velocity.y = -WATER_SINK_SPEED;
    const riseCap = state.climbBoost ? WATER_CLIMB_SPEED : WATER_SWIM_SPEED;
    if (state.velocity.y > riseCap) state.velocity.y = riseCap;
  } else {
    state.velocity.y -= GRAVITY * dt;
  }
  state.climbBoost = false;

  const half = PLAYER_WIDTH / 2;
  const v = state.velocity;
  let hitWall = false;

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
    if (v.x !== 0) hitWall = true;
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
    if (v.z !== 0) hitWall = true;
    v.z = 0;
  }

  // Water edge assist: pressed against a ledge while swimming and holding
  // jump → hop onto it (without this, 1-voxel shores are unclimbable).
  if (state.inWater && hitWall && input.jump) {
    state.velocity.y = Math.max(state.velocity.y, WATER_CLIMB_SPEED);
    state.climbBoost = true;
  }
}
