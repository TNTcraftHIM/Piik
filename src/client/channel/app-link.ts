import { CHANNEL_PROTOCOL, watchByteSourceSchema, type WatchByteSource, type RoomSummary } from "./protocol";
import { nativePageEventSchema, nativePageStateSchema, nativePageMediaChoiceSchema, nativePageIndexedCandidateSchema,
  nativePageMetadataReadSchema, nativePageMetadataResultSchema, nativePageIndexedSelectionSchema,
  nativePageResourceReadSchema, nativePageResourceResultSchema,
  type NativePageCandidate, type NativePageMediaChoice, type NativePageIndexedCandidate, type NativePageIndexedSelection } from "../native/wire";
import type { AppPagePort, WatchMediaEvent, WatchMediaPatch, WatchMediaState } from "./watch-media";
import type { WatchByteResult } from "./watch-resource";
import { z } from "zod";
import { appApprovalURL, appManagementURL, discoverLocalApp, type AppDiscovery, type AppDiscoveryOptions } from "../native/discovery";
import { nativeCaptureTargetSchema, nativeVideoCodecSchema, remoteControlStateSchema, remoteStopShortcutSchema, type NativeCaptureTarget, type EncodingExecution } from "../native/wire";
import { remoteShortcutKeySchema, type RemoteControlMode } from "../remote-control/protocol";
import type { QualityProfile } from "../media/quality";
import { activateNativePicker } from "../native/activation";
import { NativeRoomHosting } from "./hosting-api";
import type { CaptureDevice } from "../media/capture-devices";
import type { BrowserVideoCodecMode } from "../webrtc/video-codec";
import { debugEvent } from "../lib/debug";

export const APP_PROTOCOL = 14;
const APP_REQUEST_BYTES = 256 * 1024;
const identitySchema = z.object({ service: z.literal("piik-channel-app"), protocol: z.number().int().positive(), domainProtocol: z.number().int().positive().optional(), port: z.number().int().min(1).max(65535) });
const healthSchema = identitySchema.extend({ protocol: z.literal(APP_PROTOCOL), domainProtocol: z.literal(CHANNEL_PROTOCOL), token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  version: z.string().optional(), revision: z.string().optional(), packageTarget: z.string().optional(), updateSupported: z.boolean().optional(), pagePlayer: z.literal(true).optional() });
type AppHealth = z.infer<typeof healthSchema>;
const measured = z.number().finite().nonnegative();
const nativeStreamMetricSchema = z.object({
  flowId: z.uuid(), publicationId: z.uuid(), selected: z.boolean(),
  direction: z.enum(["send", "receive"]), media: z.enum(["audio", "video"]),
  outputId: z.uuid().nullable(), mid: z.string(), rid: z.string().nullable(), codec: z.string().nullable(),
  sampleTimestampMs: measured, ageMs: measured, bytes: measured, packets: measured,
  rttMs: measured.nullable(), lossFraction: measured.max(1).nullable(), jitterMs: measured.nullable(),
}).strict();
export const nativeConnectionMetricsSchema = z.object({
  sessionId: z.uuid(), bindingId: z.uuid(), connections: z.array(z.object({
    pairId: z.uuid(), connectionId: z.uuid(), peerId: z.uuid(),
    sampleTimestampMs: measured.nullable(), ageMs: measured.nullable(),
    rttMs: measured.nullable(), bweBps: measured.nullable(), streams: z.array(nativeStreamMetricSchema),
  }).strict()),
}).strict();
/** SDK sample clocks belong to each Native connectionId, never Browser performance time. */
export type NativeConnectionMetrics = z.infer<typeof nativeConnectionMetricsSchema>;
const captureSourcesSchema = z.object({ sources: z.array(nativeCaptureTargetSchema),
  codecs: z.array(nativeVideoCodecSchema),
  softwareEncodingCodecs: z.array(nativeVideoCodecSchema),
  videoAdaptation: z.boolean(),
  externalInput: z.boolean(),
  processAudio: z.boolean(), processAudioExclusion: z.boolean(), systemAudio: z.boolean(), captureBorderControl: z.boolean(), activationURL: z.string().url().max(512).optional() }).strict();
