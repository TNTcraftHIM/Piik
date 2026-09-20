import { afterEach, expect, it, vi } from "vitest";
import type { SignalPayload } from "../src/shared/protocol";
import type { NativeClient } from "../src/client/native/client";
import { NativeMediaBridge } from "../src/client/native/media-bridge";
import { VIEWER_AUTOMATIC_RECOVERY_TIMEOUT_MS, ViewerPeer } from "../src/client/webrtc/viewer-peer";
import { EMPTY_METRICS, type PeerSnapshot } from "../src/client/types";
import type { NativeClientEvent } from "../src/client/native/wire";
import {
  NativeCapableViewerPeer,
  offerHasNativeVideoCodec,
} from "../src/client/native/native-viewer-peer";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["viewer", "route"] as const)("retires a connected Native receiver on control loss (%s)", async (recoveryOwner) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("RTCPeerConnection", class { close() {} });
  vi.spyOn(NativeMediaBridge.prototype, "start").mockResolvedValue({} as MediaStream);
  vi.spyOn(NativeMediaBridge.prototype, "collectMetrics").mockResolvedValue({ ...EMPTY_METRICS });
  vi.spyOn(NativeMediaBridge.prototype, "decodedVideoFrames").mockResolvedValue(null);
  let onEvent!: (event: NativeClientEvent) => void;
  let onClose!: () => void;
  const client = {
    receiveOffer: async () => ({
      answer: { type: "answer", sdp: "v=0\r\n" }, audio: false, codec: "vp8",
    }),
    onEvent: (handler: typeof onEvent) => { onEvent = handler; return () => undefined; },
    onClose: (handler: typeof onClose) => { onClose = handler; return () => undefined; },
    closeReceiver: vi.fn(async () => undefined),
    closeEdge: vi.fn(async () => undefined),
  } as unknown as NativeClient;
  const unavailable = vi.fn();
  const restart = vi.fn(() => true);
  const exhausted = vi.fn(() => true);
  const updates: PeerSnapshot[] = [];
  const peer = new NativeCapableViewerPeer(
    { iceServers: [] },
    {
      sendSignal: () => true, sendRestartRequest: restart,
      onStream: () => undefined, onUpdate: (value) => updates.push(value),
      onRecoveryExhausted: exhausted,
    },
    { recoveryOwner }, async () => client, unavailable, "session", 2,
  );
  try {
    await peer.acceptSignal("parent", {
      kind: "description", connectionId: "current",
      description: { type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n" },
    });
    const connected = {
      version: 9, shareId: "session", connectionId: "current", type: "edge-state", state: "connected",
    } as const;
    onEvent(connected);
    expect(peer.isConnected()).toBe(true);
    expect(peer.nativeSource).not.toBeNull();

    onClose();
    expect(peer.isConnected()).toBe(false);
    expect(peer.nativeSource).toBeNull();
    expect(updates.at(-1)?.connectionState).toBe("failed");
    // A queued event cannot revive the receiver that owns the dead bridge.
    onEvent(connected);
    onClose();
    expect(peer.isConnected()).toBe(false);
    expect(unavailable).toHaveBeenCalledOnce();
    if (recoveryOwner === "viewer") {
      expect(restart).toHaveBeenCalledExactlyOnceWith("parent", "current", true);
      expect(exhausted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(VIEWER_AUTOMATIC_RECOVERY_TIMEOUT_MS);
    } else {
      expect(restart).not.toHaveBeenCalled();
    }
    expect(exhausted).toHaveBeenCalledExactlyOnceWith("parent", "current");
  } finally {
    peer.dispose();
  }
});

it.each([false, true])("ignores a late Native offer after control loss (disposed=%s)", async (disposeOnFailure) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("RTCPeerConnection", class { close() {} });
  const bridgeStart = vi.spyOn(NativeMediaBridge.prototype, "start").mockResolvedValue({} as MediaStream);
  let resolveOffer!: (value: Awaited<ReturnType<NativeClient["receiveOffer"]>>) => void;
  const receiveOffer = vi.fn(() => new Promise<Awaited<ReturnType<NativeClient["receiveOffer"]>>>((resolve) => {
    resolveOffer = resolve;
  }));
  let onClose!: () => void;
  const closeReceiver = vi.fn(async () => undefined);
  const client = {
    receiveOffer,
    onEvent: () => () => undefined,
    onClose: (handler: typeof onClose) => { onClose = handler; return () => undefined; },
    closeReceiver, closeEdge: vi.fn(async () => undefined),
  } as unknown as NativeClient;
  const sendSignal = vi.fn(() => true);
  const onStream = vi.fn();
  const restart = vi.fn(() => true);
  const unavailable = vi.fn();
  const updates: PeerSnapshot[] = [];
  let peer!: NativeCapableViewerPeer;
  peer = new NativeCapableViewerPeer(
    { iceServers: [] },
    {
      sendSignal, sendRestartRequest: restart, onStream,
      onUpdate: (value) => {
        updates.push(value);
        if (disposeOnFailure && value.connectionState === "failed") peer.dispose();
      },
    },
    {}, async () => client, unavailable, "session", 2,
  );
  try {
    const accepting = peer.acceptSignal("parent", {
      kind: "description", connectionId: "current",
      description: { type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n" },
    });
    await vi.waitFor(() => expect(receiveOffer).toHaveBeenCalledOnce());
    onClose();
    resolveOffer({ answer: { type: "answer", sdp: "v=0\r\n" }, audio: false, codec: "vp8", reused: false });
    await accepting;

    expect(updates.at(-1)?.connectionState).toBe("failed");
    expect(peer.isConnected()).toBe(false);
    expect(peer.nativeSource).toBeNull();
    expect(closeReceiver).toHaveBeenCalledWith("session", "current");
    expect(sendSignal).not.toHaveBeenCalled();
    expect(onStream).not.toHaveBeenCalled();
    expect(bridgeStart).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledTimes(disposeOnFailure ? 0 : 1);
  } finally {
    peer.dispose();
  }
});

it.each(["reused", "replaced", "answer-lost", "control-lost"])("keeps Native receiver lifetimes coherent through renegotiation (%s)", async (outcome) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("RTCPeerConnection", class { close() {} });
  const bridges: NativeMediaBridge[] = [];
  const bridgeStart = vi.spyOn(NativeMediaBridge.prototype, "start").mockImplementation(async function (this: NativeMediaBridge) {
    bridges.push(this);
    return {} as MediaStream;
  });
  let closeControl!: () => void;
  let event!: (event: NativeClientEvent) => void;
  const receiveOffer = vi.fn(async () => ({
    answer: { type: "answer" as const, sdp: "answer-sdp" }, audio: false, codec: "vp8" as const, reused: false,
  }));
  const closeReceiver = vi.fn(async () => undefined);
  const closeEdge = vi.fn(async () => undefined);
  const client = {
    health: { nativeMedia: { receiverReuse: true } }, receiveOffer, closeReceiver, closeEdge,
    onEvent: (listener: typeof event) => { event = listener; return () => {}; },
    onClose: (listener: typeof closeControl) => { closeControl = listener; return () => {}; },
  } as unknown as NativeClient;
  const sendSignal = vi.fn(() => true);
  const onStream = vi.fn();
  const unavailable = vi.fn();
  const peer = new NativeCapableViewerPeer({ iceServers: [] }, {
    sendSignal, sendRestartRequest: () => true, onStream, onUpdate: () => {},
  }, {}, async () => client, unavailable, "session", 2);
  const offer = (ice: string): SignalPayload => ({
    kind: "description", connectionId: "current", description: { type: "offer",
      sdp: `v=0\r\na=ice-ufrag:${ice}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n` },
  });
  try {
    await peer.acceptSignal("parent", offer("first"));
    event({ version: 9, type: "edge-state", shareId: "session", connectionId: "current", state: "connected" });
    const source = peer.nativeSource;
    receiveOffer.mockImplementationOnce(async () => {
      if (outcome === "replaced") {
        // Replacement closes the old local edge before its answer reaches JS.
        (bridges[0] as unknown as { onFailed(): void }).onFailed();
      }
      if (outcome === "control-lost") closeControl();
      return { answer: { type: "answer", sdp: "new-answer-sdp" }, audio: false, codec: "vp8", reused: outcome !== "replaced" };
    });
    if (outcome === "answer-lost") sendSignal.mockReturnValue(false);
    await peer.acceptSignal("parent", offer("restarted"));
    expect(receiveOffer).toHaveBeenCalledTimes(2);
    if (outcome === "control-lost") {
      expect(peer.nativeSource).toBeNull();
      expect(unavailable).toHaveBeenCalledOnce();
    } else {
      expect(closeReceiver).not.toHaveBeenCalled();
      expect(unavailable).not.toHaveBeenCalled();
      expect(bridgeStart).toHaveBeenCalledTimes(outcome === "replaced" ? 2 : 1);
      expect(onStream).toHaveBeenCalledTimes(outcome === "replaced" ? 2 : 1);
      expect(peer.nativeSource?.generation).toBe(source!.generation + (outcome === "replaced" ? 1 : 0));
      if (outcome !== "replaced") {
        expect(closeEdge).not.toHaveBeenCalled();
        expect(peer.isConnected()).toBe(true);
      }
    }
  } finally { peer.dispose(); }
});

