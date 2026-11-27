import type { NativeCaptureSelection } from "../native/capture-selection";
import { CHANNEL_PROTOCOL, isIncompatibleProtocol, MAX_RELAY_CAPACITY, roomSummarySchema, watchByteSourceSchema, type WatchByteSource, type RoomSettings, type RoomSummary } from "./protocol";
import { unsupportedVideoFormatSchema, type UnsupportedVideoFormat, nativePageEventSchema, nativePageStateSchema, nativePageMediaChoiceSchema, nativePageIndexedCandidateSchema,
  nativePageMetadataReadSchema, nativePageMetadataResultSchema, nativePageIndexedSelectionSchema,
  nativePageResourceReadSchema, nativePageResourceResultSchema,
  nativePageMpdCandidateSchema, nativePageMpdCatalogSchema, nativePageMpdSelectionSchema,
  type NativePageMpdCandidate, type NativePageMpdCatalog, type NativePageMpdSelection,
  type NativePageCandidate, type NativePageMediaChoice, type NativePageIndexedCandidate, type NativePageIndexedSelection } from "../native/wire";
import type { AppPagePort, WatchMediaEvent, WatchMediaPatch, WatchMediaState } from "./watch-media";
import type { WatchByteResult } from "./watch-resource";
import { z } from "zod";
import { discoverLocalApp, type AppDiscovery, type AppDiscoveryOptions } from "../native/discovery";
import { nativeCaptureTargetSchema, nativeVideoCodecSchema, remoteControlStateSchema, remoteStopShortcutSchema, type NativeCaptureTarget, type EncodingExecution } from "../native/wire";
import { remoteShortcutKeySchema, type RemoteControlMode } from "../remote-control/protocol";
import type { QualityProfile } from "../media/quality";
import { activateNativePicker, androidAppIntent } from "../native/activation";
import { NativeRoomHosting } from "./hosting-api";
import type { CaptureDevice } from "../media/capture-devices";
import type { BrowserVideoCodecMode } from "../webrtc/video-codec";
import { debugEvent, debugOperation } from "../lib/debug";
import { nativeVoiceShortcutEventSchema, nativeVoiceShortcutsReportSchema, type NativeVoiceShortcutsReport } from "../native/wire";
import type { VoiceToggleAction, VoiceToggleShortcuts } from "./voice-shortcut-binding";

export class RoomSettingsRejected extends Error {}
const openRoomResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("opened"), room: roomSummarySchema }),
  z.object({ type: z.literal("settings_rejected"), reason: z.string().min(1) }),
]);

export const APP_PROTOCOL = 28;
const APP_REQUEST_BYTES = 256 * 1024;
const SOURCE_LIST_TIMEOUT_MS = 8_000;
const SHORTCUT_ACTION_MAX_AGE_MS = 1_000;
const identitySchema = z.object({ service: z.literal("piik-channel-app"), protocol: z.number().int().positive(), domainProtocol: z.number().int().positive().optional(), port: z.number().int().min(1).max(65535) });
const healthSchema = identitySchema.extend({ protocol: z.literal(APP_PROTOCOL), domainProtocol: z.literal(CHANNEL_PROTOCOL), token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  version: z.string().optional(), revision: z.string().optional(), packageTarget: z.string().optional(), updateSupported: z.boolean().optional(), pagePlayer: z.boolean().optional(),
  externalScreenInputAvailable: z.boolean().optional(), backgroundVoiceShortcuts: z.boolean().optional() });
type AppHealth = z.infer<typeof healthSchema>;
const measured = z.number().finite().nonnegative();
const nativeStreamMetricSchema = z.object({
  flowId: z.uuid(), publicationId: z.uuid(), selected: z.boolean(),
  direction: z.enum(["send", "receive"]), media: z.enum(["audio", "video"]),
  outputId: z.uuid().nullable(), mid: z.string(), rid: z.string().nullable(), codec: z.string().nullable(),
  sampleTimestampMs: measured, ageMs: measured, bytes: measured, packets: measured,
  rttMs: measured.nullable(), lossFraction: measured.max(1).nullable(), jitterMs: measured.nullable(),
});
export const nativeConnectionMetricsSchema = z.object({
  sessionId: z.uuid(), bindingId: z.uuid(), connections: z.array(z.object({
    pairId: z.uuid(), connectionId: z.uuid(), peerId: z.uuid(),
    sampleTimestampMs: measured.nullable(), ageMs: measured.nullable(),
    rttMs: measured.nullable(), bweBps: measured.nullable(), streams: z.array(nativeStreamMetricSchema),
  })),
});
/** SDK sample clocks belong to each Native connectionId, never Browser performance time. */
export type NativeConnectionMetrics = z.infer<typeof nativeConnectionMetricsSchema>;
const nativeRelayCapacitySchema = z.object({
  sessionId: z.uuid(),
  relayOverride: z.number().int().min(0).max(MAX_RELAY_CAPACITY).nullable(),
});
export type NativeRelayCapacity = z.infer<typeof nativeRelayCapacitySchema>;
// Capture lists expose only choices this Browser can select.
const captureDescriptions = nativeCaptureTargetSchema.options.map(target => target.strip());
const advertisedCodecs = z.array(z.string()).transform(codecs => codecs.flatMap(codec => {
  const known = nativeVideoCodecSchema.safeParse(codec);
  return known.success ? [known.data] : [];
}));
const captureSourcesSchema = z.object({ sources: z.array(z.looseObject({ kind: z.string() })).transform((sources, ctx) => {
    const selectable: NativeCaptureTarget[] = [];
    let invalid = false;
    for (const source of sources) {
      const schema = captureDescriptions.find(target => target.shape.kind.value === source.kind);
      if (!schema) continue;
      const result = schema.safeParse(source);
      if (result.success) selectable.push(result.data);
      else invalid = true;
    }
    if (invalid && !selectable.length) ctx.addIssue({ code: "custom", message: "invalid capture sources" });
    return selectable;
  }),
  codecs: advertisedCodecs,
  softwareEncodingCodecs: advertisedCodecs,
  videoAdaptation: z.boolean(),
  renderEndpoints: z.array(z.object({ id: z.string(), label: z.string() })).nullish(),
  processAudio: z.boolean(), processAudioExclusion: z.boolean(), systemAudio: z.boolean(), captureBorderControl: z.boolean(), activationURL: z.string().url().max(512).optional() });
