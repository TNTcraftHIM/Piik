import type { InputTransport } from "../remote-control/input-route";
import type { RemoteControlMode, RemoteInputState } from "../remote-control/protocol";

/** Local Host replies for the real Viewer control. No input reaches an App. */
export class PreviewInput extends EventTarget implements InputTransport {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  private listeners = new Set<() => void>();
  private password = "";
  private state: RemoteInputState = { state: "ready", mode: "ask", platform: "windows", coPlay: true, capabilities: ["coPlay", "text"] };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: RemoteInputState): void {
    if (this.readyState !== "open") return;
    this.state = next;
    this.listeners.forEach(listener => listener());
    const data = JSON.stringify(next);
    queueMicrotask(() => { if (this.readyState === "open") this.dispatchEvent(new MessageEvent("message", { data })); });
  }
  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (typeof data !== "string") throw new TypeError("Preview input expects a text message");
    const event = JSON.parse(data) as { type: string; intent?: string; password?: string };
    if (event.type === "sync" || event.type === "capabilities") this.publish(this.state);
    else if (event.type === "release" && event.intent === this.state.intent) this.reset();
    else if (event.type === "request" && this.state.mode !== "off") {
      if (this.state.mode === "password" && event.password !== this.password) {
        this.publish({ ...this.state, state: "ready", intent: event.intent, reason: "password" });
      } else {
        const pending = this.state.mode === "ask";
        this.publish({ ...this.state, state: pending ? "pending" : "active", intent: event.intent,
          grant: pending ? undefined : "1".repeat(64), reason: undefined });
      }
    }
  }
  reset(): void {
    this.publish({ ...this.state, state: this.state.mode === "off" ? "unavailable" : "ready", grant: undefined, reason: undefined });
  }
  policy(mode: RemoteControlMode, password = ""): void {
    this.password = password;
    this.publish({ ...this.state, mode, state: mode === "off" ? "unavailable" : "ready", grant: undefined, reason: undefined });
  }
  decide(allow: boolean): void {
    if (!allow) this.reset();
    else if (this.state.state === "pending") this.publish({ ...this.state, state: "active", grant: "1".repeat(64) });
  }
  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.listeners.clear();
  }
}