it("admits one active sending H264 or VP8 video section, not unrelated SDP codec text", () => {
  const video = (codec: string, direction = "sendonly", port = 9, payload = 96) => [
    `m=video ${port} UDP/TLS/RTP/SAVPF ${payload}`,
    `a=${direction}`,
    `a=rtpmap:96 ${codec}/90000`,
    "",
  ].join("\r\n");
  expect(offerHasNativeVideoCodec(video("H264"))).toBe(true);
  expect(offerHasNativeVideoCodec(video("VP8"))).toBe(true);
  expect(offerHasNativeVideoCodec(video("VP8", "sendrecv"))).toBe(true);
  for (const offer of [
    video("VP8", "recvonly"), video("VP8", "inactive"),
    video("VP8", "sendonly", 0), video("VP8", "sendonly", 9, 97),
    video("VP9"), video("H264") + video("VP8"),
    "m=audio 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n",
  ]) expect(offerHasNativeVideoCodec(offer)).toBe(false);
});

it("does not create a browser backend after deferred native discovery is disposed", async () => {
  let resolveClient: (value: null) => void = () => undefined;
  const nativeClient = new Promise<null>((resolve) => {
    resolveClient = resolve;
  });
  const peer = new NativeCapableViewerPeer(
    { iceServers: [] },
    {
      sendSignal: () => true,
      sendRestartRequest: () => true,
      onStream: () => undefined,
      onUpdate: () => undefined,
    },
    {},
    () => nativeClient,
    () => undefined,
    "session",
    2,
  );
  const accepted = peer.acceptSignal("parent", {
    kind: "description",
    connectionId: "connection",
    description: {
      type: "offer",
      sdp: [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=sendonly",
        "a=rtpmap:96 H264/90000",
        "",
      ].join("\r\n"),
    },
  });
  peer.dispose();
  resolveClient(null);
  await accepted;
  expect(peer.getConnectionIdentity()).toBeNull();
});

