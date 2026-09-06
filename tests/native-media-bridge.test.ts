import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NativeMediaBridge,
  type NativeMediaBridgeControl,
} from "../src/client/native/media-bridge";
import type { NativeClientEvent } from "../src/client/native/wire";

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
  readonly addIceCandidate = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly createAnswer = vi.fn(async () => ({
    type: "answer" as const,
    sdp: "v=0\r\n",
  }));
  readonly setLocalDescription = vi.fn(async () => undefined);
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
        version: 8,
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native media bridge", () => {
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
      version: 8,
      type: "edge-state",
      shareId: "share_123456",
      connectionId: current.bridge.connectionId,
      state: "failed",
    });
    current.emit({
      version: 8,
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
});
