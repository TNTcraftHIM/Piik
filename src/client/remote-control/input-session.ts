import type { InputTransport } from "./input-route";
import { debugError, debugEvent } from "../lib/debug";
import { remoteInputStateSchema, remoteTextFits, remoteTextAvailable, remoteGamepadAvailable, type RemoteInputState, type RemoteGamepadReport } from "./protocol";
export type { RemoteInputState } from "./protocol";
const MAX_QUEUED_PLAINTEXT_BYTES = 8192;

// Each virtual contact has its own source. Physical keys use the default source.
type KeyInput = { type: "key"; code: string; down: boolean; source?: symbol; repeat?: boolean };

export type RemoteInputEvent =
  | { type: "move"; x: number; y: number }
  | { type: "relative"; dx: number; dy: number }
  | KeyInput
  | { type: "text"; text: string }
  | { type: "button"; button: number; down: boolean }
  | { type: "wheel"; delta: number }
  | { type: "gamepad"; gamepad: RemoteGamepadReport }
  | { type: "gamepad-reset" }
  | { type: "gamepad-stop" }
  | { type: "reset" };

type PointerInput = Extract<RemoteInputEvent, { type: "move" | "relative" }>;
export type RemoteInputInterruption = "request-not-approved" | "request-ended" | "control-ended";

// Owns input intent and its exact Host grant. DOM capture and media routing
// consume this session; neither can revive an old approval after cancellation.
export class RemoteInputSession {
  state: RemoteInputState | null = null;
  private intent: string | null = null;
  private disposed = false;
  private pointer: PointerInput | null = null;
  private pointerTimer: ReturnType<typeof setTimeout> | null = null;
  private nextPointerAt = 0;
  private wheelFraction = 0;
  private readonly heldKeys = new Map<string, Set<KeyInput["source"]>>();

  constructor(private readonly channel: InputTransport, private readonly changed: (state: RemoteInputState | null) => void,
    private readonly interrupted?: (interruption: RemoteInputInterruption) => void) {
    channel.addEventListener("message", this.message);
    channel.addEventListener("close", this.closed);
    this.send({ type: "sync" });
  }

  private set(state: RemoteInputState | null): void {
    // Capability updates do not retire input belonging to the same active grant.
    if (state?.state !== "active" || this.state?.state !== "active" ||
        state.grant !== this.state.grant || state.intent !== this.state.intent) {
      this.clearPointer();
      this.nextPointerAt = 0;
      this.wheelFraction = 0;
      this.heldKeys.clear();
    }
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
    if (pointer) {
      this.nextPointerAt = performance.now() + 4;
      this.sendInput(pointer);
    }
  };

  private readonly message = (event: MessageEvent): void => {
    if (this.disposed || typeof event.data !== "string" || event.data.length > 1024) return;
    let decoded: unknown;
    try { decoded = JSON.parse(event.data); } catch { return; }
    const parsed = remoteInputStateSchema.safeParse(decoded);
    if (!parsed.success) return;
    const state = parsed.data;
    // Source availability is authoritative for every request. Pause/off may
    // reach us before the Host receives our new intent; it still ends it.
    const requested = this.intent !== null;
    if (state.state === "unavailable") this.intent = null;
    if (this.intent !== null && state.intent !== this.intent) return;
    if (this.intent === null && (state.state === "active" || state.state === "suspended" || state.state === "pending")) {
      this.send({ type: "release", intent: state.intent });
      return;
    }
    if (state.state !== "pending" && state.state !== "active" && state.state !== "suspended") {
      this.intent = null;
      if (requested && !state.reason && state.state !== "failed") this.reportInterruption(state);
    }
    if (state.state === "failed") debugEvent("remote-input", "host-failed", { previousState: this.state?.state, mode: state.mode });
    this.set(state);
  };

  private readonly closed = (): void => {
    if (this.intent !== null) this.reportInterruption();
    this.intent = null;
    this.set(null);
  };