it.each(["route", "viewer"] as const)("recovers an answer signaling failure without disabling native (%s)", async (recoveryOwner) => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("RTCPeerConnection", class { close() {} });
  const receiveOffer = vi.fn(async () => ({
    answer: { type: "answer", sdp: "v=0\r\n" }, audio: false, codec: "vp8",
  }));
  const closeReceiver = vi.fn(async () => undefined);
  const client = {
    receiveOffer,
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    closeReceiver,
    closeEdge: vi.fn(async () => undefined),
  } as unknown as NativeClient;
  let available = true;
  const acquire = vi.fn(async () => available ? client : null);
  const unavailable = vi.fn(() => { available = false; });
  const restart = vi.fn(() => true);
  const exhausted = vi.fn(() => true);
  let signalOnline = false;
  const peer = new NativeCapableViewerPeer(
    { iceServers: [] },
    {
      sendSignal: () => signalOnline,
      sendRestartRequest: restart,
      onStream: () => undefined,
      onUpdate: () => undefined,
      onRecoveryExhausted: exhausted,
    },
    { recoveryOwner },
    acquire,
    unavailable,
    "session",
    2,
  );
  const offer = (connectionId: string): SignalPayload => ({
    kind: "description", connectionId,
    description: { type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n" },
  });
  try {
    // A transient room-signaling outage at the answer must not disable
    // Native reception for the session: close only this receiver and run
    // the ordinary recovery path.
    await peer.acceptSignal("parent", offer("first"));
    expect(unavailable).not.toHaveBeenCalled();
    expect(peer.nativeSource).toBeNull();
    expect(closeReceiver).toHaveBeenCalledWith("session", "first");
    if (recoveryOwner === "viewer") {
      expect(restart).toHaveBeenCalledWith("parent", "first", true);
      expect(exhausted).not.toHaveBeenCalled();
    } else {
      expect(exhausted).toHaveBeenCalledWith("parent", "first");
      expect(restart).not.toHaveBeenCalled();
    }

    // With signaling back online, the next offer re-acquires the native path.
    signalOnline = true;
    vi.spyOn(NativeMediaBridge.prototype, "start").mockResolvedValue(
      new (class {})() as never,
    );
    await peer.acceptSignal("parent", offer("second"));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(receiveOffer).toHaveBeenCalledTimes(2);
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    peer.dispose();
  }
});

