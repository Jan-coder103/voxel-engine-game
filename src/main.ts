import { CHUNK_SIZE, WORLD_HEIGHT_CHUNKS } from './voxel/coordinates';
import { World } from './voxel/world';
import { streamingParams } from './voxel/streaming';
import { DEFAULT_TERRAIN, type TerrainParams, findSpawn, generateChunk } from './voxel/terrain';
import { isSolidForCollision } from './voxel/materials';
import { createEngine } from './render/bootstrap';
import { ChunkMeshManager } from './render/chunkMeshes';
import { createVoxelMaterials } from './render/voxelMaterial';
import { InputManager } from './player/input';
import { createPlayerState, eyePosition, stepPlayer, type PlayerState } from './player/controller';

/**
 * Phase 3 demo: an infinite streamed world of deterministic seeded
 * terrain (hills, mountains, plains, sea level). Chunk data lives in
 * `World`; `ChunkMeshManager` builds and retires meshes around the player.
 */

const RENDER_RADIUS = 6;
const MESH_BUDGET_PER_FRAME = 3;
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

  // Seeded URL override: ?seed=1234
  const seedParam = Number.parseInt(new URLSearchParams(location.search).get('seed') ?? '', 10);
  const terrain: TerrainParams = Number.isFinite(seedParam)
    ? { ...DEFAULT_TERRAIN, seed: seedParam }
    : DEFAULT_TERRAIN;

  const world = new World((chunk) => generateChunk(chunk, terrain));
  const SPAWN = findSpawn(terrain);
  // Generate ground around the spawn synchronously so physics is solid
  // on the first frame; everything else streams in.
  const spawnChunkX = Math.floor(SPAWN.x / CHUNK_SIZE);
  const spawnChunkZ = Math.floor(SPAWN.z / CHUNK_SIZE);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
        world.ensureChunk(spawnChunkX + dx, cy, spawnChunkZ + dz);
      }
    }
  }

  const fogNear = CHUNK_SIZE * (RENDER_RADIUS - 2.5);
  const fogFar = CHUNK_SIZE * (RENDER_RADIUS + 0.5);
  const engine = createEngine(container, { fogNear, fogFar, skyColor: 0x87b5e0 });
  const materials = createVoxelMaterials({ fogNear, fogFar, skyColor: 0x87b5e0 });

  const chunkMeshes = new ChunkMeshManager(engine.scene, world, materials, {
    streaming: streamingParams(RENDER_RADIUS),
    meshBudgetPerFrame: MESH_BUDGET_PER_FRAME,
  });

  const player: PlayerState = createPlayerState(SPAWN);
  const input = new InputManager(engine.renderer.domElement);
  input.attach();

  overlay.addEventListener('click', () => input.requestLock());
  const crosshair = document.querySelector<HTMLElement>('#crosshair');
  const syncOverlay = () => {
    overlay.classList.toggle('hidden', input.isLocked);
    crosshair?.classList.toggle('hidden', !input.isLocked);
  };
  document.addEventListener('pointerlockchange', syncOverlay);

  const solidAt = (x: number, y: number, z: number) => isSolidForCollision(world.getVoxel(x, y, z));

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
      Object.assign(player.position, SPAWN);
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;
    }

    // Stream chunks around the player, favoring the view direction.
    const camDirXZ = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    chunkMeshes.update(player.position, camDirXZ);

    const eye = eyePosition(player);
    engine.camera.position.set(eye.x, eye.y, eye.z);
    engine.camera.rotation.set(player.pitch, player.yaw, 0);

    fpsFrames++;
    fpsTime += frameDt;
    if (fpsTime >= 0.5) {
      const fps = Math.round(fpsFrames / fpsTime);
      const s = chunkMeshes.stats;
      const p = player.position;
      hud.textContent =
        `fps ${fps} · chunks ${s.meshed} (q ${s.queued}) · ` +
        `${(s.quads / 1000).toFixed(1)}k quads · ` +
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` +
        (player.onGround ? '' : ' · air');
      fpsFrames = 0;
      fpsTime = 0;
    }
  });
}

main();
