import * as THREE from 'three';

/**
 * Edit-time visualizations: the wireframe highlight on the targeted voxel
 * and the translucent "ghost" preview on the cell a placement would fill.
 * Both are thin three.js objects that follow world-space voxel cells; all
 * state stays in the edit layer (ADR-002) — this is presentation only.
 */
export class SelectionViz {
  private readonly highlight: THREE.LineSegments;
  private readonly ghost: THREE.Mesh;
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(scene: THREE.Scene) {
    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    const edges = new THREE.EdgesGeometry(box);
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x0b0e14, transparent: true, opacity: 0.85 }),
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 2;
    scene.add(this.highlight);
    this.disposables.push(edges, box, this.highlight.material as THREE.Material);

    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    const ghostBox = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    this.ghost = new THREE.Mesh(ghostBox, this.ghostMaterial);
    this.ghost.visible = false;
    this.ghost.renderOrder = 1;
    scene.add(this.ghost);
    this.disposables.push(ghostBox, this.ghostMaterial);
  }

  /** Show the wireframe on a voxel cell (integer coords). */
  showHighlight(x: number, y: number, z: number): void {
    // Cell [x, x+1) → box centered at x + 0.5.
    this.highlight.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.highlight.visible = true;
  }

  hideHighlight(): void {
    this.highlight.visible = false;
  }

  /** Show the placement ghost tinted with the material's color. */
  showGhost(x: number, y: number, z: number, colorHex: number): void {
    this.ghost.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.ghostMaterial.color.setHex(colorHex);
    this.ghost.visible = true;
  }

  hideGhost(): void {
    this.ghost.visible = false;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.highlight);
    scene.remove(this.ghost);
    for (const disposable of this.disposables) disposable.dispose();
  }
}
