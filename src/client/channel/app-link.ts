import type { RoomSummary } from "./protocol";
import { z } from "zod";
import { appApprovalURL, discoverLocalApp, type AppDiscovery, type AppDiscoveryOptions } from "../native/discovery";
import { nativeCaptureTargetSchema, remoteControlStateSchema, remoteStopShortcutSchema, type NativeCaptureTarget } from "../native/wire";
import { remoteShortcutKeySchema, type RemoteControlMode } from "../remote-control/protocol";
import type { QualityProfile } from "../media/quality";
import { activateNativePicker } from "../native/activation";
import { NativeRoomHosting } from "./hosting-api";
import type { CaptureDevice } from "../media/capture-devices";

const identitySchema = z.object({ service: z.literal("piik-channel-app"), protocol: z.number().int().positive(), port: z.number().int().min(1).max(65535) });
const healthSchema = identitySchema.extend({ protocol: z.literal(1), token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) });
type AppHealth = z.infer<typeof healthSchema>;
const captureSourcesSchema = z.object({ sources: z.array(nativeCaptureTargetSchema),
  processAudio: z.boolean(), processAudioExclusion: z.boolean().default(false), systemAudio: z.boolean(), activationURL: z.string().url().max(512).optional() }).strict();
export type NativeCaptureSources = z.infer<typeof captureSourcesSchema>;
export type NativeCaptureRequest = { publicationId: string; activationURL: string };
const preparedCaptureSchema = z.object({ captureId: z.uuid(), sessionId: z.uuid() }).strict();
export type PreparedNativeCapture = z.infer<typeof preparedCaptureSchema>;
const previewSchema = z.string().max(23 + 4 * Math.ceil(64 * 1024 / 3))
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/).nullable();
const captureAudioFailureSchema = z.object({ type: z.literal("capture_audio_failed"), publicationId: z.uuid() }).strict();
const microphoneSchema = z.object({ enabled: z.boolean(), deviceId: z.string(), volume: z.number().min(0).max(2) }).strict();
export type NativeSourceMicrophone = z.infer<typeof microphoneSchema>;
const microphoneStateSchema = z.object({ type: z.literal("capture_microphone_state"), publicationId: z.uuid(), state: microphoneSchema }).strict();
const inputControlStateSchema = remoteControlStateSchema.extend({
  canSetStopShortcut: z.boolean(), stopShortcut: remoteShortcutKeySchema.nullable().optional(),
  // Omitted: fixed chord. Null: system-managed, unbound. Text: actual OS chord.
  stopShortcutLabel: z.string().min(1).max(512).nullable().optional(),
});
const stopShortcutSchema = remoteStopShortcutSchema.extend({ stopShortcutLabel: inputControlStateSchema.shape.stopShortcutLabel });
export type ChannelStopShortcut = z.infer<typeof stopShortcutSchema>;
export type ChannelRemoteControlState = z.infer<typeof inputControlStateSchema>;
const inputStateSchema = z.object({ type: z.literal("input_state"), publicationId: z.uuid(), state: inputControlStateSchema }).strict();
class AppCompatibilityError extends Error {}
type AppCommand = { type: string; publicationId?: string; roomId?: string; [key: string]: unknown };

function identity(body: unknown, port: number): void {
  const value = identitySchema.parse(body);
  if (value.port !== port) throw new Error("invalid_app_response");
  if (value.protocol !== 1) throw new AppCompatibilityError("App room protocol is incompatible");
}

export function discoverChannelAppHealth(options: AppDiscoveryOptions = {}): Promise<AppHealth | null> {
  return discoverLocalApp("health", (body, port) => {
    identity(body, port);
    return healthSchema.parse(body);
  }, options, error => error instanceof AppCompatibilityError);
}

