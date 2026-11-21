const DEAD_ZONE = 0.15;
const MAX_PIXELS_PER_SECOND = 900;
// Limit the distance sent in one update after a rendering stall.
const MAX_FRAME_MS = 50;

export class StickMouse {
  private frame: number | null = null;
  private lastTime: number | null = null;
  private x = 0;
  private y = 0;
  private remainderX = 0;
  private remainderY = 0;

  constructor(private readonly move: (dx: number, dy: number) => void,
    private readonly clock: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame"> = window) {}

  set(x: number, y: number): void {
    const distance = Math.hypot(x, y);
    if (distance <= DEAD_ZONE) {
      this.stop();
      return;
    }
    const strength = (Math.min(1, distance) - DEAD_ZONE) / (1 - DEAD_ZONE);
    const speed = MAX_PIXELS_PER_SECOND * strength * strength / distance;
    this.x = x * speed;
    this.y = y * speed;
    this.frame ??= this.clock.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame !== null) this.clock.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.lastTime = null;
    this.remainderX = this.remainderY = 0;
  }

  private readonly tick = (time: number): void => {
    this.frame = this.clock.requestAnimationFrame(this.tick);
    const elapsed = this.lastTime === null ? 0 : Math.min(MAX_FRAME_MS, time - this.lastTime) / 1000;
    this.lastTime = time;
    const x = this.x * elapsed + this.remainderX;
    const y = this.y * elapsed + this.remainderY;
    const dx = Math.trunc(x), dy = Math.trunc(y);
    this.remainderX = x - dx;
    this.remainderY = y - dy;
    if (dx || dy) this.move(dx, dy);
  };
}
