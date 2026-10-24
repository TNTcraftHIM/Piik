import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NativeMediaBridge,
  NativeMediaBridgeError,
  NativeMediaBridgeInitializationError,
  type NativeMediaBridgeControl,
} from "../src/client/native/media-bridge";
import type { NativeClientEvent } from "../src/client/native/wire";
import { debugError, debugEvent } from "../src/client/lib/debug";

vi.mock("../src/client/lib/debug", () => ({
  registerDebugCollector: vi.fn(() => vi.fn()),
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
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  readonly getReceivers = vi.fn<() => RTCRtpReceiver[]>(() => []);
  readonly getSenders = vi.fn<() => RTCRtpSender[]>(() => []);
  readonly getStats = vi.fn(async () => new Map());
  readonly addIceCandidate = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly createAnswer = vi.fn(async () => ({
    type: "answer" as const,
    sdp: "v=0\r\n",
  }));
  readonly setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit): Promise<void> => {
    this.localDescription = description;
  });
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
  >(async () => {
      if (options.hangPreparation) {
        return await new Promise<RTCSessionDescriptionInit & { offerId: string }>(() => undefined);
      }
      return { type: "offer", sdp: "v=0\r\n", offerId: "local_offer_1" };
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
  it("retires rejected local video through the existing bridge failure path", async () => {
    const current = fixture();
    vi.mocked(current.control.prepareLocalEdge).mockResolvedValueOnce({ type: "offer", offerId: "local_offer_1",
      sdp: "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n" });
    current.peer().createAnswer.mockResolvedValueOnce({ type: "answer", sdp: "m=video 0 UDP/TLS/RTP/SAVPF 120\r\n" });
    await expect(current.bridge.start()).rejects.toBeInstanceOf(NativeMediaBridgeError);
    expect(current.control.acceptSignal).not.toHaveBeenCalled();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
    expect(current.peer().close).toHaveBeenCalledOnce();
  });

  it("recovers one retained transport after a disconnect grace, including a quiet source", async () => {
    vi.useFakeTimers();
    const current = fixture();
    const starting = current.bridge.start(true);
    const video = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
    const audio = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
    current.peer().emitTrack(video);
    current.peer().emitTrack(audio);
    current.peer().setState("connected");
    await starting;

    current.peer().setState("disconnected");
    await vi.advanceTimersByTimeAsync(2_000);
    current.peer().setState("connected");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(current.control.prepareLocalEdge).toHaveBeenCalledTimes(1);

    vi.mocked(current.control.prepareLocalEdge).mockResolvedValueOnce({
      type: "offer", sdp: "v=0\r\n", offerId: "local_offer_2",
    });
    current.peer().setState("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    current.emit({ version: 10, type: "edge-state", shareId: "share_123456",
      connectionId: current.bridge.connectionId, state: "failed" });
    expect(current.control.prepareLocalEdge).toHaveBeenLastCalledWith(
      "share_123456", current.bridge.connectionId, undefined, true,
    );
    expect(current.control.prepareLocalEdge).toHaveBeenCalledTimes(2);
    expect(current.control.acceptSignal).toHaveBeenLastCalledWith(
      "share_123456", current.bridge.connectionId, expect.objectContaining({ kind: "description" }), "local_offer_2",
    );
    current.peer().setState("connected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(current.bridge.stream.getTracks()).toEqual([video, audio]);
    expect(video.stop).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
    expect(current.peer().close).not.toHaveBeenCalled();
    expect(current.onFailed).not.toHaveBeenCalled();
    current.bridge.dispose();
  });

  it("bounds a failed restart and ignores its late offer after disposal", async () => {
    vi.useFakeTimers();
    const current = fixture();
    const starting = current.bridge.start();
    current.peer().emitTrack({ kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack);
    current.peer().setState("connected");
    await starting;
    let finish!: (offer: RTCSessionDescriptionInit & { offerId: string }) => void;
    vi.mocked(current.control.prepareLocalEdge).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    current.peer().setState("failed");
    current.peer().setState("failed");
    expect(current.control.prepareLocalEdge).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    finish({ type: "offer", sdp: "v=0\r\n", offerId: "late_offer" });
    await vi.advanceTimersByTimeAsync(1);
    expect(current.onFailed).toHaveBeenCalledOnce();
    expect(current.peer().setRemoteDescription).toHaveBeenCalledOnce();
    expect(current.control.acceptSignal).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
  });

  it("gathers the answer before signaling and cancels gathering on disposal", async () => {
    const current = fixture();
    current.peer().iceGatheringState = "gathering";
    const starting = current.bridge.start();
    const rejected = expect(starting).rejects.toBeInstanceOf(NativeMediaBridgeError);
    await vi.waitFor(() => expect(current.peer().setLocalDescription).toHaveBeenCalledOnce());
    expect(current.control.acceptSignal).not.toHaveBeenCalled();
    current.bridge.dispose();
    current.peer().iceGatheringState = "complete";
    current.peer().dispatchEvent(new Event("icegatheringstatechange"));
    await rejected;
    expect(current.control.acceptSignal).not.toHaveBeenCalled();
  });

  it("advertises the same Opus receive range on local preview as remote viewers", async () => {
    const current = fixture();
    current.peer().createAnswer.mockResolvedValueOnce({ type: "answer", sdp:
      "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
      "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n" +
      "a=fmtp:111 minptime=10;useinbandfec=1\r\n",
    });
    const starting = current.bridge.start(true);
    await vi.waitFor(() => expect(current.control.acceptSignal).toHaveBeenCalledWith(
      "share_123456", current.bridge.connectionId, expect.objectContaining({
        kind: "description", description: expect.objectContaining({
          sdp: expect.stringContaining("stereo=1;maxaveragebitrate=510000"),
        }),
      }), "local_offer_1",
    ));
    expect(current.peer().setLocalDescription).toHaveBeenCalledWith(expect.objectContaining({
      sdp: expect.stringContaining("stereo=1;maxaveragebitrate=510000"),
    }));
    current.peer().emitTrack({ kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack);
    current.peer().emitTrack({ kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack);
    current.peer().setState("connected");
    await expect(starting).resolves.toBe(current.bridge.stream);
    current.bridge.dispose();
  });

  it("releases an unstarted Browser reservation without sending an edge command", async () => {
    const current = fixture();
    current.bridge.dispose();
    current.bridge.dispose();
    await expect(current.bridge.start()).rejects.toBeInstanceOf(NativeMediaBridgeError);
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(current.control.prepareLocalEdge).not.toHaveBeenCalled();
    expect(current.control.closeEdge).not.toHaveBeenCalled();
    expect(current.onFailed).not.toHaveBeenCalled();
  });

  it.each(["MediaStream", "RTCPeerConnection"])("preserves %s initialization failure without preparing an edge", (api) => {
    const current = fixture();
    current.bridge.dispose();
    vi.clearAllMocks();
    const cause = new DOMException("Browser media initialization rejected", "NotAllowedError");
    vi.stubGlobal(api, class { constructor() { throw cause; } });
    let failure: unknown;
    try { new NativeMediaBridge("share_123456", current.control, current.onFailed); }
    catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(NativeMediaBridgeError);
    expect(failure).toBeInstanceOf(NativeMediaBridgeInitializationError);
    expect((failure as Error).cause).toBe(cause);
    expect(debugError).toHaveBeenCalledWith("native-bridge", "initialization-failed", cause);
    expect(current.control.prepareLocalEdge).not.toHaveBeenCalled();
    expect(current.control.closeEdge).not.toHaveBeenCalled();
    expect(current.onFailed).not.toHaveBeenCalled();
  });

  it("records the negotiation cause before retiring a failed bridge", async () => {
    const current = fixture();
    const cause = new DOMException("Remote offer rejected", "OperationError");
    current.peer().setRemoteDescription.mockRejectedValueOnce(cause);
    await expect(current.bridge.start()).rejects.toMatchObject({ cause });
    expect(debugError).toHaveBeenCalledWith("native-bridge", "failed", cause,
      { type: "negotiation", state: "starting" });
    expect(current.peer().close).toHaveBeenCalledOnce();
    expect(current.control.closeEdge).toHaveBeenCalledOnce();
    expect(current.onFailed).not.toHaveBeenCalled();
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
    const current = fixture();
    const starting = current.bridge.start(true);
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

  it("retires an actively closed native edge once", async () => {
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
      version: 10,
      type: "edge-state",
      shareId: "share_123456",
      connectionId: current.bridge.connectionId,
      state: "closed",
    });
    current.emit({
      version: 10,
      type: "edge-state",
      shareId: "share_123456",
      connectionId: current.bridge.connectionId,
      state: "closed",
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
    expect(debugError).not.toHaveBeenCalled();
  });

  it.each(["prepare", "answer"])("does not signal after disposal during %s", async (stage) => {
    const current = fixture();
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    if (stage === "prepare") {
      vi.mocked(current.control.prepareLocalEdge).mockImplementationOnce(async () => {
        await pending;
        return { type: "offer", sdp: "v=0\r\n", offerId: "local_offer_1" };
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
