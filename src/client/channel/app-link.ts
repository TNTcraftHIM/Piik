import type { RoomSummary } from "./protocol";
import { z } from "zod";
import { appApprovalURL, discoverLocalApp, type AppDiscovery, type AppDiscoveryOptions } from "../native/discovery";
import { nativeCaptureTargetSchema, remoteControlStateSchema, remoteStopShortcutSchema, type NativeCaptureTarget, type RemoteStopShortcut } from "../native/wire";
import { remoteShortcutKeySchema, type RemoteControlMode } from "../remote-control/protocol";
import { activateNativePicker } from "../native/activation";

const identitySchema = z.object({ service: z.literal("piik-channel-app"), protocol: z.number().int().positive(), port: z.number().int().min(1).max(65535) });
const healthSchema = identitySchema.extend({ protocol: z.literal(1), token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) });
type AppHealth = z.infer<typeof healthSchema>;
const captureSourcesSchema = z.object({ sources: z.array(nativeCaptureTargetSchema),
  processAudio: z.boolean(), systemAudio: z.boolean(), activationURL: z.string().url().max(512).optional() }).strict();
export type NativeCaptureSources = z.infer<typeof captureSourcesSchema>;
export type NativeCaptureRequest = { publicationId: string; activationURL: string };
const captureAudioFailureSchema = z.object({ type: z.literal("capture_audio_failed"), publicationId: z.uuid() }).strict();
const inputControlStateSchema = remoteControlStateSchema.extend({
  canSetStopShortcut: z.boolean(), stopShortcut: remoteShortcutKeySchema.nullable().optional(),
});
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
  private captures = new Set<string>();
  private activationURL?: string;

  get connected(): boolean { return this.authenticated && this.socket.readyState === WebSocket.OPEN; }
  get screens(): ReadonlySet<string> { return this.captures; }

  captureRequest(roomId: string): NativeCaptureRequest | undefined {
    if (!this.activationURL) return;
    for (const { command } of this.requests.values()) {
      if (command.type === "start_capture" && command.roomId === roomId && command.publicationId && this.captures.has(command.publicationId)) {
        return { publicationId: command.publicationId, activationURL: this.activationURL };
      }
    }
  }

  constructor(health: AppHealth, channelId: string, userId: string, credential: string, name: string,
    onClose: () => void, onAudioFailure: (publicationId: string) => void,
    onInputState: (publicationId: string, state: ChannelRemoteControlState) => void = () => {}) {
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
          if (this.captures.has(event.publicationId)) onInputState(event.publicationId, event.state);
          return;
        }
        if (reply.type === "capture_audio_failed") {
          const { publicationId } = captureAudioFailureSchema.parse(reply);
          if (this.captures.has(publicationId)) onAudioFailure(publicationId);
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

  private request<T>(command: AppCommand): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("app_disconnected"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.requests.set(id, { command, resolve: value => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ ...command, id }));
    });
  }

  async open(policy: string): Promise<RoomSummary> {
    await this.ready;
    return this.request({ type: "open", policy });
  }

  async sources(): Promise<NativeCaptureSources> {
    await this.ready;
    const sources = captureSourcesSchema.parse(await this.request({ type: "targets" }));
    this.activationURL = sources.activationURL;
    return sources;
  }

  async startCapture(publicationId: string, roomId: string, target: NativeCaptureTarget, audio = false): Promise<void> {
    if (!this.connected) throw new Error("app_disconnected");
    this.captures.add(publicationId);
    try {
      const pending = this.request({ type: "start_capture", publicationId, roomId, target, audio });
      activateNativePicker(this.activationURL);
      await pending;
      if (!this.captures.has(publicationId)) throw new DOMException("Capture cancelled", "AbortError");
    } catch (error) {
      await this.stopCapture(publicationId).catch(() => {});
      throw error;
    }
  }

  async stopCapture(publicationId: string): Promise<void> {
    if (!this.captures.delete(publicationId)) return;
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

  async inputShortcut(publicationId: string, key: number): Promise<RemoteStopShortcut> {
    return remoteStopShortcutSchema.parse(await this.request({ type: "input_shortcut", publicationId, key }));
  }

  stopCaptures(): void {
    for (const id of this.captures) void this.stopCapture(id).catch(() => {});
  }

  close(): void {
    this.authenticated = false;
    this.captures.clear();
    clearTimeout(this.timer);
    this.socket.onclose = null;
    this.socket.close();
    const error = new Error("app_disconnected");
    this.rejectReady(error);
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
