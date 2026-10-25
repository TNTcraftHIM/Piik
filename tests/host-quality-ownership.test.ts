import { stopUserMediaTrack } from "../src/client/media/user-media";
import { HostAudio } from "../src/client/media/host-audio";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  QUALITY_PROFILES, qualitySettingsEqual, qualitySettingsLabel, qualityResolutionEqual,
  screenAudioBitrate, videoQualitySettingsEqual, supportsCaptureProfile, videoCaptureLimits, MAX_AUDIO_SEND_BITRATE,
  type QualitySettings,
} from "../src/client/media/quality";
import { NativeSenderPeer } from "../src/client/native/native-sender-peer";
import { HostPeer } from "../src/client/webrtc/host-peer";
import { NativeCompatibilityError, NativeRequestError, type NativeClient } from "../src/client/native/client";
import { NativeClientConnection } from "../src/client/native/client-connection";
import { nativeAppActivationURL } from "../src/client/native/activation";
import { nativeCaptureTargetKey } from "../src/client/native/capture-selection";
import { nativeAppDetected, type NativeSourceList } from "../src/client/components/living/CaptureSourcePicker";
import { NativeMediaBridgeError } from "../src/client/native/media-bridge";
import { InputRoute } from "../src/client/remote-control/input-route";
import { reconcileBoundedMediaChildren } from "../src/client/webrtc/media-assignment";
import { debugError, debugEvent, debugOperation } from "../src/client/lib/debug";
import { ApiError } from "../src/client/lib/api";
import { hostActionErrorKey, hostServerErrorKey, hostFailureCode, isCapturePermissionFailure } from "../src/client/pages/host-page-notices";
import { say, setCopy } from "../src/client/ui/copy";

