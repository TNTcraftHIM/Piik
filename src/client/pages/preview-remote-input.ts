import type { InputTransport } from "../remote-control/input-route";
import type { RemoteInputState } from "../remote-control/protocol";

// Local fixture for the real Viewer controls. Input never reaches an App or OS.
export class PreviewRemoteInput extends EventTarget implements InputTransport {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  private state: RemoteInputState = { state: "ready", mode: "room", platform: "windows" };

  send(data: unknown): void {
    const event = JSON.parse(String(data));
    if (event.type === "request") {
      this.state = { state: "active", mode: "room", platform: "windows", intent: event.intent, grant: "1".repeat(64) };
    } else if (event.type === "release") {
      this.state = { state: "ready", mode: "room", platform: "windows" };
    } else if (event.type !== "sync") return;
    queueMicrotask(() => {
      if (this.readyState === "open") this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(this.state) }));
    });
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
