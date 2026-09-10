import * as THREE from 'three';

/**
 * Fire particles (Phase 10): the render half of the fire sim, following
 * the debris/dust pooled-InstancedMesh pattern (ADR-004 — never one mesh
 * per particle). Two pools:
 *
 * - Embers: small bright orange boxes that pop off burning cells, arc
 *   under gravity, and die in well under a second.
 * - Smoke: dark gray boxes that rise with buoyant acceleration, drift,
 *   grow as they climb, and pop out at the end of a long life — the
 *   voxel-styled stand-in for volumetric smoke (investigated later).
 *
 * Density scales with the fire: emission budgets are proportional to the
 * burning-cell count with hard per-frame caps, so a huge blaze recycles
 * the same pools instead of growing unbounded. Pure render: the sim state
 * arrives as a plain point list each frame.
 */

interface ParticleState {
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

const EMBER_CAPACITY = 256;
const SMOKE_CAPACITY = 512;
/** Hard per-frame emission caps (pool recycling keeps long fires stable). */
const MAX_EMBERS_PER_FRAME = 12;
const MAX_SMOKE_PER_FRAME = 8;
/** Seconds between spawn attempts per burning cell. */
const EMBER_INTERVAL = 0.2;
const SMOKE_INTERVAL = 0.5;

export class FireFx {
  private readonly emberMesh: THREE.InstancedMesh;
  private readonly smokeMesh: THREE.InstancedMesh;
  private readonly emberStates: ParticleState[] = [];
  private readonly smokeStates: ParticleState[] = [];
  private readonly dummy = new THREE.Object3D();
  private emberCursor = 0;
  private smokeCursor = 0;
  private emberActive = 0;
  private smokeActive = 0;
  /** Carried spawn credit so slow frames still emit proportionally. */
  private emberCredit = 0;
  private smokeCredit = 0;

  constructor(scene: THREE.Scene) {
    this.emberMesh = this.makePool(
      new THREE.MeshBasicMaterial({ color: 0xff9430 }),
      EMBER_CAPACITY,
    );
    this.smokeMesh = this.makePool(
      new THREE.MeshBasicMaterial({
        color: 0x45454c,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
      SMOKE_CAPACITY,
    );
    const blank: ParticleState = {
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      size: 0.1,
      life: 0,
      maxLife: 1,
    };
    for (let i = 0; i < EMBER_CAPACITY; i++) this.emberStates.push({ ...blank });
    for (let i = 0; i < SMOKE_CAPACITY; i++) this.smokeStates.push({ ...blank });
    scene.add(this.smokeMesh);
    scene.add(this.emberMesh);
  }

  /**
   * Advance both pools and emit from `sources` (the fire sim's burning
   * cells; world voxel coords). Called once per rendered frame.
   */
  update(dt: number, sources: readonly { x: number; y: number; z: number }[]): void {
    if (sources.length > 0) {
      this.emberCredit += (dt / EMBER_INTERVAL) * sources.length;
      this.smokeCredit += (dt / SMOKE_INTERVAL) * sources.length;
      let n = Math.min(MAX_EMBERS_PER_FRAME, Math.floor(this.emberCredit));
      this.emberCredit -= n;
      while (n-- > 0) {
        const s = sources[(Math.random() * sources.length) | 0];
        this.spawn(s, true);
      }
      n = Math.min(MAX_SMOKE_PER_FRAME, Math.floor(this.smokeCredit));
      this.smokeCredit -= n;
      while (n-- > 0) {
        const s = sources[(Math.random() * sources.length) | 0];
        this.spawn(s, false);
      }
    } else {
      this.emberCredit = 0;
      this.smokeCredit = 0;
    }
    this.stepEmbers(dt);
    this.stepSmoke(dt);
  }

  get emberCount(): number {
    return this.emberActive;
  }

  get smokeCount(): number {
    return this.smokeActive;
  }

  dispose(scene: THREE.Scene): void {
    for (const mesh of [this.emberMesh, this.smokeMesh]) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  private makePool(material: THREE.MeshBasicMaterial, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = capacity;
    this.dummy.position.set(0, -1000, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, this.dummy.matrix);
    return mesh;
  }

  private spawn(source: { x: number; y: number; z: number }, ember: boolean): void {
    const states = ember ? this.emberStates : this.smokeStates;
    const index = this.nextSlot(states, ember);
    const state = states[index];
    if (!state.active) {
      if (ember) this.emberActive++;
      else this.smokeActive++;
    }
    state.active = true;
    state.x = source.x + 0.5 + (Math.random() - 0.5) * 0.7;
    state.y = source.y + 0.5 + (Math.random() - 0.5) * 0.4;
    state.z = source.z + 0.5 + (Math.random() - 0.5) * 0.7;
    if (ember) {
      state.vx = (Math.random() - 0.5) * 2.4;
      state.vy = 2.4 + Math.random() * 2;
      state.vz = (Math.random() - 0.5) * 2.4;
      state.size = 0.09 + Math.random() * 0.09;
      state.maxLife = 0.35 + Math.random() * 0.35;
    } else {
      state.vx = (Math.random() - 0.5) * 0.7;
      state.vy = 0.7 + Math.random() * 0.7;
      state.vz = (Math.random() - 0.5) * 0.7;
      state.size = 0.3 + Math.random() * 0.25;
      state.maxLife = 1.8 + Math.random() * 1.4;
    }
    state.life = state.maxLife;
  }

  private stepEmbers(dt: number): void {
    let anyActive = false;
    for (let i = 0; i < this.emberStates.length; i++) {
      const p = this.emberStates[i];
      if (!p.active) continue;
      anyActive = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.emberActive--;
        this.hide(this.emberMesh, i);
        continue;
      }
      // Ballistic arc under gravity.
      p.vy -= 3.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(Math.max(p.size * (1 - p.life / p.maxLife), 0.001));
      this.dummy.updateMatrix();
      this.emberMesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (anyActive) this.emberMesh.instanceMatrix.needsUpdate = true;
  }

  private stepSmoke(dt: number): void {
    let anyActive = false;
    for (let i = 0; i < this.smokeStates.length; i++) {
      const p = this.smokeStates[i];
      if (!p.active) continue;
      anyActive = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.smokeActive--;
        this.hide(this.smokeMesh, i);
        continue;
      }
      // Buoyant rise, damped drift, growth while alive.
      p.vy += 0.55 * dt;
      p.vx *= 1 - 0.4 * dt;
      p.vz *= 1 - 0.4 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const t = 1 - p.life / p.maxLife;
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(Math.max(p.size * (0.6 + t * 3.2), 0.001));
      this.dummy.updateMatrix();
      this.smokeMesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (anyActive) this.smokeMesh.instanceMatrix.needsUpdate = true;
  }

  private hide(mesh: THREE.InstancedMesh, index: number): void {
    this.dummy.position.set(0, -1000, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  private nextSlot(states: ParticleState[], ember: boolean): number {
    const capacity = states.length;
    const base = ember ? this.emberCursor : this.smokeCursor;
    let index = base;
    for (let i = 0; i < capacity; i++) {
      index = (base + i) % capacity;
      if (!states[index].active) break;
    }
    // Full pool: recycle the cursor slot rather than drop the spawn.
    if (ember) this.emberCursor = (index + 1) % capacity;
    else this.smokeCursor = (index + 1) % capacity;
    return index;
  }
}