// Exercise the actual page owners without mounting capture hardware or a Browser.
const source = ts.createSourceFile("HostPage.tsx", readFileSync(
  new URL("../src/client/pages/HostPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = new Set(["changeQuality", "commitQuality", "rememberQuality", "loadAppQualityPreference", "handleSignalMessage",
  "switchSource", "watchCaptureEnd", "switchNativeSource", "switchToNativeSource", "createBrowserAudio", "retireNativeSenderPeers", "finishSourceSwitch", "replaceBrowserStream", "recoverBrowserFanout", "disposeNativeShare",
  "acquireNativeClient", "requestSharing", "startNativeShare", "startBrowserNativeIngress",
  "connectNativeClient", "handleNativeClientClosed", "releaseUnusedNativeClient", "closeCaptureSourcePicker",
  "openCaptureSourcePicker", "startBrowserShareFromPicker", "startNativeShareFromPicker",
  "startSharing", "connectRoomSignal", "createReplacementRoom", "beginRoomMutation", "finishRoomMutation", "setCaptureError", "toggleSharingPause",
  "startPeer", "reconcileHostChildren", "setNotice", "setNoticeKey", "setStatusNotice", "setNoticeError", "setNoticeErrorKey", "endSharing", "disposeResources", "hostTerminationKey", "copyRoomLink", "isCurrentRoomAuthority",
  "handleRoomAccessFailure", "replaceCurrentRoom", "forgetRoom", "endRoomSession", "readableError", "confirmNativePermission"]);

const functions: string[] = [];
let noticeRendering = "";
const nativePermissionRendering: string[] = [];
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && owners.has(node.name.text)) {
    functions.push(node.getText(source));
    owners.delete(node.name.text);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "noticeText") {
    noticeRendering = node.initializer!.getText(source);
  }
  if (ts.isVariableDeclaration(node) && ["nativePermissionIntent", "confirmNativeCapture"].includes(node.name.getText(source))) {
    nativePermissionRendering.push(`const ${node.getText(source)};`);
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (owners.size || !noticeRendering) throw new Error(`Missing Host owner: ${[...owners].join(", ")}`);
const executable = ts.transpileModule(functions.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const original = QUALITY_PROFILES["1080p30"];
const lower = QUALITY_PROFILES["720p30"];
function ref<T>(current: T) { return { current }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
function ingress() {
  return { updateProfile: vi.fn(async (_profile: QualitySettings) => true), dispose: vi.fn() };
}

function fixture(launchedByClient = true, nativeConnected = true) {
  let physical: QualitySettings = original;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const bridge = { start: vi.fn(async (_audio: boolean) => stream), dispose: vi.fn(), getRemoteInput: () => null };
  const peer = { updateCaptureProfile: vi.fn(async () => true), updateProfile: vi.fn(async () => true),
    isConnected: vi.fn(() => true) };
  const client = { updateShare: vi.fn(async () => undefined), replaceShareSource: vi.fn(async () => undefined),
    startShare: vi.fn(async (): Promise<{ audio: boolean; codec: "h264" }> => ({ audio: false, codec: "h264" })),
    onEvent: vi.fn((_listener: (event: unknown) => void) => () => undefined),
    close: vi.fn(), onClose: vi.fn((_listener: () => void) => () => undefined),
    health: { nativeMedia: { video: true, hardwareH264: true, softwareVP8: true } },
    captureOptions: vi.fn(async () => []), sources: vi.fn(async () => []),
    stopReceive: vi.fn(async () => undefined), stopShare: vi.fn(async () => undefined) };
  const route = { updateProfile: vi.fn(async () => true), resyncAuthoritative: vi.fn(async (): Promise<void> => undefined) };
  let context: ReturnType<typeof createContext>;
  const state = {
    debugError, debugEvent, debugOperation, NativeCompatibilityError, NativeRequestError, NativeMediaBridgeError, isCapturePermissionFailure, hostFailureCode, hostActionErrorKey, hostServerErrorKey, DOMException, AbortController,
    launchedByClient, isClientActivated: vi.fn(() => launchedByClient), hostRoomSessionAvailable: false,
    NativeClient: { connect: vi.fn(async (_options?: { signal: AbortSignal }): Promise<typeof client | null> => null) },
    setJoiningRoom: vi.fn(), startSharing: vi.fn(), openCaptureSourcePicker: vi.fn(),
    videoCodecRef: ref({ primary: "h264" }),
    videoCodecModeRef: ref("h264"), MAX_ENDPOINT_MEDIA_CHILDREN: 2,
    sourcePickerReturnRef: ref<{ id: string; restore: boolean } | null>(null),
    nativeSourceRequestRef: ref<object | null>(null), nativeSourcePathRef: ref<unknown>(null),
    setNativeSources: vi.fn(), setShowCaptureBorder: vi.fn(), defaultNativeCapturePath: () => ({ adapterIndex: 0, encoderIndex: 0 }),
    roomMutationRef: ref<object | null>(null), setRoomMutation: vi.fn(),
    generationRef: ref(0), shareGenerationRef: ref<string | null>("share"),
    serverShareGenerationRef: ref<string | null>("share"), createOpaqueId: () => "share",
    setCopiedRoomLink: vi.fn(), setPhase: vi.fn(), roomInitializationRef: ref(Promise.resolve()), roomRef: ref(null),

    createRoom: vi.fn(async () => { throw new Error("must not create an empty room"); }),
    readPreferredRoomId: () => null, disposeResources: vi.fn(), ApiError,
    NativeMediaBridge: vi.fn(function (_shareId: string, _client: unknown, _onFailed: () => void) { return bridge; }), manualVideoCodecPreference: vi.fn(),
    phase: "live", qualitySettingsRef: ref<QualitySettings>(original), advancedQualityRef: ref<QualitySettings>(original),
    nativeActive: false, switchingSource: false, sourceSwitchState: null, shareVolume: { level: 1, muted: false },
    nativeAppActivationURL: (action: unknown) => nativeAppActivationURL(action, "Android"),
    window: { location: { assign: vi.fn() } },
    qualityChangeRef: ref<object | null>(null), pendingQualityChangeRef: ref<QualitySettings | null>(null),
    appQualityPreferenceRef: ref<{ save: (quality: QualitySettings) => void } | null>(null),
    qualityPreferenceEditedRef: ref(false), pendingAppQualityPreferenceRef: ref<QualitySettings | null>(null),
    activeGenerationRef: ref<number | null>(1), streamRef: ref<typeof stream | null>(stream), sourceSwitchRef: ref<object | null>(null),
    nativeSourceAudioRef: ref<boolean | undefined>(undefined), audioAvailableRef: ref(false), setMicrophoneEnabled: vi.fn(),
    nativeSourceSelectionRef: ref<Record<string, unknown> | null>(null), nativeCaptureTargetKey, nativeAppDetected,
    nativeModeRef: ref(false), nativeConnection: new NativeClientConnection(signal => context.connectNativeClient(signal),
      () => context.handleNativeClientClosed()), nativeShareGenerationRef: ref<string | null>("share"),
    hostAudioRef: ref<{ sourceStream: MediaStream } | null>(null),
    shareVolumeChangeRef: ref<object | null>(null), setShareVolume: vi.fn(),
    sharingPauseOperationRef: ref<object | null>(null),
    nativeMediaIngressRef: ref<ReturnType<typeof ingress> | null>(null), nativeMediaBridgeRef: ref(null),
    nativeInputRoute: new InputRoute(() => {}),
    nativeEventCleanupRef: ref(null), nativeShareCleanupRef: ref(Promise.resolve()),
    peersRef: ref(new Map([["viewer", peer]])), hostProvisionalChildRef: ref(null), hostSfuRouteRef: ref(route),
    signalRef: ref({ setHostQualitySettings: vi.fn(), setAudioAvailable: vi.fn(), setCoPlayGrants: vi.fn(), send: vi.fn() }),
    setQualitySettings: vi.fn(), setAdvancedQuality: vi.fn(), setChangingQuality: vi.fn(), savePreferredQuality: vi.fn(),
    setNoticeValue: vi.fn(), setNoticeError: vi.fn(),
    setDetails: vi.fn(), setNativeActive: vi.fn(), setRemoteControlState: vi.fn(),
    remoteInputPeersRef: ref([]), getRuntimeCapabilities: vi.fn(async () => ({ remoteInput: false })),
    applyCaptureProfile: vi.fn(async (_stream: unknown, profile: QualitySettings) => { physical = profile; }),
    captureDetails: () => ({}),
    qualitySettingsEqual, qualityResolutionEqual, videoQualitySettingsEqual, screenAudioBitrate, qualitySettingsLabel,
    supportsCaptureProfile, videoLimits: videoCaptureLimits(), audioBitrateCeiling: MAX_AUDIO_SEND_BITRATE,
    say: (key: string) => key, syncHostSfuQualityWarning: () => null,
    NativeSenderPeer, discardPreparedHostChild: vi.fn(), removePeer: vi.fn(), startPeer: vi.fn(async (_peerId: string, _generation: number): Promise<void> => {}),
    nativePreviewTailRef: ref(Promise.resolve()), setSourceSwitch: vi.fn(),
    invalidateSenderQualityEvidence: vi.fn(), routePolicyRef: ref({ topologyOptimization: false }),
    sourceSwitchNotice: () => "source-switch-result", hostPeerIdRef: ref(null), endpointMediaCopyCapacityRef: ref(2),
    creationProfileRef: ref({ roomPassword: null }), saveCreationProfile: vi.fn(), setCreationProfile: vi.fn(),
    setViewerPasswordEnabled: vi.fn(), setViewerPasswordDraft: vi.fn(), setViewerPasswordVisible: vi.fn(),
    setRoutePolicy: vi.fn(), setRoom: vi.fn(), activeRouteRevisionRef: ref(1),
    ensureHostSfuRoute: () => route,
    reconcileBoundedMediaChildren, activeHostChildPeerIdsRef: ref<string[]>([]),
  };
  context = createContext({ ...state, stopUserMediaTrack,
    isCurrentGeneration: (generation: number) => state.activeGenerationRef.current === generation,
    isCurrentShare: (generation: number, share: string) =>
      state.activeGenerationRef.current === generation && state.shareGenerationRef.current === share,
  });
  runInContext(executable, context);
  state.setNativeActive.mockImplementation((value: boolean) => { context.nativeActive = value; });
  state.setSourceSwitch.mockImplementation((value: unknown) => { context.sourceSwitchState = value; context.switchingSource = value !== null; });
  if (nativeConnected) state.nativeConnection.adopt(client as unknown as NativeClient);
  const start = context.startSharing;
  const startChild = context.startPeer;
  const openPicker = context.openCaptureSourcePicker;
  const dispose = context.disposeResources as (notifyServer: boolean, keepRoomSession?: boolean) => void;
  const writeNoticeError = context.setNoticeError;
  state.setNoticeError.mockImplementation(writeNoticeError);
  context.setNoticeError = state.setNoticeError;
  context.startSharing = state.startSharing;
  context.startPeer = state.startPeer;
  context.openCaptureSourcePicker = state.openCaptureSourcePicker;
  context.disposeResources = state.disposeResources;
  return { ...state, peer, client, route, track, bridge, physical: () => physical,
    context, startChild, dispose, openPicker: openPicker as () => Promise<void>,
    closePicker: context.closeCaptureSourcePicker as () => void,
    releaseUnused: context.releaseUnusedNativeClient as () => void,
    disposeNative: context.disposeNativeShare as (expectedShare?: string) => void,
    start: () => start( { kind: "native", client, target: {}, audio: false, path: {} }) as Promise<void>,
    startBrowser: () => start({ kind: "browser" }) as Promise<void>,
    writeNoticeError,
    renderNotice: (noticeValue: unknown) => runInContext(noticeRendering, createContext({ noticeValue, t: say })),
    renderNativePermission: () => runInContext(`(() => { ${nativePermissionRendering.join("\n")} return confirmNativeCapture; })()`, context),
    discover: context.acquireNativeClient as () => Promise<typeof client | null>,
    requestShare: context.requestSharing as () => void,
    startNative: () => context.startNativeShare(1, "share", { client, target: {}, audio: false, path: {} }) as Promise<unknown>,
    startOptionalIngress: () => context.startBrowserNativeIngress(1, "share", stream) as Promise<void>,
    change: context.changeQuality as (profile: QualitySettings) => Promise<void>,
    reauthenticate: () => context.handleSignalMessage({ type: "authenticated", role: "host", qualitySettings: original,
      routePolicy: {}, routeRevision: 1, endpointMediaCopyCapacity: 2 }, 1, true, null),
    switchSource: () => context.switchNativeSource(client, {}, false, {}),
  };
}

function useRealResourceDisposal(current: ReturnType<typeof fixture>): void {
  current.peersRef.current.clear();
  Object.assign(current.hostSfuRouteRef, { current: null });
  Object.assign(current.context, {
    codecProbeAbortRef: ref(null), VP8_ONLY_VIDEO_CODEC: { primary: "vp8" },
    setResolvedVideoCodec: vi.fn(), setHostSfuQualityWarning: vi.fn(),
    setInteractionSession: vi.fn(), browserVideoPoolRef: ref(null),
    setMicrophonePending: vi.fn(), retiringStreamRef: ref(null), iceConfigRef: ref(null),
    commentaryOperationRef: ref(null), setCommentary: vi.fn(), setCommentaryBusy: vi.fn(), setCommentaryInput: vi.fn(),
    setStream: vi.fn(), setPeerSnapshots: vi.fn(), setParticipantPresence: vi.fn(),
    viewerQualityEvidenceStore: { clear: vi.fn(), getSnapshot: () => new Map() },
    cancelViewerQualityEvidenceRender: vi.fn(), setViewerQualityEvidence: vi.fn(),
    setSignalStatus: vi.fn(), sharingPausedRef: ref(false), setSharingPaused: vi.fn(),
  });
  current.disposeResources.mockImplementation(current.dispose);
}

describe("Native sharing pause ownership", () => {
  function pauseFixture(paused = true) {
    const current = fixture();
    useRealResourceDisposal(current);
    current.nativeModeRef.current = true;
    const setPaused = vi.fn(async (_share: string, _paused: boolean) => {});
    Object.assign(current.client, { setPaused });
    const signal = { setSharingPaused: vi.fn(() => true), confirmSharingPaused: vi.fn(), setCoPlayGrants: vi.fn(), stop: vi.fn() };
    Object.assign(current.context, {
      sharingPausedRef: ref(paused), setSharingPaused: vi.fn(), setMediaPaused: vi.fn(() => true),
      signalRef: ref(signal),
    });
    return { ...current, setPaused, signal };
  }

  it.each([false, true])("commits the current Native pause change from paused=%s", async paused => {
    const current = pauseFixture(paused);
    current.context.toggleSharingPause();
    await vi.waitFor(() => expect(current.context.setSharingPaused).toHaveBeenCalledWith(!paused));
    expect(current.setPaused).toHaveBeenCalledExactlyOnceWith("share", !paused);
    expect(current.signal.setSharingPaused).toHaveBeenCalledExactlyOnceWith(!paused);
    expect(current.context.sharingPausedRef.current).toBe(!paused);
  });

  it.each(["success", "failure", "retired"])("ignores a superseded Native resume %s", async outcome => {
    const current = pauseFixture();
    const pending = deferred<void>();
    current.setPaused.mockReturnValueOnce(pending.promise);
    current.context.toggleSharingPause();
    if (outcome === "retired") {
      current.activeGenerationRef.current = null;
      current.dispose(false);
    } else {
      current.context.handleSignalMessage({ type: "pause-sharing-source", shareGeneration: "share" }, 1, false, null);
      expect(current.setPaused).toHaveBeenLastCalledWith("share", true);
    }
    current.context.setSharingPaused.mockClear();
    current.setNoticeValue.mockClear();
    if (outcome === "failure") pending.reject(new Error("old resume failed"));
    else pending.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(current.signal.setSharingPaused).not.toHaveBeenCalled();
    expect(current.context.setSharingPaused).not.toHaveBeenCalled();
    expect(current.setNoticeValue).not.toHaveBeenCalled();
    expect(current.sharingPauseOperationRef.current).toBeNull();
  });

  it("does not publish an old resume rollback after authoritative pause takes over", async () => {
    const current = pauseFixture();
    const rollback = deferred<void>();
    current.signal.setSharingPaused.mockReturnValue(false);
    current.setPaused.mockResolvedValueOnce().mockReturnValueOnce(rollback.promise);
    current.context.toggleSharingPause();
    await vi.waitFor(() => expect(current.setPaused).toHaveBeenCalledTimes(2));
    current.context.handleSignalMessage({ type: "pause-sharing-source", shareGeneration: "share" }, 1, false, null);
    current.signal.confirmSharingPaused.mockClear();
    current.setNoticeValue.mockClear();
    rollback.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(current.signal.confirmSharingPaused).not.toHaveBeenCalled();
    expect(current.setNoticeValue).not.toHaveBeenCalled();
  });
});

describe("Camera replacement ownership", () => {
  function sourceFixture(native: boolean) {
    const current = fixture();
    class Track extends EventTarget {
      readyState = "live";
      enabled = true;
      stop = vi.fn(() => { this.readyState = "ended"; });
      getSettings = () => ({ width: 1280, height: 720 });
    }
    const picture = (sound = false) => {
      const video = new Track();
      const audio = sound ? new Track() : null;
      return { video, getTracks: () => audio ? [video, audio] : [video], getVideoTracks: () => [video], getAudioTracks: () => audio ? [audio] : [] };
    };
    const previous = picture(), camera = picture(), nativeStream = picture(true);
    const oldBridge = { stream: previous, dispose: vi.fn(() => previous.video.stop()) };
    const peer = Object.assign(Object.create(HostPeer.prototype), { replaceStream: vi.fn(async () => true), dispose: vi.fn() });
    const nativePeer = Object.assign(Object.create(NativeSenderPeer.prototype), { dispose: vi.fn() });
    const startedPeerStreams: unknown[] = [];
    const replacePublication = vi.fn(async () => true);
    current.peersRef.current.clear();
    current.peersRef.current.set("viewer", native ? nativePeer : peer as never);
    current.removePeer.mockImplementation(id => {
      const retired = current.peersRef.current.get(id) as unknown as { dispose?: () => void };
      current.peersRef.current.delete(id);
      retired?.dispose?.();
    });
    current.startPeer.mockImplementation(async id => {
      startedPeerStreams.push(current.context.streamRef.current);
      current.peersRef.current.set(id, peer as never);
    });
    Object.assign(current.context, {
      HostAudio, streamRef: ref(previous), retiringStreamRef: ref(null), sharingPausedRef: ref(false),
      hostAudioRef: ref(native ? null : new HostAudio(previous as unknown as MediaStream, "camera")),
      nativeMediaBridgeRef: ref(native ? oldBridge : null), setCommentary: vi.fn(), setCameraDevice: vi.fn(),
      setStream: vi.fn(), setResolvedVideoCodec: vi.fn(), setMediaPaused: vi.fn(),
      captureBrowserSource: vi.fn(async () => camera), endSharing: vi.fn(),
      createOpaqueId: () => "native-source-2", nativeSources: { kind: "ready" },
      hostSfuRouteRef: ref({ replaceStream: replacePublication }),
      iceConfigRef: ref({ iceServers: [] }), hostChildIsAssigned: () => true,
      acceptHostPeerUpdate: vi.fn(), reportHostChildFailure: vi.fn(),
    });
    const nativeControl = {
      prepareEdge: vi.fn(async () => ({ type: "offer", sdp: "native encoded offer" })),
      closeEdge: vi.fn(async () => {}),
      setRemoteInputPeers: vi.fn(async () => {
        current.client.onEvent.mock.calls[0]![0](remoteSnapshot);
      }),
    };
    const remoteSnapshot = { version: 10, type: "remote-control-state", shareId: "native-source-2", mode: "ask", platform: "windows", requests: [], coPlay: false };
    Object.assign(current.client, nativeControl);
    current.signalRef.current.send.mockReturnValue(true);
    current.nativeModeRef.current = native;
    current.context.nativeActive = native;
    current.nativeShareGenerationRef.current = native ? "native-source-1" : null;
    current.nativeSourcePathRef.current = { adapterIndex: 0, encoderIndex: 0 };
    current.manualVideoCodecPreference.mockImplementation(codec => ({ primary: codec }));
    current.bridge.start.mockResolvedValue(nativeStream);
    Object.assign(current.bridge, { stream: nativeStream });
    Object.assign(current.client.health, { activationURL: "piik://media" });
    return { ...current, nativeControl, remoteSnapshot, picture, previous, camera, nativeStream, oldBridge, peer, nativePeer, startedPeerStreams, replacePublication };
  }

  it.each(["NotAllowedError", "NotReadableError"])("keeps native capture and its room when Camera fails with %s", async name => {
    const current = sourceFixture(true);
    const permission = deferred<never>();
    current.context.captureBrowserSource.mockReturnValue(permission.promise);
    current.context.startBrowserShareFromPicker("camera", "front");
    expect(current.context.captureBrowserSource).toHaveBeenCalledExactlyOnceWith(original, "camera", "front");
    expect(current.client.stopShare).not.toHaveBeenCalled();
    permission.reject(new DOMException("camera rejected", name));
    await vi.waitFor(() => expect(current.sourceSwitchRef.current).toBeNull());
    expect(current.context.streamRef.current).toBe(current.previous);
    expect(current.nativeModeRef.current).toBe(true);
    expect(current.oldBridge.dispose).not.toHaveBeenCalled();
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.context.endSharing).not.toHaveBeenCalled();
  });

  it("switches native → Camera → native through the picker handlers in one live room", async () => {
    const current = sourceFixture(true);
    const roomSignal = current.signalRef.current;
    current.context.startBrowserShareFromPicker("camera", "front");
    await vi.waitFor(() => expect(current.sourceSwitchRef.current).toBeNull());
    expect(current.context.streamRef.current).toBe(current.camera);
    expect(current.client.stopShare).toHaveBeenCalledExactlyOnceWith("native-source-1");
    expect(current.previous.video.stop).toHaveBeenCalled();
    expect(current.nativeModeRef.current).toBe(false);
    expect(current.nativePeer.dispose).toHaveBeenCalledOnce();
    expect(current.startedPeerStreams).toEqual([current.camera]);
    expect(current.replacePublication).toHaveBeenCalledWith(current.camera, true);
    expect(current.context.hostAudioRef.current).toBeInstanceOf(HostAudio);
    expect(current.context.endSharing).not.toHaveBeenCalled();

    // Revisiting the picker reacquires its control owner; the Browser camera
    // remains the publication until App ACK and the required bridge both finish.
    current.nativeConnection.adopt(current.client as unknown as NativeClient);
    current.context.startPeer = current.startChild;
    Object.assign(current.client.health.nativeMedia, { remoteInput: true });
    current.setRemoteControlState.mockClear();
    current.nativeSourcePathRef.current = { adapterIndex: 0, encoderIndex: 0 };
    const ack = deferred<{ audio: boolean; codec: "h264" }>();
    const bridge = deferred<typeof current.nativeStream>();
    current.client.startShare.mockReturnValue(ack.promise);
    current.bridge.start.mockReturnValue(bridge.promise);
    current.context.startNativeShareFromPicker({ kind: "picker", sourceId: "1", title: "System" }, true, false);
    await vi.waitFor(() => expect(current.client.startShare).toHaveBeenCalledOnce());
    expect(current.renderNativePermission()).toBe(true);
    expect(current.context.streamRef.current).toBe(current.camera);
    ack.resolve({ audio: true, codec: "h264" });
    await vi.waitFor(() => expect(current.bridge.start).toHaveBeenCalledOnce());
    expect(current.renderNativePermission()).toBe(false);
    expect(current.context.streamRef.current).toBe(current.camera);
    expect(current.nativeModeRef.current).toBe(false);
    expect(current.peersRef.current.get("viewer")).toBe(current.peer);
    expect(current.peer.dispose).not.toHaveBeenCalled();
    expect(current.setRemoteControlState).not.toHaveBeenCalledWith(current.remoteSnapshot);
    expect(current.camera.video.stop).not.toHaveBeenCalled();
    bridge.resolve(current.nativeStream);
    await vi.waitFor(() => expect(current.sourceSwitchRef.current).toBeNull());
    expect(current.context.streamRef.current).toBe(current.nativeStream);
    expect(current.nativeModeRef.current).toBe(true);
    expect(current.setRemoteControlState).toHaveBeenCalledWith(current.remoteSnapshot);
    expect(current.peersRef.current.get("viewer")).toBeInstanceOf(NativeSenderPeer);
    expect(current.peer.dispose).toHaveBeenCalledOnce();
    expect(current.peer.replaceStream).not.toHaveBeenCalledWith(current.nativeStream);
    expect(current.nativeControl.prepareEdge).toHaveBeenCalledWith(
      "native-source-2", expect.any(String), { iceServers: [] }, undefined, false,
    );
    expect(current.replacePublication).toHaveBeenLastCalledWith(current.nativeStream, true);
    expect(current.audioAvailableRef.current).toBe(true);
    expect(current.nativeShareGenerationRef.current).toBe("native-source-2");
    expect(current.shareGenerationRef.current).toBe("share");
    expect(current.activeGenerationRef.current).toBe(1);
    expect(current.signalRef.current).toBe(roomSignal);
    expect(current.camera.video.stop).toHaveBeenCalled();
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.disposeResources).not.toHaveBeenCalled();
    expect(current.context.endSharing).not.toHaveBeenCalled();
    const nativeEvents = current.client.onEvent.mock.calls[0]![0];
    nativeEvents({ type: "share-ended", shareId: "native-source-1", failed: true });
    expect(current.context.endSharing).not.toHaveBeenCalled();
    nativeEvents({ type: "share-ended", shareId: "native-source-2", failed: true });
    expect(current.context.endSharing).toHaveBeenCalledOnce();
  });

  it.each(["permission", "bridge"])("retains Camera picture, audio and codec after native %s fails", async stage => {
    const current = sourceFixture(false);
    const previousCodec = current.videoCodecRef.current;
    current.audioAvailableRef.current = true;
    Object.assign(current.client.health.nativeMedia, { remoteInput: true });
    const failure = new NativeRequestError("rejected", "start-share");
    if (stage === "permission") current.client.startShare.mockRejectedValue(failure);
    else current.bridge.start.mockImplementation(async () => {
      // Exercise the real bridge-failure callback as well as its rejected wait.
      current.NativeMediaBridge.mock.calls.at(-1)![2]();
      throw new NativeMediaBridgeError("local preview failed");
    });
    await current.context.switchToNativeSource({ kind: "native", client: current.client,
      target: { kind: "picker", sourceId: "1", title: "System" }, audio: false, path: {} });
    expect(current.context.streamRef.current).toBe(current.previous);
    expect(current.previous.video.stop).not.toHaveBeenCalled();
    expect(current.audioAvailableRef.current).toBe(true);
    expect(current.videoCodecRef.current).toBe(previousCodec);
    expect(current.nativeModeRef.current).toBe(false);
    expect(current.context.hostAudioRef.current).toBeInstanceOf(HostAudio);
    expect(current.context.endSharing).not.toHaveBeenCalled();
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.peer.replaceStream).not.toHaveBeenCalled();
    expect(current.peersRef.current.get("viewer")).toBe(current.peer);
    expect(current.peer.dispose).not.toHaveBeenCalled();
    expect(current.setRemoteControlState).not.toHaveBeenCalledWith(current.remoteSnapshot);
    expect(current.sourceSwitchRef.current).toBeNull();
    expect(current.setNoticeValue).toHaveBeenLastCalledWith(expect.objectContaining({ target: "operation" }));
  });

  it.each([true, false])("does not apply a retired ingress replacement to a new share: %s", async result => {
    const current = fixture();
    const pending = deferred<boolean>();
    const oldTrack = { stop: vi.fn() }, capturedTrack = { stop: vi.fn() };
    const previous = { getTracks: () => [oldTrack], getVideoTracks: () => [oldTrack] };
    const captured = { getTracks: () => [capturedTrack], getVideoTracks: () => [capturedTrack], getAudioTracks: () => [] };
    const optional = { hasAudio: false, replaceStream: vi.fn(() => pending.promise) };
    const token = {};
    Object.assign(current.context, {
      streamRef: ref(previous), nativeMediaIngressRef: ref(optional), sourceSwitchRef: ref(token),
      retiringStreamRef: ref(null), sharingPausedRef: ref(false),
      setMediaPaused: vi.fn(), setStream: vi.fn(), watchCaptureEnd: vi.fn(),
    });
    const replacing = current.context.replaceBrowserStream(captured, 1, token);
    expect(optional.replaceStream).toHaveBeenCalledWith(captured);
    const replacementPeer = { replaceStream: vi.fn(async () => true) };
    const replacementRoute = { replaceStream: vi.fn(async () => true) };
    current.activeGenerationRef.current = 2;
    current.context.sourceSwitchRef.current = {};
    current.context.nativeMediaIngressRef.current = null;
    current.peersRef.current.clear();
    current.peersRef.current.set("replacement", replacementPeer as never);
    current.context.hostSfuRouteRef.current = replacementRoute;
    pending.resolve(result);
    await replacing;
    expect(replacementPeer.replaceStream).not.toHaveBeenCalled();
    expect(replacementRoute.replaceStream).not.toHaveBeenCalled();
    expect(capturedTrack.stop).toHaveBeenCalledOnce();
    expect(oldTrack.stop).toHaveBeenCalledOnce();
  });

  it("keeps a screen Stop authoritative while a camera picker is pending", async () => {
    const current = fixture();
    let ended!: () => void;
    const track = { readyState: "live", addEventListener: (_event: string, callback: () => void) => { ended = callback; } };
    const previous = { getVideoTracks: () => [track] };
    const pending = deferred<unknown>();
    const endSharing = vi.fn(() => { current.context.sourceSwitchRef.current = null; });
    Object.assign(current.context, {
      streamRef: ref(previous), captureBrowserSource: () => pending.promise,
      closeCaptureSourcePicker: vi.fn(), hostAudioRef: ref({ sourceKind: "browser" }), endSharing,
    });
    current.context.watchCaptureEnd(previous, 1);
    const switching = current.context.switchSource("camera", "second");
    track.readyState = "ended";
    ended();
    expect(endSharing).toHaveBeenCalledOnce();
    const stop = vi.fn();
    pending.resolve({ getTracks: () => [{ stop }] });
    await switching;
    expect(stop).toHaveBeenCalledOnce();
  });
  it.each(["success", "failed-live", "failed-ended"])("owns old camera retirement while switching: %s", async outcome => {
    const current = fixture();
    let ended!: () => void;
    const track = { readyState: "live", addEventListener: (_event: string, callback: () => void) => { ended = callback; } };
    const previous = { getVideoTracks: () => [track] };
    const replacement = { getTracks: () => [], getVideoTracks: () => [{ readyState: "live" }] };
    const pending = deferred<unknown>();
    const endSharing = vi.fn(), replaceBrowserStream = vi.fn(async () => {}), setCaptureError = vi.fn();
    Object.assign(current.context, {
      streamRef: ref(previous), captureBrowserSource: () => pending.promise, closeCaptureSourcePicker: vi.fn(),
      hostAudioRef: ref({ sourceKind: "camera", attach: (stream: unknown) => stream }),
      endSharing, replaceBrowserStream, setCaptureError, setCameraDevice: vi.fn(),
    });
    current.context.watchCaptureEnd(previous, 1);
    const switching = current.context.switchSource("camera", "second");
    if (outcome !== "failed-live") { track.readyState = "ended"; ended(); }
    expect(endSharing).not.toHaveBeenCalled();
    if (outcome === "success") pending.resolve(replacement);
    else pending.reject(new Error("camera unavailable"));
    await switching;
    expect(replaceBrowserStream).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    expect(endSharing).toHaveBeenCalledTimes(outcome === "failed-ended" ? 1 : 0);
    expect(setCaptureError).toHaveBeenCalledTimes(outcome === "failed-live" ? 1 : 0);
  });
});