export type NativeCaptureSources = z.infer<typeof captureSourcesSchema>;
export type NativeCaptureRequest = { publicationId: string; activationURL: string };
const preparedCaptureSchema = z.object({ captureId: z.uuid(), sessionId: z.uuid(), codec: nativeVideoCodecSchema }).strict();
export type PreparedNativeCapture = z.infer<typeof preparedCaptureSchema>;
const externalInputSchema = z.object({ endpoint: z.string().url(), token: z.string().min(1).max(256) }).strict();
const externalInputStateSchema = z.discriminatedUnion("state", [
  z.object({ type: z.literal("external_input_state"), publicationId: z.uuid(), state: z.enum(["prepared", "live"]), ...preparedCaptureSchema.shape, error: z.string().optional() }).strict(),
  z.object({ type: z.literal("external_input_state"), publicationId: z.uuid(), state: z.enum(["waiting", "closed", "error"]), error: z.string().optional() }).strict(),
]);
export type NativeExternalInputState = z.infer<typeof externalInputStateSchema>;
export type NativeExternalInput = z.infer<typeof externalInputSchema> & { state: NativeExternalInputState["state"]; captureId?: string; error?: string };
const previewSchema = z.string().max(23 + 4 * Math.ceil(64 * 1024 / 3))
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/).nullable();
const captureAudioFailureSchema = z.object({ type: z.literal("capture_audio_failed"), publicationId: z.uuid() }).strict();
const captureEndedSchema = z.object({ type: z.literal("capture_ended"), publicationId: z.uuid(), captureId: z.uuid(), failed: z.boolean() }).strict();
const microphoneSchema = z.object({ enabled: z.boolean(), deviceId: z.string(), volume: z.number().min(0).max(2) }).strict();
export type NativeSourceMicrophone = z.infer<typeof microphoneSchema>;
const audioStateSchema = z.object({ sourceAudio: z.boolean(), microphone: microphoneSchema }).strict();
const captureAudioStateSchema = z.object({ type: z.literal("capture_audio_state"), publicationId: z.uuid(), state: audioStateSchema }).strict();
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

