import type { RemoteInputEvent } from "./input-session";

type Point = { x: number; y: number };
type Contact = Point & { start: Point };

// Gesture lifetime belongs to the current input grant. Coordinates stay in the
// shared picture, so viewport rotation and letterboxing do not move the target.
export class RemoteTouchpad {
  position: Point = { x: 0.5, y: 0.5 };
  private contacts = new Map<number, Contact>();
  private hold: ReturnType<typeof setTimeout> | null = null;
  private fingers = 0;
  private moved = false;
  private dragging = false;
  private started = 0;

  constructor(
    private readonly picture: () => { width: number; height: number } | null,
    private readonly input: (event: RemoteInputEvent) => void,
    private readonly scroll: (deltaY: number) => void,
    private readonly changed: (position: Point) => void,
  ) {}

  down(id: number, x: number, y: number): void {
    if (!this.contacts.size) {
      this.started = performance.now();
      this.fingers = 0;
      this.moved = false;
      this.input({ type: "move", ...this.position });
      this.changed(this.position);
    }
    this.contacts.set(id, { x, y, start: { x, y } });
    this.fingers = Math.max(this.fingers, this.contacts.size);
    this.clearHold();
    if (this.fingers === 1) {
      this.hold = setTimeout(() => {
        this.hold = null;
        this.dragging = true;
        this.input({ type: "button", button: 0, down: true });
      }, 500);
    } else {
      this.endDrag();
    }
  }

  move(id: number, x: number, y: number): void {
    const contact = this.contacts.get(id);
    if (!contact) return;
    const dx = x - contact.x, dy = y - contact.y;
    if (Math.hypot(x - contact.start.x, y - contact.start.y) > 8) {
      this.moved = true;
      this.clearHold();
    }
    if (!this.moved && !this.dragging) return;
    // Keep the initial displacement while deciding tap versus motion. Updating
    // the origin before this threshold loses the start of every small swipe.
    contact.x = x; contact.y = y;
    if (this.fingers === 1) {
      const picture = this.picture();
      if (!picture?.width || !picture.height) return;
      this.position = {
        x: Math.max(0, Math.min(1, this.position.x + dx / picture.width)),
        y: Math.max(0, Math.min(1, this.position.y + dy / picture.height)),
      };
      this.input({ type: "move", ...this.position });
      this.changed(this.position);
    } else if (this.fingers === 2 && this.contacts.size === 2) {
      this.scroll(-dy / 2);
    }
  }

  up(id: number): void {
    if (!this.contacts.delete(id)) return;
    this.clearHold();
    if (this.contacts.size) return;
    if (!this.moved && !this.dragging && performance.now() - this.started < 500 && this.fingers <= 2) {
      const button = this.fingers === 2 ? 2 : 0;
      this.input({ type: "button", button, down: true });
      this.input({ type: "button", button, down: false });
    }
    this.endDrag();
  }

  private clearHold(): void {
    if (this.hold !== null) clearTimeout(this.hold);
    this.hold = null;
  }

  private endDrag(): void {
    if (this.dragging) this.input({ type: "button", button: 0, down: false });
    this.dragging = false;
  }

  cancel(id: number): void {
    if (this.contacts.has(id)) this.reset();
  }

  reset(): void {
    this.clearHold();
    this.endDrag();
    this.contacts.clear();
  }
}