describe("Host room ownership", () => {
  function roomFixture(nativeConnected = true) {
    const current = fixture(true, nativeConnected);
    const room = { roomId: "1234", hostToken: "host-token", canonicalUrl: "https://example.test/r/1234", codeEntryPolicy: "open", inviteUrl: null };
    const signals: Signal[] = [];
    class Signal {
      interactions = {};
      stop = vi.fn();
      stopSharing = vi.fn();
      setAudioAvailable = vi.fn();
      setCoPlayGrants = vi.fn();
      enableRoomInteractions = vi.fn(() => this.interactions);
      constructor(public identity: { roomId: string; token: string; roomOnly?: true; shareGeneration?: string },
        public events: {
          onMessage(message: unknown): void;
          onTerminated(reason: "SIGNAL_TERMINATED"): void;
          onAccessRequired(): void;
        }) { signals.push(this); }
      ownsHostRoom(roomId: string, token: string) { return this.identity.roomId === roomId && this.identity.token === token; }
      wantsHostPublication(generation: string) { return this.identity.shareGeneration === generation && this.identity.roomOnly !== true; }
    }
    const forgetRoom = vi.fn(current.context.forgetRoom);
    Object.assign(current.roomRef, { current: room });
    Object.assign(current.signalRef, { current: null });
    current.generationRef.current = 1;
    Object.assign(current.context, {
      SignalingClient: Signal, hostRoomSessionAvailable: true, roomInteractionsAvailable: true, roomReactionIds: undefined,
      visRef: ref(false), hostClientIdRef: ref(null), displayNameRef: ref("Host"),
      getStableClientId: () => "host-client", defaultHostDisplayName: () => "Host", readDisplayName: () => "Host",
      setDisplayName: vi.fn(), setDisplayNameDraft: vi.fn(), setDisplayNameError: vi.fn(),
      setInteractionSession: vi.fn(), setSignalStatus: vi.fn(), forgetRoom,
      onAuthorizationRequired: vi.fn(), clearHostRoom: vi.fn(), writePreferredRoom: vi.fn(),
    });
    return { ...current, room, signals, forgetRoom, connect: (value = room) => current.context.connectRoomSignal(value) as Signal };
  }

  it("restores one room-only connection without creating a publication", () => {
    const current = roomFixture();
    current.activeGenerationRef.current = null;
    current.shareGenerationRef.current = null;
    const signal = current.connect();
    expect(signal.identity).toMatchObject({ roomId: "1234", roomOnly: true, roomSession: true });
    expect(signal.identity.shareGeneration).toBeUndefined();
    expect(current.connect()).toBe(signal);
    expect(current.signals).toHaveLength(1);
  });

  it("does not mistake capture permission in progress for publication intent", () => {
    const current = roomFixture();
    const signal = current.connect();
    signal.events.onMessage({ type: "error", code: "INVALID_TOKEN" });
    expect(current.forgetRoom).toHaveBeenCalledWith(current.room);
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.disposeResources).not.toHaveBeenCalled();
    expect(current.activeGenerationRef.current).toBe(1);
    expect(current.setPhase).not.toHaveBeenCalled();
    expect(current.setNoticeValue).not.toHaveBeenCalled();
  });

  it("shows a rejected restored room on the television before any sharing starts", () => {
    const current = roomFixture();
    current.activeGenerationRef.current = null;
    current.shareGenerationRef.current = null;
    current.connect().events.onMessage({ type: "error", code: "INVALID_TOKEN" });
    expect(current.setNoticeValue).toHaveBeenCalledExactlyOnceWith({
      kind: "key", key: "host.roomInvalid", vars: undefined,
      target: "television", comic: "room-not-found", tone: "bad",
    });
  });

  it.each(["INVALID_TOKEN", "HOST_ALREADY_CONNECTED", "room-closed", "terminated", "access-required"])(
    "retires idle native selection and its late results on %s", async event => {
      for (const stage of ["ready", "discovery", "enumeration"]) {
        const current = roomFixture(stage !== "discovery");
        useRealResourceDisposal(current);
        current.context.phase = "idle";
        current.activeGenerationRef.current = null;
        current.shareGenerationRef.current = null;
        current.nativeShareGenerationRef.current = null;
        const discovery = deferred<typeof current.client>();
        const enumeration = deferred<never[]>();
        if (stage === "discovery") {
          current.NativeClient.connect.mockReturnValueOnce(discovery.promise);
        } else if (stage === "enumeration") current.client.sources.mockReturnValueOnce(enumeration.promise);
        const signal = current.connect();
        const selecting = current.openPicker();
        if (stage === "ready") await selecting;
        else await vi.waitFor(() => expect(stage === "discovery"
          ? current.NativeClient.connect : current.client.sources).toHaveBeenCalledOnce());
        expect(current.nativeSourceRequestRef.current).not.toBeNull();

        if (event === "terminated") signal.events.onTerminated("SIGNAL_TERMINATED");
        else if (event === "access-required") signal.events.onAccessRequired();
        else signal.events.onMessage(event === "room-closed" ? { type: event } : { type: "error", code: event });
        expect(current.nativeSourceRequestRef.current).toBeNull();
        expect(current.nativeSourcePathRef.current).toBeNull();
        discovery.resolve(current.client);
        enumeration.resolve([]);
        await selecting;
        expect(current.nativeConnection.current).toBeNull();
        expect(current.client.close).toHaveBeenCalledOnce();
        expect(current.setNativeSources).toHaveBeenLastCalledWith(null);
        expect(current.createRoom).not.toHaveBeenCalled();
        if (stage === "discovery") expect(current.client.sources).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])("retires a room rejected by an access update (sharing=%s)", async sharing => {
    const current = roomFixture();
    useRealResourceDisposal(current);
    current.context.phase = sharing ? "live" : "idle";
    current.nativeModeRef.current = sharing;
    if (!sharing) {
      current.activeGenerationRef.current = null;
      current.shareGenerationRef.current = null;
      current.nativeShareGenerationRef.current = null;
      current.streamRef.current = null;
    }
    const signal = current.connect();
    await current.openPicker();
    current.context.handleRoomAccessFailure(new ApiError("Room not found", 404), current.room);
    expect(current.roomRef.current).toBeNull();
    expect(current.signalRef.current).toBeNull();
    expect(signal.stop).toHaveBeenCalledOnce();
    expect(current.activeGenerationRef.current).toBeNull();
    expect(current.track.stop).toHaveBeenCalledTimes(sharing ? 1 : 0);
    expect(current.client.close).toHaveBeenCalledOnce();
    expect(current.setNativeSources).toHaveBeenLastCalledWith(null);
    expect(current.setNoticeValue).toHaveBeenLastCalledWith(expect.objectContaining({
      key: "host.roomInvalid", target: "television", comic: "room-not-found", tone: "bad",
    }));
  });

  it("retires the room session when a replacement fails after capture was stopped", async () => {
    const current = roomFixture();
    useRealResourceDisposal(current);
    const response = deferred<never>();
    current.context.replaceOwnedRoom = vi.fn(() => response.promise);
    const signal = current.connect();
    const replacing = current.context.replaceCurrentRoom();
    current.context.endSharing({ key: "host.stopNotice" });
    expect(signal.stop).not.toHaveBeenCalled();
    expect(current.signalRef.current).toBe(signal);
    response.reject(new ApiError("Room not found", 404));
    await replacing;
    expect(current.roomRef.current).toBeNull();
    expect(current.signalRef.current).toBeNull();
    expect(signal.stop).toHaveBeenCalledOnce();
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.roomMutationRef.current).toBeNull();
  });

  it.each(["replace", "missing-room"] as const)("retires an unclaimed %s result after page exit", async path => {
    for (const stage of ["response", "claim", "accepted"] as const) {
      const current = roomFixture();
      current.context.phase = "idle";
      current.activeGenerationRef.current = null;
      const replacement = { ...current.room, roomId: "5678", hostToken: "replacement-token" };
      const response = deferred<typeof replacement>();
      const claim = deferred<void>();
      const writeHostRoom = vi.fn(async (_room: unknown, owns: () => boolean) => {
        await claim.promise;
        return owns();
      });
      const closeAbandonedRoom = vi.fn();
      const request = vi.fn(() => response.promise);
      Object.assign(current.context, {
        replaceOwnedRoom: path === "replace" ? request : async () => { throw new ApiError("Room not found", 404); },
        createRoom: request, hostRoomFromCreated: (room: unknown) => room,
        replaceViewerInvite: vi.fn(), writeHostRoom, closeAbandonedRoom,
      });
      const replacing = current.context.replaceCurrentRoom();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      if (stage === "response") current.roomMutationRef.current = null;
      response.resolve(replacement);
      if (stage === "claim") {
        await vi.waitFor(() => expect(writeHostRoom).toHaveBeenCalledOnce());
        current.roomMutationRef.current = null;
      }
      claim.resolve();
      await replacing;
      if (stage === "accepted") {
        expect(closeAbandonedRoom).not.toHaveBeenCalled();
        expect(current.roomRef.current).toBe(replacement);
        expect(current.setRoom).toHaveBeenCalledWith(replacement);
      } else {
        expect(closeAbandonedRoom).toHaveBeenCalledExactlyOnceWith(replacement);
        expect(current.roomRef.current).toBe(current.room);
        expect(current.setRoom).not.toHaveBeenCalled();
        expect(current.setNoticeError).not.toHaveBeenCalled();
        if (stage === "response") expect(writeHostRoom).not.toHaveBeenCalled();
      }
    }
  });

  it("does not recreate a missing room after its replacement operation was retired", async () => {
    const current = roomFixture();
    current.context.phase = "idle";
    current.activeGenerationRef.current = null;
    const response = deferred<never>();
    current.context.replaceOwnedRoom = () => response.promise;
    const replacing = current.context.replaceCurrentRoom();
    current.roomMutationRef.current = null;
    response.reject(new ApiError("Room not found", 404));
    await replacing;
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.setNoticeError).not.toHaveBeenCalled();
  });

  it("ignores an old room's failed access update after another room owns the session", () => {
    const current = roomFixture();
    useRealResourceDisposal(current);
    const replacement = { ...current.room, hostToken: "replacement-token" };
    Object.assign(current.roomRef, { current: replacement });
    const signal = current.connect(replacement);
    current.context.handleRoomAccessFailure(new ApiError("Room not found", 404), current.room);
    expect(current.roomRef.current).toBe(replacement);
    expect(current.signalRef.current).toBe(signal);
    expect(signal.stop).not.toHaveBeenCalled();
    expect(current.client.close).not.toHaveBeenCalled();
    expect(current.setNoticeValue).not.toHaveBeenCalled();
  });

  it.each(["INVALID_TOKEN", "HOST_ALREADY_CONNECTED", "room-closed", "terminated", "access-required"])(
    "keeps %s in the same status surface with and without a source", event => {
      const outcomes: unknown[] = [];
      for (const sharing of [false, true]) {
        const current = roomFixture();
        current.activeGenerationRef.current = sharing ? 1 : null;
        current.shareGenerationRef.current = sharing ? "share" : null;
        const signal = current.context.connectRoomSignal(current.room, undefined, false) as ReturnType<typeof current.connect>;
        if (event === "terminated") signal.events.onTerminated("SIGNAL_TERMINATED");
        else if (event === "access-required") signal.events.onAccessRequired();
        else signal.events.onMessage(event === "room-closed" ? { type: event } : { type: "error", code: event });
        expect(current.setNoticeValue).toHaveBeenCalledOnce();
        const notice = current.setNoticeValue.mock.calls[0][0];
        expect(notice).toMatchObject({ target: "television", tone: event === "room-closed" ? "off" : "bad" });
        outcomes.push({ text: notice.kind === "key" ? notice.key : notice.text, comic: notice.comic });
        expect(current.activeGenerationRef.current).toBeNull();
        expect(current.disposeResources).toHaveBeenCalledOnce();
      }
      expect(outcomes[0]).toEqual(outcomes[1]);
    },
  );

  it("checks the existing connection's authority before reusing it", () => {
    const current = roomFixture();
    const original = current.connect();
    const replacement = { ...current.room, roomId: "5678", hostToken: "new-token" };
    Object.assign(current.roomRef, { current: replacement });
    const next = current.connect(replacement);
    expect(original.stop).toHaveBeenCalledOnce();
    expect(next).not.toBe(original);
    expect(next.identity.roomId).toBe("5678");
  });

  it("retires only the matching rejected publication without sending an invalid stop", () => {
    const current = roomFixture();
    const signal = current.connect();
    signal.events.onMessage({ type: "sharing-start-failed", shareGeneration: "obsolete", code: "SERVER_ERROR" });
    expect(current.disposeResources).not.toHaveBeenCalled();
    signal.events.onMessage({ type: "sharing-start-failed", shareGeneration: "share", code: "SERVER_ERROR" });
    expect(current.disposeResources).toHaveBeenCalledExactlyOnceWith(false, true);
    expect(current.activeGenerationRef.current).toBeNull();
    expect(signal.stop).not.toHaveBeenCalled();
  });
});

