import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NativeMediaBridge,
  NativeMediaBridgeError,
  type NativeMediaBridgeControl,
} from "../src/client/native/media-bridge";
import type { NativeClientEvent } from "../src/client/native/wire";
import { debugError, debugEvent } from "../src/client/lib/debug";

vi.mock("../src/client/lib/debug", () => ({
  browserDebugEnabled: true,
  debugEvent: vi.fn(),
  debugError: vi.fn(),
}));

class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[] = [];

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  readonly getReceivers = vi.fn<() => RTCRtpReceiver[]>(() => []);
  readonly getSenders = vi.fn<() => RTCRtpSender[]>(() => []);
  readonly getStats = vi.fn(async () => new Map());
  readonly addIceCandidate = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly createAnswer = vi.fn(async () => ({
    type: "answer" as const,
    sdp: "v=0\r\n",
  }));
  readonly setLocalDescription = vi.fn(async (): Promise<void> => undefined);
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
  });

  emitTrack(track: MediaStreamTrack): void {
    this.dispatchEvent(Object.assign(new Event("track"), { track }));
  }

  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

function fixture(options: {
  hangPreparation?: boolean;
  expectedAudio?: boolean;
} = {}) {
  let listener: ((event: NativeClientEvent) => void) | null = null;
  let peer: FakePeerConnection | null = null;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("RTCPeerConnection", class {
    constructor() {
      peer = new FakePeerConnection();
      return peer;
    }
  });
  const prepareLocalEdge = vi.fn<
    NativeMediaBridgeControl["prepareLocalEdge"]
  >(async (_shareId, connectionId) => {
      listener?.({
        version: 9,
        type: "edge-candidate",
        shareId: "share_123456",
        connectionId,
        candidate: {
          candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
        },
      });
      if (options.hangPreparation) {
        return await new Promise<RTCSessionDescriptionInit>(() => undefined);
      }
      return { type: "offer", sdp: "v=0\r\n" };
    });
  const control: NativeMediaBridgeControl = {
    prepareLocalEdge,
    acceptSignal: vi.fn(async () => undefined),
    closeEdge: vi.fn(async () => undefined),
    onEvent: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  };
  const onFailed = vi.fn();
  const bridge = new NativeMediaBridge(
    "share_123456",
    control,
    onFailed,
    options.expectedAudio,
  );
  return {
    bridge,
    control,
    onFailed,
    peer: () => peer!,
    emit: (event: NativeClientEvent) => listener?.(event),
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native media bridge", () => {
  it.each(["queued", "active"])("keeps media alive after a %s candidate is rejected", async (phase) => {
    const current = fixture();
    const peer = current.peer();
    if (phase === "queued") {
      peer.addIceCandidate.mockRejectedValueOnce(new DOMException("Rejected candidate", "OperationError"));
    }
    const starting = current.bridge.start();
    // Register a rejection observer before allowing negotiation to run.
    const result = starting.catch((error: unknown) => error);
    if (phase === "queued") {
      current.emit({
        version: 9, type: "edge-candidate", shareId: "share_123456",
        connectionId: current.bridge.connectionId,
        candidate: { candidate: "candidate:2 1 udp 1 127.0.0.1 10 typ host" },
      });
    }
    await vi.waitFor(() => expect(peer.setLocalDescription).toHaveBeenCalledOnce());
    const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
    peer.emitTrack(track);
    peer.setState("connected");
    await expect(result).resolves.toBe(current.bridge.stream);
    if (phase === "active") {
      peer.addIceCandidate.mockRejectedValueOnce(new DOMException("Rejected candidate", "OperationError"));
      current.emit({
        version: 9, type: "edge-candidate", shareId: "share_123456",
        connectionId: current.bridge.connectionId,
        candidate: { candidate: "candidate:2 1 udp 1 127.0.0.1 10 typ host" },
      });
    }
    current.emit({
      version: 9, type: "edge-candidate", shareId: "share_123456",
      connectionId: current.bridge.connectionId, candidate: null,
    });
    await vi.waitFor(() => expect(debugError).toHaveBeenCalledWith(
      "webrtc", "remote-candidate-rejected", expect.any(DOMException), { origin: "ordinary" },
    ));
    expect(peer.addIceCandidate).toHaveBeenCalledWith(null);
    expect(peer.close).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(current.onFailed).not.toHaveBeenCalled();
    current.bridge.dispose();
  });

  it("still rejects invalid negotiation state when applying a candidate", async () => {
    const current = fixture();
    current.peer().addIceCandidate.mockRejectedValueOnce(new DOMException("No description", "InvalidStateError"));
    await expect(current.bridge.start()).rejects.toBeInstanceOf(NativeMediaBridgeError);
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
  });

  it("orders an early native candidate after the remote offer", async () => {
    const current = fixture();
    const starting = current.bridge.start();
    await vi.waitFor(() => {
      expect(current.peer().setLocalDescription).toHaveBeenCalledOnce();
    });
    const track = {
      kind: "video",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    current.peer().emitTrack(track);
    current.peer().setState("connected");

    await expect(starting).resolves.toBe(current.bridge.stream);
    expect(current.peer().addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: expect.stringContaining("127.0.0.1") }),
    );
    expect(current.control.acceptSignal).toHaveBeenCalledWith(
      "share_123456",
      current.bridge.connectionId,
      expect.objectContaining({ kind: "description" }),
    );
    current.bridge.dispose();
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
  });

  it("releases a local edge when preparation exceeds the total deadline", async () => {
    vi.useFakeTimers();
    const current = fixture({ hangPreparation: true });
    const starting = current.bridge.start();
    const rejected = expect(starting).rejects.toThrow("Native media bridge failed");

    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
  });

  it("does not publish a declared audio share before its audio track arrives", async () => {
    const current = fixture({ expectedAudio: true });
    const starting = current.bridge.start();
    let resolved = false;
    void starting.then(() => {
      resolved = true;
    });
    await vi.waitFor(() => {
      expect(current.peer().setLocalDescription).toHaveBeenCalledOnce();
    });
    current.peer().emitTrack({
      kind: "video",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack);
    current.peer().setState("connected");
    await Promise.resolve();
    expect(resolved).toBe(false);

    current.peer().emitTrack({
      kind: "audio",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack);

    await expect(starting).resolves.toBe(current.bridge.stream);
    expect(current.bridge.stream.getAudioTracks()).toHaveLength(1);
  });

  it("reports only categorical transport and candidate counts on timeout", async () => {
    vi.useFakeTimers();
    const current = fixture();
    const peer = current.peer();
    peer.connectionState = "connecting";
    peer.iceConnectionState = "checking";
    peer.iceGatheringState = "complete";
    peer.getReceivers.mockReturnValue([{
      track: { kind: "video", readyState: "live", id: "private-track" },
      transport: { state: "new" },
    } as unknown as RTCRtpReceiver]);
    peer.getStats.mockResolvedValue(new Map([
      ["private-local", { type: "local-candidate", candidateType: "host", protocol: "tcp", address: "192.0.2.1", port: 54321 }],
      ["private-remote", { type: "remote-candidate", candidateType: "host", protocol: "udp", address: "192.0.2.2", port: 54322 }],
    ]));
    const starting = current.bridge.start();
    const rejected = expect(starting).rejects.toBeInstanceOf(NativeMediaBridgeError);
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;

    expect(debugEvent).toHaveBeenCalledWith("native-bridge", "failed", { type: "timeout", state: "starting" });
    expect(debugEvent).toHaveBeenCalledWith("native-bridge", "ice-state", { state: "checking" });
    expect(debugEvent).toHaveBeenCalledWith("native-bridge", "ice-gathering-state", { state: "complete" });
    expect(debugEvent).toHaveBeenCalledWith("native-bridge", "dtls-state", { state: "new" });
    expect(debugEvent).toHaveBeenCalledWith("native-bridge", "receiver-count", { type: "video", state: "live", count: 1 });
    expect(debugEvent).toHaveBeenCalledWith("native-bridge", "candidate-count", { type: "local-host", state: "udp", count: 0 });
    expect(debugEvent).toHaveBeenCalledWith("native-bridge", "candidate-count", { type: "remote-host", state: "udp", count: 1 });
    const report = JSON.stringify(vi.mocked(debugEvent).mock.calls);
    for (const privateValue of ["private-track", "private-local", "private-remote", "192.0.2.", "54321", "54322"]) {
      expect(report).not.toContain(privateValue);
    }
    expect(peer.getStats).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it.each(["failed", "pending"])("does not delay timeout cleanup for %s diagnostics", async (state) => {
    vi.useFakeTimers();
    const current = fixture();
    current.peer().getStats.mockImplementation(() => state === "failed"
      ? Promise.reject(new Error("private stats failure"))
      : new Promise(() => undefined));
    const rejected = expect(current.bridge.start()).rejects.toBeInstanceOf(NativeMediaBridgeError);
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
    if (state === "failed") expect(debugError).toHaveBeenCalledWith(
      "native-bridge", "diagnostics-failed", expect.any(Error),
    );
  });

  it("reports an active native failure once and retires its edge", async () => {
    const current = fixture();
    const starting = current.bridge.start();
    await vi.waitFor(() => {
      expect(current.peer().setLocalDescription).toHaveBeenCalledOnce();
    });
    current.peer().emitTrack({
      kind: "video",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack);
    current.peer().setState("connected");
    await starting;

    current.emit({
      version: 9,
      type: "edge-state",
      shareId: "share_123456",
      connectionId: current.bridge.connectionId,
      state: "failed",
    });
    current.emit({
      version: 9,
      type: "edge-state",
      shareId: "share_123456",
      connectionId: current.bridge.connectionId,
      state: "failed",
    });

    expect(current.onFailed).toHaveBeenCalledOnce();
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
  });

  it("rejects a pending start when the bridge is disposed", async () => {
    const current = fixture();
    const starting = current.bridge.start();
    await vi.waitFor(() => {
      expect(current.peer().setLocalDescription).toHaveBeenCalledOnce();
    });

    current.bridge.dispose();

    await expect(starting).rejects.toThrow("Native media bridge failed");
    expect(current.onFailed).not.toHaveBeenCalled();
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
  });

  it.each(["prepare", "answer"])("does not signal after disposal during %s", async (stage) => {
    const current = fixture();
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    if (stage === "prepare") {
      vi.mocked(current.control.prepareLocalEdge).mockImplementationOnce(async () => {
        await pending;
        return { type: "offer", sdp: "v=0\r\n" };
      });
    } else {
      current.peer().setLocalDescription.mockImplementationOnce(() => pending);
    }
    const rejected = expect(current.bridge.start()).rejects.toBeInstanceOf(NativeMediaBridgeError);
    if (stage === "answer") await vi.waitFor(() => expect(current.peer().setLocalDescription).toHaveBeenCalledOnce());
    current.bridge.dispose();
    complete();
    current.peer().dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: null }));
    await rejected;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(current.control.acceptSignal).not.toHaveBeenCalled();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
    expect(current.onFailed).not.toHaveBeenCalled();
  });
});
