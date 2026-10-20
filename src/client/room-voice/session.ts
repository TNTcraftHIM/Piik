import type { ClientMessage, IceConfig, RoomVoiceCommand, RoomVoiceState, ServerMessage } from "../../shared/protocol";
import { audioInputConstraints } from "../media/audio-capture";
import { debugError } from "../lib/debug";
import { BrowserVoiceEndpoint } from "./browser-endpoint";

export type RoomVoiceError = "microphoneDenied" | "microphoneMissing" | "microphoneFailed" | "transport" | "rejected";
export interface RoomVoiceSnapshot {
  peerId: string;
  role: "host" | "viewer";
  connected: boolean;
  room: RoomVoiceState | null;
  capturePending: boolean;
  microphone: boolean;
  autoplayBlocked: boolean;
  muted: ReadonlySet<string>;
  error: RoomVoiceError | null;
}
interface CaptureRequest { stream?: MediaStream }

// One normal room signaling session owns voice. Sharing/capture generations do
// not enter this lifetime, and an approval never starts microphone capture.
export class RoomVoiceSession {
  readonly endpoint: BrowserVoiceEndpoint;
  private listeners = new Set<() => void>();
  private state: RoomVoiceSnapshot = { peerId: "", role: "viewer", connected: false, room: null,
    capturePending: false, microphone: false, autoplayBlocked: false, muted: new Set(), error: null };
  private capture: CaptureRequest | null = null;
  private publishing: CaptureRequest | null = null;
  private retiredPublications = new Set<string>();
  private serial = Promise.resolve();
  private scheduled = false;
  private closed = false;
  private epoch = 0;