export type NativeCaptureSources = z.infer<typeof captureSourcesSchema>;
export type NativeCaptureRequest = { publicationId: string; activationURL: string };
const preparedCaptureSchema = z.object({ captureId: z.uuid(), sessionId: z.uuid(), codec: z.string().min(1) });
export type PreparedNativeCapture = z.infer<typeof preparedCaptureSchema>;
const externalInputSchema = z.object({ endpoint: z.string().url(), token: z.string().min(1).max(256) });
const externalInputStateSchema = z.discriminatedUnion("state", [
  z.object({ type: z.literal("external_input_state"), publicationId: z.uuid(), state: z.enum(["prepared", "live"]), ...preparedCaptureSchema.shape, error: z.string().optional(), unsupportedVideoFormat: unsupportedVideoFormatSchema.optional() }),
  z.object({ type: z.literal("external_input_state"), publicationId: z.uuid(), state: z.enum(["waiting", "closed", "error"]), error: z.string().optional(), unsupportedVideoFormat: unsupportedVideoFormatSchema.optional() }),
]);
export type NativeExternalInputState = z.infer<typeof externalInputStateSchema>;
export type NativeExternalInput = z.infer<typeof externalInputSchema> & { state: NativeExternalInputState["state"]; captureId?: string; error?: string; unsupportedVideoFormat?: UnsupportedVideoFormat };
const previewSchema = z.string().max(23 + 4 * Math.ceil(64 * 1024 / 3))
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/).nullable();
const captureAudioFailureSchema = z.object({ type: z.literal("capture_audio_failed"), publicationId: z.uuid() });
const pickerReadySchema = z.object({ type: z.literal("picker_ready"), requestId: z.uuid(), captureId: z.uuid() });
const captureEndedSchema = z.object({ type: z.literal("capture_ended"), publicationId: z.uuid(), captureId: z.uuid(), failed: z.boolean() });
const microphoneSchema = z.object({ enabled: z.boolean(), deviceId: z.string(), volume: z.number().min(0).max(2) });
export type NativeSourceMicrophone = z.infer<typeof microphoneSchema>;
const audioStateSchema = z.object({ sourceAudio: z.boolean(), microphone: microphoneSchema });
const captureAudioStateSchema = z.object({ type: z.literal("capture_audio_state"), publicationId: z.uuid(), state: audioStateSchema });
const inputControlStateSchema = remoteControlStateSchema.extend({
  canSetStopShortcut: z.boolean(), stopShortcut: remoteShortcutKeySchema.nullable().optional(),
  // Omitted: fixed chord. Null: system-managed, unbound. Text: actual OS chord.
  stopShortcutLabel: z.string().min(1).max(512).nullable().optional(),
});
const stopShortcutSchema = remoteStopShortcutSchema.extend({ stopShortcutLabel: inputControlStateSchema.shape.stopShortcutLabel });
export type ChannelStopShortcut = z.infer<typeof stopShortcutSchema>;
export type ChannelRemoteControlState = z.infer<typeof inputControlStateSchema>;
const inputStateSchema = z.object({ type: z.literal("input_state"), publicationId: z.uuid(), state: inputControlStateSchema });
function isIncompatible(error: unknown): boolean {
  return error instanceof Error && isIncompatibleProtocol(error.message);
}
type AppCommand = { type: string; publicationId?: string; roomId?: string; [key: string]: unknown };

const nullResultCommands = new Set([
  "hello", "page_patch", "page_focus", "page_hide", "page_media_stop", "page_close", "cancel_preview",
  "capture_audio_settings", "capture_video_settings", "capture_paused", "capture_direct_limit", "capture_title",
  "commit_capture", "transfer_source", "cancel_external_input", "cancel_capture", "stop_capture", "input_policy", "input_decide",
]);

export type AppPageMediaSelection = string | NativePageMpdSelection | NativePageIndexedSelection;

