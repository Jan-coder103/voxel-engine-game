import * as THREE from 'three';
import type { BrushShape } from '../creator/brush';
import type { BoxSelection } from '../creator/selection';

/**
 * Creator-mode visualizations (Phase 7): the brush ghost that previews a
 * stroke's shape/size, the yellow selection wireframe, and the blue paste
 * preview box. Presentation only — all creator state lives in the edit
 * layer (ADR-002).
 */
export class CreatorViz {
  private readonly ghostGroup = new THREE.Group();
  private readonly ghostMeshes: Partial<Record<BrushShape, THREE.Mesh>> = {};
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private readonly selectionBox: THREE.LineSegments;
  private readonly pasteBox: THREE.LineSegments;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(scene: THREE.Scene) {
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.disposables.push(this.ghostMaterial);

    const sphere = new THREE.SphereGeometry(1, 14, 10);
    const box = new THREE.BoxGeometry(2, 2, 2);
    const cylinder = new THREE.CylinderGeometry(1, 1, 2, 16, 1);
    this.ghostMeshes.sphere = new THREE.Mesh(sphere, this.ghostMaterial);
    this.ghostMeshes.box = new THREE.Mesh(box, this.ghostMaterial);
    this.ghostMeshes.cylinder = new THREE.Mesh(cylinder, this.ghostMaterial);
    this.ghostMeshes.noise = new THREE.Mesh(sphere, this.ghostMaterial); // noise scatters a sphere
    for (const mesh of Object.values(this.ghostMeshes)) {
      mesh!.visible = false;
      mesh!.renderOrder = 2;
      this.ghostGroup.add(mesh!);
    }
    this.disposables.push(sphere, box, cylinder);
    this.ghostGroup.visible = false;
    scene.add(this.ghostGroup);

    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const pasteEdges = boxEdges.clone();
    const selectionMaterial = new THREE.LineBasicMaterial({
      color: 0xffd75e,
      transparent: true,
      opacity: 0.95,
    });
    const pasteMaterial = new THREE.LineBasicMaterial({
      color: 0x6fc2ff,
      transparent: true,
      opacity: 0.85,
    });
    this.selectionBox = new THREE.LineSegments(boxEdges, selectionMaterial);
    this.pasteBox = new THREE.LineSegments(pasteEdges, pasteMaterial);
    this.selectionBox.visible = false;
    this.pasteBox.visible = false;
    this.selectionBox.renderOrder = 3;
    this.pasteBox.renderOrder = 3;
    scene.add(this.selectionBox, this.pasteBox);
    this.disposables.push(boxEdges, pasteEdges, selectionMaterial, pasteMaterial);
  }

  /** Preview the brush shape centered on `center` (cell coords). */
  showBrushGhost(
    shape: BrushShape,
    center: { x: number; y: number; z: number },
    size: number,
    colorHex: number,
  ): void {
    this.ghostMaterial.color.setHex(colorHex);
    for (const [name, mesh] of Object.entries(this.ghostMeshes)) {
      mesh!.visible = name === shape;
    }
    // Cell [c, c+1) centers at c + 0.5; unit geometries have radius/half-extent 1.
    this.ghostGroup.position.set(center.x + 0.5, center.y + 0.5, center.z + 0.5);
    this.ghostGroup.scale.setScalar(size);
    this.ghostGroup.visible = true;
  }

  hideBrushGhost(): void {
    this.ghostGroup.visible = false;
  }

  /** Wireframe around the selected cell box (inclusive bounds). */
  showSelection(bounds: BoxSelection): void {
    this.placeBox(this.selectionBox, bounds.min, {
      x: bounds.max.x - bounds.min.x + 1,
      y: bounds.max.y - bounds.min.y + 1,
      z: bounds.max.z - bounds.min.z + 1,
    });
  }

  hideSelection(): void {
    this.selectionBox.visible = false;
  }

  /** Preview box for a paste of `size` cells anchored at `origin`. */
  showPaste(
    origin: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
  ): void {
    this.placeBox(this.pasteBox, origin, size);
  }

  hidePaste(): void {
    this.pasteBox.visible = false;
  }

  private placeBox(
    box: THREE.LineSegments,
    min: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
  ): void {
    box.position.set(min.x + size.x / 2, min.y + size.y / 2, min.z + size.z / 2);
    box.scale.set(size.x + 0.04, size.y + 0.04, size.z + 0.04);
    box.visible = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.ghostGroup, this.selectionBox, this.pasteBox);
    for (const disposable of this.disposables) disposable.dispose();
  }
}
