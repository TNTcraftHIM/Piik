import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IceConfig, SignalPayload } from "../src/shared/protocol.ts";
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

const ANSWER_SDP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=recvonly",
  "",
].join("\r\n");

interface ConnectionPlan {
  answerError?: Error;
  candidateGates?: Promise<void>[];
  localDescriptionGate?: Promise<void>;
  statsGate?: Promise<RTCStatsReport>;
}

class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[] = [];

  getTrackById(id: string): MediaStreamTrack | null {
    return this.tracks.find((track) => track.id === id) ?? null;
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

class FakePeerConnection extends EventTarget {
  static readonly instances: FakePeerConnection[] = [];
  static readonly plans: ConnectionPlan[] = [];

  readonly configurations: RTCConfiguration[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  remoteDescription: RTCSessionDescription | null = null;
  localDescription: RTCSessionDescription | null = null;
  statsGate: Promise<RTCStatsReport> | null = null;

  private readonly candidateGates: Promise<void>[];
  private readonly localDescriptionGate: Promise<void> | null;
  private readonly answerError: Error | null;

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

  constructor(configuration?: RTCConfiguration) {
    super();
    if (configuration) {
      this.configurations.push(configuration);
    }
    const plan = FakePeerConnection.plans.shift() ?? {};
    this.candidateGates = [...(plan.candidateGates ?? [])];
    this.localDescriptionGate = plan.localDescriptionGate ?? null;
    this.answerError = plan.answerError ?? null;
    this.statsGate = plan.statsGate ?? null;
    FakePeerConnection.instances.push(this);
  }

  readonly setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit): Promise<void> => {
      this.remoteDescription = description as RTCSessionDescription;
    },
  );

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.answerError) {
      throw this.answerError;
    }
    return {
      type: "answer",
      sdp: ANSWER_SDP,
    };
  }

  readonly setConfiguration = vi.fn((configuration: RTCConfiguration) => {
    this.configurations.push(configuration);
  });

  close(): void {
    this.connectionState = "closed";
  }
}

const intervalCallbacks = new Map<number, () => void>();
let nextIntervalId = 1;
const timeoutCallbacks = new Map<number, () => void>();
const timeoutDelays = new Map<number, number>();
let nextTimeoutId = 1;

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

function decodedReport(framesDecoded: number): RTCStatsReport {
  return new Map([
    [
      "video-in",
      {
        id: "video-in",
        type: "inbound-rtp",
        timestamp: 1_000,
        kind: "video",
        framesDecoded,
      },
    ],
  ]) as unknown as RTCStatsReport;
}