describe("Host room-link copy feedback", () => {
  function copyFixture(includeInviteCredential = true) {

    const current = fixture();
    let copiedUrl: string | null = null;
    let notice: unknown = null;
    current.setCopiedRoomLink.mockImplementation((next: string | null) => { copiedUrl = next; });
    const room = { roomId: "1234", hostToken: "host-token", inviteUrl: "https://example.test/r/1234#v=example",
      canonicalUrl: "https://example.test/r/1234" };
    Object.assign(current.roomRef, { current: room });
    current.setNoticeValue.mockImplementation((next: unknown) => {
      notice = typeof next === "function" ? next(notice) : next;
    });
    const writeText = vi.fn(async (_value: string) => {});
    Object.assign(current.context, {

      navigator: { clipboard: { writeText } },
      copiedResetTimerRef: ref<number | null>(null),
      copyRoomLinkRequestRef: ref<object | null>(null),
      includeInviteCredential, roomLinkBlocked: false, roomMutating: false,
      window: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() },
    });
    return { ...current, writeText, copied: () => copiedUrl !== null && copiedUrl === (current.context.includeInviteCredential
      ? current.context.roomRef.current?.inviteUrl : current.context.roomRef.current?.canonicalUrl),
      replaceInvite: (inviteUrl: string | null) => { current.context.roomRef.current = { ...room, inviteUrl }; }, notice: () => notice,
      copy: current.context.copyRoomLink as () => Promise<void> };
  }

  it("copies the canonical room URL when password-free invitation is off", async () => {
    const current = copyFixture(false);
    await current.copy();
    expect(current.writeText).toHaveBeenCalledWith("https://example.test/r/1234");
    expect(current.copied()).toBe(true);
  });

  it("does not copy a plain link that cannot admit a Viewer", async () => {
    const current = copyFixture(false);
    current.context.roomLinkBlocked = true;
    await current.copy();
    expect(current.writeText).not.toHaveBeenCalled();
    expect(current.copied()).toBe(false);
  });

  it("clears an earlier success when the next copy fails", async () => {
    const current = copyFixture();
    await current.copy();
    expect(current.copied()).toBe(true);
    current.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await current.copy();
    expect(current.copied()).toBe(false);
    expect(current.notice()).toMatchObject({ key: "host.invite.copyFailed", comic: "copy-failed", tone: "bad" });
  });

  it("clears its own failure after a successful retry", async () => {
    const current = copyFixture();
    current.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await current.copy();
    expect(current.notice()).toMatchObject({ key: "host.invite.copyFailed" });
    await current.copy();
    expect(current.copied()).toBe(true);
    expect(current.notice()).toBeNull();
  });

  it("preserves another notice that arrives while copying", async () => {
    const current = copyFixture();
    current.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await current.copy();
    const pending = deferred<void>();
    current.writeText.mockReturnValueOnce(pending.promise);
    const copying = current.copy();
    current.context.setNoticeErrorKey("host.accessFailed", "access-denied");
    const newer = current.notice();
    pending.resolve();
    await copying;
    expect(current.copied()).toBe(true);
    expect(current.notice()).toBe(newer);
  });

  it.each([false, true])("ignores a retired invite's late clipboard completion (failure=%s)", async (failed) => {
    const current = copyFixture();
    const pending = deferred<void>();
    current.writeText.mockReturnValueOnce(pending.promise);
    const oldCopy = current.copy();
    current.replaceInvite("https://example.test/r/1234#v=replacement");
    expect(current.copied()).toBe(false);
    await current.copy();
    expect(current.copied()).toBe(true);
    if (failed) pending.reject(new Error("old clipboard failure"));
    else pending.resolve();
    await oldCopy;
    expect(current.copied()).toBe(true);
    expect(current.notice()).toBeNull();
  });

  it.each([false, true])("keeps the latest result for concurrent copies of the same URL (latest failed=%s)", async (latestFailed) => {
    const current = copyFixture();
    const pending = deferred<void>();
    current.writeText.mockReturnValueOnce(pending.promise);
    const older = current.copy();
    if (latestFailed) current.writeText.mockRejectedValueOnce(new Error("latest denied"));
    await current.copy();
    const latestNotice = current.notice();
    if (latestFailed) pending.resolve();
    else pending.reject(new Error("older denied"));
    await older;
    expect(current.copied()).toBe(!latestFailed);
    expect(current.notice()).toBe(latestNotice);
  });
});

