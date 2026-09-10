import * as THREE from 'three';

/**
 * Structural debug overlay (Phase 11): when enabled, every collapse
 * flashes the failed cells as translucent boxes for a moment — red for
 * cells that lost their support path, orange for cells that fractured
 * under load — so the *reason* a structure fell is readable after the
 * fact. One pooled InstancedMesh, same recycling discipline as debris.
 */
export interface FailedCell {
  x: number;
  y: number;
  z: number;
  stressed: boolean;
}

const LIFE_SECONDS = 1.6;
const COLOR_UNSUPPORTED = 0xff3b30;
const COLOR_STRESSED = 0xffa62b;

interface MarkerState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  life: number;
}

export class StructureViz {
  /** Toggled by the G key; collapses are only drawn while on. */
  enabled = false;

  private readonly mesh: THREE.InstancedMesh;
  private readonly states: MarkerState[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private cursor = 0;
  private active = 0;

  constructor(
    scene: THREE.Scene,
    readonly capacity = 512,
  ) {
    const geometry = new THREE.BoxGeometry(1.04, 1.04, 1.04);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.color.setHex(0xffffff));
      this.states.push({ active: false, x: 0, y: 0, z: 0, life: 0 });
    }
    scene.add(this.mesh);
  }

  /** Flash the failed cells of one collapse (no-op while disabled). */
  show(cells: readonly FailedCell[]): void {
    if (!this.enabled) return;
    for (const cell of cells) {
      const index = this.nextSlot();
      const state = this.states[index];
      if (!state.active) this.active++;
      state.active = true;
      state.x = cell.x + 0.5;
      state.y = cell.y + 0.5;
      state.z = cell.z + 0.5;
      state.life = LIFE_SECONDS;
      this.mesh.setColorAt(
        index,
        this.color.setHex(cell.stressed ? COLOR_STRESSED : COLOR_UNSUPPORTED),
      );
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private nextSlot(): number {
    for (let i = 0; i < this.capacity; i++) {
      const index = (this.cursor + i) % this.capacity;
      if (!this.states[index].active) {
        this.cursor = (index + 1) % this.capacity;
        return index;
      }
    }
    const index = this.cursor % this.capacity;
    this.cursor = (index + 1) % this.capacity;
    return index;
  }

  /** Age the markers; they hold, then shrink away. */
  update(dt: number): void {
    let anyActive = false;
    for (let i = 0; i < this.capacity; i++) {
      const state = this.states[i];
      if (!state.active) continue;
      anyActive = true;
      state.life -= dt;
      if (state.life <= 0 || !this.enabled) {
        state.active = false;
        this.active--;
        this.dummy.position.set(0, -1000, 0);
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      const t = Math.min(1, state.life / (LIFE_SECONDS * 0.5));
      this.dummy.position.set(state.x, state.y, state.z);
      this.dummy.scale.setScalar(Math.max(t, 0.0001));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (anyActive) this.mesh.instanceMatrix.needsUpdate = true;
  }

  get activeCount(): number {
    return this.active;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
