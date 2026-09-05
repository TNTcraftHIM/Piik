import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY_SETTINGS, type SignalPayload } from "../src/shared/protocol";
import { EMPTY_METRICS, type PeerSnapshot } from "../src/client/types";
import type { HostPeerEvents } from "../src/client/webrtc/host-peer";
import { NativeMediaIngress, type NativeMediaIngressControl } from "../src/client/native/media-ingress";
import type { NativeClientEvent } from "../src/client/native/wire";

const senders = vi.hoisted(() => ({ current: null as HostPeerEvents | null }));
vi.mock("../src/client/webrtc/host-peer", () => ({
  HostPeer: class {
    constructor(readonly peerId: string, _ice: unknown, _stream: unknown, _profile: unknown, readonly events: HostPeerEvents) {
      senders.current = events;
    }
    async start() {
      this.events.sendSignal(this.peerId, { kind: "candidate", connectionId: this.peerId, candidate: null });
      return this.events.sendSignal(this.peerId, {
        kind: "description", connectionId: this.peerId, description: { type: "offer", sdp: "v=0\r\n" },
      });
    }
    async acceptSignal(payload: SignalPayload) {
      if (payload.kind === "description") this.events.onUpdate(snapshot("connected"));
    }
    dispose() {}
  },
}));

function snapshot(connectionState: RTCPeerConnectionState): PeerSnapshot {
  return {
    peerId: "ingress-peer", connectionId: "ingress-connection", connectionState,
    iceConnectionState: "connected", metrics: { ...EMPTY_METRICS }, error: null,
    senderParameters: null, audioSenderParameters: null, qualityWarning: null, qualityWarningKind: null,
  };
}

function fixture(pending = false) {
  vi.stubGlobal("window", globalThis);
  let listener: ((event: NativeClientEvent) => void) | null = null;
  let resolveAnswer!: (value: Awaited<ReturnType<NativeMediaIngressControl["receiveOffer"]>>) => void;
  const answer = { answer: { type: "answer" as const, sdp: "v=0\r\n" }, audio: false };
  const control: NativeMediaIngressControl = {
    receiveOffer: vi.fn<NativeMediaIngressControl["receiveOffer"]>(async () => pending ? new Promise((resolve) => { resolveAnswer = resolve; }) : answer),
    addReceiveCandidate: vi.fn(async () => undefined),
    closeReceiver: vi.fn(async () => undefined),
    onEvent: (next) => { listener = next; return () => { listener = null; }; },
  };
  const onFailed = vi.fn();
  const ingress = new NativeMediaIngress("share_123456", control, onFailed);
  const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
  return { ingress, control, stream, onFailed, answer: () => resolveAnswer(answer), emit: (event: NativeClientEvent) => listener?.(event) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Browser capture Native ingress", () => {
  it("queues candidates until the Native receiver exists", async () => {
    const current = fixture(true);
    const starting = current.ingress.start(current.stream, DEFAULT_QUALITY_SETTINGS);
    expect(current.control.addReceiveCandidate).not.toHaveBeenCalled();
    current.answer();
    await starting;
    expect(current.control.addReceiveCandidate).toHaveBeenCalledWith("share_123456", current.ingress.connectionId, null);
    current.ingress.dispose();
  });

  it("retires a late receiver after cancellation without reviving the owner", async () => {
    const current = fixture(true);
    const starting = current.ingress.start(current.stream, DEFAULT_QUALITY_SETTINGS);
    const rejected = expect(starting).rejects.toThrow("closed");
    current.ingress.dispose();
    current.answer();
    await rejected;
    expect(current.control.closeReceiver).toHaveBeenCalledTimes(2);
    expect(current.control.addReceiveCandidate).not.toHaveBeenCalled();
    expect(current.onFailed).not.toHaveBeenCalled();
  });

  it("reports loss of the active ingress once", async () => {
    const current = fixture();
    await current.ingress.start(current.stream, DEFAULT_QUALITY_SETTINGS);
    senders.current!.onUpdate(snapshot("failed"));
    senders.current!.onUpdate(snapshot("failed"));
    expect(current.onFailed).toHaveBeenCalledOnce();
    expect(current.control.closeReceiver).toHaveBeenCalledOnce();
  });
});
