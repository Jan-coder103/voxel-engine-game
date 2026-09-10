import * as THREE from 'three';

/**
 * Pooled voxel debris (Phase 8): one InstancedMesh holds up to `capacity`
 * tumbling boxes with a tiny believable physics step — gravity, world
 * ground collision, bounce, friction, fade-out by shrink. Pieces are
 * recycled ring-buffer style, so destruction can never accumulate
 * unbounded geometry or objects (the Phase 8 gate's stress requirement).
 */
export interface DebrisSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  material: number;
  scale: number;
}

const GRAVITY = 22;
const LIFE_SECONDS = 4;
const FADE_SECONDS = 0.45;

interface DebrisState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  scale: number;
  life: number;
}

export class DebrisSystem {
  private readonly mesh: THREE.InstancedMesh;
  private readonly states: DebrisState[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private cursor = 0;
  private active = 0;

  constructor(
    scene: THREE.Scene,
    readonly capacity = 512,
  ) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    // Park every instance at zero scale until it is spawned into.
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.color.setHex(0xffffff));
      this.states.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        wx: 0,
        wy: 0,
        wz: 0,
        scale: 1,
        life: 0,
      });
    }
    scene.add(this.mesh);
  }

  /** Spawn specs, recycling the oldest pieces when the pool is full. */
  spawn(specs: readonly DebrisSpawn[], colorFor: (material: number) => number): void {
    for (const spec of specs) {
      const index = this.nextSlot();
      const state = this.states[index];
      const fadeIn = !state.active;
      state.active = true;
      state.x = spec.x;
      state.y = spec.y;
      state.z = spec.z;
      state.vx = spec.vx;
      state.vy = spec.vy;
      state.vz = spec.vz;
      state.rx = Math.random() * Math.PI;
      state.ry = Math.random() * Math.PI;
      state.rz = Math.random() * Math.PI;
      state.wx = (Math.random() - 0.5) * 6;
      state.wy = (Math.random() - 0.5) * 6;
      state.wz = (Math.random() - 0.5) * 6;
      state.scale = spec.scale;
      state.life = LIFE_SECONDS;
      this.mesh.setColorAt(index, this.color.setHex(colorFor(spec.material)));
      if (fadeIn) this.active++;
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private nextSlot(): number {
    // Prefer inactive slots; otherwise recycle the oldest (ring cursor).
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

  /**
   * Advance the physics step. `isSolid` reads the world (usually
   * isSolidForCollision ∘ world.getVoxel); debris rests on and bounces
   * off solid ground and expires after its lifetime.
   */
  update(dt: number, isSolid: (x: number, y: number, z: number) => boolean): void {
    let anyActive = false;
    for (let i = 0; i < this.capacity; i++) {
      const state = this.states[i];
      if (!state.active) continue;
      anyActive = true;
      state.life -= dt;
      if (state.life <= 0) {
        this.deactivate(i, state);
        continue;
      }

      state.vy -= GRAVITY * dt;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      state.z += state.vz * dt;
      state.rx += state.wx * dt;
      state.ry += state.wy * dt;
      state.rz += state.wz * dt;

      // Ground interaction: sample the cell under the piece's lower face.
      const half = state.scale / 2;
      const footY = Math.floor(state.y - half);
      if (state.vy <= 0 && isSolid(Math.floor(state.x), footY, Math.floor(state.z))) {
        state.y = footY + 1 + half;
        state.vy = -state.vy * 0.3;
        state.vx *= 0.55;
        state.vz *= 0.55;
        state.wx *= 0.5;
        state.wy *= 0.5;
        state.wz *= 0.5;
        if (Math.abs(state.vy) < 0.6) state.vy = 0;
      }

      const fade = state.life < FADE_SECONDS ? Math.max(state.life / FADE_SECONDS, 0) : 1;
      const s = state.scale * fade;
      this.dummy.position.set(state.x, state.y, state.z);
      this.dummy.rotation.set(state.rx, state.ry, state.rz);
      this.dummy.scale.setScalar(Math.max(s, 0.0001));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (anyActive) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private deactivate(index: number, state: DebrisState): void {
    state.active = false;
    this.active--;
    this.dummy.position.set(0, -1000, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(index, this.dummy.matrix);
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
