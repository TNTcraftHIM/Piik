import type { RemoteInputEvent } from "./input-session";
import type { RemoteGamepadReport } from "./protocol";

// Standard Gamepad layout. Platform backends own native device formats.
// https://www.w3.org/TR/gamepad/#remapping
function gamepadReport(pad: Pick<Gamepad, "buttons" | "axes">): RemoteGamepadReport {
  let buttons = 0;
  for (let index = 0; index < 17; index++) {
    if (pad.buttons[index]?.pressed) buttons |= 1 << index;
  }
  const axis = (index: number) => {
    const value = Math.max(-1, Math.min(1, pad.axes[index] ?? 0));
    return Math.round(value * (value < 0 ? 32768 : 32767));
  };
  const trigger = (index: number) => Math.round(Math.max(0, Math.min(1, pad.buttons[index]?.value ?? 0)) * 255);
  return {
    buttons,
    leftTrigger: trigger(6), rightTrigger: trigger(7),
    leftX: axis(0), leftY: axis(1), rightX: axis(2), rightY: axis(3),
  };
}

// One collector belongs to one active grant. Focus/visibility release the current
// report, while disposing the grant also retires its animation frame and listeners.
export class RemoteGamepad {
  private frame: number | null = null;
  private nextReport = 0;
  private index: number | null = null;
  private connected = false;
  private touchReport: RemoteGamepadReport | null = null;
  private touchAxes = [0, 0, 0, 0];
  private disposed = false;

  constructor(private readonly input: (event: RemoteInputEvent) => void,
    private readonly changed: (connected: boolean) => void,
    private readonly owner: Window = window,
    private readonly page: Document = document) {
    owner.addEventListener("blur", this.pause);
    owner.addEventListener("focus", this.resume);
    owner.addEventListener("gamepaddisconnected", this.disconnected);
    page.addEventListener("visibilitychange", this.visibility);
    this.resume();
  }

  setLeftStick(x: number, y: number): void {
    this.setStick(0, x, y);
  }

  setRightStick(x: number, y: number): void {
    this.setStick(2, x, y);
  }

  private setStick(index: 0 | 2, x: number, y: number): void {
    if (this.disposed || this.connected || this.page.hidden || !this.page.hasFocus()) return;
    this.touchAxes[index] = x;
    this.touchAxes[index + 1] = y;
    if (this.touchAxes.every(axis => axis === 0)) {
      if (this.touchReport) this.input({ type: "gamepad-reset" });
      this.touchReport = null;
      return;
    }
    this.touchReport = gamepadReport({ buttons: [], axes: this.touchAxes });
  }

  private setConnected(value: boolean): void {
    if (this.connected !== value) { this.connected = value; this.changed(value); }
  }
  private readonly pause = (): void => {
    if (this.frame !== null) this.owner.cancelAnimationFrame(this.frame);
    this.frame = null; this.nextReport = 0; this.touchReport = null;
    this.touchAxes.fill(0);
    this.input({ type: "gamepad-reset" }); this.setConnected(false);
  };
  private readonly resume = (): void => {
    if (!this.disposed && !this.page.hidden && this.page.hasFocus() && this.frame === null)
      this.frame = this.owner.requestAnimationFrame(this.poll);
  };
  private readonly visibility = (): void => { if (this.page.hidden) this.pause(); else this.resume(); };
  private readonly disconnected = (event: GamepadEvent): void => {
    if (event.gamepad.index === this.index) {
      this.pause(); this.input({ type: "gamepad-stop" }); this.index = null; this.resume();
    }
  };
  private readonly poll = (time: number): void => {
    this.frame = null;
    if (this.disposed || this.page.hidden || !this.page.hasFocus()) { this.pause(); return; }
    let pad: Gamepad | undefined;
    try { pad = Array.from(this.owner.navigator.getGamepads?.() ?? []).find(value => value?.connected && value.mapping === "standard") ?? undefined; }
    catch { /* Browser permissions can deny controller access. Keep the grant neutral. */ }
    if (this.index !== null && this.index !== pad?.index) this.input({ type: "gamepad-stop" });
    this.index = pad?.index ?? null; this.setConnected(Boolean(pad));
    if (pad && this.touchReport) {
      this.touchReport = null;
      this.touchAxes.fill(0);
    }
    if ((pad || this.touchReport) && time >= this.nextReport) {
      const interval = 1000 / 60;
      this.nextReport = time + interval - ((time - this.nextReport) % interval);
      // Repeat the complete current report so the native driver can enumerate
      // a newly attached virtual device even when the player holds still.
      this.input({ type: "gamepad", gamepad: pad ? gamepadReport(pad) : this.touchReport! });
    }
    this.resume();
  };

  dispose(): void {
    this.disposed = true; this.pause();
    this.input({ type: "gamepad-stop" }); this.index = null;
    this.owner.removeEventListener("blur", this.pause);
    this.owner.removeEventListener("focus", this.resume);
    this.owner.removeEventListener("gamepaddisconnected", this.disconnected);
    this.page.removeEventListener("visibilitychange", this.visibility);
  }
}
