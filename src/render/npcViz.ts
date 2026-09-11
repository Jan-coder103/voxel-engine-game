import * as THREE from 'three';

/**
 * NPC figures (Phase 12): one pooled InstancedMesh of capsules, one
 * instance per simulated figure — same recycling discipline as the other
 * render pools (ADR-004). Activity tints the figure (green wandering,
 * yellow commuting, slate idle, dark blue asleep); sleepers lie down.
 */
import type { NpcState } from '../npc/npc';

const ACTIVITY_COLORS: Record<NpcState['activity'], number> = {
  idle: 0x8fa3b8,
  wander: 0x5fae4a,
  goto: 0xffd75e,
  sleep: 0x44506e,
};

/** Total figure height (capsule length + two hemispherical caps). */
const RADIUS = 0.3;
const LENGTH = 1.1;

export class NpcViz {
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private active = 0;

  constructor(
    scene: THREE.Scene,
    readonly capacity = 24,
  ) {
    const geometry = new THREE.CapsuleGeometry(RADIUS, LENGTH, 4, 10);
    // Unlit like every other pool (the scene has no lights; the voxel
    // shader does its own lighting).
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.color.setHex(0xffffff));
    }
    scene.add(this.mesh);
  }

  /** Mirror the sim's figure list into instance transforms. */
  update(npcs: readonly NpcState[]): void {
    const count = Math.min(npcs.length, this.capacity);
    this.active = count;
    for (let i = 0; i < count; i++) {
      const npc = npcs[i];
      const sleeping = npc.activity === 'sleep';
      this.dummy.position.set(
        npc.position.x,
        npc.position.y + (sleeping ? RADIUS + 0.05 : LENGTH / 2 + RADIUS),
        npc.position.z,
      );
      this.dummy.rotation.set(sleeping ? Math.PI / 2 : 0, npc.yaw, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.color.setHex(ACTIVITY_COLORS[npc.activity]));
    }
    // Park unused slots far below the world, zero-scaled.
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = count; i < this.capacity; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
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
