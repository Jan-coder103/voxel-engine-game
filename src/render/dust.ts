import * as THREE from 'three';

/**
 * Dust puffs (Phase 8): the particle half of destruction feedback. A
 * single pooled InstancedMesh of small light-gray boxes that erupt from a
 * fracture, drift upward, and shrink out — voxel-styled dust instead of
 * sprites, matching the world's aesthetic and avoiding extra shader work.
 */
export interface DustPuffOptions {
  /** Emission radius (voxels). */
  spread?: number;
  /** Particle count. */
  count?: number;
  /** Initial upward drift (voxels/second). */
  rise?: number;
  /** Particle box edge at birth. */
  size?: number;
}

interface DustState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  life: number;
  maxLife: number;
}

export class DustSystem {
  private readonly mesh: THREE.InstancedMesh;
  private readonly states: DustState[] = [];
  private readonly dummy = new THREE.Object3D();
  private cursor = 0;
  private active = 0;

  constructor(scene: THREE.Scene, readonly capacity = 1024) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xc9d2da,
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
      this.states.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        size: 0.3,
        life: 0,
        maxLife: 1,
      });
    }
    scene.add(this.mesh);
  }

  /** Emit one puff at a world point. */
  puff(x: number, y: number, z: number, options: DustPuffOptions = {}): void {
    const count = options.count ?? 16;
    const spread = options.spread ?? 1.5;
    const rise = options.rise ?? 1.5;
    const size = options.size ?? 0.35;
    for (let n = 0; n < count; n++) {
      const index = this.nextSlot();
      const state = this.states[index];
      const theta = Math.random() * Math.PI * 2;
      const radius = Math.random() * spread;
      const fadeIn = !state.active;
      state.active = true;
      state.x = x + Math.cos(theta) * radius;
      state.y = y + (Math.random() - 0.5) * spread;
      state.z = z + Math.sin(theta) * radius;
      state.vx = Math.cos(theta) * radius * 1.5;
      state.vy = rise * (0.5 + Math.random());
      state.vz = Math.sin(theta) * radius * 1.5;
      state.size = size * (0.6 + Math.random() * 0.8);
      state.maxLife = 0.6 + Math.random() * 0.6;
      state.life = state.maxLife;
      if (fadeIn) this.active++;
    }
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

  update(dt: number): void {
    let anyActive = false;
    for (let i = 0; i < this.capacity; i++) {
      const state = this.states[i];
      if (!state.active) continue;
      anyActive = true;
      state.life -= dt;
      if (state.life <= 0) {
        state.active = false;
        this.active--;
        this.dummy.position.set(0, -1000, 0);
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      state.vy += 0.8 * dt; // slight buoyancy
      state.vx *= 1 - 1.6 * dt;
      state.vz *= 1 - 1.6 * dt;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      state.z += state.vz * dt;
      // Grow briefly, then shrink out with life.
      const t = 1 - state.life / state.maxLife;
      const grow = t < 0.2 ? 0.5 + t * 2.5 : 1 + (1 - t) * 0.4;
      this.dummy.position.set(state.x, state.y, state.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(state.size * grow);
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