it("still disables native on a genuine failure after a signaling failure", async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("RTCPeerConnection", class { close() {} });
  let eventHandler: ((event: unknown) => void) | null = null;
  const receiveOffer = vi.fn(async () => ({
    answer: { type: "answer", sdp: "v=0\r\n" }, audio: false, codec: "vp8",
  }));
  const client = {
    receiveOffer,
    onEvent: (handler: (event: unknown) => void) => {
      eventHandler = handler;
      return () => undefined;
    },
    onClose: () => () => undefined,
    closeReceiver: vi.fn(async () => undefined),
    closeEdge: vi.fn(async () => undefined),
  } as unknown as NativeClient;
  const unavailable = vi.fn();
  const peer = new NativeCapableViewerPeer(
    { iceServers: [] },
    {
      sendSignal: () => false,
      sendRestartRequest: () => true,
      onStream: () => undefined,
      onUpdate: () => undefined,
      onRecoveryExhausted: () => true,
    },
    {},
    async () => client,
    unavailable,
    "session",
    2,
  );
  try {
    await peer.acceptSignal("parent", {
      kind: "description",
      connectionId: "first",
      description: { type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n" },
    });
    expect(unavailable).not.toHaveBeenCalled();

    // A genuine native failure on the same connection must still disable
    // Native for the session: the signaling path must not have latched the
    // failure state.
    eventHandler!({ shareId: "session", type: "share-ended", failed: true });
    expect(unavailable).toHaveBeenCalledOnce();
  } finally {
    peer.dispose();
  }
});

