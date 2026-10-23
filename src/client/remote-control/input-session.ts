import type { InputTransport } from "./input-route";
import { remoteInputStateSchema, remoteTextAvailable, remoteGamepadAvailable, type RemoteInputState, type RemoteGamepadReport } from "./protocol";
export type { RemoteInputState } from "./protocol";
export type RemoteInputEvent =
  | { type: "move"; x: number; y: number }
  | { type: "relative"; dx: number; dy: number }
  | { type: "key"; code: string; down: boolean }
  | { type: "text"; text: string }
  | { type: "button"; button: number; down: boolean }
  | { type: "wheel"; delta: number }
  | { type: "gamepad"; gamepad: RemoteGamepadReport }
  | { type: "gamepad-reset" }
  | { type: "reset" };

type PointerInput = Extract<RemoteInputEvent, { type: "move" | "relative" }>;

// Owns input intent and its exact Host grant. DOM capture and media routing
// consume this session; neither can revive an old approval after cancellation.
export class RemoteInputSession {
  state: RemoteInputState | null = null;
  private intent: string | null = null;
  private disposed = false;
  private capabilitiesRequested = false;
  private pointer: PointerInput | null = null;
  private pointerTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelFraction = 0;

  constructor(private readonly channel: InputTransport, private readonly changed: (state: RemoteInputState | null) => void) {
    channel.addEventListener("message", this.message);
    channel.addEventListener("close", this.closed);
    this.send({ type: "sync" });
  }

  private set(state: RemoteInputState | null): void {
    this.clearPointer();
    this.wheelFraction = 0;
    this.state = state;
    this.changed(state);
  }

  private clearPointer(): void {
    if (this.pointerTimer !== null) clearTimeout(this.pointerTimer);
    this.pointerTimer = null;
    this.pointer = null;
  }

  private readonly flushPointer = (): void => {
    const pointer = this.pointer;
    this.clearPointer();
    if (pointer) this.sendInput(pointer);
  };

  private readonly message = (event: MessageEvent): void => {
    if (this.disposed || typeof event.data !== "string" || event.data.length > 1024) return;
    let decoded: unknown;
    try { decoded = JSON.parse(event.data); } catch { return; }
    const parsed = remoteInputStateSchema.safeParse(decoded);
    if (!parsed.success) return;
    const state = parsed.data;
    // Wait for a real Host response: the first sync may precede installation
    // of our route key. Legacy Apps ignore this optional negotiation command.
    if (!this.capabilitiesRequested) {
      this.capabilitiesRequested = true;
      if (!state.capabilities && !this.send({ type: "capabilities" })) return;
    }
    // Source availability is authoritative for every request. Pause/off may
    // reach us before the Host receives our new intent; it still ends it.
    if (state.state === "unavailable") this.intent = null;
    if (this.intent !== null && state.intent !== this.intent) return;
    if (this.intent === null && (state.state === "active" || state.state === "suspended" || state.state === "pending")) {
      this.send({ type: "release", intent: state.intent });
      return;
    }
    if (state.state !== "pending" && state.state !== "active" && state.state !== "suspended") this.intent = null;
    this.set(state);
  };

  private readonly closed = (): void => { this.intent = null; this.set(null); };

  private send(event: object): boolean {
    if (this.disposed || this.channel.readyState !== "open") return false;
    try {
      // A stalled input queue must not replay seconds of old actions later.
      if (this.channel.bufferedAmount > 8192) throw new Error("input queue stalled");
      this.channel.send(JSON.stringify(event));
      return true;
    } catch {
      this.intent = null;
      this.set(this.state && { ...this.state, state: "failed", grant: undefined });
      this.channel.close();
      return false;
    }
  }

  request(password?: string): void {
    if (this.intent !== null) this.release();
    const state = this.state;
    if (!state) return;
    this.intent = crypto.randomUUID().replaceAll("-", "");
    if (this.send({ type: "request", intent: this.intent, ...(password !== undefined ? { password } : {}) }))
      this.set({ ...state, state: "pending", grant: undefined, reason: undefined, intent: this.intent });
  }

  release(): void {
    if (this.intent === null || !this.state) {
      if (this.state?.reason) this.set({ ...this.state, reason: undefined });
      return;
    }
    const intent = this.intent;
    const state = this.state;
    this.intent = null;
    if (this.send({ type: "release", intent })) this.set({ ...state, state: "ready", grant: undefined, intent: undefined });
  }

  input(event: RemoteInputEvent): void {
    if ((event.type === "gamepad" || event.type === "gamepad-reset") && (!this.state || !remoteGamepadAvailable(this.state))) return;
    if (this.state && event.type === "text" && !remoteTextAvailable(this.state)) return;
    if (event.type === "move" || event.type === "relative") {
      if (this.state?.state !== "active") return;
      // Absolute samples replace one another; relative samples accumulate.
      // Flush before a button/key transition to preserve drag and game input order.
      if (this.pointer && this.pointer.type !== event.type) this.flushPointer();
      this.pointer = event.type === "relative" && this.pointer?.type === "relative"
        ? { type: "relative", dx: this.pointer.dx + event.dx, dy: this.pointer.dy + event.dy }
        : event;
      // Bound motion batching independently of rendering: a slow picture must
      // not slow input too. The timer exists only while motion is pending.
      if (this.pointerTimer === null) this.pointerTimer = setTimeout(this.flushPointer, 4);
      return;
    }
    if (event.type === "reset") { this.clearPointer(); this.wheelFraction = 0; }
    else this.flushPointer();
    this.sendInput(event);
  }

  scroll(deltaY: number, deltaMode: number): void {
    if (this.state?.state !== "active") return;
    // Normalize browser pixel/line/page units to wheel ticks (120 per notch).
    // Common defaults: 100 px or 3 lines per notch; retain precision-pad fractions.
    this.wheelFraction -= deltaY * (deltaMode === 1 ? 40 : deltaMode === 2 ? 120 : 1.2);
    const delta = Math.trunc(this.wheelFraction);
    this.wheelFraction -= delta;
    if (delta) this.input({ type: "wheel", delta: Math.max(-1200, Math.min(1200, delta)) });
  }

  private sendInput(event: RemoteInputEvent): void {
    const state = this.state;
    if (!this.intent || !state?.grant || state.intent !== this.intent ||
        (state.state !== "active" && !((event.type === "reset" || event.type === "gamepad-reset") && state.state === "suspended"))) return;
    this.send({ ...event, grant: state.grant });
  }

  dispose(): void {
    this.release();
    this.clearPointer();
    this.disposed = true;
    this.channel.removeEventListener("message", this.message);
    this.channel.removeEventListener("close", this.closed);
  }
}
