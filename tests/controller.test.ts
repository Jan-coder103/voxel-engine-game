import { describe, expect, it } from 'vitest';
import {
  EYE_HEIGHT,
  GRAVITY,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  WALK_SPEED,
  applyLook,
  createPlayerState,
  eyePosition,
  stepPlayer,
  type FrameInput,
  type PlayerState,
} from '../src/player/controller';
import { STONE, isSolidForCollision } from '../src/voxel/materials';
import { VoxelVolume } from '../src/voxel/voxelVolume';

const DT = 1 / 60;

const NO_INPUT: FrameInput = {
  moveX: 0,
  moveZ: 0,
  jump: false,
  yawDelta: 0,
  pitchDelta: 0,
};

/** Ground plane: solid voxels for y ≤ groundY (via a 4-thick slab). */
function groundVolume(groundY = 3): VoxelVolume {
  const volume = new VoxelVolume(32);
  for (let y = 0; y <= groundY; y++)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) volume.set(x, y, z, STONE);
  return volume;
}

function makeSolid(volume: VoxelVolume) {
  return (x: number, y: number, z: number) => isSolidForCollision(volume.getOrAir(x, y, z));
}

function spawnAbove(groundTop: number, x = 16.5, z = 16.5): PlayerState {
  return createPlayerState({ x, y: groundTop + 0.5, z });
}

/** Run until the player comes to rest vertically (or maxSteps). */
function settle(state: PlayerState, solid: (x: number, y: number, z: number) => boolean) {
  for (let i = 0; i < 600; i++) {
    stepPlayer(state, NO_INPUT, solid, DT);
    if (state.onGround && Math.abs(state.velocity.y) < 1e-9) break;
  }
}

describe('look', () => {
  it('yaw and pitch follow deltas', () => {
    const state = createPlayerState({ x: 0, y: 0, z: 0 });
    state.yaw = 0; // start from a known orientation (spawn default is π)
    applyLook(state, { ...NO_INPUT, yawDelta: 0.5, pitchDelta: 0.2 });
    expect(state.yaw).toBeCloseTo(-0.5);
    expect(state.pitch).toBeCloseTo(-0.2);
  });

  it('clamps pitch to ±90° but never clamps yaw', () => {
    const state = createPlayerState({ x: 0, y: 0, z: 0 });
    // Positive pitchDelta = mouse down = look down = pitch → −π/2.
    applyLook(state, { ...NO_INPUT, pitchDelta: 10 });
    expect(state.pitch).toBe(-Math.PI / 2);
    applyLook(state, { ...NO_INPUT, pitchDelta: -20 });
    expect(state.pitch).toBe(Math.PI / 2);
    applyLook(state, { ...NO_INPUT, yawDelta: 100 });
    expect(Math.abs(state.yaw)).toBeGreaterThan(10);
  });
});

describe('gravity and ground', () => {
  it('falls under gravity and lands exactly on the ground surface', () => {
    const volume = groundVolume(3); // solid through y=3, top surface at y=4
    const solid = makeSolid(volume);
    const state = spawnAbove(4);
    settle(state, solid);
    expect(state.onGround).toBe(true);
    expect(state.position.y).toBeCloseTo(4, 5);
    expect(state.velocity.y).toBe(0);
  });

  it('reports onGround=false once walking off a ledge', () => {
    // Platform only under x < 16.
    const volume = new VoxelVolume(32);
    for (let y = 0; y <= 3; y++)
      for (let z = 0; z < 32; z++) for (let x = 0; x < 16; x++) volume.set(x, y, z, STONE);
    const solid = makeSolid(volume);
    const state = spawnAbove(4, 8.5, 16.5);
    settle(state, solid);
    expect(state.onGround).toBe(true);

    // Walk in +X off the edge.
    for (let i = 0; i < 240; i++) {
      stepPlayer(state, { ...NO_INPUT, moveX: 1 }, solid, DT);
    }
    expect(state.onGround).toBe(false);
    expect(state.position.y).toBeLessThan(3);
  });

  it('never sinks into the ground while settling from far above', () => {
    const volume = groundVolume(3);
    const solid = makeSolid(volume);
    const state = createPlayerState({ x: 16.5, y: 30, z: 16.5 });
    settle(state, solid);
    expect(state.position.y).toBeGreaterThanOrEqual(4);
    expect(state.position.y).toBeLessThan(4.1);
  });
});

