import type { WorldCoordinate } from './voxel/coordinates';
import { CHUNK_SIZE, WORLD_HEIGHT_CHUNKS } from './voxel/coordinates';
import { World } from './voxel/world';
import { streamingParams } from './voxel/streaming';
import { DEFAULT_TERRAIN, type TerrainParams, findSpawn, generateChunk } from './voxel/terrain';
import {
  AIR,
  WATER,
  MATERIALS,
  getMaterial,
  isSolidForCollision,
  type VoxelMaterialID,
} from './voxel/materials';
import { raycastVoxels, type RaycastHit } from './voxel/raycast';
import { applyEdits, EditHistory, intersectsPlayerCell, type VoxelEdit } from './voxel/edits';
import { FluidSim } from './voxel/fluid';
import { FireSim } from './voxel/fire';
import { debrisFromCells, explode } from './voxel/damage';
import { StructuralSim } from './voxel/structure';
import { NpcSim } from './npc/npc';
import {
  AutosavePolicy,
  deserializeWorld,
  serializeWorld,
  type SerializedWorld,
} from './voxel/persistence';
import { EventBus } from './sim/events';
import {
  brushCells,
  brushEdits,
  clampBrushSize,
  type BrushShape,
  type BrushTool,
} from './creator/brush';
import { copyRegion, selectionBounds, selectionFits, type BoxSelection } from './creator/selection';
import {
  mirrorClipboardX,
  pasteEdits,
  rotateClipboardY,
  type ClipboardVolume,
} from './creator/clipboard';
import { PrefabLibrary } from './creator/prefab';
import { formatInspection, inspectVoxel } from './creator/inspector';
import { createEngine } from './render/bootstrap';
import { ChunkMeshManager } from './render/chunkMeshes';
import { createVoxelMaterials } from './render/voxelMaterial';
import { SelectionViz } from './render/selectionViz';
import { CreatorViz } from './render/creatorViz';
import { DebrisSystem } from './render/debris';
import { DustSystem } from './render/dust';
import { FireFx } from './render/firefx';
import { StructureViz } from './render/structureViz';
import { NpcViz } from './render/npcViz';
import { SoundFx } from './audio/sfx';
import { LocalStorageSaveStore } from './persistence/localStorageStore';
import { InputManager } from './player/input';
import {
  createPlayerState,
  eyePosition,
  stepPlayer,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  type PlayerState,
} from './player/controller';

/**
 * Phase 5 demo: an editable, saveable voxel sandbox. The infinite seeded
 * terrain streams around the player; the crosshair raycasts into the
 * world for place/remove/pick edits (grouped, undoable), and the edit
 * journal autosaves to localStorage — reload restores the world.
 */

const RENDER_RADIUS = 6;
const MESH_BUDGET_PER_FRAME = 3;
const RESPAWN_HEIGHT = -32;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;
/** Fluid cells simulated per fixed step (Phase 9 activity budget). */
const FLUID_CELLS_PER_TICK = 384;
/** Fire cells simulated per fixed step (Phase 10 activity budget). */
const FIRE_CELLS_PER_TICK = 256;
/** Structural analyses per fixed step (Phase 11; each is a few ms at most). */
const STRUCTURE_ANALYSES_PER_TICK = 1;

const EDIT_REACH = 6;
const AUTOSAVE_INTERVAL_MS = 20_000;
const AUTOSAVE_KEY = 'autosave';
const BEDROCK_Y = 0; // the world floor is not removable

/** Ray targets any loaded voxel except air and (until Phase 9) water. */
const editTargetable = (material: VoxelMaterialID) => material !== AIR && material !== WATER;

interface BootState {
  terrain: TerrainParams;
  restore: SerializedWorld | undefined;
}

/** Decide seed + restore state: explicit ?seed= wins over a saved world. */
function resolveBoot(store: LocalStorageSaveStore): BootState {
  const seedParam = Number.parseInt(new URLSearchParams(location.search).get('seed') ?? '', 10);
  const explicitSeed = Number.isFinite(seedParam) ? seedParam : undefined;

  let restore: SerializedWorld | undefined;
  const saved = store.get(AUTOSAVE_KEY);
  if (saved !== undefined) {
    try {
      restore = deserializeWorld(saved);
    } catch (error) {
      console.warn('Autosave unreadable; starting fresh', error);
    }
  }
  if (restore && explicitSeed !== undefined && restore.seed !== explicitSeed) {
    restore = undefined; // the URL explicitly asked for another world
  }
  const seed = explicitSeed ?? restore?.seed ?? DEFAULT_TERRAIN.seed;
  return { terrain: { ...DEFAULT_TERRAIN, seed }, restore };
}