  constructor(private readonly send: (message: ClientMessage) => boolean, iceConfig: IceConfig,
    private readonly beforeMicrophone: () => Promise<void> = async () => {}) {
    this.endpoint = new BrowserVoiceEndpoint(iceConfig, message => this.state.connected && this.send(message), () => {
      this.refresh(); this.schedule();
    });
  }
  getSnapshot = (): RoomVoiceSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get microphone(): boolean { return this.endpoint.microphone; }
  private update(patch: Partial<RoomVoiceSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private refresh(): void {
    this.update({ microphone: this.endpoint.microphone, capturePending: !!this.capture || !!this.publishing,
      autoplayBlocked: this.endpoint.autoplayBlocked, muted: new Set(this.endpoint.muted) });
  }
  updateIceConfig(config: IceConfig): void { this.endpoint.updateIceConfig(config); }
  authenticated(peerId: string, role: "host" | "viewer"): void {
    if (this.closed) return;
    this.disconnected();
    this.update({ peerId, role, connected: true, room: null, error: null });
  }
  private enqueue(action: () => Promise<void>): void {
    const epoch = this.epoch;
    this.serial = this.serial.then(async () => {
      if (!this.closed && this.state.connected && epoch === this.epoch) await action();
    }).catch(error => {
      if (!this.closed && this.state.connected && epoch === this.epoch) {
        debugError("room-voice", "transport-failed", error);
        this.update({ error: "transport" });
      }
    });
  }
  private schedule(): void {
    if (this.scheduled || this.closed || !this.state.connected) return;
    this.scheduled = true;
    this.enqueue(async () => { this.scheduled = false; await this.endpoint.reconcile(); this.refresh(); });
  }
  receive(message: ServerMessage): boolean {
    if (this.closed || !["room-voice-state", "room-voice-signal", "room-voice-error"].includes(message.type)) return false;
    if (!this.state.connected) return true;
    if (message.type === "room-voice-state") {
      if (message.revision < (this.state.room?.revision ?? 0)) return true;
      const me = message.members.find(member => member.peerId === this.state.peerId);
      if (!me?.listen || !me.speak) this.cancelCapture();
      const repaired = message.connections.some(connection => !connection.pending &&
        this.state.room?.connections.some(previous => previous.connectionId === connection.connectionId && previous.pending));
      this.update({ room: message, ...(this.state.error === "transport" && repaired && !message.unavailable.length ? { error: null } : {}) });
      // Authority retirement is synchronous even if an SDP operation is pending.
      this.endpoint.setAuthority(message, this.state.peerId);
      const publication = message.publications.find(pub => pub.peerId === this.state.peerId);
      if (publication && this.publishing) {
        const request = this.publishing; this.publishing = null;
        if (this.capture === request && request.stream && me?.listen && me.speak) {
          const track = request.stream.getAudioTracks()[0];
          if (track?.readyState === "live") {
            this.endpoint.attach(publication.id, request.stream);
            track.onended = () => this.stopMicrophone();
            this.capture = null;
          } else this.cancelCapture();
        }
      }
      // A cancelled or former page's publication cannot revive a microphone.
      if (publication && !this.endpoint.microphone && !this.publishing && !this.retiredPublications.has(publication.id)) {
        this.retiredPublications.add(publication.id);
        this.command({ action: "unpublish", publicationId: publication.id });
      }
      for (const id of this.retiredPublications) if (!message.publications.some(pub => pub.id === id)) this.retiredPublications.delete(id);
      this.refresh(); this.schedule();
    } else if (message.type === "room-voice-signal") {
      this.enqueue(async () => { await this.endpoint.receive(message); await this.endpoint.reconcile(); this.refresh(); });
    } else if (message.type === "room-voice-error") {
      if (message.code === "not-allowed") { this.cancelCapture(); this.publishing = null; }
      this.update({ error: message.code === "connection-unavailable" ? "transport" : "rejected" });
      this.refresh();
    }
    return true;
  }
  command(command: RoomVoiceCommand): boolean {
    if (this.closed || !this.state.connected) return false;
    if (command.action === "leave") this.stopMicrophone();
    this.update({ error: null });
    if (this.send({ type: "room-voice-command", command })) return true;
    this.update({ error: "transport" }); return false;
  }
  private cancelCapture(): void {
    const request = this.capture; this.capture = null;
    request?.stream?.getTracks().forEach(track => track.stop());
  }
  async startMicrophone(): Promise<void> {
    const me = this.state.room?.members.find(member => member.peerId === this.state.peerId);
    if (this.closed || !this.state.connected || !me?.listen || !me.speak || this.capture || this.publishing || this.microphone) return;
    const request: CaptureRequest = {}; this.capture = request;
    this.update({ error: null }); this.refresh();
    let stream: MediaStream | undefined;
    try {
      // Device permission must never block the serialized SDP/authority queue.
      await this.beforeMicrophone();
      if (this.capture !== request) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audioInputConstraints(true), channelCount: 1 }, video: false });
      if (this.capture !== request) return;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") throw new DOMException("No live microphone", "NotFoundError");
      track.contentHint = "speech"; request.stream = stream;
      this.publishing = request;
      if (!this.command({ action: "publish" })) { this.publishing = null; this.cancelCapture(); }
    } catch (error) {
      if (this.capture === request) {
        this.cancelCapture(); this.publishing = null;
        const name = error instanceof Error ? error.name : "";
        this.update({ error: name === "NotAllowedError" ? "microphoneDenied" : name === "NotFoundError" ? "microphoneMissing" : "microphoneFailed" });
      }
    } finally {
      if (this.capture !== request && request.stream !== stream) stream?.getTracks().forEach(track => track.stop());
      this.refresh();
    }
  }
  stopMicrophone(): void {
    this.cancelCapture(); this.endpoint.stopMicrophone();
    const publication = this.state.room?.publications.find(pub => pub.peerId === this.state.peerId);
    if (publication && !this.retiredPublications.has(publication.id)) {
      this.retiredPublications.add(publication.id);
      this.command({ action: "unpublish", publicationId: publication.id });
    }
    this.refresh(); this.schedule();
  }
  muteVoice(peerId: string): void { this.endpoint.mute(peerId, !this.endpoint.muted.has(peerId)); this.refresh(); }
  resumeAudio(): void { void this.endpoint.resume(); }
  disconnected(): void {
    this.epoch++;
    this.cancelCapture(); this.publishing = null; this.endpoint.close();
    this.retiredPublications.clear(); this.scheduled = false;
    this.update({ connected: false, capturePending: false, microphone: false, autoplayBlocked: false });
  }
  close(): void { if (!this.closed) { this.disconnected(); this.closed = true; this.update({ room: null, peerId: "" }); } }
}
