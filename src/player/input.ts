import type { FrameInput } from './controller';

/**
 * DOM input: keyboard state + pointer-lock mouse deltas.
 * The render/game layer calls `takeFrameInput()` once per simulated step
 * to consume accumulated mouse movement as a `FrameInput`.
 */

/** Mouse pixels → radians. */
const LOOK_SENSITIVITY = 0.0022;

export class InputManager {
  private readonly keys = new Set<string>();
  private yawPixels = 0;
  private pitchPixels = 0;
  private locked = false;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly element: HTMLElement) {}

  attach(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      target: HTMLElement | Document | Window = window,
    ) => {
      target.addEventListener(type, handler as EventListener);
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener));
    };

    // Keyboard events dispatch to the focused element (usually <body>) and
    // bubble through window — listening here, not on the canvas, is what
    // makes WASD work. Mouse events while pointer-locked are retargeted to
    // the locked element, so those stay on the canvas.
    on('keydown', (e) => {
      this.keys.add(e.code);
      // Keep Space/arrow keys from scrolling the page.
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    on('keyup', (e) => this.keys.delete(e.code));
    on('blur', () => this.keys.clear());

    on('mousemove', (e) => {
      if (!this.locked) return;
      this.yawPixels += e.movementX;
      this.pitchPixels += e.movementY;
    });

    const lockChange = () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.keys.clear();
    };
    document.addEventListener('pointerlockchange', lockChange);
    this.disposers.push(() => document.removeEventListener('pointerlockchange', lockChange));
  }

  detach(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    this.element.requestPointerLock();
  }

  /** Consume accumulated input for one simulation step. */
  takeFrameInput(): FrameInput {
    const moveX =
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const moveZ =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);

    const input: FrameInput = {
      moveX,
      moveZ,
      jump: this.keys.has('Space'),
      yawDelta: this.yawPixels * LOOK_SENSITIVITY,
      pitchDelta: this.pitchPixels * LOOK_SENSITIVITY,
    };
    this.yawPixels = 0;
    this.pitchPixels = 0;
    return input;
  }
}