it.each(["route", "viewer"] as const)("keeps %s bridge failure unavailable across replacement peers", async (recoveryOwner) => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("RTCPeerConnection", class { close() {} });
  const browserSignal = vi.spyOn(ViewerPeer.prototype, "acceptSignal").mockResolvedValue();
  const bridgeStart = vi.spyOn(NativeMediaBridge.prototype, "start").mockRejectedValue(new Error("bridge failed"));
  const receiveOffer = vi.fn(async () => ({
    answer: { type: "answer", sdp: "v=0\r\n" }, audio: false, codec: "vp8",
  }));
  const client = {
    receiveOffer,
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    closeReceiver: vi.fn(async () => undefined),
    closeEdge: vi.fn(async () => undefined),
  } as unknown as NativeClient;
  let available = true;
  const acquire = vi.fn(async () => available ? client : null);
  const unavailable = vi.fn(() => { available = false; });
  const recover = vi.fn(() => {
    expect(available).toBe(false);
    return true;
  });
  const create = () => new NativeCapableViewerPeer(
    { iceServers: [] },
    {
      sendSignal: () => true,
      sendRestartRequest: recover,
      onStream: () => undefined,
      onUpdate: () => undefined,
      onRecoveryExhausted: recover,
    },
    { recoveryOwner },
    acquire,
    unavailable,
    "session",
    2,
  );
  const offer = (connectionId: string): SignalPayload => ({
    kind: "description", connectionId,
    description: { type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n" },
  });
  const first = create();
  const queued = create();
  try {
    await first.acceptSignal("parent", offer("first"));
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(recover).toHaveBeenCalledOnce();
    first.dispose();
    await queued.acceptSignal("parent", offer("queued"));
    expect(browserSignal).toHaveBeenCalledOnce();
    const replacement = create();
    try {
      await replacement.acceptSignal("parent", offer("replacement"));
      expect(browserSignal).toHaveBeenCalledTimes(2);
      expect(receiveOffer).toHaveBeenCalledOnce();
      expect(bridgeStart).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledTimes(3);
    } finally {
      replacement.dispose();
    }
  } finally {
    first.dispose();
    queued.dispose();
  }
});

it.each([false, true])("keeps committed route recovery across backend replacement (replaced=%s)", async (replaced) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("RTCPeerConnection", class { close() {} });
  vi.spyOn(NativeMediaBridge.prototype, "start").mockResolvedValue({} as MediaStream);
  vi.spyOn(NativeMediaBridge.prototype, "collectMetrics").mockResolvedValue({ ...EMPTY_METRICS });
  vi.spyOn(NativeMediaBridge.prototype, "decodedVideoFrames").mockResolvedValue(null);
  let onEvent!: (event: NativeClientEvent) => void;
  const client = {
    receiveOffer: async () => ({ answer: { type: "answer", sdp: "v=0\r\n" }, audio: false, codec: "vp8" }),
    onEvent: (fn: typeof onEvent) => { onEvent = fn; return () => undefined; },
    onClose: () => () => undefined,
    closeReceiver: vi.fn(async () => undefined), closeEdge: vi.fn(async () => undefined),
  } as unknown as NativeClient;
  const restart = vi.fn(() => true);
  const exhausted = vi.fn(() => true);
  const options = { recoveryOwner: "route" as const };
  const peer = new NativeCapableViewerPeer({ iceServers: [] }, {
    sendSignal: () => true, sendRestartRequest: restart,
    onStream: () => undefined, onUpdate: () => undefined, onRecoveryExhausted: exhausted,
  }, options, async () => client, () => undefined, "session", 2);
  const offer = (connectionId: string) => ({ kind: "description" as const, connectionId,
    description: { type: "offer" as const, sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n" }});
  const state = (connectionId: string, value: "connected" | "failed") => onEvent({
    version: 9, shareId: "session", connectionId, type: "edge-state", state: value,
  });
  try {
    await peer.acceptSignal("parent", offer("first"));
    state("first", "connected");
    peer.activatePreparedRoute();
    expect(options.recoveryOwner).toBe("route"); // Caller options are not mutable route state.
    const connectionId = replaced ? "replacement" : "first";
    if (replaced) {
      await peer.acceptSignal("parent", offer(connectionId));
      state(connectionId, "connected");
    }
    state(connectionId, "failed");
    expect(restart).toHaveBeenCalledExactlyOnceWith("parent", connectionId, false);
    expect(exhausted).not.toHaveBeenCalled();
  } finally { peer.dispose(); }
});