  private reportInterruption(next?: RemoteInputState): void {
    if (this.state?.state === "active" || this.state?.state === "suspended") {
      this.interrupted?.("control-ended");
    } else if (this.state?.state === "pending") {
      const awaitingApproval = this.state.mode === "ask" && next?.mode === "ask" && next.state === "ready";
      this.interrupted?.(awaitingApproval ? "request-not-approved" : "request-ended");
    }
  }

  private send(event: object): boolean {
    if (this.disposed || this.channel.readyState !== "open") return false;
    try {
      // A stalled input queue must not replay seconds of old actions later.
      if (this.channel.bufferedAmount > MAX_QUEUED_PLAINTEXT_BYTES) throw new Error("input queue stalled");
      this.channel.send(JSON.stringify(event));
      return true;
    } catch (error) {
      debugError("remote-input", "send-failed", error, { state: this.state?.state, readyState: this.channel.readyState, bufferedAmount: this.channel.bufferedAmount });
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
      this.set({ ...state, state: "pending", grant: undefined, reason: undefined, inputFailed: undefined, intent: this.intent });
  }

  release(): void {
    if (this.intent === null || !this.state) {
      if (this.state?.reason) this.set({ ...this.state, reason: undefined });
      return;
    }
    const intent = this.intent;
    const state = this.state;
    this.intent = null;
    if (this.send({ type: "release", intent })) this.set({ ...state, state: "ready", grant: undefined, intent: undefined, inputFailed: undefined });
  }

  input(event: RemoteInputEvent): void {
    if ((event.type === "gamepad" || event.type === "gamepad-reset" || event.type === "gamepad-stop") && (!this.state || !remoteGamepadAvailable(this.state))) return;
    if (this.state && event.type === "text" && !remoteTextAvailable(this.state)) return;
    if (event.type === "move" || event.type === "relative") {
      if (this.state?.state !== "active") return;
      // Absolute samples replace one another; relative samples accumulate.
      // Flush before a button/key transition to preserve drag and game input order.
      if (this.pointer && this.pointer.type !== event.type) this.flushPointer();
      this.pointer = event.type === "relative" && this.pointer?.type === "relative"
        ? { type: "relative", dx: this.pointer.dx + event.dx, dy: this.pointer.dy + event.dy }
        : event;
      // Send idle motion immediately; batch only inside the last send's interval.
      // This remains independent of rendering and owns no idle timer.
      if (this.pointerTimer === null) {
        const delay = this.nextPointerAt - performance.now();
        if (delay <= 0) this.flushPointer();
        else this.pointerTimer = setTimeout(this.flushPointer, delay);
      }
      return;
    }
    if (event.type === "reset") {
      this.clearPointer();
      this.wheelFraction = 0;
      this.heldKeys.clear();
    } else this.flushPointer();
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
        (state.state !== "active" && !((event.type === "reset" || event.type === "gamepad-reset" || event.type === "gamepad-stop") && state.state === "suspended"))) return;
    if (event.type === "text" && !remoteTextFits(event.text, state.grant)) return;
    if (event.type === "key") {
      const { type, code, down } = event;
      if (this.keyTransition(event)) this.send({ type, code, down, grant: state.grant });
    } else this.send({ ...event, grant: state.grant });
  }

  private keyTransition({ code, down, source, repeat }: KeyInput): boolean {
    const holders = this.heldKeys.get(code);
    if (repeat) return down && holders?.has(source) === true;
    if (down) {
      if (holders) {
        holders.add(source);
        return false;
      }
      this.heldKeys.set(code, new Set([source]));
      return true;
    }
    if (!holders?.delete(source) || holders.size) return false;
    this.heldKeys.delete(code);
    return true;
  }

  dispose(): void {
    this.release();
    this.clearPointer();
    this.disposed = true;
    this.channel.removeEventListener("message", this.message);
    this.channel.removeEventListener("close", this.closed);
  }
}