export class AppPage implements AppPagePort {
  candidates: readonly NativePageCandidate[] = [];
  private lifetime = new AbortController();
  private listeners = new Map<(event: WatchMediaEvent) => void, string | undefined>();
  private sourceListeners = new Set<() => void>();
  constructor(readonly id: string, public url: string, private request: (command: AppCommand, signal: AbortSignal) => Promise<unknown>,
    private dispose: () => void, private changed: () => void) {}
  private command(type: string, values: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    return this.request({ type, pageId: this.id, ...values }, signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal);
  }
  async prepare(): Promise<void> { z.object({ pageId: z.literal(this.id) }).parse(await this.command("page_prepare", { url: this.url })); }
  private owners = 1;
  private ownerReleased = false;
  hold(): () => void {
    this.lifetime.signal.throwIfAborted();
    this.owners++;
    let released = false;
    return () => { if (!released) { released = true; this.releaseOwner(); } };
  }
  onSharePicker?: () => void;
  enableSharePicker(): void {
    if (typeof window !== "undefined" && window.piikMountWatchPage)
      window.ipc?.postMessage(JSON.stringify({ kind: "watchSharePicker", pageId: this.id, open: true }));
  }
  selectedCandidateId?: string;
  candidatePageURL(candidateId = this.selectedCandidateId): string | null {
    const candidate = this.candidates.find(value => value.id === candidateId);
    if (!candidate) throw new Error("watch_page_unavailable");
    return candidate.pageURL;
  }
  async select(candidateId: string, originalPage = false, resourceId?: string): Promise<void> {
    nativePageStateSchema.parse(await this.command("page_select", { candidateId, ...(resourceId && { resourceId }), ...(originalPage && { originalPage }) }));
    if (!this.candidates.some(candidate => candidate.id === candidateId)) throw new Error("watch_source_unavailable");
    this.selectedCandidateId = candidateId;
    this.changed();
  }
  async read(candidateId?: string): Promise<WatchMediaState> { return nativePageStateSchema.parse(await this.command("page_read", candidateId ? { candidateId } : {})); }
  async patch(patch: WatchMediaPatch): Promise<void> { await this.command("page_patch", { patch }); }
  async focus(): Promise<void> { await this.command("page_focus"); }
  async hide(): Promise<void> { await this.command("page_hide"); }
  async mediaSources(candidateId?: string, signal?: AbortSignal): Promise<{ choices: NativePageMediaChoice[]; indexedCandidates: NativePageIndexedCandidate[]; mpdCandidates: NativePageMpdCandidate[]; byteSource: WatchByteSource | null }> {
    return z.object({ choices: z.array(nativePageMediaChoiceSchema).max(32), indexedCandidates: z.array(nativePageIndexedCandidateSchema).max(32),
      mpdCandidates: z.array(nativePageMpdCandidateSchema).max(32), byteSource: watchByteSourceSchema.nullable() }).parse(await this.command("page_media_sources", { candidateId }, signal));
  }
  async readMediaMetadata(choiceId: string, offset: number, length: number, signal: AbortSignal, candidateId?: string): Promise<{ mimeType: string; totalSize: number; bytes: Uint8Array }> {
    const range = nativePageMetadataReadSchema.parse({ choiceId, offset, length });
    const value = await this.mediaRead("read_metadata", { ...range, candidateId }, signal);
    const result = nativePageMetadataResultSchema.parse(value);
    const bytes = Uint8Array.from(atob(result.bytesBase64), value => value.charCodeAt(0));
    if (bytes.length !== Math.min(length, Math.max(0, result.totalSize - offset))) throw new Error("invalid_app_response");
    return { mimeType: result.mimeType, totalSize: result.totalSize, bytes };
  }
  async prepareMedia(selection: AppPageMediaSelection, signal: AbortSignal, candidateId?: string): Promise<WatchByteSource> {
    const preparing = AbortSignal.any([this.lifetime.signal, signal]);
    preparing.throwIfAborted();
    const page = { pageId: this.id, candidateId };
    let command: AppCommand;
    let result: z.ZodType<WatchByteSource> = watchByteSourceSchema;
    if (typeof selection === "string") {
      command = { type: "page_media_prepare", ...page, choiceId: selection };
    } else if ("sourceId" in selection) {
      command = { type: "page_media_prepare_mpd", ...page, ...nativePageMpdSelectionSchema.parse(selection) };
      result = watchByteSourceSchema.extend({ format: z.literal("dash") });
    } else {
      command = { type: "page_media_prepare_indexed", ...page, ...nativePageIndexedSelectionSchema.parse(selection) };
      // AppLink appends a UUID request id; measure that complete envelope before sending.
      const bytes = new TextEncoder().encode(JSON.stringify({ ...command, id: "00000000-0000-4000-8000-000000000000" })).byteLength;
      if (bytes > APP_REQUEST_BYTES) throw new Error("watch_resource_limit");
      result = watchByteSourceSchema.extend({ format: z.literal("hls") });
    }
    const value = await this.request(command, preparing);
    preparing.throwIfAborted();
    return result.parse(value);
  }
  async inspectMpd(choiceId: string, signal: AbortSignal, candidateId?: string): Promise<NativePageMpdCatalog> {
    const choice = z.object({ choiceId: z.uuid() }).strict().parse({ choiceId });
    return nativePageMpdCatalogSchema.parse(await this.mediaRead("inspect_mpd", { ...choice, candidateId }, signal));
  }
  async readMediaResource(sourceId: string, resourceId: string, offset: number, length: number, signal: AbortSignal): Promise<WatchByteResult> {
    const range = nativePageResourceReadSchema.parse({ sourceId, resourceId, offset, length });
    const result = nativePageResourceResultSchema.parse(await this.mediaRead("read", range, signal));
    const bytes = Uint8Array.from(atob(result.bytesBase64), value => value.charCodeAt(0));
    if (bytes.length > length || !result.eof && bytes.length !== length
      || result.totalSize !== null && (offset > result.totalSize || bytes.length !== Math.min(length, result.totalSize - offset)))
      throw new Error("invalid_app_response");
    return { bytes, mimeType: result.mimeType, totalSize: result.totalSize, eof: result.eof };
  }
  private async mediaRead(action: "read" | "read_metadata" | "inspect_mpd", range: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const reading = AbortSignal.any([this.lifetime.signal, signal]);
    reading.throwIfAborted();
    const readId = crypto.randomUUID();
    const cancel = () => {
      if (!this.lifetime.signal.aborted)
        void this.command("page_media_resource", { action: "cancel", readId }).catch(() => {});
    };
    reading.addEventListener("abort", cancel, { once: true });
    try {
      const value = await this.request({ type: "page_media_resource", action, pageId: this.id, readId, ...range }, reading);
      reading.throwIfAborted();
      return value;
    } finally { reading.removeEventListener("abort", cancel); }
  }
  async stopMedia(candidateId?: string): Promise<void> { await this.command("page_media_stop", { candidateId }); }
  listen(changed: (event: WatchMediaEvent) => void, candidateId?: string): () => void { this.listeners.set(changed, candidateId); return () => this.listeners.delete(changed); }
  private emitMedia(event: WatchMediaEvent, candidateId?: string, selected = this.selectedCandidateId): void {
    for (const [listener, candidate] of this.listeners)
      if (event === "closed" || candidateId === (candidate ?? selected)) listener(event);
  }
  listenMediaSources(changed: () => void): () => void { this.sourceListeners.add(changed); return () => this.sourceListeners.delete(changed); }
  receive(event: z.infer<typeof nativePageEventSchema>): void {
    if (event.type === "page_share_requested") { this.onSharePicker?.(); return; }
    if (event.type === "page_closed") { this.retire(); return; }
    if (event.type === "page_media_changed") { for (const listener of this.sourceListeners) listener(); return; }
    if (event.type === "page_selection_lost") {
      this.candidates = this.candidates.filter(candidate => candidate.id !== event.candidateId);
      const selected = this.selectedCandidateId;
      if (selected === event.candidateId) this.selectedCandidateId = undefined;
      this.emitMedia("source-unavailable", event.candidateId, selected);
      if (selected === event.candidateId) {
        for (const listener of this.sourceListeners) listener();
      }
      this.changed(); return;
    }
    if (event.type === "page_candidates") {
      const removed = this.candidates.filter(candidate => !event.candidates.some(next => next.id === candidate.id));
      this.url = event.url; this.candidates = event.candidates;
      for (const candidate of removed) {
        const selected = this.selectedCandidateId;
        if (selected === candidate.id) this.selectedCandidateId = undefined;
        this.emitMedia("source-unavailable", candidate.id, selected);
      }
      this.changed(); return;
    }
    if (event.type === "page_blocked") this.emitMedia("blocked", event.candidateId);
    else if (event.event !== undefined) this.emitMedia(event.event, event.candidateId);
  }
  close(): void {
    if (!this.ownerReleased) { this.ownerReleased = true; this.releaseOwner(); }
  }
  private releaseOwner(): void {
    if (--this.owners === 0) this.retire();
  }
  retire(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("watch_page_closed"));
    this.dispose();
    this.emitMedia("closed");
    this.listeners.clear();
    this.sourceListeners.clear();
    this.changed();
  }
}

