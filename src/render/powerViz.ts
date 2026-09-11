import * as THREE from 'three';

/**
 * Lit-lamp glow (Phase 15): one pooled InstancedMesh of warm translucent
 * shells, one per lamp the power sim reports lit. The lamp voxel itself
 * is a dim housing; the shell is what reads as "on". There are no dynamic
 * lights in the voxel shader yet, so lamps do not illuminate their
 * surroundings (known-issue; Phase 17 territory).
 *
 * The mesh is rebuilt only when the sim's `revision` changes (a lamp
 * flipped somewhere), so the per-frame cost is a comparison.
 */
export interface PowerVizSource {
  /** Bumped by the sim whenever the lit set changed. */
  readonly revision: number;
  /** Snapshot of lit lamp cells (world coords). */
  litPositions(): { x: number; y: number; z: number }[];
}

export class PowerViz {
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private revision = -1;

  constructor(
    scene: THREE.Scene,
    private readonly capacity = 1024,
  ) {
    const geometry = new THREE.BoxGeometry(1.06, 1.06, 1.06);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffdf8f,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    scene.add(this.mesh);
  }

  /** Mirror the sim's lit set (no-op unless its revision moved). */
  update(power: PowerVizSource): void {
    if (power.revision === this.revision) return;
    this.revision = power.revision;
    const lamps = power.litPositions();
    const shown = Math.min(lamps.length, this.capacity);
    for (let i = 0; i < shown; i++) {
      const lamp = lamps[i];
      this.dummy.position.set(lamp.x + 0.5, lamp.y + 0.5, lamp.z + 0.5);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.dummy.position.set(0, -1000, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = shown; i < this.capacity; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
