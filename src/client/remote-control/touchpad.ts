import type { RemoteInputEvent } from "./input-session";
import type { RemoteViewport } from "./viewport";
import { rotatePictureDelta, rotatePicturePoint, type VideoRotation } from "../media/video-geometry";

export const REMOTE_TOUCH_HOLD_MS = 500;

type Point = { x: number; y: number };
type PointerMode = "direct" | "trackpad" | "mouse";
type Contact = Point & { start: Point };

// Gesture lifetime belongs to the current input grant. One source target drives
// the pointer and tool; local view gestures reanchor it without remote input.
export class RemoteTouchpad {
  position: Point = { x: 0.5, y: 0.5 };
  private contacts = new Map<number, Contact>();
  private directTarget: (() => Point | null) | null = null;
  private hold: ReturnType<typeof setTimeout> | null = null;
  private fingers = 0;
  private moved = false;
  private dragging = false;
  private mode: PointerMode = "direct";
  private held = new Set<number>();
  private started = 0;
  private pair: { center: Point; distance: number } | null = null;
  private gesture: "pending" | "scroll" | "view" = "pending";
  private frame: number | null = null;

  constructor(
    private readonly picture: () => { left: number; top: number; width: number; height: number; rotation: VideoRotation } | null,
    private readonly input: (event: RemoteInputEvent) => void,
    private readonly scroll: (deltaY: number) => void,
    private readonly changed: (position: Point) => void,
    private readonly viewport: Pick<RemoteViewport, "scale" | "transform">,
  ) {}

  setMode(mode: PointerMode, position?: Point | null): void {
    if (this.mode === mode && (mode === "direct" || !position)) return;
    this.reset();
    this.mode = mode;
    if (mode !== "direct") {
      const next = position ?? this.position;
      this.position = { x: Math.max(0, Math.min(1, next.x)), y: Math.max(0, Math.min(1, next.y)) };
      this.input({ type: "move", ...this.position });
      this.changed(this.position);
    }
  }

  private directionKeys = new Set<string>();
  private readonly directionSource = Symbol();

  direction(x: number, y: number): void {
    const keys = new Set<string>();
    // Ignore small thumb movements within the central quarter of the radius.
    const deadZoneRadius = 0.25;
    if (Math.hypot(x, y) > deadZoneRadius) {
      // Eight equal sectors overlap adjacent keys in the diagonal directions.
      const threshold = Math.max(Math.abs(x), Math.abs(y)) * Math.tan(Math.PI / 8);
      if (Math.abs(x) > threshold) keys.add(x < 0 ? "KeyA" : "KeyD");
      if (Math.abs(y) > threshold) keys.add(y < 0 ? "KeyW" : "KeyS");
    }
    for (const code of this.directionKeys) {
      if (!keys.has(code)) this.input({ type: "key", code, down: false, source: this.directionSource });
    }
    for (const code of keys) {
      if (!this.directionKeys.has(code)) this.input({ type: "key", code, down: true, source: this.directionSource });
    }
    this.directionKeys = keys;
  }

  refresh(): void {
    this.changed(this.position);
  }

  // The screen contact stays with the gesture even when the picture moves.
  private aimAtContact(): boolean {
    if (!this.directTarget) return true;
    const target = this.directTarget();
    if (!target) return false;
    this.position = target;
    this.changed(target);
    return true;
  }

  down(id: number, x: number, y: number, pointAt: ((x: number, y: number) => Point | null) | null): void {
    const contact = { x, y, start: { x, y } };
    if (!this.contacts.size) {
      if (this.mode === "direct") {
        if (!pointAt) return;
        this.directTarget = () => pointAt(contact.x, contact.y);
        if (!this.aimAtContact()) { this.directTarget = null; return; }
      }
      this.started = performance.now();
      this.fingers = 0;
      this.moved = this.held.size > 0;
      this.gesture = "pending";
    }
    this.contacts.set(id, contact);
    this.fingers = Math.max(this.fingers, this.contacts.size);
    this.clearHold();
    if (this.fingers === 1 && !this.moved) {
      this.hold = setTimeout(() => {
        this.hold = null;
        if (!this.aimAtContact()) return;
        this.dragging = true;
        this.input({ type: "move", ...this.position });
        if (!this.held.has(0)) this.input({ type: "button", button: 0, down: true });
      }, REMOTE_TOUCH_HOLD_MS);
    } else {
      this.endDrag();
      this.pair = this.pairGeometry();
    }
  }