function identity(body: unknown, port: number): void {
  const value = identitySchema.extend({ service: z.enum(["piik-channel-app", "piik-client"]) }).parse(body);
  if (value.port !== port) throw new Error("invalid_app_response");
  if (value.service !== "piik-channel-app" || value.protocol !== APP_PROTOCOL || value.domainProtocol !== CHANNEL_PROTOCOL)
    throw new Error("incompatible_protocol");
}

export function discoverChannelAppHealth(options: AppDiscoveryOptions = {}): Promise<(AppHealth & { managementURL?: string }) | null> {
  return discoverLocalApp("health", (body, port) => {
    identity(body, port);
    return { ...healthSchema.parse(body), managementURL: `http://127.0.0.1:${port}/client` };
  }, options, isIncompatible);
}

const launcherAddressSchema = z.object({ connectURL: z.string().max(256) });
const windowNavigationSchema = z.object({ windowNavigation: z.boolean() });

function readLauncherAddress(body: unknown, port: number): URL {
  identity(body, port);
  const url = new URL(launcherAddressSchema.parse(body).connectURL);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== port ||
      url.username || url.password || url.pathname !== "/client" || url.search || url.hash) {
    throw new Error("invalid_app_response");
  }
  return url;
}

export const channelAppDiscovery: AppDiscovery = {
  health: discoverChannelAppHealth,
  navigation: signal => discoverLocalApp("connect-discovery", (body, port) => {
    const url = readLauncherAddress(body, port);
    const { windowNavigation } = windowNavigationSchema.parse(body);
    return { url: url.href, windowNavigation };
  }, { signal }, isIncompatible),
  connect: (options = {}) => discoverLocalApp("connect-discovery", (body, port) => {
    const url = readLauncherAddress(body, port);
    url.searchParams.set("site", window.location.origin);
    return url.href;
  }, options, isIncompatible),
  isIncompatible,
};