export const channelAppDiscovery: AppDiscovery = {
  health: discoverChannelAppHealth,
  connect: signal => discoverLocalApp("connect-discovery", (body, port) => {
    identity(body, port);
    return appApprovalURL(identitySchema.extend({ connectURL: z.string().url().max(256) }).parse(body).connectURL);
  }, { signal }, error => error instanceof AppCompatibilityError),
  isIncompatible: error => error instanceof AppCompatibilityError,
};

/** Hosting survives this link; captures selected through it belong to this page. */
export class ChannelApp {
  private socket: WebSocket;
  private requests = new Map<string, { command: AppCommand; resolve(value: unknown): void; reject(error: Error): void }>();
  readonly ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout>;
  private authenticated = false;
  private captures = new Map<string, string>();
  private microphones = new Map<string, NativeSourceMicrophone>();
  private prepared = new Set<string>();
  private activationURL?: string;
  private processAudioExclusion = false;
  private previewTail: Promise<unknown> = Promise.resolve();
  private readonly roomHosting: NativeRoomHosting;

  get connected(): boolean { return this.authenticated && this.socket.readyState === WebSocket.OPEN; }
  get screens(): ReadonlySet<string> { return new Set(this.captures.keys()); }

  captureRequest(roomId: string): NativeCaptureRequest | undefined {
    if (!this.activationURL) return;
    for (const { command } of this.requests.values()) {
      if (command.roomId === roomId && command.publicationId &&
          ((command.type === "prepare_capture" && this.prepared.has(command.publicationId)) ||
           (command.type === "capture_microphone" && this.captures.has(command.publicationId)))) {
        return { publicationId: command.publicationId, activationURL: this.activationURL };
      }
    }
  }