  move(id: number, x: number, y: number): void {
    const contact = this.contacts.get(id);
    if (!contact) return;
    if (this.fingers > 1) {
      contact.x = x; contact.y = y;
      // A native touch packet produces one pointer event per finger. Decide
      // pinch versus parallel movement after both arrive, not halfway through.
      if (this.frame === null) this.frame = requestAnimationFrame(() => this.movePair());
      return;
    }
    const dx = x - contact.x, dy = y - contact.y;
    if (Math.hypot(x - contact.start.x, y - contact.start.y) > 8) {
      this.moved = true;
      this.clearHold();
    }
    if (this.directTarget) {
      contact.x = x; contact.y = y;
      if ((this.moved || this.dragging) && this.aimAtContact()) this.input({ type: "move", ...this.position });
    } else if (this.moved || this.dragging) {
      // Keep the initial displacement while deciding a relative tap versus motion.
      contact.x = x; contact.y = y;
      this.moveBy(dx, dy);
    }
  }

  moveBy(dx: number, dy: number): void {
    this.moved = true;
    this.clearHold();
    const picture = this.picture();
    if (!picture?.width || !picture.height) return;
    const delta = rotatePictureDelta({ x: dx / picture.width, y: dy / picture.height }, picture.rotation, true);
    this.position = {
      x: Math.max(0, Math.min(1, this.position.x + delta.x)),
      y: Math.max(0, Math.min(1, this.position.y + delta.y)),
    };
    this.input({ type: "move", ...this.position });
    this.changed(this.position);
  }

  private pairGeometry(): { center: Point; distance: number } | null {
    if (this.fingers !== 2 || this.contacts.size !== 2) return null;
    const [a, b] = [...this.contacts.values()];
    return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) };
  }

  private movePair(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const next = this.pairGeometry(), previous = this.pair;
    if (!next || !previous) return;
    if (this.gesture === "pending") {
      const pinch = Math.abs(next.distance - previous.distance) > Math.max(8, previous.distance * .08);
      const pan = Math.hypot(next.center.x - previous.center.x, next.center.y - previous.center.y) > 8;
      if (!pinch && !pan) return;
      this.gesture = this.mode === "mouse" || pinch || this.viewport.scale !== 1 ? "view" : "scroll";
      this.moved = true;
    }
    if (this.gesture === "view") {
      const before = this.mode === "mouse" ? this.picture() : null;
      const point = before && rotatePicturePoint(this.position, before.rotation);
      this.viewport.transform(previous.center, next.center, next.distance / previous.distance);
      const after = point && this.picture();
      if (before && point && after?.width && after.height) {
        // The picture slides under the tool; only its local source target changes.
        const target = rotatePicturePoint({
          x: (before.left + point.x * before.width - after.left) / after.width,
          y: (before.top + point.y * before.height - after.top) / after.height,
        }, after.rotation, true);
        this.position = { x: Math.max(0, Math.min(1, target.x)), y: Math.max(0, Math.min(1, target.y)) };
        this.changed(this.position);
      }
    } else this.scroll(previous.center.y - next.center.y);
    this.pair = next;
  }

  up(id: number, x?: number, y?: number): void {
    const contact = this.contacts.get(id);
    if (!contact) return;
    if (this.directTarget && this.fingers === 1 && x !== undefined && y !== undefined) { contact.x = x; contact.y = y; }
    this.movePair();
    this.contacts.delete(id);
    this.clearHold();
    if (this.contacts.size) return;
    const before = this.position;
    const tap = !this.moved && !this.dragging && performance.now() - this.started < REMOTE_TOUCH_HOLD_MS && this.fingers <= 2;
    const aimed = (this.dragging || tap) && this.aimAtContact();
    if (this.dragging && aimed && (before.x !== this.position.x || before.y !== this.position.y)) {
      this.input({ type: "move", ...this.position });
    }
    if (aimed && tap) {
      const button = this.fingers === 2 ? 2 : 0;
      this.input({ type: "move", ...this.position });
      this.input({ type: "button", button, down: true });
      this.input({ type: "button", button, down: false });
    }
    this.directTarget = null;
    this.endDrag();
  }

  private clearHold(): void {
    if (this.hold !== null) clearTimeout(this.hold);
    this.hold = null;
  }

  private endDrag(): void {
    if (this.dragging && !this.held.has(0)) this.input({ type: "button", button: 0, down: false });
    this.dragging = false;
  }

  button(button: number, down: boolean): void {
    if (this.held.has(button) === down) return;
    this.clearHold();
    this.moved = true;
    if (down) {
      this.held.add(button);
      this.input({ type: "move", ...this.position });
    } else this.held.delete(button);
    if (button !== 0 || !this.dragging) this.input({ type: "button", button, down });
  }

  wheel(deltaY: number): void {
    this.scroll(deltaY);
  }

  cancel(id: number): void {
    if (this.contacts.has(id)) this.reset();
  }

  reset(): void {
    this.direction(0, 0);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pair = null;
    this.clearHold();
    this.endDrag();
    this.directTarget = null;
    this.contacts.clear();
    for (const button of [...this.held]) this.button(button, false);
  }
}