export interface BackgroundVoiceShortcuts {
  configure(bindings: VoiceToggleShortcuts | null): Promise<NativeVoiceShortcutsReport>;
  subscribe(listener: (action: VoiceToggleAction) => void): () => void;
}

/** Hosting survives this link; captures selected through it belong to this page. */
export class ChannelApp {
  private socket: WebSocket;
  private requests = new Map<string, { command: AppCommand; pickerURL?: string; resolve(value: unknown): void; reject(error: Error): void }>();
  readonly ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private readyWaiters = 0;
  private authenticated = false;
  private readonly lifetime = new AbortController();
  private captures = new Map<string, { id: string; kind: "capture" | "external" }>();
  private externalInputs = new Map<string, NativeExternalInput>();
  private audioStates = new Map<string, z.infer<typeof audioStateSchema>>();
  private prepared = new Map<string, { requestId: string } | "external">();
  private activationURL?: string;
  private renderEndpoints?: { id: string }[];
  private processAudioExclusion = false;
  private captureCodecs: NativeCaptureSources["codecs"] = [];
  private previewTail: Promise<void> = Promise.resolve();
  private pendingSources?: { reading: AbortController; result: Promise<NativeCaptureSources>; readers: number };
  private readonly roomHosting: NativeRoomHosting;
  private pages = new Map<string, AppPage>();
  readonly port: number;
  readonly pagePlayer: boolean;
  readonly externalScreenInputAvailable: boolean;
  readonly backgroundVoiceShortcuts?: BackgroundVoiceShortcuts;

  get connected(): boolean { return this.authenticated && this.socket.readyState === WebSocket.OPEN; }
  get screens(): ReadonlySet<string> { return new Set([...this.captures.keys(), ...this.externalInputs.keys()]); }
  hasCapture(publicationId: string): boolean { return this.captures.has(publicationId); }
  captureId(publicationId: string): string | undefined { return this.captures.get(publicationId)?.id; }
  externalInput(publicationId: string): NativeExternalInput | undefined { return this.externalInputs.get(publicationId); }
  supportsCaptureCodec(codec: NativeCaptureSources["codecs"][number]): boolean { return this.captureCodecs.includes(codec); }

  private screenPreparation(publicationId: string) {
    const pending = this.prepared.get(publicationId);
    return pending === "external" ? undefined : pending;
  }

  captureRequest(roomId: string): NativeCaptureRequest | undefined {
    if (!this.activationURL) return;
    let microphone: NativeCaptureRequest | undefined;
    for (const [requestId, { command, pickerURL }] of this.requests) {
      const { publicationId } = command;
      if (command.roomId !== roomId || !publicationId) continue;
      if (command.type === "prepare_capture" && pickerURL && this.screenPreparation(publicationId)?.requestId === requestId) {
        return { publicationId, activationURL: pickerURL };
      }
      if (command.type === "capture_microphone" && this.captures.get(publicationId)?.id === command.captureId) {
        // An off command can supersede a device change before its reply arrives.
        microphone = this.needsMicrophonePicker(publicationId, command.settings as NativeSourceMicrophone)
          ? { publicationId, activationURL: this.activationURL } : undefined;
      }
    }
    return microphone;
  }