  constructor(health: AppHealth, channelId: string, userId: string, credential: string, name: string,
    onClose: () => void, onAudioFailure: (publicationId: string) => void,
    onInputState: (publicationId: string, state: ChannelRemoteControlState) => void = () => {},
    private readonly onMicrophoneState: (publicationId: string) => void = () => {}) {
    this.roomHosting = new NativeRoomHosting(`http://127.0.0.1:${health.port}/rooms/${channelId}/${userId}`,
      { Authorization: `Bearer ${health.token}`, "X-Piik-Credential": credential });
    const socket = this.socket = new WebSocket(`ws://127.0.0.1:${health.port}/rooms`, `piik-channel-rooms.${health.token}`);
    const lost = () => { this.close(); onClose(); };
    this.timer = setTimeout(lost, 10000);
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      socket.onopen = () => {
        void this.request({ type: "hello", channelId, userId, credential, name }).then(() => {
          clearTimeout(this.timer);
          this.authenticated = true;
          resolve();
        }, error => { reject(error); lost(); });
      };
    });
    socket.onmessage = ({ data }) => {
      try {
        const reply = JSON.parse(String(data)) as { type?: string; id: string; result?: unknown; error?: string };
        if (reply.type === "input_state") {
          const event = inputStateSchema.parse(reply);
          if (this.captures.has(event.publicationId) || this.prepared.has(event.publicationId)) onInputState(event.publicationId, event.state);
          return;
        }
        if (reply.type === "capture_audio_failed") {
          const { publicationId } = captureAudioFailureSchema.parse(reply);
          if (this.captures.has(publicationId) || this.prepared.has(publicationId)) onAudioFailure(publicationId);
          return;
        }
        if (reply.type === "capture_microphone_state") {
          const { publicationId, state } = microphoneStateSchema.parse(reply);
          if (this.captures.has(publicationId) || this.prepared.has(publicationId)) {
            this.microphones.set(publicationId, state);
            onMicrophoneState(publicationId);
          }
          return;
        }
        const request = this.requests.get(reply.id);
        if (!request) return;
        this.requests.delete(reply.id);
        if (reply.error) request.reject(reply.error === "input_authorization_cancelled" || reply.error === "capture_cancelled"
          ? new DOMException(reply.error, "AbortError") : new Error(reply.error));
        else request.resolve(reply.result);
      } catch { lost(); }
    };
    socket.onclose = lost;
    socket.onerror = () => { /* Close retires the connection and its requests. */ };
  }

  private request<T>(command: AppCommand, id: string = crypto.randomUUID()): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("app_disconnected"));
    return new Promise((resolve, reject) => {
      this.requests.set(id, { command, resolve: value => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ ...command, id }));
    });
  }

  async open(policy: string): Promise<RoomSummary> {
    await this.ready;
    return this.request({ type: "open", policy });
  }

  async describeHosting() { await this.ready; return this.roomHosting.describe(); }
  async snapshotRoom(roomId: string): Promise<Blob> { await this.ready; return this.roomHosting.snapshot(roomId); }
  async restoreRoom(archive: Blob): Promise<RoomSummary> { await this.ready; return this.roomHosting.restore(archive); }

  async sources(): Promise<NativeCaptureSources> {
    await this.ready;
    const sources = captureSourcesSchema.parse(await this.request({ type: "targets" }));
    this.activationURL = sources.activationURL;
    this.processAudioExclusion = sources.processAudioExclusion;
    return sources;
  }

  preview(target: NativeCaptureTarget, signal?: AbortSignal): Promise<string | null> {
    const preview = this.previewTail.then(async () => {
      if (!this.connected || signal?.aborted || target.kind === "picker") return null;
      const id = crypto.randomUUID();
      const pending = this.request({ type: "preview", target }, id);
      const cancel = () => { void this.request({ type: "cancel_preview", requestId: id }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = previewSchema.parse(await pending);
        return signal?.aborted ? null : result;
      } catch { return null; }
      finally { signal?.removeEventListener("abort", cancel); }
    });
    // Wait for the App's stop/join acknowledgement even after local cancellation.
    this.previewTail = preview;
    return preview;
  }

  async prepareCapture(publicationId: string, roomId: string, target: NativeCaptureTarget, audio: boolean, profile: QualityProfile, excludeAudio?: NativeCaptureTarget, gain = 1): Promise<PreparedNativeCapture> {
    const settings = { width: profile.resolution.width, height: profile.resolution.height,
      fps: profile.maxFramerate, bitrate: profile.maxBitrate };
    if (!this.connected) throw new Error("app_disconnected");
    if (excludeAudio && (!audio || target.kind !== "display" || excludeAudio.kind !== "window" || !this.processAudioExclusion)) throw new Error("audio exclusion unavailable");
    this.prepared.add(publicationId);
    try {
      const pending = this.request({ type: "prepare_capture", publicationId, roomId, target, audio, settings,
        audioSettings: { bitrate: profile.maxAudioBitrate ?? 128_000, gain }, ...(excludeAudio ? { excludeAudio } : {}) });
      activateNativePicker(this.activationURL);
      const capture = preparedCaptureSchema.parse(await pending);
      if (!this.prepared.has(publicationId)) throw new DOMException("Capture cancelled", "AbortError");
      return capture;
    } catch (error) {
      await this.cancelCapture(publicationId).catch(() => {});
      throw error;
    }
  }

  async setSourceAudio(publicationId: string, bitrate: number, gain: number): Promise<void> {
    const captureId = this.captures.get(publicationId);
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "capture_audio_settings", publicationId, captureId, settings: { bitrate, gain } });
    if (this.captures.get(publicationId) !== captureId) throw new DOMException("Capture cancelled", "AbortError");
  }

  sourceMicrophone(publicationId: string): NativeSourceMicrophone | undefined {
    return this.captures.has(publicationId) ? this.microphones.get(publicationId) : undefined;
  }

  async sourceMicrophones(): Promise<CaptureDevice[]> {
    await this.ready;
    return z.array(z.object({ id: z.string(), label: z.string() }).strict()).parse(await this.request({ type: "microphones" }));
  }

  async setSourceMicrophone(publicationId: string, roomId: string, settings: NativeSourceMicrophone): Promise<void> {
    const captureId = this.captures.get(publicationId);
    if (!captureId) throw new Error("capture_unavailable");
    const pending = this.request({ type: "capture_microphone", publicationId, captureId, roomId, settings });
    if (settings.enabled && !this.sourceMicrophone(publicationId)?.enabled) activateNativePicker(this.activationURL);
    const applied = microphoneSchema.parse(await pending);
    if (this.captures.get(publicationId) !== captureId) throw new DOMException("Capture cancelled", "AbortError");
    this.microphones.set(publicationId, applied);
    this.onMicrophoneState(publicationId);
  }

  async setCapturePaused(publicationId: string, paused: boolean): Promise<void> {
    const captureId = this.captures.get(publicationId);
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "capture_paused", publicationId, captureId, paused });
    if (this.captures.get(publicationId) !== captureId) throw new DOMException("Capture cancelled", "AbortError");
  }

  async setCaptureQuality(publicationId: string, profile: QualityProfile): Promise<void> {
    const captureId = this.captures.get(publicationId);
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "capture_video_settings", publicationId, captureId, settings: {
      width: profile.resolution.width, height: profile.resolution.height, fps: profile.maxFramerate, bitrate: profile.maxBitrate,
    } });
    if (this.captures.get(publicationId) !== captureId) throw new DOMException("Capture cancelled", "AbortError");
  }

  async commitCapture(publicationId: string, captureId: string): Promise<void> {
    await this.request({ type: "commit_capture", publicationId, captureId });
    if (!this.prepared.delete(publicationId)) throw new DOMException("Capture cancelled", "AbortError");
    this.captures.set(publicationId, captureId);
  }

  async transferSource(publicationId: string, toSessionId: string): Promise<void> {
    const captureId = this.captures.get(publicationId);
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "transfer_source", publicationId, captureId, toSessionId });
  }

  async cancelCapture(publicationId: string): Promise<void> {
    const prepared = this.prepared.delete(publicationId);
    const microphone = [...this.requests.values()].some(({ command }) => command.type === "capture_microphone" && command.publicationId === publicationId);
    if (!prepared && !microphone) return;
    if (this.connected) await this.request({ type: "cancel_capture", publicationId });
  }

  async stopCapture(publicationId: string): Promise<void> {
    const active = this.captures.delete(publicationId);
    this.microphones.delete(publicationId);
    const prepared = this.prepared.delete(publicationId);
    if (!active && !prepared) return;
    if (this.connected) await this.request({ type: "stop_capture", publicationId });
  }

  async inputPolicy(publicationId: string, mode: RemoteControlMode, password?: string): Promise<void> {
    await this.request({ type: "input_policy", publicationId, mode, ...(password !== undefined ? { password } : {}) });
  }

  async inputDecide(publicationId: string, controllerSessionId: string, intent: string, allow: boolean): Promise<void> {
    await this.request({ type: "input_decide", publicationId, controllerSessionId, intent, allow });
  }

  async inputSimultaneous(publicationId: string, mode: RemoteControlMode, simultaneous: boolean): Promise<void> {
    await this.request({ type: "input_policy", publicationId, mode, simultaneous });
  }

  async inputShortcut(publicationId: string, key: number): Promise<ChannelStopShortcut> {
    const captureId = this.captures.get(publicationId);
    if (!captureId) throw new Error("capture_unavailable");
    const result = await this.request({ type: "input_shortcut", publicationId, key });
    if (this.captures.get(publicationId) !== captureId) throw new DOMException("Capture replaced", "AbortError");
    return stopShortcutSchema.parse(result);
  }

  stopCaptures(): void {
    for (const id of new Set([...this.captures.keys(), ...this.prepared])) void this.stopCapture(id).catch(() => {});
  }

  close(): void {
    this.authenticated = false;
    this.captures.clear();
    this.microphones.clear();
    this.prepared.clear();
    clearTimeout(this.timer);
    this.socket.onclose = null;
    this.socket.close();
    const error = new Error("app_disconnected");
    this.rejectReady(error);
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