describe("Host quality ownership", () => {
  it("rejects unsupported settings without changing capture, room or saved intent", async () => {
    const current = fixture();
    await current.change({ ...original, maxFramerate: 480, maxBitrate: 40_000_000 });
    expect(current.qualitySettingsRef.current).toEqual(original);
    expect(current.applyCaptureProfile).not.toHaveBeenCalled();
    expect(current.signalRef.current.setHostQualitySettings).not.toHaveBeenCalled();
    expect(current.context.savePreferredQuality).not.toHaveBeenCalled();
    expect(current.advancedQualityRef.current).toEqual(original);
  });

  it("ignores an unsupported App preference without erasing it", async () => {
    const current = fixture();
    current.activeGenerationRef.current = null;
    const preference = { read: vi.fn(async () => ({ ...original, maxFramerate: 480 })), save: vi.fn() };
    current.context.AppQualityPreference = { connect: vi.fn(async () => preference) };
    await current.context.loadAppQualityPreference(new AbortController().signal);
    expect(current.qualitySettingsRef.current).toEqual(original);
    expect(preference.save).not.toHaveBeenCalled();
    expect(current.NativeClient.connect).not.toHaveBeenCalled();
  });

  it("restores App preferences without acquiring media or changing a room", async () => {
    const current = fixture();
    current.activeGenerationRef.current = null;
    const preference = { read: vi.fn(async () => lower), save: vi.fn() };
    current.context.AppQualityPreference = { connect: vi.fn(async () => preference) };
    await current.context.loadAppQualityPreference(new AbortController().signal);
    expect(current.qualitySettingsRef.current).toEqual(lower);
    expect(current.NativeClient.connect).not.toHaveBeenCalled();
    expect(current.signalRef.current.setHostQualitySettings).not.toHaveBeenCalled();
    expect(preference.save).not.toHaveBeenCalled();
  });

  it.each(["explicit", "room", "sharing", "creating", "retired"])(
    "does not let a late App preference override %s ownership", async (owner) => {
      const current = fixture();
      current.activeGenerationRef.current = null;
      const pending = deferred<QualitySettings>();
      const preference = { read: vi.fn(() => pending.promise), save: vi.fn() };
      current.context.AppQualityPreference = { connect: vi.fn(async () => preference) };
      const controller = new AbortController();
      const loading = current.context.loadAppQualityPreference(controller.signal);
      await Promise.resolve();
      if (owner === "explicit") current.qualityPreferenceEditedRef.current = true;
      if (owner === "room") current.context.commitQuality({ ...original });
      if (owner === "sharing") current.activeGenerationRef.current = 2;
      if (owner === "creating") current.roomMutationRef.current = {};
      if (owner === "retired") controller.abort();
      pending.resolve(lower);
      await loading;
      expect(current.qualitySettingsRef.current).toEqual(original);
      expect(preference.save).not.toHaveBeenCalled();
    },
  );

  it("carries an applied choice across delayed App discovery without persisting room snapshots", async () => {
    const current = fixture();
    current.context.phase = "idle";
    current.activeGenerationRef.current = null;
    const preference = { read: vi.fn(async () => original), save: vi.fn() };
    current.context.AppQualityPreference = { connect: vi.fn(async () => preference) };
    await current.change(lower);
    await current.context.loadAppQualityPreference(new AbortController().signal);
    expect(preference.save).toHaveBeenCalledExactlyOnceWith(lower);
    expect(current.qualitySettingsRef.current).toEqual(lower);
    current.context.commitQuality(original);
    expect(preference.save).toHaveBeenCalledOnce();
    await current.change(lower);
    expect(preference.save).toHaveBeenCalledTimes(2);
  });

  it("remembers an explicit pre-share choice without changing room or capture state", async () => {
    const current = fixture();
    current.context.phase = "idle";
    await current.change(lower);
    expect(current.savePreferredQuality).toHaveBeenCalledWith(lower);
    expect(current.applyCaptureProfile).not.toHaveBeenCalled();
    expect(current.signalRef.current.setHostQualitySettings).not.toHaveBeenCalled();
  });

  it("does not replace a local preference with reauthenticated room settings", () => {
    const current = fixture();
    current.reauthenticate();
    expect(current.savePreferredQuality).not.toHaveBeenCalled();
  });

  it.each([true, false])("resumes the former raw audio input only after an accepted mixed-output resume: %s", (accepted) => {
    const current = fixture(false);
    const source = {} as MediaStream;
    current.hostAudioRef.current = { sourceStream: source };
    current.peersRef.current.clear();
    current.context.hostSfuRouteRef.current = null;
    const setMediaPaused = vi.fn(() => true);
    Object.assign(current.context, {
      sharingPausedRef: ref(true), setSharingPaused: vi.fn(), setMediaPaused,
      signalRef: ref({ setSharingPaused: () => accepted, confirmSharingPaused: vi.fn() }),
      setNoticeErrorKey: vi.fn(),
    });
    current.context.toggleSharingPause();
    expect(setMediaPaused).toHaveBeenCalledWith(current.streamRef.current, false);
    if (accepted) expect(setMediaPaused).toHaveBeenCalledWith(source, false);
    else {
      expect(setMediaPaused).not.toHaveBeenCalledWith(source, false);
      expect(setMediaPaused).toHaveBeenLastCalledWith(current.streamRef.current, true);
    }
  });
  it("refreshes source details from the capture input", async () => {
    const current = fixture(false);
    const source = {} as MediaStream;
    current.hostAudioRef.current = { sourceStream: source };
    const captureDetails = vi.fn(() => ({}));
    current.context.captureDetails = captureDetails;
    await current.change(lower);
    expect(captureDetails).toHaveBeenCalledWith(source);
  });
  it.each([false, true])("remembers the border preference and passes it to native capture: replacing %s", async (replacing) => {
    const current = fixture();
    current.context.phase = replacing ? "live" : "idle";
    current.nativeModeRef.current = replacing;
    Object.assign(current.client.health.nativeMedia, { captureBorderControl: true });
    await current.openPicker();
    current.context.nativeSources = current.setNativeSources.mock.calls.at(-1)![0];
    const target = { kind: "display", sourceId: "2", title: "Display 1" };
    current.context.startNativeShareFromPicker(target, false, true);
    expect(current.setShowCaptureBorder).toHaveBeenCalledWith(true);
    if (replacing) {
      await vi.waitFor(() => expect(current.client.replaceShareSource).toHaveBeenCalledWith(
        "share", target, false, { adapterIndex: 0, encoderIndex: 0 }, true, undefined,
      ));
    } else {
      const selection = current.startSharing.mock.calls[0]![0];
      expect(selection).toMatchObject({ kind: "native", target, audio: false, showCaptureBorder: true });
      current.client.startShare.mockRejectedValue(new Error("capture unavailable"));
      await expect(current.context.startNativeShare(1, "share", selection)).rejects.toThrow("capture unavailable");
      expect(current.client.startShare).toHaveBeenCalledWith(expect.objectContaining({ showCaptureBorder: true }), undefined);
    }
  });

  it("retains exclusion intent across audio off/on and a failed replacement until share retirement", async () => {
    const current = fixture();
    current.nativeModeRef.current = true;
    const target = { kind: "display", sourceId: "2", title: "Display" };
    const excluded = { kind: "window", sourceId: "3", pid: 123, creationTime: "456", title: "Voice fixture" };
    const path = { adapterIndex: 0, encoderIndex: 0 };
    for (const enabled of [true, false, true]) {
      await current.context.switchNativeSource(current.client, target, enabled, path, false, excluded);
      expect(current.nativeSourceSelectionRef.current).toMatchObject({ target, audio: enabled, excludeAudio: excluded });
      expect(current.client.replaceShareSource).toHaveBeenLastCalledWith("share", target, enabled, path, false, enabled ? excluded : undefined);
    }
    const next = { ...excluded, pid: 321, creationTime: "654" };
    current.client.replaceShareSource.mockRejectedValueOnce(new Error("audio unavailable"));
    await current.context.switchNativeSource(current.client, target, true, path, false, next);
    expect(current.nativeSourceSelectionRef.current).toMatchObject({ target, audio: true, excludeAudio: next });
    current.disposeNative();
    expect(current.nativeSourceSelectionRef.current).toBeNull();
  });

  it("changes native source audio without resetting sender quality or SFU publication", async () => {
    const current = fixture();
    current.nativeModeRef.current = true;
    current.routePolicyRef.current.topologyOptimization = true;
    const target = { kind: "display", sourceId: "2", title: "Display" };
    const path = { adapterIndex: 0, encoderIndex: 0 };
    current.nativeSourceSelectionRef.current = { target, path, client: current.client, showCaptureBorder: false, audio: true };
    const excluded = { kind: "window", sourceId: "3", pid: 123, creationTime: "456", title: "Voice" };
    await current.context.switchNativeSource(current.client, { ...target, title: "Renamed" }, true, path, false, excluded);
    expect(current.client.replaceShareSource).toHaveBeenCalledOnce();
    expect(current.invalidateSenderQualityEvidence).not.toHaveBeenCalled();
    expect(current.signalRef.current.send).not.toHaveBeenCalled();
    expect(current.hostSfuRouteRef.current.updateProfile).not.toHaveBeenCalled();
    expect(current.sourceSwitchRef.current).toBeNull();
  });

  it.each(["browser", "native"] as const)("keeps the %s selection until room work permits capture", async (kind) => {
    const current = fixture();
    current.context.phase = "idle";
    current.activeGenerationRef.current = null;
    current.nativeShareGenerationRef.current = null;
    const denied = new DOMException("cancelled", "NotAllowedError");
    const capture = vi.fn(async () => { throw denied; });
    current.context.captureBrowserSource = capture;
    current.client.startShare.mockRejectedValue(denied);
    await current.openPicker();
    current.context.nativeSources = current.setNativeSources.mock.calls.at(-1)![0];
    const request = current.nativeSourceRequestRef.current;
    const path = current.nativeSourcePathRef.current;
    const mutation = current.context.beginRoomMutation("access");
    let starting: Promise<void> | undefined;
    current.startSharing.mockImplementation(() => {
      starting = kind === "native" ? current.start() : current.startBrowser();
      return starting;
    });
    const confirm = () => kind === "native"
      ? current.context.startNativeShareFromPicker({}, false)
      : current.context.startBrowserShareFromPicker();
    confirm();
    await starting;
    expect(current.nativeSourceRequestRef.current).toBe(request);
    expect(current.nativeSourcePathRef.current).toBe(path);
    expect(current.client.startShare).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();

    current.context.finishRoomMutation(mutation);
    confirm();
    // Browser capture must still begin synchronously in the accepting gesture.
    if (kind === "browser") expect(capture).toHaveBeenCalledOnce();
    expect(current.nativeSourceRequestRef.current).toBeNull();
    await starting;
    if (kind === "native") expect(current.client.startShare).toHaveBeenCalledOnce();
  });

  it("retires an open switch picker and its control when sharing ends", async () => {
    const current = fixture();
    current.generationRef.current = current.activeGenerationRef.current!;
    current.nativeModeRef.current = true;
    await current.openPicker();
    expect(current.nativeSourceRequestRef.current).not.toBeNull();
    useRealResourceDisposal(current);
    Object.assign(current.signalRef, { current: null });
    current.context.endSharing({ key: "host.notice.stopped" });
    expect(current.nativeSourceRequestRef.current).toBeNull();
    expect(current.nativeSourcePathRef.current).toBeNull();
    expect(current.setNativeSources).toHaveBeenLastCalledWith(null);
    expect(current.client.close).toHaveBeenCalledOnce();
    expect(current.activeGenerationRef.current).toBeNull();
  });

  it.each(["browser", "app-browser", "native"])("keeps %s capture cancellation in the television status", async (entry) => {
    const current = fixture(entry !== "browser");
    const denied = new DOMException("private capture detail", "NotAllowedError");
    const setNoticeValue = vi.fn();
    Object.assign(current.context, {
      phase: "idle", setNoticeValue, setNoticeError: current.writeNoticeError,
      captureBrowserSource: vi.fn(async () => { throw denied; }),
    });
    current.activeGenerationRef.current = null;
    current.nativeShareGenerationRef.current = null;
    current.client.startShare.mockRejectedValue(denied);
    await (entry === "native" ? current.start() : current.startBrowser());
    expect(setNoticeValue).toHaveBeenLastCalledWith({
      kind: "key", key: "host.capture.cancelled",
      target: "television", comic: "hint-capture-browser", tone: "warn",
      failureCode: "browser/NotAllowedError",
    });
    expect(current.setPhase).toHaveBeenLastCalledWith("idle");
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.roomMutationRef.current).toBeNull();
  });

  it.each(["camera", "browser"])("keeps a rejected %s source change out of healthy media status", (source) => {
    const current = fixture();
    current.context.setCaptureError(new DOMException("denied", "NotAllowedError"), source, "source");
    expect(current.setNoticeValue).toHaveBeenLastCalledWith(expect.objectContaining({ target: "operation", tone: "warn" }));
    expect(current.setPhase).not.toHaveBeenCalled();
    expect(current.track.stop).not.toHaveBeenCalled();
  });

  it("rejects unavailable Browser media before starting native capture or creating a room", async () => {
    const current = fixture();
    const failure = new NativeMediaBridgeError("Preview unavailable", {
      cause: new DOMException("Peer connection rejected", "NotAllowedError"),
    });
    const report = vi.fn();
    Object.assign(current.context, { phase: "idle", debugError: report });
    current.activeGenerationRef.current = null;
    current.nativeShareGenerationRef.current = null;
    current.NativeMediaBridge.mockImplementationOnce(function () { throw failure; });
    await current.start();

    expect(current.client.startShare).not.toHaveBeenCalled();
    expect(current.client.stopShare).not.toHaveBeenCalled();
    expect(current.client.close).toHaveBeenCalledOnce();
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.roomMutationRef.current).toBeNull();
    expect(current.setPhase).toHaveBeenLastCalledWith("error");
    expect(current.setNoticeValue).toHaveBeenLastCalledWith(expect.objectContaining({
      target: "television", comic: "route-failed", tone: "bad",
    }));
    expect(report).toHaveBeenCalledWith("capture", "failed", failure, { action: "capture", source: undefined });
  });

  it.each(["reject", "cancel", "accept"])("owns the Browser reservation while native startup is pending: %s", async (outcome) => {
    const current = fixture();
    current.nativeShareGenerationRef.current = null;
    const started = deferred<{ audio: boolean; codec: "h264" }>();
    current.client.startShare.mockReturnValue(started.promise);
    const starting = current.startNative();
    const result = outcome === "accept" ? expect(starting).resolves.toBeDefined()
      : expect(starting).rejects.toThrow("capture unavailable");
    await vi.waitFor(() => expect(current.client.startShare).toHaveBeenCalledOnce());
    expect(current.nativeMediaBridgeRef.current).toBe(current.bridge);
    expect(current.nativeShareGenerationRef.current).toBeNull();
    expect(current.nativeModeRef.current).toBe(false);
    expect(current.bridge.start).not.toHaveBeenCalled();
    if (outcome === "accept") {
      // The App can supply its mixed audio track even when source audio was off.
      started.resolve({ audio: true, codec: "h264" });
    } else {
      if (outcome === "cancel") {
        current.activeGenerationRef.current = null;
        current.disposeNative();
        expect(current.bridge.dispose).toHaveBeenCalledOnce();
        expect(current.client.close).toHaveBeenCalledOnce();
      }
      started.reject(new Error("capture unavailable"));
    }
    await result;
    if (outcome === "accept") {
      expect(current.bridge.start).toHaveBeenCalledExactlyOnceWith(true);
      expect(current.nativeShareGenerationRef.current).toBe("share");
      expect(current.bridge.dispose).not.toHaveBeenCalled();
    } else {
      expect(current.bridge.dispose).toHaveBeenCalled();
      expect(current.nativeMediaBridgeRef.current).toBeNull();
      expect(current.client.stopShare).not.toHaveBeenCalled();
    }
  });

  it("offers Android confirmation for pending native capture, then keeps frame waiting passive", async () => {
    const current = fixture();
    Object.assign(current.client.health, { activationURL: "piik://media" });
    current.context.phase = "starting";
    current.nativeShareGenerationRef.current = null;
    const started = deferred<{ audio: boolean; codec: "h264" }>();
    const frames = deferred<Awaited<ReturnType<typeof current.bridge.start>>>();
    current.client.startShare.mockReturnValue(started.promise);
    current.bridge.start.mockReturnValue(frames.promise);
    const starting = current.startNative();
    await vi.waitFor(() => expect(current.client.startShare).toHaveBeenCalledOnce());
    expect(current.renderNativePermission()).toBe(true);
    current.context.confirmNativePermission();
    expect(current.window.location.assign).toHaveBeenCalledWith("intent://media#Intent;scheme=piik;package=tv.piik.android;end");
    started.resolve({ audio: false, codec: "h264" });
    await vi.waitFor(() => expect(current.bridge.start).toHaveBeenCalledOnce());
    expect(current.renderNativePermission()).toBe(false);
    frames.resolve(current.streamRef.current!);
    await starting;
    current.activeGenerationRef.current = null;
    current.context.confirmNativePermission();
    expect(current.window.location.assign).toHaveBeenCalledOnce();
  });

  it.each(["camera", "browser"])("retains the %s capture cause when presenting its notice", (source) => {
    const current = fixture();
    const report = vi.fn();
    current.context.debugError = report;
    const cause = new DOMException("Device unavailable", "NotReadableError");
    current.context.setCaptureError(cause, source, "capture");
    expect(report).toHaveBeenCalledWith("capture", "failed", cause, { action: "capture", source });
  });


  it("keeps a rejected source change as operation feedback while the current share stays live", async () => {
    const current = fixture();
    const denied = new DOMException("private capture detail", "NotAllowedError");
    const setNoticeValue = vi.fn();
    Object.assign(current.context, {
      setNoticeValue, setNoticeError: current.writeNoticeError,
    });
    current.client.replaceShareSource.mockRejectedValue(denied);
    await current.switchSource();
    expect(setNoticeValue).toHaveBeenLastCalledWith({
      kind: "key", key: "host.capture.cancelled",
      target: "operation", comic: "hint-capture-browser", tone: "warn",
      failureCode: "browser/NotAllowedError",
    });
    expect(current.setPhase).not.toHaveBeenCalled();
    expect(current.track.stop).not.toHaveBeenCalled();
  });

  it("keeps error keys until the actual page rendering uses the current language", () => {
    const current = fixture();
    const denied = new DOMException("private capture detail", "NotAllowedError");
    current.writeNoticeError(denied, "capture", "television");
    const notice = current.setNoticeValue.mock.lastCall![0];
    expect(notice).toMatchObject({ kind: "key", key: "host.capture.cancelled" });
    try {
      setCopy({ lang: "en" });
      expect(current.renderNotice(notice)).toBe("Screen selection cancelled or not permitted");
      setCopy({ lang: "zh" });
      expect(current.renderNotice(notice)).toBe("屏幕选择已取消或没有共享权限");
      current.context.setNoticeKey(hostServerErrorKey("ROOM_FULL"), "signal-failed", "bad");
      expect(current.renderNotice(current.setNoticeValue.mock.lastCall![0])).toBe("房间已满");
      current.writeNoticeError(new ApiError("HTTP failure with specific context", 403), "room");
      expect(current.renderNotice(current.setNoticeValue.mock.lastCall![0])).toBe("HTTP failure with specific context");
    } finally {
      setCopy({ lang: "zh" });
    }
  });

  it.each([
    { key: "host.stopNotice", comic: "share-ended", tone: "off" },
    { key: "host.shareEnded", comic: "source-failed", tone: "bad" },
  ])("keeps the share ending reason and tone together in the television: $tone", ({ key, comic, tone }) => {
    const current = fixture();
    const setNoticeValue = vi.fn();
    current.context.setNoticeValue = setNoticeValue;
    current.generationRef.current = 1;
    current.context.endSharing({ key }, false, comic, tone);
    expect(setNoticeValue).toHaveBeenCalledExactlyOnceWith({
      kind: "key", key, vars: undefined,
      target: "television", comic, tone,
    });
    expect(current.setPhase).toHaveBeenLastCalledWith("ended");
    expect(current.activeGenerationRef.current).toBeNull();
  });

  it.each([
    ["capture", "host.shareEnded", "app/capture/failed", "source-failed"],
    ["media", "native.fail.edge", "app/browser-media/connection", "route-failed"],
    ["control", "native.fail.controlDisconnected", "app/control/disconnected", "route-failed"],
  ])("retains the known %s failure when retiring native sharing", async (kind, key, failureCode, comic) => {
    const current = fixture();
    current.generationRef.current = 1;
    await current.startNative();
    if (kind === "control") current.client.onClose.mock.calls[0]![0]();
    else if (kind === "media") current.NativeMediaBridge.mock.calls[0]![2]();
    else current.client.onEvent.mock.calls[0]![0]({ type: "share-ended", shareId: "share", failed: true });
    expect(current.setNoticeValue).toHaveBeenLastCalledWith({
      kind: "key", key, vars: undefined, failureCode, target: "television", comic, tone: "bad",
    });
    expect(current.disposeResources).toHaveBeenCalledExactlyOnceWith(true, false);
    expect(current.activeGenerationRef.current).toBeNull();
  });

  it("retains connecting children during reconciliation and rebuilds them after reauthentication", async () => {
    const current = fixture(false);
    current.nativeConnection.release();
    current.peer.isConnected.mockReturnValue(false);
    const healthy = { ...current.peer, isConnected: vi.fn(() => true) };
    const replacement = { ...current.peer, start: vi.fn(async () => true) };
    current.peersRef.current.set("healthy", healthy);
    current.removePeer.mockImplementation((peerId: string) => current.peersRef.current.delete(peerId));
    const createPeer = vi.fn(function () { return replacement; });
    Object.assign(current.context, {
      startPeer: current.startChild, HostPeer: createPeer, browserVideoPool: () => null,
      iceConfigRef: ref({ iceServers: [] }),
      hostChildIsAssigned: (peerId: string) => current.activeHostChildPeerIdsRef.current.includes(peerId),
    });
    const reconcile = () => current.context.reconcileHostChildren(["viewer", "healthy"], 1);
    reconcile();
    expect(current.removePeer).not.toHaveBeenCalled();
    expect(current.peersRef.current.get("viewer")).toBe(current.peer);
    expect(createPeer).not.toHaveBeenCalled();

    current.route.resyncAuthoritative.mockImplementation(async () => { reconcile(); });
    current.reauthenticate();
    await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledOnce());
    expect(current.removePeer).toHaveBeenCalledExactlyOnceWith("viewer");
    expect(current.peersRef.current.get("viewer")).toBe(replacement);
    expect(current.peersRef.current.get("healthy")).toBe(healthy);
    expect(createPeer).toHaveBeenCalledOnce();
  });

  it("opens the same source picker for Browser and App without probing localhost on the Browser path", async () => {
    const browser = fixture(false);
    browser.nativeConnection.release();
    browser.requestShare();
    expect(browser.startSharing).not.toHaveBeenCalled();
    expect(browser.openCaptureSourcePicker).toHaveBeenCalledOnce();
    await browser.openPicker();
    expect(browser.setNativeSources).toHaveBeenLastCalledWith({ kind: "browser" });
    expect(browser.NativeClient.connect).not.toHaveBeenCalled();

    const current = fixture();
    current.nativeConnection.release();
    current.routePolicyRef.current.topologyOptimization = true;
    const discovery = deferred<typeof current.client | null>();
    current.NativeClient.connect.mockReturnValue(discovery.promise);
    const attempt = current.discover();
    current.requestShare();
    expect(current.openCaptureSourcePicker).toHaveBeenCalledTimes(1);
    expect(current.discover()).toBe(attempt);
    await current.startOptionalIngress();
    discovery.resolve(null);
    await attempt;
    expect(current.NativeClient.connect).toHaveBeenCalledTimes(1);
    current.NativeClient.connect.mockResolvedValue(current.client);
    await expect(current.discover()).resolves.toBe(current.client);
    expect(current.NativeClient.connect).toHaveBeenCalledTimes(2);
    current.nativeConnection.adopt(current.client as unknown as NativeClient);
    current.requestShare();
    expect(current.openCaptureSourcePicker).toHaveBeenCalledTimes(2);
  });

  it("refreshes a waiting picker after App approval without changing a live Browser share", async () => {
    const current = fixture(false);
    current.context.phase = "idle";
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith({ kind: "browser" });
    expect(current.client.sources).not.toHaveBeenCalled();

    current.isClientActivated.mockReturnValue(true);
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready" }));
    expect(current.client.sources).toHaveBeenCalledOnce();

    let sources: NativeSourceList | null = current.setNativeSources.mock.lastCall![0];
    current.setNativeSources.mockImplementation((next: NativeSourceList | null | ((previous: NativeSourceList | null) => NativeSourceList)) => {
      sources = typeof next === "function" ? next(sources) : next;
    });
    const enumeration = deferred<never[]>();
    current.client.sources.mockReturnValueOnce(enumeration.promise);
    const refresh = current.openPicker();
    await vi.waitFor(() => expect(current.client.sources).toHaveBeenCalledTimes(2));
    expect(sources).toEqual({ kind: "loading", appDetected: true, sources: [] });
    enumeration.resolve([]);
    await refresh;
    expect(sources).toMatchObject({ kind: "ready", sources: [] });

    current.context.phase = "live";
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready" }));
    expect(current.client.sources).toHaveBeenCalledTimes(3);
    expect(current.streamRef.current).not.toBeNull();
  });

  it("shows App incompatibility in the picker and clears it on a successful refresh", async () => {
    const current = fixture();
    current.context.phase = "idle";
    current.nativeConnection.release();
    current.nativeShareGenerationRef.current = null;
    current.NativeClient.connect.mockRejectedValueOnce(new NativeCompatibilityError(8));
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith({ kind: "incompatible" });
    expect(current.nativeConnection.current).toBeNull();
    expect(current.client.sources).not.toHaveBeenCalled();
    current.NativeClient.connect.mockResolvedValue(current.client);
    await current.openPicker();
    expect(current.NativeClient.connect).toHaveBeenCalledTimes(2);
    expect(current.setNativeSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready" }));
    current.closePicker();
  });

  it("distinguishes absent App, missing capture capability, incompatible codec and an empty source list", async () => {
    const absent = fixture();
    absent.context.phase = "idle";
    absent.nativeConnection.release();
    await absent.openPicker();
    expect(absent.setNativeSources).toHaveBeenLastCalledWith({ kind: "unavailable" });

    const unsupported = fixture();
    unsupported.context.phase = "idle";
    unsupported.client.health.nativeMedia.video = false;
    await unsupported.openPicker();
    expect(unsupported.setNativeSources).toHaveBeenLastCalledWith({ kind: "unsupported" });
    expect(unsupported.client.sources).not.toHaveBeenCalled();

    const codec = fixture();
    codec.context.phase = "idle";
    codec.context.defaultNativeCapturePath = () => null;
    await codec.openPicker();
    expect(codec.setNativeSources).toHaveBeenLastCalledWith({ kind: "unsupported" });

    const empty = fixture();
    empty.context.phase = "idle";
    await empty.openPicker();
    expect(empty.setNativeSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready", sources: [] }));
  });

  it("reports listing failure separately and reconnects on refresh", async () => {
    const current = fixture();
    current.context.phase = "idle";
    current.nativeShareGenerationRef.current = null;
    current.client.sources.mockRejectedValueOnce(new Error("capture helper exited"));
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith({ kind: "failed" });
    expect(current.client.close).toHaveBeenCalledOnce();
    const replacement = { ...current.client, close: vi.fn() };
    current.NativeClient.connect.mockResolvedValue(replacement);
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready" }));
    current.closePicker();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("keeps a live Native share when source enumeration fails", async () => {
    const current = fixture();
    current.nativeModeRef.current = true;
    current.client.sources.mockRejectedValueOnce(new Error("list failed"));
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith({ kind: "failed" });
    expect(current.client.close).not.toHaveBeenCalled();
    expect(current.client.stopShare).not.toHaveBeenCalled();
    expect(current.nativeConnection.current).toBe(current.client);
  });

  it("ignores a cancelled discovery mismatch after another picker owns a compatible App", async () => {
    const current = fixture(true, false);
    current.context.phase = "idle";
    current.nativeShareGenerationRef.current = null;
    const discovery = deferred<void>();
    current.NativeClient.connect.mockReturnValueOnce(discovery.promise.then(() => {
      throw new NativeCompatibilityError(8);
    }));
    const obsolete = current.openPicker();
    await vi.waitFor(() => expect(current.NativeClient.connect).toHaveBeenCalledOnce());
    current.closePicker();
    current.NativeClient.connect.mockResolvedValue(current.client);
    await current.openPicker();
    current.setNativeSources.mockClear();
    discovery.resolve();
    await obsolete;
    expect(current.setNativeSources).not.toHaveBeenCalled();
    expect(current.client.close).not.toHaveBeenCalled();
    expect(current.nativeConnection.current).toBe(current.client);
    current.closePicker();
  });

  it("fails the full startup before room creation when App retires during cleanup", async () => {
    const current = fixture();
    current.context.phase = "idle";
    current.activeGenerationRef.current = null;
    current.nativeShareGenerationRef.current = null;
    current.routePolicyRef.current.topologyOptimization = true;
    const cleanup = deferred<void>();
    current.nativeShareCleanupRef.current = cleanup.promise;
    const starting = current.start();
    await Promise.resolve();
    expect(current.client.startShare).not.toHaveBeenCalled();
    current.nativeConnection.release();
    cleanup.resolve();
    await starting;
    expect(current.client.startShare).not.toHaveBeenCalled();
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.setPhase).toHaveBeenLastCalledWith("error");
    expect(current.setNoticeError).toHaveBeenCalledOnce();
    expect(current.activeGenerationRef.current).toBeNull();
    expect(current.roomMutationRef.current).toBeNull();
  });

  it("retires discovery after picker cancellation and allows a later attempt", async () => {
    const current = fixture(true, false);
    current.context.phase = "idle";
    current.nativeShareGenerationRef.current = null;
    const discovery = deferred<typeof current.client>();
    current.NativeClient.connect.mockReturnValueOnce(discovery.promise);
    const opening = current.openPicker();
    await vi.waitFor(() => expect(current.NativeClient.connect).toHaveBeenCalledOnce());
    const signal = current.NativeClient.connect.mock.calls[0]![0]!.signal;
    expect(signal.aborted).toBe(false);
    current.closePicker();
    expect(signal.aborted).toBe(true);
    discovery.resolve(current.client);
    await opening;
    expect(current.client.close).toHaveBeenCalledOnce();
    expect(current.client.sources).not.toHaveBeenCalled();
    expect(current.nativeConnection.current).toBeNull();

    const replacement = { ...current.client, close: vi.fn() };
    current.NativeClient.connect.mockResolvedValue(replacement);
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready" }));
    current.closePicker();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it.each(["probe", "ingress"])("does not commit Browser codec state after sharing ends during %s", async (stage) => {
    const current = fixture(false);
    current.activeGenerationRef.current = null;
    current.nativeShareGenerationRef.current = null;
    const probe = deferred<{ primary: string }>();
    const ingress = deferred<void>();
    const captured = { getTracks: () => [current.track] };
    const resolveStreamVideoCodec = vi.fn(() => probe.promise);
    const startBrowserNativeIngress = vi.fn(() => ingress.promise);
    const setResolvedVideoCodec = vi.fn();
    Object.assign(current.context, {
      phase: "idle", captureBrowserSource: async () => captured,
      HostAudio: class {
        audioAvailable = false;
        sourceStream = captured;
        start = async () => captured;
        dispose = vi.fn();
        setVolume = vi.fn();
      }, setStream: vi.fn(), watchCaptureEnd: vi.fn(),
      resolveStreamVideoCodec, startBrowserNativeIngress, setResolvedVideoCodec,
    });
    current.disposeResources.mockImplementation(() => {
      current.videoCodecRef.current = { primary: "vp8" };
      setResolvedVideoCodec(null);
    });
    const starting = current.startBrowser();
    await vi.waitFor(() => expect(resolveStreamVideoCodec).toHaveBeenCalledOnce());
    if (stage === "ingress") {
      probe.resolve({ primary: "h264" });
      await vi.waitFor(() => expect(startBrowserNativeIngress).toHaveBeenCalledOnce());
    }
    current.context.endSharing({ key: "host.notice.stopped" });
    setResolvedVideoCodec.mockClear();
    probe.resolve({ primary: "h264" });
    ingress.resolve();
    await starting;
    expect(current.videoCodecRef.current.primary).toBe("vp8");
    expect(setResolvedVideoCodec).not.toHaveBeenCalled();
    expect(startBrowserNativeIngress).toHaveBeenCalledTimes(stage === "ingress" ? 1 : 0);
    expect(current.track.stop).toHaveBeenCalled();
    expect(current.createRoom).not.toHaveBeenCalled();
    expect(current.roomMutationRef.current).toBeNull();
  });

  it("retires a cancelled start ACK before publishing audio, codec or connecting the bridge", async () => {
    const current = fixture();
    current.nativeShareGenerationRef.current = null;
    const started = deferred<{ audio: boolean; codec: "h264" }>();
    current.client.startShare.mockReturnValue(started.promise);
    const starting = current.startNative();
    await vi.waitFor(() => expect(current.client.startShare).toHaveBeenCalledOnce());
    current.activeGenerationRef.current = null;
    started.resolve({ audio: false, codec: "h264" });
    await expect(starting).resolves.toBeNull();
    expect(current.client.stopShare).toHaveBeenCalledWith("share");
    expect(current.nativeSourceAudioRef.current).toBeUndefined();
    expect(current.manualVideoCodecPreference).not.toHaveBeenCalled();
    expect(current.NativeMediaBridge).toHaveBeenCalledOnce();
    expect(current.bridge.start).not.toHaveBeenCalled();
    expect(current.bridge.dispose).toHaveBeenCalledOnce();
    expect(current.nativeMediaBridgeRef.current).toBeNull();
    expect(current.setNativeActive).not.toHaveBeenCalled();
  });

  it("ignores a stale listing failure after a newer picker owns the App", async () => {
    const current = fixture();
    current.context.phase = "idle";
    current.nativeShareGenerationRef.current = null;
    const listing = deferred<never>();
    current.client.sources.mockReturnValueOnce(listing.promise.then(() => { throw new Error("old listing failed"); }));
    const old = current.openPicker();
    await vi.waitFor(() => expect(current.client.sources).toHaveBeenCalledOnce());
    await current.openPicker();
    current.setNativeSources.mockClear();
    listing.resolve(undefined as never);
    await old;
    expect(current.client.close).not.toHaveBeenCalled();
    expect(current.nativeConnection.current).toBe(current.client);
    expect(current.setNativeSources).not.toHaveBeenCalled();
    current.closePicker();
  });

  it("retains control for Native media but releases unused Browser and ended-share control", () => {
    const current = fixture();
    current.releaseUnused();
    expect(current.client.close).not.toHaveBeenCalled();
    current.disposeNative("older-share");
    expect(current.client.stopShare).not.toHaveBeenCalled();
    current.disposeNative("share");
    expect(current.client.stopShare).toHaveBeenCalledWith("share");
    expect(current.client.close).toHaveBeenCalledOnce();

    const browser = fixture();
    browser.nativeShareGenerationRef.current = null;
    browser.roomMutationRef.current = {};
    browser.releaseUnused();
    expect(browser.client.close).not.toHaveBeenCalled();
    browser.context.finishRoomMutation(browser.roomMutationRef.current);
    expect(browser.client.close).toHaveBeenCalledOnce();
  });

  it.each([false, "reject"])("keeps applied Browser capture after optional ingress fails: %s", async (failure) => {
    const current = fixture();
    const optional = ingress();
    current.nativeMediaIngressRef.current = optional;
    optional.updateProfile.mockImplementation(async () => {
      expect(current.qualitySettingsRef.current).toEqual(lower);
      expect(current.signalRef.current.setHostQualitySettings).toHaveBeenCalledWith(lower);
      if (failure === "reject") throw new Error("ingress failed");
      return false;
    });
    await current.change(lower);
    expect(current.physical()).toEqual(lower);
    expect(current.qualitySettingsRef.current).toEqual(lower);
    expect(current.advancedQualityRef.current).toEqual(lower);
    expect(current.savePreferredQuality).toHaveBeenCalledWith(lower);
    expect(current.peer.updateCaptureProfile).toHaveBeenCalledWith(lower);
    expect(optional.dispose).toHaveBeenCalledOnce();
    expect(current.client.stopReceive).toHaveBeenCalledWith("share");
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(current.setNoticeError).not.toHaveBeenCalled();
  });

  it("retains the committed settings when Browser capture constraints reject", async () => {
    const current = fixture();
    const optional = ingress();
    current.nativeMediaIngressRef.current = optional;
    current.applyCaptureProfile.mockRejectedValue(new Error("capture rejected"));
    await current.change(lower);
    expect(current.physical()).toEqual(original);
    expect(current.savePreferredQuality).not.toHaveBeenCalled();
    expect(current.qualitySettingsRef.current).toEqual(original);
    expect(current.advancedQualityRef.current).toEqual(original);
    expect(optional.updateProfile).not.toHaveBeenCalled();
    expect(current.signalRef.current.setHostQualitySettings).not.toHaveBeenCalled();
  });

  it.each(["peer", "sfu"])("shows partial %s settings application as a limitation and clears it after success", async (failure) => {
    const current = fixture();
    if (failure === "peer") current.peer.updateCaptureProfile.mockResolvedValueOnce(false);
    else current.route.updateProfile.mockResolvedValueOnce(false);
    await current.change(lower);
    expect(current.qualitySettingsRef.current).toEqual(lower);
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(current.setNoticeValue).toHaveBeenLastCalledWith({
      kind: "text", text: "host.notice.partialApply", target: "operation", comic: "settings-failed", tone: "warn",
    });
    await current.change(original);
    expect(current.setNoticeValue).toHaveBeenLastCalledWith({
      kind: "text", text: "host.notice.qualitySet", target: "operation", comic: "hint-quality", tone: "live",
    });
  });

  it("keeps a committed Native source change with an SFU failure in recovery rather than success", async () => {
    const current = fixture();
    current.route.updateProfile.mockResolvedValueOnce(false);
    await current.switchSource();
    expect(current.client.replaceShareSource).toHaveBeenCalledOnce();
    expect(current.setPhase).not.toHaveBeenCalled();
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(current.setNoticeValue).toHaveBeenLastCalledWith({
      kind: "text", text: "source-switch-result", target: "operation", comic: "connecting-sfu", tone: "warn",
    });
  });

  it("does not commit a capture completion after its share has ended", async () => {
    const current = fixture();
    const pending = deferred<void>();
    current.applyCaptureProfile.mockReturnValue(pending.promise);
    const changing = current.change(lower);
    current.activeGenerationRef.current = null;
    current.qualityChangeRef.current = null;
    pending.resolve();
    await changing;
    expect(current.qualitySettingsRef.current).toEqual(original);
    expect(current.savePreferredQuality).not.toHaveBeenCalled();
    expect(current.signalRef.current.setHostQualitySettings).not.toHaveBeenCalled();
  });

  it.each(["replacement", "ended"])("does not retire another ingress after an old update settles: %s", async (change) => {
    const current = fixture();
    const old = ingress(), replacement = ingress(), pending = deferred<boolean>();
    old.updateProfile.mockReturnValue(pending.promise);
    current.nativeMediaIngressRef.current = old;
    const changing = current.change(lower);
    await vi.waitFor(() => expect(old.updateProfile).toHaveBeenCalled());
    current.nativeMediaIngressRef.current = replacement;
    if (change === "ended") {
      current.activeGenerationRef.current = null;
      current.qualityChangeRef.current = null;
    }
    pending.resolve(false);
    await changing;
    expect(old.dispose).not.toHaveBeenCalled();
    expect(replacement.dispose).not.toHaveBeenCalled();
    expect(current.nativeMediaIngressRef.current).toBe(replacement);
    if (change === "ended") expect(current.peer.updateCaptureProfile).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves an active draft through reauthentication and commits its queued result: %s", async (queued) => {
    const current = fixture();
    const pending = deferred<void>();
    current.applyCaptureProfile.mockReturnValueOnce(pending.promise);
    const changing = current.change(lower);
    const latest = queued ? QUALITY_PROFILES["1080p60"] : lower;
    if (queued) await current.change(latest);
    current.reauthenticate();
    expect(current.qualitySettingsRef.current).toEqual(original);
    expect(current.advancedQualityRef.current).toEqual(latest);
    pending.resolve();
    await changing;
    await vi.waitFor(() => expect(current.qualitySettingsRef.current).toEqual(latest));
    expect(current.advancedQualityRef.current).toEqual(latest);
    expect(current.pendingQualityChangeRef.current).toBeNull();
  });

  it("does not overwrite a new notice after a stale Native source-switch SFU update", async () => {
    const current = fixture();
    const pending = deferred<boolean>();
    current.route.updateProfile.mockReturnValue(pending.promise);
    const switching = current.switchSource();
    await vi.waitFor(() => expect(current.route.updateProfile).toHaveBeenCalled());
    current.activeGenerationRef.current = 2;
    current.sourceSwitchRef.current = null;
    current.context.setNotice("new-share", "share-live", "live");
    pending.resolve(true);
    await switching;
    expect(current.setNoticeValue).toHaveBeenLastCalledWith({
      kind: "text", text: "new-share", target: "operation", comic: "share-live", tone: "live",
    });
    expect(current.setNoticeValue).not.toHaveBeenCalledWith(expect.objectContaining({ text: "source-switch-result" }));
  });

  it("uses the current committed profile when reauthentication SFU recovery finishes late", async () => {
    const current = fixture();
    const pending = deferred<void>();
    current.route.resyncAuthoritative.mockReturnValue(pending.promise);
    current.reauthenticate();
    await current.change(lower);
    current.route.updateProfile.mockClear();
    pending.resolve();
    await vi.waitFor(() => expect(current.route.updateProfile).toHaveBeenCalledOnce());
    expect(current.route.updateProfile).toHaveBeenCalledWith(lower);
  });
});