function main(): void {
  const container = document.querySelector<HTMLElement>('#app');
  const overlay = document.querySelector<HTMLElement>('#overlay');
  const hud = document.querySelector<HTMLElement>('#hud');
  const hotbar = document.querySelector<HTMLElement>('#hotbar');
  if (!container || !overlay || !hud || !hotbar) {
    throw new Error('Missing #app, #overlay, #hud, or #hotbar element');
  }

  const store = new LocalStorageSaveStore();
  const { terrain, restore } = resolveBoot(store);

  const world = new World((chunk) => generateChunk(chunk, terrain));
  const fluid = new FluidSim(world); // before any chunk generation (hooks)
  const fire = new FireSim(world); // chains onto the fluid change hook
  const structure = new StructuralSim(world); // chains after fire (burn-outs collapse)
  const npc = new NpcSim(world, terrain.seed); // observes edits to re-path (Phase 12)
  if (restore) {
    world.loadEdits(restore.edits);
    fluid.loadLevels(restore.waterLevels ?? {});
  }
  const history = new EditHistory();

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
    waterLevels: (x, y, z) => fluid.levelAt(x, y, z),
  });
  const selectionViz = new SelectionViz(engine.scene);
  const creatorViz = new CreatorViz(engine.scene);

  const player: PlayerState = createPlayerState(SPAWN);
  const input = new InputManager(engine.renderer.domElement);
  input.attach();

  // --- Edit state -------------------------------------------------------
  let selectedMaterial: VoxelMaterialID = 1; // grass
  let lastSaveAt: number | undefined;

  const autosave = new AutosavePolicy({ intervalMs: AUTOSAVE_INTERVAL_MS }, performance.now());

  /** Apply edits as one undoable command; arms the autosave. */
  const edit = (edits: Parameters<typeof applyEdits>[1], label: string): void => {
    const command = applyEdits(world, edits, label);
    if (command) {
      history.push(command);
      autosave.markDirty();
    }
  };

  // --- Creator mode (Phase 7) -------------------------------------------
  const BRUSH_SHAPES: BrushShape[] = ['sphere', 'box', 'cylinder', 'noise'];
  const BRUSH_TOOLS: BrushTool[] = ['place', 'delete', 'paint', 'replace', 'explode', 'ignite'];
  const TOOL_COLORS: Record<BrushTool, number> = {
    place: 0xffffff, // replaced with the material color at draw time
    delete: 0xff6b57,
    paint: 0xffd75e,
    replace: 0xb07fe0,
    explode: 0xff9944,
    ignite: 0xff5522,
  };

  const prefabs = new PrefabLibrary(store);
  const creator = {
    enabled: false,
    selectMode: false,
    corner: undefined as WorldCoordinate | undefined,
    selection: undefined as BoxSelection | undefined,
    clipboard: undefined as ClipboardVolume | undefined,
    clipboardName: '',
    prefabIndex: 0,
    inspector: false,
    brush: {
      shape: 'sphere' as BrushShape,
      tool: 'place' as BrushTool,
      size: 2,
      replaceFrom: AIR as VoxelMaterialID,
      seed: 90210,
      density: 0.4,
    },
  };

  const cycle = <T>(items: T[], current: T, delta: number): T => {
    const index = items.indexOf(current);
    return items[(((index + delta) % items.length) + items.length) % items.length];
  };

  /** The world query every creator tool reads through. */
  const voxelQuery = (x: number, y: number, z: number) => world.getVoxel(x, y, z);

  const copySelection = (): boolean => {
    if (!creator.selection) return false;
    creator.clipboard = copyRegion(voxelQuery, creator.selection);
    creator.clipboardName = '';
    return true;
  };

  const cutSelection = (): void => {
    if (!creator.selection || !copySelection()) return;
    const { min, max } = creator.selection;
    const edits: VoxelEdit[] = [];
    for (let y = Math.max(min.y, BEDROCK_Y + 1); y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) edits.push({ x, y, z, material: AIR });
      }
    }
    edit(edits, 'cut');
  };

  const pasteClipboard = (hit: RaycastHit): void => {
    if (!creator.clipboard) return;
    edit(pasteEdits(creator.clipboard, hit.voxel), 'paste');
  };

  const saveSelectionAsPrefab = (): void => {
    if (!creator.selection) return;
    const existing = prefabs.list();
    let n = 1;
    while (existing.includes(`prefab-${n}`)) n++;
    const name = `prefab-${n}`;
    prefabs.save(copyRegion(voxelQuery, creator.selection), name);
    creator.clipboard = copyRegion(voxelQuery, creator.selection);
    creator.clipboardName = name;
  };

  const loadNextPrefab = (): void => {
    const names = prefabs.list();
    if (names.length === 0) return;
    creator.prefabIndex = (creator.prefabIndex + 1) % names.length;
    const name = names[creator.prefabIndex];
    const clip = prefabs.load(name);
    if (!clip) return;
    creator.clipboard = clip;
    creator.clipboardName = name;
  };

  /** LMB/RMB/MMB behavior while creator mode is on. */
  const creatorClick = (button: 0 | 1 | 2): void => {
    const hit = targetHit();
    if (button === 1) {
      if (hit) selectMaterial(hit.material); // eyedropper works everywhere
      return;
    }
    if (!hit) return;
    if (creator.selectMode) {
      if (button !== 0) return;
      if (!creator.corner) {
        creator.corner = { ...hit.voxel };
        return;
      }
      const bounds = selectionBounds(creator.corner, hit.voxel);
      creator.corner = undefined;
      if (selectionFits(bounds)) creator.selection = bounds;
      return;
    }
    if (button !== 0) {
      applyClickNormal(button, hit);
      return;
    }
    const brush = { ...creator.brush, material: selectedMaterial };
    // Place builds outward from the targeted face; the other tools act on
    // the targeted cell itself.
    const center: WorldCoordinate =
      brush.tool === 'place'
        ? {
            x: hit.voxel.x + hit.normal.x,
            y: hit.voxel.y + hit.normal.y,
            z: hit.voxel.z + hit.normal.z,
          }
        : hit.voxel;
    if (brush.tool === 'explode') {
      doExplosion(hit);
      return;
    }
    if (brush.tool === 'ignite') {
      // Ignition is fire-sim state, not an edit: light every flammable
      // cell the brush shape covers (water-adjacent cells refuse).
      for (const cell of brushCells(brush, center)) fire.ignite(cell.x, cell.y, cell.z);
      return;
    }
    const edits = brushEdits(
      brush,
      center,
      voxelQuery,
      brush.tool === 'place'
        ? (cell) => intersectsPlayerCell(cell, player.position, PLAYER_WIDTH / 2, PLAYER_HEIGHT)
        : undefined,
    );
    edit(edits, `brush ${brush.tool}`);
  };

  // --- Destruction (Phase 8) --------------------------------------------
  const bus = new EventBus();
  const sfx = new SoundFx();
  const debris = new DebrisSystem(engine.scene);
  const dust = new DustSystem(engine.scene);
  const fireFx = new FireFx(engine.scene);
  const structureViz = new StructureViz(engine.scene);
  const npcViz = new NpcViz(engine.scene);
  const colorFor = (material: VoxelMaterialID) => getMaterial(material).color;
  let explosionSeed = 1;

  bus.on('explosion', () => sfx.boom());
  bus.on('structureCollapsed', () => {
    sfx.crack();
  });
  fire.onEvent = (event) => bus.emit(event);
  bus.on('fireIgnited', () => sfx.crack());
  bus.on('fireExtinguished', (event) => {
    if (event.cause === 'water') {
      dust.puff(event.x + 0.5, event.y + 0.5, event.z + 0.5, {
        count: 6,
        spread: 0.7,
        rise: 2.2,
        size: 0.3,
      });
    }
  });

  /**
   * Structural collapse (Phase 11): the sim proposes the cells that lost
   * support or fractured under load; they fall as one undoable command.
   * Debris specs are captured before the edit (they need the cells'
   * materials). Applying the edit re-queues the region through the world
   * hook, so multi-stage collapses cascade across the next ticks.
   */
  structure.onCollapse = ({ cells }) => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const cell of cells) {
      cx += cell.x;
      cy += cell.y;
      cz += cell.z;
    }
    cx /= cells.length;
    cy /= cells.length;
    cz /= cells.length;
    const specs = debrisFromCells(cells, voxelQuery, {
      seed: 777 + cells.length,
      maxDebris: 80,
      x: cx,
      z: cz,
    });
    edit(
      cells.map((cell) => ({ x: cell.x, y: cell.y, z: cell.z, material: AIR })),
      'collapse',
    );
    debris.spawn(specs, colorFor);
    dust.puff(cx + 0.5, cy + 0.5, cz + 0.5, {
      count: Math.min(48, 8 + Math.floor(cells.length / 4)),
      spread: Math.min(6, 2 + Math.cbrt(cells.length) / 2),
      rise: 1.8,
    });
    structureViz.show(cells);
    bus.emit({ type: 'structureCollapsed', x: cx, y: cy, z: cz, cells: cells.length });
    sfx.thud();
  };

  /** Creator-mode explosion tool: spherical blast + debris + dust + sound. */
  const doExplosion = (hit: RaycastHit): void => {
    const center = { x: hit.voxel.x + 0.5, y: hit.voxel.y + 0.5, z: hit.voxel.z + 0.5 };
    const radius = creator.brush.size + 2;
    const result = explode(center, radius, voxelQuery, { seed: explosionSeed++, maxDebris: 64 });
    edit(result.edits, 'explode');
    debris.spawn(result.debris, colorFor);
    fire.heatCells(result.heated); // crater-rim flammables catch (Phase 10)
    dust.puff(center.x, center.y, center.z, {
      count: 36,
      spread: radius * 0.8,
      rise: 2.5,
      size: 0.45,
    });
    bus.emit({
      type: 'explosion',
      x: center.x,
      y: center.y,
      z: center.z,
      radius,
      destroyed: result.destroyed,
    });
  };

  const saveNow = (): void => {
    const payload = serializeWorld(world, terrain, Date.now(), fluid.exportLevels());
    store.set(AUTOSAVE_KEY, JSON.stringify(payload));
    lastSaveAt = performance.now();
  };

  // Best-effort save when the tab goes away (crash recovery window).
  const saveOnHide = () => {
    if (document.visibilityState === 'hidden') saveNow();
  };
  document.addEventListener('visibilitychange', saveOnHide);

  // --- HUD: material hotbar --------------------------------------------
  const placeable = MATERIALS.filter((def) => def.id !== AIR);
  const slots = placeable.map((def, index) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `#${def.color.toString(16).padStart(6, '0')}`;
    const label = document.createElement('span');
    label.textContent = def.name;
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = String(index + 1);
    slot.append(swatch, label, key);
    hotbar.append(slot);
    return { slot, def };
  });
  const syncHotbar = () => {
    for (const { slot, def } of slots) {
      slot.classList.toggle('active', def.id === selectedMaterial);
    }
  };
  const selectMaterial = (id: VoxelMaterialID) => {
    selectedMaterial = id;
    syncHotbar();
  };
  const cycleMaterial = (delta: number) => {
    const len = placeable.length;
    const index = placeable.findIndex((def) => def.id === selectedMaterial);
    const next = (((index + delta) % len) + len) % len;
    selectMaterial(placeable[next].id);
  };
  syncHotbar();

  overlay.addEventListener('click', () => input.requestLock());
  const crosshair = document.querySelector<HTMLElement>('#crosshair');
  const syncOverlay = () => {
    overlay.classList.toggle('hidden', input.isLocked);
    crosshair?.classList.toggle('hidden', !input.isLocked);
  };
  document.addEventListener('pointerlockchange', syncOverlay);
  // Audio contexts need a user gesture; pointer lock is our first one.
  document.addEventListener('pointerlockchange', () => {
    if (input.isLocked) sfx.resume();
  });

  const solidAt = (x: number, y: number, z: number) => isSolidForCollision(world.getVoxel(x, y, z));

  /** Camera look direction from the player's yaw/pitch (YXZ convention). */
  const lookDirection = (): { x: number; y: number; z: number } => {
    const cos = Math.cos(player.pitch);
    return {
      x: -Math.sin(player.yaw) * cos,
      y: Math.sin(player.pitch),
      z: -Math.cos(player.yaw) * cos,
    };
  };

  const targetHit = (): RaycastHit | undefined =>
    raycastVoxels(
      { origin: eyePosition(player), direction: lookDirection() },
      EDIT_REACH,
      (x, y, z) => world.getVoxel(x, y, z),
      editTargetable,
    );

  /** Handle one discrete edit click (normal / sandbox controls). */
  const applyClickNormal = (button: 0 | 1 | 2, hit: RaycastHit): void => {
    if (button === 0) {
      // Remove: refuse the bedrock floor so the world bottom stays closed.
      if (hit.voxel.y <= BEDROCK_Y) return;
      edit([{ ...hit.voxel, material: AIR }], 'remove');
    } else if (button === 2) {
      // Place into the face-adjacent cell, never into the player. Water
      // cells may be filled (the fluid treats it as displacement).
      const cell = hit.normal;
      if (cell.x === 0 && cell.y === 0 && cell.z === 0) return;
      const x = hit.voxel.x + cell.x;
      const y = hit.voxel.y + cell.y;
      const z = hit.voxel.z + cell.z;
      const current = world.getVoxel(x, y, z);
      if (current !== AIR && current !== WATER) return;
      if (intersectsPlayerCell({ x, y, z }, player.position, PLAYER_WIDTH / 2, PLAYER_HEIGHT)) {
        return;
      }
      edit([{ x, y, z, material: selectedMaterial }], 'place');
    }
  };

  /** Click dispatch: creator mode replaces the primary action. */
  const applyClick = (button: 0 | 1 | 2): void => {
    if (creator.enabled) {
      creatorClick(button);
      return;
    }
    const hit = targetHit();
    if (hit) applyClickNormal(button, hit);
  };

  /** Handle one discrete key press. */
  const applyKey = (code: string): void => {
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) {
      const slot = placeable[Number(digit[1]) - 1];
      if (slot) selectMaterial(slot.id);
      return;
    }
    const ctrl = input.isDown('ControlLeft') || input.isDown('ControlRight');
    const shift = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    if (ctrl && code === 'KeyZ') {
      if (shift ? history.redo(world) : history.undo(world)) autosave.markDirty();
      return;
    }
    if (ctrl && code === 'KeyY') {
      if (history.redo(world)) autosave.markDirty();
      return;
    }
    if (ctrl && code === 'KeyC') {
      copySelection();
      return;
    }
    if (ctrl && code === 'KeyX') {
      cutSelection();
      return;
    }
    if (ctrl && code === 'KeyV') {
      const hit = targetHit();
      if (hit) pasteClipboard(hit);
      return;
    }
    if (code === 'KeyF') {
      // Paint: recolor the targeted voxel in place (bedrock protected).
      const hit = targetHit();
      if (hit && hit.voxel.y > BEDROCK_Y) {
        edit(
          [{ x: hit.voxel.x, y: hit.voxel.y, z: hit.voxel.z, material: selectedMaterial }],
          'paint',
        );
      }
      return;
    }
    if (code === 'KeyK') {
      saveNow();
      return;
    }
    if (code === 'KeyL') {
      const saved = store.get(AUTOSAVE_KEY);
      if (!saved) return;
      try {
        const data = deserializeWorld(saved);
        world.loadEdits(data.edits);
        fluid.loadLevels(data.waterLevels ?? {});
        fire.reset(); // loads are world resets: no fire survives a load
        structure.reset();
        npc.reset();
        history.clear();
        autosave.markDirty();
      } catch (error) {
        console.warn('Load failed', error);
      }
      return;
    }

    // --- Creator-mode keys (Phase 7) ---
    if (code === 'KeyI') {
      creator.inspector = !creator.inspector;
      return;
    }
    if (code === 'KeyN') {
      sfx.setEnabled(!sfx.enabled);
      return;
    }
    if (code === 'KeyG') {
      structureViz.enabled = !structureViz.enabled; // structural debug overlay
      return;
    }
    if (code === 'KeyC') {
      creator.enabled = !creator.enabled;
      if (!creator.enabled) {
        creator.selectMode = false;
        creator.corner = undefined;
      }
      return;
    }
    if (!creator.enabled) return;
    switch (code) {
      case 'KeyV':
        creator.brush.shape = cycle(BRUSH_SHAPES, creator.brush.shape, 1);
        break;
      case 'KeyQ':
        creator.brush.tool = cycle(BRUSH_TOOLS, creator.brush.tool, -1);
        break;
      case 'KeyE':
        creator.brush.tool = cycle(BRUSH_TOOLS, creator.brush.tool, 1);
        break;
      case 'BracketLeft':
        creator.brush.size = clampBrushSize(creator.brush.size - 1);
        break;
      case 'BracketRight':
        creator.brush.size = clampBrushSize(creator.brush.size + 1);
        break;
      case 'KeyB': {
        creator.selectMode = !creator.selectMode;
        creator.corner = undefined;
        break;
      }
      case 'KeyR': {
        if (creator.clipboard) {
          creator.clipboard = rotateClipboardY(creator.clipboard, shift ? -1 : 1);
        }
        break;
      }
      case 'KeyM': {
        if (creator.clipboard) creator.clipboard = mirrorClipboardX(creator.clipboard);
        break;
      }
      case 'KeyO':
        saveSelectionAsPrefab();
        break;
      case 'KeyP':
        loadNextPrefab();
        break;
      case 'Escape':
        creator.selection = undefined;
        creator.corner = undefined;
        break;
    }
  };

  let accumulator = 0;
  let fpsTime = 0;
  let fpsFrames = 0;

  engine.start((frameDt) => {
    accumulator = Math.min(accumulator + frameDt, FIXED_DT * MAX_SUBSTEPS);
    while (accumulator >= FIXED_DT) {
      const frameInput = input.takeFrameInput();
      if (input.isLocked) {
        stepPlayer(player, frameInput, solidAt, FIXED_DT, (x, y, z) => fluid.levelAt(x, y, z));
        for (const click of input.consumeClicks()) applyClick(click);
        for (const key of input.consumeKeyPresses()) applyKey(key);
        const wheel = input.consumeWheelSteps();
        if (wheel !== 0) cycleMaterial(wheel);
      } else {
        // Still consume so mouse deltas don't pile up while unlocked.
        void frameInput;
        input.consumeClicks();
        input.consumeKeyPresses();
        input.consumeWheelSteps();
      }
      // Water simulation runs every fixed step, locked or not; the
      // activity budget keeps the cost bounded while floods spread.
      fluid.tick(FLUID_CELLS_PER_TICK);
      if (fluid.takeDirty()) autosave.markDirty();
      // Fire joins the same fixed step and budget scheme (Phase 10).
      fire.tick(FIRE_CELLS_PER_TICK);
      if (fire.takeDirty()) autosave.markDirty();
      // Structural analysis last: it sees this step's edits, burn-outs
      // and the previous stage of any cascading collapse (Phase 11).
      structure.tick(STRUCTURE_ANALYSES_PER_TICK);
      // NPCs join the same fixed step (Phase 12): schedule, paths,
      // movement, population. Population centers on the player.
      npc.tick(player.position);
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

    // Destruction particle/physics steps (render-side pools).
    debris.update(frameDt, (x, y, z) => isSolidForCollision(world.getVoxel(x, y, z)));
    dust.update(frameDt);
    // Fire feedback: embers + smoke emitted from the burning cells.
    fireFx.update(frameDt, fire.burningList());
    structureViz.update(frameDt);
    // NPC figures mirror the sim's population.
    npcViz.update(npc.list());

    // Targeting + edit previews (render only; input handled above).
    const hit = input.isLocked ? targetHit() : undefined;
    if (hit) {
      selectionViz.showHighlight(hit.voxel.x, hit.voxel.y, hit.voxel.z);
      const gx = hit.voxel.x + hit.normal.x;
      const gy = hit.voxel.y + hit.normal.y;
      const gz = hit.voxel.z + hit.normal.z;
      const placeableCell =
        (hit.normal.x !== 0 || hit.normal.y !== 0 || hit.normal.z !== 0) &&
        (() => {
          const g = world.getVoxel(gx, gy, gz);
          return g === AIR || g === WATER;
        })();
      if (placeableCell) selectionViz.showGhost(gx, gy, gz, getMaterial(selectedMaterial).color);
      else selectionViz.hideGhost();
    } else {
      selectionViz.hideHighlight();
      selectionViz.hideGhost();
    }

    // Creator-mode previews (render only).
    if (creator.enabled && input.isLocked) {
      if (hit && !creator.selectMode) {
        const brush = { ...creator.brush, material: selectedMaterial };
        const center: WorldCoordinate =
          brush.tool === 'place'
            ? {
                x: hit.voxel.x + hit.normal.x,
                y: hit.voxel.y + hit.normal.y,
                z: hit.voxel.z + hit.normal.z,
              }
            : hit.voxel;
        const ghostColor =
          brush.tool === 'place' ? getMaterial(selectedMaterial).color : TOOL_COLORS[brush.tool];
        creatorViz.showBrushGhost(brush.shape, center, brush.size, ghostColor);
      } else {
        creatorViz.hideBrushGhost();
      }
      if (creator.selection) creatorViz.showSelection(creator.selection);
      else creatorViz.hideSelection();
      if (creator.clipboard && hit && !creator.selectMode) {
        creatorViz.showPaste(hit.voxel, creator.clipboard.size);
      } else {
        creatorViz.hidePaste();
      }
    } else {
      creatorViz.hideBrushGhost();
      creatorViz.hideSelection();
      creatorViz.hidePaste();
    }

    // Autosave heartbeat.
    if (autosave.shouldSave(performance.now())) saveNow();

    const eye = eyePosition(player);
    engine.camera.position.set(eye.x, eye.y, eye.z);
    engine.camera.rotation.set(player.pitch, player.yaw, 0);

    fpsFrames++;
    fpsTime += frameDt;
    if (fpsTime >= 0.5) {
      const fps = Math.round(fpsFrames / fpsTime);
      const s = chunkMeshes.stats;
      const p = player.position;
      const selected = getMaterial(selectedMaterial);
      const target = hit
        ? `${hit.voxel.x},${hit.voxel.y},${hit.voxel.z} ${getMaterial(hit.material).name}`
        : '—';
      const savedText = lastSaveAt === undefined ? 'unsaved' : `saved ${saveAge(lastSaveAt)}`;
      const lines = [
        `fps ${fps} · chunks ${s.meshed} (q ${s.queued}, lod1 ${s.lod1}) · ` +
          `${(s.quads / 1000).toFixed(1)}k quads · ` +
          `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` +
          (player.onGround ? '' : ' · air'),
        `mat ${selected.name} · target ${target} · undo ${history.depth} · ` +
          `seed ${terrain.seed} · ${savedText} · snd ${sfx.enabled ? 'on' : 'off'} · ` +
          `debris ${debris.activeCount}/${debris.capacity}` +
          (player.inWater ? ' · swimming' : '') +
          (fluid.activeCount > 0 ? ` · water ${fluid.activeCount}` : '') +
          (fire.burningCount > 0 ? ` · fire ${fire.burningCount}` : '') +
          (structure.pendingCount > 0 ? ` · struct q${structure.pendingCount}` : '') +
          (structureViz.enabled ? ' · struct-viz (G)' : '') +
          (npc.count > 0 ? ` · npc ${npc.count}` : ''),
      ];
      if (creator.enabled) {
        const b = creator.brush;
        const sel = creator.selection
          ? `sel ${creator.selection.max.x - creator.selection.min.x + 1}×${creator.selection.max.y - creator.selection.min.y + 1}×${creator.selection.max.z - creator.selection.min.z + 1}`
          : creator.selectMode
            ? creator.corner
              ? 'sel corner set'
              : 'sel pick corner 1'
            : 'sel none';
        const clip = creator.clipboard
          ? `clip ${creator.clipboard.size.x}×${creator.clipboard.size.y}×${creator.clipboard.size.z}` +
            (creator.clipboardName ? ` (${creator.clipboardName})` : '')
          : 'clip empty';
        lines.push(
          `creator ON · ${b.tool} ${b.shape}×${b.size} · ${sel} · ${clip} · ` +
            `prefabs ${prefabs.list().length} · B select · C off`,
        );
      } else {
        lines.push('creator off (C)');
      }
      if (creator.inspector) {
        const inspection = hit
          ? inspectVoxel(
              voxelQuery,
              hit.voxel.x,
              hit.voxel.y,
              hit.voxel.z,
              fluid.levelAt(hit.voxel.x, hit.voxel.y, hit.voxel.z),
              fire.fuelAt(hit.voxel.x, hit.voxel.y, hit.voxel.z),
            )
          : undefined;
        lines.push(formatInspection(inspection));
      }
      hud.textContent = lines.join('\n');
      fpsFrames = 0;
      fpsTime = 0;
    }
  });

  // Dev-only debug hook: lets GUI verification scripts (headless browser
  // tests) read game state directly. Stripped from production builds.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__mw = {
      player,
      world,
      creator,
      history,
      fluid,
      fire,
      fireFx,
      structure,
      structureViz,
      npc,
      npcViz,
      isLocked: () => input.isLocked,
    };
  }

  function saveAge(from: number): string {
    const seconds = Math.round((performance.now() - from) / 1000);
    return seconds < 5 ? 'just now' : `${seconds}s ago`;
  }
}

main();
