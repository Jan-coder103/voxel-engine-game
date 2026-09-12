import * as THREE from 'three';

/**
 * Rain and snow (Phase 16): one pooled InstancedMesh of thin streaks
 * (rain) or small flakes (snow) recycled in a cylinder around the
 * camera. The atmosphere state drives spawn rate, wind slant, and the
 * rain/snow mode; with no precipitation nothing spawns and the mesh
 * collapses to zero instances.
 *
 * Render-side pool (ADR-002/004): Math.random is fine here — none of it
 * feeds simulation state.
 */

export interface PrecipSource {
  /** 0–1 precipitation strength (spawn rate scales with it). */
  precip: number;
  wind: { x: number; z: number };
  snowing: boolean;
}

interface ParticleState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
}

const RAIN_COLOR = 0x9fb8d8;
const SNOW_COLOR = 0xffffff;
/** Particles per second at full storm. */
const RAIN_RATE = 320;
const SNOW_RATE = 110;

export class PrecipSystem {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly states: ParticleState[] = [];
  private readonly dummy = new THREE.Object3D();
  private cursor = 0;
  private active = 0;
  private spawnAccumulator = 0;
  private snowing = false;

  constructor(
    scene: THREE.Scene,
    readonly capacity = 700,
  ) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshBasicMaterial({
      color: RAIN_COLOR,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.states.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1 });
    }
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get activeCount(): number {
    return this.active;
  }

  /** One render frame: spawn ∝ precipitation, fall, slant with the wind. */
  update(dt: number, camera: { x: number; y: number; z: number }, source: PrecipSource): void {
    if (source.snowing !== this.snowing) {
      this.snowing = source.snowing;
      this.material.color.setHex(this.snowing ? SNOW_COLOR : RAIN_COLOR);
      this.material.opacity = this.snowing ? 0.85 : 0.42;
    }

    const rate = this.snowing ? SNOW_RATE : RAIN_RATE;
    if (source.precip > 0.01) {
      this.spawnAccumulator += source.precip * rate * dt;
      while (this.spawnAccumulator >= 1 && this.active < this.capacity) {
        this.spawnAccumulator -= 1;
        this.spawn(camera, source);
      }
      if (this.spawnAccumulator > 4) this.spawnAccumulator = 4;
    } else {
      this.spawnAccumulator = 0;
    }

    if (this.active === 0) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    const windX = source.wind.x * 7;
    const windZ = source.wind.z * 7;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.states[i];
      if (!s.active) continue;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      if (this.snowing) {
        // Flakes sway and drift with the wind.
        s.vx += (windX * 0.25 - s.vx) * dt * 1.5;
        s.vz += (windZ * 0.25 - s.vz) * dt * 1.5;
      }
      const below = s.y < camera.y - 8;
      const far = Math.abs(s.x - camera.x) > 20 || Math.abs(s.z - camera.z) > 20;
      if (below || far) {
        this.kill(i);
        continue;
      }
      this.dummy.position.set(s.x, s.y, s.z);
      this.dummy.rotation.set(0, 0, this.snowing ? 0 : Math.atan2(s.vx, -s.vy));
      this.dummy.scale.set(s.size, this.snowing ? s.size : s.size * 14, s.size);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  // --- internals ---------------------------------------------------------

  private spawn(camera: { x: number; y: number; z: number }, source: PrecipSource): void {
    const index = this.nextSlot();
    const s = this.states[index];
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 16;
    const wasInactive = !s.active;
    s.active = true;
    s.x = camera.x + Math.cos(angle) * radius;
    s.z = camera.z + Math.sin(angle) * radius;
    s.y = camera.y + 7 + Math.random() * 7;
    if (this.snowing) {
      s.vx = (Math.random() - 0.5) * 1.2 + source.wind.x * 2;
      s.vy = -(2.0 + Math.random() * 1.2);
      s.vz = (Math.random() - 0.5) * 1.2 + source.wind.z * 2;
      s.size = 0.07 + Math.random() * 0.05;
    } else {
      s.vx = source.wind.x * 7;
      s.vy = -(17 + Math.random() * 5);
      s.vz = source.wind.z * 7;
      s.size = 0.028 + Math.random() * 0.02;
    }
    if (wasInactive) this.active++;
  }

  private kill(index: number): void {
    const s = this.states[index];
    s.active = false;
    this.active--;
    this.dummy.position.set(0, -1000, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(index, this.dummy.matrix);
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
}
