import * as THREE from 'three';
import {
  cameraPosition,
  clipPlanes,
  DEFAULT_LIMITS,
  intersectGround,
  isClick,
  panByGroundDelta,
  panRelative,
  rotate,
  wheelZoomFactor,
  zoomTowards,
  type RtsCameraLimits,
  type RtsCameraState,
  classifyTwoFingerGesture,
} from '../lib/rtsCamera';

const ROTATE_SPEED = 0.005;
const KEY_ROTATE_SPEED = 1.6; // rad/s
const KEY_ZOOM_SPEED = 1.8; // e-folds per second

/**
 * City-builder controls (#33): left-drag pans (grab the ground), right/middle-drag or Shift+drag
 * rotates and tilts, the wheel zooms to the cursor, two fingers pinch-zoom and twist. Keyboard (when
 * the canvas has focus): WASD/arrows pan, Q/E rotate, R/F tilt, +/− zoom.
 */
export class RtsCameraController {
  state: RtsCameraState = { target: [0, 0], distance: 600, yaw: 0, pitch: 0.95 };
  limits: RtsCameraLimits = { ...DEFAULT_LIMITS };

  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private mode: 'pan' | 'rotate' | 'pinch' | null = null;
  private grab: [number, number] | null = null;
  private last = { x: 0, y: 0 };
  private down: { x: number; y: number } | null = null;
  private pinch: { distance: number; angle: number; mid: { x: number; y: number } } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly onClick: (x: number, y: number) => void,
  ) {
    element.tabIndex = 0;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    element.addEventListener('keydown', this.onKeyDown);
    element.addEventListener('keyup', this.onKeyUp);
    element.addEventListener('blur', this.onBlur);
    this.apply();
  }

  setState(state: RtsCameraState): void {
    this.state = state;
    this.apply();
  }

  /** Advances keyboard movement; returns true if the camera moved. */
  update(dt: number): boolean {
    if (this.keys.size === 0) return false;
    const k = (...codes: string[]) => (codes.some((c) => this.keys.has(c)) ? 1 : 0);
    const forward = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
    const right = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
    const turn = k('KeyE') - k('KeyQ');
    const tilt = k('KeyR') - k('KeyF');
    const zoom = k('Minus', 'NumpadSubtract') - k('Equal', 'NumpadAdd');
    let s = this.state;
    if (forward || right) s = panRelative(s, forward, right, dt, this.limits);
    if (turn || tilt) s = rotate(s, turn * KEY_ROTATE_SPEED * dt, tilt * KEY_ROTATE_SPEED * 0.6 * dt, this.limits);
    if (zoom) s = zoomTowards(s, Math.exp(zoom * KEY_ZOOM_SPEED * dt), null, this.limits);
    if (s === this.state) return false;
    this.state = s;
    this.apply();
    return true;
  }

  dispose(): void {
    const e = this.element;
    e.removeEventListener('pointerdown', this.onPointerDown);
    e.removeEventListener('pointermove', this.onPointerMove);
    e.removeEventListener('pointerup', this.onPointerUp);
    e.removeEventListener('pointercancel', this.onPointerUp);
    e.removeEventListener('wheel', this.onWheel);
    e.removeEventListener('contextmenu', this.onContextMenu);
    e.removeEventListener('keydown', this.onKeyDown);
    e.removeEventListener('keyup', this.onKeyUp);
    e.removeEventListener('blur', this.onBlur);
  }

  /** Ground point `[x, z]` under a client position, or null above the horizon. */
  groundAt(clientX: number, clientY: number): [number, number] | null {
    const rect = this.element.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    return intersectGround([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z]);
  }

  private apply(): void {
    const [x, y, z] = cameraPosition(this.state);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.state.target[0], 0, this.state.target[1]);
    const { near, far } = clipPlanes(this.state.distance);
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.element.focus({ preventScroll: true });
    this.element.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.mode = 'pinch';
      this.pinch = this.pinchMetrics();
      this.down = null;
      return;
    }
    this.down = { x: e.clientX, y: e.clientY };
    this.last = { x: e.clientX, y: e.clientY };
    if (e.button === 1 || e.button === 2 || e.shiftKey) {
      this.mode = 'rotate';
    } else {
      this.mode = 'pan';
      this.grab = this.groundAt(e.clientX, e.clientY);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.mode === 'pinch') {
      const now = this.pinchMetrics();
      if (now && this.pinch) {
        const gesture = classifyTwoFingerGesture(this.pinch, now);
        if (gesture === 'tilt') {
          // Both fingers move up/down together: tilt like in map apps.
          this.state = rotate(this.state, 0, (now.mid.y - this.pinch.mid.y) * ROTATE_SPEED, this.limits);
        } else {
          const before = this.groundAt(this.pinch.mid.x, this.pinch.mid.y);
          const after = this.groundAt(now.mid.x, now.mid.y);
          if (before && after) this.state = panByGroundDelta(this.state, before, after, this.limits);
          this.state = zoomTowards(this.state, this.pinch.distance / Math.max(now.distance, 1), this.groundAt(now.mid.x, now.mid.y), this.limits);
          this.state = rotate(this.state, now.angle - this.pinch.angle, 0, this.limits);
        }
        this.pinch = now;
        this.apply();
      }
      return;
    }
    if (this.mode === 'rotate') {
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.state = rotate(this.state, -dx * ROTATE_SPEED, dy * ROTATE_SPEED, this.limits);
      this.apply();
    } else if (this.mode === 'pan' && this.grab) {
      const now = this.groundAt(e.clientX, e.clientY);
      if (now) {
        this.state = panByGroundDelta(this.state, this.grab, now, this.limits);
        this.apply();
      }
    }
    this.last = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.down && this.mode === 'pan' && e.button === 0 && isClick(this.down, { x: e.clientX, y: e.clientY })) {
      this.onClick(e.clientX, e.clientY);
    }
    if (this.pointers.size === 0) {
      this.mode = null;
      this.grab = null;
      this.down = null;
      this.pinch = null;
    } else if (this.mode === 'pinch') {
      // Lifting one finger continues as a one-finger pan with the remaining finger.
      const [rest] = [...this.pointers.values()];
      this.pinch = null;
      this.mode = rest ? 'pan' : null;
      this.grab = rest ? this.groundAt(rest.x, rest.y) : null;
      if (rest) this.last = { ...rest };
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.state = zoomTowards(this.state, wheelZoomFactor(delta), this.groundAt(e.clientX, e.clientY), this.limits);
    this.apply();
  };

  private onContextMenu = (e: Event): void => e.preventDefault();

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^(Key[WASDQERF]|Arrow\w+|Minus|Equal|NumpadAdd|NumpadSubtract)$/.test(e.code)) {
      this.keys.add(e.code);
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => this.keys.clear();

  private pinchMetrics(): { distance: number; angle: number; mid: { x: number; y: number } } | null {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
}