export class AppPage implements AppPagePort {
  candidates: readonly NativePageCandidate[] = [];
  private lifetime = new AbortController();
  private listeners = new Set<(event: WatchMediaEvent) => void>();
  private sourceListeners = new Set<() => void>();
  constructor(readonly id: string, public url: string, private request: (command: AppCommand, signal: AbortSignal) => Promise<unknown>,
    private dispose: () => void, private changed: () => void) {}
  private command(type: string, values: Record<string, unknown> = {}): Promise<unknown> {
    return this.request({ type, pageId: this.id, ...values }, this.lifetime.signal);
  }
  async prepare(): Promise<void> { z.object({ pageId: z.literal(this.id) }).strict().parse(await this.command("page_prepare", { url: this.url })); }
  async select(candidateId: string): Promise<void> { nativePageStateSchema.parse(await this.command("page_select", { candidateId })); }
  async read(): Promise<WatchMediaState> { return nativePageStateSchema.parse(await this.command("page_read")); }
  async patch(patch: WatchMediaPatch): Promise<void> { await this.command("page_patch", { patch }); }
  async focus(): Promise<void> { await this.command("page_focus"); }
  async mediaSources(): Promise<{ choices: NativePageMediaChoice[]; indexedCandidates: NativePageIndexedCandidate[]; byteSource: WatchByteSource | null }> {
    return z.object({ choices: z.array(nativePageMediaChoiceSchema).max(32), indexedCandidates: z.array(nativePageIndexedCandidateSchema).max(32),
      byteSource: watchByteSourceSchema.nullable() }).strict().parse(await this.command("page_media_sources"));
  }
  async readMediaMetadata(choiceId: string, offset: number, length: number, signal: AbortSignal): Promise<{ mimeType: string; totalSize: number; bytes: Uint8Array }> {
    const reading = AbortSignal.any([this.lifetime.signal, signal]);
    reading.throwIfAborted();
    const range = nativePageMetadataReadSchema.parse({ choiceId, offset, length });
    const value = await this.request({ type: "page_media_read_metadata", pageId: this.id, ...range }, reading);
    reading.throwIfAborted();
    const result = nativePageMetadataResultSchema.parse(value);
    const bytes = Uint8Array.from(atob(result.bytesBase64), value => value.charCodeAt(0));
    if (bytes.length !== Math.min(length, Math.max(0, result.totalSize - offset))) throw new Error("invalid_app_response");
    return { mimeType: result.mimeType, totalSize: result.totalSize, bytes };
  }
  async prepareMedia(choiceId: string): Promise<WatchByteSource> { return watchByteSourceSchema.parse(await this.command("page_media_prepare", { choiceId })); }
  async readMediaResource(sourceId: string, resourceId: string, offset: number, length: number, signal: AbortSignal): Promise<WatchByteResult> {
    const reading = AbortSignal.any([this.lifetime.signal, signal]);
    reading.throwIfAborted();
    const range = nativePageResourceReadSchema.parse({ sourceId, resourceId, offset, length });
    const readId = crypto.randomUUID();
    const cancel = () => {
      if (!this.lifetime.signal.aborted)
        void this.command("page_media_resource", { action: "cancel", sourceId, readId }).catch(() => {});
    };
    reading.addEventListener("abort", cancel, { once: true });
    try {
      const value = await this.request({ type: "page_media_resource", action: "read", pageId: this.id, readId, ...range }, reading);
      reading.throwIfAborted();
      const result = nativePageResourceResultSchema.parse(value);
      const bytes = Uint8Array.from(atob(result.bytesBase64), value => value.charCodeAt(0));
      if (bytes.length > length || !result.eof && bytes.length !== length
        || result.totalSize !== null && (offset > result.totalSize || bytes.length !== Math.min(length, result.totalSize - offset)))
        throw new Error("invalid_app_response");
      return { bytes, mimeType: result.mimeType, totalSize: result.totalSize, eof: result.eof };
    } finally { reading.removeEventListener("abort", cancel); }
  }
  async prepareIndexedMedia(selection: NativePageIndexedSelection, signal: AbortSignal): Promise<WatchByteSource> {
    const preparing = AbortSignal.any([this.lifetime.signal, signal]);
    preparing.throwIfAborted();
    const command = { type: "page_media_prepare_indexed", pageId: this.id, ...nativePageIndexedSelectionSchema.parse(selection) };
    // AppLink appends a UUID request id; measure that complete envelope before sending.
    const bytes = new TextEncoder().encode(JSON.stringify({ ...command, id: "00000000-0000-4000-8000-000000000000" })).byteLength;
    if (bytes > APP_REQUEST_BYTES) throw new Error("watch_resource_limit");
    const value = await this.request(command, preparing);
    preparing.throwIfAborted();
    return watchByteSourceSchema.extend({ format: z.literal("hls") }).parse(value);
  }
  async stopMedia(): Promise<void> { await this.command("page_media_stop"); }
  listen(changed: (event: WatchMediaEvent) => void): () => void { this.listeners.add(changed); return () => this.listeners.delete(changed); }
  listenMediaSources(changed: () => void): () => void { this.sourceListeners.add(changed); return () => this.sourceListeners.delete(changed); }
  receive(event: z.infer<typeof nativePageEventSchema>): void {
    if (event.type === "page_closed") { this.close(); return; }
    if (event.type === "page_media_changed") { for (const listener of this.sourceListeners) listener(); return; }
    if (event.type === "page_candidates") { this.url = event.url; this.candidates = event.candidates; this.changed(); return; }
    for (const listener of this.listeners) listener(event.type === "page_blocked" ? "blocked" : event.event);
  }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("watch_page_closed"));
    this.dispose();
    for (const listener of this.listeners) listener("closed");
    this.listeners.clear();
    this.sourceListeners.clear();
    this.changed();
  }
}

