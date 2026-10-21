import type { ClientMessage, IceConfig, RoomVoiceCommand, RoomVoiceState, ServerMessage } from "../../shared/protocol";
import { audioInputConstraints } from "../media/audio-capture";
import { debugError } from "../lib/debug";
import { BrowserVoiceEndpoint } from "./browser-endpoint";
import { MicrophoneInput } from "../media/microphone-input";
import { browserCaptureDevices } from "../media/capture-devices";
import { readRoomPreferences, saveRoomPreferences, type RoomPreferences } from "../lib/room-preferences";

export type RoomVoiceError = "microphoneUnavailable" | "microphoneDenied" | "microphoneMissing" | "microphoneFailed" | "transport" | "rejected" | "closed";
export interface RoomVoiceSnapshot {
  peerId: string;
  role: "host" | "viewer";
  connected: boolean;
  room: RoomVoiceState | null;
  capturePending: boolean;
  microphone: boolean;
  deafened: boolean;
  autoplayBlocked: boolean;
  muted: ReadonlySet<string>;
  error: RoomVoiceError | null;
  input: RoomPreferences["voiceInput"];
  listeningVolume: number;
}
interface CaptureRequest { input?: MicrophoneInput; context?: AudioContext; settings: RoomPreferences["voiceInput"] }

// One normal room signaling session owns voice. Sharing/capture generations do
// not enter this lifetime, and joining never starts microphone capture.
export class RoomVoiceSession {
  readonly endpoint: BrowserVoiceEndpoint;
  private listeners = new Set<() => void>();
  private state: RoomVoiceSnapshot = { peerId: "", role: "viewer", connected: false, room: null,
    capturePending: false, microphone: false, deafened: false, autoplayBlocked: false, muted: new Set(), error: null,
    input: readRoomPreferences().voiceInput, listeningVolume: readRoomPreferences().voiceListeningVolume };
  private capture: CaptureRequest | null = null;
  private publishing: CaptureRequest | null = null;
  private retiredPublications = new Set<string>();
  private serial = Promise.resolve();
  private scheduled = false;
  private closed = false;
  private epoch = 0;