describe('jumping', () => {
  it('jumps, rises, then lands back on the ground', () => {
    const volume = groundVolume(3);
    const solid = makeSolid(volume);
    const state = spawnAbove(4);
    settle(state, solid);

    const jumpInput = { ...NO_INPUT, jump: true };
    stepPlayer(state, jumpInput, solid, DT);
    expect(state.onGround).toBe(false);

    let maxY = state.position.y;
    let landed = false;
    for (let i = 0; i < 300; i++) {
      stepPlayer(state, jumpInput, solid, DT);
      maxY = Math.max(maxY, state.position.y);
      if (i > 10 && state.onGround) {
        landed = true;
        break;
      }
    }
    expect(landed).toBe(true);
    // Jump height = JUMP_SPEED² / (2·GRAVITY) ≈ 1.08 — clears a 1-voxel step.
    expect(maxY).toBeGreaterThan(4 + 1.0);
    expect(maxY).toBeLessThan(4 + 1.2);
    expect(state.position.y).toBeCloseTo(4, 5);
  });

  it('cannot jump while airborne', () => {
    const volume = groundVolume(3);
    const solid = makeSolid(volume);
    const state = spawnAbove(4);
    // Still falling: not on ground.
    expect(state.onGround).toBe(false);
    const vyBefore = state.velocity.y;
    stepPlayer(state, { ...NO_INPUT, jump: true }, solid, DT);
    expect(state.velocity.y).toBeLessThan(vyBefore + 0.001); // only gravity
  });
});

describe('walking and walls', () => {
  it('moves forward at walk speed relative to yaw', () => {
    const volume = groundVolume(3);
    const solid = makeSolid(volume);
    const state = spawnAbove(4);
    settle(state, solid);
    state.yaw = 0; // face −Z

    // Face -Z (yaw 0): forward input should move z negative.
    stepPlayer(state, { ...NO_INPUT, moveZ: 1 }, solid, DT);
    expect(state.position.z).toBeLessThan(16.5);
    expect(Math.abs(state.position.x - 16.5)).toBeLessThan(1e-6);
  });

  it('stops at a wall without interpenetration', () => {
    const volume = groundVolume(3);
    // Wall: solid column at x=20, full height.
    for (let y = 4; y < 12; y++) for (let z = 0; z < 32; z++) volume.set(20, y, z, STONE);
    const solid = makeSolid(volume);
    const state = spawnAbove(4, 16.5, 16.5);
    settle(state, solid);

    // Face +X (yaw = -π/2 makes forward = +X) and walk into the wall.
    state.yaw = -Math.PI / 2;
    for (let i = 0; i < 600; i++) {
      stepPlayer(state, { ...NO_INPUT, moveZ: 1 }, solid, DT);
    }
    const half = PLAYER_WIDTH / 2;
    expect(state.position.x).toBeCloseTo(20 - half, 3);
    expect(state.velocity.x).toBe(0);
    // Definitely not inside the wall voxel.
    expect(solid(Math.floor(state.position.x + half), 5, 16)).toBe(false);
  });

  it('slides along a wall: blocked on one axis, free on the other', () => {
    const volume = groundVolume(3);
    for (let y = 4; y < 12; y++) for (let z = 0; z < 32; z++) volume.set(20, y, z, STONE);
    const solid = makeSolid(volume);
    const state = spawnAbove(4, 16.5, 16.5);
    settle(state, solid);
    state.yaw = -Math.PI / 2; // forward = +X

    // Diagonal input: forward (+X, blocked) + strafe left (−Z... depends).
    const startZ = state.position.z;
    for (let i = 0; i < 120; i++) {
      stepPlayer(state, { ...NO_INPUT, moveZ: 1, moveX: 1 }, solid, DT);
    }
    // Strafe (with yaw=-π/2, moveX=+1 is +Z... verify perpendicular motion happened)
    expect(Math.abs(state.position.z - startZ)).toBeGreaterThan(0.5);
    // But X still blocked at the wall.
    expect(state.position.x).toBeLessThan(20);
  });

  it('climbs 1-voxel steps by jumping', () => {
    const volume = groundVolume(3);
    // Step: voxel layer at y=4 covering x ≥ 10 (top surface at y=5).
    for (let z = 0; z < 32; z++) for (let x = 10; x < 32; x++) volume.set(x, 4, z, STONE);
    const solid = makeSolid(volume);
    // Spawn on the low side (x < 10) and walk toward the step.
    const state = spawnAbove(4, 6.5, 16.5);
    settle(state, solid);
    expect(state.position.y).toBeCloseTo(4, 5);
    state.yaw = -Math.PI / 2; // forward = +X toward the step

    const jump = { ...NO_INPUT, moveZ: 1, jump: true };
    let reached = false;
    for (let i = 0; i < 600; i++) {
      stepPlayer(state, jump, solid, DT);
      if (state.onGround && state.position.x > 11) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    expect(state.position.y).toBeCloseTo(5, 3); // now standing on the step
  });

  it('eye position is feet plus eye height', () => {
    const state = createPlayerState({ x: 1, y: 2, z: 3 });
    expect(eyePosition(state)).toEqual({ x: 1, y: 2 + EYE_HEIGHT, z: 3 });
  });

  it('constant sanity: player fits through 1-voxel gaps', () => {
    expect(PLAYER_WIDTH).toBeLessThanOrEqual(1);
    expect(PLAYER_HEIGHT).toBeGreaterThan(EYE_HEIGHT);
    expect(GRAVITY).toBeGreaterThan(0);
    expect(WALK_SPEED).toBeGreaterThan(0);
  });
});