function createPeer(
  signals: SignalPayload[],
  snapshots: PeerSnapshot[],
  signalPeers: string[] = [],
  iceConfig: IceConfig = { iceServers: [] },
  natPrediction = false,
): ViewerPeer {
  return new ViewerPeer(
    iceConfig,
    {
      sendSignal: (peerId, payload) => {
        signalPeers.push(peerId);
        signals.push(payload);
        return true;
      },
      sendRestartRequest: () => true,
      onStream: () => undefined,
      onUpdate: (snapshot) => snapshots.push(snapshot),
    },
    { natPredictionEnabled: natPrediction },
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
  timeoutCallbacks.clear();
  timeoutDelays.clear();
  nextTimeoutId = 1;
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("window", {
    setInterval: (callback: () => void) => {
      const id = nextIntervalId++;
      intervalCallbacks.set(id, callback);
      return id;
    },
    clearInterval: (id: number) => intervalCallbacks.delete(id),
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimeoutId++;
      timeoutCallbacks.set(id, callback);
      timeoutDelays.set(id, delay);
      return id;
    },
    clearTimeout: (id: number) => {
      timeoutCallbacks.delete(id);
      timeoutDelays.delete(id);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ViewerPeer connection generations", () => {
  it("proves a fresh exact connection from its first cumulative decoded frame", async () => {
    FakePeerConnection.plans.push({
      statsGate: Promise.resolve(decodedReport(1)),
    });
    const decoded = vi.fn(() => true);
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: () => true,
        onStream: () => undefined,
        onUpdate: () => undefined,
        onFirstDecodedFrame: decoded,
      },
    );

    await peer.acceptSignal("host", offer("fresh-exact"));
    await flushAsyncWork();

    expect(decoded).toHaveBeenCalledOnce();
    expect(decoded).toHaveBeenCalledWith("fresh-exact");
    peer.dispose();
  });

  it("does not publish an in-flight decoded proof from a replaced connection", async () => {
    const oldStats = createDeferred<RTCStatsReport>();
    FakePeerConnection.plans.push(
      { statsGate: oldStats.promise },
      { statsGate: Promise.resolve(new Map() as unknown as RTCStatsReport) },
    );
    const decoded = vi.fn(() => true);
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: () => true,
        onStream: () => undefined,
        onUpdate: () => undefined,
        onFirstDecodedFrame: decoded,
      },
    );

    await peer.acceptSignal("host-a", offer("old-exact"));
    await peer.acceptSignal("host-b", offer("new-exact"));
    oldStats.resolve(decodedReport(3));
    await flushAsyncWork();

    expect(decoded).not.toHaveBeenCalled();
    peer.dispose();
  });

  it("sets and signals stereo audio bitrate for every answer", async () => {
    const signals: SignalPayload[] = [];
    const peer = createPeer(signals, []);

    await peer.acceptSignal("host", offer("screen-audio"));
    await peer.acceptSignal("host", offer("screen-audio"));
    await peer.acceptSignal("host", offer("screen-audio-rebuild"));

    const answers = signals.filter((signal) => signal.kind === "description");
    const localDescriptions = FakePeerConnection.instances.flatMap((connection) =>
      connection.setLocalDescription.mock.calls.map(([description]) => description),
    );
    expect(answers).toHaveLength(3);
    for (const [index, description] of localDescriptions.entries()) {
      expect(description).toEqual(expect.objectContaining({
        type: "answer",
        sdp: expect.stringContaining(
          "a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=192000",
        ),
      }));
      expect(answers[index]?.description.sdp).toBe(description.sdp);
    }
  });

  it("applies STUN-only ICE configuration at creation and update", async () => {
    const peer = createPeer([], [], [], {
      iceServers: [{ urls: ["stun:stun-a.example.test:3478"] }],
    });
    await peer.acceptSignal("host", offer("stun-config"));
    const connection = FakePeerConnection.instances[0]!;

    peer.updateIceConfig({
      iceServers: [{ urls: ["stun:stun-b.example.test:3478"] }],
    });

    expect(connection.configurations).toEqual([
      { iceServers: [{ urls: ["stun:stun-a.example.test:3478"] }] },
      { iceServers: [{ urls: ["stun:stun-b.example.test:3478"] }] },
    ]);
    expect(connection.setConfiguration).toHaveBeenCalledOnce();
    for (const configuration of connection.configurations) {
      expect(
        configuration.iceServers?.every(
          (server) =>
            !Reflect.has(server, "username") &&
            !Reflect.has(server, "credential") &&
            (typeof server.urls === "string"
              ? server.urls.startsWith("stun:")
              : server.urls.every((url) => url.startsWith("stun:"))),
        ),
      ).toBe(true);
    }
  });

  it("uses the room NAT policy for Viewer-originated ICE candidates", async () => {
    const signals: SignalPayload[] = [];
    const peer = createPeer(
      signals,
      [],
      [],
      {
        iceServers: [{ urls: "stun:share.example.test:3478" }],
        natPredictionStunUrls: [
          "stun:share.example.test:3479",
          "stun:share.example.test:3480",
        ],
      },
      true,
    );
    await peer.acceptSignal("host", offer("nat-room-policy"));
    const connection = FakePeerConnection.instances[0]!;
    expect(connection.configurations[0]?.iceServers).toEqual([
      { urls: "stun:share.example.test:3478" },
      { urls: "stun:share.example.test:3479" },
      { urls: "stun:share.example.test:3480" },
    ]);

    const surveyUrls = [
      "stun:share.example.test:3478",
      "stun:share.example.test:3479",
      "stun:share.example.test:3480",
    ];
    const emitCandidate = (port: number, url: string): void => {
      const event = new Event("icecandidate");
      Object.defineProperty(event, "candidate", {
        value: {
          candidate:
            `candidate:base 1 udp 2122260223 203.0.113.7 ${port} ` +
            "typ srflx raddr 192.0.2.7 rport 50000 generation 0 ufrag test",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: "test",
          url,
        },
      });
      connection.dispatchEvent(event);
    };
    emitCandidate(40_000, surveyUrls[0]!);
    emitCandidate(40_003, surveyUrls[1]!);
    emitCandidate(40_006, surveyUrls[2]!);
    connection.iceGatheringState = "complete";
    connection.dispatchEvent(new Event("icegatheringstatechange"));

    const candidates = signals.filter(
      (signal): signal is Extract<SignalPayload, { kind: "candidate" }> =>
        signal.kind === "candidate",
    );
    expect(
      candidates.some((signal) =>
        signal.candidate?.candidate.startsWith("candidate:sp"),
      ),
    ).toBe(true);
    expect(
      candidates.filter((signal) =>
        signal.candidate?.candidate.startsWith("candidate:base"),
      ),
    ).toHaveLength(3);
    expect(candidates.filter((signal) => signal.candidate === null)).toHaveLength(1);
    peer.dispose();
  });

  it("restarts ICE when an answered initial connection stays stuck", async () => {
    const restartRequests: Array<{
      peerId: string;
      connectionId: string;
      rebuild: boolean;
    }> = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: (peerId, connectionId, rebuild) => {
          restartRequests.push({ peerId, connectionId, rebuild });
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
      },
    );

    await peer.acceptSignal("relay-parent", offer("stuck-connection"));

    expect(timeoutDelays.get(1)).toBe(15_000);
    timeoutCallbacks.get(1)!();
    expect(restartRequests).toEqual([
      {
        peerId: "relay-parent",
        connectionId: "stuck-connection",
        rebuild: false,
      },
    ]);
    expect(timeoutDelays.get(2)).toBe(3_000);
  });

  it("leaves a pending route candidate under the route deadline", async () => {
    const restartRequests: string[] = [];
    const exhausted: string[] = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: (_peerId, connectionId) => {
          restartRequests.push(connectionId);
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
        onRecoveryExhausted: (_peerId, connectionId) => {
          exhausted.push(connectionId);
          return true;
        },
      },
      { recoveryOwner: "route" },
    );

    await peer.acceptSignal("host", offer("route-candidate"));
    const connection = FakePeerConnection.instances[0]!;
    connection.connectionState = "disconnected";
    connection.dispatchEvent(new Event("connectionstatechange"));

    expect(timeoutDelays).toEqual(new Map());
    expect(restartRequests).toEqual([]);
    expect(exhausted).toEqual([]);

    connection.connectionState = "failed";
    connection.dispatchEvent(new Event("connectionstatechange"));
    expect(restartRequests).toEqual([]);
    expect(exhausted).toEqual(["route-candidate"]);
  });

  it("transfers recovery ownership when a prepared route fails during commit", async () => {
    const restartRequests: Array<{
      connectionId: string;
      rebuild: boolean;
    }> = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: (_peerId, connectionId, rebuild) => {
          restartRequests.push({ connectionId, rebuild });
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
      },
      { recoveryOwner: "route" },
    );

    await peer.acceptSignal("host", offer("committed-candidate"));
    const connection = FakePeerConnection.instances[0]!;
    connection.connectionState = "failed";
    peer.activatePreparedRoute();

    expect(restartRequests).toEqual([
      { connectionId: "committed-candidate", rebuild: false },
    ]);
    expect([...timeoutDelays.values()]).toEqual([3_000]);
  });

  it("cancels the initial deadline after connecting", async () => {
    const restartRequests: string[] = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: (_peerId, connectionId) => {
          restartRequests.push(connectionId);
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
      },
    );

    await peer.acceptSignal("host", offer("connected-generation"));
    const initialDeadline = timeoutCallbacks.get(1)!;
    const connection = FakePeerConnection.instances[0]!;
    connection.connectionState = "connected";
    connection.dispatchEvent(new Event("connectionstatechange"));

    expect(timeoutCallbacks.has(1)).toBe(false);
    initialDeadline();
    expect(restartRequests).toEqual([]);
  });

  it("ignores an initial deadline from an old connection generation", async () => {
    const restartRequests: string[] = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: (_peerId, connectionId) => {
          restartRequests.push(connectionId);
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
      },
    );

    await peer.acceptSignal("host", offer("connection-old"));
    const oldDeadline = timeoutCallbacks.get(1)!;
    await peer.acceptSignal("host", offer("connection-new"));

    expect(timeoutCallbacks.has(1)).toBe(false);
    expect(timeoutDelays.get(2)).toBe(15_000);
    oldDeadline();
    expect(restartRequests).toEqual([]);

    const currentConnection = FakePeerConnection.instances[1]!;
    currentConnection.connectionState = "connected";
    currentConnection.dispatchEvent(new Event("connectionstatechange"));
    expect(timeoutCallbacks.has(2)).toBe(false);
  });

  it("clears the initial deadline when disposed", async () => {
    const peer = createPeer([], []);
    await peer.acceptSignal("host", offer("disposed-connection"));

    peer.dispose();

    expect(timeoutCallbacks).toEqual(new Map());
    expect(timeoutDelays).toEqual(new Map());
  });

  it("reports one exhausted edge after bounded restart and rebuild attempts", async () => {
    const restartRequests: Array<{
      peerId: string;
      connectionId: string;
      rebuild: boolean;
    }> = [];
    const exhausted: Array<{ peerId: string; connectionId: string }> = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: (peerId, connectionId, rebuild) => {
          restartRequests.push({ peerId, connectionId, rebuild });
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
        onRecoveryExhausted: (peerId, connectionId) => {
          exhausted.push({ peerId, connectionId });
          return true;
        },
      },
    );
    await peer.acceptSignal("relay-parent", offer("failed-connection"));
    const connection = FakePeerConnection.instances[0]!;
    connection.connectionState = "failed";
    connection.dispatchEvent(new Event("connectionstatechange"));

    expect(restartRequests).toEqual([
      {
        peerId: "relay-parent",
        connectionId: "failed-connection",
        rebuild: false,
      },
    ]);
    timeoutCallbacks.get(2)!();
    expect(restartRequests.at(-1)).toEqual({
      peerId: "relay-parent",
      connectionId: "failed-connection",
      rebuild: true,
    });
    timeoutCallbacks.get(3)!();
    expect(exhausted).toEqual([
      { peerId: "relay-parent", connectionId: "failed-connection" },
    ]);

    connection.dispatchEvent(new Event("connectionstatechange"));
    expect(restartRequests).toHaveLength(2);
    expect(exhausted).toHaveLength(1);
  });

  it("retries delivery of an exhausted edge after signaling reconnects", async () => {
    let reportAvailable = false;
    const exhausted: string[] = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: () => true,
        onStream: () => undefined,
        onUpdate: () => undefined,
        onRecoveryExhausted: (_peerId, connectionId) => {
          exhausted.push(connectionId);
          return reportAvailable;
        },
      },
    );
    await peer.acceptSignal("relay-parent", offer("failed-connection"));
    const connection = FakePeerConnection.instances[0]!;
    connection.connectionState = "failed";
    connection.dispatchEvent(new Event("connectionstatechange"));

    timeoutCallbacks.get(2)!();
    timeoutCallbacks.get(3)!();
    expect(exhausted).toEqual(["failed-connection"]);

    reportAvailable = true;
    timeoutCallbacks.get(4)!();
    expect(exhausted).toEqual(["failed-connection", "failed-connection"]);

    connection.dispatchEvent(new Event("connectionstatechange"));
    expect(exhausted).toHaveLength(2);
  });

  it("requests one bounded rebuild when answer negotiation fails", async () => {
    FakePeerConnection.plans.push(
      { answerError: new Error("first answer failed") },
      { answerError: new Error("second answer failed") },
    );
    const restartRequests: Array<{
      peerId: string;
      connectionId: string;
      rebuild: boolean;
    }> = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: (peerId, connectionId, rebuild) => {
          restartRequests.push({ peerId, connectionId, rebuild });
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
      },
    );

    await peer.acceptSignal("relay-parent", offer("connection-first"));
    await peer.acceptSignal("relay-parent", offer("connection-second"));

    expect(restartRequests).toEqual([
      {
        peerId: "relay-parent",
        connectionId: "connection-first",
        rebuild: true,
      },
    ]);
  });

  it("requests a rebuild when the completed answer cannot be signaled", async () => {
    const restartRequests: Array<{
      peerId: string;
      connectionId: string;
      rebuild: boolean;
    }> = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => false,
        sendRestartRequest: (peerId, connectionId, rebuild) => {
          restartRequests.push({ peerId, connectionId, rebuild });
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
      },
    );

    await peer.acceptSignal("relay-parent", offer("unsent-answer"));

    expect(restartRequests).toEqual([
      {
        peerId: "relay-parent",
        connectionId: "unsent-answer",
        rebuild: true,
      },
    ]);
    expect([...timeoutDelays.values()]).toEqual([3_000]);
  });

  it("serializes recovery requests at the current parent", async () => {
    const signals: SignalPayload[] = [];
    const signalPeers: string[] = [];
    const restartRequests: Array<{
      peerId: string;
      connectionId: string;
      rebuild: boolean;
    }> = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: (peerId, payload) => {
          signalPeers.push(peerId);
          signals.push(payload);
          return true;
        },
        sendRestartRequest: (peerId, connectionId, rebuild) => {
          restartRequests.push({ peerId, connectionId, rebuild });
          return true;
        },
        onStream: () => undefined,
        onUpdate: () => undefined,
      },
    );

    await peer.acceptSignal("parent-old", offer("connection-old"));
    await peer.acceptSignal("parent-new", offer("connection-new"));
    expect(signalPeers).toEqual(["parent-old", "parent-new"]);

    expect(peer.requestRecovery(true)).toBe(true);
    expect(peer.requestRecovery(true)).toBe(false);
    expect(restartRequests).toEqual([
      {
        peerId: "parent-new",
        connectionId: "connection-new",
        rebuild: true,
      },
    ]);

    const connection = FakePeerConnection.instances.at(-1)!;
    connection.connectionState = "connected";
    [...timeoutCallbacks.values()].at(-1)!();
    expect(peer.requestRecovery(true)).toBe(true);
    expect(restartRequests).toHaveLength(2);
    peer.dispose();
  });

  it("retires the recovery deadline when a rebuilt connection is answered", async () => {
    const exhausted: string[] = [];
    const peer = new ViewerPeer(
      { iceServers: [] },
      {
        sendSignal: () => true,
        sendRestartRequest: () => true,
        onStream: () => undefined,
        onUpdate: () => undefined,
        onRecoveryExhausted: (_peerId, connectionId) => {
          exhausted.push(connectionId);
          return true;
        },
      },
    );

    await peer.acceptSignal("relay-parent", offer("connection-before-rebuild"));
    expect(peer.requestRecovery(true)).toBe(true);
    await peer.acceptSignal("relay-parent", offer("connection-after-rebuild"));

    expect([...timeoutDelays.values()]).toEqual([15_000]);
    expect(exhausted).toEqual([]);
    peer.dispose();
  });

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

  it("serializes ordinary offers for the same connection", async () => {
    const firstLocalDescription = createDeferred<void>();
    FakePeerConnection.plans.push({
      localDescriptionGate: firstLocalDescription.promise,
    });
    const signals: SignalPayload[] = [];
    const peer = createPeer(signals, []);

    const first = peer.acceptSignal("host", offer("same-connection"));
    await vi.waitFor(() =>
      expect(
        FakePeerConnection.instances[0]?.setLocalDescription,
      ).toHaveBeenCalledOnce(),
    );
    const connection = FakePeerConnection.instances[0]!;
    const second = peer.acceptSignal("host", offer("same-connection"));
    await Promise.resolve();
    expect(connection.setRemoteDescription).toHaveBeenCalledOnce();

    firstLocalDescription.resolve();
    await Promise.all([first, second]);
    expect(connection.setRemoteDescription).toHaveBeenCalledTimes(2);
    expect(
      signals.filter((signal) => signal.kind === "description"),
    ).toHaveLength(2);
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

  it("skips overlapping stats ticks on the same connection", async () => {
    const peer = createPeer([], []);
    await peer.acceptSignal("host", offer("connection"));
    const connection = FakePeerConnection.instances[0]!;
    const stats = createDeferred<RTCStatsReport>();
    connection.statsGate = stats.promise;
    const statsCallback = intervalCallbacks.get(1)!;

    statsCallback();
    statsCallback();
    await vi.waitFor(() => expect(connection.getStats).toHaveBeenCalledOnce());

    stats.resolve(new Map() as unknown as RTCStatsReport);
    await flushAsyncWork();
    connection.statsGate = null;
    statsCallback();
    await vi.waitFor(() =>
      expect(connection.getStats).toHaveBeenCalledTimes(2),
    );
  });
});
