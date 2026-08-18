import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SignalPayload } from "../src/shared/protocol.ts";
import type { PeerSnapshot } from "../src/client/types.ts";
import { ViewerPeer } from "../src/client/webrtc/viewer-peer.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface ConnectionPlan {
  candidateGates?: Promise<void>[];
  localDescriptionGate?: Promise<void>;
}

class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[] = [];

  getTrackById(id: string): MediaStreamTrack | null {
    return this.tracks.find((track) => track.id === id) ?? null;
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }
}

class FakePeerConnection extends EventTarget {
  static readonly instances: FakePeerConnection[] = [];
  static readonly plans: ConnectionPlan[] = [];

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  remoteDescription: RTCSessionDescription | null = null;
  localDescription: RTCSessionDescription | null = null;
  statsGate: Promise<RTCStatsReport> | null = null;

  private readonly candidateGates: Promise<void>[];
  private readonly localDescriptionGate: Promise<void> | null;

  readonly addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit | null) => {
    const gate = this.candidateGates.shift();
    if (gate) {
      await gate;
    }
  });
  readonly getStats = vi.fn(async () => {
    if (this.statsGate) {
      return this.statsGate;
    }
    return new Map() as unknown as RTCStatsReport;
  });
  readonly setLocalDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      if (this.localDescriptionGate) {
        await this.localDescriptionGate;
      }
      this.localDescription = description as RTCSessionDescription;
    },
  );

  constructor() {
    super();
    const plan = FakePeerConnection.plans.shift() ?? {};
    this.candidateGates = [...(plan.candidateGates ?? [])];
    this.localDescriptionGate = plan.localDescriptionGate ?? null;
    FakePeerConnection.instances.push(this);
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return {
      type: "answer",
      sdp: `answer-${FakePeerConnection.instances.indexOf(this)}`,
    };
  }

  setConfiguration(): void {}

  close(): void {
    this.connectionState = "closed";
  }
}

const intervalCallbacks = new Map<number, () => void>();
let nextIntervalId = 1;

function offer(connectionId: string): SignalPayload {
  return {
    kind: "description",
    connectionId,
    description: { type: "offer", sdp: `offer-${connectionId}` },
  };
}

function candidate(connectionId: string, value: string): SignalPayload {
  return {
    kind: "candidate",
    connectionId,
    candidate: {
      candidate: value,
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
  };
}

function createPeer(
  signals: SignalPayload[],
  snapshots: PeerSnapshot[],
): ViewerPeer {
  return new ViewerPeer(
    { iceServers: [], expiresAt: null, relayAvailable: false },
    {
      sendSignal: (payload) => {
        signals.push(payload);
        return true;
      },
      sendRestartRequest: () => true,
      onStream: () => undefined,
      onUpdate: (snapshot) => snapshots.push(snapshot),
    },
  );
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  FakePeerConnection.instances.length = 0;
  FakePeerConnection.plans.length = 0;
  intervalCallbacks.clear();
  nextIntervalId = 1;
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("window", {
    setInterval: (callback: () => void) => {
      const id = nextIntervalId++;
      intervalCallbacks.set(id, callback);
      return id;
    },
    clearInterval: (id: number) => intervalCallbacks.delete(id),
    setTimeout,
    clearTimeout,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ViewerPeer connection generations", () => {
  it("does not send an old answer or candidate after replacing the connection", async () => {
    const oldLocalDescription = createDeferred<void>();
    FakePeerConnection.plans.push({
      localDescriptionGate: oldLocalDescription.promise,
    });
    const signals: SignalPayload[] = [];
    const snapshots: PeerSnapshot[] = [];
    const peer = createPeer(signals, snapshots);

    const oldAccept = peer.acceptSignal("host", offer("connection-old"));
    await vi.waitFor(() => {
      expect(FakePeerConnection.instances[0]?.setLocalDescription).toHaveBeenCalledOnce();
    });
    const oldConnection = FakePeerConnection.instances[0]!;

    await peer.acceptSignal("host", offer("connection-new"));
    const iceEvent = new Event("icecandidate");
    Object.defineProperty(iceEvent, "candidate", {
      value: {
        candidate: "candidate-from-old-connection",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    });
    oldConnection.dispatchEvent(iceEvent);
    oldLocalDescription.resolve();
    await oldAccept;

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "description",
      connectionId: "connection-new",
      description: { type: "answer" },
    });
    expect(snapshots.at(-1)).toMatchObject({
      connectionId: "connection-new",
      error: null,
    });
  });

  it("stops flushing old candidates when the connection is replaced", async () => {
    const firstCandidate = createDeferred<void>();
    FakePeerConnection.plans.push({
      candidateGates: [firstCandidate.promise],
    });
    const peer = createPeer([], []);
    await peer.acceptSignal("host", candidate("connection-old", "candidate-1"));
    await peer.acceptSignal("host", candidate("connection-old", "candidate-2"));

    const oldAccept = peer.acceptSignal("host", offer("connection-old"));
    await vi.waitFor(() => {
      expect(FakePeerConnection.instances[0]?.addIceCandidate).toHaveBeenCalledOnce();
    });
    const oldConnection = FakePeerConnection.instances[0]!;

    await peer.acceptSignal("host", offer("connection-new"));
    const newConnection = FakePeerConnection.instances[1]!;
    firstCandidate.resolve();
    await oldAccept;

    expect(oldConnection.addIceCandidate).toHaveBeenCalledTimes(1);
    expect(newConnection.addIceCandidate).not.toHaveBeenCalled();
  });

  it("does not apply stats that resolve after the connection is replaced", async () => {
    const signals: SignalPayload[] = [];
    const snapshots: PeerSnapshot[] = [];
    const peer = createPeer(signals, snapshots);
    await peer.acceptSignal("host", offer("connection-old"));
    const oldConnection = FakePeerConnection.instances[0]!;
    const oldStats = createDeferred<RTCStatsReport>();
    oldConnection.statsGate = oldStats.promise;
    const oldStatsCallback = intervalCallbacks.get(1)!;

    oldStatsCallback();
    await vi.waitFor(() => expect(oldConnection.getStats).toHaveBeenCalledOnce());
    await peer.acceptSignal("host", offer("connection-new"));
    const newSnapshotCount = snapshots.filter(
      ({ connectionId }) => connectionId === "connection-new",
    ).length;

    oldStats.resolve(
      new Map([
        [
          "inbound-old",
          {
            id: "inbound-old",
            type: "inbound-rtp",
            timestamp: 2_000,
            kind: "video",
            bytesReceived: 1_000,
            framesDecoded: 60,
            frameWidth: 1_920,
            frameHeight: 1_080,
          },
        ],
      ]) as unknown as RTCStatsReport,
    );
    await flushAsyncWork();

    const newSnapshots = snapshots.filter(
      ({ connectionId }) => connectionId === "connection-new",
    );
    expect(newSnapshots).toHaveLength(newSnapshotCount);
    expect(newSnapshots.at(-1)?.metrics.resolution).toBeNull();
  });
});
