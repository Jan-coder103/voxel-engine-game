import * as THREE from 'three';
import { createDemoWorld, demoWorldSpawn } from './voxel/demoWorld';
import { meshVolume } from './voxel/mesher';
import { createEngine } from './render/bootstrap';
import { buildVoxelGeometry, createVoxelMaterial } from './render/voxelGeometry';
import { InputManager } from './player/input';
import { createPlayerState, eyePosition, stepPlayer, type PlayerState } from './player/controller';

/**
 * Phase 1 demo: walk around a voxel world. World state lives in
 * `VoxelVolume`; the engine and DOM layers consume it.
 */

const RESPAWN_HEIGHT = -32;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

function main(): void {
  const container = document.querySelector<HTMLElement>('#app');
  const overlay = document.querySelector<HTMLElement>('#overlay');
  const hud = document.querySelector<HTMLElement>('#hud');
  if (!container || !overlay || !hud) {
    throw new Error('Missing #app, #overlay, or #hud element');
  }

  // World → mesh → geometry.
  const world = createDemoWorld();
  const mesh = meshVolume(world);
  const solidAt = (x: number, y: number, z: number) => world.getOrAir(x, y, z) !== 0;

  const engine = createEngine(container);
  const geometry = buildVoxelGeometry(mesh);
  const terrain = new THREE.Mesh(geometry, createVoxelMaterial());
  engine.scene.add(terrain);

  // Player.
  const player: PlayerState = createPlayerState(demoWorldSpawn());
  const input = new InputManager(engine.renderer.domElement);
  input.attach();

  overlay.addEventListener('click', () => input.requestLock());
  const crosshair = document.querySelector<HTMLElement>('#crosshair');
  const syncOverlay = () => {
    overlay.classList.toggle('hidden', input.isLocked);
    crosshair?.classList.toggle('hidden', !input.isLocked);
  };
  document.addEventListener('pointerlockchange', syncOverlay);

  // Fixed-timestep simulation so collision behaves identically at any
  // frame rate (and can't tunnel at low FPS).
  let accumulator = 0;
  let fpsTime = 0;
  let fpsFrames = 0;

  engine.start((frameDt) => {
    accumulator = Math.min(accumulator + frameDt, FIXED_DT * MAX_SUBSTEPS);
    while (accumulator >= FIXED_DT) {
      const frameInput = input.takeFrameInput();
      if (input.isLocked) {
        stepPlayer(player, frameInput, solidAt, FIXED_DT);
      } else {
        // Still consume so mouse deltas don't pile up while unlocked.
        void frameInput;
      }
      accumulator -= FIXED_DT;
    }

    if (player.position.y < RESPAWN_HEIGHT) {
      Object.assign(player.position, demoWorldSpawn());
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;
    }

    const eye = eyePosition(player);
    engine.camera.position.set(eye.x, eye.y, eye.z);
    engine.camera.rotation.set(player.pitch, player.yaw, 0);

    fpsFrames++;
    fpsTime += frameDt;
    if (fpsTime >= 0.5) {
      const fps = Math.round(fpsFrames / fpsTime);
      const p = player.position;
      hud.textContent =
        `fps ${fps} · quads ${mesh.quadCount} · ` +
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` +
        (player.onGround ? '' : ' · air');
      fpsFrames = 0;
      fpsTime = 0;
    }
  });
}

main();
