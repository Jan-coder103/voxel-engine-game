import * as THREE from 'three';

/**
 * Renderer bootstrap (ADR-002): owns all three.js objects — renderer,
 * scene, camera, lights, resize handling, and the frame loop. World and
 * simulation code never imports three.js; this is the only entry point
 * where they meet.
 */

export interface EngineOptions {
  /** Horizontal visibility in world units; drives fog and camera far plane. */
  fogNear: number;
  fogFar: number;
  skyColor: number;
}

export interface Engine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Start the loop; `update(dtSeconds)` runs before each render. */
  start(update: (dt: number) => void): void;
  dispose(): void;
}

export function createEngine(container: HTMLElement, options: EngineOptions): Engine {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const sky = new THREE.Color(options.skyColor);
  const scene = new THREE.Scene();
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, options.fogNear, options.fogFar);

  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.1,
    options.fogFar + 96,
  );
  camera.rotation.order = 'YXZ';

  // Basic lighting: sky/ground bounce plus one sun. (The Phase 4 voxel
  // shader lights itself; these feed the interim Lambert material.)
  const hemisphere = new THREE.HemisphereLight(0xcfe8ff, 0x59472e, 1.0);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.6);
  sun.position.set(30, 60, 20);
  scene.add(sun);

  const onResize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };
  window.addEventListener('resize', onResize);

  let frameHandle = 0;
  let lastTime = 0;
  let update: (dt: number) => void = () => {};

  const tick = (nowMs: number) => {
    frameHandle = requestAnimationFrame(tick);
    // Clamp to keep physics stable across tab switches; callers that need
    // more accuracy should run fixed substeps.
    const dt = Math.min((nowMs - lastTime) / 1000, 0.1);
    lastTime = nowMs;
    update(dt);
    renderer.render(scene, camera);
  };

  return {
    scene,
    camera,
    renderer,
    start(loopUpdate) {
      update = loopUpdate;
      lastTime = performance.now();
      frameHandle = requestAnimationFrame(tick);
    },
    dispose() {
      cancelAnimationFrame(frameHandle);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
