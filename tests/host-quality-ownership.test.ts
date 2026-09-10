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
import { reconcileBoundedMediaChildren } from "../src/client/webrtc/media-assignment";
import { debugError, debugEvent, debugOperation } from "../src/client/lib/debug";

// Exercise the actual page owners without mounting capture hardware or a Browser.
const source = ts.createSourceFile("HostPage.tsx", readFileSync(
  new URL("../src/client/pages/HostPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = new Set(["changeQuality", "commitQuality", "handleSignalMessage",
  "switchNativeSource", "finishSourceSwitch", "recoverBrowserFanout", "disposeNativeShare",
  "acquireNativeClient", "requestSharing", "startNativeShare", "startBrowserNativeIngress",
  "ownNativeClient", "discardNativeClient", "releaseUnusedNativeClient", "closeCaptureSourcePicker",
  "openCaptureSourcePicker", "startSharing", "beginRoomMutation", "finishRoomMutation",
  "startPeer", "reconcileHostChildren"]);
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
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
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
    close: vi.fn(), onClose: vi.fn(() => () => undefined),
    health: { nativeMedia: { video: true, hardwareH264: true, softwareVP8: true } },
    captureOptions: vi.fn(async () => []), sources: vi.fn(async () => []),
    stopReceive: vi.fn(async () => undefined), stopShare: vi.fn(async () => undefined) };
  const route = { updateProfile: vi.fn(async () => true), resyncAuthoritative: vi.fn(async (): Promise<void> => undefined) };
  const state = {
    debugError, debugEvent, debugOperation,
    launchedByClient, NativeClient: { connect: vi.fn(async (): Promise<typeof client | null> => null) },
    nativeClientConnectRef: ref<Promise<typeof client | null> | null>(null),
    ownNativeClient: vi.fn(), setJoiningRoom: vi.fn(), startSharing: vi.fn(), openCaptureSourcePicker: vi.fn(),
    videoCodecRef: ref({ primary: "h264" }),
    videoCodecModeRef: ref("h264"), MAX_ENDPOINT_MEDIA_CHILDREN: 2,
    nativeClientCloseCleanupRef: ref<(() => void) | null>(null),
    nativeSourceRequestRef: ref<object | null>(null), nativeSourcePathRef: ref<unknown>(null),
    setNativeSources: vi.fn(), defaultNativeCapturePath: () => ({ adapterIndex: 0, encoderIndex: 0 }),
    roomMutationRef: ref<object | null>(null), setRoomMutation: vi.fn(),
    generationRef: ref(0), shareGenerationRef: ref<string | null>("share"), createOpaqueId: () => "share",
    setCopied: vi.fn(), setPhase: vi.fn(), roomInitializationRef: ref(Promise.resolve()), roomRef: ref(null),
    createRoom: vi.fn(async () => { throw new Error("must not create an empty room"); }),
    readPreferredRoomId: () => null, disposeResources: vi.fn(), ApiError: class extends Error {},
    NativeMediaBridge: vi.fn(), manualVideoCodecPreference: vi.fn(),
    phase: "live", qualitySettingsRef: ref<QualitySettings>(original), advancedQualityRef: ref<QualitySettings>(original),
    qualityChangeRef: ref<object | null>(null), pendingQualityChangeRef: ref<QualitySettings | null>(null),
    activeGenerationRef: ref<number | null>(1), streamRef: ref<typeof stream | null>(stream), sourceSwitchRef: ref<object | null>(null),
    nativeModeRef: ref(false), nativeClientRef: ref<typeof client | null>(client), nativeShareGenerationRef: ref<string | null>("share"),
    nativeMediaIngressRef: ref<ReturnType<typeof ingress> | null>(null), nativeMediaBridgeRef: ref(null),
    nativeEventCleanupRef: ref(null), nativeShareCleanupRef: ref(Promise.resolve()),
    peersRef: ref(new Map([["viewer", peer]])), hostProvisionalChildRef: ref(null), hostSfuRouteRef: ref(route),
    signalRef: ref({ setHostQualitySettings: vi.fn(), send: vi.fn() }),
    setQualitySettings: vi.fn(), setAdvancedQuality: vi.fn(), setChangingQuality: vi.fn(),
    setNotice: vi.fn(), setNoticeError: vi.fn(), setDetails: vi.fn(), setNativeActive: vi.fn(),
    applyCaptureProfile: vi.fn(async (_stream: unknown, profile: QualitySettings) => { physical = profile; }),
    captureDetails: () => ({}), nativeCaptureDetails: () => ({}),
    qualitySettingsEqual, videoQualitySettingsEqual, resolveScreenAudioQuality, qualitySettingsLabel,
    say: (key: string) => key, syncHostSfuQualityWarning: () => null,
    NativeSenderPeer, discardPreparedHostChild: vi.fn(), removePeer: vi.fn(), startPeer: vi.fn(async () => undefined),
    nativePreviewTailRef: ref(Promise.resolve()), setSwitchingSource: vi.fn(),
    invalidateSenderQualityEvidence: vi.fn(), routePolicyRef: ref({ topologyOptimization: false }),
    sourceSwitchNotice: () => "source-switch-result", hostPeerIdRef: ref(null), endpointMediaCopyCapacityRef: ref(2),
    creationProfileRef: ref({ roomPassword: null }), saveCreationProfile: vi.fn(), setCreationProfile: vi.fn(),
    setViewerPasswordEnabled: vi.fn(), setViewerPasswordDraft: vi.fn(), setViewerPasswordVisible: vi.fn(),
    setMaxViewers: vi.fn(), setRoutePolicy: vi.fn(), setRoom: vi.fn(), activeRouteRevisionRef: ref(1),
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
  context.startSharing = state.startSharing;
  context.startPeer = state.startPeer;
  context.openCaptureSourcePicker = state.openCaptureSourcePicker;
  return { ...state, peer, client, route, track, physical: () => physical,
    context, startChild, openPicker: openPicker as () => Promise<void>,
    closePicker: context.closeCaptureSourcePicker as () => void,
    releaseUnused: context.releaseUnusedNativeClient as () => void,
    disposeNative: context.disposeNativeShare as (expectedShare?: string) => void,
    start: () => start( { kind: "native", client, target: {}, audio: false, path: {} }) as Promise<void>,
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

describe("Host quality ownership", () => {
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

  it("keeps Browser capture immediate and App selection reachable after absent discovery", async () => {
    const browser = fixture(false);
    browser.nativeClientRef.current = null;
    browser.requestShare();
    expect(browser.startSharing).toHaveBeenCalledWith({ kind: "browser" });
    expect(browser.openCaptureSourcePicker).not.toHaveBeenCalled();
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

  it("retires a cancelled start ACK before publishing codec or bridge state", async () => {
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
    expect(current.manualVideoCodecPreference).not.toHaveBeenCalled();
    expect(current.NativeMediaBridge).not.toHaveBeenCalled();
    expect(current.setNativeActive).not.toHaveBeenCalled();
  });

  it("ignores a stale listing failure after a newer picker owns the App", async () => {
    const current = fixture();
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
    current.setNotice("new-share");
    pending.resolve(true);
    await switching;
    expect(current.setNotice).toHaveBeenLastCalledWith("new-share");
    expect(current.setNotice).not.toHaveBeenCalledWith("source-switch-result");
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