function identity(body: unknown, port: number): void {
  const value = identitySchema.extend({ service: z.enum(["piik-channel-app", "piik-client"]) }).parse(body);
  if (value.port !== port) throw new Error("invalid_app_response");
  if (value.service !== "piik-channel-app" || value.protocol !== APP_PROTOCOL || value.domainProtocol !== CHANNEL_PROTOCOL)
    throw new AppCompatibilityError("App room protocol is incompatible");
}

export function discoverChannelAppHealth(options: AppDiscoveryOptions = {}): Promise<(AppHealth & { managementURL?: string }) | null> {
  return discoverLocalApp("health", (body, port) => {
    identity(body, port);
    return { ...healthSchema.parse(body), managementURL: `http://127.0.0.1:${port}/client` };
  }, options, error => error instanceof AppCompatibilityError);
}

export const channelAppDiscovery: AppDiscovery = {
  health: discoverChannelAppHealth,
  navigation: signal => discoverLocalApp("connect-discovery", (body, port) => {
    identity(body, port);
    const result = identitySchema.extend({ connectURL: z.string().url().max(256), windowNavigation: z.boolean() }).parse(body);
    const url = appManagementURL(result.connectURL);
    if (Number(url.port) !== port) throw new Error("invalid_app_response");
    return { url: url.href, windowNavigation: result.windowNavigation };
  }, { signal }, error => error instanceof AppCompatibilityError),
  connect: (options = {}) => discoverLocalApp("connect-discovery", (body, port) => {
    identity(body, port);
    return appApprovalURL(identitySchema.extend({ connectURL: z.string().url().max(256) }).parse(body).connectURL);
  }, options, error => error instanceof AppCompatibilityError),
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
  private readonly lifetime = new AbortController();
  private captures = new Map<string, { id: string; kind: "capture" | "external" }>();
  private externalInputs = new Map<string, NativeExternalInput>();
  private audioStates = new Map<string, z.infer<typeof audioStateSchema>>();
  private prepared = new Map<string, "capture" | "external">();
  private activationURL?: string;
  private processAudioExclusion = false;
  private captureCodecs: NativeCaptureSources["codecs"] = [];
  private previewTail: Promise<unknown> = Promise.resolve();
  private readonly roomHosting: NativeRoomHosting;
  private pages = new Map<string, AppPage>();
  readonly pagePlayer: boolean;

  get connected(): boolean { return this.authenticated && this.socket.readyState === WebSocket.OPEN; }
  get screens(): ReadonlySet<string> { return new Set([...this.captures.keys(), ...this.externalInputs.keys()]); }
  hasCapture(publicationId: string): boolean { return this.captures.has(publicationId); }
  externalInput(publicationId: string): NativeExternalInput | undefined { return this.externalInputs.get(publicationId); }
  supportsCaptureCodec(codec: NativeCaptureSources["codecs"][number]): boolean { return this.captureCodecs.includes(codec); }

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
    onClose: () => void, onCaptureState: (publicationId: string, error?: "capture_audio_failed" | "capture_failed") => void,
    onInputState: (publicationId: string, state: ChannelRemoteControlState) => void = () => {},
    private readonly onAudioState: (publicationId: string) => void = () => {},
    onExternalInput: (event: NativeExternalInputState) => void = () => {}) {
    this.pagePlayer = health.pagePlayer === true;
    this.roomHosting = new NativeRoomHosting(`http://127.0.0.1:${health.port}/rooms/${channelId}/${userId}`,
      { Authorization: `Bearer ${health.token}`, "X-Piik-Credential": credential });
    const socket = this.socket = new WebSocket(`ws://127.0.0.1:${health.port}/rooms`, `piik-channel-rooms.${health.token}`);
    const lost = (reason: "socketclose" | "hello" | "schema" | "consumer", close?: CloseEvent, timedOut = false) => {
      if (!this.lifetime.signal.aborted) debugEvent("native", "control-closed", {
        reason, ...(close && { code: close.code, wasClean: close.wasClean }), ...(reason === "hello" && { timedOut }),
      });
      this.close(); onClose();
    };
    this.timer = setTimeout(() => lost("hello", undefined, true), 10000);
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      socket.onopen = () => {
        void this.request({ type: "hello", channelId, userId, credential, name }).then(() => {
          clearTimeout(this.timer);
          this.authenticated = true;
          resolve();
        }, error => { reject(error); lost("hello"); });
      };
    });
    socket.onmessage = ({ data }) => {
      let failure: "schema" | "consumer" = "schema";
      try {
        const reply = JSON.parse(String(data)) as { type?: string; id: string; result?: unknown; error?: string };
        if (reply.type?.startsWith("page_")) {
          const event = nativePageEventSchema.parse(reply);
          failure = "consumer";
          this.pages.get(event.pageId)?.receive(event);
          return;
        }
        if (reply.type === "input_state") {
          const event = inputStateSchema.parse(reply);
          failure = "consumer";
          if (this.captures.has(event.publicationId) || this.prepared.has(event.publicationId)) onInputState(event.publicationId, event.state);
          return;
        }
        if (reply.type === "capture_audio_failed") {
          const { publicationId } = captureAudioFailureSchema.parse(reply);
          failure = "consumer";
          if (this.captures.has(publicationId) || this.prepared.has(publicationId)) onCaptureState(publicationId, "capture_audio_failed");
          return;
        }
        if (reply.type === "capture_ended") {
          const { publicationId, captureId, failed } = captureEndedSchema.parse(reply);
          failure = "consumer";
          if (this.captures.get(publicationId)?.id === captureId) {
            this.captures.delete(publicationId);
            this.audioStates.delete(publicationId);
            onCaptureState(publicationId, failed ? "capture_failed" : undefined);
          }
          return;
        }
        if (reply.type === "capture_audio_state") {
          const { publicationId, state } = captureAudioStateSchema.parse(reply);
          failure = "consumer";
          if (this.captures.has(publicationId) || this.prepared.has(publicationId)) {
            this.audioStates.set(publicationId, state);
            onAudioState(publicationId);
          }
          return;
        }
        if (reply.type === "external_input_state") {
          const event = externalInputStateSchema.parse(reply);
          failure = "consumer";
          const input = this.externalInputs.get(event.publicationId);
          if (!input) return;
          if ((event.state === "waiting" || event.state === "closed" || event.state === "error")
              && this.prepared.get(event.publicationId) === "external") this.prepared.delete(event.publicationId);
          if (event.state === "closed") {
            this.externalInputs.delete(event.publicationId);
            if (this.captures.get(event.publicationId)?.id === input.captureId) this.captures.delete(event.publicationId);
          }
          else {
            this.externalInputs.set(event.publicationId, { ...input, state: event.state,
              captureId: "captureId" in event ? event.captureId : undefined, error: "error" in event ? event.error : undefined });
            if (event.state === "live") this.captures.set(event.publicationId, { id: event.captureId, kind: "external" });
            else if (event.state === "prepared") this.prepared.set(event.publicationId, "external");
            else if (this.captures.get(event.publicationId)?.id === input.captureId) this.captures.delete(event.publicationId);
          }
          onExternalInput(event);
          return;
        }
        const request = this.requests.get(reply.id);
        if (!request) return;
        this.requests.delete(reply.id);
        failure = "consumer";
        if (reply.error) request.reject(reply.error === "input_authorization_cancelled" || reply.error === "capture_cancelled"
          ? new DOMException(reply.error, "AbortError") : new Error(reply.error));
        else request.resolve(reply.result);
      } catch { lost(failure); }
    };
    socket.onclose = event => lost("socketclose", event);
    socket.onerror = () => { /* Close retires the connection and its requests. */ };
  }

  private request<T>(command: AppCommand, id: string = crypto.randomUUID(), signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("app_disconnected"));
    const abort = () => { this.requests.get(id)?.reject(signal!.reason); this.requests.delete(id); };
    return new Promise<T>((resolve, reject) => {
      this.requests.set(id, { command, resolve: value => resolve(value as T), reject });
      signal?.addEventListener("abort", abort, { once: true });
      this.socket.send(JSON.stringify({ ...command, id }));
    }).finally(() => { signal?.removeEventListener("abort", abort); });
  }

  async preparePage(url: string, changed: () => void, signal: AbortSignal): Promise<AppPage> {
    signal.throwIfAborted();
    if (!this.pagePlayer) throw new Error("watch_page_unavailable");
    const pageId = crypto.randomUUID();
    const page = new AppPage(pageId, url, (command, lifetime) => this.request(command, undefined, lifetime), () => {
      this.pages.delete(pageId);
      void this.request({ type: "page_close", pageId }).catch(() => {});
    }, changed);
    this.pages.set(pageId, page);
    const cancel = () => page.close();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await page.prepare();
      signal.throwIfAborted();
      return page;
    } catch (error) { page.close(); throw error; }
    finally { signal.removeEventListener("abort", cancel); }
  }

  async connectionMetrics(roomId: string, publicationId?: string, signal?: AbortSignal): Promise<NativeConnectionMetrics> {
    signal?.throwIfAborted();
    if (!this.connected) throw new Error("app_disconnected");
    return nativeConnectionMetricsSchema.parse(await this.request({ type: "connection_metrics", roomId, publicationId }, crypto.randomUUID(), signal));
  }

  async open(policy: string): Promise<RoomSummary> {
    await this.ready;
    return this.request({ type: "open", policy });
  }

  async describeHosting(signal?: AbortSignal) {
    await this.ready;
    return this.roomHosting.describe(signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal);
  }
  async snapshotRoom(roomId: string): Promise<Blob> { await this.ready; return this.roomHosting.snapshot(roomId); }
  async restoreRoom(archive: Blob): Promise<RoomSummary> { await this.ready; return this.roomHosting.restore(archive); }

  async sources(): Promise<NativeCaptureSources> {
    await this.ready;
    const sources = captureSourcesSchema.parse(await this.request({ type: "targets" }));
    this.activationURL = sources.activationURL;
    this.processAudioExclusion = sources.processAudioExclusion;
    this.captureCodecs = sources.codecs;
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

  async prepareCapture(publicationId: string, roomId: string, target: NativeCaptureTarget, audio: boolean, profile: QualityProfile, codecMode: BrowserVideoCodecMode, encodingExecution: EncodingExecution, excludeAudio?: NativeCaptureTarget, gain = 1, showCaptureBorder = false): Promise<PreparedNativeCapture> {
    const settings = { width: profile.resolution.width, height: profile.resolution.height,
      fps: profile.maxFramerate, bitrate: profile.maxBitrate, degradationPreference: profile.degradationPreference };
    if (!this.connected) throw new Error("app_disconnected");
    if (excludeAudio && (!audio || target.kind !== "display" || excludeAudio.kind !== "window" || !this.processAudioExclusion)) throw new Error("audio exclusion unavailable");
    this.prepared.set(publicationId, "capture");
    try {
      const pending = this.request({ type: "prepare_capture", publicationId, roomId, target, audio, settings, codecMode, encodingExecution, showCaptureBorder,
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

  async prepareExternalInput(publicationId: string, roomId: string): Promise<void> {
    this.prepared.set(publicationId, "external");
    try {
      const input = externalInputSchema.parse(await this.request({ type: "prepare_external_input", publicationId, roomId }));
      if (!this.prepared.delete(publicationId)) throw new DOMException("Input cancelled", "AbortError");
      this.externalInputs.set(publicationId, { ...input, state: "waiting" });
    } catch (error) { this.prepared.delete(publicationId); throw error; }
  }

  async setSourceAudio(publicationId: string, bitrate: number, gain: number): Promise<void> {
    if (!this.hasSourceAudioControl(publicationId)) throw new Error("capture_unavailable");
    await this.request({ type: "capture_audio_settings", publicationId, settings: { bitrate, gain } });
    if (!this.hasSourceAudioControl(publicationId)) throw new DOMException("Capture cancelled", "AbortError");
  }

  hasSourceAudioControl(publicationId: string): boolean {
    return this.connected && this.captures.get(publicationId)?.kind !== "external"
      && (this.captures.has(publicationId) || this.prepared.get(publicationId) === "capture");
  }

  sourceMicrophone(publicationId: string): NativeSourceMicrophone | undefined {
    return this.captures.has(publicationId) ? this.audioStates.get(publicationId)?.microphone : undefined;
  }

  hasSourceAudio(publicationId: string): boolean {
    return this.captures.has(publicationId) && !!this.audioStates.get(publicationId)?.sourceAudio;
  }

  async sourceMicrophones(): Promise<CaptureDevice[]> {
    await this.ready;
    return z.array(z.object({ id: z.string(), label: z.string() }).strict()).parse(await this.request({ type: "microphones" }));
  }

  async setSourceMicrophone(publicationId: string, roomId: string, settings: NativeSourceMicrophone): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    const pending = this.request({ type: "capture_microphone", publicationId, captureId, roomId, settings });
    if (settings.enabled && !this.sourceMicrophone(publicationId)?.enabled) activateNativePicker(this.activationURL);
    const applied = microphoneSchema.parse(await pending);
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture cancelled", "AbortError");
    this.audioStates.set(publicationId, { sourceAudio: this.audioStates.get(publicationId)?.sourceAudio ?? false, microphone: applied });
    this.onAudioState(publicationId);
  }

  async setCapturePaused(publicationId: string, paused: boolean): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "capture_paused", publicationId, captureId, paused });
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture cancelled", "AbortError");
  }

  async setCaptureTitle(publicationId: string, title: string | null): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "capture_title", publicationId, captureId, title });
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture replaced", "AbortError");
  }

  async setCaptureQuality(publicationId: string, profile: QualityProfile): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "capture_video_settings", publicationId, captureId, settings: {
      width: profile.resolution.width, height: profile.resolution.height, fps: profile.maxFramerate, bitrate: profile.maxBitrate,
      degradationPreference: profile.degradationPreference,
    } });
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture cancelled", "AbortError");
  }

  async commitCapture(publicationId: string, captureId: string): Promise<void> {
    await this.request({ type: "commit_capture", publicationId, captureId });
    if (!this.prepared.delete(publicationId)) throw new DOMException("Capture cancelled", "AbortError");
    const kind = this.externalInputs.get(publicationId)?.captureId === captureId ? "external" : "capture";
    this.captures.set(publicationId, { id: captureId, kind });
    if (kind === "external") this.audioStates.delete(publicationId);
  }

  async transferSource(publicationId: string, toSessionId: string): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
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
    const external = this.externalInputs.delete(publicationId);
    this.audioStates.delete(publicationId);
    const prepared = this.prepared.delete(publicationId);
    if (!active && !prepared && !external) return;
    if (this.connected) await this.request({ type: "stop_capture", publicationId });
  }

  async inputPolicy(publicationId: string, policy: { mode: RemoteControlMode; password?: string; simultaneous?: boolean }): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "input_policy", publicationId, captureId, ...policy });
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture replaced", "AbortError");
  }

  async inputDecide(publicationId: string, controllerSessionId: string, intent: string, allow: boolean): Promise<void> {
    await this.request({ type: "input_decide", publicationId, controllerSessionId, intent, allow });
  }

  async inputShortcut(publicationId: string, key: number): Promise<ChannelStopShortcut> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    const result = await this.request({ type: "input_shortcut", publicationId, key });
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture replaced", "AbortError");
    return stopShortcutSchema.parse(result);
  }

  stopCaptures(): void {
    for (const id of new Set([...this.screens, ...this.prepared.keys()])) void this.stopCapture(id).catch(() => {});
  }

  close(): void {
    this.lifetime.abort();
    this.authenticated = false;
    this.captures.clear();
    this.externalInputs.clear();
    this.audioStates.clear();
    this.prepared.clear();
    clearTimeout(this.timer);
    this.socket.onclose = null;
    this.socket.close();
    for (const page of this.pages.values()) page.close();
    const error = new Error("app_disconnected");
    this.rejectReady(error);
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