  constructor(verifiedHealth: unknown, channelId: string, userId: string, credential: string, name: string,
    private readonly onClose: () => void, onCaptureState: (publicationId: string, error?: "capture_audio_failed" | "capture_failed") => void,
    onInputState: (publicationId: string, state: ChannelRemoteControlState) => void = () => {},
    private readonly onCaptureControlsChanged: (publicationId: string) => void = () => {},
    onExternalInput: (event: NativeExternalInputState) => void = () => {},
    canReceiveVoiceShortcut: () => boolean = () => false) {
    const health = healthSchema.parse(verifiedHealth);
    this.port = health.port;
    this.pagePlayer = health.pagePlayer === true;
    this.externalScreenInputAvailable = health.externalScreenInputAvailable === true;
    const voiceShortcutListeners = new Set<(action: VoiceToggleAction) => void>();
    if (health.backgroundVoiceShortcuts === true) this.backgroundVoiceShortcuts = {
      configure: async bindings => {
        if (!this.connected) throw new Error("app_disconnected");
        // The App rejects unknown fields; a held talk binding never reaches it.
        const fields = { microphone: bindings?.microphone ?? null, listening: bindings?.listening ?? null };
        return nativeVoiceShortcutsReportSchema.parse(await this.request({ type: "voice_shortcuts", enabled: bindings !== null, ...fields }));
      },
      subscribe: listener => {
        voiceShortcutListeners.add(listener);
        return () => { voiceShortcutListeners.delete(listener); };
      },
    };
    this.roomHosting = new NativeRoomHosting(`http://127.0.0.1:${health.port}/rooms/${channelId}/${userId}`,
      { Authorization: `Bearer ${health.token}`, "X-Piik-Credential": credential });
    const socket = this.socket = new WebSocket(`ws://127.0.0.1:${health.port}/rooms`, `piik-channel-rooms.${health.token}`);
    const lost = (reason: "socketclose" | "hello" | "schema" | "consumer", close?: CloseEvent) => {
      if (this.lifetime.signal.aborted) return;
      debugEvent("native", "control-closed", {
        reason, ...(close && { code: close.code, wasClean: close.wasClean }),
      });
      this.close(); onClose();
    };
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      socket.onopen = () => {
        void this.request({ type: "hello", channelId, userId, credential, name }).then(() => {
          if (this.lifetime.signal.aborted) return;
          this.authenticated = true;
          resolve();
        }, error => { reject(error); lost("hello"); });
      };
    });
    socket.onmessage = ({ data }) => {
      let failure: "schema" | "consumer" = "schema";
      try {
        const reply = JSON.parse(String(data)) as { type?: unknown; id: string; result?: unknown; error?: string };
        if (reply.type !== undefined && typeof reply.type !== "string") throw new TypeError("invalid_app_notification_type");
        if (nativePageEventSchema.options.some(schema => schema.shape.type.value === reply.type)) {
          const event = nativePageEventSchema.parse(reply);
          failure = "consumer";
          this.pages.get(event.pageId)?.receive(event);
          return;
        }
        if (reply.type === "picker_ready") {
          const { requestId, captureId } = pickerReadySchema.parse(reply);
          const request = this.requests.get(requestId);
          const publication = request?.command.publicationId;
          if (request?.command.type === "prepare_capture" && publication && this.screenPreparation(publication)?.requestId === requestId) {
            const intent = androidAppIntent(this.activationURL);
            if (intent?.startsWith("intent://media#Intent")) {
              request.pickerURL = intent.replace("media#Intent", `media/${captureId}#Intent`);
              this.onCaptureControlsChanged(publication);
            }
          }
          return;
        }
        if (reply.type === "input_state") {
          const event = inputStateSchema.parse(reply);
          failure = "consumer";
          if (this.captures.has(event.publicationId) || this.prepared.has(event.publicationId)) onInputState(event.publicationId, event.state);
          return;
        }
        if (reply.type === "voice_shortcut") {
          if (!this.backgroundVoiceShortcuts || !this.connected || !canReceiveVoiceShortcut()) return;
          const event = nativeVoiceShortcutEventSchema.safeParse(reply);
          if (!event.success) return;
          const timeDifference = Math.abs(Date.now() - event.data.activatedAtMs);
          if (timeDifference > SHORTCUT_ACTION_MAX_AGE_MS) return;
          const action = event.data.action === "toggle_microphone" ? "microphone" : "listening";
          try { voiceShortcutListeners.forEach(listener => listener(action)); }
          catch { debugEvent("native", "voice-shortcut-consumer-failed"); }
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
            this.onCaptureControlsChanged(publicationId);
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
              captureId: "captureId" in event ? event.captureId : undefined, error: "error" in event ? event.error : undefined,
              unsupportedVideoFormat: event.error === "external_video_format_unsupported" ? event.unsupportedVideoFormat : undefined });
            if (event.state === "live") this.captures.set(event.publicationId, { id: event.captureId, kind: "external" });
            else if (event.state === "prepared") this.prepared.set(event.publicationId, "external");
            else if (this.captures.get(event.publicationId)?.id === input.captureId) this.captures.delete(event.publicationId);
          }
          onExternalInput(event);
          return;
        }
        // Only untyped results and errors can settle a control request.
        if (reply.type !== undefined) return;
        const request = this.requests.get(reply.id);
        if (!request) return;
        this.requests.delete(reply.id);
        failure = "consumer";
        const success = "result" in reply;
        const failed = "error" in reply;
        if (success === failed
          || (failed && (typeof reply.error !== "string" || !reply.error))
          || (success && nullResultCommands.has(request.command.type) && reply.result !== null)) {
          request.reject(new Error("invalid_app_response"));
          return;
        }
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

  async relayCapacity(signal?: AbortSignal): Promise<NativeRelayCapacity> {
    signal?.throwIfAborted();
    if (!this.connected) throw new Error("app_disconnected");
    return nativeRelayCapacitySchema.parse(await this.request({ type: "relay_capacity", action: "read" }, crypto.randomUUID(), signal));
  }

  async setRelayCapacity(current: NativeRelayCapacity, capacity: number | null): Promise<NativeRelayCapacity> {
    if (!this.connected) throw new Error("app_disconnected");
    const { sessionId } = current;
    return nativeRelayCapacitySchema.parse(await this.request({ type: "relay_capacity", action: "set", sessionId, capacity }));
  }

  async waitReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.readyWaiters++;
    let abort: (() => void) | undefined;
    try {
      if (signal) await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void this.ready.then(resolve, reject);
      });
      else await this.ready;
      signal?.throwIfAborted();
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      this.readyWaiters--;
      // An in-flight admission remains useful while another caller is waiting.
      if (signal?.aborted && this.readyWaiters === 0 && !this.connected && !this.lifetime.signal.aborted) {
        this.close(new DOMException("App connection cancelled", "AbortError"));
        this.onClose();
      }
    }
  }

  async open(room: RoomSettings & { id: string }): Promise<RoomSummary> {
    await this.ready;
    const result = openRoomResultSchema.safeParse(await this.request({ type: "open", room }));
    if (!result.success) throw new Error("invalid_app_response");
    if (result.data.type === "settings_rejected") throw new RoomSettingsRejected(result.data.reason);
    if (result.data.room.id !== room.id) throw new Error("invalid_app_response");
    return result.data.room;
  }

  async localEndpoint(signal?: AbortSignal): Promise<string | null> {
    if (!this.connected) throw new Error("app_disconnected");
    return z.object({ sessionId: z.uuid().nullable() }).parse(
      await this.request({ type: "local_endpoint" }, undefined, signal)).sessionId;
  }

  async describeHosting(signal?: AbortSignal) {
    await this.ready;
    return this.roomHosting.describe(signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal);
  }
  async clearHostMedia() { await this.ready; return this.roomHosting.clearMedia(); }
  async snapshotRoom(roomId: string, signal?: AbortSignal): Promise<Blob> { await this.ready; return this.roomHosting.snapshot(roomId, signal); }
  async restoreRoom(archive: Blob): Promise<RoomSummary> { await this.ready; return this.roomHosting.restore(archive); }

  async sources(signal?: AbortSignal): Promise<NativeCaptureSources> {
    signal?.throwIfAborted();
    // Share the socket read while at least one caller still needs its result.
    if (!this.pendingSources) {
      const reading = new AbortController();
      const result = this.readSources(reading).finally(() => {
        if (this.pendingSources?.reading === reading) this.pendingSources = undefined;
      });
      this.pendingSources = { reading, result, readers: 0 };
    }
    const pending = this.pendingSources;
    pending.readers++;
    if (!signal) return pending.result;
    return new Promise<NativeCaptureSources>((resolve, reject) => {
      const abort = () => {
        if (--pending.readers === 0 && this.pendingSources === pending) {
          this.pendingSources = undefined;
          pending.reading.abort(new Error("request_cancelled"));
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async readSources(reading: AbortController): Promise<NativeCaptureSources> {
    await this.ready;
    // Bound this Web read; the system's capture permission prompt belongs to the App.
    const timer = setTimeout(() => reading.abort(new Error("app_request_timeout")), SOURCE_LIST_TIMEOUT_MS);
    const complete = debugOperation("native", "capture-targets");
    try {
      const result = await this.request({ type: "targets" }, undefined, reading.signal);
      reading.signal.throwIfAborted();
      const sources = captureSourcesSchema.parse(result);
      this.activationURL = sources.activationURL;
      this.renderEndpoints = sources.renderEndpoints ?? undefined;
      this.processAudioExclusion = sources.processAudioExclusion;
      this.captureCodecs = sources.codecs;
      complete("ready");
      return sources;
    } catch (error) {
      // OS errors and schema exceptions can contain local source descriptions.
      const code = error instanceof z.ZodError ? "invalid_response" : error instanceof Error ? error.message : "";
      const known = ["invalid_response", "app_request_timeout", "app_disconnected", "request_cancelled", "capture_targets_failed", "permission_denied"];
      complete(known.includes(code) ? code : "native_error");
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
    this.previewTail = preview.then(() => {});
    return preview;
  }

  async prepareCapture(publicationId: string, roomId: string, {
    target, audio, showCaptureBorder, excludeAudio, renderEndpointId, profile, codecMode, encodingExecution, gain = 1,
  }: NativeCaptureSelection & { profile: QualityProfile; codecMode: BrowserVideoCodecMode; encodingExecution: EncodingExecution; gain?: number }): Promise<PreparedNativeCapture> {
    const settings = { width: profile.resolution.width, height: profile.resolution.height,
      fps: profile.maxFramerate, bitrate: profile.maxBitrate, degradationPreference: profile.degradationPreference };
    if (!this.connected) throw new Error("app_disconnected");
    if (renderEndpointId !== undefined && (!audio || target.kind !== "display" || excludeAudio || !this.renderEndpoints?.some(device => device.id === renderEndpointId))) throw new Error("render endpoint unavailable");
    if (excludeAudio && (!audio || target.kind !== "display" || excludeAudio.kind !== "window" || !this.processAudioExclusion)) throw new Error("audio exclusion unavailable");
    const preparation = { requestId: crypto.randomUUID() };
    this.prepared.set(publicationId, preparation);
    let reply: unknown;
    try {
      reply = await this.request({ type: "prepare_capture", publicationId, roomId, target, audio, settings, codecMode, encodingExecution, showCaptureBorder,
        audioSettings: { bitrate: profile.maxAudioBitrate ?? 128_000, gain }, ...(excludeAudio ? { excludeAudio } : {}), renderEndpointId }, preparation.requestId);
    } catch (error) {
      // A rejected prepare owns no lease. Another source may still be preparing.
      if (this.prepared.get(publicationId) === preparation) this.prepared.delete(publicationId);
      throw error;
    }
    if (this.prepared.get(publicationId) !== preparation) throw new DOMException("Capture cancelled", "AbortError");
    const capture = preparedCaptureSchema.safeParse(reply);
    if (capture.success) return capture.data;
    await this.cancelCapture(publicationId).catch(() => {});
    throw capture.error;
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
      && (this.captures.has(publicationId) || !!this.screenPreparation(publicationId));
  }

  sourceMicrophone(publicationId: string): NativeSourceMicrophone | undefined {
    return this.captures.has(publicationId) ? this.audioStates.get(publicationId)?.microphone : undefined;
  }

  private needsMicrophonePicker(publicationId: string, next: NativeSourceMicrophone): boolean {
    const current = this.sourceMicrophone(publicationId);
    return next.enabled && (!current?.enabled || current.deviceId !== next.deviceId);
  }

  hasSourceAudio(publicationId: string): boolean {
    return this.captures.has(publicationId) && !!this.audioStates.get(publicationId)?.sourceAudio;
  }

  async sourceMicrophones(signal?: AbortSignal): Promise<CaptureDevice[]> {
    await this.ready;
    return z.array(z.object({ id: z.string(), label: z.string() })).parse(await this.request({ type: "microphones" }, undefined, signal));
  }

  async setSourceMicrophone(publicationId: string, roomId: string, settings: NativeSourceMicrophone): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    const pending = this.request({ type: "capture_microphone", publicationId, captureId, roomId, settings });
    if (this.needsMicrophonePicker(publicationId, settings)) activateNativePicker(this.activationURL);
    const applied = microphoneSchema.parse(await pending);
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture cancelled", "AbortError");
    this.audioStates.set(publicationId, { sourceAudio: this.audioStates.get(publicationId)?.sourceAudio ?? false, microphone: applied });
    this.onCaptureControlsChanged(publicationId);
  }

  async setCapturePaused(publicationId: string, paused: boolean): Promise<void> {
    const captureId = this.captures.get(publicationId)?.id;
    if (!captureId) throw new Error("capture_unavailable");
    await this.request({ type: "capture_paused", publicationId, captureId, paused });
    if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture cancelled", "AbortError");
  }

  async setCaptureDirectLimit(publicationId: string, limit: number | null): Promise<void> {
    if (!this.screens.has(publicationId)) throw new Error("capture_unavailable");
    await this.request({ type: "capture_direct_limit", publicationId, limit });
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

  async cancelExternalInput(publicationId: string): Promise<void> {
    const candidate = this.externalInputs.get(publicationId);
    if (!candidate || candidate.state === "live") return;
    if (this.prepared.get(publicationId) === "external") this.prepared.delete(publicationId);
    if (this.captures.get(publicationId)?.kind === "external")
      this.externalInputs.set(publicationId, { ...candidate, captureId: undefined });
    else this.externalInputs.delete(publicationId);
    if (this.connected) await this.request({ type: "cancel_external_input", publicationId });
  }

  async cancelCapture(publicationId: string): Promise<void> {
    const prepared = this.prepared.get(publicationId);
    this.prepared.delete(publicationId);
    const microphone = [...this.requests.values()].some(({ command }) => command.type === "capture_microphone" && command.publicationId === publicationId);
    if (!prepared && !microphone) return;
    if (this.connected) await this.request({ type: prepared === "external" ? "cancel_external_input" : "cancel_capture", publicationId });
  }

  async stopCapture(publicationId: string, successorWatchId?: string): Promise<void> {
    if (successorWatchId) {
      const captureId = this.captures.get(publicationId)?.id;
      if (!captureId) throw new Error("capture_unavailable");
      await this.request({ type: "stop_capture", publicationId, captureId, successorWatchId });
      if (this.captures.get(publicationId)?.id !== captureId) throw new DOMException("Capture replaced", "AbortError");
      this.captures.delete(publicationId);
      if (!this.prepared.has(publicationId)) this.externalInputs.delete(publicationId);
      this.audioStates.delete(publicationId);
      return;
    }
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

  close(error = new Error("app_disconnected")): void {
    this.lifetime.abort(error);
    this.authenticated = false;
    this.captures.clear();
    this.externalInputs.clear();
    this.audioStates.clear();
    this.prepared.clear();
    this.socket.onclose = null;
    this.socket.close();
    for (const page of this.pages.values()) page.retire();
    this.rejectReady(error);
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
