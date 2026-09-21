import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  QUALITY_PROFILES, qualitySettingsEqual, qualitySettingsLabel,
  resolveScreenAudioQuality, videoQualitySettingsEqual,
  type QualitySettings,
} from "../src/client/media/quality";
import { NativeSenderPeer } from "../src/client/native/native-sender-peer";
import { NativeCompatibilityError } from "../src/client/native/client";
import { reconcileBoundedMediaChildren } from "../src/client/webrtc/media-assignment";
import { debugError, debugEvent, debugOperation } from "../src/client/lib/debug";
import { hostActionErrorNotice, isCapturePermissionFailure } from "../src/client/pages/host-page-notices";

// Exercise the actual page owners without mounting capture hardware or a Browser.
const source = ts.createSourceFile("HostPage.tsx", readFileSync(
  new URL("../src/client/pages/HostPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = new Set(["changeQuality", "commitQuality", "handleSignalMessage",
  "switchSource", "watchCaptureEnd", "switchNativeSource", "finishSourceSwitch", "replaceBrowserStream", "recoverBrowserFanout", "disposeNativeShare",
  "acquireNativeClient", "requestSharing", "startNativeShare", "startBrowserNativeIngress",
  "ownNativeClient", "discardNativeClient", "releaseUnusedNativeClient", "closeCaptureSourcePicker",
  "openCaptureSourcePicker", "startBrowserShareFromPicker", "startNativeShareFromPicker",
  "startSharing", "beginRoomMutation", "finishRoomMutation", "setCaptureError", "changeMicrophone", "toggleSharingPause",
  "startPeer", "reconcileHostChildren", "setNotice", "setNoticeKey", "setNoticeError", "setNoticeErrorKey", "endSharing", "copyRoomLink", "isCurrentRoomAuthority"]);
const functions: string[] = [];
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && owners.has(node.name.text)) {
    functions.push(node.getText(source));
    owners.delete(node.name.text);
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (owners.size) throw new Error(`Missing Host owner: ${[...owners].join(", ")}`);
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

function fixture(launchedByClient = true) {
  let physical: QualitySettings = original;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const peer = { updateCaptureProfile: vi.fn(async () => true), updateProfile: vi.fn(async () => true),
    isConnected: vi.fn(() => true) };
  const client = { updateShare: vi.fn(async () => undefined), replaceShareSource: vi.fn(async () => undefined),
    startShare: vi.fn(async (): Promise<{ audio: boolean; codec: "h264" }> => ({ audio: false, codec: "h264" })),
    onEvent: vi.fn((_listener: (event: unknown) => void) => () => undefined),
    close: vi.fn(), onClose: vi.fn(() => () => undefined),
    health: { nativeMedia: { video: true, hardwareH264: true, softwareVP8: true } },
    captureOptions: vi.fn(async () => []), sources: vi.fn(async () => []),
    stopReceive: vi.fn(async () => undefined), stopShare: vi.fn(async () => undefined) };
  const route = { updateProfile: vi.fn(async () => true), resyncAuthoritative: vi.fn(async (): Promise<void> => undefined) };
  const state = {
    debugError, debugEvent, debugOperation, NativeCompatibilityError, isCapturePermissionFailure, DOMException,
    launchedByClient, NativeClient: { connect: vi.fn(async (): Promise<typeof client | null> => null) },
    nativeClientConnectRef: ref<Promise<typeof client | null> | null>(null),
    ownNativeClient: vi.fn(), setJoiningRoom: vi.fn(), startSharing: vi.fn(), openCaptureSourcePicker: vi.fn(),
    videoCodecRef: ref({ primary: "h264" }),
    videoCodecModeRef: ref("h264"), MAX_ENDPOINT_MEDIA_CHILDREN: 2,
    nativeClientCloseCleanupRef: ref<(() => void) | null>(null),
    sourcePickerReturnRef: ref<{ id: string; restore: boolean } | null>(null),
    nativeSourceRequestRef: ref<object | null>(null), nativeSourcePathRef: ref<unknown>(null),
    setNativeSources: vi.fn(), setShowCaptureBorder: vi.fn(), defaultNativeCapturePath: () => ({ adapterIndex: 0, encoderIndex: 0 }),
    roomMutationRef: ref<object | null>(null), setRoomMutation: vi.fn(),
    generationRef: ref(0), shareGenerationRef: ref<string | null>("share"), createOpaqueId: () => "share",
    setCopiedRoomLink: vi.fn(), setPhase: vi.fn(), roomInitializationRef: ref(Promise.resolve()), roomRef: ref(null),
    createRoom: vi.fn(async () => { throw new Error("must not create an empty room"); }),
    readPreferredRoomId: () => null, disposeResources: vi.fn(), ApiError: class extends Error {},
    NativeMediaBridge: vi.fn(), manualVideoCodecPreference: vi.fn(),
    phase: "live", qualitySettingsRef: ref<QualitySettings>(original), advancedQualityRef: ref<QualitySettings>(original),
    qualityChangeRef: ref<object | null>(null), pendingQualityChangeRef: ref<QualitySettings | null>(null),
    activeGenerationRef: ref<number | null>(1), streamRef: ref<typeof stream | null>(stream), sourceSwitchRef: ref<object | null>(null),
    nativeSourceAudioRef: ref<boolean | undefined>(undefined), setMicrophoneEnabled: vi.fn(),
    nativeModeRef: ref(false), nativeClientRef: ref<typeof client | null>(client), nativeShareGenerationRef: ref<string | null>("share"),
    hostAudioRef: ref<{ sourceStream: MediaStream } | null>(null),
    nativeMediaIngressRef: ref<ReturnType<typeof ingress> | null>(null), nativeMediaBridgeRef: ref(null),
    nativeEventCleanupRef: ref(null), nativeShareCleanupRef: ref(Promise.resolve()),
    peersRef: ref(new Map([["viewer", peer]])), hostProvisionalChildRef: ref(null), hostSfuRouteRef: ref(route),
    signalRef: ref({ setHostQualitySettings: vi.fn(), send: vi.fn() }),
    setQualitySettings: vi.fn(), setAdvancedQuality: vi.fn(), setChangingQuality: vi.fn(),
    setNoticeValue: vi.fn(), setNoticeError: vi.fn(), readableError: hostActionErrorNotice,
    setDetails: vi.fn(), setNativeActive: vi.fn(),
    applyCaptureProfile: vi.fn(async (_stream: unknown, profile: QualitySettings) => { physical = profile; }),
    captureDetails: () => ({}),
    qualitySettingsEqual, videoQualitySettingsEqual, resolveScreenAudioQuality, qualitySettingsLabel,
    say: (key: string) => key, syncHostSfuQualityWarning: () => null,
    NativeSenderPeer, discardPreparedHostChild: vi.fn(), removePeer: vi.fn(), startPeer: vi.fn(async () => undefined),
    nativePreviewTailRef: ref(Promise.resolve()), setSwitchingSource: vi.fn(),
    invalidateSenderQualityEvidence: vi.fn(), routePolicyRef: ref({ topologyOptimization: false }),
    sourceSwitchNotice: () => "source-switch-result", hostPeerIdRef: ref(null), endpointMediaCopyCapacityRef: ref(2),
    creationProfileRef: ref({ roomPassword: null }), saveCreationProfile: vi.fn(), setCreationProfile: vi.fn(),
    setViewerPasswordEnabled: vi.fn(), setViewerPasswordDraft: vi.fn(), setViewerPasswordVisible: vi.fn(),
    setRoutePolicy: vi.fn(), setRoom: vi.fn(), activeRouteRevisionRef: ref(1),
    ensureHostSfuRoute: () => route,
    reconcileBoundedMediaChildren, activeHostChildPeerIdsRef: ref<string[]>([]),
  };
  const context = createContext({ ...state,
    isCurrentGeneration: (generation: number) => state.activeGenerationRef.current === generation,
    isCurrentShare: (generation: number, share: string) =>
      state.activeGenerationRef.current === generation && state.shareGenerationRef.current === share,
  });
  runInContext(executable, context);
  const start = context.startSharing;
  const startChild = context.startPeer;
  const openPicker = context.openCaptureSourcePicker;
  const writeNoticeError = context.setNoticeError;
  state.setNoticeError.mockImplementation(writeNoticeError);
  context.setNoticeError = state.setNoticeError;
  context.startSharing = state.startSharing;
  context.startPeer = state.startPeer;
  context.openCaptureSourcePicker = state.openCaptureSourcePicker;
  return { ...state, peer, client, route, track, physical: () => physical,
    context, startChild, openPicker: openPicker as () => Promise<void>,
    closePicker: context.closeCaptureSourcePicker as () => void,
    releaseUnused: context.releaseUnusedNativeClient as () => void,
    disposeNative: context.disposeNativeShare as (expectedShare?: string) => void,
    start: () => start( { kind: "native", client, target: {}, audio: false, path: {} }) as Promise<void>,
    startBrowser: () => start({ kind: "browser" }) as Promise<void>,
    writeNoticeError,
    discover: context.acquireNativeClient as () => Promise<typeof client | null>,
    requestShare: context.requestSharing as () => void,
    startNative: () => context.startNativeShare(1, "share", { client, target: {}, audio: false, path: {} }) as Promise<unknown>,
    startOptionalIngress: () => context.startBrowserNativeIngress(1, "share", stream) as Promise<void>,
    change: context.changeQuality as (profile: QualitySettings) => Promise<void>,
    reauthenticate: () => context.handleSignalMessage({ type: "authenticated", role: "host", qualitySettings: original,
      routePolicy: {}, routeRevision: 1, endpointMediaCopyCapacity: 2 }, 1, { roomId: "room" }, true, null),
    switchSource: () => context.switchNativeSource(client, {}, false, {}),
  };
}

describe("Camera replacement ownership", () => {
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
  it("refreshes source details from the capture input after microphone mixing", async () => {
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
        "share", target, false, { adapterIndex: 0, encoderIndex: 0 }, true,
      ));
    } else {
      const selection = current.startSharing.mock.calls[0]![0];
      expect(selection).toMatchObject({ kind: "native", target, audio: false, showCaptureBorder: true });
      current.client.startShare.mockRejectedValue(new Error("capture unavailable"));
      await expect(current.context.startNativeShare(1, "share", selection)).rejects.toThrow("capture unavailable");
      expect(current.client.startShare).toHaveBeenCalledWith(expect.objectContaining({ showCaptureBorder: true }));
    }
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
    current.disposeResources.mockImplementation(() => current.disposeNative());
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
      readableError: hostActionErrorNotice,
      captureBrowserSource: vi.fn(async () => { throw denied; }),
    });
    current.activeGenerationRef.current = null;
    current.nativeShareGenerationRef.current = null;
    current.client.startShare.mockRejectedValue(denied);
    await (entry === "native" ? current.start() : current.startBrowser());
    expect(setNoticeValue).toHaveBeenLastCalledWith({
      kind: "text", text: hostActionErrorNotice(denied, "capture"),
      target: "television", comic: "hint-capture-browser", tone: "warn",
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

  it.each(["success", "replace-failed", "stopped"])("retires the whole microphone operation after stream replacement: %s", async outcome => {
    const current = fixture();
    const permission = deferred<MediaStream>();
    const video = { stop: vi.fn() };
    const raw = { getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] };
    const mixed = { ...raw, getAudioTracks: () => [{}] } as unknown as MediaStream;
    const pending = vi.fn();
    Object.assign(current.context, {
      hostAudioRef: ref({ sourceStream: raw, setMicrophoneVolume: vi.fn(), setMicrophone: () => permission.promise }),
      streamRef: ref(raw), retiringStreamRef: ref(null), sharingPausedRef: ref(false),
      microphoneVolume: 1, setMicrophonePending: pending, setMicrophoneDevices: vi.fn(),
      setStream: vi.fn(), setMediaPaused: vi.fn(), peersRef: ref(new Map()),
      hostSfuRouteRef: ref(outcome === "replace-failed" ? { replaceStream: async () => { throw Error("replacement failed"); } } : null),
    });
    const changing = current.context.changeMicrophone(true, "");
    expect(pending).toHaveBeenLastCalledWith(true);
    if (outcome === "stopped") {
      current.activeGenerationRef.current = null;
      current.sourceSwitchRef.current = {};
      pending.mockClear();
    }
    permission.resolve(mixed);
    await changing;
    if (outcome === "stopped") {
      expect(pending).not.toHaveBeenCalled();
      expect(current.context.setStream).not.toHaveBeenCalled();
    } else {
      expect(pending).toHaveBeenLastCalledWith(false);
      expect(current.sourceSwitchRef.current).toBeNull();
      expect(video.stop).not.toHaveBeenCalled();
      if (outcome === "replace-failed") expect(current.setNoticeValue).toHaveBeenLastCalledWith(
        expect.objectContaining({ key: "host.microphone.unavailable", target: "operation" }));
    }
  });

  it("keeps microphone denial as operation feedback without retiring video", async () => {
    const current = fixture();
    Object.assign(current.context, {
      hostAudioRef: ref({ setMicrophoneVolume: vi.fn(), setMicrophone: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }) }),
      sharingPausedRef: ref(false), microphoneVolume: 1, setMicrophonePending: vi.fn(),
    });
    await current.context.changeMicrophone(true, "");
    expect(current.setNoticeValue).toHaveBeenLastCalledWith(expect.objectContaining({ key: "host.microphone.denied", target: "operation" }));
    expect(current.setPhase).not.toHaveBeenCalled();
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(current.sourceSwitchRef.current).toBeNull();
  });

  it("keeps a rejected source change as operation feedback while the current share stays live", async () => {
    const current = fixture();
    const denied = new DOMException("private capture detail", "NotAllowedError");
    const setNoticeValue = vi.fn();
    Object.assign(current.context, {
      setNoticeValue, setNoticeError: current.writeNoticeError,
      readableError: hostActionErrorNotice,
    });
    current.client.replaceShareSource.mockRejectedValue(denied);
    await current.switchSource();
    expect(setNoticeValue).toHaveBeenLastCalledWith({
      kind: "text", text: hostActionErrorNotice(denied, "source"),
      target: "operation", comic: "hint-capture-browser", tone: "warn",
    });
    expect(current.setPhase).not.toHaveBeenCalled();
    expect(current.track.stop).not.toHaveBeenCalled();
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

  it("retains connecting children during reconciliation and rebuilds them after reauthentication", async () => {
    const current = fixture(false);
    current.nativeClientRef.current = null;
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
    browser.nativeClientRef.current = null;
    browser.requestShare();
    expect(browser.startSharing).not.toHaveBeenCalled();
    expect(browser.openCaptureSourcePicker).toHaveBeenCalledOnce();
    await browser.openPicker();
    expect(browser.setNativeSources).toHaveBeenLastCalledWith({ kind: "browser" });
    expect(browser.NativeClient.connect).not.toHaveBeenCalled();

    const current = fixture();
    current.nativeClientRef.current = null;
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
    current.nativeClientRef.current = current.client;
    current.requestShare();
    expect(current.openCaptureSourcePicker).toHaveBeenCalledTimes(2);
  });

  it("shows App incompatibility in the picker and clears it on a successful refresh", async () => {
    const current = fixture();
    current.context.phase = "idle";
    current.nativeClientRef.current = null;
    current.nativeShareGenerationRef.current = null;
    current.NativeClient.connect.mockRejectedValueOnce(new NativeCompatibilityError(8));
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith({ kind: "incompatible" });
    expect(current.nativeClientConnectRef.current).toBeNull();
    expect(current.nativeClientRef.current).toBeNull();
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
    absent.nativeClientRef.current = null;
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
    expect(current.nativeClientRef.current).toBe(current.client);
  });

  it("ignores a cancelled discovery mismatch after another picker owns a compatible App", async () => {
    const current = fixture();
    current.context.phase = "idle";
    current.nativeClientRef.current = null;
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
    expect(current.nativeClientRef.current).toBe(current.client);
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
    current.nativeClientRef.current = null;
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
    const current = fixture();
    current.context.phase = "idle";
    current.nativeClientRef.current = null;
    current.nativeShareGenerationRef.current = null;
    const discovery = deferred<typeof current.client>();
    current.NativeClient.connect.mockReturnValueOnce(discovery.promise);
    const opening = current.openPicker();
    await vi.waitFor(() => expect(current.NativeClient.connect).toHaveBeenCalledOnce());
    current.closePicker();
    discovery.resolve(current.client);
    await opening;
    expect(current.client.close).toHaveBeenCalledOnce();
    expect(current.client.sources).not.toHaveBeenCalled();
    expect(current.nativeClientRef.current).toBeNull();

    const replacement = { ...current.client, close: vi.fn() };
    current.NativeClient.connect.mockResolvedValue(replacement);
    await current.openPicker();
    expect(current.setNativeSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready" }));
    current.closePicker();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("retires a cancelled start ACK before publishing audio, codec or bridge state", async () => {
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
    expect(current.NativeMediaBridge).not.toHaveBeenCalled();
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
    expect(current.nativeClientRef.current).toBe(current.client);
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
