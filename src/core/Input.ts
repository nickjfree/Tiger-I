/* ---------------------------------------------------------------------------
 * Keyboard + pointer-lock mouse input.
 *
 * Driving:   W/S throttle, A/D steer (differential), X handbrake
 * Combat:    LMB 88mm, Space coax MG, F hull MG, RMB (hold) gunner sight
 * Misc:      T un-flip tank, M mute, H toggle help, wheel = camera zoom
 * ------------------------------------------------------------------------ */

export class Input {
  /** Currently held key codes (KeyboardEvent.code). */
  private readonly keys = new Set<string>();

  /** Accumulated pointer-lock mouse deltas since last consume. */
  private lookDX = 0;
  private lookDY = 0;

  /** Accumulated wheel delta since last consume. */
  private wheelDelta = 0;

  firePrimary = false; // LMB held
  fireCoax = false;    // Space held (checked via keys too)
  sightHeld = false;   // RMB held

  pointerLocked = false;

  /** One-shot key presses consumed by whoever asks first. */
  private readonly pressed = new Set<string>();

  /** Called once on the first user gesture (used to unlock WebAudio). */
  onFirstInteraction: (() => void) | null = null;
  private interacted = false;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      this.noteInteraction();
      // avoid page scroll on space
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    element.addEventListener('mousedown', (e) => {
      this.noteInteraction();
      if (!this.pointerLocked) {
        element.requestPointerLock();
        return;
      }
      if (e.button === 0) this.firePrimary = true;
      if (e.button === 2) this.sightHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firePrimary = false;
      if (e.button === 2) this.sightHeld = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    });

    window.addEventListener(
      'wheel',
      (e) => {
        this.wheelDelta += Math.sign(e.deltaY);
      },
      { passive: true },
    );

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === element;
      if (!this.pointerLocked) {
        this.firePrimary = false;
        this.sightHeld = false;
      }
    });
  }

  private noteInteraction(): void {
    if (this.interacted) return;
    this.interacted = true;
    this.onFirstInteraction?.();
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** True exactly once per physical key press. */
  wasPressed(code: string): boolean {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  /** Throttle in [-1, 1]: W forward, S reverse. */
  get throttle(): number {
    return (this.isDown('KeyW') ? 1 : 0) + (this.isDown('KeyS') ? -1 : 0);
  }

  /** Steer in [-1, 1]: positive = turn right (D). */
  get steer(): number {
    return (this.isDown('KeyD') ? 1 : 0) + (this.isDown('KeyA') ? -1 : 0);
  }

  get brake(): boolean {
    return this.isDown('KeyX');
  }

  get coaxHeld(): boolean {
    return this.isDown('Space');
  }

  get hullMGHeld(): boolean {
    return this.isDown('KeyF');
  }

  /** Read and reset accumulated mouse deltas. */
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return r;
  }

  /** Read and reset accumulated wheel steps. */
  consumeWheel(): number {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }
}