  constructor(private readonly send: (message: ClientMessage) => boolean, iceConfig: IceConfig) {
    this.endpoint = new BrowserVoiceEndpoint(iceConfig, message => this.state.connected && this.send(message), () => {
      this.refresh(); this.schedule();
    });
    this.endpoint.setListeningVolume(this.state.listeningVolume);
  }
  getSnapshot = (): RoomVoiceSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get microphone(): boolean { return this.endpoint.microphone; }
  activity = (localOnly = false): Promise<ReadonlyMap<string, number>> => this.endpoint.levels(localOnly);
  microphones = () => browserCaptureDevices("audioinput");
  private update(patch: Partial<RoomVoiceSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private refresh(): void {
    this.update({ microphone: this.endpoint.microphone, capturePending: !!this.capture || !!this.publishing,
      deafened: this.endpoint.deafened, autoplayBlocked: this.endpoint.autoplayBlocked, muted: new Set(this.endpoint.muted),
      ...(this.state.error === "transport" && !this.state.room?.unavailable.length && this.endpoint.connected ? { error: null } : {}) });
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
      if (!message.enabled || !me?.joined) { this.cancelCapture(); this.publishing = null; }
      this.update({ room: message, ...(!message.enabled || this.state.error === "closed" ? { error: null } : {}) });
      // Authority retirement is synchronous even if an SDP operation is pending.
      this.endpoint.setAuthority(message, this.state.peerId);
      const publication = message.publications.find(pub => pub.peerId === this.state.peerId);
      if (publication && this.publishing) {
        const request = this.publishing; this.publishing = null;
        if (this.capture === request && request.input && message.enabled && me?.joined) {
          if (request.input.stream.getAudioTracks()[0]?.readyState === "live") {
            this.endpoint.attach(publication.id, request.input);
            this.rememberInput(request.settings);
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
      this.update({ error: message.code === "connection-unavailable" ? "transport" : message.code === "not-enabled" ? "closed" : "rejected" });
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
    request?.input?.close();
    if (request?.context) void request.context.close().catch(() => {});
  }
  private rememberInput(input: RoomPreferences["voiceInput"]): void {
    this.update({ input }); saveRoomPreferences({ voiceInput: input });
  }
  setVolume(volume: number): void {
    this.endpoint.input?.volume(volume); this.capture?.input?.volume(volume);
    if (this.capture) this.capture.settings.volume = volume;
    this.rememberInput({ ...this.state.input, volume });
  }
  setListeningVolume(volume: number): void {
    this.endpoint.setListeningVolume(volume);
    this.update({ listeningVolume: volume }); saveRoomPreferences({ voiceListeningVolume: volume });
  }
  async configureInput(patch: Partial<Pick<RoomPreferences["voiceInput"], "deviceId" | "voiceProcessing">>): Promise<void> {
    const settings = { ...this.state.input, ...patch };
    if (this.microphone) await this.startMicrophone(settings);
    else this.rememberInput(settings);
  }
  async startMicrophone(settings = this.state.input): Promise<void> {
    const me = this.state.room?.members.find(member => member.peerId === this.state.peerId);
    if (this.closed || !this.state.connected || !this.state.room?.enabled || !me?.joined || this.capture || this.publishing) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.update({ error: "microphoneUnavailable" }); return;
    }
    const request: CaptureRequest = { settings: { ...settings } }; this.capture = request;
    this.update({ error: null }); this.refresh();
    let stream: MediaStream | undefined;
    try {
      // Resume during the gesture, before a device-permission prompt can consume
      // user activation. The capture owns this context until input takes it over.
      const context = request.context = new AudioContext();
      const resumed = context.resume().then(() => true, () => false);
      // Device permission must never block the serialized SDP/authority queue.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audioInputConstraints(settings.voiceProcessing),
        channelCount: 1, ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}) }, video: false });
      if (this.capture !== request) return;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") throw new DOMException("No live microphone", "NotFoundError");
      const input = request.input = new MicrophoneInput(stream, context, request.settings.volume, () => {
        if (this.endpoint.input === input || this.capture === request) this.stopMicrophone();
      });
      request.context = undefined;
      if (!await resumed) throw new Error("Microphone audio context could not start");
      if (this.capture !== request) return;
      const publication = this.state.room?.publications.find(pub => pub.peerId === this.state.peerId);
      if (publication && this.microphone) {
        this.endpoint.attach(publication.id, input); this.capture = null;
        this.rememberInput(request.settings); this.schedule(); return;
      }
      this.publishing = request;
      if (!this.command({ action: "publish" })) { this.publishing = null; this.cancelCapture(); }
    } catch (error) {
      if (this.capture === request) {
        this.cancelCapture(); this.publishing = null;
        const name = error instanceof Error ? error.name : "";
        this.update({ error: name === "NotAllowedError" ? "microphoneDenied" : name === "NotFoundError" ? "microphoneMissing" : "microphoneFailed" });
      }
    } finally {
      if (!request.input) stream?.getTracks().forEach(track => track.stop());
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
  deafen(deafened: boolean): void {
    this.endpoint.deafen(deafened);
    if (!deafened) this.resumeAudio();
    this.refresh();
  }
  resumeAudio(): void { void this.endpoint.resume(); }
  disconnected(): void {
    this.epoch++;
    this.cancelCapture(); this.publishing = null; this.endpoint.close();
    this.retiredPublications.clear(); this.scheduled = false;
    this.update({ connected: false, capturePending: false, microphone: false, autoplayBlocked: false });
  }
  close(): void { if (!this.closed) { this.disconnected(); this.closed = true; this.update({ room: null, peerId: "" }); } }
}
