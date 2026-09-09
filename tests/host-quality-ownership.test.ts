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
import { debugEvent, debugOperation } from "../src/client/lib/debug";

// Exercise the actual page owners without mounting capture hardware or a Browser.
const source = ts.createSourceFile("HostPage.tsx", readFileSync(
  new URL("../src/client/pages/HostPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = new Set(["changeQuality", "commitQuality", "handleSignalMessage",
  "switchNativeSource", "finishSourceSwitch", "recoverBrowserFanout", "disposeNativeShare"]);
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

function fixture() {
  let physical: QualitySettings = original;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const peer = { updateCaptureProfile: vi.fn(async () => true), updateProfile: vi.fn(async () => true) };
  const client = { updateShare: vi.fn(async () => undefined), replaceShareSource: vi.fn(async () => undefined),
    stopReceive: vi.fn(async () => undefined), stopShare: vi.fn(async () => undefined) };
  const route = { updateProfile: vi.fn(async () => true), resyncAuthoritative: vi.fn(async (): Promise<void> => undefined) };
  const state = {
    debugEvent, debugOperation,
    phase: "live", qualitySettingsRef: ref<QualitySettings>(original), advancedQualityRef: ref<QualitySettings>(original),
    qualityChangeRef: ref<object | null>(null), pendingQualityChangeRef: ref<QualitySettings | null>(null),
    activeGenerationRef: ref<number | null>(1), streamRef: ref<typeof stream | null>(stream), sourceSwitchRef: ref<object | null>(null),
    nativeModeRef: ref(false), nativeClientRef: ref(client), nativeShareGenerationRef: ref<string | null>("share"),
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
  };
  const context = createContext({ ...state, isCurrentGeneration: (generation: number) => state.activeGenerationRef.current === generation });
  runInContext(executable, context);
  return { ...state, peer, client, route, track, physical: () => physical,
    change: context.changeQuality as (profile: QualitySettings) => Promise<void>,
    reauthenticate: () => context.handleSignalMessage({ type: "authenticated", role: "host", qualitySettings: original,
      routePolicy: {}, routeRevision: 1 }, 1, { roomId: "room" }, true, null),
    switchSource: () => context.switchNativeSource(client, {}, false, {}),
  };
}

describe("Host quality ownership", () => {
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
