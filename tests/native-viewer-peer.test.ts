import { afterEach, expect, it, vi } from "vitest";
import type { SignalPayload } from "../src/shared/protocol";
import type { NativeClient } from "../src/client/native/client";
import { NativeMediaBridge } from "../src/client/native/media-bridge";
import { ViewerPeer } from "../src/client/webrtc/viewer-peer";
import {
  NativeCapableViewerPeer,
  offerHasNativeVideoCodec,
} from "../src/client/native/native-viewer-peer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
